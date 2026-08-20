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

  // maxTokens
  if (mode.maxTokens) args.push("--max-tokens", String(mode.maxTokens));

  // thinkingLevel
  const thinkingFlag = THINKING_MAP[mode.thinkingLevel];
  if (thinkingFlag) args.push(thinkingFlag);

  // 权限模式
  if (mode.skipPermissions) {
    args.push("--allow-dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
  } else {
    args.push("--permission-mode", mode.permissionMode || "dontAsk");
  }

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
    modelConfig: mode.modelConfig || {}
  };
}

/**
 * 解析模式配置 — 合并内置/自定义模式和全局设置。
 * @param {string} modeId
 * @param {object} config - 全局连接配置
 * @returns {object} 最终的模式配置
 */
function resolveMode(modeId, config) {
  const fallback = BUILTIN_MODES.regular;
  const mode = getMode(modeId) || fallback;

  // 全局 skipPermissions 可以覆盖模式设置
  if (config?.skipPermissions && !mode.skipPermissions) {
    mode.skipPermissions = true;
    mode.permissionMode = "bypassPermissions";
  }

  return mode;
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

  // maxTokens
  if (mode.maxTokens) args.push("--max-tokens", String(mode.maxTokens));

  // thinkingLevel
  const thinkingFlag = THINKING_MAP[mode.thinkingLevel];
  if (thinkingFlag) args.push(thinkingFlag);

  // 权限模式
  if (mode.skipPermissions) {
    args.push("--allow-dangerously-skip-permissions", "--permission-mode", "bypassPermissions");
  } else {
    args.push("--permission-mode", mode.permissionMode || "dontAsk");
  }

  // 会话续接
  if (sessionId) args.push("--resume", sessionId);

  return args;
}

module.exports = { buildCommandWithMode, buildBridgeStartWithMode, buildLocalArgsWithMode, resolveMode, getHallucinationParams, getEnergyParams };