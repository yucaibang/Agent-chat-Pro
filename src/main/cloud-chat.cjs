"use strict";

const https = require("https");
const http = require("http");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { toAnthropicTools } = require("./cloud-tools.cjs");
// v3.24.0 模型思考调节：挡位注入（四字段族映射）——注入前 resolve 挡位表，未命中零注入
const { applyOpenAiThinking, applyAnthropicThinking } = require("./thinking-levels.cjs");

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
    if (msg.raw) { result.push({ role: msg.role, content: msg.content }); continue; } // 工具循环构造的消息原样透传
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
  // tools 注入：v3.24.0 加 thinking 注入时误删此段（历史回归测试揪出），恢复——
  // Anthropic 分支工具执行（云办公/ask_user）全靠它，丢了=服务商报 400 或 AI 永远拿不到工具
  if (Array.isArray(options.tools) && options.tools.length) {
    body.tools = toAnthropicTools(options.tools);
  }
  // v3.24.0 模型思考调节：Anthropic 原生体 thinking.budget_tokens 数字挡注入（自动钳进 max_tokens）
  if (options.thinking) applyAnthropicThinking(body, options.thinking.model ? options.thinking : { ...options.thinking, model: options.model });
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
      // v3.24.0 思考过程显示：Anthropic extended thinking 增量（thinking_delta）
      if (parsed.delta?.type === "thinking_delta" && parsed.delta?.thinking) {
        return { thinking: parsed.delta.thinking };
      }
      if (parsed.delta?.type === "input_json_delta") {
        return { toolUseDelta: { index: parsed.index || 0, partialJson: parsed.delta.partial_json || "" } };
      }
    }

    if (eventType === "content_block_start" && parsed.content_block?.type === "tool_use") {
      return { toolUseStart: { index: parsed.index || 0, id: parsed.content_block.id || "", name: parsed.content_block.name || "" } };
    }

    if (eventType === "message_delta" && parsed.usage) {
      return { usage: { prompt_tokens: parsed.usage.input_tokens || 0, completion_tokens: parsed.usage.output_tokens || 0, total_tokens: (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0) }, stopReason: parsed.delta?.stop_reason || "" };
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
    // raw 消息（工具循环构造的 assistant.tool_calls / role:"tool"）原样透传，其余走文本转换
    messages: messages.map((msg) => {
      if (msg.raw) return { role: msg.role, content: msg.content, ...msg.extra };
      return { role: msg.role, content: msg.text || msg.content || "" };
    }),
    stream: true,
    max_tokens: options.maxTokens || 4096,
    // v3.21.3 修复①：OpenAI 兼容流式默认不回 usage 块（token 计量只剩估算值）。
    // 标准字段 stream_options.include_usage 会让端点在最后一个 chunk 附带完整 usage；
    // 主流 OpenAI 兼容端点（智谱/DeepSeek/Kimi/OpenAI/Groq/硅基流动/豆包）均支持，未知字段在中转站一般被忽略。
    // Anthropic 分支不走此函数（原生 message_delta 自带 usage）。
    stream_options: { include_usage: true }
  };
  if (Array.isArray(options.tools) && options.tools.length) body.tools = options.tools;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.topP = options.topP;
  // v3.24.0 模型思考调节：挡位注入（OpenAI 兼容四字段族——reasoning_effort/thinking.type/enable_thinking/thinking_budget）
  if (options.thinking) applyOpenAiThinking(body, options.thinking);
  return body;
}

/**
 * v3.21.3 修复①：云端工具循环的 usage 跨轮累计器（纯函数，供 main.cjs 工具循环复用与单测）。
 * ⚠️ 财务口径说明（v3.21.3 修正 v3.15.1 的旧理解）：云端 AI 工具循环每一轮请求都会把
 * 全部上下文（历史+工具结果）重新计一次输入费用——服务商账单就是按「每轮完整请求」计的，
 * 所以真实消耗必须 Σ每轮 (input + output) 累加，而不是只记本轮输出。
 * usage 字段三风格兼容（camelCase / snake_case 均可）。
 * @returns {number} 本次累计到的增量（total_tokens），供日志或断言；无效 usage 返回 0
 */
function accumulateUsage(total, usage) {
  if (!usage || typeof usage !== "object") return 0;
  const prompt = Number(usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
  if (!prompt && !completion) return 0;
  total.prompt += prompt;
  total.completion += completion;
  total.total += prompt + completion;
  total.requests += 1;
  return prompt + completion;
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

/** 组装 OpenAI 增量工具调用（按 index 排序） */
function assembleOpenAiToolCalls(accumulator) {
  return Array.from(accumulator.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => ({ id: value.id, name: value.name, arguments: value.arguments }));
}

/** 组装 Anthropic tool_use 块（按 index 排序） */
function assembleAnthropicToolCalls(blocks) {
  return Array.from(blocks.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => ({ id: value.id, name: value.name, arguments: value.json }));
}

/**
 * 发送云端 AI 聊天请求（流式）
 * @param {object} config - { apiKey, baseURL, model, maxTokens, provider, proxy, thinking?(v3.24.0 {provider, choice}) }
 * @param {Array} messages - OpenAI 格式消息数组
 * @param {object} callbacks - { onDelta, onReasoning(v3.24.0 思考过程), onStatus, onUsage, onLog }
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
      body = buildAnthropicBody(messages, { model: config.model, maxTokens: config.maxTokens, tools: config.tools, thinking: config.thinking });
      headers = {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        "Accept": "text/event-stream"
      };
    } else {
      url = new URL(`${baseURL}/chat/completions`);
      body = buildChatBody(messages, { model: config.model, maxTokens: config.maxTokens, tools: config.tools, thinking: config.thinking });
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

    // 响应级超时：收到数据后重置（v3.19.0 F3：空闲秒数可配 advanced.cloud.streamIdleTimeoutSec，60~1800 默认 300）
    const streamIdleTimeoutMs = (() => {
      const n = Number(callbacks.advanced?.cloud?.streamIdleTimeoutSec);
      return Number.isFinite(n) && n >= 60 && n <= 1800 ? n * 1000 : 300000;
    })();
    let responseTimer = setTimeout(() => {
      if (!settled) {
        if (callbacks.onLog) callbacks.onLog("cloud_chat_response_timeout", { textLength: fullText?.length || 0, streamIdleTimeoutMs });
        if (req) req.destroy();
        safeReject(new Error(`云端 AI 响应空闲超过 ${Math.round(streamIdleTimeoutMs / 1000)} 秒未收到数据。`));
      }
    }, streamIdleTimeoutMs);
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
          // v3.15.3：常见状态码（402 余额不足/403/404/5xx...）翻译成人话，带服务商名，原始信息附后
          const error = new Error(translateHttpError(res.statusCode, bodyText, config.provider));
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
      let fullReasoning = ""; // v3.24.0 思考过程流式暂存（显示用，不进上下文回填）
      let lastUsage = null;
      let buffer = "";
      let stopReason = "";
      const toolCallAccumulator = new Map(); // OpenAI：index → {id, name, arguments} 增量拼接
      const anthropicToolBlocks = new Map(); // Anthropic：index → {id, name, json}

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
              // v3.24.0 思考过程：thinking_delta 片段流式外发
              if (result.thinking) {
                fullReasoning += result.thinking;
                if (callbacks.onReasoning) callbacks.onReasoning(result.thinking);
              }
              if (result.usage) {
                lastUsage = result.usage;
                if (callbacks.onUsage) callbacks.onUsage(result.usage);
              }
              if (result.stopReason) stopReason = result.stopReason;
              if (result.toolUseStart) {
                anthropicToolBlocks.set(result.toolUseStart.index, { id: result.toolUseStart.id, name: result.toolUseStart.name, json: "" });
              }
              if (result.toolUseDelta) {
                const block = anthropicToolBlocks.get(result.toolUseDelta.index);
                if (block) block.json += result.toolUseDelta.partialJson;
              }
            }
          } else {
            // OpenAI 兼容 SSE 格式
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta || {};
              if (delta.content) {
                fullText += delta.content;
                if (callbacks.onDelta) callbacks.onDelta(delta.content);
              }
              // v3.24.0 思考过程：OpenAI 兼容系思维链增量（reasoning_content 普遍/部分端点 reasoning）
              const reasoningPiece = delta.reasoning_content ?? delta.reasoning;
              if (reasoningPiece) {
                const piece = String(reasoningPiece);
                fullReasoning += piece;
                if (callbacks.onReasoning) callbacks.onReasoning(piece);
              }
              // 工具调用增量：按 index 拼接 id/name/arguments 分片
              if (Array.isArray(delta.tool_calls)) {
                for (const piece of delta.tool_calls) {
                  const index = Number.isInteger(piece.index) ? piece.index : 0;
                  const existing = toolCallAccumulator.get(index) || { id: "", name: "", arguments: "" };
                  if (piece.id) existing.id = piece.id;
                  if (piece.function?.name) existing.name += piece.function.name;
                  if (piece.function?.arguments) existing.arguments += piece.function.arguments;
                  toolCallAccumulator.set(index, existing);
                }
              }
              if (choice?.finish_reason) stopReason = choice.finish_reason;
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
          safeResolve({ text: fullText, reasoning: fullReasoning, cancelled: true });
          return;
        }

        // 处理剩余 buffer
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (anthropic) {
            const result = parseAnthropicSSE(trimmed, callbacks);
            if (result) {
              if (result.delta) fullText += result.delta;
              if (result.thinking) { fullReasoning += result.thinking; if (callbacks.onReasoning) callbacks.onReasoning(result.thinking); }
              if (result.usage) lastUsage = result.usage;
              if (result.stopReason) stopReason = result.stopReason;
              if (result.toolUseStart) {
                anthropicToolBlocks.set(result.toolUseStart.index, { id: result.toolUseStart.id, name: result.toolUseStart.name, json: "" });
              }
              if (result.toolUseDelta) {
                const block = anthropicToolBlocks.get(result.toolUseDelta.index);
                if (block) block.json += result.toolUseDelta.partialJson;
              }
            }
          } else {
            if (trimmed.startsWith("data:")) {
              const data = trimmed.slice(5).trim();
              if (data !== "[DONE]") {
                try {
                  const parsed = JSON.parse(data);
                  const choice = parsed.choices?.[0];
                  const delta = choice?.delta || {};
                  if (delta.content) fullText += delta.content;
                  const reasoningTail = delta.reasoning_content ?? delta.reasoning;
                  if (reasoningTail) { fullReasoning += String(reasoningTail); if (callbacks.onReasoning) callbacks.onReasoning(String(reasoningTail)); }
                  if (Array.isArray(delta.tool_calls)) {
                    for (const piece of delta.tool_calls) {
                      const index = Number.isInteger(piece.index) ? piece.index : 0;
                      const existing = toolCallAccumulator.get(index) || { id: "", name: "", arguments: "" };
                      if (piece.id) existing.id = piece.id;
                      if (piece.function?.name) existing.name += piece.function.name;
                      if (piece.function?.arguments) existing.arguments += piece.function.arguments;
                      toolCallAccumulator.set(index, existing);
                    }
                  }
                  if (choice?.finish_reason) stopReason = choice.finish_reason;
                  if (parsed.usage && (parsed.usage.prompt_tokens || parsed.usage.completion_tokens || parsed.usage.total_tokens)) {
                    lastUsage = parsed.usage;
                  }
                } catch {}
              }
            }
          }
        }
        if (callbacks.onLog) callbacks.onLog("cloud_chat_success", { textLength: fullText.length, usage: lastUsage, stopReason, toolCallCount: anthropic ? anthropicToolBlocks.size : toolCallAccumulator.size });
        const toolCalls = anthropic ? assembleAnthropicToolCalls(anthropicToolBlocks) : assembleOpenAiToolCalls(toolCallAccumulator);
        safeResolve({ text: fullText, reasoning: fullReasoning, usage: lastUsage, toolCalls, stopReason });
      });

      res.on("error", (error) => {
        if (cancelled) {
          safeResolve({ text: fullText, reasoning: fullReasoning, cancelled: true });
          return;
        }
        safeReject(new Error(`云端 AI 响应中断：${error.message}`));
      });

      // 兜底：连接被关闭但 end/error 都不触发时（代理/负载均衡器断开）
      res.on("close", () => {
        if (!settled) {
          if (cancelled) {
            safeResolve({ text: fullText, reasoning: fullReasoning, cancelled: true });
          } else {
            // 流意外关闭但已收到部分数据 — 作为正常完成处理
            if (fullText.length > 0) {
              if (callbacks.onLog) callbacks.onLog("cloud_chat_close_with_data", { textLength: fullText.length });
              safeResolve({ text: fullText, reasoning: fullReasoning, usage: lastUsage, toolCalls: anthropic ? assembleAnthropicToolCalls(anthropicToolBlocks) : assembleOpenAiToolCalls(toolCallAccumulator), stopReason });
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

    // v3.19.0 F3：连接超时可配（advanced.cloud.connectTimeoutSec，10~300 默认 120）
    const connectTimeoutMs = (() => {
      const n = Number(callbacks.advanced?.cloud?.connectTimeoutSec);
      return Number.isFinite(n) && n >= 10 && n <= 300 ? n * 1000 : 120000;
    })();
    req.setTimeout(connectTimeoutMs);
    req.write(JSON.stringify(body));
    req.end();
  });

  promise.cancel = () => {
    cancelled = true;
    if (req) req.destroy();
    // 取消兜底链：req.destroy() 会触发 res 的 error/close 事件，
    // 由上方 safeResolve/safeReject 确保 Promise 一定 settle；
    // UI 侧另有 10 秒强制清除状态兜底。
  };
  return promise;
}

// ────────────────────────────────────────────
//  HTTP 状态码友好翻译（v3.15.3）
//  修复：402 余额不足等错误把服务商原始 JSON 直接甩给用户，且看不出是哪家平台的问题
// ────────────────────────────────────────────

/** provider → 中文名（与渲染层 CLOUD_PROVIDERS 对齐） */
const PROVIDER_LABELS = {
  zhipu: "智谱 AI",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  doubao: "豆包",
  openai: "OpenAI",
  gemini: "Gemini",
  groq: "Groq",
  siliconflow: "硅基流动",
  anthropic: "Claude",
  custom: "自定义接口"
};

/** 常见 HTTP 状态码 → 人话提示（占位符 {provider} 会被替换） */
const HTTP_ERROR_HINTS = {
  402: "{provider} 账户余额不足（HTTP 402），请登录对应开放平台充值后重试。",
  403: "{provider} 拒绝访问（HTTP 403）：API 密钥权限不足，或该模型未开通/未授权。",
  404: "接口或模型不存在（HTTP 404）：请检查模型名称与 API 地址是否匹配。",
  408: "{provider} 服务器处理超时（HTTP 408），请稍后重试。",
  413: "请求内容过长（HTTP 413）：请精简对话或调小上下文长度。",
  500: "{provider} 服务器内部错误（HTTP 500），请稍后重试。",
  502: "{provider} 网关错误（HTTP 502），请稍后重试。",
  503: "{provider} 服务繁忙或维护中（HTTP 503），请稍后重试。",
  504: "{provider} 网关超时（HTTP 504），请稍后重试。"
};

/**
 * 把非 200 响应翻译成用户能看懂的提示（v3.15.3）
 * 有匹配的常见状态码 → 友好提示在前 + 原始信息在后（方便排查）；
 * 未匹配 → 保留原有格式，不丢排查线索。
 */
function translateHttpError(statusCode, bodyText, provider) {
  const label = PROVIDER_LABELS[provider] || "云端 AI";
  const hint = HTTP_ERROR_HINTS[statusCode];
  const raw = bodyText ? bodyText.slice(0, 200) : "（无返回内容）";
  if (hint) return `${hint.replace("{provider}", label)}\n（原始信息：${raw}）`;
  return `云端 AI 返回错误 (${statusCode})：${raw}`;
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

// ────────────────────────────────────────────
//  代理连通性测试
// ────────────────────────────────────────────

const PROXY_TEST_URL = "https://www.gstatic.com/generate_204";
const PROXY_TEST_TIMEOUT_MS = 10000;

/** 代理测试错误转中文提示 */
function translateProxyTestError(error) {
  const code = error && error.code;
  const msg = (error && error.message) || "";
  if (code === "ECONNREFUSED") return "代理端口拒绝连接（ECONNREFUSED），请确认代理软件正在运行、地址端口填写正确。";
  if (code === "ETIMEDOUT" || /timeout/i.test(msg)) return "连接代理超时，请检查地址/端口/防火墙设置。";
  if (code === "ECONNRESET" || code === "EPIPE") return "连接被重置，代理可能不稳定或代理类型选择有误。";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "代理地址无法解析，请检查代理地址是否填写正确。";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "无法连接到代理服务器，请检查代理地址和端口。";
  if (code === "EPROTO") return "协议不匹配，请确认代理类型（HTTP/SOCKS5）选择正确。";
  if (code === "ABORT_ERR") return "测试请求已超时取消。";
  return `代理测试失败：${msg || String(error)}`;
}

/** 代理连通性测试 — 通过代理发起一次轻量 HTTPS 请求，返回结果与耗时 */
function testProxyConnectivity(proxyConfig) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const finish = (partial) => resolve({ latencyMs: Date.now() - startedAt, ...partial });
    const config = proxyConfig || {};
    if (!config.enabled || !config.host || !config.port) {
      return finish({ ok: false, error: "代理未启用或地址/端口不完整，请先启用代理并填写地址和端口。" });
    }
    let agent;
    try {
      agent = buildProxyAgent(config);
    } catch (error) {
      return finish({ ok: false, error: `代理配置无效：${error.message}` });
    }
    if (!agent) {
      return finish({ ok: false, error: "代理未启用或地址/端口不完整，请先启用代理并填写地址和端口。" });
    }
    let settled = false;
    const request = https.get(PROXY_TEST_URL, { agent, timeout: PROXY_TEST_TIMEOUT_MS }, (response) => {
      const statusCode = response.statusCode || 0;
      response.resume(); // 丢弃响应体，只测连通
      if (statusCode === 407) {
        settled = true;
        return finish({ ok: false, statusCode, error: "代理要求认证（407），请检查用户名/密码。" });
      }
      settled = true;
      // 任何其他状态码都代表代理隧道已建立，即视为连通
      request.destroy();
      response.destroy();
      return finish({ ok: true, statusCode, message: `代理连通正常（HTTP ${statusCode}）` });
    });
    request.on("timeout", () => {
      request.destroy();
      if (!settled) finish({ ok: false, error: "连接代理超时（10 秒），请检查地址/端口/防火墙设置。" });
    });
    request.on("error", (error) => {
      if (!settled) finish({ ok: false, error: translateProxyTestError(error) });
    });
  });
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

module.exports = { sendCloudChat, buildMessages, verifyCloudConnection, friendlyError, testProxyConnectivity, buildChatBody, buildAnthropicBody, translateHttpError, accumulateUsage };