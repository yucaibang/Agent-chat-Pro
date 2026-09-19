"use strict";

const { LIGHTS, createSignalContractRegistry, createSignalGate } = require("./signal-contract.cjs");

const baseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "conversationId", "connectionMode", "attachmentCount", "hasSession", "runner"],
  properties: {
    requestId: { type: "string", minLength: 1 },
    conversationId: { type: "string", minLength: 1 },
    connectionMode: { enum: ["local", "ssh", "cloud"] },
    attachmentCount: { type: "integer", minimum: 0 },
    hasSession: { type: "boolean" },
    runner: { enum: ["local-runner", "remote-runner", "cloud-direct"] }
  }
};
const operationSchema = {
  ...baseSchema,
  required: [...baseSchema.required, "operation"],
  properties: { ...baseSchema.properties, operation: { const: "started" } }
};
const returnedFileSchema = { ...baseSchema, required: [...baseSchema.required, "fileCount"], properties: { ...baseSchema.properties, fileCount: { type: "integer", minimum: 0 } } };
const artifactActionSchema = {
  type: "object", additionalProperties: false,
  required: ["requestId", "action", "source"],
  properties: {
    requestId: { type: "string", minLength: 1 },
    action: { enum: ["preview", "save", "open"] },
    source: { enum: ["local", "ssh", "cloud"] }
  }
};
const artifactActions = ["preview", "save", "open"];
const toolPermissionSchema = {
  type: "object", additionalProperties: false,
  required: ["requestId", "action", "connectionMode", "automatic"],
  properties: {
    requestId: { type: "string", minLength: 1 },
    action: { const: "set-automatic-mode" },
    connectionMode: { enum: ["local", "ssh", "cloud"] },
    automatic: { type: "boolean" }
  }
};
const settingsSaveSchema = {
  type: "object", additionalProperties: false,
  required: ["requestId", "action", "connectionMode", "directoryChanged"],
  properties: {
    requestId: { type: "string", minLength: 1 },
    action: { const: "save-settings" },
    connectionMode: { enum: ["local", "ssh", "cloud"] },
    directoryChanged: { type: "boolean" }
  }
};
const modelUpdateSchema = {
  type: "object", additionalProperties: false,
  required: ["requestId", "action", "connectionMode"],
  properties: { requestId: { type: "string", minLength: 1 }, action: { const: "update-model" }, connectionMode: { enum: ["local", "ssh", "cloud"] } }
};
const deviceActionSchema = {
  type: "object", additionalProperties: false,
  required: ["requestId", "action"],
  properties: { requestId: { type: "string", minLength: 1 }, action: { enum: ["install", "uninstall"] } }
};
const bridgeActionSchema = {
  type: "object", additionalProperties: false,
  required: ["requestId", "action"],
  properties: { requestId: { type: "string", minLength: 1 }, action: { enum: ["install", "uninstall"] } }
};
const conversationManagementSchema = {
  type: "object", additionalProperties: false,
  required: ["requestId", "action"],
  properties: { requestId: { type: "string", minLength: 1 }, action: { enum: ["create", "rename", "set-pinned", "clear-session", "delete"] } }
};
const conversationManagementActions = ["create", "rename", "set-pinned", "clear-session", "delete"];
// Agent Chat Pro 扩展：云端 AI 模式（Orbit 原版仅 local/ssh）
function normalizeConnectionMode(value) { return value === "local" || value === "cloud" ? value : "ssh"; }
function normalizeRunner(value) { return value === "cloud" ? "cloud-direct" : value === "local" ? "local-runner" : "remote-runner"; }
const stages = [
  ["conversation.turn-orchestrator", "submit", "turn-input", "transport-handoff"],
  ["conversation.transport", "start", "transport-handoff", "adapter-handoff"],
  ["agent.claude.adapter", "start", "adapter-handoff", "runner-handoff"],
  ["agent.claude.runner", "run", "runner-handoff", "runner-operation"]
];

function createConversationClaudeSignalMonitor({ writeLog = () => {}, onTransition = () => {}, onRoundComplete = () => {}, enabled = true, now } = {}) {
  const registry = createSignalContractRegistry();
  for (const [moduleId, operation, input, output] of stages) {
    registry.register({ moduleId, operation, version: 1, inputs: [{ name: input, schema: baseSchema }], outputs: [{ name: output, schema: output === "runner-operation" ? operationSchema : baseSchema }] });
  }
  registry.register({ moduleId: "foundation.signal-light-strip", operation: "complete-round", version: 2, inputs: [{ name: "round-terminal", schema: baseSchema }], outputs: [{ name: "light-projection", schema: baseSchema }] });
  registry.register({ moduleId: "agent.claude.remote-runner", operation: "dispatch-attachments", version: 1, maySkip: true, inputs: [{ name: "attachment-batch", schema: baseSchema }], outputs: [{ name: "attachment-uploader-handoff", schema: baseSchema }] });
  registry.register({ moduleId: "agent.claude.remote-attachment-uploader", operation: "start-transfer", version: 1, maySkip: true, inputs: [{ name: "attachment-uploader-handoff", schema: baseSchema }], outputs: [{ name: "attachment-transfer-started", schema: baseSchema }] });
  registry.register({ moduleId: "agent.claude.remote-runner", operation: "publish-returned-files", version: 1, maySkip: true, inputs: [{ name: "discovered-artifacts", schema: returnedFileSchema }], outputs: [{ name: "conversation-artifacts-handoff", schema: returnedFileSchema }] });
  registry.register({ moduleId: "conversation.artifacts", operation: "publish-returned-files", version: 1, maySkip: true, inputs: [{ name: "conversation-artifacts-handoff", schema: returnedFileSchema }], outputs: [{ name: "assistant-message-artifacts", schema: returnedFileSchema }] });
  for (const action of artifactActions) {
    registry.register({ moduleId: "conversation.artifacts", operation: `${action}-request`, version: 1, inputs: [{ name: "artifact-action", schema: artifactActionSchema }], outputs: [{ name: "remote-artifact-request", schema: artifactActionSchema }] });
    registry.register({ moduleId: "conversation.artifacts", operation: `${action}-complete`, version: 1, inputs: [{ name: "remote-artifact-complete", schema: artifactActionSchema }], outputs: [{ name: "artifact-action-complete", schema: artifactActionSchema }] });
    registry.register({ moduleId: "conversation.artifacts", operation: `${action}-local`, version: 1, maySkip: true, inputs: [{ name: "artifact-action", schema: artifactActionSchema }], outputs: [{ name: "artifact-action-complete", schema: artifactActionSchema }] });
  }
  registry.register({ moduleId: "agent.claude.remote-runner", operation: "read-artifact", version: 1, inputs: [{ name: "remote-artifact-request", schema: artifactActionSchema }], outputs: [{ name: "remote-artifact-complete", schema: artifactActionSchema }] });
  registry.register({ moduleId: "agent.claude.remote-runner", operation: "download-artifact", version: 1, inputs: [{ name: "remote-artifact-request", schema: artifactActionSchema }], outputs: [{ name: "remote-artifact-complete", schema: artifactActionSchema }] });
  registry.register({ moduleId: "foundation.permissions", operation: "set-automatic-mode", version: 1, maySkip: true, inputs: [{ name: "tool-mode-request", schema: toolPermissionSchema }], outputs: [{ name: "settings-write-request", schema: toolPermissionSchema }] });
  registry.register({ moduleId: "foundation.settings", operation: "save-tool-mode", version: 1, inputs: [{ name: "settings-write-request", schema: toolPermissionSchema }], outputs: [{ name: "settings-write-complete", schema: toolPermissionSchema }] });
  registry.register({ moduleId: "foundation.settings", operation: "preflight-save", version: 1, inputs: [{ name: "settings-save-input", schema: settingsSaveSchema }], outputs: [{ name: "directory-prepare-request", schema: settingsSaveSchema }] });
  registry.register({ moduleId: "conversation.storage", operation: "prepare-settings-directory", version: 1, inputs: [{ name: "directory-prepare-request", schema: settingsSaveSchema }], outputs: [{ name: "settings-persist-request", schema: settingsSaveSchema }] });
  registry.register({ moduleId: "foundation.settings", operation: "persist-save", version: 1, inputs: [{ name: "settings-persist-request", schema: settingsSaveSchema }], outputs: [{ name: "archive-ensure-request", schema: settingsSaveSchema }] });
  registry.register({ moduleId: "conversation.storage", operation: "ensure-settings-archives", version: 1, inputs: [{ name: "archive-ensure-request", schema: settingsSaveSchema }], outputs: [{ name: "settings-save-complete", schema: settingsSaveSchema }] });
  registry.register({ moduleId: "foundation.model-control", operation: "request-update", version: 1, maySkip: true, inputs: [{ name: "model-update-request", schema: modelUpdateSchema }], outputs: [{ name: "model-adapter-request", schema: modelUpdateSchema }] });
  registry.register({ moduleId: "agent.claude.model-adapter", operation: "update-model", version: 1, inputs: [{ name: "model-adapter-request", schema: modelUpdateSchema }], outputs: [{ name: "model-update-complete", schema: modelUpdateSchema }] });
  for (const [moduleId, operation] of [["foundation.device-control", "request-install"], ["agent.device-registry", "register-install"], ["foundation.device-control", "install-windows"], ["agent.device-registry", "probe-install"], ["foundation.device-control", "request-uninstall"], ["foundation.device-control", "uninstall-windows"], ["agent.device-registry", "disable-uninstall"]]) {
    registry.register({ moduleId, operation, version: 1, maySkip: operation.startsWith("request-") || operation === "disable-uninstall", inputs: [{ name: operation.startsWith("request-") ? "device-action-request" : "device-action-handoff", schema: deviceActionSchema }], outputs: [{ name: operation === "probe-install" || operation === "disable-uninstall" ? "device-action-complete" : "device-action-handoff", schema: deviceActionSchema }] });
  }
  for (const action of ["install", "uninstall"]) {
    registry.register({ moduleId: "foundation.bridge-control", operation: `request-${action}`, version: 1, maySkip: true, inputs: [{ name: "bridge-action-request", schema: bridgeActionSchema }], outputs: [{ name: "bridge-adapter-request", schema: bridgeActionSchema }] });
    registry.register({ moduleId: "agent.claude.bridge", operation: action, version: 1, inputs: [{ name: "bridge-adapter-request", schema: bridgeActionSchema }], outputs: [{ name: "bridge-action-complete", schema: bridgeActionSchema }] });
  }
  for (const action of conversationManagementActions) {
    registry.register({ moduleId: "foundation.conversation-control", operation: `request-${action}`, version: 1, inputs: [{ name: "conversation-management-request", schema: conversationManagementSchema }], outputs: [{ name: "conversation-service-request", schema: conversationManagementSchema }] });
    registry.register({ moduleId: "conversation.conversations", operation: action, version: 1, inputs: [{ name: "conversation-service-request", schema: conversationManagementSchema }], outputs: [{ name: "conversation-management-complete", schema: conversationManagementSchema }] });
  }
  const gate = createSignalGate({
    registry,
    enabled,
    now,
    onTransition: (item) => { writeLog("signal_contract_result", { requestId: item.requestId.split(":")[0], moduleId: item.moduleId, operation: item.operation, light: item.light, phase: item.phase, startedAt: item.startedAt, completedAt: item.completedAt, elapsedMs: item.elapsedMs, errorCode: item.error?.code || "" }); onTransition(item); }
  });
  return Object.freeze({ createRequest(input) { return request(gate, input, enabled, onRoundComplete); }, createArtifactAction(input) { return createArtifactActionFlow(gate, input, enabled); }, createToolPermission(input) { return createToolPermissionFlow(gate, input, enabled); }, createSettingsSave(input) { return createSettingsSaveFlow(gate, input, enabled); }, createModelUpdate(input) { return createModelUpdateFlow(gate, input, enabled); }, createDeviceAction(input) { return createDeviceActionFlow(gate, input, enabled); }, createBridgeAction(input) { return createBridgeActionFlow(gate, input, enabled); }, createConversationManagement(input) { return createConversationManagementFlow(gate, input, enabled); } });
}

function request(gate, input, enabled, onRoundComplete = () => {}) {
  const base = Object.freeze({ requestId: String(input.requestId || ""), conversationId: String(input.conversationId || ""), connectionMode: normalizeConnectionMode(input.connectionMode), attachmentCount: Number(input.attachmentCount || 0), hasSession: Boolean(input.hasSession), runner: normalizeRunner(input.connectionMode) });
  const ids = stages.map(([moduleId, operation]) => `${base.requestId}:${moduleId}:${operation}`);
  const lightStripId = `${base.requestId}:foundation.signal-light-strip:complete-round`;
  let pending = null;
  let returnedFiles;
  const opened = new Set();
  const info = (actual = {}) => ({ ...base, conversationId: String(actual.conversationId ?? base.conversationId), connectionMode: actual.connectionMode ?? base.connectionMode, attachmentCount: Number(actual.attachmentCount ?? base.attachmentCount), hasSession: Boolean(actual.hasSession ?? base.hasSession), runner: actual.runner ?? base.runner });
  const open = (index) => { if (!opened.has(ids[index])) { gate.begin({ requestId: ids[index], moduleId: stages[index][0], operation: stages[index][1] }); opened.add(ids[index]); } };
  const results = () => [...ids, lightStripId].filter((id) => opened.has(id)).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  const receive = (index, signal, actual) => {
    const value = info(actual); open(index); const result = gate.receive(ids[index], signal, value);
    if (result.light === LIGHTS.RED || JSON.stringify(value) !== JSON.stringify(pending)) return gate.fail(ids[index], "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "previous-handoff", actual: "receiver-payload" });
    gate.finish(ids[index - 1]); return result;
  };
  const emit = (index, signal, actual) => { const value = info(actual); pending = value; return gate.emit(ids[index], signal, value); };
  if (!enabled) return disabledChain();
  return Object.freeze({
    turnReceived: () => { open(0); return gate.receive(ids[0], "turn-input", base); },
    turnToTransport: (actual) => emit(0, "transport-handoff", actual), transportReceived: (actual) => receive(1, "transport-handoff", actual), transportToAdapter: (actual) => emit(1, "adapter-handoff", actual), adapterReceived: (actual) => receive(2, "adapter-handoff", actual), adapterToRunner: (actual) => emit(2, "runner-handoff", actual), runnerReceived: (actual) => receive(3, "runner-handoff", actual),
    runnerOperation(operation) {
      gate.emit(ids[3], "runner-operation", { ...base, operation: "started" });
      if (operation?.promise && typeof operation.promise.then === "function") operation.promise.then(
        () => gate.finish(ids[3]),
        (error) => error?.cancelled
          ? gate.cancel(ids[3], "request-cancelled")
          : gate.fail(ids[3], "AO.CONTRACT.RUNNER_FAILED", { message: String(error?.message || error || "runner-failed") })
      );
      else gate.finish(ids[3]);
      return operation;
    },
    attachmentUpload: () => createAttachmentUploadFlow(gate, base), returnedFiles: () => returnedFiles ||= createReturnedFileFlow(gate, base),
    complete(actual) {
      const value = info(actual); gate.begin({ requestId: lightStripId, moduleId: "foundation.signal-light-strip", operation: "complete-round" }); opened.add(lightStripId);
      const received = gate.receive(lightStripId, "round-terminal", value);
      if (received.light === LIGHTS.RED || JSON.stringify(value) !== JSON.stringify(base)) return gate.fail(lightStripId, "AO.CONTRACT.LIGHT_STRIP_TERMINAL_MISMATCH", { expected: "request-terminal", actual: "light-strip-terminal" });
      const emitted = gate.emit(lightStripId, "light-projection", value);
      if (emitted.light === LIGHTS.RED) return emitted;
      const completed = gate.finish(lightStripId); onRoundComplete(base.requestId); return completed;
    },
    failed(error) {
      const current = gate.result(ids[3]);
      if (current.phase === "failed") return current;
      return gate.fail(ids[3], "AO.CONTRACT.RUNNER_FAILED", { message: String(error?.message || error || "runner-failed") });
    },
    healthy, results
  });
}

function createAttachmentUploadFlow(gate, base) {
  const runnerId = `${base.requestId}:agent.claude.remote-runner:dispatch-attachments`;
  const uploaderId = `${base.requestId}:agent.claude.remote-attachment-uploader:start-transfer`;
  const skipReason = base.connectionMode !== "ssh" ? "not-remote-ssh" : base.attachmentCount === 0 ? "no-attachments" : "";
  const actual = (value = {}) => ({ ...base, conversationId: String(value.conversationId ?? base.conversationId), connectionMode: value.connectionMode ?? base.connectionMode, attachmentCount: Number(value.attachmentCount ?? base.attachmentCount), hasSession: Boolean(value.hasSession ?? base.hasSession), runner: value.runner ?? base.runner });
  let runnerOpened = false;
  let uploaderOpened = false;
  const results = () => [runnerOpened && runnerId, uploaderOpened && uploaderId].filter(Boolean).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  if (skipReason) {
    runnerOpened = true; gate.begin({ requestId: runnerId, moduleId: "agent.claude.remote-runner", operation: "dispatch-attachments" }); gate.skip(runnerId, skipReason);
    uploaderOpened = true; gate.begin({ requestId: uploaderId, moduleId: "agent.claude.remote-attachment-uploader", operation: "start-transfer" }); gate.skip(uploaderId, skipReason);
    return Object.freeze({ runnerReceived() {}, runnerToUploader() {}, uploaderReceived() {}, transferStarted() {}, healthy, results });
  }
  let dispatched;
  return Object.freeze({
    runnerReceived(value) { runnerOpened = true; gate.begin({ requestId: runnerId, moduleId: "agent.claude.remote-runner", operation: "dispatch-attachments" }); return gate.receive(runnerId, "attachment-batch", actual(value)); },
    runnerToUploader(value) { dispatched = actual(value); const result = gate.emit(runnerId, "attachment-uploader-handoff", dispatched); gate.finish(runnerId); return result; },
    uploaderReceived(value) { const received = actual(value); uploaderOpened = true; gate.begin({ requestId: uploaderId, moduleId: "agent.claude.remote-attachment-uploader", operation: "start-transfer" }); const result = gate.receive(uploaderId, "attachment-uploader-handoff", received); if (result.light === LIGHTS.RED || JSON.stringify(received) !== JSON.stringify(dispatched)) return gate.fail(uploaderId, "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "runner-attachment-handoff", actual: "uploader-payload" }); return result; },
    transferStarted(value) { const result = gate.emit(uploaderId, "attachment-transfer-started", actual(value)); gate.finish(uploaderId); return result; },
    healthy, results
  });
}

function createReturnedFileFlow(gate, base) {
  const runnerId = `${base.requestId}:agent.claude.remote-runner:publish-returned-files`;
  const conversationId = `${base.requestId}:conversation.artifacts:publish-returned-files`;
  let runnerOpened = false;
  let conversationOpened = false;
  let handedOff;
  const actual = (value = {}) => ({ ...base, fileCount: Number(value.fileCount || 0) });
  const results = () => [runnerOpened && runnerId, conversationOpened && conversationId].filter(Boolean).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  const skip = (reason) => {
    runnerOpened = true; gate.begin({ requestId: runnerId, moduleId: "agent.claude.remote-runner", operation: "publish-returned-files" }); gate.skip(runnerId, reason);
    conversationOpened = true; gate.begin({ requestId: conversationId, moduleId: "conversation.artifacts", operation: "publish-returned-files" }); gate.skip(conversationId, reason);
  };
  return Object.freeze({
    runnerDiscovered(value) {
      const report = actual(value);
      if (!report.fileCount) { skip("no-returned-files"); return; }
      runnerOpened = true; gate.begin({ requestId: runnerId, moduleId: "agent.claude.remote-runner", operation: "publish-returned-files" }); gate.receive(runnerId, "discovered-artifacts", report); handedOff = report; gate.emit(runnerId, "conversation-artifacts-handoff", report); gate.finish(runnerId);
    },
    conversationReceived(value) {
      if (!handedOff) return;
      const report = actual(value); conversationOpened = true; gate.begin({ requestId: conversationId, moduleId: "conversation.artifacts", operation: "publish-returned-files" }); const result = gate.receive(conversationId, "conversation-artifacts-handoff", report); if (result.light === LIGHTS.RED || JSON.stringify(report) !== JSON.stringify(handedOff)) return gate.fail(conversationId, "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "runner-returned-files", actual: "conversation-files" });
    },
    conversationPublished(value) { if (!handedOff) return; gate.emit(conversationId, "assistant-message-artifacts", actual(value)); gate.finish(conversationId); },
    healthy, results
  });
}

function createArtifactActionFlow(gate, input, enabled) {
  const base = Object.freeze({ requestId: String(input?.requestId || ""), action: artifactActions.includes(input?.action) ? input.action : "preview", source: normalizeConnectionMode(input?.source) });
  if (!enabled) return disabledArtifactAction();
  const requestId = `${base.requestId}:conversation.artifacts:${base.action}-request`;
  const completeId = `${base.requestId}:conversation.artifacts:${base.action}-complete`;
  const localId = `${base.requestId}:conversation.artifacts:${base.action}-local`;
  const runnerOperation = base.action === "preview" ? "read-artifact" : "download-artifact";
  const runnerId = `${base.requestId}:agent.claude.remote-runner:${runnerOperation}`;
  const resultIds = base.source === "local" ? [localId] : [requestId, runnerId, completeId];
  const results = () => resultIds.filter((id) => opened.has(id)).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  const actual = (value = {}) => ({ ...base, requestId: String(value.requestId ?? base.requestId), action: value.action ?? base.action, source: value.source ?? base.source });
  const opened = new Set();
  const open = (id, moduleId, operation) => { if (!opened.has(id)) { gate.begin({ requestId: id, moduleId, operation }); opened.add(id); } };
  let handoff;
  let remoteResult;
  const fail = (id, code, detail) => { if (opened.has(id)) gate.fail(id, code, detail); };
  if (base.source === "local") return Object.freeze({
    artifactStarted(value) { open(localId, "conversation.artifacts", `${base.action}-local`); return gate.receive(localId, "artifact-action", actual(value)); },
    completed(value) { const result = gate.emit(localId, "artifact-action-complete", actual(value)); gate.finish(localId); return result; },
    cancelled(reason) { open(localId, "conversation.artifacts", `${base.action}-local`); gate.cancel(localId, reason); },
    failed(error) { fail(localId, "AO.CONTRACT.ARTIFACT_LOCAL_FAILED", { message: String(error?.message || error || "local-artifact-failed") }); },
    remoteRequested() {}, remoteReceived() {}, remoteCompleted() {}, artifactReceived() {}, healthy, results
  });
  return Object.freeze({
    artifactStarted(value) { open(requestId, "conversation.artifacts", `${base.action}-request`); return gate.receive(requestId, "artifact-action", actual(value)); },
    remoteRequested(value) { handoff = actual(value); const result = gate.emit(requestId, "remote-artifact-request", handoff); gate.finish(requestId); return result; },
    remoteReceived(value) { const received = actual(value); open(runnerId, "agent.claude.remote-runner", runnerOperation); const result = gate.receive(runnerId, "remote-artifact-request", received); if (result.light === LIGHTS.RED || JSON.stringify(received) !== JSON.stringify(handoff)) return gate.fail(runnerId, "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "artifact-remote-request", actual: "remote-artifact-request" }); return result; },
    remoteCompleted(value) { remoteResult = actual(value); const result = gate.emit(runnerId, "remote-artifact-complete", remoteResult); gate.finish(runnerId); return result; },
    artifactReceived(value) { const received = actual(value); open(completeId, "conversation.artifacts", `${base.action}-complete`); const result = gate.receive(completeId, "remote-artifact-complete", received); if (result.light === LIGHTS.RED || JSON.stringify(received) !== JSON.stringify(remoteResult)) return gate.fail(completeId, "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "remote-artifact-complete", actual: "artifact-complete-input" }); return result; },
    completed(value) { const result = gate.emit(completeId, "artifact-action-complete", actual(value)); gate.finish(completeId); return result; },
    cancelled(reason) { open(requestId, "conversation.artifacts", `${base.action}-request`); gate.cancel(requestId, reason); },
    failed(error) { const message = String(error?.message || error || "remote-artifact-failed"); fail(runnerId, "AO.CONTRACT.ARTIFACT_REMOTE_FAILED", { message }); fail(completeId, "AO.CONTRACT.ARTIFACT_COMPLETE_FAILED", { message }); },
    healthy, results
  });
}

function createToolPermissionFlow(gate, input, enabled) {
  const base = Object.freeze({ requestId: String(input?.requestId || ""), action: "set-automatic-mode", connectionMode: normalizeConnectionMode(input?.connectionMode), automatic: Boolean(input?.automatic) });
  if (!enabled) return disabledToolPermission();
  const permissionId = `${base.requestId}:foundation.permissions:set-automatic-mode`;
  const settingsId = `${base.requestId}:foundation.settings:save-tool-mode`;
  let permissionOpened = false;
  let settingsOpened = false;
  let handoff;
  const actual = (value = {}) => ({ ...base, requestId: String(value.requestId ?? base.requestId), action: "set-automatic-mode", connectionMode: value.connectionMode ?? base.connectionMode, automatic: typeof value.automatic === "boolean" ? value.automatic : base.automatic });
  const results = () => [permissionOpened && permissionId, settingsOpened && settingsId].filter(Boolean).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  return Object.freeze({
    permissionReceived(value) { permissionOpened = true; gate.begin({ requestId: permissionId, moduleId: "foundation.permissions", operation: "set-automatic-mode" }); return gate.receive(permissionId, "tool-mode-request", actual(value)); },
    permissionToSettings(value) { handoff = actual(value); const result = gate.emit(permissionId, "settings-write-request", handoff); gate.finish(permissionId); return result; },
    settingsReceived(value) { const received = actual(value); settingsOpened = true; gate.begin({ requestId: settingsId, moduleId: "foundation.settings", operation: "save-tool-mode" }); const result = gate.receive(settingsId, "settings-write-request", received); if (result.light === LIGHTS.RED || JSON.stringify(received) !== JSON.stringify(handoff)) return gate.fail(settingsId, "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "tool-mode-settings-write", actual: "settings-write-request" }); return result; },
    settingsSaved(value) { const result = gate.emit(settingsId, "settings-write-complete", actual(value)); gate.finish(settingsId); return result; },
    cancelled(reason) { if (!permissionOpened) { permissionOpened = true; gate.begin({ requestId: permissionId, moduleId: "foundation.permissions", operation: "set-automatic-mode" }); } gate.cancel(permissionId, reason); },
    failed(error) { const id = settingsOpened ? settingsId : permissionId; if (!settingsOpened && !permissionOpened) { permissionOpened = true; gate.begin({ requestId: permissionId, moduleId: "foundation.permissions", operation: "set-automatic-mode" }); } gate.fail(id, "AO.CONTRACT.TOOL_PERMISSION_FAILED", { message: String(error?.message || error || "tool-permission-failed") }); },
    healthy, results
  });
}

function createSettingsSaveFlow(gate, input, enabled) {
  const base = Object.freeze({ requestId: String(input?.requestId || ""), action: "save-settings", connectionMode: normalizeConnectionMode(input?.connectionMode), directoryChanged: Boolean(input?.directoryChanged) });
  if (!enabled) return disabledSettingsSave();
  const ids = [
    `${base.requestId}:foundation.settings:preflight-save`,
    `${base.requestId}:conversation.storage:prepare-settings-directory`,
    `${base.requestId}:foundation.settings:persist-save`,
    `${base.requestId}:conversation.storage:ensure-settings-archives`
  ];
  const definitions = [
    ["foundation.settings", "preflight-save", "settings-save-input", "directory-prepare-request"],
    ["conversation.storage", "prepare-settings-directory", "directory-prepare-request", "settings-persist-request"],
    ["foundation.settings", "persist-save", "settings-persist-request", "archive-ensure-request"],
    ["conversation.storage", "ensure-settings-archives", "archive-ensure-request", "settings-save-complete"]
  ];
  const opened = new Set();
  let handoff;
  const actual = (value = {}) => ({ ...base, requestId: String(value.requestId ?? base.requestId), action: "save-settings", connectionMode: value.connectionMode ?? base.connectionMode, directoryChanged: typeof value.directoryChanged === "boolean" ? value.directoryChanged : base.directoryChanged });
  const open = (index) => { if (!opened.has(ids[index])) { gate.begin({ requestId: ids[index], moduleId: definitions[index][0], operation: definitions[index][1] }); opened.add(ids[index]); } };
  const results = () => ids.filter((id) => opened.has(id)).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  const receive = (index, value) => {
    const received = actual(value); open(index); const result = gate.receive(ids[index], definitions[index][2], received);
    if (index && (result.light === LIGHTS.RED || JSON.stringify(received) !== JSON.stringify(handoff))) return gate.fail(ids[index], "AO.CONTRACT.HANDOFF_MISMATCH", { expected: definitions[index - 1][3], actual: definitions[index][2] });
    return result;
  };
  const emit = (index, value) => { handoff = actual(value); const result = gate.emit(ids[index], definitions[index][3], handoff); gate.finish(ids[index]); return result; };
  const failed = (error) => {
    const active = [...opened].map((id) => ids.indexOf(id)).reverse().find((index) => gate.result(ids[index]).phase === "working");
    const index = active === undefined ? 0 : active;
    if (!opened.has(ids[index])) open(index);
    gate.fail(ids[index], "AO.CONTRACT.SETTINGS_SAVE_FAILED", { message: String(error?.message || error || "settings-save-failed") });
  };
  return Object.freeze({
    preflightReceived: (value) => receive(0, value), preflightToStorage: (value) => emit(0, value), storageReceived: (value) => receive(1, value), storageToSettings: (value) => emit(1, value), settingsReceived: (value) => receive(2, value), settingsPersisted: (value) => emit(2, value), archivesReceived: (value) => receive(3, value), archivesReady: (value) => emit(3, value), failed, healthy, results
  });
}

function createModelUpdateFlow(gate, input, enabled) {
  const base = Object.freeze({ requestId: String(input?.requestId || ""), action: "update-model", connectionMode: normalizeConnectionMode(input?.connectionMode) });
  if (!enabled) return disabledModelUpdate();
  const controllerId = `${base.requestId}:foundation.model-control:request-update`;
  const adapterId = `${base.requestId}:agent.claude.model-adapter:update-model`;
  let controllerOpened = false;
  let adapterOpened = false;
  let handoff;
  const actual = (value = {}) => ({ ...base, requestId: String(value.requestId ?? base.requestId), action: "update-model", connectionMode: value.connectionMode ?? base.connectionMode });
  const results = () => [controllerOpened && controllerId, adapterOpened && adapterId].filter(Boolean).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  return Object.freeze({
    requestReceived(value) { controllerOpened = true; gate.begin({ requestId: controllerId, moduleId: "foundation.model-control", operation: "request-update" }); return gate.receive(controllerId, "model-update-request", actual(value)); },
    controllerToAdapter(value) { handoff = actual(value); const result = gate.emit(controllerId, "model-adapter-request", handoff); gate.finish(controllerId); return result; },
    adapterReceived(value) { const received = actual(value); adapterOpened = true; gate.begin({ requestId: adapterId, moduleId: "agent.claude.model-adapter", operation: "update-model" }); const result = gate.receive(adapterId, "model-adapter-request", received); if (result.light === LIGHTS.RED || JSON.stringify(received) !== JSON.stringify(handoff)) return gate.fail(adapterId, "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "model-adapter-request", actual: "model-adapter-request" }); return result; },
    adapterCompleted(value) { const result = gate.emit(adapterId, "model-update-complete", actual(value)); gate.finish(adapterId); return result; },
    cancelled(reason) { if (!controllerOpened) { controllerOpened = true; gate.begin({ requestId: controllerId, moduleId: "foundation.model-control", operation: "request-update" }); } gate.cancel(controllerId, reason); },
    failed(error) { const id = adapterOpened ? adapterId : controllerId; if (!adapterOpened && !controllerOpened) { controllerOpened = true; gate.begin({ requestId: controllerId, moduleId: "foundation.model-control", operation: "request-update" }); } gate.fail(id, "AO.CONTRACT.MODEL_UPDATE_FAILED", { message: String(error?.message || error || "model-update-failed") }); },
    healthy, results
  });
}

function createDeviceActionFlow(gate, input, enabled) {
  const base = Object.freeze({ requestId: String(input?.requestId || ""), action: input?.action === "uninstall" ? "uninstall" : "install" });
  if (!enabled) return disabledDeviceAction();
  const stages = base.action === "install"
    ? [["foundation.device-control", "request-install"], ["agent.device-registry", "register-install"], ["foundation.device-control", "install-windows"], ["agent.device-registry", "probe-install"]]
    : [["foundation.device-control", "request-uninstall"], ["foundation.device-control", "uninstall-windows"], ["agent.device-registry", "disable-uninstall"]];
  const ids = stages.map(([moduleId, operation]) => `${base.requestId}:${moduleId}:${operation}`);
  const opened = new Set();
  let handoff;
  const actual = (value = {}) => ({ ...base, requestId: String(value.requestId ?? base.requestId), action: value.action ?? base.action });
  const open = (index) => { if (!opened.has(ids[index])) { gate.begin({ requestId: ids[index], moduleId: stages[index][0], operation: stages[index][1] }); opened.add(ids[index]); } };
  const results = () => ids.filter((id) => opened.has(id)).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  const received = (index, value) => { const receivedValue = actual(value); open(index); const signal = index === 0 ? "device-action-request" : "device-action-handoff"; const result = gate.receive(ids[index], signal, receivedValue); if (index && (result.light === LIGHTS.RED || JSON.stringify(receivedValue) !== JSON.stringify(handoff))) return gate.fail(ids[index], "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "device-action-handoff", actual: signal }); return result; };
  const handoffToNext = (index, value) => { handoff = actual(value); const result = gate.emit(ids[index], "device-action-handoff", handoff); gate.finish(ids[index]); return result; };
  const completed = (value) => { const index = stages.length - 1; const result = gate.emit(ids[index], "device-action-complete", actual(value)); gate.finish(ids[index]); return result; };
  const cancelled = (reason) => { open(0); gate.cancel(ids[0], reason); };
  const failed = (error) => { const index = [...opened].map((id) => ids.indexOf(id)).reverse().find((item) => gate.result(ids[item]).phase === "working") ?? 0; if (!opened.has(ids[index])) open(index); gate.fail(ids[index], "AO.CONTRACT.DEVICE_ACTION_FAILED", { message: String(error?.message || error || "device-action-failed") }); };
  const skipped = (index, reason) => { open(index); gate.skip(ids[index], reason); };
  return Object.freeze({ received, handoffToNext, completed, skipped, cancelled, failed, healthy, results });
}

function createBridgeActionFlow(gate, input, enabled) {
  const base = Object.freeze({ requestId: String(input?.requestId || ""), action: input?.action === "uninstall" ? "uninstall" : "install" });
  if (!enabled) return disabledBridgeAction();
  const controlId = `${base.requestId}:foundation.bridge-control:request-${base.action}`;
  const bridgeId = `${base.requestId}:agent.claude.bridge:${base.action}`;
  let controlOpened = false;
  let bridgeOpened = false;
  let handoff;
  const actual = (value = {}) => ({ ...base, requestId: String(value.requestId ?? base.requestId), action: value.action ?? base.action });
  const results = () => [controlOpened && controlId, bridgeOpened && bridgeId].filter(Boolean).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  return Object.freeze({
    requestReceived(value) { controlOpened = true; gate.begin({ requestId: controlId, moduleId: "foundation.bridge-control", operation: `request-${base.action}` }); return gate.receive(controlId, "bridge-action-request", actual(value)); },
    controllerToBridge(value) { handoff = actual(value); const result = gate.emit(controlId, "bridge-adapter-request", handoff); gate.finish(controlId); return result; },
    bridgeReceived(value) { const received = actual(value); bridgeOpened = true; gate.begin({ requestId: bridgeId, moduleId: "agent.claude.bridge", operation: base.action }); const result = gate.receive(bridgeId, "bridge-adapter-request", received); if (result.light === LIGHTS.RED || JSON.stringify(received) !== JSON.stringify(handoff)) return gate.fail(bridgeId, "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "bridge-adapter-request", actual: "bridge-adapter-request" }); return result; },
    bridgeCompleted(value) { const result = gate.emit(bridgeId, "bridge-action-complete", actual(value)); gate.finish(bridgeId); return result; },
    cancelled(reason) { if (!controlOpened) { controlOpened = true; gate.begin({ requestId: controlId, moduleId: "foundation.bridge-control", operation: `request-${base.action}` }); } gate.cancel(controlId, reason); },
    failed(error) { const id = bridgeOpened ? bridgeId : controlId; if (!bridgeOpened && !controlOpened) { controlOpened = true; gate.begin({ requestId: controlId, moduleId: "foundation.bridge-control", operation: `request-${base.action}` }); } gate.fail(id, "AO.CONTRACT.BRIDGE_ACTION_FAILED", { message: String(error?.message || error || "bridge-action-failed") }); },
    healthy, results
  });
}

function createConversationManagementFlow(gate, input, enabled) {
  const base = Object.freeze({ requestId: String(input?.requestId || ""), action: conversationManagementActions.includes(input?.action) ? input.action : "create" });
  if (!enabled) return disabledConversationManagement();
  const controlId = `${base.requestId}:foundation.conversation-control:request-${base.action}`;
  const serviceId = `${base.requestId}:conversation.conversations:${base.action}`;
  let controlOpened = false;
  let serviceOpened = false;
  let handoff;
  const actual = (value = {}) => ({ ...base, requestId: String(value.requestId ?? base.requestId), action: value.action ?? base.action });
  const results = () => [controlOpened && controlId, serviceOpened && serviceId].filter(Boolean).map((id) => gate.result(id));
  const healthy = () => ensureHealthy(results());
  return Object.freeze({
    requestReceived(value) { controlOpened = true; gate.begin({ requestId: controlId, moduleId: "foundation.conversation-control", operation: `request-${base.action}` }); return gate.receive(controlId, "conversation-management-request", actual(value)); },
    controllerToService(value) { handoff = actual(value); const result = gate.emit(controlId, "conversation-service-request", handoff); gate.finish(controlId); return result; },
    serviceReceived(value) { const received = actual(value); serviceOpened = true; gate.begin({ requestId: serviceId, moduleId: "conversation.conversations", operation: base.action }); const result = gate.receive(serviceId, "conversation-service-request", received); if (result.light === LIGHTS.RED || JSON.stringify(received) !== JSON.stringify(handoff)) return gate.fail(serviceId, "AO.CONTRACT.HANDOFF_MISMATCH", { expected: "conversation-service-request", actual: "conversation-service-request" }); return result; },
    serviceCompleted(value) { const result = gate.emit(serviceId, "conversation-management-complete", actual(value)); gate.finish(serviceId); return result; },
    failed(error) { const id = serviceOpened ? serviceId : controlId; if (!serviceOpened && !controlOpened) { controlOpened = true; gate.begin({ requestId: controlId, moduleId: "foundation.conversation-control", operation: `request-${base.action}` }); } gate.fail(id, "AO.CONTRACT.CONVERSATION_MANAGEMENT_FAILED", { message: String(error?.message || error || "conversation-management-failed") }); },
    healthy, results
  });
}

function ensureHealthy(results) {
  const red = results.find((item) => item.light === LIGHTS.RED);
  if (red) { const error = new Error(`信号契约失败：${red.moduleId}`); error.code = red.error?.code; throw error; }
}

function disabledChain() {
  const attachment = Object.freeze({ runnerReceived() {}, runnerToUploader() {}, uploaderReceived() {}, transferStarted() {}, healthy() {}, results: () => [] });
  const returnedFiles = Object.freeze({ runnerDiscovered() {}, conversationReceived() {}, conversationPublished() {}, healthy() {}, results: () => [] });
  return Object.freeze({ turnReceived() {}, turnToTransport() {}, transportReceived() {}, transportToAdapter() {}, adapterReceived() {}, adapterToRunner() {}, runnerReceived() {}, runnerOperation: (operation) => operation, attachmentUpload: () => attachment, returnedFiles: () => returnedFiles, complete() {}, failed() {}, healthy() {}, results: () => [] });
}

function disabledArtifactAction() { return Object.freeze({ artifactStarted() {}, remoteRequested() {}, remoteReceived() {}, remoteCompleted() {}, artifactReceived() {}, completed() {}, cancelled() {}, failed() {}, healthy() {}, results: () => [] }); }
function disabledToolPermission() { return Object.freeze({ permissionReceived() {}, permissionToSettings() {}, settingsReceived() {}, settingsSaved() {}, cancelled() {}, failed() {}, healthy() {}, results: () => [] }); }
function disabledSettingsSave() { return Object.freeze({ preflightReceived() {}, preflightToStorage() {}, storageReceived() {}, storageToSettings() {}, settingsReceived() {}, settingsPersisted() {}, archivesReceived() {}, archivesReady() {}, failed() {}, healthy() {}, results: () => [] }); }
function disabledModelUpdate() { return Object.freeze({ requestReceived() {}, controllerToAdapter() {}, adapterReceived() {}, adapterCompleted() {}, cancelled() {}, failed() {}, healthy() {}, results: () => [] }); }
function disabledDeviceAction() { return Object.freeze({ received() {}, handoffToNext() {}, completed() {}, skipped() {}, cancelled() {}, failed() {}, healthy() {}, results: () => [] }); }
function disabledBridgeAction() { return Object.freeze({ requestReceived() {}, controllerToBridge() {}, bridgeReceived() {}, bridgeCompleted() {}, cancelled() {}, failed() {}, healthy() {}, results: () => [] }); }
function disabledConversationManagement() { return Object.freeze({ requestReceived() {}, controllerToService() {}, serviceReceived() {}, serviceCompleted() {}, failed() {}, healthy() {}, results: () => [] }); }

module.exports = { createConversationClaudeSignalMonitor, normalizeConnectionMode, normalizeRunner };
