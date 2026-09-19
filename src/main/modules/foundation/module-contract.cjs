"use strict";

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

function normalizeCapabilities(input = []) {
  const values = Array.isArray(input) ? input : [];
  return [...new Set(values.filter((value) => FOUNDATION_CAPABILITIES.includes(value)))].sort();
}

function assertModuleDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new Error("模块定义无效。");
  const id = String(definition.id || "");
  if (!MODULE_IDS.includes(id)) throw new Error("模块标识无效。");
  if (!String(definition.label || "").trim()) throw new Error(`模块“${id}”缺少显示名称。`);
  if (definition.activate !== undefined && typeof definition.activate !== "function") {
    throw new Error(`模块“${id}”的 activate 必须是函数。`);
  }
  return Object.freeze({
    id,
    label: String(definition.label).trim(),
    version: Math.max(1, Math.floor(Number(definition.version) || 1)),
    capabilities: normalizeCapabilities(definition.capabilities),
    activate: definition.activate || null
  });
}

module.exports = { FOUNDATION_CAPABILITIES, MODULE_IDS, assertModuleDefinition, normalizeCapabilities };
