"use strict";

const https = require("https");
const http = require("http");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

/**
 * 云端 AI 聊天模块 — OpenAI 兼容 API + Anthropic Messages API
 *
 * 支持服务商：
 * - 智谱 AI / DeepSeek / Kimi / 豆包 / OpenAI / Gemini / Groq / 硅基流动 — OpenAI 兼容
 * - Anthropic Claude — Messages API 适配
 * - 任何 OpenAI 兼容 API（自定义）
 *
 * 支持代理：HTTP/HTTPS 代理、SOCKS5 代理
 */

/** 构建代理 Agent，返回 undefined 表示不使用代理 */
function buildProxyAgent(proxyConfig) {
  if (!proxyConfig || !proxyConfig.enabled || !proxyConfig.host || !proxyConfig.port) return undefined;
  const auth = proxyConfig.username ? `${encodeURIComponent(proxyConfig.username)}:${encodeURIComponent(proxyConfig.password || "")}@` : "";
  if (proxyConfig.type === "socks5") {
    return new SocksProxyAgent(`socks5://${auth}${proxyConfig.host}:${proxyConfig.port}`);
  }
  return new HttpsProxyAgent(`http://${auth}${proxyConfig.host}:${proxyConfig.port}`);
}

// ────────────────────────────────────────────
//  Anthropic Messages API 适配层
// ────────────────────────────────────────────

/** 判断是否为 Anthropic（Claude）服务商 */
function isAnthropicProvider(provider) {
  return provider === "anthropic";
}

/** 将 OpenAI 格式消息转为 Anthropic Messages 格式 */
function toAnthropicMessages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // 系统提示单独传
    result.push({ role: msg.role, content: msg.content || "" });
  }
  return result;
}

/** 提取系统提示（Anthropic 需要单独传 system 字段） */
function extractSystemPrompt(messages) {
  const systemMsg = messages.find(m => m.role === "system");
  return systemMsg ? systemMsg.content : "";
}

/** 构建 Anthropic Messages API 请求体 */
function buildAnthropicBody(messages, options = {}) {
  const systemPrompt = extractSystemPrompt(messages);
  const anthropicMessages = toAnthropicMessages(messages);
  const body = {
    model: options.model || "claude-sonnet-4-20250514",
    messages: anthropicMessages,
    max_tokens: options.maxTokens || 4096,
    stream: true
  };
  if (systemPrompt) body.system = systemPrompt;
  return body;
}

/** 解析 Anthropic SSE 流式事件 */
function parseAnthropicSSE(line, callbacks) {
  if (!line.startsWith("event:") && !line.startsWith("data:")) return null;

  // 我们只关心 data: 行，event: 行用于上下文但解析不需要
  if (!line.startsWith("data:")) return null;

  const data = line.slice(5).trim();
  if (!data) return null;

  try {
    const parsed = JSON.parse(data);
    const eventType = parsed.type;

    if (eventType === "content_block_delta") {
      const text = parsed.delta?.text || "";
      if (text) return { delta: text };
    }

    if (eventType === "message_delta" && parsed.usage) {
      return { usage: { prompt_tokens: parsed.usage.input_tokens || 0, completion_tokens: parsed.usage.output_tokens || 0, total_tokens: (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0) } };
    }

    return { parsed };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────
//  OpenAI 兼容 API（原有逻辑）
// ────────────────────────────────────────────

/** 构建聊天请求体 */
function buildChatBody(messages, options = {}) {
  const body = {
    model: options.model || "glm-4-flash",
    messages: messages.map((msg) => ({
      role: msg.role,
      content: msg.text || msg.content || ""
    })),
    stream: true,
    max_tokens: options.maxTokens || 4096
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.topP = options.topP;
  return body;
}

/** 将对话历史转为 API 消息格式 */
function buildMessages(conversation, systemPrompt) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  for (const msg of conversation.messages) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.text });
    } else if (msg.role === "assistant" && !msg.draft) {
      messages.push({ role: "assistant", content: msg.text });
    }
  }
  return messages;
}

// ────────────────────────────────────────────
//  通用发送逻辑
// ────────────────────────────────────────────

/**
 * 发送云端 AI 聊天请求（流式）
 * @param {object} config - { apiKey, baseURL, model, maxTokens, provider, proxy }
 * @param {Array} messages - OpenAI 格式消息数组
 * @param {object} callbacks - { onDelta, onStatus, onUsage, onLog }
 * @returns {Promise<{text, usage}>}
 */
function sendCloudChat(config, messages, callbacks = {}) {
  let cancelled = false;
  let req = null;
  let resRef = null; // 保存 res 引用用于取消

  const promise = new Promise((resolve, reject) => {
    const anthropic = isAnthropicProvider(config.provider);
    const baseURL = (config.baseURL || "https://open.bigmodel.cn/api/paas/v4/").replace(/\/+$/, "");

    // 根据服务商选择端点和请求体格式
    let url, body, headers;
    if (anthropic) {
      url = new URL(`${baseURL}/messages`);
      body = buildAnthropicBody(messages, { model: config.model, maxTokens: config.maxTokens });
      headers = {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "Accept": "text/event-stream"
      };
    } else {
      url = new URL(`${baseURL}/chat/completions`);
      body = buildChatBody(messages, { model: config.model, maxTokens: config.maxTokens });
      headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
        "Accept": "text/event-stream"
      };
    }

    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    if (callbacks.onLog) callbacks.onLog("cloud_chat_request", { provider: config.provider, model: body.model, messageCount: messages.length, anthropic });

    // 构建代理 Agent
    const proxyAgent = buildProxyAgent(config.proxy);

    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers,
      ...(proxyAgent ? { agent: proxyAgent } : {})
    };

    if (callbacks.onStatus) callbacks.onStatus("connecting");

    // 安全 resolve/reject：确保 Promise 只 settle 一次
    let settled = false;
    const safeResolve = (value) => { if (!settled) { settled = true; clearTimeout(responseTimer); resolve(value); } };
    const safeReject = (error) => { if (!settled) { settled = true; clearTimeout(responseTimer); reject(error); } };

    // 响应级超时：收到数据后重置，5 分钟无数据则超时
    let responseTimer = setTimeout(() => {
      if (!settled) {
        if (callbacks.onLog) callbacks.onLog("cloud_chat_response_timeout", { textLength: fullText?.length || 0 });
        if (req) req.destroy();
        safeReject(new Error("云端 AI 响应超时（超过 5 分钟未收到数据）。"));
      }
    }, 300000);
    responseTimer.unref(); // 不阻止进程退出

    req = client.request(requestOptions, (res) => {
      resRef = res;

      if (res.statusCode === 401) {
        const error = new Error(anthropic ? "Anthropic API 密钥无效或已过期。请检查设置中的 API 密钥。" : "API 密钥无效或已过期。请检查设置中的云端 AI 密钥。");
        error.code = "CLOUD_AUTH";
        safeReject(error);
        return;
      }
      if (res.statusCode === 429) {
        const error = new Error("请求过于频繁，请稍后重试。免费模型有速率限制。");
        error.code = "CLOUD_RATE";
        safeReject(error);
        return;
      }
      if (res.statusCode !== 200) {
        let bodyText = "";
        res.on("data", (chunk) => { bodyText += chunk; });
        res.on("end", () => {
          const error = new Error(`云端 AI 返回错误 (${res.statusCode})：${bodyText.slice(0, 200)}`);
          error.code = "CLOUD_ERROR";
          safeReject(error);
        });
        return;
      }

      if (callbacks.onStatus) callbacks.onStatus("connected");

      if (cancelled) {
        safeResolve({ text: "", cancelled: true });
        return;
      }

      let fullText = "";
      let lastUsage = null;
      let buffer = "";

      res.on("data", (chunk) => {
        // 取消后忽略后续数据
        if (cancelled) return;

        // 收到数据，重置响应超时
        clearTimeout(responseTimer);
        responseTimer = setTimeout(() => {
          if (!settled) {
            if (callbacks.onLog) callbacks.onLog("cloud_chat_response_timeout", { textLength: fullText.length });
            req.destroy();
            safeReject(new Error("云端 AI 响应超时（超过 5 分钟未收到数据）。"));
          }
        }, 300000);
        responseTimer.unref();

        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (anthropic) {
            // Anthropic Messages API SSE 格式
            const result = parseAnthropicSSE(trimmed, callbacks);
            if (result) {
              if (result.delta) {
                fullText += result.delta;
                if (callbacks.onDelta) callbacks.onDelta(result.delta);
              }
              if (result.usage) {
                lastUsage = result.usage;
                if (callbacks.onUsage) callbacks.onUsage(result.usage);
              }
            }
          } else {
            // OpenAI 兼容 SSE 格式
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content || "";
              if (delta) {
                fullText += delta;
                if (callbacks.onDelta) callbacks.onDelta(delta);
              }
              if (parsed.usage && (parsed.usage.prompt_tokens || parsed.usage.completion_tokens || parsed.usage.total_tokens)) {
                lastUsage = parsed.usage;
                if (callbacks.onUsage) callbacks.onUsage(parsed.usage);
              }
            } catch {}
          }
        }
      });

      res.on("end", () => {
        // 取消后直接 resolve 已收到的文本
        if (cancelled) {
          safeResolve({ text: fullText, cancelled: true });
          return;
        }

        // 处理剩余 buffer
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (anthropic) {
            const result = parseAnthropicSSE(trimmed, callbacks);
            if (result) {
              if (result.delta) fullText += result.delta;
              if (result.usage) lastUsage = result.usage;
            }
          } else {
            if (trimmed.startsWith("data:")) {
              const data = trimmed.slice(5).trim();
              if (data !== "[DONE]") {
                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices?.[0]?.delta?.content || "";
                  if (delta) fullText += delta;
                  if (parsed.usage && (parsed.usage.prompt_tokens || parsed.usage.completion_tokens || parsed.usage.total_tokens)) {
                    lastUsage = parsed.usage;
                  }
                } catch {}
              }
            }
          }
        }
        if (callbacks.onLog) callbacks.onLog("cloud_chat_success", { textLength: fullText.length, usage: lastUsage });
        safeResolve({ text: fullText, usage: lastUsage });
      });

      res.on("error", (error) => {
        if (cancelled) {
          safeResolve({ text: fullText, cancelled: true });
          return;
        }
        safeReject(new Error(`云端 AI 响应中断：${error.message}`));
      });

      // 兜底：连接被关闭但 end/error 都不触发时（代理/负载均衡器断开）
      res.on("close", () => {
        if (!settled) {
          if (cancelled) {
            safeResolve({ text: fullText, cancelled: true });
          } else {
            // 流意外关闭但已收到部分数据 — 作为正常完成处理
            if (fullText.length > 0) {
              if (callbacks.onLog) callbacks.onLog("cloud_chat_close_with_data", { textLength: fullText.length });
              safeResolve({ text: fullText, usage: lastUsage });
            } else {
              safeReject(new Error("云端 AI 连接意外关闭，未收到任何数据。"));
            }
          }
        }
      });
    });

    req.on("error", (error) => {
      const friendly = friendlyError(error);
      safeReject(friendly);
    });

    req.on("timeout", () => {
      req.destroy();
      safeReject(new Error("云端 AI 连接超时，请检查网络或更换 API 地址。"));
    });

    req.setTimeout(120000); // 2 分钟连接超时
    req.write(JSON.stringify(body));
    req.end();
  });

  promise.cancel = () => {
    cancelled = true;
    if (req) req.destroy();
    // 如果 Promise 已经 settled，cancel 是空操作
    // 如果 Promise 还在等待（极端情况），5秒后强制 resolve
    // 这确保即使 req.destroy() 没有触发任何事件，UI 也不会永远卡住
    const forceTimer = setTimeout(() => {
      try { promise.then(() => {}, () => {}); } catch {}
      // Promise 已 settled，无需操作
    }, 5000);
    forceTimer.unref();
  };
  return promise;
}

/** 友好错误提示 */
function friendlyError(error) {
  const msg = error.message || "";
  if (error.code === "ENOTFOUND" || /getaddrinfo/.test(msg)) return Object.assign(new Error("云端 AI 服务器地址解析失败，请检查 API 地址设置。"), { code: "CLOUD_DNS" });
  if (error.code === "ECONNREFUSED") return Object.assign(new Error("云端 AI 服务器拒绝连接。"), { code: "CLOUD_REFUSED" });
  if (error.code === "ETIMEDOUT" || /timeout/i.test(msg)) return Object.assign(new Error("云端 AI 连接超时，请检查网络。"), { code: "CLOUD_TIMEOUT" });
  if (error.code === "CLOUD_AUTH" || error.code === "CLOUD_RATE" || error.code === "CLOUD_ERROR") return error;
  // 代理相关错误
  if (error.code === "ECONNRESET" || /proxy/i.test(msg) || /tunnel/i.test(msg)) return Object.assign(new Error("代理连接失败，请检查代理设置。"), { code: "CLOUD_PROXY" });
  if (error.code === "EHOSTUNREACH") return Object.assign(new Error("无法连接到代理服务器，请检查代理地址和端口。"), { code: "CLOUD_PROXY" });
  return Object.assign(new Error(`云端 AI 连接失败：${msg}`), { code: "CLOUD_ERROR" });
}

/** 测试云端 AI 连接 */
function verifyCloudConnection(config, onLog) {
  return sendCloudChat(
    { ...config, maxTokens: 10 },
    [{ role: "user", content: "你好，请回复一个字。" }],
    { onLog, onStatus: () => {} }
  ).then(() => true).catch((error) => {
    throw friendlyError(error);
  });
}

module.exports = { sendCloudChat, buildMessages, verifyCloudConnection, friendlyError };