"use strict";
/* ═══════════════════════════════════════════════════════════════════
 * workgroup-chat.cjs — 多 AI 对话（工作）· 群聊引擎（v3.35.6）
 *
 * 承接规格 模块二（独立精神-派发体现）/ 模块三（群聊指挥链）/ 模块四（Sub-Agent 包工头）
 * 与底层红线：①串行渲染=渲染层专职队列（主进程事件带成员归属）②上下文物理隔离
 * （每成员独立 transcript，零共享可变引用）③防无限套娃（自主讨论发言上限=maxTurns
 * 默认 5 上限 10；子 Agent 层级锁死 1 层）④错误瘦身（只传 {code,message}，≤300 字）
 * ⑤生命周期（云端子代理终局只清 AbortController/缓存引用；SSH/本机成员轮经
 * activeRequests 的 cancel 语义收口——与本机单人对话同一套强杀路径）
 *
 * 派发模型（v3.35.6 实现口径，如实记录）：
 *  - 云端池成员：sendCloudChat 直调（独立 Provider/Key/模型/思考挡位/agent 系提示词），
 *    @/广播可并行；上下文=按成员名牌独立转录（每成员各拿一份浅拷贝）
 *  - SSH/本机成员：群内一律串行（runner 进程互斥 + SSH 卡槽 profile 切换互斥），
 *    整组轮结束还原用户原卡槽；上下文以「自你上轮以来的新消息」转录拼 prompt（CLI 自持会话）
 *  - 自主讨论（Auto-Discuss）：全员按工作组顺序接力，发言次数 ≤ maxTurns，轮间检查停止旗
 *  - 子 Agent：仅取自「用户 Agent 池」的云端节点（模块四权限白名单）；主 Agent 群内轮
 *    经 ```sub_agent``` 约定块派生，单人云端轮经 spawn_agent 工具派生；402/429 熔断走
 *    ask_user 选择卡（换模型恢复 / 中止取产出），换脑请求同形态审批
 * ═══════════════════════════════════════════════════════════════════ */

const { randomUUID } = require("crypto");
const { getSettings, getCloudAiConfig, getConnection, switchSshProfile, getAtomcodeToken } = require("./settings.cjs");
const { runClaude, runCodexCli, runQwenCli, runHermesCli } = require("./ssh.cjs");
const { runLocalClaude } = require("./local.cjs");
const { runAtomCodeChat } = require("./daemon-chat.cjs");
const { runCustomCli } = require("./custom-cli.cjs");
const { sendCloudChat, accumulateUsage } = require("./cloud-chat.cjs");
// v3.37.0 群成员「各自干活」：云端成员轮接工作工具循环（推理走成员模型，工具在本机工作目录执行）——
// 用户实锤：群成员默认落成纯聊天（无工具无环境），「我想让他们各自干活，而他们说他们不知道我电脑是什么系统」
const { toolDefinitions, executeToolCall, ASK_USER_HINT, ASK_USER_TIMEOUT, ASK_USER_STOPPED } = require("./cloud-tools.cjs");
const { collapseRepetition } = require("./repetition-guard.cjs");
const { appendPlanConvention } = require("./plan-convention.cjs");
const pool = require("./agent-pool.cjs");

// ── 模块级群轮登记（渲染层经 chat:group-await 悬等单轮；chat:group-stop 全员收口） ──
const groupTurns = new Map(); // requestId → Promise<{ agentId, name, ... }>
const stoppedConversations = new Set(); // 紧急停止旗（大红按钮置位，接力驱动逐旗收口）
const pendingAsks = new Map(); // callId → { conversationId }（子 Agent 换脑/熔断选择卡悬等登记，群停止总收口）

/** 红线④：错误瘦身——只传 {code,message}，message 截 300 字，严禁 Stack 堆栈 */
function slimError(error) {
  const code = String(error?.code || error?.status || error?.statusCode || "ERROR").slice(0, 12);
  const raw = String(error?.message || error || "未知错误").replace(/\r?\n/g, " ").trim();
  return { code, message: raw.slice(0, 300) };
}

/** 模块四入口解析：```sub_agent {"task":"…","agent":"@名或id","expect":"…"}```（容忍 spawn_agent 写法） */
function extractSpawnBlocks(text) {
  const tasks = [];
  const source = String(text || "");
  const pattern = /```(?:sub_agent|spawn ?_?agent)\s*\n([\s\S]*?)```/g;
  let match = null;
  while ((match = pattern.exec(source))) {
    try {
      const spec = JSON.parse(match[1].trim());
      const task = String(spec.task || spec.prompt || "").trim();
      if (task) tasks.push({ task, targetAgentId: String(spec.agent || "").trim(), expect: String(spec.expect || "").trim() });
    } catch { /* 非 JSON 的约定块=AI 误写，跳过不炸 */ }
  }
  return tasks;
}

/** 红线②：群享上文独立转录——每次调用全新数组/字符串，成员间零共享可变引用 */
function buildGroupTranscript(messages, selfName) {
  const lines = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg.role === "user") lines.push({ speaker: "用户", text: String(msg.text || ""), isUser: true });
    else if (msg.role === "assistant" && !msg.draft) {
      const name = msg.agent?.name ? String(msg.agent.name) : "";
      lines.push({ speaker: name || "", text: String(msg.text || ""), isUser: false });
    }
  }
  void selfName; // 名牌归因在渲染侧气泡与历史上下文里保留；转录统一按（@名）前缀呈现
  return lines;
}

/** 红线②：群成员云端请求体构建——从对话历史独立生成（assistant 按 @名牌归因，子 Agent 汇报
 * 的 user 消息原样入列当上下文；draft 永不入列）。每次调用全新数组，成员间零共享可变引用。 */
function buildGroupMessages(conversation, systemPrompt) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  for (const msg of Array.isArray(conversation?.messages) ? conversation.messages : []) {
    if (!msg || msg.draft) continue;
    if (msg.role === "user") messages.push({ role: "user", content: String(msg.text || "") });
    else if (msg.role === "assistant" && msg.agent?.name && msg.agent?.id) {
      messages.push({ role: "assistant", content: `(@${msg.agent.name}) ${String(msg.text || "")}` });
    } else if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: String(msg.text || "") });
    }
  }
  return messages;
}

/** 群成员系提示词（协作协议 + 层级锁死声明 + v3.37.0 真实环境段） */
function groupSystemPrompt(groupName, rosterNames, selfName, modeSystemPrompt, environmentText) {
  const rosterText = rosterNames.map((name) => `@${name}`).join(" · ");
  return [
    modeSystemPrompt || "",
    environmentText || "",
    ASK_USER_HINT,
    `——多智能体协作协议（群「${groupName}」）——`,
    `你是本群成员 @${selfName}。同级成员：${rosterText}（均由用户亲自配置驱动）。`,
    "规则：以自己的专业立场直接发言；引用他人观点用 @名称；不扮演/不代写其他成员的发言；",
    "不重复他人已给出的结论，优先贡献增量信息。",
    "实干优先：被点名或任务落到你头上时，优先用工具直接干活（读/写文件、列目录、执行命令、网络抓取），产出直接放在话里或写进文件；不要用「我不能操作你电脑/不知道你的系统」推脱——上面已给真实环境参数。",
    "如需要把子任务外包，可输出 ```sub_agent {\"task\":\"…\",\"agent\":\"@池内成员名\",\"expect\":\"…\"}``` 代码块；",
    "限制：子 Agent 不得再派生新子 Agent（层级锁死 1 层）；每轮每成员至多 1 个 sub_agent 块。"
  ].filter(Boolean).join("\n");
}

/* ══════════════ 云端成员轮（sendCloudChat 直调） ══════════════ */

async function runCloudMemberTurn(ctx, agent, input, group, rosterNames) {
  const requestId = input.requestId;
  const conversation = await ctx.deps.getConversation(input.conversationId);
  // 修复：getMode 是同步函数（mode-manager 同步形态），返回对象没有 .catch——原 `.catch(() => null)` 写法
  // 对 workModeId 非空的群发恒炸 TypeError 且炸点在 try 外→被 startCloud 兜底静默吞掉（云端成员「没响应」无迹可查的根因）。
  // 对齐单聊 main.cjs 的双保险形态（async IIFE + try/catch），同步 throw 与异步 reject 都兜成 null。
  const modeConfig = input.workModeId ? await (async () => { try { return await ctx.deps.getMode(input.workModeId); } catch { return null; } })() : null;
  // v3.37.0 群成员「各自干活」：工具组随 globalCloud 开关（toolsEnabled+非沙箱+有工作目录才注入），真实环境段随系统提示
  const toolsInfo = typeof ctx.deps.groupTools === "function" ? ctx.deps.groupTools() : { enabled: false, allowCommand: false, workdir: "", environmentText: "" };
  const systemPrompt = groupSystemPrompt(group.name, rosterNames, agent.name, appendPlanConvention(modeConfig?.systemPrompt || ""), toolsInfo.environmentText || "");
  // 红线②：群成员请求体独立构建（@名牌归因 + 协作协议系统段；每次全新数组零共享引用）
  const cloudMessages = buildGroupMessages(conversation, systemPrompt);
  const globalCloud = getCloudAiConfig();
  const config = {
    apiKey: agent.apiKey,
    baseURL: agent.baseURL || providerBaseURL(agent.provider),
    model: agent.model || "",
    // 模块二·独立思考挡位：成员自己的挡位随行（choice 落池，A 不污染 B 的语义在 sendCloudChat 注入层）
    thinking: { provider: agent.provider, model: agent.model || "", choice: agent.thinkingLevel || "" },
    maxTokens: globalCloud.maxTokens,
    provider: agent.provider,
    proxy: globalCloud.proxy, // 代理用全局设置（成员级代理=后续增强）
    // v3.37.0：工作工具随行（群成员默认能干活——用户实锤「他们默认是正常对话，我想让他们各自干活」）
    tools: toolsInfo.enabled ? toolDefinitions(toolsInfo.allowCommand) : undefined
  };
  if (!config.apiKey) throw new Error(`成员「${agent.name}」未配置 API Key。`);
  ctx.emit(requestId, { type: "lifecycle", status: "started", agent: { id: agent.agentId, name: agent.name, kind: "cloud" } });

  let streamedText = "";
  let streamedReasoning = "";
  const usageTotal = { prompt: 0, completion: 0, total: 0, requests: 0 };
  let draftTimer = null;
  const persistDraft = () => {
    draftTimer = null; // v3.37.2 对齐单聊口径：草稿落一次后允许下一批 delta 重新排程（不修则中间草稿停在首个 1s 时点）
    try { ctx.deps.saveAssistantDraft(input.conversationId, requestId, streamedText); } catch (error) { ctx.log("group_draft_save_failed", { requestId, error: error.message }); }
  };
  const callbacks = {
    onDelta: (text) => {
      streamedText += String(text || "");
      ctx.emitDelta(requestId, text);
      if (!draftTimer) draftTimer = setTimeout(persistDraft, 1000);
    },
    onReasoning: (text) => {
      streamedReasoning += String(text || "");
      ctx.emit(requestId, { type: "thinking", text: String(text || "") });
    },
    onStatus: () => { /* 群轮不投影连接状态条（避免多成员互踩） */ },
    onUsage: (usage) => {
      ctx.emit(requestId, { type: "usage", usage });
    },
    onLog: ctx.log
  };
  ctx.deps.activeRequests.set(requestId, { promise: null, cancel: null, conversationId: input.conversationId, agentId: agent.agentId });
  try {
    // v3.37.0 群成员工具循环（agent loop，≤10 轮）：tool_calls → 本机工作目录执行 → 结果回填 → 再请求。
    // 形态对齐单聊 main.cjs runCloudWithTools（raw 消息回填 Anthropic/OpenAI 双形态）；ask_user 悬等同款；
    // spawn_agent 在群轮不开放（群内子任务派生走 ```sub_agent``` 块协议——层级锁死声明见 groupSystemPrompt）。
    // 群工具卡照常 ctx.emit(type:"tool") → 渲染层通用分支 messages.get(群 requestId)=群气泡 → 工具牌照常渲染。
    const entry = ctx.deps.activeRequests.get(requestId);
    const isAnthropicProvider = agent.provider === "anthropic";
    let result = null;
    let loopMessages = cloudMessages;
    for (let round = 0; round <= 10; round += 1) {
      // v3.37.2 红线三补强：轮间断点查停止旗（紧急停止后不再开新轮；悬等中停止由 stopGroupTurns cancelAll 收口）
      if (stoppedConversations.has(input.conversationId)) break;
      if (round > 0) ctx.emit(requestId, { type: "round", round });
      const promise = sendCloudChat(config, loopMessages, callbacks);
      if (entry) { entry.promise = promise; entry.cancel = () => { promise.cancel?.(); }; }
      result = await promise;
      if (result.cancelled) break;
      // v3.37.0 自查修复：多轮工具循环 usage 按轮累计（对齐单聊 main.cjs runCloudWithTools 每轮 accumulateUsage 口径）——原来只在循环后收最后一轮，漏计
      accumulateUsage(usageTotal, result.usage);
      const toolCalls = toolsInfo.enabled ? (result.toolCalls || []) : [];
      if (!toolCalls.length) break;
      const callsRaw = toolCalls.map((call, index) => {
        let parsedInput = {};
        try { parsedInput = JSON.parse(call.arguments || "{}"); } catch { parsedInput = {}; }
        return { id: call.id || `${requestId}-tool-${round}-${index}`, name: call.name || "unknown", arguments: call.arguments || "{}", input: parsedInput };
      });
      const assistantText = result.text || "";
      if (isAnthropicProvider) {
        const content = [];
        if (assistantText) content.push({ type: "text", text: assistantText });
        for (const call of callsRaw) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
        loopMessages = [...loopMessages, { raw: true, role: "assistant", content }];
      } else {
        loopMessages = [...loopMessages, {
          raw: true,
          role: "assistant",
          content: assistantText || null,
          extra: { tool_calls: callsRaw.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }
        }];
      }
      for (const call of callsRaw) {
        const card = { id: call.id, name: call.name, status: "running", input: call.input, result: "" };
        ctx.emit(requestId, { type: "tool", tool: card });
        let output;
        if (call.name === "ask_user") {
          const q = String(card.input?.question || "").trim();
          const options = (Array.isArray(card.input?.options) ? card.input.options : [])
            .map((option) => String(option || "").trim()).filter(Boolean).slice(0, 4);
          if (!q || options.length < 2) {
            output = "ask_user 参数不完整（question 必填且 options 至少 2 项）。请改用正文直接向群友/用户说明。";
          } else {
            ctx.emit(requestId, { type: "ask-user", callId: call.id, question: q, options });
            const answer = await ctx.deps.askUserRegistry.wait(requestId, call.id, q, options);
            if (answer === ASK_USER_STOPPED) {
              card.status = "completed"; card.result = "用户已停止"; ctx.emit(requestId, { type: "tool", tool: card });
              throw new Error("用户已停止当前任务");
            }
            output = answer === ASK_USER_TIMEOUT ? "（用户长时间未应答，请基于现有信息自行决定下一步，或明确说明被搁置的原因。）" : `用户选择：${answer}`;
          }
        } else if (call.name === "spawn_agent") {
          output = "群聊里请用 ```sub_agent``` 代码块派生子任务（spawn_agent 工具只开放给单聊主 Agent）。";
          card.status = "failed";
          card.result = "群内子任务走 sub_agent 块";
        } else {
          try {
            output = await ctx.deps.executeToolCall({ id: call.id, name: call.name, arguments: call.arguments }, { workdir: toolsInfo.workdir, allowCommand: toolsInfo.allowCommand, onLog: ctx.log });
            card.status = "completed";
            card.result = String(output).slice(0, 400);
            ctx.log("group_tool_success", { requestId, tool: call.name, outputLength: String(output).length });
          } catch (error) {
            card.status = "failed";
            card.result = String(error.message || error).slice(0, 400);
            output = `工具执行失败：${error.message}`;
            ctx.log("group_tool_failed", { requestId, tool: call.name, error: error.message });
          }
        }
        ctx.emit(requestId, { type: "tool", tool: card });
        if (isAnthropicProvider) {
          loopMessages.push({ raw: true, role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: output }] });
        } else {
          loopMessages.push({ raw: true, role: "tool", content: output, extra: { tool_call_id: call.id } });
        }
      }
    }
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    // 红线④+复读护栏：落库前折叠复读段落；群成员回复仍走复读检测
    const repetition = collapseRepetition(streamedText);
    const finalText = repetition.collapsed ? repetition.text : streamedText;
    if (result.cancelled) {
      const cancelledText = finalText || "已停止。";
      ctx.deps.addAssistantMessage(input.conversationId, cancelledText, "", [], [], requestId, "cloud",
        usageTotal.requests ? slimUsage(usageTotal) : undefined, undefined, undefined, undefined, undefined,
        streamedReasoning, { agentId: agent.agentId, name: agent.name });
      return { requestId, agentId: agent.agentId, name: agent.name, kind: "cloud", cancelled: true, text: cancelledText };
    }
    // usage 已在循环内每轮累计（cancelled 分支除外）；此处仅落库
    ctx.deps.addAssistantMessage(input.conversationId, finalText || "（无输出）", "", [], [], requestId, "cloud",
      usageTotal.requests ? slimUsage(usageTotal) : (result.usage || undefined), undefined, undefined, undefined, undefined,
      streamedReasoning, { agentId: agent.agentId, name: agent.name });
    await runSubAgentsForMember(ctx, input, agent, requestId, finalText);
    return { requestId, agentId: agent.agentId, name: agent.name, kind: "cloud", text: finalText, usage: slimUsage(usageTotal) };
  } catch (error) {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    persistDraft();
    // v3.37.2：紧急停止经 ask_user 收口（cancelAll → answer=STOPPED → 此处 throw）——按「停止」而非「失败」收口，
    // 不标 group-agent-failed（用户主动停，成员不背失败锅）；已流到的文本照常落库
    if (/用户已停止/.test(String((error && error.message) || error || ""))) {
      const cancelledText = streamedText || "已停止。";
      ctx.deps.addAssistantMessage(input.conversationId, cancelledText, "", [], [], requestId, "cloud",
        usageTotal.requests ? slimUsage(usageTotal) : undefined, undefined, undefined, undefined, undefined,
        streamedReasoning, { agentId: agent.agentId, name: agent.name });
      return { requestId, agentId: agent.agentId, name: agent.name, kind: "cloud", cancelled: true, text: cancelledText };
    }
    const slim = slimError(error);
    ctx.emit(requestId, { type: "group-agent-failed", agent: { id: agent.agentId, name: agent.name, kind: "cloud" }, error: slim });
    ctx.deps.addAssistantMessage(input.conversationId, `（@${agent.name} 本轮失败：${slim.code} ${slim.message}）`, "", [], [], requestId, "cloud",
      undefined, undefined, undefined, undefined, undefined, "", { agentId: agent.agentId, name: agent.name });
    return { requestId, agentId: agent.agentId, name: agent.name, kind: "cloud", failed: true, error: slim, text: "" };
  } finally {
    ctx.deps.activeRequests.delete(requestId);
    // 红线⑤：云端轮终局——仅清本地 abort/缓存引用（activeRequests 删除即完成），无进程可杀
  }
}

function slimUsage(usageTotal) {
  return {
    inputTokens: usageTotal.prompt, outputTokens: usageTotal.completion, totalTokens: usageTotal.total,
    cumulative: true, requests: usageTotal.requests
  };
}

/** 云端成员默认 baseURL（与 settings.cjs providerConfigs 同源的最小映射；custom 由节点自带） */
function providerBaseURL(provider) {
  const map = {
    zhipu: "https://open.bigmodel.cn/api/paas/v4",
    deepseek: "https://api.deepseek.com/v1",
    kimi: "https://api.moonshot.cn/v1",
    doubao: "https://ark.cn-beijing.volces.com/api/v3",
    openai: "https://api.openai.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    anthropic: "https://api.anthropic.com/v1",
    groq: "https://api.groq.com/openai/v1",
    siliconflow: "https://api.siliconflow.cn/v1"
  };
  return map[provider] || "";
}

/* ══════════════ SSH/本地成员轮（复用既有 runner 链，群内串行） ══════════════ */

function runnerCallbacks(ctx, agent, input) {
  const { getConversation } = ctx.deps;
  let streamedText = "";
  let streamedThinking = "";
  let latestSessionId = ctx.deps.agentSessionFor(getConversation(input.conversationId), agent.agentId);
  let draftTimer = null;
  const persistDraft = () => {
    draftTimer = null; // v3.37.2 对齐单聊口径：允许下一批 delta 重新排程草稿
    try { ctx.deps.saveAssistantDraft(input.conversationId, input.requestId, streamedText); } catch { /* 忽略草稿失败 */ }
  };
  return {
    callbacksRef: null,
    latestSessionId: () => latestSessionId,
    streamedText: () => streamedText,
    build() {
      const callbacks = {
        conversationId: input.conversationId,
        onDelta: (text) => {
          streamedText += String(text || "");
          ctx.emitDelta(input.requestId, text);
          if (!draftTimer) draftTimer = setTimeout(persistDraft, 1000);
        },
        onThinking: (text) => {
          streamedThinking += String(text || "");
          ctx.emit(input.requestId, { type: "thinking", text: String(text || "") });
        },
        onUploadProgress: () => { /* 群轮不上传投影 */ },
        onToolEvent: (tool) => ctx.emit(input.requestId, { type: "tool", tool }),
        onUsage: (usage) => ctx.emit(input.requestId, { type: "usage", usage }),
        onModelChange: () => { /* 群轮不投影上下文条 */ },
        onCompactEvent: () => { /* 群轮不做压缩 */ },
        onStatus: () => { /* 群轮不投影连接状态条 */ },
        onSessionId: (sessionId) => {
          latestSessionId = sessionId || latestSessionId;
          try { ctx.deps.saveAgentSession(input.conversationId, agent.agentId, sessionId); } catch { /* 落档失败不阻断 */ }
        },
        onTurnComplete: ({ text, sessionId: turnSessionId, usage: turnUsage }) => {
          if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
          const completedText = String(text || streamedText || "");
          if (completedText) {
            ctx.deps.saveAssistantDraft(input.conversationId, input.requestId, completedText);
            ctx.deps.addAssistantMessage(input.conversationId, completedText, turnSessionId || latestSessionId, [], [], input.requestId,
              agent.kind === "local" ? "local" : "ssh", turnUsage, undefined, undefined, agent.kind === "ssh" ? agent.profileId : "", agent.adapter || "claude",
              streamedThinking, { agentId: agent.agentId, name: agent.name });
            streamedText = "";
          }
        },
        onPermissionRequest: null, // 由 ctx.deps 提供（复用主进程 dialog 审批）
        onUnknownHost: null,
        onAudit: (entry) => ctx.log("work_status_signal", { requestId: input.requestId, direction: "executor-emitted", signal: "transport-event", ...entry }),
        onLog: ctx.log
      };
      const deps = ctx.deps;
      if (deps.onPermissionRequest) callbacks.onPermissionRequest = deps.onPermissionRequest;
      if (deps.onUnknownHost) callbacks.onUnknownHost = deps.onUnknownHost;
      this.callbacksRef = callbacks;
      return callbacks;
    }
  };
}

/** 一次 SSH/本地 runner 直调（群内串行：调用方保证互斥进入） */
async function runRunnerMemberTurn(ctx, agent, input, group) {
  const settings = getSettings();
  const originalProfile = settings.activeSshProfile || "ssh-1";
  if (agent.kind === "ssh" && agent.profileId && agent.profileId !== originalProfile) {
    try { switchSshProfile(agent.profileId); } catch (error) { ctx.log("group_profile_switch_failed", { agentId: agent.agentId, error: error.message }); }
  }
  ctx.emit(input.requestId, { type: "lifecycle", status: "started", agent: { id: agent.agentId, name: agent.name, kind: agent.kind } });
  try {
    const conversation = ctx.deps.getConversation(input.conversationId);
    // 转录：自该成员上轮之后的新消息（CLI 自持会话，续聊带增量）
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    let ownIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant" && messages[i].agent?.id === agent.agentId) { ownIndex = i; break; }
    }
    const fresh = buildGroupTranscript(messages.slice(ownIndex + 1), agent.name)
      .map((line) => `${line.isUser || !line.speaker ? line.speaker || "用户" : `@${line.speaker}`}：${line.text}`)
      .join("\n");
    const transcriptBlock = fresh ? `[群聊上下文 · 自你上轮以来的新消息]\n${fresh}\n\n` : "";
    const runnerConfig = getConnection();
    if (agent.kind === "local") runnerConfig.connectionMode = "local";
    if (agent.kind === "local" && agent.engine === "atomcode") runnerConfig.atomcodeToken = ctx.deps.getAtomcodeToken();
    const agentMessage = `${transcriptBlock}${input.message}`;
    const helpers = runnerCallbacks(ctx, agent, input);
    const activeSessionId = ctx.deps.agentSessionFor(conversation, agent.agentId);
    const attachments = [];
    let operation = null;
    const engine = agent.kind === "local" ? agent.engine : (agent.adapter || "claude");
    if (agent.kind === "local" && engine === "atomcode") {
      operation = runAtomCodeChat(runnerConfig, agentMessage, activeSessionId, attachments, helpers.build());
    } else if (agent.kind === "local" && engine === "custom") {
      runnerConfig.history = messages.slice(0, -1);
      operation = runCustomCli(runnerConfig, agentMessage, activeSessionId, attachments, helpers.build());
    } else if (agent.kind === "local") {
      operation = runLocalClaude(runnerConfig, agentMessage, activeSessionId, attachments, helpers.build());
    } else {
      const cliRunners = { qwen: runQwenCli, codex: runCodexCli, hermes: runHermesCli };
      const runner = cliRunners[engine];
      operation = runner ? runner(runnerConfig, agentMessage, activeSessionId, attachments, helpers.build())
        : runClaude(runnerConfig, agentMessage, activeSessionId, attachments, helpers.build());
    }
    ctx.deps.activeRequests.set(input.requestId, { operation, conversationId: input.conversationId, agentId: agent.agentId });
    const result = await operation.promise;
    if (result.sessionId) ctx.deps.saveAgentSession(input.conversationId, agent.agentId, result.sessionId);
    // 尾轮兜底落库（onTurnComplete 已落库的对话轮跳过：以最后用户消息后是否有本成员回复判断）
    const conv2 = ctx.deps.getConversation(input.conversationId);
    const after = (conv2.messages || []).filter((msg) => !msg.draft);
    const lastOwn = [...after].reverse().find((msg) => msg.role === "assistant" && msg.agent?.id === agent.agentId);
    if (!lastOwn && result.text) {
      ctx.deps.addAssistantMessage(input.conversationId, result.text, result.sessionId, result.files, result.tools, input.requestId,
        agent.kind === "local" ? "local" : "ssh", result.usage, undefined, undefined, agent.kind === "ssh" ? agent.profileId : "", agent.adapter || "claude",
        "", { agentId: agent.agentId, name: agent.name });
    }
    await runSubAgentsForMember(ctx, input, agent, input.requestId, result.text || "");
    return { requestId: input.requestId, agentId: agent.agentId, name: agent.name, kind: agent.kind, text: result.text || "" };
  } catch (error) {
    const slim = slimError(error);
    ctx.emit(input.requestId, { type: "group-agent-failed", agent: { id: agent.agentId, name: agent.name, kind: agent.kind }, error: slim });
    ctx.deps.addAssistantMessage(input.conversationId, `（@${agent.name} 本轮失败：${slim.code} ${slim.message}）`, "", [], [], input.requestId,
      agent.kind === "local" ? "local" : "ssh", undefined, undefined, undefined, agent.kind === "ssh" ? agent.profileId : "", agent.adapter || "claude",
      "", { agentId: agent.agentId, name: agent.name });
    return { requestId: input.requestId, agentId: agent.agentId, name: agent.name, kind: agent.kind, failed: true, error: slim, text: "" };
  } finally {
    ctx.deps.activeRequests.delete(input.requestId);
    if (agent.kind === "ssh" && agent.profileId && agent.profileId !== originalProfile) {
      try { switchSshProfile(originalProfile); } catch { /* 还原失败静默（下次轮仍会校正） */ }
    }
  }
}

/* ══════════════ Sub-Agent 包工头（模块四） ══════════════ */

/**
 * 单个子任务执行（权限白名单=云端池节点；换脑/熔断经 ask_user 选择卡悬等用户）。
 * 返回 { status, agentLabel, text, error } —— 红线④：error 恒为 {code,message} 摘要。
 */
async function executeSubAgent(ctx, opts, depth = 0) {
  const whitelist = pool.whitelistedCloudTargets();
  // 权限白名单：目标必须 ∈ 用户配置的云端池（可传 agent 名或 agentId）
  let target = null;
  const wanted = String(opts.targetAgentId || "").trim();
  if (wanted) {
    const bare = wanted.replace(/^@/, "");
    target = whitelist.find((node) => node.agentId === wanted || node.name === bare) || null;
  }
  if (!target && whitelist.length === 1) target = whitelist[0];
  if (!target) {
    return { status: "denied", agentLabel: wanted || "(未指定)", text: "", error: { code: "WHITELIST", message: wanted ? `子 Agent 目标「${wanted}」不在 Agent 池白名单内，已拒绝。` : "Agent 池内没有可用云端节点，子 Agent 无法派生。" } };
  }
  const subId = `sub-${randomUUID()}`;
  ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "processing", agent: { id: target.agentId, name: target.name } });
  const attempt = async (node, resumeNote) => {
    const conversation = await ctx.deps.getConversation(opts.conversationId);
    const transcript = buildGroupTranscript(conversation.messages || [], node.name)
      .map((line) => `${line.isUser ? "用户" : `@${line.speaker}`}：${line.text}`)
      .join("\n");
    const systemPrompt = [
      "你是被群内成员派生的临时子 Agent（Sub-Agent）。完成指派子任务后输出精简结果。",
      "层级限制：你不可以再派生新子 Agent（sub_agent 块无效，会被忽略）。"
    ].join("\n");
    const messages = [
      { role: "system", content: systemPrompt },
      ...(transcript ? [{ role: "user", content: `[群聊上下文摘录]\n${transcript}` }] : []),
      { role: "user", content: `[子任务派发（@${opts.parentName || "上游 Agent"} → 子 Agent）]\n任务：${opts.task}` + (opts.expect ? `\n期望产出：${opts.expect}` : "") + (resumeNote ? `\n${resumeNote}` : "") }
    ];
    const cloudConfig = {
      apiKey: node.apiKey, baseURL: node.baseURL || providerBaseURL(node.provider), model: node.model,
      provider: node.provider, maxTokens: getCloudAiConfig().maxTokens, proxy: getCloudAiConfig().proxy
    };
    return sendCloudChat(cloudConfig, messages, { onLog: ctx.log });
  };
  // 红线③：子 Agent 互调深度锁死——sub 只能从主成员发起（depth=0），换脑重试不增层
  void depth;
  try {
    const result = await attempt(target);
    // 换脑请求拦截：子 Agent 输出 ```brain_swap {"target":"…","reason":"…"}``` 时，经 ask_user 审批
    const brainSwap = parseBrainSwap(result.text);
    if (brainSwap) {
      ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "brain-swap-wait", agent: { id: target.agentId, name: target.name }, payload: { target: brainSwap.target, reason: brainSwap.reason } });
      pendingAsks.set(`swap-${subId}`, { conversationId: opts.conversationId, requestId: opts.parentRequestId });
      ctx.emit(opts.parentRequestId, { type: "ask-user", callId: `swap-${subId}`, question: `子 Agent @${target.name} 请求切换模型至「${brainSwap.target}」（${brainSwap.reason || "未说明"}）。是否同意？`, options: ["同意换脑", "拒绝换脑"], agent: { id: opts.parentAgentId || "", name: opts.parentName || "" } });
      const swapCallId = `swap-${subId}`;
      let answer = "拒绝换脑";
      try {
        answer = ctx.deps.askUserRegistry ? await ctx.deps.askUserRegistry.wait(opts.parentRequestId, swapCallId, `子 Agent @${target.name} 请求将模型切换至「${brainSwap.target}」（原因：${brainSwap.reason || "未说明"}）。是否同意？`, ["同意换脑", "拒绝换脑"]) : "拒绝换脑";
      } catch { answer = "拒绝换脑"; }
      finally { pendingAsks.delete(swapCallId); }
      if (answer === "同意换脑") {
        const nextTarget = pool.whitelistedCloudTargets().find((node) => node.model === brainSwap.target || `@${node.name}` === brainSwap.target || node.name === brainSwap.target.replace(/^@/, "")) || null;
        // 「重建实例」红线⑤（红线④口径）：云端=清旧 AbortController/缓存引用后以新配置重跑；SSH/本机无子 runner（池=云端），无进程可杀
        if (nextTarget) {
          const rerun = await attempt(nextTarget, `（你此前请求换脑至 ${nextTarget.model} 并已获用户同意；请从既有基础继续完成任务。）`);
          ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "done", agent: { id: nextTarget.agentId, name: nextTarget.name }, text: summarize(rerun.text) });
          await injectSubReport(ctx, opts, nextTarget, rerun.text);
          return { status: "done", agentLabel: `@${nextTarget.name}`, text: rerun.text || "" };
        }
        ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "rejected", agent: { id: target.agentId, name: target.name }, text: "换脑目标不在 Agent 池白名单，已拒绝。" });
      } else {
        ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "rejected", agent: { id: target.agentId, name: target.name }, text: "用户拒绝了换脑请求。" });
      }
    }
    ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "done", agent: { id: target.agentId, name: target.name }, text: summarize(result.text) });
    await injectSubReport(ctx, opts, target, result.text);
    return { status: "done", agentLabel: `@${target.name}`, text: result.text || "" };
  } catch (error) {
    // 额度熔断（模块四③）：402/429 等错误 → ask_user 给用户两条路（换模型恢复 / 中止取产出）
    const slim = slimError(error);
    const quotaLike = ["4002", "402", "429", "insufficient", "balance", "quota", "rate"].some((needle) => (slim.code + slim.message).toLowerCase().includes(needle));
    ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "failed", agent: { id: target.agentId, name: target.name }, payload: slim });
    if (!quotaLike) {
      return { status: "failed", agentLabel: `@${target.name}`, text: "", error: slim };
    }
    const fuseCallId = `fuse-${subId}`;
    pendingAsks.set(fuseCallId, { conversationId: opts.conversationId, requestId: opts.parentRequestId });
    ctx.emit(opts.parentRequestId, { type: "ask-user", callId: fuseCallId, question: `子 Agent @${target.name} 因额度/频控失败（${slim.code}）——如何处理？`, options: ["换模型并恢复进度", "中止并返回现有产出"], agent: { id: opts.parentAgentId || "", name: opts.parentName || "" } });
    let answer = "中止并返回现有产出";
    try {
      answer = ctx.deps.askUserRegistry ? await ctx.deps.askUserRegistry.wait(opts.parentRequestId, fuseCallId, `子 Agent @${target.name} 的子任务因额度/频控失败（${slim.code}）。如何处理？`, ["换模型并恢复进度", "中止并返回现有产出"]) : "中止并返回现有产出";
    } catch { answer = "中止并返回现有产出"; }
    finally { pendingAsks.delete(fuseCallId); }
    if (answer === "换模型并恢复进度") {
      const alternate = pool.whitelistedCloudTargets().find((node) => node.agentId !== target.agentId) || null;
      if (!alternate) {
        ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "failed", agent: { id: target.agentId, name: target.name }, text: "Agent 池没有其他云端节点可换，子任务中止。" });
        return { status: "failed", agentLabel: `@${target.name}`, text: "", error: { code: "NO_ALT", message: "池内无备用节点" } };
      }
      try {
        const rerun = await attempt(alternate, `（原 @${target.name} 因 ${slim.code} 失败；用户同意换至你继续，请基于任务要求完成。）`);
        ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "done", agent: { id: alternate.agentId, name: alternate.name }, text: summarize(rerun.text) });
        await injectSubReport(ctx, opts, alternate, rerun.text);
        return { status: "done", agentLabel: `@${alternate.name}`, text: rerun.text || "" };
      } catch (retryError) {
        const retrySlim = slimError(retryError);
        ctx.emitSub(opts.parentRequestId, { type: "subagent", subId, state: "failed", agent: { id: alternate.agentId, name: alternate.name }, payload: retrySlim });
        return { status: "failed", agentLabel: `@${alternate.name}`, text: "", error: retrySlim };
      }
    }
    return { status: "aborted", agentLabel: `@${target.name}`, text: "", error: slim };
  }
}

/** 解析子 Agent 换脑请求块 ```brain_swap {"target":"模型名","reason":"…"}``` */
function parseBrainSwap(text) {
  const match = /```brain ?_?swap\s*\n([\s\S]*?)```/.exec(String(text || ""));
  if (!match) return null;
  try {
    const spec = JSON.parse(match[1].trim());
    return { target: String(spec.target || "").trim(), reason: String(spec.reason || "").trim() };
  } catch { return null; }
}

function summarize(text, limit = 800) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > limit ? compact.slice(0, limit) + "…" : compact;
}

/** 子 Agent 结果回传：注入群聊共享上下文（用户可见的轻注记，下轮全员都读得到） */
async function injectSubReport(ctx, opts, target, text) {
  const report = `[子 Agent @${target.name} 汇报]\n${summarize(text, 1500)}`;
  ctx.deps.addUserMessage?.(opts.conversationId, report, [], "subagent-result");
  ctx.emitSub(opts.parentRequestId, { type: "subagent", subId: "", state: "reported", agent: { id: target.agentId, name: target.name } });
}

/** 组内轮完成后扫描 sub_agent 块并派生执行（红线③：每轮每成员上限 1 块（引擎层取 5 张总闸），子层不可再派生） */
async function runSubAgentsForMember(ctx, input, agent, requestId, text) {
  const tasks = extractSpawnBlocks(text).slice(0, 1);
  if (!tasks.length) return;
  for (const task of tasks) {
    void task;
    const result = await executeSubAgent(ctx, {
      conversationId: input.conversationId,
      parentRequestId: requestId,
      parentName: agent.name,
      task: task.task,
      expect: task.expect,
      targetAgentId: task.targetAgentId
    });
    if (result.status === "failed" || result.status === "aborted") {
      ctx.emit(requestId, { type: "round", mark: `└─ 子 Agent ${result.agentLabel} 未完成（${result.error?.code || "未知"}）：已注入现有产出。` });
    }
  }
}

/* ══════════════ 群轮编排（路由 + 调度 + 停止 + 悬等） ══════════════ */

/** 校验提及：提及名/ID 必须都在成员表（@路由白名单），非成员提及忽略并归入广播 */
function routeMembers(agents, mentionedIds = []) {
  if (!Array.isArray(mentionedIds) || !mentionedIds.length) return [...agents];
  const wanted = mentionedIds.map((value) => String(value).replace(/^@/, "").trim()).filter(Boolean);
  const picked = agents.filter((agent) => wanted.includes(agent.agentId) || wanted.includes(agent.name));
  return picked.length ? picked : [...agents]; // 非成员提及=广播兜底（不静默吞消息）
}

async function runGroupTurn(deps, input) {
  const { group, agents } = pool.resolveGroupAgents(input.workgroupId);
  if (!agents.length) throw new Error("工作组没有可用成员（节点可能已被删除）。");
  // v3.37.2：入口清停止旗——上一轮收口后按下的停止（旗无主残留）不得掐断本轮 SSH/本地成员；
  // 进行中的轮靠忙闸（chat:group-send 活跃条目检查）根本进不来，故此清不与「进行中停止」冲突
  stoppedConversations.delete(input.conversationId);
  const ctx = {
    deps,
    log: deps.log,
    emit: (requestId, event) => deps.sender.send("chat:event", { id: requestId, agent: undefined, ...event }),
    emitDelta: (requestId, text) => deps.sender.send("chat:group-delta", { id: requestId, text }),
    emitSub: (requestId, payload) => deps.sender.send("chat:subagent-event", { parentId: requestId, ...payload }),
    runSubAgentsForMember,
    getMode: deps.getMode
  };
  const rosterNames = agents.map((agent) => agent.name);
  const route = routeMembers(agents, input.mentionedAgentIds);
  const turns = [];
  const isSequential = Boolean(input.autoDiscuss);
  const cloudMembers = route.filter((agent) => agent.kind === "cloud");
  const runnerMembers = route.filter((agent) => agent.kind !== "cloud");

  const startCloud = (agent) => {
    const requestId = `g-${randomUUID()}`;
    turns.push({ requestId, agentId: agent.agentId, name: agent.name, kind: "cloud" });
    const promise = runCloudMemberTurn(ctx, agent, { ...input, requestId }, group, rosterNames).catch((error) => {
      // 引擎层兜底：轮 Promise 永不 reject（渲染层悬等只关心终态）；
      // 补漏：兜底收「try 外前置步骤炸 / 内部 catch 自身再炸」——原形态纯静默吞掉（零落库零事件，用户感知=「没响应」且无迹可查）。
      // 补 emit + 失败落库（对齐内部 catch 形态）；副作用再包一层，保证兜底自身永不二次 reject
      try {
        const slim = slimError(error);
        ctx.emit(requestId, { type: "group-agent-failed", agent: { id: agent.agentId, name: agent.name, kind: "cloud" }, error: slim });
        ctx.deps.addAssistantMessage(input.conversationId, `（@${agent.name} 本轮失败：${slim.code} ${slim.message}）`, "", [], [], requestId, "cloud",
          undefined, undefined, undefined, undefined, undefined, "", { agentId: agent.agentId, name: agent.name });
      } catch { /* 落库/事件失败不反杀兜底 */ }
      return { requestId, agentId: agent.agentId, name: agent.name, kind: "cloud", failed: true, error: slimError(error), text: "" };
    });
    groupTurns.set(requestId, { promise, conversationId: input.conversationId, agentId: agent.agentId });
    return promise;
  };
  const startRunner = (agent) => {
    const requestId = `g-${randomUUID()}`;
    turns.push({ requestId, agentId: agent.agentId, name: agent.name, kind: agent.kind });
    const promise = runRunnerMemberTurn(ctx, agent, { ...input, requestId }, group).catch((error) => {
      // 引擎层兜底（同云端成员兜底补漏）：emit + 失败落库（对齐内部 catch 的 kind 口径），副作用再包一层防二次 reject
      try {
        const slim = slimError(error);
        ctx.emit(requestId, { type: "group-agent-failed", agent: { id: agent.agentId, name: agent.name, kind: agent.kind }, error: slim });
        ctx.deps.addAssistantMessage(input.conversationId, `（@${agent.name} 本轮失败：${slim.code} ${slim.message}）`, "", [], [], requestId,
          agent.kind === "local" ? "local" : "ssh", undefined, undefined, undefined, agent.kind === "ssh" ? agent.profileId : "", agent.adapter || "claude",
          "", { agentId: agent.agentId, name: agent.name });
      } catch { /* 落库/事件失败不反杀兜底 */ }
      return { requestId, agentId: agent.agentId, name: agent.name, kind: agent.kind, failed: true, error: slimError(error), text: "" };
    });
    groupTurns.set(requestId, { promise, conversationId: input.conversationId, agentId: agent.agentId });
    return promise;
  };

  if (isSequential) {
    // 自主讨论（Auto-Discuss）：按工作组顺序接力；发言上限 = maxTurns（默认 5，红线③）；
    // 每次发言前检查停止旗——紧急停止可随时掐断接力链
    const maxUtterances = Math.min(Math.max(Number(input.maxTurns) || group.maxTurns || 5, 1), 10);
    const order = [...route];
    let spoken = 0;
    for (let i = 0; spoken < maxUtterances && i < order.length * maxUtterances; i += 1) {
      if (stoppedConversations.has(input.conversationId)) break;
      const agent = order[i % order.length];
      try {
        await (agent.kind === "cloud" ? startCloud(agent) : startRunner(agent));
      } catch (error) {
        deps.log("group_auto_failed", { error: error.message });
      }
      spoken += 1;
    }
  } else {
    // 普通群发：云端成员并行；SSH/本地成员串行（进程互斥）
    const cloudPromises = cloudMembers.map((agent) => startCloud(agent));
    if (cloudPromises.length) await Promise.allSettled(cloudPromises);
    for (const agent of runnerMembers) {
      if (stoppedConversations.has(input.conversationId)) break;
      await startRunner(agent);
    }
  }
  stoppedConversations.delete(input.conversationId);
  return { turns, groupName: group.name, routed: route.map((agent) => agent.name) };
}

/** 紧急停止（大红按钮）：全员 stop——activeRequests 逐个 cancel + 置停止旗掐断接力链 */
function stopGroupTurns(activeRequests, conversationId, askUserRegistry = null) {
  stoppedConversations.add(String(conversationId || ""));
  let count = 0;
  // v3.37.2：群成员工具循环里的 ask_user 悬等一并收口（对齐单聊 chat:cancel 的 cancelAll(id) 语义）——
  // 原来只收 pendingAsks（子 Agent 换脑/熔断卡），成员正问用户时按停止 = 该轮挂到 480s 超时后还继续跑剩余轮
  for (const [requestId, turnEntry] of new Map(activeRequests).entries()) {
    if (turnEntry.conversationId !== conversationId) continue;
    try { askUserRegistry?.cancelAll(requestId); } catch { /* registry 缺失时跳过 */ }
    try {
      if (turnEntry.operation?.cancel) turnEntry.operation.cancel();
      else if (turnEntry.cancel) turnEntry.cancel();
      else if (turnEntry.promise?.cancel) turnEntry.promise.cancel();
    } catch { /* 已结束的忽略 */ }
    count += 1;
  }
  // 子 Agent 换脑/熔断的选择卡悬等一并收口（用户停止=如实回填 __stopped__；先收集后删除防迭代期改 Map）
  const staleAskIds = [];
  for (const [callId, entry] of pendingAsks.entries()) {
    if (entry.conversationId === conversationId) staleAskIds.push(callId);
  }
  for (const staleAskId of staleAskIds) {
    const entry = pendingAsks.get(staleAskId);
    pendingAsks.delete(staleAskId);
    try { askUserRegistry?.cancelAll(entry.requestId); } catch { /* registry 缺失时跳过 */ }
  }
  return count;
}

function awaitGroupTurn(requestId) {
  const entry = groupTurns.get(String(requestId || ""));
  if (!entry) return Promise.resolve({ missing: true });
  return entry.promise;
}

module.exports = {
  buildGroupMessages,
  slimError,
  extractSpawnBlocks,
  buildGroupTranscript,
  groupSystemPrompt,
  routeMembers,
  runGroupTurn,
  runCloudMemberTurn,
  runRunnerMemberTurn,
  executeSubAgent,
  parseBrainSwap,
  summarize,
  stopGroupTurns,
  awaitGroupTurn,
  providerBaseURL
};