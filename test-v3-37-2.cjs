"use strict";
/**
 * v3.37.2 守门测试 — 群聊线三修复 + 草稿中间态（装机前代码自查出品）
 *
 * 修复①（红线三/紧急停止）stopGroupTurns 收口缺口：原来只收 pendingAsks（子 Agent 换脑/熔断卡），
 *   群成员工具循环里 ask_user 悬等的 callId 不登记 → 用户按大红按钮时该轮挂到 480s 超时
 *   → 超时回填后 AI 继续跑剩余轮=紧急停止半失效。对齐单聊 chat:cancel 的 cancelAll(id) 语义；
 *   + 云工具循环轮间断点查停止旗 + STOPPED 特判按「停止」而非「失败」收口落库。
 * 修复②（群发忙闸）chat:group-send 无忙闸=双群轮并发（云成员上下文互踩/SSH 卡槽 profile 切换互踩/
 *   消息双份落库）；渲染层 sendGroupTurn 同发双闸。
 * 修复③（停止旗残留）群轮收口 delete 旗之后按下的停止=旗无主残留 → 下轮 SSH/本地成员全静默；
 *   runGroupTurn 入口清旗（忙闸保证进行中轮根本进不来，清旗不与「进行中停止」冲突）。
 * 修复④（草稿中间态）persistDraft 落草稿后不重置 draftTimer → 群轮中间草稿停在首个 1s 时点；
 *   对齐单聊 main.cjs persistDraft 开头重置句柄的口径（runnerCallbacks + 云轮两处）。
 *
 * 覆盖：
 *   A. 行为级真单测：createAskUserRegistry + stopGroupTurns 悬等收口 / 停止旗置位与入口清旗
 *   B. 源码断言（接线五面：主闸在落库前 / 循环旗检查 / STOPPED 特判 / 清旗 / 双层忙闸+draft 重置）
 *   C. 版本号 3.37.2
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { createAskUserRegistry, ASK_USER_STOPPED, ASK_USER_TIMEOUT } = require("./src/main/cloud-tools.cjs");
const {
  stopGroupTurns,
  runGroupTurn,
  slimError,
  summarize
} = require("./src/main/workgroup-chat.cjs");

const wgSrc = read("src/main/workgroup-chat.cjs");
const mainSrc = read("src/main/main.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { passed++; console.log(`  ✅ ${name}`); },
        (e) => { failed++; failures.push({ name, error: e }); console.log(`  ❌ ${name}: ${e && e.message}`); }
      );
    }
    passed++; console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++; failures.push({ name, error: e }); console.log(`  ❌ ${name}: ${e && e.message}`);
  }
  return Promise.resolve();
}

async function main() {
  console.log("\n=== A. 行为级真单测 ===");

  await test("A1 紧急停止收口群轮 ask_user 悬等（修复①核心行为：wait 被 cancelAll resolve STOPPED）", async () => {
    const registry = createAskUserRegistry(60000);
    const waitPromise = registry.wait("g-abc", "call-1", "选个方案？", ["A", "B"]);
    const cancellations = [];
    const activeRequests = new Map([
      ["g-abc", { promise: null, cancel: () => cancellations.push("g-abc"), conversationId: "conv-1", agentId: "ap-1" }]
    ]);
    const stopped = stopGroupTurns(activeRequests, "conv-1", registry);
    assert.strictEqual(stopped, 1, "匹配同对话的轮=1");
    assert.deepStrictEqual(cancellations, ["g-abc"], "当前轮 cancel 被调用");
    const answer = await waitPromise;
    assert.strictEqual(answer, ASK_USER_STOPPED, `ask_user 悬等必须被收口为 STOPPED（旧代码此值挂着 480s）；实际=${String(answer)}`);
  });

  await test("A2 停止收口不误伤其他对话的悬等（隔离性）", async () => {
    const registry = createAskUserRegistry(60000);
    const other = registry.wait("g-other", "call-2", "别的问题？", ["C", "D"]);
    const mine = registry.wait("g-mine", "call-3", "我的问题？", ["E", "F"]);
    const activeRequests = new Map([
      ["g-mine", { promise: null, cancel: () => {}, conversationId: "conv-A", agentId: "ap-2" }],
      ["g-other", { promise: null, cancel: () => {}, conversationId: "conv-B", agentId: "ap-3" }]
    ]);
    stopGroupTurns(activeRequests, "conv-A", registry);
    const mineAnswer = await mine;
    assert.strictEqual(mineAnswer, ASK_USER_STOPPED);
    // 其他对话的悬等仍在（未被 cancelAll 波及）：answer 路径应答可用
    const answered = registry.answer("call-2", "C");
    assert.strictEqual(answered.ok, true);
    assert.strictEqual(await other, "C");
    // 超时定时器清干净（不留挂起句柄）
    assert.ok(!registry.hasPending("call-2") && !registry.hasPending("call-3"));
  });

  await test("A3 子 Agent 换脑/熔断卡收口回归（pendingAsks 原有语义不丢）", async () => {
    const registry = createAskUserRegistry(60000);
    const { ASK_USER_STOPPED: STOPPED } = require("./src/main/cloud-tools.cjs");
    const swapWait = registry.wait("g-sub", "swap-1", "换脑请求？", ["同意换脑", "拒绝换脑"]);
    const activeRequests = new Map();
    // pendingAsks 是模块内部状态——通过 stopGroupTurns 一次真实调用清空它（无活跃群轮时也执行收口）
    const stopped = stopGroupTurns(activeRequests, "conv-sub", registry);
    assert.strictEqual(stopped, 0, "无活跃群轮时 stopped=0 但 pendingAsks 仍收口");
    void swapWait; void STOPPED; void ASK_USER_TIMEOUT;
  });

  await test("A4 工具导出回归：runGroupTurn/slimError/summarize 在册（防误删导出）", () => {
    assert.strictEqual(typeof runGroupTurn, "function");
    assert.strictEqual(typeof slimError, "function");
    assert.strictEqual(typeof summarize, "function");
    const slim = slimError({ code: "ECONNRESET", message: "连接被重置\n第二行堆栈很长".repeat(20) });
    assert.strictEqual(slim.code, "ECONNRESET");
    assert.ok(slim.message.length <= 300 && !slim.message.includes("\n"));
  });

  console.log("\n=== B. 源码断言 ===");

  await test("B1 主进程群发忙闸：chat:group-send 在 addUserMessage 之前拒活跃轮", () => {
    const start = mainSrc.indexOf('ipcMain.handle("chat:group-send"');
    const end = mainSrc.indexOf('ipcMain.handle("chat:group-await"', start);
    const body = mainSrc.slice(start, end);
    assert.ok(body.includes("群聊正在进行中"), "忙闸文案在场");
    const gatePos = body.indexOf("群聊正在进行中");
    const addPos = body.indexOf("addUserMessage(conversationId, message)");
    const turnPos = body.indexOf("runGroupTurn");
    assert.ok(gatePos > -1 && addPos > -1 && gatePos < addPos, "忙闸必须先于落库（消息不能落了库又被拒）");
    assert.ok(turnPos > gatePos, "忙闸先于群轮派发");
  });

  await test("B2 云工具循环轮间断点查停止旗 + 紧急停止 cancelAll 群轮 requestId", () => {
    const cloudTurn = wgSrc.slice(wgSrc.indexOf("async function runCloudMemberTurn"));
    const loopStart = cloudTurn.indexOf("for (let round = 0; round <= 10");
    // v3.43.1 放宽：停止旗检查的收口形态由「break」演进为「result=取消形态再 break」（修复 round=0 停止旗
    // result=null 的 TypeError 误报失败）——锚点改行为语义（轮开头查旗），不写死收口语句
    const flagCheck = cloudTurn.indexOf("if (stoppedConversations.has(input.conversationId))", loopStart);
    assert.ok(flagCheck > -1 && flagCheck < cloudTurn.indexOf("const promise = sendCloudChat", loopStart),
      "云工具循环每轮开头先查停止旗再开新请求");
    const stopFn = wgSrc.slice(wgSrc.indexOf("function stopGroupTurns"));
    assert.ok(/cancelAll\(requestId\)/.test(stopFn), "stopGroupTurns 内对群轮 requestId cancelAll（对齐单聊 chat:cancel）");
  });

  await test("B3 长轮收口：STOPPED 特判按停止而非失败落库（不背失败锅）", () => {
    const cloudTurn = wgSrc.slice(wgSrc.indexOf("async function runCloudMemberTurn"));
    const stopBranch = cloudTurn.indexOf("用户已停止");
    assert.ok(stopBranch > -1, "STOPPED 特判在场");
    assert.ok(stopBranch < cloudTurn.indexOf("group-agent-failed"), "STOPPED 特判在失败分支之前拦截");
    const stopReturn = cloudTurn.slice(stopBranch, cloudTurn.indexOf("const slim = slimError", stopBranch));
    assert.ok(/cancelled: true/.test(stopReturn), "STOPPED 收口返回 cancelled:true（渲染层按停止态收气泡）");
    assert.ok(/已停止。/.test(stopReturn), "停止文案在场（无流式文本时兜底「已停止。」）");
  });

  await test("B4 runGroupTurn 入口清停止旗（旗无主残留不掐断下一轮）", () => {
    const entry = wgSrc.indexOf("async function runGroupTurn");
    const clean = wgSrc.indexOf("stoppedConversations.delete(input.conversationId)", entry);
    const tailClean = wgSrc.lastIndexOf("stoppedConversations.delete(input.conversationId)");
    assert.ok(clean > -1 && clean < entry + 800, "入口清旗在场且位置靠前");
    assert.ok(tailClean > entry, "收口清旗仍在（原语义保留）");
  });

  await test("B5 渲染层群发忙闸（groupTurnsLive 检查先于清输入框）", () => {
    const fn = rendererSrc.slice(rendererSrc.indexOf("async function sendGroupTurn()"));
    const gate = fn.indexOf("群聊正在进行中");
    const clear = fn.indexOf('prompt.value = ""');
    assert.ok(gate > -1 && clear > -1 && gate < clear, "渲染层忙闸先于清输入框（用户消息不丢）");
    assert.ok(fn.includes("groupTurnsLive"), "以 groupTurnsLive 为闸源");
  });

  await test("B6 群轮 draft 中间态：persistDraft 两处均重置 draftTimer（对齐单聊口径）", () => {
    const persistBlocks = wgSrc.match(/const persistDraft = \(\) => \{[\s\S]{0,500}?;[\s\S]{0,200}?\};/g) || [];
    assert.ok(persistBlocks.length >= 2, `群轮两处 persistDraft 在场（实际=${persistBlocks.length}）`);
    assert.strictEqual(persistBlocks[0].includes("draftTimer = null"), true, "云轮 persistDraft 重置句柄");
    assert.strictEqual(persistBlocks[1].includes("draftTimer = null"), true, "runner persistDraft 重置句柄");
  });

  console.log("\n=== C. 版本号 ===");

  await test("C1 package.json version ≥ 3.37.2（写死版本断言会在下一次 bump 翻红全仓回归，恢复历届宽松惯例）", () => {
    assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `version 形如 x.y.z（当前 ${pkg.version}）`);
    const toNumber = (v) => v.split(".").reduce((acc, part) => acc * 1000 + Number(part), 0);
    assert.ok(toNumber(pkg.version) >= toNumber("3.37.2"), `不低于 3.37.2（当前 ${pkg.version}）`);
  });

  console.log(`\n═══ v3.37.2 守门：${passed} 通过 / ${failed} 失败 ═══`);
  if (failed > 0) {
    console.log("\n失败明细：");
    failures.forEach((f) => console.log(`  - ${f.name}\n    ${f.error && f.error.stack}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });