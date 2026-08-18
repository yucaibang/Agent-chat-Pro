"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require("electron");
const path = require("path");
const { randomUUID } = require("crypto");
const { getConnection, getSettings, getSshConnection, saveSettings, trustHostFingerprint } = require("./settings.cjs");
const { downloadRemoteFile, ensureDeviceControlKey, finalizeDeviceControl, getAgentSdkBridgeStatus, installAgentSdkBridge, markDeviceControlDisabled, readRemoteFile, runClaude, uninstallAgentSdkBridge, verifyConnection } = require("./ssh.cjs");
const { copyLocalFile, readLocalFile, runLocalClaude, verifyLocalConnection } = require("./local.cjs");
const { getDeviceControlStatus, installDeviceControl, preferredAddress, uninstallDeviceControl } = require("./device-control.cjs");
const {
  addAssistantMessage,
  addUserMessage,
  createConversation,
  deleteConversation,
  ensureConversationArchives,
  getConversation,
  listConversations,
  archiveDirectory,
  prepareConversationDirectory,
  renameConversation,
  saveAssistantDraft,
  sessionForMode
} = require("./conversations.cjs");
const { logPath, writeLog } = require("./logger.cjs");
const { renderMarkdown } = require("./markdown.cjs");
const { samePath } = require("./storage.cjs");

let window;
const activeRequests = new Map();

function bundledBridgeFiles() {
  const fs = require("fs");
  const directory = path.join(__dirname, "../bridge");
  const required = ["agent-sdk-bridge.mjs", "package.json"];
  const optional = ["package-lock.json"];
  const files = required.map((name) => ({ name, data: fs.readFileSync(path.join(directory, name)) }));
  for (const name of optional) {
    const filePath = path.join(directory, name);
    if (fs.existsSync(filePath)) files.push({ name, data: fs.readFileSync(filePath) });
  }
  return files;
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
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  const publishState = () => window?.webContents.send("window:maximized", window.isMaximized());
  window.on("maximize", publishState);
  window.on("unmaximize", publishState);
  window.webContents.on("did-finish-load", publishState);
  window.webContents.on("render-process-gone", (_event, details) => writeLog("renderer_process_gone", details));
  window.on("unresponsive", () => writeLog("window_unresponsive"));
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.jiang.agentChatPro");
  nativeTheme.themeSource = "dark";
  writeLog("app_start", { version: app.getVersion(), platform: process.platform, arch: process.arch });
  try {
    const archived = ensureConversationArchives();
    writeLog("conversation_archives_ready", { conversations: archived, directory: archiveDirectory() });
  } catch (error) {
    writeLog("conversation_archives_failed", { error });
  }
  ipcMain.handle("settings:load", () => getSettings());
  ipcMain.handle("settings:save", async (_event, input) => {
    const previous = getSettings();
    const requestedDirectory = input.dataDirectory || previous.defaultDataDirectory;
    const directoryChanged = !samePath(previous.dataDirectory, requestedDirectory);
    if (directoryChanged && activeRequests.size) throw new Error("Agent 正在回复，暂时不能迁移聊天记录。请等待当前回复结束后再保存。");
    const startedAt = Date.now();
    if (directoryChanged) writeLog("storage_migration_start", { hasExistingConversations: listConversations().length > 0 });
    try {
      const migration = await prepareConversationDirectory(previous.dataDirectory, requestedDirectory);
      const saved = saveSettings({ ...input, dataDirectory: migration.directory });
      ensureConversationArchives();
      if (directoryChanged) writeLog("storage_migration_success", {
        conversations: migration.conversations,
        archives: migration.archives,
        mergedExisting: migration.mergedExisting,
        durationMs: Date.now() - startedAt
      });
      writeLog("settings_saved", { connectionMode: saved.connectionMode, host: saved.host, port: saved.port, username: saved.username, wakeName: saved.wakeName, dataDirectory: saved.dataDirectory });
      return saved;
    } catch (error) {
      if (directoryChanged) writeLog("storage_migration_failed", { durationMs: Date.now() - startedAt, error });
      throw error;
    }
  });
  ipcMain.handle("settings:tool-mode", async (_event, enabled) => {
    const current = getSettings();
    try {
      if (enabled) {
        const localMode = current.connectionMode === "local";
        const answer = await dialog.showMessageBox(window, {
          type: "warning",
          title: "允许 Agent 自动执行工具",
          message: `允许 Agent 在${localMode ? "这台电脑" : " NAS"}上自动执行工具操作？`,
          detail: `开启后，Agent 可以在${localMode ? "本机" : " NAS"}读取、创建、修改文件并运行命令。仅在信任当前${localMode ? "电脑" : " NAS"}和工作目录时开启。`,
          buttons: ["取消", "允许自动执行"],
          defaultId: 0,
          cancelId: 0
        });
        if (answer.response !== 1) return { ...current, cancelled: true };
      }
      const saved = saveSettings({ ...current, skipPermissions: Boolean(enabled) });
      writeLog("tool_permission_mode_changed", { automatic: saved.skipPermissions });
      return saved;
    } finally {
      if (window && !window.isDestroyed()) {
        window.show();
        window.focus();
        window.webContents.focus();
      }
    }
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
      detail: `目标：${config.username}@${config.host}:${config.port}\n\n软件会写入当前 SSH 账号目录 ~/.claude-nas-chat/bridge，并通过 npm 安装 Agent SDK 依赖。基础聊天不需要此组件；安装后可获得精确停止和工具确认。不会修改 Claude 的模型、账号或全局设置。`,
      buttons: ["取消", "安装增强 Bridge"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true };
    writeLog("agent_sdk_bridge_install_requested", { host: config.host, username: config.username });
    return installAgentSdkBridge(config, bundledBridgeFiles(), (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  ipcMain.handle("bridge:uninstall", async () => {
    const config = getSshConnection();
    const answer = await dialog.showMessageBox(window, {
      type: "warning",
      title: "移除增强 Bridge",
      message: "确定移除该 NAS 的增强 Bridge 吗？",
      detail: "将删除当前 SSH 账号目录 ~/.claude-nas-chat/bridge。基础直连聊天仍可使用，但精确停止和工具确认会降级。",
      buttons: ["取消", "移除增强 Bridge"],
      defaultId: 0,
      cancelId: 0
    });
    if (answer.response !== 1) return { cancelled: true };
    return uninstallAgentSdkBridge(config, (fingerprint) => trustHost(config, fingerprint), writeLog);
  });
  ipcMain.handle("markdown:render", (_event, source) => renderMarkdown(source));
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
  ipcMain.handle("conversations:rename", (_event, id, title) => renameConversation(id, title));
  ipcMain.handle("conversations:delete", (_event, id) => deleteConversation(id));
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
  ipcMain.handle("connection:test", async (_event, input) => {
    const mode = input?.connectionMode === "local" ? "local" : "ssh";
    let saved;
    try { saved = mode === "local" ? getSettings() : getConnection(); }
    catch (error) {
      if (mode !== "ssh" || !input?.password) throw error;
      saved = getSettings();
    }
    const config = { ...saved, ...input, connectionMode: mode, password: input.password || saved.password };
    writeLog("connection_test_start", { connectionMode: mode, host: config.host, port: config.port, username: config.username, wakeName: config.wakeName });
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
    const id = input.id || randomUUID();
    const message = String(input.message || "").trim();
    const attachments = Array.isArray(input.attachments) ? input.attachments : [];
    if (!message && !attachments.length) throw new Error("请输入消息或添加附件。");
    if (!input.conversationId) throw new Error("请先新建一个对话。");
    addUserMessage(input.conversationId, message, attachments.map((file) => file.name));
    writeLog("chat_send_start", {
      requestId: id,
      conversationId: input.conversationId,
      hasSession: Boolean(input.sessionId),
      textLength: message.length,
      attachments: attachments.map((file) => ({ name: file.name, size: file.data?.byteLength || 0, mimeType: file.mimeType }))
    });
    const config = getConnection();
    const agentMessage = `${message}${message ? "\n\n" : ""}[来源电脑：${config.clientLabel}]`;
    const conversation = getConversation(input.conversationId);
    const activeSessionId = sessionForMode(conversation, config.connectionMode);
    let streamedText = "";
    let draftTimer;
    const persistDraft = () => {
      draftTimer = undefined;
      if (!streamedText) return;
      try { saveAssistantDraft(input.conversationId, id, streamedText); }
      catch (error) { writeLog("conversation_draft_save_failed", { requestId: id, conversationId: input.conversationId, error }); }
    };
    const callbacks = {
      conversationId: input.conversationId,
      onDelta: (text) => {
        streamedText += text;
        event.sender.send("chat:delta", { id, text });
        if (!draftTimer) draftTimer = setTimeout(persistDraft, 1000);
      },
      onUploadProgress: (progress) => event.sender.send("chat:event", { id, type: "upload", ...progress }),
      onToolEvent: (tool) => event.sender.send("chat:event", { id, type: "tool", tool }),
      onStatus: (status) => event.sender.send("chat:event", { id, type: "connection", status }),
      onPermissionRequest: async (request) => {
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
        return answer.response === 1;
      },
      onUnknownHost: (fingerprint) => trustHost(config, fingerprint),
      onLog: writeLog
    };
    config.localUploadDirectory = path.join(app.getPath("userData"), "local-uploads");
    const operation = config.connectionMode === "local"
      ? runLocalClaude(config, agentMessage, activeSessionId, attachments, callbacks)
      : runClaude(config, agentMessage, activeSessionId, attachments, callbacks);
    activeRequests.set(id, operation);
    try {
      const result = await operation.promise;
      if (draftTimer) clearTimeout(draftTimer);
      addAssistantMessage(input.conversationId, result.text, result.sessionId, result.files, result.tools, id, config.connectionMode);
      writeLog("chat_send_success", { requestId: id, conversationId: input.conversationId, sessionId: result.sessionId, textLength: result.text.length });
      return { id, ...result };
    } catch (error) {
      if (draftTimer) clearTimeout(draftTimer);
      persistDraft();
      if (error?.cancelled || /^已停止/.test(String(error?.message || ""))) {
        writeLog("chat_send_cancelled", { requestId: id, conversationId: input.conversationId, textLength: streamedText.length });
        return { id, cancelled: true, text: streamedText, sessionId: activeSessionId, files: [], tools: [] };
      }
      writeLog("chat_send_failed", { requestId: id, conversationId: input.conversationId, error });
      throw error;
    } finally {
      if (draftTimer) clearTimeout(draftTimer);
      activeRequests.delete(id);
    }
  });
  ipcMain.handle("chat:cancel", (_event, id) => activeRequests.get(id)?.cancel());
  ipcMain.handle("window:is-maximized", () => Boolean(window?.isMaximized()));
  ipcMain.handle("window:action", (_event, action) => handleWindowAction(action));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
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
    detail: `版本 ${app.getVersion()}\n支持内网直连/外网穿透双模式 SSH 远程 AI 聊天；当前内置 Claude Code 适配器。`,
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
