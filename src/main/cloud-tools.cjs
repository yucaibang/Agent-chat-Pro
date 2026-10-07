"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { shellQuote } = require("./protocol.cjs");
const { validatedWorkingDirectory } = require("./local.cjs");

/**
 * 云端模式工具集 — cloud 模式 function calling 的执行器
 * - v3.14.0 云办公一期：本机执行（文件工具 workdir 越界防护 + run_command 独立开关）
 * - v3.22.0 云办公二期：NAS Docker 沙箱执行形态（main.cjs 注入 sandboxExecutor 后启用）
 *
 * 安全模型：
 *  - 文件/目录工具一律限制在工作目录内（resolveInsideWorkdir / resolveInsideWorkdirPosix 拦截路径逃逸）
 *  - run_command 独立开关（settings.cloudRunCommandEnabled，默认关），超时 + 输出截断
 *  - web_fetch 仅 http/https，跟随重定向 ≤3，大小/超时上限，HTML 转纯文本
 *  - 工具输出回填 API 前统一截断（MAX_OUTPUT_CHARS），防止上下文爆炸
 *  - 二期沙箱形态：文件/命令执行全部落在 NAS Docker 容器（compose：internal 隔离网络默认断网、
 *    工作卷挂载 /workspace）；容器名固定 sandbox；沙箱开启时主进程本机不再碰这些工具的执行面
 */

const MAX_TOOL_ROUNDS = 25;
const MAX_OUTPUT_CHARS = 8000;
const MAX_FILE_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 120 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;

// ── v3.22.0 沙箱常量（容器名固定，工作目录为容器内路径视角）──
const SANDBOX_CONTAINER = "sandbox";
const SANDBOX_WORKDIR = "/workspace";

// ────────────────────────────────────────────
//  工具定义（OpenAI tools 格式；Anthropic 由 cloud-chat.cjs 转换）
// ────────────────────────────────────────────

const FILE_PATH_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "工作目录内的相对路径（也接受工作目录内的绝对路径）" }
  },
  required: ["path"]
};

/** 返回 OpenAI tools 格式定义；allowCommand=false 时不注册 run_command */
function toolDefinitions(allowCommand) {
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取工作目录内文本文件的内容（最大 512KB，超出截断）。",
        parameters: FILE_PATH_SCHEMA
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "在工作目录内创建或覆盖写入文本文件（自动创建父目录）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "工作目录内的相对路径" },
            content: { type: "string", description: "要写入的完整文本内容" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_directory",
        description: "列出工作目录内某文件夹的内容（默认列出工作目录根）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "工作目录内的相对文件夹路径，缺省为工作目录根" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "抓取网页并转为纯文本（http/https，跟随重定向，最大 2MB）。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "完整的 http/https URL" }
          },
          required: ["url"]
        }
      }
    }
  ];
  if (allowCommand) {
    tools.push({
      type: "function",
      function: {
        name: "run_command",
        description: "在工作目录内执行一条命令并返回输出（默认 2 分钟超时）。仅限用户明确开启。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要执行的命令行" }
          },
          required: ["command"]
        }
      }
    });
  }
  return tools;
}

/** OpenAI tools 定义 → Anthropic tools 格式 */
function toAnthropicTools(openAiTools) {
  return openAiTools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }));
}

// ────────────────────────────────────────────
//  路径安全
// ────────────────────────────────────────────

/** 把工具传入的路径解析到工作目录内；逃逸即抛错 */
function resolveInsideWorkdir(workdir, relativePath) {
  const base = path.resolve(workdir);
  const raw = String(relativePath || "").trim() || ".";
  const target = path.resolve(base, raw);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径超出工作目录范围：${raw}（工作目录 ${base}）`);
  }
  return target;
}

function truncateOutput(value) {
  const text = String(value ?? "");
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[输出已截断，共 ${text.length} 字符]` : text;
}

// ────────────────────────────────────────────
//  文件 / 目录工具
// ────────────────────────────────────────────

function toolReadFile(args, workdir) {
  const target = resolveInsideWorkdir(workdir, args.path);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) throw new Error(`"${args.path}" 是文件夹，请用 list_directory 列出内容。`);
  let content = fs.readFileSync(target, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    content = Buffer.from(content, "utf8").subarray(0, MAX_FILE_BYTES).toString("utf8") + "\n[文件过大，已截断到 512KB]";
  }
  return content || "（空文件）";
}

function toolWriteFile(args, workdir) {
  if (typeof args.content !== "string") throw new Error("write_file 缺少 content 参数。");
  const target = resolveInsideWorkdir(workdir, args.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, args.content, "utf8");
  return `已写入 ${target}（${Buffer.byteLength(args.content, "utf8")} 字节）。`;
}

function toolListDirectory(args, workdir) {
  const target = resolveInsideWorkdir(workdir, args?.path || ".");
  const entries = fs.readdirSync(target, { withFileTypes: true });
  if (!entries.length) return "（空文件夹）";
  return entries
    .slice(0, 500)
    .map((entry) => `${entry.isDirectory() ? "[目录]" : "[文件]"} ${entry.name}`)
    .join("\n") + (entries.length > 500 ? `\n[仅显示前 500 项，共 ${entries.length} 项]` : "");
}

// ────────────────────────────────────────────
//  命令执行（独立开关）
// ────────────────────────────────────────────

function toolRunCommand(args, workdir) {
  const command = String(args.command || "").trim();
  if (!command) throw new Error("run_command 缺少 command 参数。");
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];
    const child = spawn(shell, shellArgs, { cwd: workdir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 进程已退出 */ }
      reject(new Error(`命令执行超时（${Math.round(COMMAND_TIMEOUT_MS / 1000)} 秒），已终止。`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (data) => { output += data.toString("utf8"); });
    child.stderr.on("data", (data) => { output += data.toString("utf8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`命令启动失败：${error.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = cleanAnsi(output).trim();
      resolve(`退出码 ${code}${text ? `\n${truncateOutput(text)}` : "\n（无输出）"}`);
    });
  });
}

// ────────────────────────────────────────────
//  v3.22.0 云办公二期：NAS Docker 沙箱执行形态
//  执行通道 = main.cjs 注入的 sandboxExecutor.run({command, timeoutMs, stdin})：经 SSH 发 NAS `docker exec`
//  容器内路径视角（/workspace），与命令工具同一目录世界——Agent 对路径的认知在两个工具间保持一致
// ────────────────────────────────────────────

/** POSIX 路径越界护栏（容器内 /workspace 视角；path.posix 在 Windows 主进程同样按 POSIX 语义计算） */
function resolveInsideWorkdirPosix(workdir, relativePath) {
  const base = path.posix.resolve(workdir);
  const raw = String(relativePath || "").trim() || ".";
  if (raw.includes("\u0000")) throw new Error(`路径包含非法字符：${JSON.stringify(raw.slice(0, 80))}`);
  const target = path.posix.resolve(base, raw);
  const rel = path.posix.relative(base, target);
  if (rel.startsWith("..") || path.posix.isAbsolute(rel)) {
    throw new Error(`路径超出工作目录范围：${raw}（沙箱工作目录 ${base}）`);
  }
  return target;
}

async function sandboxReadFile(executor, args) {
  const target = resolveInsideWorkdirPosix(SANDBOX_WORKDIR, args.path);
  let result;
  try {
    result = await executor.run({
      command: `docker exec ${SANDBOX_CONTAINER} cat -- ${shellQuote(target)}`,
      timeoutMs: COMMAND_TIMEOUT_MS
    });
  } catch (error) {
    throw new Error(`沙箱读取失败：${error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`读取失败（沙箱内 ${target}）：${firstLine(result.stderr) || "文件不存在或不可读"}`);
  }
  let content = result.stdout;
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    content = Buffer.from(content, "utf8").subarray(0, MAX_FILE_BYTES).toString("utf8") + "\n[文件过大，已截断到 512KB]";
  }
  return content || "（空文件）";
}

async function sandboxWriteFile(executor, args) {
  if (typeof args.content !== "string") throw new Error("write_file 缺少 content 参数。");
  const target = resolveInsideWorkdirPosix(SANDBOX_WORKDIR, args.path);
  // 内容经 stdin 流入容器内 cat 重定向——不占命令行长度，shell 不解析内容，无注入面
  const script = `cat -- > ${shellQuote(target)}`;
  let result;
  try {
    result = await executor.run({
      command: `docker exec -i ${SANDBOX_CONTAINER} sh -c ${shellQuote(script)}`,
      stdin: args.content,
      timeoutMs: COMMAND_TIMEOUT_MS
    });
  } catch (error) {
    throw new Error(`沙箱写入失败：${error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`写入失败（沙箱内 ${target}）：${firstLine(result.stderr) || "目录不可写"}`);
  }
  const bytes = Buffer.byteLength(args.content, "utf8");
  return `已写入 ${target}（${bytes} 字节）。`;
}

async function sandboxListDirectory(executor, args) {
  const target = resolveInsideWorkdirPosix(SANDBOX_WORKDIR, args?.path || ".");
  // find 不套容器 shell，参数固定无注入面；printf 的 \t/\n 由 find 转义（单引号内 shell 不展开）
  let result;
  try {
    result = await executor.run({
      command: `docker exec ${SANDBOX_CONTAINER} find ${shellQuote(target)} -maxdepth 1 -mindepth 1 -printf '%y\\t%f\\n'`,
      timeoutMs: COMMAND_TIMEOUT_MS
    });
  } catch (error) {
    throw new Error(`沙箱目录列举失败：${error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`目录列举失败（沙箱内 ${target}）：${firstLine(result.stderr) || "目录不存在"}`);
  }
  const entries = result.stdout.split("\n").map((line) => {
    const cut = line.indexOf("\t");
    return cut > 0 ? { type: line.slice(0, cut), name: line.slice(cut + 1) } : null;
  }).filter(Boolean).filter((entry) => entry.name);
  if (!entries.length) return "（空文件夹）";
  return entries
    .slice(0, 500)
    .map((entry) => `${entry.type === "d" ? "[目录]" : "[文件]"} ${entry.name}`)
    .join("\n") + (entries.length > 500 ? `\n[仅显示前 500 项，共 ${entries.length} 项]` : "");
}

async function sandboxRunCommand(executor, args) {
  const commandText = String(args.command || "").trim();
  if (!commandText) throw new Error("run_command 缺少 command 参数。");
  let result;
  try {
    result = await executor.run({
      command: `docker exec -w ${shellQuote(SANDBOX_WORKDIR)} ${SANDBOX_CONTAINER} /bin/sh -c ${shellQuote(commandText)}`,
      timeoutMs: COMMAND_TIMEOUT_MS
    });
  } catch (error) {
    throw new Error(`沙箱命令执行失败：${error.message}`);
  }
  const text = cleanAnsi(`${result.stdout}${result.stderr}`).trim();
  return `退出码 ${result.code}${text ? `\n${truncateOutput(text)}` : "\n（无输出）"}`;
}

function firstLine(value) {
  const text = String(value || "").trim();
  return text.split("\n")[0] || "";
}

function cleanAnsi(value) {
  return String(value || "")
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

// ────────────────────────────────────────────
//  网页抓取
// ────────────────────────────────────────────

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function fetchUrlOnce(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const requester = url.startsWith("https:") ? https : http;
    const request = requester.get(url, { headers: { "User-Agent": "AgentChatPro/3.14.0 (+web_fetch)" }, timeout: FETCH_TIMEOUT_MS }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if (redirectCount >= 3) return reject(new Error("重定向次数过多（>3）。"));
        const next = new URL(response.headers.location, url).toString();
        return resolve(fetchUrlOnce(next, redirectCount + 1));
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_FETCH_BYTES) {
          request.destroy();
          return reject(new Error(`响应超过 ${Math.round(MAX_FETCH_BYTES / 1024 / 1024)}MB 上限。`));
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ body: Buffer.concat(chunks), contentType: String(response.headers["content-type"] || "") }));
      response.on("error", reject);
    });
    request.on("timeout", () => {
      request.destroy();
      reject(new Error(`请求超时（${Math.round(FETCH_TIMEOUT_MS / 1000)} 秒）。`));
    });
    request.on("error", reject);
  });
}

async function toolWebFetch(args) {
  const url = String(args.url || "").trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`无效 URL：${url}`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("仅支持 http/https 协议。");
  const { body, contentType } = await fetchUrlOnce(url);
  const text = contentType.includes("html") || contentType.includes("text/") || contentType.includes("json")
    ? htmlToText(body.toString("utf8"))
    : `[非文本内容：${contentType || "未知类型"}，${body.length} 字节]`;
  if (!text) return "（页面无文本内容）";
  return truncateOutput(text);
}

// ────────────────────────────────────────────
//  统一执行入口
// ────────────────────────────────────────────

/**
 * 执行一次工具调用。
 * @param {{id?:string, name:string, arguments:string|object}} call
 * @param {{workdir?:string, allowCommand:boolean, onLog?:Function, sandboxExecutor?:{enabled:boolean, run:Function}}} context
 *   - v3.22.0：context.sandboxExecutor 存在且 enabled 时，文件/命令工具走 NAS Docker 沙箱执行；
 *     workdir 校验跳过（工作目录固定为容器内 /workspace，由沙箱工作卷挂载）。
 * @returns {Promise<string>} 回填给 API 的工具结果文本
 */
async function executeToolCall(call, context) {
  let args = call.arguments;
  if (typeof args === "string") {
    const raw = args.trim();
    try { args = raw ? JSON.parse(raw) : {}; } catch {
      throw new Error(`工具参数不是合法 JSON：${raw.slice(0, 120)}`);
    }
  }
  args = args || {};
  const name = String(call.name || "");
  context?.onLog?.("cloud_tool_call", { name, arguments: JSON.stringify(args).slice(0, 300) });

  // ── v3.22.0 沙箱分支：NAS Docker exec 通道（main.cjs 注入 sandboxExecutor） ──
  if (context?.sandboxExecutor?.enabled) {
    const executor = { run: context.sandboxExecutor.run };
    switch (name) {
      case "read_file": return sandboxReadFile(executor, args);
      case "write_file": return sandboxWriteFile(executor, args);
      case "list_directory": return sandboxListDirectory(executor, args);
      case "web_fetch": return toolWebFetch(args); // 容器默认断网，抓网仍由 ACP 本机承担
      case "run_command":
        if (!context?.allowCommand) throw new Error("命令执行未开启。请在设置中开启「允许执行命令」（有安全风险）。");
        return sandboxRunCommand(executor, args);
      default:
        throw new Error(`未知工具：${name}`);
    }
  }

  // ── 一期本机分支（兼容回退：未启用沙箱时行为不变） ──
  const workdir = validatedWorkingDirectory(context?.workdir);
  if (!workdir) throw new Error("未配置云端模式工作目录，请先在设置中填写。");
  switch (name) {
    case "read_file": return toolReadFile(args, workdir);
    case "write_file": return toolWriteFile(args, workdir);
    case "list_directory": return toolListDirectory(args, workdir);
    case "web_fetch": return toolWebFetch(args);
    case "run_command":
      if (!context?.allowCommand) throw new Error("命令执行未开启。请在设置中开启「允许执行命令」（有安全风险）。");
      return toolRunCommand(args, workdir);
    default:
      throw new Error(`未知工具：${name}`);
  }
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_TOOL_ROUNDS,
  SANDBOX_CONTAINER,
  SANDBOX_WORKDIR,
  executeToolCall,
  resolveInsideWorkdir,
  resolveInsideWorkdirPosix,
  toAnthropicTools,
  toolDefinitions
};