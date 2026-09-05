"use strict";

const MODEL_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL"
];

/**
 * Claude 模型名白名单 — 只允许 Claude 系列模型名。
 * 防止用户误输入云端 AI 模型名（如 glm-4-flash）导致 Bridge 崩溃。
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
 * 检查模型名是否为有效的 Claude 模型。
 * 允许：claude-* 前缀、已知 Claude 模型名、带日期后缀的 Claude 模型。
 * 拒绝：GLM、GPT、Gemini 等非 Claude 模型名。
 */
function isClaudeModel(modelName) {
  const model = String(modelName || "").trim().toLowerCase();
  if (!model) return false;

  // 已知 Claude 模型
  if (KNOWN_CLAUDE_MODELS.has(model)) return true;

  // 匹配 Claude 模型前缀模式
  if (CLAUDE_MODEL_PATTERNS.some((p) => p.test(model))) return true;

  // 带日期后缀的模式: claude-X-Y-YYYYMMDD
  if (/^claude-\d+(-\d+)?(-\w+)*-\d{8}$/.test(model)) return true;

  // claude-X-Y-latest
  if (/^claude-\d+(-\d+)?(-\w+)*-latest$/.test(model)) return true;

  return false;
}

function validateModelName(value) {
  const model = String(value || "").trim();
  if (!model) throw new Error("请填写模型名称。");
  if (model.length > 200 || /[\0\r\n]/.test(model)) throw new Error("模型名称无效。");
  return model;
}

/**
 * 验证模型名是否为 Claude 模型（用于 SSH/Bridge 模式）。
 * 非 Claude 模型名会导致 Claude Code 以 unrecognized_model 退出。
 */
function validateClaudeModel(modelName) {
  const model = String(modelName || "").trim();
  if (!model) throw new Error("请填写模型名称。");
  if (!isClaudeModel(model)) {
    throw new Error(
      `模型 "${model}" 不是 Claude 模型。\n` +
      `SSH/Bridge 模式仅支持 Claude 系列模型（如 claude-sonnet-4-20250514）。\n` +
      `如需使用 ${model}，请切换到云端 AI 模式。`
    );
  }
  return model;
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
  return {
    settings,
    models,
    model: configured[0] || "",
    consistent: configured.length === MODEL_ENV_KEYS.length && new Set(configured).size === 1
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

module.exports = { MODEL_ENV_KEYS, readModelSettings, replaceModelSettings, validateModelName, validateClaudeModel, isClaudeModel };