"use strict";
/**
 * v3.15.5 测试 — 复读检测折叠 + 删除同步落库 + 工具循环跨轮分隔
 * 背景：用户 Test-PC 反馈云端模式单条回复内同一段话复读 13 遍（末段细微变体）。
 *   三缺陷放大：①复读产物全量落库喂给下轮上下文（滚雪球）②右键「删除此条及下方所有消息」
 *   只删 DOM（conversations.cjs 无删单条 API），落库+模型上下文里还在，切走切回复活
 *   ③cloud 工具循环 streamedText 跨轮累计无分隔（SSH 分支有 streamedTurnText，cloud 未对齐）。
 * 修复：repetition-guard.cjs 复读折叠 + truncateConversationMessages 落库同步 + emitRoundSeparator。
 * 覆盖：repetition-guard 真单测；conversations.cjs mid/truncate 真单测（mock electron+settings）；
 *       main/preload/renderer 接线断言；obfuscate 登记；版本号。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const GUARD_PATH = path.join(ROOT, "src", "main", "repetition-guard.cjs");
const CONVERSATIONS_PATH = path.join(ROOT, "src", "main", "conversations.cjs");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
const PRELOAD_PATH = path.join(ROOT, "src", "main", "preload.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const OBFUSCATE_PATH = path.join(ROOT, "scripts", "obfuscate.cjs");
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

const mainSrc = fs.readFileSync(MAIN_PATH, "utf8");
const preloadSrc = fs.readFileSync(PRELOAD_PATH, "utf8");
const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
const obfuscateSrc = fs.readFileSync(OBFUSCATE_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

// ── 1. repetition-guard.cjs 真单测 ─────────────────
const guard = require(GUARD_PATH);
const SEG = "您说得对，我需要先调研一下为什么补丁没生效。让我检查一下当前的目录结构和文件内容，看看问题出在哪里。";
const SEG_A = "您说得对，我需要先调研一下为什么补丁没生效。让我检查一下当前的情况。";
const SEG_B = "您说得对，我需要先调研一下为什么补丁没生效。让我检查一下当前的目录结构和文件内容，看看问题出在哪里。";

async function runGuardTests() {
  await test("13 段复读 → 折叠（A 一次 + B 一次）+ 尾注 + removed=11", () => {
    const text = [SEG_A, ...Array.from({ length: 12 }, () => SEG_B)].join("\n\n");
    const result = guard.collapseRepetition(text);
    assert.strictEqual(result.removed, 11, `B 出现 12 次保留 1 次应去除 11，实际 ${result.removed}`);
    assert.strictEqual(result.collapsed, 1, `涉及 1 个重复段（A 仅出现 1 次不算），实际 ${result.collapsed}`);
    assert.ok(result.text.includes(SEG_A), "首段应保留");
    assert.strictEqual(result.text.split(SEG_B).length - 1, 1, "B 段应只保留一次");
    assert.ok(result.text.includes("已折叠"), "应有尾注提示");
    assert.ok(result.text.includes("重新生成"), "尾注应含重新生成指引");
  });

  await test("仅 2 次重复（< minRepeat=3）→ 不折叠", () => {
    const text = [SEG_B, "这是正常的第二段话，内容完全不同。", SEG_B].join("\n\n");
    const result = guard.collapseRepetition(text);
    assert.strictEqual(result.collapsed, 0);
    assert.strictEqual(result.text, text, "原样返回");
  });

  await test("正常内容（无重复）→ 原样返回", () => {
    const text = "第一段正常内容。\n\n第二段不同的内容，讨论另一个问题。\n\n第三段继续深入分析。";
    const result = guard.collapseRepetition(text);
    assert.strictEqual(result.collapsed, 0);
    assert.strictEqual(result.text, text);
  });

  await test("短段重复（段长 < 8）不参与判定 → 不折叠", () => {
    const text = ["好的。", "……", "好的。", "……", "好的。", "……"].join("\n\n");
    const result = guard.collapseRepetition(text);
    assert.strictEqual(result.collapsed, 0);
  });

  await test("重复段占比 < 30% → 不折叠（防局部重复误伤）", () => {
    // 20 段里 3 段重复（removed=2，占比 15% < 30%）→ 原样
    const parts = Array.from({ length: 20 }, (_, i) => `第 ${i} 段正常内容，各有不同的话题和表述方式。`);
    parts.splice(3, 0, SEG_B, "过渡段，内容不同。", SEG_B, "另一段内容。", SEG_B);
    const result = guard.collapseRepetition(parts.join("\n\n"));
    assert.strictEqual(result.collapsed, 0, `占比 ${(5 / 25).toFixed(2)} 不应折叠`);
  });

  await test("代码块/列表同句重复但整段不同 → 不折叠（按段非按行）", () => {
    const text = "使用方法：\n\n第 1 步安装依赖 npm install\n第 2 步运行 npm start\n第 3 步构建 npm run build\n\n以上就是全部步骤。".replace(/\n(?=第)/g, "\n第");
    const result = guard.collapseRepetition(text);
    assert.strictEqual(result.collapsed, 0);
  });

  await test("跨轮分隔符（---）段被过滤，不参与复读判定", () => {
    const text = [SEG_B, "---", SEG_B, "---", SEG_B].join("\n\n");
    const result = guard.collapseRepetition(text);
    assert.ok(result.removed >= 1, "B 段重复应被折叠");
    assert.ok(!result.text.split("\n\n").includes("---"), "折叠后不应残留独立 --- 段");
  });

  await test("空文本/非字符串 → 原样返回不崩", () => {
    assert.strictEqual(guard.collapseRepetition("").text, "");
    assert.strictEqual(guard.collapseRepetition(null).text, null);
    assert.deepStrictEqual(guard.detectRepetition(SEG), { collapsed: 0, removed: 0 });
  });

  await test("短文本不足 minRepeat 段数 → 不折叠", () => {
    assert.strictEqual(guard.collapseRepetition(SEG_B).collapsed, 0, "单段不折叠");
  });

  await test("折叠结果可作为正常文本再折叠（幂等安全）", () => {
    const text = [SEG_A, ...Array.from({ length: 5 }, () => SEG_B)].join("\n\n");
    const once = guard.collapseRepetition(text);
    const twice = guard.collapseRepetition(once.text);
    assert.strictEqual(twice.collapsed, 0, "折叠后不应再触发");
  });

  await test("自定义阈值：minRepeat=2 更灵敏，minRatio=0 放宽占比", () => {
    const text = [SEG_B, "中间一段正常话，内容完全不同。", SEG_B].join("\n\n");
    const result = guard.collapseRepetition(text, { minRepeat: 2, minRatio: 0 });
    assert.strictEqual(result.removed, 1, "2 次重复在宽松阈值下应折叠");
  });
}

// ── 2. conversations.cjs 真单测（mock electron + settings，数据写临时目录） ─────────────────
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3155-"));
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
  await test("新落库消息带 mid（user/assistant/draft 三类）", () => {
    const conv = conversations.createConversation();
    conversations.addUserMessage(conv.id, "问题");
    conversations.saveAssistantDraft(conv.id, "req-x", "草稿");
    conversations.addAssistantMessage(conv.id, "正式回复", "", [], [], "req-y", "cloud");
    const stored = conversations.getConversation(conv.id).messages;
    assert.ok(stored[0].mid, "user 消息应有 mid");
    assert.ok(stored[1].mid, "draft 消息应有 mid");
    assert.ok(stored[2].mid, "assistant 消息应有 mid");
  });

  await test("draft 转正保留 draft 的 mid（不重新生成）", () => {
    const conv = conversations.createConversation();
    conversations.addUserMessage(conv.id, "问题");
    conversations.saveAssistantDraft(conv.id, "req-1", "草稿文本");
    const draftMid = conversations.getConversation(conv.id).messages.find((m) => m.draft).mid;
    conversations.addAssistantMessage(conv.id, "正式回复", "", [], [], "req-1", "cloud");
    const stored = conversations.getConversation(conv.id).messages;
    const completed = stored.find((m) => m.role === "assistant");
    assert.strictEqual(completed.mid, draftMid, "转正应复用 draft 的 mid");
    assert.strictEqual(completed.draft, undefined);
  });

  await test("truncate 按 mid 删除该条及之后所有落库消息", () => {
    const conv = conversations.createConversation();
    conversations.addUserMessage(conv.id, "u1");
    conversations.addAssistantMessage(conv.id, "a1", "", [], [], "r1", "cloud");
    conversations.addUserMessage(conv.id, "u2");
    conversations.addAssistantMessage(conv.id, "a2", "", [], [], "r2", "cloud");
    const stored = conversations.getConversation(conv.id).messages;
    const anchor = stored[1]; // a1
    const result = conversations.truncateConversationMessages(conv.id, { mid: anchor.mid });
    assert.strictEqual(result.removed, 3, "应删 a1+u2+a2 共 3 条");
    const after = conversations.getConversation(conv.id).messages;
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].text, "u1");
  });

  await test("truncate 旧数据（无 mid）按 at+role 兜底删除", () => {
    const conv = conversations.createConversation();
    conversations.addUserMessage(conv.id, "旧消息A");
    conversations.addUserMessage(conv.id, "旧消息B");
    const stored = conversations.getConversation(conv.id).messages;
    const anchor = { mid: "", at: stored[1].at, role: "user" };
    const result = conversations.truncateConversationMessages(conv.id, anchor);
    assert.strictEqual(result.removed, 1);
    const after = conversations.getConversation(conv.id).messages;
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].text, "旧消息A");
  });

  await test("truncate 找不到锚点 → 抛中文错误", () => {
    const conv = conversations.createConversation();
    conversations.addUserMessage(conv.id, "x");
    assert.throws(
      () => conversations.truncateConversationMessages(conv.id, { mid: "not-exist", at: "", role: "" }),
      /找不到要删除的消息/
    );
  });

  await test("删除后 getConversation 数据与归档一致（updatedAt 刷新）", () => {
    const conv = conversations.createConversation();
    conversations.addUserMessage(conv.id, "a");
    conversations.addUserMessage(conv.id, "b");
    conversations.truncateConversationMessages(conv.id, { mid: conversations.getConversation(conv.id).messages[1].mid });
    const stored = conversations.getConversation(conv.id);
    assert.strictEqual(stored.messages.length, 1);
    assert.ok(stored.updatedAt, "updatedAt 应存在");
  });
}

// ── 3. 接线断言（main / preload / renderer / obfuscate） ─────────────────
async function runWiringTests() {
  await test("main.cjs：require repetition-guard + 完成/取消两处接入折叠", () => {
    assert.ok(mainSrc.includes('require("./repetition-guard.cjs")'), "repetition-guard 未接线");
    const cloudBlock = mainSrc.slice(mainSrc.indexOf('if (connectionMode === "cloud")'), mainSrc.indexOf("// ── SSH / 本机模式 ──"));
    assert.ok(cloudBlock.includes("collapseRepetition(streamedText)"), "完成分支未调用折叠");
    assert.ok(cloudBlock.includes("cloud_repetition_collapsed"), "折叠未写日志");
    assert.ok(cloudBlock.includes("const finalText = repetition.collapsed ? repetition.text : streamedText"), "finalText 选择逻辑缺失");
    assert.ok(cloudBlock.includes("text: finalText"), "返回值应用折叠后文本");
  });

  await test("main.cjs：折叠在 addAssistantMessage 之前（落库即折叠，断滚雪球）", () => {
    const cloudBlock = mainSrc.slice(mainSrc.indexOf('if (connectionMode === "cloud")'), mainSrc.indexOf("// ── SSH / 本机模式 ──"));
    const collapseIdx = cloudBlock.indexOf("const repetition = collapseRepetition(streamedText)");
    const persistIdx = cloudBlock.indexOf("addAssistantMessage(input.conversationId, finalText");
    assert.ok(collapseIdx !== -1 && persistIdx !== -1, "接线点缺失");
    assert.ok(collapseIdx < persistIdx, "折叠应先于落库");
  });

  await test("main.cjs：conversations:truncate IPC 已注册且写日志", () => {
    assert.ok(mainSrc.includes('ipcMain.handle("conversations:truncate"'), "IPC 缺失");
    assert.ok(mainSrc.includes("truncateConversationMessages"), "未调用 truncateConversationMessages");
    assert.ok(mainSrc.includes("conversation_truncated"), "删除日志缺失");
  });

  await test("main.cjs：emitRoundSeparator 定义 + 循环内 round>0 调用（v3.21.3：改推 round 事件不再拼 --- 进正文）", () => {
    assert.ok(mainSrc.includes("emitRoundSeparator"), "emitRoundSeparator 缺失");
    assert.ok(mainSrc.includes('if (round > 0 && cloudCallbacks.emitRoundSeparator)'), "循环调用点缺失");
    assert.ok(mainSrc.includes('type: "round"'), "应推 round 专用事件（v3.21.3 修复②）");
    assert.ok(!mainSrc.includes("streamedText += separator"), "不应把分隔符累计进 streamedText（v3.21.3 修复②）");
  });

  await test("main.cjs：分隔不进正文流（v3.21.3：不再推 chat:delta 文本注入），渲染层画轮次徽标", () => {
    const emitBlock = mainSrc.slice(mainSrc.indexOf("emitRoundSeparator:"), mainSrc.indexOf("onStatus:"));
    assert.ok(emitBlock.includes('type: "round"'), "分隔应推 chat:event 的 round 事件");
    assert.ok(!emitBlock.includes('sendWorkStatusSignal(event.sender, "chat:delta"'), "不应经 chat:delta 注入正文（v3.21.3 修复②）");
    assert.ok(!emitBlock.includes("cloudCallbacks.onDelta"), "不应经 onDelta 造成二次累计");
  });

  await test("preload：truncateConversationMessages 通道暴露", () => {
    assert.ok(preloadSrc.includes("truncateConversationMessages: (id, anchor) => ipcRenderer.invoke(\"conversations:truncate\", id, anchor)"));
  });

  await test("renderer：loadConversation 渲染时写入落库锚点 dataset（msgId/msgAt/msgRole）", () => {
    assert.ok(rendererSrcHas("item.dataset.msgId = message.mid"), "msgId dataset 缺失");
    assert.ok(rendererSrcHas("item.dataset.msgAt = message.at"), "msgAt dataset 缺失");
    assert.ok(rendererSrcHas("item.dataset.msgRole = message.role"), "msgRole dataset 缺失");
  });

  await test("renderer：删除 handler 先同步落库（truncate IPC）再删 DOM，失败不删", () => {
    const start = rendererSrc.indexOf('createContextMenuItem("🗑", "删除此条及下方所有消息"');
    const block = rendererSrc.slice(start, start + 2500);
    assert.ok(block.includes("await window.agentChatPro.truncateConversationMessages"), "未调用 truncate IPC");
    const truncateIdx = block.indexOf("truncateConversationMessages");
    const removeIdx = block.indexOf(".remove()");
    assert.ok(truncateIdx !== -1 && removeIdx !== -1, "关键代码缺失");
    assert.ok(truncateIdx < removeIdx, "应先落库删除再删 DOM");
    assert.ok(block.includes("删除失败"), "失败应有提示且不删 DOM");
  });

  await test("renderer：删除后按落库重算累计 token（v3.21.3：云端消息优先真实账目 tokensForMessage）", () => {
    const block = rendererSrc.slice(rendererSrc.indexOf('createContextMenuItem("🗑"'), rendererSrc.indexOf("} else if (kind === \"assistant\")"));
    assert.ok(block.includes("tokensForMessage(msg"), "token 重算缺失");
    assert.ok(block.includes("updateTokenDisplay()"), "token 刷新缺失");
  });

  await test("renderer：完成回调补落库锚点（getConversation 回查 mid，仅当前对话）", () => {
    assert.ok(rendererSrcHas("answer.dataset.msgId = lastAssistant.mid"), "assistant 锚点补写缺失");
    assert.ok(rendererSrcHas("userItem.dataset.msgId = lastUser.mid"), "user 锚点补写缺失");
    const block = rendererSrc.slice(rendererSrc.indexOf("answer.dataset.msgId = lastAssistant.mid") - 600, rendererSrc.indexOf("answer.dataset.msgId = lastAssistant.mid") + 200);
    assert.ok(block.includes("streamingConversationId === conversationId"), "补锚点应条件化于当前对话");
  });

  await test("obfuscate：repetition-guard.cjs 已登记混淆", () => {
    assert.ok(obfuscateSrc.includes('"main/repetition-guard.cjs"'), "混淆清单缺 repetition-guard.cjs");
  });

  await test("版本号 ≥ 3.15.5", () => {
    const rank = pkg.version.split(".").reduce((sum, part) => sum * 1000 + Number(part), 0);
    assert.ok(rank >= 31505, `版本 ${pkg.version} 应 ≥ 3.15.5`);
  });
}

function rendererSrcHas(fragment) {
  return rendererSrc.includes(fragment);
}

/** 从锚点文本位置找到所在箭头函数的结束（取锚点后 2500 字符窗口用于断言） */
function blockEnd(src, anchor) {
  const idx = src.indexOf(anchor);
  return idx === -1 ? src.length : Math.min(idx + 2500, src.length);
}

(async () => {
  await runGuardTests();
  await runConversationTests();
  await runWiringTests();
  console.log(`\n=== test-v3-15-5.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})();