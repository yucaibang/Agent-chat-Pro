"use strict";

/**
 * Agent Chat Pro 字节码降级执行器（v3.12.0）
 *
 * 背景：V8 字节码与 V8 版本 + 平台 flags 强绑定，跨 OS 加载即抛
 *   `Invalid or incompatible cached data (cachedDataRejected)`（v3.11.0 Windows 真机实测）。
 * v3.8.0~v3.10.0 的 NAS 构建在 Windows 上启动即崩，v3.11.0 改为跨平台构建完全跳过 .jsc
 *   （asar 退回明文混淆源码，防破解降级）。
 *
 * 本模块（v3.12.0 fallback 方案）让两全：
 *   - asar 内放 .jsc + .enc（AES-256-GCM 加密的混淆源码）+ loader 桥
 *   - loader 桥 try require("./x.jsc") → 成功（同平台构建）直接跑字节码
 *   - catch 后若属 cachedData 特征 → executeFallback 解密 .enc → 按 CJS 语义执行
 *   - 其他错误（真 bug / MODULE_NOT_FOUND）原样抛出，不吞
 *
 * 效果：无论构建机是什么平台，运行都正常；且明文 JS（连混淆版）从 asar 消失，
 *       只剩 .jsc（跨平台时是烟雾弹）+ .enc（密文体）+ 混淆后的本模块（含拆分密钥）。
 *
 * ⚠️ 密钥注入：__K 占位数组由 scripts/bytecode-encrypt.cjs 在构建 step0（混淆前）
 *   注入随机密钥段（每次构建不同）。占位段为 'f' 填充，不可用于解密。
 *
 * ⚠️ 本文件已被中等混淆（v3.12.0 起纳入混淆清单）。工作区看到 _0x 混淆码即说明
 *   上次构建被中断且未还原——执行 `node scripts/obfuscate.cjs restore` 或
 *   `git checkout HEAD -- src/main/bytecode-fallback.cjs`（入库后）恢复源码版。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
const Module = require("module");

// AES-256-GCM 密钥段（构建时注入，4 段 × 16 hex chars = 32 字节）。占位值不可解密。
const __K = ["ffffffffffffffff", "ffffffffffffffff", "ffffffffffffffff", "ffffffffffffffff"];

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_BYTES = 32;

// 解密执行缓存（require 语义：同一模块返回同一 exports；防循环/重复顶层执行）
const __fallbackCache = new Map();

/** 拼接密钥段 → 32 字节 Buffer */
function __deriveKey() {
  const joined = __K.join("");
  if (joined.length !== KEY_BYTES * 2 || !/^[0-9a-f]+$/.test(joined)) {
    throw new Error("bytecode-fallback 密钥段未注入或已损坏（占位密钥不可解密）");
  }
  return Buffer.from(joined, "hex");
}

/** 解密 .enc → 混淆后 JS 源码字符串。布局 [12B IV][16B tag][cipher]，GCM tag 篡改即抛 */
function decryptToCode(encPath) {
  const buf = fs.readFileSync(encPath);
  if (buf.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error(`加密体过短: ${path.basename(encPath)}（${buf.length} 字节）`);
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-256-gcm", __deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** 判断 .jsc 加载失败是否属于字节码不兼容（只有这类错误才降级，真错误原样抛） */
function isCachedDataError(err) {
  const msg = String((err && err.message) || err || "");
  return /cachedDataRejected|cached data|incompatible cached/i.test(msg);
}

/**
 * 解密 .enc 并按 CommonJS 语义执行（Module.wrap + vm.runInThisContext）。
 * @param {string} requestor  调用方模块的 __filename（用于定位 .enc 与虚拟路径）
 * @param {string} encRel     加密体相对路径（如 "./main.enc"）
 * @returns {module.exports}
 */
function executeFallback(requestor, encRel) {
  const dir = path.dirname(requestor);
  const encAbs = path.join(dir, encRel);
  // 虚拟文件名：.enc → .cjs（供模块内 require 相对解析与 __filename 语义一致）
  const virtualFilename = path.join(dir, path.basename(encRel).replace(/\.enc$/, ".cjs"));

  if (__fallbackCache.has(virtualFilename)) return __fallbackCache.get(virtualFilename);

  const code = decryptToCode(encAbs);
  const m = new Module(virtualFilename, null);
  m.filename = virtualFilename;
  m.paths = Module._nodeModulePaths(path.dirname(virtualFilename));
  const wrapped = vm.runInThisContext(Module.wrap(code), { filename: virtualFilename });
  // ⚠️ require 必须绑定 m（真实 Node 加载器用内部 makeRequireFunction(m)；公有等价 = bind）。
  //    直接传 m.require 原型方法，模块内调用时 this 丢失（strict 下 undefined）→
  //    相对路径 './x' 解析退化到 cwd → MODULE_NOT_FOUND（requireStack 为空的怪错即此因）。
  wrapped(m.exports, m.require.bind(m), m, virtualFilename, path.dirname(virtualFilename));
  __fallbackCache.set(virtualFilename, m.exports);
  return m.exports;
}

/** 清空缓存（仅测试用） */
function __clearCache() {
  __fallbackCache.clear();
}

module.exports = { executeFallback, decryptToCode, isCachedDataError, __clearCache, __deriveKey };