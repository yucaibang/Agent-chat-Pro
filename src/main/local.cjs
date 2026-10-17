"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { JsonLineParser, buildClaudeArgs, compactEventFromEvent, contextLimitFromModel, modelFromEvent, sessionFromEvent, textFromEvent, usageFromEvent } = require("./protocol.cjs");
const { buildLocalArgsWithMode } = require("./modes/mode-params.cjs");
const { handleToolPayload, mimeFromPath } = require("./ssh.cjs");
const { friendlyClaudeLaunchError, describeMissingWorkingDirectory } = require("./claude-launch-diagnostics.cjs");
const { readModelSettings, replaceModelSettings, replaceSingleModelSetting, replaceAutoCompactWindowSetting } = require("./model-config.cjs");

const MAX_REQUEST_MS = 30 * 60 * 1000;
const TOOL_PROGRESS_NOTICE_COUNTS = [8, 24];

async function verifyLocalConnection(config, onLog) {
  const command = await resolveLocalCommand(config.wakeName);
  const result = await runProcess(command, ["--version"], "", config.workingDirectory);
  onLog?.("local_claude_version_result", { exitCode: result.code, version: result.stdout.trim(), stderr: result.stderr.trim() });
  if (result.code !== 0) throw new Error(friendlyClaudeLaunchError(cleanError(result.stderr) || "无法运行本机 Claude 命令。", { local: true }));
  return result.stdout.trim() || "本机 Claude 已就绪";
}

async function getLocalClaudeModelStatus(config, onLog) {
  const settingsPath = path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "settings.json");
  try {
    const content = fs.readFileSync(settingsPath, "utf8");
    const parsed = readModelSettings(content);
    return { model: parsed.model, models: parsed.models, consistent: parsed.consistent, settingsPath };
  } catch (error) {
    throw new Error("无法读取本机 Claude 模型配置：" + error.message);
  }
}

async function updateLocalClaudeModel(modelName, onLog) {
  const model = String(modelName || "").trim();
  if (!model) throw new Error("请填写模型名称。");
  const settingsPath = path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "settings.json");
  let current;
  try {
    current = fs.readFileSync(settingsPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      // v3.18.0 修复：种子必须带 env 对象——"{}" 会被 readModelSettings 判「缺少 env 配置」拒绝，全新机首次写入必炸
      const replacement = replaceModelSettings('{"env":{}}', model);
      const dir = path.dirname(settingsPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, replacement.settings, { mode: 0o600 });
      return { model: replacement.model, changedKeys: replacement.changedKeys };
    }
    throw new Error("无法读取本机 Claude 模型配置：" + error.message);
  }
  const replacement = replaceModelSettings(current, model);
  const temporary = `${settingsPath}.claude-local-model-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, replacement.settings, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, settingsPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw new Error("模型配置未能保存：" + error.message);
  }
  onLog?.("local_claude_model_changed", { model: replacement.model, changedKeys: replacement.changedKeys });
  return { model: replacement.model, changedKeys: replacement.changedKeys };
}

// v3.18.0 F2：本机五项单独修改 + 自动压缩阈值（与远端同语义；写前备份 .bak-model，临时文件原子替换）
function localClaudeSettingsPath() {
  return path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "settings.json");
}

function writeLocalClaudeSettingsFile(settingsPath, current, mutation, onLog, contextLabel) {
  let replacement;
  try {
    replacement = mutation(current);
  } catch (error) {
    throw new Error(error.message.replace(/Claude settings\.json/g, "本机 Claude 配置"));
  }
  // 写前备份（规格 §1.5：写坏 settings.json 会砸链路）
  let backedUp = false;
  try { fs.copyFileSync(settingsPath, `${settingsPath}.bak-model`); backedUp = true; } catch { /* 缺备份不阻断：临时文件替换本身可回退 */ }
  const temporary = `${settingsPath}.claude-local-model-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, replacement.settings, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, settingsPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw new Error(`${contextLabel}未能保存：` + error.message);
  }
  onLog?.("local_claude_model_changed", { changedKeys: replacement.changedKeys, backup: backedUp });
  return replacement;
}

async function updateLocalClaudeModelEntry(entryId, modelName, onLog) {
  await getLocalClaudeModelStatus(); // 文件不存在/不可读时先给出明确错误
  const settingsPath = localClaudeSettingsPath();
  const current = fs.readFileSync(settingsPath, "utf8");
  const replacement = writeLocalClaudeSettingsFile(settingsPath, current, (source) => replaceSingleModelSetting(source, entryId, modelName), onLog, "模型配置项");
  const verified = readModelSettings(fs.readFileSync(settingsPath, "utf8"));
  return { entry: replacement.entry, changedKeys: replacement.changedKeys, models: verified.models, entries: verified.entries, autoCompactWindow: verified.autoCompactWindow, consistent: verified.consistent, model: verified.model };
}

async function updateLocalAutoCompactWindow(value, onLog) {
  await getLocalClaudeModelStatus();
  const settingsPath = localClaudeSettingsPath();
  const current = fs.readFileSync(settingsPath, "utf8");
  const replacement = writeLocalClaudeSettingsFile(settingsPath, current, (source) => replaceAutoCompactWindowSetting(source, value), onLog, "自动压缩阈值");
  const verified = readModelSettings(fs.readFileSync(settingsPath, "utf8"));
  return { autoCompactWindow: replacement.autoCompactWindow, changedKeys: replacement.changedKeys, models: verified.models, entries: verified.entries, consistent: verified.consistent, model: verified.model };
}

function runLocalClaude(config, message, sessionId, attachments = [], callbacks = {}) {
  let child;
  let cancelled = false;
  let requestTimer;
  let currentTurnText = "";

  function cancellationError() {
    const error = new Error("已停止生成。");
    error.cancelled = true;
    return error;
  }

  const operation = (async () => {
    requestTimer = setTimeout(() => {
      cancelled = true;
      cancellationMessage = "本次请求已运行 30 分钟，客户端为防止无限消耗已自动停止。";
      child?.kill();
    }, MAX_REQUEST_MS);
    requestTimer.unref?.();

    callbacks.onStatus?.("local-starting");
    const command = await resolveLocalCommand(config.wakeName);
    const uploaded = await writeLocalAttachments(config.localUploadDirectory, attachments, callbacks.conversationId, callbacks.onUploadProgress);
    const prompt = message + buildLocalAttachmentNote(uploaded);
    const args = buildLocalArgsWithMode(config.workModeId || "regular", safeSessionId(sessionId), config);
    const launch = launchSpec(command, args);
    callbacks.onLog?.("local_claude_command_start", {
      hasSession: Boolean(sessionId),
      attachmentCount: uploaded.length,
      wakeName: config.wakeName,
      workingDirectory: config.workingDirectory || ""
    });
    callbacks.onStatus?.("connected");

    const parser = new JsonLineParser();
    let stderr = "";
    let responseText = "";
    let nextSessionId = "";
    let usage;
    const tools = new Map();
    const outputPaths = new Set();
    const announcedToolProgress = new Set();

    await new Promise((resolve, reject) => {
      child = spawn(launch.file, launch.args, {
        cwd: validatedWorkingDirectory(config.workingDirectory),
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const handleEvents = (events) => {
        for (const item of events) {
          if (!item.value) continue;
          const text = textFromEvent(item.value);
          if (text) {
            responseText += text;
            currentTurnText += text;
            callbacks.onDelta?.(text);
          }
          // v3.24.0 思考过程：extended thinking 增量透传（渲染层折叠块实时刷新，随消息落库）
          const thinking = thinkingFromEvent(item.value);
          if (thinking) callbacks.onThinking?.(thinking);
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
                callbacks.onLog?.("local_tool_progress_notice", {
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
        }
      };
      child.stdout.on("data", (data) => handleEvents(parser.push(data)));
      child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
      child.once("error", (error) => reject(localLaunchError(error, command)));
      child.once("close", (code) => {
        handleEvents(parser.finish());
        callbacks.onLog?.("local_claude_command_close", {
          exitCode: code,
          cancelled,
          receivedTextLength: responseText.length,
          sessionId: nextSessionId || sessionId || "",
          stderr: cleanError(stderr)
        });
        if (cancelled) return reject(cancellationError());
        if (code !== 0) return reject(new Error(friendlyClaudeLaunchError(cleanError(stderr) || `本机 Claude 已退出（代码 ${code}）。`, { local: true })));
        resolve();
      });
      child.stdin.end(prompt);
    });

    const files = inspectLocalFiles([...outputPaths], new Set(uploaded.map((file) => normalizePath(file.path))));
    return { sessionId: nextSessionId || sessionId, text: responseText, lastTurnText: currentTurnText, files, tools: [...tools.values()], usage };
  })().finally(() => {
    if (requestTimer) clearTimeout(requestTimer);
  });

  return {
    promise: operation,
    cancel() {
      cancelled = true;
      child?.kill();
    }
  };
}

async function resolveLocalCommand(value, subject = "本机 Claude 唤醒命令") {
  const command = String(value || "").trim();
  if (!command) throw new Error(`请填写${subject}。`);
  if (/[\0\r\n]/.test(command)) throw new Error(`${subject}无效。`);
  if (path.isAbsolute(command) || /[\\/]/.test(command)) {
    if (!fs.existsSync(command)) throw new Error(`找不到${subject}：${command}`);
    return command;
  }
  if (process.platform !== "win32") return command;
  const stdout = await new Promise((resolve, reject) => {
    execFile("where.exe", [command], { windowsHide: true }, (error, output) => error ? reject(error) : resolve(output));
  }).catch(() => "");
  const candidates = String(stdout).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const executableMatch = candidates.find((item) => /\.exe$/i.test(item));
  if (executableMatch) return executableMatch;
  if (command.toLocaleLowerCase() === "claude") {
    const knownPaths = [
      path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe"),
      path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code-win32-x64", "claude.exe"),
      path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code-win32-arm64", "claude.exe")
    ];
    const installed = knownPaths.find((item) => item && fs.existsSync(item));
    if (installed) return installed;
  }
  const scriptMatch = candidates.find((item) => /\.(?:cmd|bat)$/i.test(item));
  if (scriptMatch) return scriptMatch;
  throw new Error(`这台 Windows 没有找到"${command}"。请先安装对应工具，或填写其完整路径。`);
}

function launchSpec(command, args) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    throw new Error("本机模式需要 claude.exe，不能使用旧式 claude.cmd/claude.bat。请填写 claude.exe 完整路径或重新安装最新版 Claude Code。");
  }
  return { file: command, args };
}

function safeSessionId(value) {
  const sessionId = String(value || "");
  if (sessionId && !/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) throw new Error("本机会话编号无效，请新建会话后重试。");
  return sessionId;
}

function validatedWorkingDirectory(value) {
  const directory = String(value || "").trim();
  if (!directory) return undefined;
  let stat;
  try { stat = fs.statSync(directory); } catch { throw new Error(describeMissingWorkingDirectory(directory, { local: true })); }
  if (!stat.isDirectory()) throw new Error("本机工作目录不是文件夹。");
  return directory;
}

async function writeLocalAttachments(root, attachments, conversationId, onProgress) {
  if (!attachments.length) return [];
  const safeFolder = String(conversationId || "default").replace(/[^a-zA-Z0-9-]/g, "");
  const directory = path.join(root, safeFolder);
  fs.mkdirSync(directory, { recursive: true });
  const uploaded = [];
  for (const [index, file] of attachments.entries()) {
    const name = safeFileName(file.name || `attachment-${index + 1}`);
    const localPath = path.join(directory, `${Date.now()}-${index + 1}-${name}`);
    const data = Buffer.from(file.data);
    fs.writeFileSync(localPath, data, { mode: 0o600 });
    onProgress?.({ index, name: file.name, sent: data.length, total: data.length, overall: (index + 1) / attachments.length });
    uploaded.push({ path: localPath, name: file.name, mimeType: file.mimeType || mimeFromPath(file.name) });
  }
  return uploaded;
}

function buildLocalAttachmentNote(files) {
  if (!files.length) return "";
  const lines = files.map((file) => `- ${file.path}`);
  return "\n\n用户附加了以下保存在本机的文件，请按需读取：\n" + lines.join("\n");
}

function inspectLocalFiles(candidates, uploadedPaths) {
  const files = [];
  const normalizedUploads = new Set([...uploadedPaths].map(normalizePath));
  for (const candidate of [...new Set(candidates)].slice(0, 20)) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || normalizedUploads.has(normalizePath(candidate))) continue;
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      const mimeType = mimeFromPath(candidate);
      files.push({ localPath: candidate, name: path.basename(candidate) || "文件", size: stat.size, mimeType, isImage: mimeType.startsWith("image/") && mimeType !== "image/svg+xml" });
    } catch { /* Claude may have removed a temporary file. */ }
  }
  return files;
}

function readLocalFile(localPath, maximumBytes) {
  if (!path.isAbsolute(String(localPath || ""))) throw new Error("本机文件路径无效。");
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) throw new Error("本机路径不是文件。");
  if (stat.size > maximumBytes) throw new Error(`文件超过 ${Math.round(maximumBytes / 1024 / 1024)} MB，无法直接预览。`);
  return fs.readFileSync(localPath);
}

function copyLocalFile(source, destination) {
  if (!path.isAbsolute(String(source || ""))) throw new Error("本机文件路径无效。");
  fs.copyFileSync(source, destination);
  return destination;
}

function runProcess(command, args, stdin, workingDirectory) {
  const launch = launchSpec(command, args);
  return new Promise((resolve, reject) => {
    const childProcess = spawn(launch.file, launch.args, { cwd: validatedWorkingDirectory(workingDirectory), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    childProcess.stdout.on("data", (data) => { stdout += data.toString("utf8"); });
    childProcess.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
    childProcess.once("error", (error) => reject(localLaunchError(error, command)));
    childProcess.once("close", (code) => resolve({ code, stdout, stderr }));
    childProcess.stdin.end(stdin);
  });
}

function localLaunchError(error, command) {
  return error?.code === "ENOENT"
    ? new Error(`找不到本机 Claude 命令"${command}"。请先安装 Claude Code或填写完整路径。`)
    : new Error("启动本机 Claude 失败：" + error.message);
}

function safeFileName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 100) || "attachment";
}

function normalizePath(value) {
  return process.platform === "win32" ? String(value).toLocaleLowerCase() : String(value);
}

function cleanError(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

module.exports = { buildLocalAttachmentNote, copyLocalFile, getLocalClaudeModelStatus, inspectLocalFiles, launchSpec, readLocalFile, resolveLocalCommand, runLocalClaude, safeSessionId, updateLocalAutoCompactWindow, updateLocalClaudeModel, updateLocalClaudeModelEntry, validatedWorkingDirectory, verifyLocalConnection, writeLocalAttachments };