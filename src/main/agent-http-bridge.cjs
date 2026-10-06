"use strict";

/**
 * Agent HTTP 桥（阉割版 Bridge Edition 专属，v3.21.2 后独立产物）
 *
 * 用途：让云端 AI（跑在本机 ACP 云端模式里、具备工具执行能力）把消息转发给 NAS Agent
 *（SSH 模式对话），形成「云端AI ↔ NAS Agent」对话链。云端 AI 侧用 curl 调本桥。
 *
 * 安全模型：
 *   - HTTP 服务仅绑定 127.0.0.1（本机回环，外机不可达）
 *   - Token 鉴权（首启自动生成；safeStorage 加密落盘由 settings.cjs 承担，本模块只比对）
 *   - 任何携带 Origin 头的请求一律拒绝（浏览器层 CSRF 加固；curl 不带 Origin 不受影响）
 *   - 消息长度上限 8000 字 + 滑动窗口限频（默认 12 条/60 秒）
 *   - 人工放行队列（默认开，agentBridgeGate）：每条云端AI消息先进队列，用户在 UI 点「放行」
 *     才转发——防 AI↔AI 失控对聊烧 token；关=全自动直发
 *
 * 复用既有链路：本模块不执行任何聊天逻辑。放行后经 notifyRenderer 推送
 * `agentBridge:turn-start`，渲染层走既有 chat:send 链路发起 SSH 轮；
 * 主进程在 senderType === "cloud-ai" 时对消息文本强制追加 CLOUD_AI_TAG 前缀
 * ——该前缀随消息文本进入 NAS Agent 上下文（防误判不依赖 UI 渲染）。
 *
 * 测试友好：零 electron 依赖、端口可传 0 自动分配（real HTTP 单测）、deps 全部可注入。
 */

const http = require("http");
const crypto = require("crypto");
const { randomUUID } = require("crypto");

/** 云端AI标记前缀——随消息文本进入 NAS Agent 上下文，防止把云端AI的话误判为用户本人的话 */
const CLOUD_AI_TAG = "【云端AI消息 · 非用户本人】";

/** 消息文本上限（字） */
const MAX_TEXT_LENGTH = 8000;
/** 放行队列上限（createAgentHttpBridge 内可经 deps.maxQueueLength 注入覆盖——默认 20；测试用） */
const MAX_QUEUE_LENGTH_DEFAULT = 20;
/** 限频：滑动窗口内最大条数（deps.rateLimit 可注入覆盖——默认 12；测试用） */
const RATE_LIMIT_DEFAULT = 12;
/** 限频窗口（毫秒） */
const RATE_WINDOW_MS = 60 * 1000;
/** 注册表容量（FIFO 淘汰，防长驻内存泄） */
const REGISTRY_CAP = 200;
/** 回复文本上限（落进注册表的截断阈值） */
const MAX_REPLY_LENGTH = 200 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""));
  const b = Buffer.from(String(expected || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createAgentHttpBridge(deps = {}) {
  const logger = typeof deps.logger === "function" ? deps.logger : () => {};
  const MAX_QUEUE_LENGTH = Number(deps.maxQueueLength) > 0 ? Number(deps.maxQueueLength) : MAX_QUEUE_LENGTH_DEFAULT;
  const RATE_LIMIT = Number(deps.rateLimit) > 0 ? Number(deps.rateLimit) : RATE_LIMIT_DEFAULT;
  const getPort = deps.getPort || (() => 21774);
  const getGate = deps.getGate || (() => true);
  const tokenProvider = deps.tokenProvider || (() => "");
  const resolveTarget = deps.resolveTarget || (() => null);
  const notifyRenderer = deps.notifyRenderer || (() => {});

  const queue = [];            // [{ msgId, text, at }]
  const registry = new Map();  // msgId → { msgId, text, state, at, reply, error }
  const rateHits = [];         // [timestamp]
  let server = null;
  let listening = false;
  let boundPort = 0;

  function log(type, payload) {
    try { logger(type, payload); } catch { /* 日志失败不阻断桥 */ }
  }

  function registrySet(entry) {
    registry.set(entry.msgId, entry);
    if (registry.size > REGISTRY_CAP) {
      const oldest = registry.keys().next().value;
      registry.delete(oldest);
    }
  }

  function busyCount() {
    let count = 0;
    for (const entry of registry.values()) {
      if (entry.state === "sent" || entry.state === "approved") count += 1;
    }
    return count;
  }

  function lastReply() {
    for (const entry of Array.from(registry.values()).reverse()) {
      if (entry.state === "done" && entry.reply) {
        return { msgId: entry.msgId, text: entry.reply, at: entry.at };
      }
    }
    return null;
  }

  function pushQueueState() {
    try { notifyRenderer("agentBridge:queue", queueSnapshot()); } catch { /* 渲染层不可达不阻断 */ }
  }

  function queueSnapshot() {
    return queue.map((item) => ({ ...item }));
  }

  /** 消息入队（人工放行闸开）：等待用户放行后才转发 */
  function enqueue(text, msgId) {
    const entry = registry.get(msgId);
    entry.state = "pending";
    queue.push({ msgId, text, at: entry.at });
    pushQueueState();
    log("agent_bridge_message_queued", { msgId, textLength: text.length, queueLength: queue.length });
  }

  /** 转发一轮：标记 sent 并通知渲染层走既有 chat:send 链路 */
  function dispatchTurn(msgId) {
    const entry = registry.get(msgId);
    if (!entry) return null;
    let target = null;
    try { target = resolveTarget(); } catch (error) {
      entry.state = "failed";
      entry.error = String(error && error.message || error);
      return null;
    }
    if (!target || !target.conversationId) {
      entry.state = "failed";
      entry.error = "没有可用的目标对话（请先在应用内新建对话）。";
      return null;
    }
    entry.state = "approved";
    entry.conversationId = target.conversationId;
    log("agent_bridge_turn_dispatched", { msgId, conversationId: entry.conversationId, textLength: entry.text.length });
    // turn text 带标记前缀：渲染层气泡所见 = 落库所存 = NAS Agent 所收（主进程侧标记幂等，不会双前缀）
    notifyRenderer("agentBridge:turn-start", {
      msgId,
      text: `${CLOUD_AI_TAG}\n${entry.text}`,
      conversationId: entry.conversationId,
      senderType: "cloud-ai"
    });
    return { msgId, conversationId: entry.conversationId };
  }

  /** 用户点击「放行」：出队→转发 */
  function approve(msgId) {
    const id = String(msgId || "");
    const index = queue.findIndex((item) => item.msgId === id);
    if (index < 0) return { ok: false, error: "该消息不在放行队列中。" };
    queue.splice(index, 1);
    const turn = dispatchTurn(id);
    if (!turn) {
      const entry = registry.get(id);
      pushQueueState();
      return { ok: false, error: entry?.error || "转发失败。" };
    }
    pushQueueState();
    return { ok: true, turn };
  }

  /** 用户点「拒绝」：出队→标 rejected。云端AI 轮询 /api/message 会看到拒绝原因，据此停手 */
  function reject(msgId, reason) {
    const id = String(msgId || "");
    const index = queue.findIndex((item) => item.msgId === id);
    if (index < 0) return { ok: false, error: "该消息不在放行队列中。" };
    queue.splice(index, 1);
    const entry = registry.get(id);
    if (entry) {
      entry.state = "rejected";
      entry.error = String(reason || "用户拒绝了这条消息。");
      log("agent_bridge_message_rejected", { msgId: id, reason: entry.error });
    }
    pushQueueState();
    return { ok: true };
  }

  /** 渲染层回报轮次终态（done/failed/cancelled/busy） */
  function reportResult(payload = {}) {
    const msgId = String(payload.msgId || "");
    const entry = registry.get(msgId);
    if (!entry) return { ok: false, error: "未知的 msgId。" };
    const state = ["done", "failed", "cancelled", "busy"].includes(payload.state) ? payload.state : null;
    if (!state) return { ok: false, error: "非法的 state。" };
    if (state === "busy") {
      // 渲染层忙（另一轮对话进行中）：按失败收口，云端AI 可稍后重发
      entry.state = "failed";
      entry.error = String(payload.error || "应用正忙：另一轮对话正在进行中，稍后可重发。");
    } else if (state === "done") {
      entry.state = "done";
      const reply = String(payload.reply == null ? "" : payload.reply);
      entry.reply = reply.length > MAX_REPLY_LENGTH ? reply.slice(0, MAX_REPLY_LENGTH) : reply;
    } else if (state === "cancelled") {
      entry.state = "done";
      entry.reply = String(payload.reply == null ? "" : payload.reply) || "（对话被用户停止。）";
    } else {
      entry.state = "failed";
      entry.error = String(payload.error || "转发轮次失败。");
    }
    log("agent_bridge_turn_reported", { msgId, state: entry.state, replyLength: (entry.reply || "").length, error: entry.error || "" });
    return { ok: true };
  }

  function checkToken(payload, queryToken) {
    // POST 从体取 token；GET 从查询串取 token（注意 searchParams 是对象——必须 .get("token")，
    // 直接 String() 会把整条查询串当 Token 比对，GET 轮询永远 403）
    const provided = payload && payload.token
      ? String(payload.token)
      : String(queryToken && typeof queryToken.get === "function" ? queryToken.get("token") || "" : queryToken || "");
    const expected = String(tokenProvider() || "");
    if (!expected) return false;
    return safeEqual(provided, expected);
  }

  function rateLimited() {
    const now = Date.now();
    while (rateHits.length && now - rateHits[0] > RATE_WINDOW_MS) rateHits.shift();
    if (rateHits.length >= RATE_LIMIT) return true;
    rateHits.push(now);
    return false;
  }

  const ROUTES = {
    "POST /api/send": (payload) => {
      if (rateLimited()) return { status: 429, body: { error: "发送频率超限（12 条/分钟），请稍后再试。" } };
      const text = String(payload.text == null ? "" : String(payload.text)).trim();
      if (!text) return { status: 400, body: { error: "消息内容不能为空。" } };
      if (text.length > MAX_TEXT_LENGTH) return { status: 400, body: { error: `消息超过 ${MAX_TEXT_LENGTH} 字上限（当前 ${text.length} 字），请拆分发送。` } };
      if (busyCount() > 0) return { status: 409, body: { error: "上一轮云端AI消息还在处理中，请等 /api/message 进入 done 后再发。" } };
      const gateOn = Boolean(getGate());
      const msgId = randomUUID();
      registrySet({ msgId, text, state: "approved", at: new Date().toISOString() });
      if (gateOn) {
        if (queue.length >= MAX_QUEUE_LENGTH) {
          const entry = registry.get(msgId);
          entry.state = "failed";
          entry.error = "人工放行队列已满，请先处理未放行消息。";
          return { status: 429, body: { error: entry.error } };
        }
        enqueue(text, msgId);
        log("agent_bridge_message_accepted", { msgId, gate: "pending", textLength: text.length });
        return { status: 202, body: { msgId, state: "pending", note: "消息已进入人工放行队列，放行后才会转发给 NAS Agent。请轮询 GET /api/message?id=… 直至 done。" } };
      }
      log("agent_bridge_message_accepted", { msgId, gate: "auto", textLength: text.length });
      const turn = dispatchTurn(msgId);
      if (!turn) {
        const entry = registry.get(msgId);
        return { status: 500, body: { msgId, state: "failed", error: entry?.error || "转发失败。" } };
      }
      return { status: 202, body: { msgId, state: "sent", note: "消息已转发。请轮询 GET /api/message?id=… 直至 done。" } };
    },
    "GET /api/message": (payload, query) => {
      const msgId = String(query.get("id") || "");
      const entry = registry.get(msgId);
      if (!entry) return { status: 404, body: { error: `未知的 msgId：${msgId || "（空）"}。` } };
      return {
        status: 200,
        body: {
          msgId,
          state: entry.state,
          reply: entry.reply || null,
          error: entry.error || null,
          at: entry.at,
          conversationId: entry.conversationId || null
        }
      };
    },
    "GET /api/status": () => ({
      status: 200,
      body: {
        busy: busyCount() > 0,
        queueLength: queue.length,
        gate: Boolean(getGate()),
        lastReply: lastReply(),
        note: Boolean(getGate()) ? "人工放行已开启：消息发送后需在应用内放行才转发。" : "人工放行已关闭：消息直接转发。"
      }
    })
  };

  function handleRequest(req, res) {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${boundPort || 1}`);
      const routeKey = `${req.method} ${url.pathname}`;
      // 远端必须为本机回环（双保险——server 已绑定回环，这里再验一层面板代理/转发情况）
      const remote = String(req.socket.remoteAddress || "");
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
        return json(res, 403, { error: "Agent HTTP 桥只接受本机回环连接。" });
      }
      // 浏览器发起的请求带 Origin 头（CSRF 面）——一律拒绝；curl/程序化调用不带 Origin 不受影响
      if (req.headers.origin) {
        return json(res, 403, { error: "Agent HTTP 桥拒绝浏览器 Origin 请求。" });
      }
      if (routeKey === "GET /health") {
        return json(res, 200, { ok: true, edition: "bridge", note: "Agent Chat Pro Bridge · Agent HTTP 桥" });
      }
      const handler = ROUTES[routeKey];
      if (!handler) return json(res, 404, { error: `未知端点：${routeKey}（可用：GET /health、POST /api/send、GET /api/message、GET /api/status）。` });
      let payload = null;
      if (req.method === "POST") {
        let raw = "";
        let oversized = false;
        req.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 64 * 1024) { oversized = true; req.destroy(); }
        });
        req.on("end", () => {
          if (oversized) return;
          try {
            payload = raw ? JSON.parse(raw) : {};
          } catch {
            return json(res, 400, { error: "请求体不是合法 JSON。" });
          }
          if (!checkToken(payload, url.searchParams)) return json(res, 403, { error: "Token 无效，请在 Agent Chat Pro Bridge 设置里复制最新 Token。" });
          const result = handler(payload, url.searchParams);
          return json(res, result.status, result.body);
        });
        req.on("error", () => { try { json(res, 400, { error: "请求读取失败。" }); } catch { /* 已销毁 */ } });
        return;
      }
      // GET：token 走查询参数
      if (!checkToken(null, url.searchParams)) return json(res, 403, { error: "Token 无效，请在 Agent Chat Pro Bridge 设置里复制最新 Token。" });
      const result = handler(null, url.searchParams);
      return json(res, result.status, result.body);
    } catch (error) {
      try { json(res, 500, { error: "桥内部错误：" + String(error && error.message || error) }); } catch { /* 响应已发出 */ }
    }
  }

  function start() {
    if (server) return { ok: true, port: boundPort };
    // 端口 0 = 系统自动分配（测试路径）；非法值落默认 21774。注意 0 不可当 falsy 误判
    const requested = Number(getPort());
    const port = Number.isInteger(requested) && requested >= 0 && requested <= 65535 ? requested : 21774;
    return new Promise((resolve) => {
      server = http.createServer(handleRequest);
      server.on("error", (error) => {
        listening = false;
        log("agent_bridge_start_failed", { error: error.message, port });
        resolve({ ok: false, error: error.message });
      });
      server.listen(port, "127.0.0.1", () => {
        boundPort = server.address().port;
        listening = true;
        log("agent_bridge_started", { port: boundPort, gate: Boolean(getGate()) });
        resolve({ ok: true, port: boundPort });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => {
        listening = false;
        server = null;
        resolve();
      });
    });
  }

  /** 渲染层设置页快照（token 明文仅走本机 IPC，给用户复制给云端AI 用）。
   *  ⚠️ lastReply 必须调用取值：IPC structuredClone 遇函数直接 DataCloneError。 */
  function info() {
    return {
      listening,
      port: boundPort,
      gate: Boolean(getGate()),
      token: String(tokenProvider() || ""),
      queue: queueSnapshot(),
      busy: busyCount() > 0,
      lastReply: lastReply()
    };
  }

  /** 测试/诊断快照 */
  function snapshot() {
    return {
      listening,
      port: boundPort,
      gate: Boolean(getGate()),
      queue: queueSnapshot(),
      registry: Array.from(registry.values()).map((entry) => ({ ...entry })),
      busy: busyCount() > 0
    };
  }

  return { start, stop, approve, reject, reportResult, info, snapshot, dispatchTurn };
}

module.exports = {
  createAgentHttpBridge,
  CLOUD_AI_TAG,
  applyCloudAiMarking: (text) => `${CLOUD_AI_TAG}\n${String(text == null ? "" : text)}`
};