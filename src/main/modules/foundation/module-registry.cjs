"use strict";

const { assertModuleDefinition } = require("./module-contract.cjs");

/**
 * 模块注册表 — 集中管理所有模块的发现与激活。
 *
 * 注册：moduleRegistry.register(definition)
 * 获取：moduleRegistry.get(id)
 * 列表：moduleRegistry.list()
 * 激活：moduleRegistry.activate(id, context)
 */

const registry = new Map();

function register(definition) {
  assertModuleDefinition(definition);
  if (registry.has(definition.id)) {
    throw new Error(`模块 "${definition.id}" 已注册，不能重复注册。`);
  }
  const frozen = Object.freeze({ ...definition });
  registry.set(definition.id, frozen);
  return frozen;
}

function get(id) {
  const module = registry.get(id);
  if (!module) throw new Error(`模块 "${id}" 未注册。`);
  return module;
}

function list() {
  return Array.from(registry.values()).map(({ activate, ...meta }) => meta);
}

async function activate(id, context) {
  const module = get(id);
  if (typeof module.activate !== "function") {
    return undefined;
  }
  return module.activate(context);
}

module.exports = { register, get, list, activate };