"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { getConnection, getSettings, getSshConnection, getCloudAiConfig, sameSshTarget, saveSettings, setModelAdminPassword, trustHostFingerprint, verifyModelAdminPassword } = require("./settings.cjs");
const { downloadRemoteFile, ensureDeviceControlKey, finalizeDeviceControl, getAgentSdkBridgeStatus, getClaudeModelStatus, installAgentSdkBridge, markDeviceControlDisabled, readRemoteFile, runClaude, uninstallAgentSdkBridge, updateClaudeModel, verifyConnection } = require("./ssh.cjs");
const { copyLocalFile, getLocalClaudeModelStatus, readLocalFile, runLocalClaude, updateLocalClaudeModel, verifyLocalConnection } = require("./local.cjs");
const { contextTokensFromUsage } = require("./protocol.cjs");
const { scanSystemCaches, cleanSystemCaches } = require("./cache-cleaner.cjs");
const { getDeviceControlStatus, installDeviceControl, preferredAddress, uninstallDeviceControl } = require("./device-control.cjs");
const {
  addAssistantMessage,
  addUserMessage,
  clearConversationSession,
  createConversation,
  deleteConversation,
  ensureConversationArchives,
  getConversation,
  getConversationRecoveryNotice,
  listConversations,
  archiveDirectory,
  prepareConversationDirectory,
  renameConversation,
  setConversationPinned,
  saveConversationSession,
  saveAssistantDraft,
  searchConversations,
  sessionForMode,
  conversationStats
} = require("./conversations.cjs");
const { logPath, writeLog } = require("./logger.cjs");
const { renderMarkdown } = require("./markdown.cjs");
const { samePath } = require("./storage.cjs");
const { listModes, getMode, createMode, updateMode, deleteMode, exportModes, importModes } = require("./modes/mode-manager.cjs");
const { buildCommandWithMode, buildBridgeStartWithMode, buildLocalArgsWithMode } = require("./modes/mode-params.cjs");
const { NetworkManager, STATES } = require("./network/network-manager.cjs");
const { LatencyMonitor } = require("./network/latency-monitor.cjs");
const { sendCloudChat, buildMessages, verifyCloudConnection, testProxyConnectivity } = require("./cloud-chat.cjs");
const {
  auditToolDetails
} = require("./status-event-normalizer.cjs");
// 状态审计日志（Orbit 真实现接线，v3.9.0）：原内联版提取为独立模块，枚举校验逻辑一致
const { journalEntry: statusJournalEntry, signalEntry: statusSignalEntry, toolLifecycleEntry: statusToolLifecycleEntry } = require("./modules/status/status-audit-journal.cjs");
const { readModelSettings, replaceModelSettings } = require("./model-config.cjs");
const { CloudBrandManager } = require("./cloud-brand.cjs");
const { IntegrityGuard } = require("./integrity-guard.cjs");
const { createModuleRegistry } = require("./modules/foundation/module-registry.cjs");
const { createStatusCenter } = require("./modules/status/status-center.cjs");
const { createToolPermissionService } = require("./modules/foundation/permissions/tool-permission-service.cjs");
const { createSignalLightStrip } = require("./modules/foundation/signal-contract/light-strip.cjs");
const { createConversationClaudeSignalMonitor } = require("./modules/foundation/signal-contract/signal-chain.cjs");

let window;
const brandManager = new CloudBrandManager();
const integrityGuard = new IntegrityGuard();
const activeRequests = new Map();
const networkManager = new NetworkManager();
let latencyMonitor = null;

/** 脱敏 URL：移除嵌入的用户名密码（user:pass@host → [REDACTED]@host） */
function sanitizeUrl(url) {
  if (!url || typeof url !== "string") return url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "[REDACTED]";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {}
  return url;
}

function normalizeAndObserveStatusEvent(event, config) {
  return statusCenter.normalize(event, config);
}

// ── 模块化架构（移植自 Agent Orbit 0.9.6） ──
const moduleRegistry = createModuleRegistry();
moduleRegistry.register({ id: "foundation", label: "软件底座与扩展框架", version: 1, capabilities: ["electron", "ipc", "window", "settings", "credentials", "filesystem", "nativeDialogs", "moduleRegistry"] });
moduleRegistry.register({ id: "status", label: "状态监控中心", version: 1 });
const statusCenter = createStatusCenter({ onGap: (entry) => writeLog("status_signal_gap", entry) });
const signalLights = createSignalLightStrip({
  publish: (payload) => { if (window && !window.isDestroyed()) window.webContents.send("signal:lights", payload); },
  writeFault: (entry) => writeLog("signal_contract_fault_journal", entry)
});
const signalMonitor = createConversationClaudeSignalMonitor({
  writeLog,
  onTransition: (item) => signalLights.transition(item),
  onRoundComplete: (requestId) => signalLights.completeRound(requestId)
});
/** 信号系统安全调用：信号链任何异常都不得影响聊天主流程 */
function safeSignal(method, fn) {
  try { return fn(); } catch (error) { writeLog("signal_contract_error", { method, error: String(error?.message || error) }); return null; }
}

// ── 工具权限服务（Orbit 真实现接线，v3.9.0）──
const toolPermissionService = createToolPermissionService({
  getSettings,
  saveSettings,
  showConfirmation: (options) => dialog.showMessageBox(window, options),
  restoreFocus: () => {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      window.webContents.focus();
    }
  },
  writeLog
});

function sendWorkStatusSignal(sender, channel, payload) {
  const event = payload || {};
  const tool = event.tool || {};
  writeLog("work_status_signal", statusSignalEntry({
    requestId: event.id,
    direction: "main-sent",
    signal: channel === "chat:delta" ? "chat-delta" : "chat-event",
    disposition: "accepted",
    eventType: event.type,
    eventStatus: event.status,
    toolId: tool.id,
    toolName: tool.name,
    ...(event.audit || (event.type === "tool" ? auditToolDetails(tool) : {})),
    textLength: channel === "chat:delta" ? String(event.text || "").length : 0,
    uploadPercent: event.type === "upload" ? Math.round(Number(event.overall || 0) * 100) : 0
  }));
  sender.send(channel, payload);
}

function applicationIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app-icon.ico")
    : path.join(__dirname, "../../build/icon.ico");
}

function cleanupOpenFileCache() {
  const directory = path.join(app.getPath("temp"), "Agent Chat Pro");
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch (error) { writeLog("open_file_cache_cleanup_failed", { error }); }
}

function assertModelAdminPassword(value) {
  if (!verifyModelAdminPassword(value)) throw new Error("模型管理员密码不正确。");
}

function bundledBridgeFiles() {
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, "bridge")
    : path.join(__dirname, "../bridge");
  const files = ["agent-sdk-bridge.mjs", "package.json", "package-lock.json"];
  return files.map((name) => {
    const filePath = path.join(directory, name);
    if (!fs.existsSync(filePath)) throw new Error(`增强 Bridge 资源不完整，缺少 ${name}。请重新下载完整程序。`);
    return { name, data: fs.readFileSync(filePath) };
  });
}

/** 保存网络连接状态到 settings */
function persistNetworkState() {
  try {
    const current = getSettings();
    const status = networkManager.getStatus();
    const state = (status.state === STATES.CONNECTED || status.state === STATES.DEGRADED) ? "connected" : "offline";
    if (current.networkLastState !== state) {
      saveSettings({ ...current, networkLastState: state });
      writeLog("network_state_persisted", { state });
    }
  } catch (error) {
    writeLog("network_state_persist_failed", { error: error.message });
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 780,
    minHeight: 580,
    backgroundColor: "#00000000",
    frame: false,
    transparent: true,
    hasShadow: true,
    roundedCorners: true,
    autoHideMenuBar: true,
    icon: applicationIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  brandManager.setWindow(window);
  brandManager.setAppVersion(app.getVersion());
  brandManager.setBrandServerUrl(getSettings().brandServerUrl || "");
  brandManager.initialize();
  brandManager.fetchBrandConfig().catch(() => {});
  brandManager.verifyBrand().catch(() => {});
  brandManager.startPeriodicCheck();
  // 完整性自检：检测到篡改时，品牌验证将返回虚假数据
  if (integrityGuard.isTampered) {
    writeLog("brand_tampered_mode", { message: "完整性异常，品牌验证启用虚假数据模式" });
  }
  // 发送初始主题给渲染进程
  try {
    const theme = getSettings().theme || "dark";
    window.webContents.on("did-finish-load", () => {
      window.webContents.send("theme:init", theme);
      brandManager._pushBrandConfig();
      brandManager._pushVerificationStatus();
    });
  } catch {}
  const publishState = () => window?.webContents.send("window:maximized", window.isMaximized());
  window.on("maximize", publishState);
  window.on("unmaximize", publishState);
  window.on("focus", () => {
    if (window.isDestroyed()) return;
    window.webContents.focus();
    window.webContents.send("window:focus");
  });
  window.webContents.on("did-finish-load", publishState);
  window.webContents.on("render-process-gone", (_event, details) => writeLog("renderer_process_gone", details));
  window.on("unresponsive", () => writeLog("window_unresponsive"));
}

app.whenReady().then(async () => {
  app.setAppUserModelId("com.jiang.agentChatPro");
  nativeTheme.themeSource = "dark";
  writeLog("app_start", { version: app.getVersion(), platform: process.platform, arch: process.arch });

  // 运行时完整性自检 — 检测 Fuse/ASAR/调试/注入
  try {
    const integrityResults = await integrityGuard.performFullCheck();
    writeLog("integrity_check", integrityResults);
    if (integrityGuard.isTampered) {
      writeLog("integrity_tampered", { reason: "tampering_detected", fakeDataActive: true });
      // 不崩溃，而是静默启用虚假数据模式，迷惑攻击者
    }
  } catch (error) {
    writeLog("integrity_check_error", { error: error.message });
  }

  cleanupOpenFileCache();
  try {
    const archived = ensureConversationArchives();
    writeLog("conversation_archives_ready", { conversations: archived, directory: archiveDirectory() });
  } catch (error) {
    writeLog("conversation_archives_failed", { error });
  }
  ipcMain.handle("settings:load", () => ({ ...getSettings(), conversationRecoveryNotice: getConversationRecoveryNotice() }));
  ipcMain.handle("settings:save", async (_event, input) => {
    const previous = getSettings();
    const requestedDirectory = input.dataDirectory || previous.defaultDataDirectory;
    const directoryChanged = !samePath(previous.dataDirectory, requestedDirectory);
    if (directoryChanged && activeRequests.size) throw new Error("Agent 正在回复，暂时不能迁移聊天记录。请等待当前回复结束后再保存。");
    const saveSignal = safeSignal("settings-save-create", () => signalMonitor.createSettingsSave({ requestId: randomUUID(), connectionMode: input.connectionMode, directoryChanged }));
    const startedAt = Date.now();
    if (directoryChanged) writeLog("storage_migration_start", { hasExistingConversations: listConversations().length > 0 });
    try {
      safeSignal("preflight", () => { saveSignal.preflightReceived(); saveSignal.preflightToStorage(); saveSignal.storageReceived(); });
      const migration = await prepareConversationDirectory(previous.dataDirectory, requestedDirectory);
      safeSignal("storage-to-settings", () => { saveSignal.storageToSettings(); saveSignal.settingsReceived(); });
      const saved = saveSettings({ ...input, dataDirectory: migration.directory });
      safeSignal("persisted", () => { saveSignal.settingsPersisted(); saveSignal.archivesReceived(); });
      ensureConversationArchives();
      safeSignal("archives-ready", () => saveSignal.archivesReady());
      if (directoryChanged) writeLog("storage_migration_success", {
        conversations: migration.conversations,
        archives: migration.archives,
        mergedExisting: migration.mergedExisting,
        durationMs: Date.now() - startedAt
      });
      writeLog("settings_saved", { connectionMode: saved.connectionMode, host: saved.host, port: saved.port, username: saved.username, wakeName: saved.wakeName, dataDirectory: saved.dataDirectory });
      return saved;
    } catch (error) {
      safeSignal("settings-save-failed", () => saveSignal.failed(error));
      if (directoryChanged) writeLog("storage_migration_failed", { durationMs: Date.now() - startedAt, error });
      throw error;
    }
  });
  ipcMain.handle("settings:tool-mode", async (_event, enabled) => {
    const current = getSettings();
    const signal = safeSignal("tool-permission-signal", () => signalMonitor.createToolPermission({ requestId: randomUUID(), connectionMode: current.connectionMode, automatic: Boolean(enabled) }));
    return toolPermissionService.setAutomaticMode(enabled, signal);
  });
  // ── 模型管理 IPC ──
  ipcMain.handle("model:status", async () => {
    const config = getConnection();
    return config.connectionMode === "local"
      ? getLocalClaudeModelStatus()
      : getClaudeModelStatus(config, (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  ipcMain.handle("model:initialize-password", (_event, input) => {
    const state = getSettings().modelAdminPasswordState;
    if (state === "ready") throw new Error("模型管理员密码已初始化；如需更换请联系管理员。");
    if (state === "unavailable") throw new Error("Windows 系统加密不可用，无法安全保存模型管理员密码。");
    const password = String(input?.password || "");
    if (password !== String(input?.confirmation || "")) throw new Error("两次输入的管理员密码不一致。");
    setModelAdminPassword(password);
    writeLog("model_admin_password_initialized");
    return getSettings();
  });
  ipcMain.handle("model:update", async (_event, input) => {
    if (activeRequests.size) throw new Error("Agent 正在回复，暂时不能切换模型。请等待当前回复结束后再操作。");
    assertModelAdminPassword(input?.adminPassword);
    const model = input?.model;
    const config = getConnection();
    const local = config.connectionMode === "local";
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "切换 Claude 模型",
      message: `将${local ? "本机 Windows" : "目标 NAS"}上的 Claude 模型统一切换为：${String(model || "").trim()}`,
      detail: "软件会只修改 ~/.claude/settings.json 的 OPUS、SONNET、HAIKU、SUBAGENT 和 SMALL_FAST 五个模型项，保留 Base URL、认证、权限、hooks 和其他配置。正在进行的回复不受影响；下一次发送消息将使用新模型。",
      buttons: ["取消", "切换模型"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true };
    writeLog("claude_model_change_requested", { connectionMode: config.connectionMode, host: config.host || "", model: String(model || "").trim() });
    return local
      ? updateLocalClaudeModel(model, writeLog)
      : updateClaudeModel(config, model, (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  ipcMain.handle("storage:choose", async () => {
    const current = getSettings().dataDirectory;
    const result = await dialog.showOpenDialog(window, {
      title: "选择聊天记录保存文件夹",
      defaultPath: current,
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? "" : result.filePaths[0];
  });
  ipcMain.handle("storage:open", async (_event, directory) => {
    const target = directory || getSettings().dataDirectory;
    const error = await shell.openPath(target);
    if (error) throw new Error("无法打开聊天记录目录：" + error);
    return target;
  });
  ipcMain.handle("archive:open", async () => {
    const target = archiveDirectory();
    require("fs").mkdirSync(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error("无法打开会话存档目录：" + error);
    return target;
  });
  ipcMain.handle("archive:show", (_event, id) => {
    ensureConversationArchives();
    const conversation = getConversation(id);
    if (!conversation?.archiveFile) throw new Error("找不到此会话的存档文件。");
    const target = path.join(archiveDirectory(), conversation.archiveFile);
    shell.showItemInFolder(target);
    return target;
  });
  ipcMain.handle("diagnostics:open", () => {
    writeLog("diagnostics_opened");
    shell.showItemInFolder(logPath());
    return logPath();
  });
  ipcMain.on("status:journal", (event, input) => {
    if (event.sender !== window?.webContents) return;
    writeLog("work_status_change", statusJournalEntry(input));
  });
  ipcMain.on("status:signal", (event, input) => {
    if (event.sender !== window?.webContents) return;
    writeLog("work_status_signal", statusSignalEntry(input));
  });
  ipcMain.on("status:tool-lifecycle", (event, input) => {
    if (event.sender !== window?.webContents) return;
    writeLog("work_status_tool_lifecycle", statusToolLifecycleEntry(input));
  });
  // ── 信号灯 IPC（16 盏灯带，快照 + 推送双通道） ──
  ipcMain.handle("signal:lights:get", () => signalLights.snapshot());
  // ── Bridge 强制关闭通知 ──
  // 由 ssh.cjs 的 handleEvents 在收到 bridge_query_force_closed 时触发
  ipcMain.handle("device-control:status", () => getDeviceControlStatus());
  ipcMain.handle("device-control:install", async (_event, input) => {
    const sourceAddress = String(input?.sourceAddress || getSettings().host || "").trim();
    const initialStatus = getDeviceControlStatus();
    const targetAddress = String(input?.targetAddress || initialStatus.targetAddress || preferredAddress(sourceAddress, initialStatus.localAddresses) || "").trim();
    const targetPort = Number(input?.targetPort || initialStatus.targetPort || 22);
    const permissionMode = input?.permissionMode === "standard" ? "standard" : "administrator";
    const permissionText = permissionMode === "administrator" ? "完整管理（专用本地管理员）" : "标准管理（非管理员）";
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "安装 Agent 联动控件",
      message: "允许管理 Agent 通过 SSH 公钥控制这台电脑？",
      detail: `不会要求或保存员工的 Windows 密码。\n\n允许来源：${sourceAddress}\n本机被控地址：${targetAddress}:${targetPort}\n权限：${permissionText}\n\n安装时 Windows 会弹出一次管理员授权。管理员模式可执行系统级操作，请只在公司授权设备上启用。`,
      buttons: ["取消", "继续安装"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true, ...getDeviceControlStatus() };
    const config = getSshConnection();
    const current = getDeviceControlStatus();
    const deviceId = current.deviceId || randomUUID();
    const metadata = { hostname: current.hostname, targetAddress, targetPort };
    writeLog("device_control_install_start", { deviceId, sourceAddress, targetAddress, targetPort, permissionMode });
    try {
      const key = await ensureDeviceControlKey(config, deviceId, metadata, (fingerprint) => trustHost(config, fingerprint), writeLog);
      const status = await installDeviceControl({
        publicKey: key.publicKey,
        sourceAddress,
        targetAddress,
        targetPort,
        permissionMode,
        deviceId,
        managementKeyPath: key.privateKeyPath
      });
      let probe;
      try { probe = await finalizeDeviceControl(config, key, metadata, (fingerprint) => trustHost(config, fingerprint), writeLog); }
      catch (error) {
        probe = { ok: false, error: error.message };
        writeLog("device_control_probe_failed", { deviceId, targetAddress, targetPort, error });
      }
      writeLog("device_control_install_success", { deviceId, sourceAddress, targetAddress, permissionMode, serviceRunning: status.serviceRunning, probeOk: probe.ok });
      return { ...status, probe };
    } catch (error) {
      writeLog("device_control_install_failed", { deviceId, sourceAddress, permissionMode, error });
      throw error;
    }
  });
  ipcMain.handle("device-control:uninstall", async () => {
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "卸载 Agent 联动控件",
      message: "确定停止 Agent 对这台电脑的 SSH 联动控制吗？",
      detail: "将撤销本机公钥、专用账号和专用防火墙规则；聊天记录和 NAS 上的 Claude 会话不受影响。",
      buttons: ["取消", "卸载联动控件"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true, ...getDeviceControlStatus() };
    const previous = getDeviceControlStatus();
    let config;
    try { config = getConnection(); } catch {}
    writeLog("device_control_uninstall_start", { deviceId: previous.deviceId });
    try {
      const status = await uninstallDeviceControl();
      if (config) {
        try { await markDeviceControlDisabled(config, previous, (fingerprint) => trustHost(config, fingerprint), writeLog); }
        catch (error) { writeLog("device_control_registry_disable_failed", { deviceId: previous.deviceId, error }); }
      }
      writeLog("device_control_uninstall_success");
      return status;
    } catch (error) {
      writeLog("device_control_uninstall_failed", { error });
      throw error;
    }
  });
  ipcMain.handle("bridge:status", async () => {
    const config = getSshConnection();
    return getAgentSdkBridgeStatus(config, (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  ipcMain.handle("bridge:install", async () => {
    const config = getSshConnection();
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "安装增强 Bridge",
      message: "允许在目标 NAS 安装增强聊天组件吗？",
      detail: `目标：${config.username}@${config.host}:${config.port}\n\n软件会写入当前 SSH 账号目录 ~/.agent-orbit/bridge，并通过 npm 安装 Agent SDK 依赖。基础聊天不需要此组件；安装后可获得精确停止和工具确认。不会修改 Claude 的模型、账号或全局设置。`,
      buttons: ["取消", "安装增强 Bridge"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true };
    writeLog("agent_sdk_bridge_install_requested", { host: config.host, username: config.username ? config.username[0] + "***" : "" });
    return installAgentSdkBridge(config, bundledBridgeFiles(), (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  ipcMain.handle("bridge:uninstall", async () => {
    const config = getSshConnection();
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "移除增强 Bridge",
      message: "确定移除该 NAS 的增强 Bridge 吗？",
      detail: "将删除当前 SSH 账号目录 ~/.agent-orbit/bridge。基础直连聊天仍可使用，但精确停止和工具确认会降级。",
      buttons: ["取消", "移除增强 Bridge"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true };
    return uninstallAgentSdkBridge(config, (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  ipcMain.handle("markdown:render", (_event, source) => renderMarkdown(source));
  // ── 模式管理 IPC ──
  ipcMain.handle("modes:list", () => listModes());
  ipcMain.handle("modes:get", (_event, id) => getMode(id));
  ipcMain.handle("modes:create", (_event, input) => createMode(input));
  ipcMain.handle("modes:update", (_event, id, input) => updateMode(id, input));
  ipcMain.handle("modes:delete", (_event, id) => deleteMode(id));
  ipcMain.handle("modes:export", () => exportModes());
  ipcMain.handle("modes:import", (_event, json) => importModes(json));
  // ── 品牌验证 IPC ──（篡改时返回虚假数据）
  ipcMain.handle("brand:get-config", () => {
    if (integrityGuard.isTampered) {
      return integrityGuard.fakeData?.brandConfig || brandManager.getBrandConfig();
    }
    return brandManager.getBrandConfig();
  });
  ipcMain.handle("brand:get-status", () => {
    if (integrityGuard.isTampered) {
      // 篡改模式下返回虚假状态：看起来未验证，实际数据是假的
      return {
        verified: false,
        brandConfig: integrityGuard.fakeData?.brandConfig || brandManager.getBrandConfig()
      };
    }
    return {
      verified: brandManager.isVerified,
      brandConfig: brandManager.getBrandConfig()
    };
  });
  ipcMain.handle("brand:admin-override", async (_event, adminPassword) => {
    if (integrityGuard.isTampered) {
      // 篡改模式下管理员覆盖永远失败，但返回看起来正常的响应
      return { success: false, message: "验证失败，请重试" };
    }
    return await brandManager.adminOverride(adminPassword);
  });
  // ── 网络状态 IPC ──
  ipcMain.handle("network:status", () => networkManager.getStatus());
  ipcMain.handle("network:connect", async (_event, config) => {
    try {
      const settings = getSshConnection();
      const mergedConfig = { ...settings, ...config };
      const transport = await networkManager.connect(mergedConfig, (fingerprint) => trustHostFingerprint(fingerprint), writeLog);
      if (!latencyMonitor) {
        latencyMonitor = new LatencyMonitor({ onUpdate: (summary) => { if (window && !window.isDestroyed()) window.webContents.send("network:latency", summary); } });
      }
      latencyMonitor.start(transport);
      return networkManager.getStatus();
    } catch (error) {
      writeLog("network_connect_failed", { error: error.message });
      throw error;
    }
  });
  ipcMain.handle("network:disconnect", async () => {
    if (latencyMonitor) latencyMonitor.stop();
    await networkManager.disconnect();
    persistNetworkState();
    return networkManager.getStatus();
  });
  ipcMain.handle("network:persist-state", () => { persistNetworkState(); return networkManager.getStatus(); });
  networkManager.onStatusChange((event) => {
    if (window && !window.isDestroyed()) window.webContents.send("network:status-change", event);
    persistNetworkState();
  });
  ipcMain.handle("link:open", async (_event, value) => {
    let target;
    try { target = new URL(String(value)); } catch { throw new Error("链接地址无效。"); }
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error("只允许打开 HTTP 或 HTTPS 链接。");
    await shell.openExternal(target.toString());
    return true;
  });
  ipcMain.handle("conversations:list", () => listConversations());
  ipcMain.handle("conversations:create", () => createConversation());
  ipcMain.handle("conversations:get", (_event, id) => {
    const conversation = getConversation(id);
    return conversation ? { ...conversation, sessionId: sessionForMode(conversation, getSettings().connectionMode) } : null;
  });
  ipcMain.handle("conversations:clear-session", (_event, id) => clearConversationSession(id));
  ipcMain.handle("conversations:rename", (_event, id, title) => renameConversation(id, title));
  ipcMain.handle("conversations:set-pinned", (_event, id, pinned) => setConversationPinned(id, pinned));
  ipcMain.handle("conversations:delete", (_event, id) => deleteConversation(id));
  ipcMain.handle("conversations:search", (_event, query, limit) => searchConversations(query, limit));
  ipcMain.handle("file:preview", async (_event, file) => {
    const mimeType = previewMime(file?.name);
    if (!mimeType) throw new Error("此文件类型不支持图片预览。");
    const config = file?.localPath ? null : getSshConnection();
    const data = file?.localPath
      ? readLocalFile(file.localPath, 8 * 1024 * 1024)
      : await readRemoteFile(config, file.remotePath, 8 * 1024 * 1024, (fingerprint) => trustHost(config, fingerprint), writeLog);
    return `data:${mimeType};base64,${data.toString("base64")}`;
  });
  ipcMain.handle("file:save", async (_event, file) => {
    const result = await dialog.showSaveDialog(window, {
      title: "保存 Claude 返回的文件",
      defaultPath: path.join(app.getPath("downloads"), safeFileName(file?.name))
    });
    if (result.canceled || !result.filePath) return "";
    const config = file?.localPath ? null : getSshConnection();
    if (file?.localPath) copyLocalFile(file.localPath, result.filePath);
    else await downloadRemoteFile(config, file.remotePath, result.filePath, (fingerprint) => trustHost(config, fingerprint), writeLog);
    writeLog("agent_file_saved", { sourceType: file?.localPath ? "local" : "ssh", remotePath: file?.remotePath, localPath: result.filePath, size: file.size });
    return result.filePath;
  });
  ipcMain.handle("file:open", async (_event, file) => {
    const directory = path.join(app.getPath("temp"), "Agent Chat Pro");
    require("fs").mkdirSync(directory, { recursive: true });
    const localPath = path.join(directory, `${randomUUID()}-${safeFileName(file?.name)}`);
    const config = file?.localPath ? null : getSshConnection();
    if (file?.localPath) copyLocalFile(file.localPath, localPath);
    else await downloadRemoteFile(config, file.remotePath, localPath, (fingerprint) => trustHost(config, fingerprint), writeLog);
    const error = await shell.openPath(localPath);
    if (error) throw new Error("文件已下载，但无法打开：" + error);
    return localPath;
  });
  ipcMain.handle("chat:test-proxy", async (_event, proxyConfig) => {
    const merged = { ...(proxyConfig || {}) };
    if (!merged.password) {
      // 表单密码留空时用已保存的代理密码兜底（避免"密码已保存未重输"场景测试失败）
      const cloudConfig = getCloudAiConfig();
      if (cloudConfig?.proxy?.password) merged.password = cloudConfig.proxy.password;
    }
    const result = await testProxyConnectivity(merged);
    writeLog("proxy_test", { ok: result.ok, latencyMs: result.latencyMs, statusCode: result.statusCode }); // 不记录地址/凭据
    return result;
  });
  ipcMain.handle("connection:test", async (_event, input) => {
    const mode = input?.connectionMode === "local" ? "local" : input?.connectionMode === "cloud" ? "cloud" : "ssh";
    if (mode === "cloud") {
      const savedConfig = getCloudAiConfig();
      const inputOverrides = {};
      if (input?.cloudAiApiKey) inputOverrides.apiKey = input.cloudAiApiKey;
      if (input?.cloudAiBaseUrl) inputOverrides.baseURL = input.cloudAiBaseUrl;
      if (input?.cloudAiModel) inputOverrides.model = input.cloudAiModel;
      if (input?.cloudAiProvider) inputOverrides.provider = input.cloudAiProvider;
      const config = { ...savedConfig, ...inputOverrides };
      if (!config.apiKey) throw new Error("请输入云端 AI 密钥。");
      writeLog("connection_test_start", { connectionMode: "cloud", baseURL: sanitizeUrl(config.baseURL), model: config.model });
      try {
        await verifyCloudConnection(config, writeLog);
        writeLog("connection_test_success", { connectionMode: "cloud" });
        return `云端 AI 连接成功 (${config.model || "glm-4-flash"})`;
      } catch (error) {
        writeLog("connection_test_failed", { error: error.message });
        throw error;
      }
    }
    let saved;
    try { saved = mode === "local" ? getSettings() : getConnection(); }
    catch (error) {
      if (mode !== "ssh" || !input?.password) throw error;
      saved = getSettings();
    }
    const config = { ...saved, ...input, connectionMode: mode === "local" ? "local" : "ssh", password: input.password || saved.password };
    writeLog("connection_test_start", { connectionMode: mode, host: config.host, port: config.port, username: config.username ? config.username[0] + "***" : "", wakeName: config.wakeName });
    try {
      const result = mode === "local"
        ? await verifyLocalConnection(config, writeLog)
        : await verifyConnection(config, (fingerprint) => trustHost(config, fingerprint), writeLog);
      writeLog("connection_test_success", { version: result });
      return result;
    } catch (error) {
      writeLog("connection_test_failed", { error });
      throw error;
    }
  });
  ipcMain.handle("chat:send", async (event, input) => {
    writeLog("work_status_signal", statusSignalEntry({
      requestId: input?.id,
      direction: "main-received",
      signal: "chat-send",
      disposition: "received",
      textLength: String(input?.message || "").length,
      attachmentCount: Array.isArray(input?.attachments) ? input.attachments.length : 0
    }));
    const id = input.id || randomUUID();
    const settings = getSettings();
    const connectionMode = settings.connectionMode;
    const message = String(input.message || "").trim();
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    if (attachments.length > 10) throw new Error("一次最多添加 10 个附件。");
    if (attachments.some((file) => Number(file?.data?.byteLength || 0) > 30 * 1024 * 1024)) {
      throw new Error("单个附件不能超过 30 MB。");
    }
    if (!message && !attachments.length) throw new Error("请输入消息或添加附件。");
    if (!input.conversationId) throw new Error("请先新建一个对话。");
    writeLog("work_status_signal", statusSignalEntry({
      requestId: id,
      direction: "main-received",
      signal: "chat-send",
      disposition: "accepted",
      textLength: message.length,
      attachmentCount: attachments.length
    }));
    const startedAt = Date.now();
    addUserMessage(input.conversationId, message, attachments.map((file) => file.name));
    writeLog("chat_send_start", {
      requestId: id,
      conversationId: input.conversationId,
      hasSession: Boolean(input.sessionId),
      textLength: message.length,
      attachments: attachments.map((file) => ({ name: file.name, size: file.data?.byteLength || 0, mimeType: file.mimeType }))
    });

    // settings 和 connectionMode 已在上方声明

    // ── 云端 AI 模式 ──
    if (connectionMode === "cloud") {
      const cloudConfig = getCloudAiConfig();
      if (!cloudConfig.apiKey) throw new Error("请先在连接设置中填写云端 AI 密钥。");
      const conversation = getConversation(input.conversationId);
      const modeConfig = input.workModeId ? await (async () => { try { return await getMode(input.workModeId); } catch { return null; } })() : null;
      const systemPrompt = modeConfig?.systemPrompt || "";
      const cloudMessages = buildMessages(conversation, systemPrompt);
      cloudMessages.push({ role: "user", content: message });
      let streamedText = "";
      let draftTimer;
      const persistDraft = () => {
        draftTimer = undefined;
        if (!streamedText) return;
        try { saveAssistantDraft(input.conversationId, id, streamedText); }
        catch (error) { writeLog("conversation_draft_save_failed", { requestId: id, conversationId: input.conversationId, error }); }
      };
      const cloudCallbacks = {
        onDelta: (text) => {
          streamedText += text;
          sendWorkStatusSignal(event.sender, "chat:delta", { id, text });
          if (!draftTimer) draftTimer = setTimeout(persistDraft, 1000);
        },
        onStatus: (status) => sendWorkStatusSignal(event.sender, "chat:event", { id, type: "connection", status }),
        onUsage: (usage) => sendWorkStatusSignal(event.sender, "chat:event", { id, type: "usage", usage }),
        onLog: writeLog
      };
      sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "connecting" }, { connectionMode: "cloud" }));
      const cloudPromise = sendCloudChat({
        apiKey: cloudConfig.apiKey,
        baseURL: cloudConfig.baseURL,
        model: cloudConfig.model || "glm-4-flash",
        maxTokens: modeConfig?.maxTokens || cloudConfig.maxTokens || 4096,
        temperature: modeConfig?.hallucinationControl === "strict" ? 0.3 : modeConfig?.hallucinationControl === "creative" ? 0.9 : undefined,
        provider: cloudConfig.provider,
        proxy: cloudConfig.proxy,
      }, cloudMessages, cloudCallbacks);
      activeRequests.set(id, { promise: cloudPromise, cancel: () => { cloudPromise.cancel?.(); }, conversationId: input.conversationId });
      // 信号链：四阶段契约（turn → transport → adapter → runner）+ 灯带投影
      const chatChain = safeSignal("chat-chain-create", () => signalMonitor.createRequest({ requestId: id, conversationId: input.conversationId, connectionMode: "cloud", attachmentCount: attachments.length, hasSession: Boolean(input.sessionId) }));
      safeSignal("chain-open", () => { chatChain.turnReceived(); chatChain.turnToTransport({}); chatChain.transportReceived({}); chatChain.transportToAdapter({}); chatChain.adapterReceived({}); chatChain.adapterToRunner({}); chatChain.runnerReceived({}); chatChain.runnerOperation({ promise: cloudPromise }); });
      try {
        const result = await cloudPromise;
        if (draftTimer) clearTimeout(draftTimer);
        safeSignal("chain-complete", () => chatChain.complete({}));
        if (result.cancelled) {
          addAssistantMessage(input.conversationId, streamedText || "已停止。", "", [], [], id, "cloud");
          writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "cancelled", eventType: "lifecycle", eventStatus: "cancelled" }));
          sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "cancelled" }, { connectionMode: "cloud" }));
          return { id, cancelled: true, text: streamedText, sessionId: "", tools: [], files: [] };
        }
        addAssistantMessage(input.conversationId, result.text, "", [], [], id, "cloud");
        const stats = conversationStats(getConversation(input.conversationId));
        writeLog("chat_send_success", { requestId: id, conversationId: input.conversationId, textLength: result.text.length, connectionMode: "cloud" });
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "completed", eventType: "lifecycle", eventStatus: "finished" }));
        sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "finished" }, { connectionMode: "cloud" }));
        return { id, ...result, sessionId: "", tools: [], files: [], stats };
      } catch (error) {
        if (draftTimer) clearTimeout(draftTimer);
        persistDraft();
        writeLog("chat_send_failed", { requestId: id, conversationId: input.conversationId, error: error.message });
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "failed", eventType: "lifecycle", eventStatus: "failed" }));
        sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "failed" }, { connectionMode: "cloud" }));
        safeSignal("chain-failed", () => chatChain.failed(error));
        throw error;
      } finally {
        if (draftTimer) clearTimeout(draftTimer);
        activeRequests.delete(id);
      }
    }

    // ── SSH / 本机模式 ──
    const config = getConnection();
    const agentMessage = `${message}${message ? "\n\n" : ""}[来源电脑：${config.clientLabel}]`;
    const conversation = getConversation(input.conversationId);
    const activeSessionId = sessionForMode(conversation, config.connectionMode);
    let streamedText = "";
    let streamedTurnText = "";
    let completedTurnCount = 0;
    let latestSessionId = activeSessionId;
    let draftTimer;
    const persistDraft = () => {
      draftTimer = undefined;
      if (!streamedTurnText) return;
      try { saveAssistantDraft(input.conversationId, id, streamedTurnText); }
      catch (error) { writeLog("conversation_draft_save_failed", { requestId: id, conversationId: input.conversationId, error }); }
    };
    const callbacks = {
      conversationId: input.conversationId,
      onDelta: (text) => {
        if (completedTurnCount > 0 && !streamedTurnText) {
          event.sender.send("chat:turn-start", { id });
        }
        streamedText += text;
        streamedTurnText += text;
        const normalized = normalizeAndObserveStatusEvent({ id, type: "delta", text }, config);
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "executor-emitted", signal: "runner-event", disposition: "emitted", eventType: "delta", textLength: String(text || "").length }));
        sendWorkStatusSignal(event.sender, "chat:delta", normalized);
        if (!draftTimer) draftTimer = setTimeout(persistDraft, 1000);
      },
      onUploadProgress: (progress) => {
        const normalized = normalizeAndObserveStatusEvent({ id, type: "upload", ...progress }, config);
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "executor-emitted", signal: "runner-event", disposition: "emitted", eventType: "upload", uploadPercent: Math.round(Number(progress?.overall || 0) * 100) }));
        sendWorkStatusSignal(event.sender, "chat:event", normalized);
      },
      onToolEvent: (tool) => {
        const normalized = normalizeAndObserveStatusEvent({ id, type: "tool", tool }, config);
        const audit = normalized.audit;
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "executor-emitted", signal: "runner-event", disposition: "emitted", eventType: "tool", ...audit }));
        sendWorkStatusSignal(event.sender, "chat:event", normalized);
      },
      onUsage: (usage) => {
        const normalized = normalizeAndObserveStatusEvent({ id, type: "usage", usage }, config);
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "executor-emitted", signal: "runner-event", disposition: "emitted", eventType: "usage" }));
        sendWorkStatusSignal(event.sender, "chat:event", normalized);
        // 上下文进度条数据（v3.10.0）：main 侧算好 contextTokens，渲染层只消费一个通道
        const contextTokens = contextTokensFromUsage(usage);
        if (contextTokens) {
          const state = lastKnownContext.get(input.conversationId) || { tokens: 0, limit: 0 };
          lastKnownContext.set(input.conversationId, { ...state, tokens: contextTokens });
        }
        sendWorkStatusSignal(event.sender, "chat:context", { id, type: "usage", contextTokens });
      },
      onModelChange: (info) => {
        if (info?.contextLimit) {
          const state = lastKnownContext.get(input.conversationId) || { tokens: 0, limit: 0 };
          lastKnownContext.set(input.conversationId, { ...state, limit: Number(info.contextLimit) || 0 });
        }
        sendWorkStatusSignal(event.sender, "chat:context", { id, type: "model", model: info.model, contextLimit: info.contextLimit });
      },
      onCompactEvent: (compactEvent) => {
        writeLog("context_compact_event", { requestId: id, phase: compactEvent.phase, success: compactEvent.success, preTokens: compactEvent.preTokens, postTokens: compactEvent.postTokens, trigger: compactEvent.trigger, error: compactEvent.error || "" });
        sendWorkStatusSignal(event.sender, "chat:context", { id, type: "compact", ...compactEvent });
      },
      onStatus: (status) => {
        const normalized = normalizeAndObserveStatusEvent({ id, type: "connection", status }, config);
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "executor-emitted", signal: "runner-event", disposition: "emitted", eventType: "connection", eventStatus: status }));
        sendWorkStatusSignal(event.sender, "chat:event", normalized);
        // 桥被强制关闭（SSH 断开 / 进程被杀）时通知渲染层：状态条降级 + 清除等待态
        if (status === "stopped" && !window?.isDestroyed()) {
          event.sender.send("bridge:force-closed", { id, reason: "runner-stopped", connectionMode: config.connectionMode });
        }
      },
      onSessionId: (sessionId) => {
        latestSessionId = sessionId || latestSessionId;
        try {
          saveConversationSession(input.conversationId, sessionId, config.connectionMode);
          writeLog("chat_session_checkpointed", { requestId: id, conversationId: input.conversationId, sessionId, connectionMode: config.connectionMode });
        } catch (error) {
          writeLog("chat_session_checkpoint_failed", { requestId: id, conversationId: input.conversationId, error });
        }
      },
      onTurnComplete: ({ text, sessionId: turnSessionId, usage: turnUsage }) => {
        if (draftTimer) clearTimeout(draftTimer);
        draftTimer = undefined;
        const completedText = String(text || streamedTurnText || "");
        if (completedText) {
          saveAssistantDraft(input.conversationId, id, completedText);
          addAssistantMessage(input.conversationId, completedText, turnSessionId || latestSessionId, [], [], id, config.connectionMode, turnUsage);
          completedTurnCount += 1;
        }
        streamedTurnText = "";
        event.sender.send("chat:turn-complete", { id });
      },
      onPermissionRequest: async (request) => {
        const waiting = normalizeAndObserveStatusEvent({ id, type: "permission", status: "waiting", toolName: request.toolName || "" }, config);
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "executor-emitted", signal: "runner-event", disposition: "emitted", eventType: "permission", eventStatus: "waiting", toolName: request.toolName }));
        sendWorkStatusSignal(event.sender, "chat:event", waiting);
        const detail = JSON.stringify(request.input || {}, null, 2);
        const answer = await dialog.showMessageBox(window, {
          type: "question",
          title: "允许 Agent 执行工具？",
          message: `Agent 请求运行：${request.toolName || "工具"}`,
          detail,
          buttons: ["拒绝", "允许"],
          defaultId: 1,
          cancelId: 0,
          noLink: true
        });
        const allowed = answer.response === 1;
        sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "permission", status: allowed ? "allowed" : "denied", toolName: request.toolName || "" }, config));
        return allowed;
      },
      onUnknownHost: (fingerprint) => trustHost(config, fingerprint),
      onAudit: (entry) => writeLog("work_status_signal", statusSignalEntry({
        requestId: id,
        direction: "executor-emitted",
        signal: "transport-event",
        disposition: "emitted",
        eventType: "transport",
        ...entry
      })),
      onLog: writeLog
    };
    config.localUploadDirectory = path.join(app.getPath("userData"), "local-uploads");
    config.workModeId = input.workModeId || config.workModeId || "regular";
    const operation = config.connectionMode === "local"
      ? runLocalClaude(config, agentMessage, activeSessionId, attachments, callbacks)
      : runClaude(config, agentMessage, activeSessionId, attachments, callbacks);
    writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "started", eventType: "lifecycle", eventStatus: "started", transport: config.connectionMode === "local" ? "local-stdio" : "ssh" }));
    activeRequests.set(id, { operation, conversationId: input.conversationId });
    // 信号链：四阶段契约（turn → transport → adapter → runner）+ 灯带投影
    const chatChain = safeSignal("chat-chain-create", () => signalMonitor.createRequest({ requestId: id, conversationId: input.conversationId, connectionMode: config.connectionMode, attachmentCount: attachments.length, hasSession: Boolean(activeSessionId) }));
    safeSignal("chain-open", () => { chatChain.turnReceived(); chatChain.turnToTransport({}); chatChain.transportReceived({}); chatChain.transportToAdapter({}); chatChain.adapterReceived({}); chatChain.adapterToRunner({}); chatChain.runnerReceived({}); chatChain.runnerOperation({ promise: operation.promise }); });
    sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "started" }, config));
    try {
      const result = await operation.promise;
      if (draftTimer) clearTimeout(draftTimer);
      safeSignal("chain-complete", () => chatChain.complete({}));
      if (!completedTurnCount) {
        addAssistantMessage(input.conversationId, result.text, result.sessionId, result.files, result.tools, id, config.connectionMode, result.usage, Date.now() - startedAt);
      }
      const stats = conversationStats(getConversation(input.conversationId));
      writeLog("chat_send_success", { requestId: id, conversationId: input.conversationId, sessionId: result.sessionId, textLength: result.text.length });
      writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "completed", eventType: "lifecycle", eventStatus: "finished" }));
      sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "finished" }, config));
      // 自动压缩（v3.10.0）：请求完成后检查上下文占用，超阈值异步触发（不阻塞返回值）
      maybeAutoCompact(event.sender, result.sessionId || latestSessionId, input.conversationId);
      return { id, ...result, stats };
    } catch (error) {
      if (draftTimer) clearTimeout(draftTimer);
      persistDraft();
      if (error?.cancelled || /^已停止/.test(String(error?.message || ""))) {
        writeLog("chat_send_cancelled", { requestId: id, conversationId: input.conversationId, textLength: streamedText.length });
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "cancelled", eventType: "lifecycle", eventStatus: "cancelled" }));
        sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "cancelled" }, config));
        return { id, cancelled: true, text: streamedText, sessionId: activeSessionId, files: [], tools: [] };
      }
      writeLog("chat_send_failed", { requestId: id, conversationId: input.conversationId, error });
      writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "failed", eventType: "lifecycle", eventStatus: "failed" }));
      sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "failed" }, config));
      safeSignal("chain-failed", () => chatChain.failed(error));
      throw error;
    } finally {
      if (draftTimer) clearTimeout(draftTimer);
      activeRequests.delete(id);
    }
  });

  // ── 上下文压缩（v3.10.0）──
  // 同一会话防重入：手动点击与自动触发共用
  const compactingSessions = new Set();
  // 每个对话最近的上下文占用/模型窗口（conversationId → {tokens, limit}），自动压缩判断依据
  const lastKnownContext = new Map();

  /** 自动压缩：compactAuto 开启且上下文占用超过阈值时异步触发（不阻塞聊天返回值） */
  const maybeAutoCompact = (sender, sessionId, conversationId) => {
    try {
      if (!sender || sender.isDestroyed?.()) return;
      const autoSettings = getSettings();
      if (!autoSettings.compactAuto) return;
      const sid = String(sessionId || "");
      if (!sid || !lastKnownContext.has(conversationId)) return;
      const state = lastKnownContext.get(conversationId);
      if (!state.tokens || !state.limit) return;
      const percent = (state.tokens / state.limit) * 100;
      if (percent < Number(autoSettings.compactThreshold || 80)) return;
      writeLog("context_compact_auto_triggered", { conversationId, sessionId: sid, percent: Math.round(percent), threshold: autoSettings.compactThreshold });
      executeCompact(sender, sid, conversationId, autoSettings.compactInstruction || "", { source: "auto" }).catch((error) => {
        writeLog("context_compact_auto_failed", { conversationId, sessionId: sid, error: error.message });
      });
    } catch (error) {
      writeLog("context_compact_auto_failed", { error: error.message });
    }
  };

  // 渲染层切换对话时回填该对话的上下文进度条（v3.12.1：切回旧对话不再归零）
  ipcMain.handle("context:get", (_event, conversationId) => {
    return lastKnownContext.get(String(conversationId || "")) || null;
  });

  /**
   * 执行压缩：独立一次 CLI 调用（resume 原会话 + 输入 "/compact"）。
   * /compact 是 CLI 本地命令（harness 拦截执行），不产生文本流，只发压缩事件。
   */
  const executeCompact = async (sender, sessionId, conversationId, instruction = "", options = {}) => {
    const config = getConnection();
    if (config.connectionMode === "cloud") throw new Error("云端模式直连 API，没有上下文压缩。");
    const sid = String(sessionId || "");
    if (!sid) throw new Error("当前对话还没有会话记录，无法压缩。");
    // 会话防重入
    if (compactingSessions.has(sid)) {
      return { ok: false, event: null, error: "该会话的压缩已在进行中，请稍候。" };
    }
    // Agent 正在回复时禁止压缩（避免两个 CLI 进程同时操作同一会话）
    if (conversationId && [...activeRequests.values()].some((req) => req.conversationId === conversationId)) {
      throw new Error("Agent 正在回复，暂时不能压缩上下文。请等待回复结束后再试。");
    }
    const compactId = randomUUID();
    const compactText = `/compact${instruction ? ` ${instruction}` : ""}`;
    let lastEvent = null;
    compactingSessions.add(sid);
    writeLog("context_compact_requested", { requestId: compactId, sessionId: sid, connectionMode: config.connectionMode, source: options.source || "manual", instruction: instruction ? "custom" : "default" });
    sendWorkStatusSignal(sender, "chat:context", { id: compactId, type: "compact", phase: "started", source: options.source || "manual" });
    const compactCallbacks = {
      conversationId: conversationId || "",
      onDelta: () => {},
      onUploadProgress: () => {},
      onToolEvent: () => {},
      onUsage: () => {},
      onStatus: (status) => {
        sendWorkStatusSignal(sender, "chat:context", { id: compactId, type: "compact-runner", status });
      },
      onSessionId: () => {},
      onTurnComplete: () => {},
      onPermissionRequest: async () => false,
      onUnknownHost: (fingerprint) => trustHost(config, fingerprint),
      onAudit: () => {},
      onLog: writeLog,
      onModelChange: (info) => {
        sendWorkStatusSignal(sender, "chat:context", { id: compactId, type: "model", model: info.model, contextLimit: info.contextLimit });
      },
      onCompactEvent: (compactEvent) => {
        lastEvent = compactEvent;
        writeLog("context_compact_event", { requestId: compactId, sessionId: sid, phase: compactEvent.phase, success: compactEvent.success, preTokens: compactEvent.preTokens, postTokens: compactEvent.postTokens, trigger: compactEvent.trigger, error: compactEvent.error || "" });
        // 压缩边界：用 postTokens 覆盖该对话的上下文占用（供下次自动压缩判断）
        if (compactEvent.phase === "boundary" && Number(compactEvent.postTokens) > 0 && conversationId) {
          const state = lastKnownContext.get(conversationId) || { tokens: 0, limit: 0 };
          lastKnownContext.set(conversationId, { ...state, tokens: Number(compactEvent.postTokens) });
        }
        sendWorkStatusSignal(sender, "chat:context", { id: compactId, type: "compact", ...compactEvent });
      }
    };
    const compactConfig = { ...config, workModeId: "regular" };
    compactConfig.localUploadDirectory = path.join(app.getPath("userData"), "local-uploads");
    const operation = config.connectionMode === "local"
      ? runLocalClaude(compactConfig, compactText, sid, [], compactCallbacks)
      : runClaude(compactConfig, compactText, sid, [], compactCallbacks);
    activeRequests.set(compactId, { operation, conversationId: conversationId || "" });
    try {
      await operation.promise;
      const success = Boolean(lastEvent && lastEvent.phase === "finished" && lastEvent.success);
      writeLog("context_compact_done", { requestId: compactId, sessionId: sid, success, error: lastEvent?.error || "" });
      return { ok: success, event: lastEvent || null, error: success ? "" : (lastEvent?.error || "压缩未完成，请稍后重试。") };
    } catch (error) {
      writeLog("context_compact_failed", { requestId: compactId, sessionId: sid, error: error.message });
      sendWorkStatusSignal(sender, "chat:context", { id: compactId, type: "compact", phase: "finished", success: false, error: error.message });
      throw error;
    } finally {
      activeRequests.delete(compactId);
      compactingSessions.delete(sid);
    }
  };

  ipcMain.handle("chat:compact", async (event, payload) => {
    return executeCompact(event.sender, String(payload?.sessionId || ""), String(payload?.conversationId || ""), String(payload?.instruction ?? "").trim(), { source: "manual" });
  });
  ipcMain.handle("chat:push-follow-up", async (_event, input) => {
    const id = String(input?.id || "");
    const followUpMessage = String(input?.message || "").trim();
    const request = activeRequests.get(id);
    if (!request || !followUpMessage || typeof request.operation?.pushFollowUp !== "function") return { accepted: false };
    const followUpConfig = getConnection();
    const agentMessage = `${followUpMessage}\n\n[来源电脑：${followUpConfig.clientLabel}]`;
    if (!(await request.operation.pushFollowUp(agentMessage))) return { accepted: false };
    addUserMessage(request.conversationId, followUpMessage);
    writeLog("chat_follow_up_accepted", { requestId: id, conversationId: request.conversationId, textLength: followUpMessage.length });
    return { accepted: true };
  });
  ipcMain.handle("chat:cancel", (_event, id) => {
    writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "chat-cancel", disposition: "accepted" }));
    const request = activeRequests.get(id);
    if (!request) return false;
    try {
      request.operation.cancel();
      writeLog("chat_cancel_requested", { requestId: id });
      return true;
    } catch (error) {
      writeLog("chat_cancel_failed", { requestId: id, error });
      return false;
    }
  });
  ipcMain.handle("cache:scan", async () => {
    try {
      const result = await scanSystemCaches();
      writeLog("cache_scan_done", { supported: result.supported, targets: result.targets.length });
      return result;
    } catch (error) {
      writeLog("cache_scan_failed", { error: error.message });
      throw error;
    }
  });
  ipcMain.handle("cache:clean", async (event, targets) => {
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) throw new Error("请先勾选要清理的缓存项。");
    writeLog("cache_clean_requested", { targets: list.join(",") });
    const result = await cleanSystemCaches(list, (message) => writeLog("cache_clean_step", { message }));
    const okCount = result.results.filter((r) => r.ok).length;
    const freedTotal = result.results.reduce((sum, r) => sum + (r.freed || 0), 0);
    writeLog("cache_clean_done", { ok: okCount, failed: result.results.length - okCount, freedTotal });
    return result;
  });
  ipcMain.handle("window:is-maximized", () => Boolean(window?.isMaximized()));
  ipcMain.handle("window:focus", () => {
    if (!window || window.isDestroyed()) return false;
    window.show();
    window.focus();
    window.webContents.focus();
    return true;
  });
  ipcMain.handle("window:restore-native-dialog-focus", async (event) => {
    if (event.sender !== window?.webContents || !window || window.isDestroyed()) return false;
    // Chromium on Windows can leave editable DOM controls inert after a
    // renderer-owned alert/confirm closes. Restore native focus first, then
    // let the renderer select its textarea via the window:focus notification.
    window.blur();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (window.isDestroyed()) return false;
    window.focus();
    window.webContents.focus();
    return true;
  });
  ipcMain.handle("window:action", (_event, action) => handleWindowAction(action));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // ── 网络状态持久化与自动重连 ──
  // 启动时：如果上次外网连接成功过，自动重连
  try {
    const startupSettings = getSettings();
    if (startupSettings.networkType === "external" && startupSettings.networkLastState === "connected") {
      writeLog("network_auto_reconnect_start", { externalMethod: startupSettings.externalMethod });
      networkManager.connect(getSshConnection(), (fingerprint) => trustHostFingerprint(fingerprint), writeLog).then((transport) => {
        if (!latencyMonitor) {
          latencyMonitor = new LatencyMonitor({ onUpdate: (summary) => { if (window && !window.isDestroyed()) window.webContents.send("network:latency", summary); } });
        }
        latencyMonitor.start(transport);
        persistNetworkState();
        writeLog("network_auto_reconnect_success", { externalMethod: startupSettings.externalMethod });
      }).catch((error) => {
        writeLog("network_auto_reconnect_failed", { error: error.message });
      });
    }
  } catch (error) {
    writeLog("network_auto_reconnect_error", { error: error.message });
  }

  // 关闭时保存网络状态和停止授权定期检查
  app.on("before-quit", () => { persistNetworkState(); brandManager.stopPeriodicCheck(); });
});

function handleWindowAction(action) {
  if (!window || window.isDestroyed()) return false;
  const web = window.webContents;
  const editing = { undo: "undo", redo: "redo", cut: "cut", copy: "copy", paste: "paste", selectAll: "selectAll" };
  if (editing[action]) web[editing[action]]();
  else if (action === "minimize") window.minimize();
  else if (action === "toggle-maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
  else if (action === "close") window.close();
  else if (action === "quit") app.quit();
  else if (action === "zoom-reset") web.setZoomFactor(1);
  else if (action === "zoom-in") web.setZoomFactor(Math.min(2, web.getZoomFactor() + 0.1));
  else if (action === "zoom-out") web.setZoomFactor(Math.max(0.5, web.getZoomFactor() - 0.1));
  else if (action === "fullscreen") window.setFullScreen(!window.isFullScreen());
  else if (action === "about") dialog.showMessageBox(window, {
    type: "info",
    title: "关于 Agent Chat Pro",
    message: "Agent Chat Pro",
    detail: `版本 ${app.getVersion()}\n支持内网直连/外网穿透双模式 SSH 远程 AI 聊天；支持云端 AI 直连和本机模式；当前内置 Claude Code 适配器。`,
    buttons: ["确定"]
  });
  else return false;
  return true;
}

function trustHost(config, fingerprint) {
  const answer = dialog.showMessageBoxSync(window, {
    type: "warning",
    buttons: ["取消连接", "信任此指纹并继续"],
    defaultId: 0,
    cancelId: 0,
    title: "确认 NAS SSH 主机指纹",
    message: `首次连接 ${config.host}:${config.port}`,
    detail: `请只在确认这是你的 NAS 时信任此主机指纹：\n${fingerprint}\n\n之后如指纹变化，客户端会拒绝连接。`
  });
  if (answer !== 1) return false;
  trustHostFingerprint(fingerprint);
  return true;
}

function safeFileName(value) {
  return String(value || "Claude-文件").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 180) || "Claude-文件";
}

function previewMime(value) {
  const extension = String(value || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" })[extension] || "";
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("child-process-gone", (_event, details) => writeLog("child_process_gone", details));

process.on("uncaughtException", (error) => writeLog("uncaught_exception", { error }));
process.on("unhandledRejection", (error) => writeLog("unhandled_rejection", { error }));