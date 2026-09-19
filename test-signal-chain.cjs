"use strict";

/**
 * 信号系统冒烟测试（v3.7.0 — 模块化架构接线自 Agent Orbit 0.9.6）
 *
 * 验证：
 *   1. module-contract 模块定义校验（白名单 ID + 冻结）
 *   2. module-registry 注册与获取
 *   3. signal-contract 四阶段主链（cloud / ssh 模式）gate 全绿
 *   4. light-strip 16 盏灯投影（transition / completeRound / snapshot / 红灯冻结）
 *   5. settings-save / tool-permission / bridge-action 等八小流创建
 *   6. runnerOperation promise 三态（成功 finish / cancelled 灰灯 / 失败红灯）
 *   7. cloud 模式适配（normalizeConnectionMode / normalizeRunner）
 */

const assert = require("assert");
const { MODULE_IDS, assertModuleDefinition, normalizeCapabilities } = require("./src/main/modules/foundation/module-contract.cjs");
const { createModuleRegistry } = require("./src/main/modules/foundation/module-registry.cjs");
const { createConversationClaudeSignalMonitor, normalizeConnectionMode, normalizeRunner } = require("./src/main/modules/foundation/signal-contract/signal-chain.cjs");
const { createSignalLightStrip, LIGHT_STRIP_PROJECTION_CONTRACT } = require("./src/main/modules/foundation/signal-contract/light-strip.cjs");

let pass = 0;
let fail = 0;
const results = [];
function test(name, fn) {
  try {
    const outcome = fn();
    if (outcome && typeof outcome.then === "function") {
      return outcome.then(
        () => { pass += 1; results.push(`  ✅ ${name}`); },
        (error) => { fail += 1; results.push(`  ❌ ${name}\n     ${error.message}`); }
      );
    }
    pass += 1;
    results.push(`  ✅ ${name}`);
  } catch (error) {
    fail += 1;
    results.push(`  ❌ ${name}\n     ${error.message}`);
  }
  return Promise.resolve();
}

// ── 1. module-contract ──
test("模块 ID 白名单包含 foundation/status/conversation/agent", () => {
  assert.deepStrictEqual([...MODULE_IDS], ["foundation", "status", "conversation", "agent"]);
});
test("合法模块定义通过校验并冻结", () => {
  const def = assertModuleDefinition({ id: "foundation", label: "软件底座与扩展框架", version: 1, capabilities: ["electron", "ipc"] });
  assert.strictEqual(def.id, "foundation");
  assert.ok(Object.isFrozen(def));
});
test("非法模块 ID 被拒绝", () => {
  assert.throws(() => assertModuleDefinition({ id: "hacker", label: "x" }), /模块标识无效/);
});
test("normalizeCapabilities 过滤未知能力", () => {
  assert.deepStrictEqual(normalizeCapabilities(["electron", "bogus", "ipc"]), ["electron", "ipc"]);
});

// ── 2. module-registry ──
test("module-registry 注册并可获取", () => {
  const registry = createModuleRegistry();
  registry.register({ id: "status", label: "状态监控中心", version: 1 });
  const fetched = registry.get("status");
  assert.strictEqual(fetched.label, "状态监控中心");
});
test("module-registry 重复注册被拒绝", () => {
  const registry = createModuleRegistry();
  registry.register({ id: "foundation", label: "a" });
  assert.throws(() => registry.register({ id: "foundation", label: "b" }));
});

// ── 3. 四阶段主链 ──
async function driveChain(mode) {
  const log = [];
  const monitor = createConversationClaudeSignalMonitor({
    enabled: true,
    writeLog: (channel, entry) => log.push({ channel, ...entry }),
    onTransition: () => {},
    onRoundComplete: () => {}
  });
  const chain = monitor.createRequest({ requestId: `smoke:${mode}:1`, conversationId: "conv-1", connectionMode: mode, attachmentCount: 0, hasSession: false });
  chain.turnReceived();
  chain.turnToTransport({});
  chain.transportReceived({});
  chain.transportToAdapter({});
  chain.adapterReceived({});
  chain.adapterToRunner({});
  chain.runnerReceived({});
  chain.runnerOperation({ promise: Promise.resolve({ text: "ok" }) });
  // runner gate 在 promise settle 后才 finish（与 main.cjs 的 await 顺序一致）
  await new Promise((resolve) => setImmediate(resolve));
  const complete = chain.complete({});
  // ensureHealthy 语义：有红灯即 throw，否则返回 undefined（不抛 = 健康）
  return { chain, complete, checkHealthy: () => chain.healthy(), results: chain.results() };
}
test("cloud 模式四阶段链 gate 全绿", async () => {
  const { checkHealthy, results } = await driveChain("cloud");
  assert.doesNotThrow(checkHealthy, "healthy 不应抛异常");
  const reds = results.filter((r) => r.light === "red");
  assert.strictEqual(reds.length, 0, `不应有红灯：${JSON.stringify(reds)}`);
  const greens = results.filter((r) => r.light === "green");
  assert.strictEqual(greens.length, 5, `四阶段 + 灯带 complete-round 应全绿：${JSON.stringify(results)}`);
});
test("ssh 模式四阶段链 gate 全绿", async () => {
  const { checkHealthy } = await driveChain("ssh");
  assert.doesNotThrow(checkHealthy, "healthy 不应抛异常");
});
test("cloud 模式归一化：connectionMode=cloud → runner=cloud-direct", () => {
  assert.strictEqual(normalizeConnectionMode("cloud"), "cloud");
  assert.strictEqual(normalizeRunner("cloud"), "cloud-direct");
});
test("ssh/local/非法值归一化正确", () => {
  assert.strictEqual(normalizeConnectionMode("ssh"), "ssh");
  assert.strictEqual(normalizeConnectionMode("local"), "local");
  assert.strictEqual(normalizeConnectionMode("bogus"), "ssh");
  assert.strictEqual(normalizeRunner("ssh"), "remote-runner");
  assert.strictEqual(normalizeRunner("local"), "local-runner");
});

// ── 4. light-strip ──
test("灯带投影契约版本为 2、16 盏灯", () => {
  assert.strictEqual(LIGHT_STRIP_PROJECTION_CONTRACT.version, 2);
  assert.strictEqual(LIGHT_STRIP_PROJECTION_CONTRACT.lampCount, 16);
});
test("transition 橙→绿投影 + completeRound 清灯", () => {
  let published = null;
  const strip = createSignalLightStrip({ publish: (payload) => { published = payload; }, writeFault: () => {}, visibleTransitionMs: 0, successHoldMs: 0 });
  strip.transition({ requestId: "smoke:ls:conversation.turn-orchestrator:submit", moduleId: "conversation.turn-orchestrator", operation: "submit", phase: "", light: "orange", startedAt: 1 });
  strip.transition({ requestId: "smoke:ls:conversation.turn-orchestrator:submit", moduleId: "conversation.turn-orchestrator", operation: "submit", phase: "", light: "green", completedAt: 2 });
  strip.completeRound("smoke:ls");
  assert.ok(published && Array.isArray(published.lights) && published.lights.length === 16);
});
test("红灯写入故障日志并冻结灯带", () => {
  const faults = [];
  const strip = createSignalLightStrip({ publish: () => {}, writeFault: (entry) => faults.push(entry), visibleTransitionMs: 0 });
  strip.transition({ requestId: "smoke:ls:agent.claude.remote-runner:run", moduleId: "agent.claude.remote-runner", operation: "run", phase: "", light: "red", error: { code: "X" } });
  assert.ok(faults.length === 1, "应写入故障日志");
  const snap = strip.snapshot();
  assert.strictEqual(snap.frozen, true, "红灯后灯带应冻结");
  assert.strictEqual(snap.repairPending, true, "红灯后维修灯应挂起");
});

// ── 5. 八大 flow 创建 ──
test("八大 flow（settings/permission/model/device/bridge/conversation/artifact）可创建", () => {
  const monitor = createConversationClaudeSignalMonitor({ enabled: true, writeLog: () => {}, onTransition: () => {}, onRoundComplete: () => {} });
  const flows = [
    monitor.createSettingsSave({ requestId: "f1", connectionMode: "ssh", directoryChanged: false }),
    monitor.createToolPermission({ requestId: "f2", automatic: true }),
    monitor.createModelUpdate({ requestId: "f3", model: "glm-4-flash" }),
    monitor.createDeviceAction({ requestId: "f4", action: "install" }),
    monitor.createBridgeAction({ requestId: "f5", action: "install" }),
    monitor.createConversationManagement({ requestId: "f6", action: "archive" }),
    monitor.createArtifactAction({ requestId: "f7", action: "download" })
  ];
  for (const flow of flows) assert.ok(flow && typeof flow === "object", "flow 应存在");
});

// ── 6. runnerOperation promise 三态 ──
test("runnerOperation promise 成功 → runner 绿灯", async () => {
  const monitor = createConversationClaudeSignalMonitor({ enabled: true, writeLog: () => {}, onTransition: () => {}, onRoundComplete: () => {} });
  const chain = monitor.createRequest({ requestId: "smoke:ro:1", conversationId: "c", connectionMode: "cloud", attachmentCount: 0, hasSession: false });
  chain.turnReceived(); chain.turnToTransport({}); chain.transportReceived({}); chain.transportToAdapter({}); chain.adapterReceived({}); chain.adapterToRunner({}); chain.runnerReceived({});
  chain.runnerOperation({ promise: Promise.resolve({ text: "ok" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const runnerResult = chain.results().find((r) => String(r.requestId || "").includes("agent.claude.runner"));
  assert.ok(runnerResult && runnerResult.light !== "red", "runner 不应红灯");
});
test("runnerOperation promise reject cancelled → 灰灯（gate.cancel）", async () => {
  const monitor = createConversationClaudeSignalMonitor({ enabled: true, writeLog: () => {}, onTransition: () => {}, onRoundComplete: () => {} });
  const chain = monitor.createRequest({ requestId: "smoke:ro:2", conversationId: "c", connectionMode: "cloud", attachmentCount: 0, hasSession: false });
  chain.turnReceived(); chain.turnToTransport({}); chain.transportReceived({}); chain.transportToAdapter({}); chain.adapterReceived({}); chain.adapterToRunner({}); chain.runnerReceived({});
  chain.runnerOperation({ promise: Promise.reject({ cancelled: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  const runnerResult = chain.results().find((r) => String(r.requestId || "").includes("agent.claude.runner"));
  assert.ok(runnerResult && runnerResult.light !== "red", "cancelled 不应红灯（应走灰灯）");
});
test("runnerOperation promise reject 普通 error → 红灯", async () => {
  const monitor = createConversationClaudeSignalMonitor({ enabled: true, writeLog: () => {}, onTransition: () => {}, onRoundComplete: () => {} });
  const chain = monitor.createRequest({ requestId: "smoke:ro:3", conversationId: "c", connectionMode: "cloud", attachmentCount: 0, hasSession: false });
  chain.turnReceived(); chain.turnToTransport({}); chain.transportReceived({}); chain.transportToAdapter({}); chain.adapterReceived({}); chain.adapterToRunner({}); chain.runnerReceived({});
  chain.runnerOperation({ promise: Promise.reject(new Error("boom")) });
  await new Promise((resolve) => setImmediate(resolve));
  const runnerResult = chain.results().find((r) => String(r.requestId || "").includes("agent.claude.runner"));
  assert.ok(runnerResult && runnerResult.light === "red", "普通 error 应红灯");
});

// ── 7. signal:lights:get IPC 快照契约 ──
test("signalLights.snapshot() 返回 16 盏灯 + repairPending + frozen", () => {
  let snapshotPayload = null;
  const strip = createSignalLightStrip({ publish: (payload) => { snapshotPayload = payload; }, writeFault: () => {} });
  const snap = strip.snapshot();
  assert.ok(snap.lights.length === 16 && typeof snap.repairPending === "boolean" && typeof snap.frozen === "boolean");
  assert.ok(snapshotPayload === null, "snapshot 不触发 publish");
});

// 等全部（含 async）测试完成后汇总
setImmediate(() => {
  console.log("🧪 信号系统冒烟测试（v3.7.0 模块化架构）\n" + results.join("\n") + `\n==================================================\n📊 测试结果: ${pass} 通过, ${fail} 失败, 共 ${pass + fail} 项`);
  if (fail > 0) {
    console.log("❌ 存在失败项！");
    process.exit(1);
  }
  console.log("✅ 所有信号系统测试通过！四阶段主链 + 灯带投影 + 八大 flow 全绿。");
});