"use strict";
/**
 * v3.15.2 回归测试 — 修复 v3.15.0 误删 elements.messages.append(item)
 * 症状：聊天区空白（消息从不进 DOM）+ .messages:empty 隐藏容器 + token 计数器/上下文进度条上浮到 header 下方（用户看到的「右上角」）
 * 覆盖：addMessage 必须挂载 + 挂载在滚动判断之前 + 其他关键回归（v3.15.0/v3.15.1 断言不回退）+ 版本号。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
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
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

async function runTests() {
  // ⭐ 核心修复：addMessage 必须把消息挂进 DOM
  await test("addMessage 含 elements.messages.append(item)（v3.15.2 核心修复）", () => {
    const fn = rendererSrc.split("function addMessage(kind, text = \"\") {")[1].split("\nfunction isNearBottom")[0];
    assert.ok(fn.includes("elements.messages.append(item);"), "addMessage 未挂载消息（聊天区空白的根因）");
  });
  await test("挂载行在滚动判断之前（先入 DOM 再滚动）", () => {
    const fn = rendererSrc.split("function addMessage(kind, text = \"\") {")[1].split("\nfunction isNearBottom")[0];
    const appendIndex = fn.indexOf("elements.messages.append(item);");
    const scrollIndex = fn.indexOf("isNearBottom()");
    assert.ok(appendIndex >= 0 && scrollIndex > appendIndex, "挂载应在滚动判断之前");
  });
  await test("addMessage 挂载 + 流式重挂载共 ≥2 处 messages.append", () => {
    const count = (rendererSrc.match(/elements\.messages\.append\(/g) || []).length;
    assert.ok(count >= 2, `messages.append 应 ≥2 处（addMessage + 切回流式重挂载），实际 ${count}`);
  });

  // 关键回归：v3.15.0 bug1 后台任务 + 智能滚动不回退
  await test("isNearBottom 仍在（智能滚动）", () => {
    assert.ok(rendererSrc.includes("function isNearBottom()"), "isNearBottom 丢失");
    assert.ok(/scrollHeight - el\.scrollTop - el\.clientHeight < 80/.test(rendererSrc), "阈值不为 80");
  });
  await test("loadConversation/createNewConversation 无 activeId 锁（后台任务切换）", () => {
    const loadFn = rendererSrc.split("async function loadConversation(id) {")[1].split("\nasync function createNewConversation")[0];
    const newFn = rendererSrc.split("async function createNewConversation() {")[1].split("\nfunction setConnection")[0];
    assert.ok(!loadFn.includes("if (activeId) return;"), "loadConversation 锁回退");
    assert.ok(!newFn.includes("if (activeId) return;"), "createNewConversation 锁回退");
  });
  await test("streamingConversationId 归属/清理/条件计量不回退", () => {
    assert.ok(rendererSrc.includes("streamingConversationId = conversationId;"), "归属记录丢失");
    assert.ok((rendererSrc.split('streamingConversationId = "";').length - 1) >= 2, "清理不足");
    assert.ok(/streamingConversationId === conversationId\) addConversationTokens/.test(rendererSrc), "token 合并未条件化");
    assert.ok(rendererSrc.includes("Boolean(activeId && streamingConversationId === conversationId)"), "streaming class 未条件化");
  });
  await test("模式图标 + 联动 + 侧边栏箭头图标不回退", () => {
    assert.ok(rendererSrc.includes('badge.className = "conversation-mode-icon"'), "模式徽标丢失");
    assert.ok(rendererSrc.includes('collapsed ? "→" : "←"'), "箭头图标丢失");
  });
  await test("上下文事件条件化不回退（v3.15.1）", () => {
    const ctxBlock = rendererSrc.split("window.agentChatPro.onContextEvent")[1].split("if (event.type === \"model\")")[0];
    assert.ok(ctxBlock.includes("streamingConversationId !== conversationId"), "context 事件未条件化");
  });

  // 版本号
  await test("版本号 = 3.15.2（语义 ≥3.15.2 跟随）", () => {
    const rank = pkg.version.split(".").reduce((sum, part) => sum * 1000 + Number(part), 0);
    assert.ok(rank >= 31502, `版本 ${pkg.version} 应 ≥ 3.15.2`);
    assert.ok(rendererSrc.includes("v3.15.2"), "渲染层注释未标注 v3.15.2");
  });
}

(async () => {
  await runTests();
  console.log(`\n=== test-v3-15-2.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})();