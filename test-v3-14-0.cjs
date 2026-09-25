"use strict";
/**
 * v3.14.0 测试 — 云端模式工具执行（云办公一期）
 * 覆盖：cloud-tools.cjs 五工具真实单测（临时目录 + mock http server）/ 路径逃逸拦截 / run_command 开关；
 *       cloud-chat.cjs tools 请求体（OpenAI/Anthropic 双格式）/ 流式 tool_calls 增量拼接 / 多轮循环消息回填；
 *       main.cjs 工具循环与工具卡接线；settings.cjs 三字段；渲染层区块；混淆登记与版本号。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const assert = require("assert");

const ROOT = __dirname;
const CLOUD_TOOLS_PATH = path.join(ROOT, "src", "main", "cloud-tools.cjs");
const CLOUD_CHAT_PATH = path.join(ROOT, "src", "main", "cloud-chat.cjs");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
const SETTINGS_PATH = path.join(ROOT, "src", "main", "settings.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const INDEX_PATH = path.join(ROOT, "src", "renderer", "index.html");
const OBFUSCATE_PATH = path.join(ROOT, "scripts", "obfuscate.cjs");
const PACKAGE_PATH = path.join(ROOT, "package.json");

const {
  MAX_TOOL_ROUNDS, MAX_OUTPUT_CHARS, MAX_FILE_BYTES,
  executeToolCall, resolveInsideWorkdir, toAnthropicTools, toolDefinitions
} = require(CLOUD_TOOLS_PATH);
const { sendCloudChat, buildChatBody, buildAnthropicBody, buildMessages } = require(CLOUD_CHAT_PATH);

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

/** 启动 mock HTTP 服务器（返回收到的请求体 + 自定义响应） */
function startMockServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ url: req.url, headers: req.headers, body });
        Promise.resolve(handler({ req, res, body, headers: req.headers, requests })).catch((error) => {
          try { res.writeHead(500); res.end(String(error.message)); } catch {}
        });
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

function sse(res, lines) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const line of lines) res.write(line);
  res.end();
}

function openAiChunk(delta, finishReason) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason || null }] })}\n\n`;
}

/** 临时工作目录（测试结束清理） */
function makeWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloud-tools-test-"));
}

// ════════════════════════════════════════════
(async () => {
  console.log("\n═══ cloud-tools.cjs 工具集与安全沙盒 ═══");

  await test("toolDefinitions：默认 4 工具，allowCommand 时 5 个", () => {
    assert.strictEqual(toolDefinitions(false).length, 4);
    assert.strictEqual(toolDefinitions(true).length, 5);
    const names = toolDefinitions(true).map((t) => t.function.name);
    for (const expected of ["read_file", "write_file", "list_directory", "web_fetch", "run_command"]) {
      assert.ok(names.includes(expected), `缺少工具 ${expected}`);
    }
    assert.strictEqual(toolDefinitions(false).some((t) => t.function.name === "run_command"), false);
  });

  await test("toAnthropicTools：function 字段转 input_schema", () => {
    const [anthropic] = toAnthropicTools(toolDefinitions(false));
    assert.strictEqual(anthropic.name, "read_file");
    assert.ok(anthropic.description);
    assert.strictEqual(anthropic.input_schema.type, "object");
    assert.strictEqual(anthropic.function, undefined);
  });

  await test("resolveInsideWorkdir：相对路径 OK、../ 逃逸拦截、目录内绝对路径 OK、目录外绝对路径拦截", () => {
    const workdir = "/tmp/cloud-tools-wd";
    assert.strictEqual(resolveInsideWorkdir(workdir, "a/b.txt"), path.resolve(workdir, "a/b.txt"));
    assert.throws(() => resolveInsideWorkdir(workdir, "../escape.txt"), /超出工作目录/);
    assert.throws(() => resolveInsideWorkdir(workdir, "../../etc/passwd"), /超出工作目录/);
    const inside = path.resolve(workdir, "sub/file.txt");
    assert.strictEqual(resolveInsideWorkdir(workdir, inside), inside);
    assert.throws(() => resolveInsideWorkdir(workdir, "/etc/passwd"), /超出工作目录/);
    assert.strictEqual(resolveInsideWorkdir(workdir, ""), workdir); // 空路径回落到工作目录根
  });

  await test("executeToolCall：无工作目录报错、未知工具报错、参数非法 JSON 报错", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-neg-"));
    try {
      await assert.rejects(executeToolCall({ name: "read_file", arguments: "{}" }, { workdir: "", allowCommand: false }), /工作目录/);
      await assert.rejects(executeToolCall({ name: "no_such_tool", arguments: "{}" }, { workdir, allowCommand: false }), /未知工具/);
      await assert.rejects(executeToolCall({ name: "read_file", arguments: "{bad json" }, { workdir, allowCommand: false }), /不是合法 JSON/);
      await assert.rejects(executeToolCall({ name: "read_file", arguments: "{}" }, { workdir: path.join(workdir, "missing"), allowCommand: false }), /工作目录/);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  await test("write_file + read_file 闭环：写新文件自动建父目录，回读一致", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-io-"));
    try {
      const writeResult = await executeToolCall(
        { name: "write_file", arguments: JSON.stringify({ path: "sub/note.txt", content: "云办公测试内容" }) },
        { workdir, allowCommand: false }
      );
      assert.ok(/已写入/.test(writeResult));
      assert.strictEqual(fs.readFileSync(path.join(workdir, "sub/note.txt"), "utf8"), "云办公测试内容");
      const readResult = await executeToolCall(
        { name: "read_file", arguments: JSON.stringify({ path: "sub/note.txt" }) },
        { workdir, allowCommand: false }
      );
      assert.strictEqual(readResult, "云办公测试内容");
      // 目录外写入被拦截
      await assert.rejects(
        executeToolCall({ name: "write_file", arguments: JSON.stringify({ path: "../evil.txt", content: "x" }) }, { workdir, allowCommand: false }),
        /超出工作目录/
      );
      assert.ok(!fs.existsSync(path.join(path.dirname(workdir), "evil.txt")));
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  await test("read_file：目录拒绝、空文件提示、超大文件截断到 512KB", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-read-"));
    try {
      await assert.rejects(
        executeToolCall({ name: "read_file", arguments: JSON.stringify({ path: "." }) }, { workdir, allowCommand: false }),
        /是文件夹/
      );
      fs.writeFileSync(path.join(workdir, "empty.txt"), "", "utf8");
      assert.strictEqual(await executeToolCall({ name: "read_file", arguments: '{"path":"empty.txt"}' }, { workdir, allowCommand: false }), "（空文件）");
      fs.writeFileSync(path.join(workdir, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1024), "utf8");
      const big = await executeToolCall({ name: "read_file", arguments: '{"path":"big.txt"}' }, { workdir, allowCommand: false });
      assert.ok(big.includes("已截断"));
      assert.ok(Buffer.byteLength(big, "utf8") < MAX_FILE_BYTES + 200);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  await test("list_directory：默认根、[目录]/[文件] 前缀、空文件夹提示", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ls-"));
    try {
      fs.mkdirSync(path.join(workdir, "sub"));
      fs.writeFileSync(path.join(workdir, "a.txt"), "x", "utf8");
      const root = await executeToolCall({ name: "list_directory", arguments: "{}" }, { workdir, allowCommand: false });
      assert.ok(root.includes("[目录] sub"));
      assert.ok(root.includes("[文件] a.txt"));
      const sub = await executeToolCall({ name: "list_directory", arguments: '{"path":"sub"}' }, { workdir, allowCommand: false });
      assert.strictEqual(sub, "（空文件夹）");
      await assert.rejects(
        executeToolCall({ name: "list_directory", arguments: '{"path":"../.."}' }, { workdir, allowCommand: false }),
        /超出工作目录/
      );
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  await test("run_command：未开启抛错、开启后回显、退出码呈现", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-cmd-"));
    try {
      await assert.rejects(
        executeToolCall({ name: "run_command", arguments: '{"command":"echo hi"}' }, { workdir, allowCommand: false }),
        /未开启/
      );
      const output = await executeToolCall({ name: "run_command", arguments: '{"command":"echo hello-cloud"}' }, { workdir, allowCommand: true });
      assert.ok(/退出码 0/.test(output));
      assert.ok(output.includes("hello-cloud"));
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  await test("web_fetch：mock server HTML 转纯文本（去 script/style + 实体解码）", async () => {
    const { server, port, requests } = await startMockServer(({ res }) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><head><script>alert(1)</script><style>.a{color:red}</style></head><body><p>标题&amp;正文</p><div>第二行&lt;标签&gt;</div></body></html>");
    });
    try {
      const output = await executeToolCall({ name: "web_fetch", arguments: JSON.stringify({ url: `http://127.0.0.1:${port}/page` }) }, { workdir: os.tmpdir(), allowCommand: false });
      assert.ok(output.includes("标题&正文"));
      assert.ok(output.includes("第二行<标签>"));
      assert.ok(!output.includes("alert(1)"));
      assert.ok(!output.includes("color:red"));
      assert.strictEqual(requests.length, 1);
      assert.ok(/AgentChatPro/.test(requests[0].headers["user-agent"]));
    } finally {
      server.close();
    }
  });

  await test("web_fetch：非 200 报 HTTP 状态、重定向跟随、非文本类型提示", async () => {
    const { server, port } = await startMockServer(({ req, res }) => {
      if (req.url === "/404") { res.writeHead(404); res.end("nope"); return; }
      if (req.url === "/jump") { res.writeHead(302, { Location: "/final" }); res.end(); return; }
      if (req.url === "/final") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("到达终点"); return; }
      if (req.url === "/bin") { res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(Buffer.from([0, 1, 2])); return; }
      res.writeHead(200); res.end("{}");
    });
    try {
      await assert.rejects(
        executeToolCall({ name: "web_fetch", arguments: JSON.stringify({ url: `http://127.0.0.1:${port}/404` }) }, { workdir: os.tmpdir(), allowCommand: false }),
        /HTTP 404/
      );
      const redirected = await executeToolCall({ name: "web_fetch", arguments: JSON.stringify({ url: `http://127.0.0.1:${port}/jump` }) }, { workdir: os.tmpdir(), allowCommand: false });
      assert.ok(redirected.includes("到达终点"));
      const binary = await executeToolCall({ name: "web_fetch", arguments: JSON.stringify({ url: `http://127.0.0.1:${port}/bin` }) }, { workdir: os.tmpdir(), allowCommand: false });
      assert.ok(/非文本内容/.test(binary));
      await assert.rejects(
        executeToolCall({ name: "web_fetch", arguments: JSON.stringify({ url: "ftp://x/y" }) }, { workdir: os.tmpdir(), allowCommand: false }),
        /http\/https/
      );
    } finally {
      server.close();
    }
  });

  console.log("\n═══ cloud-chat.cjs tools 请求体与流式解析 ═══");

  await test("buildChatBody：tools 进请求体、raw 消息透传、普通消息文本转换", () => {
    const tools = toolDefinitions(true);
    const body = buildChatBody(
      [
        { role: "system", content: "sys" },
        { role: "user", text: "你好" },
        { raw: true, role: "assistant", content: "", extra: { tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }] } },
        { raw: true, role: "tool", content: "文件内容", extra: { tool_call_id: "t1" } }
      ],
      { model: "glm-4-flash", tools }
    );
    assert.strictEqual(body.tools, tools);
    assert.strictEqual(body.messages[0].content, "sys");
    assert.strictEqual(body.messages[1].content, "你好");
    assert.strictEqual(body.messages[2].tool_calls[0].id, "t1");
    assert.strictEqual(body.messages[3].role, "tool");
    assert.strictEqual(body.messages[3].tool_call_id, "t1");
    const plain = buildChatBody([{ role: "user", text: "hi" }], { model: "m" });
    assert.strictEqual(plain.tools, undefined);
  });

  await test("buildAnthropicBody：tools 转 input_schema 格式", () => {
    const body = buildAnthropicBody([{ role: "user", content: "hi" }], { tools: toolDefinitions(false) });
    assert.strictEqual(body.tools.length, 4);
    assert.ok(body.tools[0].input_schema);
    assert.strictEqual(body.tools[0].function, undefined);
  });

  await test("OpenAI 流式 tool_calls 增量拼接：name/arguments 分片合并 + 文本混合", async () => {
    const { server, port, requests } = await startMockServer(({ res }) => {
      sse(res, [
        openAiChunk({ content: "我来读取文件", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_", arguments: "" } }] }),
        openAiChunk({ tool_calls: [{ index: 0, function: { name: "file", arguments: '{"pa' } }] }),
        openAiChunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }, "tool_calls"),
        "data: [DONE]\n\n"
      ]);
    });
    try {
      const result = await sendCloudChat({ apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, model: "m", provider: "zhipu", tools: toolDefinitions(false) },
        [{ role: "user", content: "读文件" }], {});
      assert.strictEqual(result.text, "我来读取文件");
      assert.strictEqual(result.stopReason, "tool_calls");
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].id, "call-1");
      assert.strictEqual(result.toolCalls[0].name, "read_file");
      assert.strictEqual(result.toolCalls[0].arguments, '{"path":"a.txt"}');
      const sent = JSON.parse(requests[0].body);
      assert.ok(Array.isArray(sent.tools) && sent.tools.length === 4, "请求体应带 tools");
    } finally {
      server.close();
    }
  });

  await test("OpenAI 多工具调用：两个 index 各自拼接", async () => {
    const { server, port } = await startMockServer(({ res }) => {
      sse(res, [
        openAiChunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "read_file", arguments: '{"path"' } }] }),
        openAiChunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "list_directory", arguments: '{"path":"sub"}' } }] }),
        openAiChunk({ tool_calls: [{ index: 0, function: { arguments: ':"x.txt"}' } }] }, "tool_calls"),
        "data: [DONE]\n\n"
      ]);
    });
    try {
      const result = await sendCloudChat({ apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, model: "m", provider: "zhipu", tools: toolDefinitions(false) },
        [{ role: "user", content: "x" }], {});
      assert.strictEqual(result.toolCalls.length, 2);
      assert.strictEqual(result.toolCalls[0].arguments, '{"path":"x.txt"}');
      assert.strictEqual(result.toolCalls[1].name, "list_directory");
    } finally {
      server.close();
    }
  });

  await test("Anthropic 流式 tool_use：content_block_start + input_json_delta + stop_reason=tool_use", async () => {
    const { server, port } = await startMockServer(({ res }) => {
      sse(res, [
        `data: ${JSON.stringify({ type: "message_start" })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "先看目录" } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "list_directory" } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'th":"."}' } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5 } })}\n\n`
      ]);
    });
    try {
      const result = await sendCloudChat({ apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, model: "m", provider: "anthropic", tools: toolDefinitions(false) },
        [{ role: "user", content: "看目录" }], {});
      assert.strictEqual(result.text, "先看目录");
      assert.strictEqual(result.stopReason, "tool_use");
      assert.strictEqual(result.toolCalls.length, 1);
      assert.strictEqual(result.toolCalls[0].id, "toolu_1");
      assert.strictEqual(result.toolCalls[0].name, "list_directory");
      assert.strictEqual(result.toolCalls[0].arguments, '{"path":"."}');
      assert.strictEqual(result.usage.completion_tokens, 5);
    } finally {
      server.close();
    }
  });

  await test("无工具纯文本回归：toolCalls 为空数组、文本完整（兼容旧链路）", async () => {
    const { server, port } = await startMockServer(({ res }) => {
      sse(res, [openAiChunk({ content: "你好！" }), openAiChunk({ content: "有什么可以帮你？" }, "stop"), "data: [DONE]\n\n"]);
    });
    try {
      const result = await sendCloudChat({ apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, model: "m", provider: "zhipu" },
        [{ role: "user", content: "你好" }], {});
      assert.strictEqual(result.text, "你好！有什么可以帮你？");
      assert.deepStrictEqual(result.toolCalls, []);
    } finally {
      server.close();
    }
  });

  await test("端到端工具循环：第一轮 tool_calls → 本机执行 → 第二轮回填 role:tool → 纯文本收尾", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-e2e-"));
    fs.writeFileSync(path.join(workdir, "todo.txt"), "买牛奶", "utf8");
    let round = 0;
    const { server, port, requests } = await startMockServer(({ res, body }) => {
      round += 1;
      if (round === 1) {
        const sent = JSON.parse(body);
        assert.ok(!sent.messages.some((m) => m.role === "tool"), "第一轮不应有工具结果消息");
        sse(res, [openAiChunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"todo.txt"}' } }] }, "tool_calls"), "data: [DONE]\n\n"]);
        return;
      }
      const sent = JSON.parse(body);
      const toolMsg = sent.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg, "第二轮请求体应含 role:tool 结果");
      assert.strictEqual(toolMsg.tool_call_id, "c1");
      assert.ok(toolMsg.content.includes("买牛奶"), "工具结果应回填真实文件内容");
      const assistantMsg = sent.messages.find((m) => m.role === "assistant" && m.tool_calls);
      assert.ok(assistantMsg, "第二轮请求体应含带 tool_calls 的 assistant 消息");
      sse(res, [openAiChunk({ content: "清单里是买牛奶" }, "stop"), "data: [DONE]\n\n"]);
    });
    try {
      // 复刻 main.cjs 工具循环（循环本体在 electron 主进程内，单测以同构小循环验证消息流）
      const tools = toolDefinitions(false);
      let loopMessages = [{ role: "user", content: "读一下 todo.txt" }];
      let finalText = "";
      for (let i = 0; i <= MAX_TOOL_ROUNDS; i += 1) {
        const result = await sendCloudChat({ apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, model: "m", provider: "zhipu", tools }, loopMessages, {});
        if (!result.toolCalls.length) { finalText = result.text; break; }
        loopMessages = [...loopMessages, {
          raw: true, role: "assistant", content: result.text || null,
          extra: { tool_calls: result.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }
        }];
        for (const call of result.toolCalls) {
          const output = await executeToolCall(call, { workdir, allowCommand: false });
          loopMessages.push({ raw: true, role: "tool", content: output, extra: { tool_call_id: call.id } });
        }
      }
      assert.strictEqual(finalText, "清单里是买牛奶");
      assert.strictEqual(round, 2);
    } finally {
      server.close();
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  console.log("\n═══ main.cjs 工具循环接线断言 ═══");

  const mainSource = fs.readFileSync(MAIN_PATH, "utf8");

  await test("main.cjs：require cloud-tools 三件套 + settings 三字段读取", () => {
    assert.ok(mainSource.includes('require("./cloud-tools.cjs")'));
    assert.ok(mainSource.includes("executeToolCall"));
    assert.ok(mainSource.includes("toolDefinitions"));
    assert.ok(mainSource.includes("MAX_TOOL_ROUNDS"));
    assert.ok(mainSource.includes("cloudConfig.toolsEnabled"));
    assert.ok(mainSource.includes("cloudConfig.runCommandEnabled"));
    assert.ok(mainSource.includes("cloudConfig.workingDirectory"));
    assert.ok(mainSource.includes("validatedLocalWorkdir"));
  });

  await test("main.cjs：工具循环结构（≤25 轮 / tool_calls / raw 消息回填 / 上限报错）", () => {
    assert.ok(mainSource.includes("runCloudWithTools"));
    assert.ok(mainSource.includes("for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1)"));
    assert.ok(mainSource.includes("result.toolCalls"));
    assert.ok(mainSource.includes('role: "tool"'));
    assert.ok(mainSource.includes("tool_call_id"));
    assert.ok(mainSource.includes('type: "tool_use"'));
    assert.ok(mainSource.includes("tool_result"));
    assert.ok(mainSource.includes("工具执行轮数已达上限"));
  });

  await test("main.cjs：工具卡事件 + run_command 守卫 + provider 提示 + tools 存档", () => {
    assert.ok(mainSource.includes('type: "tool", tool }, { connectionMode: "cloud" }'));
    assert.ok(mainSource.includes("emitToolCard"));
    assert.ok(mainSource.includes("工具执行失败：${error.message}"));
    assert.ok(mainSource.includes("若当前服务商不支持工具调用，请在设置中关闭「工具执行」后重试"));
    assert.ok(mainSource.includes("collectedTools"));
    assert.ok(mainSource.includes('addAssistantMessage(input.conversationId, streamedText || "（无输出）", "", [], collectedTools, id, "cloud")'));
    assert.ok(mainSource.includes("cloud_tool_success"));
    assert.ok(mainSource.includes("cloud_tool_failed"));
  });

  console.log("\n═══ settings / 渲染层 / 构建 ═══");

  const settingsSource = fs.readFileSync(SETTINGS_PATH, "utf8");

  await test("settings.cjs：三字段三处接线（getSettings / getCloudAiConfig / saveSettings）", () => {
    assert.ok(settingsSource.includes("cloudToolsEnabled: Boolean(raw.cloudToolsEnabled)"));
    assert.ok(settingsSource.includes("cloudRunCommandEnabled: Boolean(raw.cloudRunCommandEnabled)"));
    assert.ok(settingsSource.includes('cloudWorkingDirectory: String(raw.cloudWorkingDirectory || "").trim()'));
    assert.ok(settingsSource.includes("toolsEnabled: Boolean(raw.cloudToolsEnabled)"));
    assert.ok(settingsSource.includes("runCommandEnabled: Boolean(raw.cloudRunCommandEnabled)"));
    assert.ok(settingsSource.includes('workingDirectory: String(raw.cloudWorkingDirectory || "").trim()'));
    assert.ok(settingsSource.includes("cloudToolsEnabled: Boolean(input.cloudToolsEnabled)"));
    assert.ok(settingsSource.includes("cloudRunCommandEnabled: Boolean(input.cloudRunCommandEnabled)"));
  });

  const rendererSource = fs.readFileSync(RENDERER_PATH, "utf8");
  const indexSource = fs.readFileSync(INDEX_PATH, "utf8");

  await test("渲染层：设置页工具执行区块（总开关/工作目录/命令子开关/风险提示）", () => {
    assert.ok(indexSource.includes('id="cloud-tools-settings"'));
    assert.ok(indexSource.includes('id="cloud-tools-enabled"'));
    assert.ok(indexSource.includes('id="cloud-working-directory"'));
    assert.ok(indexSource.includes('id="cloud-run-command-enabled"'));
    assert.ok(indexSource.includes("启用工具执行（AI 可读写文件、抓网页、执行命令）"));
    assert.ok(indexSource.includes("所有文件工具只能访问该目录内的文件（含子目录），目录外的路径会被拒绝"));
    assert.ok(indexSource.includes("允许执行命令（run_command，有安全风险）"));
    assert.ok(indexSource.includes("⚠️ 开启后 AI 可在工作目录内执行任意命令"));
  });

  await test("renderer.js：表单收集 + 回填接线 + 安全声明条件文案（v3.14.1）", () => {
    assert.ok(rendererSource.includes("cloudToolsEnabled: document.querySelector(\"#cloud-tools-enabled\")?.checked || false"));
    assert.ok(rendererSource.includes("cloudRunCommandEnabled: document.querySelector(\"#cloud-run-command-enabled\")?.checked || false"));
    assert.ok(rendererSource.includes('cloudWorkingDirectory: document.querySelector("#cloud-working-directory")?.value || ""'));
    assert.ok(rendererSource.includes("cloudToolsEnabled.checked = Boolean(settings.cloudToolsEnabled)"));
    assert.ok(rendererSource.includes("cloudRunCommandEnabled.checked = Boolean(settings.cloudRunCommandEnabled)"));
    assert.ok(rendererSource.includes('cloudWorkingDirectory.value = settings.cloudWorkingDirectory || ""'));
    // 安全声明随工具执行开关切换：开启后不再宣称「仅传输文本消息」
    assert.ok(rendererSource.includes("云端模式已开启工具执行：AI 可在您配置的工作目录内读写文件（命令执行需单独开启）。API 密钥仅保存在本地。"));
    assert.ok(rendererSource.includes("#cloud-tools-enabled\")?.checked\n      ? \"云端模式已开启工具执行"));
    assert.ok(rendererSource.includes("云端模式仅传输文本消息，不执行任何本地或远程命令。API 密钥仅保存在本地。"), "未开启工具执行时保留原文案");
  });

  await test("cloud-chat.cjs：config.tools 透传到两个请求体构建", () => {
    const cloudChatSource = fs.readFileSync(CLOUD_CHAT_PATH, "utf8");
    assert.ok(cloudChatSource.includes("tools: config.tools"));
    assert.ok(cloudChatSource.includes("toAnthropicTools(options.tools)"));
    assert.ok(cloudChatSource.includes("delta.tool_calls"));
    assert.ok(cloudChatSource.includes("input_json_delta"));
    assert.ok(cloudChatSource.includes("assembleOpenAiToolCalls"));
    assert.ok(cloudChatSource.includes("assembleAnthropicToolCalls"));
    assert.ok(cloudChatSource.includes("stopReason"));
    assert.ok(cloudChatSource.includes('require("./cloud-tools.cjs")'));
  });

  await test("buildMessages 回归：工具循环入口消息构造不变（兼容断言）", () => {
    const messages = buildMessages({ messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "你好", draft: false }, { role: "assistant", text: "草稿", draft: true }] }, "sys");
    assert.deepStrictEqual(messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "你好" }
    ]);
  });

  const obfuscateSource = fs.readFileSync(OBFUSCATE_PATH, "utf8");

  await test("混淆清单登记 cloud-tools.cjs + 版本号 ≥ 3.14.0", () => {
    assert.ok(obfuscateSource.includes('"main/cloud-tools.cjs"'));
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    const versionRank = (major * 10000) + (minor * 100) + patch;
    assert.ok(versionRank >= 31400, `当前版本 ${pkg.version} 应不低于 3.14.0`);
  });

  console.log(`\n═══ 结果：${passed} 通过，${failed} 失败 ═══`);
  if (failures.length) {
    console.log("\n失败清单：");
    for (const item of failures) console.log(`  - ${item}`);
  }
  process.exit(failed ? 1 : 0);
})();