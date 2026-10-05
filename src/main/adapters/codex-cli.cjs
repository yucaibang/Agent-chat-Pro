"use strict";

/**
 * Codex 适配器（SSH 远程 CLI，v3.19.0 F3）
 *
 * 远端命令：`codex exec "..." --json`（JSONL：每次状态变更一行）
 *   续聊：`codex exec resume --last`（--last = 自动最近会话）
 *   沙箱：--sandbox workspace-write|read-only（默认 workspace-write）
 * 事件面（非 TTY JSON 输出）：thread/session 概念以行内 id 为准；文本增量在
 *   agent_message / agent_message_delta 类行；错误行 error → 拦截。
 *   ⚠️ 实锤风险：codex 非 TTY 稳定性随版本波动（issue #4219/#11750），
 *   事件 schema 以真机实测为准——解析器对未知行宽容跳过（记 debug 日志）。
 *
 * 安装（用户手动，NAS 侧）：npm 官方安装脚本或 `npm install -g @openai/codex`
 */

const { shellQuote } = require("../protocol.cjs");
const { runRemoteCli, cliCommand } = require("./ssh-cli-base.cjs");

const INSTALL_HINT = "在 NAS 上执行：npm install -g @openai/codex（或官方安装脚本）";

function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return "";
}

function parseCodexLine(line, state, lineCallbacks) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== "object") return;

  const type = String(event.type || event.msg?.type || "");
  const id = event.thread_id || event.session_id || event.conversation_id || "";
  if (id && !state.sessionId) state.sessionId = String(id);

  switch (type) {
    case "thread.started":
    case "session_configured":
    case "thread.resumed": {
      const sid = event.thread_id || event.thread?.id || "";
      if (sid) state.sessionId = String(sid);
      return;
    }
    case "agent_message_delta":
    case "item.updated": {
      const text = extractText(event.delta ?? event.msg?.delta ?? event.item?.text);
      if (text) {
        state.sawDelta = true; // 完整消息防重标记：出现过增量后不再回放 agent_message 全文
        lineCallbacks.onDelta(text);
      }
      return;
    }
    case "agent_message":
    case "item.completed": {
      const payload = event.item || event.msg || event;
      const text = extractText(payload.text ?? payload.content ?? payload.message);
      // 完整消息只在没有任何增量时直通（避免与 delta 重复累计）
      if (text && !state.sawDelta) lineCallbacks.onDelta(text);
      if (event.item?.item_type === "function_call" || payload.command) {
        lineCallbacks.onToolEvent({
          id: payload.id || "",
          name: payload.item_type === "function_call" ? String(payload.name || "command") : "command",
          status: "completed",
          input: payload.input || {}
        });
      }
      return;
    }
    case "error":
      state.error = extractText(event.message ?? event.msg?.message ?? payload_text(event)) || "codex 报告执行失败。";
      return;
    default: {
      // mcp_tool_call_begin / turn.completed / token.count 类：宽容跳过，用量字段尽量提
      if (event.usage || event.msg?.usage) lineCallbacks.onUsage(event.usage || event.msg.usage);
    }
  }
}

function payload_text() { return ""; }

async function verifyCodexConnection(config, onUnknownHost, onLog) {
  const operation = runRemoteCli(config, "", "", [], {}, {
    adapterName: "Codex",
    cliName: "codex",
    installHint: INSTALL_HINT,
    buildCommand: (cliPath) => cliCommand([shellQuote(cliPath), "--version"]),
    handleLine: () => {}
  });
  await operation.promise;
  return { ok: true };
}

function runCodexCli(config, message, sessionId, attachments = [], callbacks = {}) {
  const model = String(config.remoteAdapterModel || "").trim();
  const sandbox = String(config.remoteAdapterSandbox || "").trim() === "read-only" ? "read-only" : "workspace-write";
  // codex exec resume --last：续最近会话（会话 id 语义由 codex CLI 自理）
  const resume = sessionId ? ["exec", "resume", "--last"] : ["exec"];
  return runRemoteCli(config, message, sessionId, attachments, callbacks, {
    adapterName: "Codex",
    cliName: "codex",
    installHint: INSTALL_HINT,
    buildCommand: (cliPath, existingSession, text) => cliCommand([
      shellQuote(cliPath),
      ...resume,
      shellQuote(text),
      "--json",
      "--sandbox", sandbox,
      model ? `-m ${shellQuote(model)}` : ""
    ]),
    handleLine: parseCodexLine
  });
}

module.exports = { runCodexCli, verifyCodexConnection, parseCodexLine };