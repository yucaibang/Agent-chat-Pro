"use strict";

const AjvModule = require("ajv");
const Ajv = AjvModule.default || AjvModule;

const LIGHTS = Object.freeze({ ORANGE: "orange", GREEN: "green", GREY: "grey", RED: "red" });
const CONTRACT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["moduleId", "operation", "version", "inputs", "outputs"],
  properties: {
    moduleId: { type: "string", minLength: 1 }, operation: { type: "string", minLength: 1 },
    version: { type: "integer", minimum: 1 }, maySkip: { type: "boolean" },
    inputs: { type: "array", items: { $ref: "#/$defs/signal" } },
    outputs: { type: "array", items: { $ref: "#/$defs/signal" } }
  },
  $defs: { signal: { type: "object", additionalProperties: false, required: ["name", "schema"], properties: {
    name: { type: "string", minLength: 1 }, schema: { type: "object" }
  } } }
};

function createAjv() { return new Ajv({ allErrors: true, strict: true }); }
function contractKey(moduleId, operation) { return `${moduleId}:${operation}`; }
function error(code, detail) { return Object.freeze({ code, ...detail }); }

function createSignalContractRegistry() {
  const ajv = createAjv();
  const validateContract = ajv.compile(CONTRACT_SCHEMA);
  const contracts = new Map();
  function register(definition) {
    if (!validateContract(definition)) throw new Error(`信号契约无效：${ajv.errorsText(validateContract.errors)}`);
    const key = contractKey(definition.moduleId, definition.operation);
    if (contracts.has(key)) throw new Error(`信号契约已注册：${key}`);
    const compileSignals = (signals) => signals.map((signal) => Object.freeze({ ...signal, validate: ajv.compile(signal.schema) }));
    const contract = Object.freeze({ ...definition, inputs: compileSignals(definition.inputs), outputs: compileSignals(definition.outputs) });
    contracts.set(key, contract);
    return contract;
  }
  function get(moduleId, operation) {
    const contract = contracts.get(contractKey(moduleId, operation));
    if (!contract) throw new Error(`未注册信号契约：${moduleId}:${operation}`);
    return contract;
  }
  return Object.freeze({ register, get, list: () => [...contracts.values()] });
}

function createSignalGate({ registry, enabled = true, now = () => Date.now(), onTransition = () => {} } = {}) {
  if (!registry || typeof registry.get !== "function") throw new Error("signalGate 需要契约注册表。");
  const requests = new Map();
  function elapsed(state) { return Math.max(0, now() - state.startedAt); }
  function snapshot(state) { return Object.freeze({ requestId: state.requestId, moduleId: state.contract.moduleId, operation: state.contract.operation, light: state.light, phase: state.phase, error: state.error || null, inputs: state.inputs, outputs: state.outputs, startedAt: state.startedAt, completedAt: state.completedAt || null, elapsedMs: elapsed(state) }); }
  function transition(state) { const result = snapshot(state); onTransition(result); return result; }
  function fail(state, code, detail = {}) { if (state.phase !== "working") return snapshot(state); state.light = LIGHTS.RED; state.phase = "failed"; state.completedAt = now(); state.error = error(code, detail); return transition(state); }
  function complete(state, light, phase, detail) { if (state.phase !== "working") return snapshot(state); state.light = light; state.phase = phase; state.completedAt = now(); if (detail) state.error = detail; return transition(state); }
  function begin({ requestId, moduleId, operation }) {
    if (!enabled) return Object.freeze({ requestId, light: "disabled", phase: "disabled" });
    if (!String(requestId || "")) throw new Error("信号请求缺少 requestId。");
    if (requests.has(requestId)) throw new Error(`信号请求已存在：${requestId}`);
    const state = { requestId, contract: registry.get(moduleId, operation), inputs: 0, outputs: 0, light: LIGHTS.ORANGE, phase: "working", error: null, startedAt: now(), completedAt: null };
    requests.set(requestId, state); return transition(state);
  }
  function stateFor(requestId) { const state = requests.get(requestId); if (!state) throw new Error(`未知信号请求：${requestId}`); return state; }
  function accept(requestId, side, signal, payload) {
    const state = stateFor(requestId); if (state.phase !== "working") return snapshot(state);
    if (side === "outputs" && state.inputs !== state.contract.inputs.length) {
      return fail(state, "AO.CONTRACT.SIGNAL_ORDER", { side, expected: state.contract.inputs[state.inputs]?.name || "all-inputs", actual: signal });
    }
    const index = side === "inputs" ? state.inputs : state.outputs;
    const expected = state.contract[side][index];
    if (!expected) return fail(state, "AO.CONTRACT.UNEXPECTED_SIGNAL", { side, signal });
    if (expected.name !== signal) return fail(state, "AO.CONTRACT.SIGNAL_ORDER", { side, expected: expected.name, actual: signal });
    if (!expected.validate(payload)) return fail(state, "AO.CONTRACT.INVALID_SIGNAL", { side, signal, validation: expected.validate.errors.map((item) => item.instancePath || item.keyword) });
    state[side] += 1; state.light = LIGHTS.ORANGE; state.phase = "working"; return transition(state);
  }
  function finish(requestId) { const state = stateFor(requestId); if (state.phase !== "working") return snapshot(state); if (state.inputs !== state.contract.inputs.length || state.outputs !== state.contract.outputs.length) return fail(state, "AO.CONTRACT.UNFINISHED", { expectedInputs: state.contract.inputs.length, actualInputs: state.inputs, expectedOutputs: state.contract.outputs.length, actualOutputs: state.outputs }); return complete(state, LIGHTS.GREEN, "finished"); }
  function skip(requestId, reason) { const state = stateFor(requestId); if (!state.contract.maySkip) return fail(state, "AO.CONTRACT.SKIP_NOT_ALLOWED", { reason }); return complete(state, LIGHTS.GREY, "skipped"); }
  function cancel(requestId, reason = "cancelled") { const state = stateFor(requestId); return complete(state, LIGHTS.GREY, "cancelled", error("AO.CONTRACT.CANCELLED", { reason })); }
  return Object.freeze({ begin, receive: (requestId, signal, payload) => accept(requestId, "inputs", signal, payload), emit: (requestId, signal, payload) => accept(requestId, "outputs", signal, payload), finish, fail: (requestId, code, detail) => fail(stateFor(requestId), code, detail), skip, cancel, result: (requestId) => snapshot(stateFor(requestId)) });
}

module.exports = { LIGHTS, createSignalContractRegistry, createSignalGate };
