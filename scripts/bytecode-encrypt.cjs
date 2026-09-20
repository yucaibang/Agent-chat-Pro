"use strict";

/**
 * Agent Chat Pro 字节码加密器（v3.12.0）— .jsc fallback 方案的构建端
 *
 * 目标：V8 字节码跨 OS 不兼容（v3.11.0 实测 cachedDataRejected 即崩），
 *       loader 桥 try .jsc → catch 后解密 AES 加密混淆源码执行。
 *       asar 内因此只剩 .jsc（跨平台时是烟雾弹/同平台时是主路径）+ .enc（加密体）+ loader 桥，
 *       明文 JS（连混淆版）从 asar 消失。
 *
 * 用法（build-pipeline.cjs 内部调用，也可独立验证）：
 *   node scripts/bytecode-encrypt.cjs selftest   # 加密/解密自检
 *
 * .enc 文件布局（AES-256-GCM）：
 *   [0..12)   IV（12 字节，随机）
 *   [12..28)  authTag（16 字节，GCM 完整性校验——篡改即解密失败）
 *   [28..]    ciphertext（混淆后 JS 源码的 UTF-8 字节）
 *
 * 密钥策略：每次构建 crypto.randomBytes(32) 随机生成，拆 4 段 hex 注入
 *   src/main/bytecode-fallback.cjs 的 __K 占位数组（注入发生在 step1 混淆之前，
 *   混淆器会把段值编码进 stringArray——运行时透明还原，防明文检索）。
 *   不同构建产物密钥互不相同，单包泄露不通吃。
 */

const fs = require("fs");
const crypto = require("crypto");

const KEY_BYTES = 32; // AES-256
const KEY_HEX_CHARS = KEY_BYTES * 2; // 64 hex chars
const KEY_SEGMENTS = 4; // 拆 4 段，每段 16 hex chars
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** 生成随机构建密钥并拆 4 段（["...", "...", "...", "..."]） */
function generateKeyMaterial() {
  const hex = crypto.randomBytes(KEY_BYTES).toString("hex");
  if (hex.length !== KEY_HEX_CHARS) throw new Error(`密钥 hex 长度异常: ${hex.length}（期望 ${KEY_HEX_CHARS}）`);
  const segLen = KEY_HEX_CHARS / KEY_SEGMENTS;
  const segments = [];
  for (let i = 0; i < KEY_SEGMENTS; i++) {
    const seg = hex.slice(i * segLen, (i + 1) * segLen);
    if (!/^[0-9a-f]+$/.test(seg)) throw new Error("密钥段含非 hex 字符");
    segments.push(seg);
  }
  return segments;
}

/** 密钥段拼接还原为 Buffer（与 bytecode-fallback.cjs 运行时同一逻辑） */
function deriveKeyBuffer(segments) {
  if (!Array.isArray(segments) || segments.length !== KEY_SEGMENTS) {
    throw new Error(`密钥段数量异常: 期望 ${KEY_SEGMENTS} 段`);
  }
  const joined = segments.join("");
  if (joined.length !== KEY_HEX_CHARS || !/^[0-9a-f]+$/.test(joined)) {
    throw new Error("拼接后密钥不是 64 位 hex");
  }
  return Buffer.from(joined, "hex");
}

/** AES-256-GCM 加密 → [12B IV][16B tag][cipher] 单 Buffer */
function encryptToBuffer(plaintextBuf, keyBuf) {
  if (!(keyBuf instanceof Buffer) || keyBuf.length !== KEY_BYTES) {
    throw new Error(`密钥 Buffer 异常: ${keyBuf && keyBuf.length} 字节（期望 ${KEY_BYTES}）`);
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBuf, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/** 读源文件 → 加密 → 写 .enc（布局同上） */
function writeEnc(srcPath, encPath, keyBuf) {
  const plaintext = fs.readFileSync(srcPath);
  const encBuf = encryptToBuffer(plaintext, keyBuf);
  fs.writeFileSync(encPath, encBuf);
  return encBuf.length;
}

/** 注入密钥段到 bytecode-fallback.cjs 的 __K 占位数组（必须在混淆前执行） */
function injectKey(fallbackPath, segments) {
  const placeholder = readPlaceholder(fallbackPath);
  let src = fs.readFileSync(fallbackPath, "utf8");
  const injection = `const __K = [${segments.map((s) => JSON.stringify(s)).join(", ")}];`;
  const replaced = src.replace(placeholder.pattern, injection);
  if (replaced === src) throw new Error("__K 占位数组注入失败（正则未命中）");
  fs.writeFileSync(fallbackPath, replaced, "utf8");
  return true;
}

/** 读取源码中的 __K 占位数组，返回其正则（供注入与占位校验） */
function readPlaceholder(fallbackPath) {
  const src = fs.readFileSync(fallbackPath, "utf8");
  const match = src.match(/const\s+__K\s*=\s*\[([^\]]*)\]/);
  if (!match) throw new Error("bytecode-fallback.cjs 缺少 __K 占位数组");
  return { pattern: /const\s+__K\s*=\s*\[[^\]]*\]/, raw: match[1] };
}

/** 校验 fallback 源码的 __K 是否仍是占位（未注入过）——防重复注入/脏构建 */
function isPlaceholderUntouched(fallbackPath) {
  const { raw } = readPlaceholder(fallbackPath);
  // 占位段特征：不含真实随机 hex 密钥的多样性——统一为 'f' 填充段
  const segs = raw.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
  return segs.length === KEY_SEGMENTS && segs.every((s) => /^f+$/.test(s));
}

module.exports = {
  KEY_BYTES,
  KEY_HEX_CHARS,
  KEY_SEGMENTS,
  IV_LENGTH,
  TAG_LENGTH: 16,
  generateKeyMaterial,
  deriveKeyBuffer,
  encryptToBuffer,
  writeEnc,
  injectKey,
  readPlaceholder,
  isPlaceholderUntouched,
};

// ── 自检 ─────────────────────────────────────────────
if (require.main === module) {
  const assert = require("assert");
  const segs = generateKeyMaterial();
  const key = deriveKeyBuffer(segs);
  assert.strictEqual(key.length, 32, "密钥还原 32 字节");
  const plaintext = Buffer.from(`selftest-${Date.now()}\nfunction hello(){return 1;}\n`, "utf8");
  const enc = encryptToBuffer(plaintext, key);
  const iv = enc.subarray(0, IV_LENGTH);
  const tag = enc.subarray(IV_LENGTH, IV_LENGTH + 16);
  const body = enc.subarray(IV_LENGTH + 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(body), d.final()]);
  assert.strictEqual(out.toString("utf8"), plaintext.toString("utf8"), "解密回原文");
  // 篡改检测：改 1 字节 → GCM final 必抛
  body[0] ^= 0xff;
  const d2 = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d2.setAuthTag(tag);
  let tampered = false;
  try {
    Buffer.concat([d2.update(body), d2.final()]);
  } catch {
    tampered = true;
  }
  assert.strictEqual(tampered, true, "篡改被 GCM tag 拦截");
  console.log("✅ bytecode-encrypt selftest 通过（加密/解密闭环 + 篡改拦截）");
}