"use strict";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildClaudeArgs(config, prompt, sessionId, includePrompt = true) {
  const args = ["-p"];
  if (includePrompt) args.push(prompt);
  args.push(
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose"
  );

  if (sessionId) args.push("--resume", sessionId);
  // SSH 直连无法交互确认权限，统一使用 bypassPermissions
  args.push("--allow-dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
  return args;
}

function buildClaudeCommand(config, prompt, sessionId) {
  const wakeName = String(config.wakeName || "").trim();
  if (!wakeName) throw new Error("请填写 Claude 唤醒命令。");
  const args = [wakeName, ...buildClaudeArgs(config, prompt, sessionId)];
  const command = args.map(shellQuote).join(" ");
  const workingDirectory = String(config.workingDirectory || "").trim();
  return workingDirectory
    ? `cd -- ${shellQuote(workingDirectory)} && exec ${command}`
    : `exec ${command}`;
}

class JsonLineParser {
  constructor() {
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    return lines.filter(Boolean).map(parseLine);
  }

  finish() {
    if (!this.buffer.trim()) return [];
    const result = [parseLine(this.buffer)];
    this.buffer = "";
    return result;
  }
}

function parseLine(line) {
  try {
    return { value: JSON.parse(line) };
  } catch {
    return { raw: line };
  }
}

function textFromEvent(payload) {
  if (!payload) return "";

  // 格式1: stream_json 标准格式（Claude CLI 输出）
  const delta = payload.event?.delta;
  if (payload.type === "stream_event" && delta?.type === "text_delta") {
    return delta.text || "";
  }

  // 格式2: content_block_delta 直出格式
  if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") {
    return payload.delta.text || "";
  }

  return "";
}

function sessionFromEvent(payload) {
  return payload?.session_id || payload?.event?.session_id || "";
}

function usageFromEvent(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (payload.type === "usage") {
    return {
      inputTokens: Number(payload.inputTokens || payload.input_tokens || 0),
      outputTokens: Number(payload.outputTokens || payload.output_tokens || 0),
      cacheCreationInputTokens: Number(payload.cacheCreationInputTokens || payload.cache_creation_input_tokens || 0),
      cacheReadInputTokens: Number(payload.cacheReadInputTokens || payload.cache_read_input_tokens || 0)
    };
  }
  // Agent SDK bridge sends usage in result event
  if (payload.type === "result" && payload.usage && typeof payload.usage === "object") {
    return {
      inputTokens: Number(payload.usage.inputTokens || payload.usage.input_tokens || 0),
      outputTokens: Number(payload.usage.outputTokens || payload.usage.output_tokens || 0),
      cacheCreationInputTokens: Number(payload.usage.cacheCreationInputTokens || payload.usage.cache_creation_input_tokens || 0),
      cacheReadInputTokens: Number(payload.usage.cacheReadInputTokens || payload.usage.cache_read_input_tokens || 0)
    };
  }
  return undefined;
}

module.exports = {
  JsonLineParser,
  buildClaudeArgs,
  buildClaudeCommand,
  sessionFromEvent,
  shellQuote,
  textFromEvent,
  usageFromEvent
};