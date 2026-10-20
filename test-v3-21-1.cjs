"use strict";
/**
 * v3.21.1 测试 — TDZ 装机事故修复（混淆控制流平坦化/死代码注入永久禁用 + 主进程冒烟防线）
 * 背景：v3.21.0 装机 chat:send 报 Error: Cannot access '_0x4b1a81' before initialization——
 *   混淆器 controlFlowFlattening/deadCodeInjection 随机重排语句（使用被搬到声明之前）
 * 覆盖：
 *   A. 根因开关守门：medium 配置两开关=false（配置级铁闸，重新启用即拦截）
 *   B. 防线接线：obf-smoke.cjs 在场 + build-pipeline step1 挂冒烟 + obfuscate require 守卫
 *   C. 版本 3.21.1
 *   D. 主进程模块加载冒烟（干净版实跑 52 模块 = 混淆后冒烟的等价预演）
 *   E. 历史 37 项 v3.21 功能测试复跑
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const obfuscateSrc = fs.readFileSync(path.join(ROOT, "scripts/obfuscate.cjs"), "utf8");
const obfSmokePath = path.join(ROOT, "scripts/obf-smoke.cjs");
const pipelineSrc = fs.readFileSync(path.join(ROOT, "scripts/build-pipeline.cjs"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let passed = 0, failed = 0;
const failures = [];
const test = (name, fn) => Promise.resolve().then(fn)
  .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
  .catch((e) => { failed += 1; failures.push(`  ✗ ${name}\n    ${e.message}`); console.log(`  ✗ ${name}`); });

async function main() {
  console.log("\n=== A. 根因开关守门（controlFlowFlattening / deadCodeInjection 永久禁用） ===");

  await test("A1. medium 配置：controlFlowFlattening=false + deadCodeInjection=false", () => {
    const lib = require("./scripts/obfuscate.cjs");
    const medium = lib.OBFUSCATE_FILES;
    assert.ok(medium, "OBFUSCATE_FILES 已导出");
    // 名单结构校验
    assert.ok(Array.isArray(medium.medium) && medium.medium.includes("main/main.cjs"), "medium 名单在场");
    // 配置级断言：解析 obfuscate.cjs 源码中的 medium 配置段
    const m0 = obfuscateSrc.indexOf("medium: {");
    assert.ok(m0 > 0, "medium 配置段在场");
    const block = obfuscateSrc.slice(m0, obfuscateSrc.indexOf("},", m0));
    assert.ok(/controlFlowFlattening:\s*false/.test(block), "controlFlowFlattening 必须为 false（v3.21.1 装机事故根因开关）");
    assert.ok(/deadCodeInjection:\s*false/.test(block), "deadCodeInjection 必须为 false（同上）");
    assert.ok(!/controlFlowFlattening:\s*true/.test(block), "不得回潮 true");
    assert.ok(!/deadCodeInjection:\s*true/.test(block), "不得回潮 true");
  });

  await test("A2. light 配置本就关闭两开关（历史——渲染进程未引入）", () => {
    const l0 = obfuscateSrc.indexOf("light: {");
    const block = obfuscateSrc.slice(l0, obfuscateSrc.indexOf("},", l0));
    assert.ok(/controlFlowFlattening:\s*false/.test(block));
    assert.ok(/deadCodeInjection:\s*false/.test(block));
  });

  console.log("\n=== B. 防线接线 ===");

  await test("B1. obf-smoke.cjs 在场且导出名单引用正确", () => {
    assert.ok(fs.existsSync(obfSmokePath), "obf-smoke.cjs 存在");
    const s = fs.readFileSync(obfSmokePath, "utf8");
    assert.ok(s.includes('require("./obfuscate.cjs")'), "复用 obfuscate 名单");
    assert.ok(s.includes("OBFUSCATE_FILES.medium"), "冒烟范围=主进程 medium 名单");
  });

  await test("B2. build-pipeline step1 挂冒烟（混淆后立即执行）", () => {
    assert.ok(pipelineSrc.includes('run("node scripts/obfuscate.cjs obfuscate")'), "混淆步骤");
    assert.ok(pipelineSrc.includes('run("node scripts/obf-smoke.cjs")'), "冒烟步骤在场");
    assert.ok(pipelineSrc.indexOf("obf-smoke.cjs") > pipelineSrc.indexOf("obfuscate.cjs obfuscate"), "冒烟在混淆之后");
  });

  await test("B3. obfuscate.cjs require 守卫（被 require 不触发 process.exit 分发）", () => {
    assert.ok(obfuscateSrc.includes("if (require.main === module)"), "dispatch 有 require.main 守卫");
  });

  console.log("\n=== C. 版本 ===");
  await test("C1. package.json semver（版本不写死，按 v3-19-0 先例——v3.21.1 后续版本不误杀）", () => {
    assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `package.json 应为 semver 形态，实际 ${pkg.version}`);
  });

  console.log("\n=== D. 主进程模块加载冒烟（实跑） ===");
  await test("D1. obf-smoke 干净版全过（57 模块，v3.25.0 起 +ask-convention）", () => {
    let out;
    try {
      out = execFileSync("node", [obfSmokePath], { encoding: "utf8", cwd: ROOT, timeout: 120000 });
    } catch (e) {
      throw new Error(`冒烟失败：${(e.stdout || "").split("\n").filter(l => l.includes("✗")).join(" | ")}`);
    }
    assert.ok(/通过 57 · 失败 0/.test(out), `输出应为 57/0：${out.split("\n").slice(-2).join(" ")}`);
  });

  console.log("\n=== E. 历史 v3.21 功能测试 ===");
  await test("E1. test-v3-21-0.cjs 37 项复跑全绿", () => {
    let out;
    try {
      out = execFileSync("node", [path.join(ROOT, "test-v3-21-0.cjs")], { encoding: "utf8", cwd: ROOT, timeout: 180000 });
    } catch (e) {
      throw new Error(`功能测试失败：${(e.stdout || e.stderr || "").split("\n").filter(l => l.includes("✗")).slice(0, 3).join(" | ")}`);
    }
    assert.ok(/通过 37 · 失败 0/.test(out), out.split("\n").slice(-2).join(" "));
  });

  console.log(`\n━━━ test-v3-21-1 共 ${passed + failed} 项 · 通过 ${passed} · 失败 ${failed} ━━━`);
  if (failed) { console.log(failures.join("\n")); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });