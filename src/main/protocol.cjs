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
  // { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } } }
  const delta = payload.event?.delta;
  if (payload.type === "stream_event" && delta?.type === "text_delta") {
    return delta.text || "";
  }

  // 格式2: content_block_delta 直出格式（部分 CLI 版本）
  // { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
  if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta") {
    return payload.delta.text || "";
  }

  // 格式3: assistant 完整消息中的文本内容
  // { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
  // 注意：仅提取增量，完整消息由 result 事件兜底
  if (payload.type === "assistant" && Array.isArray(payload.message?.content)) {
    // assistant 事件包含完整消息，只在尚未有文本时使用（避免重复）
    // 实际文本增量由上面的 delta 格式处理，这里仅作兜底
  }

  // 格式4: result 事件中的文本
  // { type: "result", result: "..." }
  // 由 handleEvents 中的 result 分支单独处理

  return "";
}

function sessionFromEvent(payload) {
  return payload?.session_id || payload?.event?.session_id || "";
}

module.exports = {
  JsonLineParser,
  buildClaudeArgs,
  buildClaudeCommand,
  sessionFromEvent,
  shellQuote,
  textFromEvent
};
