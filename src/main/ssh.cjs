"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("ssh2");
const {
  JsonLineParser,
  buildClaudeCommand,
  shellQuote,
  sessionFromEvent,
  textFromEvent
} = require("./protocol.cjs");

const MAX_SILENT_TOOL_CALLS = 8;
const MAX_TOOL_CALLS = 24;
const MAX_REQUEST_MS = 10 * 60 * 1000;

function connect(config, onUnknownHost, onLog = () => {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    onLog("ssh_connect_start", { host: config.host, port: config.port, username: config.username });
    const timeout = setTimeout(() => {
      client.end();
      onLog("ssh_connect_timeout", { host: config.host, port: config.port });
      reject(new Error("SSH 连接超时，请检查地址、端口和 NAS 是否在线。"));
    }, 15_000);

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
      readyTimeout: 15_000,
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
    const prefix = directory ? `cd -- ${shellQuote(directory)} && ` : "";
    const result = await exec(client, `${prefix}${shellQuote(config.wakeName)} --version`);
    onLog?.("claude_version_result", { exitCode: result.code, version: result.stdout.trim(), stderr: result.stderr.trim() });
    if (result.code !== 0) throw new Error(result.stderr || "无法运行 Claude 命令。");
    return result.stdout.trim() || "已连接";
  } finally {
    client.end();
  }
}

async function ensureDeviceControlKey(config, deviceId, metadata, onUnknownHost, onLog) {
  const safeId = String(deviceId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80);
  if (!safeId) throw new Error("无法创建联动设备编号。");
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const directory = `${home}/.claude-nas-chat/device-control/${safeId}`;
    const privateKeyPath = `${directory}/id_ed25519`;
    const command = [
      "umask 077",
      `mkdir -p -- ${shellQuote(directory)}`,
      `test -f ${shellQuote(privateKeyPath)} || ssh-keygen -q -t ed25519 -N '' -C ${shellQuote(`claude-nas-agent-${safeId}`)} -f ${shellQuote(privateKeyPath)}`,
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
      account: "ClaudeAgentControl",
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
    const destination = `ClaudeAgentControl@${target}`;
    const sshArguments = `-p ${targetPort} -i ${shellQuote(key.privateKeyPath)} -o BatchMode=yes -o IdentitiesOnly=yes -o PasswordAuthentication=no -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(knownHosts)} ${shellQuote(destination)}`;
    const probe = await exec(client, `ssh ${sshArguments} ${shellQuote("echo CLAUDE_NAS_AGENT_READY")}`);
    if (probe.code !== 0 || !probe.stdout.includes("CLAUDE_NAS_AGENT_READY")) {
      throw new Error(probe.stderr.trim() || "NAS 使用专属密钥回连 Windows 失败。");
    }
    const script = `#!/bin/sh\nexec ssh ${sshArguments} \"$@\"\n`;
    const sftp = await openSftp(client);
    try { await writeSftp(sftp, connectScript, Buffer.from(script, "utf8")); } finally { sftp.end(); }
    await exec(client, `chmod 700 ${shellQuote(connectScript)}`);
    await writeRemoteJson(client, `${directory}/device.json`, {
      deviceId: key.deviceId,
      hostname: String(metadata?.hostname || ""),
      targetAddress: target,
      account: "ClaudeAgentControl",
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
      account: "ClaudeAgentControl",
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
  finally { sftp.end(); }
}

async function getAgentSdkBridgeStatus(config, onUnknownHost, onLog) {
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const bridgePath = `${home}/.claude-nas-chat/bridge`;
    const nodePath = (await exec(client, "command -v node")).stdout.trim();
    const probe = await exec(client, [`test -r ${shellQuote(`${bridgePath}/agent-sdk-bridge.mjs`)}`, `test -r ${shellQuote(`${bridgePath}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`)}`, `node --check ${shellQuote(`${bridgePath}/agent-sdk-bridge.mjs`)}`].join(" && "));
    const ready = Boolean(nodePath) && probe.code === 0;
    return { path: bridgePath, nodeAvailable: Boolean(nodePath), installed: probe.code === 0, ready, detail: ready ? "已安装并通过语法校验" : nodePath ? "未安装或依赖不完整" : "目标 NAS 未找到 Node.js" };
  } finally { client.end(); }
}

async function installAgentSdkBridge(config, files, onUnknownHost, onLog) {
  const safeFiles = normalizeBridgeFiles(files);
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const nodePath = (await exec(client, "command -v node")).stdout.trim();
    const npmPath = (await exec(client, "command -v npm")).stdout.trim();
    if (!nodePath || !npmPath) throw new Error("目标 NAS 缺少 Node.js 或 npm，无法安装增强 Bridge。");
    const base = `${home}/.claude-nas-chat`;
    const target = `${base}/bridge`;
    const staging = `${base}/bridge.staging-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const backup = `${base}/bridge.backup-${Date.now()}`;
    const prepared = await exec(client, `mkdir -p -- ${shellQuote(base)} && rm -rf -- ${shellQuote(staging)} && mkdir -p -- ${shellQuote(staging)}`);
    if (prepared.code !== 0) throw new Error(cleanError(prepared.stderr) || "无法准备 Bridge 安装目录。");
    const sftp = await openSftp(client);
    try { for (const file of safeFiles) await writeSftp(sftp, `${staging}/${file.name}`, file.data); } finally { sftp.end(); }
    const dependencies = await exec(client, `cd -- ${shellQuote(staging)} && npm ci --omit=dev --ignore-scripts --no-audit --no-fund`);
    if (dependencies.code !== 0) {
      await exec(client, `rm -rf -- ${shellQuote(staging)}`);
      throw new Error(cleanError(dependencies.stderr) || "Bridge 依赖安装失败，请检查 NAS 的 npm 网络与权限。");
    }
    const check = await exec(client, `node --check ${shellQuote(`${staging}/agent-sdk-bridge.mjs`)} && test -r ${shellQuote(`${staging}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`)}`);
    if (check.code !== 0) {
      await exec(client, `rm -rf -- ${shellQuote(staging)}`);
      throw new Error(cleanError(check.stderr) || "Bridge 文件校验失败，未替换现有版本。");
    }
    const promote = await exec(client, [`rm -rf -- ${shellQuote(backup)}`, `if test -e ${shellQuote(target)}; then mv -- ${shellQuote(target)} ${shellQuote(backup)}; fi`, `mv -- ${shellQuote(staging)} ${shellQuote(target)}`, `rm -rf -- ${shellQuote(backup)}`].join(" && "));
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
    const target = `${home}/.claude-nas-chat/bridge`;
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
    if (!channel) {
      return;
    }
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

  const operation = (async () => {
    requestTimer = setTimeout(() => interruptRemote(
      "request_timeout",
      "本次请求已运行 10 分钟，客户端为防止无限消耗已自动停止。"
    ), MAX_REQUEST_MS);
    requestTimer.unref?.();
    callbacks.onStatus?.("connecting");
    client = await connectWithRetry(config, callbacks.onUnknownHost, callbacks.onLog, callbacks.onStatus);
    if (cancelled) throw cancellationError();
    callbacks.onStatus?.("connected");
    let parser = new JsonLineParser();
    const uploaded = await uploadAttachments(client, attachments, callbacks.conversationId, callbacks.onUploadProgress);
    if (cancelled) throw cancellationError();
    const attachmentNote = uploaded.length
      ? buildAttachmentNote(uploaded)
      : "";
    const home = (await exec(client, "printf %s \"$HOME\"")).stdout.trim();
    if (!home) throw new Error("无法确定 NAS 的 SSH 主目录。");
    const bridgePath = `${home}/.claude-nas-chat/bridge/agent-sdk-bridge.mjs`;
    const bridgeCheck = await exec(client, `test -r ${shellQuote(bridgePath)} && printf READY`);
    bridgeMode = bridgeCheck.stdout.trim() === "READY";
    const wakeName = String(config.wakeName || "claude").trim();
    let resolvedClaude = "";
    if (bridgeMode) {
      resolvedClaude = (await exec(client, `command -v -- ${shellQuote(wakeName)}`)).stdout.trim();
      if (!resolvedClaude) throw new Error(`NAS 找不到 Agent 唤醒命令：${wakeName}`);
    }
    const command = bridgeMode
      ? `node ${shellQuote(bridgePath)}`
      : buildClaudeCommand(config, message + attachmentNote, sessionId);
    if (!bridgeMode) {
      callbacks.onLog?.("bridge_unavailable_direct_fallback", { bridgePath, wakeName });
    }
    callbacks.onLog?.("claude_command_start", {
      hasSession: Boolean(sessionId),
      attachmentCount: uploaded.length,
      wakeName: config.wakeName,
      workingDirectory: config.workingDirectory || "",
      transport: bridgeMode ? "agent-sdk-bridge" : "direct-cli"
    });
    let stderr = "";
    let responseText = "";
    let nextSessionId = "";
    const tools = new Map();
    const outputPaths = new Set();

    try {
      await executeCommand();
    } catch (error) {
      if (!error.connectionFailure || responseText || tools.size || cancelled) throw error;
      callbacks.onLog?.("ssh_stream_reconnect", { error: error.message, safeToRetry: true });
      callbacks.onStatus?.("reconnecting");
      client.end();
      await new Promise((resolve) => setTimeout(resolve, 600));
      client = await connectWithRetry(config, callbacks.onUnknownHost, callbacks.onLog, callbacks.onStatus);
      callbacks.onStatus?.("connected");
      parser = new JsonLineParser();
      stderr = "";
      await executeCommand();
    }

    const files = await inspectRemoteFiles(client, [...outputPaths], new Set(uploaded.map((file) => file.path)));
    return { sessionId: nextSessionId || sessionId, text: responseText, files, tools: [...tools.values()] };

    function handleEvents(events) {
      for (const item of events) {
        if (!item.value) continue;
        if (item.value.type === "bridge_ready") continue;
        if (item.value.type === "bridge_interrupt_received") {
          if (interruptTimer) clearTimeout(interruptTimer);
          callbacks.onLog?.("claude_interrupt_ack", {});
          callbacks.onStatus?.("stopping");
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
        const text = textFromEvent(item.value);
        if (text) {
          responseText += text;
          callbacks.onDelta?.(text);
        }
        const foundSession = sessionFromEvent(item.value);
        if (foundSession) nextSessionId = foundSession;
        const previousToolCount = tools.size;
        handleToolPayload(item.value, tools, outputPaths, callbacks.onToolEvent);
        if (tools.size > previousToolCount) {
          if (!responseText && tools.size >= MAX_SILENT_TOOL_CALLS) {
            interruptRemote(
              "silent_tool_limit",
              `Agent 连续执行了 ${MAX_SILENT_TOOL_CALLS} 个操作但没有返回说明，客户端已自动停止，避免无限重试和消耗 Token。`
            );
          } else if (tools.size >= MAX_TOOL_CALLS) {
            interruptRemote(
              "tool_limit",
              `Agent 本轮已执行 ${MAX_TOOL_CALLS} 个操作，达到安全上限，客户端已自动停止。请拆分任务后继续。`
            );
          }
        }
        if (item.value.type === "result" && !responseText && item.value.result) {
          responseText = item.value.result;
          callbacks.onDelta?.(responseText);
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
            if (code !== 0) return reject(new Error(cleanError(stderr) || `Claude 已退出（代码 ${code}）。`));
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
          stream.write(JSON.stringify({
            type: "start",
            prompt: message + attachmentNote,
            automatic: Boolean(config.skipPermissions),
            workingDirectory: config.workingDirectory || home,
            claudePath: resolvedClaude,
            sessionId: sessionId || ""
          }) + "\n");
          if (cancelled) stream.write(JSON.stringify({ type: "interrupt" }) + "\n");
          stream.on("data", (data) => handleEvents(parser.push(data)));
          stream.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
          stream.on("error", (error) => reject(asConnectionFailure(error)));
          stream.on("close", (code) => {
            if (channel === stream) channel = undefined;
            if (interruptTimer) clearTimeout(interruptTimer);
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
            if (code !== 0) return reject(new Error(cleanError(stderr) || `Claude 已退出（代码 ${code}）。`));
            resolve();
          });
        });
      });
    }
  })().finally(() => {
    if (requestTimer) clearTimeout(requestTimer);
    if (interruptTimer) clearTimeout(interruptTimer);
    client?.end();
  });

  return {
    promise: operation,
    cancel() {
      interruptRemote("user", "已停止生成。");
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
  const remoteDirectory = `${home}/.claude-nas-chat/uploads/${safeFolder}`;
  const created = await exec(client, `mkdir -p -- ${shellQuote(remoteDirectory)}`);
  if (created.code !== 0) throw new Error(created.stderr || "无法在 NAS 创建附件目录。");
  const sftp = await openSftp(client);
  const uploaded = [];
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
  sftp.end();
  return uploaded;
}

function openSftp(client) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
}

function writeSftp(sftp, remotePath, data, onProgress) {
  return new Promise((resolve, reject) => {
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
  });
}

function connectWithRetry(config, onUnknownHost, onLog, onStatus) {
  return connect(config, onUnknownHost, onLog).catch(async (error) => {
    if (!isTransientConnectionError(error)) throw error;
    onLog?.("ssh_reconnect_attempt", { host: config.host, error: error.message });
    onStatus?.("reconnecting");
    await new Promise((resolve) => setTimeout(resolve, 600));
    return connect(config, onUnknownHost, onLog);
  });
}

function isTransientConnectionError(error) {
  const value = String(error?.message || error);
  return !/密码|账号|authentication|指纹|host key|ECONNREFUSED/i.test(value);
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
  } finally { sftp.end(); }
  return files;
}

function sftpStat(sftp, remotePath) {
  return new Promise((resolve, reject) => sftp.stat(remotePath, (error, stat) => error ? reject(error) : resolve(stat)));
}

function isSafeRemotePath(remotePath) {
  return typeof remotePath === "string" && remotePath.startsWith("/") && remotePath.length < 4096 && !remotePath.includes("\0");
}

function mimeFromPath(filePath) {
  const extension = String(filePath).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })[extension] || "application/octet-stream";
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
    } finally { sftp.end(); }
  } finally { client.end(); }
}

async function downloadRemoteFile(config, remotePath, localPath, onUnknownHost, onLog) {
  if (!isSafeRemotePath(remotePath)) throw new Error("远程文件路径无效。");
  const temporary = `${localPath}.claude-nas-part-${process.pid}`;
  const client = await connectWithRetry(config, onUnknownHost, onLog);
  try {
    const sftp = await openSftp(client);
    try {
      await fastGet(sftp, remotePath, temporary);
      fs.copyFileSync(temporary, localPath);
      fs.rmSync(temporary, { force: true });
    } finally { sftp.end(); }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally { client.end(); }
  return localPath;
}

function readSftp(sftp, remotePath, _expectedSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const stream = sftp.createReadStream(remotePath);
    stream.on("data", (chunk) => { chunks.push(chunk); total += chunk.length; });
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks, total)));
  });
}

function fastGet(sftp, remotePath, localPath) {
  return new Promise((resolve, reject) => sftp.fastGet(remotePath, localPath, {}, (error) => error ? reject(error) : resolve()));
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      stream.on("data", (data) => { stdout += data.toString("utf8"); });
      stream.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
      stream.on("error", reject);
      stream.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  });
}

function cleanError(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

module.exports = { buildAttachmentNote, downloadRemoteFile, ensureDeviceControlKey, finalizeDeviceControl, getAgentSdkBridgeStatus, handleToolPayload, installAgentSdkBridge, markDeviceControlDisabled, mimeFromPath, readRemoteFile, runClaude, safeRemoteFileName, uninstallAgentSdkBridge, verifyConnection, writeSftp };
