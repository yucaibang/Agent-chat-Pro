"use strict";

/**
 * Electron Fuses 设置脚本 — 构建后对打包产物烧录安全熔丝。
 *
 * 烧录的 Fuses（V1 全部 8 项）：
 * - RunAsNode: OFF — 禁止作为 Node.js REPL 运行（防 NODE_OPTIONS 注入）
 * - EnableCookieEncryption: ON — Cookie 加密
 * - EnableNodeOptionsEnvironment: OFF — 禁止 NODE_OPTIONS 环境变量（防代码注入）
 * - EnableNodeCliInspectArguments: OFF — 禁止 --inspect 调试参数（防 DevTools 附加）
 * - EnableEmbeddedAsarIntegrityValidation: ON — ASAR 完整性校验（防篡改）
 * - OnlyLoadAppFromAsar: ON — 仅从 ASAR 加载代码（防 app.asar.unpacked 注入）
 * - LoadBrowserProcessSpecificV8Snapshot: OFF — 默认
 * - GrantFileProtocolExtraPrivileges: OFF — 默认
 *
 * 用法：node scripts/set-fuses.cjs
 * 必须在 electron-builder 之后、NSIS 打包之前调用。
 */

const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const path = require("path");
const fs = require("fs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");

async function findAndFlipFuses() {
  // 查找 Windows exe（Bridge Edition 构建时 build-pipeline 经 ACP_EXE_NAME 传入）
  const exeName = process.env.ACP_EXE_NAME || "Agent Chat Pro.exe";
  const exePath = path.join(DIST_DIR, "win-unpacked", exeName);

  if (!fs.existsSync(exePath)) {
    console.log(`⚠ 未找到构建产物：${exePath}`);
    console.log("  请先运行构建命令生成安装包。");
    process.exit(0);
  }

  console.log(`🔒 正在烧录 Electron Fuses：${exePath}`);

  const fuseConfig = {
    version: FuseVersion.V1,
    // ⚠️ 全部 8 项必须显式指定，不能遗漏（遗漏=使用 Electron 默认值=不安全）
    [FuseV1Options.RunAsNode]: false,                              // OFF — 禁止 Node REPL
    [FuseV1Options.EnableCookieEncryption]: true,                  // ON  — Cookie 加密
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,   // OFF — 禁止 NODE_OPTIONS 注入
    [FuseV1Options.EnableNodeCliInspectArguments]: false,          // OFF — 禁止 --inspect 调试
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,   // ON  — ASAR 完整性校验
    [FuseV1Options.OnlyLoadAppFromAsar]: true,                     // ON  — 仅从 ASAR 加载
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,   // OFF — 默认
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,       // OFF — 默认
  };

  try {
    await flipFuses(exePath, fuseConfig);
    console.log("✅ Fuses 烧录完成！");
    console.log("   - RunAsNode:                           ❌ 关闭（禁止 Node REPL）");
    console.log("   - EnableCookieEncryption:               ✅ 开启");
    console.log("   - EnableNodeOptionsEnvironmentVariable: ❌ 关闭（防代码注入）");
    console.log("   - EnableNodeCliInspectArguments:        ❌ 关闭（防调试附加）");
    console.log("   - EnableEmbeddedAsarIntegrityValidation: ✅ 开启（ASAR 完整性）");
    console.log("   - OnlyLoadAppFromAsar:                 ✅ 开启（防目录注入）");
    console.log("   - LoadBrowserProcessSpecificV8Snapshot: ❌ 关闭");
    console.log("   - GrantFileProtocolExtraPrivileges:     ❌ 关闭");
  } catch (error) {
    console.error("✗ Fuses 烧录失败：", error.message);
    console.error("  安装包仍可使用，但没有 ASAR 完整性保护和调试入口禁用。");
    process.exit(1);
  }

  // 烧录后验证：读取实际 Fuse 值确认正确
  console.log("\n🔍 验证烧录结果...");
  const data = fs.readFileSync(exePath);
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  const pos = data.indexOf(sentinel);
  if (pos === -1) {
    console.error("❌ 无法找到 Fuse sentinel！烧录可能失败。");
    process.exit(1);
  }

  const after = data.slice(pos + sentinel.length, pos + sentinel.length + 10);
  const version = after[0];
  const count = after[1];
  const values = after.slice(2, 2 + count).toString("ascii");

  const expected = "01100100"; // RunAsNode=0, Cookie=1, NodeOpts=1→0, Inspect=0, AsarInt=1, OnlyAsar=1, V8Snap=0, FilePriv=0
  // 实际期望: OFF, ON, OFF, OFF, ON, ON, OFF, OFF = 0 1 0 0 1 1 0 0
  const expectedValues = ["0", "1", "0", "0", "1", "1", "0", "0"];
  const fuseNames = [
    "RunAsNode",
    "EnableCookieEncryption",
    "EnableNodeOptionsEnvironmentVariable",
    "EnableNodeCliInspectArguments",
    "EnableEmbeddedAsarIntegrityValidation",
    "OnlyLoadAppFromAsar",
    "LoadBrowserProcessSpecificV8Snapshot",
    "GrantFileProtocolExtraPrivileges",
  ];

  let allCorrect = true;
  for (let i = 0; i < count && i < fuseNames.length; i++) {
    const actual = values[i];
    const expected = expectedValues[i];
    const stateStr = actual === "1" ? "ON" : actual === "0" ? "OFF" : `UNKNOWN(${actual})`;
    const expectedStr = expected === "1" ? "ON" : "OFF";
    const match = actual === expected ? "✅" : "❌";
    if (actual !== expected) allCorrect = false;
    console.log(`   ${match} ${fuseNames[i]}: ${stateStr} (期望: ${expectedStr})`);
  }

  if (!allCorrect) {
    console.error("\n❌ Fuse 验证失败！部分 Fuse 值不符合预期。");
    console.error("   应用可能存在安全漏洞，请勿发布此构建。");
    process.exit(1);
  }

  console.log("\n✅ 所有 Fuse 验证通过！构建安全。");
}

findAndFlipFuses();