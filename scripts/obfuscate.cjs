"use strict";

/**
 * 代码混淆脚本 — 在 electron-builder 打包前对源码进行混淆保护。
 *
 * 策略：
 * - 主进程 .cjs 文件：高混淆（控制流平坦化 + 字符串编码 + 自我防御）
 * - 渲染进程 .js 文件：中等混淆（变量名 + 字符串编码）
 * - 渲染进程 .html / .css：不处理
 * - bridge .mjs / device-control .ps1：不处理（运行时需要原样）
 * - node_modules：不处理
 *
 * 用法：node scripts/obfuscate.cjs
 */

const JavaScriptObfuscator = require("javascript-obfuscator");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");

// 需要混淆的文件（相对于 src/）
const OBFUSCATE_FILES = {
  // 主进程 — 高混淆
  high: [
    "main/main.cjs",
    "main/ssh.cjs",
    "main/settings.cjs",
    "main/local.cjs",
    "main/protocol.cjs",
    "main/conversations.cjs",
    "main/archive.cjs",
    "main/storage.cjs",
    "main/device-control.cjs",
    "main/logger.cjs",
    "main/markdown.cjs",
    "main/preload.cjs",
    "main/network/transport-base.cjs",
    "main/network/ssh-direct.cjs",
    "main/network/frp-tunnel.cjs",
    "main/network/derp-relay.cjs",
    "main/network/p2p-nat.cjs",
    "main/network/n2n-mesh.cjs",
    "main/network/network-manager.cjs",
    "main/network/latency-monitor.cjs",
    "main/modes/mode-defaults.cjs",
    "main/modes/mode-manager.cjs",
    "main/modes/mode-params.cjs"
  ],
  // 渲染进程 — 中等混淆
  medium: [
    "renderer/renderer.js"
  ]
};

const OBFUSCATOR_CONFIGS = {
  high: {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.1,
    debugProtection: true,
    debugProtectionInterval: 0,
    disableConsoleOutput: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ["base64"],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 2,
    stringArrayWrappersType: "function",
    stringArrayThreshold: 0.75,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    // 保留 require 调用和 module.exports，防止 Electron 加载断裂
    reservedNames: ["^require$", "^module$", "^exports$", "^__dirname$", "^__filename$", "^process$"],
    reservedStrings: ["^node:", "^electron$", "^@electron/"]
  },
  medium: {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayThreshold: 0.5,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    reservedNames: ["^require$", "^module$", "^exports$", "^__dirname$", "^__filename$", "^process$"],
    reservedStrings: ["^node:", "^electron$"]
  }
};

function obfuscateFile(relativePath, config) {
  const fullPath = path.join(SRC_DIR, relativePath);
  if (!fs.existsSync(fullPath)) {
    console.log(`  ⚠ 跳过（文件不存在）：${relativePath}`);
    return false;
  }

  const source = fs.readFileSync(fullPath, "utf8");
  const originalSize = Buffer.byteLength(source, "utf8");

  try {
    const result = JavaScriptObfuscator.obfuscate(source, {
      ...config,
      inputFileName: relativePath
    });
    const obfuscated = result.getObfuscatedCode();
    const newSize = Buffer.byteLength(obfuscated, "utf8");

    // 备份原文件（仅在首次混淆时）
    const backupPath = fullPath + ".orig";
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, source, "utf8");
    }

    fs.writeFileSync(fullPath, obfuscated, "utf8");
    const ratio = newSize / originalSize;
    console.log(`  ✓ ${relativePath}：${formatSize(originalSize)} → ${formatSize(newSize)}（${ratio.toFixed(1)}x）`);
    return true;
  } catch (error) {
    console.error(`  ✗ ${relativePath} 混淆失败：${error.message}`);
    return false;
  }
}

function restoreOriginals() {
  let restored = 0;
  for (const level of ["high", "medium"]) {
    for (const file of OBFUSCATE_FILES[level]) {
      const fullPath = path.join(SRC_DIR, file);
      const backupPath = fullPath + ".orig";
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, fullPath);
        fs.unlinkSync(backupPath);
        restored++;
      }
    }
  }
  return restored;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── 主逻辑 ──────────────────────────────────────────

const command = process.argv[2] || "obfuscate";

if (command === "restore") {
  console.log("🔄 恢复原始文件…");
  const count = restoreOriginals();
  console.log(`已恢复 ${count} 个文件。`);
  process.exit(0);
}

if (command === "obfuscate") {
  console.log("🔒 开始代码混淆…\n");

  let total = 0;
  let success = 0;

  console.log("【主进程 — 高混淆】");
  for (const file of OBFUSCATE_FILES.high) {
    total++;
    if (obfuscateFile(file, OBFUSCATOR_CONFIGS.high)) success++;
  }

  console.log("\n【渲染进程 — 中等混淆】");
  for (const file of OBFUSCATE_FILES.medium) {
    total++;
    if (obfuscateFile(file, OBFUSCATOR_CONFIGS.medium)) success++;
  }

  console.log(`\n✅ 混淆完成：${success}/${total} 个文件`);
  if (success < total) {
    console.log("⚠ 部分文件混淆失败，请检查上方错误信息");
    process.exit(1);
  }
  process.exit(0);
}

console.log("用法：node scripts/obfuscate.cjs [obfuscate|restore]");
process.exit(1);