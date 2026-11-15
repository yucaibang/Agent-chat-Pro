"use strict";
/**
 * test-v3-44-1.cjs —— v3.44.1 守门：群聊 @ 提及 + 自主讨论接力不轮转修复
 *
 * 用户实测（2026-11-15）：群聊 @ 某 AI 时，TA 输出完后下一轮不续接其他成员，
 * 而是同一成员继续输出雷同内容。根因=autoDiscuss 接力分支的 order 直接用 routeMembers
 * 过滤后的 route（@ 砍到单人 → i % order.length 恒指同一人，连说满 maxTurns 轮）。
 *
 * 修复语义（v3.44.1）：
 *   - @ 提及 + 自主讨论 = 被提及者优先发言，其余成员按工作组序续接（全群接力，上限 maxUtterances 不变）
 *   - @ 了不存在成员 = 广播兜底（全群按原序）
 *   - 未提及 = 全群按原序（回归不变）
 *   - 普通群发（非 autoDiscuss）+ @ = 定向单发（回归不变，仍走 routeMembers）
 *
 * 装置沿 test-v3-42-3（require.cache 注入 mock + 真实 workgroup-chat.cjs + waitFor + cloudSendHook）
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const wgPath = path.join(ROOT, "src/main/workgroup-chat.cjs");
const src = read("src/main/workgroup-chat.cjs");
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
      failures.push(`${name}: ${error.message}`);
      console.log(`  ✗ ${name}: ${error.message}`);
    });
}

// ════════════════ A. 行为真跑（沿 test-v3-42-3 装置） ════════════════
const MAIN = path.join(ROOT, "src/main");

const events = [];
const ledger = [];
let cloudCalls = 0;
let cloudSendHook = null;

const plainReply = (cbs, text) => { cbs.onDelta(text); return { text, usage: { prompt: 1, completion: 1, total: 2, requests: 1 } }; };

const stubs = {
  "settings.cjs": {
    getSettings: () => ({}),
    getCloudAiConfig: () => ({ maxTokens: 8192, proxy: "" }),
    getConnection: () => ({ dataDirectory: "" }),
    switchSshProfile: async () => ({}),
    getAtomcodeToken: async () => "",
  },
  "cloud-chat.cjs": {
    sendCloudChat: async (config, messages, callbacks) => {
      cloudCalls += 1;
      if (cloudSendHook) return cloudSendHook(config, messages, callbacks);
      return plainReply(callbacks, "（守门 mock 回复）");
    },
    accumulateUsage: (total, usage) => { if (usage) { total.requests += usage.requests || 0; } },
  },
  "cloud-tools.cjs": {
    toolDefinitions: () => [],
    executeToolCall: async () => "",
    ASK_USER_HINT: "", ASK_USER_TIMEOUT: "__timeout__", ASK_USER_STOPPED: "__stopped__",
  },
  "agent-pool.cjs": {
    resolveGroupAgents: () => ({
      group: { id: "wg-test", name: "守门群", members: [], maxTurns: 10 },
      agents: global.__poolAgents || [],
      ghosts: global.__poolGhosts || [],
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
assert.strictEqual(typeof wg.runGroupTurn, "function", "workgroup-chat.cjs 导出形态变化");
assert.strictEqual(typeof wg.routeMembers, "function", "routeMembers 导出应保留（普通群发定向单发仍用）");

const realSyncGetMode = (id) => (id === "automatic" || id === "regular" ? { id, name: id, systemPrompt: `（内置模式 ${id}）` } : null);

/** 三成员群（全云端）：大肥？ / 小肥鱼 / 老三 */
const threeMembers = [
  { kind: "cloud", agentId: "ap-a", name: "大肥？", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" },
  { kind: "cloud", agentId: "ap-b", name: "小肥鱼", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" },
  { kind: "cloud", agentId: "ap-c", name: "老三", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" },
];

function makeDeps(overrides = {}) {
  events.length = 0;
  ledger.length = 0;
  cloudCalls = 0;
  cloudSendHook = null;
  global.__poolGhosts = [];
  global.__poolAgents = null;
  return Object.assign({
    getConversation: async () => ({ id: "conv-guard", messages: [{ role: "user", text: "各位在吗？" }] }),
    getMode: realSyncGetMode,
    groupTools: () => ({ enabled: false, sandbox: false, allowCommand: false, workdir: "", environmentText: "" }),
    saveAssistantDraft: () => {},
    activeRequests: new Map(),
    addAssistantMessage: (cid, text) => ledger.push(`落库[${String(text).slice(0, 60)}]`),
    askUserRegistry: { wait: async () => "__timeout__" },
    sender: { send: (channel, payload) => events.push({ channel, payload }) },
    log: () => {},
  }, overrides);
}

async function waitFor(fn, timeoutMs = 2000, label = "条件") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (fn()) return; } catch { /* 条件未满足继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

const turnStartNames = () => events
  .filter((item) => item.payload?.type === "group-turn-start")
  .map((item) => item.payload?.turn?.name);

async function runSequential(input) {
  const deps = makeDeps();
  global.__poolAgents = threeMembers;
  const result = await wg.runGroupTurn(deps, { workgroupId: "wg-test", ...input });
  await waitFor(() => events.some((item) => item.payload?.type === "group-turn-settled"), 2000, "group-turn-settled");
  return { deps, result };
}

async function main() {
  console.log("\n═══ A. 行为真跑（接力编排）═══");

  await test("A1 @提及+自主讨论：被提及者优先，其余按组序续接，上限仍=maxTurns", async () => {
    await runSequential({
      conversationId: "c-a1", message: "@小肥鱼 谈谈你的看法", workModeId: "",
      autoDiscuss: true, maxTurns: 5, mentionedAgentIds: ["小肥鱼"],
    });
    // order=[小肥鱼,大肥？,老三] → 5 轮轮转：小肥鱼,大肥？,老三,小肥鱼,大肥？
    const order = turnStartNames();
    assert.deepStrictEqual(order, ["小肥鱼", "大肥？", "老三", "小肥鱼", "大肥？"],
      `接力顺序应为「提及优先+全群续接」，实为 ${JSON.stringify(order)}`);
    assert.ok(ledger.length >= 5, "5 轮都应落库");
  });

  await test("A2 @了不存在成员+自主讨论：广播兜底=全群按原序接力", async () => {
    await runSequential({
      conversationId: "c-a2", message: "@不存在的人 谈谈", workModeId: "",
      autoDiscuss: true, maxTurns: 4, mentionedAgentIds: ["不存在的人"],
    });
    const order = turnStartNames();
    assert.deepStrictEqual(order, ["大肥？", "小肥鱼", "老三", "大肥？"],
      `广播兜底应按工作组原序，实为 ${JSON.stringify(order)}`);
  });

  await test("A3 未提及+自主讨论：全群按原序接力（回归）", async () => {
    await runSequential({
      conversationId: "c-a3", message: "各位讨论一下", workModeId: "",
      autoDiscuss: true, maxTurns: 4, mentionedAgentIds: [],
    });
    const order = turnStartNames();
    assert.deepStrictEqual(order, ["大肥？", "小肥鱼", "老三", "大肥？"],
      `无提及应按工作组原序接力，实为 ${JSON.stringify(order)}`);
  });

  await test("A4 @提及+自主讨论：多成员提及按工作组序排前（用户提及顺序不保序）", async () => {
    await runSequential({
      conversationId: "c-a4", message: "@老三 @大肥？ 两位先说", workModeId: "",
      autoDiscuss: true, maxTurns: 5, mentionedAgentIds: ["老三", "大肥？"],
    });
    const order = turnStartNames();
    assert.deepStrictEqual(order, ["大肥？", "老三", "小肥鱼", "大肥？", "老三"],
      `多提及应按工作组序优先，实为 ${JSON.stringify(order)}`);
  });

  await test("A5 普通群发（非自主讨论）+@提及：定向单发不回归", async () => {
    const deps = makeDeps();
    global.__poolAgents = [
      { kind: "cloud", agentId: "ap-a", name: "大肥？", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" },
      { kind: "cloud", agentId: "ap-b", name: "小肥鱼", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" },
    ];
    await wg.runGroupTurn(deps, {
      conversationId: "c-a5", workgroupId: "wg-test", message: "@小肥鱼 单独问你", workModeId: "",
      mentionedAgentIds: ["小肥鱼"],
    });
    await waitFor(() => events.some((item) => item.payload?.type === "group-turn-settled"), 2000, "普通群发 settled");
    const order = turnStartNames();
    assert.deepStrictEqual(order, ["小肥鱼"], `普通群发应仅被提及成员单发，实为 ${JSON.stringify(order)}`);
    assert.ok(cloudCalls === 1, `普通群发应只发起 1 次云端请求，实为 ${cloudCalls}`);
  });

  await test("A6 接力轮 transcript 应含前轮回复（@ 修复后第二轮 prompt 带增量）", async () => {
    let captured = [];
    // 装置：落库回流——addAssistantMessage 累积进 convMessages（形态对齐 conversations.cjs
    // v3.35.6 落库：agent={id: agentMeta.agentId, name}——buildGroupMessages 的 (@名牌) 归因分支靠它）
    const convMessages = [{ role: "user", text: "@小肥鱼 先说，大家接着讨论" }];
    const deps = makeDeps({
      getConversation: async () => ({ id: "c-a6", messages: convMessages.map((m) => ({ ...m })) }),
      addAssistantMessage: (cid, text, session, files, tools, rid, mode, usage, a, b, c, d, reasoning, agentMeta) => {
        ledger.push(`落库[${String(text).slice(0, 60)}]`);
        convMessages.push({
          role: "assistant",
          text: String(text || ""),
          agent: agentMeta instanceof Object ? { id: String(agentMeta.agentId || ""), name: String(agentMeta.name || "") } : null,
        });
      },
    });
    // ⚠️ cloudSendHook 置位必须在 makeDeps 之后（makeDeps 会将其重置为 null——第一版装置踩过）
    cloudSendHook = async (config, messages, cbs) => {
      captured = messages;
      return plainReply(cbs, "（守门 mock 回复）");
    };
    global.__poolAgents = threeMembers;
    await wg.runGroupTurn(deps, {
      conversationId: "c-a6", workgroupId: "wg-test", message: "@小肥鱼 先说，大家接着讨论", workModeId: "",
      autoDiscuss: true, maxTurns: 2, mentionedAgentIds: ["小肥鱼"],
    });
    await waitFor(() => events.some((item) => item.payload?.type === "group-turn-settled"), 2000, "A6 settled");
    // 第二轮（大肥？）构建消息时第一轮回复已落库 → 上下文含第一轮内容（增量在，不再同 prompt 复读）
    const prior = captured.find((msg) => msg.role === "assistant" && String(msg.content || "").includes("（守门 mock 回复）"));
    assert.ok(prior, "第二轮上下文应含第一轮回复（接力 prompt 有增量）");
    assert.ok(String(prior.content).startsWith("(@小肥鱼)"), `前轮回复应带 @名牌归因前缀，实为「${String(prior.content).slice(0, 40)}」`);
  });

  console.log("\n═══ B. 源码锚点（防回归）═══");

  await test("B1 isSequential 分支不再直接用过滤后的 route 作接力序", () => {
    const seqStart = src.indexOf("if (isSequential) {");
    const seqBlock = src.slice(seqStart, src.indexOf("} else {", seqStart));
    assert.ok(!seqBlock.includes("[...route]"), "接力 order 不应再直接展开被 @ 过滤的 route（根因锚）");
    assert.ok(seqBlock.includes("wanted"), "接力分支应解析 mentionedAgentIds（提及优先实现锚）");
    assert.ok(seqBlock.includes("mentioned") && seqBlock.includes("rest"), "接力 order 应由 mentioned+rest 优先序列构造");
  });

  await test("B2 普通群发分支仍消费 routeMembers 过滤的 route（定向单发语义不动）", () => {
    assert.ok(src.includes("const route = routeMembers(agents, input.mentionedAgentIds);"), "routeMembers 消费点应在场");
    assert.ok(src.includes("route.filter((agent) => agent.kind === \"cloud\")"), "普通群发沿用 route 过滤分支");
  });

  console.log("\n═══ D. 版本自洽 ═══");

  await test("D1 package.json 版本 ≥ 3.44.1", () => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version || ""));
    assert.ok(m, `package.json version 应为 x.y.z 形态，实为 ${pkg.version}`);
    const [major, minor, patch] = m.slice(1).map(Number);
    assert.ok(
      major > 3 || (major === 3 && minor > 44) || (major === 3 && minor === 44 && patch >= 1),
      `package.json version 应 ≥ 3.44.1，实为 ${pkg.version}`
    );
  });

  await test("D2 README badge 与 package.json 版本自洽", () => {
    const badge = /version-([0-9.]+)/.exec(readme);
    assert.ok(badge, "README 应含 version badge");
    assert.strictEqual(badge[1], pkg.version, `README badge ${badge[1]} 应与 package.json ${pkg.version} 一致`);
  });

  console.log(`\n═══ 结果：${passed} 通过 / ${failed} 失败 ═══`);
  if (failed) {
    for (const line of failures) console.log(`  ✗ ${line}`);
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error("测试装置崩溃：", error); process.exit(1); });
