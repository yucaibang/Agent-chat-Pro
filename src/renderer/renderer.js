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
      maxRetries: advFieldValue("#adv-cloud-max-retries", 0),
      maxToolRounds: advFieldValue("#adv-cloud-tool-rounds", 25)
    }
  };
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
    const rolled = [];
    if (patch.ssh && !advanced.ssh) rolled.push("SSH 连接");
    if (patch.external && !advanced.external) rolled.push("外网传输");
    if (patch.cloud && !advanced.cloud) rolled.push("云端模型");
    setStatus(rolled.length
      ? `已保存；但 ${rolled.join("、")} 所填值不合法，已整组回退自动识别。`
      : successText, rolled.length > 0);
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

function addMessage(kind, text = "", meta = {}) {
  elements.empty.hidden = true;
  const item = document.createElement("article");
  item.className = `message ${kind}`;
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

async function renderAssistant(item, text) {
  const content = item.querySelector(".message-content");
  // v3.20.0 F5：```plan 约定块抽离渲染 Agent plan 面板（正文剥离该块不再重复显示；
  // 同消息内多个块只取最后一块=最新全局进度；AI 没输出 plan 块则零渲染）
  const plan = extractPlanBlocks(text);
  if (plan.hasPlan) renderPlanPanel(item, plan.last.map((line, i) => ({ index: i + 1, text: line, status: "" })), false);
  content.innerHTML = await window.agentChatPro.renderMarkdown(plan.rest);
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
function appendRoundMark(answer, round) {
  if (!answer) return;
  const node = document.createElement("div");
  node.className = "round-mark";
  node.textContent = `— 第 ${Number(round) || 1} 轮工具 —`;
  answer.append(node);
  if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
}

// v3.21.3 修复②：v3.15.5~v3.21.2 期间注入正文的独立 `---` 分隔行剥除（只对带工具牌的云端消息调用）
function stripSeparatorLines(text) {
  return String(text || "").replace(/^[ \t]*-{3,}[ \t]*\n/gm, "\n").replace(/^[ \t]*-{3,}[ \t]*$/gm, "");
}

function renderTool(item, tool) {
  // v3.20.0 F5：TodoWrite 走 Agent plan 面板特化渲染（结构化路=SSH 远程+本机 claude 引擎），
  // 不进通用工具卡列表、不计入 finalizeToolList 的「已执行 N 个操作」
  if (isPlanTool(tool)) {
    renderPlanPanel(item, planTodosFromTool(tool), true);
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
    const results = await window.agentChatPro.searchConversations(query);
    elements.historyCount.textContent = `${results.length} 条结果`;
    elements.conversationList.replaceChildren();
    results.forEach((conv) => {
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
    conversationCache = await window.agentChatPro.listConversations();
    elements.historyCount.textContent = String(conversationCache.length);
    elements.conversationList.replaceChildren();
    conversationCache.forEach((conversation) => {
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
  // v3.15.6：切走前先保存当前对话的输入框草稿（文本+附件），下方进入时恢复目标对话草稿
  if (conversationId) composerDrafts.set(conversationId, { text: elements.prompt.value, attachments });
  // v3.15.0 bug1：Agent 工作中允许切换对话——进行中的任务在后台继续，切回无缝衔接
  const conversation = await window.agentChatPro.getConversation(id);
  if (!conversation) return;
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
  sessionId = conversation.sessionId || "";
  // v3.15.6：恢复该对话的输入框草稿（文本+附件）——不再粗暴清空丢字/丢附件，切换互不串扰
  const composerDraft = composerDrafts.get(conversation.id) || { text: "", attachments: [] };
  attachments = [...(composerDraft.attachments || [])];
  elements.prompt.value = composerDraft.text || "";
  adjustTextarea();
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
    const item = addMessage(message.role, message.text, { senderType: message.senderType || "" });
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
      (message.tools || []).forEach((tool) => renderTool(item, tool));
      finalizeToolList(item, message.tools || []);
      renderReturnedFiles(item, message.files || []);
      // v3.21.3 修复②：带工具牌的云端历史消息——剥掉 v3.15.5 起注入正文的孤立 `---` 分隔行（不再堆横线）
      renderAssistant(item, (message.tools || []).length ? stripSeparatorLines(message.text) : message.text);
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

async function createNewConversation() {
  // v3.15.0 bug1：Agent 工作中允许新建/切换对话——进行中的任务在后台继续
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

async function sendMessage(composerText = elements.prompt.value, opts = {}) {
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
  // 桥回合的附件恒为空——全局 attachments 是用户输入框草稿，桥回合不得顺手把它带进对话
  const turnAttachments = viaBridge ? [] : attachments;
  const userItem = addMessage("user", message, { senderType: viaBridge ? "cloud-ai" : "" });
  renderSentAttachments(userItem, turnAttachments);
  const answer = addMessage("assistant generating");
  messages.set(activeId, answer);
  if (!viaBridge) { elements.prompt.value = ""; adjustTextarea(); } // 桥回合不清用户输入框草稿
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
    answer.querySelector(".message-content").textContent = failureLabel + "：\n" + error.message;
    reportBridgeResult("failed", { error: error.message });
    setConnection("连接失败", "error");
    // 失败时也合并已估算的 token
    addConversationTokens(streamingTokens + confirmedTokens);
    resetStreamingTokens();
  } finally {
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
  modelSelect.innerHTML = config.models.map((m) => `<option value="${m.value}">${m.label}</option>`).join("");
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
    if (provider === "custom") {
      const datalist = document.querySelector("#cloud-custom-model-list");
      if (datalist) datalist.innerHTML = result.models.map((m) => `<option value="${m.value}">${m.label === m.value ? "" : m.label}</option>`).join("");
      resultEl.textContent = `✅ 已拉取 ${result.count} 个模型，点模型输入框可从列表选择`;
    } else {
      const modelSelect = document.querySelector("#cloud-model");
      const current = modelSelect?.value || "";
      modelSelect.innerHTML = result.models.map((m) => `<option value="${m.value}">${m.label}</option>`).join("");
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
  const answer = messages.get(event.id);
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
    renderTool(answer, event.tool);
    // v3.15.0 智能滚动：仅当用户停在底部附近才跟随
    if (isNearBottom()) elements.messages.scrollTop = elements.messages.scrollHeight;
  } else if (event.type === "round" && answer) {
    // v3.21.3 修复②：跨轮标记——主进程不再注入正文分隔线，这里画轻量轮次徽标
    appendRoundMark(answer, event.round);
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
  } catch (error) {
    setModelBadge("读取失败");
    title.textContent = "模型配置读取失败";
    detail.textContent = error.message;
    document.querySelector("#model-entry-list").replaceChildren();
  }
}

// ── 模型管理员密码对话框（missing/invalid → 初始化；ready → 写操作确认；AO 语义承接，ACP 无老 UI 回归风险） ──
let modelPasswordResolver = null;

function openModelPasswordDialog(mode) {
  const dialog = document.querySelector("#model-password-dialog");
  const title = document.querySelector("#model-password-title");
  const hint = document.querySelector("#model-password-hint");
  const confirmWrap = document.querySelector("#model-admin-confirmation-wrap");
  const status_ = document.querySelector("#model-password-status");
  title.textContent = mode === "initialize" ? "初始化模型管理员密码" : "输入模型管理员密码";
  hint.textContent = mode === "initialize"
    ? "首次写模型配置前需要设置一个管理员密码（至少 6 位）。此后所有模型写操作都要校验它，避免误触。"
    : "写模型配置前需要校验管理员密码。";
  confirmWrap.hidden = mode !== "initialize";
  status_.textContent = "";
  document.querySelector("#model-admin-password").value = "";
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
  const initializeMode = !document.querySelector("#model-admin-confirmation-wrap").hidden;
  if (initializeMode) {
    const confirmation = document.querySelector("#model-admin-confirmation").value;
    if (password.length < 6) { document.querySelector("#model-password-status").textContent = "密码需至少 6 位。"; return; }
    if (password !== confirmation) { document.querySelector("#model-password-status").textContent = "两次输入不一致。"; return; }
    window.agentChatPro.initializeModelAdminPassword({ password, confirmation })
      .then(() => finishModelPassword(password))
      .catch((error) => { document.querySelector("#model-password-status").textContent = error.message; });
    return;
  }
  if (!password) { document.querySelector("#model-password-status").textContent = "请输入管理员密码。"; return; }
  finishModelPassword(password);
});
document.querySelector("#model-password-cancel").addEventListener("click", () => finishModelPassword(null));

async function requestModelAdminPassword() {
  const dialog = document.querySelector("#model-password-dialog");
  if (dialog.open) return null;
  const settings = await window.agentChatPro.loadSettings();
  const state = settings.modelAdminPasswordState;
  if (state === "unavailable") { setConnection("Windows 系统加密不可用，无法写模型配置。", "error"); return null; }
  const mode = state === "missing" || state === "invalid" ? "initialize" : "confirm";
  return openModelPasswordDialog(mode);
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
  } catch (error) { setStatus(error.message, true); }
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
  } catch (error) { setStatus(error.message, true); }
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
  } catch (error) { setStatus(error.message, true); }
  finally { button.disabled = false; button.textContent = originalText; }
});
