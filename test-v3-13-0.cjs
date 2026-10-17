"use strict";
/**
 * v3.13.0 测试 — 本机模式多引擎（AtomCode daemon 引擎 + 自定义命令引擎）
 * 覆盖：daemon-chat.cjs SSE 事件映射/容错/token/取消/错误；custom-cli.cjs 模板解析/历史回放/进程生命周期；
 *       main.cjs 引擎分发接线；settings.cjs 新字段与校验放宽；conversations.cjs 引擎会话隔离；渲染层与混淆登记。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("assert");

const ROOT = __dirname;
const DAEMON_PATH = path.join(ROOT, "src", "main", "daemon-chat.cjs");
const CUSTOM_PATH = path.join(ROOT, "src", "main", "custom-cli.cjs");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
const SETTINGS_PATH = path.join(ROOT, "src", "main", "settings.cjs");
const CONVERSATIONS_PATH = path.join(ROOT, "src", "main", "conversations.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const INDEX_PATH = path.join(ROOT, "src", "renderer", "index.html");
const LOCAL_PATH = path.join(ROOT, "src", "main", "local.cjs");
const OBFUSCATE_PATH = path.join(ROOT, "scripts", "obfuscate.cjs");
const PACKAGE_PATH = path.join(ROOT, "package.json");

const { runAtomCodeChat, verifyAtomCodeConnection, readDaemonTokenFile, daemonBaseUrl } = require(DAEMON_PATH);
const { runCustomCli, buildHistoryTranscript, buildSpawnPlan, tokenizeCommandTemplate, verifyCustomCliConnection } = require(CUSTOM_PATH);

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((error) => {
      failed++;
      failures.push(`${name}: ${error.message}`);
      console.log(`  ✗ ${name}: ${error.message}`);
    });
}

/** 启动 mock atomcode-daemon */
function startMockDaemon(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const handler = handlers[req.url] || handlers[req.url.split("?")[0]];
        const ctx = { req, res, body: Buffer.concat(chunks).toString("utf8"), headers: req.headers };
        if (!handler) { res.writeHead(404); res.end("{}"); return; }
        Promise.resolve(handler(ctx)).catch(() => {
          try { res.writeHead(500); res.end(JSON.stringify({ type: "error", message: "mock handler failed" })); } catch {}
        });
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function writeSse(res, events, options = {}) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (!options.keepOpen) res.end();
}

function daemonConfig(port, extra = {}) {
  return { atomcodeHost: "127.0.0.1", atomcodePort: port, workingDirectory: "", ...extra };
}

function collectRunner(callbacks) {
  return {
    deltas: [],
    tools: [],
    usage: [],
    statuses: [],
    sessionIds: [],
    make() {
      return {
        onDelta: (text) => { this.deltas.push(text); callbacks?.onDelta?.(text); },
        onToolEvent: (tool) => this.tools.push(JSON.parse(JSON.stringify(tool))),
        onUsage: (usage) => this.usage.push(usage),
        onStatus: (status) => this.statuses.push(status),
        onSessionId: (id) => this.sessionIds.push(id),
        onLog: () => {},
        onUploadProgress: () => {}
      };
    }
  };
}

async function main() {
  console.log("=== v3.13.0 本机模式多引擎测试 ===\n");

  // ── 1. daemon-chat.cjs：连接测试 ─────────────────
  await test("verifyAtomCodeConnection 拼接 version 与模型数", async () => {
    const { server, port } = await startMockDaemon({
      "/health": ({ res }) => { res.writeHead(200); res.end(JSON.stringify({ status: "ok", version: "5.1.0", service: "atomcode-daemon" })); },
      "/models": ({ res }) => { res.writeHead(200); res.end(JSON.stringify([{ provider: "openai", model: "gpt-4o", is_default: true }, { provider: "claude", model: "claude-sonnet-4-20250514" }])); }
    });
    try {
      const message = await verifyAtomCodeConnection(daemonConfig(port));
      assert.ok(message.includes("5.1.0"), "未包含版本号");
      assert.ok(message.includes("可用模型 2 个"), "未包含模型数量");
    } finally { server.close(); }
  });

  await test("verifyAtomCodeConnection 401 → 友好 token 提示", async () => {
    const { server, port } = await startMockDaemon({
      "/health": ({ res }) => { res.writeHead(401); res.end("{}"); }
    });
    try {
      await assert.rejects(() => verifyAtomCodeConnection(daemonConfig(port)), /token/);
    } finally { server.close(); }
  });

  await test("daemonBaseUrl 默认 127.0.0.1:13456", () => {
    assert.strictEqual(daemonBaseUrl({}), "http://127.0.0.1:13456");
    assert.throws(() => daemonBaseUrl({ atomcodePort: 99999 }), /端口无效/);
  });

  await test("readDaemonTokenFile 读取 ~/.atomcode/daemon-<port>.json", () => {
    const previousHome = process.env.HOME;
    const previousProfile = process.env.USERPROFILE;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "atomcode-home-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    try {
      const dir = path.join(tempHome, ".atomcode");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "daemon-13456.json"), JSON.stringify({ token: "file-token-1" }));
      assert.strictEqual(readDaemonTokenFile(13456), "file-token-1");
      fs.writeFileSync(path.join(dir, "daemon-13456.json"), JSON.stringify({ api_key: "key-token-2" }));
      assert.strictEqual(readDaemonTokenFile(13456), "key-token-2");
      fs.writeFileSync(path.join(dir, "daemon-13456.json"), "not json");
      assert.strictEqual(readDaemonTokenFile(13456), "");
      assert.strictEqual(readDaemonTokenFile(9999), "");
    } finally {
      process.env.HOME = previousHome;
      process.env.USERPROFILE = previousProfile;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  // ── 2. daemon-chat.cjs：SSE 事件映射 ─────────────────
  await test("chat 全事件映射：text/reasoning/tool/tokens/artifact/done", async () => {
    let authHeader = "";
    const events = [
      { type: "text", text: "你好" },
      { type: "text", delta: "世界" },
      { type: "reasoning", text: "思考中" },
      { type: "tool_start", id: "t1", name: "read_file", arguments: JSON.stringify({ path: "/tmp/a.txt" }) },
      { type: "tool_output", id: "t1", text: "文件内容片段" },
      { type: "tool_result", id: "t1", name: "read_file", output: "读取成功 10 字节", success: true },
      { type: "tokens", prompt: 10, completion: 5, total: 15 },
      { type: "artifact_start", id: "a1", kind: "html" },
      { type: "artifact_content", id: "a1", text: "<h1>hi</h1>" },
      { type: "artifact_end", id: "a1" },
      { type: "done", session_id: "sess-123", tokens: { prompt: 10, completion: 5, total: 15 } }
    ];
    const { server, port } = await startMockDaemon({
      "/chat": ({ res, headers }) => {
        authHeader = headers.authorization || "";
        writeSse(res, events);
      }
    });
    try {
      const collector = collectRunner();
      const runner = runAtomCodeChat(daemonConfig(port, { atomcodeToken: "tok-1" }), "消息", "", [], collector.make());
      const result = await runner.promise;
      assert.strictEqual(authHeader, "Bearer tok-1", "未带 Bearer token");
      assert.strictEqual(collector.deltas.join(""), "你好世界");
      assert.strictEqual(result.text, "你好世界");
      assert.strictEqual(result.sessionId, "sess-123");
      assert.deepStrictEqual(collector.sessionIds, ["sess-123"]);
      const usage = collector.usage.at(-1);
      assert.strictEqual(usage.prompt_tokens, 10);
      assert.strictEqual(usage.completion_tokens, 5);
      assert.strictEqual(usage.total_tokens, 15);
      const tool = collector.tools.filter((item) => item.id === "t1").at(-1);
      assert.ok(tool, "缺少工具卡");
      assert.strictEqual(tool.name, "read_file");
      assert.strictEqual(tool.status, "completed");
      assert.ok(String(tool.result).includes("读取成功"));
      const runningSnapshot = collector.tools.find((item) => item.id === "t1");
      assert.strictEqual(runningSnapshot.status, "running", "工具卡运行中快照缺失");
      const artifact = collector.tools.filter((item) => item.id === "a1").at(-1);
      assert.ok(artifact && artifact.status === "completed", "制品卡未完成");
      assert.deepStrictEqual(collector.statuses, ["local-starting", "connecting", "connected"]);
    } finally { server.close(); }
  });

  await test("event: 行兜底（data 无 type 字段）", async () => {
    const { server, port } = await startMockDaemon({
      "/chat": ({ res }) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: text\n");
        res.write(`data: ${JSON.stringify({ text: "fallback" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "done", session_id: "s1" })}\n\n`);
        res.end();
      }
    });
    try {
      const collector = collectRunner();
      const result = await runAtomCodeChat(daemonConfig(port), "m", "", [], collector.make()).promise;
      assert.strictEqual(collector.deltas.join(""), "fallback");
      assert.strictEqual(result.sessionId, "s1");
    } finally { server.close(); }
  });

  await test("error 事件 → reject 且带 message", async () => {
    const { server, port } = await startMockDaemon({
      "/chat": ({ res }) => writeSse(res, [{ type: "text", text: "部分" }, { type: "error", message: "provider 炸了" }])
    });
    try {
      const collector = collectRunner();
      await assert.rejects(
        () => runAtomCodeChat(daemonConfig(port), "m", "", [], collector.make()).promise,
        /provider 炸了/
      );
    } finally { server.close(); }
  });

  await test("空流 → 未返回任何数据", async () => {
    const { server, port } = await startMockDaemon({
      "/chat": ({ res }) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); }
    });
    try {
      await assert.rejects(
        () => runAtomCodeChat(daemonConfig(port), "m", "", [], collectRunner().make()).promise,
        /未返回任何数据/
      );
    } finally { server.close(); }
  });

  await test("非 200（404）→ 提示确认是 daemon 服务", async () => {
    const { server, port } = await startMockDaemon({});
    try {
      await assert.rejects(
        () => runAtomCodeChat(daemonConfig(port), "m", "", [], collectRunner().make()).promise,
        /HTTP 404/
      );
    } finally { server.close(); }
  });

  await test("cancel() 调用 /chat/stop 并以取消态收尾", async () => {
    let stopCalled = false;
    let releaseChat = () => {};
    const chatClosed = new Promise((resolve) => { releaseChat = resolve; });
    const { server, port } = await startMockDaemon({
      "/chat": ({ res }) => { chatClosed.then(() => res.end()); },
      "/chat/stop": ({ res, body }) => {
        if (JSON.parse(body || "{}").session_id === "sess-stop") { stopCalled = true; releaseChat(); }
        res.writeHead(200); res.end(JSON.stringify({ success: true }));
      }
    });
    try {
      const runner = runAtomCodeChat(daemonConfig(port), "m", "sess-stop", [], collectRunner().make());
      const finished = runner.promise.catch((error) => error);
      setTimeout(() => runner.cancel(), 50);
      const outcome = await finished;
      assert.ok(stopCalled, "未调用 /chat/stop");
      assert.ok(outcome instanceof Error && outcome.cancelled, "未以取消错误收尾");
    } finally { server.close(); }
  });

  await test("session_id 续聊传入请求体", async () => {
    let requestBody = "";
    const { server, port } = await startMockDaemon({
      "/chat": ({ res, body }) => {
        requestBody = body;
        writeSse(res, [{ type: "text", text: "ok" }, { type: "done", session_id: "sess-9" }]);
      }
    });
    try {
      await runAtomCodeChat(daemonConfig(port), "第二条", "sess-9", [], collectRunner().make()).promise;
      const parsed = JSON.parse(requestBody);
      assert.strictEqual(parsed.session_id, "sess-9");
      assert.ok(parsed.message.includes("第二条"), "消息未包含");
    } finally { server.close(); }
  });

  // ── 3. custom-cli.cjs ─────────────────
  await test("tokenizeCommandTemplate 引号与空格", () => {
    assert.deepStrictEqual(tokenizeCommandTemplate('aider --message "hello world"'), ["aider", "--message", "hello world"]);
    assert.deepStrictEqual(tokenizeCommandTemplate("  opencode   run  "), ["opencode", "run"]);
    assert.throws(() => tokenizeCommandTemplate("aider '未闭合"), /引号/);
    assert.throws(() => tokenizeCommandTemplate("   "), /请填写/);
  });

  await test("buildSpawnPlan 占位符与 stdin 判定", () => {
    const withPlaceholder = buildSpawnPlan("aider --message {message}", "你好");
    assert.deepStrictEqual(withPlaceholder.args, ["--message", "你好"]);
    assert.strictEqual(withPlaceholder.viaStdin, false);
    assert.strictEqual(withPlaceholder.command, "aider");
    const stdinMode = buildSpawnPlan("node script.js", "你好");
    assert.strictEqual(stdinMode.viaStdin, true);
    assert.deepStrictEqual(stdinMode.args, ["script.js"], "无占位符时应保留原参数，消息走 stdin");
  });

  await test("buildHistoryTranscript 过滤与截断", () => {
    const messages = [
      { role: "system", text: "应过滤" },
      { role: "user", text: "问题一" },
      { role: "assistant", text: "回答一", draft: true },
      { role: "assistant", text: "回答二" },
      { role: "user", text: "问题三" }
    ];
    const transcript = buildHistoryTranscript(messages);
    assert.ok(transcript.includes("问题一"), "用户消息丢失");
    assert.ok(!transcript.includes("回答一"), "草稿未被过滤");
    assert.ok(!transcript.includes("应过滤"), "system 未被过滤");
    assert.ok(transcript.includes("回答二") && transcript.includes("问题三"), "最近消息丢失");
    const capped = buildHistoryTranscript(messages, { maxMessages: 1 });
    assert.ok(capped.includes("问题三") && !capped.includes("问题一"), "maxMessages 未生效");
    const empty = buildHistoryTranscript([]);
    assert.strictEqual(empty, "");
  });

  await test("runCustomCli 端到端：{message} 传参 + stdout 流式", async () => {
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "custom-cli-")), "echo.js");
    fs.writeFileSync(script, "process.stdout.write('ECHO:' + process.argv[2]);");
    try {
      const collector = collectRunner();
      const result = await runCustomCli(
        { customCliCommand: `node ${JSON.stringify(script)} {message}`, workingDirectory: "" },
        "你好引擎",
        "",
        [],
        collector.make()
      ).promise;
      assert.ok(result.text.includes("ECHO:你好引擎"), "参数替换失败：" + result.text);
      assert.ok(collector.deltas.join("").includes("ECHO:你好引擎"));
      assert.strictEqual(result.sessionId, "");
      assert.strictEqual(result.text, result.lastTurnText);
    } finally { fs.rmSync(path.dirname(script), { recursive: true, force: true }); }
  });

  await test("runCustomCli stdin 模式 + 历史回放", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-cli-"));
    const script = path.join(dir, "stdin.js");
    fs.writeFileSync(script, "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>process.stdout.write('STDIN_BYTES:'+n));");
    try {
      const history = [
        { role: "user", text: "上一问" },
        { role: "assistant", text: "上一答" }
      ];
      const result = await runCustomCli(
        { customCliCommand: `node ${JSON.stringify(script)}`, workingDirectory: "", history },
        "新问题",
        "",
        [],
        collectRunner().make()
      ).promise;
      assert.ok(result.text.includes("STDIN_BYTES:"), "无输出");
      const bytes = Number(result.text.match(/STDIN_BYTES:(\d+)/)?.[1] || 0);
      const expected = buildHistoryTranscript(history) + "新问题";
      assert.strictEqual(bytes, Buffer.byteLength(expected, "utf8"), "stdin 内容与回放+新消息不符");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test("runCustomCli 非零退出码带 stderr", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-cli-"));
    const script = path.join(dir, "fail.js");
    fs.writeFileSync(script, "process.stderr.write('boom');process.exit(3);");
    try {
      await assert.rejects(
        () => runCustomCli({ customCliCommand: `node ${JSON.stringify(script)}`, workingDirectory: "" }, "m", "", [], collectRunner().make()).promise,
        (error) => /代码 3/.test(error.message) && /fail|boom/.test(error.message)
      );
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test("runCustomCli 取消 = 杀进程", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-cli-"));
    const script = path.join(dir, "slow.js");
    fs.writeFileSync(script, "setInterval(()=>{},1000);");
    try {
      const runner = runCustomCli({ customCliCommand: `node ${JSON.stringify(script)}`, workingDirectory: "" }, "m", "", [], collectRunner().make());
      const finished = runner.promise.catch((error) => error);
      setTimeout(() => runner.cancel(), 100);
      const outcome = await finished;
      assert.ok(outcome instanceof Error && outcome.cancelled, "未以取消错误收尾");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test("verifyCustomCliConnection 只解析不执行", async () => {
    // 绝对路径不存在 → 跨平台都能在验证阶段报"找不到"（相对命令名仅在 Windows 走 where.exe 探测）
    const missing = path.join(os.tmpdir(), "definitely-not-exist-cmd-abc");
    const template = `${JSON.stringify(missing)} {message}`;
    const plan = buildSpawnPlan(template, "x");
    assert.strictEqual(plan.viaStdin, false);
    await assert.rejects(() => verifyCustomCliConnection({ customCliCommand: template }), /找不到自定义命令/);
    // 合法命令 → 返回确认文案，不真正执行
    const ok = await verifyCustomCliConnection({ customCliCommand: "node {message}" });
    assert.ok(ok.includes("自定义命令已找到"), "正常命令验证失败：" + ok);
  });

  // ── 4. main.cjs 引擎分发接线 ─────────────────
  const mainSrc = fs.readFileSync(MAIN_PATH, "utf8");
  await test("main.cjs 引入两个新引擎模块", () => {
    assert.ok(mainSrc.includes('require("./daemon-chat.cjs")'), "未引入 daemon-chat");
    assert.ok(mainSrc.includes('require("./custom-cli.cjs")'), "未引入 custom-cli");
    assert.ok(mainSrc.includes("getAtomcodeToken"), "未引入 token 解密");
  });
  await test("main.cjs chat:send 按 localEngine 三分发 + 历史回放", () => {
    assert.ok(mainSrc.includes('localEngine === "atomcode"') && mainSrc.includes("runAtomCodeChat(config"), "atomcode 分发缺失");
    assert.ok(mainSrc.includes('localEngine === "custom"') && mainSrc.includes("runCustomCli(config"), "custom 分发缺失");
    assert.ok(mainSrc.includes("conversation.messages.slice(0, -1)"), "custom 历史截取缺失");
    assert.ok(mainSrc.includes("local-stdio") === false && mainSrc.includes("`local-${localEngine}`"), "transport 日志未升级");
  });
  await test("main.cjs 会话/落库带 engine 参数", () => {
    assert.ok(/sessionForMode\(conversation, config\.connectionMode, localEngine(?:, taskProfile)?(?:, taskRemoteAdapter)?\)/.test(mainSrc), "sessionForMode 未传引擎；v3.18.0 起允许尾参 taskProfile");
    assert.ok(/saveConversationSession\(input\.conversationId, sessionId, config\.connectionMode, localEngine(?:, taskProfile)?(?:, taskRemoteAdapter)?\)/.test(mainSrc), "saveConversationSession 未传引擎；v3.18.0 起允许尾参 taskProfile");
    assert.ok(/addAssistantMessage\([^\n]+localEngine(?:, taskProfile)?(?:, taskRemoteAdapter)?(?:, [^)\n]+)?\);/.test(mainSrc), "addAssistantMessage 未传引擎；v3.24.0 起允许尾参 thinking");
  });
  await test("main.cjs 非 claude 引擎禁用压缩 + model 管理", () => {
    assert.ok(mainSrc.includes("当前本机引擎不支持上下文压缩"), "压缩守卫缺失");
    assert.ok(mainSrc.includes("当前本机引擎不使用 Claude 模型配置"), "模型管理守卫缺失");
  });
  await test("main.cjs connection:test 三引擎分派", () => {
    assert.ok(mainSrc.includes("verifyAtomCodeConnection(config, writeLog)"), "atomcode 连接测试缺失");
    assert.ok(mainSrc.includes("verifyCustomCliConnection(config, writeLog)"), "custom 连接测试缺失");
    assert.ok(mainSrc.includes("String(input.atomcodeToken || \"\").trim() || getAtomcodeToken()"), "token 兜底缺失");
  });

  // ── 5. settings.cjs 新字段 ─────────────────
  const settingsSrc = fs.readFileSync(SETTINGS_PATH, "utf8");
  await test("settings.cjs 引擎归一化与默认值", () => {
    assert.ok(settingsSrc.includes("function normalizeLocalEngine"), "缺少 normalizeLocalEngine");
    assert.ok(settingsSrc.includes("normalizeAtomcodePort"), "缺少端口归一化");
    assert.ok(settingsSrc.includes('atomcodeHost: String(raw.atomcodeHost || "127.0.0.1")'), "getSettings 缺 host 默认值");
    assert.ok(settingsSrc.includes("hasAtomcodeToken"), "缺少 token 脱敏布尔");
    assert.ok(settingsSrc.includes("customCliCommand"), "缺少 customCliCommand");
  });
  await test("settings.cjs token 加密存储与导出", () => {
    assert.ok(settingsSrc.includes("atomcodeTokenEncrypted"), "缺少加密存储字段");
    assert.ok(settingsSrc.includes("function getAtomcodeToken"), "缺少解密读取函数");
    assert.ok(/module\.exports = \{[^}]*getAtomcodeToken/.test(settingsSrc), "getAtomcodeToken 未导出");
  });
  await test("settings.cjs 非 claude 引擎放宽唤醒命令 + 自定义模板必填", () => {
    assert.ok(settingsSrc.includes("非 Claude 引擎不依赖 Claude 唤醒命令"), "唤醒命令放宽缺失");
    assert.ok(settingsSrc.includes("自定义命令模板不能为空"), "自定义模板校验缺失");
  });

  // ── 6. conversations.cjs 引擎会话隔离 ─────────────────
  const conversationsSrc = fs.readFileSync(CONVERSATIONS_PATH, "utf8");
  await test("conversations.cjs 会话字段按引擎派生", () => {
    assert.ok(conversationsSrc.includes("function localSessionField"), "缺少 localSessionField");
    assert.ok(conversationsSrc.includes('localSessionId_${name'), "引擎后缀字段缺失");
    assert.ok(conversationsSrc.includes('if (name === "custom") return "";'), "custom 引擎应无会话字段");
    assert.ok(/sessionForMode\(conversation, connectionMode, engine = "claude"(?:, profileId = "")?(?:, remoteAdapter = "claude")?\)/.test(conversationsSrc), "sessionForMode 未加 engine 参数；v3.18.0 起允许尾参 profileId（v3.19.0 再叠 remoteAdapter）");
    assert.ok(/saveConversationSession\(id, sessionId, connectionMode = "ssh", engine = "claude"(?:, profileId = "")?(?:, remoteAdapter = "claude")?\)/.test(conversationsSrc), "saveConversationSession 未加 engine 参数；v3.18.0 起允许尾参 profileId（v3.19.0 再叠 remoteAdapter）");
  });
  await test("conversations.cjs 清会话覆盖引擎后缀字段", () => {
    assert.ok(conversationsSrc.includes("key.startsWith(\"localSessionId_\")"), "清会话未覆盖引擎字段");
  });

  // ── 7. 渲染层接线 ─────────────────
  const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
  const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");
  await test("index.html 本机引擎面板三件套", () => {
    for (const id of ["local-fields", "atomcode-fields", "custom-fields", "wake-name-field", "atomcode-host", "atomcode-port", "atomcode-token", "custom-cli-command", "toggle-atomcode-token"]) {
      assert.ok(indexSrc.includes(`id="${id}"`), `缺少 #${id}`);
    }
    assert.ok(indexSrc.includes('data-local-engine="atomcode"') && indexSrc.includes('data-local-engine="custom"'), "引擎按钮缺失");
    assert.ok(indexSrc.includes("ATOMCODE_DAEMON_ENABLE_DANGEROUS_TOOLS"), "缺 daemon 危险工具安全提示");
  });
  await test("renderer.js 引擎状态与表单接线", () => {
    assert.ok(rendererSrc.includes("function localEngineLabel"), "缺少引擎显示名函数");
    assert.ok(rendererSrc.includes("currentLocalEngine"), "缺少引擎状态变量");
    assert.ok(rendererSrc.includes("atomcodeToken: document.querySelector(\"#atomcode-token\")"), "收集缺 token");
    assert.ok(rendererSrc.includes('localEngine: data.get("localEngine")'), "收集缺引擎");
    assert.ok(rendererSrc.includes("hasAtomcodeToken"), "回显缺 token 脱敏布尔");
    assert.ok(rendererSrc.includes("[data-local-engine]"), "引擎按钮事件缺失");
    assert.ok(rendererSrc.includes("settings.localEngine === \"custom\" && !settings.customCliCommand"), "启动校验缺自定义模板");
    assert.ok(rendererSrc.includes("正在启动 AtomCode daemon…"), "AtomCode 状态文案缺失");
  });

  // ── 8. local.cjs 导出扩展 ─────────────────
  const localSrc = fs.readFileSync(LOCAL_PATH, "utf8");
  await test("local.cjs 导出 writeLocalAttachments/validatedWorkingDirectory/subject 参数", () => {
    assert.ok(/module\.exports = \{[^}]*writeLocalAttachments/.test(localSrc), "writeLocalAttachments 未导出");
    assert.ok(/module\.exports = \{[^}]*validatedWorkingDirectory/.test(localSrc), "validatedWorkingDirectory 未导出");
    assert.ok(localSrc.includes('subject = "本机 Claude 唤醒命令"'), "resolveLocalCommand 缺 subject 参数");
  });

  // ── 9. 构建管线登记与版本 ─────────────────
  const obfuscateSrc = fs.readFileSync(OBFUSCATE_PATH, "utf8");
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  await test("混淆清单登记两个新文件", () => {
    assert.ok(obfuscateSrc.includes('"main/daemon-chat.cjs"'), "daemon-chat.cjs 未登记混淆");
    assert.ok(obfuscateSrc.includes('"main/custom-cli.cjs"'), "custom-cli.cjs 未登记混淆");
  });
  await test("package.json 版本 ≥ 3.13.0（v3.14.0 起跟随当前版本，语义向后兼容）", () => {
    const [major, minor] = packageJson.version.split(".").map(Number);
    assert.ok(major > 3 || (major === 3 && minor >= 13), `当前版本 ${packageJson.version} 应不低于 3.13.0`);
  });

  // ── 汇总 ─────────────────
  console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
  if (failed) {
    console.log("失败项：");
    for (const item of failures) console.log("  - " + item);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("测试执行异常：", error);
  process.exitCode = 1;
});