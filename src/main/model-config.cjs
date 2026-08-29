"use strict";

const MODEL_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL"
];

function validateModelName(value) {
  const model = String(value || "").trim();
  if (!model) throw new Error("请填写模型名称。");
  if (model.length > 200 || /[\0\r\n]/.test(model)) throw new Error("模型名称无效。");
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

module.exports = { MODEL_ENV_KEYS, readModelSettings, replaceModelSettings, validateModelName };