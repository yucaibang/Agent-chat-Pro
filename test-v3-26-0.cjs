"use strict";
/* ═══════════════════════════════════════════════════════════════════
 * test-v3-26-0.cjs — 多 AI 对话（工作）· 阶段 A：工作区切换器 + 历史物理隔离
 *
 * 规格来源（2026-10-31 用户令「现在加个大功能：多AI对话（工作）」）：
 *   大功能整包按分支 feature/multi-agent-workgroup 分阶段实施，整包映射 v3.26/v3.27/v3.28：
 *   v3.26.0 = 工作区切换器 + 模块一（Agent 池 & 建群）+ 模块二（独立精神）+ 模块三基础（@路由/广播）
 *   v3.27.0 = 自主讨论 + 紧急停止 + max_turns 红线
 *   v3.28.0 = Sub-Agent 包工头体系（spawn/换脑/额度熔断）+ 错误瘦身/生命周期释放红线
 * 本文件随阶段推进追加；阶段 A 覆盖「UI 重构需求：工作区切换器」全部技术约束。
 *
 * 阶段 A 红线（规格原文逐条对应）：
 *   ① 侧边栏顶部下拉：主标题（Agent Chat Pro / Agents Chat Pro）+ 副标题
 *      （一对一专攻 / 多个高效合作）；选中显示 ✔，未选中不显示
 *   ② 会话列表物理隔离：conversations.cjs 增加 workspaceType 字段过滤；
 *      A 模式对话绝不能出现在 B 模式的历史记录/搜索里
 *   ③ 状态重置：切换工作区当前对话界面清空，回到该模式默认首页
 *   ④ 复用 loadConversation 逻辑 + workspace 入参校验（防串台）
 *   ⑤ 兼容迁移：存量对话无 workspaceType 字段一律视为 single
 * ═══════════════════════════════════════════════════════════════════ */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = __dirname;
let passCount = 0;
let failCount = 0;
async function test(name, fn) {
  try { await fn(); passCount++; console.log("  ✓ " + name); }
  catch (error) { failCount++; console.error("  ✗ " + name); console.error("    " + (error && error.stack ? String(error.stack).split("\n").slice(0, 6).join("\n    ") : error)); }
}

const conversationsSrc = fs.readFileSync(path.join(ROOT, "src", "main", "conversations.cjs"), "utf8");
const rendererSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "renderer.js"), "utf8");
const indexHtmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
const stylesSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");
const preloadSrc = fs.readFileSync(path.join(ROOT, "src", "main", "preload.cjs"), "utf8");
const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main", "main.cjs"), "utf8");

/* ── 第 1 组：conversations.cjs 真单测（mock electron + settings，数据写临时目录；承 v3.15.5 架子） ── */

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3260-"));
const storageFile = path.join(workdir, "conversations.json");
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
const conversations = require(path.join(ROOT, "src", "main", "conversations.cjs"));
Module._load = originalLoad;

async function runConversationTests() {
  await test("1.1 createConversation 默认归属 single（向后兼容：无参调用行为不变）", () => {
    const conv = conversations.createConversation();
    assert.strictEqual(conversations.workspaceTypeOf(conv), "single", "缺省工作区=single");
  });

  await test("1.2 createConversation('team') 落 workspaceType=team 并持久化", () => {
    const conv = conversations.createConversation("team");
    assert.strictEqual(conversations.workspaceTypeOf(conv), "team");
    const raw = JSON.parse(fs.readFileSync(storageFile, "utf8"));
    const found = raw.find((item) => item.id === conv.id);
    assert.strictEqual(found.workspaceType, "team", "落库文件带 workspaceType 字段");
  });

  await test("1.3 非法工作区值归一化回 single（不落野值）", () => {
    const conv = conversations.createConversation("hacker");
    assert.strictEqual(conversations.workspaceTypeOf(conv), "single");
    assert.strictEqual(conversations.createConversation("single").workspaceType, "single");
  });

  await test("1.4 存量兼容：无 workspaceType 字段的旧对话视为 single", () => {
    const legacy = { id: "legacy-1", title: "旧对话", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pinned: false, messages: [] };
    fs.writeFileSync(storageFile, JSON.stringify([legacy]), "utf8");
    assert.strictEqual(conversations.workspaceTypeOf(null), "single", "null 容错");
    const listed = conversations.listConversations("single");
    assert.ok(listed.some((conv) => conv.id === "legacy-1"), "single 列表含旧对话");
    assert.strictEqual(conversations.listConversations("team").find((conv) => conv.id === "legacy-1"), undefined, "team 列表不含旧对话");
  });

  await test("1.5 listConversations 按工作区物理过滤（A 模式对话绝不进 B 模式列表）", () => {
    const singleA = conversations.createConversation("single");
    const teamA = conversations.createConversation("team");
    const singleList = conversations.listConversations("single").map((conv) => conv.id);
    const teamList = conversations.listConversations("team").map((conv) => conv.id);
    assert.ok(singleList.includes(singleA.id) && !singleList.includes(teamA.id), "single 列表隔离");
    assert.ok(teamList.includes(teamA.id) && !teamList.includes(singleA.id), "team 列表隔离");
    assert.ok(conversations.listConversations("").length >= 2, "无过滤参数=全量（存量调用语义不变）");
    assert.strictEqual(singleList.every((id) => !teamList.includes(id)), true, "两列表零交集");
  });

  await test("1.6 listConversations 输出带 workspaceType 字段（渲染层可直接做校验）", () => {
    const [first] = conversations.listConversations("team");
    assert.strictEqual(first.workspaceType, "team");
  });

  await test("1.7 searchConversations 同受工作区过滤（搜索结果也不串台）", () => {
    const singleConv = conversations.createConversation("single");
    const teamConv = conversations.createConversation("team");
    conversations.addUserMessage(singleConv.id, "云端独门暗号XYZ");
    conversations.addUserMessage(teamConv.id, "群聊独门暗号XYZ");
    const singleHits = conversations.searchConversations("暗号XYZ", null, "single");
    const teamHits = conversations.searchConversations("暗号XYZ", undefined, "team");
    assert.ok(singleHits.some((hit) => hit.id === singleConv.id) && !singleHits.some((hit) => hit.id === teamConv.id), "single 搜索不含 team 对话");
    assert.ok(teamHits.some((hit) => hit.id === teamConv.id) && !teamHits.some((hit) => hit.id === singleConv.id), "team 搜索不含 single 对话");
    assert.ok(singleHits.length > 0, "limit 缺省（null/undefined IPC 序列化丢失）回落 20 正常返回");
    assert.strictEqual(teamHits[0].workspaceType, "team", "搜索结果带工作区标");
  });

  await test("1.8 workspaceType 污染不扩散：delete 后其余对话工作区标完好", () => {
    const keepSingle = conversations.createConversation("single");
    const dropTeam = conversations.createConversation("team");
    conversations.deleteConversation(dropTeam.id);
    const listed = conversations.listConversations("single").find((conv) => conv.id === keepSingle.id);
    assert.strictEqual(listed.workspaceType, "single");
  });
}

async function runStaticTests() {
  /* ── 第 2 组：主进程 IPC / preload 接线 ── */
  await test("2.1 conversations:list IPC 带 workspaceType 参数透传", () => {
    assert.ok(mainSrc.includes('ipcMain.handle("conversations:list", (_event, workspaceType) => listConversations(String(workspaceType || "")))'), "list 通道带工作区参数");
  });
  await test("2.2 conversations:create IPC 带工作区参数（缺省 single）", () => {
    assert.ok(mainSrc.includes('ipcMain.handle("conversations:create", (_event, workspaceType) => createConversation(String(workspaceType || "single")))'), "create 通道带工作区参数");
  });
  await test("2.3 conversations:search IPC 三参透传（limit 允许 null 回落）", () => {
    assert.ok(mainSrc.includes('searchConversations(query, limit, String(workspaceType || ""))'), "search 通道带工作区参数");
  });
  await test("2.4 preload 三签名扩展（渲染层 API 入口在册）", () => {
    assert.ok(preloadSrc.includes('listConversations: (workspaceType = "") => ipcRenderer.invoke("conversations:list", workspaceType)'), "preload.listConversations 带工作区");
    assert.ok(preloadSrc.includes('createConversation: (workspaceType = "single") => ipcRenderer.invoke("conversations:create", workspaceType)'), "preload.createConversation 带工作区");
    assert.ok(preloadSrc.includes('ipcRenderer.invoke("conversations:search", query, undefined, workspaceType)'), "preload.searchConversations 带工作区");
  });

  /* ── 第 3 组：渲染层（renderer.js）—— 切换器 + 隔离红线 ── */
  await test("3.1 工作区枚举与命名（主标题两行文案规格字面）", () => {
    assert.ok(rendererSrc.includes('id: "single", name: "Agent Chat Pro", desc: "一对一专攻"'), "single 工作区在册");
    assert.ok(rendererSrc.includes('id: "team", name: "Agents Chat Pro", desc: "多个高效合作"'), "team 工作区在册");
    assert.ok(rendererSrc.includes('const WORKSPACE_TEAM_NAME = "Agents Chat Pro";'), "多人区固定产品面名");
  });
  await test("3.2 normalizeWorkspace 归一化（非法值一律落回 single）", () => {
    const body = rendererSrc.slice(rendererSrc.indexOf("const normalizeWorkspace ="), rendererSrc.indexOf("let currentWorkspace ="));
    assert.ok(/value === "team" \? "team" : "single"/.test(body), "归一化语义在册");
  });
  await test("3.3 隔离三接线：列表/建对话/搜索全部按当前工作区传参", () => {
    assert.ok(rendererSrc.includes("window.agentChatPro.listConversations(currentWorkspace)"), "列表按工作区过滤");
    assert.ok(rendererSrc.includes("window.agentChatPro.createConversation(currentWorkspace)"), "新建对话归属当前工作区");
    assert.ok(rendererSrc.includes("window.agentChatPro.searchConversations(query, currentWorkspace)"), "搜索按工作区过滤");
  });
  await test("3.4 loadConversation workspace 入参校验（规格防翻车要求④）", () => {
    assert.ok(rendererSrc.includes("normalizeWorkspace(conversation.workspaceType) !== currentWorkspace"), "跨工作区对话拒绝打开");
    assert.ok(rendererSrc.includes("该对话属于另一工作区"), "拒绝提示在册");
  });
  await test("3.5 setWorkspace 状态重置序列：清界面→回默认首页→持久化→列表物理刷新", () => {
    const body = rendererSrc.slice(rendererSrc.indexOf("async function setWorkspace("), rendererSrc.indexOf("function initWorkspaceSelector()"));
    assert.ok(body.includes("elements.messages.replaceChildren()"), "聊天界面清空");
    assert.ok(body.includes("elements.empty.hidden = false"), "回到默认首页");
    assert.ok(body.includes('localStorage.setItem("acp-workspace", next)'), "工作区选择持久化");
    assert.ok(body.includes("await refreshConversationList()"), "历史列表物理刷新");
    assert.ok(body.includes("setWorkspaceDisplay()"), "触发器文案随切刷新");
  });
  await test("3.6 ✔ 规格字面：选中显示未选中不显示 + 切换器渲染在册", () => {
    assert.ok(rendererSrc.includes("check.hidden = ws.id !== currentWorkspace;"), "✔ 按选中态显隐");
    assert.ok(rendererSrc.includes("function renderWorkspaceList()") && rendererSrc.includes("function initWorkspaceSelector()"), "切换器两函数在册");
    assert.ok(rendererSrc.includes('localStorage.getItem("acp-workspace")'), "跨启动记忆读取");
  });
  await test("3.7 品牌名保护：多人工作区不写穿团队产品面名（updateBrandDisplay 守门）", () => {
    assert.ok(rendererSrc.includes('if (brandName && currentWorkspace !== "team")'), "团队区品牌名不被覆盖");
  });

  /* ── 第 4 组：index.html + styles.css 结构 ── */
  await test("4.1 index.html 工作区选择器结构（trigger+dropdown 双元素）", () => {
    assert.ok(indexHtmlSrc.includes('id="workspace-selector"') && indexHtmlSrc.includes('class="workspace-trigger"'), "选择器+触发器在册");
    assert.ok(indexHtmlSrc.includes('id="workspace-dropdown"'), "下拉容器在册");
    assert.ok(indexHtmlSrc.includes('id="workspace-desc"'), "副标题元素在册");
    assert.ok(indexHtmlSrc.includes('id="sidebar-brand-name"'), "品牌名元素保留（updateBrandDisplay 接线不断）");
    assert.ok(!indexHtmlSrc.includes('<div class="brand">'), "旧 brand 块已替换");
  });
  await test("4.2 styles.css 工作区样式：主题化变量复用（暗/亮自动适配）+ ✔ 显隐规则", () => {
    assert.ok(stylesSrc.includes(".workspace-selector") && stylesSrc.includes(".workspace-dropdown"), "选择器样式在册");
    assert.ok(stylesSrc.includes("var(--bg-mode-dropdown)") && stylesSrc.includes("var(--shadow-dropdown)"), "沿用主题化变量（暗亮两版全覆盖）");
    assert.ok(stylesSrc.includes(".workspace-item .workspace-check[hidden]") , "✔ 未选中隐藏规则在册");
    assert.ok(stylesSrc.includes(".workspace-item.active"), "选中态样式在册");
  });
  await test("4.3 旧模式下拉（mode-selector）不受影响（并存不冲突）", () => {
    assert.ok(indexHtmlSrc.includes('id="mode-selector"') && stylesSrc.includes(".mode-dropdown"), "工作模式下拉完整保留");
  });
}

(async () => {
  console.log("test-v3-26-0 — 多 AI 对话（工作）阶段 A（工作区切换器 + 历史物理隔离）");
  await runConversationTests();
  await runStaticTests();
  console.log(`\n=== 结果：${passCount} 通过 / ${failCount} 失败 ===`);
  process.exit(failCount ? 1 : 0);
})();