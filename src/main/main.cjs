"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { spawnSync } = require("child_process"); // v3.16.1 print:detect 调 reg/tasklist
const { clearModelAdminPassword, getConnection, getSettings, getAtomcodeToken, getSshConnection, getCloudAiConfig, sameSshTarget, saveSettings, setModelAdminPassword, switchSshProfile, trustHostFingerprint, verifyModelAdminPassword, ensureAgentBridgeToken, getAgentBridgeConversationId, setAgentBridgeConversationId, setAgentBridgeConfig } = require("./settings.cjs");
const { connect, connectWithRetry, downloadRemoteFile, ensureDeviceControlKey, exec, finalizeDeviceControl, getAgentSdkBridgeStatus, getClaudeModelStatus, installAgentSdkBridge, markDeviceControlDisabled, readDeviceControlIpTrack, readRemoteFile, runClaude, uninstallAgentSdkBridge, updateClaudeAutoCompactWindow, updateClaudeModel, updateClaudeModelEntry, verifyConnection } = require("./ssh.cjs");
const { copyLocalFile, getLocalClaudeModelStatus, readLocalFile, runLocalClaude, updateLocalAutoCompactWindow, updateLocalClaudeModel, updateLocalClaudeModelEntry, validatedWorkingDirectory: validatedLocalWorkdir, verifyLocalConnection } = require("./local.cjs");
const { runAtomCodeChat, verifyAtomCodeConnection } = require("./daemon-chat.cjs");
// v3.19.0 F3：SSH 远程适配器（qwen/codex/hermes 三家远端 CLI 跑法）
const { runQwenCli } = require("./adapters/qwen-cli.cjs");
const { runCodexCli } = require("./adapters/codex-cli.cjs");
const { runHermesCli } = require("./adapters/hermes-cli.cjs");
const { runCustomCli, verifyCustomCliConnection } = require("./custom-cli.cjs");
const { appendPlanConvention } = require("./plan-convention.cjs"); // v3.20.0 F5：云端路 ```plan 约定注入
const { contextTokensFromUsage } = require("./protocol.cjs");
const { scanSystemCaches, cleanSystemCaches } = require("./cache-cleaner.cjs");
const { getDeviceControlStatus, installDeviceControl, preferredAddress, uninstallDeviceControl } = require("./device-control.cjs");
const { scanCoexistence, summarizeCoexistence } = require("./coexistence-scanner.cjs");
// 产品形态开关（阉割机制）：bridge 版 = Agent HTTP 桥在场、设备联动/打印联动/本机引擎/彩蛋关闭
const EDITION = require("./edition.cjs");
const IS_BRIDGE = EDITION.edition === "bridge";
const { CLOUD_AI_TAG } = require("./agent-http-bridge.cjs");
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
  // v3.35.6 多 AI 对话（工作）：成员会话隔离与群聊绑定
  saveAgentSession,
  agentSessionFor,
  setConversationWorkgroup,
  setConversationPinned,
  saveConversationSession,
  saveAssistantDraft,
  searchConversations,
  sessionForMode,
  truncateConversationMessages, // v3.15.5 修复2：删除单条及下方所有落库消息
  conversationStats
} = require("./conversations.cjs");
const { logPath, writeLog } = require("./logger.cjs");
const { renderMarkdown } = require("./markdown.cjs");
const { samePath } = require("./storage.cjs");
const { listModes, getMode, createMode, updateMode, deleteMode, exportModes, importModes } = require("./modes/mode-manager.cjs");
const { buildCommandWithMode, buildBridgeStartWithMode, buildLocalArgsWithMode } = require("./modes/mode-params.cjs");
const { NetworkManager, STATES } = require("./network/network-manager.cjs");
const { LatencyMonitor } = require("./network/latency-monitor.cjs");
// v3.23.0 N2N 体检 + 一键部署（检测哪坏、缺哪补哪、stderr 上屏）
const { runN2nDoctor, runN2nDeploy } = require("./network/n2n-doctor.cjs");
const { sendCloudChat, buildMessages, verifyCloudConnection, testProxyConnectivity, accumulateUsage, isTruncatedStopReason } = require("./cloud-chat.cjs");
// v3.21.0 云端「拉取模型列表」：官方 GET /models 实时拉取该密钥可用的全部模型
const { fetchProviderModels } = require("./cloud-models.cjs");
// v3.36.0 输入栏「听说」：麦克风采好的 WAV 转发云端转录端点（复用已保存云配置，零新增配置）
const { transcribeAudio, asrInfoFor } = require("./voice-transcribe.cjs");
const { executeToolCall, toolDefinitions, MAX_TOOL_ROUNDS } = require("./cloud-tools.cjs");
// v3.24.0 模型思考调节：挡位表 + 请求体注入（四字段族）；ask_user 提问约定拼进云端 system prompt
const { resolveThinkingProfile, normalizeThinkingChoices } = require("./thinking-levels.cjs");
const { ASK_USER_HINT, createAskUserRegistry, ASK_USER_TIMEOUT, ASK_USER_STOPPED } = require("./cloud-tools.cjs");
// v3.24.0 ask_user 应答注册表（模块级单例；stop 请求 cancelAll 打断悬等）
const askUserRegistry = createAskUserRegistry();
const { collapseRepetition } = require("./repetition-guard.cjs"); // v3.15.5 修复1：复读检测折叠
// v3.35.6 多 AI 对话（工作）：Agent 池/工作组建档（模块一）+ 群聊引擎与 Sub-Agent 包工头（模块三④）
const poolModule = require("./agent-pool.cjs");
const { runGroupTurn, awaitGroupTurn, stopGroupTurns, executeSubAgent, summarize: subSummarize, slimError: subSlimError } = require("./workgroup-chat.cjs");
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

/** local 模式引擎（v3.13.0）：claude（默认，兼容旧配置）/ atomcode / custom */
function localEngineOf(config) {
  return config?.connectionMode === "local" ? String(config?.localEngine || "claude") : "claude";
}

// v3.18.0 F4：当前活跃 SSH 卡槽（会话隔离维度）——ssh 模式才有效，读失败按无名槽兜底
function activeSshProfileOf(config) {
  return config?.connectionMode === "ssh" ? String(getSettings().activeSshProfile || "") : "";
}

let window;
let agentBridgeInstance = null; // Agent HTTP 桥（阉割版 Bridge Edition 专属；主版恒 null）
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
  // ── v3.15.7 窗口导航兜底 ──
  // 背景：设置页密钥提示的服务商注册链接未接拦截，Electron 默认把主窗口整个导航到外链，UI
  // 被替换且无返回键 → 用户只能关掉应用重开。主进程双兜底，未来任何渲染层漏接都不会再劫持窗口。
  // ① target=_blank / window.open → 拒开子窗口，改走系统浏览器
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  // ② 主窗口内部导航拦外链（file:// 自身页面/锚点不受影响，loadFile 程序化加载不触发 will-navigate）
  window.webContents.on("will-navigate", (event, url) => {
    if (/^https?:/i.test(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
      writeLog("external_link_intercepted", { source: "will-navigate" });
    }
  });
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

// ── v3.15.8 关于页彩蛋：跳跳龙小游戏（Chrome dino 同款，主角换成 Claude Code 吉祥物）──
// 触发：设置中心·关于页点击「Agent Chat Pro」标题（renderer 接线）。单例窗口，无 preload（零 IPC 面）。
let dinoGameWindow = null;
function createDinoGameWindow() {
  if (dinoGameWindow && !dinoGameWindow.isDestroyed()) {
    if (dinoGameWindow.isMinimized()) dinoGameWindow.restore();
    dinoGameWindow.focus();
    writeLog("dino_game_opened", { reused: true });
    return { reused: true };
  }
  dinoGameWindow = new BrowserWindow({
    width: 960,
    height: 340,
    minWidth: 560,
    minHeight: 280,
    backgroundColor: "#00000000",
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  dinoGameWindow.setMenuBarVisibility(false);
  // 游戏页无外链；兜底防子窗口（与主窗口 v3.15.7 防线同款）
  dinoGameWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  dinoGameWindow.on("closed", () => { dinoGameWindow = null; });
  dinoGameWindow.loadFile(path.join(__dirname, "../renderer/game/dino.html"));
  writeLog("dino_game_opened", { reused: false });
  return { reused: false };
}

app.whenReady().then(async () => {
  // 阉割版 Bridge 用独立 AppUserModelId（与主版共存安装时通知/任务栏分组互不粘连）
  app.setAppUserModelId(IS_BRIDGE ? "com.jiang.agentChatProBridge" : "com.jiang.agentChatPro");
  nativeTheme.themeSource = "dark";
  writeLog("app_start", { version: app.getVersion(), platform: process.platform, arch: process.arch, edition: EDITION.edition });

  // v3.16.2 启动共存扫描：本机是否并存另一套 Agent 联动控件（Agent Orbit / Claude NAS 系）
  // 阉割版 Bridge 无设备联动，跳过扫描
  if (EDITION.gates.deviceLink) {
    try {
      const scan = scanCoexistence();
      if (scan.coexistence) writeLog("coexistence_scan_complete", { detected: true, otherFamilyInUse: scan.otherFamilyInUse, legacyOrphan: scan.legacyOrphan, conflicts: (scan.conflicts || []).map((c) => c.type), summary: summarizeCoexistence(scan) });
      else writeLog("coexistence_scan_complete", { detected: false });
    } catch (error) { writeLog("coexistence_scan_failed", { error: String(error && error.message || error) }); }
  }

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
  // v3.21.0 云端「拉取模型列表」：密钥用渲染层现值，留空时兜底已保存密钥（custom 用现填 baseUrl）
  ipcMain.handle("cloud:fetch-models", async (_event, payload = {}) => {
    let savedApiKey = "";
    try {
      savedApiKey = String(getCloudAiConfig().apiKey || "");
    } catch {
      savedApiKey = "";
    }
    const merged = { ...payload, apiKey: String(payload.apiKey || "").trim() || savedApiKey };
    const result = await fetchProviderModels(merged);
    if (!result.ok) writeLog("cloud_fetch_models_failed", { provider: payload.provider, reason: result.reason });
    else writeLog("cloud_fetch_models_ok", { provider: payload.provider, count: result.count });
    return result;
  });
  // ── v3.36.0 输入栏「听说」（语音转文字）：点按钮先问支持情况，说完把 WAV 交给主进程转发转录端点 ──
  ipcMain.handle("voice:info", () => {
    try {
      const cloudConfig = getCloudAiConfig();
      const info = asrInfoFor(cloudConfig.provider);
      return {
        ok: true,
        provider: cloudConfig.provider,
        supported: info.supported || false,
        maxSeconds: info.maxSeconds || 60,
        hasKey: Boolean(String(cloudConfig.apiKey || "").trim()),
        reason: info.reason || "",
      };
    } catch (error) {
      return { ok: false, supported: false, hasKey: false, maxSeconds: 60, reason: `读取连接设置失败：${error?.message || error}` };
    }
  });
  ipcMain.handle("voice:transcribe", async (_event, payload = {}) => {
    let config;
    try {
      config = getCloudAiConfig();
    } catch (error) {
      const result = { ok: false, reason: `读取连接设置失败：${error?.message || error}` };
      writeLog("voice_transcribe_failed", { reason: result.reason });
      return result;
    }
    const result = await transcribeAudio(config, payload);
    if (!result.ok) writeLog("voice_transcribe_failed", { provider: config.provider, reason: result.reason });
    else writeLog("voice_transcribe_ok", { provider: config.provider, seconds: result.seconds });
    return result;
  });
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
      // v3.21.3 修复③埋点：advanced 三组落盘形态摘要（真机排障：高级设置保存回退问题一眼可查）
      writeLog("settings_advanced_saved", {
        sshGroup: saved.advanced?.ssh ? "manual" : "auto",
        externalGroup: saved.advanced?.external ? "manual" : "auto",
        cloudGroup: saved.advanced?.cloud ? "manual" : "auto",
        cloudRounds: saved.advanced?.cloud?.maxToolRounds ?? null
      });
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
  // ── v3.22.0 云办公二期：沙箱网络切换 / 状态查询（SSH→NAS docker network 插拔；命令即时生效） ──
  const SANDBOX_SSH_CONFIG = () => {
    const sshConn = getSshConnection();
    return { host: sshConn.host, port: sshConn.port, username: sshConn.username, password: sshConn.password, hostFingerprint: sshConn.hostFingerprint };
  };
  ipcMain.handle("sandbox:setNetwork", async (_event, enabled) => {
    try {
      const verb = enabled ? "connect" : "disconnect";
      const client = await connect(SANDBOX_SSH_CONFIG(), () => false, writeLog);
      let result;
      try {
        result = await exec(client, `docker network ${verb} bridge sandbox`, { timeoutMs: 20 * 1000, label: "沙箱联网切换" });
      } finally {
        try { client.end(); } catch { /* 已断开 */ }
      }
      if (result.code !== 0) throw new Error(String(result.stderr || result.stdout || "沙箱联网切换失败").trim());
      saveSettings({ ...getSettings(), cloudSandboxNetworkEnabled: Boolean(enabled) });
      writeLog("cloud_sandbox_network_toggled", { enabled, verb });
      return { ok: true, networkEnabled: Boolean(enabled) };
    } catch (error) {
      writeLog("cloud_sandbox_network_failed", { enabled, error: error.message });
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("sandbox:status", async () => {
    let client;
    try {
      client = await connect(SANDBOX_SSH_CONFIG(), () => false, writeLog);
    } catch (error) {
      return { ok: false, error: `SSH 连接失败：${error.message}` };
    }
    try {
      const state = await exec(client, "docker inspect sandbox --format '{{.State.Running}}' 2>/dev/null || printf missing", { timeoutMs: 20 * 1000, label: "沙箱状态" });
      const networks = await exec(client, "docker inspect sandbox --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null", { timeoutMs: 20 * 1000, label: "沙箱网络" });
      const stateText = String(state.stdout || "").trim();
      const networkList = String(networks.stdout || "").trim().split(/\s+/).filter(Boolean);
      return {
        ok: true,
        container: stateText === "missing" ? "missing" : stateText === "true" ? "running" : "stopped",
        networkOn: networkList.includes("bridge")
      };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      try { client.end(); } catch { /* 已断开 */ }
    }
  });
  // ── 模型管理 IPC ──
  ipcMain.handle("model:status", async () => {
    const config = getConnection();
    // v3.18.0 F2：模式分派——云端/非 Claude 引擎不抛错，返回可渲染的分派对象（模型页按形状分派渲染）
    if (config.connectionMode === "cloud") {
      return { connectionMode: "cloud", provider: config.cloudAiProvider, model: config.cloudAiModel, baseUrl: config.cloudAiBaseUrl || "" };
    }
    if (localEngineOf(config) !== "claude") {
      return { connectionMode: "local", engine: String(config.localEngine || "claude"), noClaudeConfig: true };
    }
    return config.connectionMode === "local"
      ? getLocalClaudeModelStatus()
      : getClaudeModelStatus(config, (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  ipcMain.handle("model:initialize-password", (_event, input) => {
    const state = getSettings().modelAdminPasswordState;
    if (state === "ready") throw new Error("模型管理员密码已设置。如需更换，请在模型页使用「更换管理员密码」。");
    if (state === "unavailable") throw new Error("Windows 系统加密不可用，无法安全保存模型管理员密码。");
    const password = String(input?.password || "");
    if (password !== String(input?.confirmation || "")) throw new Error("两次输入的管理员密码不一致。");
    setModelAdminPassword(password);
    writeLog("model_admin_password_initialized");
    return getSettings();
  });
  // v3.40.0：管理员密码体验三补充——预校验（渲染层弹窗内即时反馈）/ 更换（旧密+新密+确认）/ 重置（忘记密码兜底）
  ipcMain.handle("model:verify-password", (_event, input) => {
    try {
      return { ok: verifyModelAdminPassword(String(input?.password || "")) };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });
  ipcMain.handle("model:change-password", (_event, input) => {
    const currentPassword = String(input?.currentPassword || "");
    const password = String(input?.password || "");
    if (password !== String(input?.confirmation || "")) throw new Error("两次输入的新密码不一致。");
    if (password.length < 6 || password.length > 200 || /[\0\r\n]/.test(password)) throw new Error("新密码需为 6–200 个字符，且不能包含换行。");
    let currentOk;
    try { currentOk = verifyModelAdminPassword(currentPassword); }
    catch (error) { throw new Error(String(error?.message || "当前管理员密码校验失败。")); }
    if (!currentOk) throw new Error("当前管理员密码不正确。");
    setModelAdminPassword(password);
    writeLog("model_admin_password_changed");
    return getSettings();
  });
  ipcMain.handle("model:reset-password", async () => {
    if (getSettings().modelAdminPasswordState === "missing") return getSettings();
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "重置模型管理员密码",
      message: "确认重置模型管理员密码？",
      detail: "仅清除本机加密保存的管理员密码（模型配置、聊天记录等数据不受影响）。下次写模型配置时会要求设置一个新密码。此操作会写入操作日志。",
      buttons: ["取消", "重置密码"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true };
    clearModelAdminPassword();
    writeLog("model_admin_password_reset");
    return getSettings();
  });
  ipcMain.handle("model:update", async (_event, input) => {
    if (activeRequests.size) throw new Error("Agent 正在回复，暂时不能切换模型。请等待当前回复结束后再操作。");
    assertModelAdminPassword(input?.adminPassword);
    const model = input?.model;
    const config = getConnection();
    if (config.connectionMode === "cloud") throw new Error("云端模式不使用 Claude 五项模型配置；请在连接页选择服务商与模型。");
    if (localEngineOf(config) !== "claude") throw new Error("当前本机引擎不使用 Claude 模型配置，无法切换模型。");
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
  // v3.18.0 F2：五项单独修改 + 自动压缩阈值（管理员密码 + 主进程确认弹窗 + 写前备份，语义对齐 model:update）
  ipcMain.handle("model:update-entry", async (_event, input) => {
    if (activeRequests.size) throw new Error("Agent 正在回复，暂时不能修改模型配置。请等待当前回复结束后再操作。");
    assertModelAdminPassword(input?.adminPassword);
    const entryId = String(input?.entryId || "");
    const model = String(input?.model || "").trim();
    const config = getConnection();
    if (config.connectionMode === "cloud") throw new Error("云端模式不使用 Claude 五项模型配置；请在连接页选择服务商与模型。");
    if (localEngineOf(config) !== "claude") throw new Error("当前本机引擎不使用 Claude 模型配置，无法修改模型配置项。");
    const local = config.connectionMode === "local";
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "修改模型配置项",
      message: `将${local ? "本机 Windows" : "目标 NAS"}上的「${entryId}」单独改为：${model}`,
      detail: "只修改这一项模型配置，其余五项与 Ollama 地址、认证、权限、hooks 全部保留。写前会备份 settings.json（.bak-model），出错可用备份恢复。写入成功后，下一条消息将使用新配置。",
      buttons: ["取消", "修改此项"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true };
    writeLog("claude_model_entry_change_requested", { connectionMode: config.connectionMode, host: config.host || "", entryId, model });
    return local
      ? updateLocalClaudeModelEntry(entryId, model, writeLog)
      : updateClaudeModelEntry(config, entryId, model, (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  ipcMain.handle("model:update-compact", async (_event, input) => {
    if (activeRequests.size) throw new Error("Agent 正在回复，暂时不能修改自动压缩阈值。请等待当前回复结束后再操作。");
    assertModelAdminPassword(input?.adminPassword);
    const value = input?.value;
    const config = getConnection();
    if (config.connectionMode === "cloud") throw new Error("云端模式不使用 Claude 五项模型配置；请在连接页选择服务商与模型。");
    if (localEngineOf(config) !== "claude") throw new Error("当前本机引擎不使用 Claude 模型配置，无法修改自动压缩阈值。");
    const local = config.connectionMode === "local";
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "调整自动压缩阈值",
      message: `将${local ? "本机 Windows" : "目标 NAS"}上的自动压缩阈值调整为：${String(value ?? "auto")}`,
      detail: "auto 表示使用 Claude 官方自动值（删除 settings.json 顶层的 autoCompactWindow 覆盖）。上面的五项模型配置不受影响；下一条消息将使用新阈值。",
      buttons: ["取消", "修改阈值"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true };
    writeLog("claude_model_compact_change_requested", { connectionMode: config.connectionMode, host: config.host || "", value: String(value) });
    return local
      ? updateLocalAutoCompactWindow(value, writeLog)
      : updateClaudeAutoCompactWindow(config, value, (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  // v3.18.0 F4：切换 SSH 卡槽（目标槽整套参数物化为活跃连接；密码/指纹随槽走；
  // 运行中任务在开始时已捕获 config+taskProfile，切槽不杀也不串会话——拍板「任务跟原连接走」）
  // v3.19.0 F3：SSH 远程适配器在场检测——单次 SSH 连接探测全部远端 CLI（claude/atomcode 内置直接返回）
  ipcMain.handle("settings:detect-ssh-adapter", async (_event, payload = {}) => {
    const requested = String(payload?.adapter || "").trim();
    const config = getConnection();
    if (config.connectionMode !== "ssh") throw new Error("适配器检测仅在 SSH 连接模式下可用（本机模式无需远端 CLI）。");
    const remote = [
      { key: "qwen", cli: "qwen", installHint: "在 NAS 上执行：npm install -g @qwen-code/qwen-code" },
      { key: "codex", cli: "codex", installHint: "在 NAS 上执行：npm install -g @openai/codex" },
      { key: "hermes", cli: "hermes", installHint: "官方脚本安装（hermes-agent.nousresearch.com）" }
    ];
    const builtin = [
      { key: "claude", detail: "内置 agent-sdk-bridge / direct-cli 双链，无需额外安装" },
      { key: "atomcode", detail: "通过 NAS 侧 atomcode daemon 调用（连接设置里已配置），无需远端 CLI" }
    ];
    const results = [];
    if (!requested || remote.some((item) => item.key === requested)) {
      const probed = remote.filter((item) => !requested || item.key === requested);
      const client = await connectWithRetry(config, () => {}, writeLog, undefined);
      try {
        const list = probed.map((item) => item.cli).join(" ");
        const script = `for c in ${list}; do p=$(command -v -- "$c" 2>/dev/null) && echo "OK:$c:$p" || echo "MISS:$c"; done`;
        const probe = await exec(client, script);
        const found = {};
        for (const line of probe.stdout.split("\n")) {
          const match = /^(OK|MISS):([^:]+)(?::(.*))?$/.exec(line.trim());
          if (match) found[match[2]] = match[1] === "OK" ? (match[3] || "").trim() : "";
        }
        for (const item of probed) {
          results.push({
            key: item.key,
            status: found[item.cli] ? "installed" : "missing",
            path: found[item.cli] || "",
            installHint: found[item.cli] ? "" : item.installHint
          });
        }
      } finally {
        try { client.end(); } catch { /* 已断开 */ }
      }
    }
    for (const item of builtin) {
      if (requested && item.key !== requested) continue;
      results.push({ key: item.key, status: "builtin", path: "", installHint: "", detail: item.detail });
    }
    writeLog("ssh_adapter_detect", { requested: requested || "all", installed: results.filter((r) => r.status === "installed").length });
    return { results };
  });
  ipcMain.handle("settings:switch-ssh-profile", (_event, profileId) => {
    const next = switchSshProfile(profileId);
    writeLog("settings_ssh_profile_switched", { profileId: next.activeSshProfile, host: next.host || "" });
    return next;
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
    const installCoexistenceNote = summarizeCoexistence(initialStatus.coexistence) || "";
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "安装 Agent 联动控件",
      message: "允许管理 Agent 通过 SSH 公钥控制这台电脑？",
      detail: `不会要求或保存员工的 Windows 密码。\n\n允许来源：${sourceAddress}\n本机被控地址：${targetAddress}:${targetPort}\n权限：${permissionText}\n\n安装时 Windows 会弹出一次管理员授权。管理员模式可执行系统级操作，请只在公司授权设备上启用。` + (installCoexistenceNote ? `\n\n⚠ 共存扫描：${installCoexistenceNote}\n安装流程内如发现结构性冲突，Windows 会再弹出一次共存选择窗口。` : ""),
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
      writeLog("device_control_install_success", { deviceId, sourceAddress, targetAddress, permissionMode, serviceRunning: status.serviceRunning, probeOk: probe.ok, coexistenceChoice: status.coexistenceChoice || "none", coexistenceDetected: Boolean(status.coexistenceDetected) });
      return { ...status, probe };
    } catch (error) {
      writeLog("device_control_install_failed", { deviceId, sourceAddress, permissionMode, error });
      throw error;
    }
  });
  ipcMain.handle("device-control:ip-track", async (_event, deviceId) => {
    const config = getSshConnection();
    const result = await readDeviceControlIpTrack(config, deviceId, (fingerprint) => trustHost(config, fingerprint), writeLog);
    return result;
  });
  ipcMain.handle("device-control:uninstall", async () => {
    const currentBeforeConfirm = getDeviceControlStatus();
    const uninstallCoexistenceNote = summarizeCoexistence(currentBeforeConfirm.coexistence) || "";
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "卸载 Agent 联动控件",
      message: "确定停止 Agent 对这台电脑的 SSH 联动控制吗？",
      detail: "将撤销本机公钥、专用账号和专用防火墙规则；聊天记录和 NAS 上的 Claude 会话不受影响。" + (uninstallCoexistenceNote ? `\n\n⚠ 共存扫描：${uninstallCoexistenceNote}\n卸载流程内 Windows 会弹出共存选择窗口，让你决定另一套控件的保留或清理方式。` : ""),
      buttons: ["取消", "卸载联动控件"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true, ...currentBeforeConfirm };
    const previous = currentBeforeConfirm;
    let config;
    try { config = getConnection(); } catch {}
    writeLog("device_control_uninstall_start", { deviceId: previous.deviceId });
    try {
      const status = await uninstallDeviceControl();
      if (config) {
        try { await markDeviceControlDisabled(config, previous, (fingerprint) => trustHost(config, fingerprint), writeLog); }
        catch (error) { writeLog("device_control_registry_disable_failed", { deviceId: previous.deviceId, error }); }
      }
      writeLog("device_control_uninstall_success", { coexistenceChoice: status.coexistenceChoice || "none", coexistenceDetected: Boolean(status.coexistenceDetected) });
      return status;
    } catch (error) {
      writeLog("device_control_uninstall_failed", { error });
      throw error;
    }
  });
  // ── v3.23.0 N2N 体检 + 一键部署（检测哪坏、缺哪补哪、逐行 stderr 上屏） ──
  ipcMain.handle("n2n:doctor", async (_event, payload = {}) => {
    const sender = _event.sender;
    return runN2nDoctor(payload, (item) => {
      if (!sender.isDestroyed()) sender.send("n2n:doctor:item", item);
    });
  });
  ipcMain.handle("n2n:deploy", async (_event, payload = {}) => {
    const sender = _event.sender;
    const answer = await dialog.showMessageBox(window, {
      type: "info",
      title: "N2N 一键部署",
      message: "开始自动安装 N2N 环境？",
      detail: "将执行：解压 edge 到 C:\\n2n → 安装 TAP 虚拟网卡驱动（需 Windows 管理员授权）→ 写用户 PATH → 自检。约 30 秒，每步日志会展示在设置页 N2N 参数区内。",
      buttons: ["取消", "开始部署"],
      defaultId: 1,
      cancelId: 0
    });
    if (answer.response !== 1) return { canceled: true, steps: [], summary: ["已取消部署"] };
    writeLog("n2n_deploy_start", { platform: process.platform });
    try {
      const result = await runN2nDeploy(payload, (line) => {
        if (!sender.isDestroyed()) sender.send("n2n:deploy:line", line);
      });
      writeLog("n2n_deploy_done", { ok: result.ok });
      return result;
    } catch (error) {
      writeLog("n2n_deploy_failed", { error: error.message });
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
  // v3.35.6：三通道带工作区参数（历史列表/建对话/搜索按 workspaceType 物理过滤，历史记录不串台）
  ipcMain.handle("conversations:list", (_event, workspaceType) => listConversations(String(workspaceType || "")));
  ipcMain.handle("conversations:create", (_event, workspaceType) => createConversation(String(workspaceType || "single")));
  ipcMain.handle("conversations:get", (_event, id) => {
    const conversation = getConversation(id);
    return conversation ? { ...conversation, sessionId: sessionForMode(conversation, getSettings().connectionMode, undefined, getSettings().activeSshProfile) } : null;
  });
  ipcMain.handle("conversations:clear-session", (_event, id) => clearConversationSession(id));
  ipcMain.handle("conversations:rename", (_event, id, title) => renameConversation(id, title));
  ipcMain.handle("conversations:set-pinned", (_event, id, pinned) => setConversationPinned(id, pinned));
  // v3.15.5 修复2：删除单条及下方所有落库消息（右键菜单「删除此条及下方所有消息」同步删除）
  ipcMain.handle("conversations:truncate", (_event, id, anchor) => {
    const result = truncateConversationMessages(id, anchor || {});
    writeLog("conversation_truncated", { conversationId: id, removed: result.removed });
    return result;
  });
  ipcMain.handle("conversations:delete", (_event, id) => deleteConversation(id));
  ipcMain.handle("conversations:search", (_event, query, limit, workspaceType) => searchConversations(query, limit, String(workspaceType || "")));
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
  // v3.16.1 打印联动（Agent print 生态闭环）：检测本机 Agent print 在场 → 图片卡片显示「打印」按钮
  // 检测依据 = Agent print 首次启动用 setAsDefaultProtocolClient 注册的 agent-print:// 协议（HKCU 注册表），
  // 兜底进程探测同名 exe（Agent print.exe，Setup 版）。
  // 阉割版 Bridge：打印联动关闭（gates.printLink=false），通道不注册——渲染层同步按门控不调
  if (EDITION.gates.printLink) {
  ipcMain.handle("print:detect", async () => {
    try {
      const out = spawnSync("reg", ["query", "HKCU\\Software\\Classes\\agent-print"], { encoding: "utf8", timeout: 5000 });
      if (!out.error && out.status === 0 && String(out.stdout || "").includes("agent-print")) return true;
    } catch (_) { /* reg 不存在/超时 → 走进程兜底 */ }
    try {
      const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq Agent print.exe", "/NH"], { encoding: "utf8", timeout: 5000 });
      return !out.error && String(out.stdout || "").toLowerCase().includes("agent print.exe");
    } catch (_) { return false; }
  });
  // v3.16.1 「打印」点击：远程文件（SSH 产物）或本地文件落临时目录 → agent-print:// 唤起 Agent print（单实例锁接手）
  ipcMain.handle("print:send", async (_event, file) => {
    const directory = path.join(app.getPath("temp"), "Agent Chat Pro");
    fs.mkdirSync(directory, { recursive: true });
    // 顺手清 >24h 的历史 print-* 残留（Agent print 已 stageCopy 走自己的副本）
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(directory)) {
        if (!f.startsWith("print-")) continue;
        const full = path.join(directory, f);
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      }
    } catch (_) { /* 清理失败不致命 */ }
    const localPath = path.join(directory, `print-${randomUUID()}-${safeFileName(file?.name)}`);
    const config = file?.localPath ? null : getSshConnection();
    if (file?.localPath) copyLocalFile(file.localPath, localPath);
    else await downloadRemoteFile(config, file.remotePath, localPath, (fingerprint) => trustHost(config, fingerprint), writeLog);
    const url = "agent-print://print?p=" + encodeURIComponent(localPath)
      + "&n=" + encodeURIComponent(file?.name || path.basename(localPath));
    await shell.openExternal(url);
    writeLog("file_sent_to_agent_print", { name: file?.name, staged: path.basename(localPath), size: file?.size, source: file?.localPath ? "local" : "ssh" });
    return localPath;
  });
  }
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
    // AtomCode 引擎：优先用表单里未保存的新 token，否则读加密存储（v3.13.0）
    if (mode === "local") config.atomcodeToken = String(input.atomcodeToken || "").trim() || getAtomcodeToken();
    writeLog("connection_test_start", { connectionMode: mode, host: config.host, port: config.port, username: config.username ? config.username[0] + "***" : "", wakeName: config.wakeName });
    try {
      const engine = localEngineOf(config);
      const result = mode === "local"
        ? (engine === "atomcode"
          ? await verifyAtomCodeConnection(config, writeLog)
          : engine === "custom"
            ? await verifyCustomCliConnection(config, writeLog)
            : await verifyLocalConnection(config, writeLog))
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
    // 阉割版 Bridge Edition：云端AI 经 HTTP 桥注入的消息 senderType === "cloud-ai"——
    // 标记前缀在主进程侧强制追加（不信任渲染层自称），随消息文本进入 NAS Agent 上下文防误判
    const senderType = input.senderType === "cloud-ai" ? "cloud-ai" : "";
    const rawMessage = String(input.message || "").trim();
    // 标记幂等：turn-start 载荷已带前缀（渲染层气泡所见=落库所存），不因重复注入而双前缀
    let message = senderType && !rawMessage.startsWith(CLOUD_AI_TAG) ? `${CLOUD_AI_TAG}\n${rawMessage}` : rawMessage;
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    if (attachments.length > 10) throw new Error("一次最多添加 10 个附件。");
    if (attachments.some((file) => Number(file?.data?.byteLength || 0) > 30 * 1024 * 1024)) {
      throw new Error("单个附件不能超过 30 MB。");
    }
    if (!message && !attachments.length) throw new Error("请输入消息或添加附件。");
    if (!input.conversationId) throw new Error("请先新建一个对话。");
    // v3.35.6 群聊对话走专用路（chat:group-send）——普通单聊拒绝绑群的对话，防两套引擎互踩
    if (getConversation(input.conversationId)?.workgroupId) {
      throw new Error("该对话是多 AI 群聊对话，请在群聊输入框发送（或新建一对一对话）。");
    }
    writeLog("work_status_signal", statusSignalEntry({
      requestId: id,
      direction: "main-received",
      signal: "chat-send",
      disposition: "accepted",
      textLength: message.length,
      attachmentCount: attachments.length
    }));
    const startedAt = Date.now();
    addUserMessage(input.conversationId, message, attachments.map((file) => file.name), senderType);
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
      // v3.20.0 F5：云端路 Agent plan——system prompt 幂等追加 ```plan 约定段（渲染层 extractPlanBlocks 解析）
      // v3.24.0：再拼 ask_user 选择题提问约定（工具开放后告知 AI 何时该提问）
      const systemPrompt = appendPlanConvention(modeConfig?.systemPrompt || "") + ASK_USER_HINT;
      // v3.35.6 修复：删去旧 push——buildMessages 已含刚落库的用户消息，旧版再 push 一次=每轮双发
      // （P12 初版遗留：请求消息序列 user×2，白耗 token 且易致 AI 回答偏题；工具轮 tool 回填不受影响）
      const cloudMessages = buildMessages(conversation, systemPrompt);

      // 工具执行（v3.14.0 云办公一期）：推理走云端 API，工具在本机工作目录内执行
      // v3.22.0 云办公二期：cloudConfig.sandboxEnabled 开启时文件/命令工具改经 SSH→NAS `docker exec sandbox`
      // 在容器内 /workspace 执行（容器默认断网 + internal 隔离网络；宿主本机零执行面）。
      // ⚠ 沙箱执行器声明必须先于 runCloudWithTools 定义（闭包体引用静态前置——TDZ 禁形态守门，铁律 §9）
      const toolsEnabled = Boolean(cloudConfig.toolsEnabled);
      const allowCommand = toolsEnabled && Boolean(cloudConfig.runCommandEnabled);
      const sandboxOn = toolsEnabled && Boolean(cloudConfig.sandboxEnabled);
      let sandboxSshClient = null;
      const sandboxExecutor = { enabled: false, run: null };
      if (toolsEnabled && !validatedLocalWorkdir(cloudConfig.workingDirectory) && !sandboxOn) {
        throw new Error("已开启工具执行，请先在设置中配置云端模式的工作目录。");
      }
      const cloudTools = toolsEnabled ? toolDefinitions(allowCommand) : undefined;
      const isAnthropicProvider = cloudConfig.provider === "anthropic";
      const collectedTools = [];

      let streamedText = "";
      let streamedReasoning = ""; // v3.24.0 思考过程累计（随消息落库）
      let draftTimer;
      const persistDraft = () => {
        draftTimer = undefined;
        if (!streamedText) return;
        try { saveAssistantDraft(input.conversationId, id, streamedText); }
        catch (error) { writeLog("conversation_draft_save_failed", { requestId: id, conversationId: input.conversationId, error }); }
      };
      const emitToolCard = (tool) => {
        const normalized = normalizeAndObserveStatusEvent({ id, type: "tool", tool }, { connectionMode: "cloud" });
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "executor-emitted", signal: "runner-event", disposition: "emitted", eventType: "tool", ...(normalized.audit || {}) }));
        sendWorkStatusSignal(event.sender, "chat:event", normalized);
      };
      const cloudCallbacks = {
        advanced: getCloudAiConfig().advancedEffective, // v3.19.0 F3：云端超时/重试参数随行
        onDelta: (text) => {
          streamedText += text;
          sendWorkStatusSignal(event.sender, "chat:delta", { id, text });
          if (!draftTimer) draftTimer = setTimeout(persistDraft, 1000);
        },
        // v3.21.3 修复②：跨轮分隔不再把 markdown `---` 拼进 streamedText（v3.15.5 的做法会污染
        // 正文/draft/会话历史，N 轮工具 = N 条 hr 横线堆叠，用户实报观感混乱）。改为推专用 round 事件，
        // 渲染层在工具牌序列前画轻量「第 N 轮」徽标，正文零污染。
        emitRoundSeparator: (round) => {
          sendWorkStatusSignal(event.sender, "chat:event", { id, type: "round", round });
        },
        // v3.24.0 思考过程：流式外发（渲染层气泡内折叠块实时刷新；随消息落库 msg.thinking）
        onReasoning: (text) => {
          streamedReasoning += String(text || "");
          sendWorkStatusSignal(event.sender, "chat:event", { id, type: "thinking", text: String(text || "") });
        },
        onStatus: (status) => sendWorkStatusSignal(event.sender, "chat:event", { id, type: "connection", status }),
        onUsage: (usage) => sendWorkStatusSignal(event.sender, "chat:event", { id, type: "usage", usage }),
        onToolEvent: emitToolCard,
        onLog: writeLog
      };
      // v3.24.0：思考挡位选择（settings.thinkingChoices 按「provider/model」记忆；未选择=不注入=服务商默认）
      const thinkingChoice = String(((settings.thinkingChoices || {}).cloud || {})[`${cloudConfig.provider}/${cloudConfig.model}`] || "").trim();
      const thinkingContext = { provider: cloudConfig.provider, model: cloudConfig.model || "", choice: thinkingChoice };
      const requestOnce = (messages) => sendCloudChat({
        apiKey: cloudConfig.apiKey,
        baseURL: cloudConfig.baseURL,
        model: cloudConfig.model || "glm-4-flash",
        // v3.24.9：输出上限 tokens 三级链（模式覆盖 → 服务商配置 → 设置中心高级设置；旧版末级硬编码 4096——
        // 免费档服务商按此截断且旧版不检查 stopReason，正是「干活干到一半无提示就沉默」的主因之一）
        maxTokens: modeConfig?.maxTokens || cloudConfig.maxTokens
          || Number(cloudConfig.advancedEffective?.cloud?.maxTokens) || 8192,
        temperature: modeConfig?.hallucinationControl === "strict" ? 0.3 : modeConfig?.hallucinationControl === "creative" ? 0.9 : undefined,
        provider: cloudConfig.provider,
        proxy: cloudConfig.proxy,
        tools: cloudTools,
        thinking: thinkingContext,
      }, messages, cloudCallbacks);

      // 工具循环（agent loop）：tool_calls → 本机执行 → 结果回填 → 再请求，直到纯文本回复或达轮数上限
      // v3.21.3 修复①：跨轮 usage 累计器——财务真实账目 = Σ每轮(输入+输出)。
      // 旧版 lastUsage 每轮被覆盖+渲染层只记输出，用户 200 万 token 烧穿而计数器只显示 4652 的主因之一。
      // ⚠ 声明位置必须先于 runCloudWithTools 定义（闭包体静态前置，规避混淆器语句重排 TDZ 事故形态——铁律 §9）
      const usageTotal = { prompt: 0, completion: 0, total: 0, requests: 0 };
      // ── v3.22.0 沙箱执行器：懒建立 SSH 连接（runCloudWithTools 调用先行建立，finally 统一清理）──
      if (sandboxOn) {
        const sshConn = getSshConnection(); // SSH 凭证缺失时抛「请先保存密码」中文提示
        try {
          sandboxSshClient = await connect(
            { host: sshConn.host, port: sshConn.port, username: sshConn.username, password: sshConn.password, hostFingerprint: sshConn.hostFingerprint },
            () => false, // 未信任主机不在此处弹信任询问——提示用户先在 SSH 页完成首次连接信任
            writeLog
          );
        } catch (error) {
          sandboxSshClient = null;
          throw new Error(`沙箱执行需要 SSH 连接 NAS：${error.message}（首次使用请先在 SSH 页面完成一次连接以信任主机指纹）`);
        }
        sandboxExecutor.enabled = true;
        sandboxExecutor.run = async ({ command, timeoutMs, stdin }) => {
          try {
            const result = await exec(sandboxSshClient, command, { timeoutMs, label: "沙箱命令", stdin });
            return { code: result.code, stdout: result.stdout, stderr: result.stderr };
          } catch (error) {
            const seconds = Math.round(Number(timeoutMs) / 1000);
            throw new Error(/超时/.test(error.message || "") ? `沙箱命令执行超时（${seconds} 秒），已终止。` : `沙箱执行失败：${error.message}`);
          }
        };
        writeLog("cloud_sandbox_executor_ready", { requestId: id, host: sshConn.host, workdir: "/workspace" });
      }
      const runCloudWithTools = async () => {
        let loopMessages = cloudMessages;
        // v3.19.0 F3：工具循环轮数上限可配（advanced.cloud.maxToolRounds，5~10000 默认 25；
        //   v3.24.4 需求②：上限 50→10000 实际取消限制，与 settings.cjs ADVANCED_CLAMPS 三处同步）
        // v3.21.2 TDZ 修复：原写 config 引用的是 handler 顶层（云端分支之后、云端路径永不执行）
        // 的 const config → 云端发消息必 TDZ（ReferenceError: Cannot access '_0x27f1ac'）。
        // v3.19/v3.20 装机没炸纯属混淆器洗牌侥幸掩盖。改为 cloudConfig（本块内先声明的 getCloudAiConfig()），
        // 同源 advancedEffective 字段（另见 cloudCallbacks.advanced 的正确示范 L990），语义等价。
        const advancedCloud = cloudConfig.advancedEffective?.cloud || {};
        const maxToolRounds = Number.isInteger(Number(advancedCloud.maxToolRounds))
          && Number(advancedCloud.maxToolRounds) >= 5 && Number(advancedCloud.maxToolRounds) <= 10000
          ? Number(advancedCloud.maxToolRounds) : MAX_TOOL_ROUNDS;
        // v3.21.3 修复①：跨轮 usage 累计器——财务真实账目 = Σ每轮(输入+输出)。
        // 旧版 lastUsage 每轮被覆盖+渲染层只记输出，用户 200 万 token 烧穿而计数器只显示 4652 的主因之一。
        const withCumulativeUsage = (result) => ({
          ...result,
          usage: usageTotal.requests
            ? {
                inputTokens: usageTotal.prompt, outputTokens: usageTotal.completion, totalTokens: usageTotal.total,
                cumulative: true, requests: usageTotal.requests,
                prompt_tokens: usageTotal.prompt, completion_tokens: usageTotal.completion, total_tokens: usageTotal.total
              }
            : (result.usage || null)
        });
        // v3.24.9：截断自动续写计数（续写块见循环内注释）
        let autoContinues = 0;
        for (let round = 0; round <= maxToolRounds; round += 1) {
          // v3.21.3 修复②：round>0 时上一轮工具已执行完，推跨轮标记事件（首轮不推；不再注入正文分隔线）
          if (round > 0 && cloudCallbacks.emitRoundSeparator) cloudCallbacks.emitRoundSeparator(round);
          const promise = requestOnce(loopMessages);
          activeRequests.set(id, { promise, cancel: () => { promise.cancel?.(); }, conversationId: input.conversationId });
          const result = await promise;
          // v3.21.3 修复①：本轮请求结束后把最终 usage 计入累计，并推「轮末累计」事件供渲染层以真实账目替换估算
          const roundUsageDelta = accumulateUsage(usageTotal, result.usage);
          if (roundUsageDelta > 0) {
            writeLog("cloud_round_usage", { requestId: id, round, promptTokens: usageTotal.prompt, completionTokens: usageTotal.completion, totalTokens: usageTotal.total, requests: usageTotal.requests });
            sendWorkStatusSignal(event.sender, "chat:event", { id, type: "usage", usage: { inputTokens: usageTotal.prompt, outputTokens: usageTotal.completion, totalTokens: usageTotal.total, cumulative: true, requests: usageTotal.requests } });
          }
          if (result.cancelled) return withCumulativeUsage({ ...result, tools: collectedTools });
          // v3.24.9：「莫名其妙停止、没有任何提示」修复①——服务商输出上限截断自动续写。
          // 旧版不检查 stopReason：max_tokens/length 截断时半截文本直接当「正常完成」落库（用户实锤），
          // 且截断轮的 tool_calls 可能是断在半路的残缺 JSON（执行会污染任务）——统一不执行本轮工具直接续写。
          if (isTruncatedStopReason(result.stopReason)) {
            if (autoContinues < 3) {
              autoContinues += 1;
              writeLog("cloud_auto_continue", { requestId: id, round, autoContinues, stopReason: result.stopReason });
              sendWorkStatusSignal(event.sender, "chat:event", { id, type: "round", round: round + 1, mark: `✂ 输出被截断（服务商输出上限），已自动续写（第 ${autoContinues} 段）` });
              loopMessages = [...loopMessages, { role: "user", content: "继续（你上一条回复被输出上限截断，请从中断处续写，不要重复已输出的内容。）" }];
              continue;
            }
            // 上限已达：给一条可见徽标（旧版这里是静默的第五条命案现场）
            sendWorkStatusSignal(event.sender, "chat:event", { id, type: "round", round: round + 1, mark: "✂ 已自动续写 3 段仍被截断，停止续写——建议拆小任务，或在设置中心「云端模型设置」调大「输出上限 tokens」。" });
          }
          const toolCalls = toolsEnabled ? (result.toolCalls || []) : [];
          if (!toolCalls.length) return withCumulativeUsage({ ...result, tools: collectedTools });

          const toolCallsRaw = toolCalls.map((call, index) => {
            let input = {};
            try { input = JSON.parse(call.arguments || "{}"); } catch { input = {}; }
            return { id: call.id || `cloud-tool-${round}-${index}`, name: call.name || "unknown", arguments: call.arguments || "{}", input };
          });
          const assistantText = result.text || "";
          if (isAnthropicProvider) {
            const content = [];
            if (assistantText) content.push({ type: "text", text: assistantText });
            for (const call of toolCallsRaw) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
            loopMessages = [...loopMessages, { raw: true, role: "assistant", content }];
          } else {
            loopMessages = [...loopMessages, {
              raw: true,
              role: "assistant",
              content: assistantText || null,
              extra: { tool_calls: toolCallsRaw.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }
            }];
          }

          for (const call of toolCallsRaw) {
            const card = { id: call.id, name: call.name, status: "running", input: call.input, result: "" };
            collectedTools.push(card);
            emitToolCard(card);
            let output;
            // v3.24.0 AI 选择题提问（ask_user）：不进本机执行器——发气泡事件悬等用户点选，
            // 停止请求 cancelAll 如实回填「用户已停止」；超时 8 分钟回填「未应答」由 AI 自行决定下一步。
            if (call.name === "ask_user") {
              const q = String(card.input?.question || "").trim();
              const options = (Array.isArray(card.input?.options) ? card.input.options : [])
                .map((option) => String(option || "").trim()).filter(Boolean).slice(0, 4);
              if (!q || options.length < 2) {
                output = "ask_user 参数不完整（question 必填且 options 至少 2 项）。请改用正文直接向用户说明。";
              } else {
                sendWorkStatusSignal(event.sender, "chat:event", { id, type: "ask-user", callId: call.id, question: q, options });
                const answer = await askUserRegistry.wait(id, call.id, q, options);
                if (answer === ASK_USER_STOPPED) {
                  card.status = "completed"; card.result = "用户已停止"; emitToolCard(card);
                  throw new Error("用户已停止当前任务");
                }
                output = answer === ASK_USER_TIMEOUT ? "（用户长时间未应答，请基于现有信息自行决定下一步，或明确说明被搁置的原因。）" : `用户选择：${answer}`;
              }
            } else if (call.name === "spawn_agent") {
              // v3.35.6 模块四：云端单聊轮的子 Agent 派生（权限白名单=Agent 池云端节点；
              // 换脑/熔断走 ask-user 选择卡悬等；子结果精简回填 tool 消息 + subagent-result 轻注记入上下文）
              const task = String(card.input?.task || "").trim();
              if (!task) {
                output = "spawn_agent 参数不完整（task 必填）。请自行完成该工作或向用户说明。";
                card.status = "completed"; card.result = "缺 task，未派生";
              } else {
                const subResult = await executeSubAgent({
                  log: writeLog,
                  emit: (rid, payload) => sendWorkStatusSignal(event.sender, "chat:event", { id: rid, ...payload }),
                  emitSub: (rid, payload) => sendWorkStatusSignal(event.sender, "chat:subagent-event", { parentId: rid, ...payload }),
                  deps: { ...groupDeps(), sender: event.sender }
                }, {
                  conversationId: input.conversationId,
                  parentRequestId: id,
                  parentName: "云端助手",
                  task,
                  expect: String(card.input?.expect || ""),
                  targetAgentId: String(card.input?.agent || "")
                });
                if (subResult.status === "done") {
                  card.status = "completed";
                  card.result = subSummarize(subResult.text, 400);
                  output = `子 Agent ${subResult.agentLabel} 已完成任务，结果如下：\n${subSummarize(subResult.text, 2000)}`;
                } else {
                  card.status = "failed";
                  card.result = `${subResult.agentLabel} ${subResult.error?.code || ""}`;
                  output = `子 Agent 派生未完成（status=${subResult.status}, ${subResult.error?.code || "ERROR"}：${subResult.error?.message || ""}）。请基于现有信息继续，或向用户说明。`;
                }
                writeLog("cloud_spawn_agent", { requestId: id, status: subResult.status, agent: subResult.agentLabel, conversationId: input.conversationId });
              }
            } else {
            try {
              output = await executeToolCall({ id: call.id, name: call.name, arguments: call.arguments }, { workdir: sandboxOn ? "/workspace" : cloudConfig.workingDirectory, allowCommand, onLog: writeLog, sandboxExecutor: sandboxOn ? sandboxExecutor : undefined });
              card.status = "completed";
              card.result = String(output).slice(0, 400);
              writeLog("cloud_tool_success", { requestId: id, tool: call.name, outputLength: String(output).length });
            } catch (error) {
              card.status = "failed";
              card.result = String(error.message || error).slice(0, 400);
              output = `工具执行失败：${error.message}`;
              writeLog("cloud_tool_failed", { requestId: id, tool: call.name, error: error.message });
            }
            }
            emitToolCard(card);
            if (isAnthropicProvider) {
              loopMessages.push({ raw: true, role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: output }] });
            } else {
              loopMessages.push({ raw: true, role: "tool", content: output, extra: { tool_call_id: call.id } });
            }
          }
        }
        // v3.24.4 修复③：报错文案用实际生效轮次数（旧版硬编码 MAX_TOOL_ROUNDS=25，用户设 50 时提示错误）
        throw new Error(`工具执行轮数已达上限（${maxToolRounds} 轮），已停止本轮任务。`);
      };

      sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "connecting" }, { connectionMode: "cloud" }));
      const cloudPromise = runCloudWithTools();
      activeRequests.set(id, { promise: cloudPromise, cancel: () => { cloudPromise.cancel?.(); }, conversationId: input.conversationId });
      // 信号链：四阶段契约（turn → transport → adapter → runner）+ 灯带投影
      const chatChain = safeSignal("chat-chain-create", () => signalMonitor.createRequest({ requestId: id, conversationId: input.conversationId, connectionMode: "cloud", attachmentCount: attachments.length, hasSession: Boolean(input.sessionId) }));
      safeSignal("chain-open", () => { chatChain.turnReceived(); chatChain.turnToTransport({}); chatChain.transportReceived({}); chatChain.transportToAdapter({}); chatChain.adapterReceived({}); chatChain.adapterToRunner({}); chatChain.runnerReceived({}); chatChain.runnerOperation({ promise: cloudPromise }); });
      try {
        const result = await cloudPromise;
        if (draftTimer) clearTimeout(draftTimer);
        safeSignal("chain-complete", () => chatChain.complete({}));
        if (result.cancelled) {
          // v3.15.5 修复1：取消时同样折叠复读段落再落库
          const cancelledRepetition = collapseRepetition(streamedText);
          if (cancelledRepetition.collapsed) {
            writeLog("cloud_repetition_collapsed", { requestId: id, conversationId: input.conversationId, collapsed: cancelledRepetition.collapsed, removed: cancelledRepetition.removed, originalLength: streamedText.length, phase: "cancelled" });
          }
          const cancelledText = (cancelledRepetition.collapsed ? cancelledRepetition.text : streamedText) || "已停止。";
          // v3.21.3 修复①：取消时已发生的真实消耗同样入账（usageTotal 为空则不挂）
          addAssistantMessage(input.conversationId, cancelledText, "", [], collectedTools, id, "cloud",
            usageTotal.requests ? { inputTokens: usageTotal.prompt, outputTokens: usageTotal.completion, totalTokens: usageTotal.total, cumulative: true } : undefined,
            undefined, undefined, undefined, undefined, streamedReasoning);
          writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "cancelled", eventType: "lifecycle", eventStatus: "cancelled" }));
          sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "cancelled" }, { connectionMode: "cloud" }));
          return { id, cancelled: true, text: cancelledText, sessionId: "", tools: collectedTools, files: [] };
        }
        // v3.15.5 修复1：复读检测折叠——模型陷入复读循环（同段复读 N 遍）时，落库与返回都走折叠后文本，
        // 防止复读产物全量进入下轮上下文（滚雪球放大）
        const repetition = collapseRepetition(streamedText);
        if (repetition.collapsed) {
          writeLog("cloud_repetition_collapsed", { requestId: id, conversationId: input.conversationId, collapsed: repetition.collapsed, removed: repetition.removed, originalLength: streamedText.length });
        }
        const finalText = repetition.collapsed ? repetition.text : streamedText;
        // v3.21.3 修复①：落库挂累计 usage（conversationStats 聚合输入/输出/总计真实账目；形态驼峰对齐）
        const cumulativeUsage = usageTotal.requests
          ? { inputTokens: usageTotal.prompt, outputTokens: usageTotal.completion, totalTokens: usageTotal.total, cumulative: true }
          : undefined;
        addAssistantMessage(input.conversationId, finalText || "（无输出）", "", [], collectedTools, id, "cloud", cumulativeUsage, undefined, undefined, undefined, undefined, streamedReasoning);
        const stats = conversationStats(getConversation(input.conversationId));
        writeLog("chat_send_success", { requestId: id, conversationId: input.conversationId, textLength: finalText.length, toolCallCount: collectedTools.length, connectionMode: "cloud", usageTokens: usageTotal.total });
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "completed", eventType: "lifecycle", eventStatus: "finished" }));
        sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "finished" }, { connectionMode: "cloud" }));
        return { id, text: finalText, usage: result.usage, stopReason: result.stopReason, sessionId: "", tools: collectedTools, files: [], stats, repetition: { collapsed: repetition.collapsed, removed: repetition.removed } };
      } catch (error) {
        if (draftTimer) clearTimeout(draftTimer);
        persistDraft();
        if (toolsEnabled && error.code === "CLOUD_ERROR" && !error.message.includes("工具执行轮数")) {
          error.message += "（若当前服务商不支持工具调用，请在设置中关闭「工具执行」后重试。）";
        }
        writeLog("chat_send_failed", { requestId: id, conversationId: input.conversationId, error: error.message, toolCallCount: collectedTools.length });
        writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "failed", eventType: "lifecycle", eventStatus: "failed" }));
        sendWorkStatusSignal(event.sender, "chat:event", normalizeAndObserveStatusEvent({ id, type: "lifecycle", status: "failed" }, { connectionMode: "cloud" }));
        safeSignal("chain-failed", () => chatChain.failed(error));
        throw error;
      } finally {
        if (draftTimer) clearTimeout(draftTimer);
        activeRequests.delete(id);
        // v3.22.0：沙箱执行器 SSH 连接清理（成功/失败/取消三路径统一收口）
        if (sandboxSshClient) { try { sandboxSshClient.end(); } catch { /* 已断开 */ } sandboxSshClient = null; }
      }
    }

    // ── SSH / 本机模式 ──
    const config = getConnection();
    const localEngine = localEngineOf(config);
    if (localEngine === "atomcode") config.atomcodeToken = getAtomcodeToken();
    const agentMessage = `${message}${message ? "\n\n" : ""}[来源电脑：${config.clientLabel}]`;
    const conversation = getConversation(input.conversationId);
    const taskProfile = activeSshProfileOf(config); // v3.18.0 F4：任务开始时锁定卡槽维度——切槽不杀任务也不串会话
    // v3.19.0 F3：任务开始时同样锁定适配器维度（advanced.adapter；仅 SSH 模式有第二语义）
    const taskRemoteAdapter = config.connectionMode === "ssh" ? String(config.advancedEffective?.adapter || "claude") : "claude";
    const activeSessionId = sessionForMode(conversation, config.connectionMode, localEngine, taskProfile, taskRemoteAdapter);
    let streamedText = "";
    let streamedTurnText = "";
    let streamedTurnThinking = ""; // v3.24.0 思考过程累计（turn 完成随消息落库）
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
      // v3.24.0 思考过程：SSH/local 流式外发 + 累积（协议层 thinkingFromEvent 透传）
      onThinking: (text) => {
        streamedTurnThinking += String(text || "");
        sendWorkStatusSignal(event.sender, "chat:event", { id, type: "thinking", text: String(text || "") });
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
          saveConversationSession(input.conversationId, sessionId, config.connectionMode, localEngine, taskProfile, taskRemoteAdapter);
          writeLog("chat_session_checkpointed", { requestId: id, conversationId: input.conversationId, sessionId, connectionMode: config.connectionMode, remoteAdapter: taskRemoteAdapter });
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
          addAssistantMessage(input.conversationId, completedText, turnSessionId || latestSessionId, [], [], id, config.connectionMode, turnUsage, undefined, undefined, taskProfile, taskRemoteAdapter, streamedTurnThinking);
          completedTurnCount += 1;
        }
        streamedTurnText = "";
        streamedTurnThinking = "";
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
    let operation;
    if (config.connectionMode === "local" && localEngine === "atomcode") {
      operation = runAtomCodeChat(config, agentMessage, activeSessionId, attachments, callbacks);
    } else if (config.connectionMode === "local" && localEngine === "custom") {
      // 自定义命令引擎无原生会话：回放历史续聊（最后一条是刚入库的本次用户消息，排除）
      config.history = conversation.messages.slice(0, -1);
      operation = runCustomCli(config, agentMessage, activeSessionId, attachments, callbacks);
    } else if (config.connectionMode === "local") {
      operation = runLocalClaude(config, agentMessage, activeSessionId, attachments, callbacks);
    } else {
      // v3.19.0 F3：SSH 远程适配器分派——claude=现有 bridge/direct 链不动；
      // qwen/codex/hermes=远端 CLI 直跑；atomcode=NAS 侧 daemon HTTP（daemon 换 NAS IP，零新代码）。
      const remoteAdapter = String(config.advancedEffective?.adapter || "claude");
      const cliRunners = { qwen: runQwenCli, codex: runCodexCli, hermes: runHermesCli };
      const runner = cliRunners[remoteAdapter];
      if (remoteAdapter === "atomcode") {
        // atomcode daemon 跑在 NAS 上：SSH 模式把 daemon 地址换成 NAS 连接地址（其余全走既有 daemon HTTP 链）
        config.atomcodeHost = String(config.host || "").trim() || String(config.atomcodeHost || "127.0.0.1");
        config.atomcodeToken = getAtomcodeToken() || config.atomcodeToken;
        callbacks.onLog?.("ssh_adapter_dispatch", { adapter: "atomcode", daemonHost: config.atomcodeHost });
        operation = runAtomCodeChat(config, agentMessage, activeSessionId, attachments, callbacks);
      } else if (runner) {
        callbacks.onLog?.("ssh_adapter_dispatch", { adapter: remoteAdapter });
        // 命令行模型的沙箱/服务商参数从高级设置透传（qwen -m / codex --sandbox / hermes --model --provider）
        if (config.advancedEffective?.adapterOptions) {
          config.remoteAdapterModel = config.advancedEffective.adapterOptions.model || config.remoteAdapterModel;
          config.remoteAdapterSandbox = config.advancedEffective.adapterOptions.sandbox || config.remoteAdapterSandbox;
          config.remoteAdapterProvider = config.advancedEffective.adapterOptions.provider || config.remoteAdapterProvider;
        }
        operation = runner(config, agentMessage, activeSessionId, attachments, callbacks);
      } else {
        operation = runClaude(config, agentMessage, activeSessionId, attachments, callbacks);
      }
    }
    writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "request-outcome", disposition: "started", eventType: "lifecycle", eventStatus: "started", transport: config.connectionMode === "local" ? `local-${localEngine}` : "ssh" }));
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
        addAssistantMessage(input.conversationId, result.text, result.sessionId, result.files, result.tools, id, config.connectionMode, result.usage, Date.now() - startedAt, localEngine, taskProfile, taskRemoteAdapter, "");
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
    if (config.connectionMode === "local" && String(config.localEngine || "claude") !== "claude") throw new Error("当前本机引擎不支持上下文压缩（仅 Claude CLI 引擎可用）。");
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
  // ── v3.37.0 群成员「各自干活」运行环境描述（用户实锤：群成员说不知道这台电脑是什么系统）──
  // 直接把真实系统/架构/工作目录写进群成员系统提示——不再靠 AI 猜平台。
  const cloudEnvironmentNote = () => {
    const platformName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
    const workdir = validatedLocalWorkdir(getCloudAiConfig().workingDirectory) || "";
    return `【本机运行环境（真实参数，直接可用）】操作系统：${platformName}（内核版本 ${os.release()}，架构 ${process.arch}）；你的工具（读文件/写文件/列目录${getCloudAiConfig().runCommandEnabled ? "/执行命令" : ""}/网络抓取）都是在这台 ${platformName} 机器上直接执行。工作目录：${workdir || "未配置（用户在连接设置配好云端工作目录后，文件与命令类工具才可用）"}。规则：能动手就动手，不要再说「不知道你电脑是什么系统」——以上就是真实系统参数。`;
  };
  // ── v3.35.6 多 AI 对话（工作）：Agent 池与工作组建档（模块一）──
  ipcMain.handle("agent-pool:list", () => poolModule.listPool());
  ipcMain.handle("agent-pool:add-cloud", (_event, input) => poolModule.addCloudNode(input || {}));
  ipcMain.handle("agent-pool:add-instance", (_event, input) => poolModule.addInstanceNode(input || {}));
  ipcMain.handle("agent-pool:update-node", (_event, id, patch) => poolModule.updatePoolNode(id, patch || {}));
  ipcMain.handle("agent-pool:remove-node", (_event, id) => poolModule.removePoolNode(id));
  ipcMain.handle("agent-pool:workgroups:list", () => poolModule.listWorkgroups());
  ipcMain.handle("agent-pool:workgroup:create", (_event, input) => poolModule.createWorkgroup(input || {}));
  ipcMain.handle("agent-pool:workgroup:update", (_event, id, patch) => poolModule.updateWorkgroup(id, patch || {}));
  ipcMain.handle("agent-pool:workgroup:delete", (_event, id) => poolModule.deleteWorkgroup(id));
  // 子 Agent 白名单目标（脱敏：不给完整密钥）
  ipcMain.handle("agent-pool:targets", () => poolModule.whitelistedCloudTargets().map(({ apiKey, ...rest }) => rest));
  // 建群入口：新建 team 对话后即时绑定工作组（首次群发也会兜底绑定）
  ipcMain.handle("conversations:set-workgroup", (_event, id, workgroupId) => setConversationWorkgroup(String(id || ""), String(workgroupId || "")));

  // ── v3.35.6 群聊指挥链路（模块三）+ Sub-Agent 包工头（模块四）──
  const groupDeps = () => ({
    sender: null, // 由 handler 填充（event.sender）
    sendWorkStatusSignal,
    log: writeLog,
    getConversation,
    getMode,
    addAssistantMessage,
    addUserMessage,
    saveAssistantDraft,
    activeRequests,
    agentSessionFor,
    saveAgentSession,
    getAtomcodeToken,
    askUserRegistry,
    // ── v3.37.0 群成员「各自干活」：工具执行组注入（跟随连接设置的全局工具开关；环境信息随行）──
    executeToolCall,
    toolDefinitions,
    groupTools: () => {
      const cloudConfig = getCloudAiConfig();
      const enabled = Boolean(cloudConfig.toolsEnabled);
      const allowCommand = enabled && Boolean(cloudConfig.runCommandEnabled);
      const sandboxOn = enabled && Boolean(cloudConfig.sandboxEnabled);
      const workdir = validatedLocalWorkdir(cloudConfig.workingDirectory) || "";
      // 沙箱模式下工作目录语义在容器内，本模块不接沙盒执行器（成员级沙盒=后续增强）——工作目录缺失/沙箱开=不注入文件/命令工具，纯聊天不炸
      return { enabled: enabled && !sandboxOn && Boolean(workdir), allowCommand, workdir, environmentText: cloudEnvironmentNote() };
    },
  });
  ipcMain.handle("chat:group-send", async (event, input) => {
    const conversationId = String(input?.conversationId || "");
    const workgroupId = String(input?.workgroupId || "");
    const message = String(input?.message || "").trim();
    if (!conversationId) throw new Error("请先新建一个群聊对话。");
    if (!workgroupId) throw new Error("该对话未绑定工作组，请先建群。");
    if (!message) throw new Error("请输入消息。");
    if (!getConversation(conversationId)) throw new Error("找不到对话，请新建后重试。");
    // v3.37.2 群发忙闸：该对话仍有进行中群轮时拒绝（渲染层闸兜底主闸）——
    // 原来无闸：群发进行中再群发=双群轮并发（云成员上下文互踩、SSH 卡槽 profile 切换互踩、消息双份落库）
    for (const entry of activeRequests.values()) {
      if (entry && entry.conversationId === conversationId) {
        throw new Error("群聊正在进行中（有成员仍在工作）。请点红色停止按钮结束本轮，或等本轮结束后再发。");
      }
    }
    writeLog("group_send_start", {
      conversationId, workgroupId, textLength: message.length,
      mentioned: Array.isArray(input.mentionedAgentIds) ? input.mentionedAgentIds.length : 0,
      autoDiscuss: Boolean(input.autoDiscuss)
    });
    setConversationWorkgroup(conversationId, workgroupId); // 群聊对话锁定工作组（首次群发落定）
    addUserMessage(conversationId, message);
    const deps = { ...groupDeps(), sender: event.sender };
    const outcome = await runGroupTurn(deps, {
      conversationId,
      workgroupId,
      message,
      mentionedAgentIds: Array.isArray(input.mentionedAgentIds) ? input.mentionedAgentIds : [],
      autoDiscuss: Boolean(input.autoDiscuss),
      // 红线③：maxTurns 缺省取工作组配置（默认 5），上限 10（引擎层 clamp）
      maxTurns: Number(input.maxTurns) || 0,
      workModeId: input.workModeId || ""
    });
    return { conversationId, ...outcome };
  });
  ipcMain.handle("chat:group-await", (_event, requestId) => awaitGroupTurn(String(requestId || "")));
  ipcMain.handle("chat:group-stop", (event, conversationId) => {
    const id = String(conversationId || "");
    writeLog("work_status_signal", statusSignalEntry({ requestId: `group-${id}`, direction: "main-received", signal: "group-stop", disposition: "accepted" }));
    // 紧急停止大红按钮：置停止旗（接力轮间断点）+ activeRequests 全员 cancel + 子 Agent 悬等收口
    const stopped = stopGroupTurns(activeRequests, id, askUserRegistry);
    writeLog("group_stop_requested", { conversationId: id, stopped });
    return { stopped };
  });
  // 池内云端成员（Sub-Agent 派生目标，脱敏形态）
  ipcMain.handle("chat:spawn-subagent", async (event, input) => {
    const conversationId = String(input?.conversationId || "");
    if (!conversationId) throw new Error("请先新建一个对话。");
    const task = String(input?.task || "").trim();
    if (!task) throw new Error("子任务描述不能为空。");
    const result = await executeSubAgent({
      log: writeLog,
      emit: (rid, payload) => sendWorkStatusSignal(event.sender, "chat:event", { id: rid, ...payload }),
      emitSub: (rid, payload) => sendWorkStatusSignal(event.sender, "chat:subagent-event", { parentId: rid, ...payload }),
      deps: { ...groupDeps(), sender: event.sender }
    }, {
      conversationId,
      parentRequestId: String(input?.parentRequestId || ""),
      parentName: String(input?.parentName || "用户"),
      task,
      expect: String(input?.expect || ""),
      targetAgentId: String(input?.targetAgentId || "")
    });
    return result;
  });
  ipcMain.handle("chat:cancel", (_event, id) => {
    writeLog("work_status_signal", statusSignalEntry({ requestId: id, direction: "main-received", signal: "chat-cancel", disposition: "accepted" }));
    const request = activeRequests.get(id);
    if (!request) return false;
    try {
      // v3.24.0：停止请求同时打断 ask_user 选择题悬等（气泡卡片收口，工具循环如实回填「用户已停止」）
      try { askUserRegistry.cancelAll(id); } catch {}
      request.operation.cancel();
      writeLog("chat_cancel_requested", { requestId: id });
      return true;
    } catch (error) {
      writeLog("chat_cancel_failed", { requestId: id, error });
      return false;
    }
  });
  // v3.24.0：聊天气泡选择题（ask_user）用户应答 —— resolve 工具循环悬等，结果作为 tool 消息回填继续
  ipcMain.handle("ask-user:answer", (_event, payload) => {
    const callId = String(payload?.callId || "");
    if (!callId) return { ok: false, error: "缺少 callId" };
    if (typeof payload?.label !== "string") return { ok: false, error: "缺少 label" };
    writeLog("ask_user_answered", { callId, labelLength: payload.label.length });
    return askUserRegistry.answer(callId, payload.label);
  });
  // v3.24.0：思考挡位表查询（输入栏 Codex 风格面板按当前模型原生挡位渲染滑条）
  ipcMain.handle("thinking:profile", (_event, payload) => {
    const profile = resolveThinkingProfile(payload?.provider || "", payload?.model || "");
    return { profile };
  });
  // 关于页版本展示（v3.12.2）
  ipcMain.handle("app:version", () => app.getVersion());
  // v3.15.8 关于页彩蛋：跳跳龙小游戏窗口
  ipcMain.handle("app:open-dino-game", () => createDinoGameWindow());
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

  // ── 产品形态门控（渲染层经 app:edition 获取同一份编译期对象：隐藏设备联动/本机模式/彩蛋等） ──
  // v3.37.1 悬账修复：EDITION 整包含函数 editionFor → 结构化克隆拒（「An object could not be cloned」）
  // 只回三字段纯数据（gates 浅拷防上游共享引用）；消费者只有 edition/productName/gates 三个键。
  ipcMain.handle("app:edition", () => ({
    edition: EDITION.edition,
    productName: EDITION.productName,
    gates: { ...EDITION.gates }
  }));

  // ── Agent HTTP 桥（阉割版 Bridge Edition 专属，agentBridge:* 命名空间——既有 bridge:* 是 Agent SDK 桥安装机制，不可混用） ──
  // 云端AI 走 curl → 桥（127.0.0.1 + Token + 人工放行队列）→ 放行后推 agentBridge:turn-start 给渲染层
  // → 渲染层走既有 chat:send 链路（senderType=cloud-ai，主进程强制追加标记前缀）→ 回报终态 → 云端AI 轮询 /api/message 收回复
  // 安全面：桥只收本机回环 + Token；云端AI 无法触达设备联动/打印 IPC（它们是渲染层调用面，且阉割版两者已关）
  if (EDITION.gates.agentBridge) {
    const { createAgentHttpBridge } = require("./agent-http-bridge.cjs");
    agentBridgeInstance = createAgentHttpBridge({
      logger: writeLog,
      getPort: () => getSettings().agentBridgePort,
      getGate: () => getSettings().agentBridgeGate,
      tokenProvider: () => { try { return ensureAgentBridgeToken(); } catch (error) { writeLog("agent_bridge_token_error", { error: error.message }); return ""; } },
      resolveTarget: () => {
        // 目标对话：settings 指定 id 在场且存在 → 用之；否则取最新对话；再无 → 自动建「云端AI桥接」
        const wanted = getAgentBridgeConversationId();
        if (wanted) {
          const found = getConversation(wanted);
          if (found) return { conversationId: found.id };
        }
        const all = listConversations();
        if (all.length) {
          if (wanted !== all[0].id) setAgentBridgeConversationId(all[0].id);
          return { conversationId: all[0].id };
        }
        const created = createConversation();
        setAgentBridgeConversationId(created.id);
        writeLog("agent_bridge_conversation_created", { conversationId: created.id });
        return { conversationId: created.id };
      },
      notifyRenderer: (channel, payload) => {
        if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
      }
    });
    agentBridgeInstance.start();
    ipcMain.handle("agentBridge:info", () => agentBridgeInstance.info());
    ipcMain.handle("agentBridge:approve", (_event, msgId) => agentBridgeInstance.approve(msgId));
    ipcMain.handle("agentBridge:reject", (_event, msgId, reason) => agentBridgeInstance.reject(msgId, reason));
    ipcMain.handle("agentBridge:report", (_event, payload) => agentBridgeInstance.reportResult(payload));
    // set-config：改端口必须 stop 后再 start（start() 对已监听实例直通返回旧端口），否则新端口不生效
    ipcMain.handle("agentBridge:set-config", async (_event, input) => {
      setAgentBridgeConfig(input || {});
      await agentBridgeInstance.stop();
      const started = await agentBridgeInstance.start();
      return { ...agentBridgeInstance.info(), started };
    });
    ipcMain.handle("agentBridge:set-target", (_event, conversationId) => { setAgentBridgeConversationId(conversationId); return agentBridgeInstance.info(); });
  }

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