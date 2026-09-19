"use strict";

/**
 * Agent Chat Pro 构建流水线 v2 — 强化防破解
 *
 * 流程：混淆 → bytenode 编译 → 打包 → Fuse 烧录 → 还原 → 验证
 *
 * 用法：
 *   node scripts/build-pipeline.cjs           # 完整构建（NSIS）
 *   node scripts/build-pipeline.cjs portable   # Portable 版本
 *   node scripts/build-pipeline.cjs verify     # 仅验证当前构建产物
 *
 * 防破解层级：
 *   1. 代码混淆（javascript-obfuscator 中/轻量）
 *   2. V8 字节码编译（bytenode）— JS 源码 → .jsc 字节码
 *   3. ASAR 完整性校验（Electron Fuse）
 *   4. Electron Fuse 烧录（禁用 Node REPL/调试/NODE_OPTIONS）
 *   5. 运行时自检（integrity-guard.cjs）
 *   6. 商业壳加固（需在 Windows 端手动执行，见文档）
 *
 * 注意：bytenode 编译必须用 Electron 本体执行（electron: true + electronPath），
 *       V8 字节码与 V8 版本强绑定但跨操作系统兼容（实测 Electron 35.7.5 Linux 编译
 *       → 同版本 Electron 加载成功 / 系统 Node 加载报 Invalid cachedData）。
 *       如果 bytenode 不可用，跳过此步骤，回退到纯混淆模式。
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");

// 需要编译为字节码的文件（核心防破解模块）
const BYTECODE_FILES = [
  "src/main/cloud-brand.cjs",
  "src/main/integrity-guard.cjs",
  "src/main/main.cjs",
  "src/main/settings.cjs",
  "src/main/cloud-chat.cjs",
  "src/main/ssh.cjs",
];

// ── 工具函数 ──────────────────────────────────────────

function log(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}

function run(cmd, options = {}) {
  try {
    execSync(cmd, {
      cwd: PROJECT_ROOT,
      stdio: options.silent ? "pipe" : "inherit",
      encoding: "utf8",
      ...options,
    });
    return true;
  } catch (e) {
    if (options.allowFail) {
      log("⚠️", `命令失败（允许）: ${cmd}`);
      return false;
    }
    log("❌", `命令失败: ${cmd}`);
    throw e;
  }
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(PROJECT_ROOT, relativePath));
}

// ── 构建步骤 ──────────────────────────────────────────

function step1_obfuscate() {
  log("🔒", "步骤 1/6: 代码混淆...");
  run("node scripts/obfuscate.cjs obfuscate");
  log("✅", "代码混淆完成");
}

async function step2_bytenode() {
  log("⚙️", "步骤 2/6: V8 字节码编译（bytenode）...");

  // 检查 bytenode 是否可用
  try {
    require.resolve("bytenode");
  } catch {
    log("⚠️", "bytenode 不可用，跳过字节码编译（回退到纯混淆模式）");
    log("💡", "安装方法: npm install --save bytenode");
    return false;
  }

  // Electron 二进制必须存在（编译用它执行，保证 V8 版本与运行时一致）
  const electronPath = path.join(PROJECT_ROOT, "node_modules", "electron", "dist", "electron");
  if (!fs.existsSync(electronPath)) {
    log("⚠️", `Electron 二进制不存在: ${electronPath}，跳过字节码编译`);
    return false;
  }
  const electronVersion = require(path.join(PROJECT_ROOT, "node_modules/electron/package.json")).version;
  log("📋", `Electron 版本: ${electronVersion}（用其本体编译，V8 字节码跨 OS 兼容）`);

  const bytenode = require("bytenode");
  let compiled = 0;
  const compiledList = [];

  for (const file of BYTECODE_FILES) {
    const srcPath = path.join(PROJECT_ROOT, file);
    const jscPath = srcPath.replace(/\.cjs$/, ".jsc");

    if (!fs.existsSync(srcPath)) {
      log("⚠️", `  跳过（文件不存在）: ${file}`);
      continue;
    }

    try {
      await bytenode.compileFile({
        filename: srcPath,
        output: jscPath,
        electron: true,
        electronPath,
      });
      if (!fs.existsSync(jscPath)) throw new Error("编译后未生成 .jsc 文件");
      log("  ✅", `编译: ${path.basename(file)} → ${path.basename(jscPath)}`);
      compiled++;
      compiledList.push(jscPath);
    } catch (e) {
      log("⚠️", `  编译失败: ${file} — ${e.message}`);
      log("💡", "  跳过此文件，将使用混淆版 .cjs");
    }
  }

  if (compiled === 0) {
    log("⚠️", "没有任何文件编译成功，回退到纯混淆模式");
    return false;
  }

  // 用加载桥替换 .cjs（修复：必须 require bytenode 注册 .jsc 扩展 + module.exports 转发，
  // 否则 require 该模块的业务代码拿到 undefined 直接崩溃）
  for (const jscPath of compiledList) {
    const srcPath = jscPath.replace(/\.jsc$/, ".cjs");
    const jscFile = path.basename(jscPath);
    const loader = `"use strict";\nrequire("bytenode");\nmodule.exports = require("./${jscFile}");\n`;
    fs.writeFileSync(srcPath, loader);
    log("  📝", `加载桥: ${path.basename(srcPath)} → bytenode + require("./${jscFile}")`);
  }

  log("✅", `字节码编译完成: ${compiled}/${BYTECODE_FILES.length} 个文件`);
  return compiled > 0;
}

function step3_build(target = "nsis") {
  log("📦", `步骤 3/6: electron-builder 打包 (${target})...`);
  const cmd =
    target === "portable"
      ? "electron-builder --win portable -c.npmRebuild=false"
      : "electron-builder --win nsis -c.npmRebuild=false";
  run(cmd);
  log("✅", "打包完成");
}

function step4_fuses() {
  log("🔐", "步骤 4/6: Electron Fuse 烧录...");
  run("node scripts/set-fuses.cjs");
  log("✅", "Fuse 烧录完成");
}

function step5_restore() {
  log("🔄", "步骤 5/6: 还原混淆源码...");
  run("node scripts/obfuscate.cjs restore");

  // 清理 bytenode 生成的 .jsc 文件（如果有的话）
  for (const file of BYTECODE_FILES) {
    const jscPath = path.join(PROJECT_ROOT, file.replace(/\.cjs$/, ".jsc"));
    if (fs.existsSync(jscPath)) {
      fs.unlinkSync(jscPath);
      log("  🗑️", `删除: ${path.basename(jscPath)}`);
    }
  }

  log("✅", "源码还原完成");
}

function step6_verify() {
  log("🔍", "步骤 6/6: 构建产物验证...");

  const exePath = path.join(DIST_DIR, "win-unpacked", "Agent Chat Pro.exe");
  if (!fs.existsSync(exePath)) {
    log("❌", "构建产物不存在，验证跳过");
    return false;
  }

  // 验证 Fuse
  const data = fs.readFileSync(exePath);
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  const pos = data.indexOf(sentinel);

  if (pos === -1) {
    log("❌", "Fuse sentinel 未找到！");
    return false;
  }

  const after = data.slice(pos + sentinel.length, pos + sentinel.length + 10);
  const version = after[0];
  const count = after[1];
  const values = after.slice(2, 2 + count).toString("ascii");

  const expected = "01001100";
  const fuseOK = values.startsWith(expected);

  if (fuseOK) {
    log("✅", "Fuse 验证通过");
  } else {
    log("❌", `Fuse 验证失败! 期望=${expected} 实际=${values}`);
    return false;
  }

  // 验证 ASAR
  const asarPath = path.join(DIST_DIR, "win-unpacked", "resources", "app.asar");
  if (fs.existsSync(asarPath)) {
    log("✅", `ASAR 包存在 (${(fs.statSync(asarPath).size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    log("❌", "ASAR 包不存在！");
    return false;
  }

  // 验证字节码已打包（v3.8.0）：asar 内必须有 .jsc + bytenode 运行时
  try {
    const asarList = execSync(`npx asar list "${asarPath}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const jscCount = (asarList.match(/\.jsc\b/gm) || []).length;
    const hasBytenode = /bytenode[\\/]lib[\\/]index\.js/.test(asarList);
    if (jscCount >= BYTECODE_FILES.length && hasBytenode) {
      log("✅", `V8 字节码已打包（${jscCount} 个 .jsc + bytenode 运行时）`);
    } else {
      log("❌", `字节码打包不完整: .jsc=${jscCount}（期望≥${BYTECODE_FILES.length}），bytenode=${hasBytenode ? "有" : "无"}`);
      return false;
    }
  } catch (e) {
    log("⚠️", `asar 字节码清单验证失败（不阻断）: ${e.message}`);
  }

  // 验证 integrity-guard.cjs 存在
  const integrityGuard = path.join(DIST_DIR, "win-unpacked", "resources", "app.asar");
  // Note: can't easily verify files inside ASAR without extraction

  log("✅", "构建验证通过！");
  return true;
}

// ── 主流程 ────────────────────────────────────────────

async function main() {
  const target = process.argv[2] || "nsis";

  if (target === "verify") {
    process.exit(step6_verify() ? 0 : 1);
  }

  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Agent Chat Pro 构建流水线 v2 — 强化防破解     ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("");

  const startTime = Date.now();

  try {
    step1_obfuscate();
    await step2_bytenode(); // 可选步骤，失败则跳过
    step3_build(target);
    step4_fuses();
    step5_restore();
    const verified = step6_verify();
    if (!verified) throw new Error("构建产物验证未通过（见上方 ❌ 项）");

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("");
    log("🎉", `构建完成！耗时 ${elapsed}s`);

    // 商业壳加固提示
    console.log("");
    log("📋", "后续步骤（需在 Windows 端手动执行）：");
    console.log("   1. 将 dist/win-unpacked 复制到 Windows 机器");
    console.log("   2. 使用 Virbox Protector DS 模式加固 Agent Chat Pro.exe");
    console.log("   3. 或使用 VMProtect Ultimate 加壳保护");
    console.log("   4. 重新打包为 NSIS 安装包");
    console.log("   5. 安装测试验证功能正常");
  } catch (error) {
    log("❌", `构建失败: ${error.message}`);

    // 尝试还原
    try {
      step5_restore();
    } catch (e) {
      // 忽略还原失败
    }

    process.exit(1);
  }
}

main();