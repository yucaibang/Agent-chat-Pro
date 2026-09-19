"use strict";

const { isTerminalLifecycle } = require("./modules/status/status-lifecycle.cjs");

const COMMANDS = new Set(["ssh", "sftp", "scp", "rsync"]);
const OPTIONS_WITH_VALUE = new Set(["-b", "-c", "-d", "-e", "-f", "-i", "-j", "-l", "-m", "-o", "-p", "-r", "-s", "-w"]);
const AUDIT_FILE_FORMATS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "avif", "heic",
  "txt", "md", "json", "yaml", "yml", "xml", "csv", "tsv", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "js", "cjs", "mjs", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "cs", "go", "rs", "sh", "ps1", "html", "css", "scss", "sql"
]);
const AUDIT_TOOL_ACTIONS = new Set(["view-image", "read-file", "create-file", "modify-file", "delete-file", "uninstall", "run-command", "other"]);
const SUPPORTED_EVENT_TYPES = new Set(["connection", "upload", "tool", "permission", "usage", "delta", "lifecycle", "transport"]);
// Once a request starts using a proxy, that routing context remains material
// to the user until the agent explicitly disables it or the request ends. A
// completed individual tool only means that one action returned; it does not
// prove that the agent has stopped using the proxy for the rest of the turn.
// This state stays in the module so it is the sole owner of the lifecycle.
const proxySessions = new Map();
const toolSemantics = new Map();

function normalizeAuditTarget(value) {
  const target = String(value || "").trim().toLocaleLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^.*@/, "")
    .replace(/^\[/, "").replace(/\].*$/, "")
    .replace(/[:/].*$/, "");
  if (!target || target.length > 80 || !/^[a-z0-9.-]+$/.test(target)) return "";
  return target.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function shellTokens(value) {
  return String(value || "").match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) || [];
}

function addCommandTargets(source, targets) {
  const tokens = shellTokens(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const command = tokens[index].toLocaleLowerCase();
    if (!COMMANDS.has(command)) continue;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      const option = token.toLocaleLowerCase();
      if (option === "--") continue;
      if (option.startsWith("-")) {
        if (OPTIONS_WITH_VALUE.has(option)) cursor += 1;
        continue;
      }
      const target = normalizeAuditTarget(token);
      if (["ssh", "sftp"].includes(command)) {
        if (target) targets.add(target);
        break;
      }
      if (/@|:/.test(token) && target) targets.add(target);
    }
  }
}

function auditToolTargets(tool) {
  const targets = new Set();
  const visit = (value, key = "") => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
    if (value && typeof value === "object") return Object.entries(value).forEach(([nextKey, nextValue]) => visit(nextValue, nextKey));
    if (/(host|hostname|nas|server|remote)/i.test(key)) {
      const target = normalizeAuditTarget(value);
      if (target) targets.add(target);
    }
    if (typeof value === "string") addCommandTargets(value, targets);
  };
  visit(tool?.input || {});
  return [...targets].slice(0, 8);
}

function auditFileFormats(tool) {
  let source = "";
  try { source = JSON.stringify(tool?.input || {}); } catch { source = ""; }
  const formats = new Set();
  for (const match of source.toLocaleLowerCase().matchAll(/\.([a-z0-9]{1,10})(?=[^a-z0-9]|$)/g)) {
    if (AUDIT_FILE_FORMATS.has(match[1])) formats.add(match[1]);
  }
  return [...formats].slice(0, 16);
}

function auditToolAction(tool, fileFormats) {
  const name = String(tool?.name || "").toLocaleLowerCase();
  const input = tool?.input || {};
  if (["write", "create"].includes(name)) return "create-file";
  if (["edit", "patch", "notebookedit"].includes(name)) return "modify-file";
  if (name === "read") return fileFormats.some((format) => ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "avif", "heic"].includes(format)) ? "view-image" : "read-file";
  const source = [name, input.command, input.action, input.operation, input.mode, input.verb]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
  if (/uninstall|卸载/.test(source)) return "uninstall";
  if (/delete|remove|rm\s|unlink|删除|移除/.test(source)) return "delete-file";
  if (/\b(write|create)\b|创建/.test(source)) return "create-file";
  if (/\b(edit|patch)\b|修改|编辑/.test(source)) return "modify-file";
  if (/\b(read|open|view)\b|读取|查看/.test(source)) return fileFormats.some((format) => ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "avif", "heic"].includes(format)) ? "view-image" : "read-file";
  if (name === "bash") return "run-command";
  return "other";
}

function toolSemanticKey(requestId, tool) {
  const request = String(requestId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
  const toolId = String(tool?.id || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
  return request && toolId ? `${request}:${toolId}` : "";
}

function reconcileToolAction(requestId, tool, fileFormats) {
  const observedAction = auditToolAction(tool, fileFormats);
  const key = toolSemanticKey(requestId, tool);
  if (!key || observedAction === "other") return { action: observedAction, observedAction, conflict: false };
  const previous = toolSemantics.get(key);
  if (!previous) {
    toolSemantics.set(key, { action: observedAction });
    return { action: observedAction, observedAction, conflict: false };
  }
  if (previous.action === observedAction) return { action: previous.action, observedAction, conflict: false };
  return { action: previous.action, observedAction, conflict: true };
}

function clearToolSemantics(requestId) {
  const request = String(requestId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
  if (!request) return;
  for (const key of toolSemantics.keys()) {
    if (key.startsWith(`${request}:`)) toolSemantics.delete(key);
  }
}

function toolStatus(tool) {
  if (tool?.status !== "denied") return tool?.status || "running";
  return tool.result === "未获得执行权限" ? "denied" : "failed";
}

function hasNasEvidence(tool, context, target) {
  if (normalizeAuditTarget(context?.connection?.host) === target && context?.connection?.connectionMode === "ssh") return true;
  let source = "";
  try { source = `${JSON.stringify(tool?.input || {})} ${tool?.name || ""}`; } catch { source = String(tool?.name || ""); }
  return /(?:\bnas\b|飞牛|fnos)/i.test(source);
}

function isCoreFileChange(tool) {
  const name = String(tool?.name || "");
  if (!/^(Write|Edit|NotebookEdit|Bash)$/i.test(name)) return false;
  const input = tool?.input || {};
  const signal = `${input.file_path || ""} ${input.path || ""} ${input.notebook_path || ""} ${input.command || ""}`;
  return /(?:^|[\\/\s"'`])(?:src[\\/](?:main|renderer)[\\/]|(?:package(?:-lock)?\.json|main\.cjs|preload\.cjs|renderer\.js|styles\.css|index\.html|electron-builder[^\\/\s"'`]*\.json))(?:$|[\\/\s"'`])/i.test(signal);
}

function toolTone(tool, action = "", actionConflict = false) {
  const input = tool?.input || {};
  let source = "";
  try { source = `${tool?.name || ""} ${JSON.stringify(input)}`; } catch { source = String(tool?.name || ""); }
  if (isCoreFileChange(tool)) return "danger";
  if (actionConflict) return "working";
  if (["delete-file", "uninstall"].includes(action)) return "danger";
  if (action === "run-command" && /(删除|移除|清理|卸载|delete|uninstall|remove-item|\brm\b|\brmdir\b|\bdel\b|\berase\b|\bunlink\b|\bshred\b|git\s+clean|git\s+reset\s+--hard)/i.test(source)) return "danger";
  if (/(http_proxy|https_proxy|all_proxy|no_proxy|npm\s+config\s+get\s+proxy|git\s+config\s+.*proxy|curl\s+.*(?:-x|--proxy)|proxychains|tinyproxy|socat\s+.*proxy|ssh\s+.*-d\s|ssh\s+.*-w\s|代理)/i.test(source)) return "proxy";
  return "working";
}

function toolSource(tool) {
  try { return `${tool?.name || ""} ${JSON.stringify(tool?.input || {})}`; }
  catch { return String(tool?.name || ""); }
}

function proxyDirective(tool) {
  const source = toolSource(tool).toLocaleLowerCase();
  if (!/(?:http_proxy|https_proxy|all_proxy|no_proxy|proxychains|tinyproxy|socat|\bproxy\b|代理)/i.test(source)) return "";
  if (/(?:unset\s+(?:http_proxy|https_proxy|all_proxy|no_proxy)|(?:http_proxy|https_proxy|all_proxy|no_proxy)\s*=\s*(?:\"\"|''|null)|npm\s+config\s+(?:delete|rm)\s+proxy|git\s+config\s+--unset(?:-all)?\s+.*proxy|(?:关闭|停用|停止).{0,12}代理|(?:disable|stop)\s+(?:the\s+)?proxy)/i.test(source)) return "stop";
  if (/(?:export|setx?|set-item|npm\s+config\s+set|git\s+config).{0,80}(?:http_proxy|https_proxy|all_proxy|no_proxy|\bproxy\b)|(?:开启|启用|启动|配置).{0,12}代理|(?:enable|start|configure)\s+(?:the\s+)?proxy/i.test(source)) return "start";
  return toolTone(tool) === "proxy" ? "transient" : "";
}

function proxySessionKey(requestId) {
  return String(requestId || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
}

function updateProxySession(requestId, tool) {
  const key = proxySessionKey(requestId);
  if (!key) return { active: false, stopping: false };
  const session = proxySessions.get(key) || { configured: false };
  const status = toolStatus(tool);
  const directive = proxyDirective(tool);

  if (directive === "start") {
    if (status === "failed" || status === "denied") session.configured = false;
    else session.configured = true;
  } else if (directive === "stop") {
    if (status === "completed") session.configured = false;
  } else if (directive === "transient") {
    // `curl -x`, `--proxy`, and similar commands are individual uses of an
    // already available proxy. Their completed frame closes that one command,
    // not the proxy context. Keep the request purple until a real stop signal
    // or lifecycle terminal arrives.
    session.configured = true;
  }

  const active = session.configured;
  if (active) proxySessions.set(key, session);
  else proxySessions.delete(key);
  return {
    active,
    stopping: directive === "stop" && status !== "completed",
    stopped: directive === "stop" && status === "completed"
  };
}

function clearProxySession(requestId) {
  const key = proxySessionKey(requestId);
  if (key) proxySessions.delete(key);
}

function proxyDisplay(display, state) {
  // Red is the one status that outranks purple. A failed operation remains
  // visible as a failure even when the request is still routed via proxy.
  if (["error", "danger"].includes(display.tone)) return display;
  if (state.stopped) return { ...display, tone: "working" };
  if (!state.active) return display;
  const label = state.stopping ? "正在停止使用代理" : display.label;
  return { ...display, label, tone: "proxy", proxyActive: true };
}

function proxyTone(presentation, requestId) {
  const key = proxySessionKey(requestId);
  const session = key ? proxySessions.get(key) : null;
  if (presentation?.tone !== "working" || !session?.configured) return presentation;
  return { ...presentation, tone: "proxy", proxyActive: true };
}

function proxyTestTargets(tool) {
  const source = toolSource(tool)
    // Commands arrive JSON-serialized, so normalise escaped shell quotes
    // before removing proxy endpoint assignments.
    .replace(/\\(["'])/g, "$1")
    .replace(/(?:^|\s)(?:-x|--proxy)(?:\s+|=)["']?https?:\/\/[^\s"'\\]+/gi, " ")
    .replace(/\b(?:https?_proxy|all_proxy|proxy)\s*=\s*["']?https?:\/\/[^\s"'\\]+/gi, " ");
  const urls = source.match(/https?:\/\/[^\s"'\\]+/gi) || [];
  return [...new Set(urls)];
}

function proxyTestTarget(tool) {
  return proxyTestTargets(tool)[0] || "";
}

function inputDisplayValue(value) {
  if (Array.isArray(value)) return value.map(inputDisplayValue).filter(Boolean).join(" · ");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  try {
    const serialized = value && typeof value === "object" ? JSON.stringify(value) : "";
    return serialized === "{}" || serialized === "[]" ? "" : serialized;
  }
  catch { return ""; }
}

function toolInputDetail(tool, preferredKeys = []) {
  const input = tool?.input || {};
  const keys = [...new Set([
    ...preferredKeys,
    "query", "search_query", "q", "url", "urls", "uri", "endpoint",
    "file_path", "path", "command", "pattern", "glob", "prompt", "task", "description", "args", "arguments", "skill", "skillName", "skill_name"
  ])];
  for (const key of keys) {
    const value = inputDisplayValue(input[key]);
    if (value) return value;
  }
  return inputDisplayValue(input);
}

function readableToolToken(value) {
  const text = String(value || "").replace(/^mcp__/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase()) : "";
}

function mcpDisplayLabel(name) {
  const parts = String(name || "").split("__").filter(Boolean);
  if (parts[0]?.toLocaleLowerCase() !== "mcp") return "";
  const service = readableToolToken(parts[1]);
  const action = readableToolToken(parts.slice(2).join(" ").replace(new RegExp(`^${parts[1]}[_-]?`, "i"), ""));
  return [service, action].filter(Boolean).join(" · ");
}

function tavilyDisplayLabel(tool) {
  const name = String(tool?.name || "").toLocaleLowerCase();
  const detail = toolInputDetail(tool, ["query", "search_query", "q", "url", "urls", "uri", "endpoint"]);
  const action = name.includes("research") ? "调研"
    : name.includes("extract") ? "提取"
      : name.includes("crawl") ? "抓取"
        : name.includes("map") ? "检索"
          : "搜索";
  return detail ? `Tavily · ${action} ${detail}` : "Tavily";
}

function withToolDetail(label, detail) {
  return detail && !String(label).includes(detail) ? `${label} · ${detail}` : label;
}

function splitSceneAndDetail(label, toolName = "") {
  const text = String(label || "").trim();
  if (!text) return { scene: "正在执行工具", detail: "" };
  const tavily = text.match(/^(Tavily · (?:搜索|调研|提取|抓取|检索))\s+(.+)$/);
  if (tavily) return { scene: tavily[1], detail: tavily[2] };
  const skill = text.match(/^(使用技能)\s+(.+)$/);
  if (skill) return { scene: skill[1], detail: skill[2] };
  const proxyTest = text.match(/^(通过代理测试)\s+(.+)$/);
  if (proxyTest) return { scene: proxyTest[1], detail: proxyTest[2] };
  const parts = text.split(" · ").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3 && /^mcp__/i.test(String(toolName))) return { scene: parts.slice(0, 2).join(" · "), detail: parts.slice(2).join(" · ") };
  if (parts.length >= 2) return { scene: parts[0], detail: parts.slice(1).join(" · ") };
  return { scene: text, detail: "" };
}

function scenePresentation(kind, scene, detail, extra = {}) {
  return { kind, workLabel: scene, workDetail: detail, ...extra };
}

function skillDisplayLabel(tool) {
  const input = tool?.input || {};
  const raw = input.skill || input.skillName || input.skill_name || "";
  const skill = String(raw).trim().split(/[\\/]/).pop().replace(/\s+/g, " ").slice(0, 48);
  return skill ? `使用技能 ${skill}` : "使用技能";
}

function displayTarget(target) {
  const value = String(target || "");
  return /^\d{1,3}(?:-\d{1,3}){3}$/.test(value) ? value.replace(/-/g, ".") : value;
}

function containsAny(source, expressions) {
  return expressions.some((expression) => expression.test(source));
}

function toolSubject(name) {
  const source = String(name || "").toLocaleLowerCase();
  if (/(?:^|[_:-])nas(?:$|[_:-])|\b(?:fnos|飞牛)\b/i.test(source)) return "NAS";
  if (/filesystem|file[_:-]?(?:system|manager)?/.test(source)) return "文件";
  if (/github|gitlab|git[_:-]/.test(source)) return "代码仓库";
  if (/playwright|puppeteer|browser|web[_:-]/.test(source)) return "网页";
  if (/docker|container|kubernetes|k8s/.test(source)) return "容器";
  if (/database|postgres|mysql|sqlite|mongo|redis/.test(source)) return "数据库";
  if (/memory|knowledge/.test(source)) return "记忆";
  if (/calendar/.test(source)) return "日历";
  if (/mail|email/.test(source)) return "邮件";
  if (/slack|discord|teams/.test(source)) return "消息";
  return "";
}

function actionLabelFromSource(name, source, audit) {
  const lowerName = String(name || "").toLocaleLowerCase();
  const subject = toolSubject(name);
  const activity = (label) => subject ? `${label}${subject}` : label;
  const has = (expressions) => containsAny(`${lowerName} ${source}`.toLocaleLowerCase(), expressions);
  const direct = {
    Read: "读取文件", Write: "创建文件", Edit: "编辑文件", NotebookEdit: "编辑笔记本",
    Bash: "运行命令", WebFetch: "读取网页", WebSearch: "搜索网页", Glob: "查找文件", Grep: "搜索内容",
    Skill: "使用技能", Agent: "调用子 Agent", Task: "调用子 Agent"
  };
  if (direct[name]) return direct[name];
  if (has([/(?:^|[_:\-\s])(?:read|open|get|view|cat|head|tail)(?:$|[_:\-\s])/, /读取|查看|打开/])) return activity(audit.toolAction === "view-image" ? "查看图片" : "读取");
  if (has([/(?:^|[_:\-\s])(?:list|ls|dir|find|glob|tree)(?:$|[_:\-\s])/, /列出|列表|浏览/])) return subject === "NAS" && has([/task|任务/]) ? "查看 NAS 任务" : activity("查看");
  if (has([/(?:^|[_:\-\s])(?:search|grep|rg|query)(?:$|[_:\-\s])/, /搜索|查询/])) return activity(subject === "网页" ? "搜索" : "查询");
  if (has([/(?:^|[_:\-\s])(?:write|create|mkdir|touch|upload)(?:$|[_:\-\s])/, /创建|写入|上传/])) return activity("创建");
  if (has([/(?:^|[_:\-\s])(?:edit|patch|update|replace|apply)(?:$|[_:\-\s])/, /编辑|修改|更新/])) return activity("编辑");
  if (has([/(?:^|[_:\-\s])(?:delete|remove|unlink|rmdir)(?:$|[_:\-\s])/, /删除|移除/])) return activity("删除");
  if (has([/(?:^|[_:\-\s])(?:download|export)(?:$|[_:\-\s])/, /下载|导出/])) return activity("下载");
  if (has([/(?:^|[_:\-\s])(?:run|exec|execute|bash|shell|command)(?:$|[_:\-\s])/, /执行|运行/])) return subject ? `操作${subject}` : "运行命令";
  return "";
}

function toolDisplay(tool, audit, context) {
  const name = String(tool?.name || "");
  const lowerName = name.toLocaleLowerCase();
  let source = "";
  try { source = `${name} ${JSON.stringify(tool?.input || {})}`; } catch { source = name; }
  const target = audit.toolTargets[0] || "";
  const isNas = target && hasNasEvidence(tool, context, target);
  const targetName = target ? `${isNas ? "NAS" : "远程主机"} ${displayTarget(target)}` : "";
  const tone = toolTone(tool, audit.toolAction, audit.actionConflict);
  const detail = toolInputDetail(tool);
  if (audit.actionConflict) return { label: withToolDetail("文件操作待核对", detail), tone, covered: true };
  if (target && /\bssh\b/i.test(source)) return { label: withToolDetail(`正在连接 ${targetName}`, detail), tone, covered: true };
  if (target && /\b(sftp|scp|rsync)\b/i.test(source)) return { label: withToolDetail(`正在访问 ${targetName}`, detail), tone, covered: true };
  const byAction = {
    "view-image": "查看图片",
    "read-file": "读取文件",
    "create-file": "创建文件",
    "modify-file": "编辑文件",
    "delete-file": "删除文件",
    uninstall: "卸载工具",
    "run-command": "运行命令"
  };
  if (target) return { label: withToolDetail(`正在操作 ${targetName}`, detail), tone, covered: true };
  if (lowerName.includes("tavily")) return { label: tavilyDisplayLabel(tool), tone, covered: true };
  if (name === "WebSearch") return { label: withToolDetail("搜索网页", detail), tone, covered: true };
  if (lowerName.includes("skill")) return { label: withToolDetail(skillDisplayLabel(tool), toolInputDetail(tool, ["args", "arguments", "description"])), tone, covered: true };
  if (lowerName.includes("agent") || lowerName === "task") return { label: withToolDetail("调用子 Agent", detail), tone, covered: true };
  if (/(?:unset\s+(?:http_proxy|https_proxy|all_proxy|no_proxy)|npm\s+config\s+(?:delete|rm)\s+proxy|git\s+config\s+--unset|关闭.{0,12}代理|停用.{0,12}代理)/i.test(source)) return { label: "停止使用代理", tone, covered: true };
  if (/(?:curl|wget).*(?:-x|--proxy|proxy)/i.test(source)) {
    const targets = proxyTestTargets(tool);
    const targetDetail = targets.join(" · ");
    return { label: targetDetail ? `通过代理测试 ${targetDetail}` : withToolDetail("通过代理测试网络连通性", detail), tone, covered: true };
  }
  if (/(http_proxy|https_proxy|all_proxy|no_proxy|proxychains|tinyproxy|代理)/i.test(source)) return { label: "使用代理", tone, covered: true };
  if (/(hostname|uname|systeminfo|get-computerinfo|whoami|computername)/i.test(source)) return { label: "查询主机资料", tone, covered: true };
  if (/(ipconfig|ifconfig|ip addr|ip route|netstat|network|网络|dns|路由)/i.test(source)) return { label: "查询网络信息", tone, covered: true };
  const action = actionLabelFromSource(name, source, audit) || byAction[audit.toolAction];
  if (action) return { label: withToolDetail(action, detail), tone, covered: true };
  const mcp = mcpDisplayLabel(name);
  return mcp ? { label: withToolDetail(mcp, detail), tone, covered: true } : { label: withToolDetail("正在执行工具", detail), tone, covered: false };
}

function auditToolDetails(tool, context = {}, requestId = "") {
  const fileFormats = auditFileFormats(tool);
  const semantic = reconcileToolAction(requestId, tool, fileFormats);
  const audit = {
    toolId: tool?.id,
    toolName: tool?.name,
    toolStatus: toolStatus(tool),
    toolAction: semantic.action,
    observedToolAction: semantic.observedAction,
    actionConflict: semantic.conflict,
    fileFormats,
    toolTargets: auditToolTargets(tool)
  };
  return { ...audit, display: toolDisplay(tool, audit, context) };
}

function connectionDisplay(status, context) {
  if (context?.connection?.connectionMode === "local") {
    const text = status === "local-starting" ? "正在启动本机 Claude" : "本机 Claude 正在处理";
    return scenePresentation("connection", text, "", { text, title: text, tone: "working", connectionState: status === "connected" ? "connected" : "", preserveActiveTool: status === "continuing" });
  }
  const target = normalizeAuditTarget(context?.connection?.host);
  const nas = target ? `NAS ${displayTarget(target)}` : "NAS";
  const labels = {
    connecting: { scene: "正在连接 NAS", detail: displayTarget(target) },
    reconnecting: { scene: "连接中断，正在重连", detail: nas },
    connected: { scene: "Claude 正在处理", detail: `${nas} 已连接` },
    continuing: { scene: "Claude 正在持续执行操作", detail: "" },
    stopping: { scene: "正在结束当前操作", detail: "Claude 已收到停止请求" }
  };
  const display = labels[status] || { scene: "正在处理", detail: "" };
  const text = [display.scene, display.detail].filter(Boolean).join(" · ");
  return scenePresentation("connection", display.scene, display.detail, { text, title: text, tone: "working", connectionState: status === "connected" ? "connected" : "", preserveActiveTool: status === "continuing" });
}

function toolActionLabel(toolName) {
  const fileFormats = [];
  const action = auditToolAction({ name: toolName, input: {} }, fileFormats);
  return ({
    "view-image": "查看图片",
    "read-file": "读取文件",
    "create-file": "创建文件",
    "modify-file": "编辑文件",
    "delete-file": "删除文件",
    uninstall: "卸载工具",
    "run-command": "运行命令"
  })[action] || "正在执行工具";
}

function permissionDisplay(status, toolName) {
  const action = toolActionLabel(toolName);
  if (status === "waiting") return scenePresentation("permission", "等待权限", action, { title: `等待允许执行：${action}`, tone: "error" });
  if (status === "allowed") return scenePresentation("permission", "权限已允许", action, { title: `权限已允许：${action}`, tone: "working", force: true });
  return scenePresentation("permission", "权限被拒绝", action, { title: `权限被拒绝：${action}`, tone: "error" });
}

function uploadDisplay(event) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(event?.overall || 0) * 100)));
  const text = `正在上传附件 · ${percent}%`;
  return scenePresentation("upload", "正在上传附件", `${percent}%`, { text, title: text, tone: "working" });
}

function deltaDisplay() {
  return scenePresentation("delta", "正在生成回复", "", { title: "Claude 正在生成回复", tone: "working", preserveActiveTool: true });
}

function lifecycleDisplay(status, context) {
  if (status === "started") return connectionDisplay(context?.connection?.connectionMode === "local" ? "local-starting" : "connecting", context);
  if (status === "failed") return scenePresentation("lifecycle", "连接或执行失败", "", { title: "连接或 Claude 执行失败", tone: "error", clearActiveTools: true });
  if (status === "cancelled") return { kind: "lifecycle", workLabel: "空闲", title: "任务已停止", tone: "connected", clearActiveTools: true };
  return { kind: "lifecycle", workLabel: "空闲", title: "当前没有正在执行的动作", tone: "idle", clearActiveTools: true };
}

function toolPresentation(audit) {
  const label = audit.display.label;
  const completed = audit.toolStatus === "completed";
  const failed = ["failed", "denied"].includes(audit.toolStatus);
  const display = splitSceneAndDetail(label, audit.toolName);
  return {
    ...scenePresentation("tool", failed ? "工具失败" : display.scene, failed ? label : display.detail),
    ...audit.display,
    title: failed ? `工具失败：${label}` : completed ? `工具已完成：${label}` : label,
    // A tool-level outcome is not a request-level failure.  The lifecycle
    // event remains the only source allowed to show a global failure.
    tone: failed ? "error" : audit.display.tone
  };
}

function isIncompleteRunningCommand(tool, audit) {
  if (audit.toolStatus !== "running" || String(tool?.name || "").toLocaleLowerCase() !== "bash") return false;
  return !String(tool?.input?.command || "").trim();
}

function legacyToolForRenderer(tool, audit) {
  // The frozen renderer reads only name/input/status.  Give it a compact,
  // human-readable compatibility view while retaining the raw data in
  // `audit` for diagnostics and future module rules.
  return {
    ...tool,
    name: audit.display.label,
    input: { description: "" },
    status: audit.toolStatus
  };
}

function legacyConnectionEvent(event, presentation) {
  const activeStatuses = new Set(["connecting", "reconnecting", "continuing", "stopping"]);
  if (!activeStatuses.has(event.status)) return { ...event, presentation };
  // The frozen renderer has no field for an arbitrary connection label.  Its
  // established tool-event contract does, so the module adapts the connection
  // to that contract without making the renderer interpret connection data.
  return {
    ...event,
    originalType: "connection",
    type: "tool",
    tool: {
      id: "status-connection",
      name: presentation.text,
      input: { description: "" },
      status: "running"
    },
    presentation
  };
}

function displayAudit(sourceType, presentation, coverage) {
  if (coverage?.status === "unclassified") {
    return { disposition: "fallback", reason: "未知信号使用安全状态文案" };
  }
  if (sourceType === "usage") {
    return { disposition: "not-required", reason: "用量只更新 Token，不抢占状态栏" };
  }
  if (sourceType === "delta") {
    return { disposition: "coalesced", reason: "连续正文合并显示为生成回复状态" };
  }
  if (presentation?.updateWorkStatus === false) {
    return { disposition: "not-required", reason: "该信号不要求改变状态栏" };
  }
  return { disposition: "expected", reason: "模块已提供状态栏显示文案" };
}

function withDisplayAudit(event, sourceType, coverage) {
  return { ...event, displayAudit: displayAudit(sourceType, event.presentation, coverage) };
}

function normalizeStatusEvent(event = {}, context = {}) {
  const type = String(event.type || "");
  const coverage = SUPPORTED_EVENT_TYPES.has(type)
    ? { status: "supported", key: type }
    : { status: "unclassified", key: type || "missing-type", reason: "未知事件类型" };
  if (type === "tool") {
    const audit = auditToolDetails(event.tool, context, event.id);
    audit.display = proxyDisplay(audit.display, updateProxySession(event.id, event.tool));
    const needsReview = !audit.display.covered || audit.actionConflict;
    const review = { status: "review", key: `tool:${audit.toolName || "unknown"}`, reason: audit.actionConflict ? "同一工具 ID 的动作分类冲突" : "工具未命中中文动作词典" };
    // The executor can announce a Bash tool before its command payload arrives.
    // Do not flash a guessed status just before the semantic command frame;
    // that next frame is the first one allowed to decide the visible action.
    if (isIncompleteRunningCommand(event.tool, audit)) {
      return withDisplayAudit({
        ...event,
        tool: legacyToolForRenderer(event.tool, audit),
        audit,
        presentation: { kind: "tool", updateWorkStatus: false },
        coverage: needsReview ? review : coverage
      }, type, needsReview ? review : coverage);
    }
    return withDisplayAudit({
      ...event,
      tool: legacyToolForRenderer(event.tool, audit),
      audit,
      presentation: toolPresentation(audit),
      coverage: needsReview ? review : coverage
    }, type, needsReview ? review : coverage);
  }
  if (type === "connection") return withDisplayAudit({ ...legacyConnectionEvent(event, proxyTone(connectionDisplay(event.status, context), event.id)), coverage }, type, coverage);
  if (type === "permission") return withDisplayAudit({ ...event, presentation: proxyTone(permissionDisplay(event.status, event.toolName), event.id), coverage }, type, coverage);
  if (type === "upload") return withDisplayAudit({ ...event, presentation: proxyTone(uploadDisplay(event), event.id), coverage }, type, coverage);
  if (type === "delta") return withDisplayAudit({ ...event, presentation: proxyTone(deltaDisplay(), event.id), coverage }, type, coverage);
  if (type === "usage") return withDisplayAudit({ ...event, presentation: { kind: "usage", updateWorkStatus: false }, coverage }, type, coverage);
  if (type === "lifecycle") {
    if (isTerminalLifecycle(event.status)) {
      clearProxySession(event.id);
      clearToolSemantics(event.id);
    }
    return withDisplayAudit({ ...event, presentation: lifecycleDisplay(event.status, context), coverage }, type, coverage);
  }
  return withDisplayAudit({ ...event, presentation: scenePresentation("unknown", "正在执行工具", "", { title: "正在执行工具", tone: "working" }), coverage }, type, coverage);
}

function createStatusSignalObserver({ enabled = false, onGap = () => {} } = {}) {
  const reported = new Set();
  const requestLedgers = new Map();
  const report = (entry) => {
    const key = `${entry.status}:${entry.key}`;
    if (reported.has(key)) return;
    reported.add(key);
    onGap(entry);
  };
  return {
    observe(event) {
      if (!enabled) return event?.coverage || { status: "disabled", key: "capture-disabled" };
      const coverage = event?.coverage || { status: "unclassified", key: "missing-coverage", reason: "缺少覆盖标记" };
      const display = event?.displayAudit || { disposition: "fallback", reason: "缺少显示审计标记" };
      const requestId = String(event?.id || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
      if (requestId) {
        const ledger = requestLedgers.get(requestId) || { expected: 0, coalesced: 0, notRequired: 0, fallback: 0, review: 0 };
        if (display.disposition === "expected") ledger.expected += 1;
        else if (display.disposition === "coalesced") ledger.coalesced += 1;
        else if (display.disposition === "not-required") ledger.notRequired += 1;
        else ledger.fallback += 1;
        if (coverage.status === "review" || coverage.status === "unclassified") ledger.review += 1;
        requestLedgers.set(requestId, ledger);
        if (event?.originalType === "lifecycle" || (event?.type === "lifecycle" && isTerminalLifecycle(event?.status))) {
          report({ status: "display-summary", key: `request:${requestId}`, reason: "状态显示覆盖汇总", eventType: "lifecycle", display: ledger });
          requestLedgers.delete(requestId);
        }
      }
      if (coverage.status === "supported") return coverage;
      report({ status: coverage.status, key: coverage.key, reason: coverage.reason || "待收录", eventType: String(event?.type || "") });
      return coverage;
    }
  };
}

// ── Merged from audit-targets.cjs ──
// audit-targets originally re-exported auditToolTargets and normalizeAuditTarget
// from this module; they are now directly available here as a single file.

module.exports = {
  // Constants
  AUDIT_FILE_FORMATS,
  AUDIT_TOOL_ACTIONS,
  SUPPORTED_EVENT_TYPES,
  // Audit target functions (originally also exported via audit-targets.cjs)
  auditToolTargets,
  normalizeAuditTarget,
  // Core functions
  auditToolDetails,
  createStatusSignalObserver,
  normalizeStatusEvent
};