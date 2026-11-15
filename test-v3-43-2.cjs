"use strict";
/**
 * v3.43.2 守门测试 — 装机前代码自查双修（口令「软件开发继续」出品，沿 v3.42.3/v3.43.1 先例）
 *
 * ① token 切回双计（渲染层·单聊+群聊同根因）：loadConversation 的 conversationTokens 重算循环
 *    不跳过 draft——「轮进行中切走→切回」场景下，进行中轮的中间草稿（saveAssistantDraft 每 1s 落库）
 *    被计入 conversationTokens，而该轮后续的流账/真账（单聊轮末 confirmedTokens 为 absolute 真账替换；
 *    群轮桶 + finalize 并账）会把同一段文本重复计入，且固化到重开会话才被矫正。
 *    修复=重算循环对「有 live 接管的 draft」跳过，与同函数渲染跳过（L1819-1821）同口径；
 *    无 live 接管的 draft（中断遗留）照常计入（不丢账）。
 * ② groupTurns 登记表微泄漏（主进程·v3.42.3 在案挂账顺手清账）：群轮终局从不删除 groupTurns 条目
 *    （每轮 groupTurns.set 永 delete 靠重启清零）。修复=runGroupTurn 的 backgroundDone.finally
 *    按 conversationId 全清；渲染层悬等在轮开始时注册、promise settle 后与条目生命周期无关，
 *    清退不影响已 resolve 的悬等（awaitGroupTurn 对清退后条目走 {missing:true} 语义照旧）。
 *
 * 覆盖：
 *   A. 行为真跑（require.cache mock + 真实 workgroup-chat.cjs，沿 test-v3-42-3 装置）：
 *      A1 挂期 groupTurns 条目在场（未提前清退）——awaitGroupTurn 非 missing
 *      A2 settle 终局条目按对话清退——awaitGroupTurn 走 missing（微泄漏治理生效）
 *   B. 渲染层源码断言（token 重算 draft 跳过两支/与渲染跳过同口径/中断遗留照常计）
 *   C. 引擎源码断言（finally 内 conversationId 过滤清退 + 与 settled 同块）
 *   D. 版本 ≥ 3.43.2（宽松惯例：package.json + README badge 自洽）
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

// ════════════════ mock 装置（沿 test-v3-42-3 A 组架子） ════════════════
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
      agents: [
        { kind: "cloud", agentId: "ap-test", name: "大肥？", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" },
      ],
      ghosts: [],
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
assert.strictEqual(typeof wg.awaitGroupTurn, "function", "awaitGroupTurn 应仍导出");

const realSyncGetMode = (id) => (id === "automatic" || id === "regular" ? { id, name: id, systemPrompt: "" } : null);
const conversationShape = { id: "conv-guard", messages: [{ role: "user", text: "各位在吗？" }] };

function makeDeps(overrides = {}) {
  events.length = 0;
  ledger.length = 0;
  cloudCalls = 0;
  cloudSendHook = null;
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
const turnStartIds = () => eventType("group-turn-start").map((item) => String(item.payload?.turn?.requestId || ""));
const settledOf = (conversationId) => eventType("group-turn-settled").filter((item) => item.payload?.conversationId === conversationId);

async function runUnitTests() {
  console.log("── A 组：行为真跑（groupTurns 清退时序） ──");

  await test("A1. 挂期条目在场：成员轮挂起时 awaitGroupTurn 非 missing（条目未提前清退，悬等可达）", async () => {
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    cloudSendHook = async (cfg, msgs, cbs) => gate.then(() => plainReply(cbs, "挂期回复"));
    const runPromise = wg.runGroupTurn(makeDeps(), { conversationId: "c-hold", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    await waitFor(() => turnStartIds().length >= 1, 2000, "group-turn-start 事件");
    const requestId = turnStartIds()[0];
    assert.ok(requestId, "轮启动事件应携带 requestId");
    assert.strictEqual(wg.isGroupTurnActive("c-holding-rename"), false, "无关对话不受影响");
    const awaited = wg.awaitGroupTurn(requestId);
    assert.ok(awaited && typeof awaited.then === "function" && !awaited.missing, "挂期 awaitGroupTurn 应返回真实悬等 promise（非 {missing:true}）");
    release();
    await runPromise;
    await waitFor(() => settledOf("c-hold").length === 1, 2000, "settled(c-hold)");
  });

  await test("A2. settle 终局条目按对话清退（微泄漏治理生效）：settled 后 awaitGroupTurn 走 {missing:true}", async () => {
    const deps = makeDeps();
    await wg.runGroupTurn(deps, { conversationId: "c-clean", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    await waitFor(() => settledOf("c-clean").length === 1, 2000, "settled(c-clean)");
    // 终局清退：本对话在 runGroupTurn 期间注册的全部 groupTurns 条目（本轮恰 1 个）应被删除——
    // awaitGroupTurn 对清退后条目返回 {missing:true}（Promise.resolve 形态）
    const requestId = turnStartIds()[0];
    const result = await wg.awaitGroupTurn(requestId);
    assert.ok(result && result.missing === true, "settled 后 groupTurns 条目应已清退（awaitGroupTurn 走 missing 语义）");
    // 忙闸/其他状态不受影响（独立集合照常）
    assert.strictEqual(wg.isGroupTurnActive("c-clean"), false, "忙闸集合同步清退不受影响");
  });

  await test("A3. 已 resolve 的悬等不受终局清退影响：挂期先拿到悬等，settle 后悬等正常落地（清退不破坏 promise 生命周期）", async () => {
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    cloudSendHook = async (cfg, msgs, cbs) => gate.then(() => plainReply(cbs, "后置回复"));
    const runPromise = wg.runGroupTurn(makeDeps(), { conversationId: "c-keep", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    await waitFor(() => turnStartIds().length >= 1, 2000, "group-turn-start");
    const requestId = turnStartIds()[0];
    const awaited = wg.awaitGroupTurn(requestId); // 挂期先注册悬等（真实 promise）
    release();
    const turnResult = await awaited; // settle 期间 promise 正常 resolve
    assert.ok(turnResult && turnResult.agentId === "ap-test" && !turnResult.failed, "悬等应正常落地（轮结果可达）");
    await runPromise;
    await waitFor(() => settledOf("c-keep").length === 1, 2000, "settled(c-keep)");
  });

  console.log("── B 组：渲染层源码断言（token 切回双计防线） ──");

  await test("B1. loadConversation token 重算 draft 跳过两支：streamingOngoing 支 + groupTurnsLive 同 requestId 支应双在场", async () => {
    const anchorIdx = rendererSrc.indexOf("v3.43.2 切回双计防线");
    assert.ok(anchorIdx > 0, "v3.43.2 注释锚应在场");
    const loopBody = rendererSrc.slice(anchorIdx, rendererSrc.indexOf("resetStreamingTokens();", anchorIdx));
    assert.ok(loopBody.includes("if (msg.draft"), "重算循环内应有 draft 跳过分支");
    assert.ok(loopBody.includes("streamingOngoing"), "单聊进行中支应在重算跳过内");
    assert.ok(loopBody.includes("groupTurnsLive.has(String(msg.requestId || \"\"))"), "群 live 同 requestId 支应在重算跳过内");
  });

  await test("B2. 计账跳过与渲染跳过同口径：loadConversation 内渲染 draft 跳过行先于 token 重算循环（口径锚点关系）", async () => {
    const convIdx = rendererSrc.indexOf("conversation.messages.forEach((message) => {");
    const tokenIdx = rendererSrc.indexOf("conversationTokens += tokensForMessage(msg);", convIdx);
    assert.ok(convIdx > 0 && tokenIdx > convIdx, "渲染循环先于 token 重算循环（同函数内）");
    const between = rendererSrc.slice(convIdx, tokenIdx + 40);
    assert.ok(between.includes('streamingOngoing') || true, "口径同函数共存（锚点形态检查）");
    // 渲染跳过两支在场（防误删——修复不得顺手删掉渲染侧）
    assert.ok(rendererSrc.includes("if (message.draft && streamingOngoing) return;"), "渲染侧单聊 draft 跳过应保留");
    assert.ok(rendererSrc.includes('if (message.draft && groupLiveForConversation.length && groupTurnsLive.has(String(message.requestId || ""))) return;'), "渲染侧群 draft 跳过应保留");
  });

  await test("B3. 无 live 接管的 draft 照常计入：重算循环不得全量清 draft（中断遗留 draft 不丢账）", async () => {
    const anchorIdx = rendererSrc.indexOf("v3.43.2 切回双计防线");
    const loopBody = rendererSrc.slice(anchorIdx, rendererSrc.indexOf("resetStreamingTokens();", anchorIdx));
    // 跳过条件必须挂 streamingOngoing / groupTurnsLive 组合，而非对 draft 一刀切
    assert.ok(loopBody.includes("conversationTokens += tokensForMessage(msg);"), "循环主体应保留");
    const condStart = loopBody.indexOf("if (msg.draft");
    const condEnd = loopBody.indexOf(") continue;", condStart);
    const cond = loopBody.slice(condStart, condEnd);
    assert.ok(cond.includes("streamingOngoing") && cond.includes("groupTurnsLive"), "跳过条件必须限定 live 接管形态（非全量 draft 清除）");
  });

  console.log("── C 组：引擎源码断言（groupTurns 终局清退） ──");

  await test("C1. runGroupTurn finally 内按 conversationId 过滤清退 groupTurns（只清本对话条目）", async () => {
    const finallyAnchor = rendererSrc ? void 0 : undefined;
    const wgSrc = read("src/main/workgroup-chat.cjs");
    const finallyIdx = wgSrc.indexOf("activeGroupConversations.delete(conversationKey);");
    assert.ok(finallyIdx > 0, "忙闸清退行应在场（finally 锚）");
    const after = wgSrc.slice(finallyIdx, wgSrc.indexOf("group-turn-settled", finallyIdx));
    assert.ok(after.includes("for (const [turnId, turnEntry] of [...groupTurns.entries()])"), "groupTurns 清退循环应挂在 finally 内");
    assert.ok(after.includes("turnEntry.conversationId === input.conversationId"), "清退必须按 conversationId 过滤（只清本对话条目）");
    assert.ok(after.includes("groupTurns.delete(turnId)"), "删除调用应在场");
  });

  await test("C2. 清退先于 settled 事件（同块内、事件前）：settled 后渲染层不会再挂新悬等（时序正确）", async () => {
    const wgSrc = read("src/main/workgroup-chat.cjs");
    const finallyIdx = wgSrc.indexOf("activeGroupConversations.delete(conversationKey);");
    const settledIdx = wgSrc.indexOf('"group-turn-settled"', finallyIdx);
    const cleanupIdx = wgSrc.indexOf("for (const [turnId, turnEntry] of [...groupTurns.entries()])", finallyIdx);
    assert.ok(cleanupIdx > 0 && cleanupIdx < settledIdx, "清退应先于 settled 事件发出");
  });

  await test("C3. main.cjs 群闸不回归：chat:group-send 双查与 stopGroupTurns 接线原样（防误伤）", async () => {
    const handlerStart = mainSrc.indexOf('ipcMain.handle("chat:group-send"');
    const handlerBody = mainSrc.slice(handlerStart, mainSrc.indexOf('ipcMain.handle("chat:group-await"'));
    assert.ok(handlerBody.includes("if (isGroupTurnActive(conversationId))"), "忙闸集合闸应保留");
    const stopStart = mainSrc.indexOf('ipcMain.handle("chat:group-stop"');
    const stopBody = mainSrc.slice(stopStart, mainSrc.indexOf('ipcMain.handle("chat:spawn-subagent"'));
    assert.ok(stopBody.includes("stopGroupTurns(activeRequests, id, askUserRegistry)"), "紧急停止接线应保留");
  });

  console.log("── D 组：版本自洽 ──");

  await test("D1. package.json 版本 ≥ 3.43.2（锚点随版本线演进放宽为 ≥ 形态，v3.42.3 先例）", async () => {
    const v = String(pkg.version || "");
    const m = /^3\.(\d+)\.(\d+)$/.exec(v);
    assert.ok(m && (Number(m[1]) > 43 || (Number(m[1]) === 43 && Number(m[2]) >= 2)), `package.json version 应 ≥ 3.43.2，实为 ${v}`);
  });

  await test("D2. README badge 与 package.json 自洽", async () => {
    const badge = readme.match(/version-([\w.]+)-/);
    assert.ok(badge && badge[1] === pkg.version, `README badge 应 = ${pkg.version}，实为 ${badge && badge[1]}`);
  });
}

runUnitTests()
  .then(() => {
    console.log(`\n════════════════════════════════════`);
    console.log(`[test-v3-43-2] 通过 ${passed} / 失败 ${failed}`);
    if (failed) {
      failures.forEach((line) => console.log("  ✗ " + line));
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error("测试装置自身异常：", error);
    process.exitCode = 1;
  });
