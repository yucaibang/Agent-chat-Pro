"use strict";

const https = require("https");
const http = require("http");

/**
 * 云端 AI 聊天模块 — OpenAI 兼容 API（智谱 AI GLM-4-Flash 等）
 *
 * 支持所有 OpenAI chat/completions 兼容接口：
 * - 智谱 AI (open.bigmodel.cn) — 推荐，GLM-4-Flash 永久免费
 * - 硅基流动 (siliconflow.cn)
 * - OpenRouter (openrouter.ai)
 * - 任何 OpenAI 兼容 API
 */

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

/**
 * 发送云端 AI 聊天请求（流式）
 * @param {object} config - { apiKey, baseURL, model, maxTokens }
 * @param {Array} messages - OpenAI 格式消息数组
 * @param {object} callbacks - { onDelta, onStatus, onLog }
 * @returns {Promise<{text, sessionId}>}
 */
function sendCloudChat(config, messages, callbacks = {}) {
  let cancelled = false;
  const promise = new Promise((resolve, reject) => {
    const baseURL = (config.baseURL || "https://open.bigmodel.cn/api/paas/v4/").replace(/\/+$/, "");
    const url = new URL(`${baseURL}/chat/completions`);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    const body = buildChatBody(messages, {
      model: config.model || "glm-4-flash",
      maxTokens: config.maxTokens || 4096
    });

    if (callbacks.onLog) callbacks.onLog("cloud_chat_request", { model: body.model, messageCount: messages.length });

    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
        "Accept": "text/event-stream"
      }
    };

    if (callbacks.onStatus) callbacks.onStatus("connecting");

    const req = client.request(requestOptions, (res) => {
      if (res.statusCode === 401) {
        const error = new Error("API 密钥无效或已过期。请检查设置中的云端 AI 密钥。");
        error.code = "CLOUD_AUTH";
        reject(error);
        return;
      }
      if (res.statusCode === 429) {
        const error = new Error("请求过于频繁，请稍后重试。免费模型有速率限制。");
        error.code = "CLOUD_RATE";
        reject(error);
        return;
      }
      if (res.statusCode !== 200) {
        let bodyText = "";
        res.on("data", (chunk) => { bodyText += chunk; });
        res.on("end", () => {
          const error = new Error(`云端 AI 返回错误 (${res.statusCode})：${bodyText.slice(0, 200)}`);
          error.code = "CLOUD_ERROR";
          reject(error);
        });
        return;
      }

      if (callbacks.onStatus) callbacks.onStatus("connected");

      if (cancelled) {
        resolve({ text: "", cancelled: true });
        return;
      }

      let fullText = "";
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            if (delta) {
              fullText += delta;
              if (callbacks.onDelta) callbacks.onDelta(delta);
            }
          } catch {}
        }
      });

      res.on("end", () => {
        // 处理剩余 buffer
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data:")) {
            const data = trimmed.slice(5).trim();
            if (data !== "[DONE]") {
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content || "";
                if (delta) fullText += delta;
              } catch {}
            }
          }
        }
        if (callbacks.onLog) callbacks.onLog("cloud_chat_success", { textLength: fullText.length });
        resolve({ text: fullText });
      });

      res.on("error", (error) => {
        reject(new Error(`云端 AI 响应中断：${error.message}`));
      });
    });

    req.on("error", (error) => {
      const friendly = friendlyError(error);
      reject(friendly);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("云端 AI 连接超时，请检查网络或更换 API 地址。"));
    });

    req.setTimeout(120000); // 2 分钟超时
    req.write(JSON.stringify(body));
    req.end();
  });
  promise.cancel = () => { cancelled = true; req.destroy(); };
  return promise;
}

/** 友好错误提示 */
function friendlyError(error) {
  const msg = error.message || "";
  if (error.code === "ENOTFOUND" || /getaddrinfo/.test(msg)) return Object.assign(new Error("云端 AI 服务器地址解析失败，请检查 API 地址设置。"), { code: "CLOUD_DNS" });
  if (error.code === "ECONNREFUSED") return Object.assign(new Error("云端 AI 服务器拒绝连接。"), { code: "CLOUD_REFUSED" });
  if (error.code === "ETIMEDOUT" || /timeout/i.test(msg)) return Object.assign(new Error("云端 AI 连接超时，请检查网络。"), { code: "CLOUD_TIMEOUT" });
  if (error.code === "CLOUD_AUTH" || error.code === "CLOUD_RATE" || error.code === "CLOUD_ERROR") return error;
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