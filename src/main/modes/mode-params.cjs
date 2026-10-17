"use strict";

/**
 * 模式参数映射 — 将 UI 层的模式参数转换为 CLI/API 参数。
 *
 * 用法：在构建命令或 Bridge start 消息时，调用 buildModeParams(mode, sessionId)
 * 将模式配置注入到命令行或 Bridge 协议中。
 */

const { BUILTIN_MODES, HALLUCINATION_MAP, ENERGY_MAP, THINKING_MAP } = require("./mode-defaults.cjs");
const { getMode } = require("./mode-manager.cjs");
const { shellQuote } = require("../protocol.cjs");

// v3.24.1：SSH/本机思考挡位合法值域（与 mode-manager validateThinkingLevel 同域）
const THINKING_LEVEL_VALUES = ["none", "low", "medium", "high"];

/**
 * 清理模型名 — 移除上下文窗口标记等非标准后缀。
 * 例如: "glm-5.1:cloud[1m]" → "glm-5.1:cloud"
 *       "deepseek-chat[128k]" → "deepseek-chat"
 *       "claude-sonnet-4-20250514" → "claude-sonnet-4-20250514"（不变）
 */
function sanitizeModelName(model) {
  if (typeof model !== "string") return model;
  return model.replace(/\[[^\]]*\]$/g, "").trim() || model;
}

/**
 * 根据模式 ID 构建完整的 CLI 参数列表。
 * @param {string} modeId - 模式 ID（内置或自定义）
 * @param {string} prompt - 用户消息
 * @param {string|null} sessionId - 会话 ID（续接时传入）
 * @param {object} config - 连接配置（含 wakeName, workingDirectory, skipPermissions 等）
 * @returns {string} 完整的命令行字符串
 */
function buildCommandWithMode(modeId, prompt, sessionId, config) {
  const mode = resolveMode(modeId, config);
  const args = ["-p", prompt, "--output-format", "stream-json", "--include-partial-messages", "--verbose"];

  // model：清理模型名后缀（如 [1m]），传给 --model 参数
  if (mode.modelConfig?.model) {
    const cleanModel = sanitizeModelName(mode.modelConfig.model);
    if (cleanModel) args.push("--model", cleanModel);
  }

  // maxTokens
  if (mode.maxTokens) args.push("--max-tokens", String(mode.maxTokens));

  // thinkingLevel
  const thinkingFlag = THINKING_MAP[mode.thinkingLevel];
  if (thinkingFlag) args.push(thinkingFlag);

  // 权限模式：SSH 直连无法交互确认权限，统一使用 bypassPermissions
  // Bridge 模式通过 onPermissionRequest 回调实现交互式确认
  args.push("--allow-dangerously-skip-permissions", "--permission-mode", "bypassPermissions");

  // 会话续接
  if (sessionId) args.push("--resume", sessionId);

  const wakeName = String(config.wakeName || "claude").trim();
  const command = [wakeName, ...args].map(shellQuote).join(" ");
  const workingDirectory = String(config.workingDirectory || "").trim();
  return workingDirectory
    ? `cd -- ${shellQuote(workingDirectory)} && exec ${command}`
    : `exec ${command}`;
}

/**
 * 构建 Bridge start 消息参数（用于 Bridge 模式）。
 * @param {string} modeId - 模式 ID
 * @param {string} prompt - 用户消息
 * @param {string|null} sessionId - 会话 ID
 * @param {object} config - 连接配置
 * @returns {object} Bridge start 消息对象
 */
function buildBridgeStartWithMode(modeId, prompt, sessionId, config) {
  const mode = resolveMode(modeId, config);
  // 清理 modelConfig 中的模型名后缀（如 [1m]、[128k]），避免 CLI 报 unrecognized_model
  const rawModelConfig = mode.modelConfig || {};
  const modelConfig = { ...rawModelConfig };
  if (modelConfig.model && typeof modelConfig.model === "string") {
    modelConfig.model = sanitizeModelName(modelConfig.model);
  }
  return {
    type: "start",
    prompt,
    automatic: Boolean(mode.skipPermissions),
    workingDirectory: config.workingDirectory || "",
    claudePath: config.wakeName || "claude",
    sessionId: sessionId || "",
    // Pro 扩展参数
    maxTokens: mode.maxTokens,
    thinkingLevel: mode.thinkingLevel,
    hallucinationControl: mode.hallucinationControl,
    energyPriority: mode.energyPriority,
    systemPrompt: mode.systemPrompt || "",
    modelConfig
  };
}

/**
 * v3.24.1：挡位偏好覆盖（纯函数供直测）— settings.thinkingChoices.ssh[modeId] 高于模式默认挡位。
 * 挡位属会话偏好（与云端 thinkingChoices.cloud[provider/model] 同构），不写模式定义——
 * v3.24.0 装机 bug 修复：内置工作模式上调整挡位不再撞「内置模式不可修改」守卫。
 * @param {object} mode - 模式对象（应为副本）
 * @param {string} modeId - 工作模式 ID
 * @param {object} thinkingChoices - settings.thinkingChoices（{ ssh: { [modeId]: level } }）
 * @returns {object} 覆盖后的模式对象（无合法偏好时原样返回）
 */
function applyThinkingChoice(mode, modeId, thinkingChoices) {
  if (!mode) return mode;
  const choice = String((thinkingChoices?.ssh || {})[modeId] || "").trim();
  if (THINKING_LEVEL_VALUES.includes(choice)) return { ...mode, thinkingLevel: choice };
  return mode;
}

/** 读取 settings.thinkingChoices（settings.cjs 依赖 electron，延迟 require + 兜底，不污染纯函数测试） */
function readThinkingChoices() {
  try { return ((require("../settings.cjs").getSettings() || {}).thinkingChoices) || {}; }
  catch { return {}; }
}

/**
 * 解析模式配置 — 合并内置/自定义模式、全局设置和挡位偏好。
 * @param {string} modeId
 * @param {object} config - 全局连接配置
 * @returns {object} 最终的模式配置
 */
function resolveMode(modeId, config) {
  const fallback = BUILTIN_MODES.regular;
  // v3.24.1：保证副本——fallback 是 BUILTIN_MODES 常量引用，后续字段覆盖不得污染内置常量
  const mode = { ...(getMode(modeId) || fallback) };

  // 全局 skipPermissions 可以覆盖模式设置
  if (config?.skipPermissions && !mode.skipPermissions) {
    mode.skipPermissions = true;
    mode.permissionMode = "bypassPermissions";
  }

  // v3.24.1：挡位偏好覆盖（SSH/Bridge/本机三链共用此汇聚点；未调整时用模式默认挡位）
  return applyThinkingChoice(mode, modeId, readThinkingChoices());
}

/**
 * 获取幻觉抑制参数（用于未来 API 模式）。
 * @param {string} level - strict | standard | creative
 * @returns {{ temperature: number, topP: number }}
 */
function getHallucinationParams(level) {
  return HALLUCINATION_MAP[level] || HALLUCINATION_MAP.standard;
}

/**
 * 获取能耗优先参数（用于未来 API 模式）。
 * @param {string} priority - quality | balanced | economy
 * @returns {{ maxTurns: number|null }}
 */
function getEnergyParams(priority) {
  return ENERGY_MAP[priority] || ENERGY_MAP.balanced;
}

/**
 * 构建本地模式 CLI 参数数组（用于 spawn 调用）。
 * 注意：-p 标志不带参数值，prompt 通过 stdin 传入。
 * @param {string} modeId - 模式 ID
 * @param {string|null} sessionId - 会话 ID
 * @param {object} config - 连接配置
 * @returns {string[]} CLI 参数数组（不含命令名）
 */
function buildLocalArgsWithMode(modeId, sessionId, config) {
  const mode = resolveMode(modeId, config);
  const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];

  // model：清理模型名后缀（如 [1m]），传给 --model 参数
  if (mode.modelConfig?.model) {
    const cleanModel = sanitizeModelName(mode.modelConfig.model);
    if (cleanModel) args.push("--model", cleanModel);
  }

  // maxTokens
  if (mode.maxTokens) args.push("--max-tokens", String(mode.maxTokens));

  // thinkingLevel
  const thinkingFlag = THINKING_MAP[mode.thinkingLevel];
  if (thinkingFlag) args.push(thinkingFlag);

  // 权限模式：本机模式同样无法交互确认权限，统一使用 bypassPermissions
  args.push("--allow-dangerously-skip-permissions", "--permission-mode", "bypassPermissions");

  // 会话续接
  if (sessionId) args.push("--resume", sessionId);

  return args;
}

module.exports = { buildCommandWithMode, buildBridgeStartWithMode, buildLocalArgsWithMode, resolveMode, applyThinkingChoice, getHallucinationParams, getEnergyParams, sanitizeModelName };