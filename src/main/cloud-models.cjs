"use strict";
// v3.21.0 云端「拉取模型列表」：走各服务商官方 GET /models 实时拉取当前密钥可用的全部模型。
// 设计要点：
// - 9 家均支持 OpenAI 兼容模型列表端点（响应为 { data: [ { id, ... } ] }）；
//   响应为 Anthropic 形态时额外使用 display_name 做标签。
// - 例外：豆包（火山方舟）没有模型列表端点，模型 ID 带日期尾标且持续更新，
//   标记 unsupported，引导用户走内置清单 / 手填 Model ID。
// - custom（中转站）按 baseUrl 现拼 <baseUrl>/models（OpenAI 兼容约定）。
// 主进程只负责发请求与解析，密钥由渲染层现值传入（留空时由 main.cjs 用已存密钥兜底）。

const DEFAULT_TIMEOUT_MS = 15000;

// 每家固定拉取端点；auth: "bearer" = Authorization: Bearer <key>，「anthropic」= x-api-key + anthropic-version。
const PULL_ENDPOINTS = {
  zhipu: { url: "https://open.bigmodel.cn/api/paas/v4/models", auth: "bearer" },
  deepseek: { url: "https://api.deepseek.com/models", auth: "bearer" },
  kimi: { url: "https://api.moonshot.cn/v1/models", auth: "bearer" },
  openai: { url: "https://api.openai.com/v1/models", auth: "bearer" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/models", auth: "bearer" },
  anthropic: { url: "https://api.anthropic.com/v1/models", auth: "anthropic" },
  xai: { url: "https://api.x.ai/v1/models", auth: "bearer" },
  siliconflow: { url: "https://api.siliconflow.cn/v1/models", auth: "bearer" }
};

const DOUBAO_UNSUPPORTED_REASON =
  "豆包（火山方舟）没有模型列表接口：模型 ID 带日期尾标（如 doubao-seed-2-1-pro-260915）且持续更新，请从内置清单选择，或直接粘贴 Model ID。";

// custom 的 baseUrl 允许写 /v1/ 或裸根；去掉尾部斜杠后统一拼 /models
function modelsUrlForCustom(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return `${trimmed}/models`;
}

function authHeaders(auth, apiKey) {
  if (!apiKey) return {};
  if (auth === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

// 解析各家响应：统一提取 { id, displayName? } 有序去重列表。
// - OpenAI 形态：data[].id
// - Anthropic 形态：data[].id + data[].display_name
// - 有些中转站返回 models[]（非 OpenAI 标准），兜底识别
function modelsFromPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : typeof row?.name === "string" ? row.name.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof row?.display_name === "string" ? row.display_name.trim() : "";
    models.push({ value: id, label: displayName && displayName !== id ? `${displayName}（${id}）` : id });
  }
  return models;
}

function chineseErrorForStatus(status) {
  if (status === 401 || status === 403) return "密钥无效或无权限访问模型列表";
  if (status === 404) return "服务商未提供模型列表接口（404）";
  if (status === 429) return "请求过于频繁（429），稍后再试";
  return `请求失败（HTTP ${status}）`;
}

async function fetchProviderModels(payload = {}, fetchImpl = globalThis.fetch) {
  const provider = String(payload.provider || "").trim();
  const apiKey = String(payload.apiKey || "").trim();
  const baseUrl = String(payload.baseUrl || "").trim();
  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : DEFAULT_TIMEOUT_MS;

  if (provider === "doubao") {
    return { ok: false, unsupported: true, reason: DOUBAO_UNSUPPORTED_REASON, models: [] };
  }

  const endpoint = PULL_ENDPOINTS[provider === "custom" ? null : provider];
  const url = provider === "custom" ? modelsUrlForCustom(baseUrl) : endpoint?.url || "";
  if (!url) {
    return { ok: false, reason: provider === "custom" && !baseUrl ? "请先填写 API 地址再拉取" : "不认识的服务商，无法拉取模型列表", models: [] };
  }
  if (!apiKey && provider !== "custom") {
    return { ok: false, reason: "请先填写 API 密钥再拉取", models: [] };
  }

  const headers = { Accept: "application/json", ...authHeaders(endpoint?.auth || "bearer", apiKey) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, reason: chineseErrorForStatus(response.status), models: [] };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "响应不是合法 JSON，请检查 API 地址是否指向正确的服务商", models: [] };
    }
    const models = modelsFromPayload(parsed);
    if (models.length === 0) {
      return { ok: false, reason: "接口返回了空模型列表（该密钥可能未开通任何模型）", models: [] };
    }
    return { ok: true, count: models.length, models };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return { ok: false, reason: aborted ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : `网络错误：${error?.message || "未知"}`, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchProviderModels, PULL_ENDPOINTS, modelsFromPayload, modelsUrlForCustom, DOUBAO_UNSUPPORTED_REASON };