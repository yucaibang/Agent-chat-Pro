"use strict";

const { assertCallbacks } = require("./contract.cjs");
const local = require("../../../../local.cjs");
const remote = require("../../../../ssh.cjs");

/**
 * Claude 适配器门面 — 统一 local 和 remote 两种运行模式。
 *
 * createClaudeAdapter() 返回冻结的安全接口对象，
 * 调用 start() 时统一校验回调白名单，再根据 connectionMode 选择 local/remote。
 */

function createClaudeAdapter({ localRunner = local, remoteRunner = remote } = {}) {
  function start(config, message, sessionId, attachments, callbacks) {
    assertCallbacks(callbacks);
    if (config.connectionMode === "local") {
      return localRunner.runLocalClaude(config, message, sessionId, attachments, callbacks);
    }
    return remoteRunner.runClaude(config, message, sessionId, attachments, callbacks);
  }

  function verifyLocal(config) {
    return localRunner.verifyLocalConnection(config);
  }

  function verifyRemote(config, trustHostFn, onLog) {
    return remoteRunner.verifyConnection(config, trustHostFn, onLog);
  }

  return Object.freeze({
    id: "claude-code",
    start,
    verifyLocal,
    verifyRemote,
    bridge: Object.freeze({
      status: () => remoteRunner.getBridgeStatus?.() || null,
      install: (config, onLog) => remoteRunner.installBridge?.(config, onLog) || Promise.resolve(null),
      uninstall: (config, onLog) => remoteRunner.uninstallBridge?.(config, onLog) || Promise.resolve(null)
    })
  });
}

module.exports = { createClaudeAdapter };