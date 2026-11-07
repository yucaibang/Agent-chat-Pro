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
  stateDot: document.querySelector("#state-dot"),
  // 阉割版 Bridge Edition：云端AI 放行队列（composer 上方浮层卡片）
  bridgeQueue: document.querySelector("#bridge-queue")
};

let sessionId = "";
let activeId = "";
let conversationId = "";
// v3.41.0 任务完成系统通知：当前显示会话标题（loadConversation/refreshConversationList 单点维护），
// 供通知标题使用；发送时另做快照防「切走后收尾标错会话名」
let conversationTitle = "";
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
let streamingConversationId = "";  // 进行中任务所属对话（v3.15.0：切走后后台继续，切回无缝衔接）
// v3.15.6：输入框草稿按对话隔离——切走时保存（文本+附件），进入时恢复，新对话干净待发送
const composerDrafts = new Map();  // conversationId → { text, attachments }
let streamingConnectionMode = "";  // 进行中任务发起时的连接模式（状态条文案用）

// ── 产品形态门控（阉割版 Bridge Edition）：getEdition IPC 返回，默认主版全开 ──
let editionState = {
  edition: "main",
  productName: "Agent Chat Pro",
  gates: { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true }
};

// v3.15.0 功能2：历史列表模式图标（对话的 lastConnectionMode → 标题后徽标）
const CONVERSATION_MODE_ICONS = { ssh: "🖥️", cloud: "☁️", local: "💻" };
const CONVERSATION_MODE_LABELS = { ssh: "SSH 远程", cloud: "云端 AI", local: "本机" };

// ── v3.35.6 工作区切换器（多 AI 对话（工作）· UI 重构需求）──
// 数据强隔离：single=一对一专攻（存量对话/缺省）/ team=多个高效合作。
// 会话列表按工作区物理过滤 + loadConversation 工作区入参校验，严禁串台。
const WORKSPACES = [
  { id: "single", name: "Agent Chat Pro", desc: "一对一专攻" },
  { id: "team", name: "Agents Chat Pro", desc: "多个高效合作" }
];
const WORKSPACE_TEAM_NAME = "Agents Chat Pro";
const normalizeWorkspace = (value) => (value === "team" ? "team" : "single");
let currentWorkspace = "";
let workspaceDropdownOpen = false;

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
    // v3.18.0 F4：SSH 卡槽（活跃槽 hidden 字段 + 当前槽名称随表单保存）
    activeSshProfile: data.get("activeSshProfile") || "ssh-1",
    sshProfileName: data.get("sshProfileName") || "",
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
    // v3.41.0：任务完成系统通知开关（默认开）
    taskCompleteNotifications: data.get("taskCompleteNotifications") === "on",
    workModeId: currentModeId,
    networkType: document.querySelector("#network-type").value,
    externalMethod: document.querySelector("#external-method").value,
    cloudAiProvider: provider,
    // v3.21.0：custom 走模型名手填框（原先恒为字面 "custom" 的隐性 bug 修复）
    cloudAiModel: provider === "custom"
      ? (document.querySelector("#cloud-custom-model")?.value || "").trim()
      : (document.querySelector("#cloud-model")?.value || "glm-4.7-flash"),
    cloudAiBaseUrl: document.querySelector("#cloud-base-url")?.value || (config?.baseUrl || ""),
    cloudAiApiKey: document.querySelector("#cloud-api-key")?.value || "",
    clearCloudAiApiKey: !document.querySelector("#cloud-api-key")?.value && hasCloudApiKey,
    // 云端模式工具执行（v3.14.0 云办公一期）
    cloudToolsEnabled: document.querySelector("#cloud-tools-enabled")?.checked || false,
    cloudRunCommandEnabled: document.querySelector("#cloud-run-command-enabled")?.checked || false,
    cloudWorkingDirectory: document.querySelector("#cloud-working-directory")?.value || "",
    // 云办公二期 v3.22.0：沙箱执行与临时联网状态
    cloudSandboxEnabled: document.querySelector("#cloud-sandbox-enabled")?.checked || false,
    cloudSandboxNetworkEnabled: document.querySelector("#cloud-sandbox-network-enabled")?.checked || false,
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
  // v3.41.0：任务完成系统通知开关回填（默认开）
  elements.form.elements.namedItem("taskCompleteNotifications").checked = settings.taskCompleteNotifications !== false;
  document.body.classList.toggle("signal-lights-hidden", settings.showSignalLights === false);
  elements.form.elements.namedItem("connectionMode").value = settings.connectionMode || "ssh";
  currentConnectionMode = settings.connectionMode === "local" ? "local" : settings.connectionMode === "cloud" ? "cloud" : "ssh";
  elements.form.elements.namedItem("localEngine").value = settings.localEngine || "claude";
  currentLocalEngine = settings.localEngine || "claude";
  updateConnectionModeUI();
  // v3.24.0：不再按全局 skipPermissions 覆盖输入栏模式图标（根因见 setToolModeAppearance；图标随当前模式）
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
  const model = settings.cloudAiModel || "";
  if (cloudProvider) cloudProvider.value = provider;
  if (cloudBaseURL) cloudBaseURL.value = baseURL || (CLOUD_PROVIDERS[provider]?.baseUrl || "");
  // v3.21.0：custom 模型名回填手填框；固定服务商把已存模型传给 change 处理（重建下拉后恢复选中，防漂移）
  const customModelInput = document.querySelector("#cloud-custom-model");
  if (provider === "custom" && customModelInput) customModelInput.value = model;
  if (cloudProvider) applyCloudProviderChange(provider === "custom" ? "" : model);
  // 工具执行回填（v3.14.0 云办公一期）
  const cloudToolsEnabled = document.querySelector("#cloud-tools-enabled");
  const cloudRunCommandEnabled = document.querySelector("#cloud-run-command-enabled");
  const cloudWorkingDirectory = document.querySelector("#cloud-working-directory");
  if (cloudToolsEnabled) cloudToolsEnabled.checked = Boolean(settings.cloudToolsEnabled);
  if (cloudRunCommandEnabled) cloudRunCommandEnabled.checked = Boolean(settings.cloudRunCommandEnabled);
  if (cloudWorkingDirectory) cloudWorkingDirectory.value = settings.cloudWorkingDirectory || "";
  // 云办公二期 v3.22.0：沙箱执行与临时联网回填
  const cloudSandboxEnabled = document.querySelector("#cloud-sandbox-enabled");
  const cloudSandboxNetwork = document.querySelector("#cloud-sandbox-network-enabled");
  if (cloudSandboxEnabled) cloudSandboxEnabled.checked = Boolean(settings.cloudSandboxEnabled);
  if (cloudSandboxNetwork) cloudSandboxNetwork.checked = Boolean(settings.cloudSandboxNetworkEnabled);
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
  // v3.18.0 F4：SSH 卡槽回填（活跃槽高亮 + 名称 + 两槽配置状态行）
  renderSshProfiles(settings);
  // v3.19.0 F3：高级设置三卡回填（自动/手动徽章 + 实值 + 适配器选中态）
  renderAdvancedPanels(settings);
}

// ── v3.18.0 F4：SSH 多卡槽（AO 0.9.6 同构 + ACP 切槽即落库语义） ──
const DEFAULT_SSH_PROFILE_NAMES = { "ssh-1": "卡槽 1", "ssh-2": "卡槽 2" };

// ── v3.19.0 F3：高级设置（网络/云端自动·手动两态 + SSH 连接适配器五选一） ──
const ADV_ADAPTER_META = {
  claude: { label: "Claude", note: "内置 agent-sdk-bridge / direct-cli 双链，无需在 NAS 上额外安装；模型页配置对它生效。" },
  atomcode: { label: "AtomCode", note: "通过 NAS 侧 atomcode daemon 调用（daemon 地址自动取当前 SSH 连接的 NAS IP），无需远端 CLI。" },
  qwen: { label: "Qwen Code", note: "NAS 需安装：npm install -g @qwen-code/qwen-code；附加参数可指定 -m 模型。" },
  codex: { label: "Codex", note: "NAS 需安装：npm install -g @openai/codex；附加参数可切沙箱（workspace-write / read-only）。" },
  hermes: { label: "Hermes", note: "NAS 需安装 hermes CLI（官方脚本或 NAS 容器内挂 PATH）；附加参数支持 --model 与 --provider。" }
};

let pendingAdapterKey = "claude";
let advancedSaving = false;

function setAdvBadge(panel, text, manual) {
  const badge = document.querySelector(`[data-adv-badge="${panel}"]`);
  if (!badge) return;
  badge.textContent = text;
  badge.classList.toggle("is-manual", Boolean(manual));
}

function advFieldValue(id, fallback) {
  const input = document.querySelector(id);
  if (!input || String(input.value ?? "").trim() === "") return fallback;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function advNetworkPatch() {
  return {
    ssh: {
      requestTimeoutMin: advFieldValue("#adv-ssh-request-timeout", 30),
      connectTimeoutSec: advFieldValue("#adv-ssh-connect-timeout", 15),
      sftpTimeoutSec: advFieldValue("#adv-ssh-sftp-timeout", 30),
      reconnectAttempts: advFieldValue("#adv-ssh-reconnect-attempts", 3),
      reconnectBaseMs: advFieldValue("#adv-ssh-reconnect-base", 600),
      keepaliveSec: advFieldValue("#adv-ssh-keepalive", 15),
      debugLog: Boolean(document.querySelector("#adv-ssh-debug-log")?.checked)
    },
    external: {
      n2n: {
        cipher: document.querySelector("#adv-n2n-cipher")?.value || "",
        compression: document.querySelector("#adv-n2n-compression")?.value || "",
        protocol: document.querySelector("#adv-n2n-protocol")?.value || "",
        headerEncryption: Boolean(document.querySelector("#adv-n2n-header-encryption")?.checked)
      }
    }
  };
}

function advCloudPatch() {
  return {
    cloud: {
      connectTimeoutSec: advFieldValue("#adv-cloud-connect-timeout", 120),
      streamIdleTimeoutSec: advFieldValue("#adv-cloud-stream-idle", 300),
      maxTokens: advFieldValue("#adv-cloud-max-tokens", 8192),
      maxRetries: advFieldValue("#adv-cloud-max-retries", 0),
      maxToolRounds: advFieldValue("#adv-cloud-tool-rounds", 25)
    }
  };
}

/** v3.24.4 修复①：对比 patch 与落盘值，收集被边界钳制的数字字段（中文标签如实告知） */
const ADV_FIELD_LABELS = {
  ssh: { requestTimeoutMin: "请求超时", connectTimeoutSec: "连接超时", sftpTimeoutSec: "SFTP 超时", reconnectAttempts: "重试次数", reconnectBaseMs: "退避基数", keepaliveSec: "保活间隔" },
  cloud: { connectTimeoutSec: "连接超时", streamIdleTimeoutSec: "流式空闲超时", maxRetries: "重试次数", maxToolRounds: "工具循环轮次", maxTokens: "输出上限 tokens" }
};

function collectClampedFields(patch, advanced) {
  const fixed = [];
  for (const groupKey of ["ssh", "cloud"]) {
    const patchGroup = patch[groupKey];
    const savedGroup = advanced[groupKey];
    if (!patchGroup || typeof patchGroup !== "object" || !savedGroup || typeof savedGroup !== "object") continue;
    for (const [field, label] of Object.entries(ADV_FIELD_LABELS[groupKey])) {
      const input = Number(patchGroup[field]);
      const saved = Number(savedGroup[field]);
      if (Number.isFinite(input) && Number.isFinite(saved) && input !== saved) fixed.push(label);
    }
  }
  return fixed;
}

async function saveAdvancedGroup(patch, successText) {
  if (advancedSaving) return;
  advancedSaving = true;
  try {
    const latest = await window.agentChatPro.loadSettings();
    const baseAdvanced = latest.advanced && typeof latest.advanced === "object" ? latest.advanced : {};
    const settings = await window.agentChatPro.saveSettings({ ...latest, advanced: { ...baseAdvanced, ...patch } });
    populateSettings(settings);
    const advanced = settings.advanced && typeof settings.advanced === "object" ? settings.advanced : {};
    // v3.24.4 修复①：手动组不再整组回退自动（字段级钳边界/补默认），旧"整组回退"文案清理；
    //   新增落盘差异提示——被钳到边界的字段如实告知（超界值修正后与输入框回填值一致可见）
    const rolled = [];
    if (patch.ssh && !advanced.ssh) rolled.push("SSH 连接");
    if (patch.external && !advanced.external) rolled.push("外网传输");
    if (patch.cloud && !advanced.cloud) rolled.push("云端模型");
    if (rolled.length) {
      setStatus(`已保存；但 ${rolled.join("、")} 参数缺失，已回退自动识别。`, true);
      return;
    }
    const corrected = collectClampedFields(patch, advanced);
    setStatus(corrected.length
      ? `已保存；${corrected.join("、")} 超出合法范围，已自动修正到边界值。`
      : successText, false);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    advancedSaving = false;
  }
}

function renderAdapterCard(adapterOptions = {}) {
  document.querySelectorAll("#adv-panel-adapter [data-adapter-key]").forEach((button) => {
    button.classList.toggle("active", button.dataset.adapterKey === pendingAdapterKey);
  });
  const meta = ADV_ADAPTER_META[pendingAdapterKey] || { label: pendingAdapterKey, note: "" };
  document.querySelector("#adapter-note").textContent = meta.note || "";
  const showModel = pendingAdapterKey === "qwen" || pendingAdapterKey === "hermes";
  const showSandbox = pendingAdapterKey === "codex";
  const showProvider = pendingAdapterKey === "hermes";
  document.querySelectorAll("#adapter-options [data-adapter-opt]").forEach((field) => {
    const kind = field.dataset.adapterOpt;
    field.hidden = kind === "model" ? !showModel : kind === "sandbox" ? !showSandbox : !showProvider;
  });
  document.querySelector("#adapter-options").hidden = !(showModel || showSandbox || showProvider);
  const modelValue = typeof adapterOptions.model === "string" ? adapterOptions.model : "";
  document.querySelector("#adapter-opt-model").value = modelValue;
  document.querySelector("#adapter-opt-sandbox").value = adapterOptions.sandbox === "read-only" ? "read-only" : "";
  document.querySelector("#adapter-opt-provider").value = typeof adapterOptions.provider === "string" ? adapterOptions.provider : "";
}

function renderAdvancedPanels(settings) {
  const advanced = settings.advanced && typeof settings.advanced === "object" ? settings.advanced : {};
  const effective = settings.advancedEffective || {};
  const effSsh = effective.ssh || {};
  document.querySelector("#adv-ssh-request-timeout").value = advanced.ssh?.requestTimeoutMin ?? effSsh.requestTimeoutMin ?? 30;
  document.querySelector("#adv-ssh-connect-timeout").value = advanced.ssh?.connectTimeoutSec ?? effSsh.connectTimeoutSec ?? 15;
  document.querySelector("#adv-ssh-sftp-timeout").value = advanced.ssh?.sftpTimeoutSec ?? effSsh.sftpTimeoutSec ?? 30;
  document.querySelector("#adv-ssh-reconnect-attempts").value = advanced.ssh?.reconnectAttempts ?? effSsh.reconnectAttempts ?? 3;
  document.querySelector("#adv-ssh-reconnect-base").value = advanced.ssh?.reconnectBaseMs ?? effSsh.reconnectBaseMs ?? 600;
  document.querySelector("#adv-ssh-keepalive").value = advanced.ssh?.keepaliveSec ?? effSsh.keepaliveSec ?? 15;
  document.querySelector("#adv-ssh-debug-log").checked = Boolean(advanced.ssh?.debugLog ?? effSsh.debugLog);
  const effN2n = effective.external?.n2n || {};
  document.querySelector("#adv-n2n-cipher").value = advanced.external?.n2n?.cipher ?? effN2n.cipher ?? "";
  document.querySelector("#adv-n2n-compression").value = advanced.external?.n2n?.compression ?? effN2n.compression ?? "";
  document.querySelector("#adv-n2n-protocol").value = advanced.external?.n2n?.protocol ?? effN2n.protocol ?? "";
  document.querySelector("#adv-n2n-header-encryption").checked = Boolean(advanced.external?.n2n?.headerEncryption ?? effN2n.headerEncryption);
  setAdvBadge("network", advanced.ssh || advanced.external ? "手动" : "自动识别", Boolean(advanced.ssh || advanced.external));

  const effCloud = effective.cloud || {};
  document.querySelector("#adv-cloud-connect-timeout").value = advanced.cloud?.connectTimeoutSec ?? effCloud.connectTimeoutSec ?? 120;
  document.querySelector("#adv-cloud-stream-idle").value = advanced.cloud?.streamIdleTimeoutSec ?? effCloud.streamIdleTimeoutSec ?? 300;
  document.querySelector("#adv-cloud-max-tokens").value = advanced.cloud?.maxTokens ?? effCloud.maxTokens ?? 8192;
  document.querySelector("#adv-cloud-max-retries").value = advanced.cloud?.maxRetries ?? effCloud.maxRetries ?? 0;
  document.querySelector("#adv-cloud-tool-rounds").value = advanced.cloud?.maxToolRounds ?? effCloud.maxToolRounds ?? 25;
  setAdvBadge("cloud", advanced.cloud ? "手动" : "自动识别", Boolean(advanced.cloud));

  const adapter = String(advanced.adapter || effective.adapter || "claude");
  pendingAdapterKey = ["claude", "atomcode", "qwen", "codex", "hermes"].includes(adapter) ? adapter : "claude";
  renderAdapterCard(effective.adapterOptions || {});
  setAdvBadge("adapter", `${(ADV_ADAPTER_META[pendingAdapterKey] || { label: pendingAdapterKey }).label}${advanced.adapter ? "（手动选择）" : "（内置默认）"}`, Boolean(advanced.adapter));
}

function renderAdapterDetect(results) {
  const box = document.querySelector("#adapter-detect-result");
  if (!Array.isArray(results) || !results.length) { box.hidden = true; box.textContent = ""; return; }
  const rows = [];
  for (const item of results) {
    const meta = ADV_ADAPTER_META[item.key] || { label: item.key };
    const row = document.createElement("div");
    row.className = "adv-detect-row";
    const name = document.createElement("span");
    name.textContent = meta.label;
    const state = document.createElement("strong");
    state.textContent = item.status === "builtin" ? "✅ 内置" : item.status === "installed" ? "✅ 已安装" : "❌ 未安装";
    row.append(name, state);
    const hint = item.status === "missing" ? item.installHint : item.status === "builtin" ? item.detail : item.path ? `路径：${item.path}` : "";
    if (hint) {
      const note = document.createElement("span");
      note.className = "field-hint";
      note.textContent = hint;
      row.append(note);
    }
    rows.push(row);
  }
  box.replaceChildren(...rows);
  box.hidden = false;
}

function slotProfileLabel(slot) {
  if (!slot?.configured) return `${DEFAULT_SSH_PROFILE_NAMES[slot?.id] || slot?.id}：未配置`;
  const name = slot.name ? `「${slot.name}」` : "";
  return `${DEFAULT_SSH_PROFILE_NAMES[slot?.id] || slot?.id}${name}：${slot.host || "未填地址"}${slot.hasPassword ? " · 已存密码" : " · 无密码"}`;
}

function renderSshProfiles(settings) {
  const profiles = Array.isArray(settings.sshProfiles) ? settings.sshProfiles : [];
  if (!profiles.length) return;
  const active = settings.activeSshProfile || "ssh-1";
  document.querySelectorAll("#ssh-profile-switch [data-ssh-profile-id]").forEach((button) => {
    const id = button.dataset.sshProfileId;
    const slot = profiles.find((entry) => entry.id === id);
    button.classList.toggle("active", id === active);
    button.textContent = slot?.name || DEFAULT_SSH_PROFILE_NAMES[id] || id;
  });
  const nameInput = document.querySelector("#ssh-profile-name");
  const hidden = document.querySelector("#active-ssh-profile");
  const activeSlot = profiles.find((entry) => entry.id === active);
  if (nameInput && document.activeElement !== nameInput) nameInput.value = activeSlot?.name || "";
  if (hidden) hidden.value = active;
  for (const slot of profiles) {
    const info = document.querySelector(`#ssh-profile-slot-info-${slot.id === "ssh-2" ? "2" : "1"}`);
    if (info) info.textContent = slotProfileLabel(slot);
  }
}

document.querySelector("#ssh-profile-switch").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-ssh-profile-id]");
  if (!button || button.classList.contains("active")) return;
  if (currentConnectionMode !== "ssh") { setConnection("先切回 SSH 远程模式再切换卡槽。", "error"); return; }
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = "切换…";
  try {
    const next = await window.agentChatPro.switchSshProfile(button.dataset.sshProfileId);
    populateSettings(next);
    setConnection(`已切换到${DEFAULT_SSH_PROFILE_NAMES[next.activeSshProfile]}：${next.host ? next.host : "（未配置）"}`, next.host ? "connected" : "error");
    // 卡槽各自一套 Claude 会话——刷新当前对话的会话归属显示
    if (conversationId && conversationCache.some((item) => item.id === conversationId)) await loadConversation(conversationId);
  } catch (error) {
    setConnection("切换卡槽失败：" + error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
});

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
  document.querySelector("#device-control-settings").hidden = isLocal || isCloud || editionState.gates.deviceLink === false;
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
    ? (document.querySelector("#cloud-tools-enabled")?.checked
      ? "云端模式已开启工具执行：AI 可在您配置的工作目录内读写文件（命令执行需单独开启）。API 密钥仅保存在本地。"
      : "云端模式仅传输文本消息，不执行任何本地或远程命令。API 密钥仅保存在本地。")
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
  renderDeviceControlCoexistence(status.coexistence);
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

// ── v3.17.0 IP 追踪状态卡（读 NAS 侧 ip-track.log，重定位记录可视化） ──
function renderDeviceControlIpTrack(result) {
  const box = document.querySelector("#device-control-ip-track");
  if (!box) return;
  if (!result || !Array.isArray(result.entries)) { box.hidden = true; box.textContent = ""; return; }
  const lines = [];
  if (!result.entries.length) {
    lines.push("IP 追踪已随 v3.17.0 部署：NAS 侧连接本机失败且错误属网络类时，会自动扫描网段并用 SSH 主机键指纹定位新 IP 后重连一次（公钥链路不变，只动「去哪找」）。尚未发生重定位，故无记录。");
  } else {
    lines.push("最近 IP 重定位（最多显示 5 条，公钥链路未变更）：");
    for (const entry of result.entries) {
      const time = String(entry.time || "").replace("T", " ").slice(0, 19);
      lines.push(`${time} · ${entry.from || "?"} → ${entry.to || "?"} · 指纹 ${String(entry.fingerprint || "").replace("SHA256:", "").slice(0, 16)}…`);
    }
  }
  box.textContent = lines.join("\n");
  box.hidden = false;
}

function refreshDeviceControlIpTrack(deviceId) {
  const box = document.querySelector("#device-control-ip-track");
  if (!box || !deviceId) return;
  window.agentChatPro.readDeviceControlIpTrack(deviceId)
    .then((result) => renderDeviceControlIpTrack(result))
    .catch(() => { box.hidden = true; box.textContent = ""; });
}

// ── v3.16.2 双控件共存扫描结果渲染（使用时扫描的可视面） ──
function renderDeviceControlCoexistence(coexistence) {
  const box = document.querySelector("#device-control-coexistence");
  if (!box) return;
  box.classList.remove("conflict");
  if (!coexistence || !coexistence.coexistence) { box.hidden = true; box.textContent = ""; return; }
  const lines = [];
  const other = (coexistence.families || []).find((family) => family.id === "claude-nas-line");
  if (coexistence.otherFamilyInUse && other) {
    lines.push(`检测到另一套联动控件在使用中：${other.label}（账号 ${other.account}${other.installedAt ? `，安装于 ${String(other.installedAt).slice(0, 10)}` : ""}）。双方已互相隔离：本应用的安装/卸载流程不会删改对方资源。`);
  } else if (coexistence.legacyOrphan && other) {
    lines.push(`检测到旧版联动控件遗留：${other.label}（无人认领）。下次卸载本应用控件时，Windows 弹窗里可选择是否连带清理。`);
  }
  for (const conflict of coexistence.conflicts || []) lines.push(`⚠ ${conflict.message}`);
  if (!lines.length) { box.hidden = true; box.textContent = ""; return; }
  box.textContent = lines.join("\n");
  box.hidden = false;
  if (coexistence.conflicts && coexistence.conflicts.length) box.classList.add("conflict");
}

async function refreshDeviceControlStatus() {
  let status = null;
  try { status = await window.agentChatPro.getDeviceControlStatus(); renderDeviceControlStatus(status); }
  catch (error) { document.querySelector("#device-control-info").textContent = "状态检查失败：" + error.message; return; }
  // v3.17.0 IP 追踪卡：异步加载不阻塞状态渲染（需读 NAS 远程日志，较慢；失败静默收起）
  if (status && status.supported && status.deviceId) refreshDeviceControlIpTrack(status.deviceId);
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
  // v3.24.0 修复「无论调哪个模式图标一直是护盾」：composerModeTrigger 的图标/标题/样式
  // 不再在此按全局 skipPermissions 二值覆盖——图标渲染权统一收归 updateModeDisplay（按 mode.icon）。
  // 背景：populateSettings（全局设置回填）在模式切换保存后调用此处，旧全局布尔值与 workModeId 解耦，
  // 用户切到 ⚡自动化/🌿ECO 也永远被改写回 🛡（全局 false）。本函数只保留工作态布尔+拒授工具刷新。
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
// v3.21.3 修复①：单条消息 token 口径——云端消息带累计 usage（cumulative）时用服务商真实账目，
// 其余（含 SSH/local 与无 usage 旧消息）维持估算文本
function tokensForMessage(msg) {
  if (msg?.usage && msg.usage.cumulative === true) {
    return Number(msg.usage.totalTokens ?? msg.usage.total_tokens ?? 0) || 0;
  }
  return estimateTokens(msg.text || "");
}
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
  // v3.15.1：streaming 态仅当进行中任务属于当前显示的对话（后台任务不点亮当前计数器）
  counter.classList.toggle("streaming", Boolean(activeId && streamingConversationId === conversationId));
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
  let percent = 0;
  if (limit) {
    percent = Math.min(100, (contextTokens / limit) * 100);
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
  // v3.40.0（ChatGPT UX 方案）：≥85% 主动预警——90% 起危险色已是强信号，此处在其之前给出下一步（自动压缩/新开对话）
  if (percent >= 85 && percent < 90) parts.push("上下文接近上限——建议开启自动压缩或新开对话");
  detailEl.textContent = parts.join(" · ");
}

function resetContextBar() {
  contextTokens = 0;
  contextLimit = 0;
  compactingNow = false;
  renderContextBar();
}

function addMessage(kind, text = "", meta = {}) {
  elements.empty.hidden = true;
  const item = document.createElement("article");
  item.className = `message ${kind}`;
  // v3.35.6 群聊：成员名牌 header（assistant 消息带 meta.agent 时渲染 @成员名 + 类型徽章；
  // 模块二独立精神的界面体现——每个发言肉眼可辨归属，A 绝不冒充 B）
  if (meta.agent?.name) {
    item.classList.add("group-agent");
    const head = document.createElement("div");
    head.className = "agent-tag";
    const kindLabel = meta.agent.kind === "cloud" ? "云端" : meta.agent.kind === "ssh" ? "SSH" : meta.agent.kind === "ghost" ? "缺席" : "本机";
    head.textContent = `@${meta.agent.name} · ${kindLabel}`;
    // 成员配色（按名字哈希取色，亮暗主题均用主题内变量）
    item.dataset.agentName = meta.agent.name;
    head.classList.add(`agent-kind-${meta.agent.kind || "cloud"}`);
    item.append(head);
  }
  // v3.35.6 模块四：子 Agent 汇报=轻注记（样式弱化，可读但不当主角）
  if (meta.senderType === "subagent-result") {
    item.classList.add("subagent-note");
  }
  // 阉割版 Bridge Edition：云端AI 经 HTTP 桥注入的消息——气泡顶部强制徽章（文本本体另带
  // 「【云端AI消息 · 非用户本人】」前缀，双保险：前缀进 NAS Agent 上下文，徽章防人看走眼）
  if (meta.senderType === "cloud-ai") {
    const badge = document.createElement("div");
    badge.className = "cloudai-badge";
    badge.textContent = "🤖 云端AI发送 · 非用户本人";
    item.append(badge);
  }
  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = text;
  item.append(content);
  // 右键菜单替代悬浮操作栏
  item.addEventListener("contextmenu", (event) => showMessageContextMenu(event, item, kind));
  // v3.15.2 修复：v3.15.0 改智能滚动时误删了挂载行，消息从不进 DOM → 聊天区空白 + token 计数器上浮到 header（右上角假象）
  elements.messages.append(item);
  // v3.15.0 智能滚动：自己发的消息（user）始终滚底；其他（assistant/工具卡出现）仅当用户已在底部附近才跟随
  if (kind.startsWith("user") || isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
  return item;
}

/** 用户是否停在聊天区底部附近（v3.15.0：Agent 输出时只有贴底才自动跟随，上滚看历史不再被拉回） */
function isNearBottom() {
  const el = elements.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

/**
 * v3.15.7 链接统一接管 — 防止主窗口被外链劫持（用户无返回键，被劫持后只能关掉应用重开）。
 * 背景：设置页 #cloud-key-hint 的服务商注册链接（deepseek/智谱等）没接拦截，Electron 默认行为
 * 是主窗口内部导航 → 整个聊天 UI 被替换成外部网站。此容器内所有 <a href> 一律 preventDefault
 * + openLink（IPC → shell.openExternal 走系统浏览器）；href 为空或 "#" 只拦不放。
 */
function bindExternalLinks(container, onError) {
  container?.querySelectorAll?.("a[href]").forEach((link) => {
    const href = (link.getAttribute("href") || "").trim();
    if (href === "" || href === "#") return; // 静态占位死链：拦截交给主进程兜底，不弹浏览器
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.agentChatPro.openLink(link.getAttribute("href")).catch((error) => { if (onError) onError(error); });
    });
  });
}

async function renderAssistant(item, text, renderOptions = {}) {
  const content = item.querySelector(".message-content");
  // v3.20.0 F5：```plan 约定块抽离渲染 Agent plan 面板（正文剥离该块不再重复显示；
  // 同消息内多个块只取最后一块=最新全局进度；AI 没输出 plan 块则零渲染）
  const plan = extractPlanBlocks(text);
  if (plan.hasPlan) renderPlanPanel(item, plan.last.map((line, i) => ({ index: i + 1, text: line, status: "" })), false);
  // v3.25.0：```ask_user 约定块抽离渲染选择卡（本函数是全部模式 assistant 正文唯一汇聚点
  // —— 云端真悬等工具卡之外，SSH/本机 claude/atomcode/custom 只要模型输出块即渲染；
  // 历史重放 static 定格禁点，本轮流式可点点选=发新消息）
  const asks = extractAskBlocks(plan.rest);
  asks.blocks.forEach((block) => renderAskBlockCard(item, block, Boolean(renderOptions.static)));
  content.innerHTML = await window.agentChatPro.renderMarkdown(asks.rest);
  content.classList.add("rendered");
  bindExternalLinks(content, (error) => alert(error.message));
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

// v3.21.3 修复②：跨轮徽标（历史不做轮次重建——工具牌连排天然分组；本轮流式实时插入）
function appendRoundMark(answer, round, mark) {
  if (!answer) return;
  const node = document.createElement("div");
  node.className = "round-mark" + (mark ? " round-mark--notice" : "");
  // v3.24.9：可选自定义文案（截断自动续写提示）；缺省仍是轮次徽标
  node.textContent = mark ? String(mark) : `— 第 ${Number(round) || 1} 轮工具 —`;
  answer.append(node);
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
}

// v3.21.3 修复②：v3.15.5~v3.21.2 期间注入正文的独立 `---` 分隔行剥除（只对带工具牌的云端消息调用）
function stripSeparatorLines(text) {
  return String(text || "").replace(/^[ \t]*-{3,}[ \t]*\n/gm, "\n").replace(/^[ \t]*-{3,}[ \t]*$/gm, "");
}

/* ── v3.24.0 思考过程折叠块 + AI 选择题提问卡片 ── */

/** v3.24.5 思考程度标签（豆包同款五档、不自创）：模型原生思考流无程度元数据，按思考字数启发式映射 */
const THINK_DEPTH_TIERS = [
  { min: 15000, label: "thinking continuously" },
  { min: 5000, label: "thinking most" },
  { min: 2000, label: "thinking more" },
  { min: 500, label: "thinking" },
  { min: 0, label: "little thinking" }
];

function thinkDepthLabel(words) {
  const n = Number(words) || 0;
  return (THINK_DEPTH_TIERS.find((tier) => n >= tier.min) || THINK_DEPTH_TIERS[THINK_DEPTH_TIERS.length - 1]).label;
}

/** 确保 assistant 气泡有思考折叠块（挂正文正上方；工具牌区仍在最上、plan 面板位置不变） */
function ensureThinkingBlock(item) {
  const content = item.querySelector(".message-content");
  let block = item.querySelector(".thinking-block");
  if (!block) {
    block = document.createElement("details");
    block.className = "thinking-block";
    const summary = document.createElement("summary");
    summary.textContent = "💭 思考过程";
    const body = document.createElement("div");
    body.className = "thinking-body";
    block.append(summary, body);
    if (content) content.before(block); else item.append(block);
  }
  return block;
}

/** 流式思考增量（chat:event type:"thinking"）：折叠块正文追加 + 计数标题刷新；v3.24.5 记思考流起止时刻（真耗时测思考时窗，不含正文输出） */
function appendThinkingDelta(item, text) {
  if (!item || !text) return;
  const block = ensureThinkingBlock(item);
  const body = block.querySelector(".thinking-body");
  body.textContent += String(text);
  const now = performance.now();
  if (!block.dataset.thinkT0) block.dataset.thinkT0 = String(now);
  block.dataset.thinkT1 = String(now);
  block.querySelector("summary").textContent = `💭 思考过程（${body.textContent.length} 字 · 进行中…）`;
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
}

/** 静态思考块渲染（历史重放 msg.thinking；落库无耗时 → 标题只带字数+程度） */
function renderStaticThinking(item, thinking) {
  const value = String(thinking || "");
  if (!value.trim()) return;
  const block = ensureThinkingBlock(item);
  const body = block.querySelector(".thinking-body");
  body.textContent = value;
  block.querySelector("summary").textContent = `💭 思考过程（${value.length} 字 · 🧠 ${thinkDepthLabel(value.length)}）`;
}

/** turn 终态：把「进行中…」字样收敛为定稿计数 + v3.24.5 元信息（⏱ 耗时=首末思考增量时窗差，一位小数；无时间数据时省略耗时段） */
function finalizeThinkingSummary(item) {
  if (!item) return;
  const block = item.querySelector(".thinking-block");
  if (!block) return;
  const body = block.querySelector(".thinking-body");
  if (!body || !body.textContent) return;
  const words = body.textContent.length;
  const t0 = Number(block.dataset.thinkT0);
  const t1 = Number(block.dataset.thinkT1);
  const secs = Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0 ? Number(((t1 - t0) / 1000).toFixed(1)) : null;
  const elapsed = secs !== null ? ` · ⏱ ${secs}s` : "";
  block.querySelector("summary").textContent = `💭 思考过程（${words} 字${elapsed} · 🧠 ${thinkDepthLabel(words)}）`;
}

/* ── v3.24.6 开发面板（右侧实时观察 AI 编辑中的文件；三模式共用工具事件流） ── */

const DEV_PANEL_WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "write_file", "edit_file", "append_file"]);
const DEV_PANEL_READ_TOOLS = new Set(["Read", "read_file", "list_directory", "Glob", "Grep"]);
const DEV_PANEL_PATH_KEYS = ["file_path", "path", "notebook_path", "filePath", "notebookPath"];
const DEV_PANEL_ROLE_DESC = {
  assist: "人主机辅：AI 只是帮忙检查漏洞，和回答问题",
  lead: "机主人辅：AI 干活，用户用来监督和观察"
};
const DEV_PANEL_FEED_LIMIT = 30;

/** 工作区文件活动账本（key=文件路径；不随会话切换清空——面板是工作区视角） */
const devPanelItems = new Map();

function devPanelToolPath(tool) {
  const input = tool?.input && typeof tool.input === "object" ? tool.input : {};
  for (const key of DEV_PANEL_PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function devPanelBasename(p) {
  const raw = String(p || "");
  const idx = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

/** 工具事件→账本记账（纯逻辑；返回 true=已入账本，调用方决定是否刷新 DOM） */
function devPanelAccount(tool) {
  if (!tool || typeof tool !== "object") return false;
  const name = String(tool.name || "");
  const write = DEV_PANEL_WRITE_TOOLS.has(name);
  const read = !write && DEV_PANEL_READ_TOOLS.has(name);
  if (!write && !read) return false;
  const filePath = devPanelToolPath(tool);
  if (!filePath) return false;
  const status = String(tool.status || "running");
  const entry = devPanelItems.get(filePath) || { path: filePath, name: devPanelBasename(filePath), op: write ? "edit" : "read", lastStatus: "idle", lastTs: 0, running: new Set() };
  if (status === "running") {
    if (write) entry.op = "edit";
    entry.running.add(String(tool.id || ""));
    entry.lastStatus = "queued";
  } else {
    entry.running.delete(String(tool.id || ""));
    entry.lastStatus = status === "failed" || status === "denied" ? "failed" : status === "completed" ? "ok" : "idle";
  }
  entry.lastTs = Date.now();
  entry.lastTool = name;
  devPanelItems.set(filePath, entry);
  return true;
}

function devPanelClock(ts) {
  const d = new Date(Number(ts) || Date.now());
  const two = (v) => String(v).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 面板 DOM 渲染：空态/正在编辑/最近活动 + 折叠窄条小进度同步 */
function renderDevPanel() {
  const empty = document.querySelector("#dev-empty");
  const active = document.querySelector("#dev-active");
  const activeFile = document.querySelector("#dev-active-file");
  const feed = document.querySelector("#dev-feed");
  const railDot = document.querySelector("#dev-rail-dot");
  const railLabel = document.querySelector("#dev-rail-label");
  if (!empty || !active || !activeFile || !feed) return;
  const items = [...devPanelItems.values()].sort((a, b) => b.lastTs - a.lastTs);
  if (!items.length) {
    empty.hidden = false;
    active.hidden = true;
    feed.replaceChildren();
    if (railDot) railDot.classList.remove("busy");
    if (railLabel) railLabel.textContent = "开发";
    return;
  }
  empty.hidden = true;
  const editing = items.find((it) => it.op === "edit" && it.running.size > 0);
  active.hidden = !editing;
  if (editing) {
    activeFile.textContent = editing.path;
    activeFile.title = editing.path;
  }
  if (railDot) railDot.classList.toggle("busy", Boolean(editing));
  if (railLabel) railLabel.textContent = editing ? devPanelBasename(editing.path) : "开发";
  feed.replaceChildren();
  for (const it of items.slice(0, DEV_PANEL_FEED_LIMIT)) {
    const row = document.createElement("div");
    row.className = "dev-feed-row";
    const dot = document.createElement("span");
    dot.className = "dev-feed-dot " + (it.running.size > 0 ? "queued" : it.lastStatus === "failed" ? "failed" : it.op === "edit" ? "edit" : "read");
    const name = document.createElement("span");
    name.className = "dev-feed-name";
    name.textContent = it.name;
    name.title = it.path;
    const op = document.createElement("span");
    op.className = "dev-feed-op";
    op.textContent = it.op === "edit" ? (it.running.size > 0 ? "编辑中" : "已编辑") : (it.running.size > 0 ? "查看中" : "已查看");
    const time = document.createElement("span");
    time.className = "dev-feed-time";
    time.textContent = devPanelClock(it.lastTs);
    row.append(dot, name, op, time);
    feed.append(row);
  }
}

/** 主备模式 pill 渲染与记忆 */
function renderDevPanelRole(role) {
  const norm = role === "lead" ? "lead" : "assist";
  const on = document.querySelector(norm === "lead" ? "#dev-role-lead" : "#dev-role-assist");
  const off = document.querySelector(norm === "lead" ? "#dev-role-assist" : "#dev-role-lead");
  if (on) on.classList.add("active");
  if (off) off.classList.remove("active");
  const desc = document.querySelector("#dev-role-desc");
  if (desc) desc.textContent = DEV_PANEL_ROLE_DESC[norm];
  localStorage.setItem("acp-dev-panel-role", norm);
}

/** 选择题卡片构建（云端 ipc 应答 / SSH 近似回发两个通道共用骨架；disabled=历史定格） */
function buildAskUserCard(payload, disabled, onPick) {
  const card = document.createElement("div");
  card.className = "ask-card";
  const label = document.createElement("div");
  label.className = "ask-label";
  label.textContent = "❓ AI 向你提问（单选）";
  const question = document.createElement("div");
  question.className = "ask-question";
  question.textContent = payload.question || "";
  const row = document.createElement("div");
  row.className = "ask-options";
  card.append(label, question, row);
  for (const optionText of payload.options || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ask-option";
    button.textContent = optionText;
    button.disabled = Boolean(disabled);
    if (disabled) button.classList.add("dim");
    button.addEventListener("click", () => onPick(card, button, String(optionText)));
    row.append(button);
  }
  return card;
}

/** 点选后的视觉定格（选中高亮 + 其余压暗 + 「已选择」注记） */
function markAskCardAnswered(card, button, optionText) {
  card.classList.add("answered");
  card.querySelectorAll(".ask-option").forEach((other) => {
    other.disabled = true;
    if (other !== button) other.classList.add("dim");
  });
  button.classList.add("picked");
  const note = document.createElement("div");
  note.className = "ask-picked-note";
  note.textContent = `已选择：${optionText}`;
  card.append(note);
  return note;
}

/** 云端选择卡：点选 → IPC ask-user:answer → 工具循环悬等 resolve，AI 拿到选择继续 */
function renderCloudAskUserCard(item, event) {
  if (!item || item.querySelector(".ask-card")) return;
  const card = buildAskUserCard(event, false, async (cardEl, button, optionText) => {
    if (cardEl.classList.contains("answered")) return;
    const note = markAskCardAnswered(cardEl, button, optionText);
    try {
      const result = await window.agentChatPro.answerAskUser({ callId: event.callId, label: optionText });
      if (result && result.ok === false) {
        note.textContent = "该提问已失效（已超时或任务已停止），请直接输入回复。";
        note.classList.add("stale");
      }
    } catch (error) {
      note.textContent = `应答失败：${error.message}，请直接输入回复。`;
      note.classList.add("stale");
    }
  });
  item.append(card);
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
}

/** SSH 特化选择卡（claude AskUserQuestion 工具事件）：点选=把选择作为新消息发出（体验一致近似） */
function renderSshAskUserCard(item, tool) {
  if (!item || item.querySelector(".ask-card")) return;
  const input = tool?.input && typeof tool.input === "object" ? tool.input : {};
  const first = Array.isArray(input.questions) && input.questions.length ? input.questions[0] : {};
  const rawOptions = Array.isArray(input.options) && input.options.length ? input.options : Array.isArray(first.options) ? first.options : [];
  const options = rawOptions
    .map((option) => (typeof option === "string" ? option : option && option.label ? String(option.label) : ""))
    .filter(Boolean)
    .slice(0, 4);
  const done = tool?.status === "completed";
  const card = buildAskUserCard(
    { question: String(input.question || first.question || ""), options },
    Boolean(done), // 历史消息定格禁用；进行中可点（点选时 busy 兜底回滚+提示）
    (cardEl, button, optionText) => {
      if (cardEl.classList.contains("answered")) return;
      if (activeId) {
        // 任务仍在处理：回滚视觉，提示手动发送（SSH print 链路没有悬等回传通道）
        cardEl.classList.remove("answered");
        cardEl.querySelectorAll(".ask-option").forEach((other) => { other.disabled = false; });
        cardEl.querySelector(".ask-picked-note")?.remove();
        setConnection("任务仍在处理中；请等待结束或直接在输入栏发送你的选择。", "connected");
        return;
      }
      markAskCardAnswered(cardEl, button, optionText);
      sendMessage(`我选择：${optionText}`);
    }
  );
  // 历史消息（定格）一律禁用；进行中任务先禁用防止误点（busy 检查兜底仍保留）
  if (done) card.querySelectorAll(".ask-option").forEach((other) => { other.disabled = true; other.classList.add("dim"); });
  item.append(card);
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
}

/** SSH AskUserQuestion 工具识别（本机 claude 引擎同款工具名） */
function isAskUserTool(tool) {
  return String(tool?.name || "") === "AskUserQuestion";
}

function renderTool(item, tool) {
  // v3.20.0 F5：TodoWrite 走 Agent plan 面板特化渲染（结构化路=SSH 远程+本机 claude 引擎），
  // 不进通用工具卡列表、不计入 finalizeToolList 的「已执行 N 个操作」
  if (isPlanTool(tool)) {
    renderPlanPanel(item, planTodosFromTool(tool), true);
    return;
  }
  // v3.24.0 功能B：AskUserQuestion 工具 → 气泡内嵌选择题卡片（不进通用工具牌列表）
  if (isAskUserTool(tool)) {
    renderSshAskUserCard(item, tool);
    return;
  }
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

// ══════════ v3.20.0 F5 Agent plan 面板（三模式共用一套组件） ══════════
// 结构化路（SSH 远程 + 本机 claude 引擎）：工具管线 TodoWrite 的 input.todos
//   [{content, status: pending|in_progress|completed, activeForm}] → 特化渲染
// 约定路（云端 AI + 本机 atomcode/custom 引擎）：assistant 文本中的 ```plan 块
//   （云端由 plan-convention.cjs 注入约定；atomcode/custom 无 system prompt 通道，
//   模型若按约定输出 plan 块即被渲染层检测渲染——严格「AI 列了才显示」）

const PLAN_ITEM_ICONS = { pending: "○", in_progress: "●", completed: "✓" };

function isPlanTool(tool) {
  return String(tool?.name || "").trim().toLowerCase() === "todowrite";
}

function normalizePlanItemStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  return PLAN_ITEM_ICONS[value] ? value : "pending";
}

/** TodoWrite input 形状容错：input 为对象或 JSON 字符串（不同 adapter 事件流形状不一），
 *  空条目剔除后连续重编号（显示序号 = 面板序号） */
function planTodosFromTool(tool) {
  let input = tool?.input;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = null; } }
  const todos = Array.isArray(input?.todos) ? input.todos : [];
  return todos
    .map((todo) => {
      const source = typeof todo === "string" ? { content: todo } : (todo && typeof todo === "object" ? todo : {});
      const content = String(source.content ?? source.text ?? source.description ?? "").trim();
      const activeForm = String(source.activeForm ?? "").trim();
      if (!content && !activeForm) return null;
      return { text: content || activeForm, activeForm, status: normalizePlanItemStatus(source.status), source };
    })
    .filter(Boolean)
    .map((entry, i) => ({ ...entry, index: i + 1 }));
}

/** 约定路：抽离 assistant 文本中的 ```plan 块。同消息内多个块 → 全部剥出正文、
 *  内容只取最后一块（= 最新全局进度，「新一轮覆盖上一轮，不做历史堆积」） */
function extractPlanBlocks(text) {
  const value = typeof text === "string" ? text : "";
  const blocks = [];
  const rest = value.replace(/```[ \t]*plan[ \t]*\r?\n([\s\S]*?)```/g, (_match, body) => {
    const items = String(body).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .map((line) => line.replace(/^\d+\s*[.)、:：]\s*/, "").trim())
      .filter(Boolean);
    if (items.length) blocks.push(items);
    return "";
  });
  return { rest: rest.trim(), blocks, hasPlan: blocks.length > 0, last: blocks.length ? blocks[blocks.length - 1] : null };
}

/** 约定路：抽离 assistant 文本中的 ```ask_user 块（v3.25.0 AI 选择题三模式补全）。
 *  全部块剥出正文（不重复显示原始代码块）；解析形态：首行「问题：」一句话 +
 *  随后编号选项行（1. 2. 3. / - 列表均可，行内「——」说明保留显示，最多取 4 项）；
 *  容错：AI 省略「问题：」前缀时首行即问题。返回 {blocks:[{question,options}], rest} */
function extractAskBlocks(text) {
  const value = typeof text === "string" ? text : "";
  const blocks = [];
  const rest = value.replace(/```[ \t]*ask_user[ \t]*\r?\n([\s\S]*?)```/g, (_match, body) => {
    const lines = String(body).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const isQuestionLine = (line) => /^(?:问题|question)\s*[:：]/i.test(line);
    const questionLine = lines.find(isQuestionLine);
    const question = questionLine
      ? questionLine.replace(/^(?:问题|question)\s*[:：]\s*/i, "").trim()
      : (lines[0] || "").replace(/^(?:问题|question)\s*[:：]\s*/i, "").trim();
    // 选项行来源：有「问题：」行时取其余行；无前缀形态时首行是问题、其余是选项
    const optionSource = (questionLine ? lines.filter((line) => line !== questionLine) : lines.slice(1))
      .filter((line) => !isQuestionLine(line)); // 容错：块内混入第二个「问题：」行不当选项
    const options = optionSource
      .map((line) => line.replace(/^(?:\d+\s*[.)、:：]|[-•*])\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 4);
    if (question && options.length) blocks.push({ question, options });
    return "";
  });
  return { blocks, rest: rest.trim(), hasAsk: blocks.length > 0 };
}

/** ask 约定块选择卡渲染：与 SSH 特化卡同款交互（busy 时回滚提示等待/闲时点选=发新消息）；
 *  块卡带 ask-conv-card 附加类做幂等（同气泡一张），与云端工具卡/SSH 工具事件卡共用骨架互不冲突 */
function renderAskBlockCard(item, block, disabled) {
  if (!item || item.querySelector(".ask-conv-card")) return;
  const card = buildAskUserCard(
    { question: String(block?.question || ""), options: Array.isArray(block?.options) ? block.options : [] },
    Boolean(disabled), // 历史消息定格禁点；本轮流式可点（busy 兜底回滚+提示）
    (cardEl, button, optionText) => {
      if (cardEl.classList.contains("answered")) return;
      if (activeId) {
        // 任务仍在处理：回滚视觉，提示手动发送（约定块路没有悬等回传通道）
        cardEl.classList.remove("answered");
        cardEl.querySelectorAll(".ask-option").forEach((other) => { other.disabled = false; });
        cardEl.querySelector(".ask-picked-note")?.remove();
        setConnection("任务仍在处理中；请等待结束或直接在输入栏发送你的选择。", "connected");
        return;
      }
      markAskCardAnswered(cardEl, button, optionText);
      sendMessage(`我选择：${optionText}`);
    }
  );
  card.classList.add("ask-conv-card");
  item.append(card);
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
}

/** 新一轮 plan 面板出现时，把会话内其他消息上的旧面板收成紧凑态（用户点开仍可回看历史） */
function supersedeOtherPlanPanels(currentItem) {
  document.querySelectorAll(".plan-panel").forEach((panel) => {
    if (panel.closest?.("article.message") === currentItem) return;
    panel.classList.add("superseded", "collapsed");
  });
}

/**
 * Agent plan 面板渲染（原位更新：同一条消息只保留一个面板，多条 TodoWrite/多块 plan
 * 数据覆盖到同一面板上；面板插在工具区之下、正文之上）
 * @param {HTMLElement} item 消息 article 元素
 * @param {Array<{text,activeForm,status,index}>} entries 已归一条目（status "" = 约定块路）
 * @param {boolean} structured true=TodoWrite 结构化路（有状态徽标）；false=```plan 约定路（标「计划」）
 */
function renderPlanPanel(item, entries, structured) {
  if (!item || !Array.isArray(entries) || !entries.length) return;
  const content = item.querySelector(".message-content");
  let panel = item.__planPanel || null;
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "plan-panel";
    item.__planPanel = panel;
    if (content) item.insertBefore(panel, content); else item.append(panel);
    supersedeOtherPlanPanels(item);
  }
  const total = entries.length;
  const done = entries.filter((entry) => entry.status === "completed").length;
  const header = document.createElement("div");
  header.className = "plan-header";
  const title = document.createElement("span");
  title.className = "plan-title";
  title.textContent = "📋 Agent plan";
  const meta = document.createElement("span");
  meta.className = structured ? "plan-meta" : "plan-meta plan-meta-draft";
  meta.textContent = structured ? `${done}/${total}` : `计划 · ${total} 项`;
  const toggle = document.createElement("span");
  toggle.className = "plan-toggle";
  header.append(title, meta, toggle);
  header.addEventListener("click", () => {
    toggle.textContent = panel.classList.toggle("collapsed") ? "▸" : "▾";
  });
  if (panel.classList.contains("collapsed")) toggle.textContent = "▸"; else toggle.textContent = "▾";
  const list = document.createElement("div");
  list.className = "plan-items";
  entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = `plan-item${entry.status ? ` ${entry.status}` : " convention"}`;
    const arrow = document.createElement("span");
    arrow.className = "plan-arrow";
    arrow.textContent = "|→";
    const index = document.createElement("span");
    index.className = "plan-index";
    index.textContent = `${entry.index}.`;
    const text = document.createElement("span");
    text.className = "plan-text";
    // 结构化路进行中的条目优先显示 activeForm（Claude Code 语义：现进行时描述），历史值放 title
    text.textContent = entry.status === "in_progress" && entry.activeForm ? entry.activeForm : entry.text;
    const tip = entry.status === "in_progress" && entry.activeForm && entry.activeForm !== entry.text ? `${entry.text}（进行中：${entry.activeForm}）` : entry.text;
    text.title = tip;
    const state = document.createElement("span");
    state.className = "plan-state";
    const icon = PLAN_ITEM_ICONS[entry.status] || (entry.status ? "○" : "·");
    state.textContent = icon || "·";
    row.append(arrow, index, text, state);
    list.append(row);
  });
  panel.replaceChildren(header, list);
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
  // v3.20.0 F5：TodoWrite 是 Agent plan 面板（自有组件），不计入「已执行 N 个操作」
  const shown = tools.filter((tool) => !isPlanTool(tool));
  if (!shown.length) return;
  const denied = shown.filter((tool) => normalizedToolStatus(tool) === "denied").length;
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = `tool-summary${denied ? " needs-permission" : ""}`;
  const label = () => denied ? `⚠ ${denied} 项操作需要权限` : `✓ 已执行 ${shown.length} 个操作`;
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
    // v3.16.1 打印联动：AI 产物图片下方出现「打印」按钮（检测到本机 Agent print 打印终端时才显示）
    // 阉割版 Bridge Edition：printLink 门控关闭 → 按钮不再出现（主进程 print:* IPC 也已注册拦截）
    if (file.isImage && editionState.gates.printLink !== false) {
      window.agentChatPro.printDetect().then((present) => {
        if (!present || actions.querySelector(".print-btn")) return;
        const print = document.createElement("button");
        print.type = "button";
        print.className = "print-btn";
        print.textContent = "打印";
        print.title = "经 Agent print 送 HP-DJ1200-XiaoBaiBox 打印";
        print.addEventListener("click", () => runFileAction(print, async () => {
          // 点击时二次确认在场（应用可能刚被卸载/关闭协议失效）
          const ok = await window.agentChatPro.printDetect();
          if (!ok) throw new Error("未检测到 Agent print 打印终端——请先安装/打开 Agent print（共享盘 软件开发/Agent print/）。");
          await window.agentChatPro.printSend(file);
        }));
        actions.append(print);
      }).catch(() => { /* 检测异常 = 按钮不出现，不影响卡片其它动作 */ });
    }
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
    const results = await window.agentChatPro.searchConversations(query, currentWorkspace);
    elements.historyCount.textContent = `${results.length} 条结果`;
    elements.conversationList.replaceChildren();
    results.forEach((conv) => {
      if (conv.id === conversationId) conversationTitle = conv.title; // v3.41.0：当前会话改名/标题随列表刷新同步
      const row = document.createElement("div");
      row.className = "conversation-row" + (conv.id === conversationId ? " active" : "");
      const button = document.createElement("button");
      button.className = "conversation-item";
      const titleSpan = document.createElement("span");
      titleSpan.className = "conversation-title";
      titleSpan.textContent = conv.title;
      button.append(titleSpan);
      const modeIcon = CONVERSATION_MODE_ICONS[conv.lastConnectionMode];
      if (modeIcon) {
        const badge = document.createElement("span");
        badge.className = "conversation-mode-icon";
        badge.textContent = modeIcon;
        badge.title = `此对话使用${CONVERSATION_MODE_LABELS[conv.lastConnectionMode]}模式`;
        button.append(badge);
      }
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
    // v3.35.6：列表按当前工作区物理过滤（历史记录不串台）
    conversationCache = await window.agentChatPro.listConversations(currentWorkspace);
    elements.historyCount.textContent = String(conversationCache.length);
    elements.conversationList.replaceChildren();
    conversationCache.forEach((conversation) => {
      if (conversation.id === conversationId) conversationTitle = conversation.title; // v3.41.0：同上（改名后无需切出重进）
      const row = document.createElement("div");
      row.className = "conversation-row" + (conversation.id === conversationId ? " active" : "");
      const button = document.createElement("button");
      button.className = "conversation-item";
      const titleSpan = document.createElement("span");
      titleSpan.className = "conversation-title";
      titleSpan.textContent = conversation.title;
      button.append(titleSpan);
      const modeIcon = CONVERSATION_MODE_ICONS[conversation.lastConnectionMode];
      if (modeIcon) {
        const badge = document.createElement("span");
        badge.className = "conversation-mode-icon";
        badge.textContent = modeIcon;
        badge.title = `此对话使用${CONVERSATION_MODE_LABELS[conversation.lastConnectionMode]}模式`;
        button.append(badge);
      }
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
      const remaining = await window.agentChatPro.listConversations(currentWorkspace);
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
  // v3.15.6：切走前先保存当前对话的输入框草稿（文本+附件），下方进入时恢复目标对话草稿
  if (conversationId) composerDrafts.set(conversationId, { text: elements.prompt.value, attachments });
  // v3.15.0 bug1：Agent 工作中允许切换对话——进行中的任务在后台继续，切回无缝衔接
  const conversation = await window.agentChatPro.getConversation(id);
  if (!conversation) return;
  // v3.35.6 红线（规格 UI 重构需求 2）：loadConversation workspace 入参校验——
  // 非 A/B 模式互不可见，跨工作区对话一律拒绝打开并按当前工作区刷新列表（防历史记录串台）
  if (normalizeWorkspace(conversation.workspaceType) !== currentWorkspace) {
    await refreshConversationList();
    setConnection("该对话属于另一工作区，未打开", "connected");
    return;
  }
  // v3.15.0 功能2：切到另一模式的对话时，聊天界面模式跟着切换（同步持久化——main 侧 chat:send 读已保存设置）
  // 阉割版 Bridge：本机模式被形态门控关闭——lastMode=local 一律不跟随，保持 SSH
  const allowedLastModes = editionState.gates.localEngines === false ? ["ssh", "cloud"] : ["ssh", "cloud", "local"];
  const lastMode = conversation.lastConnectionMode || "";
  if (lastMode && allowedLastModes.includes(lastMode) && lastMode !== currentConnectionMode) {
    elements.form.elements.namedItem("connectionMode").value = lastMode;
    updateConnectionModeUI();
    try {
      await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), connectionMode: lastMode });
    } catch {}
  }
  conversationId = conversation.id;
  conversationTitle = conversation.title || ""; // v3.41.0：通知标题用会话名
  sessionId = conversation.sessionId || "";
  // v3.35.6 群聊：该对话绑定工作组 → 群聊布局（成员名牌条 + 群工具栏：自主讨论开关 / 大红停止）
  applyGroupLayout(conversation);
  // v3.15.6：恢复该对话的输入框草稿（文本+附件）——不再粗暴清空丢字/丢附件，切换互不串扰
  const composerDraft = composerDrafts.get(conversation.id) || { text: "", attachments: [] };
  attachments = [...(composerDraft.attachments || [])];
  elements.prompt.value = composerDraft.text || "";
  adjustTextarea();
  onPromptInputChanged(); // v3.40.0：草稿回填不触发 input 事件——镜像层/浮层按新草稿刷新
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
  // v3.15.0 bug1：此对话正在后台处理中——最后一条 draft 是流式元素本体，跳过渲染，随后重新挂载流式元素
  const streamingOngoing = Boolean(activeId && streamingConversationId === conversation.id);
  conversation.messages.forEach((message) => {
    if (message.draft && streamingOngoing) return;
    const item = addMessage(message.role, message.text, { senderType: message.senderType || "", agent: message.agent || null });
    // v3.15.5 修复2：写入落库锚点（mid/at/role）——右键「删除此条及下方所有消息」据此同步落库删除
    item.dataset.msgId = message.mid || "";
    item.dataset.msgAt = message.at || "";
    item.dataset.msgRole = message.role;
    if (message.role === "user") renderSentAttachments(item, [], message.attachmentNames || []);
    if (message.role === "assistant") {
      if (message.draft) {
        item.classList.add("interrupted");
        const note = document.createElement("div");
        note.className = "draft-note";
        note.textContent = "未完成的回复 · 已自动保存";
        item.prepend(note);
      }
      // v3.24.0 功能C：历史消息重放思考折叠块（msg.thinking 随消息落库）
      renderStaticThinking(item, message.thinking);
      (message.tools || []).forEach((tool) => renderTool(item, tool));
      finalizeToolList(item, message.tools || []);
      renderReturnedFiles(item, message.files || []);
      // v3.21.3 修复②：带工具牌的云端历史消息——剥掉 v3.15.5 起注入正文的孤立 `---` 分隔行（不再堆横线）
      // v3.25.0：第三参 {static:true}=历史重放——ask 约定块卡定格禁点（本轮流式才可点选）
      renderAssistant(item, (message.tools || []).length ? stripSeparatorLines(message.text) : message.text, { static: true });
    }
  });
  // v3.15.0 bug1：切回正在处理的对话——把后台流式元素重新挂载（同一引用，后续 delta 无缝衔接）
  if (streamingOngoing) {
    const answer = messages.get(activeId);
    if (answer && !answer.isConnected) elements.messages.append(answer);
  }
  elements.empty.hidden = conversation.messages.length > 0 || streamingOngoing;
  if (streamingOngoing) {
    setConnection(`${streamingConnectionMode === "cloud" ? "云端 AI" : streamingConnectionMode === "local" ? `本机 ${localEngineLabel()}` : " SSH"}仍在处理此对话，输出结束后自动完成`, "connected");
  } else {
    setConnection(sessionId ? `已恢复${currentConnectionMode === "cloud" ? "云端 AI" : currentConnectionMode === "local" ? `本机 ${localEngineLabel()}` : " SSH"} 会话` : "新对话，等待发送", "connected");
  }
  // v3.15.6：发送区忙碌样态跟随任务归属——进行中任务只属于本对话才显示忙碌/停止视觉，
  // 切到无任务的对话恢复正常"待发送"样态（点发送与 Esc 同样按归属分派，见 sendMessage/submit/Esc）
  elements.composer.classList.toggle("busy", streamingOngoing);
  elements.composer.setAttribute("aria-busy", String(streamingOngoing));
  elements.send.classList.toggle("busy", streamingOngoing);
  elements.send.title = streamingOngoing ? "停止生成（Esc）" : "发送";
  // 从历史消息估算累计 token（v3.21.3 修复①：云端消息优先用落库的真实累计账目）
  conversationTokens = 0;
  for (const msg of conversation.messages) {
    conversationTokens += tokensForMessage(msg);
  }
  resetStreamingTokens();
  updateTokenDisplay();
  refreshConversationList();
}

// ── v3.35.6 多 AI 对话（工作）：群聊引擎（模块三）+ Sub-Agent 树气泡（模块四）──────
// 群聊对话 = 绑定工作组的 team 对话；发送走专用 chat:group-send（单聊闸门不适用——
// 红线①：多流渲染由此模块的串行队列收口，DOM 每 ≤24ms 合帧写一次，防 OOM）。

let groupActiveConversationId = ""; // 当前处于群聊布局的对话 id
let groupActiveWorkgroupId = ""; // 该对话绑定的工作组
let groupMemberNames = []; // 成员名（@解析白名单——非成员提及忽略，广播兜底在主进程）
let groupRosterAgents = []; // 成员完整信息（名牌条渲染）
let groupAutoDiscussOn = false; // 自主讨论开关（按序接力，发言上限=工作组 maxTurns）
let groupTurnsLive = new Map(); // requestId → { item, name, kind, conversationId }（渲染层群轮登记）
const groupDeltaBuffer = new Map(); // 红线①：delta 合帧缓冲
let groupDeltaTimer = null;
// v3.42.0 修复①：群发收口状态（chat:group-send 改「启动即返」后，结束判定从「await sendGroupMessage
// resolve」移到「主进程 group-turn-settled 事件 + 全部轮 finalize」双保险）：{conversationId, title, armed, total, failed}
let groupSendState = null;

/** 群布局切换（loadConversation 进入时调用）：建群对话挂成员名牌条 + 群工具栏 */
async function applyGroupLayout(conversation) {
  const isGroup = normalizeWorkspace(conversation.workspaceType) === "team" && Boolean(conversation.workgroupId);
  groupActiveConversationId = isGroup ? conversation.id : "";
  groupActiveWorkgroupId = isGroup ? (conversation.workgroupId || "") : "";
  const composer = elements.composer;
  composer?.classList?.toggle("group-mode", isGroup);
  document.getElementById("group-toolbar")?.remove();
  document.getElementById("group-roster")?.remove();
  if (!isGroup) { groupMemberNames = []; groupRosterAgents = []; onPromptInputChanged(); return; } // v3.40.0：转单聊即关镜像层
  // 成员名解析（工作组配置 → 池节点名）
  try {
    const workgroups = await window.agentChatPro.listWorkgroups();
    const group = (workgroups || []).find((item) => item.id === groupActiveWorkgroupId);
    const pool = await window.agentChatPro.listAgentPool();
    groupRosterAgents = (group?.members || [])
      .map((member) => pool.find((node) => node.id === member.agentId))
      .filter(Boolean);
    groupMemberNames = groupRosterAgents.map((node) => node.name);
  } catch { groupMemberNames = []; groupRosterAgents = []; }
  // 群工具栏（composer 上方）：成员 @ 快捷点选 + 自主讨论开关 + 大红停止
  if (composer) {
    const toolbar = document.createElement("div");
    toolbar.id = "group-toolbar";
    toolbar.className = "group-toolbar";
    const roster = groupRosterAgents.map((node) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "group-chip";
      chip.textContent = `@${node.name}`;
      chip.title = "点此把该成员点名进下一条消息（@路由）";
      chip.addEventListener("click", () => {
        const prompt = elements.prompt;
        const value = prompt.value;
        prompt.value = value && !value.endsWith(" ") ? `${value} @${node.name} ` : `${value}@${node.name} `;
        prompt.focus();
      });
      return chip;
    });
    const autodiscuss = document.createElement("label");
    autodiscuss.className = "group-autodiscuss";
    autodiscuss.title = "自主讨论（Auto-Discuss）：全员按工作组顺序自动接力，最多 " + (groupRosterAgents.length ? "按工作组轮数上限" : "maxTurns") + " 发言。也可在输入中直接写「自主讨论/自主聊天/自主对话」关键词触发（字面词按指令消费，不进成员消息）";
    const discussCheck = document.createElement("input");
    discussCheck.type = "checkbox";
    discussCheck.id = "group-autodiscuss-toggle";
    discussCheck.checked = groupAutoDiscussOn;
    discussCheck.addEventListener("change", () => { groupAutoDiscussOn = discussCheck.checked; });
    autodiscuss.append(discussCheck, document.createTextNode(" 自主讨论"));
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.id = "group-stop-button";
    stopBtn.className = "group-stop-button";
    stopBtn.textContent = "🛑 紧急停止";
    stopBtn.title = "立即中断所有正在发言的成员（含子 Agent）；自主讨论接力一并掐断";
    stopBtn.addEventListener("click", emergencyStopGroup);
    toolbar.append(...roster, autodiscuss, stopBtn);
    composer.prepend(toolbar);
    // 成员名牌条（聊天区顶）
    const rosterBar = document.createElement("div");
    rosterBar.id = "group-roster";
    rosterBar.className = "group-roster";
    const label = document.createElement("span");
    label.className = "group-roster-label";
    label.textContent = "群成员";
    rosterBar.append(label);
    groupRosterAgents.forEach((node) => {
      const tag = document.createElement("span");
      tag.className = `group-roster-tag agent-kind-${node.kind || "cloud"}`;
      const kindLabel = node.kind === "cloud" ? `云端·${node.cloud?.model || ""}` : node.kind === "ssh" ? `SSH·${node.ssh?.profileId || ""}` : `本机·${node.local?.engine || ""}`;
      tag.textContent = `@${node.name}`;
      tag.title = `${node.name}（${kindLabel}${node.thinkingLevel ? ` · 思考:${node.thinkingLevel}` : ""}）`;
      rosterBar.append(tag);
    });
    elements.messages.parentElement?.prepend(rosterBar) || elements.messages.prepend(rosterBar);
    onPromptInputChanged(); // v3.40.0：群布局就位后按当前草稿刷新镜像层，并关掉可能残留的 @ 浮层
  }
}

function appendMentionsToIds(message) {
  const wanted = new Set();
  for (const name of groupMemberNames) if (message.includes(`@${name}`)) wanted.add(name);
  return [...wanted];
}

/** 红线①：群流渲染队列——delta 只入缓冲，≤24ms 合帧一次 DOM 写（多成员并行不炸） */
function enqueueGroupDelta(requestId, text) {
  const entry = groupTurnsLive.get(requestId);
  if (!entry) return;
  groupDeltaBuffer.set(requestId, (groupDeltaBuffer.get(requestId) || "") + String(text || ""));
  const flush = () => {
    groupDeltaTimer = null;
    for (const [rid, chunkText] of groupDeltaBuffer.entries()) {
      groupDeltaBuffer.delete(rid);
      const live = groupTurnsLive.get(rid);
      if (!live || !chunkText) continue;
      const content = live.item.querySelector(".message-content");
      if (content) content.textContent += chunkText;
      live.text += chunkText;
      // v3.37.0 状态可视化：首段正文到达 →「正在回复…」（思考阶段已过；note 不再长期停在「正在处理…」的哑态）
      if (live.text && live.item.classList.contains("group-streaming")) {
        const note = live.item.querySelector(".draft-note");
        if (note && note.textContent !== `@${live.name} 正在回复…`) note.textContent = `@${live.name} 正在回复…`;
      }
    }
    if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
  };
  if (!groupDeltaTimer) groupDeltaTimer = setTimeout(flush, 24);
}

function renderGroupTurnBubble(turn) {
  const item = addMessage("assistant", "", { agent: { id: turn.agentId, name: turn.name, kind: turn.kind } });
  item.classList.add("group-streaming");
  const note = document.createElement("div");
  note.className = "draft-note";
  // v3.37.0 状态可视化（用户实锤「无法判断他们到底在思考还是干嘛」）：初始=思考中，收到首段 delta 后由 enqueueGroupDelta 切为回复中
  note.textContent = `@${turn.name} 正在思考…`;
  item.prepend(note);
  item.dataset.groupTurn = turn.requestId;
  messages.set(turn.requestId, item); // 群轮也入单流 Map：通用 onChatEvent（thinking/ask-user/round）按 id 找气泡
  elements.messages.append(item);
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
  groupTurnsLive.set(turn.requestId, { item, name: turn.name, kind: turn.kind, conversationId: turn.conversationId || groupActiveConversationId, text: "" });
  return item;
}

/** v3.42.0 修复①：群轮气泡统一入口（幂等）——事件先到即建「正在思考」气泡并注册悬等，
 * sendGroupMessage resolve 后快照建轮同样走这里（has 防重）。幽灵轮分流灰态缺席气泡。 */
function ensureGroupTurnBubble(turn) {
  const requestId = String(turn?.requestId || "");
  if (!requestId) return null;
  if (turn.ghost) return renderGhostTurnBubble(turn);
  if (groupTurnsLive.has(requestId)) return groupTurnsLive.get(requestId).item;
  renderGroupTurnBubble(turn);
  window.agentChatPro.awaitGroupTurn(requestId)
    .then((turnResult) => finalizeGroupTurn(requestId, turnResult))
    .catch(() => finalizeGroupTurn(requestId, { failed: true, error: { code: "IPC", message: "该轮无返回" } }));
  return groupTurnsLive.get(requestId)?.item || null;
}

/** v3.42.0 幽灵成员轮：群成员指向已删 Agent 池节点——灰态缺席气泡（不再静默出局无人知晓）。
 * 不入 groupTurnsLive（不占群发忙闸、不计成员统计），直接终态呈现。 */
function renderGhostTurnBubble(turn) {
  const item = addMessage("assistant", "", { agent: { id: turn.agentId, name: turn.name, kind: "ghost" } });
  item.classList.add("group-failed");
  const note = document.createElement("div");
  note.className = "draft-note";
  note.textContent = `@${turn.name} 已不在 Agent 池，本轮缺席`;
  item.prepend(note);
  const content = item.querySelector(".message-content");
  if (content) content.textContent = "（该成员的 Agent 节点已被删除——请到侧边栏「Agent 池」更新工作组成员）";
  elements.messages.append(item);
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
  return item;
}

/** v3.42.0 群发收口：主进程 group-turn-settled（全组终局）+ finalize 逐轮即时判定双保险。
 * 条件 = 状态已布防 && 本对话已无任何进行中轮 → 状态条收口 + v3.41.0 任务完成通知（total/failed 实测计数）。 */
function checkGroupSendSettle(conversationId) {
  const state = groupSendState;
  if (!state || !state.armed || String(state.conversationId) !== String(conversationId)) return;
  for (const live of groupTurnsLive.values()) {
    if (String(live.conversationId) === String(conversationId)) return; // 仍有成员在跑，不收口
  }
  state.armed = false;
  setConnection("群聊已结束本轮，等待下一次发言", "connected");
  reportTaskNotify({
    kind: "group",
    id: state.conversationId,
    title: state.title,
    force: state.conversationId !== conversationId,
    summary: "",
    totalMembers: state.total,
    failedCount: state.failed
  });
}

/** 群轮终态转正：markdown 渲染 + 去占位 + 失败态样式（v3.42.0：失败轮显示真实失败原因，不再一律「本轮无输出」） */
async function finalizeGroupTurn(requestId, turnResult) {
  const live = groupTurnsLive.get(requestId);
  if (!live) return;
  groupTurnsLive.delete(requestId);
  messages.delete(requestId);
  const item = live.item;
  item.classList.remove("group-streaming");
  const note = item.querySelector(".draft-note");
  if (note) note.remove();
  const state = groupSendState;
  if (state && state.armed && String(state.conversationId) === String(live.conversationId)) {
    state.total += 1;
    if (turnResult?.failed) state.failed += 1;
  }
  if (turnResult?.failed) item.classList.add("group-failed");
  else if (turnResult?.cancelled) item.classList.add("interrupted");
  const finalText = String(turnResult?.text ?? live.text ?? "");
  const content = item.querySelector(".message-content");
  if (content) {
    if (finalText) await renderAssistant(item, finalText, { static: true });
    else if (turnResult?.failed) {
      const err = turnResult.error || {};
      content.textContent = `本轮失败：${err.code || "ERROR"} ${String(err.message || "未知错误").slice(0, 220)}`;
    } else if (turnResult?.missing) {
      content.textContent = "（该轮未启动——大概率已被紧急停止）";
    } else {
      content.textContent = "（本轮无输出）";
    }
  }
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
  checkGroupSendSettle(live.conversationId);
}

/** 群发送（主入口）：@ 路由解析 → sendGroupMessage → 轮气泡建挂 → 每轮 awaitGroupTurn 悬等转正 */
async function sendGroupTurn() {
  const prompt = elements.prompt;
  let text = prompt.value.trim();
  if (!groupActiveConversationId) return false;
  // v3.40.0：指令关键词（自主讨论/自主聊天/自主对话）——输入即触发，不再必须点「自主讨论」开关；
  // 关键词=本次强制开启（勾选开关仍可用，二者叠加取或）；发送时从成员消息文本中剥离（指令已消费）
  const keywordHit = AUTODISCUSS_HAS_RE.test(text);
  if (keywordHit) {
    text = text.replace(AUTODISCUSS_STRIP_RE, "").replace(/\s{2,}/g, " ").trim();
    if (!text) {
      setConnection("已识别自主讨论指令，但内容为空——请补一段要讨论的话题再发", "connected");
      return true; // 群已接管本次提交（指令被识别，不留单聊路）
    }
  }
  const effectiveAutoDiscuss = keywordHit || groupAutoDiscussOn;
  if (!text) return false;
  // v3.37.2 群发忙闸：本对话仍有群轮进行中时拦截（双群轮并发=云成员上下文互踩/SSH 卡槽互踩）
  for (const live of groupTurnsLive.values()) {
    if (live.conversationId === groupActiveConversationId) {
      setConnection("群聊正在进行中，请点红色停止按钮或等本轮结束后再发", "connected");
      return true; // 群已接管本次提交（不再落入单聊路）
    }
  }
  prompt.value = "";
  adjustTextarea();
  renderPromptMirror();
  closeAtPopover();
  renderAttachments(); // 清空当前输入附件（群发送暂不支持附件——CLI 成员暂不接附件）
  attachments = [];
  const message = addMessage("user", text);
  message.dataset.msgRole = "user";
  conversationTokens += estimateTokens(text);
  updateTokenDisplay();
  const mentioned = appendMentionsToIds(text);
  if (!mentioned.length && groupMemberNames.length) { /* 非成员提及/无提及=广播（主进程兜底） */ }
  setConnection(`${effectiveAutoDiscuss ? "自主讨论接力中" : "群聊进行中"}`, "connected");
  try {
    const result = await window.agentChatPro.sendGroupMessage({
      conversationId: groupActiveConversationId,
      workgroupId: groupActiveWorkgroupId,
      message: text,
      mentionedAgentIds: mentioned,
      autoDiscuss: effectiveAutoDiscuss,
      // v3.37.0 群成员不再默认纯聊天：工作模式随群发（成员系统提示/工具行为与该模式语义一致）
      workModeId: currentModeId
    });
    // v3.42.0 修复①（chat:group-send 启动即返）：群轮状态布防 + 快照建轮（幂等——事件先到的轮已建）。
    // 结束判定不再依赖本 await（它现在=启动确认而非全程），收口走 group-turn-settled 事件 + finalize 双保险。
    const groupNotifyConversationId = result.conversationId || groupActiveConversationId;
    groupSendState = { conversationId: groupNotifyConversationId, title: conversationTitle, armed: true, total: 0, failed: 0 };
    (result.turns || []).forEach((turn) => ensureGroupTurnBubble({ ...turn, conversationId: groupNotifyConversationId }));
    checkGroupSendSettle(groupNotifyConversationId); // 快轮兜底：主进程先发 settle 事件也不会漏收口（armed 事件侧等待）
    return true;
  } catch (error) {
    setConnection(error.message || "群聊发送失败", "error");
    return true; // 群已接管本次提交（不再落入单聊路）
  }
}

/** 紧急停止大红按钮（模块三④）：全员 stop（activeRequests cancel + 停止旗 + 子 Agent 悬等收口） */
async function emergencyStopGroup() {
  if (!groupActiveConversationId) return;
  try {
    await window.agentChatPro.stopGroupTurns(groupActiveConversationId);
    for (const [requestId, live] of groupTurnsLive.entries()) {
      live.item.classList.remove("group-streaming");
      live.item.classList.add("interrupted");
      const note = live.item.querySelector(".draft-note");
      if (note) note.textContent = "已紧急停止";
      else {
        const note2 = document.createElement("div");
        note2.className = "draft-note";
        note2.textContent = "已紧急停止";
        live.item.prepend(note2);
      }
      groupTurnsLive.delete(requestId);
    }
    // v3.42.0：停止=取消分支——收口状态立即解除布防（不再等 settle 事件；任务完成通知不上报，对齐 v3.41.0 取消语义）
    if (groupSendState && groupSendState.armed) groupSendState = { ...groupSendState, armed: false };
    setConnection("已紧急停止全部群聊成员", "connected");
  } catch (error) {
    setConnection(error.message || "停止失败", "error");
  }
}

/** Sub-Agent 树状折叠气泡（模块四）：└─ 子 Agent [名] 正在处理…（挂到父轮气泡内） */
function renderSubagentTreeLine(payload) {
  const parentId = String(payload?.parentId || "");
  const live = groupTurnsLive.get(parentId);
  if (!live) return;
  const item = live.item;
  if (!payload || payload.type !== "subagent") return;
  let list = item.querySelector(".subagent-tree");
  if (!list) {
    list = document.createElement("details");
    list.className = "subagent-tree";
    const summary = document.createElement("summary");
    summary.textContent = "└─ 子 Agent 工作树";
    list.append(summary);
    item.querySelector(".message-content")?.before(list);
  }
  const agentName = payload.agent?.name ? `[${payload.agent.name}]` : "";
  const stateLabels = {
    "processing": `└─ 子 Agent [${payload.agent?.name || ""}] 正在处理…`,
    "brain-swap-wait": `└─ 子 Agent ${agentName} 请求换脑 → ${JSON.stringify(payload.payload || {})}`,
    "done": `└─ 子 Agent ${agentName} 完成：${payload.text || ""}`,
    "rejected": `└─ 子 Agent ${agentName} 已拒绝：${payload.text || ""}`,
    "failed": `└─ 子 Agent ${agentName} 失败：${payload.payload?.message || payload.text || ""}`,
    "reported": `└─ 子 Agent ${agentName} 结果已注入群聊上下文`
  };
  const line = document.createElement("div");
  line.className = `subagent-line subagent-${payload.state || "processing"}`;
  line.textContent = stateLabels[payload.state] || `└─ 子 Agent ${agentName}（${payload.state || ""}）`;
  list.append(line);
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function createNewConversation() {
  // v3.15.0 bug1：Agent 工作中允许新建/切换对话——进行中的任务在后台继续
  const conversation = await window.agentChatPro.createConversation(currentWorkspace);
  // v3.37.0 一键延续上次群聊（用户实锤「设置个群聊，新开个对话还得特地新建群聊工作站，选择确认超级麻烦」）：
  // 多人工作区新建对话 → 自动沿用最近一次工作组（成员配置照旧，上下文全新）；要换群仍走「建群」入口
  if (currentWorkspace === "team") {
    try {
      const workgroups = await window.agentChatPro.listWorkgroups();
      // 建档顺序而非最近序——按 createdAt 取最后一次建的组（「上次群聊」语义）
      const latest = (workgroups || []).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
      if (latest && Array.isArray(latest.members) && latest.members.length) {
        await window.agentChatPro.setConversationWorkgroup(conversation.id, latest.id);
      }
    } catch { /* 沿用失败不拦新建——回落无组对话（可与建群对话框重走） */ }
  }
  await loadConversation(conversation.id);
  // 新对话重置 token 计数
  conversationTokens = 0;
  resetStreamingTokens();
  updateTokenDisplay();
  elements.prompt.focus();
}

// ── v3.35.6 工作区切换器 ──────────────────────────────
// 规格（UI 重构需求）：侧边栏顶部下拉；主标题/副标题两行；选中右侧 ✔ 未选中不显示；
// 切换即「数据强隔离」——历史列表物理刷新过滤 + 当前对话界面清空回默认首页（状态重置）。
function setWorkspaceDisplay() {
  const ws = WORKSPACES.find((item) => item.id === currentWorkspace) || WORKSPACES[0];
  const name = document.querySelector("#sidebar-brand-name");
  const desc = document.querySelector("#workspace-desc");
  if (desc) desc.textContent = ws.desc;
  // 多人工作区为主标题固定产品面「Agents Chat Pro」；单人工作区跟随品牌配置（阉割版品牌名可覆盖）
  if (name) name.textContent = currentWorkspace === "team" ? WORKSPACE_TEAM_NAME : (brandConfig?.appName || "Agent Chat Pro");
}

function renderWorkspaceList() {
  const list = document.querySelector("#workspace-dropdown");
  if (!list) return;
  list.replaceChildren();
  for (const ws of WORKSPACES) {
    const item = document.createElement("div");
    item.className = "workspace-item" + (ws.id === currentWorkspace ? " active" : "");
    const icon = document.createElement("span");
    icon.className = "workspace-item-icon";
    icon.textContent = ws.id === "team" ? "👥" : "✦";
    const info = document.createElement("span");
    info.className = "workspace-item-info";
    const name = document.createElement("span");
    name.className = "workspace-item-name";
    name.textContent = ws.name;
    const desc = document.createElement("span");
    desc.className = "workspace-item-desc";
    desc.textContent = ws.desc;
    info.append(name, desc);
    const check = document.createElement("span");
    check.className = "workspace-check";
    check.textContent = "✔";
    check.hidden = ws.id !== currentWorkspace; // 规格：选中显示 ✔，未选中不显示
    item.append(icon, info, check);
    item.addEventListener("click", () => setWorkspace(ws.id));
    list.append(item);
  }
}

function closeWorkspaceDropdown() {
  workspaceDropdownOpen = false;
  document.querySelector("#workspace-dropdown").hidden = true;
}

// 切换工作区：当前打开的对话界面清空——回到该工作区的默认首页（#empty-state）
async function setWorkspace(workspaceId) {
  closeWorkspaceDropdown();
  const next = normalizeWorkspace(workspaceId);
  if (next === currentWorkspace) return;
  // v3.35.6 群聊状态重置：群布局/成员/群轮登记全部清回默认（规格 UI 需求 3）
  groupActiveConversationId = "";
  groupActiveWorkgroupId = "";
  groupMemberNames = [];
  groupRosterAgents = [];
  elements.composer?.classList?.remove("group-mode");
  document.getElementById("group-toolbar")?.remove();
  document.getElementById("group-roster")?.remove();
  onPromptInputChanged(); // v3.40.0：退群布局即收镜像层与 @ 浮层
  // 切走前保存当前对话草稿（与 loadConversation 同约定——切回不丢字）
  if (conversationId) composerDrafts.set(conversationId, { text: elements.prompt.value, attachments });
  const hadOpenConversation = Boolean(conversationId);
  conversationId = "";
  conversationTitle = ""; // v3.41.0：回首页即无当前会话——清标题防通知标错会话名
  sessionId = "";
  attachments = [];
  renderAttachments();
  resetContextBar();
  conversationTokens = 0;
  resetStreamingTokens();
  updateTokenDisplay();
  elements.prompt.value = "";
  adjustTextarea();
  onPromptInputChanged();
  elements.messages.replaceChildren();
  elements.empty.hidden = false;
  const label = `${streamingConnectionMode === "cloud" ? "云端 AI" : streamingConnectionMode === "local" ? "本机" : "SSH"}任务仍在后台处理 · 已切换工作区`;
  setConnection(activeId && hadOpenConversation && streamingConversationId ? label : "新对话，等待发送", "connected");
  currentWorkspace = next;
  try { localStorage.setItem("acp-workspace", next); } catch { /* 存储不可写不阻断 */ }
  setWorkspaceDisplay();
  renderWorkspaceList();
  ensureEmptyStateGroupEntry();
  await refreshConversationList(); // 历史列表按新工作区物理刷新
}

function initWorkspaceSelector() {
  // 恢复上次选择（localStorage 跨启动记忆；非法/缺失值一律落回 single）
  currentWorkspace = normalizeWorkspace(localStorage.getItem("acp-workspace") || "single");
  setWorkspaceDisplay();
  renderWorkspaceList();
}

document.querySelector("#workspace-trigger").addEventListener("click", (event) => {
  event.stopPropagation();
  workspaceDropdownOpen = !workspaceDropdownOpen;
  document.querySelector("#workspace-dropdown").hidden = !workspaceDropdownOpen;
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".workspace-selector")) closeWorkspaceDropdown();
});

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
  onPromptInputChanged();
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
  // v3.35.6 群聊：群对话的停止=紧急停止大红按钮同一语义（全员 stop，含子 Agent 悬等收口）
  if (groupActiveConversationId === conversationId && groupActiveConversationId && groupTurnsLive.size) {
    emergencyStopGroup();
    return;
  }
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
  streamingConversationId = "";
  streamingConnectionMode = "";
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

// v3.40.0（ChatGPT UX 方案）：聊天失败三段式——发生了什么 / 可能原因 / 建议操作。
// 原始 error.message 保留在「发生了什么」段（不丢排查信息）；原因由关键词判定出可读结论，不展开堆栈。
function connectionFailureBrief(error) {
  const message = String((error && error.message) || error || "");
  let reason = "执行过程中抛出异常";
  let action = streamingConnectionMode === "cloud"
    ? "检查服务商密钥与模型名；或到设置 → 诊断查看详细网络错误"
    : "检查连接配置；或到设置 → 诊断查看详细错误";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    reason = "主机地址无法解析（地址拼写或 DNS 问题）";
    action = "到连接设置核对主机地址拼写，确认本机网络可达";
  } else if (/ECONNREFUSED/i.test(message)) {
    reason = "目标端口拒绝连接（端口未开放或远端服务未启动）";
    action = "确认地址端口与远端 SSH/AI 服务已在运行，防火墙未拦截该端口";
  } else if (/ETIMEDOUT|ECONNRESET|ESOCKETTIMEDOUT|timed?\s?out/i.test(message)) {
    reason = "连接超时或中途断开（网络抖动、防火墙或代理问题）";
    action = "重试一次；若经外网隧道访问，确认隧道存活，或检查代理设置";
  } else if (/认证|auth|password|密码|denied|permission/i.test(message)) {
    reason = "认证未通过（用户名、密码或密钥不正确 / 权限不足）";
    action = "重新填写用户名与密码（或密钥），确认账号具备远程访问权限";
  }
  return `发生了什么：${message}\n可能原因：${reason}\n建议操作：${action}`;
}

/** v3.41.0 任务完成系统通知：渲染层上报 → 主进程结合设置开关/窗口焦点统一判定弹与不弹；
 *  点击通知回跳会话并聚焦输入框（对话继续说）。上报失败静默——通知不打断主聊天链路。 */
async function reportTaskNotify(input = {}) {
  try {
    await window.agentChatPro.notifyTaskComplete({
      kind: input.kind || "done",
      conversationId: input.id || "",
      conversationTitle: input.title || "",
      summary: String(input.summary || "").slice(0, 400),
      force: Boolean(input.force)
    });
  } catch { /* 通知失败不影响聊天主链路 */ }
}

async function sendMessage(composerText = elements.prompt.value, opts = {}) {
  // v3.35.6 群聊分流：绑了工作组的对话走群聊引擎（chat:group-send）——单聊闸门（activeId）不适用
  if (groupActiveConversationId === conversationId && groupActiveConversationId) {
    const result = await sendGroupTurn();
    if (result) return;
  }
  // 阉割版 Bridge Edition：云端AI 经 HTTP 桥放的轮（opts.bridge.msgId 在场）——终态必须回报给桥
  //（云端AI 轮询 /api/message 拿回复），busy/取消/失败/成功四态都回报，不让云端AI 悬等
  const viaBridge = Boolean(opts.bridge && opts.bridge.msgId);
  const reportBridgeResult = (state, extra = {}) => {
    if (!viaBridge) return;
    try { window.agentChatPro.reportAgentBridgeResult({ msgId: opts.bridge.msgId, state, ...extra }); } catch { /* 回报失败不阻断 UI */ }
  };
  const message = String(composerText ?? "").trim();
  if (!message && !attachments.length) return;
  // v3.15.6：全局同一时间仅一个任务——被占用时不再静默拦截，按任务归属给出明确提示
  if (activeId) {
    reportBridgeResult("failed", { error: "应用正忙：另一轮对话正在进行中，稍后可重发。" });
    if (streamingConversationId === conversationId) return; // 本对话已在处理中
    setConnection(`正在处理其他对话的任务，完成后即可发送（同一时间仅支持一个任务）`, "connected");
    return;
  }
  activeId = crypto.randomUUID();
  // v3.15.0 bug1：记录进行中任务归属（对话+模式）——切走后后台继续，完成回调防串话
  streamingConversationId = conversationId;
  streamingConnectionMode = currentConnectionMode;
  // v3.41.0：发出时快照会话身份——切走后收尾按「发起会话」上报通知（标题不再随当前显示会话漂移）
  const turnConversationId = streamingConversationId;
  const turnTitle = conversationTitle;
  // 桥回合的附件恒为空——全局 attachments 是用户输入框草稿，桥回合不得顺手把它带进对话
  const turnAttachments = viaBridge ? [] : attachments;
  const userItem = addMessage("user", message, { senderType: viaBridge ? "cloud-ai" : "" });
  renderSentAttachments(userItem, turnAttachments);
  const answer = addMessage("assistant generating");
  messages.set(activeId, answer);
  if (!viaBridge) { elements.prompt.value = ""; adjustTextarea(); onPromptInputChanged(); } // 桥回合不清用户输入框草稿
  setBusy(true);
  setConnection(currentConnectionMode === "cloud" ? "正在连接云端 AI…" : currentConnectionMode === "local" ? `正在启动本机 ${localEngineLabel()}…` : "正在连接 NAS…", "");
  // 重置流式 token 计数，估算用户消息 token
  resetStreamingTokens();
  addConversationTokens(estimateTokens(message));

  try {
    const preparedAttachments = await Promise.all(turnAttachments.map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      data: await file.arrayBuffer()
    })));
    if (!viaBridge) { attachments = []; renderAttachments(); }
    // 客户端超时兜底：35 分钟（略大于 ssh.cjs 的 MAX_REQUEST_MS 30 分钟）
    const SEND_TIMEOUT_MS = 35 * 60 * 1000;
    const sendPromise = window.agentChatPro.sendMessage({
      id: activeId,
      message,
      sessionId,
      conversationId,
      attachments: preparedAttachments,
      workModeId: currentModeId,
      // 阉割版 Bridge：云端AI 桥回合——主进程据此强制追加标记前缀 + 落库 senderType
      senderType: viaBridge ? "cloud-ai" : ""
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
      reportBridgeResult("cancelled", { reply: partial || "" });
      // 停止时合并已产生的流式 token
      addConversationTokens(streamingTokens + confirmedTokens);
      resetStreamingTokens();
      setConnection(`${streamingConnectionMode === "cloud" ? "云端 AI" : streamingConnectionMode === "local" ? "本机 Agent" : "NAS"}已停止当前任务 · 连接正常`, "connected");
      return;
    }
    // v3.15.0 bug1：仅当用户仍看着该对话才更新全局会话状态（切走后完成后防串到别的对话）
    if (streamingConversationId === conversationId) sessionId = result.sessionId || sessionId;
    const content = answer.querySelector(".message-content");
    if (!content.textContent && result.text) content.textContent = result.text;
    await renderAssistant(answer, result.text || content.textContent);
    (result.tools || []).forEach((tool) => renderTool(answer, tool));
    finalizeToolList(answer, result.tools || []);
    renderReturnedFiles(answer, result.files || []);
    reportBridgeResult("done", { reply: result.text || "" });
    answer.classList.remove("generating");
    // v3.41.0：任务完成系统通知——用户切走（发起会话≠当前显示会话）或失焦时主进程弹系统提醒；
    // 正盯着本对话看时不打扰（窗口聚焦状态由主进程判定）
    reportTaskNotify({
      kind: "done",
      id: turnConversationId,
      title: turnTitle,
      force: turnConversationId !== conversationId,
      summary: result.text || content.textContent
    });
    // 合并流式 token 到对话累计（v3.15.0：切走后完成时不再累进当前对话的计数，切回时按消息重算）
    if (streamingConversationId === conversationId) addConversationTokens(streamingTokens + confirmedTokens);
    resetStreamingTokens();
    // 如果 result.stats 包含对话统计，更新 token 显示（仅当用户仍看着该对话）
    if (result.stats && result.stats.totalTokens && streamingConversationId === conversationId) {
      conversationTokens = result.stats.totalTokens;
      updateTokenDisplay();
    }
    // v3.15.5 修复2：补落库锚点（mid）——本轮完成后回查落库记录补写 dataset，右键删除不再依赖「重新进入对话」
    if (streamingConversationId === conversationId) {
      try {
        const stored = await window.agentChatPro.getConversation(conversationId);
        const reversed = (stored?.messages || []).slice().reverse();
        const lastUser = reversed.find((msg) => msg.role === "user");
        const lastAssistant = reversed.find((msg) => msg.role === "assistant" && !msg.draft);
        if (lastUser?.mid) userItem.dataset.msgId = lastUser.mid;
        if (lastUser?.at) userItem.dataset.msgAt = lastUser.at;
        if (lastAssistant?.mid) answer.dataset.msgId = lastAssistant.mid;
        if (lastAssistant?.at) answer.dataset.msgAt = lastAssistant.at;
      } catch {}
    }
    setConnection(`${streamingConnectionMode === "cloud" ? "云端 AI" : streamingConnectionMode === "local" ? `本机 ${localEngineLabel()}` : "NAS"}已完成本轮任务 · 连接正常`, "connected");
    refreshConversationList();
  } catch (error) {
    answer.classList.remove("generating");
    answer.classList.add("error");
    // v3.15.3：错误前缀按本轮连接模式动态显示（cloud→云端 AI / local→本机引擎 / ssh→NAS Agent），不再硬编码 Claude
    const localEngineName = currentLocalEngine === "atomcode" ? "AtomCode" : currentLocalEngine === "custom" ? "自定义命令" : "Claude";
    const failureLabel =
      streamingConnectionMode === "cloud" ? "连接或云端 AI 执行失败"
      : streamingConnectionMode === "local" ? `连接或本机 ${localEngineName} 执行失败`
      : "连接或 NAS Agent 执行失败";
    // v3.40.0（ChatGPT UX 方案）：错误三段式（发生了什么/可能原因/建议操作），替代原先裸 error 单行
    answer.querySelector(".message-content").textContent = failureLabel + "：\n" + connectionFailureBrief(error);
    reportBridgeResult("failed", { error: error.message });
    // v3.41.0：失败同样系统通知——贴长任务单切走后 AI 中途出事，不能等回来才发现（v3.24.9「莫名停止无提示」同病根）
    reportTaskNotify({
      kind: "error",
      id: turnConversationId,
      title: turnTitle,
      force: turnConversationId !== conversationId,
      summary: String(error?.message || error || "")
    });
    setConnection("连接失败", "error");
    // 失败时也合并已估算的 token
    addConversationTokens(streamingTokens + confirmedTokens);
    resetStreamingTokens();
  } finally {
    // v3.24.0：轮终态——把思考折叠块「进行中…」字样收敛为定稿计数
    try { finalizeThinkingSummary(messages.get(activeId)); } catch {}
    messages.delete(activeId);
    activeId = "";
    streamingConversationId = "";
    streamingConnectionMode = "";
    setBusy(false);
    elements.send.classList.remove("stopping");
    requestAnimationFrame(() => focusPrompt());
  }
}

// ── 侧边栏收缩（v3.15.0 功能1：豆包样式——完全收起、主区占满；localStorage 记忆跨启动）──
const sidebarToggle = document.querySelector("#sidebar-toggle");
function syncSidebarToggle() {
  const collapsed = document.body.classList.contains("sidebar-collapsed");
  // v3.15.1：图标改箭头语义——展开时显示「←」（点击收起），收起时显示「→」（点击展开）
  sidebarToggle.textContent = collapsed ? "→" : "←";
  sidebarToggle.title = collapsed ? "展开侧边栏" : "收起侧边栏";
}
if (localStorage.getItem("acp-sidebar-collapsed") === "1") document.body.classList.add("sidebar-collapsed");
syncSidebarToggle();
sidebarToggle.addEventListener("click", () => {
  document.body.classList.toggle("sidebar-collapsed");
  localStorage.setItem("acp-sidebar-collapsed", document.body.classList.contains("sidebar-collapsed") ? "1" : "0");
  syncSidebarToggle();
});

// ── v3.24.7 开发面板插件化：设置中心「插件」页安装/移除，默认未安装，即时生效；折叠仅会话内有效（v3.24.6 真机「隐藏后展不开」教训——折叠状态不再跨重启记忆，重启一律回展开态） ──
const devPanelInstallKey = "acp-plugin-devpanel";
function renderDevPanelPluginCard(installed) {
  const badge = document.querySelector("#devpanel-badge");
  const install = document.querySelector("#install-devpanel");
  const uninstall = document.querySelector("#uninstall-devpanel");
  if (!badge || !install || !uninstall) return;
  badge.textContent = installed ? "已启用" : "未安装";
  badge.classList.toggle("installed", installed);
  install.hidden = installed;
  uninstall.hidden = !installed;
}
function devPanelApply(installed) {
  document.body.classList.toggle("devpanel-absent", !installed);
  if (installed) document.body.classList.remove("dev-collapsed");  // 安装/重启一律展开态
  renderDevPanelPluginCard(installed);
}
devPanelApply(localStorage.getItem(devPanelInstallKey) === "1");
document.querySelector("#install-devpanel")?.addEventListener("click", () => { localStorage.setItem(devPanelInstallKey, "1"); devPanelApply(true); });
document.querySelector("#uninstall-devpanel")?.addEventListener("click", () => { localStorage.setItem(devPanelInstallKey, "0"); devPanelApply(false); });
// 折叠开合（会话内有效，不落盘）
document.querySelector("#dev-collapse")?.addEventListener("click", () => document.body.classList.add("dev-collapsed"));
document.querySelector("#dev-rail")?.addEventListener("click", () => document.body.classList.remove("dev-collapsed"));
const devPanelRoleSaved = localStorage.getItem("acp-dev-panel-role") === "lead" ? "lead" : "assist";
renderDevPanelRole(devPanelRoleSaved);
document.querySelector("#dev-role-assist")?.addEventListener("click", () => renderDevPanelRole("assist"));
document.querySelector("#dev-role-lead")?.addEventListener("click", () => renderDevPanelRole("lead"));

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
  // v3.16.2 使用时扫描：切到设备联动页即刷新状态（status 内含双控件共存扫描结果）
  if (tab === "device" && currentConnectionMode === "ssh") refreshDeviceControlStatus();
  // v3.18.0 F2：切到模型页即按当前模式装载（ssh/local-claude 读五项表，cloud/其他引擎出状态卡）
  if (tab === "models") refreshModelsPage();
}
document.querySelectorAll("[data-settings-tab]").forEach((item) => {
  item.addEventListener("click", () => switchSettingsTab(item.dataset.settingsTab));
});
async function fillAboutVersion() {
  try { document.querySelector("#about-version").textContent = await window.agentChatPro.getAppVersion(); }
  catch { /* 版本通道不可用时保持占位符 */ }
}
fillAboutVersion();

// ── v3.15.8 关于页彩蛋：点击「Agent Chat Pro」标题弹出跳跳龙小游戏 ──
// 阉割版 Bridge Edition：easterEgg 门控关闭 → 不注册点击（主进程 app:open-dino-game 也不注册）
if (editionState.gates.easterEgg !== false) {
  document.querySelector(".about-title")?.addEventListener("click", () => {
    window.agentChatPro.openDinoGame().catch(() => {});
  });
}

// ── 阉割版 Bridge Edition：Agent HTTP 桥（云端AI ↔ NAS Agent 对话链） ──────────
// 云端AI 用 curl POST /api/send → 进入放行队列（浮层卡片）→ 用户点「放行」→
// 主进程推 agentBridge:turn-start → runBridgeTurn 切到桥目标对话并以 SSH 模式走既有 chat:send。
// 所有云端AI消息：文本强制带【云端AI消息 · 非用户本人】前缀（主进程侧）+ 气泡徽章（渲染层）。

/** 门控应用：按 edition gates 隐藏阉割项、放行桥设置卡；boot IIFE 在 populateSettings 后调用 */
async function applyEdition() {
  try { editionState = (await window.agentChatPro.getEdition?.()) || editionState; } catch { return editionState; }
  const gates = editionState.gates || {};
  const isBridge = editionState.edition === "bridge";
  document.body.classList.toggle("edition-bridge", isBridge);
  const hide = (selector) => { const el = document.querySelector(selector); if (el) el.hidden = true; };
  if (gates.localEngines === false) {
    hide("#mode-local");
    hide("#local-fields");
    hide("#atomcode-fields");
    hide("#custom-fields");
    // 存量设置若停在 local 模式：强制回 SSH（本机引擎链路在 Bridge 版不存在）
    if (currentConnectionMode === "local") {
      elements.form.elements.namedItem("connectionMode").value = "ssh";
      currentConnectionMode = "ssh";
      updateConnectionModeUI();
      try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), connectionMode: "ssh" }); } catch {}
    }
  }
  if (gates.deviceLink === false) document.querySelectorAll('[data-settings-tab="device"]').forEach((tab) => { tab.hidden = true; });
  if (gates.agentBridge) {
    const section = document.querySelector("#agentbridge-settings");
    if (section) section.hidden = false;
    await refreshAgentBridgeInfo();
  }
  return editionState;
}

/** 放行队列渲染：每条云端AI待放行消息一张卡（文本全文 + 放行/拒绝按钮） */
function renderBridgeQueue(queue = []) {
  if (!elements.bridgeQueue) return;
  const items = editionState.gates.agentBridge && Array.isArray(queue) ? queue : [];
  elements.bridgeQueue.hidden = items.length === 0;
  elements.bridgeQueue.replaceChildren();
  if (!items.length) return;
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "bridge-queue-card";
    const head = document.createElement("div");
    head.className = "bridge-queue-head";
    const tag = document.createElement("span");
    tag.className = "bridge-queue-tag";
    tag.textContent = "🤖 云端AI请求 · 等待放行";
    head.append(tag);
    const body = document.createElement("div");
    body.className = "bridge-queue-text";
    body.textContent = String(item.text == null ? "" : item.text);
    const meta = document.createElement("div");
    meta.className = "bridge-queue-meta";
    meta.textContent = `${item.at || ""} · ${String(item.text == null ? "" : item.text).length} 字`;
    const actions = document.createElement("div");
    actions.className = "bridge-queue-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "bridge-approve";
    approve.textContent = "放行";
    approve.addEventListener("click", async () => {
      approve.disabled = true;
      try {
        const result = await window.agentChatPro.approveAgentBridgeMessage(item.msgId);
        if (result?.ok === false) setStatus(result.error || "放行失败。", true);
      } catch (error) { setStatus(error.message, true); }
      finally { approve.disabled = false; }
    });
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "bridge-reject";
    reject.textContent = "拒绝";
    reject.addEventListener("click", async () => {
      reject.disabled = true;
      try { await window.agentChatPro.rejectAgentBridgeMessage(item.msgId); }
      catch (error) { setStatus(error.message, true); }
      finally { reject.disabled = false; }
    });
    actions.append(approve, reject);
    card.append(head, body, meta, actions);
    elements.bridgeQueue.append(card);
  }
}

/** 桥回合：切到桥目标对话、切回 SSH 模式，然后走既有 sendMessage（opts.bridge 携 msgId 回报终态） */
async function runBridgeTurn(turn) {
  if (!turn?.msgId || !turn.text) return;
  try {
    // ① 目标对话在场：不在场（应用刚启动/用户切走）则加载
    if (turn.conversationId && conversationId !== turn.conversationId) {
      await loadConversation(turn.conversationId);
    } else if (!turn.conversationId && !conversationId) {
      const conversation = await window.agentChatPro.createConversation();
      await loadConversation(conversation.id);
    }
  } catch (error) {
    try { window.agentChatPro.reportAgentBridgeResult({ msgId: turn.msgId, state: "failed", error: `无法进入目标对话：${error.message}` }); } catch {}
    return;
  }
  // ② 桥对话链固定 SSH 模式（云端AI 的对面是 NAS Agent，不是云端AI 自己）
  if (currentConnectionMode !== "ssh") {
    elements.form.elements.namedItem("connectionMode").value = "ssh";
    currentConnectionMode = "ssh";
    updateConnectionModeUI();
    try { await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), connectionMode: "ssh" }); } catch {}
  }
  sendMessage(turn.text, { bridge: { msgId: turn.msgId } });
}

/** 桥设置卡回填（端口/闸门/Token/目标对话）；token 明文只走本机 IPC 展示 */
async function refreshAgentBridgeInfo() {
  try {
    const info = await window.agentChatPro.getAgentBridgeInfo();
    if (!info) return;
    renderBridgeQueue(info.queue || []);
    const portInput = document.querySelector("#agentbridge-port");
    if (portInput && document.activeElement !== portInput) portInput.value = info.port || "";
    const gateBox = document.querySelector("#agentbridge-gate");
    if (gateBox) gateBox.checked = Boolean(info.gate);
    const tokenInput = document.querySelector("#agentbridge-token");
    if (tokenInput) tokenInput.value = info.token || "";
    const urlText = document.querySelector("#agentbridge-url");
    // ⚠ #agentbridge-url 是 <input>（index.html 431 行）——input 显示靠 value 属性，textContent 赋值不渲染（v1.0.0 装机实锤空白）；
    // listening 才有 port（stop 后 boundPort 残留旧值，别用 port 判断服务在不在）
    if (urlText) urlText.value = info.listening ? `http://127.0.0.1:${info.port}/api/send` : "（HTTP 服务未启动）";
    const targetName = document.querySelector("#agentbridge-target-name");
    if (targetName) {
      const settings = await window.agentChatPro.loadSettings();
      const targetId = String(settings.agentBridgeConversationId || "");
      targetName.textContent = targetId
        ? (conversationCache.find((item) => item.id === targetId)?.title || `对话 ${targetId.slice(0, 8)}…`)
        : "跟随最新对话（未指定时自动用最新一条）";
    }
  } catch { /* 桥未就绪时忽略（设置卡保留占位） */ }
}

document.querySelector("#agentbridge-save")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const port = Number(document.querySelector("#agentbridge-port")?.value) || 0;
  const gate = Boolean(document.querySelector("#agentbridge-gate")?.checked);
  button.disabled = true;
  try {
    const info = await window.agentChatPro.setAgentBridgeConfig({ port, gate });
    await refreshAgentBridgeInfo();
    setConnection(info?.listening ? `Agent 桥已运行：127.0.0.1:${info.port}（放行${info.gate ? "开启" : "关闭"}）` : "Agent 桥配置已保存，但 HTTP 服务启动失败（端口被占用？）", info?.listening ? "connected" : "error");
  } catch (error) { setConnection("Agent 桥配置保存失败：" + error.message, "error"); }
  finally { button.disabled = false; }
});
document.querySelector("#agentbridge-copy-token")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const token = document.querySelector("#agentbridge-token")?.value || "";
  try { await navigator.clipboard.writeText(token); button.textContent = "已复制"; }
  catch { button.textContent = "复制失败"; }
  setTimeout(() => { button.textContent = "复制 Token"; }, 1500);
});
document.querySelector("#agentbridge-reset-target")?.addEventListener("click", async () => {
  try {
    await window.agentChatPro.setAgentBridgeTarget("");
    await refreshAgentBridgeInfo();
    setConnection("桥目标已重置：下一条放行消息将转发到最新对话。", "connected");
  } catch (error) { setConnection("重置失败：" + error.message, "error"); }
});
window.agentChatPro?.onAgentBridgeQueue?.((queue) => renderBridgeQueue(Array.isArray(queue) ? queue : []));
window.agentChatPro?.onAgentBridgeTurn?.((turn) => runBridgeTurn(turn));

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
// ── v3.19.0 F3：高级设置事件绑定 ──
document.querySelector("#adv-network-manual").addEventListener("click", async () => {
  // v3.21.3 修复③：以输入框当前值为准落底。旧实现用 effective（落盘实值）覆盖提交——
  // 用户改了 40 还没点保存就点「切换为手动」时，40 被旧实值 25 覆盖回输入框（实报「改 40 点保存回 25」现场）
  await saveAdvancedGroup(advNetworkPatch(), "网络设置已切换为手动（按当前输入框值落底）。");
});
document.querySelector("#adv-network-auto").addEventListener("click", () => saveAdvancedGroup({ ssh: null, external: null }, "网络设置已恢复自动识别。"));
document.querySelector("#adv-network-save").addEventListener("click", () => saveAdvancedGroup(advNetworkPatch(), "网络设置已保存，下一次请求/建隧道生效。"));
document.querySelector("#adv-cloud-manual").addEventListener("click", async () => {
  // v3.21.3 修复③：同上——以输入框当前值为准，不再吞用户已改未存的值
  await saveAdvancedGroup(advCloudPatch(), "云端模型设置已切换为手动（按当前输入框值落底）。");
});
document.querySelector("#adv-cloud-auto").addEventListener("click", () => saveAdvancedGroup({ cloud: null }, "云端模型设置已恢复自动识别。"));
document.querySelector("#adv-cloud-save").addEventListener("click", () => saveAdvancedGroup(advCloudPatch(), "云端模型设置已保存。"));

document.querySelectorAll("#adv-panel-adapter [data-adapter-key]").forEach((button) => {
  button.addEventListener("click", () => {
    pendingAdapterKey = button.dataset.adapterKey;
    // 切换选择时保留已填的附加参数值（回读输入框构造展示态）
    const adapterOptions = {
      model: document.querySelector("#adapter-opt-model").value.trim(),
      sandbox: document.querySelector("#adapter-opt-sandbox").value,
      provider: document.querySelector("#adapter-opt-provider").value.trim()
    };
    renderAdapterCard(adapterOptions);
  });
});
document.querySelector("#adapter-apply").addEventListener("click", async () => {
  const adapterOptions = {
    model: document.querySelector("#adapter-opt-model").value.trim(),
    sandbox: document.querySelector("#adapter-opt-sandbox").value,
    provider: document.querySelector("#adapter-opt-provider").value.trim()
  };
  const label = (ADV_ADAPTER_META[pendingAdapterKey] || { label: pendingAdapterKey }).label;
  await saveAdvancedGroup({ adapter: pendingAdapterKey, adapterOptions },
    pendingAdapterKey === "claude"
      ? "SSH 连接适配器已切回 Claude（内置），下一次发消息生效。"
      : `SSH 连接适配器已切到 ${label}，下一次发消息生效（各适配器会话已隔离）。`);
});
document.querySelector("#adapter-detect").addEventListener("click", async () => {
  const button = document.querySelector("#adapter-detect");
  button.disabled = true;
  setStatus("正在通过 SSH 检测 NAS 上的远端 CLI…");
  try {
    const result = await window.agentChatPro.detectSshAdapter({});
    renderAdapterDetect(result.results || []);
    setStatus("远端适配器检测完成。");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
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
      refreshDeviceControlIpTrack(status.deviceId);
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
// v3.21.0：内置清单全量重写（2026-10-05 各官方一手实锤，见 资料库/调研存档/云端AI模型清单全量-2026-10-05.md）。
// 每家全量收录当前在役模型；「拉取模型列表」按钮可实时刷新该密钥可用清单，两边互补永不落后。
// pullModels: 是否支持官方 GET /models 实拉（豆包无列表端点故为 false）。
const CLOUD_PROVIDERS = {
  zhipu: {
    name: "智谱 AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    pullModels: true,
    models: [
      { value: "glm-5.3", label: "GLM-5.3（新旗舰）" },
      { value: "glm-5.2", label: "GLM-5.2（旗舰）" },
      { value: "glm-5.1", label: "GLM-5.1" },
      { value: "glm-5-turbo", label: "GLM-5-Turbo（高速）" },
      { value: "glm-5", label: "GLM-5" },
      { value: "glm-4.7", label: "GLM-4.7" },
      { value: "glm-4.7-flash", label: "GLM-4.7-Flash（免费）" },
      { value: "glm-4.7-flashx", label: "GLM-4.7-FlashX（免费·极速）" },
      { value: "glm-4.6", label: "GLM-4.6" },
      { value: "glm-4.5-air", label: "GLM-4.5-Air" },
      { value: "glm-4.5-airx", label: "GLM-4.5-AirX（极速）" },
      { value: "glm-4.5-flash", label: "GLM-4.5-Flash（26-01-30 下线→4.7-Flash）" },
      { value: "glm-4-flash-250414", label: "GLM-4-Flash-250414（免费）" },
      { value: "glm-4-flashx-250414", label: "GLM-4-FlashX-250414（免费·极速）" },
      { value: "glm-5v-turbo", label: "GLM-5V-Turbo（视觉）" },
      { value: "glm-4.6v", label: "GLM-4.6V（视觉）" },
      { value: "glm-4.6v-flash", label: "GLM-4.6V-Flash（视觉·免费）" },
      { value: "glm-4.6v-flashx", label: "GLM-4.6V-FlashX（视觉·免费）" },
      { value: "glm-4.5v", label: "GLM-4.5V（视觉）" },
      { value: "glm-4.1v-thinking-flashx", label: "GLM-4.1V-Thinking-FlashX（视觉）" },
      { value: "glm-4.1v-thinking-flash", label: "GLM-4.1V-Thinking-Flash（视觉）" },
      { value: "glm-4v-flash", label: "GLM-4V-Flash（视觉·免费）" }
    ],
    registerUrl: "https://open.bigmodel.cn/user/apikey",
    hint: '还没有密钥？<a href="https://open.bigmodel.cn/user/apikey" id="cloud-register-link">点击免费注册智谱 AI</a>，Flash 系免费。'
  },
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1/",
    pullModels: true,
    models: [
      { value: "deepseek-flash", label: "DeepSeek V4.1-Flash（1M·支持视觉）" },
      { value: "deepseek-v4-pro", label: "DeepSeek V4-Pro（旗舰）" }
    ],
    registerUrl: "https://platform.deepseek.com/api_keys",
    hint: '还没有密钥？<a href="https://platform.deepseek.com/" id="cloud-register-link">点击注册 DeepSeek</a>。（deepseek-chat/reasoner 已于 26-07-24 退役）'
  },
  kimi: {
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1/",
    pullModels: true,
    models: [
      { value: "kimi-k3", label: "Kimi-K3（旗舰·1M）" },
      { value: "kimi-k2.7-code", label: "Kimi-K2.7-Code（编程）" },
      { value: "kimi-k2.7-code-highspeed", label: "Kimi-K2.7-Code-Highspeed（编程·高速）" },
      { value: "kimi-k2.6", label: "Kimi-K2.6" }
    ],
    registerUrl: "https://platform.moonshot.cn/console/api-keys",
    hint: '还没有密钥？<a href="https://platform.moonshot.cn/" id="cloud-register-link">点击注册 Kimi</a>。（moonshot-v1/k2.5 系已 26-08-31 下线）'
  },
  doubao: {
    name: "豆包（字节跳动）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3/",
    pullModels: false,
    models: [
      { value: "doubao-seed-evolving", label: "Doubao Seed-Evolving（统一 ID·自动升级）" },
      { value: "doubao-seed-2-1-pro-260915", label: "Doubao Seed 2.1-Pro（1M·旗舰）" },
      { value: "doubao-seed-2-1-lite-260915", label: "Doubao Seed 2.1-Lite（1M）" },
      { value: "doubao-seed-2-1-turbo-260628", label: "Doubao Seed 2.1-Turbo" },
      { value: "doubao-seed-2-0-lite-260428", label: "Doubao Seed 2.0-Lite" },
      { value: "doubao-seed-2-0-mini-260428", label: "Doubao Seed 2.0-Mini" },
      { value: "doubao-seed-2-0-pro-260215", label: "Doubao Seed 2.0-Pro（即将下线）" },
      { value: "doubao-seed-2-0-lite-260215", label: "Doubao Seed 2.0-Lite-260215（即将下线）" },
      { value: "doubao-seed-2-0-code-preview-260215", label: "Doubao Seed 2.0-Code（编程）" },
      { value: "doubao-seed-character-251128", label: "Doubao Seed Character（角色扮演）" }
    ],
    registerUrl: "https://console.volcengine.com/ark",
    hint: '还没有密钥？<a href="https://console.volcengine.com/ark" id="cloud-register-link">点击注册豆包</a>，在火山引擎控制台创建 API Key（无需接入点也可直接用 Model ID）。'
  },
  openai: {
    name: "OpenAI（ChatGPT）",
    baseUrl: "https://api.openai.com/v1/",
    pullModels: true,
    models: [
      { value: "gpt-5.4", label: "GPT-5.4（新旗舰）" },
      { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
      { value: "gpt-5.4-nano", label: "GPT-5.4-Nano（最低价）" },
      { value: "gpt-5-pro", label: "GPT-5-Pro（深度推理）" },
      { value: "gpt-5.1", label: "GPT-5.1（上一代）" },
      { value: "gpt-5", label: "GPT-5（上一代）" },
      { value: "gpt-5-codex", label: "GPT-5-Codex（编程，Responses API）" },
      { value: "gpt-5-codex-max", label: "GPT-5-Codex-Max（编程）" },
      { value: "gpt-5-codex-mini", label: "GPT-5-Codex-Mini（编程）" },
      { value: "o3-pro", label: "o3-Pro" },
      { value: "o3", label: "o3" },
      { value: "o4-mini", label: "o4-Mini" },
      { value: "gpt-oss-120b", label: "GPT-OSS-120B（开源权重）" },
      { value: "gpt-oss-20b", label: "GPT-OSS-20B（开源权重）" },
      { value: "gpt-4o", label: "GPT-4o（旧款，ChatGPT 已退役·API 在役）" },
      { value: "gpt-4.1", label: "GPT-4.1（旧款，API 在役）" },
      { value: "gpt-4.1-mini", label: "GPT-4.1-Mini（旧款）" }
    ],
    registerUrl: "https://platform.openai.com/api-keys",
    hint: '需要 OpenAI API Key。<a href="https://platform.openai.com/api-keys" id="cloud-register-link">点击管理密钥</a>。'
  },
  gemini: {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    pullModels: true,
    models: [
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash（最新）" },
      { value: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite（高吞吐）" },
      { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro（Preview）" },
      { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash（Preview）" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
      { value: "gemma-4-31b-it", label: "Gemma 4 31B（开源）" },
      { value: "gemma-4-26b-a4b-it", label: "Gemma 4 26B MoE（开源）" }
    ],
    registerUrl: "https://aistudio.google.com/apikey",
    hint: '需要 Google AI API Key。<a href="https://aistudio.google.com/apikey" id="cloud-register-link">点击获取密钥</a>，Flash-Lite 有免费额度。'
  },
  anthropic: {
    name: "Anthropic（Claude）",
    baseUrl: "https://api.anthropic.com/v1/",
    pullModels: true,
    models: [
      { value: "claude-fable-5-1", label: "Claude Fable 5.1（顶配·1M）" },
      { value: "claude-opus-5-5", label: "Claude Opus 5.5（1M）" },
      { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5（1M）" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5（最快·10-15 起退休窗口）" },
      { value: "claude-fable-5", label: "Claude Fable 5" },
      { value: "claude-opus-5", label: "Claude Opus 5" },
      { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "claude-opus-4-5", label: "Claude Opus 4.5" },
      { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" }
    ],
    registerUrl: "https://console.anthropic.com/settings/keys",
    hint: '需要 Anthropic API Key。<a href="https://console.anthropic.com/settings/keys" id="cloud-register-link">点击管理密钥</a>。'
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1/",
    pullModels: true,
    models: [
      { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B（~280tps）" },
      { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B（~560tps 极速）" },
      { value: "openai/gpt-oss-120b", label: "GPT-OSS-120B（~500tps）" },
      { value: "openai/gpt-oss-20b", label: "GPT-OSS-20B（~1000tps）" },
      { value: "qwen/qwen3.8-27b", label: "Qwen3.8-27B（视觉）" },
      { value: "minimaxai/minimax-m2.7", label: "MiniMax-M2.7" },
      { value: "openai/gpt-oss-safeguard-20b", label: "GPT-OSS-Safeguard-20B（安全审查）" },
      { value: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B" },
      { value: "groq/compound", label: "Groq Compound（联网 Agent 系统）" },
      { value: "groq/compound-mini", label: "Groq Compound-Mini（联网）" }
    ],
    registerUrl: "https://console.groq.com/keys",
    hint: '还没有密钥？<a href="https://console.groq.com/keys" id="cloud-register-link">点击注册 Groq</a>，极速推理，免费额度。'
  },
  siliconflow: {
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1/",
    pullModels: true,
    models: [
      { value: "zai-org/GLM-5.3", label: "GLM-5.3（旗舰）" },
      { value: "zai-org/GLM-5.2", label: "GLM-5.2" },
      { value: "Pro/zai-org/GLM-5.1", label: "GLM-5.1（Pro 加速版）" },
      { value: "zai-org/GLM-4.5V", label: "GLM-4.5V（视觉）" },
      { value: "zai-org/GLM-4.5-Air", label: "GLM-4.5-Air" },
      { value: "deepseek-ai/DeepSeek-V4-Flash", label: "DeepSeek V4-Flash（夜间时段半价）" },
      { value: "deepseek-ai/DeepSeek-V4-Pro", label: "DeepSeek V4-Pro（旗舰）" },
      { value: "deepseek-ai/DeepSeek-V3.2", label: "DeepSeek V3.2" },
      { value: "deepseek-ai/DeepSeek-V3.1-Terminus", label: "DeepSeek V3.1-Terminus" },
      { value: "moonshotai/Kimi-K2.7-Code", label: "Kimi K2.7-Code（编程）" },
      { value: "Pro/moonshotai/Kimi-K2.6", label: "Kimi K2.6（Pro 加速版）" },
      { value: "Qwen/Qwen3.8-27B", label: "Qwen3.8-27B" },
      { value: "Qwen/Qwen3.6-35B-A3B", label: "Qwen3.6-35B-A3B" },
      { value: "Qwen/Qwen3.6-27B", label: "Qwen3.6-27B" },
      { value: "Qwen/Qwen3.5-122B-A10B", label: "Qwen3.5-122B-A10B（MoE 大杯）" },
      { value: "Qwen/Qwen3.5-35B-A3B", label: "Qwen3.5-35B-A3B" },
      { value: "Qwen/Qwen3.5-27B", label: "Qwen3.5-27B" },
      { value: "meituan-longcat/LongCat-2.0", label: "LongCat-2.0（美团）" },
      { value: "stepfun-ai/Step-3.5-Flash", label: "Step-3.5-Flash（阶跃）" },
      { value: "tencent/Hunyuan-A13B-Instruct", label: "Hunyuan-A13B（混元·免费）" },
      { value: "XingChenAGI/Xing4.0-29B", label: "Xing4.0-29B（星尘·免费）" }
    ],
    registerUrl: "https://cloud.siliconflow.cn/",
    hint: '还没有密钥？<a href="https://cloud.siliconflow.cn/" id="cloud-register-link">点击免费注册硅基流动</a>。「🔄 拉取」可拿全量模型（内置只列主力）。'
  },
  custom: {
    name: "自定义",
    baseUrl: "",
    pullModels: true,
    models: [],
    registerUrl: "",
    hint: '填写任意 OpenAI 兼容的 API 地址和密钥。支持 one-api、new-api 等中转站。模型名手填，或填好后点「🔄 拉取」从列表选。'
  }
};

// v3.21.0：切服务商重建模型下拉，支持恢复已存档模型（savedModel 不在清单里时追加选中项，杜绝回填漂移）；
// custom 走模型名手填框；豆包无拉取端点故隐藏「🔄 拉取」按钮。
function applyCloudProviderChange(savedModel) {
  const provider = document.querySelector("#cloud-provider").value;
  const modelSelect = document.querySelector("#cloud-model");
  const customFields = document.querySelector("#cloud-custom-fields");
  const keyHint = document.querySelector("#cloud-key-hint");
  const providerHint = document.querySelector("#cloud-provider-hint");
  const fetchResult = document.querySelector("#cloud-fetch-result");
  const fetchButton = document.querySelector("#cloud-fetch-models");
  const config = CLOUD_PROVIDERS[provider];
  if (!config) return;
  // 更新模型下拉
  // v3.40.0（atomcode 审计#4）：模型名/值一律 DOM API 渲染——模型名是不可信外部数据（custom 中转站可返回任意值），模板串入 innerHTML 存在 HTML/事件属性注入面
  modelSelect.replaceChildren(...config.models.map((entry) => {
    const option = document.createElement("option");
    option.value = String(entry.value ?? "");
    option.textContent = String(entry.label ?? entry.value ?? "");
    return option;
  }));
  // 已存档模型保底：清单里有就选中；没有（例如服务商刚退役该款）就追加一条标注存档的 option 选中，保存时不漂移
  if (savedModel) {
    if (config.models.some((m) => m.value === savedModel)) {
      modelSelect.value = savedModel;
    } else if (savedModel !== "custom") {
      const archived = document.createElement("option");
      archived.value = savedModel;
      archived.textContent = `${savedModel}（已存档·清单暂无）`;
      modelSelect.appendChild(archived);
      modelSelect.value = savedModel;
    }
  }
  // 更新服务商提示
  const blurbs = {
    zhipu: "智谱 AI — GLM-4.7/GLM-4.6V Flash 系免费。",
    anthropic: "Anthropic — Claude 5.x 系按量计费，Sonnet 最均衡。"
  };
  if (providerHint) providerHint.textContent = blurbs[provider] || `${config.name} — 在下方输入 API 密钥后即可使用。`;
  // 显示/隐藏自定义字段与模型控件（custom：模型手填框 + datalist；其它：下拉）
  customFields.hidden = provider !== "custom";
  const modelLabel = document.querySelector("#cloud-model-label");
  if (modelLabel) modelLabel.hidden = provider === "custom";
  // 拉取按钮：豆包不支持官方模型列表端点，隐藏
  if (fetchButton) fetchButton.hidden = config.pullModels === false;
  if (fetchResult) {
    fetchResult.textContent = config.pullModels === false ? "该服务商无模型列表接口，从以上清单选择即可。" : "";
  }
  if (config.baseUrl) document.querySelector("#cloud-base-url").value = config.baseUrl;
  else document.querySelector("#cloud-base-url").value = "";
  // 更新密钥提示
  if (keyHint) keyHint.innerHTML = config.hint;
  // v3.15.7 注册链接接管——切服务商重写 hint 后重新绑定（否则点「点击注册 DeepSeek」等会把主窗口导航走）
  bindExternalLinks(keyHint);
}

document.querySelector("#cloud-provider")?.addEventListener("change", () => applyCloudProviderChange());

// ── v3.21.0「🔄 拉取」：走官方 GET /models 实时拉取该密钥可用的全部模型 ──
document.querySelector("#cloud-fetch-models")?.addEventListener("click", async () => {
  const button = document.querySelector("#cloud-fetch-models");
  const resultEl = document.querySelector("#cloud-fetch-result");
  if (!button || !resultEl || button.disabled) return;
  const provider = document.querySelector("#cloud-provider")?.value || "zhipu";
  const config = CLOUD_PROVIDERS[provider];
  if (!config || config.pullModels === false) return;
  const apiKey = document.querySelector("#cloud-api-key")?.value || ""; // 留空时主进程用已保存密钥兜底
  const baseUrl = document.querySelector("#cloud-base-url")?.value || config.baseUrl || "";
  button.disabled = true;
  button.textContent = "拉取中…";
  resultEl.textContent = "正在请求官方模型列表…";
  try {
    const result = await window.agentChatPro.fetchCloudModels({ provider, apiKey, baseUrl });
    if (!result?.ok) {
      resultEl.textContent = `⚠️ ${result?.reason || "拉取失败，请检查密钥和网络"}`;
      return;
    }
    // custom：填 datalist（手填框照用）；其它：全量替换下拉并保持当前选中
    // v3.40.0（atomcode 审计#4）：模型清单来自服务商 API 返回（custom 中转站=任意第三方 URL），
    // 属不可信外部输入——一律 DOM API 渲染，杜绝 <img onerror> 之类事件属性注入（CSP 只是兜底不是消毒）
    if (provider === "custom") {
      const datalist = document.querySelector("#cloud-custom-model-list");
      if (datalist) {
        datalist.replaceChildren(...result.models.map((m) => {
          const option = document.createElement("option");
          option.value = String(m.value ?? "");
          option.textContent = String(m.label === m.value ? "" : (m.label ?? m.value ?? ""));
          return option;
        }));
      }
      resultEl.textContent = `✅ 已拉取 ${result.count} 个模型，点模型输入框可从列表选择`;
    } else {
      const modelSelect = document.querySelector("#cloud-model");
      const current = modelSelect?.value || "";
      modelSelect.replaceChildren(...result.models.map((m) => {
        const option = document.createElement("option");
        option.value = String(m.value ?? "");
        option.textContent = String(m.label ?? m.value ?? "");
        return option;
      }));
      if (current && result.models.some((m) => m.value === current)) modelSelect.value = current;
      resultEl.textContent = `✅ 已拉取 ${result.count} 个该密钥可用的模型`;
    }
  } catch (error) {
    resultEl.textContent = `⚠️ 拉取失败：${error?.message || error}`;
  } finally {
    button.disabled = false;
    button.textContent = "🔄 拉取";
  }
});

// v3.15.7 静态初始提示（页面加载时的智谱注册链接）同样接管
bindExternalLinks(document.querySelector("#cloud-key-hint"));

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

// ── 云办公二期 v3.22.0：沙箱状态检测 + 临时联网切换（立即生效，非表单保存） ──
document.querySelector("#cloud-sandbox-network-enabled")?.addEventListener("change", async () => {
  const toggle = document.querySelector("#cloud-sandbox-network-enabled");
  const hint = document.querySelector("#cloud-sandbox-status-text");
  if (!toggle) return;
  const wanted = toggle.checked;
  toggle.disabled = true;
  try {
    const result = await window.agentChatPro.setSandboxNetwork(wanted);
    if (!result.ok) {
      toggle.checked = !wanted; // 切换失败回拨勾选态与实际网络一致
      if (hint) hint.textContent = `联网切换失败：${result.error}`;
    } else if (hint) {
      hint.textContent = wanted ? "沙箱已临时连网（用完记得取消勾选恢复断网）。" : "沙箱已恢复断网（外网数据泄出通道已关闭）。";
    }
  } catch (error) {
    toggle.checked = !wanted;
    if (hint) hint.textContent = `联网切换失败：${error.message || error}`;
  } finally {
    toggle.disabled = false;
  }
});
document.querySelector("#cloud-sandbox-status")?.addEventListener("click", async () => {
  const hint = document.querySelector("#cloud-sandbox-status-text");
  if (!hint) return;
  hint.textContent = "检测中…";
  try {
    const status = await window.agentChatPro.getSandboxStatus();
    if (!status.ok) {
      hint.textContent = `沙箱状态检测失败：${status.error}`;
      return;
    }
    const stateText = status.container === "running" ? "运行中" : status.container === "stopped" ? "已停止" : "未安装（容器不存在）";
    const networkText = status.container === "missing" ? "" : status.networkOn ? " · 已临时连网" : " · 断网隔离中";
    hint.textContent = `沙箱容器：${stateText}${networkText}`;
  } catch (error) {
    hint.textContent = `沙箱状态检测失败：${error.message || error}`;
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
  if (activeId) {
    // v3.15.6：忙碌按钮语义按任务归属分派——进行中任务属于本对话才触发停止，
    // 任务属于其他对话时走发送路径（sendMessage 内部给出明确提示，不再误停别人的任务）
    if (streamingConversationId === conversationId) stopActiveMessage();
    else sendMessage();
  } else sendMessage();
});
elements.composer.addEventListener("click", (event) => {
  if (event.target === elements.composer) focusPrompt(true);
});
// ── v3.40.0：输入栏镜像层（指令关键词橙标）+ @ 成员浮层（群聊）─────────────────
// 镜像层：textarea 文字透明，镜像 div 渲染同一文本（转义+橙色指令词 span）——textarea 不支持局部着色的成熟绕法
const AUTODISCUSS_PATTERN = "自主讨论|自主聊天|自主对话";
const AUTODISCUSS_HAS_RE = new RegExp(AUTODISCUSS_PATTERN); // test 用（无 g 标志无 lastIndex 状态坑）
const AUTODISCUSS_STRIP_RE = new RegExp(AUTODISCUSS_PATTERN, "g"); // replace 用（g 标志；与 HAS_RE 分开正是为了避开 /g 的 lastIndex 状态坑）
const atPopoverState = { open: false, items: [], index: 0, atStart: -1, query: "" };
let atPopoverEl = null;

function escapeHTMLForMirror(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/** 群聊布局时以镜像层渲染输入文本；单聊/空值=关闭镜像（textarea 直显，placeholder 正常可见） */
function renderPromptMirror() {
  const prompt = elements.prompt;
  const mirror = document.querySelector("#prompt-mirror");
  if (!prompt || !mirror) return;
  const isGroupMode = Boolean(document.querySelector("#group-toolbar"));
  const text = prompt.value;
  if (!isGroupMode || !text) {
    mirror.hidden = true;
    mirror.textContent = "";
    prompt.classList.remove("mirror-on");
    return;
  }
  mirror.hidden = false;
  prompt.classList.add("mirror-on");
  const safe = escapeHTMLForMirror(text).replace(new RegExp(AUTODISCUSS_PATTERN, "g"), '<span class="autodiscuss-token">$1</span>');
  mirror.innerHTML = `${safe}\n`; // 尾随空行让镜像内容高度 ≥ textarea 滚动总高（末行不裁切）
  mirror.scrollTop = prompt.scrollTop;
  mirror.scrollLeft = prompt.scrollLeft;
}

function closeAtPopover() {
  atPopoverState.open = false;
  atPopoverState.items = [];
  atPopoverState.atStart = -1;
  if (atPopoverEl) { atPopoverEl.remove(); atPopoverEl = null; }
}

/** 光标前 @词检测：@ 需在行头/空白之后，词内不含空白/@；命中返回 { start, query } */
function detectAtContext(el) {
  const pos = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, pos);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  // @ 前置边界：行头/空白/中文字符之后都可触发（「帮我@小助手」这类中文连打是主场景）；
  // 仅当 @ 紧贴在英数字/符号词内（如邮箱前缀）才视为普通文本不弹层
  if (at > 0 && !/\s/.test(before[at - 1]) && !/[一-龥　-〿＀-￯]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/[\s@]/.test(query)) return null;
  return { start: at, query };
}

function paintAtActive() {
  if (!atPopoverEl) return;
  Array.from(atPopoverEl.children).forEach((node) => {
    if (node.dataset && node.dataset.atIndex) node.classList.toggle("active", node.dataset.atIndex === String(atPopoverState.index));
  });
}

/** @ 浮层渲染（仅群聊）：群成员按已输入片段过滤；无匹配即关闭 */
function renderAtPopover() {
  const prompt = elements.prompt;
  if (!document.querySelector("#group-toolbar") || !groupRosterAgents.length) { closeAtPopover(); return; }
  const ctx = detectAtContext(prompt);
  if (!ctx) { closeAtPopover(); return; }
  const roster = groupRosterAgents.filter((agent) => !ctx.query || String(agent.name || "").toLowerCase().includes(ctx.query.toLowerCase()));
  if (!roster.length) { closeAtPopover(); return; }
  const wrap = prompt.closest(".prompt-wrap");
  if (!wrap) return;
  if (!atPopoverEl) {
    atPopoverEl = document.createElement("div");
    atPopoverEl.id = "at-popover";
    const hint = document.createElement("div");
    hint.className = "at-hint";
    hint.textContent = "↑↓ 选择成员 · Enter/Tab 确认 · Esc 关闭";
    atPopoverEl.appendChild(hint);
    wrap.appendChild(atPopoverEl);
  }
  atPopoverState.open = true;
  atPopoverState.atStart = ctx.start;
  atPopoverState.items = roster;
  if (ctx.query !== atPopoverState.query) atPopoverState.index = 0;
  atPopoverState.query = ctx.query;
  if (atPopoverState.index >= roster.length) atPopoverState.index = 0;
  atPopoverEl.querySelectorAll(".at-item").forEach((node) => node.remove());
  roster.forEach((agent, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "at-item" + (i === atPopoverState.index ? " active" : "");
    item.dataset.atIndex = String(i);
    item.textContent = `@${agent.name}`;
    item.addEventListener("mousedown", (event) => { event.preventDefault(); atPopoverState.index = i; acceptAt(agent); });
    atPopoverEl.appendChild(item);
  });
}

/** 浮层确认：替换 @片段 → @名字+空格，光标回位并刷新镜像层 */
function acceptAt(agent) {
  const prompt = elements.prompt;
  const start = atPopoverState.atStart;
  closeAtPopover();
  if (start < 0 || !agent) return;
  const pos = prompt.selectionStart ?? prompt.value.length;
  prompt.value = `${prompt.value.slice(0, start)}@${agent.name} ${prompt.value.slice(pos)}`;
  const caret = start + String(agent.name || "").length + 2;
  prompt.focus();
  try { prompt.setSelectionRange(caret, caret); } catch { /* 光标不可设则忽略 */ }
  renderPromptMirror();
}

function onPromptInputChanged() {
  renderPromptMirror();
  renderAtPopover();
}

elements.prompt.addEventListener("input", () => { adjustTextarea(); onPromptInputChanged(); });
elements.prompt.addEventListener("scroll", () => {
  const mirror = document.querySelector("#prompt-mirror");
  if (!mirror || mirror.hidden) return;
  mirror.scrollTop = elements.prompt.scrollTop;
  mirror.scrollLeft = elements.prompt.scrollLeft;
});
document.querySelector("#attach").addEventListener("click", () => elements.filePicker.click());

// ── v3.36.0 输入栏「听说」：麦克风语音输入（点击开始录音，说完再点一次，云端转录把文字插进输入框）──
// Electron 内置 webkitSpeechRecognition 在 Electron 里从未真正可用（electron#46143 维护者确认依赖
// Chrome 专属云服务），故录音走渲染层 WebAudio 采 16kHz 单声道 WAV → voice:transcribe IPC →
// 云端转录端点（智谱/硅基流动/OpenAI/Groq，密钥用连接设置已保存的云配置，零新增配置）。
const voiceButton = document.querySelector("#voice");
const VOICE_DEFAULT_PLACEHOLDER = elements.prompt?.placeholder || "给 Agent 发消息…（Enter 发送，Shift + Enter 换行）";
let voiceSession = null; // { stream, audioContext, source, processor, chunks, sampleRate, startedAt, timer, maxSeconds }

function voiceIdle() {
  if (!voiceButton) return;
  voiceButton.classList.remove("recording", "working");
  voiceButton.disabled = false;
  voiceButton.textContent = "🎤 听说";
}
// 失败提示短暂写进输入栏 placeholder（10 秒后还原，或用户重新点「听说」前一直可见）
let voiceTipTimer = null;
function voiceShowTip(reason) {
  if (!elements.prompt) return;
  elements.prompt.placeholder = reason;
  clearTimeout(voiceTipTimer);
  voiceTipTimer = setTimeout(() => { elements.prompt.placeholder = VOICE_DEFAULT_PLACEHOLDER; }, 10000);
}

function voiceResampleMerge(chunks, sourceRate) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  if (sourceRate === 16000 || total === 0) return { samples: merged, rate: 16000 };
  const outLength = Math.round((total * 16000) / sourceRate);
  const out = new Float32Array(outLength);
  const step = sourceRate / 16000;
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = merged[idx] || 0;
    const b = merged[idx + 1] || a;
    out[i] = a + (b - a) * frac;
  }
  return { samples: out, rate: 16000 };
}

function voiceEncodeWav(samples, sampleRate) {
  const count = samples.length;
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function voiceTeardown() {
  if (!voiceSession) return;
  try { clearInterval(voiceSession.timer); } catch { /* 忽略 */ }
  try { voiceSession.processor?.disconnect(); } catch { /* 忽略 */ }
  try { voiceSession.source?.disconnect(); } catch { /* 忽略 */ }
  try { voiceSession.stream?.getTracks().forEach((track) => track.stop()); } catch { /* 忽略 */ }
  try { voiceSession.audioContext?.close(); } catch { /* 忽略 */ }
  voiceSession = null;
}

function voiceBytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function voiceInsertText(text) {
  const el = elements.prompt;
  if (!el) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const glue = before && !/\s$/.test(before) ? " " : "";
  el.value = `${before}${glue}${text}${after}`;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  const caret = (before + glue + text).length;
  el.setSelectionRange(caret, caret);
}

async function startVoiceInput() {
  if (voiceSession) return;
  const info = await window.agentChatPro.voiceInfo().catch(() => null);
  if (!info?.ok || !info.supported || !info.hasKey) {
    voiceIdle();
    voiceShowTip(info?.reason || (!info?.hasKey ? "尚未在连接设置保存云端 API Key，先去「连接设置 → 云端 AI」保存再用听说。" : "语音输入暂不支持当前云端服务商。"));
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    voiceShowTip("当前环境不支持麦克风录音（mediaDevices 不可用）。");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch (error) {
    const reasonBy = {
      NotAllowedError: "麦克风权限被拒绝：允许本 App 使用麦克风，或检查 Windows 设置 → 隐私 → 麦克风。",
      PermissionDeniedError: "麦克风权限被拒绝：允许本 App 使用麦克风，或检查 Windows 设置 → 隐私 → 麦克风。",
      NotFoundError: "没有找到可用的麦克风设备。",
      NotReadableError: "麦克风被其他程序占用，关闭占用它的应用后重试。",
    };
    voiceShowTip(reasonBy[error?.name] || `无法打开麦克风：${error?.message || error}`);
    return;
  }
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (event) => {
    // 直接持有拷贝，onaudioprocess 的复用缓冲会被内部回收写穿
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(audioContext.destination); // ScriptProcessor 不连 destination 不出回调
  const sampleRate = audioContext.sampleRate;
  const maxSeconds = Math.max(5, Math.min(Number(info.maxSeconds) || 60, 300));
  voiceSession = { stream, audioContext, source, processor, chunks, sampleRate, startedAt: Date.now(), timer: 0, maxSeconds };
  voiceButton.classList.add("recording");
  voiceButton.textContent = "■ 停止";
  if (elements.prompt) elements.prompt.placeholder = `正在听说…说完点「停止」结束（最长 ${maxSeconds} 秒，Esc 取消）`;
  voiceSession.timer = setInterval(() => {
    if (voiceSession && (Date.now() - voiceSession.startedAt) / 1000 >= voiceSession.maxSeconds) stopVoiceInput(true);
  }, 250);
}

async function stopVoiceInput(commit) {
  const session = voiceSession;
  if (!session) return;
  const elapsedSeconds = (Date.now() - session.startedAt) / 1000;
  voiceTeardown();
  voiceButton.classList.remove("recording");
  if (!commit) {
    if (elements.prompt) elements.prompt.placeholder = VOICE_DEFAULT_PLACEHOLDER;
    voiceIdle();
    return;
  }
  const { samples, rate } = voiceResampleMerge(session.chunks, session.sampleRate);
  if (elapsedSeconds < 0.6 || samples.length < 1600) {
    voiceIdle();
    voiceShowTip("录音太短（不足 0.6 秒），请按住节奏说完再点「停止」。");
    return;
  }
  const wavBytes = voiceEncodeWav(samples, rate);
  const audioBase64 = voiceBytesToBase64(wavBytes);
  voiceButton.classList.add("working");
  voiceButton.disabled = true;
  voiceButton.textContent = "…识别中";
  if (elements.prompt) elements.prompt.placeholder = "正在识别语音…";
  try {
    const result = await window.agentChatPro.voiceTranscribe({ audioBase64, seconds: elapsedSeconds });
    if (!result?.ok) {
      voiceShowTip(result?.reason || "语音识别失败，请稍后再试。");
      return;
    }
    voiceInsertText(String(result.text || ""));
  } catch (error) {
    voiceShowTip(`语音识别失败：${error?.message || error}`);
  } finally {
    if (elements.prompt) elements.prompt.placeholder = VOICE_DEFAULT_PLACEHOLDER;
    voiceIdle();
  }
}

if (voiceButton) {
  voiceButton.addEventListener("click", () => {
    if (voiceSession) stopVoiceInput(true);
    else startVoiceInput();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && voiceSession && !event.defaultPrevented) {
      event.stopPropagation();
      stopVoiceInput(false);
    }
  });
  window.addEventListener("beforeunload", () => voiceTeardown());
}
// ── 输入栏模式弹出菜单 ──────────────────────────────────

let composerModePopupOpen = false;

function closeComposerModePopup() {
  composerModePopupOpen = false;
  if (elements.composerModePopup) elements.composerModePopup.hidden = true;
}

// v3.24.0 输入栏模式选择 → 思考调节（Codex 风格面板：上=模型名，下滑条按模型原生挡位；底部=工作模式快捷 chips）。
// 挡位表主进程 thinking-levels.cjs 维护（provider+model 匹配，四字段族映射注入）；SSH/本机 claude 走工作模式 thinkingLevel。
// v3.24.2：挡位序 eco 最前（用户拍板）→ 默认 → 强度递增；文案统一 轻度/中等/最高
const THINK_SSH_LEVELS = [
  { id: "eco", label: "ECO", hint: "零思考注入，最省 token（CLI 与默认挡一致）" },
  { id: "off", label: "默认", hint: "不传 --thinking-level（CLI 默认）" },
  { id: "low", label: "轻度", hint: "较浅思考，省 token 且更快" },
  { id: "medium", label: "中等", hint: "常规深度（Claude 默认档位）" },
  { id: "high", label: "最高", hint: "最深思考，适合复杂任务" }
];
const THINK_CLAUDE_LEVEL_IDS = { eco: "eco", off: "none", low: "low", medium: "medium", high: "high" };
// v3.24.1：落库值域（eco/none/low/medium/high，与 mode.thinkingLevel 同域）→ UI 挡位 id
const THINK_CLAUDE_LEVEL_REVERSE = { eco: "eco", none: "off", low: "low", medium: "medium", high: "high" };
// v3.24.2：最高挡彩蛋（随机三选一，2s 后消失）
const THINK_EGG_LINES = ["更高的工作质量", "燃烧你的钱包吧！", "更快的消耗额度"];

// v3.25.1 轨道刻度+文案同几何对齐（DeepSeek UI 建议落地；纯渲染层，thinking-levels.cjs 零触碰）。
// 几何实锤：input range 的 thumb 中心可动区是 [半径R, 轨道宽-R]（首尾挡 thumb 不出轨）——
// 第 i 挡中心 = 7px + (100% - 14px)·i/(N-1)。刻度点、挡位文案、thumb 落位三层同用此函数 → 绝对居中对齐。
// key fix（装机自查 2026-10-24）：left 用 CSS calc 表达式（%+px 混合）而非「读 clientWidth 再算百分数」——
// 挡位浮层首次打开时 refresh 在 hidden（display:none）态执行，此时 clientWidth=0，百分数几何会疯狅乱飞；
// calc 形态由浏览器在元素显示后按真实宽度解析，与时序/隐藏态完全解耦。挡位数动态（各家 2~7 档）。
// v3.25.3（用户令 2026-10-27 批注图）：thumb=白色正圆、轨道同径同收口（胶囊 26×14 撤销——
// 用户翻旧账：几个版本始终没给到圆的）；刻度点/文案几何随 R=8 与 thumb 中心三点重合。
// v3.25.6（用户令 2026-10-29「我说了是拉宽，是将半圆边的直径变大」）：半圆直径 16→24px——
// 轨道加粗至 24px 高（端部半圆直径=24），thumb 白圆按「半径相同」铁令同步 24px（半径 12）同径嵌合。
const THINK_THUMB_RADIUS = 12; // 与 styles.css thumb 白圆 24px（=轨道半圆直径 24）同步改（半径）
// v3.25.4（用户令 2026-10-29「两端的定位点：最左的往右点，最右的往左点」）：刻度带内收——
// 定位点不再贴轨道端部半圆弧，全表在 [R+INSET, 宽-R-INSET] 区间等分重排（中间诸点同步内缩）。
// 端点挡 thumb 白圆（v3.25.6 起直径 24，中心 R12+偏移）覆盖 [0,24] 仍罩住内收后的端点刻度（17∈[0,24]），选中不露点。
const THINK_TRACK_INSET = 5; // 刻度带两端各内收 5px（首尾点离轨道端部弧线 5px）
const thinkMarkLefts = (count) => {
  const n = Math.max(1, Math.floor(Number(count) || 0));
  if (n === 1) return ["50%"];
  const pad = THINK_THUMB_RADIUS + THINK_TRACK_INSET;
  return Array.from({ length: n }, (_, i) => `calc(${pad}px + (100% - ${pad * 2}px)*${i}/${n - 1})`);
};

// v3.24.3：SSH/本机挡位浮层顶行补模型型号（装机反馈「没显示模型型号」）——
// 型号来源优先级：模式显式 modelConfig.model（构建命令同款 sanitize 去 [后缀]）> 远程/本机 Claude 实际生效模型
// （getModelStatus 读 ~/.claude/settings.json——SSH 走远端 cat、本机走 fs，main.cjs 按连接方式分派）；
// 5 分钟 TTL 缓存防面板开合反复建 SSH 连接；拿不到/未连接静默不追加（只显模式名）。
// stamp 防竞态：面板任何重建（切模式/切连接方式/换挡渲染）都作废旧异步结果，过期回包不写 modelEl。
let thinkModelCache = null; // { model: string, at: number }
// v3.25.1 顶行体系（用户令 2026-10-24）：（连接模式）•（模型 工作模式英文标 思考挡英文标）——例 ssh•GLM 5.3 flash auto eco；
// 「当前挡位」行删除（挡位名由下方 active 文案+顶行英文标承担）。工作模式三改 id 保留（完全权限 auto/高危审批 High-Risk Approval/按需审批 On-Demand Approval）；
// 思考挡英标：默认(off)不加字/eco/low/middle/high；ultra/Max 仅云端挡位表存在；kimi/qwen 的 on（开=默认态）同 off 无标；GLM5「超高」(xhigh) 用户表未列，补字面 xhigh。
const WORK_MODE_EN = { automatic: "auto", regular: "High-Risk Approval", eco: "On-Demand Approval" };
const THINK_LEVEL_EN = { eco: "eco", off: "", low: "low", medium: "middle", high: "high", xhigh: "xhigh", ultra: "ultra", max: "Max", on: "" };
const composeThinkTop = (conn, model, modeId, levelId) => {
  const connLabel = conn === "cloud" ? "cloud" : conn === "local" ? "local" : "ssh";
  const modeEn = WORK_MODE_EN[modeId] || ""; // 自定义模式无英标：省略，模型名原样
  const levelEn = THINK_LEVEL_EN[levelId] ?? "";
  const tail = [String(model || "").trim(), modeEn, levelEn].filter(Boolean).join(" ");
  return `${connLabel}•${tail || "未设置模型"}`;
};
let thinkModelStamp = 0;
const THINK_MODEL_TTL = 5 * 60 * 1000;
const thinkModeModelText = (mode) => {
  const raw = String(mode?.modelConfig?.model || "").trim();
  return raw.replace(/\[[^\]]*\]$/g, "").trim();
};
const fetchThinkRemoteModel = async () => {
  const cached = thinkModelCache;
  if (cached && Date.now() - cached.at < THINK_MODEL_TTL) return cached.model;
  try {
    const status = await window.agentChatPro.getModelStatus();
    const model = String(status?.model || "").trim();
    thinkModelCache = { model, at: Date.now() };
    return model;
  } catch {
    return cached ? cached.model : ""; // 拉取失败：有过期缓存沿用旧值，否则空
  }
};

async function refreshComposerModePopup() {
  const modelEl = document.querySelector("#think-model");
  const slider = document.querySelector("#think-slider");
  const levelsRow = document.querySelector("#think-levels");
  const ticksRow = document.querySelector("#think-ticks");
  const meta = document.querySelector("#think-meta");
  const modesRow = document.querySelector("#think-modes");
  // 面板骨架不存在（HTML 未升级/桥版）→ 静默退出
  if (!slider || !modesRow || !ticksRow) return;

  const applyChoice = async (choiceId) => {
    try {
      if (currentConnectionMode === "cloud") {
        const snapshot = await window.agentChatPro.loadSettings();
        const provider = snapshot.cloudAiProvider || "zhipu";
        const model = snapshot.cloudAiModel || "";
        const cloudChoices = { ...((snapshot.thinkingChoices || {}).cloud || {}), [`${provider}/${model}`]: choiceId };
        await window.agentChatPro.saveSettings({ ...snapshot, thinkingChoices: { ...(snapshot.thinkingChoices || {}), cloud: cloudChoices } });
      } else {
        // v3.24.1：SSH/本机挡位=会话偏好，存 settings.thinkingChoices.ssh[工作模式]（与云端 cloud[provider/model] 同构）。
        // 不再写模式定义——内置模式守卫拒改导致 v3.24.0 装机报「内置模式不可修改」（真机截图实锤）；
        // 执行链 resolveMode 读偏好覆盖模式默认挡位（内置三模式 none/medium/none 默认继续生效）。
        const snapshot = await window.agentChatPro.loadSettings();
        const modeKey = currentModeId || "regular";
        const sshChoices = { ...((snapshot.thinkingChoices || {}).ssh || {}), [modeKey]: THINK_CLAUDE_LEVEL_IDS[choiceId] || "none" };
        await window.agentChatPro.saveSettings({ ...snapshot, thinkingChoices: { ...(snapshot.thinkingChoices || {}), ssh: sshChoices } });
      }
      await refreshComposerModePopup();
    } catch (error) { setConnection("思考挡位保存失败：" + error.message, "error"); }
  };

  // ↻ 重置按钮可见性（v3.24.1 机制保留；v3.25.1 简洁化删除挡位名大字行）
  const renderMeta = (_active, hasMemory) => {
    meta.innerHTML = ""; // 简洁化（用户令 2026-10-24）：「当前挡位」行删除，挡位名由下方 active 文案+顶行英文标承担；容器保留（id 锚/桥版兼容）
    const resetBtn = document.querySelector("#think-reset");
    if (resetBtn) resetBtn.hidden = !hasMemory;
  };
  // ↻ 重置 = 清除当前模型/工作模式的挡位偏好记忆，回默认挡位（云端=服务商默认；SSH/本机=模式默认挡位）
  const resetChoice = async () => {
    try {
      const snapshot = await window.agentChatPro.loadSettings();
      const thinkingChoices = { ...(snapshot.thinkingChoices || {}) };
      if (currentConnectionMode === "cloud") {
        const provider = snapshot.cloudAiProvider || "zhipu";
        const model = snapshot.cloudAiModel || "";
        const cloud = { ...((thinkingChoices || {}).cloud || {}) };
        delete cloud[`${provider}/${model}`];
        thinkingChoices.cloud = cloud;
      } else {
        const ssh = { ...((thinkingChoices || {}).ssh || {}) };
        delete ssh[currentModeId || "regular"];
        thinkingChoices.ssh = ssh;
      }
      await window.agentChatPro.saveSettings({ ...snapshot, thinkingChoices });
      await refreshComposerModePopup();
    } catch (error) { setConnection("挡位重置失败：" + error.message, "error"); }
  };
  const resetBtn = document.querySelector("#think-reset");
  if (resetBtn) resetBtn.onclick = resetChoice;

  // ── v3.24.2 挡位条主题（用户拍板细节）──
  // eco=绿系整轨渐变（深绿→绿→浅绿→白，白段浅绿颗粒）；其他挡（默认除外）=蓝系按滑距填充（白→浅蓝→蓝→深蓝）；默认=素灰。
  // 填充长度走 CSS background-size 变量 + transition（Electron Chromium 原生平滑动画）。
  const renderSliderTheme = (slider, levels) => {
    const index = Number(slider.value);
    const active = levels[index] || levels[0];
    // v3.25.2 层序修复：轨道渐变背景挪 .think-track-wrap::before——--fill/--eco 改设 wrap（伪元素 var() 继承父级）；
    // eco/blue class 仍留在 slider（thumb 描边/光环选择器 .think-slider.blue|.eco 依赖）
    const wrap = slider.parentElement || slider;
    if (!active || active.id === "off") {
      slider.classList.remove("eco", "blue");
      wrap.style.setProperty("--fill", "0%");
      wrap.style.setProperty("--eco", "0%");
      return;
    }
    if (active.id === "eco") {
      slider.classList.add("eco");
      slider.classList.remove("blue");
      wrap.style.setProperty("--fill", "0%");
      wrap.style.setProperty("--eco", "100%");
      return;
    }
    const ratio = levels.length > 1 ? index / (levels.length - 1) : 1;
    slider.classList.add("blue");
    slider.classList.remove("eco");
    wrap.style.setProperty("--fill", `${(ratio * 100).toFixed(1)}%`);
    wrap.style.setProperty("--eco", "0%");
  };
  // 挡位 chips 颜色与轨道色系统一：eco=深绿；默认=灰白；其余按 index 蓝系四阶插值（白→浅蓝→蓝→深蓝）
  // v3.25.1 配色追改：蓝系渐进基色齐步换 Codex 图提取纯蓝 #3878f0 族（浅蓝 #9db4f7/深蓝 #1e3a8a）
  const THINK_CHIP_RAMP = [[203, 213, 225], [157, 180, 247], [56, 120, 240], [30, 58, 138]];
  const chipColor = (index, count) => {
    if (index === 1 || count <= 2) return "rgb(203, 213, 225)";
    const t = Math.max(0, Math.min(1, (index - 1) / Math.max(1, count - 2)));
    const s = t * 3;
    const seg = Math.min(2, Math.floor(s));
    const frac = s - seg;
    const c = THINK_CHIP_RAMP[seg];
    const n = THINK_CHIP_RAMP[seg + 1];
    const mix = (a, b, t2) => Math.round(a + (b - a) * t2);
    return `rgb(${mix(c[0], n[0], frac)}, ${mix(c[1], n[1], frac)}, ${mix(c[2], n[2], frac)})`;
  };
  // v3.25.1：挡位渲染改为「轨道内刻度点 + 下方文案」双层，同一几何函数定位（thinkMarkLefts）——
  // 原 renderChips 的 flex space-between 文字中心与 thumb 中心有系统性偏差，本版三点重合；
  // chips 渐进色语义保留（文字沿用 chipColor 插值，eco=深绿/默认=灰白/其余蓝系四阶）。
  // 不读 clientWidth（hidden 态渲染时 clientWidth=0 会让几何疯狅——calc 表达式免疫时序，见 thinkMarkLefts 注）
  const renderTrackMarks = (ticksRow, labelsRow, levels, activeIndex) => {
    const lefts = thinkMarkLefts(levels.length);
    ticksRow.replaceChildren();
    labelsRow.replaceChildren();
    levels.forEach((level, index) => {
      const left = lefts[index] ?? "50%";
      const tick = document.createElement("span");
      tick.className = `think-tick${index === activeIndex ? " active" : ""}${level.id === "eco" ? " eco" : ""}`;
      tick.style.left = left;
      ticksRow.append(tick);
      const label = document.createElement("span");
      label.className = `think-level${index === activeIndex ? " active" : ""}`;
      label.textContent = level.label;
      label.title = level.hint || "";
      label.style.color = level.id === "eco" ? "rgb(22, 101, 52)" : chipColor(index, levels.length);
      label.style.left = left;
      // 挡位文案全表中心锚（v3.25.2 装机位移修复，用户拍板 A）：文字中心=刻度中心=胶囊中心三点重合——
      // v3.25.1 终版首尾「贴端对齐」（07e6c2e 吸收 DeepSeek 令）实锤位移：首挡文字左缘压在胶囊中心线上
      // → ECO 文字中心偏右半字（11.5px）、末挡「最高」中心偏左半字（12.5px），真机截图（ECO/最高两端端点挡）实锤；
      // 中心锚八挡 GLM5 首尾出血 ±6px 由浮层 6px 内边距兜住（68188c5 时代形态，装机无位移报告）
      label.style.transform = "translateX(-50%)";
      labelsRow.append(label);
    });
  };
  // v3.25.1：拖动/选挡时轻量同步 active（不重建 DOM 防闪烁）
  const syncMarkActive = (ticksRow, labelsRow, activeIndex) => {
    Array.from(ticksRow.children).forEach((el, i) => el.classList.toggle("active", i === activeIndex));
    Array.from(labelsRow.children).forEach((el, i) => el.classList.toggle("active", i === activeIndex));
  };
  // 最高挡彩蛋：拉到最高挡瞬间，面板下方随机文案显示 2s 后淡出
  let thinkEggTimer = null;
  const showThinkEgg = () => {
    const egg = document.querySelector("#think-egg");
    if (!egg) return;
    egg.textContent = THINK_EGG_LINES[Math.floor(Math.random() * THINK_EGG_LINES.length)];
    egg.hidden = false;
    requestAnimationFrame(() => egg.classList.add("show"));
    if (thinkEggTimer) clearTimeout(thinkEggTimer);
    thinkEggTimer = setTimeout(() => {
      egg.classList.remove("show");
      setTimeout(() => { egg.hidden = true; }, 260);
    }, 2000);
  };
  const maybeShowThinkEgg = (levels, index) => {
    const active = levels[index];
    if (active && index === levels.length - 1 && active.id !== "eco") showThinkEgg();
  };

  // ── v3.35.7 群聊思考面板：群里多少个 AI，就按各自模型支持的档位一节一节往上叠（每成员独立滑条+预计消耗倍数）──
  // 独立精神延续：每成员一节独立滑条绝不共用；云端成员挡位落 agent-pool 节点 thinkingLevel（runCloudMemberTurn 注入链同源）；
  // SSH/本机成员挡位由引擎/工作模式决定，群内不单独注入（面板只说明，不给可控滑条）。
  const buildGroupMemberThinkRow = async (node) => {
    const section = document.createElement("div");
    section.className = "think-group-member agent-kind-" + (node.kind || "cloud");
    const head = document.createElement("div");
    head.className = "think-member-head";
    const nameTag = document.createElement("span");
    nameTag.className = "think-member-name";
    nameTag.textContent = "@" + node.name;
    const kindTag = document.createElement("span");
    const kindLabel = node.kind === "cloud" ? "云端" : node.kind === "ssh" ? "SSH" : "本机";
    kindTag.className = "think-member-kind";
    kindTag.textContent = kindLabel;
    head.append(nameTag, kindTag);
    section.append(head);
    if (node.kind !== "cloud") {
      const note = document.createElement("div");
      note.className = "think-member-note";
      note.textContent = "挡位由实例引擎/工作模式决定，群内不单独注入";
      section.append(note);
      return section;
    }
    const model = node.cloud?.model || "";
    const modelTag = document.createElement("div");
    modelTag.className = "think-member-model";
    modelTag.textContent = model || "（未设置模型）";
    section.append(modelTag);
    let profile = null;
    try { profile = (await window.agentChatPro.getThinkingProfile({ provider: node.cloud?.provider, model })).profile; } catch {}
    if (!profile || !Array.isArray(profile.levels) || !profile.levels.length) {
      const note = document.createElement("div");
      note.className = "think-member-note";
      note.textContent = "该模型不支持思考调节";
      section.append(note);
      return section;
    }
    const levels = profile.levels;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "think-slider think-group-slider";
    slider.min = "0"; slider.max = String(levels.length - 1); slider.step = "1"; slider.value = "0";
    const wrap = document.createElement("div"); // 轨道渐变变量的消费者（renderSliderTheme 写 slider.parentElement 的 --fill/--eco）
    wrap.className = "think-track-wrap";
    const ticksRow = document.createElement("div");
    ticksRow.className = "think-ticks";
    const labelsRow = document.createElement("div");
    labelsRow.className = "think-levels";
    const costRow = document.createElement("div");
    costRow.className = "think-member-cost";
    const applyIndex = (index) => {
      const active = levels[index] || levels[0];
      costRow.textContent = active?.cost != null ? `预计消耗倍数 ×${active.cost}` : "预计消耗倍数 ×1";
      costRow.title = "估算值：该挡位相对「无思考注入」请求的 token 消耗倍率（真实计费依服务商账单）";
    };
    const defaultIdx = Math.max(0, levels.findIndex((level) => level.id === node.thinkingLevel));
    slider.value = String(defaultIdx < 0 ? 0 : defaultIdx);
    renderSliderTheme(slider, levels);
    renderTrackMarks(ticksRow, labelsRow, levels, Number(slider.value));
    applyIndex(Number(slider.value));
    slider.addEventListener("input", () => { renderSliderTheme(slider, levels); syncMarkActive(ticksRow, labelsRow, Number(slider.value)); applyIndex(Number(slider.value)); });
    slider.addEventListener("change", async () => {
      const level = levels[Number(slider.value)] || levels[0];
      try { await window.agentChatPro.updateAgentPoolNode(node.id, { thinkingLevel: level.id || "" }); } catch { /* 存档失败静默（挡位重读=池存档） */ }
    });
    wrap.append(slider, ticksRow);
    section.append(wrap, labelsRow, costRow);
    return section;
  };
  const renderGroupThinkPanel = async (stamp) => {
    const trackWrap = document.querySelector(".think-track-wrap");
    const resetBtn = document.querySelector("#think-reset");
    const groupRows = document.querySelector("#think-group-rows");
    levelsRow.replaceChildren();
    meta.innerHTML = "";
    if (trackWrap) trackWrap.hidden = true;
    levelsRow.hidden = true;
    meta.hidden = true;
    if (resetBtn) resetBtn.hidden = true;
    if (!groupRows) { modelEl.textContent = "群聊"; return; }
    // v3.37.0 群面板默认收起（用户实锤「自主讨论那一节占了整个对话框的二分之一」）：只留一行摘要，点击才展开逐成员挡位
    groupRows.hidden = true;
    groupRows.replaceChildren();
    modelEl.textContent = `群聊 · ${groupRosterAgents.length} 位成员 ▸ 点开逐成员挡位`;
    modelEl.style.cursor = "pointer";
    modelEl.title = "点开/收起逐成员思考挡位（每成员独立记忆）";
    if (stamp !== thinkModelStamp) return; // 面板已重建 → 作废（非群切换竞态）
    const fillRows = async () => {
      const stampLocal = ++thinkModelStamp;
      groupRows.replaceChildren();
      for (const node of groupRosterAgents) {
        const section = await buildGroupMemberThinkRow(node);
        if (stampLocal !== thinkModelStamp) return;
        groupRows.append(section);
      }
    };
    if (!modelEl.dataset.groupToggle) {
      modelEl.dataset.groupToggle = "1";
      modelEl.addEventListener("click", () => {
        groupRows.hidden = !groupRows.hidden;
        modelEl.textContent = groupRows.hidden ? `群聊 · ${groupRosterAgents.length} 位成员 ▸ 点开逐成员挡位` : "群聊 · 逐成员挡位（点此收起）";
        if (!groupRows.hidden) fillRows();
      });
    }
  };

  const buildSlider = async () => {
    const stamp = ++thinkModelStamp; // v3.24.3：面板重建计数（作废旧型号异步回包）
    // v3.35.7 群聊分支：成员堆叠面板（群工作区绑定了工作组的对话）——不叠建群设置滑条，挡位进群聊面板独立调
    if (groupActiveConversationId && groupRosterAgents.length) {
      await renderGroupThinkPanel(stamp);
      return;
    }
    // 非群（单聊）：静态骨架复位（群模式残留在面板里的 hidden 状态还原）
    const groupRows = document.querySelector("#think-group-rows");
    if (groupRows) { groupRows.hidden = true; groupRows.replaceChildren(); }
    const trackWrapEl = document.querySelector(".think-track-wrap");
    if (trackWrapEl) trackWrapEl.hidden = false;
    levelsRow.hidden = false;
    meta.hidden = false;
    levelsRow.replaceChildren();
    meta.innerHTML = "";
    const resetBtnEl = document.querySelector("#think-reset");
    if (resetBtnEl) resetBtnEl.hidden = true;
    if (currentConnectionMode === "cloud") {
      const snapshot = await window.agentChatPro.loadSettings();
      const provider = snapshot.cloudAiProvider || "zhipu";
      const model = snapshot.cloudAiModel || "";
      const choice = String(((snapshot.thinkingChoices || {}).cloud || {})[`${provider}/${model}`] || "");
      let profile = null;
      try { profile = (await window.agentChatPro.getThinkingProfile({ provider, model })).profile; } catch {}
      modelEl.textContent = `cloud•${model || "未设置模型"}`; // 顶行先占位（模型域），挡位解出后重拼含英文标全串（composeThinkTop）
      if (!profile || !Array.isArray(profile.levels) || !profile.levels.length) {
        slider.disabled = true;
        slider.value = 0;
        ticksRow.replaceChildren();
        levelsRow.innerHTML = `<span class="think-unsupported">该模型不支持思考调节</span>`;
        if (meta) meta.textContent = "思考挡位按模型原生支持显示；未列出时不注入任何思考参数。";
        return;
      }
      // v3.24.2：ECO 挡显示层前置（各家挡位表不动——注入器 hasChoice 对 eco 零注入，天然安全）；
      // 未选挡位（服务商默认）时滑块对位 off/默认挡，不再落在 eco
      const levels = [{ id: "eco", label: "ECO", hint: "零思考注入，最省 token（服务商默认挡位）" }, ...profile.levels];
      slider.disabled = false;
      slider.min = 0;
      slider.max = String(levels.length - 1);
      slider.step = 1;
      const defaultIdx = Math.max(0, levels.findIndex((l) => l.id === "off"));
      slider.value = String(choice ? Math.max(0, levels.findIndex((l) => l.id === choice)) : defaultIdx);
      renderSliderTheme(slider, levels);
      renderTrackMarks(ticksRow, levelsRow, levels, Number(slider.value));
      const active = levels[Number(slider.value)] || levels[0];
      modelEl.textContent = composeThinkTop("cloud", model, currentModeId, active.id);
      renderMeta(active, Boolean(choice));
      slider.oninput = () => { renderSliderTheme(slider, levels); syncMarkActive(ticksRow, levelsRow, Number(slider.value)); modelEl.textContent = composeThinkTop("cloud", model, currentModeId, levels[Number(slider.value)].id); };
      slider.onchange = () => { applyChoice(levels[Number(slider.value)].id); maybeShowThinkEgg(levels, Number(slider.value)); };
    } else {
      // SSH / 本机 claude 引擎：挡位=会话偏好（settings.thinkingChoices.ssh[工作模式]），
      // 未调整时用模式默认挡位（内置三模式 none/medium/none 继续生效）
      const snapshot = await window.agentChatPro.loadSettings();
      const modesRaw = window._cachedModes && window._cachedModes.length ? window._cachedModes : await window.agentChatPro.listModes();
      const modes = Array.isArray(modesRaw) ? modesRaw : [];
      const mode = modes.find((m) => m.id === currentModeId);
      const engineClaude = currentConnectionMode === "ssh" || (currentConnectionMode === "local" && currentLocalEngine === "claude");
      const modeLevel = (mode && ["eco", "high", "low", "none"].includes(mode.thinkingLevel)) ? mode.thinkingLevel : "medium";
      const modeKey = currentModeId || "regular";
      const sshChoice = String((((snapshot.thinkingChoices || {}).ssh || {})[modeKey]) || "").trim();
      const levelValue = ["eco", "high", "medium", "low", "none"].includes(sshChoice) ? sshChoice : modeLevel;
      const levelId = THINK_CLAUDE_LEVEL_REVERSE[levelValue] || "medium";
      // v3.25.1 顶行重写（用户令）：（连接模式）•（模型 工作模式英标 思考挡英标）——ssh•GLM 5.3 flash auto 形态；
      // v3.24.3 模型渐显机制保留（模式显式配置优先 thinkModeModelText 去[后缀]，否则后台拉生效模型重拼）
      const stampTop = (m, lvl) => composeThinkTop(currentConnectionMode, m, modeKey, lvl ?? levelId);
      const modeModel = thinkModeModelText(mode);
      modelEl.textContent = stampTop(modeModel);
      if (!modeModel) {
        fetchThinkRemoteModel().then((remoteModel) => {
          if (stamp !== thinkModelStamp || !remoteModel) return; // 面板已重建/拿不到 → 不追加
          modelEl.textContent = stampTop(remoteModel);
        });
      }
      const levels = THINK_SSH_LEVELS;
      if (!engineClaude) {
        slider.disabled = true;
        slider.value = 0;
        ticksRow.replaceChildren();
        levelsRow.innerHTML = `<span class="think-unsupported">当前引擎不支持思考调节</span>`;
        return;
      }
      slider.disabled = false;
      slider.min = 0;
      slider.max = String(levels.length - 1);
      slider.step = 1;
      slider.value = String(Math.max(0, levels.findIndex((l) => l.id === levelId)));
      renderSliderTheme(slider, levels);
      renderTrackMarks(ticksRow, levelsRow, levels, Number(slider.value));
      const active = levels[Number(slider.value)] || levels[0];
      renderMeta(active, Boolean(sshChoice));
      slider.oninput = () => { renderSliderTheme(slider, levels); syncMarkActive(ticksRow, levelsRow, Number(slider.value)); modelEl.textContent = stampTop(modeModel || (thinkModelCache && thinkModelCache.model) || "", levels[Number(slider.value)].id); };
      slider.onchange = () => { applyChoice(levels[Number(slider.value)].id); maybeShowThinkEgg(levels, Number(slider.value)); };
    }
  };

  // 工作模式快捷切换（三内置 chips——模式选择完整入口仍在侧边栏）
  modesRow.replaceChildren();
  slider.onchange = null;
  const modesRaw = window._cachedModes && window._cachedModes.length ? window._cachedModes : await window.agentChatPro.listModes();
  const modes = Array.isArray(modesRaw) ? modesRaw : []; // 防御：列表接口异常返回时不炸（回归套 mock 教训）
  for (const mode of modes.filter((m) => m.isBuiltIn)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `think-mode-chip${mode.id === currentModeId ? " active" : ""}`;
    chip.innerHTML = `<span class="think-mode-chip-icon">${mode.icon}</span>${mode.name}`;
    chip.title = mode.description || "";
    chip.addEventListener("click", async () => {
      currentModeId = mode.id;
      updateModeDisplay(mode);
      await refreshModeSelector();
      try {
        const settings = await window.agentChatPro.saveSettings({ ...(await window.agentChatPro.loadSettings()), workModeId: mode.id });
        populateSettings(settings);
      } catch (error) { setConnection("模式切换失败：" + error.message, "error"); }
      await refreshComposerModePopup();
    });
    modesRow.append(chip);
  }

  await buildSlider();
}

// v3.24.1：常显思考徽标已移除（用户拍板「难看」）——挡位只进面板看；
// composerModeTrigger 图标渲染权回归 updateModeDisplay（v3.24.0「populateSettings 双写互踩」修复语义不变）

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
  // v3.40.0：@ 成员浮层打开时接管四键——↑↓ 导航 / Enter、Tab 选中（不误触发送）/ Esc 关闭
  if (atPopoverState.open && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
    event.preventDefault();
    if (event.key === "ArrowDown") atPopoverState.index = (atPopoverState.index + 1) % atPopoverState.items.length;
    else if (event.key === "ArrowUp") atPopoverState.index = (atPopoverState.index - 1 + atPopoverState.items.length) % atPopoverState.items.length;
    else if (event.key === "Enter" || event.key === "Tab") { acceptAt(atPopoverState.items[atPopoverState.index] || null); return; }
    else closeAtPopover();
    paintAtActive();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    // v3.15.6：Enter 与点击发送按钮语义一致——本对话任务进行中不动作（停止走按钮/Esc），
    // 任务属于其他对话时进入 sendMessage 拿到明确提示（不再静默无反应）
    if (!activeId || streamingConversationId !== conversationId) {
      event.preventDefault();
      sendMessage();
    } else event.preventDefault();
  }
});
window.addEventListener("focus", () => requestAnimationFrame(() => focusPrompt()));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestAnimationFrame(() => focusPrompt());
});
window.agentChatPro.onDelta(({ id, text }) => {
  const answer = messages.get(id);
  if (!answer) return;
  // v3.35.6：群轮走专用通道（chat:group-delta → onGroupDelta；单聊 delta 见下方群轮过滤）
  if (groupTurnsLive.has(id)) return;
  answer.querySelector(".message-content").textContent += text;
  // v3.15.1：仅当进行中任务属于当前显示的对话才刷新 token 计数与滚动（后台任务不挪用当前对话的计量）
  if (streamingConversationId === conversationId) {
    // v3.15.0 智能滚动：仅当用户停在底部附近才跟随，上滚看历史不再被拉回
    if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
    // 实时估算流式 token
    streamingTokens += estimateTokens(text);
    updateTokenDisplay();
  }
});
window.agentChatPro.onChatEvent((event) => {
  // v3.42.0 修复①：群轮「启动即返」两事件（主进程编排层直发，均不挂任何气泡 id 判断链）——
  // group-turn-start：事件先到即建「正在思考」气泡+注册悬等（sendGroupMessage resolve 的快照建轮幂等）；幽灵轮出灰态缺席气泡
  // group-turn-settled：主进程全组终局收口信号（全部轮 promise 已 settle 后发）——finalize 兜底收口
  if (event.type === "group-turn-start") {
    ensureGroupTurnBubble({ ...(event.turn || {}), conversationId: event.conversationId || groupActiveConversationId });
    return;
  }
  if (event.type === "group-turn-settled") {
    const settleId = event.conversationId || String(event.id || "").replace(/^group-/, "");
    setTimeout(() => { checkGroupSendSettle(settleId); checkGroupSendSettle(groupActiveConversationId); }, 120);
    return;
  }
  const answer = messages.get(event.id);
  // v3.35.6 群轮分支：群轮的 connection/lifecycle/usage 不再单聊状态条投影（多成员互踩红线①；
  // thinking/round/ask-user 走下方通用分支按 messages.get(id) 挂群轮气泡）
  const GROUP_OPAQUE_EVENTS = ["upload", "connection", "lifecycle", "usage"];
  if (groupTurnsLive.has(String(event?.id || ""))) {
    if (GROUP_OPAQUE_EVENTS.includes(event.type)) return;
    if (event.type === "group-agent-failed") {
      const live = groupTurnsLive.get(event.id);
      if (live) {
        live.item.classList.add("group-failed");
        const note = document.createElement("div");
        note.className = "draft-note";
        note.textContent = `@${live.name} 本轮失败：${event.error?.message || ""}`.slice(0, 200);
        live.item.prepend(note);
      }
      return;
    }
  }
  if (event.type === "upload") {
    setConnection(`正在上传 ${event.name} · ${Math.round(event.overall * 100)}%`, "");
  } else if (event.type === "connection") {
    // v3.15.0：进行中任务的文案标签用发起时的模式（切到别的对话/模式后不再错标）
    const modeLabel = activeId ? streamingConnectionMode : currentConnectionMode;
    const labels = modeLabel === "local"
      ? (currentLocalEngine === "atomcode"
        ? { "local-starting": "正在启动 AtomCode daemon…", connected: "AtomCode 正在处理…" }
        : currentLocalEngine === "custom"
        ? { "local-starting": "正在启动本机命令…", connected: "本机命令正在处理…" }
        : { "local-starting": "正在启动本机 Claude…", connected: "本机 Claude 正在处理…" })
      : modeLabel === "cloud"
      ? { connecting: "正在连接云端 AI…", connected: "云端 AI 正在处理…", stopping: "正在停止…" }
      : { connecting: "正在连接 NAS…", reconnecting: "连接中断，正在自动重连…", connected: "已连接，Claude 正在处理…", stopping: "Claude 已收到停止请求，正在结束当前操作…", stopped: "连接已被强制关闭，正在结束当前请求…" };
    setConnection(labels[event.status] || "正在处理…", event.status === "connected" ? "connected" : "");
  } else if (event.type === "tool" && answer) {
    // v3.24.6 开发面板：工具事件入账本（三模式共用通道），入账了才刷新面板 DOM
    if (devPanelAccount(event.tool)) renderDevPanel();
    renderTool(answer, event.tool);
    // v3.15.0 智能滚动：仅当用户停在底部附近才跟随
    if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
  } else if (event.type === "round" && answer) {
    // v3.21.3 修复②：跨轮标记——主进程不再注入正文分隔线，这里画轻量轮次徽标
    // v3.24.9：续写提示徽标（主进程截断续写时带 mark 自定义文案）
    appendRoundMark(answer, event.round, event.mark);
  } else if (event.type === "thinking" && answer) {
    // v3.24.0 功能C：思考过程流式折叠块（云端 reasoning 流 + SSH/local claude 扩展思考透传共用通道）
    appendThinkingDelta(answer, event.text || "");
    // v3.37.0 群轮思考可视化：思考流到达 → 群气泡 note 保持/切回「正在思考…」（正文到达后被 enqueueGroupDelta 覆写）
    const live = groupTurnsLive.get(event.id);
    if (live && live.item.classList.contains("group-streaming")) {
      const note = live.item.querySelector(".draft-note");
      if (note && note.textContent !== `@${live.name} 正在思考…`) note.textContent = `@${live.name} 正在思考…`;
    }
  } else if (event.type === "ask-user" && answer) {
    // v3.24.0 功能B：AI 选择题提问悬等卡（云端 ask_user 工具；点选经 IPC 回传继续工具循环）
    renderCloudAskUserCard(answer, event);
    // v3.41.0：AI 提问悬等同样系统通知——用户切走时不能让轮在 480s 超时里白等一个选择
    reportTaskNotify({
      kind: "ask",
      id: streamingConversationId,
      title: (conversationCache.find((item) => item.id === streamingConversationId) || {}).title || conversationTitle,
      force: streamingConversationId !== conversationId,
      summary: event.question || event.text || ""
    });
  } else if (event.type === "usage") {
    // v3.15.1：后台任务的 usage 不挪用当前对话的 token 计量（切回该对话时按消息重算兜底）
    if (streamingConversationId !== conversationId) return;
    // 处理 usage 事件：用实际 token 数据替换估算值
    if (event.usage) {
      const usage = event.usage;
      // v3.21.3 修复①：轮末累计事件（主进程工具循环跨轮累计器）——服务商真实账目直接替换估算。
      // 财务口径 = Σ每轮(输入+输出)：每一轮请求都把全部上下文重算一次输入费用，input 必须计入。
      if (usage.cumulative === true) {
        const realTotal = Number(usage.totalTokens ?? usage.total_tokens ?? 0) || 0;
        if (realTotal) {
          streamingTokens = 0;
          confirmedTokens = realTotal;
          updateTokenDisplay();
        }
        return;
      }
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

// ── v3.35.6 群聊事件通道 ──
window.agentChatPro.onGroupDelta(({ id, text }) => {
  // 红线①：入缓冲合帧（enqueueGroupDelta 内部 ≤24ms 一次 DOM 写）
  enqueueGroupDelta(id, text);
});
window.agentChatPro.onSubagentEvent?.((payload) => {
  // 模块四：树状折叠行（└─ 子 Agent …）；单聊路（无父轮气泡在群登记时）忽略
  renderSubagentTreeLine(payload);
});
// 桥被强制关闭（SSH 断开 / runner 进程被杀）：状态条降级为错误态并清除等待 UI
window.agentChatPro.onBridgeForceClosed?.((detail) => {
  setConnection(`连接已被强制关闭${detail?.reason === "runner-stopped" ? "（Agent 已停止）" : ""}。`, "error");
  if (activeId) forceClearActiveState("连接已被强制关闭");
});

// ── 上下文进度条事件（v3.10.0）：model / usage / compact 三类 ──
window.agentChatPro.onContextEvent?.((event) => {
  if (!event) return;
  // v3.15.1：后台任务的上下文事件不挪用当前对话的进度条（切回该对话时按记录回填兜底）
  if (activeId && streamingConversationId !== conversationId) return;
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
    // v3.15.6：Esc 只停止当前正在查看对话的任务——任务属于其他对话时不误停
    if (activeId && streamingConversationId === conversationId) {
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

// ── v3.41.0 任务完成系统通知：点击通知回跳——切回对应会话＋输入框聚焦，直接打字续聊 ──
if (window.agentChatPro.onTaskNotificationActivated) {
  window.agentChatPro.onTaskNotificationActivated(async (data) => {
    const targetId = String((data && data.conversationId) || "");
    if (targetId && targetId !== conversationId) {
      try { await loadConversation(targetId); } catch { /* 回跳失败不炸（会话可能已被删除） */ }
    }
    requestAnimationFrame(() => focusPrompt());
  });
}

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
  // v3.24.0 修复保留：populateSettings 里 setToolModeAppearance(全局 skipPermissions) 不再覆盖图标，
  // 图标渲染权仍独占于此处（双写互踩不复发）；v3.24.1 徽标移除后图标/标题回归本函数渲染
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
      bindExternalLinks(preview); // v3.15.7 链接拦截收编到通用函数
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
      updateModeDisplay(result); // v3.24.0：图标随 mode.icon（自定义模式自定义图标不再被布尔覆盖吃掉）
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

// ── v3.23.0：N2N 体检 + 一键部署（检测哪坏、缺哪补哪、日志上屏） ──

const N2N_DOCTOR_LEVEL_MARKS = { ok: "✓", warn: "△", fail: "✗", skip: "—" };

function n2nDoctorItemNode(item) {
  const row = document.createElement("div");
  row.className = `n2n-check n2n-check-${item.level}`;
  const mark = document.createElement("span");
  mark.className = "n2n-check-mark";
  mark.textContent = N2N_DOCTOR_LEVEL_MARKS[item.level] || "·";
  const body = document.createElement("div");
  body.className = "n2n-check-body";
  const title = document.createElement("strong");
  title.textContent = item.title;
  const detail = document.createElement("small");
  detail.textContent = item.detail;
  body.appendChild(title);
  body.appendChild(detail);
  if (item.hint) {
    const hint = document.createElement("small");
    hint.className = "n2n-hint";
    hint.textContent = item.hint;
    body.appendChild(hint);
  }
  row.appendChild(mark);
  row.appendChild(body);
  return row;
}

function appendN2nDeployLine(line) {
  const box = document.querySelector("#n2n-deploy-log");
  if (!box) return;
  box.hidden = false;
  box.textContent += line + "\n";
  box.scrollTop = box.scrollHeight;
}

// N2N 表单当前值 → 体检/部署 payload（地址为空时不带，远端回落默认入口）
function collectN2nFormPayload() {
  const addrInput = document.querySelector("#n2n-supernode-addr");
  const portInput = document.querySelector("#n2n-supernode-port");
  return {
    n2n: {
      supernodeAddr: addrInput ? addrInput.value.trim() : "",
      supernodePort: Number(portInput && portInput.value) || 7777
    }
  };
}

let n2nDoctorRunning = false;
let n2nDeployRunning = false;

document.querySelector("#n2n-doctor-run")?.addEventListener("click", async () => {
  if (n2nDoctorRunning || n2nDeployRunning) return;
  const button = document.querySelector("#n2n-doctor-run");
  const box = document.querySelector("#n2n-doctor-result");
  n2nDoctorRunning = true;
  button.disabled = true;
  button.textContent = "⏳ 体检中…";
  box.hidden = false;
  box.textContent = "";
  const status = document.createElement("div");
  status.className = "n2n-doctor-status";
  status.textContent = "正在体检（最多约 15 秒）…";
  box.appendChild(status);
  try {
    const result = await window.agentChatPro.runN2nDoctor(collectN2nFormPayload());
    status.remove();
    const verdict = document.createElement("div");
    verdict.className = result.ok ? "n2n-verdict n2n-verdict-ok" : "n2n-verdict n2n-verdict-fail";
    verdict.textContent = result.ok ? `✅ ${result.nextAction}` : `⚠️ ${result.nextAction}`;
    box.appendChild(verdict);
  } catch (error) {
    status.textContent = `体检失败：${error.message}`;
  } finally {
    n2nDoctorRunning = false;
    button.disabled = false;
    button.textContent = "🔍 N2N 体检";
  }
});

document.querySelector("#n2n-deploy-run")?.addEventListener("click", async () => {
  if (n2nDoctorRunning || n2nDeployRunning) return;
  const button = document.querySelector("#n2n-deploy-run");
  n2nDeployRunning = true;
  button.disabled = true;
  button.textContent = "⏳ 部署中…";
  const logBox = document.querySelector("#n2n-deploy-log");
  logBox.hidden = false;
  logBox.textContent = "";
  try {
    const payload = collectN2nFormPayload();
    const result = await window.agentChatPro.runN2nDeploy(payload);
    if (result.canceled) {
      appendN2nDeployLine("── 已取消部署 ──");
    } else if (result.ok) {
      appendN2nDeployLine("✅ 部署完成——无需重启，可直接连接。");
    } else {
      appendN2nDeployLine("⚠️ 部署未完全成功——按上方日志处理后再试。");
    }
    if (Array.isArray(result.summary)) result.summary.forEach((line) => appendN2nDeployLine("· " + line));
  } catch (error) {
    appendN2nDeployLine(`✗ 部署失败：${error.message}`);
  } finally {
    n2nDeployRunning = false;
    button.disabled = false;
    button.textContent = "⚡ 一键部署";
  }
});

// 体检逐项实时上屏（顶层注册一次，点击触发期间推送逐项插入）
window.agentChatPro?.onN2nDoctorItem?.((item) => {
  const box = document.querySelector("#n2n-doctor-result");
  if (!box) return;
  box.hidden = false;
  const status = box.querySelector(".n2n-doctor-status");
  if (status) status.remove();
  box.appendChild(n2nDoctorItemNode(item));
});

// 部署逐行实时上屏
window.agentChatPro?.onN2nDeployLine?.((line) => {
  appendN2nDeployLine(String(line ?? ""));
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

  // 更新侧边栏品牌名（v3.35.6 起此元素为工作区切换器主标题：多人工作区品牌名不写穿，由 setWorkspaceDisplay 定名）
  const brandName = document.querySelector("#sidebar-brand-name");
  if (brandName && currentWorkspace !== "team") brandName.textContent = config.appName;

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
  // 阉割版 Bridge Edition：门控应用（隐藏本机模式/设备联动等，放行桥设置卡）——必须在 loadConversation 之前
  await applyEdition();
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
  // v3.35.6 工作区：先恢复上次工作区（含切换器渲染），历史列表按工作区过滤后再恢复最近对话
  initWorkspaceSelector();
  initGroupSetupUI();
  bindEmptyStateGroupEntry();
  const conversations = await window.agentChatPro.listConversations(currentWorkspace);
  if (conversations.length) await loadConversation(conversations[0].id);
  else await createNewConversation();
  // 启动必填检查（v3.13.0：非 Claude 本机引擎不依赖唤醒命令，自定义命令引擎要求命令模板）
  const claudeEngine = settings.connectionMode !== "local" || String(settings.localEngine || "claude") === "claude";
  if ((claudeEngine && !settings.wakeName)
    || (settings.connectionMode !== "local" && (!settings.host || !settings.username || !settings.hasPassword))
    || (settings.connectionMode === "local" && settings.localEngine === "custom" && !settings.customCliCommand)) {
    openSettings();
  }
  // v3.40.0：首次启动=新手向导（三段分流）；必填检查若已打开设置中心则不叠弹（下次启动再引导）
  setTimeout(() => {
    if (!document.querySelector("#settings-dialog")?.open) openOnboarding();
  }, 1400);
})();

// ── v3.40.0：新手向导（三段分流）──────────────────────────────────────
// 三段：①新/老用户（老用户直达全功能）②专业/普通（专业人士直达全功能）③普通用户三步引导（选 AI 类型→是否现在配置）
const ONBOARDING_KEY = "acp-onboarding-v1";

function openOnboarding(force = false) {
  const dialog = document.querySelector("#onboarding-dialog");
  if (!dialog) return;
  if (!force && localStorage.getItem(ONBOARDING_KEY)) return; // 已完成过=静默（force 从设置→关于进入）
  showOnboardingStep("welcome");
  if (!dialog.open) dialog.showModal();
}

function showOnboardingStep(step) {
  ["welcome", "experience", "guide", "config"].forEach((name) => {
    const section = document.querySelector(`#onboarding-step-${name}`);
    if (section) section.hidden = name !== step;
  });
}

function finishOnboarding() {
  try { localStorage.setItem(ONBOARDING_KEY, "done"); } catch { /* 存储不可用时忽略（下次启动会再引导） */ }
  document.querySelector("#onboarding-dialog")?.close();
}

document.querySelectorAll("[data-onboarding-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    const choice = button.dataset.onboardingChoice;
    if (choice === "new") showOnboardingStep("experience");      // 新用户 → 进入第二段（专业/普通分流）
    else if (choice === "old") finishOnboarding();               // 老用户 → 直接跳过全部引导
    else if (choice === "pro") finishOnboarding();               // 专业人士 → 直接跳过全部引导
    else if (choice === "normal") showOnboardingStep("guide");   // 普通用户 → 进入三步引导
    else finishOnboarding();                                     // 「稍后再说」等 → 完成本次引导
  });
});

const ONBOARDING_MODE_DETAILS = {
  cloud: "☁️ 云端 AI：只需一个服务商 API 密钥（部分服务商有免费模型/额度）。连接页选服务商、保存密钥即可开聊。",
  local: "💻 本机 AI：需要本机装有 Claude Code / AtomCode 等 CLI；连接页选「本机」模式并选择引擎。",
  ssh: "🖥 SSH 远程：需要一台开了 SSH 的机器（NAS / 服务器）上面装着 Claude Code；连接页填地址、账号、密码（或密钥）。"
};

document.querySelectorAll("[data-onboarding-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.onboardingMode;
    const detail = document.querySelector("#onboarding-mode-detail");
    if (detail) detail.textContent = ONBOARDING_MODE_DETAILS[mode] || "";
    showOnboardingStep("config");
  });
});

document.querySelector("#onboarding-open-settings")?.addEventListener("click", () => {
  finishOnboarding();
  openSettings();
  switchSettingsTab("connection");
});
document.querySelector("#onboarding-skip")?.addEventListener("click", () => finishOnboarding());
document.querySelector("#about-reopen-onboarding")?.addEventListener("click", () => openOnboarding(true));

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
      onPromptInputChanged();
      elements.prompt.focus();
      closeContextMenu();
    });
    content.append(editItem);

    const quoteItem = createContextMenuItem("❝", "引用到输入框", () => {
      const text = item.querySelector(".message-content").textContent;
      elements.prompt.value = `> ${text.split("\n").join("\n> ")}\n\n` + elements.prompt.value;
      adjustTextarea();
      onPromptInputChanged();
      elements.prompt.focus();
      closeContextMenu();
    });
    content.append(quoteItem);

    content.append(createContextMenuSeparator());

    const deleteItem = createContextMenuItem("🗑", "删除此条及下方所有消息", async () => {
      closeContextMenu();
      // v3.15.5 修复2：先同步落库（truncate IPC）成功后再删 DOM——切走切回不再复活
      const anchorId = item.dataset.msgId || "";
      const anchorAt = item.dataset.msgAt || "";
      const anchorRole = item.dataset.msgRole || "user";
      if (!anchorId && !anchorAt) {
        alert("本条消息还没有同步记录，请重新进入该对话后再删除。");
        return;
      }
      try {
        await window.agentChatPro.truncateConversationMessages(conversationId, { mid: anchorId, at: anchorAt, role: anchorRole });
      } catch (error) {
        alert("删除失败：" + (error.message || error));
        return;
      }
      const allMessages = Array.from(elements.messages.querySelectorAll(".message"));
      const startIndex = allMessages.indexOf(item);
      if (startIndex === -1) return;
      // 删除当前及后续所有消息
      for (let i = allMessages.length - 1; i >= startIndex; i--) {
        allMessages[i].remove();
      }
      // 如果没有消息了，显示空状态
      if (!elements.messages.querySelector(".message")) {
        elements.empty.hidden = false;
      }
      // 按落库消息重算累计 token（删除的消息不再计入；v3.21.3 修复①：云端消息优先真实账目）
      conversationTokens = 0;
      try {
        const stored = await window.agentChatPro.getConversation(conversationId);
        for (const msg of stored?.messages || []) {
          conversationTokens += tokensForMessage(msg);
        }
      } catch {}
      updateTokenDisplay();
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

// ── v3.18.0 F2：「模型」页（设置中心第六导航）——AO 0.9.6 五项表 1:1 移植 + 云端/本机状态卡 ──
// 分派语义：ssh → NAS 五项表（读写远端 settings.json）；local+claude → 本机五项表（同一套渲染）；
// local+atomcode/custom → 引擎状态卡；cloud → 服务商/模型状态卡 + 快捷入口（不重复建编辑器，防双份配置打架）。
let modelStatusCache = null;
let modelTargetMode = ""; // 当前模型页面向的目标："ssh" | "local" | "cloud" | "local-engine"

function formatAutoCompactTokens(tokens) {
  return tokens >= 1_000_000 ? "1M tokens" : `${Math.round(tokens / 1000)}K tokens`;
}

function modelModeOf() {
  if (currentConnectionMode === "cloud") return "cloud";
  if (currentConnectionMode === "local") return currentLocalEngine === "claude" ? "local" : "local-engine";
  return "ssh";
}

function setModelBadge(text, positive = false) {
  const badge = document.querySelector("#model-badge");
  badge.textContent = text;
  badge.classList.toggle("installed", positive);
}

function renderModelStatusCard(status, target) {
  const title = document.querySelector("#model-title");
  const detail = document.querySelector("#model-detail");
  const info = document.querySelector("#model-info");
  const gotoCloud = document.querySelector("#goto-cloud-settings");
  const editor = document.querySelector("#model-editor");
  const note = document.querySelector("#model-mode-note");
  const refresh = document.querySelector("#refresh-model");
  gotoCloud.hidden = target !== "cloud";
  note.hidden = target !== "local-engine";
  editor.hidden = !(target === "ssh" || target === "local");
  refresh.hidden = target === "cloud";
  if (target === "cloud") {
    const provider = CLOUD_PROVIDERS[status?.provider];
    title.textContent = "云端 AI";
    detail.textContent = `服务商：${provider?.name || status?.provider || "智谱 AI"} · 模型：${status?.model || "-"}`;
    setModelBadge("已选择", true);
    info.textContent = "云端模式的服务商与模型在连接页配置，模型页仅显示当前选择；写 Claude 模型配置不适用于云端模式。";
  } else if (target === "local-engine") {
    title.textContent = currentLocalEngine === "atomcode" ? "AtomCode 引擎" : "自定义命令引擎";
    detail.textContent = "该引擎无 Claude 模型配置（不走 ~/.claude/settings.json 五项映射）。";
    setModelBadge("不适用");
    info.textContent = "如需管理模型配置，请在本机模式切回 Claude CLI 引擎，或使用 SSH 远程模式。";
  }
}

function renderModelEntryRow(entry) {
  const row = document.createElement("div");
  row.className = "model-entry-row";
  const copy = document.createElement("div");
  copy.className = "model-entry-copy";
  copy.innerHTML = ""; // 只用 DOM API 组装——模型名来自远端 settings.json，按不可信输入处理（防 HTML 注入）
  const strong = document.createElement("strong");
  strong.textContent = `${entry.label}（${entry.key}）`;
  const small = document.createElement("small");
  small.textContent = entry.description;
  copy.append(strong, small);
  const editor = document.createElement("div");
  editor.className = "model-entry-editor";
  const input = document.createElement("input");
  input.type = "text";
  input.autocapitalize = "off";
  input.autocorrect = "off";
  input.spellcheck = false;
  input.placeholder = entry.model || "未配置";
  input.value = entry.model || "";
  input.dataset.modelEntryInput = entry.id;
  if (entry.configured && !entry.valid) input.placeholder = `当前值无效：${entry.model}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.dataset.modelEntryUpdate = entry.id;
  button.textContent = "单独保存";
  editor.append(input, button);
  row.append(copy, editor);
  return row;
}

function renderClaudeEditor(status) {
  const title = document.querySelector("#model-title");
  const detail = document.querySelector("#model-detail");
  const list = document.querySelector("#model-entry-list");
  const compactCurrent = document.querySelector("#auto-compact-current");
  const compactSelect = document.querySelector("#auto-compact-window");
  const unified = document.querySelector("#claude-model");
  if (!status) return;
  // 状态卡
  const configured = (status.entries || []).filter((entry) => entry.configured);
  const consistentText = status.consistent ? `五项统一为 ${status.model}` : configured.length ? `五项并存（${configured.length}/5 已配置）` : "五项均未配置";
  title.textContent = status.model || "未配置五项模型";
  detail.textContent = `${consistentText} · ${status.settingsPath || ""}`;
  setModelBadge(status.valid === false ? "含无效值" : "已读取", status.valid !== false);
  unified.value = status.consistent ? (status.model || "") : (unified.value || "");
  // 五项明细
  list.replaceChildren(...(status.entries || []).map(renderModelEntryRow));
  // 自动压缩阈值
  const window_ = status.autoCompactWindow;
  if (window_) {
    compactCurrent.textContent = window_.mode === "auto" ? "Claude 官方自动值" : window_.valid ? formatAutoCompactTokens(window_.tokens) : `当前值无效（${window_.raw || "?"}）`;
    compactSelect.value = window_.valid && window_.mode === "fixed" ? String(window_.tokens) : "auto";
  }
}

async function refreshModelsPage() {
  const target = modelModeOf();
  modelTargetMode = target;
  renderModelStatusCard(null, target);
  document.querySelector("#auto-compact-current").textContent = "正在读取…";
  if (target === "cloud" || target === "local-engine") {
    document.querySelector("#model-password-actions").hidden = true;
    try {
      // 云端/引擎卡数据源：设置里的服务商与模型（云端）/引擎名（本机）
      const settings = await window.agentChatPro.loadSettings();
      renderModelStatusCard(target === "cloud" ? { provider: settings.cloudAiProvider, model: settings.cloudAiModel } : null, target);
    } catch (error) { setModelBadge("读取失败"); }
    return;
  }
  const title = document.querySelector("#model-title");
  const detail = document.querySelector("#model-detail");
  title.textContent = "正在读取…";
  detail.textContent = target === "ssh" ? "正在读取 NAS 的 ~/.claude/settings.json" : "正在读取本机 ~/.claude/settings.json";
  try {
    const status = await window.agentChatPro.getModelStatus();
    if (target !== modelTargetMode) return; // 用户已切走，丢弃过期结果
    modelStatusCache = status;
    renderClaudeEditor(status);
    // v3.40.0：管理员密码管理入口——已初始化（ready）才显示更换/重置
    try {
      const settings = await window.agentChatPro.loadSettings();
      document.querySelector("#model-password-actions").hidden = settings.modelAdminPasswordState !== "ready";
    } catch { document.querySelector("#model-password-actions").hidden = true; }
  } catch (error) {
    setModelBadge("读取失败");
    title.textContent = "模型配置读取失败";
    detail.textContent = error.message;
    document.querySelector("#model-entry-list").replaceChildren();
    document.querySelector("#model-password-actions").hidden = true;
  }
}

// ── 模型管理员密码对话框（v3.40.0 三态：missing/invalid → 初始化；ready → 写操作确认；change → 更换） ──
let modelPasswordResolver = null;
// v3.40.0：管理员密码会话缓存——同一会话内校验通过一次后，写模型操作不再重复弹窗
// （仅内存不落盘；更换密码/重置后立即失效，主进程判「密码不正确」时也会失效回退）
let modelPasswordSession = "";
let modelPasswordSessionValid = false;

/** v3.40.0：主进程判密码类错误 → 会话缓存立即失效（下次写操作重新校验） */
function invalidateModelPasswordSession(error) {
  if (/管理员密码/.test(String((error && error.message) || error || ""))) modelPasswordSessionValid = false;
}

function openModelPasswordDialog(mode) {
  const dialog = document.querySelector("#model-password-dialog");
  const title = document.querySelector("#model-password-title");
  const hint = document.querySelector("#model-password-hint");
  const pwdWrap = document.querySelector("#model-admin-password-wrap");
  const newWrap = document.querySelector("#model-admin-new-wrap");
  const confirmWrap = document.querySelector("#model-admin-confirmation-wrap");
  const status_ = document.querySelector("#model-password-status");
  title.textContent = mode === "initialize" ? "初始化模型管理员密码" : mode === "change" ? "更换管理员密码" : "输入模型管理员密码";
  hint.textContent = mode === "initialize"
    ? "首次写模型配置前需要设置一个管理员密码（至少 6 位）。此后所有模型写操作都要校验它，避免误触。密码保存在本机加密存储；忘记可在模型页重置。"
    : mode === "change"
    ? "先输入当前管理员密码校验身份，再设置新密码（至少 6 位）。更换成功后本会话内的写操作不再重复询问。"
    : "写模型配置前需要校验管理员密码；同一会话内校验通过后不再重复询问。";
  newWrap.hidden = mode !== "change";
  confirmWrap.hidden = mode === "confirm";
  const pwdLabel = pwdWrap.firstChild;
  if (pwdLabel && pwdLabel.nodeType === 3) {
    pwdLabel.textContent = mode === "change" ? "当前管理员密码" : mode === "initialize" ? "设置管理员密码" : "管理员密码";
  }
  status_.textContent = "";
  document.querySelector("#model-admin-password").value = "";
  document.querySelector("#model-admin-new").value = "";
  document.querySelector("#model-admin-confirmation").value = "";
  dialog.showModal();
  document.querySelector("#model-admin-password").focus();
  return new Promise((resolve) => { modelPasswordResolver = resolve; });
}

function finishModelPassword(value) {
  const resolver = modelPasswordResolver;
  modelPasswordResolver = null;
  document.querySelector("#model-password-dialog").close();
  resolver?.(value);
}

document.querySelector("#model-password-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!modelPasswordResolver) return;
  const password = document.querySelector("#model-admin-password").value;
  const newWrap = document.querySelector("#model-admin-new-wrap");
  const changeMode = !newWrap.hidden; // 更换模式：当前密码 + 新密码 + 确认（三输入）
  const initializeMode = changeMode ? false : !document.querySelector("#model-admin-confirmation-wrap").hidden;
  if (changeMode) {
    const newPassword = document.querySelector("#model-admin-new").value;
    const confirmation = document.querySelector("#model-admin-confirmation").value;
    if (newPassword.length < 6) { document.querySelector("#model-password-status").textContent = "新密码需至少 6 位。"; return; }
    if (newPassword !== confirmation) { document.querySelector("#model-password-status").textContent = "两次输入的新密码不一致。"; return; }
    if (newPassword === password) { document.querySelector("#model-password-status").textContent = "新密码与当前密码相同，无需更换。"; return; }
    window.agentChatPro.changeModelAdminPassword({ currentPassword: password, password: newPassword, confirmation })
      .then(() => {
        modelPasswordSession = newPassword;
        modelPasswordSessionValid = true;
        finishModelPassword(newPassword);
      })
      .catch((error) => { document.querySelector("#model-password-status").textContent = error.message; });
    return;
  }
  if (initializeMode) {
    const confirmation = document.querySelector("#model-admin-confirmation").value;
    if (password.length < 6) { document.querySelector("#model-password-status").textContent = "密码需至少 6 位。"; return; }
    if (password !== confirmation) { document.querySelector("#model-password-status").textContent = "两次输入不一致。"; return; }
    window.agentChatPro.initializeModelAdminPassword({ password, confirmation })
      .then(() => {
        modelPasswordSession = password;
        modelPasswordSessionValid = true;
        finishModelPassword(password);
      })
      .catch((error) => { document.querySelector("#model-password-status").textContent = error.message; });
    return;
  }
  if (!password) { document.querySelector("#model-password-status").textContent = "请输入管理员密码。"; return; }
  // v3.40.0：confirm 模式先预校验——通过即入会话缓存（后续写操作免重输）；不通过在对话框内报错重输
  window.agentChatPro.verifyModelAdminPassword({ password })
    .then((result) => {
      if (result?.ok) {
        modelPasswordSession = password;
        modelPasswordSessionValid = true;
        finishModelPassword(password);
      } else {
        document.querySelector("#model-password-status").textContent = result?.reason || "管理员密码不正确，请重试。";
      }
    })
    .catch((error) => { document.querySelector("#model-password-status").textContent = error.message; });
});
document.querySelector("#model-password-cancel").addEventListener("click", () => finishModelPassword(null));

// v3.40.0：管理员密码管理入口——更换（change 三态对话框）/ 重置（双击确认 + 主进程二次确认，忘记密码兜底）
document.querySelector("#model-password-change").addEventListener("click", () => requestModelAdminPassword("change"));
document.querySelector("#model-password-reset").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.dataset.armed !== "1") {
    button.dataset.armed = "1";
    button.textContent = "危险操作，请再点一次确认";
    setTimeout(() => {
      if (button.isConnected && button.dataset.armed === "1") {
        button.dataset.armed = "";
        button.textContent = "重置管理员密码";
      }
    }, 5000);
    return;
  }
  button.dataset.armed = "";
  button.textContent = "重置管理员密码";
  try {
    const result = await window.agentChatPro.resetModelAdminPassword();
    if (result && !result.cancelled) {
      modelPasswordSession = "";
      modelPasswordSessionValid = false;
      modelStatusCache = null;
      setConnection("管理员密码已重置；下次写模型配置时会引导设置新密码（模型配置数据不受影响）。", "connected");
      refreshModelsPage();
    }
  } catch (error) { setStatus(error.message, true); }
});

async function requestModelAdminPassword(mode = "confirm") {
  const dialog = document.querySelector("#model-password-dialog");
  if (dialog.open) return null;
  // v3.40.0：会话内已校验通过 → 直接用存档密码（不落盘）；换密/重置/主进程判错即失效
  if (mode === "confirm" && modelPasswordSessionValid && modelPasswordSession) return modelPasswordSession;
  const settings = await window.agentChatPro.loadSettings();
  const state = settings.modelAdminPasswordState;
  if (state === "unavailable") { setConnection("Windows 系统加密不可用，无法写模型配置。", "error"); return null; }
  if (mode === "change" && state === "missing") { setConnection("尚未设置管理员密码；下次写模型配置时会引导设置。", "connected"); return null; }
  const effectiveMode = state === "missing" || state === "invalid" ? "initialize" : mode;
  return openModelPasswordDialog(effectiveMode);
}

// ── 模型页写操作三入口（统一改为 / 单项保存 / 自动压缩阈值）+ 读取 ──
document.querySelector("#refresh-model").addEventListener("click", () => refreshModelsPage());
document.querySelector("#goto-cloud-settings").addEventListener("click", () => switchSettingsTab("connection"));

document.querySelector("#save-model").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const model = document.querySelector("#claude-model").value.trim();
  if (!model) { setConnection("请先填写要统一使用的模型名称。", "error"); return; }
  const adminPassword = await requestModelAdminPassword();
  if (adminPassword === null) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "正在切换…";
  try {
    const result = await window.agentChatPro.updateModel({ model, adminPassword });
    if (result.cancelled) return;
    if (modelTargetMode === "ssh" || modelTargetMode === "local") { modelStatusCache = result; renderClaudeEditor(result); }
    setConnection(`五项已统一更改为 ${result.model}；下一条消息将使用新配置。`, "connected");
  } catch (error) { invalidateModelPasswordSession(error); setStatus(error.message, true); }
  finally { button.disabled = false; button.textContent = originalText; }
});

document.querySelector("#model-entry-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-model-entry-update]");
  if (!button) return;
  const entryId = button.dataset.modelEntryUpdate;
  const input = document.querySelector(`[data-model-entry-input="${entryId}"]`);
  const model = input?.value.trim() || "";
  const adminPassword = await requestModelAdminPassword();
  if (adminPassword === null) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "正在更改…";
  try {
    const result = await window.agentChatPro.updateModelEntry({ entryId, model, adminPassword });
    if (result.cancelled) return;
    modelStatusCache = result;
    renderClaudeEditor(result);
    setConnection(`${result.entry?.label || entryId}已更改为 ${result.entry?.model || model}；其余五项未改，下一条消息将使用新配置。`, "connected");
  } catch (error) { invalidateModelPasswordSession(error); setStatus(error.message, true); }
  finally { button.disabled = false; button.textContent = originalText; }
});

document.querySelector("#save-auto-compact").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const value = document.querySelector("#auto-compact-window").value;
  const adminPassword = await requestModelAdminPassword();
  if (adminPassword === null) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "正在更改…";
  try {
    const result = await window.agentChatPro.updateAutoCompactWindow({ value, adminPassword });
    if (result.cancelled) return;
    modelStatusCache = result;
    renderClaudeEditor(result);
    const label = result.autoCompactWindow?.mode === "auto" ? "Claude 官方自动值" : formatAutoCompactTokens(result.autoCompactWindow.tokens);
    setConnection(`自动压缩阈值已改为 ${label}；五项模型未改，下一条消息将使用新阈值。`, "connected");
  } catch (error) { invalidateModelPasswordSession(error); setStatus(error.message, true); }
  finally { button.disabled = false; button.textContent = originalText; }
});

// ── v3.35.6 建群对话框（模块一 群主视角）：Agent 池管理 + 工作组编排 ──────────────
const GROUP_PROVIDERS = [
  ["zhipu", "智谱 GLM"], ["deepseek", "DeepSeek"], ["kimi", "Kimi"], ["doubao", "豆包"],
  ["openai", "OpenAI"], ["anthropic", "Anthropic"], ["gemini", "Gemini"], ["groq", "Groq"],
  ["siliconflow", "硅基流动"], ["custom", "custom"]
];

/** team 工作区空态入口按钮（规格 UI 重构需求：默认首页给建群入口） */
async function ensureEmptyStateGroupEntry() {
  const empty = document.querySelector("#empty-state");
  if (!empty) return;
  // 清理旧入口：连行容器一起删（v3.35.8 起按钮包在 .empty-group-entry-row 里，单删按钮会残留空行容器越积越多）
  empty.querySelector(".empty-group-entry-row")?.remove();
  if (currentWorkspace !== "team") return;
  const button = document.createElement("button");
  button.type = "button";
  button.id = "empty-group-entry";
  button.className = "primary empty-group-entry";
  button.textContent = "👥 建群开始协作";
  button.addEventListener("click", () => openGroupSetup());
  // v3.35.8 实锤修复：按钮不直接当 grid item（窄容器下列收缩会把它压成一字一行窄条），
  // 独立行容器包裹（flex 居中 + width:100%）隔离 grid 收缩，按钮自身 white-space:nowrap 永不断行
  const row = document.createElement("div");
  row.className = "empty-group-entry-row";
  row.append(button);
  empty.append(row);
}

function bindEmptyStateGroupEntry() {
  ensureEmptyStateGroupEntry();
}

/** 打开建群对话框（渲染 Agent 池与工作组两个列表） */
async function openGroupSetup() {
  const dialog = document.querySelector("#group-setup-dialog");
  if (!dialog) return;
  await renderSetupPoolList();
  await renderSetupWgList();
  if (!dialog.dataset.started) {
    dialog.dataset.started = "1";
    dialog.querySelectorAll("[data-group-tab]").forEach((tab) => {
      tab.addEventListener("click", () => {
        const tabId = tab.dataset.groupTab;
        document.querySelectorAll("[data-group-tab]").forEach((item) => item.classList.toggle("active", item === tab));
        document.querySelector("#group-tab-pool").hidden = tabId !== "pool";
        document.querySelector("#group-tab-workgroups").hidden = tabId !== "workgroups";
      });
    });
    document.querySelector("#group-setup-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    // ── v3.35.9 云端节点「🔄 拉取」：与连接设置云端同款官方 GET /models 实拉（用户令：填 Key 后不该再手打模型名）
    const poolCloudProvider = document.querySelector("#pool-cloud-provider");
    const poolFetchButton = document.querySelector("#pool-cloud-fetch-models");
    const poolFetchResult = document.querySelector("#pool-cloud-fetch-result");
    // ── v3.37.0（用户令⑥）：datalist 要点输入框里的小三角才展开，太别扭——弃用，改自绘浮层：
    // 拉取成功自动弹列表直接点选；之后点模型框也有列表；点选项直接回填；点浮层外收起。
    let poolModelOptions = [];
    const poolModelInput = document.querySelector("#pool-cloud-model");
    const poolModelPopover = document.querySelector("#pool-cloud-model-popover");
    const hidePoolModelPopover = () => {
      if (poolModelPopover) poolModelPopover.hidden = true;
    };
    const openPoolModelPopover = () => {
      if (!poolModelPopover || !poolModelInput || !poolModelOptions.length) return;
      const rect = poolModelInput.getBoundingClientRect();
      poolModelPopover.style.left = `${Math.round(rect.left)}px`;
      poolModelPopover.style.top = `${Math.round(rect.bottom + 4)}px`;
      poolModelPopover.style.width = `${Math.max(240, Math.round(rect.width))}px`;
      poolModelPopover.replaceChildren();
      for (const model of poolModelOptions) {
        const option = document.createElement("div");
        option.className = "model-popover-item";
        option.textContent = model.label === model.value ? model.value : `${model.label}（${model.value}）`;
        option.title = option.textContent;
        option.addEventListener("click", () => {
          poolModelInput.value = model.value;
          poolModelInput.dispatchEvent(new Event("input", { bubbles: true }));
          hidePoolModelPopover();
          poolModelInput.focus();
        });
        poolModelPopover.append(option);
      }
      poolModelPopover.hidden = false;
    };
    if (poolModelInput && poolModelPopover) {
      poolModelInput.addEventListener("click", () => {
        if (poolModelPopover.hidden && poolModelOptions.length) openPoolModelPopover();
      });
      poolModelInput.addEventListener("focus", () => {
        if (poolModelPopover.hidden && poolModelOptions.length) openPoolModelPopover();
      });
      // 场外按下即收起（mousedown 先于 click，不会吃掉场外点击）
      document.addEventListener("mousedown", (event) => {
        if (poolModelPopover.hidden) return;
        if (event.target === poolModelInput || poolModelPopover.contains(event.target)) return;
        hidePoolModelPopover();
      });
    }
    const applyPoolProviderFetch = () => {
      const provider = poolCloudProvider.value;
      const config = CLOUD_PROVIDERS[provider];
      const pullable = Boolean(config) && config.pullModels !== false;
      poolFetchButton.hidden = !pullable;
      if (poolFetchResult) {
        poolFetchResult.hidden = pullable;
        poolFetchResult.textContent = pullable ? "" : "该服务商无模型列表接口，模型名手填即可。";
      }
      poolModelOptions = [];
      hidePoolModelPopover();
      document.querySelector("#pool-cloud-baseurl").placeholder = provider === "custom" ? "API 地址（custom 必填，如 https://xx/v1）" : `自定义 baseURL（选填，走服务商默认）`;
    };
    if (poolCloudProvider) poolCloudProvider.addEventListener("change", applyPoolProviderFetch);
    applyPoolProviderFetch(); // 初始按默认服务商校准显隐
    poolFetchButton?.addEventListener("click", async () => {
      if (poolFetchButton.disabled) return;
      const provider = poolCloudProvider.value;
      const config = CLOUD_PROVIDERS[provider];
      if (!config || config.pullModels === false) return;
      const apiKey = document.querySelector("#pool-cloud-key").value.trim();
      const baseUrl = document.querySelector("#pool-cloud-baseurl").value.trim() || config.baseUrl || "";
      // 节点 Key 独立计费（不复用主设置）——未填直接拦下，绝不让主进程兜全局云端密钥
      if (!apiKey) {
        poolFetchResult.hidden = false;
        poolFetchResult.textContent = "⚠️ 请先填写该节点的 API Key 再拉取";
        return;
      }
      if (!baseUrl) {
        poolFetchResult.hidden = false;
        poolFetchResult.textContent = "⚠️ 请先填写 API 地址再拉取";
        return;
      }
      poolFetchButton.disabled = true;
      poolFetchButton.textContent = "拉取中…";
      poolFetchResult.hidden = false;
      poolFetchResult.textContent = "正在请求官方模型列表…";
      try {
        const result = await window.agentChatPro.fetchCloudModels({ provider, apiKey, baseUrl });
        if (!result?.ok) {
          poolFetchResult.textContent = `⚠️ ${result?.reason || "拉取失败，请检查密钥和网络"}`;
          return;
        }
        // v3.37.0：存进浮层数据源并自动弹出——用户不用再找输入框里的小三角
        poolModelOptions = result.models || [];
        openPoolModelPopover();
        poolFetchResult.textContent = `✅ 已拉取 ${result.count} 个该 Key 可用的模型，列表已弹出，点一个直接填入（也可手填）`;
      } catch (error) {
        poolFetchResult.textContent = `⚠️ 拉取失败：${error?.message || error}`;
      } finally {
        poolFetchButton.disabled = false;
        poolFetchButton.textContent = "🔄 拉取";
      }
    });
    // 三个添加块
    // v3.35.7（用户令）：建群对话框不再放思考挡位滑条——思考程度统一在群聊输入栏的
    // 思考面板里按成员叠加调（每成员一节+预计消耗倍数）；池节点保存时不带挡位（留池默认）
    document.querySelector("#pool-cloud-save").addEventListener("click", async () => {
      const status = document.querySelector("#group-setup-status");
      const provider = document.querySelector("#pool-cloud-provider").value;
      const model = document.querySelector("#pool-cloud-model").value.trim();
      try {
        await window.agentChatPro.addAgentPoolCloud({
          name: document.querySelector("#pool-cloud-name").value,
          provider,
          apiKey: document.querySelector("#pool-cloud-key").value,
          model,
          baseURL: document.querySelector("#pool-cloud-baseurl").value
        });
        status.textContent = "云端节点已入池。";
        ["#pool-cloud-name", "#pool-cloud-key", "#pool-cloud-model", "#pool-cloud-baseurl"].forEach((sel) => { document.querySelector(sel).value = ""; });
        await renderSetupPoolList();
      } catch (error) {
        status.textContent = `保存失败：${error.message || error}`;
      }
    });
    bindInstanceForm("pool-ssh-save", (form) => window.agentChatPro.addAgentPoolInstance({ kind: "ssh", name: form[0].value, profileId: form[1].value, adapter: form[2].value }));
    bindInstanceForm("pool-local-save", (form) => window.agentChatPro.addAgentPoolInstance({ kind: "local", name: form[0].value, engine: form[1].value }));
    document.querySelector("#wg-create").addEventListener("click", createWorkgroupFromForm);
    document.querySelector("#wg-start-chat").addEventListener("click", startWorkgroupChat);
    renderCloudThinkingHint();
  }
  dialog.showModal();
}

function bindInstanceForm(saveId, submitter) {
  document.querySelector(`#${saveId}`).addEventListener("click", async () => {
    const block = document.querySelector(`#${saveId}`).closest(".group-add-block");
    const fields = [...block.querySelectorAll("input[type=text], select")].filter((el) => !el.closest("details").querySelector("summary").textContent.includes("云端"));
    const status = document.querySelector("#group-setup-status");
    try {
      await submitter(fields);
      status.textContent = "实例已入池。";
      block.querySelectorAll("input").forEach((input) => { input.value = ""; });
      await renderSetupPoolList();
      await renderSetupWgList();
    } catch (error) {
      status.textContent = `保存失败：${error.message || error}`;
    }
  });
}

/** 云端节点默认挡位提示（thinking-levels 按家挡位不同——模块二要求按各家范围独立注入） */
function renderCloudThinkingHint() {
  void 0; // 挡位表实时按 provider/model 查询（getThinkingProfile），无需预载
}

/** 建群对话框 boot 期空挂载：全部事件绑定在 openGroupSetup 内懒初始化（dialog.dataset.started） */
function initGroupSetupUI() { void 0; }

async function renderSetupPoolList() {
  const list = document.querySelector("#group-pool-list");
  if (!list) return;
  const nodes = await window.agentChatPro.listAgentPool();
  list.replaceChildren();
  if (!nodes.length) {
    const empty = document.createElement("p");
    empty.className = "group-hint";
    empty.textContent = "池为空：先在下方添加 Agent 实例（云端 / SSH / 本机任意组合）。";
    list.append(empty);
    return;
  }
  for (const node of nodes) {
    const row = renderPoolNodeRow(node);
    list.append(row);
  }
}

/** 池节点行：名称 + 类型徽章 + 云端模型/思考挡位滑条（模块二·独立滑条） + 删除 */
function renderPoolNodeRow(node) {
  const row = document.createElement("div");
  row.className = "pool-node-row";
  row.dataset.nodeId = node.id;
  const head = document.createElement("div");
  head.className = "pool-node-head";
  const kindLabel = node.kind === "cloud" ? "云端" : node.kind === "ssh" ? "SSH" : "本机";
  const badge = document.createElement("span");
  badge.className = `pool-kind-badge pool-kind-${node.kind}`;
  badge.textContent = kindLabel;
  const name = document.createElement("span");
  name.className = "pool-node-name";
  name.textContent = `@${node.name}`;
  const key = node.kind === "cloud" ? `${node.cloud?.provider || ""} · ${node.cloud?.model || ""}${node.cloud?.keyTail ? ` · key ${node.cloud.keyTail}` : ""}`
    : node.kind === "ssh" ? `${node.ssh?.profileId || ""} · ${node.ssh?.adapter || ""}` : node.local?.engine || "";
  const meta = document.createElement("span");
  meta.className = "pool-node-meta";
  meta.textContent = key || "（未配置）";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "pool-remove";
  remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    try {
      await window.agentChatPro.removeAgentPoolNode(node.id);
      await renderSetupPoolList();
      await renderSetupWgList();
    } catch (error) {
      document.querySelector("#group-setup-status").textContent = `删除失败：${error.message || error}`;
    }
  });
  head.append(badge, name, meta, remove);
  row.append(head);
  // v3.35.7（用户令）：建群对话框不再给节点行放思考滑条——只读小字显示当前挡位；
  // 挡位调整统一在群聊输入栏思考面板里按成员叠加调（群聊设置里不出现思考程度）
  if (node.kind === "cloud" && node.thinkingLevel) {
    const levelTag = document.createElement("span");
    levelTag.className = "pool-node-level";
    levelTag.textContent = `思考:${node.thinkingLevel}`;
    levelTag.title = "挡位在群聊输入栏的思考面板里调整（每成员独立）";
    head.append(levelTag);
  }
  return row;
}

let groupSetupSelectedWorkgroupId = "";

async function renderSetupWgList() {
  const list = document.querySelector("#group-wg-list");
  if (!list) return;
  const [workgroups, nodes] = await Promise.all([
    window.agentChatPro.listWorkgroups(),
    window.agentChatPro.listAgentPool()
  ]);
  list.replaceChildren();
  const checks = document.querySelector("#wg-member-checks");
  checks.replaceChildren();
  // v3.37.0 默认预选最近一次建的工作组（用户实锤「选择确认超级麻烦」）：打开建群对话框即可直接「开始协作」，要换组再点
  if (!groupSetupSelectedWorkgroupId) {
    const latest = (workgroups || []).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
    if (latest) groupSetupSelectedWorkgroupId = latest.id;
  }
  const nameById = new Map(nodes.map((node) => [node.id, node.name]));
  for (const group of workgroups) {
    const row = document.createElement("div");
    row.className = "wg-row" + (group.id === groupSetupSelectedWorkgroupId ? " active" : "");
    const title = document.createElement("span");
    title.className = "wg-name";
    title.textContent = group.name;
    const members = document.createElement("span");
    members.className = "wg-members";
    members.textContent = (group.members || []).map((member) => `@${nameById.get(member.agentId) || "?"}`).join(" → ");
    const turns = document.createElement("span");
    turns.className = "wg-turns";
    turns.textContent = `上限 ${group.maxTurns} 轮`;
    const use = document.createElement("button");
    use.type = "button";
    use.className = "wg-use";
    use.textContent = "选择";
    use.addEventListener("click", () => {
      groupSetupSelectedWorkgroupId = group.id;
      void use;
      renderSetupWgList();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pool-remove";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      try {
        await window.agentChatPro.deleteWorkgroup(group.id);
        if (groupSetupSelectedWorkgroupId === group.id) groupSetupSelectedWorkgroupId = "";
        await renderSetupWgList();
      } catch (error) {
        document.querySelector("#group-setup-status").textContent = `删除失败：${error.message || error}`;
      }
    });
    row.append(title, members, turns, use, remove);
    list.append(row);
  }
  // 成员勾选框（按勾选顺序=自主讨论接力顺序）
  nodes.forEach((node) => {
    const label = document.createElement("label");
    label.className = "wg-member-check";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = node.id;
    label.append(check, document.createTextNode(` @${node.name}（${node.kind === "cloud" ? "云端" : node.kind === "ssh" ? "SSH" : "本机"}）`));
    checks.append(label);
  });
  if (!workgroups.length) {
    const empty = document.createElement("p");
    empty.className = "group-hint";
    empty.textContent = "还没有工作组：勾选成员后创建一个（群主视角）。";
    list.append(empty);
  }
}

async function createWorkgroupFromForm() {
  const status = document.querySelector("#group-setup-status");
  const agentIds = [...document.querySelectorAll("#wg-member-checks input:checked")].map((check) => check.value);
  const name = document.querySelector("#wg-name").value;
  const maxTurns = Number(document.querySelector("#wg-max-turns").value) || 5;
  try {
    await window.agentChatPro.createWorkgroup({ name, agentIds, maxTurns });
    status.textContent = "工作组已创建。";
    document.querySelector("#wg-name").value = "";
    document.querySelectorAll("#wg-member-checks input:checked").forEach((check) => { check.checked = false; });
    await renderSetupWgList();
  } catch (error) {
    status.textContent = `创建失败：${error.message || error}`;
  }
}

/** 「进入群聊」：选中工作组 → 新建 team 对话 → 绑定工作组 → 载入群聊布局 */
async function startWorkgroupChat() {
  const status = document.querySelector("#group-setup-status");
  if (!groupSetupSelectedWorkgroupId) {
    status.textContent = "请先在「工作组」页选择一个工作组。";
    return;
  }
  try {
    const conversation = await window.agentChatPro.createConversation("team");
    await window.agentChatPro.setConversationWorkgroup(conversation.id, groupSetupSelectedWorkgroupId);
    document.querySelector("#group-setup-dialog").close();
    await loadConversation(conversation.id);
    elements.prompt.focus();
  } catch (error) {
    status.textContent = `进入群聊失败：${error.message || error}`;
  }
}
