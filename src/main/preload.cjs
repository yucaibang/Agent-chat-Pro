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

contextBridge.exposeInMainWorld("agentChatPro", {
  // ── 设置 IPC ──
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  setToolMode: (enabled) => ipcRenderer.invoke("settings:tool-mode", enabled),
  // v3.22.0 云办公二期：沙箱状态查询与临时联网切换（立即生效动作，非表单保存）
  getSandboxStatus: () => ipcRenderer.invoke("sandbox:status"),
  setSandboxNetwork: (enabled) => ipcRenderer.invoke("sandbox:setNetwork", enabled),
  // ── 模型管理 IPC ──
  getModelStatus: () => ipcRenderer.invoke("model:status"),
  initializeModelAdminPassword: (input) => ipcRenderer.invoke("model:initialize-password", input),
  updateModel: (model) => ipcRenderer.invoke("model:update", model),
  // v3.18.0 F2：五项单独修改 + 自动压缩阈值（管理员密码与确认语义对齐 model:update）
  updateModelEntry: (input) => ipcRenderer.invoke("model:update-entry", input),
  updateAutoCompactWindow: (input) => ipcRenderer.invoke("model:update-compact", input),
  // v3.18.0 F4：SSH 卡槽切换（目标槽整套参数物化为活跃连接）
  switchSshProfile: (profileId) => ipcRenderer.invoke("settings:switch-ssh-profile", profileId),
  // v3.19.0 F3：SSH 远程适配器在场检测（单次连接探测远端 CLI）
  detectSshAdapter: (payload) => ipcRenderer.invoke("settings:detect-ssh-adapter", payload),
  // ── 会话管理 IPC ──
  listConversations: () => ipcRenderer.invoke("conversations:list"),
  createConversation: () => ipcRenderer.invoke("conversations:create"),
  getConversation: (id) => ipcRenderer.invoke("conversations:get", id),
  clearConversationSession: (id) => ipcRenderer.invoke("conversations:clear-session", id),
  renameConversation: (id, title) => ipcRenderer.invoke("conversations:rename", id, title),
  setConversationPinned: (id, pinned) => ipcRenderer.invoke("conversations:set-pinned", id, pinned),
  // v3.15.5 修复2：删除单条及下方所有落库消息（右键菜单同步删除）
  truncateConversationMessages: (id, anchor) => ipcRenderer.invoke("conversations:truncate", id, anchor),
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
  // ── 代理连通性测试 IPC ──
  testProxy: (proxyConfig) => ipcRenderer.invoke("chat:test-proxy", proxyConfig),
  // v3.21.0 云端「拉取模型列表」IPC
  fetchCloudModels: (payload) => ipcRenderer.invoke("cloud:fetch-models", payload),
  // ── 上下文压缩 IPC（v3.10.0）──
  compactContext: (payload) => ipcRenderer.invoke("chat:compact", payload),
  // 上下文进度条回填（v3.12.1）：切换对话时取 main 侧记录的 {tokens, limit}
  getConversationContext: (conversationId) => ipcRenderer.invoke("context:get", conversationId),
  // 关于页版本（v3.12.2）
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  // v3.15.8 关于页彩蛋：跳跳龙小游戏窗口
  openDinoGame: () => ipcRenderer.invoke("app:open-dino-game"),
  // ── 缓存清理 IPC（v3.10.0）──
  scanSystemCaches: () => ipcRenderer.invoke("cache:scan"),
  cleanSystemCaches: (targets) => ipcRenderer.invoke("cache:clean", targets),
  // ── Markdown 渲染 IPC ──
  renderMarkdown: (source) => ipcRenderer.invoke("markdown:render", source),
  // ── 链接打开 IPC ──
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  // ── 产品形态（阉割门控）：渲染层按 gates 隐藏设备联动/本机模式/彩蛋/打印等 ──
  getEdition: () => ipcRenderer.invoke("app:edition"),
  // ── Agent HTTP 桥（阉割版 Bridge Edition 专属；agentBridge:* 命名空间，与既有 bridge:*（Agent SDK 桥安装机制）严格区分） ──
  getAgentBridgeInfo: () => ipcRenderer.invoke("agentBridge:info"),
  approveAgentBridgeMessage: (msgId) => ipcRenderer.invoke("agentBridge:approve", msgId),
  rejectAgentBridgeMessage: (msgId, reason) => ipcRenderer.invoke("agentBridge:reject", msgId, reason),
  reportAgentBridgeResult: (payload) => ipcRenderer.invoke("agentBridge:report", payload),
  setAgentBridgeConfig: (input) => ipcRenderer.invoke("agentBridge:set-config", input),
  setAgentBridgeTarget: (conversationId) => ipcRenderer.invoke("agentBridge:set-target", conversationId),
  onAgentBridgeQueue: (handler) => ipcRenderer.on("agentBridge:queue", (_event, queue) => handler(queue)),
  onAgentBridgeTurn: (handler) => ipcRenderer.on("agentBridge:turn-start", (_event, turn) => handler(turn)),
  // ── 网络状态 IPC ──
  getNetworkStatus: () => ipcRenderer.invoke("network:status"),
  networkConnect: (config) => ipcRenderer.invoke("network:connect", config),
  networkDisconnect: () => ipcRenderer.invoke("network:disconnect"),
  persistNetworkState: () => ipcRenderer.invoke("network:persist-state"),
  // ── N2N 体检 + 一键部署 IPC（v3.23.0）──
  runN2nDoctor: (payload) => ipcRenderer.invoke("n2n:doctor", payload),
  onN2nDoctorItem: (handler) => ipcRenderer.on("n2n:doctor:item", (_event, item) => handler(item)),
  runN2nDeploy: (payload) => ipcRenderer.invoke("n2n:deploy", payload),
  onN2nDeployLine: (handler) => ipcRenderer.on("n2n:deploy:line", (_event, line) => handler(line)),
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
  readDeviceControlIpTrack: (deviceId) => ipcRenderer.invoke("device-control:ip-track", deviceId),
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
  // ── 打印联动（v3.16.1，Agent print 生态闭环）──
  printDetect: () => ipcRenderer.invoke("print:detect"),
  printSend: (file) => ipcRenderer.invoke("print:send", file),
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
  // ── 品牌验证 IPC ──
  getBrandConfig: () => ipcRenderer.invoke("brand:get-config"),
  getBrandStatus: () => ipcRenderer.invoke("brand:get-status"),
  submitAdminOverride: (adminPassword) => ipcRenderer.invoke("brand:admin-override", adminPassword),
  onBrandConfig: (handler) => ipcRenderer.on("brand:config", (_event, config) => handler(config)),
  onBrandStatus: (handler) => ipcRenderer.on("brand:status", (_event, status) => handler(status)),
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
  // ── 上下文进度条事件（v3.10.0）：model / usage / compact 三类 ──
  onContextEvent: (handler) => ipcRenderer.on("chat:context", (_event, payload) => handler(payload)),
  onWindowMaximized: (handler) => ipcRenderer.on("window:maximized", (_event, value) => handler(value)),
  onWindowFocus: (handler) => ipcRenderer.on("window:focus", () => handler()),
  onNetworkStatusChange: (handler) => ipcRenderer.on("network:status-change", (_event, event) => handler(event)),
  onNetworkLatency: (handler) => ipcRenderer.on("network:latency", (_event, summary) => handler(summary)),
  onThemeInit: (handler) => ipcRenderer.once("theme:init", (_event, theme) => handler(theme)),
  // ── 信号灯 IPC（UI 隐藏，后端通道预留） ──
  onSignalLights: (handler) => ipcRenderer.on("signal:lights", (_event, lights) => handler(lights)),
  getSignalLights: () => ipcRenderer.invoke("signal:lights:get"),
  // ── Bridge 强制关闭通知 ──
  onBridgeForceClosed: (handler) => ipcRenderer.on("bridge:force-closed", (_event, detail) => handler(detail)),
});