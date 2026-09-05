"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { app, safeStorage } = require("electron");

const SETTINGS_FILE = "connection.json";
const USER_AVATARS = new Set(["user-male-1", "user-female-1", "user-male-2", "user-female-2"]);
let recoveryNotice = "";

function normalizeUserAvatar(value) {
  const avatar = String(value || "");
  return USER_AVATARS.has(avatar) ? avatar : "user-male-1";
}

function settingsPath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
}

function legacySettingsPath() {
  return path.join(path.dirname(app.getPath("userData")), "claude-nas-chat", SETTINGS_FILE);
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
    return current;
  } catch (error) {
    if (error.code === "ENOENT") {
      try { return JSON.parse(fs.readFileSync(legacySettingsPath(), "utf8")); }
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
  try {
    fs.writeFileSync(temporary, JSON.stringify(raw, null, 2), { mode: 0o600, flag: "wx" });
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

function getSettings() {
  const raw = readRaw();
  const defaultDataDirectory = app.getPath("userData");
  return {
    connectionMode: raw.connectionMode === "local" ? "local" : raw.connectionMode === "cloud" ? "cloud" : "ssh",
    host: raw.host || "",
    port: raw.port || 22,
    username: raw.username || "",
    clientLabel: raw.clientLabel || os.hostname(),
    wakeName: raw.wakeName || "claude",
    workingDirectory: raw.workingDirectory || "",
    skipPermissions: Boolean(raw.skipPermissions),
    statusSignalCapture: raw.statusSignalCapture === undefined ? !app.isPackaged : Boolean(raw.statusSignalCapture),
    userAvatar: normalizeUserAvatar(raw.userAvatar),
    hostFingerprint: raw.hostFingerprint || "",
    dataDirectory: raw.dataDirectory || defaultDataDirectory,
    defaultDataDirectory,
    hasPassword: Boolean(raw.password),
    hasModelAdminPassword: modelAdminPasswordState(raw) === "ready",
    modelAdminPasswordState: modelAdminPasswordState(raw),
    // 网络设置
    networkType: raw.networkType || "internal",
    externalMethod: raw.externalMethod || "auto",
    frp: raw.frp || {},
    derp: raw.derp || {},
    p2p: raw.p2p || {},
    n2n: raw.n2n || {},
    keepalive: raw.keepalive || {},
    reconnect: raw.reconnect || {},
    accessPassword: raw.accessPassword || "",
    networkLastState: raw.networkLastState || "",
    // 云端 AI 设置
    cloudAiProvider: raw.cloudAiProvider || "zhipu",
    cloudAiApiKey: "",
    cloudAiModel: raw.cloudAiModel || "glm-4-flash",
    cloudAiBaseUrl: raw.cloudAiBaseUrl || "",
    // 代理设置
    proxyEnabled: Boolean(raw.proxyEnabled),
    proxyType: raw.proxyType === "socks5" ? "socks5" : "http",
    proxyHost: raw.proxyHost || "",
    proxyPort: raw.proxyPort || 0,
    proxyUsername: raw.proxyUsername || "",
    hasProxyPassword: Boolean(raw.proxyPasswordEncrypted || raw.proxyPassword),
    // 主题
    // 主题
    theme: raw.theme || "dark",
    // 背景设置
    backgroundImage: raw.backgroundImage || "",
    backgroundBlur: raw.backgroundBlur || 0,
    backgroundOpacity: raw.backgroundOpacity || 0.15,
    frostedGlass: raw.frostedGlass || false,
    // 模式
    workModeId: raw.workModeId || "regular",
    // 恢复通知
    recoveryNotice,
    // 授权
    hasCloudAiConfig: Boolean(raw.cloudAiApiKeyEncrypted || raw.cloudAiApiKey),
    // 品牌验证服务器（留空则禁用品牌验证）
    brandServerUrl: raw.brandServerUrl || ""
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
  if (!raw.password) throw new Error("请先在连接设置中保存密码。");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows 系统加密不可用，无法安全保存 SSH 密码。");
  }

  return {
    ...settings,
    password: decryptStoredString(raw.password, "SSH 密码")
  };
}

function getCloudAiConfig() {
  const raw = readRaw();
  const providerConfigs = {
    zhipu: { baseURL: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-flash" },
    deepseek: { baseURL: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat" },
    kimi: { baseURL: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-8k" },
    doubao: { baseURL: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: "doubao-pro-4k" },
    openai: { baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
    gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.0-flash" },
    anthropic: { baseURL: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-20250514" },
    groq: { baseURL: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile" },
    siliconflow: { baseURL: "https://api.siliconflow.cn/v1", defaultModel: "deepseek-ai/DeepSeek-V3" },
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
    maxTokens: raw.cloudAiMaxTokens || 4096,
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
    // 网络
    networkType: input.networkType || previous.networkType || "internal",
    externalMethod: input.externalMethod || previous.externalMethod || "auto",
    frp: input.frp || previous.frp || {},
    derp: input.derp || previous.derp || {},
    p2p: input.p2p || previous.p2p || {},
    n2n: input.n2n || previous.n2n || {},
    keepalive: input.keepalive || previous.keepalive || {},
    reconnect: input.reconnect || previous.reconnect || {},
    accessPassword: input.accessPassword || previous.accessPassword || "",
    networkLastState: input.networkLastState !== undefined ? input.networkLastState : previous.networkLastState || "",
    // 云端 AI
    cloudAiProvider: input.cloudAiProvider || previous.cloudAiProvider || "zhipu",
    cloudAiModel: input.cloudAiModel || previous.cloudAiModel || "glm-4-flash",
    cloudAiBaseUrl: input.cloudAiBaseUrl || previous.cloudAiBaseUrl || "",
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
    // 主题
    theme: input.theme || previous.theme || "dark",
    // 背景
    backgroundImage: input.backgroundImage !== undefined ? input.backgroundImage : previous.backgroundImage || "",
    backgroundBlur: input.backgroundBlur !== undefined ? input.backgroundBlur : previous.backgroundBlur || 0,
    backgroundOpacity: input.backgroundOpacity !== undefined ? input.backgroundOpacity : previous.backgroundOpacity || 0.15,
    frostedGlass: input.frostedGlass || previous.frostedGlass || false,
    // 模式
    workModeId: input.workModeId || previous.workModeId || "regular",
    // 品牌验证服务器（留空则禁用）
    brandServerUrl: input.brandServerUrl !== undefined ? input.brandServerUrl : previous.brandServerUrl || ""
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
  if (!next.wakeName) throw new Error("Claude 唤醒命令不能为空。");
  if (!next.clientLabel || next.clientLabel.length > 32 || !/^[\p{L}\p{N}._-]+$/u.test(next.clientLabel)) {
    throw new Error("本机标识需为 1–32 个字符，只能使用文字、数字、点、短横线或下划线。");
  }
  if (connectionMode === "ssh" && (!next.host || !next.username)) throw new Error("NAS 地址和 SSH 账号不能为空。");
  if (connectionMode === "ssh" && !next.password) {
    throw new Error(sameSshTarget(previous, next)
      ? "请先输入并保存 SSH 密码。"
      : "SSH 地址、端口或账号已改变，请输入新目标的 SSH 密码。旧密码不会自动用于新目标。");
  }

  writeRaw(next);
  recoveryNotice = "";
  return getSettings();
}

function trustHostFingerprint(fingerprint) {
  const raw = readRaw();
  raw.hostFingerprint = fingerprint;
  writeRaw(raw);
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

module.exports = { getConnection, getSettings, getSshConnection, getCloudAiConfig, modelAdminPasswordState, sameSshTarget, saveSettings, setModelAdminPassword, trustHostFingerprint, verifyModelAdminPassword };