"use strict";

/**
 * Hermes 适配器（SSH 远程 CLI，v3.19.0 F3）
 *
 * 远端命令：`hermes chat -q "..."`（非结构化逐 token 流——stdout 直接当文本增量）
 *   续聊：`--continue`（最新会话）
 *   模型 / 服务商：--model "anthropic/claude-sonnet-4" --provider nous|openrouter
 * 输出无结构化事件（spinner 的 token flow 即 stdout 文本流）；stderr 里可能混
 *   spinner 动画帧——流式仅读 stdout，退出非 0 时用 stderr 汇总错误。
 *
 * 安装（用户手动，NAS 侧）：MIT 开源 curl 脚本（hermes-agent.nousresearch.com）
 * 参照：111 NAS 已跑 lisa-hermse 容器实例
 */

const { shellQuote } = require("../protocol.cjs");
const { runRemoteCli, cliCommand } = require("./ssh-cli-base.cjs");

const INSTALL_HINT = "官方脚本安装（详见 hermes-agent.nousresearch.com/docs）或 NAS 容器内 CLI 挂 PATH";

function parseHermesLine(line, state, lineCallbacks) {
  if (/\[error\]|Error:/i.test(line)) {
    state.error = line;
    return;
  }
  // 纯文本流：每行即增量（补回换行保持段落）
  if (line.trim()) lineCallbacks.onDelta(`${line}\n`);
}

async function verifyHermesConnection(config, onUnknownHost, onLog) {
  const operation = runRemoteCli(config, "", "", [], {}, {
    adapterName: "Hermes",
    cliName: "hermes",
    installHint: INSTALL_HINT,
    buildCommand: (cliPath) => cliCommand([shellQuote(cliPath), "--version"]),
    handleLine: () => {}
  });
  await operation.promise;
  return { ok: true };
}

function runHermesCli(config, message, sessionId, attachments = [], callbacks = {}) {
  const model = String(config.remoteAdapterModel || "").trim();
  const provider = String(config.remoteAdapterProvider || "").trim();
  return runRemoteCli(config, message, sessionId, attachments, callbacks, {
    adapterName: "Hermes",
    cliName: "hermes",
    installHint: INSTALL_HINT,
    buildCommand: (cliPath, existingSession, text) => cliCommand([
      shellQuote(cliPath),
      "chat",
      "-q", shellQuote(text),
      existingSession ? "--continue" : "",
      model ? `--model ${shellQuote(model)}` : "",
      provider ? `--provider ${shellQuote(provider)}` : ""
    ]),
    handleLine: parseHermesLine
  });
}

module.exports = { runHermesCli, verifyHermesConnection, parseHermesLine };