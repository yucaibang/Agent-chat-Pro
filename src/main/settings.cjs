"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { app, safeStorage } = require("electron");

const SETTINGS_FILE = "connection.json";
const USER_AVATARS = new Set(["user-male-1", "user-female-1", "user-male-2", "user-female-2"]);
let recoveryNotice = "";

/**
 * 网络配置脱敏：移除敏感字段，替换为 hasXxx 布尔标记。
 * frp: token → hasToken
 * derp: authKey → hasAuthKey
 * n2n: key → hasKey, community → hasCommunity
 * p2p: 无敏感字段，原样返回
 */
const NETWORK_SENSITIVE_FIELDS = {
  frp: { token: "hasToken" },
  derp: { authKey: "hasAuthKey" },
  n2n: { community: "hasCommunity", key: "hasKey" }
};

function sanitizeNetworkConfig(config, type) {
  const fields = NETWORK_SENSITIVE_FIELDS[type];
  if (!fields) return { ...(config || {}) };
  const result = { ...(config || {}) };
  for (const [secretField, hasField] of Object.entries(fields)) {
    result[hasField] = Boolean(result[secretField]);
    delete result[secretField];
  }
  return result;
}

/**
 * 保存时合并网络配置：前端脱敏后不含敏感字段，需要从 previous 继承。
 * 如果前端传了新的敏感字段值（用户修改了），则使用新值；
 * 如果前端传了空字符串（用户留空=不修改），则保留 previous 中的值。
 */
function mergeNetworkConfig(input, previous, type) {
  const fields = NETWORK_SENSITIVE_FIELDS[type];
  const merged = { ...(previous || {}), ...(input || {}) };
  if (!fields) return merged;
  for (const [secretField, hasField] of Object.entries(fields)) {
    // 前端留空=不修改，保留 previous 中的值
    if (merged[secretField] === "" && (previous || {})[secretField]) {
      merged[secretField] = previous[secretField];
    }
    // 清除 hasXxx 标记（这是前端脱敏标记，不应存入磁盘）
    delete merged[hasField];
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────
// 高级设置（v3.19.0 F3）：自动/手动两态
//   分组值 null = 自动识别（行为 = 代码内默认值，零字段暴露）
//   分组值 = 对象时为手动（字段逐个白名单钳制，非法即整组回自动）
//   adapter 不参与两态：SSH 远程适配器显式五选一（claude 内置，其余需远端安装）
// 默认值表 = 现状硬编码实锤（与 ssh.cjs / cloud-chat.cjs / cloud-tools.cjs 常量逐一对应）
// ─────────────────────────────────────────────────────────────────────
const ADVANCED_ADAPTERS = ["claude", "atomcode", "qwen", "codex", "hermes"];

const ADVANCED_DEFAULTS = {
  ssh: { requestTimeoutMin: 30, connectTimeoutSec: 15, sftpTimeoutSec: 30, reconnectAttempts: 3, reconnectBaseMs: 600, keepaliveSec: 15, debugLog: false },
  cloud: { connectTimeoutSec: 120, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 25 }
};

const ADVANCED_CLAMPS = {
  ssh: {
    requestTimeoutMin: [10, 120],   // 单次请求超时（分钟）；现状 MAX_REQUEST_MS 30
    connectTimeoutSec: [5, 60],     // SSH ready 超时（秒）；现状 SSH_READY_TIMEOUT_MS 15
    sftpTimeoutSec: [10, 300],      // SFTP/探针/步进超时（秒）；现状 SFTP_OPERATION_TIMEOUT_MS 30
    reconnectAttempts: [0, 10],     // 连接重试次数；现状 MAX_CONNECT_ATTEMPTS 3
    reconnectBaseMs: [100, 30000],  // 指数退避基数（毫秒）；现状 600起步封顶15s
    keepaliveSec: [10, 120]         // SSH keepalive 间隔（秒）；现状 SSH_KEEPALIVE_INTERVAL_MS 15
  },
  cloud: {
    connectTimeoutSec: [10, 300],       // 云端连接超时（秒）；现状 req.setTimeout 120
    streamIdleTimeoutSec: [60, 1800],   // 流式空闲超时（秒）；现状响应级 300000ms
    maxRetries: [0, 3],                 // 失败自动重试（仅幂等码 429/5xx）；现状 0
    maxToolRounds: [5, 50]              // 工具循环轮数上限；现状 MAX_TOOL_ROUNDS 25
  }
};

const N2N_CIPHER_OPTIONS = ["", "A2", "A3", "A4", "A5"]; // edge -A 加密方式（空=n2n 默认；A5 Speck-CTR 走 -A5）
const N2N_COMPRESSION_OPTIONS = ["", "lzo1x", "zstd"];   // -z1 / -z2
const N2N_PROTOCOL_OPTIONS = ["", "udp", "tcp"];          // 空=自动（UDP 失败降级 TCP）；手动=固定模式不探测
const FRP_PROTOCOL_OPTIONS = ["", "tcp", "kcp", "quic", "websocket", "wss"]; // frpc transport.protocol（服务端 toml，客户端仅标注）

function normalizeRemoteAdapter(value) {
  const adapter = String(value || "").trim();
  return ADVANCED_ADAPTERS.includes(adapter) ? adapter : "claude";
}

function clampAdvancedInt(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** 手动组逐字段钳制：任一字段非法 → 整组回自动（null），绝不静默改值 */
function sanitizeAdvancedNumericGroup(group, clamps) {
  if (!group || typeof group !== "object") return null;
  const out = {};
  for (const [field, [min, max]] of Object.entries(clamps)) {
    const value = clampAdvancedInt(group[field], min, max);
    if (value === null) return null;
    out[field] = value;
  }
  return out;
}

/** SSH 手动组 = 数字六参数（钳制） + debugLog 布尔开关：任一数字非法整组回自动 */
function sanitizeSshAdvanced(group) {
  const numeric = sanitizeAdvancedNumericGroup(group, ADVANCED_CLAMPS.ssh);
  if (!numeric) return null;
  return { ...numeric, debugLog: Boolean(group.debugLog) };
}

function sanitizeN2nAdvanced(group) {
  // external 分组带方式子键（v3.19.0 本轮只实做 n2n 的可消费参数；frp/derp/p2p 为 NAS 侧或明文标注无客户端字段）
  const n2n = group?.n2n && typeof group.n2n === "object" ? group.n2n : null;
  if (!n2n) return null;
  const cipher = String(n2n.cipher ?? "");
  const compression = String(n2n.compression ?? "");
  const protocol = String(n2n.protocol ?? "").toLowerCase();
  if (!N2N_CIPHER_OPTIONS.includes(cipher)) return null;
  if (!N2N_COMPRESSION_OPTIONS.includes(compression)) return null;
  if (!N2N_PROTOCOL_OPTIONS.includes(protocol)) return null;
  return {
    n2n: {
      cipher: cipher || "",
      compression: compression || "",
      protocol: protocol || "",
      headerEncryption: Boolean(n2n.headerEncryption) // edge -H 头加密（要求 supernode 固定社区名）
    }
  };
}

/**
 * advanced 分组合并：input 带 advanced 时整体接管（UI 每次 save 全量提交）；
 * 否则继承 previous。null 分组 = 自动。
 */
function sanitizeAdvanced(input, previous) {
  const source = input !== undefined && input !== null && typeof input === "object" ? input : (previous || {});
  const rawSsh = source.ssh === undefined ? null : source.ssh;
  const rawExternal = source.external === undefined ? null : source.external;
  const rawCloud = source.cloud === undefined ? null : source.cloud;
  return {
    ssh: sanitizeSshAdvanced(rawSsh),
    external: sanitizeN2nAdvanced(rawExternal),
    cloud: sanitizeAdvancedNumericGroup(rawCloud, ADVANCED_CLAMPS.cloud),
    adapter: normalizeRemoteAdapter(source.adapter),
    // 适配器附加参数（v3.19.0 F3）：qwen -m / codex --sandbox / hermes --model --provider；宽松 trim
    adapterOptions: sanitizeAdapterOptions(source.adapterOptions)
  };
}

/** 适配器附加参数：全部可选，非法/缺失回空串（三家 runner 空值即不带参） */
function sanitizeAdapterOptions(value) {
  const source = value && typeof value === "object" ? value : {};
  const sandbox = String(source.sandbox || "").trim();
  return {
    model: String(source.model || "").trim(),
    sandbox: sandbox === "read-only" ? "read-only" : sandbox === "workspace-write" ? "workspace-write" : "",
    provider: String(source.provider || "").trim()
  };
}

/** 合并实值：null 分组展开为默认值表，消费端（ssh.cjs/cloud-chat/main）直接读取 */
function advancedEffective(advanced) {
  return {
    ssh: { ...ADVANCED_DEFAULTS.ssh, ...(advanced?.ssh || {}) },
    cloud: { ...ADVANCED_DEFAULTS.cloud, ...(advanced?.cloud || {}) },
    external: {
      n2n: {
        cipher: advanced?.external?.n2n?.cipher || "",
        compression: advanced?.external?.n2n?.compression || "",
        protocol: advanced?.external?.n2n?.protocol || "",
        headerEncryption: Boolean(advanced?.external?.n2n?.headerEncryption)
      }
    },
    adapter: normalizeRemoteAdapter(advanced?.adapter),
    adapterOptions: {
      model: String(advanced?.adapterOptions?.model || "").trim(),
      sandbox: advanced?.adapterOptions?.sandbox === "read-only" ? "read-only" : "",
      provider: String(advanced?.adapterOptions?.provider || "").trim()
    }
  };
}

function normalizeUserAvatar(value) {
  const avatar = String(value || "");
  return USER_AVATARS.has(avatar) ? avatar : "user-male-1";
}

/** 配置结构版本（v3.16.0 数据迁移机制）：结构变化时在此推进版本并加迁移分支 */
// v3.18.0 F4：升到 2（SSH 多卡槽字段起步）
// v3.19.0 F3：升到 3（advanced 高级设置分组起步——自动/手动两态 + SSH 适配器 remoteAdapter）
const SETTINGS_SCHEMA_VERSION = 3;

function settingsPath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
}

function legacySettingsPath() {
  return path.join(path.dirname(app.getPath("userData")), "claude-nas-chat", SETTINGS_FILE);
}

/**
 * 配置结构迁移（v3.16.0）：读到旧版本（或无版本标）配置时——
 * ① 整文件备份为 .schema-v{旧版本}.bak（固定名覆盖，幂等不堆积）
 * ② 打上版本标并落盘（本会话后续读取短路零开销）
 * 任何一步失败都不阻断读取（迁移失败可恢复 = 原文件未动）。
 */
function migrateSchema(raw) {
  const from = Number(raw.schemaVersion) || 0;
  if (from === SETTINGS_SCHEMA_VERSION) return raw;
  const source = settingsPath();
  const backup = `${source}.schema-v${from}.bak`;
  try { fs.copyFileSync(source, backup); } catch { /* 首迁（legacy/新装）或源不存在：跳过备份 */ }
  const migrated = { ...raw, schemaVersion: SETTINGS_SCHEMA_VERSION };
  try { writeRaw(migrated); } catch { /* 版本标落盘失败不影响本次读取 */ }
  return migrated;
}

function readRaw() {
  try {
    const current = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    // 品牌更名迁移：从旧配置文件继承模型密码
    if (!current.modelAdminPassword) {
      try {
        const legacy = JSON.parse(fs.readFileSync(legacySettingsPath(), "utf8"));
        if (legacy.modelAdminPassword) current.modelAdminPassword = legacy.modelAdminPassword;
      } catch { /* 旧配置文件损坏不影响当前配置 */ }
    }
    return migrateSchema(current);
  } catch (error) {
    if (error.code === "ENOENT") {
      try { return migrateSchema(JSON.parse(fs.readFileSync(legacySettingsPath(), "utf8"))); }
      catch { return {}; }
    }
    const source = settingsPath();
    const backup = `${source}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    try {
      fs.renameSync(source, backup);
      recoveryNotice = `检测到损坏的连接设置，已备份为 ${path.basename(backup)}，请重新检查并保存设置。`;
      return {};
    } catch (backupError) {
      throw new Error("无法读取本地连接设置，且无法创建恢复备份：" + backupError.message);
    }
  }
}

function writeRaw(raw) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const temporary = `${settingsPath()}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stamped = { ...raw, schemaVersion: SETTINGS_SCHEMA_VERSION };
  try {
    fs.writeFileSync(temporary, JSON.stringify(stamped, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, settingsPath());
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function sameSshTarget(left, right) {
  return String(left?.host || "").trim().toLocaleLowerCase() === String(right?.host || "").trim().toLocaleLowerCase()
    && (Number(left?.port) || 22) === (Number(right?.port) || 22)
    && String(left?.username || "").trim() === String(right?.username || "").trim();
}

// ── SSH 多卡槽（v3.18.0 F4，AO 0.9.6 同构 + ACP 特性扩展）──
// v1 固定两槽（UI 预留扩展——拍板 #2）；每槽独立保存 host/port/username/password/workingDirectory/
// skipPermissions/networkType/externalMethod/hostFingerprint；外网传输的具体参数（frp/n2n token 等）
// v1 仍全局一份、槽只保存「用哪套」的选择（networkType/externalMethod）——多 NAS 各异 token 的场景留待后续版本。
const SSH_PROFILE_IDS = ["ssh-1", "ssh-2"];

function normalizeSshProfileId(value) {
  return SSH_PROFILE_IDS.includes(value) ? value : "ssh-1";
}

/** 卡槽名称（AO：≤4 个中文字符或 8 个英文数字；留空恢复默认名）：宽松为 ≤8 码元 + 无空白无标点。 */
function normalizeSshProfileName(value) {
  const name = String(value || "").trim();
  if (!name) return "";
  if (name.length > 8 || /\s/.test(name) || /[\\/:*?"<>|]/.test(name)) return "";
  return name;
}

function normalizeSshProfileSlot(slot) {
  return {
    id: normalizeSshProfileId(slot?.id),
    name: normalizeSshProfileName(slot?.name),
    host: String(slot?.host || "").trim(),
    port: Number(slot?.port) || 22,
    username: String(slot?.username || "").trim(),
    // password 为 safeStorage base64 密文；槽间不可混（拍板：沿用 v3.1.0 AES-256-GCM 密文，各自独立保存）
    password: typeof slot?.password === "string" ? slot.password : "",
    workingDirectory: String(slot?.workingDirectory || "").trim(),
    skipPermissions: Boolean(slot?.skipPermissions),
    networkType: slot?.networkType === "external" ? "external" : "internal",
    externalMethod: String(slot?.externalMethod || "auto").trim(),
    hostFingerprint: String(slot?.hostFingerprint || "").trim(),
    configured: Boolean(String(slot?.host || "").trim() && String(slot?.username || "").trim())
  };
}

/**
 * 卡槽列表规整 + 旧单套配置迁移（拍板：「旧配置首升全部落到 ssh-1，ssh-2 空槽待配」）：
 * raw 无 sshProfiles 数组时 = 旧配置，ssh-1 承接顶层主配置（密码/指纹/网络选择原样搬）；
 * 已有数组则按 id 归一化（缺失的槽补空槽）。幂等，无副作用。
 */
function ensureSshProfiles(raw) {
  const hasList = Array.isArray(raw?.sshProfiles);
  if (!hasList) {
    const migrated = normalizeSshProfileSlot({
      id: "ssh-1",
      host: raw?.host, port: raw?.port, username: raw?.username, password: raw?.password,
      workingDirectory: raw?.workingDirectory, skipPermissions: raw?.skipPermissions,
      networkType: raw?.networkType, externalMethod: raw?.externalMethod, hostFingerprint: raw?.hostFingerprint
    });
    return [migrated, normalizeSshProfileSlot({ id: "ssh-2" })];
  }
  return SSH_PROFILE_IDS.map((id) => normalizeSshProfileSlot(raw.sshProfiles.find((slot) => slot?.id === id) || { id }));
}

function activeSshProfileSlot(raw) {
  const profiles = ensureSshProfiles(raw);
  const activeId = normalizeSshProfileId(raw?.activeSshProfile);
  return profiles.find((slot) => slot.id === activeId) || profiles[0];
}

function modelAdminPasswordState(raw = readRaw()) {
  if (!safeStorage.isEncryptionAvailable()) return "unavailable";
  if (!raw.modelAdminPassword) return "missing";
  try {
    safeStorage.decryptString(Buffer.from(raw.modelAdminPassword, "base64"));
    return "ready";
  } catch {
    return "invalid";
  }
}

/** 压缩起始阈值（%）：50–95，默认 80 */
function normalizeCompactThreshold(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 80;
  return Math.min(95, Math.max(50, Math.round(num)));
}

/** 压缩指令：预设空串（默认 /compact）或自定义文本，最长 300 字符 */
function normalizeCompactInstruction(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.slice(0, 300);
}

/** 本机模式引擎归一化（v3.13.0）：仅接受 atomcode / custom，其余一律 claude（兼容旧配置） */
function normalizeLocalEngine(value) {
  return value === "atomcode" || value === "custom" ? value : "claude";
}

/** 外观参数钳制（v3.21.4）：clamp 至滑杆合法域；非法/低于下限（含旧版 0-1 比例残留 0.15）回退默认值 */
// v3.24.0 模型思考调节：挡位记忆归一（settings.thinkingChoices）
const { normalizeThinkingChoices } = require("./thinking-levels.cjs");

function clampAppearanceRange(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeAtomcodePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 13456;
}

/** AtomCode daemon token：加密存储，仅主进程解密使用，不出设置接口 */
function getAtomcodeToken() {
  const raw = readRaw();
  if (!raw.atomcodeTokenEncrypted) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法解密 AtomCode token。");
  return decryptStoredString(raw.atomcodeTokenEncrypted, "AtomCode token");
}

/** Agent HTTP 桥端口归一化（阉割版专用）：1024–65535，非法回默认 21774 */
function normalizeAgentBridgePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 21774;
}

/** Agent HTTP 桥 Token：首次取用时自动生成并 safeStorage 加密落盘（加密存储，不随 settings:load 明文外发，仅桥模块比对与 agentBridge:info 出示给用户复制） */
function ensureAgentBridgeToken() {
  const raw = readRaw();
  if (raw.agentBridgeTokenEncrypted) return decryptStoredString(raw.agentBridgeTokenEncrypted, "Agent 桥 Token");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法生成 Agent 桥 Token。");
  const token = crypto.randomBytes(24).toString("hex");
  raw.agentBridgeTokenEncrypted = safeStorage.encryptString(token).toString("base64");
  writeRaw(raw);
  return token;
}

/** Agent HTTP 桥目标对话：settings 存指定对话 id（空 = 桥模块fallback取最新对话/自动建） */
function getAgentBridgeConversationId() {
  return String(readRaw().agentBridgeConversationId || "").trim();
}

function setAgentBridgeConversationId(id) {
  const raw = readRaw();
  raw.agentBridgeConversationId = String(id || "").trim();
  writeRaw(raw);
}

/** Agent HTTP 桥配置直写（不走 saveSettings——saveSettings 对 ssh 模式强制校验密码，而放行闸开关必须在未配好连接时也能改） */
function setAgentBridgeConfig(input = {}) {
  const raw = readRaw();
  if (input.port !== undefined) raw.agentBridgePort = normalizeAgentBridgePort(input.port);
  if (input.gate !== undefined) raw.agentBridgeGate = Boolean(input.gate);
  writeRaw(raw);
  return { agentBridgePort: normalizeAgentBridgePort(raw.agentBridgePort), agentBridgeGate: Boolean(raw.agentBridgeGate) };
}

function getSettings() {
  const raw = readRaw();
  const defaultDataDirectory = app.getPath("userData");
  // v3.18.0 F4：SSH 字段从当前活跃卡槽物化（顶层 raw 字段保持为活跃槽镜像，供旧读取方兼容）；
  // sshProfiles 只脱敏暴露（hasPassword，不回传密文/明文）。
  const slot = activeSshProfileSlot(raw);
  const profiles = ensureSshProfiles(raw);
  const activeProfile = normalizeSshProfileId(raw.activeSshProfile);
  const advancedState = sanitizeAdvanced(undefined, raw.advanced);
  return {
    connectionMode: raw.connectionMode === "local" ? "local" : raw.connectionMode === "cloud" ? "cloud" : "ssh",
    activeSshProfile: activeProfile,
    sshProfiles: profiles.map((entry) => ({
      id: entry.id,
      name: entry.name,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      workingDirectory: entry.workingDirectory,
      skipPermissions: entry.skipPermissions,
      networkType: entry.networkType,
      externalMethod: entry.externalMethod,
      hostFingerprint: entry.hostFingerprint,
      configured: entry.configured,
      hasPassword: Boolean(entry.password),
      active: entry.id === activeProfile
    })),
    host: slot.host || "",
    port: slot.port || 22,
    username: slot.username || "",
    clientLabel: raw.clientLabel || os.hostname(),
    wakeName: raw.wakeName || "claude",
    // 本机模式引擎（v3.13.0）
    localEngine: normalizeLocalEngine(raw.localEngine),
    atomcodeHost: String(raw.atomcodeHost || "127.0.0.1").trim() || "127.0.0.1",
    atomcodePort: normalizeAtomcodePort(raw.atomcodePort),
    hasAtomcodeToken: Boolean(raw.atomcodeTokenEncrypted),
    customCliCommand: String(raw.customCliCommand || "").trim(),
    workingDirectory: slot.workingDirectory || "",
    skipPermissions: Boolean(slot.skipPermissions),
    statusSignalCapture: raw.statusSignalCapture === undefined ? !app.isPackaged : Boolean(raw.statusSignalCapture),
    userAvatar: normalizeUserAvatar(raw.userAvatar),
    hostFingerprint: slot.hostFingerprint || "",
    dataDirectory: raw.dataDirectory || defaultDataDirectory,
    defaultDataDirectory,
    hasPassword: Boolean(slot.password || raw.password),
    hasModelAdminPassword: modelAdminPasswordState(raw) === "ready",
    modelAdminPasswordState: modelAdminPasswordState(raw),
    // 网络设置（活跃卡槽物化；frp/n2n 等具体参数 v1 仍全局）
    networkType: slot.networkType || "internal",
    externalMethod: slot.externalMethod || "auto",
    frp: sanitizeNetworkConfig(raw.frp || {}, "frp"),
    derp: sanitizeNetworkConfig(raw.derp || {}, "derp"),
    p2p: sanitizeNetworkConfig(raw.p2p || {}, "p2p"),
    n2n: sanitizeNetworkConfig(raw.n2n || {}, "n2n"),
    keepalive: raw.keepalive || {},
    reconnect: raw.reconnect || {},
    hasAccessPassword: Boolean(raw.accessPassword),
    networkLastState: raw.networkLastState || "",
    // 云端 AI 设置
    cloudAiProvider: raw.cloudAiProvider || "zhipu",
    cloudAiApiKey: "",
    cloudAiModel: raw.cloudAiModel || "glm-4-flash",
    cloudAiBaseUrl: raw.cloudAiBaseUrl || "",
    // 云端模式工具执行（v3.14.0 云办公一期）
    cloudToolsEnabled: Boolean(raw.cloudToolsEnabled),
    cloudRunCommandEnabled: Boolean(raw.cloudRunCommandEnabled),
    cloudWorkingDirectory: String(raw.cloudWorkingDirectory || "").trim(),
    // 云办公二期 v3.22.0：NAS Docker 沙箱（容器名固定 sandbox；默认断网、临时联网可切换）
    cloudSandboxEnabled: Boolean(raw.cloudSandboxEnabled),
    cloudSandboxNetworkEnabled: Boolean(raw.cloudSandboxNetworkEnabled),
    // Agent HTTP 桥（阉割版 Bridge Edition 专用；主版字段在场但功能门控关闭；Token 不出此接口）
    agentBridgePort: normalizeAgentBridgePort(raw.agentBridgePort),
    agentBridgeGate: raw.agentBridgeGate === undefined ? true : Boolean(raw.agentBridgeGate),
    // 代理设置
    proxyEnabled: Boolean(raw.proxyEnabled),
    proxyType: raw.proxyType === "socks5" ? "socks5" : "http",
    proxyHost: raw.proxyHost || "",
    proxyPort: raw.proxyPort || 0,
    proxyUsername: raw.proxyUsername || "",
    hasProxyPassword: Boolean(raw.proxyPasswordEncrypted || raw.proxyPassword),
    // 主题
    // 高级设置（v3.19.0 F3）：null 分组=自动识别；adapter=SSH 远程适配器五选一
    advanced: advancedState,
    advancedEffective: advancedEffective(advancedState),
    // 主题
    theme: raw.theme || "dark",
    // 背景设置
    backgroundImage: raw.backgroundImage || "",
    backgroundBlur: clampAppearanceRange(raw.backgroundBlur, 0, 30, 0),
    backgroundOpacity: clampAppearanceRange(raw.backgroundOpacity, 10, 100, 100),
    // 毛玻璃参数（v3.21.4）：此前渲染层提交被落盘白名单静默丢弃（拖杆值重启丢失），补收
    frostedBlur: clampAppearanceRange(raw.frostedBlur, 4, 60, 20),
    frostedOpacity: clampAppearanceRange(raw.frostedOpacity, 20, 100, 85),
    frostedGlass: raw.frostedGlass || false,
    // 思考挡位记忆（v3.24.0）：{ cloud: { "provider/model": 选挡 } }
    thinkingChoices: normalizeThinkingChoices(raw.thinkingChoices),
    // 模式
    workModeId: raw.workModeId || "regular",
    // 恢复通知
    recoveryNotice,
    // 授权
    hasCloudAiConfig: Boolean(raw.cloudAiApiKeyEncrypted || raw.cloudAiApiKey),
    // 品牌验证服务器（留空则禁用品牌验证）
    brandServerUrl: raw.brandServerUrl || "",
    // 上下文压缩（v3.10.0）
    compactThreshold: normalizeCompactThreshold(raw.compactThreshold),
    compactAuto: Boolean(raw.compactAuto),
    compactInstruction: normalizeCompactInstruction(raw.compactInstruction)
  };
}

function getConnection() {
  const settings = getSettings();
  if (settings.connectionMode === "local") return settings;
  return getSshConnection();
}

function decryptStoredString(encoded, label) {
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch (error) {
    throw new Error(`本机保存的${label}已失效，请在"连接设置"中重新输入并保存后重试。`);
  }
}

function getSshConnection() {
  const raw = readRaw();
  const settings = getSettings();
  // v3.18.0 F4：密码取当前活跃卡槽（顶层 raw.password 是活跃槽镜像，做兜底）
  const slot = activeSshProfileSlot(raw);
  const passwordStored = slot.password || raw.password || "";
  if (!passwordStored) throw new Error("请先在连接设置中保存密码。");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows 系统加密不可用，无法安全保存 SSH 密码。");
  }

  return {
    ...settings,
    // 覆盖脱敏后的网络配置为完整配置（包含 token/authKey/key/community）
    frp: raw.frp || settings.frp,
    derp: raw.derp || settings.derp,
    n2n: raw.n2n || settings.n2n,
    password: decryptStoredString(passwordStored, "SSH 密码")
  };
}

function getCloudAiConfig() {
  const raw = readRaw();
  // v3.21.0：defaultModel 全部刷新为 2026-10 各家现役模型（原先的 deepseek-chat / moonshot-v1-8k /
  // doubao-pro-4k / claude-sonnet-4-20250514 等均已退役，新用户切司会 404）
  const providerConfigs = {
    zhipu: { baseURL: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4.7-flash" },
    deepseek: { baseURL: "https://api.deepseek.com/v1", defaultModel: "deepseek-flash" },
    kimi: { baseURL: "https://api.moonshot.cn/v1", defaultModel: "kimi-k2.6" },
    doubao: { baseURL: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: "doubao-seed-evolving" },
    openai: { baseURL: "https://api.openai.com/v1", defaultModel: "gpt-5.4-mini" },
    gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-flash" },
    anthropic: { baseURL: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-5-5" },
    groq: { baseURL: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" },
    siliconflow: { baseURL: "https://api.siliconflow.cn/v1", defaultModel: "Qwen/Qwen3.5-27B" },
    custom: { baseURL: "", defaultModel: "" }
  };
  const provider = raw.cloudAiProvider || "zhipu";
  const config = providerConfigs[provider] || providerConfigs.custom;
  const apiKey = raw.cloudAiApiKeyEncrypted
    ? decryptStoredString(raw.cloudAiApiKeyEncrypted, "云端 AI 密钥")
    : (raw.cloudAiApiKey || "");
  // 代理配置
  const proxyPassword = raw.proxyPasswordEncrypted
    ? decryptStoredString(raw.proxyPasswordEncrypted, "代理密码")
    : "";
  return {
    provider,
    apiKey,
    baseURL: raw.cloudAiBaseUrl || config.baseURL,
    model: raw.cloudAiModel || config.defaultModel,
    // 工具执行（v3.14.0 云办公一期）
    toolsEnabled: Boolean(raw.cloudToolsEnabled),
    runCommandEnabled: Boolean(raw.cloudRunCommandEnabled),
    workingDirectory: String(raw.cloudWorkingDirectory || "").trim(),
    // 云办公二期 v3.22.0：NAS Docker 沙箱执行（文件/命令工具一律经 SSH→容器内执行）
    sandboxEnabled: Boolean(raw.cloudSandboxEnabled),
    sandboxNetworkEnabled: Boolean(raw.cloudSandboxNetworkEnabled),
    maxTokens: raw.cloudAiMaxTokens || 4096,
    // v3.19.0 F3：高级设置（云端超时/重试/轮次）与 SSH 适配器选择随行
    advancedEffective: advancedEffective(sanitizeAdvanced(undefined, raw.advanced)),
    proxy: {
      enabled: Boolean(raw.proxyEnabled),
      type: raw.proxyType === "socks5" ? "socks5" : "http",
      host: raw.proxyHost || "",
      port: raw.proxyPort || 0,
      username: raw.proxyUsername || "",
      password: proxyPassword
    }
  };
}

function saveSettings(input) {
  const previous = readRaw();
  const connectionMode = input.connectionMode === "local" ? "local" : input.connectionMode === "cloud" ? "cloud" : "ssh";
  if (connectionMode === "ssh" && !safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows 系统加密不可用，无法安全保存 SSH 密码。");
  }

  const next = {
    connectionMode,
    host: String(input.host || "").trim(),
    port: Number(input.port) || 22,
    username: String(input.username || "").trim(),
    clientLabel: String(input.clientLabel || os.hostname()).trim(),
    wakeName: String(input.wakeName || "claude").trim(),
    // 本机模式引擎（v3.13.0）
    localEngine: normalizeLocalEngine(input.localEngine !== undefined ? input.localEngine : previous.localEngine),
    atomcodeHost: String(input.atomcodeHost !== undefined ? input.atomcodeHost : (previous.atomcodeHost || "127.0.0.1")).trim() || "127.0.0.1",
    atomcodePort: normalizeAtomcodePort(input.atomcodePort !== undefined ? input.atomcodePort : previous.atomcodePort),
    atomcodeTokenEncrypted: previous.atomcodeTokenEncrypted || "",
    atomcodeToken: "",
    customCliCommand: String(input.customCliCommand !== undefined ? input.customCliCommand : (previous.customCliCommand || "")).trim(),
    // Agent HTTP 桥（阉割版专用；saveSettings 白名单透传保存，避免每次保存设置被抹字段。Token 不走此链——ensureAgentBridgeToken 独立加密落盘）
    agentBridgePort: normalizeAgentBridgePort(input.agentBridgePort !== undefined ? input.agentBridgePort : previous.agentBridgePort),
    agentBridgeGate: input.agentBridgeGate !== undefined
      ? Boolean(input.agentBridgeGate)
      : (previous.agentBridgeGate === undefined ? true : Boolean(previous.agentBridgeGate)),
    agentBridgeTokenEncrypted: previous.agentBridgeTokenEncrypted || "",
    workingDirectory: String(input.workingDirectory || "").trim(),
    skipPermissions: Boolean(input.skipPermissions),
    statusSignalCapture: typeof input.statusSignalCapture === "boolean"
      ? input.statusSignalCapture
      : previous.statusSignalCapture === undefined ? !app.isPackaged : Boolean(previous.statusSignalCapture),
    userAvatar: normalizeUserAvatar(input.userAvatar || previous.userAvatar),
    dataDirectory: String(input.dataDirectory || app.getPath("userData")).trim(),
    hostFingerprint: previous.host === String(input.host || "").trim()
      && Number(previous.port || 22) === (Number(input.port) || 22)
      ? previous.hostFingerprint || ""
      : "",
    password: sameSshTarget(previous, input) ? previous.password : "",
    modelAdminPassword: previous.modelAdminPassword,
    // 网络（合并脱敏后前端传来的配置，敏感字段从 previous 继承）
    networkType: input.networkType || previous.networkType || "internal",
    externalMethod: input.externalMethod || previous.externalMethod || "auto",
    frp: mergeNetworkConfig(input.frp, previous.frp, "frp"),
    derp: mergeNetworkConfig(input.derp, previous.derp, "derp"),
    p2p: mergeNetworkConfig(input.p2p, previous.p2p, "p2p"),
    n2n: mergeNetworkConfig(input.n2n, previous.n2n, "n2n"),
    keepalive: input.keepalive || previous.keepalive || {},
    reconnect: input.reconnect || previous.reconnect || {},
    // accessPassword: 从 input 取（用户可能修改），留空则保留 previous
    accessPassword: String(input.accessPassword || "").length > 0 ? input.accessPassword : (previous.accessPassword || ""),
    networkLastState: input.networkLastState !== undefined ? input.networkLastState : previous.networkLastState || "",
    // 云端 AI
    cloudAiProvider: input.cloudAiProvider || previous.cloudAiProvider || "zhipu",
    cloudAiModel: input.cloudAiModel || previous.cloudAiModel || "glm-4-flash",
    cloudAiBaseUrl: input.cloudAiBaseUrl || previous.cloudAiBaseUrl || "",
    // 云端模式工具执行（v3.14.0 云办公一期）
    cloudToolsEnabled: Boolean(input.cloudToolsEnabled),
    cloudRunCommandEnabled: Boolean(input.cloudRunCommandEnabled),
    cloudWorkingDirectory: String(input.cloudWorkingDirectory || "").trim(),
    // 云办公二期 v3.22.0：NAS Docker 沙箱（容器名固定 sandbox）
    cloudSandboxEnabled: Boolean(input.cloudSandboxEnabled),
    cloudSandboxNetworkEnabled: Boolean(input.cloudSandboxNetworkEnabled),
    cloudAiMaxTokens: input.cloudAiMaxTokens || previous.cloudAiMaxTokens || 4096,
    cloudAiApiKeyEncrypted: previous.cloudAiApiKeyEncrypted || "",
    cloudAiApiKey: "",
    // 代理设置
    proxyEnabled: Boolean(input.proxyEnabled),
    proxyType: input.proxyType === "socks5" ? "socks5" : "http",
    proxyHost: String(input.proxyHost || "").trim(),
    proxyPort: Number(input.proxyPort) || 0,
    proxyUsername: String(input.proxyUsername || "").trim(),
    proxyPasswordEncrypted: previous.proxyPasswordEncrypted || "",
    proxyPassword: "",
    // 高级设置（v3.19.0 F3）：input 带时整体接管，无则继承 previous（sanitize 幂等）
    advanced: sanitizeAdvanced(input.advanced !== undefined ? input.advanced : previous.advanced),
    // 主题
    theme: input.theme || previous.theme || "dark",
    // 背景
    backgroundImage: input.backgroundImage !== undefined ? input.backgroundImage : previous.backgroundImage || "",
    backgroundBlur: input.backgroundBlur !== undefined ? clampAppearanceRange(input.backgroundBlur, 0, 30, 0) : clampAppearanceRange(previous.backgroundBlur, 0, 30, 0),
    backgroundOpacity: input.backgroundOpacity !== undefined ? clampAppearanceRange(input.backgroundOpacity, 10, 100, 100) : clampAppearanceRange(previous.backgroundOpacity, 10, 100, 100),
    // 毛玻璃参数（v3.21.4）：渲染层滑杆提交落盘白名单（修复拖杆值重启丢失）
    frostedBlur: input.frostedBlur !== undefined ? clampAppearanceRange(input.frostedBlur, 4, 60, 20) : clampAppearanceRange(previous.frostedBlur, 4, 60, 20),
    frostedOpacity: input.frostedOpacity !== undefined ? clampAppearanceRange(input.frostedOpacity, 20, 100, 85) : clampAppearanceRange(previous.frostedOpacity, 20, 100, 85),
    frostedGlass: input.frostedGlass || previous.frostedGlass || false,
    // 思考挡位记忆（v3.24.0）：input 带时整体接管 + 归一；不带继承
    thinkingChoices: normalizeThinkingChoices(input.thinkingChoices !== undefined ? input.thinkingChoices : previous.thinkingChoices),
    // 模式
    workModeId: input.workModeId || previous.workModeId || "regular",
    // 信号灯带
    showSignalLights: input.showSignalLights !== undefined ? Boolean(input.showSignalLights) : previous.showSignalLights !== false,
    // 品牌验证服务器（留空则禁用）
    brandServerUrl: input.brandServerUrl !== undefined ? input.brandServerUrl : previous.brandServerUrl || "",
    // 上下文压缩（v3.10.0）
    compactThreshold: normalizeCompactThreshold(input.compactThreshold !== undefined ? input.compactThreshold : previous.compactThreshold),
    compactAuto: input.compactAuto !== undefined ? Boolean(input.compactAuto) : Boolean(previous.compactAuto),
    compactInstruction: normalizeCompactInstruction(input.compactInstruction !== undefined ? input.compactInstruction : previous.compactInstruction)
  };

  if (input.clearPassword) next.password = "";
  if (typeof input.password === "string" && input.password.length > 0) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法安全保存 SSH 密码。");
    next.password = safeStorage.encryptString(input.password).toString("base64");
  }
  // 云端 AI 密钥加密存储
  if (typeof input.cloudAiApiKey === "string" && input.cloudAiApiKey.length > 0) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法安全保存云端 AI 密钥。");
    next.cloudAiApiKeyEncrypted = safeStorage.encryptString(input.cloudAiApiKey).toString("base64");
    next.cloudAiApiKey = "";
  }
  // 代理密码加密存储
  if (input.clearProxyPassword) {
    next.proxyPasswordEncrypted = "";
  } else if (typeof input.proxyPassword === "string" && input.proxyPassword.length > 0) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法安全保存代理密码。");
    next.proxyPasswordEncrypted = safeStorage.encryptString(input.proxyPassword).toString("base64");
    next.proxyPassword = "";
  }
  // AtomCode daemon token 加密存储（v3.13.0）
  if (input.clearAtomcodeToken) {
    next.atomcodeTokenEncrypted = "";
  } else if (typeof input.atomcodeToken === "string" && input.atomcodeToken.trim().length > 0) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法安全保存 AtomCode token。");
    next.atomcodeTokenEncrypted = safeStorage.encryptString(input.atomcodeToken.trim()).toString("base64");
  }
  // 非 Claude 引擎不依赖 Claude 唤醒命令（v3.13.0）
  if (!(connectionMode === "local" && next.localEngine !== "claude") && !next.wakeName) {
    throw new Error("Claude 唤醒命令不能为空。");
  }
  if (connectionMode === "local" && next.localEngine === "custom" && !next.customCliCommand) {
    throw new Error("自定义命令模板不能为空，例如：aider --message {message}。");
  }
  if (!next.clientLabel || next.clientLabel.length > 32 || !/^[\p{L}\p{N}._-]+$/u.test(next.clientLabel)) {
    throw new Error("本机标识需为 1–32 个字符，只能使用文字、数字、点、短横线或下划线。");
  }
  if (connectionMode === "ssh" && (!next.host || !next.username)) throw new Error("NAS 地址和 SSH 账号不能为空。");
  if (connectionMode === "ssh" && !next.password) {
    throw new Error(sameSshTarget(previous, next)
      ? "请先输入并保存 SSH 密码。"
      : "SSH 地址、端口或账号已改变，请输入新目标的 SSH 密码。旧密码不会自动用于新目标。");
  }

  // v3.18.0 F4：本次保存的连接参数镜像进活跃卡槽（ssh 模式）；local/cloud 模式卡槽结构原样保留仅归一化
  if (connectionMode === "ssh") {
    const profiles = ensureSshProfiles({ ...next, sshProfiles: Array.isArray(previous.sshProfiles) ? previous.sshProfiles : undefined });
    const activeId = normalizeSshProfileId(input.activeSshProfile !== undefined ? input.activeSshProfile : previous.activeSshProfile);
    const index = SSH_PROFILE_IDS.indexOf(activeId);
    const base = profiles[index] || {};
    profiles[index] = {
      id: activeId,
      name: input.sshProfileName !== undefined ? normalizeSshProfileName(input.sshProfileName) : (base.name || ""),
      host: next.host, port: next.port, username: next.username, password: next.password,
      workingDirectory: next.workingDirectory, skipPermissions: Boolean(next.skipPermissions),
      networkType: next.networkType || "internal", externalMethod: next.externalMethod || "auto",
      hostFingerprint: next.hostFingerprint || "",
      configured: Boolean(next.host && next.username)
    };
    next.sshProfiles = profiles;
    next.activeSshProfile = activeId;
  } else {
    // 非 ssh 模式的 host/username 输入为空且不可信——卡槽结构一律从 previous 归一化，防止空值覆盖卡槽
    next.sshProfiles = ensureSshProfiles(previous);
    next.activeSshProfile = normalizeSshProfileId(previous.activeSshProfile);
  }

  writeRaw(next);
  recoveryNotice = "";
  return getSettings();
}

function trustHostFingerprint(fingerprint) {
  const raw = readRaw();
  raw.hostFingerprint = fingerprint;
  // v3.18.0 F4：指纹属于「凭什么进门」的身份链——同步记进活跃卡槽，切槽不丢
  raw.sshProfiles = ensureSshProfiles(raw);
  raw.activeSshProfile = normalizeSshProfileId(raw.activeSshProfile);
  const index = SSH_PROFILE_IDS.indexOf(raw.activeSshProfile);
  raw.sshProfiles[index] = { ...raw.sshProfiles[index], hostFingerprint: fingerprint };
  writeRaw(raw);
}

/** v3.18.0 F4：切换 SSH 卡槽——把目标槽整套参数物化到顶层（活跃槽镜像），密码/指纹随槽走。 */
function switchSshProfile(profileId) {
  const raw = readRaw();
  const profiles = ensureSshProfiles(raw);
  // v3.18.0 F4 防御：未知槽 id 明确拒绝而不是静默回退槽 1（用户点了不存在的槽必须知道没切成功）
  if (!SSH_PROFILE_IDS.includes(String(profileId || ""))) throw new Error("未知的 SSH 卡槽，无法切换。");
  const activeId = normalizeSshProfileId(profileId);
  const slot = profiles.find((entry) => entry.id === activeId) || profiles[0];
  const next = {
    ...raw,
    sshProfiles: profiles,
    activeSshProfile: activeId,
    host: slot.host,
    port: slot.port,
    username: slot.username,
    password: slot.password,
    workingDirectory: slot.workingDirectory,
    skipPermissions: slot.skipPermissions,
    networkType: slot.networkType,
    externalMethod: slot.externalMethod,
    hostFingerprint: slot.hostFingerprint
  };
  writeRaw(next);
  return getSettings();
}

function setModelAdminPassword(value) {
  const password = String(value || "");
  if (password.length < 6 || password.length > 200 || /[\0\r\n]/.test(password)) {
    throw new Error("模型管理员密码需为 6–200 个字符，且不能包含换行。");
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法安全保存模型管理员密码。");
  const raw = readRaw();
  raw.modelAdminPassword = safeStorage.encryptString(password).toString("base64");
  writeRaw(raw);
}

function verifyModelAdminPassword(value) {
  const raw = readRaw();
  if (!raw.modelAdminPassword) throw new Error("尚未设置模型管理员密码，请由管理员初始化后再操作。");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法校验模型管理员密码。");
  const expected = Buffer.from(decryptStoredString(raw.modelAdminPassword, "模型管理员密码"), "utf8");
  const actual = Buffer.from(String(value || ""), "utf8");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { getConnection, getSettings, getAtomcodeToken, getSshConnection, getCloudAiConfig, modelAdminPasswordState, normalizeSshProfileId, normalizeSshProfileName, sameSshTarget, saveSettings, setModelAdminPassword, switchSshProfile, trustHostFingerprint, verifyModelAdminPassword, ensureAgentBridgeToken, getAgentBridgeConversationId, setAgentBridgeConversationId, setAgentBridgeConfig, normalizeAgentBridgePort };