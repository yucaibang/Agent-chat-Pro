"use strict";

/**
 * v3.45.4 守门：百宝箱面装机前代码自查三修（口令「软件开发继续」出品，沿 v3.45.1/v3.45.2 等六代先例）
 *
 * Bug#1（功能级·实锤）GC 静默失效：main.cjs memory:optimize 旧写法
 *   v8.setFlagsFromString("--expose-gc") 后取 global.gc——但 --expose-gc 是 V8 bootstrap
 *   flag（context 全局初始化时挂 gc），运行期改 flag 位不会回头补挂：实测 Node v22
 *   动态设置后 typeof global.gc === "undefined"、启动 flag 对照组才是 function。
 *   → 恒传 gc:null → gcRan 恒 false，垃圾回收从不执行，「内存优化」静默降级为只体检；
 *   45-3 守门 mock 层恰好掩盖（mock 恒 gcRan:true，没人测真实注入形态）。
 *   → 修复=memory-optimizer.cjs 新增 resolveGc()（vm 新 context 方案：新 context 初始化
 *   重新读 flag 位 → gc 注册进新 context → 取出同一 isolate 的 gc 函数引用，实测生效）
 *   + 按探测一次缓存；main.cjs 改注 resolveGc()、删裸 setFlagsFromString 与 v8 顶层依赖。
 * Bug#2（体系欠账）memory-optimizer.cjs 未登记 obfuscate medium 名单
 *   （v3.36.0 voice-transcribe 同型先例专门登记过；45-3 交付链无 obf-smoke 记录=漏网）。
 *   → 修复=obfuscate.cjs 登记 main/memory-optimizer.cjs。
 * Bug#3（轻·文案矛盾）渲染层 !gcRan 时首句仍断言「主进程垃圾回收：X→Y（释放 Z）」与
 *   补句「垃圾回收未执行」自相矛盾。→ 修复=三元文案：gcRan=true 讲快照差值，false 如实
 *   「未执行（环境不支持，仅体检）」。
 *
 * 本守门核心=行为级真跑（不再 mock 掩盖）：resolveGc 在 node 真环境取 gc + 缓存 +
 * 真回收 + global.gc 优先 + optimizeMemory 端到端 gcRan=true / gc:null 如实 false。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const mainSrc = read("src/main/main.cjs");
const optimizerSrc = read("src/main/memory-optimizer.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const obfuscateSrc = read("scripts/obfuscate.cjs");
const preloadSrc = read("src/main/preload.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const readme = read("README.md");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((error) => {
      failed++;
      const message = error && error.message ? error.message.split("\n")[0] : String(error);
      failures.push(`${name} —— ${message}`);
      console.log(`  ✗ ${name} —— ${message}`);
    });
}

const OPTIMIZER_PATH = path.join(ROOT, "src/main/memory-optimizer.cjs");

/** 重新加载 memory-optimizer（清 require.cache 重置 cachedGc 探测缓存） */
function freshOptimizer() {
  delete require.cache[OPTIMIZER_PATH];
  return require(OPTIMIZER_PATH);
}

// ── A. 行为级真跑（node 真环境，无 mock 掩盖）─────────────────────

async function runBehaviorTests() {
  await test("A1. resolveGc 真环境取 gc：返回 function（vm 新 context 方案生效）", () => {
    const { resolveGc } = freshOptimizer();
    const gc = resolveGc();
    assert.strictEqual(typeof gc, "function", `resolveGc 应取得 gc 函数（实得 ${typeof gc}）`);
  });

  await test("A2. resolveGc 探测缓存：二次调用返回同一引用", () => {
    const { resolveGc } = freshOptimizer();
    const first = resolveGc();
    const second = resolveGc();
    assert.strictEqual(second, first, "resolveGc 第二次调用应返回同一引用（缓存）");
  });

  await test("A3. gc 真实生效：造垃圾后调用 gc()，used_heap_size 不升", () => {
    const { resolveGc } = freshOptimizer();
    const gc = resolveGc();
    assert.strictEqual(typeof gc, "function", "gc 函数应已就绪");
    gc(); // 先收一轮，让起点干净
    const v8 = require("v8");
    const mid = v8.getHeapStatistics().used_heap_size;
    for (let i = 0; i < 200000; i += 1) {
      const junk = { a: i, b: "x".repeat(24) };
      if (junk.b === "never") throw new Error("unreachable");
    }
    const peak = v8.getHeapStatistics().used_heap_size;
    gc();
    const after = v8.getHeapStatistics().used_heap_size;
    assert.ok(after <= peak, `gc 后堆不升：peak ${Math.round(peak / 1048576)}MB → after ${Math.round(after / 1048576)}MB`);
  });

  await test("A4. 启动期 global.gc 优先：挂上 spy 后 fresh require 解析到 spy（测试毕还原）", () => {
    const { resolveGc } = freshOptimizer();
    const spy = function spyGc() {};
    const hadGc = Object.prototype.hasOwnProperty.call(global, "gc");
    const original = global.gc;
    global.gc = spy;
    try {
      const got = resolveGc();
      assert.strictEqual(got, spy, "global.gc 在场时 resolveGc 应直接用它（不走 vm 方案）");
    } finally {
      if (hadGc) global.gc = original;
      else delete global.gc;
    }
  });

  await test("A5. optimizeMemory 端到端：gc=resolveGc() → gcRan=true + freedMb≥0 + 体检聚合", () => {
    const mod = freshOptimizer();
    const result = mod.optimizeMemory({
      gc: mod.resolveGc(),
      metrics: [
        { type: "Browser", memory: { workingSetSize: 51200 } },
        { type: "Renderer", memory: { workingSetSize: 102400 } },
        { type: "GPU", memory: { workingSetSize: 25600 } },
        { type: "Tab", memory: { workingSetSize: 8192 } },
      ],
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.gcRan, true, "gcRan 应为 true（真实 gc 注入形态，mock 掩盖面回归网）");
    assert.ok(typeof result.freedMb === "number" && result.freedMb >= 0, `freedMb 应≥0（实得 ${result.freedMb}）`);
    assert.ok(result.afterMb >= 1, "afterMb 应为正数（node 堆不可能为空）");
    assert.deepStrictEqual(result.memoryParts, ["主 50 MB", "渲染 100 MB", "GPU 25 MB", "其他 8 MB"], "体检按 type 聚合+未知归其他");
    assert.strictEqual(result.totalMb, 183, "总量 KB→MB 口径");
  });

  await test("A6. gc 不可用如实路径：gc=null → gcRan=false + ok=true（渲染层「未执行」分支数据形态）", () => {
    const mod = freshOptimizer();
    const result = mod.optimizeMemory({ gc: null, metrics: [{ type: "Browser", memory: { workingSetSize: 51200 } }] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.gcRan, false, "gc 不可用应如实 gcRan=false");
    assert.deepStrictEqual(result.memoryParts, ["主 50 MB"]);
  });
}

// ── B. 源码锚 ──────────────────────────────────────────────────────

async function runSourceTests() {
  await test("B1. main.cjs：gc 经 resolveGc 注入 + 裸 setFlagsFromString 清零", () => {
    assert.ok(mainSrc.includes("const { optimizeMemory, resolveGc } = require(\"./memory-optimizer.cjs\")"), "main 应解构引 resolveGc");
    const handlerSlice = mainSrc.slice(mainSrc.indexOf("memory:optimize"), mainSrc.indexOf("memory:optimize") + 900);
    assert.ok(handlerSlice.includes("gc: resolveGc()"), "handler 应注入 resolveGc()");
    assert.ok(!mainSrc.includes("v8.setFlagsFromString"), "main 不应再裸 setFlagsFromString（v3.45.4 Bug#1 修复锚）");
    assert.ok(!/^const v8 = require\("v8"\);$/m.test(mainSrc), "main 顶层 v8 依赖应清零（gc 取得已收编进模块）");
  });

  await test("B2. memory-optimizer.cjs：vm 新 context 方案 + 缓存在场 + 旧「global.gc 直接取」保留", () => {
    assert.ok(optimizerSrc.includes("function resolveGc"), "resolveGc 应在场");
    assert.ok(optimizerSrc.includes('vm.createContext'), "vm 新 context 方案应在场");
    assert.ok(optimizerSrc.includes('vm.runInContext("gc"'), "应从新 context 取 gc");
    assert.ok(optimizerSrc.includes('require("v8").setFlagsFromString("--expose-gc")'), "vm 方案内应先开 flag");
    assert.ok(/cachedGc !=?=? undefined/.test(optimizerSrc), "探测缓存应在场");
    assert.ok(optimizerSrc.includes('module.exports = { optimizeMemory, summarizeMetrics, resolveGc }'), "resolveGc 应导出");
  });

  await test("B3. 渲染层：!gcRan 文案改「未执行（环境不支持，仅体检）」不再断言快照差值", () => {
    const slice = rendererSrc.slice(rendererSrc.indexOf("#memory-optimize"), rendererSrc.indexOf("#memory-optimize") + 2200);
    assert.ok(slice.includes("主进程垃圾回收：未执行（环境不支持，仅体检）"), "未执行文案应在");
    assert.ok(!slice.includes("垃圾回收未执行（环境不支持）"), "旧矛盾补句应清零");
    assert.ok(slice.includes("result.gcRan\n      ? [`主进程垃圾回收："), "gcRan 三元文案应在场");
  });

  await test("B4. 混淆名单：main/memory-optimizer.cjs 已登记（v3.45.4 Bug#2 修复锚）", () => {
    assert.ok(obfuscateSrc.includes('"main/memory-optimizer.cjs"'), "medium 名单应含 memory-optimizer.cjs");
    const list = require("./scripts/obfuscate.cjs").OBFUSCATE_FILES.medium;
    assert.ok(Array.isArray(list) && list.includes("main/memory-optimizer.cjs"), "导出的 medium 名单应含 memory-optimizer.cjs");
  });

  await test("B5. preload 桥不动：optimizeMemory → memory:optimize 接线保持", () => {
    assert.ok(preloadSrc.includes('optimizeMemory: () => ipcRenderer.invoke("memory:optimize")'), "preload 桥应保持");
  });
}

// ── C. 版本自洽 ────────────────────────────────────────────────────

async function runVersionTests() {
  await test("C1. package.json 版本 ≥3.45.4 且 README badge 自洽（滚动式下限锚，45-1 硬钉教训固化）", () => {
    const [maj, min, patch] = String(pkg.version).split(".").map((n) => Number(n) || 0);
    assert.ok(maj > 3 || (maj === 3 && (min > 45 || (min === 45 && patch >= 4))), `版本应 ≥3.45.4（实得 ${pkg.version}）`);
    assert.strictEqual(readme.match(/badge\/version-([v\d.]+)-blue\.svg/)?.[1] || "", pkg.version, `README badge 与 package.json ${pkg.version} 应自洽`);
  });
}

(async () => {
  console.log("\n── A. 行为级真跑（resolveGc 真环境） ──");
  await runBehaviorTests();
  console.log("\n── B. 源码锚 ──");
  await runSourceTests();
  console.log("\n── C. 版本自洽 ──");
  await runVersionTests();
  console.log("");
  if (failed) { console.error(`test-v3-45-4 ✗ ${failed} 项失败`); failures.forEach((f) => console.log(`✗ ${f}`)); process.exit(1); }
  console.log(`test-v3-45-4: ${passed} 项全绿`);
})().catch((error) => { console.error(error); process.exit(1); });
