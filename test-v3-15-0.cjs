"use strict";
/**
 * v3.15.0 测试 — Agent 后台任务 + 智能滚动跟随 + 侧边栏收缩 + 历史模式图标
 * 覆盖：conversations.cjs lastConnectionMode 三值化（真单测，mock electron/settings）；
 *       renderer.js 后台任务切换/智能滚动/模式图标/侧边栏收缩；index.html + styles.css 断言；版本号。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const CONVERSATIONS_PATH = path.join(ROOT, "src", "main", "conversations.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const INDEX_PATH = path.join(ROOT, "src", "renderer", "index.html");
const STYLES_PATH = path.join(ROOT, "src", "renderer", "styles.css");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
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

// ── 1. conversations.cjs 真单测（mock electron + settings，数据写临时目录） ─────────────────
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3150-"));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => workdir, whenReady: async () => {} } };
  }
  if (request === "./settings.cjs") {
    return { getSettings: () => ({ dataDirectory: workdir }) };
  }
  return originalLoad.apply(this, arguments);
};
const conversations = require(CONVERSATIONS_PATH);
Module._load = originalLoad;

async function runConversationTests() {
  await test("addAssistantMessage 传 cloud → lastConnectionMode 记 cloud（v3.15.0 三值化）", () => {
    const conv = conversations.createConversation();
    conversations.addAssistantMessage(conv.id, "你好", "", [], [], "req-1", "cloud");
    const stored = conversations.getConversation(conv.id);
    assert.strictEqual(stored.lastConnectionMode, "cloud");
  });

  await test("addAssistantMessage 传 ssh → 记 ssh；传 local → 记 local", () => {
    const a = conversations.createConversation();
    conversations.addAssistantMessage(a.id, "a", "", [], [], "req-2", "ssh");
    assert.strictEqual(conversations.getConversation(a.id).lastConnectionMode, "ssh");
    const b = conversations.createConversation();
    conversations.addAssistantMessage(b.id, "b", "", [], [], "req-3", "local");
    assert.strictEqual(conversations.getConversation(b.id).lastConnectionMode, "local");
  });

  await test("addAssistantMessage 传未知值 → 兜底 ssh", () => {
    const conv = conversations.createConversation();
    conversations.addAssistantMessage(conv.id, "x", "", [], [], "req-4", "whatever");
    assert.strictEqual(conversations.getConversation(conv.id).lastConnectionMode, "ssh");
  });

  await test("saveConversationSession 传 cloud → lastConnectionMode 记 cloud", () => {
    const conv = conversations.createConversation();
    conversations.saveConversationSession(conv.id, "sess-cloud-1", "cloud");
    const stored = conversations.getConversation(conv.id);
    assert.strictEqual(stored.lastConnectionMode, "cloud");
  });

  await test("sessionForMode 兼容三值：cloud 对话返回 sshSessionId", () => {
    const conv = conversations.createConversation();
    conversations.saveConversationSession(conv.id, "sess-abc", "cloud");
    const stored = conversations.getConversation(conv.id);
    assert.strictEqual(conversations.sessionForMode(stored, "cloud"), "sess-abc");
  });

  await test("listConversations 返回含 lastConnectionMode 字段", () => {
    const list = conversations.listConversations();
    assert.ok(list.length > 0, "列表为空");
    assert.ok("lastConnectionMode" in list[0], "listConversations 未返回 lastConnectionMode");
  });

  await test("searchConversations 返回含 lastConnectionMode 字段", () => {
    const results = conversations.searchConversations("你好");
    assert.ok(results.length > 0, "搜索无结果");
    assert.ok("lastConnectionMode" in results[0], "searchConversations 未返回 lastConnectionMode");
  });

  await test("getConversation 含 lastConnectionMode（切对话联动模式的数据源）", () => {
    const conv = conversations.createConversation();
    conversations.saveConversationSession(conv.id, "s1", "cloud");
    const stored = conversations.getConversation(conv.id);
    assert.strictEqual(stored.lastConnectionMode, "cloud");
  });
}

// ── 2. renderer.js 源码断言 ─────────────────
const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");

async function runRendererTests() {
  // bug2：智能滚动
  await test("isNearBottom 判定存在（距底 80px 阈值）", () => {
    assert.ok(rendererSrc.includes("function isNearBottom()"), "缺少 isNearBottom 函数");
    assert.ok(/scrollHeight - el\.scrollTop - el\.clientHeight < 80/.test(rendererSrc), "阈值不为 80");
  });
  await test("addMessage：user 消息强制滚底，其余按 isNearBottom 判定", () => {
    assert.ok(rendererSrc.includes('kind.startsWith("user") || isNearBottom()'), "addMessage 滚动条件未条件化");
  });
  await test("onDelta 流式输出按 isNearBottom 条件滚动", () => {
    const onDeltaBlock = rendererSrc.split("window.agentChatPro.onDelta(")[1].split("});")[0];
    assert.ok(onDeltaBlock.includes("if (isNearBottom())"), "onDelta 仍无条件强制滚底");
  });
  await test("onChatEvent tool 工具卡按 isNearBottom 条件滚动", () => {
    const toolBlock = rendererSrc.split('event.type === "tool" && answer')[1].split("} else if")[0];
    assert.ok(toolBlock.includes("if (isNearBottom())"), "tool 事件仍无条件强制滚底");
  });
  // bug1：后台任务
  await test("loadConversation 已移除 activeId 锁（工作中可切换对话）", () => {
    const fn = rendererSrc.split("async function loadConversation(id) {")[1].split("\nasync function createNewConversation")[0];
    assert.ok(!fn.includes("if (activeId) return;"), "loadConversation 仍拦截进行中切换");
  });
  await test("createNewConversation 已移除 activeId 锁", () => {
    const fn = rendererSrc.split("async function createNewConversation() {")[1].split("\nfunction setConnection")[0];
    assert.ok(!fn.includes("if (activeId) return;"), "createNewConversation 仍拦截");
  });
  await test("sendMessage 记录进行中任务归属（对话+模式）", () => {
    assert.ok(rendererSrc.includes("streamingConversationId = conversationId;"), "未记录 streamingConversationId");
    assert.ok(rendererSrc.includes("streamingConnectionMode = currentConnectionMode;"), "未记录 streamingConnectionMode");
  });
  await test("切回进行中对话重新挂载流式元素（isConnected 判定）", () => {
    const fn = rendererSrc.split("async function loadConversation(id) {")[1].split("\nasync function createNewConversation")[0];
    assert.ok(fn.includes("streamingOngoing"), "缺 streamingOngoing 判定");
    assert.ok(fn.includes("!answer.isConnected"), "未重新挂载流式元素");
    assert.ok(fn.includes("message.draft && streamingOngoing"), "进行中对话的 draft 未跳过渲染");
  });
  await test("完成回调条件更新 sessionId（防串话）", () => {
    assert.ok(rendererSrc.includes("if (streamingConversationId === conversationId) sessionId = result.sessionId || sessionId;"), "sessionId 无条件更新");
  });
  await test("完成回调条件更新 token/stats（仅当用户仍看着该对话）", () => {
    assert.ok(/streamingConversationId === conversationId\) addConversationTokens/.test(rendererSrc), "token 合并未条件化");
    assert.ok(/result\.stats && result\.stats\.totalTokens && streamingConversationId === conversationId/.test(rendererSrc), "stats 未条件化");
  });
  await test("finally 与 forceClearActiveState 清理 streaming 状态", () => {
    const cleanups = rendererSrc.split('streamingConversationId = "";').length - 1;
    assert.ok(cleanups >= 2, `streamingConversationId 清理应 ≥2 处（finally + forceClearActiveState），实际 ${cleanups}`);
    const forceClear = rendererSrc.split("function forceClearActiveState")[1].split("\nfunction ")[0];
    assert.ok(forceClear.includes('streamingConversationId = "";'), "forceClearActiveState 未清 streaming 状态");
  });
  await test("状态条文案用发起时模式（streamingConnectionMode）", () => {
    assert.ok(rendererSrc.includes("const modeLabel = activeId ? streamingConnectionMode : currentConnectionMode;"), "connection 事件文案未用发起时模式");
  });
  // 功能2：模式图标 + 切对话联动
  await test("模式图标映射：ssh=🖥️ cloud=☁️ local=💻", () => {
    assert.ok(rendererSrc.includes('ssh: "🖥️"'), "缺 ssh 图标");
    assert.ok(rendererSrc.includes('cloud: "☁️"'), "缺 cloud 图标");
    assert.ok(rendererSrc.includes('local: "💻"'), "缺 local 图标");
  });
  await test("历史列表标题后追加模式徽标（conversation-mode-icon）", () => {
    assert.ok(rendererSrc.includes('badge.className = "conversation-mode-icon"'), "列表未加模式徽标");
    assert.ok((rendererSrc.match(/conversation-mode-icon/g) || []).length >= 2, "两个列表分支（搜索/常规）未都加徽标");
  });
  await test("loadConversation 读 lastConnectionMode 联动切模式并持久化", () => {
    const fn = rendererSrc.split("async function loadConversation(id) {")[1].split("\nasync function createNewConversation")[0];
    assert.ok(fn.includes("conversation.lastConnectionMode"), "未读对话 lastConnectionMode");
    assert.ok(fn.includes('["ssh", "cloud", "local"].includes(lastMode)'), "未校验三值");
    assert.ok(fn.includes("saveSettings"), "联动未持久化（main 侧 chat:send 读已保存设置）");
    assert.ok(fn.includes("updateConnectionModeUI()"), "联动未更新 UI");
  });
  // 功能1：侧边栏收缩
  await test("侧边栏收缩接线 + localStorage 记忆 + 箭头图标（←收起/→展开）", () => {
    assert.ok(rendererSrc.includes('document.querySelector("#sidebar-toggle")'), "未接线 #sidebar-toggle");
    assert.ok(rendererSrc.includes("body.classList.toggle(\"sidebar-collapsed\")"), "未切换 sidebar-collapsed 类");
    assert.ok(rendererSrc.includes('"acp-sidebar-collapsed"'), "未用 localStorage 记忆");
    assert.ok(rendererSrc.includes('localStorage.getItem("acp-sidebar-collapsed") === "1"'), "启动未恢复收缩状态");
    assert.ok(rendererSrc.includes('collapsed ? "→" : "←"'), "图标未用箭头语义（v3.15.1）");
  });
  // v3.15.1：token/上下文计量与后台任务隔离
  await test("onDelta 仅当前对话刷新 token 计数（后台任务不挪用计量）", () => {
    const onDeltaBlock = rendererSrc.split("window.agentChatPro.onDelta(")[1].split("});")[0];
    assert.ok(onDeltaBlock.includes("streamingConversationId === conversationId"), "onDelta 未按对话隔离 token 计数");
    assert.ok(onDeltaBlock.includes("streamingTokens += estimateTokens"), "streamingTokens 累计丢失");
  });
  await test("usage 事件仅当前对话生效", () => {
    const usageBlock = rendererSrc.split('event.type === "usage"')[1].split("}\n});")[0];
    assert.ok(usageBlock.includes("streamingConversationId !== conversationId") && usageBlock.includes("return;"), "usage 未条件化");
  });
  await test("上下文事件仅当前对话刷新进度条", () => {
    const ctxBlock = rendererSrc.split("window.agentChatPro.onContextEvent")[1].split("if (event.type === \"model\")")[0];
    assert.ok(ctxBlock.includes("streamingConversationId !== conversationId"), "context 事件未条件化");
  });
  await test("token 计数器 streaming 态仅当前对话点亮", () => {
    assert.ok(rendererSrc.includes("Boolean(activeId && streamingConversationId === conversationId)"), "streaming class 未条件化");
  });
}

// ── 3. index.html + styles.css 断言 ─────────────────
const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");
const stylesSrc = fs.readFileSync(STYLES_PATH, "utf8");

async function runAssetTests() {
  await test("index.html 含 #sidebar-toggle 按钮", () => {
    assert.ok(indexSrc.includes('id="sidebar-toggle"'), "缺 #sidebar-toggle");
  });
  await test("CSS 收缩规则：sidebar 隐藏 + main 宽度放开", () => {
    assert.ok(stylesSrc.includes("body.sidebar-collapsed .sidebar { display: none; }"), "缺 sidebar 隐藏规则");
    assert.ok(stylesSrc.includes("body.sidebar-collapsed .main { width: min(980px, 100%); }"), "缺 main 宽度放开规则");
  });
  await test("CSS 模式徽标与标题 flex 布局（防长标题截断徽标）", () => {
    assert.ok(stylesSrc.includes(".conversation-title { flex: 1 1 auto"), "缺标题 flex 规则");
    assert.ok(stylesSrc.includes(".conversation-mode-icon { flex: none;"), "缺徽标样式");
  });
}

// ── 4. main.cjs cloud 落盘 + 版本号 ─────────────────
const mainSrc = fs.readFileSync(MAIN_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

async function runVersionTests() {
  await test("main.cjs cloud 分支 addAssistantMessage 落盘 connectionMode=cloud", () => {
    assert.ok(mainSrc.includes('[], collectedTools, id, "cloud")'), "cloud 分支未落盘 cloud 模式");
  });
  await test("版本号 = 3.15.0（语义 ≥3.15.0 跟随）", () => {
    const rank = pkg.version.split(".").reduce((sum, part) => sum * 1000 + Number(part), 0);
    assert.ok(rank >= 31500, `版本 ${pkg.version} 应 ≥ 3.15.0`);
    assert.ok(rendererSrc.includes("v3.15.0"), "渲染层注释未标注 v3.15.0");
  });
}

(async () => {
  await runConversationTests();
  await runRendererTests();
  await runAssetTests();
  await runVersionTests();
  console.log(`\n=== test-v3-15-0.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})();