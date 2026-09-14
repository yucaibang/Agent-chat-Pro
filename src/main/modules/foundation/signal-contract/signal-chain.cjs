"use strict";

const { createSignalContractRegistry, LIGHTS } = require("./signal-contract.cjs");

/**
 * 信号链编排 — 注册所有跨模块信号契约并创建监控器。
 *
 * 每个请求从 conversation.turn-orchestrator 提交开始，
 * 经过 transport → adapter → runner 四个阶段，
 * 每个阶段的 handoff 数据通过 JSON Schema 严格校验。
 *
 * 信号链还涵盖：附件上传、返回文件、制品操作、工具权限、
 * 设置保存、模型更新、设备控制、Bridge 操作、会话管理。
 *
 * disabled 模式：enabled=false 时所有方法为空操作，不影响正常业务。
 */

function createConversationClaudeSignalMonitor(options = {}) {
  const { enabled = true, onLog } = options;
  const registry = createSignalContractRegistry();

  if (!enabled) {
    return Object.freeze({
      registry,
      startRequest: () => ({ receive: () => null, emit: () => null, finish: () => null, fail: () => null, cancel: () => null, skip: () => null, snapshot: () => ({}) }),
      lightStrip: null,
      enabled: false
    });
  }

  // ── 注册所有信号契约 ──

  // 对话主链（4 个阶段）
  registry.register({ moduleId: "conversation", operation: "submit", version: 1, inputs: [{ name: "turn-input" }], outputs: [{ name: "transport-handoff" }] });
  registry.register({ moduleId: "conversation", operation: "transport-start", version: 1, inputs: [{ name: "transport-handoff" }], outputs: [{ name: "adapter-handoff" }] });
  registry.register({ moduleId: "agent", operation: "adapter-start", version: 1, inputs: [{ name: "adapter-handoff" }], outputs: [{ name: "runner-handoff" }] });
  registry.register({ moduleId: "agent", operation: "runner-run", version: 1, inputs: [{ name: "runner-handoff" }], outputs: [{ name: "runner-operation" }] });

  // 附件上传
  registry.register({ moduleId: "agent", operation: "dispatch-attachments", version: 1, inputs: [{ name: "attachment-list" }], outputs: [{ name: "upload-complete" }] });

  // 返回文件
  registry.register({ moduleId: "agent", operation: "publish-returned-files", version: 1, inputs: [{ name: "returned-file-list" }], outputs: [{ name: "file-catalog" }] });

  // 制品操作（preview / save / open）
  registry.register({ moduleId: "conversation", operation: "artifact-action", version: 1, inputs: [{ name: "action-request" }], outputs: [{ name: "action-complete" }] });

  // 工具权限
  registry.register({ moduleId: "foundation", operation: "set-tool-mode", version: 1, inputs: [{ name: "mode-change-request" }], outputs: [{ name: "mode-persisted" }] });

  // 设置保存（4 阶段）
  registry.register({ moduleId: "foundation", operation: "preflight-save", version: 1, inputs: [{ name: "save-request" }], outputs: [{ name: "preflight-ok" }] });
  registry.register({ moduleId: "foundation", operation: "prepare-directory", version: 1, inputs: [{ name: "preflight-ok" }], outputs: [{ name: "directory-ready" }] });
  registry.register({ moduleId: "foundation", operation: "persist-save", version: 1, inputs: [{ name: "directory-ready" }], outputs: [{ name: "save-complete" }] });

  // 模型更新
  registry.register({ moduleId: "foundation", operation: "request-model-update", version: 1, inputs: [{ name: "model-update-request" }], outputs: [{ name: "model-update-complete" }] });

  // 设备控制
  registry.register({ moduleId: "foundation", operation: "device-control-install", version: 1, inputs: [{ name: "install-request" }], outputs: [{ name: "install-complete" }] });
  registry.register({ moduleId: "foundation", operation: "device-control-uninstall", version: 1, maySkip: true, inputs: [{ name: "uninstall-request" }], outputs: [{ name: "uninstall-complete" }] });

  // Bridge 操作
  registry.register({ moduleId: "foundation", operation: "bridge-install", version: 1, inputs: [{ name: "bridge-install-request" }], outputs: [{ name: "bridge-install-complete" }] });
  registry.register({ moduleId: "foundation", operation: "bridge-uninstall", version: 1, maySkip: true, inputs: [{ name: "bridge-uninstall-request" }], outputs: [{ name: "bridge-uninstall-complete" }] });

  // 会话管理
  registry.register({ moduleId: "conversation", operation: "create-conversation", version: 1, inputs: [{ name: "create-request" }], outputs: [{ name: "create-complete" }] });
  registry.register({ moduleId: "conversation", operation: "rename-conversation", version: 1, inputs: [{ name: "rename-request" }], outputs: [{ name: "rename-complete" }] });
  registry.register({ moduleId: "conversation", operation: "set-pinned", version: 1, inputs: [{ name: "pin-request" }], outputs: [{ name: "pin-complete" }] });
  registry.register({ moduleId: "conversation", operation: "clear-session", version: 1, inputs: [{ name: "clear-request" }], outputs: [{ name: "clear-complete" }] });
  registry.register({ moduleId: "conversation", operation: "delete-conversation", version: 1, inputs: [{ name: "delete-request" }], outputs: [{ name: "delete-complete" }] });

  // ── 请求级信号门管理 ──

  const activeGates = new Map(); // requestId → gate

  function startRequest(requestId, contractKey) {
    const contract = registry.get("conversation", "submit");
    if (!contract) return null;
    // 动态获取契约
    const [moduleId, operation] = contractKey ? contractKey.split(":") : ["conversation", "submit"];
    const targetContract = registry.get(moduleId, operation);
    if (!targetContract) return null;

    const { createSignalGate } = require("./signal-contract.cjs");
    const gate = createSignalGate(targetContract, { onLog });
    gate.begin(requestId);
    activeGates.set(requestId, gate);
    return gate;
  }

  function getGate(requestId) {
    return activeGates.get(requestId) || null;
  }

  function finishRequest(requestId) {
    const gate = activeGates.get(requestId);
    if (gate) {
      gate.finish();
      activeGates.delete(requestId);
    }
  }

  function failRequest(requestId, error) {
    const gate = activeGates.get(requestId);
    if (gate) {
      gate.fail(error);
      activeGates.delete(requestId);
    }
  }

  return Object.freeze({
    registry,
    startRequest,
    getGate,
    finishRequest,
    failRequest,
    enabled: true
  });
}

module.exports = { createConversationClaudeSignalMonitor };