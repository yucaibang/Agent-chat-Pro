"use strict";
/**
 * v3.15.3 回归测试 — 云端错误提示友好化
 * 背景：用户切 DeepSeek 后账户余额不足（HTTP 402），错误弹窗显示
 *   「连接或 Claude 执行失败：… 云端 AI 返回错误 (402)：{"error":…Insufficient Balance…}」
 *   —— 前缀硬编码 Claude（误导用户以为软件坏了）+ 原始 JSON 直接甩脸（看不懂）。
 * 覆盖：主进程状态码翻译（translateHttpError + provider 中文名）+ 渲染层错误前缀按模式分派 + 版本号。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const CLOUD_CHAT_PATH = path.join(ROOT, "src", "main", "cloud-chat.cjs");
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

const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
const cloudChatSrc = fs.readFileSync(CLOUD_CHAT_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
const cloudChat = require(CLOUD_CHAT_PATH);

async function runTests() {
  // ── 主进程：状态码翻译 ──
  await test("translateHttpError 存在并导出", () => {
    assert.ok(typeof cloudChat.translateHttpError === "function", "translateHttpError 未导出");
  });
  await test("402 → 余额不足人话提示（含 DeepSeek 名）", () => {
    const msg = cloudChat.translateHttpError(402, '{"error":{"message":"Insufficient Balance"}}', "deepseek");
    assert.ok(msg.includes("余额不足"), `未翻译余额不足：${msg}`);
    assert.ok(msg.includes("DeepSeek"), `未带服务商名：${msg}`);
    assert.ok(msg.includes("充值"), `未提示充值：${msg}`);
    assert.ok(msg.includes("Insufficient Balance"), "原始信息丢失（排查线索）");
    assert.ok(!msg.includes("{provider}"), "占位符未替换");
  });
  await test("403/404/500 系列均翻译（未匹配状态码保留原格式）", () => {
    for (const code of [403, 404, 408, 413, 500, 502, 503, 504]) {
      const msg = cloudChat.translateHttpError(code, "raw", "zhipu");
      assert.ok(!/云端 AI 返回错误 \(\d+\)/.test(msg), `${code} 未翻译：${msg}`);
      assert.ok(code === 404 || code === 413 ? true : msg.includes("智谱 AI"), `${code} 未带服务商名：${msg}`);
    }
    const unknown = cloudChat.translateHttpError(418, "teapot", "deepseek");
    assert.ok(/云端 AI 返回错误 \(418\)：teapot/.test(unknown), "未匹配状态码应保留原格式");
  });
  await test("未知 provider 显示兜底名「云端 AI」", () => {
    const msg = cloudChat.translateHttpError(402, "x", "mystery");
    assert.ok(msg.includes("云端 AI"), `兜底名缺失：${msg}`);
  });
  await test("sendCloudChat 非 200 兜底已接入 translateHttpError", () => {
    assert.ok(cloudChatSrc.includes("translateHttpError(res.statusCode, bodyText, config.provider)"), "兜底分支未接入");
    assert.ok(!cloudChatSrc.includes("`云端 AI 返回错误 (${res.statusCode})：${bodyText.slice(0, 200)}`"), "旧模板字符串仍在");
  });
  await test("401/429 专用分支未被破坏", () => {
    assert.ok(cloudChatSrc.includes('res.statusCode === 401'), "401 分支丢失");
    assert.ok(cloudChatSrc.includes('res.statusCode === 429'), "429 分支丢失");
  });

  // ── 渲染层：错误前缀按模式分派 ──
  await test("错误前缀不再硬编码「连接或 Claude 执行失败」", () => {
    assert.ok(!rendererSrc.includes('"连接或 Claude 执行失败：\\n" + error.message'), "硬编码前缀仍在");
  });
  await test("前缀按 streamingConnectionMode 三分支分派", () => {
    assert.ok(rendererSrc.includes('streamingConnectionMode === "cloud" ? "连接或云端 AI 执行失败"'), "cloud 分支缺失");
    assert.ok(rendererSrc.includes('streamingConnectionMode === "local" ? `连接或本机 ${localEngineName} 执行失败`'), "local 分支缺失");
    assert.ok(rendererSrc.includes(': "连接或 NAS Agent 执行失败"'), "ssh 分支缺失");
    assert.ok(rendererSrc.includes("v3.15.3"), "未标注 v3.15.3");
  });
  await test("localEngineName 三引擎映射正确", () => {
    assert.ok(rendererSrc.includes('currentLocalEngine === "atomcode" ? "AtomCode"'), "atomcode 缺失");
    assert.ok(rendererSrc.includes('currentLocalEngine === "custom" ? "自定义命令"'), "custom 缺失");
  });

  // ── 版本号 ──
  await test("版本号 = 3.15.3（语义 ≥3.15.3 跟随）", () => {
    const rank = pkg.version.split(".").reduce((sum, part) => sum * 1000 + Number(part), 0);
    assert.ok(rank >= 31503, `版本 ${pkg.version} 应 ≥ 3.15.3`);
  });
}

(async () => {
  await runTests();
  console.log(`\n=== test-v3-15-3.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})();