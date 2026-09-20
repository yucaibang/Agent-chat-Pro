#!/usr/bin/env node
"use strict";
// v3.12.0 .jsc + 加密混淆 fallback 测试 — 加密器单元 + 解密执行器闭环 + 真实 loader 桥链路 + 构建接线断言
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}`);
  }
}

(async () => {
  const encryptor = require(path.join(ROOT, "scripts", "bytecode-encrypt.cjs"));

  console.log("── 加密器单元（scripts/bytecode-encrypt.cjs）──");
  const segs = encryptor.generateKeyMaterial();
  check("密钥 4 段", Array.isArray(segs) && segs.length === encryptor.KEY_SEGMENTS);
  check("每段 16 hex chars", segs.every((s) => /^[0-9a-f]{16}$/.test(s)));
  check("两次生成互不相同（每次构建随机）", JSON.stringify(segs) !== JSON.stringify(encryptor.generateKeyMaterial()));
  const keyBuf = encryptor.deriveKeyBuffer(segs);
  check("拼接还原 32 字节", keyBuf.length === encryptor.KEY_BYTES);
  let deriveThrew = false;
  try { encryptor.deriveKeyBuffer(["short", "x", "y", "z"]); } catch { deriveThrew = true; }
  check("密钥段数量异常被拒", deriveThrew);

  const plaintext = Buffer.from(`fixture-v312-${Date.now()}\nmodule.exports = { tag: "fallback-ok", add: (a, b) => a + b };\n`, "utf8");
  const enc = encryptor.encryptToBuffer(plaintext, keyBuf);
  check(".enc 布局 = IV(12) + tag(16) + cipher（长度正确）", enc.length === plaintext.length + encryptor.IV_LENGTH + encryptor.TAG_LENGTH);
  const encText = enc.toString("utf8");
  check("密文不含明文业务标识", !/module\.exports|fallback-ok|createWindow/.test(encText));
  let roundTrip = false;
  try {
    const crypto = require("crypto");
    const d = crypto.createDecipheriv("aes-256-gcm", keyBuf, enc.subarray(0, encryptor.IV_LENGTH));
    d.setAuthTag(enc.subarray(encryptor.IV_LENGTH, encryptor.IV_LENGTH + encryptor.TAG_LENGTH));
    roundTrip = Buffer.concat([d.update(enc.subarray(encryptor.IV_LENGTH + encryptor.TAG_LENGTH)), d.final()]).equals(plaintext);
  } catch { roundTrip = false; }
  check("解密回原文（构建端独立解密）", roundTrip);
  let tamperThrew = false;
  try {
    const crypto = require("crypto");
    const bad = Buffer.from(enc);
    bad[bad.length - 1] ^= 0xff;
    const d = crypto.createDecipheriv("aes-256-gcm", keyBuf, bad.subarray(0, encryptor.IV_LENGTH));
    d.setAuthTag(bad.subarray(encryptor.IV_LENGTH, encryptor.IV_LENGTH + encryptor.TAG_LENGTH));
    Buffer.concat([d.update(bad.subarray(encryptor.IV_LENGTH + encryptor.TAG_LENGTH)), d.final()]);
  } catch { tamperThrew = true; }
  check("密文篡改被 GCM tag 拦截", tamperThrew);

  console.log("── 解密执行器（src/main/bytecode-fallback.cjs）──");
  const fallbackSrcPath = path.join(ROOT, "src", "main", "bytecode-fallback.cjs");
  check("__K 占位为 'f' 填充（未注入状态）", encryptor.isPlaceholderUntouched(fallbackSrcPath));
  check("__K 占位为单行数组（正则可命中）", /const\s+__K\s*=\s*\[[^\]]*\]/.test(read("src/main/bytecode-fallback.cjs")));

  const fallback = require(fallbackSrcPath);
  check("v3.11.0 实测报错文本命中 cachedData 特征（cachedDataRejected）", fallback.isCachedDataError(new Error("Invalid or incompatible cached data (cachedDataRejected)")) === true);
  check("变体报错命中（incompatible cached data）", fallback.isCachedDataError(new Error("The cached data does not match / incompatible cached data")) === true);
  check("MODULE_NOT_FOUND 不降级（真错误原样抛）", fallback.isCachedDataError(new Error("Cannot find module './x.jsc'")) === false);
  check("权限错误不降级", fallback.isCachedDataError(new Error("EACCES: permission denied")) === false);
  let placeholderDecryptThrew = false;
  try { fallback.decryptToCode("/dev/null-nonexistent"); } catch (e) { placeholderDecryptThrew = true; }
  check("占位密钥下解密入口不会静默成功（读不到即抛）", placeholderDecryptThrew);
  let placeholderGcmThrew = false;
  try {
    const tmpEnc = path.join(os.tmpdir(), `acp-placeholder-enc-${Date.now()}.enc`);
    fs.writeFileSync(tmpEnc, encryptor.encryptToBuffer(Buffer.from("probe", "utf8"), encryptor.deriveKeyBuffer(segs)));
    fallback.decryptToCode(tmpEnc); // 占位 __K 解密真实密文 → GCM tag 必不匹配
    fs.unlinkSync(tmpEnc);
  } catch { placeholderGcmThrew = true; }
  check("占位密钥解密真实密文必败（GCM 完整性兜底，防呆）", placeholderGcmThrew);

  console.log("── 端到端闭环（注入密钥 → 加密 → loader 桥 → 解密执行）──");
  // 完整模拟 asar 内真实形态：main.cjs(loader桥) + main.enc + helper.cjs(loader桥) + helper.enc + bytecode-fallback.cjs(注入密钥版)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-fallback-test-"));
  fs.copyFileSync(fallbackSrcPath, path.join(tmpDir, "bytecode-fallback.cjs"));
  const tmpFallbackPath = path.join(tmpDir, "bytecode-fallback.cjs");
  encryptor.injectKey(tmpFallbackPath, segs);
  const tmpFallback = require(tmpFallbackPath);

  const helperCode = `"use strict";\nmodule.exports = { name: "helper-v312", combine: (s) => s + "-combined" };\n`;
  const mainCode = [
    `"use strict";`,
    `const helper = require("./helper.cjs");`,
    `module.exports = { tag: "fallback-ok", add: (a, b) => a + b, helperName: helper.name, combined: helper.combine("v312") };`,
    ``,
  ].join("\n");
  const helperEnc = encryptor.encryptToBuffer(Buffer.from(helperCode, "utf8"), keyBuf);
  const mainEnc = encryptor.encryptToBuffer(Buffer.from(mainCode, "utf8"), keyBuf);
  fs.writeFileSync(path.join(tmpDir, "helper.enc"), helperEnc);
  fs.writeFileSync(path.join(tmpDir, "main.enc"), mainEnc);
  // helper.cjs = 仅 .enc loader 桥（模拟 .jsc 编译失败形态）
  fs.writeFileSync(
    path.join(tmpDir, "helper.cjs"),
    `"use strict";\nmodule.exports = require("./bytecode-fallback.cjs").executeFallback(__filename, "./helper.enc");\n`
  );
  // main.cjs = fallback loader 桥（try .jsc → catch .enc，模拟完整形态；.jsc 不存在 → cachedData 特征？不——MODULE_NOT_FOUND 会 throw，
  // 故此用例验证的是「无 .jsc 场景必须用 encOnly 模板」的接线正确性）
  fs.writeFileSync(
    path.join(tmpDir, "main.cjs"),
    `"use strict";\nmodule.exports = require("./bytecode-fallback.cjs").executeFallback(__filename, "./main.enc");\n`
  );

  const mainMod = require(path.join(tmpDir, "main.cjs"));
  check("encOnly loader 桥解密执行成功（exports 正确）", mainMod && mainMod.tag === "fallback-ok" && mainMod.add(2, 3) === 5);
  check("模块内 require 相对解析走 fallback（helper 经 loader 桥加载）", mainMod.helperName === "helper-v312" && mainMod.combined === "v312-combined");
  const mainAgain = require(path.join(tmpDir, "main.cjs"));
  check("require 语义：同模块返回同一 exports（缓存）", mainAgain === mainMod);
  let tamperEncThrew = false;
  try {
    const bad = Buffer.from(mainEnc);
    bad[30] ^= 0xff;
    fs.writeFileSync(path.join(tmpDir, "main.enc"), bad);
    tmpFallback.__clearCache();
    delete require.cache[require.resolve(path.join(tmpDir, "main.cjs"))];
    require(path.join(tmpDir, "main.cjs"));
  } catch { tamperEncThrew = true; }
  check("被篡改的 .enc 解密失败（GCM 完整性 → 防篡改）", tamperEncThrew);

  console.log("── 真实 fallback loader 桥（try .jsc 主路径 + V8 不匹配真实降级）──");
  const { fallbackLoaderTemplate, encOnlyLoaderTemplate } = require(path.join(ROOT, "scripts", "loader-templates.cjs"));
  const pipeline = read("scripts/build-pipeline.cjs");
  check("流水线 require 独立模板模块（可测试、无顶层副作用）", /loader-templates\.cjs/.test(pipeline));
  const loaderText = fallbackLoaderTemplate("main.cjs");
  check("loader 桥模板含 try bytenode + .jsc 主路径", /try \{[\s\S]*require\("bytenode"\);[\s\S]*module\.exports = require\("\.\/main\.jsc"\);/.test(loaderText));
  check("loader 桥 catch 走 isCachedDataError + executeFallback(.enc)", /catch \(__e\) \{[\s\S]*isCachedDataError\(__e\)[\s\S]*executeFallback\(__filename, "\.\/main\.enc"\)/.test(loaderText));

  // 完整模拟 Windows 真机：Electron 编译的 .jsc 被不同 V8 加载 → rejected → catch → 解密降级。
  // 系统 Node 的 V8 ≠ 编译用 Electron 的 V8（test-bytecode.cjs 已证 rejected），等价于跨 OS 场景。
  const tmpReal = fs.mkdtempSync(path.join(ROOT, ".tmp-fallback-real-"));
  fs.copyFileSync(fallbackSrcPath, path.join(tmpReal, "bytecode-fallback.cjs"));
  const realFallbackPath = path.join(tmpReal, "bytecode-fallback.cjs");
  encryptor.injectKey(realFallbackPath, segs);
  const realMainCode = `\"use strict\";\nmodule.exports = { tag: \"real-fallback-ok\", sum: [1, 2, 3].reduce((a, b) => a + b, 0) };\n`;
  fs.writeFileSync(path.join(tmpReal, "main-src.cjs"), realMainCode);
  const electronPath = path.join(ROOT, "node_modules", "electron", "dist", "electron");
  const bytenodeCli = path.join(ROOT, "node_modules", "bytenode", "lib", "cli.js");
  const realJsc = path.join(tmpReal, "main.jsc");
  const { execFileSync } = require("child_process");
  execFileSync(electronPath, [bytenodeCli, "--compile", "--no-warnings", path.join(tmpReal, "main-src.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, cwd: tmpReal, stdio: "pipe",
  });
  fs.renameSync(path.join(tmpReal, "main-src.jsc"), realJsc);
  fs.writeFileSync(path.join(tmpReal, "main.enc"), encryptor.encryptToBuffer(Buffer.from(realMainCode, "utf8"), keyBuf));
  fs.writeFileSync(path.join(tmpReal, "main.cjs"), fallbackLoaderTemplate("main.cjs"));
  const realMod = require(path.join(tmpReal, "main.cjs"));
  check("系统 Node 加载 Electron 编译 .jsc → rejected → 自动降级解密执行（Windows 真机等价场景）", realMod && realMod.tag === "real-fallback-ok" && realMod.sum === 6);
  // 同一 loader 引用的 .jsc 被删除（人为破坏）→ MODULE_NOT_FOUND 非降级错误 → 抛（防篡改从严）
  fs.renameSync(realJsc, path.join(tmpReal, "main.jsc.bak"));
  fs.writeFileSync(path.join(tmpReal, "main-broken.cjs"), fallbackLoaderTemplate("main.cjs"));
  let brokenThrew = false;
  try { require(path.join(tmpReal, "main-broken.cjs")); } catch (e) { brokenThrew = !fallback.isCachedDataError(e); }
  check("loader 引用 .jsc 但文件被删 → 抛错不静默（防篡改从严）", brokenThrew);
  fs.renameSync(path.join(tmpReal, "main.jsc.bak"), realJsc);
  // encOnly 模板（仅 .enc 形态）
  fs.writeFileSync(path.join(tmpReal, "only.cjs"), encOnlyLoaderTemplate("only.cjs"));
  fs.writeFileSync(path.join(tmpReal, "only.enc"), encryptor.encryptToBuffer(Buffer.from(`\"use strict\";\nmodule.exports = { mode: \"enc-only\" };`, "utf8"), keyBuf));
  const onlyMod = require(path.join(tmpReal, "only.cjs"));
  check("encOnly loader 桥（逃生门形态）执行成功", onlyMod && onlyMod.mode === "enc-only");

  console.log("── 构建流水线接线（v3.12.0）──");
  check("step0 密钥注入存在且在混淆之前", /step0_inject_key\(\)/.test(pipeline) && pipeline.indexOf("step0_inject_key();") < pipeline.indexOf("step1_obfuscate();"));
  check("step0 日志标明混淆前执行（防 stringArray 编码吞掉正则）", /混淆前/.test(pipeline));
  check("step2 加密失败阻断构建（.enc 是关键产物）", /加密失败[\s\S]{0,120}构建中止/.test(pipeline));
  check("step5 清理 .jsc/.enc/密钥传递文件", /\.jsc[\s\S]{0,80}\.enc/.test(pipeline) && /\.bytecode-key\.json/.test(pipeline));
  check("verify ① loader 桥特征（jsc+enc+fallback+executeFallback+isCachedDataError）", /isFallbackLoader[\s\S]*main\\\.jsc[\s\S]*main\\\.enc[\s\S]*bytecode-fallback[\s\S]*executeFallback[\s\S]*isCachedDataError/.test(pipeline));
  check("verify ② main.enc 密文抽查（明文即失败）", /main\.enc 疑似明文/.test(pipeline));
  check("verify ③ ACP_FORCE_BYTECODE=0 逃生门形态化", /ACP_FORCE_BYTECODE=0/.test(pipeline));
  check("BYTECODE_FILES 仍含 7 个核心模块", (pipeline.match(/src\/main\/[\w-]+\.cjs/g) || []).length >= 7);

  console.log("── 防回归接线 ──");
  check("混淆清单含 bytecode-fallback.cjs（密钥段进 stringArray）", /"main\/bytecode-fallback\.cjs"/.test(read("scripts/obfuscate.cjs")));
  check(".gitignore 排除构建残留 .jsc/.enc/密钥文件", /\.jsc/.test(read(".gitignore")) && /\.enc/.test(read(".gitignore")) && /bytecode-key/.test(read(".gitignore")));
  check("build.files 含 src/**（.enc/.jsc 进 asar）", (() => { const pkg = JSON.parse(read("package.json")); return (pkg.build.files || []).some((f) => f === "src/**"); })());
  check("test-v3-10-0 跨平台断言已更新为 v3.12.0 语义", /v3\.12\.0 fallback 三件套/.test(read("test-v3-10-0.cjs")));
  const pkg = JSON.parse(read("package.json"));
  const versionParts = pkg.version.split(".").map(Number);
  check("版本号 ≥ 3.12.0（语义比较）", versionParts[0] > 3 || (versionParts[0] === 3 && (versionParts[1] > 12 || (versionParts[1] === 12 && versionParts[2] >= 0))));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpReal, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error("测试异常:", error);
  process.exit(1);
});