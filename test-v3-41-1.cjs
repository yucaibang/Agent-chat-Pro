"use strict";
/**
 * v3.41.1 守门测试 — 群聊云端成员全静默「没响应」根因修复
 *
 * 背景：用户群发广播后云端 3 成员零反应（零 lifecycle/零 cloud_chat_request/零失败落库），
 *       SSH 成员正常、单聊正常。根因=workgroup-chat.cjs 原 118 行
 *       `await ctx.deps.getMode(input.workModeId).catch(() => null)`——mode-manager 的 getMode
 *       是同步函数（返回对象无 .catch），workModeId 非空（渲染层恒传）恒炸 TypeError，
 *       且炸点在函数 try 块之外 → 被 startCloud 兜底 catch 纯静默吞掉。v3.26.0 起潜伏至今。
 * 覆盖：
 *   A. 行为真跑（require.cache 注入 mock 依赖 + require 真实 workgroup-chat.cjs）：
 *      A1 生产形态（真同步 getMode + workModeId 非空）→ 云端轮走通（修复点回归网核心）
 *      A2 getMode 异步 reject → 兜成 null，轮仍走通
 *      A3 getMode 同步 throw → 兜成 null，轮仍走通
 *      A4 getConversation 前置炸 → startCloud 兜底产出 failed turn + group-agent-failed 事件 + 失败落库（不再静默）
 *   B. 接线断言（源代码静态）：
 *      B1 118 行不再对 getMode 挂 .catch（防改回去翻红）
 *      B2 startCloud 兜底含 group-agent-failed + 失败落库
 *      B3 startRunner 兜底同款补漏
 *      B4 单聊对照仍在位（main.cjs 双保险形态不被误改）
 *   C. 版本号 ≥ 3.41.1（宽松惯例：写死版本会在下次 bump 翻红本测试）
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const wgPath = path.join(ROOT, "src/main/workgroup-chat.cjs");
const wgSrc = fs.readFileSync(wgPath, "utf8");
const mainSrc = read("src/main/main.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

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

// ════════════════ A. 行为真跑（mock 注入 + 真实代码） ════════════════
const MAIN = path.join(ROOT, "src/main");

let cloudChatCalls = 0;
const ledger = [];      // 落库/事件记录
const events = [];      // 事件记录（chat:event / chat:group-delta）

const stubs = {
  "settings.cjs": {
    getSettings: () => ({}),
    getCloudAiConfig: () => ({ maxTokens: 8192, proxy: "", toolsEnabled: false }),
    getConnection: () => ({ dataDirectory: "" }),
    switchSshProfile: async () => ({}),
    getAtomcodeToken: async () => "",
  },
  "cloud-chat.cjs": {
    sendCloudChat: async (config, messages, callbacks) => {
      cloudChatCalls += 1;
      callbacks.onDelta("（守门 mock 回复）");
      return { text: "（守门 mock 回复）", usage: { prompt: 1, completion: 1, total: 2, requests: 1 } };
    },
    accumulateUsage: (total, usage) => { if (usage) { total.prompt += usage.prompt || 0; total.total += usage.total || 0; total.requests += usage.requests || 0; } },
  },
  "cloud-tools.cjs": {
    toolDefinitions: () => [],
    executeToolCall: async () => "",
    ASK_USER_HINT: "", ASK_USER_TIMEOUT: "__timeout__", ASK_USER_STOPPED: "__stopped__",
  },
  "agent-pool.cjs": {
    resolveGroupAgents: () => ({
      group: { id: "wg-test", name: "守门群", members: [], maxTurns: 10 },
      agents: [{ kind: "cloud", agentId: "ap-test", name: "大肥？", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" }],
    }),
    read: () => ({ nodes: [], workgroups: [] }),
  },
  "repetition-guard.cjs": { collapseRepetition: (t) => ({ collapsed: false, text: t }) },
  "plan-convention.cjs": { appendPlanConvention: (s) => s },
  "ssh.cjs": { runClaude: async () => "", runCodexCli: async () => "", runQwenCli: async () => "", runHermesCli: async () => "" },
  "local.cjs": { runLocalClaude: async () => "" },
  "daemon-chat.cjs": { runAtomCodeChat: async () => "" },
  "custom-cli.cjs": { runCustomCli: async () => "" },
};

for (const [file, exports_] of Object.entries(stubs)) {
  const abs = path.join(MAIN, file);
  const m = new Module(abs, null);
  m.filename = abs;
  m.loaded = true;
  m.exports = exports_;
  require.cache[abs] = m;
}

const wg = require(wgPath);
assert.strictEqual(typeof wg.runCloudMemberTurn, "function", "workgroup-chat.cjs 导出形态变化");
assert.strictEqual(typeof wg.runGroupTurn, "function", "workgroup-chat.cjs 导出形态变化");

/** 生产形态同步 getMode（mode-manager 46 行起为同步函数，直返对象） */
const realSyncGetMode = (id) => {
  if (id === "automatic" || id === "regular") return { id, name: id, systemPrompt: `（内置模式 ${id}）` };
  return null;
};

const conversationShape = {
  id: "conv-guard",
  messages: [
    { role: "user", text: "各位在吗？" },
    { role: "assistant", text: "在的。", agent: { id: "ap-ssh", name: "三肥鱼的老板" } },
  ],
};

function makeDeps(overrides = {}) {
  cloudChatCalls = 0;
  ledger.length = 0;
  events.length = 0;
  return Object.assign({
    getConversation: async () => conversationShape,
    getMode: realSyncGetMode,
    groupTools: () => ({ enabled: false, allowCommand: false, workdir: "", environmentText: "" }),
    saveAssistantDraft: () => {},
    activeRequests: new Map(),
    addAssistantMessage: (cid, text) => ledger.push(`落库[${String(text).slice(0, 60)}]`),
    askUserRegistry: { wait: async () => "__timeout__" },
    executeToolCall: async () => "",
    sender: { send: (ch, payload) => events.push(`${ch}:${payload?.type || payload?.text || ""}`) },
    log: () => {},
  }, overrides);
}

const group = { id: "wg-test", name: "守门群", members: [], maxTurns: 10 };
const rosterNames = ["大肥？", "三肥鱼的老板"];
const cloudAgent = { agentId: "ap-test", name: "大肥？", kind: "cloud", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" };

async function runUnitTests() {
  await test("A1. 生产形态：真同步 getMode + workModeId 非空 → 云端轮走通（根因回归网核心）", async () => {
    const ctx = {
      deps: makeDeps(),
      log: () => {},
      emit: (rid, ev) => events.push(ev.type),
      emitDelta: (rid, text) => events.push("delta"),
      emitSub: () => {},
    };
    const turn = await wg.runCloudMemberTurn(ctx, cloudAgent, { requestId: "r-A1", conversationId: "conv-guard", workModeId: "automatic" }, group, rosterNames);
    assert.strictEqual(cloudChatCalls, 1, "sendCloudChat 应被调用 1 次");
    assert.strictEqual(turn.failed, undefined, "轮不应失败");
    assert.ok(turn.text && turn.text.includes("守门 mock 回复"), "轮应有正文");
    assert.ok(events.includes("lifecycle"), "应发出 lifecycle started");
  });

  await test("A2. getMode 异步 reject → 兜成 null，轮仍走通", async () => {
    const ctx = {
      deps: makeDeps({ getMode: async () => { throw new Error("（注入）模式读取失败"); } }),
      log: () => {}, emit: (rid, ev) => events.push(ev.type), emitDelta: () => {}, emitSub: () => {},
    };
    const turn = await wg.runCloudMemberTurn(ctx, cloudAgent, { requestId: "r-A2", conversationId: "conv-guard", workModeId: "automatic" }, group, rosterNames);
    assert.strictEqual(cloudChatCalls, 1, "getMode 失败不应掐断云端轮");
    assert.strictEqual(turn.failed, undefined, "轮不应失败");
  });

  await test("A3. getMode 同步 throw（防御面）→ 兜成 null，轮仍走通", async () => {
    const ctx = {
      deps: makeDeps({ getMode: () => { throw new Error("（注入）同步炸"); } }),
      log: () => {}, emit: (rid, ev) => events.push(ev.type), emitDelta: () => {}, emitSub: () => {},
    };
    const turn = await wg.runCloudMemberTurn(ctx, cloudAgent, { requestId: "r-A3", conversationId: "conv-guard", workModeId: "automatic" }, group, rosterNames);
    assert.strictEqual(cloudChatCalls, 1, "getMode 同步炸不应掐断云端轮");
    assert.strictEqual(turn.failed, undefined, "轮不应失败");
  });

  await test("A4. getConversation 前置炸 → startCloud 兜底产出 failed turn + 可见事件 + 失败落库（静默吞错修复回归）", async () => {
    const outcome = await wg.runGroupTurn(makeDeps({
      getConversation: () => { throw new Error("（守门注入）前置步骤炸"); },
    }), {
      conversationId: "conv-guard", workgroupId: "wg-test", message: "各位在吗？",
      mentionedAgentIds: [], autoDiscuss: false, maxTurns: 0, workModeId: "automatic",
    });
    // runGroupTurn 返回的 turns 是占位数组（轮 Promise 终态在 groupTurns Map，经 awaitGroupTurn 取）
    const finalTurn = await wg.awaitGroupTurn(outcome.turns[0].requestId);
    assert.strictEqual(finalTurn.failed, true, "兜底应产出 failed turn");
    assert.ok(finalTurn.error && finalTurn.error.message.includes("（守门注入）前置步骤炸"), "turn.error 应带原始错误信息");
    assert.ok(events.some((e) => e.includes("group-agent-failed")), "应发出 group-agent-failed 事件");
    assert.ok(ledger.some((t) => t.includes("本轮失败")), "应失败落库（不再静默）");
  });
}

// ════════════════ B. 接线断言（源代码静态） ════════════════
async function runWireTests() {
  await test("B1. 云端轮 getMode 不再挂 .catch（防修改回退）", () => {
    assert.ok(!wgSrc.includes("getMode(input.workModeId).catch"), "原炸弹形态 `.catch(() => null)` 必须保持移除");
    assert.ok(wgSrc.includes("try { return await ctx.deps.getMode(input.workModeId); }"), "双保险形态应在位");
  });

  await test("B2. startCloud 兜底含 group-agent-failed + 失败落库", () => {
    assert.ok(wgSrc.includes("轮 Promise 永不 reject"), "兜底注释应在位");
    // 锚定 startCloud 调用点（带展开参数），避免命中 115 行的函数定义行；固定窗口取兜底块全文
    const idx = wgSrc.indexOf("runCloudMemberTurn(ctx, agent, { ...input, requestId }, group, rosterNames)");
    assert.ok(idx >= 0, "startCloud 调用点应可定位");
    const seg = wgSrc.slice(idx, idx + 1400);
    assert.ok(seg.includes("group-agent-failed"), "兜底应 emit group-agent-failed");
    assert.ok(seg.includes("本轮失败"), "兜底应失败落库");
    assert.ok(seg.includes("} catch { /* 落库/事件失败不反杀兜底 */ }"), "副作用应再包一层防二次 reject");
  });

  await test("B3. startRunner 兜底同款补漏", () => {
    const idx = wgSrc.indexOf("runRunnerMemberTurn(ctx, agent, { ...input, requestId }, group)");
    assert.ok(idx >= 0, "startRunner 调用点应可定位");
    const seg = wgSrc.slice(idx, idx + 1400);
    assert.ok(seg.includes("group-agent-failed") && seg.includes("本轮失败"), "runner 兜底应同款可见");
  });

  await test("B4. 单聊对照仍在位（main.cjs 双保险形态不被误改）", () => {
    assert.ok(mainSrc.includes("await (async () => { try { return await getMode(input.workModeId); } catch { return null; } })()"),
      "单聊 1164 双保险应保持原样");
  });
}

// ════════════════ C. 版本宽松 ════════════════
async function runVersionTests() {
  await test("C1. 版本号 ≥ 3.41.1", () => {
    const [a, b, c] = String(pkg.version).split(".").map(Number);
    assert.ok(a > 3 || (a === 3 && b > 41) || (a === 3 && b === 41 && c >= 1),
      `package.json version 应 ≥ 3.41.1，实际 ${pkg.version}`);
  });
}

(async () => {
  console.log("=== test-v3-41-1.cjs：群聊云端成员静默死修复守门 ===");
  await runUnitTests();
  await runWireTests();
  await runVersionTests();
  console.log(`=== test-v3-41-1.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) {
    for (const f of failures) console.error(`  详情: ${f}`);
    process.exit(1);
  }
})();