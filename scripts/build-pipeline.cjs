"use strict";

/**
 * Agent Chat Pro 构建流水线 v2 — 强化防破解
 *
 * 流程：密钥注入 → 混淆 → 字节码编译+AES加密 → 打包 → Fuse 烧录 → 还原 → 验证
 *
 * 用法：
 *   node scripts/build-pipeline.cjs           # 完整构建（NSIS）
 *   node scripts/build-pipeline.cjs portable   # Portable 版本
 *   node scripts/build-pipeline.cjs verify     # 仅验证当前构建产物
 *
 * 防破解层级：
 *   1. 代码混淆（javascript-obfuscator 中/轻量）
 *   2. V8 字节码 + AES 加密 fallback（v3.12.0）— asar 内只剩 .jsc + .enc + loader 桥
 *   3. ASAR 完整性校验（Electron Fuse）
 *   4. Electron Fuse 烧录（禁用 Node REPL/调试/NODE_OPTIONS）
 *   5. 运行时自检（integrity-guard.cjs）
 *   6. 商业壳加固（需在 Windows 端手动执行，见文档）
 *
 * 注意：bytenode 编译必须用 Electron 本体执行（electron: true + electronPath）。
 *       ⚠️ v3.11.0 重大更正（2026-09-19 Windows 真机实测）：V8 字节码与 V8 版本强绑定，
 *       且**跨操作系统不兼容**——Linux Electron 35.7.5 编译的 .jsc 在 Windows Electron
 *       加载即抛 `Invalid or incompatible cached data (cachedDataRejected)`，v3.8.0~v3.10.0
 *       的包启动即崩。v3.11.0 改为跨平台构建完全跳过 .jsc（asar 退回明文混淆源码，防破解降级）。
 *
 *       ⚙️ v3.12.0 fallback 方案（两全）：跨平台也编译 .jsc + 每文件附 AES-256-GCM
 *       加密混淆源码（.enc），loader 桥 try .jsc → catch（cachedData 特征）→ 解密 .enc
 *       按 CJS 语义执行（src/main/bytecode-fallback.cjs）。效果：
 *         - 同平台构建（未来 Windows 端）：.jsc 直接生效，fallback 永不触发
 *         - 跨平台构建（NAS 上）：.jsc rejected → 自动降级，功能完整不崩
 *         - 无论哪种：明文 JS（连混淆版）从 asar 消失，只剩 .jsc + .enc + 混淆 fallback
 *       密钥每次构建随机生成、拆 4 段注入 bytecode-fallback.cjs（step0，混淆前——
 *       混淆器会把段值编码进 stringArray，运行时透明还原）。
 *       设 ACP_FORCE_BYTECODE=0 可跳过 .jsc 编译（仅 .enc fallback，用于 bytenode 故障时）。
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
  "src/main/cache-cleaner.cjs",
];

// 构建目标平台（step3 的 electron-builder --win 恒为 Windows）
const TARGET_PLATFORM = "win32";

// v3.12.0：跨平台也编译 .jsc（rejected 时 loader 桥自动降级到 .enc fallback，不再崩）。
// skipJscCompile 仅在 ACP_FORCE_BYTECODE=0（bytenode 故障逃生门）或 bytenode/Electron
// 不可用时为 true —— 此时 asar 内只有 .enc fallback，功能仍完整。
function skipJscCompile() {
  return process.env.ACP_FORCE_BYTECODE === "0";
}

// fallback loader 桥模板（v3.12.0）— 独立模块（无副作用，测试可 require）
const { fallbackLoaderTemplate, encOnlyLoaderTemplate } = require(path.join(__dirname, "loader-templates.cjs"));

// step0 与 step2 之间的密钥传递文件（dist/ 不入 git、不进 asar）
const KEY_FILE_REL = path.join("dist", ".bytecode-key.json");

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

function step0_inject_key() {
  log("🔑", "步骤 0/6: fallback 密钥注入（v3.12.0）...");

  const encryptor = require(path.join(__dirname, "bytecode-encrypt.cjs"));
  const fallbackSrc = path.join(PROJECT_ROOT, "src", "main", "bytecode-fallback.cjs");

  if (!fs.existsSync(fallbackSrc)) {
    log("❌", `缺少解密执行器: src/main/bytecode-fallback.cjs`);
    throw new Error("bytecode-fallback.cjs 不存在");
  }
  if (!encryptor.isPlaceholderUntouched(fallbackSrc)) {
    log("⚠️", "  __K 非占位状态（上次构建中断残留），先还原占位再注入");
    run("git checkout -- src/main/bytecode-fallback.cjs");
    if (!encryptor.isPlaceholderUntouched(fallbackSrc)) {
      throw new Error("无法还原 __K 占位（bytecode-fallback.cjs 工作区状态异常）");
    }
  }

  const segments = encryptor.generateKeyMaterial();
  encryptor.injectKey(fallbackSrc, segments);
  fs.writeFileSync(
    path.join(PROJECT_ROOT, KEY_FILE_REL),
    JSON.stringify({ segments, injectedAt: new Date().toISOString() }, null, 2)
  );
  log("  ✅", `随机密钥已注入 __K（4 段 × 16 hex）+ 传递文件 ${KEY_FILE_REL}`);
  log("✅", "密钥注入完成（混淆前执行——混淆器会把段值编码进 stringArray）");
}

function step1_obfuscate() {
  log("🔒", "步骤 1/6: 代码混淆...");
  run("node scripts/obfuscate.cjs obfuscate");
  log("✅", "代码混淆完成");
}

async function step2_bytenode() {
  log("⚙️", "步骤 2/6: V8 字节码编译 + AES 加密 fallback（v3.12.0）...");

  const encryptor = require(path.join(__dirname, "bytecode-encrypt.cjs"));
  const keyFile = path.join(PROJECT_ROOT, KEY_FILE_REL);
  if (!fs.existsSync(keyFile)) {
    throw new Error("密钥传递文件缺失（step0 未执行）");
  }
  const keySegments = JSON.parse(fs.readFileSync(keyFile, "utf8")).segments;
  const keyBuf = encryptor.deriveKeyBuffer(keySegments);
  log("📋", `构建密钥已装载（${encryptor.KEY_BYTES} 字节，仅存于产物内拆分注入）`);

  // .jsc 编译前置检查（可跳过：逃生门 / bytenode 缺失 / Electron 缺失）
  let jscEnabled = !skipJscCompile();
  if (jscEnabled) {
    try {
      require.resolve("bytenode");
    } catch {
      log("⚠️", "bytenode 不可用 → 跳过 .jsc 编译（.enc fallback 照常，功能不受影响）");
      jscEnabled = false;
    }
  }
  const electronPath = path.join(PROJECT_ROOT, "node_modules", "electron", "dist", "electron");
  if (jscEnabled && !fs.existsSync(electronPath)) {
    log("⚠️", `Electron 二进制不存在: ${electronPath} → 跳过 .jsc 编译（.enc fallback 照常）`);
    jscEnabled = false;
  }
  if (jscEnabled) {
    const electronVersion = require(path.join(PROJECT_ROOT, "node_modules/electron/package.json")).version;
    log("📋", `Electron 版本: ${electronVersion}（用其本体编译，V8 版本与运行时一致）`);
  } else {
    log("💡", "构建形态: 仅 .enc fallback（无 .jsc）。同平台用户运行走解密执行，功能完整。");
  }

  const bytenode = jscEnabled ? require("bytenode") : null;
  let encrypted = 0;
  let compiled = 0;

  for (const file of BYTECODE_FILES) {
    const srcPath = path.join(PROJECT_ROOT, file);
    const jscPath = srcPath.replace(/\.cjs$/, ".jsc");
    const encPath = srcPath.replace(/\.cjs$/, ".enc");
    const basename = path.basename(file);

    if (!fs.existsSync(srcPath)) {
      log("⚠️", `  跳过（文件不存在）: ${file}`);
      continue;
    }

    // ① bytenode 编译（尽力——失败仅影响 .jsc 主路径，.enc fallback 照常兜底）
    let hasJsc = false;
    if (jscEnabled) {
      try {
        await bytenode.compileFile({ filename: srcPath, output: jscPath, electron: true, electronPath });
        if (!fs.existsSync(jscPath)) throw new Error("编译后未生成 .jsc 文件");
        log("  🔩", `字节码: ${basename} → ${path.basename(jscPath)}`);
        compiled++;
        hasJsc = true;
      } catch (e) {
        log("⚠️", `  字节码编译失败（fallback 兜底）: ${basename} — ${e.message}`);
      }
    }

    // ② AES-256-GCM 加密混淆后源码 → .enc（必须成功——这是跨平台的功能保障）
    try {
      const encSize = encryptor.writeEnc(srcPath, encPath, keyBuf);
      log("  🔐", `加密体: ${basename} → ${path.basename(encPath)}（${(encSize / 1024).toFixed(1)} KB）`);
      encrypted++;
    } catch (e) {
      log("❌", `  加密失败: ${basename} — ${e.message}`);
      throw new Error(`.enc 加密失败（fallback 方案的关键产物），构建中止`);
    }

    // ③ 写 fallback loader 桥（有 .jsc → try/catch 双路径；无 → 纯 .enc）
    const loader = hasJsc ? fallbackLoaderTemplate(basename) : encOnlyLoaderTemplate(basename);
    fs.writeFileSync(srcPath, loader);
    log("  📝", `loader 桥: ${basename}（${hasJsc ? ".jsc → 失败降级 .enc" : "仅 .enc"}）`);
  }

  if (encrypted < BYTECODE_FILES.length) {
    log("❌", `加密体不完整: ${encrypted}/${BYTECODE_FILES.length} —— .enc 是 fallback 方案关键产物`);
    return false;
  }

  log("✅", `字节码+加密完成: .jsc=${compiled}/${BYTECODE_FILES.length}（${jscEnabled ? "启用" : "跳过"}）, .enc=${encrypted}/${BYTECODE_FILES.length}`);
  return encrypted === BYTECODE_FILES.length;
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

  // 清理字节码/加密体构建残留（asar 已打包，源码目录不留）
  for (const file of BYTECODE_FILES) {
    for (const suffix of [".jsc", ".enc"]) {
      const artifactPath = path.join(PROJECT_ROOT, file.replace(/\.cjs$/, suffix));
      if (fs.existsSync(artifactPath)) {
        fs.unlinkSync(artifactPath);
        log("  🗑️", `删除: ${path.basename(artifactPath)}`);
      }
    }
  }

  // 清理密钥传递文件（构建产物已含拆分密钥，明文传递文件不留盘）
  const keyFile = path.join(PROJECT_ROOT, KEY_FILE_REL);
  if (fs.existsSync(keyFile)) {
    fs.unlinkSync(keyFile);
    log("  🗑️", `删除: ${KEY_FILE_REL}`);
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

  // 验证字节码+加密 fallback 三件套（v3.12.0，不再按平台分支——两种构建形态同构）：
  //   ① loader 桥：main.cjs 必须是 try .jsc / catch 解密 .enc 的 fallback 桥
  //   ② .enc：每个 BYTECODE_FILE 都有 AES 加密体，且内容必须是密文（非明文源码）
  //   ③ .jsc + bytenode：启用编译时必须有；跳过编译（逃生门）时必须为 0
  try {
    const asarList = execSync(`npx asar list "${asarPath}"`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const jscCount = (asarList.match(/\.jsc\b/gm) || []).length;
    const encCount = (asarList.match(/\.enc\b/gm) || []).length;
    const hasBytenode = /bytenode[\\/]lib[\\/]index\.js/.test(asarList);
    const jscSkipped = skipJscCompile();
    const asar = require("@electron/asar");

    // ① loader 桥特征（用 @electron/asar API 读取，CLI extract-file 输出到 cwd basename，路径不可靠）
    const mainContent = asar.extractFile(asarPath, "src/main/main.cjs").toString("utf8");
    const isFallbackLoader =
      /\.\/main\.jsc/.test(mainContent) &&
      /\.\/main\.enc/.test(mainContent) &&
      /bytecode-fallback/.test(mainContent) &&
      /executeFallback/.test(mainContent) &&
      /isCachedDataError/.test(mainContent);
    if (!isFallbackLoader) {
      log("❌", "main.cjs 不是 fallback loader 桥（缺 .jsc/.enc/bytecode-fallback 特征）—— step2 未生效");
      return false;
    }
    if (mainContent.includes("_0x") || mainContent.includes("createWindow")) {
      log("❌", "main.cjs 疑似混淆源码/明文业务码残留（应为纯 loader 桥）");
      return false;
    }
    log("✅", "fallback loader 桥验证通过（try .jsc → catch 解密 .enc）");

    // ② .enc 数量 + 密文抽查
    if (encCount < BYTECODE_FILES.length) {
      log("❌", `加密体打包不完整: .enc=${encCount}（期望≥${BYTECODE_FILES.length}）——跨平台运行将崩`);
      return false;
    }
    const mainEnc = asar.extractFile(asarPath, "src/main/main.enc");
    if (!mainEnc || mainEnc.length <= 12 + 16) {
      log("❌", "main.enc 密文体异常（过短）");
      return false;
    }
    const encText = mainEnc.toString("utf8");
    if (/createWindow|app\.on\(|_0x[0-9a-f]{4,}|require\("electron"\)/.test(encText)) {
      log("❌", "main.enc 疑似明文（AES 加密未生效）——fallback 方案失效");
      return false;
    }
    log("✅", `AES 加密体验证通过（${encCount} 个 .enc，main.enc ${(mainEnc.length / 1024).toFixed(1)} KB 密文）`);

    // ③ .jsc + bytenode（形态化验证）
    if (jscSkipped) {
      if (jscCount > 0) {
        log("❌", `ACP_FORCE_BYTECODE=0 逃生门下不应有 .jsc: 发现 ${jscCount} 个`);
        return false;
      }
      log("⏭️", ".jsc 编译已跳过（仅 .enc fallback 形态）——预期行为");
    } else if (jscCount >= BYTECODE_FILES.length && hasBytenode) {
      log("✅", `V8 字节码已打包（${jscCount} 个 .jsc + bytenode 运行时；跨平台 rejected 时自动降级 .enc）`);
    } else {
      log("⚠️", `.jsc 打包不完整: .jsc=${jscCount}（期望≥${BYTECODE_FILES.length}），bytenode=${hasBytenode ? "有" : "无"}（.enc fallback 可兜底，不阻断）`);
    }
  } catch (e) {
    log("❌", `asar 三件套验证失败: ${e.message}`);
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
    process.exit(step6_verify() ? 0 : 1);
  }

  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Agent Chat Pro 构建流水线 v2 — 强化防破解     ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("");

  const startTime = Date.now();

  try {
    step0_inject_key(); // v3.12.0：必须在混淆前注入（混淆器把密钥段编码进 stringArray）
    step1_obfuscate();
    await step2_bytenode(); // .jsc 尽力编译，.enc 必须全量（fallback 方案关键产物）
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