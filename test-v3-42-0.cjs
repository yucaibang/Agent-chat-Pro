"use strict";
/**
 * v3.42.0 守门测试 — 群聊线四修（装机实测反馈）
 *
 * 用户四点（来源 LISA-PC）：
 *   ①当用户发出消息时，所有成员没有任何思考过程/工具卡出现——不知道他们在干嘛
 *     根因=chat:group-send 实为「handler await runGroupTurn 全程」（v3.35.6 设计意图
 *     "立即返回 turns[]" 被实现落空），渲染层拿到 turns 时全组已终态，气泡批量出终态。
 *     修复=启动即返 + group-turn-start 事件即时建「正在思考」气泡（thinking/工具卡/round 随之实时上屏）。
 *   ②群成员默认没有工具执行，则是聊天状态，应默认执行模式
 *     根因=groupTools() 形态 `enabled = toolsEnabled && !sandboxOn && workdir`——v3.22.0 沙箱是
 *     推荐开的，用户开着沙箱 → 群成员永远纯聊天且零提示。修复=沙箱照常注入工具组，接 createSandboxBridge
 *     共享沙箱执行器（SSH→docker exec 容器内 /workspace），建连失败降级纯聊天并上屏原因。
 *   ③自主讨论没真实执行（=①②复合：接力链全程不可见+成员无工具）
 *   ④群聊思考面板成员滑条叠加过高，顶到应用顶上没有空间显示——应做上下滚动
 *     修复=.think-group-rows 独立限高滚动 + .composer-mode-popup 整体兜底限高滚动。
 * 顺带（v3.41.1 连带缺陷清单）：幽灵成员（池节点已删）不再静默出局，出灰态缺席气泡；
 *     失败轮气泡显示真实失败原因（不再一律「本轮无输出」）。
 *
 * 覆盖：
 *   A. 行为真跑（require.cache 注入 mock + 真实 workgroup-chat.cjs）：
 *      A1 启动即返：runGroupTurn resolve 时轮仍在进行（挂期 sendCloudChat），activeRequests 已登记
 *      A2 group-turn-start 事件：每轮启动即外发（turn 带 agentId/name/kind/requestId）
 *      A3 全组终局 group-turn-settled 事件（收口信号）
 *      A4 沙箱语义真跑：context.workdir=/workspace + sandboxExecutor 随行 + 终局 dispose
 *      A5 沙箱建连失败：降级纯聊天 + round mark 上屏原因（不再静默零工具）
 *      A6 幽灵成员：turns 含 ghost 轮（不 throw、正常轮照跑）
 *      A7 幽灵全灭：agents 空但 ghosts 有 → 不 throw，turns 全为缺席提示轮
 *      A8 自主讨论接力链完整：逐轮启动事件+发言上限语义不被重构破坏
 *   B. 主进程源码断言：
 *      B1 groupTools 沙箱语义（禁写法已除+新形态在场）
 *      B2 createSandboxBridge 定义（SSH connect+exec+dispose）
 *      B3 cloudSandboxEnvironmentNote 定义+沙箱分支引用
 *      B4 agent-pool ghosts 收集+返回
 *      B5 轮启动事件双发（startCloud+registerRunner）+ 后台收尾三件（dispose/清旗/settled emit）
 *   C. 渲染层源码断言：
 *      C1 ensureGroupTurnBubble 幂等+悬等注册+ghost 分流
 *      C2 onChatEvent group-turn-start / group-turn-settled 分支
 *      C3 finalizeGroupTurn 失败原因/未启动消费 + 逐轮收口
 *      C4 sendGroupTurn 启动即返适配（快照 ensure+布防+旧收口移除）
 *      C5 emergencyStop 停止=取消分支解除布防
 *      C6 addMessage ghost 徽章「缺席」
 *   D. CSS 断言：成员堆叠区独立滚动 + 浮层兜底滚动
 *   E. 版本 ≥ 3.42.0（宽松惯例：写死会在下次 bump 翻红）
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
const poolSrc = read("src/main/agent-pool.cjs");
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
const ledger = [];        // addAssistantMessage 落库记录
const toolContexts = [];  // executeToolCall 收到的 context
let cloudCalls = 0;
let disposed = 0;
// ⚠️ wg 顶层 `const { sendCloudChat } = require(...)` 解构缓存了函数引用——运行时替换
// stubs 属性对已加载的 wg 无效；场景差异一律走本 hook 变量（函数体每次调用时读它）
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
  toolContexts.length = 0;
  cloudCalls = 0;
  disposed = 0;
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
/** 按会话过滤 settled/starts——events 是跨测试共享数组（前序测试未收尾轮的迟到事件会漏进来） */
const settledOf = (conversationId) => eventType("group-turn-settled").filter((item) => item.payload?.conversationId === conversationId);
const startsOf = (conversationId) => eventType("group-turn-start").filter((item) => item.payload?.turn?.conversationId === conversationId);
const cloudAgent = { agentId: "ap-test", name: "大肥？", kind: "cloud", provider: "zhipu", model: "glm-test", baseURL: "", apiKey: "sk-guard", thinkingLevel: "" };

async function runUnitTests() {
  await test("A1. 启动即返：runGroupTurn resolve 时仍有成员轮在跑（首成员 sendCloudChat 挂期）+ activeRequests 已登记", async () => {
    const deps = makeDeps();
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    const blindCallbacks = { onDelta: () => {} };
    cloudSendHook = async () => (cloudCalls === 1
      ? gate.then(() => plainReply(blindCallbacks, "挂期回复"))
      : plainReply(blindCallbacks, "x"));
    const out = await wg.runGroupTurn(deps, { conversationId: "c1", workgroupId: "wg-test", message: "在吗", workModeId: "automatic", mentionedAgentIds: [] });
    assert.strictEqual(out.turns.length, 2, `turns 快照应已注册 2 轮（mock 双成员），实际 ${out.turns.length}`);
    // resolve 与成员轮首个 await 之间的微任务续延（activeRequests.set 等）在后续 tick 才跑——waitFor 轮询间隙给它们让路
    await waitFor(() => deps.activeRequests.size === 1 && cloudCalls >= 1, 2000, "首成员轮进入挂期（activeRequests 登记 + 次成员轮已即时收尾）");
    assert.strictEqual(startsOf("c1").length, 2, "两条启动事件应先于 runGroupTurn resolve 外发");
    release();
    await waitFor(() => settledOf("c1").length === 1, 2000, "settled(c1)");
    await waitFor(() => deps.activeRequests.size === 0, 2000, "轮收尾清 activeRequests");
  });

  await test("A2. group-turn-start 事件形态：agentId/name/kind/requestId/conversationId 全集（渲染层建「正在思考」气泡的原料）", async () => {
    const deps = makeDeps();
    const out = await wg.runGroupTurn(deps, { conversationId: "c2", workgroupId: "wg-test", message: "hi", workModeId: "regular", mentionedAgentIds: [] });
    const starts = startsOf("c2");
    assert.strictEqual(starts.length, 2, `双成员应两条启动事件，实际 ${starts.length}`);
    const turn = starts[0].payload.turn;
    for (const key of ["requestId", "agentId", "name", "kind", "conversationId"]) assert.ok(turn[key], `turn.${key} 缺失`);
    assert.strictEqual(turn.kind, "cloud");
    assert.strictEqual(turn.requestId, out.turns[0].requestId, "事件 turn 与快照轮应同 requestId");
    const snapshotIds = new Set(out.turns.map((t) => t.requestId));
    assert.strictEqual(starts.filter((item) => snapshotIds.has(item.payload.turn.requestId)).length, 2, "每条启动事件都应能对回快照轮");
    await waitFor(() => settledOf("c2").length === 1, 2000, "settled(c2)");
  });

  await test("A3. 全组终局 emit group-turn-settled（渲染层收口信号，conversationId 随行）", async () => {
    const deps = makeDeps();
    await wg.runGroupTurn(deps, { conversationId: "c3", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    await waitFor(() => settledOf("c3").length === 1, 2000, "settled(c3)");
    const settled = settledOf("c3")[0];
    assert.strictEqual(settled.payload.conversationId, "c3", "settled 事件应带 conversationId");
    assert.strictEqual(settled.channel, "chat:event", "settled 应经 chat:event 外发");
    await waitFor(() => deps.activeRequests.size === 0, 2000, "全组终局后 activeRequests 清空");
  });

  await test("A4. 沙箱语义真跑：executeToolCall 收到 workdir=/workspace + 共享 sandboxExecutor + 终局 dispose", async () => {
    const deps = makeDeps({
      groupTools: () => ({ enabled: true, sandbox: true, allowCommand: true, workdir: "/workspace", environmentText: "（沙箱环境段）" }),
      createSandboxBridge: async () => ({ executor: { enabled: true, run: async () => ({ code: 0, stdout: "", stderr: "" }) }, dispose: () => { disposed += 1; } }),
    });
    cloudSendHook = async (cfg, msgs, cbs) => (toolContexts.length
      ? plainReply(cbs, "done")
      : { text: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }] });
    await wg.runGroupTurn(deps, { conversationId: "c4", workgroupId: "wg-test", message: "读文件", workModeId: "automatic", mentionedAgentIds: [] });
    await waitFor(() => toolContexts.length >= 1, 2000, "executeToolCall 被调");
    const ctx0 = toolContexts[0].context;
    assert.strictEqual(ctx0.workdir, "/workspace", "沙箱模式下工作目录语义应为容器内 /workspace");
    assert.ok(ctx0.sandboxExecutor && ctx0.sandboxExecutor.enabled === true && typeof ctx0.sandboxExecutor.run === "function", "沙箱执行器应随行且可用");
    await waitFor(() => settledOf("c4").length === 1, 2000, "settled(c4)");
    await waitFor(() => disposed === 1, 2000, "沙箱桥 finally dispose");
  });

  await test("A5. 沙箱建连失败：整组降级纯聊天 + round mark 上屏原因（不再静默零工具）", async () => {
    const deps = makeDeps({
      groupTools: () => ({ enabled: true, sandbox: true, allowCommand: false, workdir: "/workspace", environmentText: "" }),
      createSandboxBridge: async () => { throw new Error("沙箱执行需要 SSH 连接 NAS：connect ECONNREFUSED（首次使用请先在 SSH 页面完成一次连接以信任主机指纹）"); },
    });
    const out = await wg.runGroupTurn(deps, { conversationId: "c5", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    await waitFor(() => settledOf("c5").length === 1, 2000, "settled(c5)");
    assert.strictEqual(out.turns.length, 2, `降级后成员轮仍应正常注册（纯聊天），实际 ${out.turns.length}`);
    assert.strictEqual(ledger.length, 2, `两条降级轮应正常落库，实际 ${ledger.length}`);
    assert.ok(ledger.every((item) => item.includes("（守门 mock 回复）")), "落库应为降级轮正文");
    const marks = events.filter((item) => item.payload?.type === "round" && String(item.payload.mark || "").includes("沙箱连接失败"));
    assert.ok(marks.length >= 1, "应上屏「沙箱连接失败」原因徽标（round mark）");
    assert.strictEqual(disposed, 0, "失败建连无桥可释放（dispose 不被调）");
  });

  await test("A6. 幽灵成员：池节点已删 → turns 含 ghost 提示轮，正常成员轮照跑（不再静默出局）", async () => {
    const deps = makeDeps();
    global.__poolGhosts = ["ap-dead-node-uuid"];
    const out = await wg.runGroupTurn(deps, { conversationId: "c6", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    const ghostTurn = out.turns.find((turn) => turn.ghost);
    assert.ok(ghostTurn, "turns 应含 ghost 轮");
    assert.strictEqual(ghostTurn.agentId, "ap-dead-node-uuid", "ghost 轮应带幽灵 agentId");
    assert.ok(ghostTurn.name, "ghost 轮应有可读名（ID 前段）");
    assert.ok(ghostTurn.requestId, "ghost 轮应带渲染层锚 requestId");
    await waitFor(() => settledOf("c6").length === 1, 2000, "settled(c6)");
    assert.strictEqual(cloudCalls, 2, `正常成员轮不受幽灵影响（双成员 2 次云调用），实际 ${cloudCalls}`);
  });

  await test("A7. 幽灵全灭：agents 空但 ghosts 有 → 不 throw，turns 全为缺席提示轮", async () => {
    const deps = makeDeps();
    global.__poolAgents = [];
    global.__poolGhosts = ["ap-ghost-1", "ap-ghost-2"];
    const out = await wg.runGroupTurn(deps, { conversationId: "c7", workgroupId: "wg-test", message: "hi", workModeId: "", mentionedAgentIds: [] });
    assert.strictEqual(out.turns.length, 2, `两个幽灵应出两条缺席轮，实际 ${out.turns.length}`);
    assert.ok(out.turns.every((turn) => turn.ghost === true), "全部轮应为 ghost 形态");
    await waitFor(() => settledOf("c7").length === 1, 2000, "settled(c7)");
  });

  await test("A8. 自主讨论接力链完整（重构不破坏）：逐轮启动事件 + 发言上限语义", async () => {
    const deps = makeDeps();
    await wg.runGroupTurn(deps, { conversationId: "c8", workgroupId: "wg-test", message: "自主讨论一下", workModeId: "automatic", mentionedAgentIds: [], autoDiscuss: true, maxTurns: 3 });
    await waitFor(() => settledOf("c8").length === 1, 3000, "接力链收口");
    const starts = startsOf("c8");
    assert.strictEqual(starts.length, 3, `发言上限 3 → 3 轮启动事件，实际 ${starts.length}`);
    assert.strictEqual(cloudCalls, 3, `云端调用 3 次，实际 ${cloudCalls}`);
    const requestIds = new Set(starts.map((item) => item.payload.turn.requestId));
    assert.strictEqual(requestIds.size, 3, "三轮 requestId 应互不相同（接力逐轮注册）");
    await waitFor(() => deps.activeRequests.size === 0, 2000, "接力链终局 activeRequests 清空");
  });
}

// ════════════════ B/C/D/E 静态断言 ════════════════
async function runStaticTests() {
  await test("B1. groupTools 沙箱语义：禁写法已除 + 新形态在场（沙箱开启照常启用工具组）", () => {
    assert.ok(/toolsEnabled && \(sandboxOn \|\| Boolean\(workdir\)\)/.test(mainSrc), "新形态 `toolsEnabled && (sandboxOn || Boolean(workdir))` 应在场");
    assert.ok(!/!sandboxOn && Boolean\(workdir\)/.test(mainSrc), "旧禁写法 `!sandboxOn && Boolean(workdir)` 应已移除");
    assert.ok(/sandboxEnabled \? "\/workspace" : workdir/.test(mainSrc), "沙箱模式 workdir 语义应为 /workspace");
  });

  await test("B2. createSandboxBridge 定义：SSH connect + docker exec 通道 + dispose 释放", () => {
    assert.ok(/createSandboxBridge: async \(\)/.test(mainSrc), "groupDeps 应定义 createSandboxBridge");
    const from = mainSrc.indexOf("createSandboxBridge");
    const seg = mainSrc.slice(from, from + 2600);
    assert.ok(/await connect\(/.test(seg), "应建立 SSH 连接（connect）");
    assert.ok(/exec\(client, command, \{ timeoutMs, label: "沙箱命令", stdin \}\)/.test(seg), "命令应经 docker exec 通道");
    assert.ok(/dispose: \(\) => \{ try \{ client\.end\(\); \} catch/.test(seg), "dispose 应释放 SSH 连接");
    assert.ok(/首次使用请先在 SSH 页面完成一次连接以信任主机指纹/.test(seg), "建连失败中文指引应在场");
  });

  await test("B3. cloudSandboxEnvironmentNote：定义在场 + groupTools 沙箱分支引用（工具执行位置如实换位）", () => {
    assert.ok(/const cloudSandboxEnvironmentNote = \(\) =>/.test(mainSrc), "沙箱版环境段函数应定义");
    assert.ok(/sandboxEnabled \? cloudSandboxEnvironmentNote\(\) : cloudEnvironmentNote\(\)/.test(mainSrc), "groupTools 应按沙箱态切换环境段");
    const from = mainSrc.indexOf("cloudSandboxEnvironmentNote = () =>");
    assert.ok(/\/workspace/.test(mainSrc.slice(from, from + 1400)), "沙箱环境段应交代 /workspace");
  });

  await test("B4. agent-pool ghosts：幽灵收集 + 返回形态（不再静默 continue）", () => {
    assert.ok(/ghosts\.push\(member\.agentId\)/.test(poolSrc), "幽灵 agentId 应收集进 ghosts");
    assert.ok(/return \{ group, agents, ghosts \}/.test(poolSrc), "resolveGroupAgents 应返回 ghosts");
    assert.ok(/已删节点自动出局，但必须让用户知道它缺席了/.test(poolSrc), "幽灵出局语义注释应在场");
  });

  await test("B5. 启动事件双发 + 后台收尾三件（dispose/清旗/settled emit）+ 沙箱执行器随行", () => {
    assert.ok(/emitTurnStart\(\{ requestId, agentId: agent\.agentId, name: agent\.name, kind: "cloud"/.test(wgSrc), "startCloud 应外发轮启动事件");
    assert.ok(/const registerRunner = \(agent\) =>/.test(wgSrc), "registerRunner（先注册后排程）应定义");
    assert.ok(/ctx\.emitTurnStart\(turn\)/.test(wgSrc), "registerRunner 应外发轮启动事件");
    assert.ok(/type: "group-turn-settled"/.test(wgSrc), "后台收尾应 emit settled 事件");
    const tail = wgSrc.slice(wgSrc.indexOf("backgroundDone"));
    assert.ok(/sandboxBridge\?\.dispose\(\)/.test(tail), "收尾应释放沙箱桥");
    assert.ok(/stoppedConversations\.delete\(input\.conversationId\)/.test(tail), "收尾应清停止旗");
    const flat = wgSrc.replace(/\n\s+/g, " ");
    assert.ok(/sandboxExecutor: toolsInfo\.sandbox \? ctx\.sandboxBridge\?\.executor : undefined/.test(flat), "云成员轮 executeToolCall 应随行沙箱执行器");
    assert.ok(/sandboxBridgeError/.test(wgSrc), "沙箱建连失败降级链路应在场");
  });

  await test("C1. ensureGroupTurnBubble：幂等防重 + 悬等注册 + ghost 分流", () => {
    assert.ok(/function ensureGroupTurnBubble\(turn\)/.test(rendererSrc), "统一入口应定义");
    assert.ok(/if \(turn\.ghost\) return renderGhostTurnBubble\(turn\);/.test(rendererSrc), "幽灵轮分流灰态缺席气泡");
    assert.ok(/if \(groupTurnsLive\.has\(requestId\)\) return groupTurnsLive\.get\(requestId\)\.item;/.test(rendererSrc), "has 防重应在场");
    const from = rendererSrc.indexOf("function ensureGroupTurnBubble");
    const seg = rendererSrc.slice(from, from + 900);
    assert.ok(/awaitGroupTurn\(requestId\)/.test(seg), "建气泡同时应注册悬等");
    assert.ok(/finalizeGroupTurn\(requestId, \{ failed: true, error: \{ code: "IPC"/.test(seg), "悬等 catch 应兜可见失败态");
  });

  await test("C2. onChatEvent：group-turn-start / group-turn-settled 两分支在最前（不受 messages.get 影响）", () => {
    const from = rendererSrc.indexOf("window.agentChatPro.onChatEvent(");
    const seg = rendererSrc.slice(from, from + 1400);
    assert.ok(/event\.type === "group-turn-start"/.test(seg), "group-turn-start 分支应在场");
    assert.ok(/ensureGroupTurnBubble\(\{/.test(seg), "start 分支应调统一入口");
    assert.ok(/event\.type === "group-turn-settled"/.test(seg), "settled 分支应在场");
    assert.ok(/checkGroupSendSettle/.test(seg), "settled 分支应触发收口");
  });

  await test("C3. finalizeGroupTurn：失败原因/未启动消费 + 逐轮收口统计", () => {
    const from = rendererSrc.indexOf("async function finalizeGroupTurn");
    const seg = rendererSrc.slice(from, from + 2600);
    assert.ok(/本轮失败：\$\{err\.code \|\| "ERROR"\}/.test(seg), "失败轮应显示真实失败原因（不再一律「本轮无输出」）");
    assert.ok(/该轮未启动/.test(seg), "missing 轮应有可见文案");
    assert.ok(/turnResult\?\.cancelled\) item\.classList\.add\("interrupted"\)/.test(seg), "停止收口应有中断态样式");
    assert.ok(/state\.total \+= 1/.test(seg) && /if \(turnResult\?\.failed\) state\.failed \+= 1/.test(seg), "收口统计（成功+失败计数）应随逐轮 finalize 累计");
    assert.ok(/checkGroupSendSettle\(live\.conversationId\)/.test(seg), "finalize 应触发收口判定（双保险之一）");
  });

  await test("C4. sendGroupTurn 启动即返适配：快照 ensure + groupSendState 布防 + 旧收口移除", () => {
    assert.ok(/let groupSendState = null;/.test(rendererSrc), "群发收口状态应声明");
    assert.ok(/\(result\.turns \|\| \[\]\)\.forEach\(\(turn\) => ensureGroupTurnBubble\(/.test(rendererSrc), "快照建轮应走 ensure（幂等）");
    assert.ok(/groupSendState = \{ conversationId: groupNotifyConversationId, title: conversationTitle, armed: true, total: 0, failed: 0 \}/.test(rendererSrc), "发群时布防收口状态");
    assert.ok(/checkGroupSendSettle\(groupNotifyConversationId\);/.test(rendererSrc), "await resolve 后应立即兜底收口判定");
    const from = rendererSrc.indexOf("async function sendGroupTurn");
    const sendSeg = rendererSrc.slice(from, from + 4200);
    assert.ok(!/const groupTurnResults = \(result\.turns \|\| \[\]\)\.map\(/.test(sendSeg), "旧逐轮 Promise.all 悬等应移除（悬等注册移交 ensure）");
    assert.ok(!/Promise\.all\(groupTurnResults\)/.test(sendSeg), "旧收口 Promise.all 应移除（移交 checkGroupSendSettle）");
  });

  await test("C5. emergencyStopGroup：停止=取消分支解除布防（不再等 settle 事件）", () => {
    const from = rendererSrc.indexOf("async function emergencyStopGroup");
    const seg = rendererSrc.slice(from, from + 1800).replace(/\n\s+/g, " ");
    assert.ok(/if \(groupSendState && groupSendState\.armed\) groupSendState = \{ \.\.\.groupSendState, armed: false \}/.test(seg), "停止应解除收口布防");
  });

  await test("C6. addMessage ghost 徽章「缺席」+ renderGhostTurnBubble 终态文案", () => {
    assert.ok(/meta\.agent\.kind === "ghost" \? "缺席"/.test(rendererSrc), "ghost 类型徽章应为「缺席」");
    assert.ok(/已不在 Agent 池，本轮缺席/.test(rendererSrc), "缺席 note 文案应在场");
    assert.ok(/请到侧边栏「Agent 池」更新工作组成员/.test(rendererSrc), "缺席正文指引应在场");
  });

  await test("D1. 思考浮层滚动：成员堆叠区独立限高 + 浮层整体兜底（v3.42.0 修复④）", () => {
    const rows = stylesSrc.slice(stylesSrc.indexOf(".think-group-rows {"), stylesSrc.indexOf(".think-group-rows {") + 500);
    assert.ok(/max-height: 42vh/.test(rows), "成员堆叠区应独立限高（42vh）");
    assert.ok(/overflow-y: auto/.test(rows), "成员堆叠区应允许上下滚动");
    const popup = stylesSrc.slice(stylesSrc.indexOf(".composer-mode-popup"), stylesSrc.indexOf(".composer-mode-popup") + 700);
    assert.ok(/max-height: calc\(100vh - 170px\)/.test(popup), "浮层应整体兜底限高");
    assert.ok(/overflow-y: auto/.test(popup), "浮层应允许上下滚动");
  });

  await test("E1. 版本 ≥ 3.42.0（宽松惯例：写死会在下次 bump 翻红本测试）", () => {
    const rank = (v) => String(v).split(".").map((seg) => Number(seg) || 0);
    const [rA, rB] = [rank(pkg.version), rank("3.42.0")];
    for (let i = 0; i < 3; i += 1) {
      if (rA[i] !== rB[i]) { assert.ok(rA[i] > rB[i], `package.json 版本应 ≥ 3.42.0，实际 ${pkg.version}`); break; }
    }
  });
}

(async () => {
  console.log("\n════ A. 行为真跑（mock 注入 + 真实 workgroup-chat.cjs）════");
  await runUnitTests();
  console.log("\n════ B/C/D/E. 主进程/渲染层/CSS/版本静态断言 ════");
  await runStaticTests();
  console.log(`\n══════════════════════════════════`);
  console.log(`通过 ${passed} 项 / 失败 ${failed} 项`);
  if (failed) {
    console.log("\n失败清单：");
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
  console.log("✅ v3.42.0 守门全绿");
})().catch((error) => { console.error("测试驱动崩溃:", error); process.exit(1); });
