"use strict";

const elements = {
  dialog: document.querySelector("#settings-dialog"),
  form: document.querySelector("#settings-form"),
  status: document.querySelector("#settings-status"),
  messages: document.querySelector("#messages"),
  empty: document.querySelector("#empty-state"),
  prompt: document.querySelector("#prompt"),
  filePicker: document.querySelector("#file-picker"),
  attachmentList: document.querySelector("#attachment-list"),
  conversationList: document.querySelector("#conversation-list"),
  conversationSearch: document.querySelector("#conversation-search"),
  historyCount: document.querySelector("#history-count"),
  composer: document.querySelector("#composer"),
  send: document.querySelector("#send"),
  composerModeTrigger: document.querySelector("#composer-mode-trigger"),
  composerModePopup: document.querySelector("#composer-mode-popup"),
  composerModeList: document.querySelector("#composer-mode-list"),
  stateText: document.querySelector("#state-text"),
  stateDot: document.querySelector("#state-dot")
};

let sessionId = "";
let activeId = "";
let conversationId = "";
let attachments = [];
let conversationCache = [];
let automaticTools = false;
let currentConnectionMode = "ssh";
let currentLocalEngine = "claude";  // 本机模式引擎（v3.13.0）：claude / atomcode / custom

/** 本机引擎显示名（不含"本机"前缀） */
function localEngineLabel() {
  if (currentConnectionMode !== "local") return "Claude";
  return currentLocalEngine === "atomcode" ? "AtomCode" : currentLocalEngine === "custom" ? "自定义命令" : "Claude";
}
let hasCloudApiKey = false;
let brandConfig = null;     // 云端品牌配置
let brandVerified = false;  // 是否通过云端验证
const messages = new Map();

// ── Token 计数器 ──
let conversationTokens = 0;  // 当前对话累计 token 数
let streamingTokens = 0;    // 当前流式响应估算的 token 数
let confirmedTokens = 0;    // 当前流式响应已确认的 token 数（来自 usage 事件）
let hasProxyPassword = false;  // 是否已保存代理密码

// ── 上下文进度条（v3.10.0）──
let contextTokens = 0;      // 当前上下文占用（input + cache 写入 + cache 读取）
let contextLimit = 0;       // 当前模型上下文窗口上限
let compactingNow = false;  // 是否正在压缩（禁用压缩按钮）

// ── 外观设置状态 ──
let appearanceSettings = {
  frostedGlass: false,
  frostedBlur: 20,
  frostedOpacity: 85,
  backgroundImage: "",
  backgroundBlur: 0,
  backgroundOpacity: 100
};

function settingsFromForm() {
  const data = new FormData(elements.form);
  const network = networkSettingsFromForm();
  const provider = document.querySelector("#cloud-provider")?.value || "zhipu";
  const config = CLOUD_PROVIDERS[provider];
  return {
    connectionMode: data.get("connectionMode"),
    host: data.get("host"),
    port: data.get("port"),
    username: data.get("username"),
    password: data.get("password"),
    wakeName: data.get("wakeName"),
    // 本机模式引擎（v3.13.0）
    localEngine: data.get("localEngine") || "claude",
    atomcodeHost: document.querySelector("#atomcode-host")?.value || "",
    atomcodePort: Number(document.querySelector("#atomcode-port")?.value) || 0,
    atomcodeToken: document.querySelector("#atomcode-token")?.value || "",
    customCliCommand: document.querySelector("#custom-cli-command")?.value || "",
    clientLabel: data.get("clientLabel"),
    workingDirectory: data.get("workingDirectory"),
    dataDirectory: data.get("dataDirectory"),
    skipPermissions: data.get("skipPermissions") === "on",
    showSignalLights: data.get("showSignalLights") === "on",
    workModeId: currentModeId,
    networkType: document.querySelector("#network-type").value,
    externalMethod: document.querySelector("#external-method").value,
    cloudAiProvider: provider,
    cloudAiModel: document.querySelector("#cloud-model")?.value || "glm-4-flash",
    cloudAiBaseUrl: document.querySelector("#cloud-base-url")?.value || (config?.baseUrl || ""),
    cloudAiApiKey: document.querySelector("#cloud-api-key")?.value || "",
    clearCloudAiApiKey: !document.querySelector("#cloud-api-key")?.value && hasCloudApiKey,
    // 代理设置
    proxyEnabled: document.querySelector("#proxy-enabled")?.checked || false,
    proxyType: document.querySelector("#proxy-type")?.value || "http",
    proxyHost: document.querySelector("#proxy-host")?.value || "",
    proxyPort: Number(document.querySelector("#proxy-port")?.value) || 0,
    proxyUsername: document.querySelector("#proxy-username")?.value || "",
    proxyPassword: document.querySelector("#proxy-password")?.value || "",
    clearProxyPassword: !document.querySelector("#proxy-password")?.value && hasProxyPassword,
    // 上下文压缩（v3.10.0）
    compactAuto: document.querySelector("#compact-auto")?.checked || false,
    compactThreshold: Number(document.querySelector("#compact-threshold")?.value) || 80,
    compactInstruction: document.querySelector("#compact-instruction")?.value || "",
    ...network
  };
}

function populateSettings(settings) {
  for (const key of ["host", "port", "username", "wakeName", "clientLabel", "workingDirectory", "dataDirectory"]) {
    const input = elements.form.elements.namedItem(key);
    input.value = settings[key] ?? "";
  }
  elements.form.elements.namedItem("skipPermissions").checked = Boolean(settings.skipPermissions);
  elements.form.elements.namedItem("showSignalLights").checked = settings.showSignalLights !== false;
  document.body.classList.toggle("signal-lights-hidden", settings.showSignalLights === false);
  elements.form.elements.namedItem("connectionMode").value = settings.connectionMode || "ssh";
  currentConnectionMode = settings.connectionMode === "local" ? "local" : settings.connectionMode === "cloud" ? "cloud" : "ssh";
  elements.form.elements.namedItem("localEngine").value = settings.localEngine || "claude";
  currentLocalEngine = settings.localEngine || "claude";
  updateConnectionModeUI();
  setToolModeAppearance(Boolean(settings.skipPermissions));
  const password = elements.form.elements.namedItem("password");
  password.value = "";
  password.type = "password";
  document.querySelector("#toggle-password").textContent = "显示";
  document.querySelector("#password-hint").textContent = settings.hasPassword
    ? "已安全保存密码；留空不会修改"
    : "尚未保存密码";
  password.placeholder = settings.hasPassword
    ? "已安全保存；留空则不更改"
    : "请输入 SSH 密码";
  const controlSource = document.querySelector("#device-control-source");
  if (!controlSource.value) controlSource.value = settings.host || "";
  // 云端 AI 设置填充（扁平字段）
  const cloudApiKey = document.querySelector("#cloud-api-key");
  const cloudBaseURL = document.querySelector("#cloud-base-url");
  const cloudModel = document.querySelector("#cloud-model");
  const cloudProvider = document.querySelector("#cloud-provider");
  hasCloudApiKey = Boolean(settings.hasCloudAiConfig || settings.cloudAi?.hasApiKey);
  if (cloudApiKey) {
    cloudApiKey.value = "";
    cloudApiKey.type = "password";
    cloudApiKey.placeholder = hasCloudApiKey ? "已安全保存密钥；留空不会修改" : "在此粘贴你的 API 密钥";
    document.querySelector("#toggle-cloud-key").textContent = "显示";
  }
  // 从扁平字段回填
  const provider = settings.cloudAiProvider || "zhipu";
  const baseURL = settings.cloudAiBaseUrl || "";
  const model = settings.cloudAiModel || "glm-4-flash";
  if (cloudProvider) cloudProvider.value = provider;
  if (cloudBaseURL) cloudBaseURL.value = baseURL || (CLOUD_PROVIDERS[provider]?.baseUrl || "");
  if (cloudModel) cloudModel.value = model;
  if (cloudProvider) cloudProvider.dispatchEvent(new Event("change"));
  // 代理设置回填
  hasProxyPassword = Boolean(settings.hasProxyPassword);
  const proxyEnabled = document.querySelector("#proxy-enabled");
  const proxyType = document.querySelector("#proxy-type");
  const proxyHost = document.querySelector("#proxy-host");
  const proxyPort = document.querySelector("#proxy-port");
  const proxyUsername = document.querySelector("#proxy-username");
  const proxyPassword = document.querySelector("#proxy-password");
  if (proxyEnabled) proxyEnabled.checked = Boolean(settings.proxyEnabled);
  if (proxyType) proxyType.value = settings.proxyType === "socks5" ? "socks5" : "http";
  if (proxyHost) proxyHost.value = settings.proxyHost || "";
  if (proxyPort) proxyPort.value = settings.proxyPort || "";
  if (proxyUsername) proxyUsername.value = settings.proxyUsername || "";
  if (proxyPassword) {
    proxyPassword.value = "";
    proxyPassword.type = "password";
    proxyPassword.placeholder = hasProxyPassword ? "已安全保存；留空不会修改" : "留空则不认证";
  }
  // 代理开关联动
  updateProxyFieldsVisibility();
  // 上下文压缩回填（v3.10.0）
  const compactAuto = document.querySelector("#compact-auto");
  const compactThreshold = document.querySelector("#compact-threshold");
  const compactInstruction = document.querySelector("#compact-instruction");
  if (compactAuto) compactAuto.checked = Boolean(settings.compactAuto);
  if (compactThreshold) compactThreshold.value = settings.compactThreshold ?? 80;
  if (compactInstruction) compactInstruction.value = settings.compactInstruction || "";
  // 本机引擎回填（v3.13.0）
  const atomcodeHost = document.querySelector("#atomcode-host");
  const atomcodePort = document.querySelector("#atomcode-port");
  const atomcodeToken = document.querySelector("#atomcode-token");
  if (atomcodeHost) atomcodeHost.value = settings.atomcodeHost || "127.0.0.1";
  if (atomcodePort) atomcodePort.value = settings.atomcodePort ?? 13456;
  if (atomcodeToken) {
    atomcodeToken.value = "";
    atomcodeToken.placeholder = settings.hasAtomcodeToken ? "已安全保存 Token；留空不会修改" : "留空自动读取 ~/.atomcode/daemon-端口.json";
    document.querySelector("#toggle-atomcode-token").textContent = "显示";
  }
  const customCliCommand = document.querySelector("#custom-cli-command");
  if (customCliCommand) customCliCommand.value = settings.customCliCommand || "";
}

function updateConnectionModeUI() {
  const modeValue = elements.form.elements.namedItem("connectionMode").value;
  currentConnectionMode = modeValue === "local" ? "local" : modeValue === "cloud" ? "cloud" : "ssh";
  const isLocal = currentConnectionMode === "local";
  const isCloud = currentConnectionMode === "cloud";
  const localEngine = elements.form.elements.namedItem("localEngine")?.value || "claude";
  currentLocalEngine = isLocal ? localEngine : "claude";
  document.querySelector("#mode-ssh").classList.toggle("active", currentConnectionMode === "ssh");
  document.querySelector("#mode-cloud").classList.toggle("active", isCloud);
  document.querySelector("#mode-local").classList.toggle("active", isLocal);
  document.querySelector("#ssh-fields").hidden = isLocal || isCloud;
  document.querySelector("#cloud-fields").hidden = !isCloud;
  document.querySelector("#device-control-settings").hidden = isLocal || isCloud;
  document.querySelector("#bridge-settings").hidden = isLocal || isCloud;
  // 本机引擎子面板（v3.13.0）
  const localFields = document.querySelector("#local-fields");
  if (localFields) {
    localFields.hidden = !isLocal;
    localFields.querySelectorAll("[data-local-engine]").forEach((button) => button.classList.toggle("active", button.dataset.localEngine === localEngine));
  }
  const atomcodeFields = document.querySelector("#atomcode-fields");
  if (atomcodeFields) atomcodeFields.hidden = !isLocal || localEngine !== "atomcode";
  const customFields = document.querySelector("#custom-fields");
  if (customFields) customFields.hidden = !isLocal || localEngine !== "custom";
  const claudeEngine = !isLocal || localEngine === "claude";
  const wakeField = document.querySelector("#wake-name-field");
  if (wakeField) wakeField.hidden = !claudeEngine;
  elements.form.elements.namedItem("wakeName").required = claudeEngine;
  const skipPermissionsField = document.querySelector("#skip-permissions-field");
  if (skipPermissionsField) skipPermissionsField.hidden = !claudeEngine;
  const permissionHint = document.querySelector("#permission-hint");
  if (permissionHint) permissionHint.hidden = !claudeEngine;
  elements.form.elements.namedItem("host").required = currentConnectionMode === "ssh";
  elements.form.elements.namedItem("username").required = currentConnectionMode === "ssh";
  document.querySelector("#working-directory").placeholder = isLocal ? "留空则使用本机默认目录" : "留空则使用 SSH 账号的主目录";
  document.querySelector("#permission-label").textContent = `允许 Agent 在${isLocal ? "本机" : isCloud ? "云端" : " NAS"}自动执行工具操作`;
  document.querySelector("#permission-hint").textContent = `开启后会传入 Claude Code 的 bypass permissions 参数。仅在你信任${isLocal ? "这台电脑" : isCloud ? "云端服务" : "该 NAS"}与当前工作目录时使用。`;
  document.querySelector("#settings-description").textContent = isCloud
    ? "直接使用云端 AI API 聊天，无需安装任何 CLI。"
    : isLocal
    ? (localEngine === "atomcode"
      ? "使用本机 AtomCode（通过 atomcode-daemon 本机接口）。"
      : localEngine === "custom"
      ? "通过自定义命令接入本机终端 AI。"
      : "直接使用这台 Windows 电脑上的 Claude Code。")
    : "通过 SSH 使用 NAS 或服务器上的 Agent CLI（当前适配 Claude Code）。";
  document.querySelector("#connection-subtitle").textContent = isCloud
    ? "使用云端 AI API 聊天（无需本地 CLI）"
    : isLocal
    ? (localEngine === "atomcode" ? "使用本机 AtomCode" : localEngine === "custom" ? "使用本机自定义命令" : "使用本机 Windows 上的 Agent CLI")
    : "通过 SSH 使用 NAS 上的 Agent CLI";
  document.querySelector("#empty-description").textContent = isCloud
    ? "选择云端 AI 模式，输入消息即可开始聊天，无需任何本地安装。"
    : isLocal
    ? "输入消息后，客户端会调用本机 Agent 并保留聊天上下文。"
    : "输入消息后，客户端会连接 NAS 并保留本次聊天的上下文。";
  document.querySelector("#security-note").textContent = isCloud
    ? "云端模式仅传输文本消息，不执行任何本地或远程命令。API 密钥仅保存在本地。"
    : isLocal
    ? (localEngine === "atomcode"
      ? "本机模式通过本机 daemon 接口通信；Token 仅保存在这台电脑的加密存储中。"
      : "本机模式不保存 SSH 密码；Agent 登录信息由对应 CLI 自己管理。")
    : "密码仅保存在这台 Windows 电脑的系统加密存储中。";
}

function renderDeviceControlStatus(status) {
  const title = document.querySelector("#device-control-title");
  const detail = document.querySelector("#device-control-detail");
  const badge = document.querySelector("#device-control-badge");
  const info = document.querySelector("#device-control-info");
  const install = document.querySelector("#install-device-control");
  const uninstall = document.querySelector("#uninstall-device-control");
  const source = document.querySelector("#device-control-source");
  const target = document.querySelector("#device-control-target");
  const targetPort = document.querySelector("#device-control-port");
  const permission = document.querySelector("#device-control-permission");
  if (!status.supported) {
    title.textContent = "当前系统不支持";
    detail.textContent = status.reason || "仅支持 Windows 10/11";
    badge.textContent = "不可用";
    badge.classList.remove("installed");
    install.disabled = true;
    uninstall.hidden = true;
    return;
  }
  install.disabled = false;
  if (status.installed) {
    title.textContent = status.serviceRunning ? "联动控件已安装并运行" : "联动控件已安装，但 SSH 服务未运行";
    detail.textContent = `账号 ${status.account} · Windows ${status.windowsRelease}`;
    badge.textContent = status.serviceRunning ? "运行中" : "需修复";
    badge.classList.add("installed");
    source.value = status.sourceAddress || source.value;
    target.value = status.targetAddress || target.value;
    targetPort.value = status.targetPort || targetPort.value || 22;
    permission.value = status.permissionMode || "administrator";
    const addresses = (status.localAddresses || []).join("、") || "未识别";
    const warning = status.existingBroadFirewallWarning ? "；检测到安装前已有较宽的 OpenSSH 防火墙规则，请由管理员复核" : "";
    info.textContent = `本机地址：${addresses}；管理密钥保存在 NAS：${status.managementKeyPath || "已配置"}${warning}`;
    install.textContent = "更新联动配置";
    uninstall.hidden = false;
  } else {
    title.textContent = "未安装 Agent 联动控件";
    detail.textContent = "员工无需创建或提供 Windows 密码";
    badge.textContent = "未安装";
    badge.classList.remove("installed");
    info.textContent = "点击安装后，NAS 为本机生成独立密钥，Windows 弹出一次 UAC 授权；以后 Agent 使用公钥连接，不使用员工密码。";
    install.textContent = "安装联动控件";
    uninstall.hidden = true;
    if (!target.value && status.localAddresses?.length) {
      const prefix = source.value.match(/^(\d+\.\d+\.\d+)\./)?.[1];
      target.value = (prefix && status.localAddresses.find((address) => address.startsWith(prefix + "."))) || status.localAddresses[0];
    }
  }
}

async function refreshDeviceControlStatus() {
  try { renderDeviceControlStatus(await window.agentChatPro.getDeviceControlStatus()); }
  catch (error) { document.querySelector("#device-control-info").textContent = "状态检查失败：" + error.message; }
}

function renderBridgeStatus(status) {
  const title = document.querySelector("#bridge-title");
  const detail = document.querySelector("#bridge-detail");
  const badge = document.querySelector("#bridge-badge");
  const install = document.querySelector("#install-bridge");
  const uninstall = document.querySelector("#uninstall-bridge");
  title.textContent = status.ready ? "增强 Bridge 已就绪" : "基础直连聊天可用";
  detail.textContent = status.detail || "未检查";
  badge.textContent = status.ready ? "已就绪" : "可选";
  badge.classList.toggle("installed", Boolean(status.ready));
  install.textContent = status.ready ? "更新增强 Bridge" : "安装增强 Bridge";
  uninstall.hidden = !status.installed;
}

async function refreshBridgeStatus() {
  try { renderBridgeStatus(await window.agentChatPro.getBridgeStatus()); }
  catch (error) {
    document.querySelector("#bridge-title").textContent = "尚未连接目标 NAS";
    document.querySelector("#bridge-detail").textContent = error.message;
  }
}

function setToolModeAppearance(enabled) {
  automaticTools = enabled;
  // 更新输入栏模式触发按钮的图标和样式
  if (elements.composerModeTrigger) {
    elements.composerModeTrigger.textContent = enabled ? "⚡" : "🛡";
    elements.composerModeTrigger.title = enabled ? "自动化模式" : "常规模式（安全）";
    elements.composerModeTrigger.className = `composer-mode-trigger ${enabled ? "automatic" : "safe"}`;
  }
  refreshDeniedToolActions();
}

async function changeToolMode(enabled) {
  try {
    const settings = await window.agentChatPro.setToolMode(enabled);
    if (settings.cancelled) return false;
    setToolModeAppearance(settings.skipPermissions);
    elements.form.elements.namedItem("skipPermissions").checked = settings.skipPermissions;
    // 同步侧边栏模式选择器
    currentModeId = enabled ? "automatic" : "regular";
    const mode = await window.agentChatPro.getMode(currentModeId);
    if (mode) updateModeDisplay(mode);
    await refreshModeSelector();
    await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), workModeId: currentModeId }).then(populateSettings);
    setConnection(settings.skipPermissions ? `已允许 Claude 在${currentConnectionMode === "local" ? "本机" : " NAS"}自动执行工具` : "安全模式：需授权的工具会被拒绝", settings.skipPermissions ? "connected" : "");
    return true;
  } finally {
    elements.composerModeTrigger?.blur();
    requestAnimationFrame(() => focusPrompt(true));
    setTimeout(() => focusPrompt(true), 80);
  }
}

function setStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.classList.toggle("error", isError);
}

// ── Token 计数器更新 ──
function estimateTokens(text) {
  // 粗略估算：英文约 4 字符/token，中文约 1.5 字符/token，混合取约 2.5
  if (!text) return 0;
  let cjk = 0, latin = 0;
  for (const ch of text) {
    if (/[一-鿿㐀-䶿　-〿＀-￯]/.test(ch)) cjk++;
    else if (/\S/.test(ch)) latin++;
  }
  return Math.ceil(cjk / 1.5 + latin / 4 + 1);
}

function updateTokenDisplay() {
  const counter = document.querySelector("#token-counter");
  const countEl = document.querySelector("#token-count");
  if (!counter || !countEl) return;
  const total = conversationTokens + streamingTokens + confirmedTokens;
  countEl.textContent = total.toLocaleString();
  counter.hidden = total === 0 && !contextTokens && !contextLimit;
  counter.classList.toggle("streaming", Boolean(activeId));
  renderContextBar();
}

function addConversationTokens(count) {
  conversationTokens += count;
  updateTokenDisplay();
}

function resetStreamingTokens() {
  streamingTokens = 0;
  confirmedTokens = 0;
}

// ── 上下文进度条（v3.10.0）──
function formatCompactNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

function renderContextBar() {
  const row = document.querySelector("#context-bar-row");
  const track = document.querySelector("#context-bar-track");
  const fill = document.querySelector("#context-bar-fill");
  const percentEl = document.querySelector("#context-percent");
  const detailEl = document.querySelector("#context-detail");
  if (!row || !track || !fill || !percentEl || !detailEl) return;
  const total = conversationTokens + streamingTokens + confirmedTokens;
  // 无数据时整行隐藏（cloud 模式没有上下文压缩概念）
  if (!contextTokens && !contextLimit && total === 0) {
    row.hidden = true;
    track.hidden = true;
    return;
  }
  row.hidden = false;
  // 窗口未知时用累计 token 显示，进度条隐藏
  const limit = contextLimit || 0;
  track.hidden = !limit;
  if (limit) {
    const percent = Math.min(100, (contextTokens / limit) * 100);
    fill.style.width = `${percent.toFixed(1)}%`;
    fill.classList.toggle("warn", percent >= 70 && percent < 90);
    fill.classList.toggle("danger", percent >= 90);
    percentEl.textContent = `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
    percentEl.classList.toggle("warn", percent >= 70 && percent < 90);
    percentEl.classList.toggle("danger", percent >= 90);
  } else {
    fill.style.width = "0%";
    percentEl.textContent = "—";
    percentEl.classList.remove("warn", "danger");
  }
  const parts = [];
  if (contextTokens) parts.push(`上下文 ${formatCompactNumber(contextTokens)}${limit ? ` / ${formatCompactNumber(limit)}` : ""}`);
  if (!contextTokens && total) parts.push(`累计 ${formatCompactNumber(total)}`);
  detailEl.textContent = parts.join(" · ");
}

function resetContextBar() {
  contextTokens = 0;
  contextLimit = 0;
  compactingNow = false;
  renderContextBar();
}

function addMessage(kind, text = "") {
  elements.empty.hidden = true;
  const item = document.createElement("article");
  item.className = `message ${kind}`;
  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = text;
  item.append(content);
  // 右键菜单替代悬浮操作栏
  item.addEventListener("contextmenu", (event) => showMessageContextMenu(event, item, kind));
  elements.messages.append(item);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return item;
}

async function renderAssistant(item, text) {
  const content = item.querySelector(".message-content");
  content.innerHTML = await window.agentChatPro.renderMarkdown(text);
  content.classList.add("rendered");
  content.querySelectorAll("a[href]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.agentChatPro.openLink(link.getAttribute("href")).catch((error) => alert(error.message));
    });
  });
  content.querySelectorAll("pre").forEach((pre) => {
    const copy = document.createElement("button");
    copy.className = "copy-code";
    copy.type = "button";
    copy.textContent = "复制";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(pre.querySelector("code")?.textContent || pre.textContent);
      copy.textContent = "已复制";
      setTimeout(() => { copy.textContent = "复制"; }, 1200);
    });
    pre.append(copy);
  });
}

function renderTool(item, tool) {
  let list = item.querySelector(".tool-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "tool-list";
    item.prepend(list);
  }
  let card = [...list.children].find((child) => child.dataset.toolId === tool.id);
  if (!card) {
    card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.toolId = tool.id;
    list.append(card);
  }
  const labels = { running: "执行中", completed: "已完成", failed: "执行未成功", denied: "未获得权限" };
  const status = normalizedToolStatus(tool);
  card.className = `tool-card ${status}`;
  card.replaceChildren();
  const icon = document.createElement("span");
  icon.className = "tool-icon";
  icon.textContent = status === "completed" ? "✓" : ["failed", "denied"].includes(status) ? "!" : "⋯";
  const description = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = friendlyToolName(tool.name);
  const state = document.createElement("small");
  state.textContent = labels[status] || "处理中";
  description.append(title, state);
  const detail = toolDisplayDetail(tool);
  if (detail) {
    const detailBox = document.createElement("pre");
    detailBox.className = "tool-detail";
    detailBox.textContent = detail;
    detailBox.title = detail;
    description.append(detailBox);
  }
  card.append(icon, description);
  if (status === "denied") {
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = automaticTools ? "权限已开启，请重试" : "允许工具";
    action.addEventListener("click", async () => {
      if (automaticTools) {
        setConnection("自动执行权限已经开启，请重新发送刚才的要求", "connected");
        focusPrompt(true);
        return;
      }
      if (await changeToolMode(true)) {
        action.textContent = "权限已开启，请重试";
        setConnection("已允许自动执行工具，请重新发送刚才的要求", "connected");
      }
    });
    card.append(action);
  }
}

function normalizedToolStatus(tool) {
  if (tool?.status !== "denied") return tool?.status || "running";
  return tool.result === "未获得执行权限" ? "denied" : "failed";
}

function refreshDeniedToolActions() {
  document.querySelectorAll(".tool-card.denied button").forEach((button) => {
    button.textContent = automaticTools ? "权限已开启，请重试" : "允许工具";
  });
}

function finalizeToolList(item, tools) {
  const list = item.querySelector(".tool-list");
  if (!list || !tools.length) return;
  list.querySelector(".tool-summary")?.remove();
  const denied = tools.filter((tool) => normalizedToolStatus(tool) === "denied").length;
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = `tool-summary${denied ? " needs-permission" : ""}`;
  const label = () => denied ? `⚠ ${denied} 项操作需要权限` : `✓ 已执行 ${tools.length} 个操作`;
  summary.textContent = `${label()} · 查看详情`;
  summary.addEventListener("click", () => {
    const expanded = list.classList.toggle("expanded");
    summary.textContent = `${label()} · ${expanded ? "收起详情" : "查看详情"}`;
  });
  list.classList.add("finalized");
  list.prepend(summary);
}

function friendlyToolName(name) {
  return ({ Read: "读取文件", Write: "创建文件", Edit: "编辑文件", Bash: "运行命令", WebFetch: "读取网页", WebSearch: "搜索网页", Glob: "查找文件", Grep: "搜索内容" })[name] || `使用工具：${name || "未知"}`;
}

function toolDisplayDetail(tool) {
  const input = tool?.input || {};
  const value = ({
    Bash: input.command,
    Read: input.file_path,
    Write: input.file_path,
    Edit: input.file_path,
    NotebookEdit: input.notebook_path,
    WebFetch: input.url,
    WebSearch: input.query,
    Glob: [input.path, input.pattern].filter(Boolean).join("  →  "),
    Grep: [input.path, input.pattern].filter(Boolean).join("  →  ")
  })[tool?.name] || input.description || input.prompt || input.path || "";
  return String(value || "").trim();
}

function renderReturnedFiles(item, files = []) {
  item.querySelector(".returned-files")?.remove();
  if (!files.length) return;
  const list = document.createElement("div");
  list.className = "returned-files";
  files.forEach((file) => {
    const card = document.createElement("div");
    card.className = "returned-file";
    if (file.isImage) {
      const preview = document.createElement("img");
      preview.alt = file.name;
      preview.className = "remote-image loading";
      window.agentChatPro.previewRemoteFile(file).then((source) => {
        preview.src = source;
        preview.classList.remove("loading");
      }).catch(() => { preview.classList.add("failed"); preview.alt = "图片预览加载失败，可保存后查看"; });
      card.append(preview);
    }
    const details = document.createElement("div");
    details.className = "file-details";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const size = document.createElement("small");
    size.textContent = formatBytes(file.size);
    details.append(name, size);
    const actions = document.createElement("div");
    actions.className = "file-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "另存为";
    save.addEventListener("click", () => runFileAction(save, () => window.agentChatPro.saveRemoteFile(file)));
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "打开";
    open.addEventListener("click", () => runFileAction(open, () => window.agentChatPro.openRemoteFile(file)));
    actions.append(save, open);
    card.append(details, actions);
    list.append(card);
  });
  item.append(list);
}

function renderSentAttachments(item, files = [], names = []) {
  if (!files.length && !names.length) return;
  const list = document.createElement("div");
  list.className = "sent-files";
  if (files.length) {
    files.forEach((file) => {
      if (file.type.startsWith("image/")) {
        const image = document.createElement("img");
        image.alt = file.name;
        image.className = "sent-image";
        const source = URL.createObjectURL(file);
        image.src = source;
        image.addEventListener("load", () => URL.revokeObjectURL(source), { once: true });
        list.append(image);
      }
      const chip = document.createElement("span");
      chip.textContent = `📎 ${file.name}`;
      list.append(chip);
    });
  } else {
    names.forEach((name) => {
      const chip = document.createElement("span");
      chip.textContent = `📎 ${name}`;
      list.append(chip);
    });
  }
  item.append(list);
}

async function runFileAction(button, action) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中…";
  try { await action(); }
  catch (error) { alert(error.message); }
  finally { button.disabled = false; button.textContent = original; }
}

function formatBytes(size) {
  if (!Number.isFinite(size)) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshConversationList() {
  const query = elements.conversationSearch.value.trim();
  if (query) {
    // 全文搜索：搜索标题和消息内容
    const results = await window.agentChatPro.searchConversations(query);
    elements.historyCount.textContent = `${results.length} 条结果`;
    elements.conversationList.replaceChildren();
    results.forEach((conv) => {
      const row = document.createElement("div");
      row.className = "conversation-row" + (conv.id === conversationId ? " active" : "");
      const button = document.createElement("button");
      button.className = "conversation-item";
      button.textContent = conv.title;
      button.title = conv.title;
      button.addEventListener("click", () => loadConversation(conv.id));
      const menu = document.createElement("button");
      menu.className = "conversation-menu";
      menu.type = "button";
      menu.title = "对话操作";
      menu.textContent = "⋯";
      menu.addEventListener("click", (event) => showConversationMenu(event, conv));
      row.append(button, menu);
      if (conv.snippet) {
        const snippetEl = document.createElement("p");
        snippetEl.className = "conversation-snippet";
        snippetEl.textContent = conv.snippet;
        row.append(snippetEl);
      }
      elements.conversationList.append(row);
    });
    if (!results.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "没有匹配的对话";
      elements.conversationList.append(empty);
    }
  } else {
    conversationCache = await window.agentChatPro.listConversations();
    elements.historyCount.textContent = String(conversationCache.length);
    elements.conversationList.replaceChildren();
    conversationCache.forEach((conversation) => {
      const row = document.createElement("div");
      row.className = "conversation-row" + (conversation.id === conversationId ? " active" : "");
      const button = document.createElement("button");
      button.className = "conversation-item";
      button.textContent = conversation.title;
      button.title = conversation.title;
      button.addEventListener("click", () => loadConversation(conversation.id));
      const menu = document.createElement("button");
      menu.className = "conversation-menu";
      menu.type = "button";
      menu.title = "对话操作";
      menu.textContent = "⋯";
      menu.addEventListener("click", (event) => showConversationMenu(event, conversation));
      row.append(button, menu);
      elements.conversationList.append(row);
    });
    if (!conversationCache.length) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "还没有历史对话";
      elements.conversationList.append(empty);
    }
  }
}

function showConversationMenu(event, conversation) {
  document.querySelector(".conversation-popover")?.remove();
  const popover = document.createElement("div");
  popover.className = "conversation-popover";
  const rename = document.createElement("button");
  rename.textContent = "重命名";
  rename.addEventListener("click", async () => {
    const title = prompt("输入新的对话名称", conversation.title);
    if (title === null) return;
    try { await window.agentChatPro.renameConversation(conversation.id, title); await refreshConversationList(); }
    catch (error) { alert(error.message); }
  });
  const archive = document.createElement("button");
  archive.textContent = "打开存档";
  archive.addEventListener("click", async () => {
    try { await window.agentChatPro.showConversationArchive(conversation.id); popover.remove(); }
    catch (error) { alert(error.message); }
  });
  const remove = document.createElement("button");
  remove.className = "danger";
  remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    if (!confirm(`确定删除“${conversation.title}”吗？此操作只删除本机聊天记录，NAS 文件不会删除。`)) return;
    await window.agentChatPro.deleteConversation(conversation.id);
    popover.remove();
    if (conversation.id === conversationId) {
      const remaining = await window.agentChatPro.listConversations();
      if (remaining.length) await loadConversation(remaining[0].id);
      else await createNewConversation();
    } else await refreshConversationList();
  });
  popover.append(rename, archive, remove);
  event.currentTarget.closest(".conversation-row").append(popover);
  const close = (click) => {
    if (!popover.contains(click.target) && click.target !== event.currentTarget) {
      popover.remove();
      document.removeEventListener("click", close, true);
    }
  };
  setTimeout(() => document.addEventListener("click", close, true));
}

async function loadConversation(id) {
  if (activeId) return;
  const conversation = await window.agentChatPro.getConversation(id);
  if (!conversation) return;
  conversationId = conversation.id;
  sessionId = conversation.sessionId || "";
  attachments = [];
  resetContextBar(); // 切换对话时重置上下文进度条（新对话还没有 usage 数据）
  // 回填 main 侧记录的该对话上下文状态（v3.12.1：切回旧对话进度条不再归零）
  try {
    const known = await window.agentChatPro.getConversationContext?.(conversationId);
    if (known) {
      contextTokens = Number(known.tokens) || 0;
      contextLimit = Number(known.limit) || 0;
      renderContextBar();
    }
  } catch {}
  renderAttachments();
  elements.messages.replaceChildren();
  conversation.messages.forEach((message) => {
    const item = addMessage(message.role, message.text);
    if (message.role === "user") renderSentAttachments(item, [], message.attachmentNames || []);
    if (message.role === "assistant") {
      if (message.draft) {
        item.classList.add("interrupted");
        const note = document.createElement("div");
        note.className = "draft-note";
        note.textContent = "未完成的回复 · 已自动保存";
        item.prepend(note);
      }
      (message.tools || []).forEach((tool) => renderTool(item, tool));
      finalizeToolList(item, message.tools || []);
      renderReturnedFiles(item, message.files || []);
      renderAssistant(item, message.text);
    }
  });
  elements.empty.hidden = conversation.messages.length > 0;
  setConnection(sessionId ? `已恢复${currentConnectionMode === "cloud" ? "云端 AI" : currentConnectionMode === "local" ? `本机 ${localEngineLabel()}` : " SSH"} 会话` : "新对话，等待发送", "connected");
  // 从历史消息估算累计 token
  conversationTokens = 0;
  for (const msg of conversation.messages) {
    conversationTokens += estimateTokens(msg.text || "");
  }
  resetStreamingTokens();
  updateTokenDisplay();
  refreshConversationList();
}

async function createNewConversation() {
  if (activeId) return;
  const conversation = await window.agentChatPro.createConversation();
  await loadConversation(conversation.id);
  // 新对话重置 token 计数
  conversationTokens = 0;
  resetStreamingTokens();
  updateTokenDisplay();
  elements.prompt.focus();
}

function setConnection(text, state) {
  elements.stateText.textContent = text;
  elements.stateDot.className = state || "";
}

async function retryFromMessage(assistantItem) {
  if (activeId) return;
  // 从该助手消息往前找最近的用户消息
  const allMessages = Array.from(elements.messages.querySelectorAll(".message"));
  const idx = allMessages.indexOf(assistantItem);
  let userText = "";
  for (let i = idx - 1; i >= 0; i--) {
    if (allMessages[i].classList.contains("user")) {
      userText = allMessages[i].querySelector(".message-content").textContent;
      break;
    }
  }
  if (!userText) return;
  elements.prompt.value = userText;
  adjustTextarea();
  sendMessage();
}

function focusPrompt(force = false) {
  if (elements.dialog.open || elements.prompt.disabled || !document.hasFocus()) return;
  const active = document.activeElement;
  const hasNeutralFocus = !active || active === document.body || active === document.documentElement || active === elements.composer;
  if (force || hasNeutralFocus || active === elements.prompt) {
    elements.prompt.focus({ preventScroll: true });
  }
}

function setBusy(busy) {
  elements.send.disabled = false;
  elements.send.classList.toggle("busy", busy);
  elements.send.classList.remove("stopping");
  elements.send.title = busy ? "停止生成（Esc）" : "发送";
  elements.send.setAttribute("aria-label", busy ? "停止生成，或按 Escape" : "发送消息");
  elements.composer.classList.toggle("busy", busy);
  elements.composer.setAttribute("aria-busy", String(busy));
}

function stopActiveMessage() {
  if (!activeId) return;
  if (elements.send.classList.contains("stopping")) {
    // 第二次按 ESC：强制清除状态（防止 Promise 永不 settle 导致界面卡死）
    forceClearActiveState("用户再次按 ESC 强制停止");
    return;
  }
  elements.send.classList.add("stopping");
  elements.send.disabled = true;
  elements.send.title = "正在停止…";
  window.agentChatPro.cancelMessage(activeId);
  // 安全网：10 秒后如果 Promise 还没 settle，强制清除状态
  const stopId = activeId;
  setTimeout(() => {
    if (activeId === stopId) {
      forceClearActiveState("取消操作超时，强制停止");
    }
  }, 10000);
}

/**
 * 强制清除活跃状态 — 当 cancel Promise 永远不 settle 时的兜底
 */
function forceClearActiveState(reason) {
  if (!activeId) return;
  const answer = messages.get(activeId);
  if (answer) {
    answer.classList.remove("generating", "stopping");
    answer.classList.add("interrupted");
    const content = answer.querySelector(".message-content");
    if (content && !content.textContent.trim()) {
      content.textContent = "（已强制停止）";
    }
  }
  messages.delete(activeId);
  activeId = "";
  setBusy(false);
  elements.send.classList.remove("stopping");
  requestAnimationFrame(() => focusPrompt());
  setConnection(`已停止 · ${reason}`, "connected");
}

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  elements.attachmentList.hidden = attachments.length === 0;
  attachments.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const name = document.createElement("span");
    name.textContent = `📎 ${file.name}`;
    name.title = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "移除此附件";
    remove.textContent = "×";
    remove.addEventListener("click", () => { attachments.splice(index, 1); renderAttachments(); });
    chip.append(name, remove);
    elements.attachmentList.append(chip);
  });
}

function addFiles(files) {
  const permitted = [...files].filter((file) => {
    if (file.size > 30 * 1024 * 1024) { alert(`${file.name} 超过 30 MB，未添加。`); return false; }
    return true;
  });
  attachments = attachments.concat(permitted).slice(0, 10);
  renderAttachments();
  requestAnimationFrame(() => focusPrompt(true));
}

function adjustTextarea() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = Math.min(elements.prompt.scrollHeight, 180) + "px";
}

async function openSettings() {
  setStatus("");
  populateSettings(await window.agentChatPro.loadSettings());
  if (currentConnectionMode === "ssh") await refreshDeviceControlStatus();
  elements.dialog.showModal();
}

async function sendMessage() {
  const message = elements.prompt.value.trim();
  if ((!message && !attachments.length) || activeId) return;
  activeId = crypto.randomUUID();
  const userItem = addMessage("user", message);
  renderSentAttachments(userItem, attachments);
  const answer = addMessage("assistant generating");
  messages.set(activeId, answer);
  elements.prompt.value = "";
  adjustTextarea();
  setBusy(true);
  setConnection(currentConnectionMode === "cloud" ? "正在连接云端 AI…" : currentConnectionMode === "local" ? `正在启动本机 ${localEngineLabel()}…` : "正在连接 NAS…", "");
  // 重置流式 token 计数，估算用户消息 token
  resetStreamingTokens();
  addConversationTokens(estimateTokens(message));

  try {
    const preparedAttachments = await Promise.all(attachments.map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      data: await file.arrayBuffer()
    })));
    attachments = [];
    renderAttachments();
    // 客户端超时兜底：35 分钟（略大于 ssh.cjs 的 MAX_REQUEST_MS 30 分钟）
    const SEND_TIMEOUT_MS = 35 * 60 * 1000;
    const sendPromise = window.agentChatPro.sendMessage({
      id: activeId,
      message,
      sessionId,
      conversationId,
      attachments: preparedAttachments,
      workModeId: currentModeId
    });
    // 超时兜底赢走 race 后，IPC 才报错/返回时避免 unhandled rejection
    sendPromise.catch(() => {});
    let sendTimeoutTimer;
    const result = await Promise.race([
      sendPromise,
      new Promise((_, reject) => {
        sendTimeoutTimer = setTimeout(() => reject(new Error("请求超时（超过 35 分钟未响应，已停止等待）。")), SEND_TIMEOUT_MS);
      })
    ]).finally(() => clearTimeout(sendTimeoutTimer));
    if (result.cancelled) {
      answer.classList.remove("generating", "error");
      answer.classList.add("interrupted");
      const partial = result.text || answer.querySelector(".message-content").textContent;
      answer.querySelector(".message-content").textContent = partial
        ? `${partial}\n\n（已停止）`
        : "已停止。";
      // 停止时合并已产生的流式 token
      addConversationTokens(streamingTokens + confirmedTokens);
      resetStreamingTokens();
      setConnection(`${currentConnectionMode === "cloud" ? "云端 AI" : currentConnectionMode === "local" ? "本机 Agent" : "NAS"}已停止当前任务 · 连接正常`, "connected");
      return;
    }
    sessionId = result.sessionId || sessionId;
    const content = answer.querySelector(".message-content");
    if (!content.textContent && result.text) content.textContent = result.text;
    await renderAssistant(answer, result.text || content.textContent);
    (result.tools || []).forEach((tool) => renderTool(answer, tool));
    finalizeToolList(answer, result.tools || []);
    renderReturnedFiles(answer, result.files || []);
    answer.classList.remove("generating");
    // 合并流式 token 到对话累计
    addConversationTokens(streamingTokens + confirmedTokens);
    resetStreamingTokens();
    // 如果 result.stats 包含对话统计，更新 token 显示
    if (result.stats && result.stats.totalTokens) {
      conversationTokens = result.stats.totalTokens;
      updateTokenDisplay();
    }
    setConnection(`${currentConnectionMode === "cloud" ? "云端 AI" : currentConnectionMode === "local" ? `本机 ${localEngineLabel()}` : "NAS"}已连接 · 会话已保存`, "connected");
    refreshConversationList();
  } catch (error) {
    answer.classList.remove("generating");
    answer.classList.add("error");
    answer.querySelector(".message-content").textContent = "连接或 Claude 执行失败：\n" + error.message;
    setConnection("连接失败", "error");
    // 失败时也合并已估算的 token
    addConversationTokens(streamingTokens + confirmedTokens);
    resetStreamingTokens();
  } finally {
    messages.delete(activeId);
    activeId = "";
    setBusy(false);
    elements.send.classList.remove("stopping");
    requestAnimationFrame(() => focusPrompt());
  }
}

document.querySelector("#show-settings").addEventListener("click", openSettings);
document.querySelector("#header-appearance").addEventListener("click", openAppearanceDialog);
document.querySelector("#close-settings").addEventListener("click", () => elements.dialog.close());
document.querySelector("#close-appearance").addEventListener("click", () => document.querySelector("#appearance-dialog").close());

// ── 设置中心导航（v3.12.2：连接设置 / 插件 / 关于）──
function switchSettingsTab(tab) {
  document.querySelectorAll("[data-settings-tab]").forEach((item) => item.classList.toggle("active", item.dataset.settingsTab === tab));
  // hidden 与 .active 同步切换（v3.12.4 修复：两套 CSS 显示模型——
  // [hidden]{display:none!important} 与 .settings-panel.active{display:block}——都必须正确，
  // 否则面板 hidden 移除后因缺少 .active 仍被 .settings-panel{display:none} 隐藏 → 空白页）
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    const active = panel.dataset.settingsPanel === tab;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}
document.querySelectorAll("[data-settings-tab]").forEach((item) => {
  item.addEventListener("click", () => switchSettingsTab(item.dataset.settingsTab));
});
async function fillAboutVersion() {
  try { document.querySelector("#about-version").textContent = await window.agentChatPro.getAppVersion(); }
  catch { /* 版本通道不可用时保持占位符 */ }
}
fillAboutVersion();

elements.dialog.addEventListener("close", async () => {
  try { populateSettings(await window.agentChatPro.loadSettings()); }
  catch (error) { setConnection("重新读取设置失败：" + error.message, "error"); }
});
document.querySelector("#new-chat").addEventListener("click", createNewConversation);
elements.conversationSearch.addEventListener("input", refreshConversationList);
elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const saveButton = document.querySelector("#save-settings");
  const originalText = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = "正在保存和迁移…";
  try {
    const formData = settingsFromForm();
    const settings = await window.agentChatPro.saveSettings(formData);
    populateSettings(settings);
    await refreshConversationList();
    if (conversationId && conversationCache.some((item) => item.id === conversationId)) await loadConversation(conversationId);
    else if (conversationCache.length) await loadConversation(conversationCache[0].id);
    else await createNewConversation();
    elements.dialog.close();
    setConnection("设置已保存", "connected");
    // 外网模式下保存设置后触发网络连接
    if (formData.networkType === "external") {
      try {
        await window.agentChatPro.networkConnect(formData);
        setConnection("外网连接已建立", "connected");
      } catch (error) {
        setConnection("外网连接失败：" + error.message, "error");
      }
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalText;
  }
});
document.querySelector("#test-connection").addEventListener("click", async () => {
  const mode = elements.form.elements.namedItem("connectionMode").value;
  const engine = mode === "local" ? (elements.form.elements.namedItem("localEngine")?.value || "claude") : "claude";
  const engineLabel = engine === "atomcode" ? "AtomCode daemon" : engine === "custom" ? "自定义命令" : "Claude CLI";
  const modeLabel = mode === "cloud" ? "云端 AI" : mode === "local" ? `本机 ${engineLabel}` : "SSH";
  setStatus(mode === "cloud" ? "正在测试云端 AI 连接…" : mode === "local" ? `正在检查本机 ${engineLabel}…` : "正在连接并检查 Claude 命令…");
  try {
    const version = await window.agentChatPro.testConnection(settingsFromForm());
    setStatus(`${modeLabel}连接成功${mode === "cloud" || engine !== "claude" ? `：${version}` : "：Claude Code " + version}`);
  } catch (error) {
    setStatus(error.message, true);
  }
});
document.querySelector("#open-diagnostics").addEventListener("click", async () => {
  const path = await window.agentChatPro.openDiagnostics();
  setStatus(`已打开日志位置：${path}`);
});
document.querySelector("#refresh-device-control").addEventListener("click", refreshDeviceControlStatus);
document.querySelector("#refresh-bridge").addEventListener("click", refreshBridgeStatus);
document.querySelector("#install-bridge").addEventListener("click", async () => {
  const button = document.querySelector("#install-bridge");
  button.disabled = true;
  setStatus("正在部署增强 Bridge 并安装其依赖…");
  try {
    const result = await window.agentChatPro.installBridge();
    if (result.cancelled) setStatus("已取消部署。基础直连聊天不受影响。");
    else { renderBridgeStatus(result); setStatus("增强 Bridge 已安装并校验完成。"); }
  } catch (error) { setStatus(error.message, true); await refreshBridgeStatus(); }
  finally { button.disabled = false; }
});
document.querySelector("#uninstall-bridge").addEventListener("click", async () => {
  const button = document.querySelector("#uninstall-bridge");
  button.disabled = true;
  setStatus("正在移除增强 Bridge…");
  try {
    const result = await window.agentChatPro.uninstallBridge();
    if (result.cancelled) setStatus("已取消移除。");
    else { renderBridgeStatus(result); setStatus("增强 Bridge 已移除；基础直连聊天仍可使用。"); }
  } catch (error) { setStatus(error.message, true); await refreshBridgeStatus(); }
  finally { button.disabled = false; }
});
document.querySelector("#install-device-control").addEventListener("click", async () => {
  const button = document.querySelector("#install-device-control");
  button.disabled = true;
  setStatus("正在准备联动密钥。确认 Windows 管理员授权后，安装会在后台继续，通常需要几十秒；请留在软件窗口等待结果。");
  try {
    const settings = await window.agentChatPro.saveSettings(settingsFromForm());
    populateSettings(settings);
    const status = await window.agentChatPro.installDeviceControl({
      sourceAddress: document.querySelector("#device-control-source").value,
      targetAddress: document.querySelector("#device-control-target").value,
      targetPort: document.querySelector("#device-control-port").value,
      permissionMode: document.querySelector("#device-control-permission").value
    });
    if (status.cancelled) setStatus("已取消安装，电脑没有被启用远程控制。", true);
    else {
      renderDeviceControlStatus(status);
      setStatus(status.probe?.ok
        ? "联动控件已安装，NAS 已使用专属密钥回连成功；员工不需要设置 Windows 密码。"
        : `联动控件已安装，但 NAS 回连测试失败：${status.probe?.error || "未知原因"}`, !status.probe?.ok);
    }
  } catch (error) {
    setStatus(error.message, true);
    await refreshDeviceControlStatus();
  } finally { button.disabled = false; }
});
document.querySelector("#uninstall-device-control").addEventListener("click", async () => {
  const button = document.querySelector("#uninstall-device-control");
  button.disabled = true;
  setStatus("正在卸载联动控件…");
  try {
    const status = await window.agentChatPro.uninstallDeviceControl();
    if (status.cancelled) setStatus("已取消卸载。", true);
    else {
      renderDeviceControlStatus(status);
      setStatus("联动控件已卸载，Agent 已不能再通过该密钥连接本机。");
    }
  } catch (error) {
    setStatus(error.message, true);
    await refreshDeviceControlStatus();
  } finally { button.disabled = false; }
});
const passwordInput = elements.form.elements.namedItem("password");
document.querySelectorAll("[data-connection-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.form.elements.namedItem("connectionMode").value = button.dataset.connectionMode;
    updateConnectionModeUI();
  });
});
// ── 本机引擎选择（v3.13.0） ──
document.querySelectorAll("[data-local-engine]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.form.elements.namedItem("localEngine").value = button.dataset.localEngine;
    updateConnectionModeUI();
  });
});
document.querySelector("#toggle-atomcode-token")?.addEventListener("click", () => {
  const input = document.querySelector("#atomcode-token");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  document.querySelector("#toggle-atomcode-token").textContent = showing ? "显示" : "隐藏";
});

// ── 云端 AI 设置事件（通用适配器） ──
const CLOUD_PROVIDERS = {
  zhipu: {
    name: "智谱 AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    models: [
      { value: "glm-4-flash", label: "GLM-4-Flash（永久免费）" },
      { value: "glm-4.7-flash", label: "GLM-4.7-Flash（免费）" },
      { value: "glm-4-plus", label: "GLM-4-Plus（付费，更强）" },
      { value: "glm-4-long", label: "GLM-4-Long（付费，超长文本）" }
    ],
    registerUrl: "https://open.bigmodel.cn/user/apikey",
    hint: '还没有密钥？<a href="https://open.bigmodel.cn/user/apikey" id="cloud-register-link">点击免费注册智谱 AI</a>，注册后在 API Keys 页面创建密钥。'
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1/",
    models: [
      { value: "deepseek-chat", label: "DeepSeek-V3（对话）" },
      { value: "deepseek-reasoner", label: "DeepSeek-R1（推理）" }
    ],
    registerUrl: "https://platform.deepseek.com/api_keys",
    hint: '还没有密钥？<a href="https://platform.deepseek.com/" id="cloud-register-link">点击注册 DeepSeek</a>。'
  },
  kimi: {
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1/",
    models: [
      { value: "moonshot-v1-8k", label: "Moonshot V1 8K" },
      { value: "moonshot-v1-32k", label: "Moonshot V1 32K" },
      { value: "moonshot-v1-128k", label: "Moonshot V1 128K" }
    ],
    registerUrl: "https://platform.moonshot.cn/console/api-keys",
    hint: '还没有密钥？<a href="https://platform.moonshot.cn/" id="cloud-register-link">点击注册 Kimi</a>。'
  },
  doubao: {
    name: "豆包（字节跳动）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3/",
    models: [
      { value: "doubao-pro-4k", label: "Doubao Pro 4K" },
      { value: "doubao-pro-32k", label: "Doubao Pro 32K" },
      { value: "doubao-pro-128k", label: "Doubao Pro 128K" },
      { value: "doubao-lite-4k", label: "Doubao Lite 4K（免费额度）" }
    ],
    registerUrl: "https://console.volcengine.com/ark",
    hint: '还没有密钥？<a href="https://console.volcengine.com/ark" id="cloud-register-link">点击注册豆包</a>，在火山引擎控制台创建 API Key。'
  },
  openai: {
    name: "OpenAI（ChatGPT）",
    baseUrl: "https://api.openai.com/v1/",
    models: [
      { value: "gpt-4o", label: "GPT-4o" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini" },
      { value: "o3-mini", label: "o3-mini" },
      { value: "gpt-4.1", label: "GPT-4.1" },
      { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" }
    ],
    registerUrl: "https://platform.openai.com/api-keys",
    hint: '需要 OpenAI API Key。<a href="https://platform.openai.com/api-keys" id="cloud-register-link">点击管理密钥</a>。'
  },
  gemini: {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    models: [
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" }
    ],
    registerUrl: "https://aistudio.google.com/apikey",
    hint: '需要 Google AI API Key。<a href="https://aistudio.google.com/apikey" id="cloud-register-link">点击获取密钥</a>。'
  },
  anthropic: {
    name: "Anthropic（Claude）",
    baseUrl: "https://api.anthropic.com/v1/",
    models: [
      { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { value: "claude-3.7-sonnet-20250219", label: "Claude 3.7 Sonnet" },
      { value: "claude-3.5-haiku-20241022", label: "Claude 3.5 Haiku" }
    ],
    registerUrl: "https://console.anthropic.com/settings/keys",
    hint: '需要 Anthropic API Key。<a href="https://console.anthropic.com/settings/keys" id="cloud-register-link">点击管理密钥</a>。'
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1/",
    models: [
      { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B（极速）" },
      { value: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
      { value: "gemma2-9b-it", label: "Gemma 2 9B" }
    ],
    registerUrl: "https://console.groq.com/keys",
    hint: '还没有密钥？<a href="https://console.groq.com/keys" id="cloud-register-link">点击注册 Groq</a>，极速推理，免费额度。'
  },
  siliconflow: {
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1/",
    models: [
      { value: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3" },
      { value: "Qwen/Qwen3-8B", label: "Qwen3 8B（免费）" },
      { value: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen2.5 72B" },
      { value: "meta-llama/Meta-Llama-3.1-8B-Instruct", label: "Llama 3.1 8B" }
    ],
    registerUrl: "https://cloud.siliconflow.cn/",
    hint: '还没有密钥？<a href="https://cloud.siliconflow.cn/" id="cloud-register-link">点击免费注册硅基流动</a>。'
  },
  custom: {
    name: "自定义",
    baseUrl: "",
    models: [{ value: "custom", label: "自定义模型（请在下方填写）" }],
    registerUrl: "",
    hint: '填写任意 OpenAI 兼容的 API 地址和密钥。支持 one-api、new-api 等中转站。'
  }
};

document.querySelector("#cloud-provider")?.addEventListener("change", () => {
  const provider = document.querySelector("#cloud-provider").value;
  const modelSelect = document.querySelector("#cloud-model");
  const customFields = document.querySelector("#cloud-custom-fields");
  const keyHint = document.querySelector("#cloud-key-hint");
  const providerHint = document.querySelector("#cloud-provider-hint");
  const config = CLOUD_PROVIDERS[provider];
  if (!config) return;
  // 更新模型下拉
  modelSelect.innerHTML = config.models.map((m) => `<option value="${m.value}">${m.label}</option>`).join("");
  // 更新服务商提示
  if (providerHint) providerHint.textContent = config.name === "智谱 AI" ? "智谱 AI 的 GLM-4-Flash 模型永久免费，适合日常对话。" : `${config.name} — 在下方输入 API 密钥后即可使用。`;
  // 显示/隐藏自定义字段
  customFields.hidden = provider !== "custom";
  if (config.baseUrl) document.querySelector("#cloud-base-url").value = config.baseUrl;
  else document.querySelector("#cloud-base-url").value = "";
  // 更新密钥提示
  if (keyHint) keyHint.innerHTML = config.hint;
});

document.querySelector("#toggle-cloud-key")?.addEventListener("click", () => {
  const input = document.querySelector("#cloud-api-key");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  document.querySelector("#toggle-cloud-key").textContent = visible ? "显示" : "隐藏";
  input.focus();
});

// ── 代理设置交互 ──
function updateProxyFieldsVisibility() {
  const enabled = document.querySelector("#proxy-enabled")?.checked || false;
  const fields = document.querySelector("#proxy-fields");
  if (fields) fields.hidden = !enabled;
}
document.querySelector("#proxy-enabled")?.addEventListener("change", updateProxyFieldsVisibility);
document.querySelector("#toggle-proxy-password")?.addEventListener("click", () => {
  const input = document.querySelector("#proxy-password");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  document.querySelector("#toggle-proxy-password").textContent = visible ? "显示" : "隐藏";
  input.focus();
});
// ── 代理连通性测试 ──
document.querySelector("#proxy-test")?.addEventListener("click", async () => {
  const button = document.querySelector("#proxy-test");
  const resultEl = document.querySelector("#proxy-test-result");
  if (!button || !resultEl || button.disabled) return;
  button.disabled = true;
  button.textContent = "测试中…";
  resultEl.hidden = false;
  resultEl.classList.remove("ok", "fail");
  resultEl.textContent = "正在通过代理发起测试请求…";
  try {
    const result = await window.agentChatPro.testProxy({
      enabled: document.querySelector("#proxy-enabled")?.checked || false,
      type: document.querySelector("#proxy-type")?.value || "http",
      host: document.querySelector("#proxy-host")?.value || "",
      port: Number(document.querySelector("#proxy-port")?.value) || 0,
      username: document.querySelector("#proxy-username")?.value || "",
      password: document.querySelector("#proxy-password")?.value || "", // 留空时主进程用已保存密码兜底
    });
    if (result?.ok) {
      resultEl.textContent = `✅ ${result.message} · ${result.latencyMs}ms`;
      resultEl.classList.add("ok");
    } else {
      resultEl.textContent = `❌ ${result?.error || "测试失败"}`;
      resultEl.classList.add("fail");
    }
  } catch (error) {
    resultEl.hidden = false;
    resultEl.textContent = `❌ 测试失败：${error?.message || error}`;
    resultEl.classList.add("fail");
  } finally {
    button.disabled = false;
    button.textContent = "测试代理连接";
  }
});

// ── 上下文压缩按钮（v3.10.0）──
document.querySelector("#context-compact")?.addEventListener("click", async () => {
  const button = document.querySelector("#context-compact");
  if (!button || button.disabled) return;
  if (!sessionId) {
    setConnection("当前对话还没有会话记录（先发一条消息），无法压缩。", "error");
    return;
  }
  button.disabled = true;
  button.classList.add("compacting");
  button.textContent = "✂ 压缩中…";
  try {
    const result = await window.agentChatPro.compactContext({ sessionId, conversationId, instruction: "" });
    if (result?.ok) {
      const post = result.event?.postTokens ? `，当前 ${formatCompactNumber(result.event.postTokens)} tokens` : "";
      setConnection(`上下文压缩完成${post} · 会话已保留`, "connected");
    } else {
      setConnection(`上下文压缩未完成${result?.error ? `：${result.error}` : ""}，请稍后重试。`, "error");
    }
  } catch (error) {
    setConnection(`上下文压缩失败：${error?.message || error}`, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("compacting");
    button.textContent = "✂ 压缩";
  }
});

// ── 系统缓存清理（v3.10.0，仅 Windows 有效）──
const CACHE_RISK_LABELS = { safe: "安全", advanced: "进阶", admin: "管理员" };

function formatCacheSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`;
  return `${n} B`;
}

function renderCacheTargets(targets) {
  const list = document.querySelector("#cache-target-list");
  const cleanRow = document.querySelector("#cache-clean-row");
  if (!list || !cleanRow) return;
  list.replaceChildren();
  let hasAvailable = false;
  for (const target of targets || []) {
    const item = document.createElement("div");
    item.className = "cache-target-item";
    const main = document.createElement("div");
    main.className = "cache-target-main";
    const name = document.createElement("div");
    name.className = "cache-target-name";
    name.textContent = target.name || target.id;
    const desc = document.createElement("div");
    desc.className = "cache-target-desc";
    desc.textContent = `${target.description || ""}${target.location && target.location !== "（内存缓存）" ? `（${target.location}）` : ""}`;
    main.append(name, desc);
    const risk = document.createElement("span");
    risk.className = `cache-risk-badge ${target.risk || "safe"}`;
    risk.textContent = CACHE_RISK_LABELS[target.risk] || target.risk;
    const size = document.createElement("span");
    size.className = "cache-target-size";
    size.textContent = target.available === false ? "不可用" : `${formatCacheSize(target.size)} · ${target.fileCount || 0} 项`;
    if (target.available === false) size.classList.add("pending");
    item.append(risk, main, size);
    if (target.available !== false) {
      hasAvailable = true;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = target.risk === "safe"; // 安全级默认勾选
      checkbox.dataset.targetId = target.id;
      item.prepend(checkbox);
    }
    list.append(item);
  }
  list.hidden = !(targets || []).length;
  cleanRow.hidden = !hasAvailable;
}

document.querySelector("#cache-scan")?.addEventListener("click", async () => {
  const button = document.querySelector("#cache-scan");
  const resultEl = document.querySelector("#cache-scan-result");
  if (!button || button.disabled) return;
  button.disabled = true;
  button.textContent = "扫描中…";
  if (resultEl) { resultEl.hidden = false; resultEl.textContent = "正在扫描缓存目录…"; }
  try {
    const result = await window.agentChatPro.scanSystemCaches();
    if (!result?.supported) {
      if (resultEl) resultEl.textContent = `当前系统（${result?.platform || "未知"}）不支持缓存清理，此功能仅限 Windows。`;
      renderCacheTargets([]);
      return;
    }
    const total = (result.targets || []).reduce((sum, t) => sum + (t.size || 0), 0);
    if (resultEl) resultEl.textContent = `扫描完成：${result.targets.length} 项，共 ${formatCacheSize(total)}`;
    renderCacheTargets(result.targets);
  } catch (error) {
    if (resultEl) { resultEl.hidden = false; resultEl.textContent = `扫描失败：${error?.message || error}`; }
  } finally {
    button.disabled = false;
    button.textContent = "扫描缓存";
  }
});

document.querySelector("#cache-clean")?.addEventListener("click", async () => {
  const button = document.querySelector("#cache-clean");
  const resultEl = document.querySelector("#cache-clean-result");
  if (!button || button.disabled) return;
  const checked = [...document.querySelectorAll("#cache-target-list input[type=checkbox]:checked")].map((el) => el.dataset.targetId);
  if (!checked.length) {
    if (resultEl) { resultEl.hidden = false; resultEl.className = "field-hint fail"; resultEl.textContent = "请先勾选要清理的缓存项。"; }
    return;
  }
  button.disabled = true;
  button.textContent = "清理中…";
  if (resultEl) { resultEl.hidden = false; resultEl.className = "field-hint"; resultEl.textContent = "正在清理…（管理员权限项会弹出 UAC 窗口）"; }
  try {
    const result = await window.agentChatPro.cleanSystemCaches(checked);
    const results = result?.results || [];
    const okList = results.filter((r) => r.ok);
    const failList = results.filter((r) => !r.ok);
    const freed = results.reduce((sum, r) => sum + (r.freed || 0), 0);
    const hasUnknown = results.some((r) => r.freedUnknown);
    const text = [
      `完成 ${okList.length}/${results.length}`,
      freed ? `释放 ${formatCacheSize(freed)}` : hasUnknown ? "部分项无法统计大小" : "",
      ...failList.map((r) => `${r.name}：${r.message}`)
    ].filter(Boolean).join(" · ");
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.className = `field-hint ${failList.length ? "fail" : "ok"}`;
      resultEl.textContent = text;
    }
  } catch (error) {
    if (resultEl) { resultEl.hidden = false; resultEl.className = "field-hint fail"; resultEl.textContent = `清理失败：${error?.message || error}`; }
  } finally {
    button.disabled = false;
    button.textContent = "清理勾选项";
  }
});
passwordInput.addEventListener("input", () => {
  document.querySelector("#password-hint").textContent = passwordInput.value
    ? `本次输入 ${[...passwordInput.value].length} 个字符，请确认没有重复`
    : "留空则保留已保存的密码";
});
document.querySelector("#toggle-password").addEventListener("click", () => {
  const visible = passwordInput.type === "text";
  passwordInput.type = visible ? "password" : "text";
  document.querySelector("#toggle-password").textContent = visible ? "显示" : "隐藏";
  passwordInput.focus();
});
document.querySelector("#choose-directory").addEventListener("click", async () => {
  const selected = await window.agentChatPro.chooseStorageDirectory();
  if (selected) elements.form.elements.namedItem("dataDirectory").value = selected;
});
document.querySelector("#open-directory").addEventListener("click", async () => {
  try {
    await window.agentChatPro.openStorageDirectory(elements.form.elements.namedItem("dataDirectory").value);
  } catch (error) {
    setStatus(error.message, true);
  }
});
document.querySelector("#open-archive").addEventListener("click", async () => {
  try {
    const path = await window.agentChatPro.openArchiveDirectory();
    setStatus(`已打开会话存档：${path}`);
  } catch (error) {
    setStatus(error.message, true);
  }
});
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (activeId) stopActiveMessage();
  else sendMessage();
});
elements.composer.addEventListener("click", (event) => {
  if (event.target === elements.composer) focusPrompt(true);
});
elements.prompt.addEventListener("input", adjustTextarea);
document.querySelector("#attach").addEventListener("click", () => elements.filePicker.click());
// ── 输入栏模式弹出菜单 ──────────────────────────────────

let composerModePopupOpen = false;

function closeComposerModePopup() {
  composerModePopupOpen = false;
  if (elements.composerModePopup) elements.composerModePopup.hidden = true;
}

async function refreshComposerModePopup() {
  try {
    const modes = await window.agentChatPro.listModes();
    const list = elements.composerModeList;
    if (!list) return;
    list.replaceChildren();
    for (const mode of modes) {
      const item = document.createElement("div");
      item.className = `composer-mode-item${mode.id === currentModeId ? " active" : ""}`;
      item.innerHTML = `<span class="composer-mode-item-icon">${mode.icon}</span><div class="composer-mode-item-info"><span class="composer-mode-item-name">${mode.name}</span><span class="composer-mode-item-desc">${mode.description}</span></div>`;
      item.addEventListener("click", async () => {
        currentModeId = mode.id;
        updateModeDisplay(mode);
        // 同步侧边栏模式选择器
        await refreshModeSelector();
        // 保存到设置
        try {
          const settings = await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), workModeId: mode.id });
          populateSettings(settings);
        } catch (error) { setConnection("模式切换失败：" + error.message, "error"); }
        closeComposerModePopup();
      });
      list.append(item);
    }
  } catch (error) { console.error("Failed to load modes for composer popup:", error); }
}

if (elements.composerModeTrigger) {
  elements.composerModeTrigger.addEventListener("click", async (event) => {
    event.stopPropagation();
    composerModePopupOpen = !composerModePopupOpen;
    if (composerModePopupOpen) {
      await refreshComposerModePopup();
    }
    if (elements.composerModePopup) elements.composerModePopup.hidden = !composerModePopupOpen;
  });
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".composer-mode-selector")) closeComposerModePopup();
});
elements.filePicker.addEventListener("change", () => { addFiles(elements.filePicker.files); elements.filePicker.value = ""; });
elements.composer.addEventListener("dragover", (event) => event.preventDefault());
elements.composer.addEventListener("drop", (event) => { event.preventDefault(); addFiles(event.dataTransfer.files); });
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !activeId) { event.preventDefault(); sendMessage(); }
});
window.addEventListener("focus", () => requestAnimationFrame(() => focusPrompt()));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestAnimationFrame(() => focusPrompt());
});
window.agentChatPro.onDelta(({ id, text }) => {
  const answer = messages.get(id);
  if (!answer) return;
  answer.querySelector(".message-content").textContent += text;
  elements.messages.scrollTop = elements.messages.scrollHeight;
  // 实时估算流式 token
  streamingTokens += estimateTokens(text);
  updateTokenDisplay();
});
window.agentChatPro.onChatEvent((event) => {
  const answer = messages.get(event.id);
  if (event.type === "upload") {
    setConnection(`正在上传 ${event.name} · ${Math.round(event.overall * 100)}%`, "");
  } else if (event.type === "connection") {
    const labels = currentConnectionMode === "local"
      ? (currentLocalEngine === "atomcode"
        ? { "local-starting": "正在启动 AtomCode daemon…", connected: "AtomCode 正在处理…" }
        : currentLocalEngine === "custom"
        ? { "local-starting": "正在启动本机命令…", connected: "本机命令正在处理…" }
        : { "local-starting": "正在启动本机 Claude…", connected: "本机 Claude 正在处理…" })
      : currentConnectionMode === "cloud"
      ? { connecting: "正在连接云端 AI…", connected: "云端 AI 正在处理…", stopping: "正在停止…" }
      : { connecting: "正在连接 NAS…", reconnecting: "连接中断，正在自动重连…", connected: "已连接，Claude 正在处理…", stopping: "Claude 已收到停止请求，正在结束当前操作…", stopped: "连接已被强制关闭，正在结束当前请求…" };
    setConnection(labels[event.status] || "正在处理…", event.status === "connected" ? "connected" : "");
  } else if (event.type === "tool" && answer) {
    renderTool(answer, event.tool);
    elements.messages.scrollTop = elements.messages.scrollHeight;
  } else if (event.type === "usage") {
    // 处理 usage 事件：用实际 token 数据替换估算值
    if (event.usage) {
      const usage = event.usage;
      // 三种字段风格兼容（v3.12.1 修复：SSH/local 模式 protocol 已归一为驼峰，
      // 旧代码只读下划线 → 确认值恒 0；OpenAI 风格为 prompt_tokens/completion_tokens）
      const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
      const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
      if (inputTokens || outputTokens) {
        // 把之前估算的流式 token 清零，用实际数据
        streamingTokens = 0;
        // ⚠️ 累计口径只记本轮真实输出：usage.input 是本轮请求的总输入（含全部历史上下文），
        //    全量累加会随轮数平方级膨胀；输入部分已由用户消息按估算入账
        confirmedTokens = outputTokens;
        updateTokenDisplay();
      }
    }
  }
});

// 桥被强制关闭（SSH 断开 / runner 进程被杀）：状态条降级为错误态并清除等待 UI
window.agentChatPro.onBridgeForceClosed?.((detail) => {
  setConnection(`连接已被强制关闭${detail?.reason === "runner-stopped" ? "（Agent 已停止）" : ""}。`, "error");
  if (activeId) forceClearActiveState("连接已被强制关闭");
});

// ── 上下文进度条事件（v3.10.0）：model / usage / compact 三类 ──
window.agentChatPro.onContextEvent?.((event) => {
  if (!event) return;
  if (event.type === "model") {
    contextLimit = Number(event.contextLimit) || 0;
    renderContextBar();
  } else if (event.type === "usage") {
    if (event.contextTokens) contextTokens = Number(event.contextTokens);
    renderContextBar();
  } else if (event.type === "compact") {
    handleCompactEvent(event);
  } else if (event.type === "compact-runner") {
    // 压缩执行器状态（connecting/connected/finished）：仅提示
    if (event.status === "connected") setConnection("正在压缩上下文…", "");
  }
});

function handleCompactEvent(event) {
  const button = document.querySelector("#context-compact");
  if (event.phase === "started") {
    compactingNow = true;
    if (button) {
      button.disabled = true;
      button.classList.add("compacting");
      button.textContent = "✂ 压缩中…";
    }
    setConnection("正在压缩上下文（发送 /compact）…", "");
  } else if (event.phase === "boundary") {
    // 压缩边界：用 postTokens 覆盖上下文占用
    if (Number(event.postTokens) > 0) contextTokens = Number(event.postTokens);
    renderContextBar();
  } else if (event.phase === "finished") {
    compactingNow = false;
    if (button) {
      button.disabled = false;
      button.classList.remove("compacting");
      button.textContent = "✂ 压缩";
    }
    if (event.success === true) {
      const post = event.postTokens ? `，当前 ${formatCompactNumber(event.postTokens)} tokens` : "";
      setConnection(`上下文压缩完成${post} · 会话已保留`, "connected");
    } else if (event.success === false) {
      setConnection(`上下文压缩失败${event.error ? `：${event.error}` : ""}`, "error");
    }
  }
}

// ── 信号灯带（移植自 Agent Orbit 0.9.6）：16 盏状态灯 + 维修灯位 ──
const SIGNAL_LIGHT_COUNT = 16;

function createSignalLightStripDom() {
  const titlebar = document.querySelector(".titlebar");
  const menu = titlebar?.querySelector(".app-menu");
  if (!titlebar || !menu || document.querySelector("#signal-light-strip")) return;
  const strip = document.createElement("div");
  strip.id = "signal-light-strip";
  strip.className = "signal-light-strip";
  strip.setAttribute("role", "status");
  strip.setAttribute("aria-label", "信号灯带：等待下一轮信号");
  strip.title = "信号灯带：等待下一轮信号";
  for (let index = 1; index <= SIGNAL_LIGHT_COUNT; index += 1) {
    const light = document.createElement("span");
    light.className = "signal-light is-idle";
    light.dataset.position = String(index);
    strip.append(light);
  }
  titlebar.insertBefore(strip, menu);
}

function renderSignalLights(payload) {
  const states = Array.isArray(payload?.lights) ? payload.lights : [];
  document.querySelectorAll("#signal-light-strip .signal-light").forEach((light, index) => {
    const item = states[index] || { state: "idle", label: "等待信号" };
    light.className = `signal-light is-${item.state}`;
    light.title = item.label;
  });
}

createSignalLightStripDom();
window.agentChatPro.onSignalLights?.((payload) => renderSignalLights(payload));
window.agentChatPro.getSignalLights?.().then((payload) => renderSignalLights(payload)).catch(() => {});

// 设置开关即时生效：保存设置后按返回值切换灯带可见性
function applySignalLightsVisibility(showSignalLights) {
  document.body.classList.toggle("signal-lights-hidden", showSignalLights === false);
}

function closeAppMenus(except) {
  document.querySelectorAll(".menu-group.open").forEach((group) => {
    if (group !== except) group.classList.remove("open");
  });
}

document.querySelectorAll(".menu-trigger").forEach((trigger) => {
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const group = trigger.closest(".menu-group");
    const opening = !group.classList.contains("open");
    closeAppMenus(group);
    group.classList.toggle("open", opening);
  });
});
document.querySelectorAll("[data-window-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    closeAppMenus();
    // 「关于」走设置中心的关于页（v3.12.2），其余窗口动作照旧发 main
    if (button.dataset.windowAction === "about") {
      populateSettings(await window.agentChatPro.loadSettings());
      switchSettingsTab("about");
      elements.dialog.showModal();
      return;
    }
    await window.agentChatPro.windowAction(button.dataset.windowAction);
  });
});
document.querySelectorAll("[data-app-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    closeAppMenus();
    await runAppAction(button.dataset.appAction);
  });
});
document.addEventListener("click", () => closeAppMenus());
document.querySelector(".titlebar").addEventListener("dblclick", (event) => {
  if (!event.target.closest("button, nav")) window.agentChatPro.windowAction("toggle-maximize");
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    runAppAction("new-chat");
  }
  if (event.key === "Escape") {
    closeAppMenus();
    if (activeId) {
      event.preventDefault();
      stopActiveMessage();
    }
  }
});

function setMaximized(maximized) {
  document.body.classList.toggle("maximized", Boolean(maximized));
  const button = document.querySelector("#maximize-window");
  button.classList.toggle("is-restoring", Boolean(maximized));
  button.title = maximized ? "还原" : "最大化";
  button.setAttribute("aria-label", maximized ? "还原" : "最大化");
}

window.agentChatPro.onWindowMaximized(setMaximized);
window.agentChatPro.onWindowFocus(() => {
  const prompt = document.getElementById("prompt");
  if (prompt && !window.getSelection().toString()) prompt.focus();
});

// ── 模式选择器 ──────────────────────────────────

let currentModeId = "regular";
let modeDropdownOpen = false;

function closeModeDropdown() {
  modeDropdownOpen = false;
  document.querySelector("#mode-dropdown").hidden = true;
}

async function refreshModeSelector() {
  try {
    const modes = await window.agentChatPro.listModes();
    window._cachedModes = modes;
    const list = document.querySelector("#mode-list");
    list.replaceChildren();
    for (const mode of modes) {
      const item = document.createElement("div");
      item.className = `mode-item${mode.id === currentModeId ? " active" : ""}`;
      item.innerHTML = `<span class="mode-item-icon">${mode.icon}</span><div class="mode-item-info"><span class="mode-item-name">${mode.name}</span><span class="mode-item-desc">${mode.description}</span></div>`;
      item.addEventListener("click", async () => {
        currentModeId = mode.id;
        updateModeDisplay(mode);
        // 同步刷新输入栏弹出菜单高亮
        await refreshComposerModePopup();
        // 保存到设置
        try {
          const settings = await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), workModeId: mode.id });
          populateSettings(settings);
        } catch (error) { setConnection("模式切换失败：" + error.message, "error"); }
        closeModeDropdown();
      });
      // 双击编辑模式
      item.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        closeModeDropdown();
        openModeEditDialog(mode.id);
      });
      list.append(item);
    }
  } catch (error) { console.error("Failed to load modes:", error); }
}

function updateModeDisplay(mode) {
  document.querySelector("#mode-icon").textContent = mode.icon;
  document.querySelector("#mode-name").textContent = mode.name;
  document.querySelector("#mode-trigger").title = `${mode.name}：${mode.description}`;
  setToolModeAppearance(mode.skipPermissions);
  // 同步更新输入栏模式按钮
  if (elements.composerModeTrigger) {
    elements.composerModeTrigger.textContent = mode.icon;
    elements.composerModeTrigger.title = `${mode.name}：${mode.description}`;
    elements.composerModeTrigger.className = `composer-mode-trigger ${mode.skipPermissions ? "automatic" : "safe"}`;
  }
  // 同步更新聊天区模式 badge
  const badge = document.querySelector("#chat-mode-badge");
  if (badge) {
    badge.textContent = `${mode.icon} ${mode.name}`;
    badge.title = `${mode.name}：${mode.description}`;
  }
}

document.querySelector("#mode-trigger").addEventListener("click", (event) => {
  event.stopPropagation();
  modeDropdownOpen = !modeDropdownOpen;
  document.querySelector("#mode-dropdown").hidden = !modeDropdownOpen;
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".mode-selector")) closeModeDropdown();
});

document.querySelector("#mode-edit").addEventListener("click", async () => {
  closeModeDropdown();
  openModeEditDialog();
});

// ── 模式编辑弹窗 ──────────────────────────────────

const modeEditDialog = document.querySelector("#mode-edit-dialog");
const modeEditForm = document.querySelector("#mode-edit-form");
const modeEditId = document.querySelector("#mode-edit-id");
const modeEditIcon = document.querySelector("#mode-edit-icon");
const modeEditName = document.querySelector("#mode-edit-name");
const modeEditDesc = document.querySelector("#mode-edit-desc");
const modeEditSystemPrompt = document.querySelector("#mode-edit-system-prompt");
const modeEditMaxTokens = document.querySelector("#mode-edit-max-tokens");
const modeEditThinking = document.querySelector("#mode-edit-thinking");
const modeEditHallucination = document.querySelector("#mode-edit-hallucination");
const modeEditEnergy = document.querySelector("#mode-edit-energy");
const modeEditSkipPermissions = document.querySelector("#mode-edit-skip-permissions");
const modeEditPermissionLabel = document.querySelector("#mode-edit-permission-label");
const modeEditPermissionHint = document.querySelector("#mode-edit-permission-hint");
const modeEditStatus = document.querySelector("#mode-edit-status");
const modeEditTitle = document.querySelector("#mode-edit-title");
const modeEditSubtitle = document.querySelector("#mode-edit-subtitle");
const deleteModeBtn = document.querySelector("#delete-mode");
const saveModeBtn = document.querySelector("#save-mode");

function openModeEditDialog(modeId) {
  modeEditStatus.textContent = "";
  modeEditStatus.classList.remove("error");
  if (modeId) {
    // 编辑现有模式
    const existing = window._cachedModes?.find((m) => m.id === modeId);
    if (!existing) return;
    modeEditId.value = existing.id;
    modeEditIcon.value = existing.icon || "🔧";
    modeEditName.value = existing.name || "";
    modeEditDesc.value = existing.description || "";
    modeEditSystemPrompt.value = existing.systemPrompt || "";
    modeEditMaxTokens.value = String(existing.maxTokens || 8192);
    modeEditThinking.value = existing.thinkingLevel || "none";
    modeEditHallucination.value = existing.hallucinationControl || "standard";
    modeEditEnergy.value = existing.energyPriority || "balanced";
    modeEditSkipPermissions.checked = Boolean(existing.skipPermissions);
    modeEditTitle.textContent = "编辑模式";
    modeEditSubtitle.textContent = existing.isBuiltIn ? "内置模式参数不可修改" : "修改自定义模式参数";
    deleteModeBtn.hidden = existing.isBuiltIn;
    saveModeBtn.disabled = existing.isBuiltIn;
    // 内置模式：只读
    modeEditName.readOnly = existing.isBuiltIn;
    modeEditIcon.readOnly = existing.isBuiltIn;
    modeEditDesc.readOnly = existing.isBuiltIn;
    updatePermissionLabels(existing.skipPermissions);
  } else {
    // 新建模式
    modeEditId.value = "";
    modeEditIcon.value = "🔧";
    modeEditName.value = "";
    modeEditDesc.value = "";
    modeEditSystemPrompt.value = "";
    modeEditMaxTokens.value = "8192";
    modeEditThinking.value = "none";
    modeEditHallucination.value = "standard";
    modeEditEnergy.value = "balanced";
    modeEditSkipPermissions.checked = false;
    modeEditTitle.textContent = "新建模式";
    modeEditSubtitle.textContent = "创建自定义工作模式";
    deleteModeBtn.hidden = true;
    saveModeBtn.disabled = false;
    modeEditName.readOnly = false;
    modeEditIcon.readOnly = false;
    updatePermissionLabels(false);
  }
  modeEditDialog.showModal();
  updateSystemPromptPreview();
}

function updatePermissionLabels(skipPermissions) {
  modeEditPermissionLabel.textContent = skipPermissions ? "自动执行工具操作（跳过权限确认）— 已开启" : "自动执行工具操作（跳过权限确认）";
  modeEditPermissionHint.textContent = skipPermissions ? "⚠️ 开启后 Agent 将自动执行所有工具操作，无需逐一确认。请仅在信任环境中使用。" : "开启后 Agent 将自动执行所有工具操作，无需逐一确认。";
}

modeEditSkipPermissions.addEventListener("change", () => {
  updatePermissionLabels(modeEditSkipPermissions.checked);
});

// ── 系统提示词实时预览 ──────────────────────────────

let promptPreviewTimer = null;

function updateSystemPromptPreview() {
  const text = modeEditSystemPrompt.value.trim();
  const section = document.querySelector("#system-prompt-preview-section");
  const preview = document.querySelector("#system-prompt-preview");
  section.hidden = !text;
  if (!text) {
    preview.textContent = "";
    preview.classList.remove("rendered");
    return;
  }
  // 防抖：300ms 后渲染 Markdown
  clearTimeout(promptPreviewTimer);
  promptPreviewTimer = setTimeout(async () => {
    try {
      const html = await window.agentChatPro.renderMarkdown(text);
      preview.innerHTML = html;
      preview.classList.add("rendered");
      // 链接拦截
      preview.querySelectorAll("a[href]").forEach((link) => {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          window.agentChatPro.openLink(link.getAttribute("href")).catch(() => {});
        });
      });
    } catch {
      preview.textContent = text;
      preview.classList.remove("rendered");
    }
  }, 300);
}

modeEditSystemPrompt.addEventListener("input", updateSystemPromptPreview);

document.querySelector("#close-mode-edit").addEventListener("click", () => modeEditDialog.close());
document.querySelector("#cancel-mode-edit").addEventListener("click", () => modeEditDialog.close());

deleteModeBtn.addEventListener("click", async () => {
  const id = modeEditId.value;
  if (!id) return;
  const mode = window._cachedModes?.find((m) => m.id === id);
  if (!mode || mode.isBuiltIn) return;
  if (!confirm(`确定删除模式"${mode.name}"吗？此操作不可撤销。`)) return;
  try {
    await window.agentChatPro.deleteMode(id);
    if (currentModeId === id) {
      currentModeId = "regular";
      const regular = await window.agentChatPro.getMode("regular");
      if (regular) updateModeDisplay(regular);
      const settings = await window.agentChatPro.loadSettings();
      await window.agentChatPro.saveSettings({ ...settings, workModeId: "regular" });
    }
    await refreshModeSelector();
    modeEditDialog.close();
    setConnection("模式已删除", "connected");
  } catch (error) { modeEditStatus.textContent = error.message; modeEditStatus.classList.add("error"); }
});

modeEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = modeEditId.value;
  const input = {
    icon: modeEditIcon.value.trim() || "🔧",
    name: modeEditName.value.trim(),
    description: modeEditDesc.value.trim(),
    systemPrompt: modeEditSystemPrompt.value.trim(),
    maxTokens: Number(modeEditMaxTokens.value) || 8192,
    thinkingLevel: modeEditThinking.value,
    hallucinationControl: modeEditHallucination.value,
    energyPriority: modeEditEnergy.value,
    skipPermissions: modeEditSkipPermissions.checked
  };
  if (!input.name) { modeEditStatus.textContent = "模式名称不能为空。"; modeEditStatus.classList.add("error"); return; }
  try {
    let result;
    if (id) {
      result = await window.agentChatPro.updateMode(id, input);
    } else {
      result = await window.agentChatPro.createMode(input);
    }
    // 如果编辑的是当前模式，刷新显示
    if (result.id === currentModeId) {
      updateModeDisplay(result);
      setToolModeAppearance(result.skipPermissions);
    }
    await refreshModeSelector();
    modeEditDialog.close();
    setConnection(id ? "模式已更新" : "模式已创建", "connected");
  } catch (error) { modeEditStatus.textContent = error.message; modeEditStatus.classList.add("error"); }
});

modeEditDialog.addEventListener("close", () => {
  modeEditStatus.textContent = "";
  modeEditStatus.classList.remove("error");
});

document.querySelector("#mode-import").addEventListener("click", async () => {
  closeModeDropdown();
  try {
    const json = prompt("粘贴导出的模式 JSON：");
    if (!json) return;
    const result = await window.agentChatPro.importModes(json);
    await refreshModeSelector();
    setConnection(`导入成功：新增 ${result.added} 个模式`, "connected");
  } catch (error) { alert("导入失败：" + error.message); }
});

document.querySelector("#mode-export").addEventListener("click", async () => {
  closeModeDropdown();
  try {
    const json = await window.agentChatPro.exportModes();
    await navigator.clipboard.writeText(json);
    alert("自定义模式已复制到剪贴板。");
  } catch (error) { alert("导出失败：" + error.message); }
});

// ── 网络配置 UI ─────────────────────────────────

function updateNetworkModeUI() {
  const mode = document.querySelector("#network-type").value;
  const isExternal = mode === "external";
  document.querySelector("#mode-internal").classList.toggle("active", !isExternal);
  document.querySelector("#mode-external").classList.toggle("active", isExternal);
  document.querySelector("#external-fields").hidden = !isExternal;
  updateExternalMethodUI();
}

function updateExternalMethodUI() {
  const method = document.querySelector("#external-method").value;
  document.querySelector("#frp-config").hidden = method !== "frp";
  document.querySelector("#derp-config").hidden = method !== "derp";
  document.querySelector("#p2p-config").hidden = method !== "p2p";
  document.querySelector("#n2n-config").hidden = method !== "n2n";
  // FRP 参数在 auto 或 frp 时显示
  if (method === "auto") {
    document.querySelector("#frp-config").hidden = false;
    document.querySelector("#derp-config").hidden = false;
  }
}

function populateNetworkSettings(settings) {
  document.querySelector("#network-type").value = settings.networkType || "internal";
  document.querySelector("#external-method").value = settings.externalMethod || "auto";
  if (settings.frp) {
    document.querySelector("#frp-server-addr").value = settings.frp.serverAddr || "";
    document.querySelector("#frp-server-port").value = settings.frp.serverPort || 7000;
    document.querySelector("#frp-local-port").value = settings.frp.localPort || 22;
    document.querySelector("#frp-remote-port").value = settings.frp.remotePort || 6000;
    document.querySelector("#frp-token").value = "";
    document.querySelector("#frp-token").placeholder = settings.frp.hasToken ? "已安全保存；留空不修改" : "可选";
  }
  if (settings.derp) {
    document.querySelector("#derp-relay-addr").value = settings.derp.relayAddr || "";
    document.querySelector("#derp-relay-port").value = settings.derp.relayPort || 3478;
    document.querySelector("#derp-auth-key").value = "";
    document.querySelector("#derp-auth-key").placeholder = settings.derp.hasAuthKey ? "已安全保存；留空不修改" : "可选";
  }
  if (settings.p2p) {
    document.querySelector("#p2p-stun-addr").value = settings.p2p.stunAddr || "stun.l.google.com";
    document.querySelector("#p2p-stun-port").value = settings.p2p.stunPort || 19302;
  }
  if (settings.n2n) {
    document.querySelector("#n2n-supernode-addr").value = settings.n2n.supernodeAddr || "";
    document.querySelector("#n2n-supernode-port").value = settings.n2n.supernodePort || 7777;
    document.querySelector("#n2n-community").value = "";
    document.querySelector("#n2n-community").placeholder = settings.n2n.hasCommunity ? "已安全保存；留空不修改" : "社区标识";
    document.querySelector("#n2n-key").value = "";
    document.querySelector("#n2n-key").placeholder = settings.n2n.hasKey ? "已安全保存；留空不修改" : "可选";
  }
  if (settings.hasAccessPassword) {
    document.querySelector("#access-password").placeholder = "已安全保存；留空不修改";
  }
  updateNetworkModeUI();
}

function networkSettingsFromForm() {
  return {
    frp: {
      serverAddr: document.querySelector("#frp-server-addr").value,
      serverPort: Number(document.querySelector("#frp-server-port").value) || 7000,
      localPort: Number(document.querySelector("#frp-local-port").value) || 22,
      remotePort: Number(document.querySelector("#frp-remote-port").value) || 6000,
      token: document.querySelector("#frp-token").value
    },
    derp: {
      relayAddr: document.querySelector("#derp-relay-addr").value,
      relayPort: Number(document.querySelector("#derp-relay-port").value) || 3478,
      authKey: document.querySelector("#derp-auth-key").value
    },
    p2p: {
      stunAddr: document.querySelector("#p2p-stun-addr").value,
      stunPort: Number(document.querySelector("#p2p-stun-port").value) || 19302
    },
    n2n: {
      supernodeAddr: document.querySelector("#n2n-supernode-addr").value,
      supernodePort: Number(document.querySelector("#n2n-supernode-port").value) || 7777,
      community: document.querySelector("#n2n-community").value,
      key: document.querySelector("#n2n-key").value
    },
    accessPassword: document.querySelector("#access-password").value
  };
}

document.querySelectorAll("[data-network-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector("#network-type").value = button.dataset.networkMode;
    updateNetworkModeUI();
  });
});

document.querySelector("#external-method").addEventListener("change", updateExternalMethodUI);

document.querySelector("#toggle-access-password").addEventListener("click", () => {
  const input = document.querySelector("#access-password");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  document.querySelector("#toggle-access-password").textContent = visible ? "显示" : "隐藏";
  input.focus();
});

// ── 网络状态更新 ──────────────────────────────────

function updateNetworkStatus(status) {
  const modeLabel = document.querySelector("#network-mode-label");
  const latencyLabel = document.querySelector("#network-latency-label");
  const networkInfo = document.querySelector("#network-info");

  const modeLabels = {
    "ssh-direct": "内网直连",
    "p2p-nat": "P2P 打洞",
    "derp-relay": "DERP 中继",
    "frp-tunnel": "FRP 穿透",
    "n2n-mesh": "N2N 虚拟局域网"
  };

  if (status.state === "connected" || status.state === "degraded") {
    networkInfo.hidden = false;
    modeLabel.textContent = modeLabels[status.type] || status.mode || "已连接";
    if (status.latencyMs !== null) {
      latencyLabel.textContent = `${status.latencyMs}ms`;
      latencyLabel.className = status.latencyMs < 50 ? "quality-excellent" : status.latencyMs < 150 ? "quality-good" : status.latencyMs < 300 ? "quality-fair" : "quality-poor";
    } else {
      latencyLabel.textContent = "";
      latencyLabel.className = "";
    }
    // 连接成功时更新连接状态指示器
    setConnection(`${modeLabels[status.type] || "外网"}已连接`, "connected");
  } else if (status.state === "reconnecting" || status.state === "probing") {
    networkInfo.hidden = false;
    modeLabel.textContent = status.state === "reconnecting" ? "重连中…" : "连接中…";
    latencyLabel.textContent = "";
    setConnection(status.detail || "正在建立外网连接…", "");
  } else if (status.state === "failed") {
    networkInfo.hidden = false;
    modeLabel.textContent = "连接失败";
    latencyLabel.textContent = "";
    setConnection(status.detail || "外网连接失败", "error");
  } else {
    networkInfo.hidden = true;
  }
}

window.agentChatPro.onNetworkStatusChange((event) => {
  updateNetworkStatus(networkManager.getStatus());
});

// ── 主题切换 ──────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  // 更新外观面板中的主题按钮状态
  document.querySelector("#theme-dark")?.classList.toggle("active", theme === "dark");
  document.querySelector("#theme-light")?.classList.toggle("active", theme === "light");
  // 更新毛玻璃 RGB 值（深色/浅色不同底色）
  updateFrostedGlassRGB(theme);
  try { localStorage.setItem("theme", theme); } catch {}
}

function updateFrostedGlassRGB(theme) {
  const dark = theme !== "light";
  document.documentElement.style.setProperty("--main-bg-rgb", dark ? "27, 34, 39" : "240, 242, 245");
}

document.querySelector("#theme-dark")?.addEventListener("click", async () => {
  applyTheme("dark");
  try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), theme: "dark" }); } catch {}
});
document.querySelector("#theme-light")?.addEventListener("click", async () => {
  applyTheme("light");
  try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), theme: "light" }); } catch {}
});

// 初始化主题（优先使用主进程推送，回退到设置和 localStorage）
let themeInitialized = false;
function initTheme(theme) {
  if (themeInitialized) return;
  themeInitialized = true;
  applyTheme(theme || "dark");
}
window.agentChatPro.onThemeInit((theme) => initTheme(theme));
setTimeout(() => {
  if (!themeInitialized) initTheme(localStorage.getItem("theme") || "dark");
}, 1000);

window.agentChatPro.onNetworkLatency((summary) => {
  const latencyLabel = document.querySelector("#network-latency-label");
  if (latencyLabel) {
    latencyLabel.textContent = `${summary.avgLatency}ms · ${summary.label}`;
    latencyLabel.className = `quality-${Object.entries({ excellent: 90, good: 70, fair: 50 }).find(([, v]) => summary.quality >= v)?.[0] || "poor"}`;
  }
});

// ── 品牌验证 ──

function updateBrandDisplay() {
  const config = brandConfig || { appName: "Agent Chat Pro", appSubtitle: "三模式 AI 聊天客户端", appIcon: "🤖" };

  // 更新侧边栏品牌名
  const brandName = document.querySelector("#sidebar-brand-name");
  if (brandName) brandName.textContent = config.appName;

  // 更新标题栏
  const titleIdentity = document.querySelector("#titlebar-identity");
  if (titleIdentity) titleIdentity.querySelector("strong").textContent = config.appName;

  // 更新水印
  const watermark = document.querySelector("#brand-watermark");
  if (watermark) watermark.hidden = brandVerified;
}

window.agentChatPro.onBrandConfig((config) => {
  brandConfig = config;
  updateBrandDisplay();
});
window.agentChatPro.onBrandStatus((status) => {
  brandVerified = status.verified;
  updateBrandDisplay();
});

// 品牌验证水印按钮
document.querySelector("#watermark-admin-btn")?.addEventListener("click", () => {
  const dialog = document.querySelector("#brand-admin-dialog");
  if (dialog) dialog.showModal();
});

// 品牌管理员覆盖弹窗
document.querySelector("#close-brand-admin")?.addEventListener("click", () => {
  document.querySelector("#brand-admin-dialog")?.close();
});
document.querySelector("#brand-admin-cancel")?.addEventListener("click", () => {
  document.querySelector("#brand-admin-dialog")?.close();
});
document.querySelector("#brand-admin-submit")?.addEventListener("click", async () => {
  const password = document.querySelector("#brand-admin-password")?.value;
  const status = document.querySelector("#brand-admin-status");
  if (!password) { if (status) status.textContent = "请输入管理员密码"; return; }
  try {
    const result = await window.agentChatPro.submitAdminOverride(password);
    if (result.success) {
      if (status) { status.textContent = "验证成功！"; status.className = "brand-admin-status success"; }
      setTimeout(() => { document.querySelector("#brand-admin-dialog")?.close(); updateBrandDisplay(); }, 1000);
    } else {
      if (status) { status.textContent = result.message || "验证失败"; status.className = "brand-admin-status error"; }
    }
  } catch (e) {
    if (status) { status.textContent = "连接失败: " + e.message; status.className = "brand-admin-status error"; }
  }
});

// 初始化品牌验证
window.agentChatPro.getBrandStatus().then(status => {
  brandVerified = status.verified;
  brandConfig = status.brandConfig;
  updateBrandDisplay();
}).catch(() => {});
window.agentChatPro.getBrandConfig().then(config => {
  brandConfig = config;
  updateBrandDisplay();
}).catch(() => {});

(async () => {
  setMaximized(await window.agentChatPro.isWindowMaximized());
  const settings = await window.agentChatPro.loadSettings();
  populateSettings(settings);
  // 初始化模式选择器
  currentModeId = settings.workModeId || "regular";
  await refreshModeSelector();
  const currentMode = await window.agentChatPro.getMode(currentModeId);
  if (currentMode) updateModeDisplay(currentMode);
  // 初始化网络配置
  populateNetworkSettings(settings);
  // 初始化外观设置
  appearanceSettings.frostedGlass = Boolean(settings.frostedGlass);
  appearanceSettings.frostedBlur = Number(settings.frostedBlur) || 20;
  appearanceSettings.frostedOpacity = Number(settings.frostedOpacity) || 85;
  appearanceSettings.backgroundImage = settings.backgroundImage || "";
  appearanceSettings.backgroundBlur = Number(settings.backgroundBlur) || 0;
  appearanceSettings.backgroundOpacity = Number(settings.backgroundOpacity) || 100;
  applyFrostedGlass();
  applyBackgroundImage();
  const conversations = await window.agentChatPro.listConversations();
  if (conversations.length) await loadConversation(conversations[0].id);
  else await createNewConversation();
  // 启动必填检查（v3.13.0：非 Claude 本机引擎不依赖唤醒命令，自定义命令引擎要求命令模板）
  const claudeEngine = settings.connectionMode !== "local" || String(settings.localEngine || "claude") === "claude";
  if ((claudeEngine && !settings.wakeName)
    || (settings.connectionMode !== "local" && (!settings.host || !settings.username || !settings.hasPassword))
    || (settings.connectionMode === "local" && settings.localEngine === "custom" && !settings.customCliCommand)) {
    openSettings();
  }
})();

// ── 右键菜单 ──────────────────────────────────────────

let activeContextMenu = null;

function showMessageContextMenu(event, item, kind) {
  event.preventDefault();
  closeContextMenu();
  const menu = document.querySelector("#context-menu");
  const content = menu.querySelector(".context-menu-content");
  content.replaceChildren();

  // 通用：复制
  const copyItem = createContextMenuItem("📋", "复制文本", () => {
    const text = item.querySelector(".message-content").textContent;
    navigator.clipboard.writeText(text).then(() => {}).catch(() => {});
    closeContextMenu();
  });
  content.append(copyItem);

  if (kind === "user") {
    // 用户消息：编辑、引用、删除+同步删除AI回复
    const editItem = createContextMenuItem("✎", "编辑消息", () => {
      elements.prompt.value = item.querySelector(".message-content").textContent;
      adjustTextarea();
      elements.prompt.focus();
      closeContextMenu();
    });
    content.append(editItem);

    const quoteItem = createContextMenuItem("❝", "引用到输入框", () => {
      const text = item.querySelector(".message-content").textContent;
      elements.prompt.value = `> ${text.split("\n").join("\n> ")}\n\n` + elements.prompt.value;
      adjustTextarea();
      elements.prompt.focus();
      closeContextMenu();
    });
    content.append(quoteItem);

    content.append(createContextMenuSeparator());

    const deleteItem = createContextMenuItem("🗑", "删除此条及下方所有消息", () => {
      const allMessages = Array.from(elements.messages.querySelectorAll(".message"));
      const startIndex = allMessages.indexOf(item);
      if (startIndex === -1) { closeContextMenu(); return; }
      // 删除当前及后续所有消息
      for (let i = allMessages.length - 1; i >= startIndex; i--) {
        allMessages[i].remove();
      }
      // 如果没有消息了，显示空状态
      if (!elements.messages.querySelector(".message")) {
        elements.empty.hidden = false;
      }
      closeContextMenu();
    }, true);
    content.append(deleteItem);
  } else if (kind === "assistant") {
    // AI消息：重新生成
    content.append(createContextMenuSeparator());

    const retryItem = createContextMenuItem("↻", "重新生成", () => {
      retryFromMessage(item);
      closeContextMenu();
    });
    content.append(retryItem);
  }

  // 定位菜单
  menu.hidden = false;
  const menuRect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - menuRect.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - menuRect.height - 8);
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  activeContextMenu = menu;

  // 点击其他地方关闭
  setTimeout(() => document.addEventListener("click", closeContextMenu, true));
}

function createContextMenuItem(icon, label, handler, isDanger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "context-menu-item" + (isDanger ? " danger" : "");
  button.innerHTML = `<span class="context-icon">${icon}</span>${label}`;
  button.addEventListener("click", handler);
  return button;
}

function createContextMenuSeparator() {
  const div = document.createElement("div");
  div.className = "context-menu-separator";
  return div;
}

function closeContextMenu() {
  const menu = document.querySelector("#context-menu");
  if (menu) menu.hidden = true;
  document.removeEventListener("click", closeContextMenu, true);
  activeContextMenu = null;
}

// Escape 关闭右键菜单
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeContextMenu) {
    closeContextMenu();
    e.preventDefault();
  }
});

// ── 外观设置面板 ──────────────────────────────────────────

async function openAppearanceDialog() {
  const dialog = document.querySelector("#appearance-dialog");
  // 加载当前设置
  const settings = await window.agentChatPro.loadSettings();
  appearanceSettings.frostedGlass = Boolean(settings.frostedGlass);
  appearanceSettings.frostedBlur = Number(settings.frostedBlur) || 20;
  appearanceSettings.frostedOpacity = Number(settings.frostedOpacity) || 85;
  appearanceSettings.backgroundImage = settings.backgroundImage || "";
  appearanceSettings.backgroundBlur = Number(settings.backgroundBlur) || 0;
  appearanceSettings.backgroundOpacity = Number(settings.backgroundOpacity) || 100;

  // 硬件检测
  const toggle = document.querySelector("#frosted-glass-toggle");
  const statusEl = document.querySelector("#frosted-glass-status");
  const hardwareOK = detectFrostedGlassSupport();
  if (!hardwareOK) {
    toggle.disabled = true;
    toggle.checked = false;
    statusEl.textContent = "⚠️ 当前设备不支持毛玻璃效果（需 GPU 加速）";
    appearanceSettings.frostedGlass = false;
  } else {
    toggle.disabled = false;
    toggle.checked = appearanceSettings.frostedGlass;
    statusEl.textContent = appearanceSettings.frostedGlass ? "毛玻璃效果已开启" : "点击开关启用毛玻璃效果";
  }

  // 滑块
  document.querySelector("#frosted-blur-range").value = appearanceSettings.frostedBlur;
  document.querySelector("#blur-value-label").textContent = appearanceSettings.frostedBlur + "px";
  document.querySelector("#frosted-opacity-range").value = appearanceSettings.frostedOpacity;
  document.querySelector("#opacity-value-label").textContent = appearanceSettings.frostedOpacity + "%";

  // 主题按钮状态
  const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
  document.querySelector("#theme-dark").classList.toggle("active", currentTheme === "dark");
  document.querySelector("#theme-light").classList.toggle("active", currentTheme === "light");

  // 背景图片
  updateBackgroundPreview();

  dialog.showModal();
}

function detectFrostedGlassSupport() {
  // 检测 GPU 和 backdrop-filter 支持
  try {
    // WebGL 检测
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return false;
    // 检查 renderer 是否为软件渲染
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    if (debugInfo) {
      const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      // 排除已知软件渲染器
      if (renderer && (renderer.includes("SwiftShader") || renderer.includes("llvmpipe") || renderer.includes("Software"))) {
        return false;
      }
    }
    // CSS backdrop-filter 检测
    return CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)");
  } catch {
    return false;
  }
}

function updateBackgroundPreview() {
  const noneCard = document.querySelector("#background-preview-none");
  const uploadCard = document.querySelector("#background-preview-upload");
  const uploadSection = document.querySelector("#background-upload-section");
  const blurRow = document.querySelector("#background-blur-row");
  const opacityRow = document.querySelector("#background-opacity-row");
  const pathInput = document.querySelector("#background-image-path");

  noneCard.classList.toggle("background-preview-active", !appearanceSettings.backgroundImage);
  uploadCard.classList.toggle("background-preview-active", Boolean(appearanceSettings.backgroundImage));
  uploadSection.hidden = !appearanceSettings.backgroundImage && !pathInput?.value;
  if (appearanceSettings.backgroundImage) {
    pathInput.value = appearanceSettings.backgroundImage === "[uploaded]" ? "已选择本地图片" : appearanceSettings.backgroundImage;
    uploadSection.hidden = false;
  }
  blurRow.hidden = !appearanceSettings.backgroundImage;
  opacityRow.hidden = !appearanceSettings.backgroundImage;
  if (blurRow.hidden === false) {
    document.querySelector("#background-blur-range").value = appearanceSettings.backgroundBlur;
    document.querySelector("#bg-blur-value-label").textContent = appearanceSettings.backgroundBlur + "px";
    document.querySelector("#background-opacity-range").value = appearanceSettings.backgroundOpacity;
    document.querySelector("#bg-opacity-value-label").textContent = appearanceSettings.backgroundOpacity + "%";
  }
}

function applyFrostedGlass() {
  const main = document.querySelector(".main");
  if (!main) return;
  main.classList.toggle("frosted", appearanceSettings.frostedGlass);
  document.documentElement.style.setProperty("--frosted-blur", appearanceSettings.frostedBlur + "px");
  document.documentElement.style.setProperty("--frosted-opacity", (appearanceSettings.frostedOpacity / 100).toFixed(2));
}

function applyBackgroundImage() {
  const main = document.querySelector(".main");
  if (!main) return;
  if (appearanceSettings.backgroundImage) {
    main.classList.add("background-image");
    main.style.setProperty("--bg-image-blur", appearanceSettings.backgroundBlur + "px");
    if (appearanceSettings.backgroundImage.startsWith("data:") || appearanceSettings.backgroundImage.startsWith("blob:")) {
      main.style.backgroundImage = `url(${appearanceSettings.backgroundImage})`;
    } else {
      main.style.backgroundImage = `url(${appearanceSettings.backgroundImage.replace(/'/g, "\\'")})`;
    }
    // 背景透明度通过 opacity 滤镜叠加
    main.style.setProperty("--bg-image-opacity", (appearanceSettings.backgroundOpacity / 100).toFixed(2));
  } else {
    main.classList.remove("background-image");
    main.style.backgroundImage = "";
    main.style.removeProperty("--bg-image-blur");
    main.style.removeProperty("--bg-image-opacity");
  }
}

// ── 外观设置事件绑定 ──

// 毛玻璃开关
document.querySelector("#frosted-glass-toggle")?.addEventListener("change", async () => {
  appearanceSettings.frostedGlass = document.querySelector("#frosted-glass-toggle").checked;
  document.querySelector("#frosted-glass-status").textContent = appearanceSettings.frostedGlass ? "毛玻璃效果已开启" : "点击开关启用毛玻璃效果";
  applyFrostedGlass();
  try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), frostedGlass: appearanceSettings.frostedGlass, frostedBlur: appearanceSettings.frostedBlur, frostedOpacity: appearanceSettings.frostedOpacity }); } catch {}
});

// 毛玻璃模糊强度
document.querySelector("#frosted-blur-range")?.addEventListener("input", () => {
  appearanceSettings.frostedBlur = Number(document.querySelector("#frosted-blur-range").value);
  document.querySelector("#blur-value-label").textContent = appearanceSettings.frostedBlur + "px";
  applyFrostedGlass();
});
document.querySelector("#frosted-blur-range")?.addEventListener("change", async () => {
  try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), frostedBlur: appearanceSettings.frostedBlur }); } catch {}
});

// 毛玻璃透明度
document.querySelector("#frosted-opacity-range")?.addEventListener("input", () => {
  appearanceSettings.frostedOpacity = Number(document.querySelector("#frosted-opacity-range").value);
  document.querySelector("#opacity-value-label").textContent = appearanceSettings.frostedOpacity + "%";
  applyFrostedGlass();
});
document.querySelector("#frosted-opacity-range")?.addEventListener("change", async () => {
  try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), frostedOpacity: appearanceSettings.frostedOpacity }); } catch {}
});

// 背景图片选择
document.querySelector("#background-preview-none")?.addEventListener("click", async () => {
  appearanceSettings.backgroundImage = "";
  updateBackgroundPreview();
  applyBackgroundImage();
  try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), backgroundImage: "", backgroundBlur: 0, backgroundOpacity: 100 }); } catch {}
});

document.querySelector("#background-preview-upload")?.addEventListener("click", () => {
  document.querySelector("#background-upload-section").hidden = false;
  document.querySelector("#choose-background-image").click();
});

document.querySelector("#choose-background-image")?.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      appearanceSettings.backgroundImage = reader.result; // data URL
      updateBackgroundPreview();
      applyBackgroundImage();
      try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), backgroundImage: appearanceSettings.backgroundImage, backgroundBlur: appearanceSettings.backgroundBlur, backgroundOpacity: appearanceSettings.backgroundOpacity }); } catch {}
    };
    reader.readAsDataURL(file);
  });
  input.click();
});

document.querySelector("#clear-background-image")?.addEventListener("click", async () => {
  appearanceSettings.backgroundImage = "";
  document.querySelector("#background-image-path").value = "";
  updateBackgroundPreview();
  applyBackgroundImage();
  try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), backgroundImage: "", backgroundBlur: 0, backgroundOpacity: 100 }); } catch {}
});

// 背景模糊滑块
document.querySelector("#background-blur-range")?.addEventListener("input", () => {
  appearanceSettings.backgroundBlur = Number(document.querySelector("#background-blur-range").value);
  document.querySelector("#bg-blur-value-label").textContent = appearanceSettings.backgroundBlur + "px";
  applyBackgroundImage();
});
document.querySelector("#background-blur-range")?.addEventListener("change", async () => {
  try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), backgroundBlur: appearanceSettings.backgroundBlur }); } catch {}
});

// 背景透明度滑块
document.querySelector("#background-opacity-range")?.addEventListener("input", () => {
  appearanceSettings.backgroundOpacity = Number(document.querySelector("#background-opacity-range").value);
  document.querySelector("#bg-opacity-value-label").textContent = appearanceSettings.backgroundOpacity + "%";
  applyBackgroundImage();
});
document.querySelector("#background-opacity-range")?.addEventListener("change", async () => {
  try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), backgroundOpacity: appearanceSettings.backgroundOpacity }); } catch {}
});

// 外观设置面板关闭时同步
document.querySelector("#appearance-dialog")?.addEventListener("close", () => {});

// ── 菜单增加"外观设置" ──

async function runAppAction(action) {
  if (action === "new-chat") await createNewConversation();
  else if (action === "settings") await openSettings();
  else if (action === "appearance") await openAppearanceDialog();
  else if (action === "archive") {
    try { await window.agentChatPro.openArchiveDirectory(); }
    catch (error) { alert(error.message); }
  } else if (action === "diagnostics") {
    try { await window.agentChatPro.openDiagnostics(); }
    catch (error) { alert(error.message); }
  }
}
