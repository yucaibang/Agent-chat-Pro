import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PROTOCOL_VERSION = 1;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const permissions = new Map();
let startConfig;
let activeQuery;
let interruptPending = false;
let forceCloseTimer;

const FORCE_CLOSE_AFTER_INTERRUPT_MS = 1_500;

class MessageQueue {
  #items = [];
  #waiters = [];
  #closed = false;

  push(value) {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#items.push(value);
    return true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length) this.#waiters.shift({ value: undefined, done: true });
  }

  async next() {
    if (this.#items.length) return { value: this.#items.shift(), done: false };
    if (this.#closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator]() { return this; }
}

const messages = new MessageQueue();

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function scheduleForceClose(reason, delayMs = FORCE_CLOSE_AFTER_INTERRUPT_MS) {
  if (!activeQuery) return;
  if (forceCloseTimer) clearTimeout(forceCloseTimer);
  forceCloseTimer = setTimeout(() => {
    forceCloseTimer = undefined;
    try {
      activeQuery?.close();
      emit({ type: "bridge_query_force_closed", protocolVersion: PROTOCOL_VERSION, reason });
    } catch (error) {
      emit({ type: "bridge_control_error", message: String(error?.message || error) });
    }
  }, delayMs);
  forceCloseTimer.unref?.();
}

function userMessage(text, priority) {
  const value = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: String(text || "") }] },
    parent_tool_use_id: null,
    shouldQuery: true,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    origin: { kind: "human" }
  };
  if (priority) value.priority = priority;
  return value;
}

function settlePermission(id, decision) {
  const pending = permissions.get(id);
  if (!pending) return;
  permissions.delete(id);
  pending.cleanup();
  if (decision === "allow") pending.resolve({ behavior: "allow", updatedInput: pending.input });
  else pending.resolve({ behavior: "deny", message: "用户拒绝了此工具操作。" });
}

function requestPermission(toolName, toolInput, context) {
  const id = randomUUID();
  emit({ type: "bridge_permission_request", protocolVersion: PROTOCOL_VERSION, id, toolName, input: toolInput });
  return new Promise((resolve) => {
    const abort = () => settlePermission(id, "deny");
    context?.signal?.addEventListener("abort", abort, { once: true });
    permissions.set(id, {
      input: toolInput,
      resolve,
      cleanup: () => context?.signal?.removeEventListener("abort", abort)
    });
  });
}

async function handleControl(value) {
  if (!value || typeof value !== "object") return;
  if (value.type === "start" && !startConfig) {
    startConfig = value;
    return;
  }
  if (value.type === "follow_up") {
    const text = String(value.message || "").trim();
    if (!text || !messages.push(userMessage(text, "next"))) {
      emit({ type: "bridge_follow_up_rejected", protocolVersion: PROTOCOL_VERSION, id: String(value.id || "") });
      return;
    }
    emit({ type: "bridge_follow_up_received", protocolVersion: PROTOCOL_VERSION, id: String(value.id || "") });
    return;
  }
  if (value.type === "close_input") {
    messages.close();
    if (interruptPending) scheduleForceClose("interrupt-input-closed");
    return;
  }
  if (value.type === "permission_result") {
    settlePermission(String(value.id || ""), value.decision === "allow" ? "allow" : "deny");
    return;
  }
  if (value.type === "interrupt") {
    interruptPending = true;
    emit({ type: "bridge_interrupt_received", protocolVersion: PROTOCOL_VERSION });
    if (activeQuery) {
      scheduleForceClose("interrupt-timeout");
      await activeQuery.interrupt();
    }
  }
}

input.on("line", (line) => {
  let value;
  try { value = JSON.parse(line); }
  catch {
    emit({ type: "bridge_protocol_error", message: "无法解析客户端控制消息。" });
    return;
  }
  handleControl(value).catch((error) => emit({ type: "bridge_control_error", message: String(error?.message || error) }));
});

input.on("close", () => messages.close());

async function waitForStart() {
  if (startConfig) return startConfig;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("等待客户端启动消息超时。")), 15_000);
    const poll = setInterval(() => { if (startConfig) finish(resolve, startConfig); }, 25);
  });
}

/**
 * 清理模型名 — 移除上下文窗口标记等非标准后缀。
 * 例如: "glm-5.1:cloud[1m]" → "glm-5.1:cloud"
 *       "deepseek-chat[128k]" → "deepseek-chat"
 *       "claude-sonnet-4-20250514" → "claude-sonnet-4-20250514"（不变）
 */
function sanitizeModelName(model) {
  if (typeof model !== "string") return model;
  // 移除 [xxx] 后缀（上下文窗口标记）
  return model.replace(/\[[^\]]*\]$/g, "").trim() || model;
}

/**
 * 已知 Claude 模型 ID 前缀。
 * 用于判断用户指定的模型是否是 Claude 原生模型。
 * 如果不是，则需要注入 modelOverrides 确保 Claude Code 内部路径正常工作。
 */
const CLAUDE_MODEL_PREFIXES = ["claude-", "anthropic-"];

/**
 * Claude Code 内部可能使用的模型 ID。
 * 当用户使用非 Claude 模型时，这些 ID 需要通过 modelOverrides 映射到用户的模型，
 * 以确保标题生成（Haiku 路径）、子代理调用等内部操作使用正确的模型名。
 *
 * 覆盖范围：
 * - 当前代（2025）：claude-haiku-4-5, claude-sonnet-4-*, claude-opus-4-*
 * - 上一代（2024）：claude-3-5-haiku, claude-3-5-sonnet, claude-3-opus, claude-3-haiku
 */
const CLAUDE_INTERNAL_MODEL_IDS = [
  // 当前代（2025）
  "claude-haiku-4-5",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5",
  "claude-opus-4-20250514",
  "claude-opus-4-5",
  // 上一代（2024）
  "claude-3-5-haiku-20241022",
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229",
  "claude-3-haiku-20240307",
  "claude-3-5-sonnet-20240620",
];

/**
 * 判断模型名是否为 Claude 原生模型。
 * 如果是，则不需要 modelOverrides；如果不是，则需要映射。
 */
function isClaudeModel(model) {
  if (typeof model !== "string" || !model.trim()) return true; // 空或非字符串视为 Claude（不覆盖）
  const lower = model.toLowerCase().trim();
  return CLAUDE_MODEL_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/**
 * 构建模型覆盖映射。
 * 将所有 Claude 内部模型 ID 映射到用户指定的模型，确保 Claude Code 的
 * 标题生成、子代理等内部路径使用正确的模型名。
 *
 * @param {string} userModel - 用户指定的模型名（已清理后缀）
 * @returns {Object} modelOverrides 映射对象
 */
function buildModelOverrides(userModel) {
  const overrides = {};
  for (const claudeId of CLAUDE_INTERNAL_MODEL_IDS) {
    overrides[claudeId] = userModel;
  }
  return overrides;
}

async function main() {
  const start = await waitForStart();
  const automatic = Boolean(start.automatic);
  const options = {
    cwd: String(start.workingDirectory || process.env.HOME || process.cwd()),
    pathToClaudeCodeExecutable: String(start.claudePath || ""),
    resume: start.sessionId ? String(start.sessionId) : undefined,
    permissionMode: automatic ? "bypassPermissions" : "default",
    allowDangerouslySkipPermissions: automatic,
    includePartialMessages: true,
    maxTurns: 20,
    settingSources: ["user", "project", "local"]
  };
  if (!automatic) options.canUseTool = requestPermission;

  // ── Pro 扩展参数映射 ──
  if (start.maxTokens && Number.isFinite(Number(start.maxTokens))) {
    options.maxTokens = Number(start.maxTokens);
  }
  if (start.thinkingLevel && ["none", "low", "medium", "high"].includes(start.thinkingLevel)) {
    options.thinkingLevel = start.thinkingLevel;
  }
  const hallucinationMap = { strict: { temperature: 0.3, topP: 0.85 }, standard: { temperature: 0.7, topP: 0.95 }, creative: { temperature: 0.9, topP: 0.98 } };
  const hallucination = hallucinationMap[start.hallucinationControl] || hallucinationMap.standard;
  options.temperature = hallucination.temperature;
  options.topP = hallucination.topP;
  const energyMap = { quality: 200, balanced: 20, economy: 8 };
  if (start.energyPriority && energyMap[start.energyPriority]) {
    options.maxTurns = energyMap[start.energyPriority];
  }
  if (start.systemPrompt && String(start.systemPrompt).trim()) {
    options.systemPrompt = String(start.systemPrompt).trim();
  }

  // ── 模型名全兼容处理 ──
  // 所有模型名都直接传给 Claude Code CLI，不做白名单限制。
  // 清理模型名中的非标准后缀（如 [1m]、[128k] 上下文窗口标记），
  // 这些后缀会导致 Claude Code 报 unrecognized_model 错误。
  // 非Claude模型自动注入 modelOverrides，确保内部路径（标题生成/子代理等）
  // 使用正确的模型名，无需手动修改 settings.json。
  if (start.modelConfig && typeof start.modelConfig === "object") {
    const modelConfig = { ...start.modelConfig };
    if (modelConfig.model && typeof modelConfig.model === "string") {
      const originalModel = modelConfig.model;
      modelConfig.model = sanitizeModelName(modelConfig.model);
      if (originalModel !== modelConfig.model) {
        emit({ type: "bridge_model_sanitized", protocolVersion: PROTOCOL_VERSION, originalModel, sanitizedModel: modelConfig.model });
      }
      // 非Claude模型：自动注入 modelOverrides
      // 将所有 Claude 内部模型 ID 映射到用户模型，
      // 解决标题生成（Haiku路径）等内部操作的 unrecognized_model 错误。
      if (!isClaudeModel(modelConfig.model)) {
        const overrides = buildModelOverrides(modelConfig.model);
        options.settings = {
          ...(options.settings && typeof options.settings === "object" ? options.settings : {}),
          modelOverrides: overrides,
        };
        emit({ type: "bridge_model_overrides_applied", protocolVersion: PROTOCOL_VERSION, model: modelConfig.model, overrideTargets: Object.keys(overrides) });
      }
    }
    Object.assign(options, modelConfig);
  }

  emit({ type: "bridge_ready", protocolVersion: PROTOCOL_VERSION, mode: "streaming-input" });
  messages.push(userMessage(String(start.prompt || "")));
  activeQuery = query({ prompt: messages, options });
  if (interruptPending) await activeQuery.interrupt();

  try {
    for await (const message of activeQuery) {
      emit(message);
      if (message?.type === "result") emit({ type: "bridge_turn_complete", protocolVersion: PROTOCOL_VERSION });
    }
  } finally {
    if (forceCloseTimer) clearTimeout(forceCloseTimer);
    messages.close();
    for (const id of [...permissions.keys()]) settlePermission(id, "deny");
    // 仅在 interrupt pending 时 force close，正常结束不需要
    if (interruptPending) activeQuery?.close();
    input.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Agent SDK bridge failed: ${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});