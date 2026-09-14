"use strict";

/**
 * 凭证保险箱 — 封装 Electron safeStorage API，提供加密存储。
 *
 * 使用 Electron 的 safeStorage（底层调用系统密钥链）：
 *   Windows: DPAPI
 *   macOS: Keychain
 *   Linux: Secret Service (libsecret)
 *
 * 解密失败时有明确的中文提示。
 */

let safeStorage = null;

function initialize(vault) {
  safeStorage = vault;
}

function isAvailable() {
  if (!safeStorage) return false;
  try {
    return typeof safeStorage.isAvailable === "function" ? safeStorage.isAvailable() : false;
  } catch {
    return false;
  }
}

function encrypt(value, unavailableMessage = "本机加密不可用，请检查系统密钥服务。") {
  if (!isAvailable()) throw new Error(unavailableMessage);
  const buffer = safeStorage.encryptString(String(value));
  return buffer.toString("base64");
}

function decrypt(encoded, label = "密码") {
  if (!isAvailable()) throw new Error(`本机加密不可用，无法解密${label}。请在连接设置中重新输入并保存后重试。`);
  try {
    const buffer = Buffer.from(encoded, "base64");
    return safeStorage.decryptString(buffer);
  } catch {
    throw new Error(`本机保存的${label}已失效，请在连接设置中重新输入并保存后重试。`);
  }
}

function canDecrypt(encoded) {
  if (!isAvailable() || !encoded) return false;
  try {
    const buffer = Buffer.from(encoded, "base64");
    safeStorage.decryptString(buffer);
    return true;
  } catch {
    return false;
  }
}

module.exports = { initialize, isAvailable, encrypt, decrypt, canDecrypt };