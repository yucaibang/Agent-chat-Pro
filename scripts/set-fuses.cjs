"use strict";

/**
 * Electron Fuses 设置脚本 — 构建后对打包产物烧录安全熔丝。
 *
 * 烧录的 Fuses：
 * - EnableEmbeddedAsarIntegrityValidation: ASAR 完整性校验（防篡改/重打包）
 * - OnlyLoadAppFromAsar: 仅从 ASAR 加载代码（阻止 fallback 到源码目录）
 * - EnableCookieEncryption: Cookie 加密
 * - 禁用 NODE_OPTIONS / --inspect 调试入口
 *
 * 用法：node scripts/set-fuses.cjs
 * 构建流程会自动在 electron-builder 之后调用此脚本。
 */

const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const path = require("path");
const fs = require("fs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");

async function findAndFlipFuses() {
  // 查找 Windows exe
  const exeName = "Agent Chat Pro.exe";
  const exePath = path.join(DIST_DIR, "win-unpacked", exeName);

  if (!fs.existsSync(exePath)) {
    console.log(`⚠ 未找到构建产物：${exePath}`);
    console.log("  请先运行构建命令生成安装包。");
    process.exit(0);
  }

  console.log(`🔒 正在烧录 Electron Fuses：${exePath}`);

  try {
    await flipFuses(exePath, {
      version: FuseVersion.V1,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironment]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
    });
    console.log("✅ Fuses 烧录完成！");
    console.log("   - EnableEmbeddedAsarIntegrityValidation: ✅ 开启");
    console.log("   - OnlyLoadAppFromAsar: ✅ 开启");
    console.log("   - EnableCookieEncryption: ✅ 开启");
    console.log("   - EnableNodeOptionsEnvironment: ❌ 关闭");
    console.log("   - EnableNodeCliInspectArguments: ❌ 关闭");
    console.log("   - GrantFileProtocolExtraPrivileges: ❌ 关闭");
  } catch (error) {
    console.error("✗ Fuses 烧录失败：", error.message);
    console.error("  安装包仍可使用，但没有 ASAR 完整性保护和调试入口禁用。");
    process.exit(1);
  }
}

findAndFlipFuses();