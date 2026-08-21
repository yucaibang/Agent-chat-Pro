"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, safeStorage } = require("electron");

const SETTINGS_FILE = "connection.json";

/** @type {string[]} 允许的 externalMethod 枚举值 */
const EXTERNAL_METHODS = ["auto", "derp", "frp", "p2p", "n2n"];

function settingsPath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE);
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("无法读取本地连接设置：" + error.message);
  }
}

function getSettings() {
  const raw = readRaw();
  const defaultDataDirectory = app.getPath("userData");
  return {
    connectionMode: raw.connectionMode === "local" ? "local" : "ssh",
    host: raw.host || "",
    port: raw.port || 22,
    username: raw.username || "",
    clientLabel: raw.clientLabel || os.hostname(),
    wakeName: raw.wakeName || "claude",
    workingDirectory: raw.workingDirectory || "",
    skipPermissions: Boolean(raw.skipPermissions),
    hostFingerprint: raw.hostFingerprint || "",
    dataDirectory: raw.dataDirectory || defaultDataDirectory,
    defaultDataDirectory,
    hasPassword: Boolean(raw.password),
    // 工作模式
    workModeId: raw.workModeId || "regular",
    // 网络配置
    networkType: raw.networkType === "external" ? "external" : "internal",
    externalMethod: EXTERNAL_METHODS.includes(raw.externalMethod) ? raw.externalMethod : "auto",
    // FRP 配置
    frp: {
      serverAddr: String(raw.frp?.serverAddr || "").trim(),
      serverPort: Number(raw.frp?.serverPort) || 7000,
      token: String(raw.frp?.token || "").trim(),
      localPort: Number(raw.frp?.localPort) || 22,
      remotePort: Number(raw.frp?.remotePort) || 6000,
      ...(raw.frp || {})
    },
    // DERP 配置
    derp: {
      relayAddr: String(raw.derp?.relayAddr || "").trim(),
      relayPort: Number(raw.derp?.relayPort) || 3478,
      authKey: String(raw.derp?.authKey || "").trim(),
      ...(raw.derp || {})
    },
    // P2P 配置
    p2p: {
      stunAddr: String(raw.p2p?.stunAddr || "stun.l.google.com").trim(),
      stunPort: Number(raw.p2p?.stunPort) || 19302,
      localPort: Number(raw.p2p?.localPort) || 0,
      remotePort: Number(raw.p2p?.remotePort) || 0,
      ...(raw.p2p || {})
    },
    // N2N 配置
    n2n: {
      supernodeAddr: String(raw.n2n?.supernodeAddr || "").trim(),
      supernodePort: Number(raw.n2n?.supernodePort) || 7777,
      community: String(raw.n2n?.community || "").trim(),
      key: String(raw.n2n?.key || "").trim(),
      ...(raw.n2n || {})
    },
    // 心跳保活
    keepalive: {
      interval: Number(raw.keepalive?.interval) || 30,
      count: Number(raw.keepalive?.count) || 3,
      ...(raw.keepalive || {})
    },
    // 重连策略
    reconnect: {
      maxRetries: Number(raw.reconnect?.maxRetries) || 3,
      baseDelay: Number(raw.reconnect?.baseDelay) || 1000,
      maxDelay: Number(raw.reconnect?.maxDelay) || 30000,
      ...(raw.reconnect || {})
    },
    // 外网访问密码
    accessPassword: raw.accessPassword || "",
    // 网络连接状态持久化
    networkLastState: raw.networkLastState || "offline",
    // 主题偏好
    theme: raw.theme === "light" ? "light" : "dark",
    // 云端 AI 配置
    cloudAi: {
      baseURL: String(raw.cloudAi?.baseURL || "https://open.bigmodel.cn/api/paas/v4/").trim(),
      model: String(raw.cloudAi?.model || "glm-4-flash").trim(),
      maxTokens: Number(raw.cloudAi?.maxTokens) || 4096,
      hasApiKey: false,
      ...(raw.cloudAi ? { baseURL: String(raw.cloudAi.baseURL || "").trim() || "https://open.bigmodel.cn/api/paas/v4/", model: String(raw.cloudAi.model || "glm-4-flash").trim(), maxTokens: Number(raw.cloudAi.maxTokens) || 4096 } : {})
    }
  };
}

function getConnection() {
  const settings = getSettings();
  if (settings.connectionMode === "local") return settings;
  return getSshConnection();
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
    password: safeStorage.decryptString(Buffer.from(raw.password, "base64"))
  };
}

function saveSettings(input) {
  const previous = readRaw();
  const connectionMode = input.connectionMode === "local" ? "local" : "ssh";
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
    dataDirectory: String(input.dataDirectory || app.getPath("userData")).trim(),
    hostFingerprint: previous.host === String(input.host || "").trim()
      && Number(previous.port || 22) === (Number(input.port) || 22)
      ? previous.hostFingerprint || ""
      : "",
    password: previous.password,
    // 工作模式
    workModeId: String(input.workModeId || "regular").trim(),
    // 网络配置
    networkType: input.networkType === "external" ? "external" : "internal",
    externalMethod: EXTERNAL_METHODS.includes(input.externalMethod) ? input.externalMethod : "auto",
    // 穿透方案配置
    frp: { ...previous.frp, ...(input.frp || {}) },
    derp: { ...previous.derp, ...(input.derp || {}) },
    p2p: { ...previous.p2p, ...(input.p2p || {}) },
    n2n: { ...previous.n2n, ...(input.n2n || {}) },
    // 心跳与重连
    keepalive: { ...previous.keepalive, ...(input.keepalive || {}) },
    reconnect: { ...previous.reconnect, ...(input.reconnect || {}) },
    // 外网访问密码
    accessPassword: String(input.accessPassword || ""),
    // 网络连接状态持久化
    networkLastState: String(input.networkLastState || "offline"),
    // 主题偏好
    theme: input.theme === "light" ? "light" : "dark",
    // 云端 AI 配置
    cloudAi: { ...previous.cloudAi, ...(input.cloudAi || {}) }
  };

  // 云端 AI 密钥加密保存
  if (input.cloudAi && typeof input.cloudAi.apiKey === "string" && input.cloudAi.apiKey.length > 0) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法安全保存云端 AI 密钥。");
    next.cloudAi._encryptedApiKey = safeStorage.encryptString(input.cloudAi.apiKey).toString("base64");
    next.cloudAi.hasApiKey = true;
    delete next.cloudAi.apiKey;
  } else if (input.cloudAi && input.cloudAi.clearApiKey) {
    next.cloudAi._encryptedApiKey = "";
    next.cloudAi.hasApiKey = false;
  } else {
    next.cloudAi._encryptedApiKey = previous.cloudAi?._encryptedApiKey || "";
    next.cloudAi.hasApiKey = previous.cloudAi?.hasApiKey || false;
  }
  };

  if (input.clearPassword) next.password = "";
  if (typeof input.password === "string" && input.password.length > 0) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法安全保存 SSH 密码。");
    next.password = safeStorage.encryptString(input.password).toString("base64");
  }
  if (!next.wakeName) throw new Error("Agent 唤醒命令不能为空。");
  if (!next.clientLabel || next.clientLabel.length > 32 || !/^[\p{L}\p{N}._-]+$/u.test(next.clientLabel)) {
    throw new Error("本机标识需为 1–32 个字符，只能使用文字、数字、点、短横线或下划线。");
  }
  if (connectionMode === "ssh" && (!next.host || !next.username)) throw new Error("NAS 地址和 SSH 账号不能为空。");

  // 云端 AI 模式校验
  if (connectionMode === "cloud") {
    if (!next.cloudAi.apiKey) throw new Error("云端 AI 模式必须填写 API 密钥。");
    if (!next.cloudAi.baseURL) throw new Error("云端 AI 模式必须填写 API 地址。");
  }

  // 外网模式校验
  if (next.networkType === "external") {
    if (!next.accessPassword) throw new Error("外网模式必须设置访问密码。");
    const method = next.externalMethod;
    if (method === "frp" && !next.frp.serverAddr) throw new Error("FRP 模式必须填写 FRP 服务器地址。");
    if (method === "derp" && !next.derp.relayAddr) throw new Error("DERP 模式必须填写中继服务器地址。");
    if (method === "p2p" && !next.p2p.stunAddr) throw new Error("P2P 模式必须填写 STUN 服务器地址。");
    if (method === "n2n" && !next.n2n.supernodeAddr) throw new Error("N2N 模式必须填写超级节点地址。");
  }

  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  const temporary = settingsPath() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, settingsPath());
  return getSettings();
}

function trustHostFingerprint(fingerprint) {
  const raw = readRaw();
  raw.hostFingerprint = fingerprint;
  fs.writeFileSync(settingsPath(), JSON.stringify(raw, null, 2), { mode: 0o600 });
}

function getCloudAiConfig() {
  const settings = getSettings();
  const config = { ...settings.cloudAi };
  if (config._encryptedApiKey) {
    try { config.apiKey = safeStorage.decryptString(Buffer.from(config._encryptedApiKey, "base64")); } catch { config.apiKey = ""; }
  }
  return config;
}

module.exports = { getConnection, getSettings, getSshConnection, getCloudAiConfig, saveSettings, trustHostFingerprint, EXTERNAL_METHODS };