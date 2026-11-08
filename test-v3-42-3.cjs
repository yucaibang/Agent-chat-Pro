"use strict";
/**
 * v3.42.3 守门测试 — 后台群轮两真修（装机前代码自查出品）
 *
 * 本轮两 bug 均为 v3.42.0「启动即返+背景推进」重构后的潜伏面（用户切走会话后暴露）：
 *   ① 后台群轮视图污染：用户群发后切到别的对话（v3.15.0 允许），后续启动的成员轮/幽灵轮
 *      的 group-turn-start 事件仍会被渲染层 ensureGroupTurnBubble 建进【当前正在看的错误会话
 *      视图】并接流（「正在思考」气泡+delta 直写他会话）——真污染。
 *      修复=ensureGroupTurnBubble 会话归属守卫；连带 flush 合帧滚动只允许当前视图轮触发。
 *   ② 群发忙闸穿透窗口：「chat:group-send 门检查（activeRequests）」与「首轮真正登记进
 *      activeRequests」之间隔着 getConversation IO / createSandboxBridge SSH 建连（秒级）——
 *      沙箱用户快速二连发可绕闸=双群轮并发（消息双份落库/SSH 卡槽互踩/双 sandbox bridge）。
 *      修复=引擎层 activeGroupConversations 同步集合（runGroupTurn 同步入场 → 全组 settle 清退）
 *      + main.cjs 忙闸双查（activeRequests ∪ 集合）。
 * 附带：
 *   ③ 群聊后台轮切回无缝衔接——loadConversation 复刻单聊 remount 语义（draft 与 live 同
 *      requestId 时不渲染 draft；循环后重挂 live 项；状态条「群聊仍在后台处理中」）。
 *   ④ emergencyStopGroup 补 messages.delete（此前 live 删除后 finalize 早退不删 messages Map）。
 *
 * 覆盖：
 *   A. 行为真跑（require.cache 注入 mock + 真实 workgroup-chat.cjs，沿 test-v3-42-0 装置）：
 *      A1 createSandboxBridge 挂期（SSH 建连窗口）isGroupTurnActive 已同步置位
 *      A2 全组挂期不清退、settled 终局才清退
 *      A3 幽灵全灭组：不 throw、登记照走、settle 后清退
 *   B. 渲染层源码断言（归属守卫/draft 跳过/live 重挂/滚动守卫/messages 清理）
 *   C. 主进程源码断言（忙闸双查 + 引擎登记次序先于一切 await + finally 清退）
 *   D. 版本 ≥ 3.42.3（宽松惯例）
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const wgPath = path.join(ROOT, "src/main/workgroup-chat.cjs");
const mainSrc = read("src/main/main.cjs");
const rendererSrc = read("src/renderer/renderer.js");
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

// ════════════════ A. 行为真跑（沿 test-v3-42-0 装置） ════════════════
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
    toolDefinitions: () => [{ type: "function", function: { name: "read_file" } }],
    executeToolCall: async () => "（文件内容）",
    ASK_USER_HINT: "", ASK_USER_TIMEOUT: "__timeout__", ASK_USER_STOPPED: "__stopped__",
  },
  "agent-pool.cjs": {
    resolveGroupAgents: () => ({
      group: { id: "wg-test", name: "守门群", members: [], maxTurns: 10 },
      agents: global.__poolAgents || [
        { kind: "cloud", agentId: "ap-test", name: "大肥？", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" },
        { kind: "cloud", agentId: "ap-test-2", name: "小肥鱼", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" },
      ],
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
assert.strictEqual(typeof wg.isGroupTurnActive, "function", "v3.42.3 应导出 isGroupTurnActive");

const realSyncGetMode = (id) => (id === "automatic" || id === "regular" ? { id, name: id, systemPrompt: `（内置模式 ${id}）` } : null);
const conversationShape = { id: "conv-guard", messages: [{ role: "user", text: "各位在吗？" }] };

function makeDeps(overrides = {}) {
  events.length = 0;
  ledger.length = 0;
  cloudCalls = 0;
  cloudSendHook = null;
  global.__poolGhosts = [];
  global.__poolAgents = null;
  return Object.assign({
    getConversation: async () => conversationShape,
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

const eventType = (type) => events.filter((item) => item.payload?.type === type);
const settledOf = (conversationId) => eventType("group-turn-settled").filter((item) => item.payload?.conversationId === conversationId);

async function runUnitTests() {
  await test("A1. 忙闸同步集合：createSandboxBridge 挂期（SSH 建连秒级窗口）isGroupTurnActive 已置位——纯 activeRequests 闸的穿透窗口被第二道闸封死", async () => {
    let releaseBridge = null;
    const bridgeGate = new Promise((resolve) => { releaseBridge = resolve; });
    const deps = makeDeps({
      groupTools: () => ({ enabled: true, sandbox: true, allowCommand: false, workdir: "/workspace", environmentText: "" }),
      createSandboxBridge: () => bridgeGate.then(() => ({
        executor: { enabled: true, run: async () => ({ code: 0, stdout: "", stderr: "" }) },
        dispose: () => {},
      })),
    });
    const runPromise = wg.runGroupTurn(deps, { conversationId: "c-busy", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    // runGroupTurn 首个 await（createSandboxBridge）挂起期间——此刻 activeRequests 必然空、旧闸失效，
    // 新集合闸必须在 runGroupTurn() 返回 promise 的同一 tick 已置位（同步语义，二连发在此被封）
    assert.strictEqual(wg.isGroupTurnActive("c-busy"), true, "SSH 建连挂起窗口忙闸集合应已同步置位");
    releaseBridge();
    await runPromise;
    await waitFor(() => settledOf("c-busy").length === 1, 2000, "settled(c-busy)");
  });

  await test("A2. 忙闸清退=全组 settle 终局：成员轮挂期不得提前清退，settled 后才解锁", async () => {
    const deps = makeDeps({
      groupTools: () => ({ enabled: true, sandbox: true, allowCommand: false, workdir: "/workspace", environmentText: "" }),
      createSandboxBridge: async () => ({ executor: { enabled: true, run: async () => ({ code: 0, stdout: "", stderr: "" }) }, dispose: () => {} }),
    });
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    cloudSendHook = async (cfg, msgs, cbs) => (cloudCalls === 1 ? gate.then(() => plainReply(cbs, "x")) : plainReply(cbs, "x"));
    await wg.runGroupTurn(deps, { conversationId: "c-release", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    await waitFor(() => cloudCalls >= 1, 2000, "首个成员轮进入挂期");
    assert.strictEqual(wg.isGroupTurnActive("c-release"), true, "成员轮挂期（未 settle）忙闸不得提前清退");
    release();
    await waitFor(() => settledOf("c-release").length === 1, 2000, "settled(c-release)");
    await waitFor(() => wg.isGroupTurnActive("c-release") === false, 2000, "settle 终局清退");
  });

  await test("A3. 幽灵全灭组：不 throw、集合登记照走、settle 后清退（清退路径覆盖无正常轮形态）", async () => {
    const deps = makeDeps();
    global.__poolGhosts = ["ap-dead-node-uuid"];
    await wg.runGroupTurn(deps, { conversationId: "c-ghost", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    assert.strictEqual(wg.isGroupTurnActive("c-ghost"), true, "幽灵组运行期集合应置位");
    await waitFor(() => settledOf("c-ghost").length === 1, 2000, "settled(c-ghost)");
    await waitFor(() => wg.isGroupTurnActive("c-ghost") === false, 2000, "幽灵组 settle 后清退");
  });

  // ════════════════ B. 渲染层源码断言 ════════════════
  console.log("── B 组：渲染层源码断言 ──");

  await test("B1. ensureGroupTurnBubble 会话归属守卫：非当前会话轮直接 return null（不再建进错误视图），且守卫先于 ghost 分流", async () => {
    const fnStart = rendererSrc.indexOf("function ensureGroupTurnBubble(turn)");
    assert.ok(fnStart > 0, "ensureGroupTurnBubble 应在场");
    const fnBody = rendererSrc.slice(fnStart, rendererSrc.indexOf("function renderGhostTurnBubble"));
    const guardIdx = fnBody.indexOf('String(turn?.conversationId || "") !== String(groupActiveConversationId)');
    const ghostIdx = fnBody.indexOf("if (turn.ghost)");
    assert.ok(guardIdx > 0, "归属守卫行应在场");
    assert.ok(ghostIdx > 0, "ghost 分流应仍在场");
    assert.ok(guardIdx < ghostIdx, "守卫必须先于 ghost 分流（幽灵轮同样不得进错误视图）");
  });

  await test("B2. loadConversation 群 draft 跳过：本对话仍有 live 群轮时，同 requestId 的 draft 不重复渲染（live 重挂接管）", async () => {
    assert.ok(rendererSrc.includes("const groupLiveForConversation = [...groupTurnsLive.values()].filter("),
      "群 live 归属过滤应随 loadConversation 计算");
    assert.ok(rendererSrc.includes('groupTurnsLive.has(String(message.requestId || ""))'),
      "draft 跳过应以 requestId 对回 live 群轮");
  });

  await test("B3. 群聊后台轮切回重挂：live 项 disconnected 时 append（同引用续流，v3.15.0 单聊同款语义）+ 后台状态条文案", async () => {
    assert.ok(rendererSrc.includes("if (live.item && !live.item.isConnected) elements.messages.append(live.item);"),
      "live 气泡重挂行应在场");
    assert.ok(rendererSrc.includes("群聊仍在后台处理中"), "后台群轮状态条文案应在场");
  });

  await test("B4. flush 合帧滚动守卫：仅本轮 flush 触达当前视图轮才跟随滚动（后台轮写 detached 引用不拉扯他会话）", async () => {
    assert.ok(rendererSrc.includes("let touchedCurrentView = false;"), "touchedCurrentView 声明应在场");
    assert.ok(rendererSrc.includes("if (touchedCurrentView && isNearBottom()) elements.messages.scrollTop"), "滚动出口应挂 touchedCurrentView 守卫");
    const touchCount = (rendererSrc.match(/touchedCurrentView = true;/g) || []).length;
    assert.strictEqual(touchCount, 1, "置位点应唯一（按 live.conversationId 判定）");
  });

  await test("B5. emergencyStopGroup 补 messages.delete：紧急停止后 messages Map 不再残留 detached 引用", async () => {
    const fnStart = rendererSrc.indexOf("async function emergencyStopGroup()");
    assert.ok(fnStart > 0, "emergencyStopGroup 应在场");
    const fnBody = rendererSrc.slice(fnStart, rendererSrc.indexOf("/** Sub-Agent 树状折叠气泡"));
    assert.ok(fnBody.includes("messages.delete(requestId)"), "紧急停止循环内应同步清 messages Map");
    assert.ok(fnBody.includes("groupTurnsLive.delete(requestId)"), "live 登记删除应仍在场");
  });

  // ════════════════ C. 主进程源码断言 ════════════════
  console.log("── C 组：主进程源码断言 ──");

  await test("C1. chat:group-send 忙闸双查：activeRequests 循环闸之后补 isGroupTurnActive 集合闸（同文案拒发）", async () => {
    const handlerStart = mainSrc.indexOf('ipcMain.handle("chat:group-send"');
    assert.ok(handlerStart > 0, "chat:group-send handler 应在场");
    const handlerBody = mainSrc.slice(handlerStart, mainSrc.indexOf('ipcMain.handle("chat:group-await"'));
    assert.ok(handlerBody.includes("for (const entry of activeRequests.values())"), "原 activeRequests 闸应保留");
    assert.ok(handlerBody.includes("if (isGroupTurnActive(conversationId))"), "忙闸双查（引擎集合闸）应在场");
    const loopIdx = handlerBody.indexOf("for (const entry of activeRequests.values())");
    const setIdx = handlerBody.indexOf("if (isGroupTurnActive(conversationId))");
    assert.ok(loopIdx < setIdx, "集合闸应排 在 activeRequests 闸之后（双查语义）");
    assert.ok(handlerBody.split("群聊正在进行中（有成员仍在工作）").length >= 3, "两道闸同文案（用户看到的拒绝提示一致）");
  });

  await test("C2. main.cjs 接线：workgroup-chat 导入行含 isGroupTurnActive", async () => {
    const importLine = mainSrc.split("\n").find((line) => line.includes('require("./workgroup-chat.cjs")'));
    assert.ok(importLine && importLine.includes("isGroupTurnActive"), "导入应含 isGroupTurnActive");
  });

  await test("C3. 引擎登记次序：activeGroupConversations.add 先于 createSandboxBridge await（穿透窗口封死点），finally 清退在场", async () => {
    assert.ok(wgSrcHas("const activeGroupConversations = new Set();"), "忙闸集合定义应在场");
    const addIdx = wgSrc.indexOf("activeGroupConversations.add(conversationKey);");
    const bridgeIdx = wgSrc.indexOf("await deps.createSandboxBridge()");
    assert.ok(addIdx > 0 && bridgeIdx > 0 && addIdx < bridgeIdx, "集合登记必须先于沙箱桥建连 await（封死穿透窗口）");
    assert.ok(wgSrcHas("activeGroupConversations.delete(conversationKey);"), "finally 清退应在场");
    assert.ok(wgSrcHas("function isGroupTurnActive(conversationId)"), "查询函数应在场");
  });

  await test("C4. settled 外发 try 包裹：sender 销毁（窗口退出中）不再把 finally 后续清退炸掉", async () => {
    const finallyIdx = wgSrc.indexOf(".finally(() => {");
    const finallyBody = wgSrc.slice(finallyIdx, wgSrc.indexOf("return { turns, groupName"));
    assert.ok(finallyBody.includes("try {") && finallyBody.includes("group-turn-settled"), "settled 外发应有 try 保护");
    assert.ok(finallyBody.indexOf("activeGroupConversations.delete(conversationKey)") < finallyBody.indexOf("deps.sender.send"), "清退应先于 settled 外发（send 抛错不拖累解锁）");
  });

  // ════════════════ D. 版本断言 ════════════════
  console.log("── D 组：版本断言 ──");
  await test("D1. package.json version ≥ 3.42.3（宽松惯例：写死会在下次 bump 翻红本测试）", async () => {
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    assert.ok(major > 3 || (major === 3 && minor > 42) || (major === 3 && minor === 42 && patch >= 3), `version=${pkg.version}`);
  });
  await test("D2. README badge 版本与 package.json 一致（自洽形态）", async () => {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    assert.ok(readme.includes(`version-${pkg.version}-blue`), "README version badge 应回填 package.json 版本");
  });
}

// workgroup-chat 源码缓存（加载真实代码前后各读一次即可——本文件无混淆需求）
const wgSrc = fs.readFileSync(wgPath, "utf8");
function wgSrcHas(needle) { return wgSrc.includes(needle); }

(async () => {
  await runUnitTests();
  console.log("");
  console.log(`━━━ test-v3-42-3 共 ${passed + failed} 项 · 通过 ${passed} · 失败 ${failed} ━━━`);
  if (failures.length) {
    console.log("失败明细：");
    for (const item of failures) console.log(`  - ${item}`);
  }
  process.exit(failed ? 1 : 0);
})();
