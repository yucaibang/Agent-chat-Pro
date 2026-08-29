import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PROTOCOL_VERSION = 1;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const permissions = new Map();
let startConfig;
let activeQuery;
let interruptPending = false;

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
    while (this.#waiters.length) this.#waiters.shift()({ value: undefined, done: true });
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
    return;
  }
  if (value.type === "permission_result") {
    settlePermission(String(value.id || ""), value.decision === "allow" ? "allow" : "deny");
    return;
  }
  if (value.type === "interrupt") {
    interruptPending = true;
    emit({ type: "bridge_interrupt_received", protocolVersion: PROTOCOL_VERSION });
    if (activeQuery) await activeQuery.interrupt();
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
  if (start.modelConfig && typeof start.modelConfig === "object") {
    Object.assign(options, start.modelConfig);
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
    messages.close();
    for (const id of [...permissions.keys()]) settlePermission(id, "deny");
    activeQuery?.close();
    input.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Agent SDK bridge failed: ${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});