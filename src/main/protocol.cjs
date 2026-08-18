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
  if (config.skipPermissions) {
    args.push(
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions"
    );
  } else {
    args.push("--permission-mode", "dontAsk");
  }
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
  const delta = payload?.event?.delta;
  if (payload?.type === "stream_event" && delta?.type === "text_delta") {
    return delta.text || "";
  }
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
