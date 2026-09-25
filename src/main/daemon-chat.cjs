"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { inspectLocalFiles } = require("./local.cjs");
const { buildLocalAttachmentNote, writeLocalAttachments, validatedWorkingDirectory } = require("./local.cjs");

/**
 * AtomCode（本机 daemon 引擎）— atomcode-daemon HTTP API 适配层
 *
 * 对接 atomcode-daemon（Axum + SSE）：
 * - GET  /health      连接测试（返回 version）
 * - GET  /models      Provider 模型列表
 * - POST /chat        聊天（SSE 流式，事件带 type 字段）
 * - POST /chat/stop   停止当前聊天
 *
 * SSE 事件（官方 README，v5.1.0）：text / reasoning / tool_start / tool_output /
 * tool_progress / tool_result / tokens / artifact_start|content|end / done / stopped / error
 * 注意：官方文档未标注各事件的确切字段名，解析层对 text/delta/content/chunk 做容错提取。
 */

const MAX_REQUEST_MS = 30 * 60 * 1000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15 * 1000;
const HEALTH_TIMEOUT_MS = 8 * 1000;
const TOOL_RESULT_SUMMARY_LIMIT = 180;

// ────────────────────────────────────────────
//  基础设施
// ────────────────────────────────────────────

function daemonBaseUrl(config) {
  const host = String(config?.atomcodeHost || "127.0.0.1").trim() || "127.0.0.1";
  const port = Number(config?.atomcodePort || 13456);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AtomCode daemon 端口无效（应为 1-65535）。");
  return `http://${host}:${port}`;
}

/** 读取 daemon 启动时自动生成的 token 文件：~/.atomcode/daemon-<port>.json */
function readDaemonTokenFile(port) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home) return "";
  const file = path.join(home, ".atomcode", `daemon-${Number(port || 13456)}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of ["token", "api_key", "auth_token", "accessToken", "access_token"]) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch { /* 文件不存在或非 JSON → 视为无 token */ }
  return "";
}

function resolveDaemonToken(config) {
  const configured = String(config?.atomcodeToken || "").trim();
  return configured || readDaemonTokenFile(config?.atomcodePort);
}

function daemonHeaders(config, extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  const token = resolveDaemonToken(config);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function cancellationError() {
  const error = new Error("已停止生成。");
  error.cancelled = true;
  return error;
}

function friendlyDaemonError(error) {
  const code = error?.code;
  const msg = error?.message || String(error || "");
  if (code === "ECONNREFUSED") return new Error("无法连接 AtomCode daemon（连接被拒绝）。请确认 atomcode-daemon 已启动，且设置中的主机/端口正确。");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new Error("AtomCode daemon 主机地址无法解析，请检查设置中的主机名。");
  if (code === "ECONNRESET" || code === "EPIPE") return new Error("AtomCode daemon 连接被重置，daemon 可能已退出。");
  if (/timeout/i.test(msg)) return new Error("连接 AtomCode daemon 超时，请检查地址/端口/防火墙设置。");
  return new Error(`AtomCode daemon 连接失败：${msg}`);
}

/** 非流式请求（health / models / stop） */
function rawRequest(config, method, urlPath, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = (value) => { if (!settled) { settled = true; resolve(value); } };
    const safeReject = (error) => { if (!settled) { settled = true; reject(error); } };
    let req;
    try {
      const url = new URL(urlPath, `${daemonBaseUrl(config)}/`);
      const payload = bodyObj === null || bodyObj === undefined ? null : JSON.stringify(bodyObj);
      const headers = daemonHeaders(config, payload ? { "Content-Length": Buffer.byteLength(payload) } : {});
      req = http.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => safeResolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks) }));
        res.on("error", (error) => safeReject(error));
      });
      req.on("error", (error) => safeReject(error));
      req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
      if (payload) req.write(payload);
      req.end();
    } catch (error) {
      safeReject(error);
    }
  });
}

// ────────────────────────────────────────────
//  连接测试 / 模型列表 / 停止
// ────────────────────────────────────────────

async function verifyAtomCodeConnection(config, onLog) {
  let health;
  try {
    health = await rawRequest(config, "GET", "/health", null, HEALTH_TIMEOUT_MS);
  } catch (error) {
    throw friendlyDaemonError(error);
  }
  if (health.statusCode === 401) throw new Error("AtomCode daemon 要求 token 认证（401）：请把 ~/.atomcode/daemon-<端口>.json 中的 token 填入设置（留空会自动读取该文件）。");
  if (health.statusCode !== 200) throw new Error(`AtomCode daemon 返回 HTTP ${health.statusCode}，请确认该地址是 atomcode-daemon 服务。`);
  let parsed = {};
  try { parsed = JSON.parse(health.body.toString("utf8") || "{}"); } catch { /* 非 JSON → 仍按就绪处理 */ }
  const version = String(parsed.version || "").trim();
  onLog?.("atomcode_daemon_verify", { version: version || "unknown", service: String(parsed.service || "") });

  let modelNote = "";
  try {
    const models = await rawRequest(config, "GET", "/models", null, HEALTH_TIMEOUT_MS);
    if (models.statusCode === 200) {
      const list = JSON.parse(models.body.toString("utf8") || "[]");
      if (Array.isArray(list) && list.length) {
        const fallback = list.find((item) => item?.is_default) || list[0];
        modelNote = `，可用模型 ${list.length} 个（默认 ${String(fallback?.model || "未知")}）`;
      }
    }
  } catch { /* 模型列表失败不影响连接测试结论 */ }
  return `AtomCode daemon 已就绪${version ? `（v${version}）` : ""}${modelNote}`;
}

async function listAtomCodeModels(config) {
  const result = await rawRequest(config, "GET", "/models", null, HEALTH_TIMEOUT_MS);
  if (result.statusCode !== 200) throw new Error(`获取模型列表失败（HTTP ${result.statusCode}）。`);
  const list = JSON.parse(result.body.toString("utf8") || "[]");
  return Array.isArray(list) ? list : [];
}

async function stopDaemonChat(config, sessionId) {
  const body = sessionId ? { session_id: sessionId } : {};
  const result = await rawRequest(config, "POST", "/chat/stop", body, 5000);
  return result.statusCode === 200;
}

// ────────────────────────────────────────────
//  SSE 解析与事件映射
// ────────────────────────────────────────────

function extractText(ev) {
  const value = ev?.text ?? ev?.delta ?? ev?.content ?? ev?.chunk;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function parseToolArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string" && raw.trim()) {
    try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") return parsed; } catch { /* 非 JSON */ }
    return { value: raw };
  }
  return {};
}

function summarizeToolResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.replace(/\s+/g, " ").slice(0, TOOL_RESULT_SUMMARY_LIMIT);
}

function collectPathsFromInput(input, paths) {
  for (const key of ["file_path", "path", "notebook_path", "file"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) paths.add(value.trim());
  }
}

function collectPathsFromText(value, paths) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const matches = text.match(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"`<>|]+[\\/])*[^\s'"`<>|]+\.(?:png|jpe?g|gif|webp|pdf|txt|md|json|csv|zip|docx|xlsx|pptx)/gi) || [];
  matches.forEach((filePath) => paths.add(filePath.replace(/[),.;:]+$/, "")));
}

function normalizePath(value) {
  return process.platform === "win32" ? String(value).toLocaleLowerCase() : String(value);
}

// ────────────────────────────────────────────
//  聊天主流程（契约同 runLocalClaude：{ promise, cancel }）
// ────────────────────────────────────────────

function runAtomCodeChat(config, message, sessionId, attachments = [], callbacks = {}) {
  let cancelled = false;
  let daemonError = null;
  let receivedAnyEvent = false;
  let req;
  let idleTimer;
  let connectTimer;
  let requestTimer;

  const operation = (async () => {
    requestTimer = setTimeout(() => {
      cancelled = true;
      stopDaemonChat(config, sessionId).catch(() => {});
    }, MAX_REQUEST_MS);
    requestTimer.unref?.();

    callbacks.onStatus?.("local-starting");
    const uploaded = await writeLocalAttachments(config.localUploadDirectory, attachments, callbacks.conversationId, callbacks.onUploadProgress);
    const prompt = message + buildLocalAttachmentNote(uploaded);
    const workingDir = validatedWorkingDirectory(config.workingDirectory);
    callbacks.onLog?.("atomcode_chat_start", {
      hasSession: Boolean(sessionId),
      attachmentCount: uploaded.length,
      baseUrl: daemonBaseUrl(config),
      hasToken: Boolean(resolveDaemonToken(config)),
      workingDirectory: config.workingDirectory || ""
    });
    callbacks.onStatus?.("connecting");

    const payload = { message: prompt };
    if (sessionId) payload.session_id = sessionId;
    if (workingDir) payload.working_dir = workingDir;

    let responseText = "";
    let usage;
    let nextSessionId = "";
    const tools = new Map();
    const outputPaths = new Set();

    const emitTool = (tool) => callbacks.onToolEvent?.(tool);
    const findOpenToolByName = (name) => [...tools.values()].reverse().find((tool) => tool.name === name && tool.status === "running");

    const handleDaemonEvent = (ev, fallbackType) => {
      const type = ev?.type || fallbackType || "";
      receivedAnyEvent = true;
      switch (type) {
        case "text": {
          const text = extractText(ev);
          if (text) {
            responseText += text;
            callbacks.onDelta?.(text);
          }
          break;
        }
        case "reasoning": {
          // 对齐 claude 路径：思考内容不渲染，只记日志
          const text = extractText(ev);
          if (text) callbacks.onLog?.("atomcode_reasoning", { length: text.length });
          break;
        }
        case "tool_start": {
          const id = String(ev.id ?? ev.tool_id ?? `tool-${tools.size + 1}`);
          const tool = {
            id,
            name: String(ev.name ?? ev.tool ?? "工具"),
            status: "running",
            input: parseToolArguments(ev.arguments ?? ev.input ?? ev.args)
          };
          tools.set(id, tool);
          collectPathsFromInput(tool.input, outputPaths);
          emitTool(tool);
          break;
        }
        case "tool_output": {
          const id = ev.id ?? ev.tool_id;
          const tool = (id !== undefined && tools.get(id)) || findOpenToolByName(String(ev.name ?? ev.tool ?? ""));
          if (tool) {
            tool.outputText = (tool.outputText || "") + extractText(ev);
            tool.result = summarizeToolResult(tool.outputText);
            emitTool(tool);
          }
          break;
        }
        case "tool_progress": {
          // 渲染层无原位替换槽位，仅日志
          callbacks.onLog?.("atomcode_tool_progress", { id: String(ev.id ?? ""), progress: ev.progress });
          break;
        }
        case "tool_result": {
          const name = String(ev.name ?? ev.tool ?? "工具");
          let id = ev.id ?? ev.tool_id;
          if (id === undefined || id === null) id = findOpenToolByName(name)?.id ?? `tool-${tools.size + 1}`;
          const prior = tools.get(id) || { id, name, status: "running", input: {} };
          const output = extractText(ev) || summarizeToolResult(ev.output ?? "");
          const tool = { ...prior, status: ev.success === false ? "failed" : "completed", result: summarizeToolResult(output) };
          tools.set(tool.id, tool);
          collectPathsFromText(output, outputPaths);
          emitTool(tool);
          break;
        }
        case "tokens": {
          const promptTokens = Number(ev.prompt ?? ev.prompt_tokens) || 0;
          const completionTokens = Number(ev.completion ?? ev.completion_tokens) || 0;
          usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: Number(ev.total) || (promptTokens + completionTokens)
          };
          callbacks.onUsage?.(usage);
          break;
        }
        case "artifact_start": {
          const id = String(ev.id ?? `artifact-${[...tools.keys()].filter((key) => key.startsWith("artifact")).length + 1}`);
          const tool = { id, name: `制品${ev.kind ? `（${ev.kind}）` : ""}`, status: "running", input: { kind: String(ev.kind ?? ev.language ?? "") } };
          tools.set(id, tool);
          emitTool(tool);
          break;
        }
        case "artifact_content": {
          const id = ev.id ?? [...tools.keys()].reverse().find((key) => key.startsWith("artifact"));
          const tool = id !== undefined && tools.get(id);
          if (tool) {
            tool.outputText = (tool.outputText || "") + extractText(ev);
            tool.result = summarizeToolResult(tool.outputText);
            emitTool(tool);
          }
          break;
        }
        case "artifact_end": {
          const id = ev.id ?? [...tools.keys()].reverse().find((key) => key.startsWith("artifact"));
          const prior = id !== undefined && tools.get(id);
          if (prior) {
            const tool = { ...prior, status: "completed", result: prior.result || "制品输出完成" };
            tools.set(tool.id, tool);
            emitTool(tool);
          }
          break;
        }
        case "done": {
          const foundSession = String(ev.session_id ?? "");
          if (foundSession && foundSession !== nextSessionId) {
            nextSessionId = foundSession;
            callbacks.onSessionId?.(nextSessionId);
          }
          if (!usage && ev.tokens) {
            usage = {
              prompt_tokens: Number(ev.tokens.prompt ?? ev.tokens.prompt_tokens) || 0,
              completion_tokens: Number(ev.tokens.completion ?? ev.tokens.completion_tokens) || 0,
              total_tokens: Number(ev.tokens.total ?? ev.tokens.total_tokens) || 0
            };
            callbacks.onUsage?.(usage);
          }
          break; // 等 res end 统一收尾
        }
        case "stopped":
          break; // 由 res end + cancelled 标记统一收尾
        case "error":
          daemonError = new Error(String(ev.message || "AtomCode daemon 返回错误。"));
          break;
        default:
          break;
      }
    };

    await new Promise((resolve, reject) => {
      let buffer = "";
      let lastEventName = "";

      const finishError = (error) => {
        clearTimeout(idleTimer);
        clearTimeout(connectTimer);
        reject(error);
      };
      const bumpIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          req?.destroy();
          finishError(new Error("AtomCode daemon 响应超时（超过 5 分钟未收到数据）。"));
        }, IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      };

      const handleLine = (line) => {
        if (line.startsWith("event:")) {
          lastEventName = line.slice(6).trim();
          return;
        }
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data) return;
        let ev;
        try { ev = JSON.parse(data); } catch { return; }
        try { handleDaemonEvent(ev, lastEventName); } catch (error) {
          callbacks.onLog?.("atomcode_event_map_failed", { error: error.message });
        }
      };

      try {
        const url = new URL("/chat", `${daemonBaseUrl(config)}/`);
        const payloadText = JSON.stringify(payload);
        req = http.request(url, {
          method: "POST",
          headers: daemonHeaders(config, { Accept: "text/event-stream", "Content-Length": Buffer.byteLength(payloadText) })
        }, (res) => {
          clearTimeout(connectTimer);
          if (cancelled) { res.resume(); return finishError(cancellationError()); }
          if (res.statusCode === 401) { res.resume(); return finishError(new Error("AtomCode daemon 认证失败（401）：请把 ~/.atomcode/daemon-<端口>.json 中的 token 填入设置。")); }
          if (res.statusCode !== 200) {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              const bodyText = Buffer.concat(chunks).toString("utf8").slice(0, 200);
              finishError(new Error(`AtomCode daemon 返回 HTTP ${res.statusCode}：${bodyText || "(无响应体)"}`));
            });
            res.on("error", () => finishError(new Error(`AtomCode daemon 返回 HTTP ${res.statusCode}。`)));
            return;
          }

          callbacks.onStatus?.("connected");
          bumpIdle();
          res.on("data", (chunk) => {
            if (cancelled) return;
            bumpIdle();
            buffer += chunk.toString("utf8");
            let index;
            while ((index = buffer.indexOf("\n")) >= 0) {
              handleLine(buffer.slice(0, index).replace(/\r$/, ""));
              buffer = buffer.slice(index + 1);
            }
          });
          res.on("end", () => {
            clearTimeout(idleTimer);
            if (buffer.trim()) handleLine(buffer.replace(/\r$/, ""));
            if (cancelled) return reject(cancellationError());
            if (daemonError) return reject(daemonError);
            resolve();
          });
          res.on("error", (error) => {
            clearTimeout(idleTimer);
            if (cancelled || error.cancelled) return reject(cancellationError());
            finishError(new Error(`AtomCode daemon 连接中断：${error.message}`));
          });
        });
        req.on("error", (error) => {
          clearTimeout(idleTimer);
          clearTimeout(connectTimer);
          finishError(cancelled ? cancellationError() : friendlyDaemonError(error));
        });

        connectTimer = setTimeout(() => {
          req?.destroy();
          finishError(new Error("连接 AtomCode daemon 超时（15 秒无响应）。"));
        }, CONNECT_TIMEOUT_MS);
        connectTimer.unref?.();

        req.write(payloadText);
        req.end();
      } catch (error) {
        finishError(error);
      }
    });

    if (!receivedAnyEvent && !responseText) throw new Error("AtomCode daemon 未返回任何数据，请检查 daemon 是否正常运行。");
    const files = inspectLocalFiles([...outputPaths], new Set(uploaded.map((file) => normalizePath(file.path))));
    return { sessionId: nextSessionId || sessionId, text: responseText, lastTurnText: responseText, files, tools: [...tools.values()], usage };
  })().finally(() => {
    clearTimeout(requestTimer);
    clearTimeout(idleTimer);
    clearTimeout(connectTimer);
  });

  return {
    promise: operation,
    cancel() {
      cancelled = true;
      stopDaemonChat(config, sessionId).catch(() => {});
    }
  };
}

module.exports = { runAtomCodeChat, verifyAtomCodeConnection, listAtomCodeModels, stopDaemonChat, readDaemonTokenFile, daemonBaseUrl };