"use strict";

/**
 * 对话传输选择器 — 根据 connectionMode 选择 local 或 remote 执行器。
 * 轻量级策略模式，解耦 turn-orchestrator 和具体运行器。
 */

function createConversationTransport({ startLocal, startRemote }) {
  if (typeof startLocal !== "function") throw new Error("startLocal 必须是函数。");
  if (typeof startRemote !== "function") throw new Error("startRemote 必须是函数。");

  function start(config, message, sessionId, attachments, callbacks) {
    if (config.connectionMode === "local") {
      return startLocal(config, message, sessionId, attachments, callbacks);
    }
    return startRemote(config, message, sessionId, attachments, callbacks);
  }

  return Object.freeze({ start });
}

module.exports = { createConversationTransport };