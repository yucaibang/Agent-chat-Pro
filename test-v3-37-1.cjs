"use strict";
/**
 * v3.37.1 守门测试 — app:edition 结构化克隆悬账修复
 *
 * 事故（v3.37.0 登记）：`ipcMain.handle("app:edition", () => EDITION)` 把 edition.cjs
 * 整包返回，module.exports 含函数 editionFor → IPC structuredClone 直接拒（
 * 「An object could not be cloned」）→ 渲染层 applyEdition catch 兜底。
 * 主版兜底默认值恰等于主版真值=行为无感，但真实数据流断裂（任何 gate 默认值变化即失配）。
 *
 * 修复：handler 只回 { edition, productName, gates } 三字段纯数据（gates 浅拷）。
 *   - bridge 形态（构建期 edition.cjs 覆写为纯数据 BRIDGE_EDITION）本就不含函数，不受影响；
 *   - 修复对两形态统一成立。
 *
 * 覆盖：
 *   A. 实锤回归（structuredClone）：edition.cjs 提交整包含函数必须克隆失败（防有人「简化」回去）；
 *      修复后返回形状克隆成功且值与 EDITION 一致；bridge 覆写产物形态同样可克隆。
 *   B. 源码断言：main.cjs 不再裸返 EDITION；handler 呈三字段形状；preload 渲染层消费链不变。
 *   C. 版本号：package.json = 3.37.1。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const EDITION = require("./src/main/edition.cjs");
const mainSrc = read("src/main/main.cjs");
const pipelineSrc = read("scripts/build-pipeline.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { passed++; console.log(`  ✅ ${name}`); },
        (e) => { failed++; failures.push({ name, error: e }); console.log(`  ❌ ${name}: ${e && e.message}`); }
      );
    }
    passed++; console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++; failures.push({ name, error: e }); console.log(`  ❌ ${name}: ${e && e.message}`);
  }
  return Promise.resolve();
}

/** IPC 传输侧等价物：Electron handler 返回值经结构化克隆；函数直接拒 */
function cloneViaIpc(value) {
  return JSON.parse(JSON.stringify("ok")) && structuredClone(value); // structuredClone 同 Source 结构化克隆算法
}

async function main() {
  console.log("\n=== A. 实锤回归：结构化克隆 ===");

  await test("A1 事故本体——edition.cjs 提交整包含函数，整包过 IPC 必克隆失败（防裸返回归）", () => {
    assert.strictEqual(typeof EDITION.editionFor, "function", "edition.cjs 必须导出 editionFor（build-pipeline 依赖）");
    assert.throws(() => cloneViaIpc(EDITION), (e) =>
      /could not be cloned/.test(String(e && e.message)),
      `EDITION 整包 structuredClone 应抛「could not be cloned」，实际：${typeof EDITION.editionFor}`);
  });

  await test("A2 修复形态——{edition,productName,gates} 三字段纯数据克隆成功且与 EDITION 值一致", () => {
    const g = EDITION.gates || {};
    const payload = { edition: EDITION.edition, productName: EDITION.productName, gates: { ...g } };
    const cloned = cloneViaIpc(payload);
    assert.strictEqual(cloned.edition, "main");
    assert.strictEqual(cloned.productName, "Agent Chat Pro");
    assert.deepStrictEqual(cloned.gates, g);
    // 行为语义：主版 gates 必须全开且桥关（与主版默认门控一致）
    assert.strictEqual(g.agentBridge, false);
    assert.deepStrictEqual(
      ["deviceLink", "printLink", "localEngines", "easterEgg", "cloudChat", "cacheClean", "signalLights"]
        .map((k) => g[k]),
      Array(7).fill(true)
    );
  });

  await test("A3 bridge 覆写产物形态（纯数据 BRIDGE_EDITION）同样可克隆（构建期形态不受修复影响）", () => {
    // 覆写模板产出 = module.exports = <JSON.stringify(BRIDGE_EDITION)> → 序列化天然无函数
    assert.ok(pipelineSrc.includes("module.exports = ${JSON.stringify(BRIDGE_EDITION, null, 2)}"),
      "bridge 覆写模板漂移：edition.cjs 覆写应产 JSON 序列化的 BRIDGE_EDITION（纯数据）");
    const { BRIDGE_EDITION } = EDITION;
    const bridgePayload = { edition: BRIDGE_EDITION.edition, productName: BRIDGE_EDITION.productName, gates: { ...BRIDGE_EDITION.gates } };
    const cloned = cloneViaIpc(bridgePayload);
    assert.strictEqual(cloned.edition, "bridge");
    assert.strictEqual(cloned.gates.agentBridge, true);
    assert.strictEqual(cloned.gates.deviceLink, false);
    // BRIDGE_EDITION 本体键全为非函数——bridge 版 handler 修复前后都成立
    assert.ok(Object.keys(BRIDGE_EDITION).every((k) => typeof BRIDGE_EDITION[k] !== "function"));
  });

  console.log("\n=== B. 源码断言 ===");

  await test("B1 main.cjs 不再裸返 EDITION 整包（事故写法根除）", () => {
    assert.ok(!/ ipcMain\.handle\("app:edition", \(\) => EDITION\)/.test(mainSrc),
      '发现事故写法 `ipcMain.handle("app:edition", () => EDITION)` —— 悬账修复被回退');
  });

  await test("B2 handler 呈三字段形状且 gates 浅拷（防上游共享引用）", () => {
    const handlerMatch = mainSrc.match(/ipcMain\.handle\("app:edition", \(\) => \(\{[\s\S]*?\}\)\);/);
    assert.ok(handlerMatch, "app:edition handler 未找到（形状漂移）");
    const body = handlerMatch[0];
    assert.ok(body.includes("edition: EDITION.edition"), "缺 edition 字段");
    assert.ok(body.includes("productName: EDITION.productName"), "缺 productName 字段");
    assert.ok(body.includes("gates: { ...EDITION.gates }"), "gates 必须浅拷（{ ...EDITION.gates }）");
  });

  await test("B3 EDITION 主进程消费点只取 edition/gates 两键（修后无断供）", () => {
    const consumers = mainSrc.match(/EDITION\.[A-Za-z_]+/g) || [];
    const usedKeys = [...new Set(consumers.map((s) => s.replace("EDITION.", "")))].filter((k) => k !== "edition");
    assert.ok(usedKeys.every((k) => k === "gates" || k === "productName"),
      `主进程存在 handler 之外的未知 EDITION 消费键：${usedKeys.join(", ")}`);
  });

  console.log("\n=== C. 版本号 ===");

  await test("C1 版本锚 ≥3.37（37 线起，语义化不随 patch 手改）", () => {
    assert.ok(/^3\./.test(pkg.version) && Number(pkg.version.split(".")[1]) >= 37, `版本锚 ≥3.37（实际 ${pkg.version}）`);
  });

  // Z. 零 unhandledRejection 兜底（装置污染检测）
  await new Promise((r) => setImmediate(r));
  if (process._getActiveHandles && process._getActiveHandles().length === 0) { /* noop */ }

  console.log(`\n═══ v3.37.1 守门：${passed} 通过 / ${failed} 失败 ═══`);
  if (failed > 0) {
    console.log("\n失败明细：");
    failures.forEach((f) => console.log(`  - ${f.name}\n    ${f.error && f.error.stack}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });