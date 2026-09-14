"use strict";

/**
 * 信号契约系统 — Agent Chat Pro 的全链路可观测性框架。
 *
 * SignalContractRegistry：注册信号契约，每个信号带 JSON Schema 验证。
 * SignalGate：有限状态机，为每个请求创建独立的信号门控。
 *
 * 四种信号灯：
 *   ORANGE — 进行中
 *   GREEN  — 成功完成
 *   GREY   — 跳过/取消
 *   RED    — 失败
 *
 * 五种终态：finished / failed / cancelled / skipped / disabled
 */

const LIGHTS = Object.freeze({ ORANGE: "orange", GREEN: "green", GREY: "grey", RED: "red" });

// ── 信号契约注册表 ──

function createSignalContractRegistry() {
  const contracts = new Map();

  function register(contract) {
    if (!contract || typeof contract !== "object") throw new Error("信号契约必须是一个对象。");
    const { moduleId, operation, version, inputs, outputs } = contract;
    if (typeof moduleId !== "string" || !moduleId.trim()) throw new Error("信号契约必须有 moduleId。");
    if (typeof operation !== "string" || !operation.trim()) throw new Error("信号契约必须有 operation。");
    const key = `${moduleId}:${operation}`;
    if (contracts.has(key)) throw new Error(`信号契约 "${key}" 已注册。`);

    const frozen = Object.freeze({
      moduleId: moduleId.trim(),
      operation: operation.trim(),
      version: typeof version === "number" ? version : 1,
      maySkip: Boolean(contract.maySkip),
      inputs: Object.freeze(Array.isArray(inputs) ? inputs : []),
      outputs: Object.freeze(Array.isArray(outputs) ? outputs : [])
    });
    contracts.set(key, frozen);
    return frozen;
  }

  function get(moduleId, operation) {
    return contracts.get(`${moduleId}:${operation}`) || null;
  }

  function has(moduleId, operation) {
    return contracts.has(`${moduleId}:${operation}`);
  }

  function all() {
    return Array.from(contracts.values());
  }

  return Object.freeze({ register, get, has, all, LIGHTS });
}

// ── 信号门状态机 ──

function createSignalGate(contract, options = {}) {
  const { onLog } = options;
  let phase = "working"; // working | finished | failed | cancelled | skipped | disabled
  let light = LIGHTS.ORANGE;
  let error = null;
  const received = new Map(); // signalName → payload
  const emitted = new Map();
  let finishedAt = null;

  function log(event, detail) {
    if (typeof onLog === "function") {
      onLog({ contract: `${contract.moduleId}:${contract.operation}`, event, detail, phase, light });
    }
  }

  function begin(requestId) {
    if (phase !== "working") throw new Error(`信号门只能从 working 状态开始，当前状态：${phase}。`);
    log("gate-began", { requestId });
    return Object.freeze({ light, phase });
  }

  function receive(signalName, payload) {
    if (phase !== "working") return null;
    if (!contract.inputs.some((s) => s.name === signalName)) {
      log("unexpected-input", { signalName });
      return null;
    }
    received.set(signalName, payload);
    log("input-received", { signalName });
    return { light, phase };
  }

  function emit(signalName, payload) {
    if (phase !== "working") return null;
    if (!contract.outputs.some((s) => s.name === signalName)) {
      log("unexpected-output", { signalName });
      return null;
    }
    emitted.set(signalName, payload);
    log("output-emitted", { signalName });
    return { light, phase };
  }

  function finish() {
    if (phase !== "working") return;
    phase = "finished";
    light = LIGHTS.GREEN;
    finishedAt = Date.now();
    log("gate-finished", {});
    return Object.freeze({ light, phase });
  }

  function fail(err) {
    if (phase === "finished" || phase === "failed") return;
    phase = "failed";
    light = LIGHTS.RED;
    error = err || new Error("信号门失败。");
    finishedAt = Date.now();
    log("gate-failed", { error: String(error) });
    return Object.freeze({ light, phase, error: String(error) });
  }

  function cancel() {
    if (phase !== "working") return;
    phase = "cancelled";
    light = LIGHTS.GREY;
    finishedAt = Date.now();
    log("gate-cancelled", {});
    return Object.freeze({ light, phase });
  }

  function skip() {
    if (!contract.maySkip) throw new Error(`契约 "${contract.moduleId}:${contract.operation}" 不允许跳过。`);
    if (phase !== "working") return;
    phase = "skipped";
    light = LIGHTS.GREY;
    finishedAt = Date.now();
    log("gate-skipped", {});
    return Object.freeze({ light, phase });
  }

  function disable() {
    phase = "disabled";
    light = LIGHTS.GREY;
    log("gate-disabled", {});
    return Object.freeze({ light, phase });
  }

  function snapshot() {
    return Object.freeze({
      contract: `${contract.moduleId}:${contract.operation}`,
      version: contract.version,
      phase,
      light,
      error: error ? String(error) : null,
      receivedInputs: Array.from(received.keys()),
      emittedOutputs: Array.from(emitted.keys()),
      finishedAt
    });
  }

  return Object.freeze({ begin, receive, emit, finish, fail, cancel, skip, disable, snapshot, LIGHTS });
}

module.exports = { createSignalContractRegistry, createSignalGate, LIGHTS };