"use strict";
/**
 * v3.42.1 守门测试 — 群聊 token 真账全算（三成员自主讨论应烧两百万就显两百万） + workspace 副标题回归下拉
 *
 * 用户两点（来源 LISA-PC）：
 *   ①群聊里 token 计数只有几千~2 万（≈只算输出）：三成员自主讨论按 200 万级上下文重烧 input，
 *     会计入账应像一对一一样「工具调用+输入输出全部算内」，且**所有 AI 加起来一条**（不按成员拆条）。
 *     根因三断点：
 *       a. 主进程群轮从未发「轮末累计真账」事件（单聊 main.cjs 轮末 accumulateUsage+cumulative 形态，群轮缺）
 *       b. executeSubAgent 子轮 sendCloudChat 没接 onUsage（换脑重试等子轮账全丢）
 *       c. 渲染层 GROUP_OPAQUE_EVENTS 把 usage 整类丢弃（v3.35.6 防多成员互踩时连真账一起丢了）
 *     修复=主进程每轮轮末 emit cumulative 绝对值（带 conversationId/subId）→ 渲染层 per-轮真账桶
 *       （Map+Σ 合计一条）→ finalizeGroupTurn 收尾并入会话账并清桶；落库侧 conversations.addUsageToMessage
 *       把子轮账追加进父成员消息 usage（重开会话 loadConversation 真账口径自然含子轮）。
 *   ②workspace 选择器收起条长显副标题「一对一专攻」不美观——副标题该出现在下拉列表项
 *     （CSS display:none 收起条内隐藏；下拉项 workspace-item-desc 照常）。
 *
 * 覆盖：
 *   A. 行为真跑（require.cache 注入 mock + 真实 workgroup-chat.cjs）：
 *      A1 云成员轮工具循环轮末真账事件（累计=Σ每轮 + conversationId 随行）
 *      A2 纯聊轮单请求也发真账（每成员轮一次）
 *      A3 取消轮真账照发（已耗不丢）
 *      A4 子 Agent 子轮：onUsage 收账（换脑 rerun 两 attempt 合计）+ 流中事件带 subId（桶键形态）
 *      A5 子轮真账落库追账 runSubAgentsForMember→addUsageToMessage（父轮 requestId 锚点）
 *      A6 云轮失败分支已耗账也照发照落
 *   B. conversations.cjs 真单测（mock electron/archive/storage，临时目录落盘）：
 *      B1 群成员消息落库保留 requestId（追账锚点）；单聊消息照旧不留
 *      B2 addUsageToMessage 累计合并（cumulative 保持 + 四值相加）
 *      B3 addUsageToMessage 原始形态（prompt/completion）兼容入参
 *      B4 无消息/无账 → 静默 no-op
 *      B5 draft 转正后 requestId 保留（草稿链）
 *   C. 渲染层源码断言：opaque 名单除 usage / 群 usage 分支四要素 / ledger+Σ / finalize 收尾
 *      / reset 清桶 / total 公式 / delta 估算兜底+usageSeen 旗
 *   D. 全链接线：main 解构+groupDeps 注入 / wg 源码三要素 / styles display:none + 下拉项 desc 保留
 *   E. 版本 ≥ 3.42.1（宽松惯例：写死会在下次 bump 翻红本测试）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const wgPath = path.join(ROOT, "src/main/workgroup-chat.cjs");
const wgSrc = fs.readFileSync(wgPath, "utf8");
const convSrc = read("src/main/conversations.cjs");
const mainSrc = read("src/main/main.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const stylesSrc = read("src/renderer/styles.css");
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

const events = [];        // sender.send 记录（{channel, payload}）
const ledger = [];        // addAssistantMessage 落库记录（{cid, text, usage, meta}）
const usageMerges = [];   // addUsageToMessage 追账记录（{cid, rid, usage}）
const toolContexts = [];  // executeToolCall 收到的 context
let cloudCalls = 0;
let subCalls = 0;
let disposed = 0;
// ⚠️ wg 顶层 `const { sendCloudChat } = require(...)` 解构缓存了函数引用——运行时替换
// stubs 属性对已加载的 wg 无效；场景差异一律走本 hook 变量（函数体每次调用时读它）
let cloudSendHook = null;

const plainReply = (cbs, text) => {
  cbs.onDelta(text);
  return { text, usage: { promptTokens: 7, completionTokens: 3 } };
};

// 真实现的 accumulateUsage 口径（mock 必须与 src/main/cloud-chat.cjs L159 一致——mock 简化版只累 requests 会漏真账断言）
const realAccumulateUsage = (total, usage) => {
  if (!usage || typeof usage !== "object") return 0;
  const prompt = Number(usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
  if (!prompt && !completion) return 0;
  total.prompt += prompt;
  total.completion += completion;
  total.total += prompt + completion;
  total.requests += 1;
  return prompt + completion;
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
    accumulateUsage: realAccumulateUsage,
  },
  "cloud-tools.cjs": {
    toolDefinitions: () => [{ type: "function", function: { name: "read_file" } }],
    executeToolCall: async (call, context) => { toolContexts.push({ call, context }); return "（文件内容）"; },
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
    whitelistedCloudTargets: () => global.__poolCloudTargets || [
      { kind: "cloud", agentId: "ap-sub", name: "子肥猴", provider: "zhipu", model: "glm-sub-1", baseURL: "", apiKey: "sk-sub" },
      { kind: "cloud", agentId: "ap-sub-2", name: "子肥猪", provider: "zhipu", model: "glm-sub-2", baseURL: "", apiKey: "sk-sub" },
    ],
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

const realSyncGetMode = (id) => (id === "automatic" || id === "regular" ? { id, name: id, systemPrompt: `（内置模式 ${id}）` } : null);
const conversationShape = { id: "conv-guard", messages: [{ role: "user", text: "各位在吗？" }] };

function makeDeps(overrides = {}) {
  events.length = 0;
  ledger.length = 0;
  usageMerges.length = 0;
  toolContexts.length = 0;
  cloudCalls = 0;
  subCalls = 0;
  disposed = 0;
  cloudSendHook = null;
  global.__poolGhosts = [];
  global.__poolAgents = null;
  global.__poolCloudTargets = null;
  return Object.assign({
    getConversation: async () => conversationShape,
    getMode: realSyncGetMode,
    groupTools: () => ({ enabled: false, sandbox: false, allowCommand: false, workdir: "", environmentText: "" }),
    saveAssistantDraft: () => {},
    addUsageToMessage: (cid, rid, usage) => usageMerges.push({ cid, rid, usage }),
    activeRequests: new Map(),
    addAssistantMessage: (cid, text, sessionId, files, tools, requestId, mode, usage, duration, engine, profileId, adapter, thinking, meta) => ledger.push({ cid, text, usage, meta, requestId, mode }),
    addUserMessage: () => {},
    askUserRegistry: { wait: async () => "__timeout__" },
    executeToolCall: stubs["cloud-tools.cjs"].executeToolCall,
    sender: { send: (channel, payload) => events.push({ channel, payload }) },
    log: () => {},
  }, overrides);
}

/** 轮询等一个条件（后台异步链收口断言用） */
async function waitFor(fn, timeoutMs = 2000, label = "条件") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (fn()) return; } catch { /* 条件未满足继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

const eventType = (type) => events.filter((item) => item.payload?.type === type);
/** 真账事件（cumulative 绝对值）——按会话过滤（events 跨测试共享，前序测试迟到事件会漏进来） */
const usageOf = (conversationId) =>
  events.filter((item) =>
    item.channel === "chat:event" &&
    item.payload?.type === "usage" &&
    item.payload?.usage?.cumulative === true &&
    item.payload?.conversationId === conversationId);
const settledOf = (conversationId) => eventType("group-turn-settled").filter((item) => item.payload?.conversationId === conversationId);
const startsOf = (conversationId) => eventType("group-turn-start").filter((item) => item.payload?.turn?.conversationId === conversationId);

async function runRealWorkgroupTests() {
  await test("A1. 云成员轮工具循环：每轮轮末发累计真账（cumulative 绝对值递增=Σ每轮请求，含输入）+ conversationId 随行", async () => {
    const deps = makeDeps({
      groupTools: () => ({ enabled: true, sandbox: false, allowCommand: false, workdir: "/tmp/wg-guard", environmentText: "" }),
    });
    // 工具循环两轮：首轮吐 usage(100,50)+工具调用 → 第二轮（上下文已回填）吐 usage(300,20) 收口
    cloudSendHook = async (config, msgs, cbs) => {
      const rawCount = (Array.isArray(msgs) ? msgs : []).filter((m) => m.raw).length;
      return rawCount === 0
        ? { text: "先读文件", usage: { promptTokens: 100, completionTokens: 50 }, toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }] }
        : { text: "读完了", usage: { promptTokens: 300, completionTokens: 20 } };
    };
    await wg.runGroupTurn(deps, { conversationId: "c-usage1", workgroupId: "wg-test", message: "读文件", workModeId: "automatic", mentionedAgentIds: ["大肥？"] });
    await waitFor(() => settledOf("c-usage1").length === 1, 2000, "settled(c-usage1)");
    const usages = usageOf("c-usage1");
    assert.ok(usages.length >= 2, `工具循环两轮应各发一次累计真账，实际 ${usages.length}`);
    const first = usages[0].payload.usage;
    const last = usages[usages.length - 1].payload.usage;
    assert.strictEqual(first.totalTokens, 150, `首轮累计应为 150（100 输入 + 50 输出），实际 ${first.totalTokens}`);
    assert.strictEqual(last.totalTokens, 470, `轮末累计应为 470（第一轮 150 + 第二轮 320），实际 ${last.totalTokens}`);
    assert.strictEqual(last.requests, 2, "累计真账应带请求次数");
    assert.ok(usages[usages.length - 1].payload.id, "usage 事件应随 id=群轮 requestId（渲染层桶键）");
    assert.ok(usages.every((u) => u.payload.conversationId === "c-usage1"), "累计真账应带 conversationId（渲染层路由红线）");
  });

  await test("A2. 纯聊轮（单请求无工具）也发轮末真账——每成员轮一次，双成员两条", async () => {
    const deps = makeDeps();
    await wg.runGroupTurn(deps, { conversationId: "c-usage2", workgroupId: "wg-test", message: "在吗", workModeId: "regular", mentionedAgentIds: [] });
    await waitFor(() => settledOf("c-usage2").length === 1, 2000, "settled(c-usage2)");
    const usages = usageOf("c-usage2");
    assert.strictEqual(usages.length, 2, `双成员纯聊应各发一次轮末真账，实际 ${usages.length}`);
    assert.strictEqual(usages[0].payload.usage.totalTokens, 10, `plainReply 喂 7+3=10，实际 ${usages[0].payload.usage.totalTokens}`);
    assert.strictEqual(usages[0].payload.usage.requests, 1);
  });

  await test("A3. 取消轮真账照发（用户停止时的已耗不丢）", async () => {
    const deps = makeDeps();
    cloudSendHook = async (config, msgs, cbs) => ({ text: "已中断", cancelled: true, usage: { promptTokens: 500, completionTokens: 200 } });
    await wg.runGroupTurn(deps, { conversationId: "c-usage3", workgroupId: "wg-test", message: "停一下", workModeId: "automatic", mentionedAgentIds: ["大肥？"] });
    await waitFor(() => settledOf("c-usage3").length === 1, 2000, "settled(c-usage3)");
    const usages = usageOf("c-usage3");
    assert.ok(usages.length >= 1, `取消轮应仍发真账，实际 ${usages.length}`);
    assert.strictEqual(usages[usages.length - 1].payload.usage.totalTokens, 700, "取消时的累计真账应为 700");
    await waitFor(() => ledger.length >= 1, 2000, "取消轮落库");
    assert.ok(ledger.some((item) => item.requestId && item.usage && item.usage.totalTokens === 700), "取消轮落库应带真账 usage");
  });

  await test("A4. 子 Agent 子轮：onUsage 收账（换脑 rerun 两 attempt 合计 55）+ 流中事件带 subId（渲染层独立桶键形态）", async () => {
    const deps = makeDeps({
      getMode: realSyncGetMode,
      askUserRegistry: { wait: async () => "同意换脑" },
    });
    cloudSendHook = async (config, msgs, cbs) => {
      const sys = String(msgs[0]?.content || "");
      // ⚠️ 判定用 executeSubAgent 独有字眼「被群内成员派生」——群成员轮的协作协议系统段里也有「子 Agent」词，误判会串
      if (sys.includes("被群内成员派生")) {
        subCalls += 1;
        cbs.onUsage({ promptTokens: subCalls === 1 ? 10 : 30, completionTokens: subCalls === 1 ? 5 : 10 });
        return subCalls === 1
          ? { text: "我先请求换脑：\n```brain_swap\n{\"target\":\"@子肥猪\",\"reason\":\"额度稳\"}\n```\n（首答）" }
          : { text: "换脑重跑完成" };
      }
      return plainReply(cbs, "派生一下\n```sub_agent\n{\"task\":\"查数\",\"agent\":\"ap-sub\"}\n```\n");
    };
    await wg.runGroupTurn(deps, { conversationId: "c-sub1", workgroupId: "wg-test", message: "派生查数", workModeId: "automatic", mentionedAgentIds: ["大肥？"] });
    await waitFor(() => settledOf("c-sub1").length === 1, 2000, "settled(c-sub1)");
    const subUsageEvents = events.filter((item) =>
      item.channel === "chat:event" &&
      item.payload?.type === "usage" &&
      String(item.payload?.subId || "").startsWith("sub-") &&
      item.payload?.conversationId === "c-sub1");
    assert.ok(subUsageEvents.length >= 2, `子轮两次请求（首答+换脑 rerun）各发一次累计真账，实际 ${subUsageEvents.length}`);
    assert.strictEqual(subUsageEvents[subUsageEvents.length - 1].payload.usage.totalTokens, 55, `子轮换脑 rerun 账应累计（15+40=55），实际 ${subUsageEvents[subUsageEvents.length - 1].payload.usage.totalTokens}`);
    assert.strictEqual(subUsageEvents[subUsageEvents.length - 1].payload.usage.requests, 2);
  });

  await test("A5. 子轮真账落库追账：runSubAgentsForMember→addUsageToMessage（父轮 requestId 锚点）", async () => {
    const deps = makeDeps({ askUserRegistry: { wait: async () => "同意换脑" } });
    cloudSendHook = async (config, msgs, cbs) => {
      if (String(msgs[0]?.content || "").includes("被群内成员派生")) {
        subCalls += 1;
        cbs.onUsage({ promptTokens: 10, completionTokens: 5 });
        return subCalls === 1
          ? { text: "\n```brain_swap\n{\"target\":\"@子肥猪\",\"reason\":\"继续任务\"}\n```\n" }
          : { text: "子轮完成" };
      }
      return plainReply(cbs, "派生出\n```sub_agent\n{\"task\":\"统计\",\"agent\":\"ap-sub\"}\n```\n");
    };
    const out = await wg.runGroupTurn(deps, { conversationId: "c-sub2", workgroupId: "wg-test", message: "统计一下", workModeId: "automatic", mentionedAgentIds: ["大肥？"] });
    await waitFor(() => settledOf("c-sub2").length === 1, 2000, "settled(c-sub2)");
    const memberRequestId = out.turns[0].requestId;
    assert.ok(usageMerges.length === 1, `子轮账应追账落库一次，实际 ${usageMerges.length}`);
    const merge = usageMerges[0];
    assert.strictEqual(merge.cid, "c-sub2", "追账会话应正确");
    assert.strictEqual(merge.rid, memberRequestId, "追账锚点应为父成员轮 requestId（子轮晚于父轮落库）");
    assert.strictEqual(merge.usage.totalTokens, 30, `子轮两 attempt 累计账应为 30（15+15），实际 ${merge.usage.totalTokens}`);
    assert.strictEqual(merge.usage.requests, 2);
  });

  await test("A6. 云轮失败分支：已耗账也照发照落（网络断半途的账不丢）", async () => {
    // 半途失败真场景：首轮发工具调用（账已发生）→ 工具执行后第二轮 throw「连接超时」
    const deps2 = makeDeps({
      groupTools: () => ({ enabled: true, sandbox: false, allowCommand: false, workdir: "/tmp/wg-guard", environmentText: "" }),
    });
    let once = true;
    cloudSendHook = async (config, msgs, cbs) => {
      const rawCount = (Array.isArray(msgs) ? msgs : []).filter((m) => m.raw).length;
      if (rawCount === 0 && once) { once = false; return { text: "读吧", usage: { promptTokens: 20, completionTokens: 10 }, toolCalls: [{ id: "t2", name: "read_file", arguments: "{}" }] }; }
      throw new Error("连接超时");
    };
    await wg.runGroupTurn(deps2, { conversationId: "c-usage6", workgroupId: "wg-test", message: "读文件", workModeId: "automatic", mentionedAgentIds: ["大肥？"] });
    await waitFor(() => settledOf("c-usage6").length === 1, 2000, "settled(c-usage6)");
    await waitFor(() => ledger.some((item) => item.usage && item.usage.totalTokens === 30 && item.text.includes("失败")), 2000, "失败轮落库带真账（占位文本+usage）");
    const usages = usageOf("c-usage6");
    assert.ok(usages.length >= 1, `失败轮已耗账应照发，实际 ${usages.length}`);
    assert.strictEqual(usages[usages.length - 1].payload.usage.totalTokens, 30);
  });
}

// ════════════════ B. conversations.cjs 真单测 ════════════════
async function runConversationsTests() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3421-"));
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return { app: { getPath: () => tmp } };
    if (request.endsWith("archive.cjs")) return { archiveFileName: (title, createdAt, id) => `archive-${String(id || title || "x").slice(0, 40)}.md`, archiveMarkdown: () => "#" };
    if (request.endsWith("storage.cjs")) return { ARCHIVE_FOLDER: "会话归档", migrateConversationDirectory: async () => 0 };
    return originalLoad.apply(this, arguments);
  };
  const convAbs = path.join(ROOT, "src/main/conversations.cjs");
  delete require.cache[convAbs];
  const conversations = require(convAbs);
  Module._load = originalLoad;

  await test("B1. 群成员消息落库保留 requestId（子轮账追账锚点）；无 agentMeta 的单聊消息照旧不留", () => {
    const cid = conversations.createConversation("team").id;
    conversations.addAssistantMessage(cid, "成员回复", "", [], [], "rid-B1", "cloud",
      { inputTokens: 100, outputTokens: 20, totalTokens: 120, cumulative: true, requests: 1 }, undefined, "claude", "", "claude", "", { agentId: "ap-test", name: "大肥？" });
    const conv = conversations.getConversation(cid);
    const memberMsg = conv.messages.find((message) => message.role === "assistant" && message.requestId === "rid-B1");
    assert.ok(memberMsg, "群成员消息应保留 requestId（追账锚点）");
    assert.ok(memberMsg.agent, "群成员消息应带 agent 归因");
    // 单聊路径（无 agentMeta）不留 requestId（旧语义保持）
    const cid2 = conversations.createConversation("single").id;
    conversations.addAssistantMessage(cid2, "单聊回复", "", [], [], "rid-B1x", "cloud", undefined);
    const conv2 = conversations.getConversation(cid2);
    assert.strictEqual(conv2.messages.filter((message) => message.role === "assistant" && message.requestId).length, 0, "单聊落库不应保留 requestId（旧语义）");
  });

  await test("B2. addUsageToMessage 累计合并（cumulative 保持 + 四值相加，真账覆盖估算）", () => {
    const cid = conversations.createConversation("team").id;
    conversations.addAssistantMessage(cid, "成员回复", "", [], [], "rid-B2", "cloud",
      { inputTokens: 100, outputTokens: 20, totalTokens: 120, cumulative: true, requests: 1 }, undefined, "claude", "", "claude", "", { agentId: "ap-test", name: "大肥？" });
    conversations.addUsageToMessage(cid, "rid-B2", { inputTokens: 10, outputTokens: 5, totalTokens: 15, requests: 2 });
    const msg = conversations.getConversation(cid).messages.find((message) => message.requestId === "rid-B2");
    assert.deepStrictEqual(msg.usage, { inputTokens: 110, outputTokens: 25, totalTokens: 135, cumulative: true, requests: 3 });
    // 重算口径：loadConversation 的 tokensForMessage 走 cumulative 真账 totalTokens=135
    assert.strictEqual(Number(msg.usage.totalTokens), 135);
  });

  await test("B3. addUsageToMessage 兼容原始账形态（prompt/completion/total）", () => {
    const cid = conversations.createConversation("team").id;
    conversations.addAssistantMessage(cid, "成员回复", "", [], [], "rid-B3", "cloud", undefined, undefined, "claude", "", "claude", "", { agentId: "ap-test", name: "大肥？" });
    conversations.addUsageToMessage(cid, "rid-B3", { prompt: 40, completion: 10, total: 50, requests: 1 });
    const msg = conversations.getConversation(cid).messages.find((message) => message.requestId === "rid-B3");
    assert.deepStrictEqual(msg.usage, { inputTokens: 40, outputTokens: 10, totalTokens: 50, cumulative: true, requests: 1 });
  });

  await test("B4. addUsageToMessage：消息不存在/空账 → 静默 no-op（不阻塞群主链）", () => {
    const cid = conversations.createConversation("team").id;
    const before = JSON.stringify(conversations.getConversation(cid));
    conversations.addUsageToMessage(cid, "rid-ghost", { totalTokens: 500, requests: 1 }); // 无此消息
    assert.strictEqual(JSON.stringify(conversations.getConversation(cid)), before, "无对应消息应 no-op");
    const cid2 = conversations.createConversation("team").id;
    conversations.addAssistantMessage(cid2, "回复", "", [], [], "rid-B4", "cloud", undefined, undefined, "claude", "", "claude", "", { agentId: "ap-test", name: "大肥？" });
    const before2 = JSON.stringify(conversations.getConversation(cid2));
    conversations.addUsageToMessage(cid2, "rid-B4", { inputTokens: 0, outputTokens: 0 }); // 空账（requests 也是 0）
    assert.strictEqual(JSON.stringify(conversations.getConversation(cid2)), before2, "空账应 no-op");
  });

  await test("B5. draft 转正后 requestId 保留（群成员草稿链不丢锚点）", () => {
    const cid = conversations.createConversation("team").id;
    conversations.saveAssistantDraft(cid, "rid-B5", "流中草稿");
    conversations.addAssistantMessage(cid, "草稿转正", "", [], [], "rid-B5", "cloud",
      { inputTokens: 3, outputTokens: 4, totalTokens: 7, cumulative: true, requests: 1 }, undefined, "claude", "", "claude", "", { agentId: "ap-test", name: "大肥？" });
    const msg = conversations.getConversation(cid).messages.find((message) => message.role === "assistant" && message.text === "草稿转正");
    assert.ok(msg, "draft 应转正");
    assert.strictEqual(msg.requestId, "rid-B5", "转正后应保留 requestId（追账锚点不掉）");
    assert.strictEqual(msg.usage?.totalTokens, 7, "转正应带真账 usage");
  });
}

// ════════════════ C. 渲染层源码断言 ════════════════
async function runRendererTests() {
  await test("C1. 群轮 opaque 名单已从 usage 中解除（真账照收不改单聊状态条投影）", () => {
    assert.ok(!/const GROUP_OPAQUE_EVENTS = \[.*"usage"/.test(rendererSrc), "GROUP_OPAQUE_EVENTS 仍含 usage——真账会被整类丢弃");
    assert.ok(/const GROUP_OPAQUE_EVENTS = \["upload", "connection", "lifecycle"\];/.test(rendererSrc), "opaque 名单形态应只留 upload/connection/lifecycle");
  });

  await test("C2. 群轮 usage 分支四要素：conversationId 路由（后台账不挪用）/ 只吃 cumulative / subId 独立桶键 / 覆盖入桶", () => {
    const opaqueStart = rendererSrc.indexOf("const GROUP_OPAQUE_EVENTS");
    const branch = rendererSrc.indexOf('if (event.type === "usage")', opaqueStart);
    assert.ok(branch > 0, "群轮 usage 分支缺失");
    const slice = rendererSrc.slice(branch, branch + 1400);
    assert.ok(slice.includes("eventConversationId !== conversationId"), "后台群轮账路由缺失（v3.15.1 红线对偶）");
    assert.ok(slice.includes("event.usage?.cumulative !== true"), "应只吃累计真账（流中原始单轮账忽略）");
    assert.ok(slice.includes("event.subId"), "子轮 usage 应带 subId 独立桶键（不与成员轮互踩）");
    assert.ok(slice.includes("groupUsageLedger.set(usageKey, realUsage)"), "真账应写群账桶（absolute 覆盖）");
    assert.ok(slice.includes("liveTurn.usageSeen = true"), "真账到达应立 usageSeen 旗（估算止步）");
  });

  await test("C3. finalizeGroupTurn 收尾：父轮+子轮桶一并并入会话账并清桶", () => {
    const finalizeStart = rendererSrc.indexOf("async function finalizeGroupTurn");
    const slice = rendererSrc.slice(finalizeStart, finalizeStart + 2600);
    assert.ok(slice.includes("groupUsageLedger"), "finalizeGroupTurn 应处理群账桶");
    assert.ok(slice.includes("startsWith(`"+"${"+"requestId}:"+"`"+")"), "子轮桶键前缀清账缺失");
    assert.ok(slice.includes("conversationTokens += settledUsage"), "收尾应把真账并入会话累计账(等落库真账的实时记账点)");
  });

  await test("C4. resetStreamingTokens 清群账桶（切会话/重载不留残留账）", () => {
    const resetStart = rendererSrc.indexOf("function resetStreamingTokens");
    const slice = rendererSrc.slice(resetStart, resetStart + 260);
    assert.ok(slice.includes("groupUsageLedger.clear()"), "resetStreamingTokens 应清空群账桶");
  });

  await test("C5. 计数器公式=会话累计+群账桶Σ（群聊所有 AI 加起来一条，不按成员拆条）", () => {
    assert.ok(rendererSrc.includes("confirmedTokens + groupUsageLedgerSum()"), "total 应并入群账桶Σ");
    assert.ok(rendererSrc.includes("function groupUsageLedgerSum()"), "群账桶求和 helper 缺失");
  });

  await test("C6. 群 delta 流内估算兜底（SSH/本地成员轮没真账事件也不空转）+ usageSeen 旗止步", () => {
    const flush = rendererSrc.indexOf("live.text += chunkText;");
    assert.ok(flush > 0, "群 delta flush 写点缺失");
    const slice = rendererSrc.slice(flush, flush + 720);
    assert.ok(slice.includes("groupUsageLedger.set(String(rid), estimateTokens(live.text))"), "流内估算应入群账桶（与重算口径同源）");
    assert.ok(slice.includes("if (!live.usageSeen"), "估算应有 usageSeen 旗止步（不覆盖真账）");
    assert.ok(slice.includes("live.conversationId) === String(conversationId)"), "后台群轮估算应带会话路由（不挪用当前对话计数）");
  });
}

// ════════════════ D. 全链接线断言 ════════════════
async function runWiringTests() {
  await test("D1. main.cjs：conversations 解构 + groupDeps 注入 addUsageToMessage（子轮追账落库通道）", () => {
    const { count } = { count: (mainSrc.match(/addUsageToMessage/g) || []).length };
    assert.ok(count >= 2, `main.cjs 应在解构与 groupDeps 两处接线 addUsageToMessage，实际 ${count} 处`);
    const groupDeps = mainSrc.slice(mainSrc.indexOf("const groupDeps = () => ({"));
    assert.ok(groupDeps.includes("addUsageToMessage"), "groupDeps 注入缺失（wg 里 ctx.deps.addUsageToMessage 调不到）");
  });

  await test("D2. workgroup-chat.cjs：成员轮轮末真账 emit + 子轮 onUsage 收账 emit + 落库追账三要素", () => {
    assert.ok(wgSrc.includes('ctx.emit(requestId, { type: "usage", usage: slimUsage(usageTotal), conversationId: input.conversationId }'), "成员轮轮末真账 emit 缺失（cumulative 绝对值 + conversationId）");
    assert.ok(wgSrc.includes("onUsage: (usage) =>"), "子轮 onUsage 接线缺失");
    assert.ok(wgSrc.includes('ctx.emit(opts.parentRequestId, { type: "usage", subId, usage: slimUsage(subUsageTotal)'), "子轮 usage 事件形态（subId 随行）缺失");
    assert.ok(wgSrc.includes("ctx.deps.addUsageToMessage?.(input.conversationId, requestId, result.usage)"), "子轮账追账落库缺失");
    assert.ok((wgSrc.match(/usage: slimSubUsage\(\)/g) || []).length >= 6, `executeSubAgent 各 return 应带子轮真账（含换脑/熔断重跑），实际 ${(wgSrc.match(/usage: slimSubUsage\(\)/g) || []).length} 处`);
  });

  await test("D3. 副标题回归下拉：收起条内 display:none，下拉列表项 workspace-item-desc 照常", () => {
    assert.ok(/\.workspace-desc \{ display: none; \}/.test(stylesSrc), "收起条副标题未隐藏");
    assert.ok(/\.workspace-item-desc \{ font-size: 11px/.test(stylesSrc), "下拉列表项 desc 样式应保留（副标题出现的正确位置）");
    assert.ok(/workspace-item-desc`/.test(rendererSrc) || /workspace-item-desc/.test(rendererSrc), "下拉列表项 desc 渲染应保留");
  });

  await test("D4. 静态 HTML：workspace-trigger 收起条结构保留（无破坏性改动，样式隐藏即可）", () => {
    const indexSrc = read("src/renderer/index.html");
    assert.ok(indexSrc.includes('id="workspace-desc"'), "workspace-desc 节点应保留（桥版兼容）");
    assert.ok(indexSrc.includes('id="workspace-item-desc"') || indexSrc.includes("workspace-item-desc") === false, "下拉 desc 由 JS 动态渲染（HTML 无固定节点也正常）");
  });
}

// ════════════════ E. 版本 ════════════════
async function runVersionTests() {
  await test("E1. 版本号 ≥ 3.42.1（宽松惯例）", () => {
    const toNumber = (v) => Number(String(v || "").split(".").map((n) => String(Number(n)).padStart(4, "0")).join("")) || 0;
    assert.ok(toNumber(pkg.version) >= toNumber("3.42.1"), `当前版本 ${pkg.version}`);
  });
}

(async () => {
  console.log("\n── A. workgroup-chat 行为真跑 ──");
  await runRealWorkgroupTests();
  console.log("\n── B. conversations.cjs 真单测 ──");
  await runConversationsTests();
  console.log("\n── C. 渲染层源码断言 ──");
  await runRendererTests();
  console.log("\n── D. 全链接线断言 ──");
  await runWiringTests();
  console.log("\n── E. 版本 ──");
  await runVersionTests();
  console.log(`\n${passed} 项通过, ${failed} 项失败`);
  if (failed > 0) { failures.forEach((f) => console.log(`✗ ${f}`)); process.exit(1); }
  console.log(`test-v3-42-1: ${passed} 项全绿`);
})().catch((error) => { console.error(error); process.exit(1); });
