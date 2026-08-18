"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { JsonLineParser, buildClaudeArgs, sessionFromEvent, textFromEvent } = require("./protocol.cjs");
const { handleToolPayload, mimeFromPath } = require("./ssh.cjs");

async function verifyLocalConnection(config, onLog) {
  const command = await resolveLocalCommand(config.wakeName);
  const result = await runProcess(command, ["--version"], "", config.workingDirectory);
  onLog?.("local_claude_version_result", { exitCode: result.code, version: result.stdout.trim(), stderr: cleanError(result.stderr) });
  if (result.code !== 0) throw new Error(cleanError(result.stderr) || "无法运行本机 Claude 命令。");
  return result.stdout.trim() || "本机 Claude 已就绪";
}

function runLocalClaude(config, message, sessionId, attachments = [], callbacks = {}) {
  let child;
  let cancelled = false;
  const operation = (async () => {
    callbacks.onStatus?.("local-starting");
    const command = await resolveLocalCommand(config.wakeName);
    const uploaded = await writeLocalAttachments(config.localUploadDirectory, attachments, callbacks.conversationId, callbacks.onUploadProgress);
    const prompt = message + buildLocalAttachmentNote(uploaded);
    const args = buildClaudeArgs(config, prompt, safeSessionId(sessionId), false);
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
    const tools = new Map();
    const outputPaths = new Set();

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
          if (text) { responseText += text; callbacks.onDelta?.(text); }
          const foundSession = sessionFromEvent(item.value);
          if (foundSession) nextSessionId = foundSession;
          handleToolPayload(item.value, tools, outputPaths, callbacks.onToolEvent);
          if (item.value.type === "result" && !responseText && item.value.result) {
            responseText = item.value.result;
            callbacks.onDelta?.(responseText);
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
        if (cancelled) {
          const error = new Error("已停止生成。");
          error.cancelled = true;
          return reject(error);
        }
        if (code !== 0) return reject(new Error(cleanError(stderr) || `本机 Claude 已退出（代码 ${code}）。`));
        resolve();
      });
      child.stdin.end(prompt);
    });

    const files = inspectLocalFiles([...outputPaths], new Set(uploaded.map((file) => normalizePath(file.path))));
    return { sessionId: nextSessionId || sessionId, text: responseText, files, tools: [...tools.values()] };
  })();

  return {
    promise: operation,
    cancel() {
      cancelled = true;
      child?.kill();
    }
  };
}

async function resolveLocalCommand(value) {
  const command = String(value || "").trim();
  if (!command) throw new Error("请填写本机 Claude 唤醒命令。");
  if (/[\0\r\n]/.test(command)) throw new Error("本机 Claude 唤醒命令无效。");
  if (path.isAbsolute(command) || /[\\/]/.test(command)) {
    if (!fs.existsSync(command)) throw new Error(`找不到本机 Claude 命令：${command}`);
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
  throw new Error(`这台 Windows 没有找到“${command}”。请先安装 Claude Code，或填写 claude.exe/claude.cmd 的完整路径。`);
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
  try { stat = fs.statSync(directory); } catch { throw new Error(`本机工作目录不存在：${directory}`); }
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
    const child = spawn(launch.file, launch.args, { cwd: validatedWorkingDirectory(workingDirectory), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString("utf8"); });
    child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
    child.once("error", (error) => reject(localLaunchError(error, command)));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function localLaunchError(error, command) {
  return error?.code === "ENOENT"
    ? new Error(`找不到本机 Claude 命令“${command}”。请先安装 Claude Code或填写完整路径。`)
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

module.exports = { buildLocalAttachmentNote, copyLocalFile, inspectLocalFiles, launchSpec, readLocalFile, resolveLocalCommand, runLocalClaude, safeSessionId, verifyLocalConnection };
