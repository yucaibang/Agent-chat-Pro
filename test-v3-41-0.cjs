"use strict";
/**
 * v3.41.0 守门测试 — 任务完成系统推送通知（参考 ChatGPT APP 推送：AI 干完活主动提醒你回来）
 *
 * 背景：用户给云端 AI 粘贴超长任务单后切去刷抖音，几小时后才发现 AI 一小时前就干完了。
 * 方案：渲染层上报（单聊完成/失败、AI 提问悬等、群聊全员收工）→ 主进程统一判定弹与不弹
 *       （设置开关 / 窗口焦点 / 最小化可见 / 失焦 8s 宽限）→ 点击通知回跳会话+输入框聚焦。
 * 覆盖：
 *   A. task-notify.cjs 纯函数真跑：决策矩阵 / 四种 kind 文案 / 截断 / 入参净化
 *   B. settings.cjs 行为真单测（mock electron）：taskCompleteNotifications 默认开/显式关落盘/保持
 *   C. 全链接线断言：main handler+blur 追踪+点击回跳 / preload 两 API / renderer 三上报点+群收工汇总
 *      + 会话标题单点维护 + 回跳接线 / index.html 开关 / 混淆名单
 *   D. 版本号 ≥ 3.41.0（宽松惯例：写死版本会在下次 bump 翻红本测试）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const mainSrc = read("src/main/main.cjs");
const preloadSrc = read("src/main/preload.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const indexSrc = read("src/renderer/index.html");
const settingsSrc = read("src/main/settings.cjs");
const obfSrc = read("scripts/obfuscate.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

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

// ════════════════ A. task-notify.cjs 纯函数真跑 ════════════════
async function runUnitTests() {
  const tn = require("./src/main/task-notify.cjs");

  await test("A1. 决策矩阵：窗口聚焦中不弹（正盯着看不打扰）", () => {
    const d = tn.decideTaskNotification({
      payload: { kind: "done", conversationTitle: "任务单", summary: "干完了" },
      windowState: { notificationAllowed: true, focused: true, minimized: false, visible: true, lastBlurAt: 0 },
      now: Date.now()
    });
    assert.strictEqual(d.show, false);
    assert.strictEqual(d.reason, "focused-on-window");
  });

  await test("A2. 决策矩阵：失焦超宽限期弹（刷抖音场景的核心提醒）", () => {
    const now = Date.now();
    const d = tn.decideTaskNotification({
      payload: { kind: "done", summary: "x" },
      windowState: { notificationAllowed: true, focused: false, minimized: false, visible: true, lastBlurAt: now - 20000 },
      now
    });
    assert.strictEqual(d.show, true);
    assert.strictEqual(d.reason, "window-unfocused");
  });

  await test("A3. 决策矩阵：刚失焦（8s 宽限内）不弹（用户切走一眼就回来）", () => {
    const now = Date.now();
    const d = tn.decideTaskNotification({
      payload: { kind: "done", summary: "x" },
      windowState: { notificationAllowed: true, focused: false, minimized: false, visible: true, lastBlurAt: now - 2000 },
      now
    });
    assert.strictEqual(d.show, false);
    assert.strictEqual(d.reason, "just-blurred");
  });

  await test("A4. 决策矩阵：从blur未追踪（lastBlurAt=0）失焦也弹", () => {
    const d = tn.decideTaskNotification({
      payload: { kind: "done", summary: "x" },
      windowState: { notificationAllowed: true, focused: false, minimized: false, visible: true, lastBlurAt: 0 },
      now: Date.now()
    });
    assert.strictEqual(d.show, true);
    assert.strictEqual(d.reason, "window-unfocused");
  });

  await test("A5. 决策矩阵：窗口最小化必弹", () => {
    const d = tn.decideTaskNotification({
      payload: { kind: "done", summary: "x" },
      windowState: { notificationAllowed: true, focused: true, minimized: true, visible: true, lastBlurAt: 0 },
      now: Date.now()
    });
    assert.strictEqual(d.show, true);
    assert.strictEqual(d.reason, "window-hidden-or-minimized");
  });

  await test("A6. 决策矩阵：窗口不可见必弹", () => {
    const d = tn.decideTaskNotification({
      payload: { kind: "done", summary: "x" },
      windowState: { notificationAllowed: true, focused: true, minimized: false, visible: false, lastBlurAt: 0 },
      now: Date.now()
    });
    assert.strictEqual(d.show, true);
    assert.strictEqual(d.reason, "window-hidden-or-minimized");
  });

  await test("A7. 决策矩阵：后台会话（force）即便聚焦也弹（切走后在别的会话聊天时后台任务完成）", () => {
    const d = tn.decideTaskNotification({
      payload: { kind: "done", summary: "x", force: true },
      windowState: { notificationAllowed: true, focused: true, minimized: false, visible: true, lastBlurAt: 0 },
      now: Date.now()
    });
    assert.strictEqual(d.show, true);
    assert.strictEqual(d.reason, "background-conversation");
  });

  await test("A8. 决策矩阵：设置关闭一律不弹且优先级最高", () => {
    const d = tn.decideTaskNotification({
      payload: { kind: "done", summary: "x", force: true },
      windowState: { notificationAllowed: false, focused: false, minimized: true, visible: false, lastBlurAt: 0 },
      now: Date.now()
    });
    assert.strictEqual(d.show, false);
    assert.strictEqual(d.reason, "notifications-disabled");
  });

  await test("A9. 文案：done=✅回话名+摘要", () => {
    const t = tn.notificationTitleBody({ kind: "done", conversationTitle: "超长任务单", summary: "改好了" });
    assert.match(t.title, /✅ 超长任务单 · AI 回复完成/);
    assert.strictEqual(t.body, "改好了");
  });

  await test("A10. 文案：error=⚠️失败+错误一行；ask=❓等回答；group=✅收工+成败计数", () => {
    const e = tn.notificationTitleBody({ kind: "error", conversationTitle: "会话A", summary: "连不上" });
    assert.match(e.title, /⚠️ 会话A · 任务执行失败/);
    assert.strictEqual(e.body, "连不上");
    const a = tn.notificationTitleBody({ kind: "ask", conversationTitle: "会话B", summary: "选哪种方案？" });
    assert.match(a.title, /❓ 会话B · AI 在等你的回答/);
    const g = tn.notificationTitleBody({ kind: "group", conversationTitle: "工作组X", totalMembers: 5, failedCount: 1 });
    assert.match(g.title, /✅ 群聊 工作组X · 本轮收工/);
    assert.strictEqual(g.body, "共 5 位成员：4 位完成，1 位失败");
    const g2 = tn.notificationTitleBody({ kind: "group", conversationTitle: "工作组X", totalMembers: 3, failedCount: 0 });
    assert.strictEqual(g2.body, "共 3 位成员回复完成");
    const g3 = tn.notificationTitleBody({ kind: "group", conversationTitle: "", totalMembers: 0 });
    assert.strictEqual(g3.body, "本轮群聊已收工");
  });

  await test("A11. 截断：超长摘要 160 截断带省略号；换行/连续空白合并为单空格", () => {
    const t = tn.notificationTitleBody({ kind: "done", summary: "文本\n和  很多   空白" });
    assert.strictEqual(t.body, "文本 和 很多 空白");
    const long = "x".repeat(200);
    const t2 = tn.notificationTitleBody({ kind: "done", summary: long });
    assert.strictEqual(t2.body.length, 161);
    assert.strictEqual(t2.body.endsWith("…"), true);
  });

  await test("A12. 净化：未知 kind 兜底 done / 标题超长截 24 / 空 summary 给兜底文案", () => {
    const t = tn.notificationTitleBody({ kind: "weird-junk", conversationTitle: "y".repeat(40), summary: "" });
    assert.match(t.title, /✅ /);
    assert.match(t.title, /y+… · AI 回复完成/);
    const empty = tn.notificationTitleBody({ kind: "done", summary: "" });
    assert.ok(empty.body.length > 0, "空摘要应有兜底文案");
    assert.ok(tn.sanitizeTaskNotifyPayload({ kind: "error", force: "yes" }).force === true);
  });
}

// ════════════════ B. settings.cjs 行为真单测（mock electron） ════════════════
async function runSettingsTests() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3410-"));
  const workdir = path.join(base, "userdata");
  fs.mkdirSync(workdir, { recursive: true });
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        app: { getPath: (name) => (name === "userData" ? workdir : path.join(base, name)), isPackaged: false, whenReady: async () => {} },
        safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v, "utf8"), decryptString: (buf) => buf.toString("utf8") }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(ROOT, "src/main/settings.cjs"))];
  const settings = require(path.join(ROOT, "src/main/settings.cjs"));
  Module._load = originalLoad;

  const cloudBase = { connectionMode: "cloud", cloudAiProvider: "zhipu", cloudAiModel: "glm-4.7-flash" };
  const settingsFile = () => path.join(workdir, "connection.json"); // settings.cjs SETTINGS_FILE 固定名

  await test("B1. 默认开：旧配置（字段缺省）getSettings 回 true", () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ connectionMode: "cloud", cloudAiProvider: "zhipu" }), "utf8");
    const s = settings.getSettings();
    assert.strictEqual(s.taskCompleteNotifications, true);
  });

  await test("B2. 显式关：saveSettings(false) 落盘并读回 false", () => {
    settings.saveSettings({ ...cloudBase, taskCompleteNotifications: false });
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    assert.strictEqual(raw.taskCompleteNotifications, false);
    assert.strictEqual(settings.getSettings().taskCompleteNotifications, false);
  });

  await test("B3. 保存不带字段：保持既有值不被重置", () => {
    settings.saveSettings({ ...cloudBase, taskCompleteNotifications: false });
    settings.saveSettings({ ...cloudBase });
    assert.strictEqual(settings.getSettings().taskCompleteNotifications, false);
    settings.saveSettings({ ...cloudBase, taskCompleteNotifications: true });
    settings.saveSettings({ ...cloudBase });
    assert.strictEqual(settings.getSettings().taskCompleteNotifications, true);
  });
}

// ════════════════ C. 全链接线断言 ════════════════
async function runWiringTests() {
  await test("C1. main.cjs：Notification 解构 + task-notify require + IPC handler 在位", () => {
    assert.ok(/\{\s*app, BrowserWindow, Notification,/, mainSrc, "electron 解构应含 Notification");
    assert.ok(/require\("\.\/task-notify\.cjs"\)/.test(mainSrc), "应 require task-notify.cjs");
    assert.ok(mainSrc.includes('"notify:task-complete"'), "notify:task-complete handler 缺失");
    assert.ok(/decideTaskNotification\(/.test(mainSrc), "应调用决策矩阵");
    assert.ok(/^let lastWindowBlurAt = 0;/m.test(mainSrc), "失焦时刻变量在位");
  });

  await test("C2. main.cjs：blur 追踪 + click 回跳三动作 + activated 广播 + skip/日志", () => {
    assert.ok(/window\.on\("blur"/.test(mainSrc), "窗口失焦追踪缺失");
    assert.ok(/lastWindowBlurAt = Date\.now\(\)/.test(mainSrc), "失焦时刻应记录");
    const handler = mainSrc.slice(mainSrc.indexOf('"notify:task-complete"'));
    assert.ok(handler.includes("notification.on(\"click\""), "通知点击监听缺失");
    assert.ok(handler.includes("window.isMinimized()) window.restore()"), "点击应还原最小化窗口");
    assert.ok(handler.includes("window.show()"), "点击应 show");
    assert.ok(handler.includes("window.focus()"), "点击应聚焦");
    assert.ok(handler.includes('"notify:activated"'), "点击应广播回跳事件");
    assert.ok(handler.includes("notification.show()"), "通知应 show");
    assert.ok(handler.includes("task_notify_skipped"), "不弹应有日志");
    assert.ok(handler.includes("task_notify_shown"), "弹出应有日志");
    assert.ok(handler.includes("taskCompleteNotifications !== false"), "设置开关判定缺失");
  });

  await test("C3. preload.cjs：两 API（上报 + 点击回跳监听）", () => {
    assert.ok(preloadSrc.includes("notifyTaskComplete"), "notifyTaskComplete API 缺失");
    assert.ok(preloadSrc.includes('"notify:task-complete"'), "上报通道缺失");
    assert.ok(preloadSrc.includes("onTaskNotificationActivated"), "回跳监听 API 缺失");
    assert.ok(preloadSrc.includes('"notify:activated"'), "回跳事件通道缺失");
  });

  await test("C4. renderer.js：reportTaskNotify 上报 helper 与单聊快照（发起会话身份防切走标错）", () => {
    assert.ok(/function reportTaskNotify\(/.test(rendererSrc), "上报 helper 缺失");
    assert.ok(rendererSrc.includes("window.agentChatPro.notifyTaskComplete"), "上报调用缺失");
    assert.ok(/const turnConversationId = streamingConversationId;/.test(rendererSrc), "发起会话 id 快照缺失");
    assert.ok(/const turnTitle = conversationTitle;/.test(rendererSrc), "发起会话标题快照缺失");
    assert.ok(/force: turnConversationId !== conversationId/.test(rendererSrc), "后台会话判定缺失（应基于发起会话快照）");
    assert.ok(rendererSrc.includes("summary: String(input.summary || \"\").slice(0, 400)"), "摘要应渲染层先截断");
  });

  await test("C5. renderer.js：三上报点（done/error/ask）齐全且取消分支不上报", () => {
    assert.ok(/kind: "done",/.test(rendererSrc), "成功上报点缺失");
    assert.ok(/kind: "error",/.test(rendererSrc), "失败上报点缺失");
    assert.ok(/kind: "ask",/.test(rendererSrc), "AI 提问悬等上报点缺失");
    const cancelledStart = rendererSrc.indexOf("if (result.cancelled)");
    const donePoint = rendererSrc.indexOf('kind: "done"');
    assert.ok(cancelledStart > 0 && donePoint > cancelledStart, "成功点应在取消分支之后（取消路径不得误报）");
    // ask 上报挂实时事件路径（历史重放不触发事件=天然防误弹）
    const askPoint = rendererSrc.indexOf('kind: "ask"');
    assert.ok(askPoint > rendererSrc.indexOf('event.type === "ask-user"'), "ask 上报应挂 ask-user 实时事件路径");
  });

  await test("C6. renderer.js：群聊全员收工汇总（v3.42.0 对齐：groupSendState 逐轮累计 + settled 收口上报）", () => {
    // v3.42.0 启动即返重构：悬等收集从 sendGroupTurn 的 Promise.all 移交 ensureGroupTurnBubble 内部
    // awaitGroupTurn 注册；成败计数改 checkGroupSendSettle 收口时从 groupSendState（逐轮 finalize 累计）上报
    assert.ok(!/const groupTurnResults = \(result\.turns \|\| \[\]\)\.map\(/.test(rendererSrc), "旧悬等收集应已移除（移交 ensureGroupTurnBubble）");
    assert.ok(!/Promise\.all\(groupTurnResults\)\.then\(\(settled\) =>/.test(rendererSrc), "旧 Promise.all 收工应已移除（移交 checkGroupSendSettle）");
    assert.ok(/kind: "group",/.test(rendererSrc), "group 上报缺失");
    assert.ok(/totalMembers: state\.total,/.test(rendererSrc), "成员总数未上报（逐轮累计）");
    assert.ok(/failedCount: state\.failed/.test(rendererSrc), "失败计数未上报（逐轮累计）");
  });

  await test("C7. renderer.js：会话标题单点维护（load/列表两分支/回首页置空）", () => {
    assert.ok(/^let conversationTitle = "";/m.test(rendererSrc), "conversationTitle 声明缺失");
    assert.ok(/conversationTitle = conversation\.title \|\| "";/.test(rendererSrc), "loadConversation 应赋值");
    assert.ok(/conversationTitle = conv\.title;/.test(rendererSrc), "搜索分支列表刷新同步缺失");
    assert.ok(/conversationTitle = conversation\.title;/.test(rendererSrc), "普通分支列表刷新同步缺失");
    assert.ok(rendererSrc.includes('conversationTitle = "";'), "回首页应置空标题");
  });

  await test("C8. renderer.js：点击通知回跳接线（切回会话+聚焦输入框）", () => {
    assert.ok(/window\.agentChatPro\.onTaskNotificationActivated/.test(rendererSrc), "回跳监听接线缺失");
    const hook = rendererSrc.slice(rendererSrc.indexOf("onTaskNotificationActivated"));
    assert.ok(hook.includes("loadConversation(targetId)"), "回跳应切回对应会话");
    assert.ok(hook.includes("focusPrompt()"), "回跳应聚焦输入框（直接打字续聊）");
  });

  await test("C9. settings/index.html/混淆名单：开关键四面在位", () => {
    assert.ok(/taskCompleteNotifications: raw\.taskCompleteNotifications === undefined \? true : Boolean\(raw\.taskCompleteNotifications\)/.test(settingsSrc), "getSettings 归一缺失（默认开）");
    assert.ok(/taskCompleteNotifications/.test(settingsSrc), "saveSettings 白名单缺失");
    assert.ok(indexSrc.includes('name="taskCompleteNotifications"'), "设置开关控件缺失");
    assert.ok(rendererSrc.includes('namedItem("taskCompleteNotifications")'), "设置回填缺失");
    assert.ok(rendererSrc.includes('taskCompleteNotifications: data.get("taskCompleteNotifications") === "on"'), "保存载荷缺失");
    assert.ok(obfSrc.includes("main/task-notify.cjs"), "task-notify.cjs 应登记混淆名单");
  });
}

// ════════════════ D. 版本 ════════════════
async function runVersionTests() {
  await test("D1. 版本号 ≥ 3.41.0（宽松惯例）", () => {
    const toNumber = (v) => Number(String(v || "").split(".").map((n) => String(Number(n)).padStart(4, "0")).join("")) || 0;
    assert.ok(toNumber(pkg.version) >= toNumber("3.41.0"), `当前版本 ${pkg.version}`);
  });
}

(async () => {
  console.log("\n── A. task-notify 纯函数真跑 ──");
  await runUnitTests();
  console.log("\n── B. settings.cjs 行为真单测 ──");
  await runSettingsTests();
  console.log("\n── C. 全链接线断言 ──");
  await runWiringTests();
  console.log("\n── D. 版本 ──");
  await runVersionTests();
  console.log(`\n${passed} 项通过, ${failed} 项失败`);
  if (failed > 0) { failures.forEach((f) => console.log(`✗ ${f}`)); process.exit(1); }
  console.log(`test-v3-41-0: ${passed} 项全绿`);
})().catch((error) => { console.error(error); process.exit(1); });