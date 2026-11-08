"use strict";
/**
 * v3.43.0 守门测试 — 云端服务商替换：Groq → Grok（xAI）
 *
 * 背景：用户确认第 8 家云服务商的本意一直是 Grok（xAI），但仓库自 v3.4.0 起接入的
 * 实际是另一家真实服务商 Groq（groq.com：baseUrl/模型清单/注册链接/语音转写全套）。
 * v3.43.0 将该服务商位整体替换为 Grok（xAI），仍保持十家：
 *   - id: groq → xai；显示名 Groq → Grok（xAI）；baseUrl → https://api.x.ai/v1/
 *   - 模型清单换 grok 系（pullModels 现拉现用）；注册链接 → console.x.ai
 *   - 思考挡位：provider 或 grok 前缀命中 → reasoning_effort 两挡（官方实锤 low/high）；
 *     xai 下非 grok 模型零注入
 *   - 语音转录：xAI 无公开 ASR 端点，转录支持从四家降为三家（智谱/硅基流动/OpenAI）
 *   - README 现役文案同步；v3.4.0 历史概览行保留 Groq 字样（历史事实不改写）
 * ⚠️ 附带后果（已向用户确认）：已填的 Groq 密钥作废需重填 xAI key；
 *    settings 存量 provider:"groq" 走 getCloudAiConfig 的 custom 回退自然淘汰。
 *
 * 覆盖：
 *   A. thinking-levels.cjs 行为真跑（xai 挡位族/零注入防线/unknown provider 前缀链）
 *   B. voice-transcribe.cjs 行为真跑（xai 无转录引导 + 三家未破坏）
 *   C. 源码断言（xai 条目五件套 / groq 全仓清零 / 下拉双 option / 三层 base 表同源）
 *   D. README 现役文案 + 历史行保护 + 版本三自洽
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const levels = require(path.join(ROOT, "src/main/thinking-levels.cjs"));
const voice = require(path.join(ROOT, "src/main/voice-transcribe.cjs"));
const cloudModels = require(path.join(ROOT, "src/main/cloud-models.cjs"));

const rendererSrc = read("src/renderer/renderer.js");
const indexSrc = read("src/renderer/index.html");
const cloudChatSrc = read("src/main/cloud-chat.cjs");
const settingsSrc = read("src/main/settings.cjs");
const workgroupSrc = read("src/main/workgroup-chat.cjs");
const cloudModelsSrc = read("src/main/cloud-models.cjs");
const voiceSrc = read("src/main/voice-transcribe.cjs");
const thinkingSrc = read("src/main/thinking-levels.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

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

async function runUnitTests() {
  // ════════════════ A. thinking-levels 行为真跑 ════════════════
  await test("A1. resolveThinkingProfile(xai, grok-*) → family xai，低/高两挡（官方实锤 low/high）", () => {
    const p = levels.resolveThinkingProfile("xai", "grok-4-fast");
    assert.ok(p, "grok-4-fast 应命中挡位");
    assert.strictEqual(p.family, "xai", "family 应为 xai");
    assert.deepStrictEqual(p.levels.map((l) => l.id), ["low", "high"], "挡位应为 low/high 两挡");
  });

  await test("A2. xai provider 下非 grok 模型 → null（零注入防线，绝不给不支持模型乱传参数）", () => {
    assert.strictEqual(levels.resolveThinkingProfile("xai", "llama-3.3-70b"), null, "非 grok 模型应零挡");
    assert.strictEqual(levels.resolveThinkingProfile("xai", ""), null, "空模型名应零挡");
  });

  await test("A3. applyOpenAiThinking：xai+grok 选挡注入 reasoning_effort；xai 无 off 挡（非挡 choice 零注入）", () => {
    const b1 = {};
    assert.strictEqual(levels.applyOpenAiThinking(b1, { provider: "xai", model: "grok-4", choice: "high" }), true);
    assert.strictEqual(b1.reasoning_effort, "high", "high 挡应注入 reasoning_effort=high");
    const b2 = {};
    assert.strictEqual(levels.applyOpenAiThinking(b2, { provider: "xai", model: "grok-4", choice: "off" }), false,
      "off 不在 xai 挡位集（low/high）内 → 零注入");
    assert.deepStrictEqual(b2, {}, "零注入不得改写请求体");
    const b3 = {};
    assert.strictEqual(levels.applyOpenAiThinking(b3, { provider: "xai", model: "grok-4", choice: "" }), false,
      "未选挡 = 零注入");
    assert.deepStrictEqual(b3, {}, "零注入不得改写请求体");
  });

  await test("A4. provider unknown + grok-* 模型前缀链同样命中（与 /claude/ 前缀同款语义）", () => {
    const p = levels.resolveThinkingProfile("unknown", "grok-4-fast");
    assert.ok(p && p.family === "xai" && p.levels.length === 2, "前缀链应命中 xai 两挡");
  });

  // ════════════════ B. voice-transcribe 行为真跑 ════════════════
  await test("B1. asrInfoFor(xai) → unsupported，引导文案列三家（智谱/硅基流动/OpenAI）", () => {
    const info = voice.asrInfoFor("xai");
    assert.strictEqual(info.supported, false, "xAI 无公开 ASR 端点");
    assert.ok(info.reason.includes("智谱 / 硅基流动 / OpenAI"), "引导文案应列三家");
    assert.ok(!info.reason.includes("Groq"), "文案不得再出现 Groq");
  });

  await test("B2. 原三家转录能力未破坏（zhipu/siliconflow/openai supported + model 在册）", () => {
    for (const [prov, model] of [["zhipu", "glm-asr-2512"], ["siliconflow", "FunAudioLLM/SenseVoiceSmall"], ["openai", "whisper-1"]]) {
      const info = voice.asrInfoFor(prov);
      assert.ok(info.supported && info.model === model, `${prov} 转录应保持 ${model}`);
    }
  });

  await test("B3. transcribeAudio(xai) → unsupported 分支（不发现请求）", async () => {
    let called = 0;
    const out = await voice.transcribeAudio(
      { provider: "xai", apiKey: "sk", baseURL: "https://api.x.ai/v1" },
      { audioBase64: "aGVsbG8=", seconds: 3 },
      async () => { called += 1; return { ok: true, text: () => "{}" }; }
    );
    assert.ok(out.unsupported && !out.ok, "应走 unsupported 分支");
    assert.strictEqual(called, 0, "不得发起任何 HTTP 请求");
  });

  // ════════════════ C. 源码断言 ════════════════
  console.log("── C 组：源码断言 ──");

  await test("C1. CLOUD_PROVIDERS.xai 条目五件套（名/址/pullModels/grok 清单/注册链）", () => {
    assert.ok(rendererSrc.includes('xai: {\n    name: "Grok（xAI）"'), "xai 条目应在册");
    assert.ok(rendererSrc.includes('baseUrl: "https://api.x.ai/v1/"'), "baseUrl 应指向 api.x.ai");
    assert.ok(rendererSrc.includes('registerUrl: "https://console.x.ai/"'), "注册链接应指向 console.x.ai");
    assert.ok(rendererSrc.includes('value: "grok-4"') && rendererSrc.includes('value: "grok-4-fast"')
      && rendererSrc.includes('value: "grok-code-fast-1"') && rendererSrc.includes('value: "grok-3"')
      && rendererSrc.includes('value: "grok-3-mini"'), "兜底 grok 模型清单应在列");
  });

  await test("C2. groq 全仓清零：8 个触点文件（大小写不敏感）均无 groq 残留", () => {
    for (const [name, src] of Object.entries({
      "renderer.js": rendererSrc, "index.html": indexSrc, "cloud-chat.cjs": cloudChatSrc,
      "settings.cjs": settingsSrc, "workgroup-chat.cjs": workgroupSrc, "cloud-models.cjs": cloudModelsSrc,
      "voice-transcribe.cjs": voiceSrc, "thinking-levels.cjs": thinkingSrc
    })) {
      assert.ok(!/groq/i.test(src), `${name} 仍有 groq 残留`);
    }
  });

  await test("C3. index.html 双下拉均已换 xai option（各恰出现一次）", () => {
    assert.strictEqual((indexSrc.match(/<option value="xai">Grok<\/option>/g) || []).length, 2,
      "Grok option 应恰在 2 处下拉（连接设置 + 建群对话框）");
    assert.ok(!indexSrc.includes('value="groq"'), "不得残留 groq option");
  });

  await test("C4. settings providerConfigs.xai：baseURL api.x.ai/v1 + defaultModel grok-4-fast", () => {
    assert.ok(settingsSrc.includes('xai: { baseURL: "https://api.x.ai/v1", defaultModel: "grok-4-fast" }'),
      "xai 默认配置应在册");
  });

  await test("C5. 三层 base 表同源：workgroup-chat providerBaseURL 含 xai 行", () => {
    assert.ok(workgroupSrc.includes('xai: "https://api.x.ai/v1"'), "群聊成员 base 表应含 xai");
  });

  await test("C6. PULL_ENDPOINTS.xai：/v1/models + bearer（真模块断言）", () => {
    assert.strictEqual(cloudModels.PULL_ENDPOINTS.xai.url, "https://api.x.ai/v1/models");
    assert.strictEqual(cloudModels.PULL_ENDPOINTS.xai.auth, "bearer", "xAI 走 OpenAI 兼容 Bearer");
    assert.ok(!cloudModels.PULL_ENDPOINTS.groq, "groq 拉取端点不得残留");
  });

  await test("C7. cloud-chat PROVIDER_LABELS.xai = Grok + GROUP_PROVIDERS 成员行在册", () => {
    assert.ok(cloudChatSrc.includes('xai: "Grok",'), "HTTP 错误提示的 provider 名映射应换 Grok");
    assert.ok(rendererSrc.includes('["xai", "Grok"]'), "建群对话框服务商行应换 Grok");
  });

  // ════════════════ D. README + 版本 ════════════════
  console.log("── D 组：README 与版本 ──");

  await test("D1. README 现役文案两处 Grok（xAI）在册；Groq 仅存 v3.4.0 历史概览行（历史不改写）", () => {
    assert.ok(readme.includes("Anthropic · Grok（xAI） · 硅基流动"), "核心特性服务商列应含 Grok（xAI）");
    assert.ok(readme.includes("Anthropic、Grok（xAI）、硅基流动"), "FAQ 内置十家列应含 Grok（xAI）");
    const groqLines = readme.split("\n").filter((line) => /Groq/.test(line));
    assert.strictEqual(groqLines.length, 1, `README 应仅剩历史行出现 Groq（现 ${groqLines.length} 行）`);
    assert.ok(groqLines[0].includes("v3.4.0"), "残留 Groq 的应是 v3.4.0 历史概览行");
  });

  await test("D2. package.json 3.43.0 + README badge 自洽（D 组宽松惯例）", () => {
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    assert.ok(major > 3 || (major === 3 && minor > 42) || (major === 3 && minor === 43 && patch >= 0),
      `version=${pkg.version}`);
    assert.ok(readme.includes(`version-${pkg.version}-blue`), "README version badge 应回填 package.json 版本");
  });
}

(async () => {
  await runUnitTests();
  console.log("");
  console.log(`━━━ test-v3-43-0 共 ${passed + failed} 项 · 通过 ${passed} · 失败 ${failed} ━━━`);
  if (failures.length) {
    console.log("失败明细：");
    for (const item of failures) console.log(`  - ${item}`);
  }
  process.exit(failed ? 1 : 0);
})();
