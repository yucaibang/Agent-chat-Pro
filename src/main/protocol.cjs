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
  // 每条 assistant 消息自带 usage — 每轮 input 包含全部上下文，
  // 是上下文进度条最实时的数据源（result 只在 turn 结束时才有）
  if (payload.type === "assistant" && payload.message && typeof payload.message.usage === "object") {
    const u = payload.message.usage;
    return {
      inputTokens: Number(u.inputTokens || u.input_tokens || 0),
      outputTokens: Number(u.outputTokens || u.output_tokens || 0),
      cacheCreationInputTokens: Number(u.cacheCreationInputTokens || u.cache_creation_input_tokens || 0),
      cacheReadInputTokens: Number(u.cacheReadInputTokens || u.cache_read_input_tokens || 0)
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

/** 当前上下文占用 = input + cache 写入 + cache 读取（三者之和即本轮实际进入上下文的量） */
function contextTokensFromUsage(usage) {
  if (!usage || typeof usage !== "object") return 0;
  // 兼容驼峰（内部 usage 对象）与下划线（直传 API 原始 usage）两种字段风格
  const pick = (a, b) => Number(usage[a] ?? usage[b] ?? 0) || 0;
  return Math.max(
    0,
    pick("inputTokens", "input_tokens") +
    pick("cacheCreationInputTokens", "cache_creation_input_tokens") +
    pick("cacheReadInputTokens", "cache_read_input_tokens")
  );
}

/** 从 system/init 消息提取模型名（Claude Code 每轮开头都会发一次 init） */
function modelFromEvent(payload) {
  if (payload && payload.type === "system" && payload.subtype === "init" && payload.model) {
    return String(payload.model);
  }
  return undefined;
}

/**
 * 模型名 → 上下文窗口上限（tokens）。
 * 模型名可能带窗口标记后缀：[1m] → 1,000,000；[128k]/[200k] → 128,000/200,000；
 * 无标记的 Claude 模型默认 200,000。
 * 例："glm-5.3-flash:cloud[1m]" → 1e6；"deepseek-chat[128k]" → 128000；"claude-sonnet-4-5" → 200000
 */
function contextLimitFromModel(model) {
  const name = String(model || "");
  const bracket = name.match(/\[([^\]]*)\]\s*$/);
  if (bracket) {
    const tag = bracket[1].toLowerCase();
    const multipliers = { k: 1_000, m: 1_000_000 };
    const parsed = tag.match(/^(\d+(?:\.\d+)?)([km])$/);
    if (parsed) {
      const value = Number(parsed[1]) * multipliers[parsed[2]];
      if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
    if (tag === "1m") return 1_000_000;
  }
  return 200_000;
}

/**
 * 从 stream-json 事件提取压缩事件（手动 /compact 与 CLI 自动压缩都会触发）。
 * 压缩开始：system/status status="compacting" → { phase: "started" }
 * 压缩结束：system/status compact_result="success"|"failed" → { phase: "finished", success, error }
 * 压缩边界：system/compact_boundary（官方带 pre_tokens/post_tokens/trigger/duration_ms）
 *   → { phase: "boundary", preTokens, postTokens, trigger, durationMs }
 */
function compactEventFromEvent(payload) {
  if (!payload || payload.type !== "system") return undefined;
  if (payload.subtype === "status" && payload.status === "compacting") {
    return { phase: "started" };
  }
  if (payload.subtype === "status" && payload.compact_result) {
    return {
      phase: "finished",
      success: payload.compact_result === "success",
      error: payload.compact_error ? String(payload.compact_error) : ""
    };
  }
  if (payload.subtype === "compact_boundary" && payload.compact_metadata) {
    const meta = payload.compact_metadata;
    return {
      phase: "boundary",
      preTokens: Number(meta.pre_tokens) || undefined,
      postTokens: Number(meta.post_tokens) || undefined,
      trigger: meta.trigger === "auto" ? "auto" : "manual",
      durationMs: Number(meta.duration_ms) || undefined
    };
  }
  return undefined;
}

module.exports = {
  JsonLineParser,
  buildClaudeArgs,
  buildClaudeCommand,
  compactEventFromEvent,
  contextLimitFromModel,
  contextTokensFromUsage,
  modelFromEvent,
  sessionFromEvent,
  shellQuote,
  textFromEvent,
  usageFromEvent
};