"use strict";

/**
 * SSH 远程 CLI 适配器公共基建（v3.19.0 F3）
 *
 * 五家 SSH 远程适配器（claude / atomcode-qwen / codex / hermes）的公共跑法：
 *   1. connectWithRetry（复用 ssh.cjs 的指纹信任 / 指数退避 / advanced.ssh 阈值参数化全套）
 *   2. 工作目录预检（不存在直接拦截，防远端 SDK 误报 libc）
 *   3. `command -v <cli>` 在场检测（不在场报引导安装的明确错误）
 *   4. cd 到工作目录后流式 exec（逐行 stdout 回调 + stderr 聚合 + 超时/取消）
 *
 * 各家 adapter 只需要提供：cliName / buildCommand(message, sessionId) / handleLine(line)。
 * 本轮先做纯文本消息（附件链路仅 claude bridge 支持，三家如实忽略并提示）。
 */

const { connectWithRetry, exec, shellQuote } = require("../ssh.cjs");

const MAX_REQUEST_MS = 30 * 60 * 1000;

function cancellationError() {
  const error = new Error("已停止生成。");
  error.cancelled = true;
  return error;
}

/** 从 config.advancedEffective.ssh 读请求超时（与 runClaude 同源语义） */
function requestTimeoutMs(config) {
  const n = Number(config?.advancedEffective?.ssh?.requestTimeoutMin);
  return Number.isFinite(n) && n >= 10 && n <= 120 ? n * 60_000 : MAX_REQUEST_MS;
}

function cleanAnsi(value) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

/**
 * 通用 SSH 远程 CLI 跑法。返回与 runClaude 相同的契约：{promise, cancel()}。
 * @param {object} options
 * @param {string} options.adapterName - 适配器显示名（错误文案用）
 * @param {string} options.cliName - 远端 CLI 命令名（command -v 检测）
 * @param {string} [options.installHint] - 不在场时的安装指引（放进错误文案）
 * @param {(config: object, sessionId: string, message: string) => string} options.buildCommand - 拼远端命令
 * @param {(line: string, state: object) => void} options.handleLine - 逐行
 *   事件解析；state = {sessionId, text, usage, done, error}，解析器负责写这些字段，
 *   并可调 stateCallbacks 回流（onDelta/onToolEvent/onUsage）。
 */
function runRemoteCli(config, message, sessionId, attachments, callbacks, options) {
  const adapterName = String(options.adapterName || "适配器");
  const cliName = String(options.cliName || "cli");

  const operation = (async () => {
    if (attachments.length) {
      callbacks.onLog?.("adapter_attachments_skipped", { adapter: adapterName, count: attachments.length });
      callbacks.onStatus?.("connected", { note: `附件仅 Claude 引擎支持，${adapterName} 已忽略 ${attachments.length} 个附件。` });
    }
    callbacks.onStatus?.("connecting");
    let client = await connectWithRetry(config, callbacks.onUnknownHost || (() => {}), callbacks.onLog, callbacks.onStatus);
    if (callbacks.cancelled) throw cancellationError();
    callbacks.onStatus?.("connected");

    const workingDirectory = String(config.workingDirectory || "").trim();
    if (workingDirectory) {
      const directoryCheck = await exec(client, `test -d -- ${shellQuote(workingDirectory)}`);
      if (directoryCheck.code !== 0) {
        client.end();
        throw new Error(`远端工作目录不存在：${workingDirectory}`);
      }
    }

    const which = await exec(client, `command -v -- ${shellQuote(cliName)}`);
    if (!which.stdout.trim()) {
      client.end();
      throw new Error(`远端 NAS 找不到 ${adapterName} 的 CLI（${cliName}）。${options.installHint ? `安装：${options.installHint}` : "请先在 NAS 上安装。"}`);
    }
    const cliPath = which.stdout.trim().split("\n")[0].trim();

    const command = `cd ${shellQuote(workingDirectory)} && ${options.buildCommand(cliPath, sessionId, message)}`;
    callbacks.onLog?.("adapter_cli_start", { adapter: adapterName, command, hasSession: Boolean(sessionId) });

    const state = { sessionId: sessionId || "", text: "", usage: undefined, done: false, error: "" };
    const lineCallbacks = {
      onDelta: (text) => {
        if (text) { state.text += text; callbacks.onDelta?.(text); }
      },
      onToolEvent: (tool) => callbacks.onToolEvent?.(tool),
      onUsage: (usage) => { state.usage = usage || state.usage; callbacks.onUsage?.(usage); }
    };
    options.prepare?.(state, lineCallbacks);

    let stderrText = "";
    const timeoutMs = requestTimeoutMs(config);
    let timer;
    let cancelled = false;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        state.error = `本次请求已运行 ${Math.round(timeoutMs / 60000)} 分钟，客户端为防止无限消耗已自动停止。`;
        try { stream?.close(); } catch { /* 通道未开 */ }
      }, timeoutMs);

      let buffer = "";
      let stream;
      const handleChunk = (chunk) => {
        if (settled || cancelled) return;
        buffer += chunk.toString("utf8");
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (line.trim()) {
            try { options.handleLine(line, state, lineCallbacks); } catch (parseError) {
              callbacks.onLog?.("adapter_line_parse_failed", { adapter: adapterName, error: parseError.message });
            }
          }
          index = buffer.indexOf("\n");
        }
      };

      client.exec(command, (error, opened) => {
        if (error) {
          callbacks.onLog?.("adapter_exec_failed", { adapter: adapterName, error: error.message });
          settle(reject, error);
          return;
        }
        stream = opened;
        stream.on("data", handleChunk);
        stream.stderr?.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });
        stream.on("error", (streamError) => {
          if (cancelled) return settle(reject, cancellationError());
          callbacks.onLog?.("adapter_stream_error", { adapter: adapterName, error: streamError.message });
        });
        stream.on("close", (code) => {
          if (cancelled) return settle(reject, cancellationError());
          if (state.error) {
            settle(reject, new Error(describeAdapterFailure(state.error, cliPath, stderrText)));
            return;
          }
          if (code !== 0 && !state.text) {
            settle(reject, new Error(describeAdapterFailure(`${cliName} 退出码 ${code}`, cliPath, stderrText)));
            return;
          }
          callbacks.onSessionId?.(state.sessionId || sessionId || "");
          callbacks.onTurnComplete?.({ text: state.text, sessionId: state.sessionId || sessionId || "", usage: state.usage });
          settle(resolve, { sessionId: state.sessionId || sessionId || "", text: state.text, files: [], tools: [], usage: state.usage });
        });
      });
      // 等待 exec 打开后再把 stream 交给外面（闭包时序：exec 回调同步先于 timeout 判空无碍）
      if (stream) { /* 已在回调内赋值 */ }
    });

    promise.finally(() => {
      if (timer) clearTimeout(timer);
      try { client.end(); } catch { /* 已断开 */ }
    });

    return await promise;
  })();

  return {
    promise: operation,
    cancel() { callbacks.cancelled = true; }
  };
}

function describeAdapterFailure(message, cliPath, stderrText) {
  const tail = cleanAnsi(stderrText).split("\n").filter(Boolean).slice(-2).join("；");
  const base = `${message}`;
  if (/command not found|not installed/i.test(`${message} ${tail}`)) {
    return `${base}（远端缺少 ${cliPath}，请先在 NAS 安装对应 CLI。）`;
  }
  return tail ? `${base}，详细：${tail}` : base;
}

/** 供各家 adapter 直接拼带引号的 CLI 调用 */
function cliCommand(parts) {
  return parts.filter(Boolean).join(" ");
}

module.exports = { cancellationError, cleanAnsi, cliCommand, runRemoteCli, requestTimeoutMs };