"use strict";
/**
 * v3.15.6 回归测试 — 切对话后输入框仍是上一个对话的「预发送状态」
 * 用户反馈（Test-PC）：上一个对话正工作中切换对话时，输入框还是同样的预发送状态。
 * 根因（v3.15.0 后台任务切换的遗留，四个连带）：
 *   ① 输入框草稿全局共享（prompt.value 切对话既不清空也不隔离）
 *   ② attachments 在 loadConversation 被粗暴清空（文本留着附件丢，状态错乱）
 *   ③ 忙碌样态不归属（composer busy / 停止按钮是全局的，切到无任务对话仍显示工作中样态）
 *   ④ 停止行为串对话（busy 时点发送按钮 = stopActiveMessage() → 在 B 里点发送误停 A 的任务；Esc 同样误停）
 * 修复：草稿按对话隔离（composerDrafts Map）+ 忙碌样态/发送按钮/Esc 语义按任务归属分派
 *   + 任务属于其他对话时发送给出明确提示（不再静默 return，也不误停）。
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

function extractBetween(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `源码片段提取失败：${start}`);
  return src.slice(i, j);
}

const loadFn = extractBetween(rendererSrc, "async function loadConversation(id) {", "\nasync function createNewConversation");
const loadFnEnd = loadFn.slice(0, 2000); // loadConversation 前段：草稿保存与恢复逻辑

async function runTests() {
  // ⭐ 核心：草稿按对话隔离
  await test("composerDrafts Map 已声明（v3.15.6 核心）", () => {
    assert.ok(rendererSrc.includes("const composerDrafts = new Map();"), "composerDrafts Map 丢失");
    assert.ok(rendererSrc.includes("输入框草稿按对话隔离"), "设计注释缺失");
  });
  await test("loadConversation 切走前保存当前草稿（文本+附件）", () => {
    assert.ok(loadFn.includes("composerDrafts.set(conversationId, { text: elements.prompt.value, attachments });"),
      "切走前未保存草稿（conversationId 仍是旧对话时 set）");
    assert.ok(loadFn.indexOf("composerDrafts.set") < loadFn.indexOf("await window.agentChatPro.getConversation(id);"),
      "草稿保存必须在读取目标对话之前（此时 conversationId 还是旧对话）");
  });
  await test("loadConversation 恢复目标对话草稿（prompt.value 赋值）", () => {
    assert.ok(rendererSrc.includes("const composerDraft = composerDrafts.get(conversation.id)"),
      "草稿恢复缺失");
    const restoreIdx = rendererSrc.indexOf("elements.prompt.value = composerDraft.text || \"\";");
    assert.ok(restoreIdx >= 0, "prompt.value 未从草稿恢复");
    assert.ok(loadFn.indexOf("composerDrafts.get(conversation.id)") < loadFnEnd.indexOf("elements.messages.replaceChildren()"),
      "草稿恢复应在替换聊天区之前");
  });
  await test("附件随草稿恢复（浅拷贝，不再被粗暴清空丢弃）", () => {
    assert.ok(rendererSrc.includes("attachments = [...(composerDraft.attachments || [])];"),
      "附件未随草稿恢复（丢附件状态错乱的根因②）");
    const fn = loadFn.split("if (conversationId) composerDrafts.set")[0];
    assert.ok(!/\battachments = \[\];/.test(fn.split("composerDrafts.get")[0]), "loadConversation 前段不应再出现 attachments = [] 粗暴清空");
  });

  // ⭐ 核心：忙碌样态按任务归属
  await test("loadConversation 内忙碌样态跟随 streamingOngoing（切到无任务对话恢复待发送样态）", () => {
    const busyBlock = extractBetween(loadFn, "v3.15.6：发送区忙碌样态跟随任务归属", "refreshConversationList();");
    assert.ok(busyBlock.includes('elements.composer.classList.toggle("busy", streamingOngoing);'), "composer busy 未归属化");
    assert.ok(busyBlock.includes('elements.send.classList.toggle("busy", streamingOngoing);'), "send busy 未归属化");
    assert.ok(busyBlock.includes('elements.send.title = streamingOngoing ? "停止生成（Esc）" : "发送";'), "send title 未归属化");
  });
  await test("忙碌样态判定与 streamingOngoing 同源（activeId && streamingConversationId === conversation.id）", () => {
    const busyBlock = extractBetween(loadFn, "v3.15.6：发送区忙碌样态跟随任务归属", "refreshConversationList();");
    const idx = busyBlock.indexOf('elements.composer.classList.toggle("busy", streamingOngoing);');
    const declIdx = loadFn.indexOf("const streamingOngoing = Boolean(activeId && streamingConversationId === conversation.id);");
    assert.ok(declIdx >= 0 && idx >= 0, "streamingOngoing 复用失败——忙碌样态应与流式归属同一判定");
  });

  // ⭐ 核心：停止语义按任务归属分派（误停别人的任务）
  await test("发送按钮 busy 时归属分派——仅本对话任务触发停止", () => {
    const submitBlock = extractBetween(rendererSrc, 'elements.composer.addEventListener("submit"', "elements.composer.addEventListener(\"click\"");
    assert.ok(submitBlock.includes("streamingConversationId === conversationId) stopActiveMessage();"),
      "busy 按钮未按归属分派停止（根因④：在 B 里点发送误停 A 的任务）");
    assert.ok(submitBlock.includes("else sendMessage();"), "非本对话任务应分派到发送路径");
  });
  await test("Esc 仅停止当前查看对话的任务（不误停后台任务）", () => {
    const escBlock = rendererSrc.split('if (event.key === "Escape") {')[1].split("});")[0];
    assert.ok(escBlock.includes('if (activeId && streamingConversationId === conversationId)'), "Esc 未按任务归属分派");
    assert.ok(escBlock.includes("stopActiveMessage();"), "Esc 停止路径丢失");
  });
  await test("Enter 键不静默无反应——任务属于其他对话时进入 sendMessage 拿提示", () => {
    const enterBlock = extractBetween(rendererSrc, 'elements.prompt.addEventListener("keydown"', "window.addEventListener(\"focus\"");
    assert.ok(enterBlock.includes("streamingConversationId !== conversationId"), "Enter 未按任务归属分派");
    assert.ok(enterBlock.includes("sendMessage();"), "Enter 发送路径丢失");
  });
  await test("sendMessage 拦截归属化本对话 + 明确提示其他对话（不再静默 return）", () => {
    const sendFnHead = extractBetween(rendererSrc, "async function sendMessage(composerText = elements.prompt.value, opts = {}) {", "const userItem = addMessage");
    assert.ok(sendFnHead.includes('if (streamingConversationId === conversationId) return;'), "本对话任务进行中仍应静默拦截");
    assert.ok(sendFnHead.includes("setConnection("), "其他对话任务占用时未给出提示");
    assert.ok(sendFnHead.includes("完成后即可发送"), "提示文案缺失（同一时间仅一个任务）");
  });

  // 回归：v3.15.0 后台任务切换不回退
  await test("loadConversation/createNewConversation 无 activeId 锁（v3.15.0 不回退）", () => {
    assert.ok(!loadFn.includes("if (activeId) return;"), "loadConversation 锁回退");
  });
  await test("addMessage 仍挂载消息（v3.15.2 不回退）", () => {
    const fn = rendererSrc.split('function addMessage(kind, text = "", meta = {}) {')[1];
    assert.ok(fn.includes("elements.messages.append(item);"), "addMessage 未挂载消息");
  });
  await test("计量隔离仍在（v3.15.1 不回退）", () => {
    assert.ok(rendererSrc.includes("if (streamingConversationId === conversationId) sessionId = result.sessionId"),
      "完成回调 sessionId 计量隔离丢失");
  });
  await test("v3.15.5 落库锚点回补仍在", () => {
    assert.ok(rendererSrc.includes("v3.15.5 修复2：补落库锚点（mid）"), "v3.15.5 锚点回补丢失");
    assert.ok(rendererSrc.includes("v3.15.5 修复2：写入落库锚点（mid/at/role）"), "v3.15.5 dataset 写入丢失");
  });

  await test("版本号 ≥3.15.6", () => {
    const parts = pkg.version.split(".").map(Number);
    const ok = parts[0] > 3 || (parts[0] === 3 && (parts[1] > 15 || (parts[0] === 3 && parts[1] === 15 && parts[2] >= 6)));
    assert.ok(ok, `版本号应为 ≥3.15.6，实际 ${pkg.version}`);
  });

  console.log(`\n${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.log("\n失败项：");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

runTests().catch((error) => { console.error(error); process.exit(1); });