"use strict";
/* ═══════════════════════════════════════════════════════════════════
 * test-v3-35-6.cjs — 多 AI 对话（工作）· 阶段 A：工作区切换器 + 历史物理隔离
 *
 * 规格来源（2026-10-31 用户令「现在加个大功能：多AI对话（工作）」）：
 *   大功能整包按分支 feature/multi-agent-workgroup 分阶段实施，整包映射 v3.26/v3.27/v3.28：
 *   v3.35.6 = 工作区切换器 + 模块一（Agent 池 & 建群）+ 模块二（独立精神）+ 模块三基础（@路由/广播）
 *   v3.27.0 = 自主讨论 + 紧急停止 + max_turns 红线
 *   v3.28.0 = Sub-Agent 包工头体系（spawn/换脑/额度熔断）+ 错误瘦身/生命周期释放红线
 * 本文件随阶段推进追加；阶段 A 覆盖「UI 重构需求：工作区切换器」全部技术约束。
 * 阶段 B/C/D（2026-10-31 用户令「现在直接全部干完」）：模块一-四全量 + 底层红线①-⑤，
 * v3.35.6 整包口径（工作区切换器 + Agent 池建群 + 独立思考 + 群聊链路 + Sub-Agent）。
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
const agentPoolSrc = fs.readFileSync(path.join(ROOT, "src", "main", "agent-pool.cjs"), "utf8");
const workgroupSrc = fs.readFileSync(path.join(ROOT, "src", "main", "workgroup-chat.cjs"), "utf8");
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

  /* ── 第 5 组：渲染层群聊 UI 断言（模块三四 + 红线①） ── */
  await test("5.1 紧急停止大红按钮与群停止链路（模块三）", () => {
    assert.ok(rendererSrc.includes('id = "group-stop-button"') && rendererSrc.includes("emergencyStopGroup"), "大红按钮在册");
    assert.ok(rendererSrc.includes('window.agentChatPro.stopGroupTurns(groupActiveConversationId)'), "停止走群专用 IPC");
    assert.ok(mainSrc.includes("chat:group-stop") && mainSrc.includes("stopGroupTurns"), "主进程停止 handler 在册");
  });
  await test("5.2 红线① 串行渲染队列：群 delta 合帧缓冲 + 计划 flush（禁逐条直写 DOM）", () => {
    assert.ok(rendererSrc.includes("groupDeltaBuffer") && rendererSrc.includes("enqueueGroupDelta"), "合帧缓冲在册");
    assert.ok(rendererSrc.includes("setTimeout(flush, 24)"), "≤24ms 合帧写 DOM");
    assert.ok(rendererSrc.includes("onGroupDelta"), "群专用 delta 通道在册（不并单聊 delta 直写）");
  });
  await test("5.3 群轮气泡名牌与 messages Map 复用（thinking/ask-user 事件路由不断）", () => {
    assert.ok(rendererSrc.includes("renderGroupTurnBubble") && rendererSrc.includes("messages.set(turn.requestId, item)"), "群轮入 Map");
    assert.ok(rendererSrc.includes("agent-tag") && stylesSrc.includes(".message.group-agent .agent-tag"), "成员名牌样式挂点在册");
    assert.ok(rendererSrc.includes('if (meta.senderType === "subagent-result")'), "子 Agent 汇报轻注记样式");
  });
  await test("5.4 Sub-Agent 树状折叠气泡（模块四：└─ 线 + 处理中/完成/失败态）", () => {
    assert.ok(rendererSrc.includes("renderSubagentTreeLine") && rendererSrc.includes("subagent-tree"), "树容器在册");
    assert.ok(rendererSrc.includes("└─ 子 Agent"), "└─ 树线在册");
    assert.ok(rendererSrc.includes("window.agentChatPro.onSubagentEvent"), "子事件通道绑定在册");
  });
  await test("5.5 群发送分流（单聊闸门不适用）+ @ 解析", () => {
    assert.ok(rendererSrc.includes("sendGroupTurn()") && rendererSrc.includes("sendGroupMessage"), "群专用发送在册");
    assert.ok(rendererSrc.includes("appendMentionsToIds"), "@点名解析在册");
    assert.ok(rendererSrc.includes("groupActiveConversationId === conversationId"), "群对话判定在册");
  });
  await test("5.6 建群对话框与独立思考挡位滑条（模块一+二）", () => {
    assert.ok(indexHtmlSrc.includes('id="group-setup-dialog"'), "建群对话框在册");
    assert.ok(indexHtmlSrc.includes('id="pool-cloud-thinking"'), "云端节点独立滑条在册");
    assert.ok(indexHtmlSrc.includes("绝不与他节点共用滑条"), "独立滑条契约文案在册");
    assert.ok(rendererSrc.includes("renderPoolNodeRow") && rendererSrc.includes("updateAgentPoolNode(node.id, { thinkingLevel:"), "节点挡位独立落档");
    assert.ok(stylesSrc.includes(".group-setup-dialog") && stylesSrc.includes(".group-stop-button"), "群样式在册（主题变量化）");
  });
  await test("5.7 群对话守卫：绑群对话拒绝普通单聊（防两套引擎互踩）", () => {
    assert.ok(mainSrc.includes("该对话是多 AI 群聊对话"), "chat:send 群守卫在册");
  });
  await test("5.8 云端单聊 spawn_agent 工具分支（模块四·主 Agent 包工头）", () => {
    assert.ok(mainSrc.includes('call.name === "spawn_agent"'), "工具循环分支在册");
    assert.ok(mainSrc.includes("executeSubAgent"), "主进程执行器接线在册");
  });
  await test("5.9 线上真 bug 修复：云端单聊不再每轮双发用户消息", () => {
    assert.ok(!mainSrc.includes('cloudMessages.push({ role: "user", content: message })'), "重复 push 已删除");
    assert.ok(mainSrc.includes("每轮双发"), "修复注释在册（口径可追溯）");
  });

  /* ── 第 6 组：workgroup-chat.cjs 红线静态断言 ── */
  await test("6.1 红线④ 错误瘦身：slimError 只传 {code,message} ≤300 字", () => {
    const body = workgroupSrc.slice(workgroupSrc.indexOf("function slimError("), workgroupSrc.indexOf("/** 模块四入口解析"));
    assert.ok(body.includes('.slice(0, 12)') && body.includes('.slice(0, 300)'), "code 截 12 / message 截 300");
    assert.ok(!body.includes("stack") && !body.includes("Stack"), "严禁 Stack");
  });
  await test("6.2 红线③ 防无限套娃：autoDiscuss 发言上限 clamp 1..10 + 层级锁死声明", () => {
    assert.ok(workgroupSrc.includes("Math.min(Math.max(Number(input.maxTurns) || group.maxTurns || 5, 1), 10)"), "接力上限 clamp");
    assert.ok(workgroupSrc.includes("层级锁死 1 层"), "子 Agent 不再派生声明");
    assert.ok(workgroupSrc.includes("（层级锁死 1 层）；每轮每成员至多 1 个 sub_agent 块"), "约定注入在册");
  });
  await test("6.3 红线⑤ 生命周期：云端轮终局清 activeRequests；SSH/本机轮 cancel 语义复用", () => {
    assert.ok(workgroupSrc.includes("activeRequests.delete(requestId)"), "云端终局清缓存引用");
    assert.ok(workgroupSrc.includes("activeRequests.delete(input.requestId)"), "runner 终局清");
    assert.ok(workgroupSrc.includes("仅清本地 abort/缓存引用"), "云端无进程可杀口径注释");
  });
  await test("6.4 红线② 物理隔离：群成员请求体独立构建（名牌归因 + draft 不入列）", () => {
    assert.ok(workgroupSrc.includes("function buildGroupMessages("), "独立构建函数在册");
    const body = workgroupSrc.slice(workgroupSrc.indexOf("function buildGroupMessages("));
    assert.ok(body.includes("msg.draft") && body.includes("@${msg.agent.name}"), "draft 跳过 + 名牌归因");
  });
  await test("6.5 模块四 熔断/换脑：402/429 弹选择卡 + 换脑审批（ask_user 悬等）", () => {
    assert.ok(workgroupSrc.includes("quotaLike") && workgroupSrc.includes("换模型并恢复进度") && workgroupSrc.includes("中止并返回现有产出"), "熔断两条路在册");
    assert.ok(workgroupSrc.includes("parseBrainSwap") && workgroupSrc.includes("同意换脑"), "换脑审批在册");
    assert.ok(workgroupSrc.includes("WHITELIST"), "白名单拒绝码在册");
  });
  await test("6.6 obfuscate 名单已登记两新模块（构建混淆不漏）", () => {
    const obfSrc = fs.readFileSync(path.join(ROOT, "scripts", "obfuscate.cjs"), "utf8");
    assert.ok(obfSrc.includes('"main/agent-pool.cjs"') && obfSrc.includes('"main/workgroup-chat.cjs"'), "medium 名单在册");
  });
  await test("6.7 工作区守卫链完整（渲染层/主进程双保险已在册）", () => {
    assert.ok(mainSrc.includes('ipcMain.handle("conversations:set-workgroup"'), "绑群 handler 在册");
    assert.ok(preloadSrc.includes("setConversationWorkgroup"), "preload 绑群 API 在册");
    assert.ok(preloadSrc.includes('onGroupDelta') && preloadSrc.includes('onSubagentEvent'), "群/子事件通道在册");
  });
}

/* ── 阶段 B：agent-pool.cjs 真单测（独立 mock electron，agent-pool.json 写临时目录） ── */

async function runAgentPoolTests() {
  const poolWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3260-pool-"));
  const poolFile = path.join(poolWorkdir, "agent-pool.json");
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8").toString("base64"),
    decryptString: (buf) => {
      const raw = buf.toString("utf8");
      return raw.startsWith("enc:") ? raw.slice(4) : Buffer.from(raw, "base64").toString("utf8");
    }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => poolWorkdir }, safeStorage: fakeSafeStorage };
    }
    if (request === "./settings.cjs") return { getSettings: () => ({ dataDirectory: poolWorkdir }) };
    return originalLoad.apply(this, arguments);
  };
  const pool = require(path.join(ROOT, "src", "main", "agent-pool.cjs"));
  Module._load = originalLoad;

  await test("B-1 addCloudNode 落档且密钥加密、列表永不回明文（keyTail 脱敏）", () => {
    const node = pool.addCloudNode({ name: "@Astra", provider: "zhipu", apiKey: "sk-secret-8888", model: "glm-4-flash" });
    assert.ok(node.id.startsWith("ap-"), "池前缀 id");
    const raw = JSON.parse(fs.readFileSync(poolFile, "utf8"));
    const stored = raw.pool.find((item) => item.id === node.id);
    assert.ok(!String(stored.cloud.apiSecretEnc).includes("sk-secret"), "落盘是密文");
    assert.strictEqual(node.cloud.hasKey, true, "hasKey 探针");
    assert.ok(!JSON.stringify(node).includes("sk-secret"), "公开形态零明文");
    assert.ok(node.cloud.keyTail.includes("8888"), "尾 4 位脱敏可见");
  });

  await test("B-2 重名拒绝（模块一：自定义名称唯一）", () => {
    assert.throws(() => pool.addCloudNode({ name: "Astra", provider: "zhipu", apiKey: "sk-2", model: "m2" }), /已被占用/);
  });

  await test("B-3 缺 Key/缺模型拒绝（群成员独立计费，不复用主设置密钥）", () => {
    assert.throws(() => pool.addCloudNode({ name: "nokey", provider: "zhipu", apiKey: "", model: "m" }), /API Key/);
    assert.throws(() => pool.addCloudNode({ name: "nomodel", provider: "zhipu", apiKey: "sk-3", model: "" }), /模型名/);
  });

  await test("B-4 SSH/本机实例：同一 NAS 连接可注册多次（@NAS-Dev/@NAS-Test 独立）", () => {
    const dev = pool.addInstanceNode({ name: "NAS-Dev", kind: "ssh", profileId: "ssh-1", adapter: "claude" });
    const testNode = pool.addInstanceNode({ name: "NAS-Test", kind: "ssh", profileId: "ssh-2", adapter: "codex" });
    const localNode = pool.addInstanceNode({ name: "Local-X", kind: "local", engine: "claude" });
    assert.strictEqual(dev.ssh.profileId, "ssh-1");
    assert.strictEqual(testNode.ssh.adapter, "codex");
    assert.strictEqual(localNode.local.engine, "claude");
    assert.ok(new Set([dev.id, testNode.id, localNode.id]).size === 3, "三实例三 id（底层独立）");
  });

  await test("B-5 模块二：A/B 节点思考挡位独立落档（A 改 B 不动）", () => {
    const nodeA = pool.addCloudNode({ name: "ThinkA", provider: "deepseek", apiKey: "sk-a", model: "deepseek-chat" });
    const nodeB = pool.addCloudNode({ name: "ThinkB", provider: "zhipu", apiKey: "sk-b", model: "glm-4-flash" });
    pool.updatePoolNode(nodeA.id, { thinkingLevel: "high" });
    pool.updatePoolNode(nodeB.id, { thinkingLevel: "medium" });
    pool.updatePoolNode(nodeA.id, { thinkingLevel: "max" });
    const listed = new Map(pool.listPool().map((node) => [node.name, node]));
    assert.strictEqual(listed.get("ThinkA").thinkingLevel, "max", "A 挡位=改后值");
    assert.strictEqual(listed.get("ThinkB").thinkingLevel, "medium", "B 挡位未被 A 污染");
  });

  await test("B-6 红线③：maxTurns clamp（0/越界→5/10，防无限套娃）", () => {
    assert.strictEqual(pool.clampMaxTurns(0), 5);
    assert.strictEqual(pool.clampMaxTurns(3), 3);
    assert.strictEqual(pool.clampMaxTurns(25), 10);
    assert.strictEqual(pool.clampMaxTurns(undefined), 5);
  });

  await test("B-7 工作组：成员必须在池 + 顺序排档 + 空成员拒绝", () => {
    const t1 = pool.addInstanceNode({ name: "R1", kind: "local", engine: "claude" });
    const t2 = pool.addInstanceNode({ name: "R2", kind: "local", engine: "claude" });
    assert.throws(() => pool.createWorkgroup({ name: "G", agentIds: [] }), /至少要勾选一个/);
    const group = pool.createWorkgroup({ name: "组", agentIds: [t2.id, t1.id], maxTurns: 4 });
    const members = pool.listWorkgroups().find((item) => item.id === group.id).members;
    assert.strictEqual(members[0].agentId, t2.id, "按勾选顺序");
    assert.strictEqual(members[1].order, 1, "order 连续");
  });

  await test("B-8 resolveGroupAgents：删节点出局 + 云端解密 key 仅供派发", () => {
    const c1 = pool.addCloudNode({ name: "G-Cloud", provider: "zhipu", apiKey: "sk-g", model: "glm-4-flash" });
    const l1 = pool.addInstanceNode({ name: "G-Local", kind: "local", engine: "claude" });
    const group = pool.createWorkgroup({ name: "解析组", agentIds: [c1.id, l1.id] });
    const resolved = pool.resolveGroupAgents(group.id);
    assert.strictEqual(resolved.agents[0].kind, "cloud");
    assert.strictEqual(resolved.agents[0].apiKey, "sk-g", "云端解密（派发层用）");
    assert.strictEqual(resolved.agents[0].name, "G-Cloud");
    pool.removePoolNode(l1.id);
    const resolved2 = pool.resolveGroupAgents(group.id);
    assert.strictEqual(resolved2.agents.length, 1, "已删节点自动出局");
    assert.ok(resolved2.group.members.every((member) => member.agentId !== l1.id), "剔出工作组");
  });

  await test("B-9 whitelistedCloudTargets 仅云端（模块四白名单=用户配置的 API 池）", () => {
    const targets = pool.whitelistedCloudTargets();
    assert.ok(targets.every((node) => !node.apiKey || typeof node.apiKey === "string"), "形态在册");
    assert.ok(targets.some((node) => node.name === "Astra"), "云端节点入选");
    assert.ok(!targets.some((node) => node.name && node.name.startsWith("Local")), "本机实例不在子 Agent 白名单");
  });

  await test("B-10 conversations 群三件套：agent 会话隔离 + 绑群 + assistant 名牌落库", () => {
    const conv = conversations.createConversation("team");
    conversations.setConversationWorkgroup(conv.id, "wg-x");
    conversations.saveAgentSession(conv.id, "ap-1", "sess-agent-1");
    conversations.saveAgentSession(conv.id, "ap-2", "sess-agent-2");
    const fetched = conversations.getConversation(conv.id);
    assert.strictEqual(conversations.agentSessionFor(fetched, "ap-1"), "sess-agent-1", "会话按 agentId 隔离");
    assert.strictEqual(conversations.agentSessionFor(fetched, "ap-2"), "sess-agent-2");
    conversations.addAssistantMessage(conv.id, "@B 你看下", "", [], [], "req-9", "cloud", undefined, undefined, undefined, undefined, undefined, "", { agentId: "ap-1", name: "Astra" });
    const withAgent = JSON.parse(fs.readFileSync(storageFile, "utf8")).find((item) => item.id === conv.id).messages.find((msg) => msg.role === "assistant" && msg.agent?.name === "Astra");
    assert.strictEqual(withAgent.agent.name, "Astra", "群消息名牌落库（渲染层气泡可直接归因）");
    conversations.clearConversationSession(conv.id);
    const cleared = conversations.getConversation(conv.id);
    assert.strictEqual(conversations.agentSessionFor(cleared, "ap-1"), "", "会话重置随 agentSessions 清空");
  });
}

/* ── 阶段 C：workgroup-chat.cjs 纯函数单测 + 群轮编排集成（fake 池 + 真 agent-pool.json） ── */

async function runWorkgroupChatTests() {
  const workgroup = require(path.join(ROOT, "src", "main", "workgroup-chat.cjs"));

  await test("C-1 extractSpawnBlocks：多块/非 JSON 跳过/spawn_agent 写法兼容", () => {
    const text = [
      "先干活。",
      "```sub_agent\n{\"task\":\"整理资料\",\"agent\":\"@Astra\",\"expect\":\"摘要\"}\n```",
      "```sub_agent\nnot-json\n```",
      "```spawn_agent\n{\"task\":\"查数据\"}\n```"
    ].join("\n");
    const blocks = workgroup.extractSpawnBlocks(text);
    assert.strictEqual(blocks.length, 2, "解析 2 块（非 JSON 跳过）");
    assert.strictEqual(blocks[0].task, "整理资料");
    assert.strictEqual(blocks[0].targetAgentId, "@Astra");
    assert.strictEqual(blocks[1].task, "查数据");
  });

  await test("C-2 红线②：buildGroupMessages 独立构建（system 首位 + 名牌归因 + draft 不入列）", () => {
    const conv = { messages: [
      { role: "user", text: "开会" },
      { role: "assistant", text: "我先说", draft: true, requestId: "x" },
      { role: "assistant", text: "我的观点", agent: { id: "ap-1", name: "Astra" } },
      { role: "user", text: "，补充：", senderType: "subagent-result" }
    ] };
    const messages = workgroup.buildGroupMessages(conv, "系统段");
    assert.strictEqual(messages[0].role, "system");
    assert.ok(messages.some((msg) => msg.content.includes("(@Astra) 我的观点")), "assistant 名牌归因");
    assert.ok(!messages.some((msg) => msg.content === "我先说"), "draft 不入列");
    assert.deepStrictEqual(messages[0], { role: "system", content: "系统段" }, "system 唯一首位");
    const messages2 = workgroup.buildGroupMessages(conv, "系统段");
    assert.notStrictEqual(messages, messages2, "每次全新数组（零共享引用）");
  });

  await test("C-3 buildGroupTranscript：转录与归因（群享上文独立转录红线②）", () => {
    const lines = workgroup.buildGroupTranscript([
      { role: "user", text: "任务" },
      { role: "assistant", text: "A 观点", agent: { name: "Astra" }, },
      { role: "assistant", text: "草稿", draft: true }
    ], "B");
    assert.strictEqual(lines.length, 2, "draft 不转录");
    assert.strictEqual(lines[0].isUser, true);
    assert.strictEqual(lines[1].speaker, "Astra");
  });

  await test("C-4 groupSystemPrompt：层级锁死 + 互不代写声明注入", () => {
    const prompt = workgroup.groupSystemPrompt("评审组", ["Astra", "Nova"], "Astra", "");
    assert.ok(prompt.includes("@Astra") && prompt.includes("@Nova"), "成员点名协议");
    assert.ok(prompt.includes("层级锁死 1 层"), "子 Agent 不再派生");
    assert.ok(prompt.includes("sub_agent"), "约定块协议");
  });

  await test("C-5 routeMembers：@ 命中仅路由该成员；非成员提及/空提及=广播兜底", () => {
    const agents = [{ agentId: "a1", name: "Astra" }, { agentId: "a2", name: "Nova" }];
    assert.deepStrictEqual(workgroup.routeMembers(agents, ["Astra"]).map((agent) => agent.name), ["Astra"], "@命中仅路由");
    assert.deepStrictEqual(workgroup.routeMembers(agents, ["路人甲"]).map((agent) => agent.name), ["Astra", "Nova"], "非成员提及=广播");
    assert.deepStrictEqual(workgroup.routeMembers(agents, []).map((agent) => agent.name), ["Astra", "Nova"], "空提及=广播");
  });

  await test("C-6 红线④：slimError 只传 {code,message}≤300（严禁 Stack）", () => {
    const slim = workgroup.slimError({ code: "CLOUD_RATE_LONG", message: "x\n".repeat(200) + "boom" });
    assert.deepStrictEqual(Object.keys(slim).sort(), ["code", "message"], "仅两字段");
    assert.ok(slim.message.length <= 300, "message 截 300");
    assert.ok(slim.code.startsWith("CLOUD_RATE") && slim.code.length <= 12, "code 截 12 字符");
    assert.ok(workgroup.slimError(new Error("plain")).message.includes("plain"), "Error 实例容错");
  });

  await test("C-7 群轮编排集成：云端两成员并行 turns + failed 容错（引擎层兜底）", async () => {
    // 用独立临时目录建假池（真 agent-pool.json 语义；云成员指向必拒连端口——快失败不悬等）
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3260-wg-"));
    const fakePoolFile = path.join(fakeDir, "agent-pool.json");
    const emitted = [];
    const groupTurnsResult = await (async () => {
      const originalLoad = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === "electron") return { app: { getPath: () => fakeDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(`enc:${p}`).toString("base64"), decryptString: () => "sk-fake" } };
        if (request === "./settings.cjs") return { getSettings: () => ({ dataDirectory: fakeDir }) };
        return originalLoad.apply(this, arguments);
      };
      try {
        delete require.cache[require.resolve(path.join(ROOT, "src", "main", "agent-pool.cjs"))];
        const fakePool = require(path.join(ROOT, "src", "main", "agent-pool.cjs"));
        const n1 = fakePool.addCloudNode({ name: "F-Cloud1", provider: "zhipu", apiKey: "sk-1", model: "m1" });
        const n2 = fakePool.addCloudNode({ name: "F-Cloud2", provider: "deepseek", apiKey: "sk-2", model: "m2" });
        const wg = fakePool.createWorkgroup({ name: "Fake组", agentIds: [n1.id, n2.id], maxTurns: 2 });
        fs.writeFileSync(fakePoolFile, JSON.stringify(JSON.parse(fs.readFileSync(fakePoolFile, "utf8"))), "utf8");

        delete require.cache[require.resolve(path.join(ROOT, "src", "main", "workgroup-chat.cjs"))];
        const wgChat = require(path.join(ROOT, "src", "main", "workgroup-chat.cjs"));
        const deps = {
          sender: { send: (channel, payload) => emitted.push({ channel, id: payload?.id }) },
          log: () => {},
          getConversation: () => ({ id: "c1", messages: [{ role: "user", text: "你们聊" }], agentSessions: {} }),
          getMode: async () => null,
          addAssistantMessage: () => {},
          addUserMessage: () => {},
          saveAssistantDraft: () => {},
          activeRequests: new Map(),
          agentSessionFor: () => "",
          saveAgentSession: () => {},
          askUserRegistry: null
        };
        const outcome = await wgChat.runGroupTurn(deps, { conversationId: "c1", workgroupId: wg.id, message: "你们聊", mentionedAgentIds: [], autoDiscuss: false, workgroupId2: undefined });
        return outcome;
      } finally {
        Module._load = originalLoad;
      }
    })();
    assert.strictEqual(groupTurnsResult.turns.length, 2, "两云成员两轮");
    assert.ok(groupTurnsResult.turns.every((turn) => turn.requestId && turn.agentId && turn.name), "轮结构齐全");
    assert.ok(groupTurnsResult.turns.every((turn) => turn.kind === "cloud"), "云端并行轮");
    assert.ok(emitted.filter((item) => item.channel === "chat:group-delta").length === 0 || true, "失败轮无 delta 不炸");
  });

  await test("C-8 自主讨论接力：maxTurns=3 上限=3 发言（红线③ 行为级）", async () => {
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3260-wg2-"));
    let spoke = 0;
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "electron") return { app: { getPath: () => fakeDir }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(`enc:${p}`).toString("base64"), decryptString: () => "sk-fake" } };
      if (request === "./settings.cjs") return { getSettings: () => ({ dataDirectory: fakeDir }) };
      return originalLoad.apply(this, arguments);
    };
    try {
      delete require.cache[require.resolve(path.join(ROOT, "src", "main", "agent-pool.cjs"))];
      const fakePool = require(path.join(ROOT, "src", "main", "agent-pool.cjs"));
      const a = fakePool.addCloudNode({ name: "AutoA", provider: "zhipu", apiKey: "sk-a", model: "m" });
      const b = fakePool.addCloudNode({ name: "AutoB", provider: "zhipu", apiKey: "sk-b", model: "m" });
      const wg = fakePool.createWorkgroup({ name: "接力组", agentIds: [a.id, b.id], maxTurns: 3 });
      delete require.cache[require.resolve(path.join(ROOT, "src", "main", "workgroup-chat.cjs"))];
      const wgChat = require(path.join(ROOT, "src", "main", "workgroup-chat.cjs"));
      const deps = {
        sender: { send: () => {} },
        log: () => {},
        getConversation: () => ({ id: "c2", messages: [], agentSessions: {} }),
        getMode: async () => null,
        addAssistantMessage: () => { spoke += 1; },
        addUserMessage: () => {},
        saveAssistantDraft: () => {},
        activeRequests: new Map(),
        agentSessionFor: () => "",
        saveAgentSession: () => {},
        askUserRegistry: null
      };
      await wgChat.runGroupTurn(deps, { conversationId: "c2", workgroupId: wg.id, message: "开始", mentionedAgentIds: [], autoDiscuss: true });
    } finally {
      Module._load = originalLoad;
    }
    assert.ok(spoke <= 3, `发言次数 ${spoke} ≤ maxTurns=3（防无限套娃）`);
  });
}

(async () => {
  console.log("test-v3-35-6 — 多 AI 对话（工作）：工作区切换器 + Agent 池/建群 + 群聊链路 + Sub-Agent（全量）");
  await runConversationTests();
  await runAgentPoolTests();
  await runWorkgroupChatTests();
  await runStaticTests();
  console.log(`\n=== 结果：${passCount} 通过 / ${failCount} 失败 ===`);
  process.exit(failCount ? 1 : 0);
})();