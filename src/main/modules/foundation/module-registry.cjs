"use strict";

const { assertModuleDefinition } = require("./module-contract.cjs");

function createModuleRegistry() {
  const modules = new Map();
  return Object.freeze({
    register(definition) {
      const module = assertModuleDefinition(definition);
      if (modules.has(module.id)) throw new Error(`模块“${module.id}”已注册。`);
      modules.set(module.id, module);
      return module;
    },
    get(id) {
      const module = modules.get(String(id || ""));
      if (!module) throw new Error("请求的模块尚未注册。");
      return module;
    },
    list() {
      return [...modules.values()].map(({ activate, ...module }) => module);
    },
    activate(id, context) {
      const module = this.get(id);
      return module.activate ? module.activate(context) : undefined;
    }
  });
}

module.exports = { createModuleRegistry };
