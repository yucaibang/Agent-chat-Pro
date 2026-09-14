"use strict";

/**
 * Bridge 后续对话信号 — 异步 follow-up 流程的信号追踪。
 *
 * 两个阶段：
 *   conversation.turn-orchestrator:follow-up → agent.claude.bridge:follow-up
 *
 * 支持 maySkip：如果 Bridge 不可用或不可接受，可跳过。
 */

const { createSignalContractRegistry } = require("./signal-contract.cjs");

function createBridgeFollowupSignal(options = {}) {
  const { enabled = true, onLog } = options;
  if (!enabled) {
    return Object.freeze({
      start: () => ({ receive: () => null, emit: () => null, finish: () => null, skip: () => null, snapshot: () => ({}) }),
      enabled: false
    });
  }

  const registry = createSignalContractRegistry();

  registry.register({
    moduleId: "conversation",
    operation: "follow-up",
    version: 1,
    maySkip: true,
    inputs: [{ name: "follow-up-request" }],
    outputs: [{ name: "follow-up-complete" }]
  });

  return Object.freeze({ registry, enabled: true });
}

module.exports = { createBridgeFollowupSignal };