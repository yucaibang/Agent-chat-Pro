"use strict";

/**
 * Qwen Code 适配器（SSH 远程 CLI，v3.19.0 F3）
 *
 * 远端命令：`qwen -p "..." --output-format stream-json --include-partial-messages`
 *   续聊：`--continue`（自动最近会话；session 归属由 qwen 本地 CLI 自理，ACP 只透传）
 *   模型：-m（settings 里配则带）
 * 事件流与 Claude Code CLI 同构（system init / assistant / stream_event / result），
 * 直接复用 protocol.cjs 的解析函数——textFromEvent / usageFromEvent / sessionFromEvent。
 *
 * 安装（用户手动，NAS 侧）：`npm install -g @qwen-code/qwen-code`（Node 18+）
 * 风险注记：qwen headless 对工具调用的行为需真机验证（QwenLM/qwen-code issue #874）
 */

const {
  textFromEvent,
  usageFromEvent,
  sessionFromEvent,
  shellQuote
} = require("../protocol.cjs");
const { runRemoteCli, cliCommand } = require("./ssh-cli-base.cjs");

const INSTALL_HINT = "在 NAS 上执行：npm install -g @qwen-code/qwen-code";

function parseQwenLine(line, state, lineCallbacks) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== "object") return;

  // 部分增量（--include-partial-messages）：stream_event.content_block_delta.text_delta
  if (event.type === "stream_event") {
    const delta = event.event?.delta;
    if ((event.event?.type === "content_block_delta" || delta?.type === "text_delta") && delta?.text) {
      lineCallbacks.onDelta(delta.text);
    }
    return;
  }

  if (event.type === "assistant") {
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && part.text) {
          lineCallbacks.onDelta(part.text);
        } else if (part?.type === "tool_use") {
          lineCallbacks.onToolEvent({
            id: part.id || "",
            name: part.name || "unknown",
            status: "running",
            input: part.input || {}
          });
        }
      }
    }
    const usage = usageFromEvent(event);
    if (usage) lineCallbacks.onUsage(usage);
    const session = sessionFromEvent(event);
    if (session) state.sessionId = session;
    return;
  }

  if (event.type === "result") {
    if (event.result && !state.text) lineCallbacks.onDelta(event.result);
    const usage = usageFromEvent(event);
    if (usage) lineCallbacks.onUsage(usage);
    const session = sessionFromEvent(event);
    if (session) state.sessionId = session;
    if (event.is_error) state.error = textFromEvent(event) || "qwen 报告执行失败。";
    state.done = true;
    return;
  }

  if (event.type === "system" && event.subtype === "init") {
    const session = sessionFromEvent(event);
    if (session) state.sessionId = session;
  }
}

async function verifyQwenConnection(config, onUnknownHost, onLog) {
  const operation = runRemoteCli(config, "echo ok", "", [], {}, {
    adapterName: "Qwen Code",
    cliName: "qwen",
    installHint: INSTALL_HINT,
    buildCommand: (cliPath) => cliCommand([shellQuote(cliPath), "--version"]),
    handleLine: () => {}
  });
  await operation.promise;
  return { ok: true };
}

function runQwenCli(config, message, sessionId, attachments = [], callbacks = {}) {
  const model = String(config.remoteAdapterModel || "").trim();
  const continueFlag = sessionId ? "--continue" : "";
  return runRemoteCli(config, message, sessionId, attachments, callbacks, {
    adapterName: "Qwen Code",
    cliName: "qwen",
    installHint: INSTALL_HINT,
    buildCommand: (cliPath, existingSession, text) => cliCommand([
      shellQuote(cliPath),
      "-p", shellQuote(text),
      "--output-format", "stream-json",
      "--include-partial-messages",
      continueFlag,
      model ? `-m ${shellQuote(model)}` : ""
    ]),
    handleLine: parseQwenLine
  });
}

module.exports = { runQwenCli, verifyQwenConnection, parseQwenLine };