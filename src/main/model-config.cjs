"use strict";

const MODEL_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL"
];

// v3.18.0 F2：五项模型配置表（AO 0.9.6 MODEL_ENTRIES 1:1 移植）——
// 模型页五项单独修改按 id 定位；label/description 直接来自 AO 同源文案。
const MODEL_ENTRIES = Object.freeze([
  Object.freeze({ id: "opus", kind: "env", key: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus 档位", description: "Claude 选择 Opus 档位时使用" }),
  Object.freeze({ id: "sonnet", kind: "env", key: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet 档位", description: "Claude 选择 Sonnet 档位时使用" }),
  Object.freeze({ id: "haiku", kind: "env", key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku 档位", description: "Claude 选择 Haiku 档位及部分后台任务时使用" }),
  Object.freeze({ id: "subagent", kind: "env", key: "CLAUDE_CODE_SUBAGENT_MODEL", label: "子 Agent 默认模型", description: "没有单独指定模型的子 Agent 默认使用" }),
  Object.freeze({ id: "small-fast", kind: "env", key: "ANTHROPIC_SMALL_FAST_MODEL", label: "旧版后台小模型", description: "兼容旧版 Claude Code 的后台小任务配置" })
]);

// 自动压缩阈值（AO 0.9.6 同源）：settings.json 顶层 autoCompactWindow，auto=删键走官方自动值。
const AUTO_COMPACT_MIN_TOKENS = 100_000;
const AUTO_COMPACT_MAX_TOKENS = 1_000_000;

/**
 * Claude 模型名识别 — 用于判断模型类型，决定 Bridge 调用策略。
 * 注意：此函数不拒绝任何模型名，仅做分类标记。
 */
const CLAUDE_MODEL_PATTERNS = [
  /^claude-/i,           // claude-3-5-sonnet, claude-sonnet-4-20250514, etc.
  /^anthropic-/i,        // anthropic/ prefix (API format)
];

const KNOWN_CLAUDE_MODELS = new Set([
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-20240620",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "claude-3-haiku-20240307",
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
  "claude-3-opus-latest",
  "claude-3-sonnet-latest",
  "claude-3-haiku-latest",
]);

/**
 * 检查模型名是否为 Claude 模型。
 * 返回 true/false，不做拒绝。
 */
function isClaudeModel(modelName) {
  const model = String(modelName || "").trim().toLowerCase();
  if (!model) return false;
  if (KNOWN_CLAUDE_MODELS.has(model)) return true;
  if (CLAUDE_MODEL_PATTERNS.some((p) => p.test(model))) return true;
  if (/^claude-\d+(-\d+)?(-\w+)*-\d{8}$/.test(model)) return true;
  if (/^claude-\d+(-\d+)?(-\w+)*-latest$/.test(model)) return true;
  return false;
}

/** 模型名形态校验（v3.18.0 对齐 AO 0.9.6）：防 `[1m]` 这类终端形碎片被写进配置。 */
function isValidModelName(model) {
  const model_ = String(model || "").trim();
  return Boolean(model_) && model_.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model_);
}

function validateModelName(value) {
  const model = String(value || "").trim();
  if (!model) throw new Error("请填写模型名称。");
  if (model.length > 200 || /[\0\r\n]/.test(model)) throw new Error("模型名称无效。");
  // 终端形碎片（例如 "[1m"）会先被 Agent SDK 拒绝在聊天开始后——写入前直接拦下（v3.18.0 AO 同款）。
  if (!isValidModelName(model)) throw new Error("模型名称无效。");
  return model;
}

/** autoCompactWindow 读取（AO 0.9.6 同源）：缺省/auto=官方自动；固定值须在 100K~1M 之间。 */
function readAutoCompactWindow(settings) {
  const raw = settings.autoCompactWindow;
  if (raw === undefined || raw === null || String(raw).trim().toLowerCase() === "auto") {
    return { mode: "auto", tokens: null, valid: true };
  }
  const tokens = typeof raw === "number" ? raw : Number(String(raw).trim());
  const valid = Number.isInteger(tokens) && tokens >= AUTO_COMPACT_MIN_TOKENS && tokens <= AUTO_COMPACT_MAX_TOKENS;
  return valid
    ? { mode: "fixed", tokens, valid: true }
    : { mode: "invalid", tokens: null, valid: false, raw: String(raw) };
}

function validateAutoCompactWindow(value) {
  if (value === undefined || value === null || String(value).trim().toLowerCase() === "auto") return null;
  const tokens = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(tokens) || tokens < AUTO_COMPACT_MIN_TOKENS || tokens > AUTO_COMPACT_MAX_TOKENS) {
    throw new Error("自动压缩阈值必须在 100K 到 1M 之间，或选择自动。");
  }
  return tokens;
}

function readModelSettings(source) {
  let settings;
  try { settings = JSON.parse(String(source)); }
  catch { throw new Error("Claude settings.json 不是有效 JSON，未作任何修改。"); }
  if (!settings || Array.isArray(settings) || typeof settings !== "object") {
    throw new Error("Claude settings.json 格式无效，未作任何修改。");
  }
  const env = settings.env;
  if (!env || Array.isArray(env) || typeof env !== "object") {
    throw new Error("Claude settings.json 缺少 env 配置，未作任何修改。");
  }
  const models = Object.fromEntries(MODEL_ENV_KEYS.map((key) => [key, String(env[key] || "").trim()]));
  const values = Object.values(models);
  const configured = values.filter(Boolean);
  // v3.18.0 增量（additive，不改既有返回形状）：entries = 五项带 label/id/valid 明细；autoCompactWindow 状态
  const entries = MODEL_ENTRIES.map((entry) => {
    const value = String(env[entry.key] || "").trim();
    return { ...entry, model: value, configured: Boolean(value), valid: !value || isValidModelName(value) };
  });
  const invalidKeys = entries.filter((entry) => !entry.valid).map((entry) => entry.key);
  return {
    settings,
    models,
    model: configured[0] || "",
    consistent: configured.length === MODEL_ENV_KEYS.length && new Set(configured).size === 1,
    entries,
    autoCompactWindow: readAutoCompactWindow(settings),
    valid: invalidKeys.length === 0,
    invalidKeys
  };
}

function replaceModelSettings(source, modelName) {
  const model = validateModelName(modelName);
  const parsed = readModelSettings(source);
  const next = {
    ...parsed.settings,
    env: { ...parsed.settings.env }
  };
  for (const key of MODEL_ENV_KEYS) next.env[key] = model;
  return {
    model,
    settings: JSON.stringify(next, null, 2) + "\n",
    changedKeys: [...MODEL_ENV_KEYS]
  };
}

/** 五项单独修改（v3.18.0 F2，AO 0.9.6 replaceSingleModelSetting 同源）：只改一项，其余 env 原样保留。 */
function replaceSingleModelSetting(source, entryId, modelName) {
  const model = validateModelName(modelName);
  const entry = MODEL_ENTRIES.find((candidate) => candidate.id === String(entryId || ""));
  if (!entry) throw new Error("未知的 Claude 模型配置项，未作任何修改。");
  const parsed = readModelSettings(source);
  const next = { ...parsed.settings, env: { ...parsed.settings.env } };
  next.env[entry.key] = model;
  return {
    entry: { ...entry, model, configured: true, valid: true },
    model,
    settings: JSON.stringify(next, null, 2) + "\n",
    changedKeys: [entry.key]
  };
}

/** 自动压缩阈值写入（v3.18.0 F2，AO 0.9.6 replaceAutoCompactWindowSetting 同源）：auto=删键。 */
function replaceAutoCompactWindowSetting(source, value) {
  const tokens = validateAutoCompactWindow(value);
  const parsed = readModelSettings(source);
  const next = { ...parsed.settings };
  if (tokens === null) delete next.autoCompactWindow;
  else next.autoCompactWindow = tokens;
  return {
    autoCompactWindow: { mode: tokens === null ? "auto" : "fixed", tokens, valid: true },
    settings: JSON.stringify(next, null, 2) + "\n",
    changedKeys: ["autoCompactWindow"]
  };
}

module.exports = {
  AUTO_COMPACT_MAX_TOKENS,
  AUTO_COMPACT_MIN_TOKENS,
  MODEL_ENTRIES,
  MODEL_ENV_KEYS,
  isClaudeModel,
  readAutoCompactWindow,
  readModelSettings,
  replaceAutoCompactWindowSetting,
  replaceModelSettings,
  replaceSingleModelSetting,
  validateAutoCompactWindow,
  validateModelName
};