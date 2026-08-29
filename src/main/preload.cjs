"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function auditSignal(entry) {
  ipcRenderer.send("status:signal", entry);
}
function eventAuditDetails(payload = {}) {
  const audit = payload.audit && typeof payload.audit === "object" ? payload.audit : {};
  return {
    requestId: payload.id,
    eventType: payload.type,
    eventStatus: payload.status,
    toolId: audit.toolId || "",
    toolName: audit.toolName || payload.toolName || "",
    toolStatus: audit.toolStatus || "",
    toolAction: audit.toolAction || "",
    fileFormats: Array.isArray(audit.fileFormats) ? audit.fileFormats : [],
    toolTargets: Array.isArray(audit.toolTargets) ? audit.toolTargets : [],
    textLength: payload.type === "delta" ? String(payload.text || "").length : 0,
    uploadPercent: payload.type === "upload" ? Math.round(Number(payload.overall || 0) * 100) : 0
  };
}

contextBridge.exposeInMainWorld("claudeNas", {
  // ── 设置 IPC ──
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  setToolMode: (enabled) => ipcRenderer.invoke("settings:tool-mode", enabled),
  // ── 模型管理 IPC ──
  getModelStatus: () => ipcRenderer.invoke("model:status"),
  initializeModelAdminPassword: (input) => ipcRenderer.invoke("model:initialize-password", input),
  updateModel: (model) => ipcRenderer.invoke("model:update", model),
  // ── 会话管理 IPC ──
  listConversations: () => ipcRenderer.invoke("conversations:list"),
  createConversation: () => ipcRenderer.invoke("conversations:create"),
  getConversation: (id) => ipcRenderer.invoke("conversations:get", id),
  clearConversationSession: (id) => ipcRenderer.invoke("conversations:clear-session", id),
  renameConversation: (id, title) => ipcRenderer.invoke("conversations:rename", id, title),
  setConversationPinned: (id, pinned) => ipcRenderer.invoke("conversations:set-pinned", id, pinned),
  deleteConversation: (id) => ipcRenderer.invoke("conversations:delete", id),
  searchConversations: (query, limit) => ipcRenderer.invoke("conversations:search", query, limit),
  // ── 聊天 IPC ──
  sendMessage: (input) => {
    auditSignal({
      requestId: input?.id,
      direction: "preload-sent",
      signal: "chat-send",
      disposition: "accepted",
      textLength: String(input?.message || "").length,
      attachmentCount: Array.isArray(input?.attachments) ? input.attachments.length : 0
    });
    return ipcRenderer.invoke("chat:send", input);
  },
  pushFollowUp: (input) => {
    auditSignal({
      requestId: input?.id,
      direction: "preload-sent",
      signal: "chat-push-follow-up",
      disposition: "attempt",
      textLength: String(input?.message || "").length
    });
    return ipcRenderer.invoke("chat:push-follow-up", input);
  },
  cancelMessage: (id) => {
    auditSignal({ requestId: id, direction: "preload-sent", signal: "chat-cancel", disposition: "attempt" });
    return ipcRenderer.invoke("chat:cancel", id);
  },
  // ── 连接测试 IPC ──
  testConnection: (settings) => ipcRenderer.invoke("connection:test", settings),
  // ── Markdown 渲染 IPC ──
  renderMarkdown: (source) => ipcRenderer.invoke("markdown:render", source),
  // ── 链接打开 IPC ──
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  // ── 授权管理 IPC ──
  getAuthStatus: () => ipcRenderer.invoke("auth:status"),
  verifyAuthCode: (code) => ipcRenderer.invoke("auth:verify", code),
  checkAuthFromServer: () => ipcRenderer.invoke("auth:check"),
  // ── 网络状态 IPC ──
  getNetworkStatus: () => ipcRenderer.invoke("network:status"),
  networkConnect: (config) => ipcRenderer.invoke("network:connect", config),
  networkDisconnect: () => ipcRenderer.invoke("network:disconnect"),
  persistNetworkState: () => ipcRenderer.invoke("network:persist-state"),
  // ── 模式管理 IPC ──
  listModes: () => ipcRenderer.invoke("modes:list"),
  getMode: (id) => ipcRenderer.invoke("modes:get", id),
  createMode: (input) => ipcRenderer.invoke("modes:create", input),
  updateMode: (id, input) => ipcRenderer.invoke("modes:update", id, input),
  deleteMode: (id) => ipcRenderer.invoke("modes:delete", id),
  exportModes: () => ipcRenderer.invoke("modes:export"),
  importModes: (json) => ipcRenderer.invoke("modes:import", json),
  // ── Bridge IPC ──
  getBridgeStatus: () => ipcRenderer.invoke("bridge:status"),
  installBridge: () => ipcRenderer.invoke("bridge:install"),
  uninstallBridge: () => ipcRenderer.invoke("bridge:uninstall"),
  // ── 设备控制 IPC ──
  getDeviceControlStatus: () => ipcRenderer.invoke("device-control:status"),
  installDeviceControl: (options) => ipcRenderer.invoke("device-control:install", options),
  uninstallDeviceControl: () => ipcRenderer.invoke("device-control:uninstall"),
  // ── 存储目录 IPC ──
  chooseStorageDirectory: () => ipcRenderer.invoke("storage:choose"),
  openStorageDirectory: (directory) => ipcRenderer.invoke("storage:open", directory),
  // ── 归档 IPC ──
  openArchiveDirectory: () => ipcRenderer.invoke("archive:open"),
  showConversationArchive: (id) => ipcRenderer.invoke("archive:show", id),
  // ── 诊断 IPC ──
  openDiagnostics: () => ipcRenderer.invoke("diagnostics:open"),
  // ── 文件操作 IPC ──
  previewRemoteFile: (file) => ipcRenderer.invoke("file:preview", file),
  saveRemoteFile: (file) => ipcRenderer.invoke("file:save", file),
  openRemoteFile: (file) => ipcRenderer.invoke("file:open", file),
  // ── 状态审计 IPC ──
  recordWorkStatus: (entry) => ipcRenderer.send("status:journal", entry),
  recordWorkStatusSignal: (entry) => ipcRenderer.send("status:signal", entry),
  recordWorkStatusToolLifecycle: (entry) => ipcRenderer.send("status:tool-lifecycle", entry),
  // ── 窗口控制 IPC ──
  windowAction: (action) => ipcRenderer.invoke("window:action", action),
  isWindowMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  restoreNativeDialogFocus: () => ipcRenderer.invoke("window:restore-native-dialog-focus"),
  // ── 主题偏好 ──
  getTheme: () => ipcRenderer.invoke("settings:load").then((s) => s.theme || "dark"),
  // ── 事件监听 ──
  onDelta: (handler) => ipcRenderer.on("chat:delta", (_event, payload) => {
    auditSignal({ ...eventAuditDetails({ ...payload, type: "delta" }), direction: "preload-received", signal: "chat-delta", disposition: "accepted" });
    handler(payload);
  }),
  onChatEvent: (handler) => ipcRenderer.on("chat:event", (_event, payload) => {
    auditSignal({ ...eventAuditDetails(payload), direction: "preload-received", signal: "chat-event", disposition: "accepted" });
    handler(payload);
  }),
  onTurnStart: (handler) => ipcRenderer.on("chat:turn-start", (_event, payload) => handler(payload)),
  onTurnComplete: (handler) => ipcRenderer.on("chat:turn-complete", (_event, payload) => handler(payload)),
  onMenuAction: (handler) => ipcRenderer.on("app:menu", (_event, action) => handler(action)),
  onWindowMaximized: (handler) => ipcRenderer.on("window:maximized", (_event, value) => handler(value)),
  onNetworkStatusChange: (handler) => ipcRenderer.on("network:status-change", (_event, event) => handler(event)),
  onNetworkLatency: (handler) => ipcRenderer.on("network:latency", (_event, summary) => handler(summary)),
  onThemeInit: (handler) => ipcRenderer.once("theme:init", (_event, theme) => handler(theme)),
  // ── 授权事件监听 ──
  onAuthShowLockScreen: (handler) => ipcRenderer.on("auth:show-lock-screen", (_event) => handler()),
  onAuthUnlockSuccess: (handler) => ipcRenderer.on("auth:unlock-success", (_event) => handler())
});