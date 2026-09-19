#!/usr/bin/env node
"use strict";
// v3.8.0 V8 字节码编译测试 — 流水线接线断言 + 真实编译/加载闭环 + V8 版本绑定验证
const assert = require("assert");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
  console.log("── 流水线接线断言 ──");
  const pipeline = read("scripts/build-pipeline.cjs");
  check("BYTECODE_FILES 含 6 个核心模块", (pipeline.match(/src\/main\/[\w-]+\.cjs/g) || []).length >= 6);
  check("loader 桥带 require(bytenode)", /require\("bytenode"\)/.test(pipeline));
  check("loader 桥带 module.exports 转发", /module\.exports = require\("\.\//.test(pipeline));
  check("electron: true 参数", /electron: true,/.test(pipeline));
  check("electronPath 指向 Electron 本体", /electron.*dist.*electron/.test(pipeline));
  check("verify 校验 asar 内 .jsc", /asar list/.test(pipeline) && /\.jsc/.test(pipeline));
  check("还原步骤删除 .jsc", /unlinkSync/.test(pipeline) && /\.jsc/.test(pipeline));

  const pkg = JSON.parse(read("package.json"));
  check("bytenode 在 dependencies（打包进 asar）", Boolean(pkg.dependencies && pkg.dependencies.bytenode));
  const versionParts = pkg.version.split(".").map(Number);
  const minParts = [3, 8, 0];
  check("版本号 ≥ 3.8.0（语义比较）", versionParts[0] > minParts[0] || (versionParts[0] === minParts[0] && (versionParts[1] > minParts[1] || (versionParts[1] === minParts[1] && versionParts[2] >= minParts[2]))));

  const obfuscateList = read("scripts/obfuscate.cjs");
  check("preload 在混淆跳过列表（防白屏铁律）", /main\/preload\.cjs",\s*\/\/.*白屏/.test(obfuscateList));

  console.log("── 真实编译/加载闭环 ──");
  // 放在项目内：loader 的 require("bytenode") 要能解析到项目 node_modules（与 asar 内布局一致）
  const tmpDir = fs.mkdtempSync(path.join(ROOT, ".tmp-bytecode-test-"));
  const fixtureName = `bytecode-fixture-${Date.now()}.cjs`;
  const fixtureSrc = path.join(tmpDir, fixtureName);
  const fixtureJsc = fixtureSrc.replace(/\.cjs$/, ".jsc");
  fs.writeFileSync(fixtureSrc, `"use strict";\nconst TAG = "v3.8.0-bytecode-ok";\nmodule.exports = { TAG, add: (a, b) => a + b };\n`);

  const electronPath = path.join(ROOT, "node_modules", "electron", "dist", "electron");
  const bytenodeCli = path.join(ROOT, "node_modules", "bytenode", "lib", "cli.js");
  execFileSync(electronPath, [bytenodeCli, "--compile", fixtureSrc], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, cwd: tmpDir });
  check("Electron 编译 .jsc 产出", fs.existsSync(fixtureJsc) && fs.statSync(fixtureJsc).size > 100);

  const loaderSrc = path.join(tmpDir, `loader-${fixtureName}`);
  fs.writeFileSync(loaderSrc, `"use strict";\nrequire("bytenode");\nmodule.exports = require("./${fixtureName.replace(/\.cjs$/, ".jsc")}");\n`);
  const loaded = execFileSync(electronPath, ["-e", `const m = require(${JSON.stringify(loaderSrc)}); console.log(m.TAG + "|" + m.add(2, 3));`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
  check("Electron 经 loader 加载 jsc 成功", /v3\.8\.0-bytecode-ok\|5/.test(loaded.trim()));

  console.log("── V8 版本绑定验证 ──");
  let rejected = false;
  try {
    execFileSync(process.execPath, ["-e", `require("bytenode"); require(${JSON.stringify(fixtureJsc)});`], { cwd: tmpDir, encoding: "utf8", stdio: "pipe" });
  } catch {
    rejected = true;
  }
  check("系统 Node 加载 jsc 被拒（字节码 V8 强绑定）", rejected);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error("测试异常:", error);
  process.exit(1);
});