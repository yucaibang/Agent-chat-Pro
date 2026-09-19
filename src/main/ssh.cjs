"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { Client } = require("ssh2");
const {
  JsonLineParser,
  buildClaudeCommand,
  compactEventFromEvent,
  contextLimitFromModel,
  modelFromEvent,
  shellQuote,
  sessionFromEvent,
  textFromEvent,
  usageFromEvent
} = require("./protocol.cjs");
const { buildCommandWithMode, buildBridgeStartWithMode } = require("./modes/mode-params.cjs");
const { friendlyClaudeLaunchError, describeMissingWorkingDirectory } = require("./claude-launch-diagnostics.cjs");
const { readModelSettings, replaceModelSettings } = require("./model-config.cjs");
const { bridgeCompatibility, parseVersion } = require("./modules/agent/claude/runtime-compatibility.cjs");

const TOOL_PROGRESS_NOTICE_COUNTS = [8, 24];
const MAX_REQUEST_MS = 30 * 60 * 1000;
const SSH_READY_TIMEOUT_MS = 15_000;
const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
const SSH_KEEPALIVE_COUNT_MAX = 3;
const MAX_CONNECT_ATTEMPTS = 3;
const SFTP_OPERATION_TIMEOUT_MS = 30_000;

function auditTransportItem(onAudit, item, transport) {
  const payload = item?.value;
  const content = Array.isArray(payload?.message?.content) ? payload.message.content : [];
  onAudit?.({
    transport,
    parser: payload ? "parsed" : item?.raw ? "unparsed" : "empty",
    rawType: payload?.type,
    rawEventType: payload?.event?.type,
    rawContentKind: content.map((entry) => String(entry?.type || "")).filter(Boolean).slice(0, 4).join("_"),
    rawLength: item?.raw ? String(item.raw).length : 0
  });
}

function connect(config, onUnknownHost, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    onLog("ssh_connect_start", { host: config.host, port: config.port, username: config.username ? config.username[0] + "***" : "" });
    const timeout = setTimeout(() => {
      client.end();
      onLog("ssh_connect_timeout", { host: config.host, port: config.port });
      reject(new Error("SSH 连接超时，请检查地址、端口和 NAS 是否在线。"));
    }, SSH_READY_TIMEOUT_MS);

    client.once("ready", () => {
      clearTimeout(timeout);
      onLog("ssh_ready", { host: config.host, port: config.port });
      resolve(client);
    });
    client.once("error", (error) => {
      clearTimeout(timeout);
      const message = error.message === "All configured authentication methods failed"
        ? "SSH 账号或密码不正确，请在连接设置中重新填写。"
        : "SSH 连接失败：" + error.message;
      onLog("ssh_error", { host: config.host, port: config.port, error: message });
      reject(new Error(message));
    });
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: SSH_READY_TIMEOUT_MS,
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
      hostHash: "sha256",
      hostVerifier: (key) => {
        const fingerprint = `SHA256:${Buffer.from(key, "hex").toString("base64").replace(/=+$/, "")}`;
        if (config.hostFingerprint) {
          const matches = config.hostFingerprint === fingerprint;
          onLog("ssh_host_fingerprint", { fingerprint, matches, previouslyTrusted: true });
          return matches;
        }
        const trusted = onUnknownHost?.(fingerprint) === true;
        onLog("ssh_host_fingerprint", { fingerprint, trusted, previouslyTrusted: false });
        if (trusted) config.hostFingerprint = fingerprint;
        return trusted;
      }
    });
  });
}

async function verifyConnection(config, onUnknownHost, onLog) {
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const directory = String(config.workingDirectory || "").trim();
    if (directory) {
      // v3.7.2：工作目录预检——目录不存在时报准确中文错误，不让 SDK 误报 libc 问题
      const directoryCheck = await exec(client, `test -d -- ${shellQuote(directory)}`);
      if (directoryCheck.code !== 0) {
        throw new Error(describeMissingWorkingDirectory(directory, { host: config.host }));
      }
    }
    const prefix = directory ? `cd -- ${shellQuote(directory)} && ` : "";
    const result = await exec(client, `${prefix}${shellQuote(config.wakeName)} --version`);
    onLog?.("claude_version_result", { exitCode: result.code, version: result.stdout.trim(), stderr: result.stderr.trim() });
    if (result.code !== 0) throw new Error(friendlyClaudeLaunchError(result.stderr || "无法运行 Claude 命令。", { host: config.host }));
    return result.stdout.trim() || "已连接";
  } finally {
    client.end();
  }
}

async function getClaudeModelStatus(config, onUnknownHost, onLog) {
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const settingsPath = `${home}/.claude/settings.json`;
    const result = await exec(client, `cat -- ${shellQuote(settingsPath)}`);
    if (result.code !== 0) throw new Error("无法读取目标 NAS 的 Claude 模型配置：" + cleanError(result.stderr));
    const parsed = readModelSettings(result.stdout);
    return { model: parsed.model, models: parsed.models, consistent: parsed.consistent, settingsPath };
  } finally { client.end(); }
}

async function updateClaudeModel(config, modelName, onUnknownHost, onLog) {
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const settingsPath = `${home}/.claude/settings.json`;
    const current = await exec(client, `cat -- ${shellQuote(settingsPath)}`);
    if (current.code !== 0) throw new Error("无法读取目标 NAS 的 Claude 模型配置：" + cleanError(current.stderr));
    const replacement = replaceModelSettings(current.stdout, modelName);
    const temporaryPath = `${settingsPath}.agent-chat-pro-model-${process.pid}-${Date.now()}.tmp`;
    try {
      const sftp = await openSftp(client);
      try { await writeSftp(sftp, temporaryPath, Buffer.from(replacement.settings, "utf8")); }
      finally { closeSftp(sftp); }
      const promote = await exec(client, [
        `chmod 600 -- ${shellQuote(temporaryPath)}`,
        `mv -- ${shellQuote(temporaryPath)} ${shellQuote(settingsPath)}`
      ].join(" && "));
      if (promote.code !== 0) throw new Error("模型配置未能保存，原配置仍保留：" + cleanError(promote.stderr));
      const verified = await getModelStatusFromClient(client, settingsPath);
      if (!verified.consistent || verified.model !== replacement.model) {
        throw new Error("模型配置写入后核对失败，请检查五项模型配置。");
      }
      onLog?.("claude_model_changed", { host: config.host, model: replacement.model, changedKeys: replacement.changedKeys });
      return { ...verified, changedKeys: replacement.changedKeys };
    } catch (error) {
      await exec(client, `rm -f -- ${shellQuote(temporaryPath)}`).catch(() => {});
      throw error;
    }
  } finally { client.end(); }
}

async function getModelStatusFromClient(client, settingsPath) {
  const result = await exec(client, `cat -- ${shellQuote(settingsPath)}`);
  if (result.code !== 0) throw new Error("模型配置写入后无法重新读取：" + cleanError(result.stderr));
  const parsed = readModelSettings(result.stdout);
  return { model: parsed.model, models: parsed.models, consistent: parsed.consistent, settingsPath };
}

async function ensureDeviceControlKey(config, deviceId, metadata, onUnknownHost, onLog) {
  const safeId = String(deviceId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80);
  if (!safeId) throw new Error("无法创建联动设备编号。");
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const directory = `${home}/.agent-orbit/device-control/${safeId}`;
    const privateKeyPath = `${directory}/id_ed25519`;
    const command = [
      "umask 077",
      `mkdir -p -- ${shellQuote(directory)}`,
      `test -f ${shellQuote(privateKeyPath)} || ssh-keygen -q -t ed25519 -N '' -C ${shellQuote(`agent-orbit-${safeId}`)} -f ${shellQuote(privateKeyPath)}`,
      `cat -- ${shellQuote(privateKeyPath + ".pub")}`
    ].join(" && ");
    const result = await exec(client, command);
    if (result.code !== 0) throw new Error(result.stderr || "无法在 NAS 创建联动密钥。");
    const publicKey = result.stdout.trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: .*)?$/.test(publicKey)) throw new Error("NAS 返回的联动公钥无效。");
    await writeRemoteJson(client, `${directory}/device.json`, {
      deviceId: safeId,
      hostname: String(metadata?.hostname || ""),
      targetAddress: String(metadata?.targetAddress || ""),
      targetPort: Number(metadata?.targetPort || 22),
      account: "AgentChatProControl",
      port: Number(metadata?.targetPort || 22),
      status: "pairing",
      updatedAt: new Date().toISOString()
    });
    onLog?.("device_control_key_ready", { deviceId: safeId, privateKeyPath });
    return { publicKey, privateKeyPath, deviceId: safeId };
  } finally {
    client.end();
  }
}

async function finalizeDeviceControl(config, key, metadata, onUnknownHost, onLog) {
  const target = String(metadata?.targetAddress || "").trim();
  const targetPort = Number(metadata?.targetPort || 22);
  if (!/^[0-9a-fA-F:.]+$/.test(target)) throw new Error("本机被控地址不是有效 IP。");
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error("本机 SSH 端口无效。");
  const directory = key.privateKeyPath.replace(/\\/g, "/").replace(/\/id_ed25519$/, "");
  const knownHosts = `${directory}/known_hosts`;
  const connectScript = `${directory}/connect.sh`;
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const scan = await exec(client, [
      `ssh-keyscan -T 8 -p ${targetPort} -H ${shellQuote(target)} > ${shellQuote(knownHosts + ".tmp")} 2>/dev/null`,
      `test -s ${shellQuote(knownHosts + ".tmp")}`,
      `mv -- ${shellQuote(knownHosts + ".tmp")} ${shellQuote(knownHosts)}`,
      `chmod 600 ${shellQuote(knownHosts)}`
    ].join(" && "));
    if (scan.code !== 0) throw new Error("NAS 无法读取这台 Windows 的 SSH 主机指纹，请检查本机地址和防火墙。");
    const destination = `AgentChatProControl@${target}`;
    const sshArguments = `-p ${targetPort} -i ${shellQuote(key.privateKeyPath)} -o BatchMode=yes -o IdentitiesOnly=yes -o PasswordAuthentication=no -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(knownHosts)} ${shellQuote(destination)}`;
    const probe = await exec(client, `ssh ${sshArguments} ${shellQuote("echo AGENT_CHAT_PRO_READY")}`);
    if (probe.code !== 0 || !probe.stdout.includes("AGENT_CHAT_PRO_READY")) {
      throw new Error(probe.stderr.trim() || "NAS 使用专属密钥回连 Windows 失败。");
    }
    const script = `#!/bin/sh\nexec ssh ${sshArguments} \"$@\"\n`;
    const sftp = await openSftp(client);
    try { await writeSftp(sftp, connectScript, Buffer.from(script, "utf8")); } finally { closeSftp(sftp); }
    await exec(client, `chmod 700 ${shellQuote(connectScript)}`);
    await writeRemoteJson(client, `${directory}/device.json`, {
      deviceId: key.deviceId,
      hostname: String(metadata?.hostname || ""),
      targetAddress: target,
      account: "AgentChatProControl",
      port: targetPort,
      status: "ready",
      keyPath: key.privateKeyPath,
      connectScript,
      updatedAt: new Date().toISOString()
    });
    onLog?.("device_control_probe_success", { deviceId: key.deviceId, targetAddress: target, connectScript });
    return { ok: true, connectScript, targetAddress: target };
  } finally { client.end(); }
}

async function markDeviceControlDisabled(config, status, onUnknownHost, onLog) {
  const privateKeyPath = String(status?.managementKeyPath || "");
  if (!privateKeyPath.endsWith("/id_ed25519")) return false;
  const directory = privateKeyPath.slice(0, -"/id_ed25519".length);
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    await writeRemoteJson(client, `${directory}/device.json`, {
      deviceId: String(status.deviceId || ""),
      hostname: String(status.hostname || ""),
      targetAddress: String(status.targetAddress || ""),
      account: "AgentChatProControl",
      port: Number(status.targetPort || 22),
      status: "disabled",
      keyPath: privateKeyPath,
      updatedAt: new Date().toISOString()
    });
    await exec(client, `rm -f -- ${shellQuote(directory + "/connect.sh")} ${shellQuote(directory + "/known_hosts")}`);
    return true;
  } finally { client.end(); }
}

async function writeRemoteJson(client, remotePath, value) {
  const sftp = await openSftp(client);
  try { await writeSftp(sftp, remotePath, Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8")); }
  finally { closeSftp(sftp); }
}

async function getAgentSdkBridgeStatus(config, onUnknownHost, onLog) {
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  const runProbe = (command) => exec(client, command, { label: "增强 Bridge 状态检查", timeoutMs: 30_000 });
  try {
    const home = (await runProbe("printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const bridgePath = `${home}/.agent-orbit/bridge`;
    const nodePath = (await runProbe("command -v node")).stdout.trim();
    const probe = await runProbe([`test -r ${shellQuote(`${bridgePath}/agent-sdk-bridge.mjs`)}`, `test -r ${shellQuote(`${bridgePath}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`)}`, `node --check ${shellQuote(`${bridgePath}/agent-sdk-bridge.mjs`)}`].join(" && "));
    const ready = Boolean(nodePath) && probe.code === 0;
    // 运行时兼容性评估（v3.9.0，Orbit 真实现）：已安装时读取 SDK 版本与 Claude CLI 版本比对
    let compatibility = { state: "not-applicable", label: "当前模式未使用增强 Bridge SDK", checked: false };
    if (ready) {
      try {
        const sdkResult = await runProbe(`cat -- ${shellQuote(`${bridgePath}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`)}`);
        const sdk = JSON.parse(sdkResult.stdout);
        const cliResult = await runProbe("claude --version 2>/dev/null || echo ''");
        compatibility = bridgeCompatibility({
          cliVersion: parseVersion(cliResult.stdout),
          sdkVersion: parseVersion(sdk.version),
          sdkClaudeCodeVersion: parseVersion(sdk.claudeCodeVersion)
        });
      } catch {
        compatibility = { state: "unknown", label: "SDK 或 Claude 版本无法识别，无法判断匹配情况", checked: false };
      }
    }
    return { path: bridgePath, nodeAvailable: Boolean(nodePath), installed: probe.code === 0, ready, detail: ready ? "已安装并通过语法校验" : nodePath ? "未安装或依赖不完整" : "目标 NAS 未找到 Node.js", compatibility };
  } finally { client.end(); }
}

async function installAgentSdkBridge(config, files, onUnknownHost, onLog) {
  const safeFiles = normalizeBridgeFiles(files);
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  const runStep = async (stage, command, timeoutMs = 30_000) => {
    onLog?.("agent_sdk_bridge_install_stage", { host: config.host, stage });
    return exec(client, command, { label: `增强 Bridge：${stage}`, timeoutMs });
  };
  try {
    const home = (await runStep("resolve-home", "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const nodePath = (await runStep("check-node", "command -v node")).stdout.trim();
    const npmPath = (await runStep("check-npm", "command -v npm")).stdout.trim();
    if (!nodePath || !npmPath) throw new Error("目标 NAS 缺少 Node.js 或 npm，无法安装增强 Bridge。");
    const base = `${home}/.agent-orbit`;
    const target = `${base}/bridge`;
    const staging = `${base}/bridge.staging-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const backup = `${base}/bridge.backup-${Date.now()}`;
    const prepared = await runStep("prepare-staging", `mkdir -p -- ${shellQuote(base)} && rm -rf -- ${shellQuote(staging)} && mkdir -p -- ${shellQuote(staging)}`);
    if (prepared.code !== 0) throw new Error(cleanError(prepared.stderr) || "无法准备 Bridge 安装目录。");
    onLog?.("agent_sdk_bridge_install_stage", { host: config.host, stage: "upload-files" });
    const sftp = await openSftp(client);
    try { for (const file of safeFiles) await writeSftp(sftp, `${staging}/${file.name}`, file.data); } finally { closeSftp(sftp); }
    const dependencies = await runStep("install-dependencies", `cd -- ${shellQuote(staging)} && npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, 120_000);
    if (dependencies.code !== 0) {
      await runStep("cleanup-failed-staging", `rm -rf -- ${shellQuote(staging)}`);
      throw new Error(cleanError(dependencies.stderr) || "Bridge 依赖安装失败，请检查 NAS 的 npm 网络与权限。");
    }
    const check = await runStep("validate-files", `node --check ${shellQuote(`${staging}/agent-sdk-bridge.mjs`)} && test -r ${shellQuote(`${staging}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`)}`);
    if (check.code !== 0) {
      await runStep("cleanup-invalid-staging", `rm -rf -- ${shellQuote(staging)}`);
      throw new Error(cleanError(check.stderr) || "Bridge 文件校验失败，未替换现有版本。");
    }
    const promote = await runStep("promote", [`rm -rf -- ${shellQuote(backup)}`, `if test -e ${shellQuote(target)}; then mv -- ${shellQuote(target)} ${shellQuote(backup)}; fi`, `mv -- ${shellQuote(staging)} ${shellQuote(target)}`, `rm -rf -- ${shellQuote(backup)}`].join(" && "));
    if (promote.code !== 0) throw new Error(cleanError(promote.stderr) || "Bridge 安装完成前无法切换到新版本。");
    onLog?.("agent_sdk_bridge_install_success", { host: config.host, path: target });
    return { ...(await getAgentSdkBridgeStatus(config, onUnknownHost, onLog)), updated: true };
  } catch (error) {
    onLog?.("agent_sdk_bridge_install_failed", { host: config.host, error });
    throw error;
  } finally { client.end(); }
}

async function uninstallAgentSdkBridge(config, onUnknownHost, onLog) {
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const target = `${home}/.agent-orbit/bridge`;
    const removed = await exec(client, `rm -rf -- ${shellQuote(target)}`);
    if (removed.code !== 0) throw new Error(cleanError(removed.stderr) || "无法移除增强 Bridge。");
    onLog?.("agent_sdk_bridge_uninstall_success", { host: config.host, path: target });
    return { ...(await getAgentSdkBridgeStatus(config, onUnknownHost, onLog)), removed: true };
  } finally { client.end(); }
}

function normalizeBridgeFiles(files) {
  const expected = new Set(["agent-sdk-bridge.mjs", "package.json", "package-lock.json"]);
  if (!Array.isArray(files) || files.length !== expected.size) throw new Error("客户端 Bridge 文件不完整。");
  const normalized = files.map((file) => ({ name: String(file?.name || ""), data: Buffer.from(file?.data || []) }));
  if (normalized.some((file) => !expected.has(file.name) || !file.data.length) || new Set(normalized.map((file) => file.name)).size !== expected.size) throw new Error("客户端 Bridge 文件校验失败。");
  return normalized;
}

function runClaude(config, message, sessionId, attachments = [], callbacks = {}) {
  let client;
  let channel;
  let cancelled = false;
  let cancellationMessage = "已停止生成。";
  let interruptTimer;
  let requestTimer;
  let bridgeMode = false;
  let bridgeCapabilityChecked = false;
  let uploaded = [];
  const announcedToolProgress = new Set();
  let bridgeCloseTimer;
  let currentTurnText = "";
  let lastTurnText = "";
  const bufferedStreamInputs = [];
  const pendingFollowUps = new Map();

  function settleFollowUp(id, accepted) {
    const pending = pendingFollowUps.get(id);
    if (!pending) return;
    pendingFollowUps.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(Boolean(accepted));
  }

  function rejectPendingFollowUps() {
    for (const id of [...pendingFollowUps.keys()]) settleFollowUp(id, false);
    while (bufferedStreamInputs.length) bufferedStreamInputs.shift().resolve(false);
  }

  function cancellationError() {
    const error = new Error(cancellationMessage);
    error.cancelled = true;
    return error;
  }

  function interruptRemote(reason, message) {
    if (cancelled) return;
    cancelled = true;
    cancellationMessage = message || "已停止生成。";
    callbacks.onLog?.("claude_cancel_requested", { reason, hasChannel: Boolean(channel) });
    if (!channel) return;
    if (!bridgeMode) {
      callbacks.onLog?.("claude_direct_cancel", { reason });
      try { channel.close(); } catch { /* The direct CLI stream may already be closing. */ }
      return;
    }
    try {
      channel.write(JSON.stringify({ type: "interrupt" }) + "\n");
      callbacks.onLog?.("claude_interrupt_sent", { reason });
    } catch (error) {
      callbacks.onLog?.("claude_interrupt_send_failed", { reason, error });
    }
    interruptTimer = setTimeout(() => {
      callbacks.onLog?.("claude_interrupt_timeout", { reason });
      try { channel?.close(); } catch { /* Bridge may already be closing. */ }
    }, 10_000);
    interruptTimer.unref?.();
  }

  function closeBridgeInputSoon(delayMs = 900) {
    if (!bridgeMode || !channel || bridgeCloseTimer) return;
    bridgeCloseTimer = setTimeout(() => {
      bridgeCloseTimer = undefined;
      if (!channel) return;
      try {
        channel.write(JSON.stringify({ type: "close_input" }) + "\n");
        callbacks.onLog?.("claude_stream_input_closed", {});
      } catch (error) {
        callbacks.onLog?.("claude_stream_input_close_failed", { error });
      }
    }, delayMs);
    bridgeCloseTimer.unref?.();
  }

  function writeBridgeFollowUp(text, id = randomUUID()) {
    if (!channel || cancelled) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingFollowUps.delete(id);
        callbacks.onLog?.("claude_follow_up_ack_timeout", { id, textLength: text.length });
        resolve(false);
      }, 8_000);
      timer.unref?.();
      pendingFollowUps.set(id, { resolve, timer });
      try {
        channel.write(JSON.stringify({ type: "follow_up", id, message: text }) + "\n");
        callbacks.onLog?.("claude_follow_up_sent", { id, textLength: text.length });
      } catch (error) {
        callbacks.onLog?.("claude_follow_up_send_failed", { id, error });
        settleFollowUp(id, false);
      }
    });
  }

  function pushFollowUp(text) {
    if (!text || cancelled) return Promise.resolve(false);
    if (bridgeCloseTimer) {
      clearTimeout(bridgeCloseTimer);
      bridgeCloseTimer = undefined;
    }
    if (!bridgeCapabilityChecked || (bridgeMode && !channel)) {
      return new Promise((resolve) => {
        bufferedStreamInputs.push({ text, resolve });
        callbacks.onLog?.("claude_stream_input_buffered", { textLength: text.length, buffered: bufferedStreamInputs.length });
      });
    }
    if (!bridgeMode) return Promise.resolve(false);
    return writeBridgeFollowUp(text);
  }

  async function auditExecutionTarget() {
    try {
      const result = await exec(client, "hostname");
      callbacks.onAudit?.({ transport: "ssh", eventType: "lifecycle", executionTarget: result.stdout.trim() });
    } catch {
      callbacks.onAudit?.({ transport: "ssh", eventType: "lifecycle" });
    }
  }

  const operation = (async () => {
    requestTimer = setTimeout(() => interruptRemote(
      "request_timeout",
      "本次请求已运行 30 分钟，客户端为防止无限消耗已自动停止。"
    ), MAX_REQUEST_MS);
    requestTimer.unref?.();
    callbacks.onStatus?.("connecting");
    client = await connectWithRetry(config, callbacks.onUnknownHost, callbacks.onLog, callbacks.onStatus);
    if (cancelled) throw cancellationError();
    callbacks.onStatus?.("connected");
    await auditExecutionTarget();
    let parser = new JsonLineParser();
    uploaded = await uploadAttachments(client, attachments, callbacks.conversationId, callbacks.onUploadProgress);
    if (cancelled) throw cancellationError();
    const attachmentNote = uploaded.length
      ? buildAttachmentNote(uploaded)
      : "";
    const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const bridgePath = `${home}/.agent-orbit/bridge/agent-sdk-bridge.mjs`;
    const bridgeCheck = await exec(client, [
      `test -r ${shellQuote(bridgePath)}`,
      `test -r ${shellQuote(`${home}/.agent-orbit/bridge/node_modules/@anthropic-ai/claude-agent-sdk/package.json`)}`,
      `node --check ${shellQuote(bridgePath)}`,
      "printf READY"
    ].join(" && "));
    bridgeMode = bridgeCheck.stdout.trim() === "READY";
    bridgeCapabilityChecked = true;
    // v3.7.2：工作目录预检——目录不存在时远端 SDK 会误报 libc 问题（实测
    // 2026-09-19：workingDirectory 不存在 → SDK 套 libc 模板），提前拦截。
    const workingDirectory = String(config.workingDirectory || "").trim();
    if (workingDirectory) {
      const directoryCheck = await exec(client, `test -d -- ${shellQuote(workingDirectory)}`);
      if (directoryCheck.code !== 0) {
        throw new Error(describeMissingWorkingDirectory(workingDirectory, { host: config.host }));
      }
    }
    const wakeName = String(config.wakeName || "claude").trim();
    let resolvedClaude = "";
    if (bridgeMode) {
      resolvedClaude = (await exec(client, `command -v -- ${shellQuote(wakeName)}`)).stdout.trim();
      if (!resolvedClaude) throw new Error(`NAS 找不到 Agent 唤醒命令：${wakeName}`);
    }
    const directPrompt = message + attachmentNote;
    if (!bridgeMode) rejectPendingFollowUps();
    const command = bridgeMode
      ? `node ${shellQuote(bridgePath)}`
      : buildCommandWithMode(config.workModeId || "regular", directPrompt, sessionId, config);
    if (!bridgeMode) {
      callbacks.onLog?.("bridge_unavailable_direct_fallback", { bridgePath, wakeName });
    }
    callbacks.onLog?.("claude_command_start", {
      hasSession: Boolean(sessionId),
      attachmentCount: uploaded.length,
      wakeName: config.wakeName,
      workingDirectory: config.workingDirectory || "",
      transport: bridgeMode ? "agent-sdk-bridge" : "direct-cli",
      command,
      bridgeMode
    });
    let stderr = "";
    let responseText = "";
    let nextSessionId = "";
    let usage;
    const tools = new Map();
    const outputPaths = new Set();

    try {
      await executeCommand();
    } catch (error) {
      if (!error.connectionFailure || responseText || tools.size || nextSessionId || cancelled) throw error;
      callbacks.onLog?.("ssh_stream_reconnect", { error: error.message, safeToRetry: true });
      callbacks.onStatus?.("reconnecting");
      client.end();
      await new Promise((resolve) => setTimeout(resolve, 600));
      client = await connectWithRetry(config, callbacks.onUnknownHost, callbacks.onLog, callbacks.onStatus);
      callbacks.onStatus?.("connected");
      await auditExecutionTarget();
      parser = new JsonLineParser();
      stderr = "";
      await executeCommand();
    }

    const files = await inspectRemoteFiles(client, [...outputPaths], new Set(uploaded.map((file) => file.path)));
    return { sessionId: nextSessionId || sessionId, text: responseText, lastTurnText, files, tools: [...tools.values()], usage };

    function handleEvents(events) {
      for (const item of events) {
        auditTransportItem(callbacks.onAudit, item, bridgeMode ? "ssh-bridge" : "ssh-direct");
        if (!item.value) continue;
        if (item.value.type === "bridge_ready") continue;
        if (bridgeCloseTimer && !cancelled && ["assistant", "system"].includes(item.value.type)) {
          clearTimeout(bridgeCloseTimer);
          bridgeCloseTimer = undefined;
          callbacks.onLog?.("claude_stream_input_next_turn_started", {});
        }
        if (item.value.type === "bridge_follow_up_received") {
          const id = String(item.value.id || "");
          settleFollowUp(id, true);
          callbacks.onLog?.("claude_follow_up_accepted", { id });
          continue;
        }
        if (item.value.type === "bridge_follow_up_rejected") {
          const id = String(item.value.id || "");
          settleFollowUp(id, false);
          callbacks.onLog?.("claude_follow_up_rejected", { id });
          continue;
        }
        if (item.value.type === "bridge_interrupt_received") {
          if (interruptTimer) clearTimeout(interruptTimer);
          callbacks.onLog?.("claude_interrupt_ack", {});
          callbacks.onStatus?.("stopping");
          closeBridgeInputSoon(0);
          continue;
        }
        if (item.value.type === "bridge_permission_request") {
          callbacks.onPermissionRequest?.(item.value).then((allowed) => {
            channel?.write(JSON.stringify({
              type: "permission_result",
              id: item.value.id,
              decision: allowed ? "allow" : "deny"
            }) + "\n");
          }).catch(() => {
            channel?.write(JSON.stringify({ type: "permission_result", id: item.value.id, decision: "deny" }) + "\n");
          });
          continue;
        }
        if (item.value.type === "bridge_query_force_closed") {
          callbacks.onLog?.("claude_query_force_closed", { reason: item.value.reason || "interrupt-timeout" });
          callbacks.onStatus?.("stopped");
          continue;
        }
        const text = textFromEvent(item.value);
        if (text) {
          responseText += text;
          currentTurnText += text;
          callbacks.onDelta?.(text);
        }
        const foundSession = sessionFromEvent(item.value);
        if (foundSession && foundSession !== nextSessionId) {
          nextSessionId = foundSession;
          callbacks.onSessionId?.(foundSession);
        }
        const foundUsage = usageFromEvent(item.value);
        if (foundUsage) {
          usage = foundUsage;
          callbacks.onUsage?.(usage);
        }
        const foundModel = modelFromEvent(item.value);
        if (foundModel) {
          callbacks.onModelChange?.({ model: foundModel, contextLimit: contextLimitFromModel(foundModel) });
        }
        const compactEvent = compactEventFromEvent(item.value);
        if (compactEvent) {
          callbacks.onCompactEvent?.(compactEvent);
        }
        const previousToolCount = tools.size;
        handleToolPayload(item.value, tools, outputPaths, callbacks.onToolEvent);
        if (tools.size > previousToolCount) {
          for (const count of TOOL_PROGRESS_NOTICE_COUNTS) {
            if (tools.size >= count && !announcedToolProgress.has(count)) {
              announcedToolProgress.add(count);
              callbacks.onLog?.("claude_tool_progress_notice", {
                count,
                responseStarted: Boolean(responseText),
                message: `Agent 已连续执行 ${count} 个操作，仍在继续；如需停止请点击停止按钮。`
              });
              callbacks.onStatus?.("continuing");
            }
          }
        }
        if (item.value.type === "result" && !currentTurnText && item.value.result) {
          const resultText = String(item.value.result);
          responseText += resultText;
          currentTurnText = resultText;
          callbacks.onDelta?.(resultText);
        }
        if (item.value.type === "result" && bridgeMode) {
          lastTurnText = currentTurnText;
          callbacks.onTurnComplete?.({ text: currentTurnText, pendingTurns: 0, sessionId: nextSessionId || sessionId || "", usage });
          currentTurnText = "";
          closeBridgeInputSoon();
        }
      }
    }

    function executeCommand() {
      return bridgeMode ? executeBridge() : executeDirect();
    }

    function executeDirect() {
      return new Promise((resolve, reject) => {
        if (cancelled) return reject(cancellationError());
        client.exec(command, { pty: false }, (error, stream) => {
          if (error) return reject(asConnectionFailure(error));
          channel = stream;
          stream.on("data", (data) => handleEvents(parser.push(data)));
          stream.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
          stream.on("error", (error) => reject(asConnectionFailure(error)));
          stream.on("close", (code) => {
            if (channel === stream) channel = undefined;
            handleEvents(parser.finish());
            callbacks.onLog?.("claude_command_close", {
              exitCode: code,
              cancelled,
              receivedTextLength: responseText.length,
              sessionId: nextSessionId || sessionId || "",
              stderr: cleanError(stderr),
              transport: "direct-cli"
            });
            if (cancelled) return reject(cancellationError());
            if (code === undefined || code === null) return reject(asConnectionFailure(new Error("SSH 数据流意外中断。")));
            if (code !== 0) return reject(new Error(friendlyClaudeLaunchError(cleanError(stderr) || `Claude 已退出（代码 ${code}）。`, { host: config.host })));
            resolve();
          });
        });
      });
    }

    function executeBridge() {
      return new Promise((resolve, reject) => {
        if (cancelled) return reject(cancellationError());
        client.exec(command, { pty: false }, (error, stream) => {
          if (error) return reject(asConnectionFailure(error));
          channel = stream;
          const startPrompt = message + attachmentNote;
          stream.write(JSON.stringify({
            type: "start",
            prompt: startPrompt,
            automatic: Boolean(config.skipPermissions),
            workingDirectory: config.workingDirectory || home,
            claudePath: resolvedClaude,
            sessionId: sessionId || ""
          }) + "\n");
          const followUps = bufferedStreamInputs.splice(0);
          for (const followUp of followUps) {
            writeBridgeFollowUp(followUp.text).then(followUp.resolve);
          }
          if (cancelled) stream.write(JSON.stringify({ type: "interrupt" }) + "\n");
          stream.on("data", (data) => handleEvents(parser.push(data)));
          stream.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
          stream.on("error", (error) => reject(asConnectionFailure(error)));
          stream.on("close", (code) => {
            if (channel === stream) channel = undefined;
            if (interruptTimer) clearTimeout(interruptTimer);
            if (bridgeCloseTimer) clearTimeout(bridgeCloseTimer);
            rejectPendingFollowUps();
            handleEvents(parser.finish());
            callbacks.onLog?.("claude_command_close", {
              exitCode: code,
              cancelled,
              receivedTextLength: responseText.length,
              sessionId: nextSessionId || sessionId || "",
              stderr: cleanError(stderr)
            });
            if (cancelled) return reject(cancellationError());
            if (code === undefined || code === null) return reject(asConnectionFailure(new Error("SSH 数据流意外中断。")));
            if (code !== 0) return reject(new Error(friendlyClaudeLaunchError(cleanError(stderr) || `Claude 已退出（代码 ${code}）。`, { host: config.host })));
            resolve();
          });
        });
      });
    }
  })().finally(async () => {
    if (requestTimer) clearTimeout(requestTimer);
    if (interruptTimer) clearTimeout(interruptTimer);
    if (bridgeCloseTimer) clearTimeout(bridgeCloseTimer);
    rejectPendingFollowUps();
    if (client && uploaded.length) await cleanupRemoteAttachments(client, uploaded).catch(() => {});
    client?.end();
  });

  return {
    promise: operation,
    cancel() {
      interruptRemote("user", "已停止生成。");
    },
    pushFollowUp(message) {
      return pushFollowUp(message);
    }
  };
}

function asConnectionFailure(error) {
  const result = error instanceof Error ? error : new Error(String(error));
  result.connectionFailure = true;
  return result;
}

async function uploadAttachments(client, attachments, conversationId, onProgress) {
  if (!attachments.length) return [];
  const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
  if (!home) throw new Error("无法确定 NAS 的 SSH 主目录，附件未上传。");
  const safeFolder = String(conversationId || "default").replace(/[^a-zA-Z0-9-]/g, "");
  const remoteDirectory = `${home}/.agent-orbit/uploads/${safeFolder}`;
  const created = await exec(client, `mkdir -p -- ${shellQuote(remoteDirectory)}`);
  if (created.code !== 0) throw new Error(created.stderr || "无法在 NAS 创建附件目录。");
  const sftp = await openSftp(client);
  const uploaded = [];
  try {
    for (const [index, file] of attachments.entries()) {
      const name = safeRemoteFileName(file.name || `attachment-${index + 1}`);
      const remotePath = `${remoteDirectory}/${Date.now()}-${index + 1}-${name}`;
      const data = Buffer.from(file.data);
      await writeSftp(sftp, remotePath, data, (sent) => onProgress?.({
        index,
        name: file.name,
        sent,
        total: data.length,
        overall: (index + (data.length ? sent / data.length : 1)) / attachments.length
      }));
      uploaded.push({ path: remotePath, name: file.name, mimeType: file.mimeType || mimeFromPath(file.name) });
    }
    return uploaded;
  } catch (error) {
    closeSftp(sftp);
    await cleanupRemoteAttachments(client, uploaded).catch(() => {});
    throw error;
  } finally { closeSftp(sftp); }
}

async function cleanupRemoteAttachments(client, uploaded) {
  const paths = (uploaded || []).map((file) => file?.path).filter(isSafeRemotePath);
  if (!paths.length) return false;
  const directories = [...new Set(paths.map((remotePath) => remotePath.slice(0, remotePath.lastIndexOf("/"))))];
  const command = `rm -f -- ${paths.map(shellQuote).join(" ")}`
    + (directories.length ? `; rmdir -- ${directories.map(shellQuote).join(" ")} 2>/dev/null || true` : "");
  await exec(client, command);
  return true;
}

function openSftp(client) {
  return withTimeout("SFTP 连接", SFTP_OPERATION_TIMEOUT_MS,
    () => new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp))),
    () => client.end());
}

function writeSftp(sftp, remotePath, data, onProgress) {
  return withTimeout("SFTP 上传", SFTP_OPERATION_TIMEOUT_MS, () => new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath, { mode: 0o600 });
    stream.once("error", reject);
    stream.once("close", resolve);
    let offset = 0;
    const writeNext = () => {
      while (offset < data.length) {
        const end = Math.min(offset + 64 * 1024, data.length);
        const ready = stream.write(data.subarray(offset, end));
        offset = end;
        onProgress?.(offset);
        if (!ready) return stream.once("drain", writeNext);
      }
      stream.end();
    };
    writeNext();
  }), () => closeSftp(sftp));
}

async function connectWithRetry(config, onUnknownHost, onLog, onStatus) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      return await connect(config, onUnknownHost, onLog);
    } catch (error) {
      lastError = error;
      if (!isTransientConnectionError(error) || attempt === MAX_CONNECT_ATTEMPTS) throw error;
      const maximumDelayMs = Math.min(15_000, 600 * (2 ** (attempt - 1)));
      const delayMs = Math.floor(Math.random() * (maximumDelayMs + 1));
      onLog?.("ssh_reconnect_attempt", { host: config.host, attempt: attempt + 1, maxAttempts: MAX_CONNECT_ATTEMPTS, delayMs, error: error.message });
      onStatus?.("reconnecting");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function isTransientConnectionError(error) {
  const value = String(error?.message || error);
  if (/密码|账号|authentication|指纹|host key/i.test(value)) return false;
  return /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|连接超时|socket.*(?:closed|ended)/i.test(value);
}

function buildAttachmentNote(files) {
  const lines = files.map((file) => `- 原始文件名：${JSON.stringify(String(file.name || "附件"))}\n  NAS 路径：${JSON.stringify(String(file.path || ""))}`);
  const images = files.filter((file) => String(file.mimeType).startsWith("image/"));
  let note = "\n\n用户附加了以下已上传到 NAS 的本地文件。请按 NAS 路径读取；原始文件名只用于识别：\n" + lines.join("\n");
  if (images.length) {
    note += "\n\n硬性要求：不要用 Read 读取图片。请逐张运行 image-decoder 技能的独立脚本："
      + "python3 /home/demo-user/.claude/skills/image-decoder/scripts/decode_image.py <图片路径>，"
      + "只读取脚本返回的文字描述，再回答用户。";
  }
  if (files.length > images.length) note += "\n普通文本或代码文件可按需使用 Read 工具读取。";
  return note;
}

function safeRemoteFileName(value) {
  const fallback = "attachment";
  const normalized = String(value || fallback)
    .normalize("NFC")
    .replace(/[\\/\x00-\x1F\x7F]/g, "_")
    .trim();
  const candidate = normalized && !/^\.+$/.test(normalized) ? normalized : fallback;
  let result = "";
  let bytes = 0;
  for (const character of candidate) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 180) break;
    result += character;
    bytes += size;
  }
  return result || fallback;
}

function handleToolPayload(payload, tools, outputPaths, onToolEvent) {
  const block = payload?.event?.content_block;
  if (payload?.type === "stream_event" && payload.event?.type === "content_block_start" && block?.type === "tool_use") {
    const tool = { id: block.id, name: block.name, status: "running", input: block.input || {} };
    tools.set(tool.id, tool);
    onToolEvent?.(tool);
  }
  if (payload?.type === "assistant") {
    for (const content of payload.message?.content || []) {
      if (content.type !== "tool_use") continue;
      const tool = { id: content.id, name: content.name, status: "running", input: content.input || {} };
      tools.set(tool.id, tool);
      if (["Write", "Edit", "NotebookEdit"].includes(content.name)) collectOutputPath(content.input, outputPaths);
      onToolEvent?.(tool);
    }
  }
  if (payload?.type === "user") {
    for (const content of payload.message?.content || []) {
      if (content.type !== "tool_result") continue;
      const prior = tools.get(content.tool_use_id) || { id: content.tool_use_id, name: "工具" };
      const tool = { ...prior, status: content.is_error ? "failed" : "completed", result: summarizeToolResult(content.content) };
      tools.set(tool.id, tool);
      const filePath = payload.tool_use_result?.filePath;
      if (filePath && ["Write", "Edit", "NotebookEdit"].includes(prior.name)) outputPaths.add(filePath);
      if (prior.name === "Bash") collectPathsFromText(content.content, outputPaths);
      onToolEvent?.(tool);
    }
  }
  if (payload?.type === "result") {
    for (const denial of payload.permission_denials || []) {
      const id = denial.tool_use_id || denial.toolUseId || `denied-${tools.size}`;
      const prior = tools.get(id) || { id, name: denial.tool_name || denial.toolName || "工具" };
      const tool = { ...prior, status: "denied", result: "未获得执行权限" };
      tools.set(id, tool);
      onToolEvent?.(tool);
    }
  }
}

function collectOutputPath(input, paths) {
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = input?.[key];
    if (typeof value === "string" && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value))) paths.add(value);
  }
}

function summarizeToolResult(content) {
  const value = typeof content === "string" ? content : JSON.stringify(content || "");
  return value.replace(/\s+/g, " ").slice(0, 180);
}

function collectPathsFromText(content, paths) {
  const value = typeof content === "string" ? content : JSON.stringify(content || "");
  const matches = value.match(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s'"`<>|]+[\\/])*[^\s'"`<>|]+\.(?:png|jpe?g|gif|webp|pdf|txt|md|json|csv|zip|docx|xlsx|pptx)/gi) || [];
  matches.forEach((filePath) => paths.add(filePath.replace(/[),.;:]+$/, "")));
}

async function inspectRemoteFiles(client, candidates, uploadedPaths) {
  if (!candidates.length) return [];
  const sftp = await openSftp(client);
  const files = [];
  try {
    for (const remotePath of [...new Set(candidates)].slice(0, 20)) {
      if (uploadedPaths.has(remotePath) || !isSafeRemotePath(remotePath)) continue;
      try {
        const stat = await sftpStat(sftp, remotePath);
        if (!stat.isFile()) continue;
        files.push({
          remotePath,
          name: remotePath.split("/").pop() || "文件",
          size: stat.size,
          mimeType: mimeFromPath(remotePath),
          isImage: mimeFromPath(remotePath).startsWith("image/") && mimeFromPath(remotePath) !== "image/svg+xml"
        });
      } catch { /* File may have been temporary or removed by Claude. */ }
    }
  } finally { closeSftp(sftp); }
  return files;
}

function sftpStat(sftp, remotePath) {
  return withTimeout("SFTP 文件状态查询", SFTP_OPERATION_TIMEOUT_MS,
    () => new Promise((resolve, reject) => sftp.stat(remotePath, (error, stat) => error ? reject(error) : resolve(stat))),
    () => closeSftp(sftp));
}

function isSafeRemotePath(remotePath) {
  return typeof remotePath === "string" && remotePath.startsWith("/") && remotePath.length < 4096 && !remotePath.includes("\0");
}

function mimeFromPath(filePath) {
  const extension = String(filePath).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })[extension] || "application/octet-stream";
}

async function readRemoteFile(config, remotePath, maximumBytes, onUnknownHost, onLog) {
  if (!isSafeRemotePath(remotePath)) throw new Error("远程文件路径无效。");
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const sftp = await openSftp(client);
    try {
      const stat = await sftpStat(sftp, remotePath);
      if (!stat.isFile()) throw new Error("远程路径不是文件。");
      if (stat.size > maximumBytes) throw new Error(`文件超过 ${Math.round(maximumBytes / 1024 / 1024)} MB，无法直接预览。`);
      return await readSftp(sftp, remotePath, stat.size);
    } finally { closeSftp(sftp); }
  } finally { client.end(); }
}

async function downloadRemoteFile(config, remotePath, localPath, onUnknownHost, onLog) {
  if (!isSafeRemotePath(remotePath)) throw new Error("远程文件路径无效。");
  const temporary = `${localPath}.agent-chat-pro-part-${process.pid}`;
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const sftp = await openSftp(client);
    try {
      await fastGet(sftp, remotePath, temporary);
      fs.copyFileSync(temporary, localPath);
      fs.rmSync(temporary, { force: true });
    } finally { closeSftp(sftp); }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally { client.end(); }
  return localPath;
}

function readSftp(sftp, remotePath, _expectedSize) {
  return withTimeout("SFTP 文件读取", SFTP_OPERATION_TIMEOUT_MS, () => new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const stream = sftp.createReadStream(remotePath);
    stream.on("data", (chunk) => { chunks.push(chunk); total += chunk.length; });
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks, total)));
  }), () => closeSftp(sftp));
}

function fastGet(sftp, remotePath, localPath) {
  return withTimeout("SFTP 文件下载", SFTP_OPERATION_TIMEOUT_MS,
    () => new Promise((resolve, reject) => sftp.fastGet(remotePath, localPath, {}, (error) => error ? reject(error) : resolve())),
    () => closeSftp(sftp));
}

function closeSftp(sftp) {
  try { sftp?.end(); } catch { /* The channel may already be closed after a timeout. */ }
}

function withTimeout(label, timeoutMs, operation, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* Preserve the original timeout error. */ }
      finish(reject, new Error(`${label} 超时（${Math.round(timeoutMs / 1000)} 秒），已关闭当前传输，请检查网络后重试。`));
    }, timeoutMs);
    Promise.resolve().then(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function exec(client, command, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stream;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const timeoutMs = Number(options.timeoutMs || 0);
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { stream?.close(); } catch { /* The SSH channel may not have opened. */ }
        finish(reject, new Error(`${options.label || "远程操作"}超时（${Math.round(timeoutMs / 1000)} 秒），请检查 NAS 网络、权限或 npm 依赖源。`));
      }, timeoutMs);
    }
    client.exec(command, (error, openedStream) => {
      if (error) return finish(reject, error);
      stream = openedStream;
      stream.on("data", (data) => { stdout += data.toString("utf8"); });
      stream.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
      stream.on("error", (streamError) => finish(reject, streamError));
      stream.on("close", (code) => finish(resolve, { code, stdout, stderr }));
    });
  });
}

function cleanError(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

module.exports = { buildAttachmentNote, cleanupRemoteAttachments, downloadRemoteFile, ensureDeviceControlKey, finalizeDeviceControl, getAgentSdkBridgeStatus, getClaudeModelStatus, handleToolPayload, installAgentSdkBridge, markDeviceControlDisabled, mimeFromPath, readRemoteFile, runClaude, safeRemoteFileName, uninstallAgentSdkBridge, updateClaudeModel, verifyConnection, withTimeout, writeSftp };