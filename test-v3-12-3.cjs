"use strict";
/**
 * v3.12.3 测试 — N2N 传输模式自动兼容（UDP 失败自动降级 TCP -S2）
 * 背景：NAS supernode 经 FRP TCP 隧道（entry.example.org:0）暴露公网入口，
 *       UDP 包无法进入 TCP 隧道 → edge 默认 UDP 模式连不上 → 需 -S2 TCP 模式。
 *       用户要求自动兼容：UDP 失败自动降级 TCP，成功模式按入口缓存。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const N2N_PATH = path.join(ROOT, "src", "main", "network", "n2n-mesh.cjs");
const { N2nMeshTransport } = require(N2N_PATH);

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${fn.name || "case"}`); })
    .catch((e) => {
      failed++;
      failures.push(`${e.message}`);
      console.log(`  ✗ ${e.message}`);
    });
}

async function main() {
  console.log("=== v3.12.3 N2N 自动兼容测试 ===\n");
  const src = fs.readFileSync(N2N_PATH, "utf8");

  // ── 1. 接线断言：自动兼容核心要素 ─────────────────
  await test("has MODE_CACHE", () => {
    assert.ok(src.includes("const MODE_CACHE = new Map()"), "缺少 MODE_CACHE 定义");
  });
  await test("tcp mode pushes -S2", () => {
    assert.ok(src.includes('"-S2"'), "缺少 -S2 参数");
    assert.ok(/isTcp.*\n?\s*args\.push\("-S2"\)/.test(src) || src.includes('args.push("-S2")'), "-S2 未条件挂载");
  });
  await test("udp->tcp fallback order", () => {
    assert.ok(src.includes('["udp", "tcp"]'), "缺少双模式顺序数组");
  });
  await test("cached tcp skips udp", () => {
    assert.ok(src.includes('cached === "tcp" ? ["tcp"]'), "缓存 tcp 未跳过 UDP");
  });
  await test("udp attempts reduced (8) vs tcp (15)", () => {
    assert.ok(src.includes("? 15 : 8"), "缺少双阶段轮询次数参数化");
  });
  await test("fallback log hooks", () => {
    for (const ev of ["n2n_mesh_mode_attempt", "n2n_mesh_udp_fallback_tcp", "n2n_mesh_udp_attempt_failed", "n2n_mesh_mode_cached"]) {
      assert.ok(src.includes(`"${ev}"`), `缺少日志埋点 ${ev}`);
    }
  });
  await test("combined dual-mode error preserved by friendlyError", () => {
    assert.ok(src.includes("/已自动尝试 UDP 和 TCP/"), "friendlyError 未保留双模式结论原文");
  });
  await test("ssh stage not switching mode", () => {
    // _createSshOverN2n 的失败应独立处理（不在 _establishN2nNetwork 循环内）
    const defIdx = src.indexOf("async _establishN2nNetwork(");
    const sshIdx = src.indexOf("_createSshOverN2n");
    assert.ok(defIdx > -1 && sshIdx > -1, "关键方法缺失");
    const methodEnd = src.indexOf("\n  }", defIdx);
    const establishBody = src.slice(defIdx, methodEnd);
    assert.ok(!establishBody.includes("_createSshOverN2n"), "SSH 阶段被卷入模式循环");
    // connect 主流程：先建立网络，后 SSH（顺序断言）
    const callEstablish = src.indexOf("await this._establishN2nNetwork(");
    const callSsh = src.indexOf("await this._createSshOverN2n(");
    assert.ok(callEstablish > -1 && callSsh > callEstablish, "SSH 阶段应在网络建立之后");
  });
  await test("edge process cleanup between modes", () => {
    // 模式切换前必须 kill 上一个失败 edge，避免残留进程占 tun
    assert.ok(/if \(isTcp\) \{[\s\S]*?已自动尝试 UDP 和 TCP/.test(src), "TCP 终态抛错缺失");
    assert.ok(src.includes('this._edgeProcess.kill("SIGTERM")'), "模式切换未清理旧 edge 进程");
  });

  // ── 2. 行为冒烟 ──────────────────────────────────
  await test("module loads and instantiates", () => {
    const t = new N2nMeshTransport();
    assert.strictEqual(t.type, "n2n-mesh");
  });
  await test("connect rejects without supernodeAddr", async () => {
    const t = new N2nMeshTransport();
    await assert.rejects(
      () => t.connect({ n2n: {}, host: "10.0.0.1", port: 22 }),
      /超级节点地址未配置/
    );
  });
  await test("connect rejects without community", async () => {
    const t = new N2nMeshTransport();
    await assert.rejects(
      () => t.connect({ n2n: { supernodeAddr: "entry.example.org", supernodePort: 53371 }, host: "10.0.0.1" }),
      /社区名未配置/
    );
  });
  await test("friendlyError passthrough for dual-mode summary", () => {
    const t = new N2nMeshTransport();
    const msg = t._friendlyError(new Error("N2N 虚拟网络就绪失败（已自动尝试 UDP 和 TCP 两种模式）。原因：x"));
    assert.ok(msg.includes("已自动尝试 UDP 和 TCP"), "双模式结论被改写");
  });
  await test("waitForNetworkReady default attempts = 15", () => {
    // 参数化默认值保持向后兼容（原 15 次）
    assert.ok(/maxAttempts = 15\)/.test(src) || src.includes("maxAttempts = 15"), "默认轮询次数应保持 15");
  });

  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  if (failed > 0) {
    console.log(failures.join("\n"));
    process.exit(1);
  }
}

main();