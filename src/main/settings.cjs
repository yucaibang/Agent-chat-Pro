"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, safeStorage } = require("electron");

const SETTINGS_FILE = "connection.json";

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
    hasPassword: Boolean(raw.password)
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
    password: previous.password
  };

  if (input.clearPassword) next.password = "";
  if (typeof input.password === "string" && input.password.length > 0) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 系统加密不可用，无法安全保存 SSH 密码。");
    next.password = safeStorage.encryptString(input.password).toString("base64");
  }
  if (!next.wakeName) throw new Error("Claude 唤醒命令不能为空。");
  if (!next.clientLabel || next.clientLabel.length > 32 || !/^[\p{L}\p{N}._-]+$/u.test(next.clientLabel)) {
    throw new Error("本机标识需为 1–32 个字符，只能使用文字、数字、点、短横线或下划线。");
  }
  if (connectionMode === "ssh" && (!next.host || !next.username)) throw new Error("NAS 地址和 SSH 账号不能为空。");

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

module.exports = { getConnection, getSettings, getSshConnection, saveSettings, trustHostFingerprint };
