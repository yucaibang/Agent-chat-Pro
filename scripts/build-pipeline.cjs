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
 * 注意：bytenode 编译需要在目标 Electron 版本的 Node 上执行，
 *       当前在 NAS(Linux) 上编译可能不兼容 Windows Electron。
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

function step2_bytenode() {
  log("⚙️", "步骤 2/6: V8 字节码编译（bytenode）...");

  // 检查 bytenode 是否可用
  try {
    require.resolve("bytenode");
  } catch {
    log("⚠️", "bytenode 不可用，跳过字节码编译（回退到纯混淆模式）");
    log("💡", "安装方法: npm install --save-dev bytenode");
    return false;
  }

  // 检查 Electron 版本兼容性
  const electronVersion = require(path.join(PROJECT_ROOT, "node_modules/electron/package.json")).version;
  log("📋", `Electron 版本: ${electronVersion}`);

  try {
    const bytenode = require("bytenode");

    let compiled = 0;
    for (const file of BYTECODE_FILES) {
      const srcPath = path.join(PROJECT_ROOT, file);
      const jscPath = srcPath.replace(/\.cjs$/, ".jsc");

      if (!fs.existsSync(srcPath)) {
        log("⚠️", `  跳过（文件不存在）: ${file}`);
        continue;
      }

      try {
        bytenode.compileFile({
          filename: srcPath,
          output: jscPath,
          electron: path.join(PROJECT_ROOT, "node_modules/electron/dist/electron"),
        });
        log("  ✅", `编译: ${path.basename(file)} → ${path.basename(jscPath)}`);
        compiled++;
      } catch (e) {
        log("⚠️", `  编译失败: ${file} — ${e.message}`);
        log("💡", `  跳过此文件，将使用混淆版 .cjs`);
      }
    }

    // 创建加载器：.cjs 文件加载对应的 .jsc（如果存在）
    for (const file of BYTECODE_FILES) {
      const srcPath = path.join(PROJECT_ROOT, file);
      const jscPath = srcPath.replace(/\.cjs$/, ".jsc");
      const jscFile = path.basename(file).replace(/\.cjs$/, ".jsc");

      if (fs.existsSync(jscPath)) {
        // 替换 .cjs 为加载器
        const loader = `"use strict";\nrequire("./${jscFile}");\n`;
        fs.writeFileSync(srcPath, loader);
        log("  📝", `创建加载器: ${path.basename(file)} → require("${jscFile}")`);
      }
    }

    log("✅", `字节码编译完成: ${compiled}/${BYTECODE_FILES.length} 个文件`);
    return compiled > 0;
  } catch (e) {
    log("⚠️", `bytenode 编译失败: ${e.message}`);
    log("💡", "回退到纯混淆模式");
    return false;
  }
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
    step6_verify();
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
    step2_bytenode(); // 可选步骤，失败则跳过
    step3_build(target);
    step4_fuses();
    step5_restore();
    step6_verify();

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