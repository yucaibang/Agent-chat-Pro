"use strict";

/**
 * 代码混淆脚本 — Electron 打包前源码保护（v2 修复版）
 *
 * v1 问题（导致白屏）：
 *   - preload.cjs 被混淆 → contextBridge.exposeInMainWorld 序列化失败
 *   - selfDefending:true → 反调试代码导致 Electron 渲染进程崩溃
 *   - debugProtection:true → 阻止 DevTools，白屏时无法排查
 *   - transformObjectKeys:true → 对象键名被篡改，DOM 属性/IPC 通道断裂
 *   - .orig 备份被删除 → 还原路径断裂
 *
 * v2 修复策略：
 *   - preload.cjs 完全跳过混淆（Electron 沙箱限制）
 *   - renderer.js 仅轻量混淆（变量重命名 + 字符串编码）
 *   - 主进程中等混淆（去掉 selfDefending/debugProtection/transformObjectKeys）
 *   - 备份改用 git checkout HEAD（不依赖 .orig 文件）
 *   - cloud-chat.cjs 纳入中等混淆列表
 *
 * 用法：
 *   node scripts/obfuscate.cjs obfuscate  — 混淆所有源文件
 *   node scripts/obfuscate.cjs restore     — 从 git 还原原始文件
 *   node scripts/obfuscate.cjs check        — 检查当前是否已混淆
 */

const JavaScriptObfuscator = require("javascript-obfuscator");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");

// ── 文件列表（相对于 src/）──────────────────────────────

const OBFUSCATE_FILES = {
  // ⛔ 不混淆（Electron 沙箱限制，混淆必崩）
  skip: [
    "main/preload.cjs",          // contextBridge 沙箱，混淆必崩（白屏根因）
  ],

  // 🔵 渲染进程 — 轻量混淆
  light: [
    "renderer/renderer.js",
  ],

  // 🟠 主进程 — 中等混淆
  medium: [
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
    "main/modes/mode-params.cjs",
    "main/cloud-chat.cjs",        // 纯 Node.js 模块，可以混淆
    "main/cloud-brand.cjs",      // 品牌验证模块
    "main/model-config.cjs",      // 模型配置
    "main/status-event-normalizer.cjs", // 状态归一化
  ],
};

// ── 混淆配置 ──────────────────────────────────────────

const OBFUSCATOR_CONFIGS = {
  // 🔵 渲染进程 — 轻量混淆
  // 仅：变量重命名 + 字符串编码数组 + 代码压缩
  // 禁止：控制流平坦化、自我防御、调试保护、对象键变换（都会破坏 DOM 操作）
  light: {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,            // ← 禁止（渲染进程需要 DevTools 排错）
    disableConsoleOutput: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    selfDefending: false,              // ← 禁止（导致渲染进程崩溃白屏）
    simplify: true,
    splitStrings: false,                // ← 轻量级不拆字符串
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.6,          // ← 渲染进程覆盖率稍低，避免过度膨胀
    transformObjectKeys: false,         // ← 禁止（会破坏 DOM 属性访问和 CSS 操作）
    unicodeEscapeSequence: false,
    // 保留 require/module/exports 和 Electron API
    reservedNames: ["^require$", "^module$", "^exports$", "^__dirname$", "^__filename$", "^process$"],
    reservedStrings: ["^node:", "^electron$", "^@electron/", "^app$", "^BrowserWindow$"],
  },

  // 🟠 主进程 — 中等混淆
  // 字符串编码 + 变量重命名 + 适度控制流平坦化
  // 禁止：自我防御、调试保护、对象键变换（防止 IPC 通道名/事件名断裂）
  medium: {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.3, // ← 降低（0.5 太激进，影响性能）
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.05,      // ← 降低（0.1 膨胀过大）
    debugProtection: false,                // ← 禁止（主进程也需要调试）
    disableConsoleOutput: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    selfDefending: false,                  // ← 禁止（v1 白屏根因之一）
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
    transformObjectKeys: false,             // ← 禁止（会破坏 IPC 通道名和事件名映射）
    unicodeEscapeSequence: false,
    // 保留 require 调用和 module.exports，防止 Electron 加载断裂
    reservedNames: ["^require$", "^module$", "^exports$", "^__dirname$", "^__filename$", "^process$"],
    reservedStrings: ["^node:", "^electron$", "^@electron/"],
  },
};

// ── 混淆文件 ──────────────────────────────────────────

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
      inputFileName: relativePath,
    });
    const obfuscated = result.getObfuscatedCode();

    const newSize = Buffer.byteLength(obfuscated, "utf8");
    fs.writeFileSync(fullPath, obfuscated, "utf8");
    const ratio = newSize / originalSize;
    console.log(`  ✓ ${relativePath}：${formatSize(originalSize)} → ${formatSize(newSize)}（${ratio.toFixed(1)}x）`);
    return true;
  } catch (error) {
    console.error(`  ✗ ${relativePath} 混淆失败：${error.message}`);
    return false;
  }
}

// ── 从 git 还原 ────────────────────────────────────────

function restoreFromGit() {
  const allFiles = [...OBFUSCATE_FILES.light, ...OBFUSCATE_FILES.medium];
  let restored = 0;

  for (const file of allFiles) {
    const fullPath = path.join(SRC_DIR, file);
    // git checkout 需要相对于仓库根目录的路径
    const gitPath = path.join("src", file);
    try {
      // 从 git HEAD 还原（始终有 git 历史）
      execSync(`git checkout HEAD -- "${gitPath}"`, {
        cwd: PROJECT_ROOT,
        stdio: "pipe",
      });
      restored++;
    } catch (error) {
      // 如果 HEAD 中也是混淆态，尝试从 P12 还原
      try {
        execSync(`git checkout 2b19fc9 -- "${gitPath}"`, {
          cwd: PROJECT_ROOT,
          stdio: "pipe",
        });
        console.log(`  ↻ ${file}：从 P12 还原`);
        restored++;
      } catch (e2) {
        console.error(`  ✗ ${file} 还原失败：${error.message}`);
      }
    }
  }

  // 清理可能残留的 .orig 备份文件
  let cleanedOrig = 0;
  for (const file of allFiles) {
    const origPath = path.join(SRC_DIR, file + ".orig");
    if (fs.existsSync(origPath)) {
      fs.unlinkSync(origPath);
      cleanedOrig++;
    }
  }
  if (cleanedOrig > 0) {
    console.log(`  🧹 清理 ${cleanedOrig} 个 .orig 备份文件`);
  }

  return restored;
}

// ── 检查混淆状态 ──────────────────────────────────────

function checkObfuscationStatus() {
  const allFiles = [...OBFUSCATE_FILES.skip, ...OBFUSCATE_FILES.light, ...OBFUSCATE_FILES.medium];
  let obfuscatedCount = 0;
  let cleanCount = 0;

  for (const file of allFiles) {
    const fullPath = path.join(SRC_DIR, file);
    if (!fs.existsSync(fullPath)) continue;

    const source = fs.readFileSync(fullPath, "utf8");
    // 混淆特征：大量十六进制变量名 _0x
    const hexVarCount = (source.match(/_0x[0-9a-f]{4,}/g) || []).length;
    const isObfuscated = hexVarCount > 10;

    if (OBFUSCATE_FILES.skip.includes(file)) {
      console.log(`  ⛔ ${file}：${isObfuscated ? "❌ 已混淆（应跳过）" : "✅ 干净（正确跳过）"}`);
      if (isObfuscated) obfuscatedCount++;
    } else {
      console.log(`  ${isObfuscated ? "🔒" : "📄"} ${file}：${isObfuscated ? "已混淆" : "干净"}`);
      if (isObfuscated) obfuscatedCount++;
      else cleanCount++;
    }
  }

  console.log(`\n状态：${obfuscatedCount} 已混淆 / ${cleanCount} 干净`);

  // 检查 skip 列表中的文件是否被误混淆
  const skipViolations = OBFUSCATE_FILES.skip.filter(file => {
    const fullPath = path.join(SRC_DIR, file);
    if (!fs.existsSync(fullPath)) return false;
    const source = fs.readFileSync(fullPath, "utf8");
    return (source.match(/_0x[0-9a-f]{4,}/g) || []).length > 10;
  });

  if (skipViolations.length > 0) {
    console.log(`\n⚠️ 警告：以下不应混淆的文件已被混淆（会导致白屏）：`);
    skipViolations.forEach(f => console.log(`  - ${f}`));
    console.log(`请运行: node scripts/obfuscate.cjs restore`);
    return false;
  }

  return true;
}

// ── 工具函数 ───────────────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── 主逻辑 ────────────────────────────────────────────

const command = process.argv[2] || "check";

if (command === "restore") {
  console.log("🔄 从 git 还原原始文件…");
  const count = restoreFromGit();
  console.log(`✅ 已还原 ${count} 个文件`);
  process.exit(0);
}

if (command === "check") {
  console.log("🔍 检查混淆状态…\n");
  const ok = checkObfuscationStatus();
  process.exit(ok ? 0 : 1);
}

if (command === "obfuscate") {
  // 先检查 skip 列表中的文件是否干净
  console.log("🔍 预检查…");
  const skipViolations = OBFUSCATE_FILES.skip.filter(file => {
    const fullPath = path.join(SRC_DIR, file);
    if (!fs.existsSync(fullPath)) return false;
    const source = fs.readFileSync(fullPath, "utf8");
    return (source.match(/_0x[0-9a-f]{4,}/g) || []).length > 10;
  });

  if (skipViolations.length > 0) {
    console.log("❌ 以下不应混淆的文件已被混淆（会导致白屏）：");
    skipViolations.forEach(f => console.log(`  - ${f}`));
    console.log("请先运行: node scripts/obfuscate.cjs restore");
    process.exit(1);
  }

  // 检查 git 工作区是否干净（确保可以从 git 还原）
  try {
    const gitStatus = execSync("git status --porcelain", {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    }).trim();
    if (!gitStatus) {
      console.log("⚠️ git 工作区是干净的，混淆后无法用 git checkout HEAD 还原。");
      console.log("   建议：先 git add + commit 当前改动，再混淆。");
      console.log("   或者混淆后用 node scripts/obfuscate.cjs restore 从 P12 还原。");
    }
  } catch (e) {
    // git 不可用则跳过此检查
  }

  console.log("\n🔒 开始代码混淆（v2 安全策略）…\n");

  let total = 0;
  let success = 0;

  // 跳过列表
  if (OBFUSCATE_FILES.skip.length > 0) {
    console.log("⛔ 跳过（不可混淆）：");
    OBFUSCATE_FILES.skip.forEach(f => console.log(`  - ${f}`));
    console.log();
  }

  // 轻量混淆
  console.log("🔵 渲染进程 — 轻量混淆：");
  for (const file of OBFUSCATE_FILES.light) {
    total++;
    if (obfuscateFile(file, OBFUSCATOR_CONFIGS.light)) success++;
  }

  // 中等混淆
  console.log("\n🟠 主进程 — 中等混淆：");
  for (const file of OBFUSCATE_FILES.medium) {
    total++;
    if (obfuscateFile(file, OBFUSCATOR_CONFIGS.medium)) success++;
  }

  console.log(`\n✅ 混淆完成：${success}/${total} 个文件`);
  if (success < total) {
    console.log("⚠ 部分文件混淆失败，请检查上方错误信息");
    process.exit(1);
  }

  // 混淆后验证：确保 skip 列表中的文件仍然干净
  console.log("\n🔍 混淆后验证…");
  const postCheckViolations = OBFUSCATE_FILES.skip.filter(file => {
    const fullPath = path.join(SRC_DIR, file);
    if (!fs.existsSync(fullPath)) return false;
    const source = fs.readFileSync(fullPath, "utf8");
    return (source.match(/_0x[0-9a-f]{4,}/g) || []).length > 10;
  });

  if (postCheckViolations.length > 0) {
    console.log("❌ 混淆后检查发现异常！以下文件不应被混淆：");
    postCheckViolations.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }

  console.log("✅ 所有文件混淆状态正确，skip 列表中的文件保持干净。");
  process.exit(0);
}

console.log("用法：node scripts/obfuscate.cjs [obfuscate|restore|check]");
console.log();
console.log("  obfuscate  — 混淆源文件（打包前执行）");
console.log("  restore     — 从 git 还原原始文件（打包后执行）");
console.log("  check       — 检查当前混淆状态");
process.exit(1);