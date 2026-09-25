"use strict";
/**
 * v3.15.4 回归测试 — 外网连接方式短名归一化
 * 背景：设置页「外网连接方式」下拉存的短名（derp/frp/p2p/n2n）未归一化直接传入
 *   _createTransport（只认全名 n2n-mesh 等），导致显式选「N2N 虚拟局域网」等四个选项
 *   连接时抛「未知的传输类型：n2n」（network:connect 失败，外网/N2N 模式不可用）。
 *   仅 auto（走 FALLBACK_ORDER 全名数组）幸免。
 * 修复：_connectExternal 入口 METHOD_ALIASES 归一化（短名→全名，历史全名配置原样兼容）。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const NM_PATH = path.join(ROOT, "src", "main", "network", "network-manager.cjs");
const INDEX_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PACKAGE_PATH = path.join(ROOT, "package.json");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((error) => {
      failed++;
      failures.push(`${name}: ${error.message}`);
      console.log(`  ✗ ${name}: ${error.message}`);
    });
}

const nmSrc = fs.readFileSync(NM_PATH, "utf8");
const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
const nm = require(NM_PATH);

async function runTests() {
  // ── 归一化映射 ──
  await test("METHOD_ALIASES 导出且四个短名映射正确", () => {
    assert.deepStrictEqual(nm.METHOD_ALIASES, {
      derp: "derp-relay", frp: "frp-tunnel", p2p: "p2p-nat", n2n: "n2n-mesh"
    });
  });
  await test("_connectExternal 入口已接入归一化", () => {
    assert.ok(nmSrc.includes("METHOD_ALIASES[rawMethod] || rawMethod"), "归一化表达式缺失");
    assert.ok(nmSrc.includes("const rawMethod = config.externalMethod"), "rawMethod 取值缺失");
   });
  await test("归一化后短名不再流入 _createTransport（全名 switch 不再收到裸短名）", () => {
    const block = nmSrc.slice(nmSrc.indexOf("_connectExternal"), nmSrc.indexOf("_methodLabel"));
    assert.ok(!/attempts = method === "auto"\s*\?\s*FALLBACK_ORDER\s*:\s*\[config\.externalMethod/.test(block), "仍直接使用 config.externalMethod");
    assert.ok(block.includes(": [method]"), "attempts 应使用归一化后的 method");
  });
  await test("全名历史配置原样兼容（METHOD_ALIASES 无全名键，靠 || rawMethod 透传）", () => {
    for (const full of ["ssh-direct", "frp-tunnel", "derp-relay", "p2p-nat", "n2n-mesh"]) {
      assert.strictEqual(nm.METHOD_ALIASES[full], undefined, `${full} 不应被映射改写`);
    }
    const raw = "n2n-mesh";
    assert.strictEqual(nm.METHOD_ALIASES[raw] || raw, "n2n-mesh");
  });
  await test("auto 仍走 FALLBACK_ORDER 降级链", () => {
    assert.deepStrictEqual(nm.FALLBACK_ORDER, ["p2p-nat", "derp-relay", "frp-tunnel"]);
    assert.ok(nmSrc.includes('? FALLBACK_ORDER'), "auto 降级链分支缺失");
  });

  // ── 五种传输类型全名可实例化 ──
  await test("_createTransport 五种全名均能实例化", () => {
    const manager = new nm.NetworkManager();
    const expected = {
      "ssh-direct": "SshDirectTransport",
      "frp-tunnel": "FrpTunnelTransport",
      "derp-relay": "DerpRelayTransport",
      "p2p-nat": "P2pNatTransport",
      "n2n-mesh": "N2nMeshTransport"
    };
    for (const [type, cls] of Object.entries(expected)) {
      const t = manager._createTransport(type);
      assert.strictEqual(t.constructor.name, cls, `${type} → ${cls} 失败`);
    }
  });
  await test("UI 下拉每个非 auto 选项都能被 METHOD_ALIASES 归一化为合法全名", () => {
    const selectBlock = indexSrc.slice(indexSrc.indexOf('id="external-method"'), indexSrc.indexOf("</select>", indexSrc.indexOf('id="external-method"')));
    const values = [...selectBlock.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(values.includes("n2n"), "UI 应有 n2n 选项");
    assert.ok(values.includes("auto"), "UI 应有 auto 选项");
    for (const v of values) {
      const normalized = nm.METHOD_ALIASES[v] || v;
      assert.ok(["auto", "ssh-direct", "frp-tunnel", "derp-relay", "p2p-nat", "n2n-mesh"].includes(normalized),
        `UI 选项 "${v}" 归一化后 "${normalized}" 不是合法传输类型`);
    }
  });

  // ── 版本号 ──
  await test("版本号 = 3.15.4（语义 ≥3.15.4 跟随）", () => {
    const rank = pkg.version.split(".").reduce((sum, part) => sum * 1000 + Number(part), 0);
    assert.ok(rank >= 31504, `版本 ${pkg.version} 应 ≥ 3.15.4`);
  });
}

(async () => {
  await runTests();
  console.log(`\n=== test-v3-15-4.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})();