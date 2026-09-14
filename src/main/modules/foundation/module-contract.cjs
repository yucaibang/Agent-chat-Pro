"use strict";

/**
 * 模块契约定义 — Agent Chat Pro 模块系统的合法性约束。
 *
 * 所有模块必须通过 assertModuleDefinition 校验后才能注册到 ModuleRegistry。
 * 每个模块声明 id、label、version 和 capabilities，
 * 注册后不可变（Object.freeze）。
 */

const MODULE_IDS = Object.freeze(["foundation", "status", "conversation", "agent"]);

const FOUNDATION_CAPABILITIES = Object.freeze([
  "electron",
  "ipc",
  "window",
  "settings",
  "credentials",
  "filesystem",
  "nativeDialogs",
  "moduleRegistry"
]);

const VALID_CAPABILITIES = new Set([
  ...FOUNDATION_CAPABILITIES,
  "statusCenter",
  "signalContract",
  "conversationStore",
  "turnOrchestration",
  "transport",
  "artifactStore",
  "claudeAdapter",
  "claudeRunner",
  "claudeProtocol",
  "modelConfig",
  "runtimeCompatibility",
  "deviceControl",
  "toolPermission",
  "cloudChat"
]);

function assertModuleDefinition(definition) {
  if (!definition || typeof definition !== "object") {
    throw new Error("模块定义必须是一个对象。");
  }
  if (!MODULE_IDS.includes(definition.id)) {
    throw new Error(`模块 ID "${definition.id}" 不合法。合法 ID：${MODULE_IDS.join("、")}。`);
  }
  if (typeof definition.label !== "string" || !definition.label.trim()) {
    throw new Error(`模块 "${definition.id}" 必须有非空的 label。`);
  }
  if (typeof definition.version !== "number" || !Number.isInteger(definition.version) || definition.version < 1) {
    throw new Error(`模块 "${definition.id}" 的 version 必须是正整数。`);
  }
  if (definition.capabilities) {
    if (!Array.isArray(definition.capabilities)) {
      throw new Error(`模块 "${definition.id}" 的 capabilities 必须是数组。`);
    }
    for (const cap of definition.capabilities) {
      if (!VALID_CAPABILITIES.has(cap)) {
        throw new Error(`模块 "${definition.id}" 的 capability "${cap}" 不在合法白名单中。`);
      }
    }
  }
  if (definition.activate !== undefined && typeof definition.activate !== "function") {
    throw new Error(`模块 "${definition.id}" 的 activate 必须是函数。`);
  }
}

module.exports = {
  MODULE_IDS,
  FOUNDATION_CAPABILITIES,
  VALID_CAPABILITIES,
  assertModuleDefinition
};