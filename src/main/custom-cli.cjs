"use strict";

const { spawn, execFile } = require("child_process");
const { buildLocalAttachmentNote, resolveLocalCommand, validatedWorkingDirectory, writeLocalAttachments } = require("./local.cjs");

/**
 * 自定义命令引擎 — 本机任意终端 AI 的纯文本兜底接入
 *
 * - 命令模板：config.customCliCommand，如 `aider --message {message}`；
 *   模板含 {message} 占位符 → 命令行传参；不含 → 消息走 stdin
 * - 无原生会话：main 侧回放对话历史（config.history），截断上限兜底
 * - stdout 流式 → assistant 文本增量；停止 = 杀进程（Windows cmd 包裹时杀进程树）
 */

const MAX_REQUEST_MS = 30 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 16;
const MAX_HISTORY_CHARS = 12000;

// ────────────────────────────────────────────
//  命令模板解析
// ────────────────────────────────────────────

/** 模板分词：尊重单双引号；引号未闭合报错 */
function tokenizeCommandTemplate(template) {
  const value = String(template || "").trim();
  if (!value) throw new Error("请填写自定义命令模板，例如：aider --message {message}。");
  const tokens = [];
  let current = "";
  let quote = "";
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error("自定义命令模板的引号没有闭合。");
  if (current) tokens.push(current);
  if (!tokens.length) throw new Error("请填写自定义命令模板，例如：aider --message {message}。");
  return tokens;
}

/** 拆出 [命令, 参数]；判断是否用 stdin 传消息 */
function buildSpawnPlan(template, message) {
  const tokens = tokenizeCommandTemplate(template);
  const command = tokens[0];
  const rest = tokens.slice(1);
  const hasPlaceholder = rest.some((token) => token.includes("{message}"));
  const args = rest.map((token) => token.split("{message}").join(message));
  return { command, args, viaStdin: !hasPlaceholder };
}

// ────────────────────────────────────────────
//  历史回放
// ────────────────────────────────────────────

/** 取最近若干条已完成消息拼成转录块（不含本次新消息，由 main 侧截好传入） */
function buildHistoryTranscript(messages, options = {}) {
  const maxMessages = options.maxMessages ?? MAX_HISTORY_MESSAGES;
  const maxChars = options.maxChars ?? MAX_HISTORY_CHARS;
  const usable = (Array.isArray(messages) ? messages : [])
    .filter((msg) => (msg.role === "user" || msg.role === "assistant") && !msg.draft && String(msg.text || "").trim());
  const picked = [];
  let chars = 0;
  for (let index = usable.length - 1; index >= 0 && picked.length < maxMessages; index -= 1) {
    const text = String(usable[index].text);
    if (picked.length && chars + text.length > maxChars) break;
    picked.unshift({ role: usable[index].role, text });
    chars += text.length;
  }
  if (!picked.length) return "";
  const lines = picked.map((msg) => `${msg.role === "user" ? "用户" : "助手"}：${msg.text}`);
  return "[以下是此前的对话记录，供理解上下文用；请只回应最后的用户消息]\n" + lines.join("\n\n") + "\n[对话记录结束]\n\n";
}

// ────────────────────────────────────────────
//  进程工具
// ────────────────────────────────────────────

function isWindowsScript(file) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(String(file || ""));
}

function cmdEscape(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

/** Windows 下 cmd/bat 包装的子进程需杀整棵树 */
function killProcessTree(child) {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    } catch { /* 兜底直接 kill */ child.kill(); }
  } else {
    child.kill();
  }
}

function cleanAnsi(value) {
  return String(value || "")
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

// ────────────────────────────────────────────
//  连接测试 / 聊天
// ────────────────────────────────────────────

/** 连接测试：只解析并确认命令存在，不执行（避免拉起交互式 TUI） */
async function verifyCustomCliConnection(config, onLog) {
  const plan = buildSpawnPlan(config?.customCliCommand, "连接测试");
  const command = await resolveLocalCommand(plan.command, "自定义命令");
  onLog?.("custom_cli_verify", { command, viaStdin: plan.viaStdin });
  return `自定义命令已找到：${command}${plan.viaStdin ? "（消息将通过标准输入传入）" : ""}`;
}

function runCustomCli(config, message, sessionId, attachments = [], callbacks = {}) {
  let child;
  let cancelled = false;
  let requestTimer;
  let responseText = "";

  const operation = (async () => {
    requestTimer = setTimeout(() => {
      cancelled = true;
      killProcessTree(child);
    }, MAX_REQUEST_MS);
    requestTimer.unref?.();

    callbacks.onStatus?.("local-starting");
    const plan = buildSpawnPlan(config.customCliCommand, message);
    const command = await resolveLocalCommand(plan.command, "自定义命令");
    const uploaded = await writeLocalAttachments(config.localUploadDirectory, attachments, callbacks.conversationId, callbacks.onUploadProgress);
    const prompt = buildHistoryTranscript(config.history) + message + buildLocalAttachmentNote(uploaded);
    callbacks.onLog?.("custom_cli_start", {
      command,
      viaStdin: plan.viaStdin,
      attachmentCount: uploaded.length,
      historyMessageCount: Array.isArray(config.history) ? config.history.length : 0,
      workingDirectory: config.workingDirectory || ""
    });
    callbacks.onStatus?.("connected");

    let stderr = "";
    await new Promise((resolve, reject) => {
      const cwd = validatedWorkingDirectory(config.workingDirectory);
      if (isWindowsScript(command)) {
        // Node 拒绝直接 spawn .cmd/.bat（EINVAL），显式走 cmd.exe；停止时杀进程树
        const commandLine = [command, ...plan.args].map(cmdEscape).join(" ");
        child = spawn("cmd.exe", ["/d", "/s", "/c", commandLine], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      } else {
        child = spawn(command, plan.args, { cwd, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      }
      child.stdout.on("data", (data) => {
        if (cancelled) return;
        const text = cleanAnsi(data.toString("utf8"));
        if (!text) return;
        responseText += text;
        callbacks.onDelta?.(text);
      });
      child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
      child.once("error", (error) => {
        reject(error.code === "ENOENT"
          ? new Error(`找不到自定义命令"${command}"。请检查命令模板或先安装对应工具。`)
          : new Error(`启动自定义命令失败：${error.message}`));
      });
      child.once("close", (code) => {
        callbacks.onLog?.("custom_cli_close", {
          exitCode: code,
          cancelled,
          receivedTextLength: responseText.length,
          stderr: cleanAnsi(stderr).slice(0, 500)
        });
        if (cancelled) {
          const error = new Error("已停止生成。");
          error.cancelled = true;
          return reject(error);
        }
        if (code !== 0) return reject(new Error(`自定义命令已退出（代码 ${code}）：${cleanAnsi(stderr).slice(-500) || "无错误输出"}`));
        if (!responseText.trim()) callbacks.onLog?.("custom_cli_empty_output", {});
        resolve();
      });
      child.stdin.end(plan.viaStdin ? prompt : "");
    });

    return { sessionId: "", text: responseText, lastTurnText: responseText, files: [], tools: [], usage: undefined };
  })().finally(() => {
    if (requestTimer) clearTimeout(requestTimer);
  });

  return {
    promise: operation,
    cancel() {
      cancelled = true;
      killProcessTree(child);
    }
  };
}

module.exports = { buildHistoryTranscript, buildSpawnPlan, runCustomCli, tokenizeCommandTemplate, verifyCustomCliConnection };