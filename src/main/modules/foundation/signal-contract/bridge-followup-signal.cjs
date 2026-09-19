"use strict";
const { createSignalContractRegistry, createSignalGate } = require("./signal-contract.cjs");
const schema = { type: "object", additionalProperties: false, required: ["requestId", "conversationId"], properties: { requestId: { type: "string", minLength: 1 }, conversationId: { type: "string", minLength: 1 } } };
function createBridgeFollowUpSignal({ requestId, conversationId, writeLog = () => {} }) {
  const registry = createSignalContractRegistry();
  registry.register({ moduleId: "conversation.turn-orchestrator", operation: "follow-up", version: 1, maySkip: true, inputs: [{ name: "follow-up-request", schema }], outputs: [{ name: "bridge-handoff", schema }] });
  registry.register({ moduleId: "agent.claude.bridge", operation: "follow-up", version: 1, maySkip: true, inputs: [{ name: "bridge-handoff", schema }], outputs: [{ name: "bridge-ack", schema }] });
  const value = { requestId: String(requestId), conversationId: String(conversationId) }; const a = `${value.requestId}:followup:conversation`; const b = `${value.requestId}:followup:bridge`;
  const gate = createSignalGate({ registry, onTransition: (item) => writeLog("signal_contract_result", { requestId: value.requestId, moduleId: item.moduleId, operation: item.operation, light: item.light, phase: item.phase, startedAt: item.startedAt, completedAt: item.completedAt, elapsedMs: item.elapsedMs, errorCode: item.error?.code || "" }) });
  let conversationFinished = false; let bridgeStarted = false;
  function finishConversation() { if (!conversationFinished) { gate.finish(a); conversationFinished = true; } return gate.result(a); }
  function startBridge() { if (!bridgeStarted) { gate.begin({ requestId: b, moduleId: "agent.claude.bridge", operation: "follow-up" }); bridgeStarted = true; } return gate.result(b); }
  return Object.freeze({ conversationSent() { gate.begin({ requestId: a, moduleId: "conversation.turn-orchestrator", operation: "follow-up" }); gate.receive(a, "follow-up-request", value); return gate.emit(a, "bridge-handoff", value); }, bridgeReceived() { startBridge(); const result = gate.receive(b, "bridge-handoff", value); finishConversation(); return result; }, bridgeAcknowledged(accepted) { let result = accepted ? gate.emit(b, "bridge-ack", value) : gate.fail(b, "AO.CONTRACT.BRIDGE_FOLLOWUP_REJECTED", {}); if (accepted) result = gate.finish(b); return result; }, unavailable() { finishConversation(); startBridge(); return gate.fail(b, "AO.CONTRACT.BRIDGE_FOLLOWUP_UNAVAILABLE", {}); }, cancelled(reason = "cancelled") { return bridgeStarted ? gate.cancel(b, reason) : gate.cancel(a, reason); } });
}
module.exports = { createBridgeFollowUpSignal };
