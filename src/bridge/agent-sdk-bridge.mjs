import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PROTOCOL_VERSION = 1;

class MessageQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
    return true;
  }

  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() { return this; }

  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const messages = new MessageQueue();
const permissions = new Map();
let startConfig;
let activeQuery;
let interruptPending = false;

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function userMessage(text) {
  return {
    type: "user",
    message: { role: "user", content: String(text || "") },
    parent_tool_use_id: null
  };
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
  emit({
    type: "bridge_permission_request",
    protocolVersion: PROTOCOL_VERSION,
    id,
    toolName,
    input: toolInput
  });
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
    messages.push(userMessage(value.prompt));
    notifyStart(value);
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
  handleControl(value).catch((error) => {
    emit({ type: "bridge_control_error", message: String(error?.message || error) });
  });
});

input.on("close", () => messages.close());

const startPromise = { resolve: null, reject: null };
const startReady = new Promise((resolve, reject) => { startPromise.resolve = resolve; startPromise.reject = reject; });

function notifyStart(config) {
  startPromise.resolve(config);
}

async function waitForStart() {
  if (startConfig) return startConfig;
  const timer = setTimeout(() => startPromise.reject(new Error("等待客户端启动消息超时。")), 15_000);
  try { return await startReady; } finally { clearTimeout(timer); }
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

  // ── Pro 扩展参数映射 ──
  // maxTokens → maxTokens
  if (start.maxTokens && Number.isFinite(Number(start.maxTokens))) {
    options.maxTokens = Number(start.maxTokens);
  }
  // thinkingLevel → thinkingLevel (none/low/medium/high)
  if (start.thinkingLevel && ["none", "low", "medium", "high"].includes(start.thinkingLevel)) {
    options.thinkingLevel = start.thinkingLevel;
  }
  // hallucinationControl → temperature + topP
  const hallucinationMap = { strict: { temperature: 0.3, topP: 0.85 }, standard: { temperature: 0.7, topP: 0.95 }, creative: { temperature: 0.9, topP: 0.98 } };
  const hallucination = hallucinationMap[start.hallucinationControl] || hallucinationMap.standard;
  options.temperature = hallucination.temperature;
  options.topP = hallucination.topP;
  // energyPriority → maxTurns
  const energyMap = { quality: 200, balanced: 20, economy: 8 };
  if (start.energyPriority && energyMap[start.energyPriority]) {
    options.maxTurns = energyMap[start.energyPriority];
  }
  // systemPrompt → systemPrompt
  if (start.systemPrompt && String(start.systemPrompt).trim()) {
    options.systemPrompt = String(start.systemPrompt).trim();
  }
  // modelConfig → spread into options
  if (start.modelConfig && typeof start.modelConfig === "object") {
    Object.assign(options, start.modelConfig);
  }

  if (!automatic) options.canUseTool = requestPermission;

  emit({ type: "bridge_ready", protocolVersion: PROTOCOL_VERSION });
  activeQuery = query({ prompt: messages, options });
  if (interruptPending) await activeQuery.interrupt();

  try {
    for await (const message of activeQuery) {
      emit(message);
      if (message?.type === "result") break;
    }
  } finally {
    for (const id of [...permissions.keys()]) settlePermission(id, "deny");
    messages.close();
    activeQuery?.close();
    input.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Agent SDK bridge failed: ${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
