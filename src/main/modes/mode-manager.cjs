"use strict";

/**
 * 模式管理器 — 自定义工作模式的 CRUD + 导入导出。
 *
 * 模式配置存储在 %APPDATA%/Agent Chat Pro/modes.json。
 * 内置模式不可删除/修改，但可以在此基础上创建自定义模式。
 */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { BUILTIN_MODES } = require("./mode-defaults.cjs");

const MODES_FILE = "modes.json";

function modesPath() {
  return path.join(app.getPath("userData"), MODES_FILE);
}

function readModes() {
  try {
    return JSON.parse(fs.readFileSync(modesPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { custom: [] };
    throw new Error("无法读取工作模式配置：" + error.message);
  }
}

function writeModes(data) {
  fs.mkdirSync(path.dirname(modesPath()), { recursive: true });
  const temporary = modesPath() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, modesPath());
}

/** 获取所有模式（内置 + 自定义）。 */
function listModes() {
  const data = readModes();
  const builtIn = Object.values(BUILTIN_MODES);
  const custom = (data.custom || []).map(normalizeCustomMode);
  return [...builtIn, ...custom];
}

/** 获取指定 ID 的模式。 */
function getMode(id) {
  if (BUILTIN_MODES[id]) return { ...BUILTIN_MODES[id] };
  const data = readModes();
  const custom = (data.custom || []).find((m) => m.id === id);
  return custom ? normalizeCustomMode(custom) : null;
}

/** 创建自定义模式。 */
function createMode(input) {
  const data = readModes();
  const id = generateId(input.name);
  if (BUILTIN_MODES[id]) throw new Error("不能使用内置模式的名称。");
  if ((data.custom || []).find((m) => m.id === id)) throw new Error("已存在同名模式。");

  const mode = normalizeCustomMode({
    id,
    name: String(input.name || "").trim(),
    icon: String(input.icon || "🔧").trim(),
    description: String(input.description || "").trim(),
    isBuiltIn: false,
    skipPermissions: Boolean(input.skipPermissions),
    permissionMode: input.skipPermissions ? "bypassPermissions" : "dontAsk",
    maxTokens: validateMaxTokens(input.maxTokens),
    thinkingLevel: validateThinkingLevel(input.thinkingLevel),
    hallucinationControl: validateHallucination(input.hallucinationControl),
    energyPriority: validateEnergy(input.energyPriority),
    systemPrompt: String(input.systemPrompt || "").trim(),
    modelConfig: input.modelConfig || {}
  });

  if (!mode.name || mode.name.length > 40) throw new Error("模式名称需为 1–40 个字符。");

  data.custom = data.custom || [];
  data.custom.push(mode);
  writeModes(data);
  return mode;
}

/** 更新自定义模式。 */
function updateMode(id, input) {
  if (BUILTIN_MODES[id]) throw new Error("内置模式不可修改。");
  const data = readModes();
  const index = (data.custom || []).findIndex((m) => m.id === id);
  if (index < 0) throw new Error("找不到此模式。");

  data.custom[index] = normalizeCustomMode({
    ...data.custom[index],
    ...input,
    id,
    isBuiltIn: false,
    permissionMode: input.skipPermissions ? "bypassPermissions" : "dontAsk"
  });

  if (!data.custom[index].name || data.custom[index].name.length > 40) {
    throw new Error("模式名称需为 1–40 个字符。");
  }

  writeModes(data);
  return data.custom[index];
}

/** 删除自定义模式。 */
function deleteMode(id) {
  if (BUILTIN_MODES[id]) throw new Error("内置模式不可删除。");
  const data = readModes();
  const index = (data.custom || []).findIndex((m) => m.id === id);
  if (index < 0) throw new Error("找不到此模式。");
  data.custom.splice(index, 1);
  writeModes(data);
  return true;
}

/** 导出自定义模式为 JSON。 */
function exportModes() {
  const data = readModes();
  return JSON.stringify({ version: 1, custom: data.custom || [] }, null, 2);
}

/** 导入自定义模式（合并，不覆盖已有同名模式）。 */
function importModes(jsonString) {
  let imported;
  try { imported = JSON.parse(jsonString); } catch { throw new Error("JSON 格式无效。"); }
  if (!Array.isArray(imported?.custom)) throw new Error("导入文件缺少自定义模式列表。");

  const data = readModes();
  const existing = new Set((data.custom || []).map((m) => m.id));
  const existingNames = new Set((data.custom || []).map((m) => m.name));
  let added = 0;

  for (const mode of imported.custom) {
    const normalized = normalizeCustomMode(mode);
    if (BUILTIN_MODES[normalized.id]) continue;
    if (existing.has(normalized.id) || existingNames.has(normalized.name)) continue;
    if (!normalized.name) continue;
    data.custom = data.custom || [];
    data.custom.push(normalized);
    existing.add(normalized.id);
    existingNames.add(normalized.name);
    added++;
  }

  writeModes(data);
  return { added, total: (data.custom || []).length };
}

// ── 内部工具 ──────────────────────────────────────────

function generateId(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "custom-" + Date.now().toString(36);
}

function normalizeCustomMode(mode) {
  return {
    id: String(mode.id || ""),
    name: String(mode.name || "").trim(),
    icon: String(mode.icon || "🔧").trim(),
    description: String(mode.description || "").trim(),
    isBuiltIn: false,
    skipPermissions: Boolean(mode.skipPermissions),
    permissionMode: mode.skipPermissions ? "bypassPermissions" : "dontAsk",
    maxTokens: validateMaxTokens(mode.maxTokens),
    thinkingLevel: validateThinkingLevel(mode.thinkingLevel),
    hallucinationControl: validateHallucination(mode.hallucinationControl),
    energyPriority: validateEnergy(mode.energyPriority),
    systemPrompt: String(mode.systemPrompt || "").trim(),
    modelConfig: mode.modelConfig || {}
  };
}

function validateMaxTokens(value) {
  const n = Number(value);
  return [4096, 8192, 16384, 32768].includes(n) ? n : 8192;
}

function validateThinkingLevel(value) {
  return ["none", "low", "medium", "high"].includes(value) ? value : "none";
}

function validateHallucination(value) {
  return ["strict", "standard", "creative"].includes(value) ? value : "standard";
}

function validateEnergy(value) {
  return ["quality", "balanced", "economy"].includes(value) ? value : "balanced";
}

module.exports = { listModes, getMode, createMode, updateMode, deleteMode, exportModes, importModes };