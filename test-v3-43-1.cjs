"use strict";
/**
 * v3.43.1 守门测试 — 装机前代码自查双修
 *
 * Bug A（主进程·群聊）：大红停止误报「本轮失败」——runCloudMemberTurn 的工具循环在 round=0
 *   停止旗直接 break 时 result 尚为 null，下方 `result.cancelled` 必炸 TypeError
 *   （Cannot read properties of null (reading 'cancelled')）→ 外层 catch 按失败收口：
 *   落库「（@xx 本轮失败：ERROR …null…）」+ group-agent-failed 事件 + 渲染层失败样式。
 *   触发=群发（v3.42.0 启动即返）后、成员轮还在 getConversation/getMode 窗口内点大红停止——
 *   activeRequests 尚未登记本 requestId，stopGroupTurns 只置旗不动它。修复=break 前把 result
 *   置成 { cancelled: true }，按「停止」收口不背失败锅（usageTotal 为空→落库不带 usage）。
 * Bug B（主进程+渲染层·单聊）：spawn_agent 派生子账丢失两件套——
 *   ① main.cjs 单聊 spawn_agent 分支只消费 subResult.text，subResult.usage 被丢弃且不走
 *      addUsageToMessage（群聊线 v3.42.1 已修，单聊漏）→ 轮末落库/轮末 emit 累计真账缺子账；
 *   ② 渲染层单聊 usage 分支对带 subId 的 cumulative 事件直接覆盖 confirmedTokens——
 *      主轮真账被子账顶掉（随后主轮下一轮累计再顶回=子账闪现即丢）。
 *   修复=①并账进 usageTotal（轮末落库/emit 自然含）+ ②单聊分支忽略 subId 事件。
 *
 * 覆盖：
 *   A. 行为真跑（require.cache 注入 mock + 真实 workgroup-chat.cjs，沿 test-v3-42-0 装置）：
 *      A1 round=0 停止旗：不再 TypeError/不再失败落库/不再 group-agent-failed——按「已停止」收口
 *      A2 round>0 停止旗：已流文本照常落库 + 返回 cancelled:true（不再混同正常完成）
 *      A3 回归网：正常完成（无停止）路径零位移（落库文本与返回形态不变）
 *   B. 源码断言：单聊 spawn_agent 并账（accumulateUsage+usageTotal 引用+顺序 TDZ 安全）+ emit 真账
 *   C. 源码断言：渲染层单聊 usage 分支 subId 防线 + 群轮分支 subId 桶键保留（v3.42.1 资产不回归）
 *   D. 版本 ≥ 3.43.1（宽松惯例）+ README badge 自洽
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
const wgSrc = fs.readFileSync(wgPath, "utf8");
const readmeSrc = read("README.md");
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

const events = [];
const ledger = [];
let cloudCalls = 0;
// ⚠ wg 顶层解构缓存函数引用——场景差异一律走 hook 变量（test-v3-42-0 装置教训）
let cloudSendHook = null;

const plainReply = (cbs, text) => {
  cbs.onDelta(text);
  return { text, usage: { promptTokens: 10, completionTokens: 5, requests: 1 } };
};

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
    // 真实累计器语义（promptTokens/completionTokens 求和 + requests 计数）
    accumulateUsage: (total, usage) => {
      if (!usage || typeof usage !== "object") return 0;
      const prompt = Number(usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
      const completion = Number(usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
      if (!prompt && !completion) return 0;
      total.prompt += prompt; total.completion += completion; total.total += prompt + completion; total.requests += 1;
      return prompt + completion;
    },
  },
  "cloud-tools.cjs": {
    toolDefinitions: () => [{ type: "function", function: { name: "read_file" } }],
    executeToolCall: async () => "（工具输出）",
    ASK_USER_HINT: "", ASK_USER_TIMEOUT: "__timeout__", ASK_USER_STOPPED: "__stopped__",
  },
  "agent-pool.cjs": {
    resolveGroupAgents: () => ({
      group: { id: "wg-test", name: "守门群", members: [], maxTurns: 10 },
      agents: [
        { agentId: "ap-test", name: "大肥？", kind: "cloud", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" },
      ],
      ghosts: [],
    }),
    whitelistedCloudTargets: () => [],
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
assert.strictEqual(typeof wg.stopGroupTurns, "function", "stopGroupTurns 应在导出集");

const realSyncGetMode = (id) => (id === "automatic" ? { id, name: id, systemPrompt: "（内置）" } : null);

function makeDeps(overrides = {}) {
  events.length = 0;
  ledger.length = 0;
  cloudCalls = 0;
  cloudSendHook = null;
  return Object.assign({
    getConversation: async () => ({ id: "conv-guard", messages: [{ role: "user", text: "在吗" }] }),
    getMode: realSyncGetMode,
    groupTools: () => ({ enabled: false, sandbox: false, allowCommand: false, workdir: "", environmentText: "" }),
    saveAssistantDraft: () => {},
    activeRequests: new Map(),
    addAssistantMessage: (cid, text) => ledger.push(String(text)),
    askUserRegistry: { wait: async () => "__timeout__" },
    executeToolCall: stubs["cloud-tools.cjs"].executeToolCall,
    sender: { send: (channel, payload) => events.push({ channel, payload }) },
    log: () => {},
  }, overrides);
}

async function waitFor(fn, timeoutMs = 2000, label = "条件") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (fn()) return; } catch { /* 继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

const eventType = (type) => events.filter((item) => item.payload?.type === type);
const settledOf = (conversationId) => eventType("group-turn-settled").filter((item) => item.payload?.conversationId === conversationId);

async function runUnitTests() {
  // ── A1 修复①核心：round=0 停止旗（getConversation 窗口内置旗）按「已停止」收口 ──
  await test("A1. round=0 停止旗（requestId 未登记窗口内大红停止）：不再 TypeError，落库「已停止。」+ 返回 cancelled，零 group-agent-failed", async () => {
    let releaseGet = null;
    let seenFirstGet = 0;
    const deps = makeDeps({
      // 成员轮首个 await 卡住（activeRequests 登记发生在它之后）→ 此窗口内 stopGroupTurns 只置旗
      getConversation: () => {
        seenFirstGet += 1;
        if (seenFirstGet === 1) {
          return new Promise((resolve) => { releaseGet = () => resolve({ id: "conv-guard", messages: [] }); });
        }
        return { id: "conv-guard", messages: [] };
      },
    });
    const out = await wg.runGroupTurn(deps, { conversationId: "c-stop0", workgroupId: "wg-test", message: "hi", workModeId: "automatic", mentionedAgentIds: [], autoDiscuss: false });
    assert.strictEqual(out.turns.length, 1, "单成员应 1 轮快照");
    const turn = out.turns[0];
    await waitFor(() => seenFirstGet >= 1, 2000, "成员轮已发出 getConversation 并卡住");
    // 在 getConversation 完成之前置停止旗（修复前：该轮后续 break → result=null → TypeError → 误报失败）
    wg.stopGroupTurns(deps.activeRequests, "c-stop0", null);
    releaseGet();
    // 悬等该轮终态（渲染层 awaitGroupTurn 同款路径）
    const turnResult = await wg.awaitGroupTurn(turn.requestId);
    await waitFor(() => settledOf("c-stop0").length === 1, 2000, "settled(c-stop0)");
    assert.strictEqual(turnResult.cancelled, true, `停止轮应按「停止」收口（cancelled:true），实际 ${JSON.stringify(turnResult)}`);
    assert.ok(!turnResult.failed, `停止轮不得带 failed（实际 ${JSON.stringify(turnResult).slice(0, 200)}）`);
    assert.strictEqual(ledger.filter((t) => /本轮失败/.test(t)).length, 0, `停止轮不得落库「本轮失败」（修复前 TypeError 会落：${ledger.join(" | ").slice(0, 200)}）`);
    assert.strictEqual(ledger.filter((t) => /null/.test(t)).length, 0, "失败消息不得含 null 字样（TypeError 痕迹）");
    assert.strictEqual(ledger.length, 1, "应按「已停止。」落库一次");
    assert.ok(/已停止/.test(ledger[0]), `落库文本应为「已停止。」形态，实际「${String(ledger[0]).slice(0, 60)}」`);
    const failedEvents = eventType("group-agent-failed").filter((e) => String(e.payload?.agent?.name || "").includes("大肥"));
    assert.strictEqual(failedEvents.length, 0, "停止轮不得发 group-agent-failed 事件");
    await waitFor(() => deps.activeRequests.size === 0, 2000, "activeRequests 清空");
  });

  // ── A2 修复①的 round>0 形态：已流文本照常落库 + cancelled:true ──
  await test("A2. round>0 停止旗（工具轮后置旗掐断下一轮）：已流文本照常落库 + 返回 cancelled:true（不再混同正常完成）", async () => {
    const deps = makeDeps({
      // 工具轮触发前提：工具组在场（默认 mock 是纯聊天 enabled:false，第一轮不会进工具执行）
      groupTools: () => ({ enabled: true, sandbox: false, allowCommand: true, workdir: "/home/test", environmentText: "" }),
    });
    let toolExecuted = 0;
    // 停止旗在工具执行路径内同步置位——工具 await 续延后 round=1 的停止旗检查必命中（确定性，无竞态）
    deps.executeToolCall = async () => {
      toolExecuted += 1;
      if (toolExecuted === 1) wg.stopGroupTurns(deps.activeRequests, "c-stop1", null);
      return "（工具输出）";
    };
    cloudSendHook = async (cfg, msgs, cbs) => {
      if (toolExecuted === 0) {
        cbs.onDelta("第一轮回复文本"); // 流先入 streamedText（群轮落库口径=流式累计，而非 result.text）
        return { text: "第一轮回复文本", toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }], usage: { promptTokens: 10, completionTokens: 5, requests: 1 } };
      }
      return plainReply(cbs, "第二轮");
    };
    const out = await wg.runGroupTurn(deps, { conversationId: "c-stop1", workgroupId: "wg-test", message: "hi", workModeId: "automatic", mentionedAgentIds: [] });
    const turn = out.turns[0];
    await waitFor(() => toolExecuted >= 1, 2000, "第一轮工具已执行（停止旗已在工具路径内置位）");
    const turnResult = await wg.awaitGroupTurn(turn.requestId);
    await waitFor(() => settledOf("c-stop1").length === 1, 2000, "settled(c-stop1)");
    assert.strictEqual(turnResult.cancelled, true, `中断轮应返回 cancelled:true，实际 ${JSON.stringify(turnResult)}`);
    assert.ok(!turnResult.failed, "中断轮不得带 failed");
    assert.strictEqual(ledger.filter((t) => /本轮失败/.test(t)).length, 0, "中断轮不得落库失败消息");
    const finalLedged = ledger.find((t) => !/正在|stop/.test(t));
    assert.ok(finalLedged && finalLedged.includes("第一轮回复文本"), `已流文本应照常落库，实际「${String(ledger).slice(0, 120)}」`);
  });

  // ── A3 回归网：正常完成（无停止）路径零位移 ──
  await test("A3. 回归网：无停止路径正常完成——落库文本/usage/返回形态与修复前一致", async () => {
    const deps = makeDeps();
    cloudSendHook = null; // 走 stub 默认 plainReply（守门 mock 回复）
    const out = await wg.runGroupTurn(deps, { conversationId: "c-normal", workgroupId: "wg-test", message: "hi", workModeId: "automatic", mentionedAgentIds: [] });
    const turnResult = await wg.awaitGroupTurn(out.turns[0].requestId);
    await waitFor(() => settledOf("c-normal").length === 1, 2000, "settled(c-normal)");
    assert.strictEqual(turnResult.cancelled, undefined, "正常完成不得带 cancelled");
    assert.strictEqual(turnResult.failed, undefined, "正常完成不得带 failed");
    assert.ok(turnResult.text && turnResult.text.includes("守门 mock 回复"), "正常完成应带回复文本");
    assert.strictEqual(ledger.filter((t) => /本轮失败|已停止/.test(t)).length, 0, "正常完成不得误标停止/失败");
    assert.strictEqual(turnResult.usage && turnResult.usage.requests, 1, "正常完成 usage.requests 应为 1（累计器在位回归）");
  });

  // ── B/C 源码断言 ──
  await test("B1. 单聊 spawn_agent 分支并账：subResult.usage 经 accumulateUsage(usageTotal,… 入累计器 + 并账后 emit cumulative 真账", () => {
    assert.ok(/if \(subResult\.usage\) \{[\s\S]*?accumulateUsage\(usageTotal, subResult\.usage\)/.test(mainSrc), "spawn_agent 分支应把 subResult.usage 并进 usageTotal（usageTotal 累计器）");
    const branchStart = mainSrc.indexOf("else if (call.name === \"spawn_agent\")");
    const branchEnd = mainSrc.indexOf("} else {\n            try {", branchStart);
    assert.ok(branchStart > 0 && branchEnd > branchStart, "spawn_tool 分支定位失败");
    const branch = mainSrc.slice(branchStart, branchEnd);
    assert.ok(/accumulateUsage\(usageTotal/.test(branch), "并账调用应在 spawn_agent 分支内");
    assert.ok(/type: "usage"[\s\S]*?cumulative: true/.test(branch), "并账后应 emit cumulative 真账事件");
    assert.ok(/cloud_spawn_usage/.test(branch), "并账应留审计日志（cloud_spawn_usage）");
  });

  await test("B2. TDZ 顺序安全：usageTotal 声明行在 spawn_agent 并账使用行之前（铁律 §9 守门）", () => {
    const declareLine = mainSrc.indexOf("const usageTotal = { prompt: 0, completion: 0, total: 0, requests: 0 };");
    const useLine = mainSrc.indexOf("accumulateUsage(usageTotal, subResult.usage)");
    assert.ok(declareLine > 0 && useLine > declareLine, "usageTotal 声明必须先于单聊并账使用点（源码顺序）");
  });

  await test("C1. 渲染层单聊 usage 分支 subId 防线：带 subId 的事件不覆盖主轮真账（confirmedTokens）", () => {
    const singleBranch = rendererSrc.indexOf("} else if (event.type === \"usage\") {");
    assert.ok(singleBranch > 0, "单聊 usage 分支定位失败");
    const seg = rendererSrc.slice(singleBranch, singleBranch + 900);
    assert.ok(/if \(event\.subId\) return;/.test(seg), "单聊 usage 分支应忽略带 subId 的子账事件（防覆盖主轮真账）");
  });

  await test("C2. 渲染层群轮分支 subId 桶键保留（v3.42.1 资产不回归）", () => {
    const groupBranch = rendererSrc.indexOf("groupUsageLedger.set(usageKey, realUsage)");
    assert.ok(groupBranch > 0, "群真账桶写入点缺失");
    const usageKeyDef = rendererSrc.indexOf('const usageKey = String(event.id) + (event.subId ? `:${event.subId}` : "");');
    assert.ok(usageKeyDef > 0, "群桶键应带 subId 区分成员轮与子轮");
  });

  await test("C3. 单聊并账链闭合：轮末落库/emit 均经 usageTotal（渲染层忽略 subId 后真账仍可达）", () => {
    // 轮末 emit（L1310 形态）与轮末落库（cumulativeUsage）都必须源自 usageTotal——
    // 修复②把子账并入 usageTotal 后，两条出口自然含子账
    assert.ok(/cumulativeUsage = usageTotal\.requests/.test(mainSrc), "轮末落库应经 usageTotal 构造 cumulative 形态");
    assert.ok(/chat:event", \{ id, type: "usage", usage: \{ inputTokens: usageTotal\.prompt/.test(mainSrc), "轮末 emit 应源自 usageTotal");
  });

  await test("D1. 版本 ≥ 3.43.1（宽松惯例：写死会在下次 bump 翻红）", () => {
    const [a, b, c] = String(pkg.version).split(".").map(Number);
    assert.ok(a > 3 || (a === 3 && (b > 43 || (b === 43 && c >= 1))), `package.json 版本应 ≥3.43.1，实际 ${pkg.version}`);
  });

  await test("D2. README badge 与 package.json 自洽", () => {
    const badge = /version-(\d+\.\d+\.\d+)-blue/.exec(readmeSrc);
    assert.ok(badge, "README 版本 badge 缺失");
    assert.strictEqual(badge[1], pkg.version, `README badge=${badge[1]} 应与 package.json=${pkg.version} 一致`);
  });
}

runUnitTests()
  .then(() => {
    console.log(`\n=== test-v3-43-1.cjs：${passed} 通过 / ${failed} 失败 ===`);
    if (failed > 0) {
      console.error(failures.map((line) => `  ✗ ${line}`).join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("测试装置异常：", error);
    process.exit(1);
  });
