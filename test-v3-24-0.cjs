"use strict";
/**
 * v3.24.0 测试 — 模式图标修复 + 思考调节（Codex 风格挡位面板）+ AI 选择题提问 + 思考过程折叠显示
 *   附 v3.24.1 组：装机 bug 修复（SSH/本机挡位改存 settings.thinkingChoices.ssh 偏好层，
 *   执行链 resolveMode 覆盖模式默认挡位，内置模式守卫零接触）+ 常显思考徽标移除 +
 *   挡位浮层对齐参考设计（↻重置 / 挡位名焦点 / chips 渐进色）。
 *   附 v3.24.2 组：挡位条重做（挡序 eco 最前 / 滑条三层渐变蓝绿双系 / chips JS 插值 / 最高挡彩蛋）。
 *   附 v3.24.3 组：SSH/本机挡位浮层顶行补模型型号（模式配置 > 远程生效模型 TTL 缓存渐显）+ thumb 胶囊化。
 * 背景：模式切换后输入栏图标恒护盾（providerSettings 双写互踩）；云端各家思考参数是四字段族
 *   并存（reasoning_effort / thinking.type / enable_thinking / thinking_budget），挡位随模型各异。
 * 覆盖：thinking-levels 纯函数真测（匹配链+挡位集+注入行为）+
 *       cloud-chat 注入打通 + reasoning 流拆分（本地 mock SSE 真测 OpenAI 与 Anthropic 双分支）+
 *       ask_user 注册表真单测（应答/取消/超时/未知）+ 接线断言 +
 *       图标修复回归三处 + vm 假 DOM 全量求值冒烟 + 版本。
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const ROOT = __dirname;
const LEVELS_PATH = path.join(ROOT, "src", "main", "thinking-levels.cjs");
const CLOUD_CHAT_PATH = path.join(ROOT, "src", "main", "cloud-chat.cjs");
const CLOUD_TOOLS_PATH = path.join(ROOT, "src", "main", "cloud-tools.cjs");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
const SETTINGS_PATH = path.join(ROOT, "src", "main", "settings.cjs");
const PRELOAD_PATH = path.join(ROOT, "src", "main", "preload.cjs");
const CONVERSATIONS_PATH = path.join(ROOT, "src", "main", "conversations.cjs");
const PROTOCOL_PATH = path.join(ROOT, "src", "main", "protocol.cjs");
const SSH_PATH = path.join(ROOT, "src", "main", "ssh.cjs");
const LOCAL_PATH = path.join(ROOT, "src", "main", "local.cjs");
const MODE_PARAMS_PATH = path.join(ROOT, "src", "main", "modes", "mode-params.cjs");
const MODE_MANAGER_PATH = path.join(ROOT, "src", "main", "modes", "mode-manager.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const STYLES_PATH = path.join(ROOT, "src", "renderer", "styles.css");
const PACKAGE_PATH = path.join(ROOT, "package.json");

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

const levels = require(LEVELS_PATH);
const cloudChat = require(CLOUD_CHAT_PATH);
const cloudTools = require(CLOUD_TOOLS_PATH);
const mainSrc = fs.readFileSync(MAIN_PATH, "utf8");
const settingsSrc = fs.readFileSync(SETTINGS_PATH, "utf8");
const preloadSrc = fs.readFileSync(PRELOAD_PATH, "utf8");
const conversationsSrc = fs.readFileSync(CONVERSATIONS_PATH, "utf8");
const protocolSrc = fs.readFileSync(PROTOCOL_PATH, "utf8");
const sshSrc = fs.readFileSync(SSH_PATH, "utf8");
const localSrc = fs.readFileSync(LOCAL_PATH, "utf8");
const modeParamsSrc = fs.readFileSync(MODE_PARAMS_PATH, "utf8");
const modeManagerSrc = fs.readFileSync(MODE_MANAGER_PATH, "utf8");
const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
const htmlSrc = fs.readFileSync(HTML_PATH, "utf8");
const stylesSrc = fs.readFileSync(STYLES_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

/* ── A 组：thinking-levels 纯函数真测 ── */

async function runLevelsTests() {
  console.log("── A 组：thinking-levels 挡位表与注入 ──");

  await test("A1 智谱：GLM-4.x 两挡开关族；GLM-5 系七挡 effort 族", () => {
    const glm4 = levels.resolveThinkingProfile("zhipu", "glm-4-flash");
    assert.strictEqual(glm4.family, "zhipu");
    assert.ok(glm4.levels.some((l) => l.id === "off") && glm4.levels.some((l) => l.id === "on"));
    assert.strictEqual(glm4.levels.length, 2);
    const glm5 = levels.resolveThinkingProfile("zhipu", "glm-5.3");
    assert.strictEqual(glm5.levels.length, 7, "GLM-5 系应为七挡");
    assert.ok(glm5.levels.some((l) => l.id === "xhigh") && glm5.levels.some((l) => l.id === "max"));
  });

  await test("A2 DeepSeek：开关 + effort 三档并存（off/low/high/max）", () => {
    const profile = levels.resolveThinkingProfile("deepseek", "deepseek-chat");
    assert.strictEqual(profile.family, "deepseek");
    const ids = profile.levels.map((l) => l.id);
    assert.deepStrictEqual(ids, ["off", "low", "high", "max"]);
  });

  await test("A3 Kimi / 豆包：纯开关族（kimi off/on；doubao auto/off）", () => {
    const kimi = levels.resolveThinkingProfile("moonshot", "kimi-latest");
    assert.deepStrictEqual(kimi.levels.map((l) => l.id), ["off", "on"]);
    const doubao = levels.resolveThinkingProfile("doubao", "doubao-seed-1-6");
    assert.deepStrictEqual(doubao.levels.map((l) => l.id), ["auto", "off"]);
  });

  await test("A4 Gemini：3 系三挡；2.5 系四挡（兼容层 reasoning_effort）", () => {
    const g3 = levels.resolveThinkingProfile("google", "gemini-3-pro");
    assert.deepStrictEqual(g3.levels.map((l) => l.id), ["off", "low", "high"]);
    const g2 = levels.resolveThinkingProfile("google", "gemini-2.5-flash");
    assert.deepStrictEqual(g2.levels.map((l) => l.id), ["off", "low", "medium", "high"]);
  });

  await test("A5 OpenAI：挡位随模型各异（gpt-5.2 附 xhigh；gpt-4o 无 xhigh；o3 四挡）", () => {
    const g52 = levels.resolveThinkingProfile("openai", "gpt-5.2");
    assert.ok(g52.levels.some((l) => l.id === "xhigh"), "新旗舰应有超高挡");
    assert.ok(g52.levels.some((l) => l.id === "minimal"), "应在最低挡");
    const gpt4o = levels.resolveThinkingProfile("openai", "gpt-4o");
    assert.ok(!gpt4o.levels.some((l) => l.id === "xhigh"), "gpt-4o 不应有超高挡");
    const o3 = levels.resolveThinkingProfile("openai", "o3");
    assert.ok(o3.levels.length === 4 && !o3.levels.some((l) => l.id === "xhigh"), "o3 应四挡无超高");
  });

  await test("A6 Groq 仅 gpt-oss 支持挡；硅基流动按模型前缀分族", () => {
    const oss = levels.resolveThinkingProfile("groq", "gpt-oss-120b");
    assert.deepStrictEqual(oss.levels.map((l) => l.id), ["low", "medium", "high"]);
    assert.strictEqual(levels.resolveThinkingProfile("groq", "llama-3.3-70b"), null, "非 oss 应零挡");
    const sQwen35 = levels.resolveThinkingProfile("siliconflow", "Qwen3.5-Plus");
    assert.strictEqual(sQwen35.family, "siliconflow_effort");
    const sQwen3 = levels.resolveThinkingProfile("siliconflow", "Qwen3-32B");
    assert.strictEqual(sQwen3.family, "siliconflow_switch");
    assert.strictEqual(levels.resolveThinkingProfile("siliconflow", "Qwen2.5-72B"), null, "非思考模型零注入");
  });

  await test("A7 阿里百炼 Qwen：3.5+ effort+budget 挡；其余开关挡", () => {
    const q35 = levels.resolveThinkingProfile("qwen", "qwen3.5-plus");
    assert.strictEqual(q35.family, "qwen");
    const high = q35.levels.find((l) => l.id === "high");
    assert.ok(high && high.budget === 32768, "高档应带预算 32768");
    const qSwitch = levels.resolveThinkingProfile("qwen", "qwen-turbo");
    assert.deepStrictEqual(qSwitch.levels.map((l) => l.id), ["off", "on"]);
  });

  await test("A8 Claude / Anthropic：budget 数字挡；未知或 custom 模型 null", () => {
    const claude = levels.resolveThinkingProfile("anthropic", "claude-sonnet-4-5");
    assert.strictEqual(claude.family, "anthropic_budget");
    const byPrefix = levels.resolveThinkingProfile("zhipu", "claude-sonnet-4-0");
    assert.strictEqual(byPrefix.family, "anthropic_budget", "claude 前缀同样命中");
    assert.ok(levels.resolveThinkingProfile("zhipu", "glm-4-flash"), "glm 前缀应命中非空 profile（A1 已细测挡位）");
    assert.strictEqual(levels.resolveThinkingProfile("custom", "whatever"), null);
    assert.strictEqual(levels.resolveThinkingProfile("unknown-p", "some-model"), null);
    assert.strictEqual(levels.resolveThinkingProfile("zhipu", ""), null, "空模型零挡");
  });

  await test("A9 注入：OpenAI effort 族（medium/off→none/dynamic 删参数）", () => {
    const body1 = {};
    assert.strictEqual(levels.applyOpenAiThinking(body1, { provider: "openai", model: "gpt-5.2", choice: "medium" }), true);
    assert.strictEqual(body1.reasoning_effort, "medium");
    const body2 = { reasoning_effort: "medium" };
    assert.strictEqual(levels.applyOpenAiThinking(body2, { provider: "openai", model: "gpt-5.2", choice: "off" }), false, "OpenAI 族无 off 挡（最低=minimal），off 应零注入");
    assert.strictEqual(body2.reasoning_effort, "medium", "无效挡不得改写请求体");
    const body2b = {};
    assert.strictEqual(levels.applyOpenAiThinking(body2b, { provider: "openai", model: "gpt-5.2", choice: "minimal" }), true);
    assert.strictEqual(body2b.reasoning_effort, "minimal", "最低挡应生效");
    const body3 = {};
    levels.applyOpenAiThinking(body3, { provider: "openai", model: "gpt-5.2", choice: "dynamic" });
    assert.ok(!("reasoning_effort" in body3), "dynamic 应删参数交服务商默认");
    const body4 = {};
    assert.strictEqual(levels.applyOpenAiThinking(body4, { provider: "openai", model: "gpt-5.2", choice: "zzz" }), false, "无效挡零注入");
    const gemOff = {};
    assert.strictEqual(levels.applyOpenAiThinking(gemOff, { provider: "google", model: "gemini-2.5-flash", choice: "off" }), true);
    assert.strictEqual(gemOff.reasoning_effort, "none", "Gemini 兼容层的关挡应落 none");
  });

  await test("A10 注入：DeepSeek 开关+effort / 智谱 GLM-4 纯开关不夹带 effort", () => {
    const ds = {};
    levels.applyOpenAiThinking(ds, { provider: "deepseek", model: "deepseek-chat", choice: "low" });
    assert.strictEqual(ds.thinking.type, "enabled");
    assert.strictEqual(ds.reasoning_effort, "low");
    const dsOff = {};
    levels.applyOpenAiThinking(dsOff, { provider: "deepseek", model: "deepseek-chat", choice: "off" });
    assert.strictEqual(dsOff.thinking.type, "disabled");
    const glm4 = {};
    levels.applyOpenAiThinking(glm4, { provider: "zhipu", model: "glm-4-flash", choice: "on" });
    assert.strictEqual(glm4.thinking.type, "enabled");
    assert.ok(!("reasoning_effort" in glm4), "GLM-4.x 纯开关不带 effort");
  });

  await test("A11 注入：硅基流动开关族 enable_thinking / 百炼 budget 挡", () => {
    const sf = {};
    levels.applyOpenAiThinking(sf, { provider: "siliconflow", model: "Qwen3-32B", choice: "off" });
    assert.strictEqual(sf.enable_thinking, false);
    const qwen = {};
    levels.applyOpenAiThinking(qwen, { provider: "qwen", model: "qwen3.5-plus", choice: "high" });
    assert.strictEqual(qwen.enable_thinking, true);
    assert.strictEqual(qwen.thinking_budget, 32768);
    const qwenOff = {};
    levels.applyOpenAiThinking(qwenOff, { provider: "qwen", model: "qwen3.5-plus", choice: "off" });
    assert.strictEqual(qwenOff.enable_thinking, false);
    assert.ok(!("thinking_budget" in qwenOff), "off 应删 budget");
  });

  await test("A12 注入：Anthropic budget（正常/钳制 headroom/太小放弃/off 不注入）", () => {
    const ok = {};
    assert.strictEqual(levels.applyAnthropicThinking(ok, { provider: "anthropic", model: "claude-sonnet-4-5", choice: "medium", maxTokens: 16384 }), true);
    assert.strictEqual(ok.thinking.budget_tokens, 12288);
    const clamped = {};
    levels.applyAnthropicThinking(clamped, { provider: "anthropic", model: "claude-sonnet-4-5", choice: "high", maxTokens: 8192 });
    assert.strictEqual(clamped.thinking.budget_tokens, 7168, "24576 预算应钳进 max_tokens 余量 7168");
    assert.ok(clamped.thinking.budget_tokens < 8192, "budget 必须小于 max_tokens（官方硬约束）");
    const tooSmall = {};
    assert.strictEqual(levels.applyAnthropicThinking(tooSmall, { provider: "anthropic", model: "claude-sonnet-4-5", choice: "low", maxTokens: 1600 }), false, "max_tokens 太小应放弃注入");
    assert.ok(!tooSmall.thinking, "放弃时不得写入 thinking");
    const off = {};
    assert.strictEqual(levels.applyAnthropicThinking(off, { provider: "anthropic", model: "claude-sonnet-4-5", choice: "off", maxTokens: 8192 }), false);
    assert.ok(!off.thinking, "off 不注入 thinking");
  });

  await test("A13 normalizeThinkingChoices 防呆（非对象归空/字符串截断/嵌套净化）", () => {
    assert.deepStrictEqual(levels.normalizeThinkingChoices(null), {});
    assert.deepStrictEqual(levels.normalizeThinkingChoices("x"), {});
    assert.deepStrictEqual(levels.normalizeThinkingChoices([1]), {});
    const cleaned = levels.normalizeThinkingChoices({ cloud: { "zhipu/glm-4-flash": "high" }, junk: 42, nest: { a: "ok", b: 7 } });
    assert.deepStrictEqual(cleaned.cloud["zhipu/glm-4-flash"], "high");
    assert.deepStrictEqual(cleaned.nest, { a: "ok" });
    assert.ok(!("junk" in cleaned));
  });

  await test("A14 levelLabel 与 SSH_LEVELS 在册", () => {
    assert.strictEqual(levels.levelLabel("low"), "低");
    assert.strictEqual(levels.levelLabel({ id: "medium", label: "中" }), "中");
    assert.ok(levels.SSH_LEVELS.length === 5 && levels.SSH_LEVELS[0].id === "eco" && levels.SSH_LEVELS[1].id === "off", "v3.24.2：5 挡且 eco 最前（承接 W1）");
    assert.strictEqual(levels.ANTHROPIC_BUDGET.high, 24576);
  });
}

/* ── B 组：cloud-chat 注入打通 + reasoning 流拆分（本地 mock SSE 真测） ── */

function startMockSSE(handler) {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const bodies = [];
        let parsed = {};
        try { parsed = JSON.parse(raw || "{}"); } catch {}
        Promise.resolve().then(() => handler({ body: parsed, headers: req.headers, bodies })).then((lines) => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(lines.join("\n\n"));
          res.end("\n");
        }).catch((error) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: error.message } }));
        });
      });
    });
    server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port }));
  });
}

/** SSE 事件数组 → wire 格式（data: 行）；OpenAI 风格 */
function sseOpenAi(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}`).concat(["data: [DONE]"]);
}
/** Anthropic 风格：event + data 双行 */
function sseAnthropic(events) {
  return events
    .map((e) => {
      const payload = `event: ${e.type}\ndata: ${JSON.stringify(e)}`;
      return payload.startsWith("event: message_start") ? payload : payload;
    })
    .concat(["event: message_stop\ndata: {\"type\":\"message_stop\"}"]);
}

async function runCloudStreamTests() {
  console.log("── B 组：云端注入 + reasoning 流拆分（mock SSE） ──");

  await test("B1 buildChatBody 带 options.thinking 时打通注入（真函数链）", () => {
    const messages = [{ role: "user", content: "hi" }];
    const body = cloudChat.buildChatBody(messages, {
      model: "gpt-5.2",
      maxTokens: 8192,
      thinking: { provider: "openai", model: "gpt-5.2", choice: "high" }
    });
    assert.strictEqual(body.reasoning_effort, "high", "思考挡位应写入请求体");
  });

  await test("B2 sendCloudChat OpenAI 流：请求带挡位注入 + reasoning_content/reasoning 双字段拆分", async () => {
    const bodies = [];
    const { server, port } = await startMockSSE(({ body }) => {
      bodies.push(body);
      return sseOpenAi([
        { choices: [{ delta: { reasoning_content: "先想第一步。" } }] },
        { choices: [{ delta: { reasoning: "第二步推理。" } }] },
        { choices: [{ delta: { content: "最终答案。" } }] }
      ]);
    });
    const collected = { text: "", reasoning: "" };
    const result = await cloudChat.sendCloudChat(
      { provider: "openai", apiKey: "sk-test", baseURL: `http://127.0.0.1:${port}/v1`, model: "gpt-5.2", maxTokens: 8192, thinking: { provider: "openai", model: "gpt-5.2", choice: "medium" } },
      [{ role: "user", content: "hi" }],
      {
        onDelta: (text) => { collected.text += text; },
        onReasoning: (text) => { collected.reasoning += text; }
      }
    );
    server.close();
    assert.strictEqual(bodies[0].reasoning_effort, "medium", "请求体应带思考挡位");
    assert.strictEqual(collected.text, "最终答案。", "正文流式应照常");
    assert.strictEqual(collected.reasoning, "先想第一步。第二步推理。", "思考流应双字段拆分");
    assert.strictEqual(result.reasoning, collected.reasoning, "resolve 应带 reasoning");
    assert.strictEqual(result.text, "最终答案。");
  });

  await test("B3 sendCloudChat Anthropic 流：thinking_delta 拆分 + budget 注入钳制", async () => {
    const bodies = [];
    const { server, port } = await startMockSSE(({ body }) => {
      bodies.push(body);
      return sseAnthropic([
        { type: "message_start", message: { id: "msg_1" } },
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "思考内容。" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "回复正文。" } },
        { type: "message_stop" }
      ]);
    });
    const collected = { text: "", reasoning: "" };
    const result = await cloudChat.sendCloudChat(
      { provider: "anthropic", apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, model: "claude-sonnet-4-5", maxTokens: 8192, thinking: { provider: "anthropic", model: "claude-sonnet-4-5", choice: "medium" } },
      [{ role: "user", content: "hi" }],
      {
        onDelta: (text) => { collected.text += text; },
        onReasoning: (text) => { collected.reasoning += text; }
      }
    );
    server.close();
    assert.strictEqual(bodies[0].thinking.budget_tokens, 7168, "12288 应钳进 8192-1024 余量");
    assert.strictEqual(bodies[0].thinking.type, "enabled");
    assert.strictEqual(collected.reasoning, "思考内容。", "thinking_delta 应拆出思考流");
    assert.strictEqual(result.reasoning, "思考内容。");
    assert.strictEqual(result.text, "回复正文。");
  });

  await test("B4 无思考字段的老流式照常（不产出 reasoning）", async () => {
    const { server, port } = await startMockSSE(() => sseOpenAi([
      { choices: [{ delta: { content: "旧式正文。" } }] }
    ]));
    const collected = { text: "", reasoning: "" };
    const result = await cloudChat.sendCloudChat(
      { provider: "openai", apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1`, model: "gpt-5.2", maxTokens: 8192 },
      [{ role: "user", content: "hi" }],
      { onDelta: (text) => { collected.text += text; }, onReasoning: (text) => { collected.reasoning += text; } }
    );
    server.close();
    assert.strictEqual(collected.text, "旧式正文。");
    assert.strictEqual(collected.reasoning, "", "无思考字段时 reasoning 应为空");
    assert.strictEqual(result.reasoning, "");
  });
}

/* ── C 组：ask_user 注册表真单测 + 拦截接线 ── */

async function runAskUserTests() {
  console.log("── C 组：ask_user 注册表与工具循环拦截 ──");

  await test("C1 wait→answer：应答回填并清除悬等", async () => {
    const registry = cloudTools.createAskUserRegistry(60_000);
    const pending = registry.wait("req-1", "call-1", "选哪个？", ["甲", "乙"]);
    assert.ok(registry.hasPending("call-1"));
    const answered = registry.answer("call-1", "乙");
    assert.strictEqual(answered.ok, true);
    assert.strictEqual(await pending, "乙");
    assert.ok(!registry.hasPending("call-1"));
  });

  await test("C2 未知 callId answer 被拒（不 resolve 悬等）", async () => {
    const registry = cloudTools.createAskUserRegistry(60_000);
    const outcome = registry.answer("no-such", "x");
    assert.strictEqual(outcome.ok, false);
    assert.ok(/不存在或已应答/.test(outcome.error));
  });

  await test("C3 cancelAll 按 requestId 打断悬等（停止请求）", async () => {
    const registry = cloudTools.createAskUserRegistry(60_000);
    const pending = registry.wait("req-A", "call-A", "q", ["a"]);
    registry.wait("req-B", "call-B", "q", ["a"]); // 别的请求不该被打断
    const cancelled = registry.cancelAll("req-A");
    assert.strictEqual(cancelled, 1);
    assert.strictEqual(await pending, cloudTools.ASK_USER_STOPPED);
    assert.ok(registry.hasPending("call-B"));
  });

  await test("C4 超时哨兵（快速 timer 真跑）", async () => {
    const registry = cloudTools.createAskUserRegistry(50);
    const pending = registry.wait("req-T", "call-T", "q", ["a"]);
    const answer = await pending;
    assert.strictEqual(answer, cloudTools.ASK_USER_TIMEOUT);
  });

  await test("C5 ask_user 工具定义在册（2~4 选项约束）", () => {
    const defs = cloudTools.toolDefinitions(false);
    const ask = defs.find((t) => t.function.name === "ask_user");
    assert.ok(ask, "ask_user 应在工具清单首位");
    assert.strictEqual(ask.function.parameters.properties.options.minItems, 2);
    assert.strictEqual(ask.function.parameters.properties.options.maxItems, 4);
    assert.ok(ask.function.parameters.required.includes("question") && ask.function.parameters.required.includes("options"));
  });

  await test("C6 ASK_USER_HINT 约订文本在册并拼进云端 systemPrompt", () => {
    assert.ok(cloudTools.ASK_USER_HINT.includes("ask_user"), "hint 应点名工具");
    assert.ok(cloudTools.ASK_USER_HINT.includes("2~4"), "应约束选项数");
    assert.ok(mainSrc.includes('+ ASK_USER_HINT'), "systemPrompt 应拼接 hint");
  });

  await test("C7 main.cjs 拦截接线：chat:event 发卡 + 注册表悬等 + 超时/停止/选择三语义", () => {
    assert.ok(mainSrc.includes('call.name === "ask_user"'), "工具循环应拦截 ask_user");
    assert.ok(mainSrc.includes('type: "ask-user"'), "应发 ask-user 事件");
    assert.ok(mainSrc.includes("askUserRegistry.wait("), "应悬等应答");
    assert.ok(mainSrc.includes("askUserRegistry.answer"), "IPC 应答回填");
    assert.ok(mainSrc.includes("用户长时间未应答"), "超时回填文案");
    assert.ok(mainSrc.includes("用户已停止当前任务"), "停止打断文案");
    assert.ok(mainSrc.includes("askUserRegistry.cancelAll("), "取消应打断全部悬等");
    assert.ok(mainSrc.includes("ask-user:answer"), "IPC 通道在册");
  });
}

/* ── D 组：主进程/渲染层/资产接线断言 ── */

async function runWiringTests() {
  console.log("── D 组：接线断言 ──");

  await test("D1 main.cjs：thinking-levels 引入 + thinking 上下文注入请求链", () => {
    assert.ok(mainSrc.includes("require(\"./thinking-levels.cjs\")"), "模块引入");
    assert.ok(mainSrc.includes("resolveThinkingProfile"), "thinking:profile 通道用");
    assert.ok(mainSrc.includes("thinking: thinkingContext"), "config 应带 thinking");
    assert.ok(mainSrc.includes("settings.thinkingChoices || {}", "挡位记忆读取"));
  });

  await test("D2 main.cjs：thinking:profile IPC + onReasoning 事件", () => {
    assert.ok(mainSrc.includes('"thinking:profile"'), "IPC 通道");
    assert.ok(mainSrc.includes('type: "thinking"'), "思考事件通道");
    assert.ok(mainSrc.includes("streamedReasoning"), "云端思考累计器");
  });

  await test("D3 settings：thinkingChoices 白名单读写", () => {
    assert.ok(settingsSrc.includes("normalizeThinkingChoices"), "归一函数引入");
    assert.ok(settingsSrc.includes("thinkingChoices: normalizeThinkingChoices(raw.thinkingChoices)"), "读取面");
    assert.ok(settingsSrc.includes("thinkingChoices: normalizeThinkingChoices(input.thinkingChoices !== undefined ? input.thinkingChoices : previous.thinkingChoices)"), "保存面不丢字段");
  });

  await test("D4 preload：getThinkingProfile / answerAskUser 两桥在册", () => {
    assert.ok(preloadSrc.includes('ipcRenderer.invoke("thinking:profile"'), "挡位表桥");
    assert.ok(preloadSrc.includes('ipcRenderer.invoke("ask-user:answer"'), "提问应答桥");
  });

  await test("D5 conversations：第 13 参 thinking 落库并截断", () => {
    assert.ok(conversationsSrc.includes("thinking = \"\""), "签名尾参在册");
    assert.ok(conversationsSrc.includes("completed.thinking = String(thinking).slice(0, 200000)"), "落库截断上限");
  });

  await test("D6 protocol：thinkingFromEvent 双格式解析并导出", () => {
    assert.ok(protocolSrc.includes("function thinkingFromEvent"), "解析函数");
    assert.ok(protocolSrc.includes("thinking_delta"), "增量思考分支");
    assert.ok(/thinkingFromEvent/.test(protocolSrc.match(/module\.exports = \{[\s\S]*?\}/)?.[0] || ""), "应导出");
  });

  await test("D7 ssh/local：onThinking 透传接线", () => {
    assert.ok(sshSrc.includes("thinkingFromEvent"), "SSH 引入解析");
    assert.ok(sshSrc.includes("callbacks.onThinking?.(thinking)"), "SSH 透传");
    assert.ok(localSrc.includes("thinkingFromEvent"), "本机引入解析");
    assert.ok(localSrc.includes("callbacks.onThinking?.(thinking)"), "本机透传");
  });

  await test("D8 cloud-chat：SSE thinking_delta + reasoning 字段 + sendCloudChat thinking 传参", () => {
    const cloudSrc = fs.readFileSync(CLOUD_CHAT_PATH, "utf8");
    assert.ok(cloudSrc.includes('applyOpenAiThinking'), "OpenAI 注入调用");
    assert.ok(cloudSrc.includes("applyAnthropicThinking"), "Anthropic 注入调用");
    assert.ok(cloudSrc.includes("thinking_delta"), "SSE 拆分分支");
    assert.ok(cloudSrc.includes("reasoning: fullReasoning"), "resolve 带 reasoning");
    assert.ok(cloudSrc.includes("thinking: config.thinking"), "thinking 配置传参");
    assert.ok(cloudSrc.includes("onReasoning"), "思考流回调");
  });

  await test("D9 renderer：面板/事件分支/历史重放/特化卡在册（v3.24.1 徽标移除）", () => {
    assert.ok(!rendererSrc.includes("function refreshThinkingBadge"), "v3.24.1 常显思考徽标应已移除");
    assert.ok(rendererSrc.includes("THINK_SSH_LEVELS"), "SSH 挡位表");
    assert.ok(rendererSrc.includes("getThinkingProfile"), "挡位表桥调用");
    assert.ok(rendererSrc.includes('event.type === "thinking"'), "思考事件分支");
    assert.ok(rendererSrc.includes('event.type === "ask-user"'), "提问事件分支");
    assert.ok(rendererSrc.includes("function ensureThinkingBlock"), "折叠块构建");
    assert.ok(rendererSrc.includes("function appendThinkingDelta"), "流式思考追加");
    assert.ok(rendererSrc.includes("function renderStaticThinking"), "历史重放思考");
    assert.ok(rendererSrc.includes("renderStaticThinking(item, message.thinking)"), "重放接线");
    assert.ok(rendererSrc.includes("function finalizeThinkingSummary"), "终态收敛");
    assert.ok(rendererSrc.includes("function buildAskUserCard"), "选择题卡构建");
    assert.ok(rendererSrc.includes("input.questions") && rendererSrc.includes("input.options"), "SSH 载荷双形态容错（questions/options）");
    assert.ok(rendererSrc.includes("renderSshAskUserCard"), "SSH 特化卡");
    assert.ok(rendererSrc.includes("answerAskUser"), "云端应答桥调用");
    assert.ok(rendererSrc.includes("think-slider"), "滑条元素引用");
    assert.ok(rendererSrc.includes("think-modes"), "模式 chips 容器");
  });

  await test("D10 index.html：think-panel 骨架六元素（v3.24.1 + 重置钮/顶部行）", () => {
    for (const id of ["think-panel", "think-model", "think-slider", "think-ticks", "think-levels", "think-meta", "think-modes"]) {
      assert.ok(htmlSrc.includes(`id="${id}"`), `缺 #${id}`);
    }
    assert.ok(htmlSrc.includes('id="think-reset"'), "v3.24.1 缺 #think-reset 重置钮");
    assert.ok(htmlSrc.includes("think-model-row"), "v3.24.1 缺顶部行容器");
  });

  await test("D11 styles.css：面板/折叠块/选择题卡三类样式在册", () => {
    assert.ok(stylesSrc.includes(".think-panel"), "面板样式");
    assert.ok(stylesSrc.includes(".think-slider"), "滑条样式");
    assert.ok(stylesSrc.includes(".thinking-block"), "折叠块样式");
    assert.ok(stylesSrc.includes(".thinking-body"), "思考正文样式");
    assert.ok(stylesSrc.includes(".ask-card"), "选择题卡样式");
    assert.ok(stylesSrc.includes(".ask-option"), "选项按钮样式");
    assert.ok(stylesSrc.includes('[data-theme="light"] .thinking-block'), "亮色主题适配");
  });

  await test("D12 cloud-tools：ask_user 注册表 + hint 导出面在册", () => {
    for (const key of ["ASK_USER_HINT", "createAskUserRegistry", "ASK_USER_TIMEOUT", "ASK_USER_STOPPED"]) {
      assert.ok(key in cloudTools, `导出缺 ${key}`);
    }
  });
}

/* ── E 组：模式图标修复回归（三处收口） ── */

async function runIconFixTests() {
  console.log("── E 组：图标修复回归 ──");

  await test("E1 populateSettings 不再覆盖图标（setToolModeAppearance 调用已删）", () => {
    const body = rendererSrc.slice(rendererSrc.indexOf("function populateSettings"), rendererSrc.indexOf("const DEFAULT_SSH_PROFILE_NAMES"));
    assert.ok(!/setToolModeAppearance\(/.test(body), "populateSettings 里不应再有全局开关覆盖调用（注释命中不算）");
  });

  await test("E2 updateModeDisplay 独占图标渲染（v3.24.1 徽标移除后 icon/title 回归，双写修复保留）", () => {
    const body = rendererSrc.slice(rendererSrc.indexOf("function updateModeDisplay"), rendererSrc.indexOf('document.querySelector("#mode-trigger").addEventListener'));
    assert.ok(body.includes("composerModeTrigger.textContent = mode.icon"), "图标渲染权应回归 updateModeDisplay（v3.24.1）");
    assert.ok(body.includes("composerModeTrigger.title ="), "模式名/描述 title 应回归");
    assert.ok(!body.includes("refreshThinkingBadge()"), "徽标刷新调用应已移除");
    assert.ok(body.includes("composer-mode-trigger ${mode.skipPermissions ? \"automatic\" : \"safe\"}"), "按钮类名仍应随模式");
  });

  await test("E3 常显思考徽标整体移除（v3.24.1 用户拍板：🧠 徽标难看不常显，挡位只进面板）", () => {
    assert.ok(!rendererSrc.includes("function refreshThinkingBadge"), "徽标函数应删除");
    // v3.24.7 思考元信息标题（用户拍板豆包同款）复用 🧠 字面：限定仅思考块模板可用，常显徽标场景仍禁止
    const brainCount = rendererSrc.split("🧠").length - 1;
    assert.ok(brainCount <= 2 && brainCount >= 1, `🧠 仅限思考元信息标题（1~2 处模板），实际 ${brainCount} 处`);
    assert.ok(!/refreshThinkingBadge\(/.test(rendererSrc), "徽标调用点应全部清除");
    const body = rendererSrc.slice(rendererSrc.indexOf("function setToolModeAppearance"), rendererSrc.indexOf("async function changeToolMode"));
    assert.ok(!body.includes("elements.composerModeTrigger"), "setToolModeAppearance 仍不碰输入栏按钮（双写修复语义保留，注释提及不算）");
  });

  await test("E4 setToolModeAppearance 自身保留（模式编辑面板仍用）", () => {
    assert.ok(rendererSrc.includes("function setToolModeAppearance"), "函数应保留");
  });
}

/* ── V 组：v3.24.1 挡位偏好层修复 + 徽标移除 + 浮层参考设计 ── */

async function runV3241Tests() {
  console.log("── V 组：v3.24.1 挡位偏好层 + 徽标移除 + 浮层参考设计 ──");

  await test("V1 mode-params.applyThinkingChoice 纯函数真测（偏好覆盖/无偏好保留/非法值忽略/空模式安全）", () => {
    const fnBody = modeParamsSrc.slice(modeParamsSrc.indexOf("const THINKING_LEVEL_VALUES"), modeParamsSrc.indexOf("/** 读取 settings.thinkingChoices"));
    const applyThinkingChoice = new Function(`${fnBody}\nreturn applyThinkingChoice;`)();
    const mode = { id: "automated", thinkingLevel: "none", skipPermissions: false };
    const overridden = applyThinkingChoice(mode, "automated", { ssh: { automated: "high" } });
    assert.strictEqual(overridden.thinkingLevel, "high", "偏好应覆盖模式默认挡位");
    assert.notStrictEqual(overridden, mode, "应返回副本不改入参");
    assert.strictEqual(applyThinkingChoice(mode, "automated", { ssh: {} }).thinkingLevel, "none", "无偏好保留模式默认挡位");
    assert.strictEqual(applyThinkingChoice(mode, "automated", { ssh: { automated: "ultra" } }).thinkingLevel, "none", "非法偏好值忽略");
    assert.strictEqual(applyThinkingChoice(null, "x", { ssh: { x: "high" } }), null, "空模式安全透传");
    assert.strictEqual(applyThinkingChoice({ id: "regular", thinkingLevel: "medium" }, "regular", { ssh: { regular: "low" } }).thinkingLevel, "low", "内置模式挡位同样走偏好（守卫零接触）");
  });

  await test("V2 mode-params.resolveMode 挡位偏好接线（SSH/Bridge/本机三链汇聚点 + 内置常量副本保护）", () => {
    assert.ok(modeParamsSrc.includes("return applyThinkingChoice(mode, modeId, readThinkingChoices())"), "resolveMode 尾部挂偏好覆盖");
    assert.ok(modeParamsSrc.includes("{ ...(getMode(modeId) || fallback) }"), "resolveMode 副本保护（不污染 BUILTIN_MODES 常量）");
    assert.ok(modeParamsSrc.includes('require("../settings.cjs").getSettings()'), "延迟读 settings（依赖兜底，不污染纯函数测试）");
    assert.ok(modeParamsSrc.includes("catch { return {}; }"), "settings 不可读时零偏好兜底");
    assert.ok(/applyThinkingChoice[,\s}]/.test(modeParamsSrc.slice(modeParamsSrc.indexOf("module.exports"))), "module.exports 导出 applyThinkingChoice");
  });

  await test("V3 renderer：SSH/本机挡位改存偏好层（thinkingChoices.ssh[工作模式]），不再写模式定义", () => {
    assert.ok(rendererSrc.includes("ssh: sshChoices }"), "applyChoice SSH/本机分支落 thinkingChoices.ssh");
    assert.ok(rendererSrc.includes('[modeKey]: THINK_CLAUDE_LEVEL_IDS[choiceId] || "none"'), "按工作模式记忆挡位（off→none 同域落盘）");
    assert.ok(!rendererSrc.includes("await window.agentChatPro.updateMode(mode.isBuiltIn ? mode.id : mode.id"), "旧路径（updateMode 传模式定义+三元死代码）应清除");
    assert.ok(rendererSrc.includes('THINK_CLAUDE_LEVEL_REVERSE = { eco: "eco", none: "off"'), "落库值域→UI 挡位 id 反向映射在册（v3.24.2 值域含 eco）");
    assert.ok(rendererSrc.includes('const levelValue = ["eco", "high", "medium", "low", "none"].includes(sshChoice) ? sshChoice : modeLevel;'), "面板读取：偏好高于模式默认挡位（v3.24.2 值域含 eco）");
  });

  await test("V4 renderer：↻ 重置（清偏好回默认挡位）+ 挡位名视觉焦点接线", () => {
    assert.ok(rendererSrc.includes("const resetChoice = async () => {"), "重置处理器");
    assert.ok(rendererSrc.includes("delete ssh[currentModeId || \"regular\"];") && rendererSrc.includes("delete cloud[`${provider}/${model}`];"), "双模式重置清除偏好键");
    assert.ok(rendererSrc.includes('resetBtn.hidden = !hasMemory'), "有偏好记忆时才显示重置钮");
    assert.ok(rendererSrc.includes('meta.innerHTML = "";'), "v3.25.1 简洁化（用户令）：「当前挡位」行删除——挡位名由下方 active 文案+顶行英文标承担，容器保留；重置钮逻辑保留");
  });

  await test("V5 index.html/styles.css：顶部行+重置钮+渐进色+焦点样式在册", () => {
    assert.ok(htmlSrc.includes('id="think-reset"') && htmlSrc.includes("think-model-row"), "骨架：顶部行+重置钮");
    assert.ok(stylesSrc.includes(".think-model-row") && stylesSrc.includes(".think-reset:hover"), "重置钮样式");
    assert.ok(stylesSrc.includes(".think-level.active") && !stylesSrc.includes(".think-meta-level"), "挡位聚焦样式在册；v3.25.1 简洁化：.think-meta-level 样式随「当前挡位」行一同清除（用户令）");
    assert.ok(!stylesSrc.includes(".think-level:nth-child"), "nth-child 硬编码渐进色应清除（chips 改渲染层上色）");
    assert.ok(!stylesSrc.includes(".composer-mode-trigger.unsupported {"), "徽标态死样式应清除（清理注释提及不算）");
  });

  await test("V6 mode-manager 内置守卫原封不动（修复走偏好层，不松动模式定义防线）", () => {
    assert.ok(modeManagerSrc.includes('throw new Error("内置模式不可修改。")'), "内置模式守卫保留");
    assert.ok(modeManagerSrc.includes('throw new Error("内置模式不可删除。")'), "内置模式删除守卫保留");
    assert.ok(!JSON.stringify(modeManagerSrc).includes("builtinOverrides"), "不应引入内置 override 落盘机制（方案 A′ 守卫零接触）");
  });
}

/* ── W 组：v3.24.2 挡位条重做（eco 挡序 / 三层渐变 / 彩蛋） ── */

async function runV3242Tests() {
  console.log("── W 组：v3.24.2 挡位条重做 ──");

  await test("W1 挡序 eco 最前 + 文案用户拍板（SSH_LEVELS/THINK_SSH_LEVELS/值域三处同链）", () => {
    // 用户拍板原话锚：eco→默认→轻度→中等→最高
    assert.deepStrictEqual(levels.SSH_LEVELS.map((l) => l.id), ["eco", "off", "low", "medium", "high"], "SSH_LEVELS 挡序 eco 最前");
    assert.deepStrictEqual(levels.SSH_LEVELS.map((l) => l.label), ["ECO", "默认", "轻度", "中等", "最高"], "挡位文案：ECO/默认/轻度/中等/最高");
    assert.deepStrictEqual(rendererSrc.slice(rendererSrc.indexOf("const THINK_SSH_LEVELS"), rendererSrc.indexOf("THINK_CLAUDE_LEVEL_IDS")).includes('{ id: "eco", label: "ECO"'), true, "渲染层挡位表 eco 最前");
    assert.ok(rendererSrc.includes('const THINK_SSH_LEVELS = [\n  { id: "eco"'), "渲染层挡位序列首项 eco");
    assert.ok(modeParamsSrc.includes('const THINKING_LEVEL_VALUES = ["eco", "none", "low", "medium", "high"]'), "mode-params 值域含 eco");
    assert.ok(modeManagerSrc.includes('"eco", "none", "low", "medium", "high"'), "mode-manager validateThinkingLevel 值域含 eco");
  });

  await test("W2 THINKING_MAP.eco 零 flag + eco 注入安全（云/SSH 双链）", () => {
    const defaultsSrc = fs.readFileSync(path.join(ROOT, "src", "main", "modes", "mode-defaults.cjs"), "utf8");
    assert.ok(defaultsSrc.includes('eco: ""'), "THINKING_MAP.eco = 空串（CLI 与默认挡一致，不传 --thinking-level）");
    // 云端注入器真测：eco 不在任何家族挡位表 → hasChoice=false → 零注入
    const body = { model: "glm-5", messages: [] };
    assert.strictEqual(levels.applyOpenAiThinking(body, { provider: "zhipu", model: "glm-5", choice: "eco" }), false, "GLM-5 eco 挡零注入");
    assert.ok(!("thinking" in body) && !("reasoning_effort" in body), "请求体不残留思考参数");
    const body2 = { model: "deepseek-chat", messages: [] };
    assert.strictEqual(levels.applyOpenAiThinking(body2, { provider: "deepseek", model: "deepseek-chat", choice: "eco" }), false, "DeepSeek eco 挡零注入");
    // Anthropic 原生链：eco 非预算挡 → 关
    assert.strictEqual(levels.applyAnthropicThinking({ max_tokens: 8192 }, { provider: "anthropic", model: "claude-sonnet-4", choice: "eco" }), false, "Anthropic eco 挡零注入");
  });

  await test("W3 云端 eco 显示层前置 + 空偏好对位默认挡（挡位表不动，注入天然安全）", () => {
    assert.ok(rendererSrc.includes('const levels = [{ id: "eco", label: "ECO", hint: "零思考注入，最省 token（服务商默认挡位）" }, ...profile.levels];'), "云端 levels 前置拼装 eco（profile 原表零改动）");
    assert.ok(rendererSrc.includes('const defaultIdx = Math.max(0, levels.findIndex((l) => l.id === "off"));'), "空偏好（服务商默认）对位 off 挡，不落 eco");
    assert.ok(rendererSrc.includes("slider.value = String(choice ? Math.max(0, levels.findIndex((l) => l.id === choice)) : defaultIdx);"), "有偏好按记忆对位");
  });

  await test("W4 挡位条主题接线：renderSliderTheme/chips 上色/双分支挂接（蓝绿双系 + 滑动动画）", () => {
    assert.ok(rendererSrc.includes("const renderSliderTheme = (slider, levels) => {"), "轨道主题 helper");
    assert.ok(rendererSrc.includes('slider.classList.add("eco")') && rendererSrc.includes('slider.classList.add("blue")'), "eco/blue 双主题类切换");
    assert.ok(rendererSrc.includes('wrap.style.setProperty("--fill"'), "--fill 填充变量（蓝系按滑距；v3.25.2 层序修复：变量落 wrap 供 ::before 继承，eco/blue 类仍挂 slider）");
    assert.ok(rendererSrc.includes("const THINK_CHIP_RAMP = [[203, 213, 225], [157, 180, 247], [56, 120, 240], [30, 58, 138]];"), "chips 蓝系四阶渐变表（v3.25.1 配色：纯蓝 #3878f0 族）");
    assert.ok(rendererSrc.includes('label.style.color = level.id === "eco" ? "rgb(22, 101, 52)" : chipColor(index, levels.length);'), "文案渐进色沿用（v3.25.1 renderChips→renderTrackMarks，eco=深绿语义不变）");
    assert.ok(rendererSrc.includes("slider.oninput = () => { renderSliderTheme(slider, levels); syncMarkActive(ticksRow, levelsRow, Number(slider.value));"), "oninput 即时换色+刻度 active 同步（v3.25.1；顶行英文标拖挡即时重拼追加）");
    assert.ok(rendererSrc.includes("slider.onchange = () => { applyChoice(levels[Number(slider.value)].id); maybeShowThinkEgg(levels, Number(slider.value)); };"), "onchange 落盘+彩蛋（云/SSH 同款）");
    assert.strictEqual(rendererSrc.split("slider.onchange = () => { applyChoice(levels[Number(slider.value)].id); maybeShowThinkEgg(levels, Number(slider.value)); };").length - 1, 2, "云端与 SSH 分支都挂接");
  });

  await test("W5 最高挡彩蛋（用户拍板三选一文案 + 2s 淡出 + 通用判定）", () => {
    assert.ok(rendererSrc.includes('const THINK_EGG_LINES = ["更高的工作质量", "燃烧你的钱包吧！", "更快的消耗额度"];'), "三选一文案原文（用户原话）");
    assert.ok(rendererSrc.includes('if (active && index === levels.length - 1 && active.id !== "eco") showThinkEgg();'), "判定：最后一挡且非 eco（云端任意挡位表通用）");
    assert.ok(rendererSrc.includes('egg.textContent = THINK_EGG_LINES[Math.floor(Math.random() * THINK_EGG_LINES.length)];'), "随机三选一");
    assert.ok(rendererSrc.includes("}, 2000);") && rendererSrc.includes('setTimeout(() => { egg.hidden = true; }, 260);'), "2s 后淡出（260ms transition 收尾）");
    assert.ok(htmlSrc.includes('<div class="think-egg" id="think-egg" hidden></div>'), "index.html 彩蛋行在册");
    assert.ok(stylesSrc.includes(".think-egg.show { opacity: 1; transform: translateY(0); }"), "淡入淡出样式");
  });

  await test("W6 三层渐变轨道 CSS（用户拍板：蓝系白→浅蓝→蓝→深蓝 / eco 绿系深绿→白带颗粒 / 粗条+动画）", () => {
    assert.ok(stylesSrc.includes("linear-gradient(90deg, #f8fafc 0%, #9db4f7 34%, #3878f0 67%, #1e3a8a 100%)"), "①蓝系填充层（白→浅蓝→纯蓝→深蓝；v3.25.1 配色换 Codex 图提取纯蓝 #3878f0）");
    assert.ok(stylesSrc.includes("radial-gradient(rgba(134, 239, 172, .5) 1px, transparent 1.4px)"), "②eco 浅绿颗粒层（repeat 平铺）");
    assert.ok(stylesSrc.includes("linear-gradient(90deg, #14532d 0%, #16a34a 32%, #86efac 62%, #f0fdf4 100%)"), "③eco 整轨渐变层（深绿→绿→浅绿→白）");
    assert.ok(stylesSrc.includes("background-size: var(--fill, 0%) 100%, var(--eco, 0%) 100%, var(--eco, 0%) 100%;"), "三变量控长显隐");
    assert.ok(stylesSrc.includes("transition: background-size .22s ease;"), "滑动过渡动画（Chromium 原生）");
    assert.ok(!stylesSrc.includes(".think-slider.eco { --eco: 100%; }"), "旧 --eco class 规则清除（v3.25.2 层序修复：--eco 由 renderSliderTheme 显式设 wrap，::before 消费）");
    assert.ok(stylesSrc.includes("height: 16px; border-radius: 8px;"), "粗条轨道（v3.25.3 加粗 16px+端部 8px 全半圆收口）");
    assert.ok(stylesSrc.includes(".think-slider::-webkit-slider-thumb:active { transform: scale(1.18); }"), "拖动放大手感");
    assert.ok(stylesSrc.includes(".composer-mode-popup") && stylesSrc.includes("width: 460px;"), "面板加宽（220→300→350→460 定宽，v3.25.5 硬拉）");
  });

  await test("W7 渲染层 SSH 挡位值域含 eco（面板读取 + 反向映射 + levelValue）", () => {
    assert.ok(rendererSrc.includes('const THINK_CLAUDE_LEVEL_REVERSE = { eco: "eco", none: "off", low: "low", medium: "medium", high: "high" };'), "落库值域→UI id 反向映射含 eco");
    assert.ok(rendererSrc.includes('const THINK_CLAUDE_LEVEL_IDS = { eco: "eco", off: "none", low: "low", medium: "medium", high: "high" };'), "UI id→落库值域含 eco（off→none 同域）");
    assert.ok(rendererSrc.includes('const modeLevel = (mode && ["eco", "high", "low", "none"].includes(mode.thinkingLevel)) ? mode.thinkingLevel : "medium";'), "模式默认挡读取（medium 缺省即回 medium，语义等价）");
  });
}

/* ── X 组：v3.24.3 顶行模型型号 + thumb 胶囊化 ── */

async function runV3243Tests() {
  console.log("── X 组：v3.24.3 顶行模型型号 + thumb 胶囊化 ──");

  await test("X1 SSH/本机顶行补模型型号（模式配置优先 > 远程生效模型 TTL 渐显 + stamp 防竞态）", () => {
    assert.ok(rendererSrc.includes("let thinkModelCache = null;") && rendererSrc.includes("let thinkModelStamp = 0;"), "模块级缓存与重建计数");
    assert.ok(rendererSrc.includes("const THINK_MODEL_TTL = 5 * 60 * 1000;"), "5 分钟 TTL（防面板开合反复建 SSH 连接）");
    assert.ok(rendererSrc.includes('return raw.replace(/\\[[^\\]]*\\]$/g, "").trim();'), "modeConfig.model 同款 sanitize（去 [1m] 等后缀）");
    assert.ok(rendererSrc.includes("const status = await window.agentChatPro.getModelStatus();"), "远程/本机生效模型探测（main.cjs 按连接方式分派）");
    assert.ok(rendererSrc.includes("const stamp = ++thinkModelStamp;"), "面板重建计数入口（buildSlider 顶部）");
    assert.ok(rendererSrc.includes("if (stamp !== thinkModelStamp || !remoteModel) return;"), "过期回包/空型号不写顶行（防竞态）");
    assert.ok(rendererSrc.includes("const stampTop = (m, lvl) => composeThinkTop(currentConnectionMode, m, modeKey, lvl ?? levelId);"), "v3.25.1（用户令）：顶行改（连接模式）•（模型 工作模式英标 思考挡英标）——stampTop 闭包重拼（可参 lvl 供拖挡即时重拼）");
    assert.ok(rendererSrc.includes("modelEl.textContent = stampTop(modeModel);"), "模式显式配置直接显示");
    assert.ok(rendererSrc.includes("modelEl.textContent = stampTop(remoteModel);"), "远程型号后台渐显追加");
  });

  await test("X2 thumb 随 v3.25.3 终定正圆（用户令 2026-10-27「我想让滑动条是圆的」+批注图白色圆圈实锤：胶囊 26×14 终结）", () => {
    assert.ok(stylesSrc.includes("width: 16px; height: 16px; border-radius: 50%;"), "thumb 正圆 16px（直径=轨道高 16px，用户令「半径相同」）");
    assert.ok(stylesSrc.includes("margin-top: 0;"), "16px 圆与 16px 轨道同径天然居中（无 -1px 偏移）");
    assert.ok(!stylesSrc.includes("border-radius: 9999px;"), "胶囊 9999px 组合清除（.think-tick 4px 不连坐）");
    assert.ok(stylesSrc.includes(".think-slider::-webkit-slider-thumb:active { transform: scale(1.18); }"), "拖动放大手感保留");
    assert.ok(stylesSrc.includes(".think-slider.blue::-webkit-slider-thumb { border-color: #3878f0; }") && stylesSrc.includes(".think-slider.eco::-webkit-slider-thumb { border-color: #16a34a; }"), "蓝绿双系描边保留（蓝系=提取纯蓝 #3878f0）");
  });
}

/* ── F 组：vm 假 DOM 冒烟（renderer 改动必过） ── */

async function runVmSmokeTests() {
  console.log("── F 组：vm 假 DOM 全量求值冒烟 ──");

  const captureProps = {};
  const registeredHandlers = {};
  for (const key of ["onChatEvent"]) {
    captureProps[key] = (handler) => { registeredHandlers[key] = handler; return undefined; };
  }
  function makeStyle() {
    const store = {};
    return new Proxy(store, {
      get(_t, prop) {
        if (prop === "setProperty") return (key, val) => { store[key] = val; };
        if (prop === "removeProperty") return (key) => { delete store[key]; };
        if (prop === "getPropertyValue") return (key) => store[key];
        return store[prop];
      },
      set() { return true; }
    });
  }
  /** 子树选择器匹配（.class / #id / tag 三形态；本元素自身不参与匹配） */
  function elementMatches(el, sel) {
    const raw = String(sel || "").trim();
    if (!raw || !el || typeof el !== "object") return false;
    if (raw.startsWith(".")) return String(el.className || "").split(/\s+/).includes(raw.slice(1));
    if (raw.startsWith("#")) return String(el.id || "") === raw.slice(1);
    return String(el.tagName || "").toUpperCase() === raw.toUpperCase();
  }
  function querySubtree(root, sel, collectAll) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (elementMatches(child, sel)) { found.push(child); if (!collectAll) return; }
        walk(child);
      }
    };
    walk(root);
    return collectAll ? found : (found[0] || null);
  }
  function makeFakeEl() {
    const classes = new Set();
    const children = [];
    const listeners = {};
    return {
      value: "", checked: false, type: "", placeholder: "", textContent: "", innerHTML: "",
      hidden: false, disabled: false, tagName: "DIV", draggable: false, id: "",
      // classList 与 className 同源（classes 集合派生，双向一致）
      get className() { return [...classes].join(" "); },
      set className(v) { classes.clear(); for (const part of String(v || "").split(/\s+/)) if (part) classes.add(part); },
      title: "", role: "", tabIndex: 0,
      scrollTop: 0, scrollHeight: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0,
      files: [], children, style: makeStyle(), dataset: {},
      elements: { namedItem: () => getFake("#form-named-item") },
      form: { elements: { namedItem: () => getFake("#named-form-item") } },
      classList: {
        toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name);; return on; },
        add(...names) { for (const n of names) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); }
      },
      // v3.24.0：click 类监听器要真实触发（选择题卡点选定格走 addEventListener("click")）
      addEventListener(type, fn) { const key = type && String(type); if (key) { listeners[key] = listeners[key] || []; listeners[key].push(fn); } }, removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false, toggleAttribute: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement: () => null, hasChildNodes() { return children.length > 0; },
      append(...nodes) { for (const node of nodes) children.push(node); },
      prepend(...nodes) { for (const node of nodes) children.unshift(node); },
      appendChild(node) { children.push(node); return node; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      closest() { return null; }, contains() { return false; },
      // before() 需把兄弟插到本元素之前——此处简化为追加（位置断言只看存在性）
      before(...nodes) { for (const node of nodes) children.push(node); },
      querySelector(sel) { return querySubtree({ children }, sel, false); },
      querySelectorAll(sel) { return querySubtree({ children }, sel, true); },
      focus() {}, blur() {}, select() {}, remove() {},
      click() { for (const fn of listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} }); },
      scrollIntoView() {}, scrollBy() {}, scrollTo() {}, setSelectionRange() {},
      showModal() {}, close() {}, show() {}, showPicker() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
  }
  const cache = new Map();
  const getFake = (sel) => {
    const key = String(sel);
    if (!cache.has(key)) cache.set(key, makeFakeEl());
    return cache.get(key);
  };
  const documentStub = {
    body: getFake("body"), head: getFake("head"), documentElement: getFake("documentElement"),
    activeElement: null,
    querySelector: (sel) => getFake(sel), querySelectorAll: () => [],
    getElementById: (id) => getFake(`#${id}`),
    createElement: (tag) => { const el = makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    addEventListener() {}, removeEventListener() {}
  };
  const gatesStub = { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true };
  const methodMocks = {
    listConversations: async () => [],
    listModes: async () => [],
    getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub }),
    getThinkingProfile: async ({ provider, model }) => ({
      profile: levels.resolveThinkingProfile(provider, model)
    })
  };
  const defaultResult = () => ({
    edition: "main", productName: "Agent Chat Pro", gates: gatesStub,
    conversations: [], items: [], messages: [], tools: [], files: [], entries: [],
    results: [], valid: true, invalidKeys: [], ok: true, path: "",
    lastConnectionMode: "", version: "3.24.7",
    host: "", port: 22, username: "", wakeName: "", clientLabel: "",
    workingDirectory: "", dataDirectory: "", skipPermissions: false,
    showSignalLights: true, connectionMode: "cloud", localEngine: "claude",
    hasPassword: true, hasCloudAiConfig: true,
    cloudAiProvider: "zhipu", cloudAiBaseUrl: "", cloudAiModel: "glm-4-flash",
    thinkingChoices: { cloud: { "zhipu/glm-4-flash": "high" } },
    theme: "dark"
  });
  const windowStub = {
    window: null, self: null,
    agentChatPro: new Proxy(captureProps, {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop in _t) return _t[prop];
        if (prop in methodMocks) return methodMocks[prop];
        return async () => defaultResult();
      }
    }),
    addEventListener() {}, removeEventListener() {},
    location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
    matchMedia: () => ({ matches: false, media: "", addEventListener() {}, addListener() {}, removeListener() {} }),
    open: () => null, close() {},
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "smoke" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    innerWidth: 1200, innerHeight: 800
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    Math, Date, JSON, Object, Array, String, Number, Boolean, BigInt,
    Map, Set, WeakMap, WeakSet, Promise, Symbol, Error, TypeError, RangeError,
    SyntaxError, ReferenceError, RegExp, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, structuredClone,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    queueMicrotask, performance, Buffer,
    process: { env: {}, platform: "win32", versions: process.versions },
    window: windowStub, document: documentStub,
    navigator: windowStub.navigator, localStorage: windowStub.localStorage,
    location: windowStub.location, matchMedia: windowStub.matchMedia,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    getComputedStyle: windowStub.getComputedStyle,
    Event: function FakeEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
    CustomEvent: function FakeCustomEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
    FormData: function FormData() {},
    alert() {}, confirm: () => false, prompt: () => null,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}
  };
  sandbox.globalThis = sandbox;

  const vm = require("vm");
  const rendererCode = fs.readFileSync(RENDERER_PATH, "utf8");
  const source = rendererCode + "\n;globalThis.__acpSmoke = { ensureThinkingBlock, appendThinkingDelta, renderStaticThinking, finalizeThinkingSummary, buildAskUserCard, markAskCardAnswered, isAskUserTool, renderTool, addMessage };";
  await test("F1 renderer.js vm 假 DOM 全量求值零异常（v3.24.0 新代码含在内）", () => {
    let error = null;
    try { vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: "renderer.js" }); }
    catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke");
  });

  await test("F2 思考折叠块：details + summary + body 结构", () => {
    const item = getFake("#f2-item");
    const block = sandbox.__acpSmoke.ensureThinkingBlock(item);
    assert.strictEqual(block.className, "thinking-block");
    assert.strictEqual(block.tagName, "DETAILS");
    assert.strictEqual(block.children[0].textContent, "💭 思考过程");
    assert.ok(block.children[1].className === "thinking-body");
  });

  await test("F3 流式思考追加：两段累积 + 计数标题刷新", () => {
    const item = getFake("#f3-item");
    sandbox.__acpSmoke.appendThinkingDelta(item, "第一步推演。");
    sandbox.__acpSmoke.appendThinkingDelta(item, "续上，第二步。");
    const block = item.querySelector(".thinking-block");
    const bodyText = block.querySelector(".thinking-body").textContent;
    assert.strictEqual(bodyText, "第一步推演。续上，第二步。", `实际正文：${JSON.stringify(bodyText)}（len ${bodyText.length}）`);
    assert.ok(block.querySelector("summary").textContent.includes("13 字"), `应含字数：${block.querySelector("summary").textContent}`);
  });

  await test("F4 空思考增量不建块（无文本零副作用）", () => {
    const item = getFake("#f4-item");
    sandbox.__acpSmoke.appendThinkingDelta(item, "");
    assert.ok(!item.querySelector(".thinking-block"), "空文本不应建块");
  });

  await test("F5 静态思考渲染：历史重放定稿标题", () => {
    const item = getFake("#f5-item");
    sandbox.__acpSmoke.renderStaticThinking(item, "落库的思考文本");
    const block = item.querySelector(".thinking-block");
    assert.ok(block, "有思考时应有折叠块");
    assert.ok(block.querySelector("summary").textContent.includes("7 字"), "定稿标题应含字数且无进行中字样");
    assert.ok(!block.querySelector("summary").textContent.includes("进行中"));
    const empty = getFake("#f5-empty");
    sandbox.__acpSmoke.renderStaticThinking(empty, "");
    assert.ok(!empty.querySelector(".thinking-block"), "空思考不渲染");
  });

  await test("F6 选择题卡：选项结构 + 禁用 + 点击定格", async () => {
    let pickedText = "";
    const card = sandbox.__acpSmoke.buildAskUserCard({ question: "选哪个方案？", options: ["方案甲", "方案乙"] }, false, (cardEl, button, optionText) => {
      pickedText = optionText;
      sandbox.__acpSmoke.markAskCardAnswered(cardEl, button, optionText);
    });
    const buttons = card.children.find((c) => c.className === "ask-options");
    assert.ok(buttons.children.length === 2, "两选项");
    assert.ok(buttons.children[0].disabled === false, "未禁用");
    buttons.children[1].click();
    assert.strictEqual(pickedText, "方案乙");
    assert.ok(buttons.children[1].className.includes("picked"), "选中高亮");
    assert.ok(buttons.children[0].className.includes("dim"), "其余压暗");
    assert.ok(card.querySelector(".ask-picked-note").textContent.includes("方案乙"), "已选择注记");
    const historyCard = sandbox.__acpSmoke.buildAskUserCard({ question: "q", options: ["a", "b"] }, true, () => {});
    assert.ok([...historyCard.children.find((c) => c.className === "ask-options").children].every((b) => b.disabled === true), "历史定型禁用");
  });

  await test("F7 isAskUserTool 识别与 renderTool 短路（不进通用工具牌列表）", () => {
    assert.ok(sandbox.__acpSmoke.isAskUserTool({ name: "AskUserQuestion" }));
    assert.ok(!sandbox.__acpSmoke.isAskUserTool({ name: "Read" }));
    const item = getFake("#f7-item");
    sandbox.__acpSmoke.renderTool(item, { id: "call-1", name: "AskUserQuestion", input: { question: "q?", options: ["甲", "乙"] } });
    assert.ok(item.children.some((c) => c.className === "ask-card"), "应直出选择题卡");
    assert.ok(!item.children.some((c) => c.className === "tool-list"), "不应进通用工具牌");
  });

  await test("F8 终态收敛：进行中字样消失", () => {
    const item = getFake("#f8-item");
    sandbox.__acpSmoke.appendThinkingDelta(item, "终态前的思考。");
    sandbox.__acpSmoke.finalizeThinkingSummary(item);
    const block = item.querySelector(".thinking-block");
    assert.ok(!block.querySelector("summary").textContent.includes("进行中"), "进行中应收敛");
    assert.ok(block.querySelector("summary").textContent.includes("7 字"));
  });
}

(async () => {
  await runLevelsTests();
  await runCloudStreamTests();
  await runAskUserTests();
  await runWiringTests();
  await runIconFixTests();
  await runV3241Tests();
  await runV3242Tests();
  await runV3243Tests();
  await runVmSmokeTests();
  await test("G1 package.json 版本 ≥ 3.24.7（放宽锚点：后续版本继续在册）", () => {
    const [maj, min, patch] = String(pkg.version).split(".").map(Number);
    const [rmaj, rmin, rpatch] = "3.24.7".split(".").map(Number);
    assert.ok(maj > rmaj || (maj === rmaj && (min > rmin || (min === rmin && patch >= rpatch))), `应 ≥ 3.24.7，实际 ${pkg.version}`);
  });
  console.log(`\n=== test-v3-24-0.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})().catch((error) => { console.error("测试运行失败：", error); process.exitCode = 1; });