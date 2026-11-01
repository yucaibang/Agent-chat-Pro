"use strict";
/**
 * Bridge Edition（阉割版）测试 — Agent HTTP 桥 + 云端AI标记 + 门控三件套
 * 覆盖：
 *   A. edition.cjs 形态定义（主版默认 + BRIDGE_EDITION + gates 精确集合 + editionFor）
 *   B. 云端AI标记（CLOUD_AI_TAG / applyCloudAiMarking）
 *   C. main.cjs / preload.cjs / conversations.cjs / settings.cjs / renderer.js 接线（源码断言）
 *   D. settings + conversations 真单测（Module._load electron mock）：senderType 落库 / Token 往返 / 桥配置直写
 *   E. agent-http-bridge.cjs 真 HTTP 单测（127.0.0.1 全链路：token/Origin/限频/长度/闸门/放行/拒绝/终态回报）
 *   F. renderer.js vm 假 DOM 冒烟（徽章 / 放行队列渲染 / 门控隐藏 / 桥设置卡回填 / 忙碌回报 / 监听器注册）
 *   G. 构建管线 bridge 目标（形态覆写 / exe 与清单随形态 / 混淆名单 / fuse 环境变量 / npm script）
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const Module = require("module");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { createAgentHttpBridge, CLOUD_AI_TAG, applyCloudAiMarking } = require("./src/main/agent-http-bridge.cjs");
const mainSrc = read("src/main/main.cjs");
const preloadSrc = read("src/main/preload.cjs");
const settingsSrc = read("src/main/settings.cjs");
const conversationsSrc = read("src/main/conversations.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const htmlSrc = read("src/renderer/index.html");
const stylesSrc = read("src/renderer/styles.css");
const pipelineSrc = read("scripts/build-pipeline.cjs");
const fusesSrc = read("scripts/set-fuses.cjs");
const obfuscateSrc = read("scripts/obfuscate.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let passed = 0;
let failed = 0;
const failures = [];

// vm 假 DOM 装置的兜底防线：boot IIFE 若有未捕获拒绝（装置形状漂移），显性失败而非静默
let unhandledRejection = null;
process.on("unhandledRejection", (error) => {
  unhandledRejection = error;
  console.error("  ⚠️ unhandledRejection（装置形状漂移或 vm boot 路径溢出）:", (error && error.stack) || error);
});

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
    .catch((error) => { failed += 1; failures.push(`  ✗ ${name}\n    ${error.message}`); console.log(`  ✗ ${name}`); });
}

function httpJSON(method, port, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(headers || {}) } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* 非 JSON 容错 */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("HTTP 请求超时")));
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function main() {
  // ════════════════ A. edition.cjs 形态定义 ════════════════
  console.log("\n=== A. edition.cjs 形态定义 ===");
  const edition = require("./src/main/edition.cjs");

  await test("A1. 提交态默认为主版形态（main + productName + agentBridge:false）", () => {
    assert.strictEqual(edition.edition, "main");
    assert.strictEqual(edition.productName, "Agent Chat Pro");
    assert.strictEqual(edition.gates.agentBridge, false, "主版不注册 HTTP 桥");
    assert.strictEqual(edition.gates.deviceLink, true);
    assert.strictEqual(edition.gates.printLink, true);
    assert.strictEqual(edition.gates.localEngines, true);
    assert.strictEqual(edition.gates.easterEgg, true);
  });

  await test("A2. BRIDGE_EDITION 定义完整（阉割项全关 + 桥开 + 命名隔离）", () => {
    const b = edition.BRIDGE_EDITION;
    assert.strictEqual(b.edition, "bridge");
    assert.strictEqual(b.productName, "Agent Chat Pro Bridge");
    assert.strictEqual(b.gates.agentBridge, true);
    assert.strictEqual(b.gates.deviceLink, false, "设备联动阉割");
    assert.strictEqual(b.gates.printLink, false, "打印联动阉割");
    assert.strictEqual(b.gates.localEngines, false, "本机引擎阉割");
    assert.strictEqual(b.gates.easterEgg, false, "彩蛋阉割");
    assert.strictEqual(b.gates.cloudChat, true, "云端模式保留");
    assert.strictEqual(b.gates.signalLights, true);
  });

  await test("A3. editionFor 覆写感知（bridge 入参 → bridge 对象）", () => {
    const result = edition.editionFor("bridge");
    assert.strictEqual(result.edition, "bridge");
    assert.strictEqual(edition.editionFor("main").edition, "main");
    assert.strictEqual(edition.editionFor("unknown").edition, "main", "未知值落主版");
  });

  // ════════════════ B. 云端AI标记 ════════════════
  console.log("\n=== B. 云端AI标记 ===");

  await test("B1. CLOUD_AI_TAG 精确文本（防误判的字面前缀）", () => {
    assert.strictEqual(CLOUD_AI_TAG, "【云端AI消息 · 非用户本人】");
  });

  await test("B2. applyCloudAiMarking 拼接形态（前缀+换行+正文）", () => {
    assert.strictEqual(applyCloudAiMarking("你好"), `${CLOUD_AI_TAG}\n你好`);
    assert.strictEqual(applyCloudAiMarking(null), `${CLOUD_AI_TAG}\n`);
  });

  await test("B3. main.cjs 主进程强制标记 + 幂等（startsWith 防双前缀）+ senderType 落库", () => {
    assert.ok(mainSrc.includes('input.senderType === "cloud-ai" ? "cloud-ai"'), "senderType 白名单");
    assert.ok(mainSrc.includes("!rawMessage.startsWith(CLOUD_AI_TAG)"), "标记幂等检查在场");
    assert.ok(mainSrc.includes("addUserMessage(input.conversationId, message, attachments.map((file) => file.name), senderType)"), "落库携带 senderType");
  });

  // ════════════════ C. 接线（源码断言） ════════════════
  console.log("\n=== C. 接线断言 ===");

  await test("C1. main.cjs：edition 装载 + app:edition IPC + bridge 形态分支", () => {
    assert.ok(mainSrc.includes('require("./edition.cjs")'), "edition.cjs 引入");
    assert.ok(mainSrc.includes('const IS_BRIDGE = EDITION.edition === "bridge"'), "IS_BRIDGE");
    // v3.37.1：handler 改回三字段纯数据（EDITION 整包含 editionFor 函数 → 结构化克隆拒，锚点随修复演进）
    assert.ok(mainSrc.includes('ipcMain.handle("app:edition"'), "app:edition handler");
    assert.ok(!/ipcMain\.handle\("app:edition", \(\) => EDITION\)/.test(mainSrc), "app:edition 不得裸返 EDITION 整包（克隆拒悬账）");
    assert.ok(mainSrc.includes('IS_BRIDGE ? "com.jiang.agentChatProBridge" : "com.jiang.agentChatPro"'), "appId 双形态");
    assert.ok(mainSrc.includes("EDITION.gates.agentBridge"), "桥注册有形态门");
  });

  await test("C2. main.cjs：agentBridge:* 全套 handler + set-config 先 stop 再 start（换端口生效）", () => {
    for (const channel of ["agentBridge:info", "agentBridge:approve", "agentBridge:reject", "agentBridge:report", "agentBridge:set-config", "agentBridge:set-target"]) {
      assert.ok(mainSrc.includes(`"${channel}"`), `${channel} 注册`);
    }
    assert.ok(/set-config[\s\S]{0,400}agentBridgeInstance\.stop\(\)[\s\S]{0,200}agentBridgeInstance\.start\(\)/.test(mainSrc), "set-config 先 stop 再 start");
  });

  await test("C3. main.cjs：print:* 门控 + chat:test-proxy 注册未失（回归防线）", () => {
    assert.ok(mainSrc.includes("EDITION.gates.printLink"), "print handler 有形态门");
    assert.ok(mainSrc.includes('ipcMain.handle("chat:test-proxy"'), "chat:test-proxy 注册仍在");
  });

  await test("C4. preload.cjs：agentBridge 桥面暴露（7 个方法 + 2 个事件）", () => {
    for (const method of ["getAgentBridgeInfo", "approveAgentBridgeMessage", "rejectAgentBridgeMessage", "reportAgentBridgeResult", "setAgentBridgeConfig", "setAgentBridgeTarget", "getEdition"]) {
      assert.ok(preloadSrc.includes(`${method}:`), `${method} 暴露`);
    }
    assert.ok(preloadSrc.includes('onAgentBridgeQueue: (handler) => ipcRenderer.on("agentBridge:queue"'), "队列事件");
    assert.ok(preloadSrc.includes('onAgentBridgeTurn: (handler) => ipcRenderer.on("agentBridge:turn-start"'), "回合事件");
  });

  await test("C5. conversations.cjs：addUserMessage 带可选 senderType（向后兼容）", () => {
    assert.ok(conversationsSrc.includes("function addUserMessage(id, text, attachmentNames = [], senderType = \"\")"), "可选参数形态");
    assert.ok(conversationsSrc.includes("if (senderType) message.senderType = senderType;"), "条件落字段");
  });

  await test("C6. settings.cjs：桥四函数 + saveSettings 透传（Token 字段防抹）", () => {
    for (const name of ["normalizeAgentBridgePort", "ensureAgentBridgeToken", "getAgentBridgeConversationId", "setAgentBridgeConversationId", "setAgentBridgeConfig"]) {
      assert.ok(settingsSrc.includes(`function ${name}(`), `${name} 定义`);
    }
    assert.ok(settingsSrc.includes("agentBridgePort: normalizeAgentBridgePort(raw.agentBridgePort)"), "getSettings 出参");
    assert.ok(settingsSrc.includes("agentBridgeTokenEncrypted: previous.agentBridgeTokenEncrypted || \"\""), "saveSettings 白名单透传加密 Token");
    // v3.40.0：exports 清单新增 clearModelAdminPassword（重置兜底）——整串匹配会随每次加导出翻红，改逐项存在断言
    const exportsLine = settingsSrc.slice(settingsSrc.indexOf("module.exports ="));
    for (const name of ["getConnection", "getSettings", "getAtomcodeToken", "getSshConnection", "getCloudAiConfig", "modelAdminPasswordState", "normalizeSshProfileId", "saveSettings", "setModelAdminPassword", "switchSshProfile", "trustHostFingerprint", "verifyModelAdminPassword", "ensureAgentBridgeToken", "getAgentBridgeConversationId", "setAgentBridgeConversationId", "setAgentBridgeConfig", "normalizeAgentBridgePort", "clearModelAdminPassword"]) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(exportsLine), `exports 含 ${name}`);
    }
  });

  await test("C7. renderer.js：终态四路回报 + 桥回合 + 队列渲染 + 门控", () => {
    for (const snippet of [
      "reportBridgeResult(\"failed\", { error: \"应用正忙：另一轮对话正在进行中，稍后可重发。\" })",
      "reportBridgeResult(\"cancelled\", { reply: partial || \"\" })",
      "reportBridgeResult(\"done\", { reply: result.text || \"\" })",
      "reportBridgeResult(\"failed\", { error: error.message })",
      "async function runBridgeTurn(turn)",
      "window.agentChatPro?.onAgentBridgeTurn?.((turn) => runBridgeTurn(turn))",
      "function renderBridgeQueue(queue = [])",
      "window.agentChatPro?.onAgentBridgeQueue?.",
      "async function applyEdition()",
      "(await window.agentChatPro.getEdition?.()) || editionState",
      "senderType: viaBridge ? \"cloud-ai\" : \"\"",
      "meta.senderType === \"cloud-ai\"",
      "🤖 云端AI发送 · 非用户本人"
    ]) {
      assert.ok(rendererSrc.includes(snippet), `片段在场: ${snippet.slice(0, 48)}…`);
    }
  });

  await test("C8. index.html：放行队列 + 桥设置卡 + 标记说明文案", () => {
    assert.ok(htmlSrc.includes('<section id="bridge-queue" class="bridge-queue" hidden>'), "队列容器");
    assert.ok(htmlSrc.includes('<details id="agentbridge-settings" hidden>'), "桥设置卡（默认隐藏）");
    assert.ok(htmlSrc.includes('id="agentbridge-port"'), "端口输入");
    assert.ok(htmlSrc.includes('id="agentbridge-gate"'), "放行闸勾选");
    assert.ok(htmlSrc.includes('id="agentbridge-token"'), "Token 展示");
    assert.ok(htmlSrc.includes("【云端AI消息 · 非用户本人】"), "标记文案告知用户");
  });

  await test("C9. styles.css：徽章 + 队列 + 按钮双主题", () => {
    for (const sel of [".cloudai-badge", ".bridge-queue", ".bridge-queue-card", ".bridge-approve", ".bridge-reject", '[data-theme="light"] .bridge-approve']) {
      assert.ok(stylesSrc.includes(sel), `样式在场: ${sel}`);
    }
  });

  await test("C10. agent-http-bridge.cjs：回环校验 + Origin 拒绝 + 回环绑定", () => {
    const bridgeSrc = read("src/main/agent-http-bridge.cjs");
    assert.ok(bridgeSrc.includes('["127.0.0.1", "::1", "::ffff:127.0.0.1"]'), "remoteAddress 回环白名单");
    assert.ok(bridgeSrc.includes("req.headers.origin"), "Origin 头拒绝");
    assert.ok(bridgeSrc.includes('server.listen(port, "127.0.0.1"'), "仅回环监听");
    assert.ok(bridgeSrc.includes("timingSafeEqual"), "Token 恒时比较");
    assert.ok(bridgeSrc.includes("MAX_TEXT_LENGTH = 8000"), "长度上限");
  });

  // ════════════════ D. settings + conversations 真单测 ════════════════
  console.log("\n=== D. settings + conversations 真单测（electron mock） ===");

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bridge-test-"));
  const originalLoad = Module._load;
  // ⚠️ addUserMessage/update() 系列返回「对话」而非「消息」——断言一律走 getConversation 落库读回
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => workdir, whenReady: async () => {} },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (text) => Buffer.from(`M0CK:${String(text)}`),
          decryptString: (buffer) => {
            const text = Buffer.from(buffer).toString("utf8");
            if (!text.startsWith("M0CK:")) throw new Error("not encrypted");
            return text.slice(5);
          }
        }
      };
    }
    if (request === "./settings.cjs") {
      return { getSettings: () => ({ dataDirectory: workdir }) };
    }
    return originalLoad.apply(this, arguments);
  };
  const conversations = require("./src/main/conversations.cjs");
  const settingsModule = require("./src/main/settings.cjs");
  Module._load = originalLoad;

  await test("D1. addUserMessage senderType=cloud-ai 落库；不传时不写字段（存量兼容）", () => {
    const conv = conversations.createConversation();
    conversations.addUserMessage(conv.id, "云端AI的问题", [], "cloud-ai");
    conversations.addUserMessage(conv.id, "用户本人消息");
    const stored = conversations.getConversation(conv.id).messages;
    assert.strictEqual(stored[0].senderType, "cloud-ai");
    assert.strictEqual(stored[1].senderType, undefined, "普通消息不写字段");
  });

  await test("D2. ensureAgentBridgeToken：48 位 hex、二次取用同值（加密落盘往返）", () => {
    const token = settingsModule.ensureAgentBridgeToken();
    assert.ok(/^[0-9a-f]{48}$/.test(token), `48 位 hex，实际: ${token.slice(0, 8)}…`);
    assert.strictEqual(settingsModule.ensureAgentBridgeToken(), token, "二次取用不重新生成");
  });

  await test("D3. setAgentBridgeConfig 直写（未经 saveSettings 校验）+ 端口归一化", () => {
    const applied = settingsModule.setAgentBridgeConfig({ port: 24100, gate: false });
    assert.strictEqual(applied.agentBridgePort, 24100);
    assert.strictEqual(applied.agentBridgeGate, false);
    assert.strictEqual(settingsModule.getSettings().agentBridgePort, 24100);
    assert.strictEqual(settingsModule.getSettings().agentBridgeGate, false);
    // 非法端口 → 回默认 21774；gate 不传 → 不动
    settingsModule.setAgentBridgeConfig({ port: 80 });
    assert.strictEqual(settingsModule.getSettings().agentBridgePort, 21774, "低端口非法回默认");
    assert.strictEqual(settingsModule.getSettings().agentBridgeGate, false, "gate 未传不动");
  });

  await test("D4. getSettings 出参：未配置时 gate 默认 true（人工放行默认开）", () => {
    const workdirB = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bridge-default-"));
    Module._load = function (request, parent, isMain) {
      if (request === "electron") {
        return {
          app: { getPath: () => workdirB, whenReady: async () => {} },
          safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (text) => Buffer.from(`M0CK:${String(text)}`),
            decryptString: (buffer) => Buffer.from(buffer).toString("utf8").slice(5)
          }
        };
      }
      return originalLoad.apply(this, arguments);
    };
    try {
      delete require.cache[require.resolve("./src/main/settings.cjs")];
      const fresh = require("./src/main/settings.cjs");
      assert.strictEqual(fresh.getSettings().agentBridgeGate, true, "默认开闸");
      assert.strictEqual(fresh.getSettings().agentBridgePort, 21774, "默认端口");
    } finally {
      Module._load = originalLoad;
    }
  });

  // ════════════════ E. 真 HTTP 桥单测 ════════════════
  console.log("\n=== E. agent-http-bridge.cjs 真 HTTP 单测 ===");

  const instances = [];
  async function startBridge(deps = {}) {
    const bridge = createAgentHttpBridge({ tokenProvider: () => "tok123", getGate: () => true, getPort: () => 0, ...deps });
    const started = await bridge.start();
    assert.ok(started.ok, `桥启动失败: ${started.error || ""}`);
    assert.ok(started.port > 0, `端口 0 应被系统自动分配，实际: ${started.port}`);
    instances.push(bridge);
    return { bridge, port: started.port };
  }
  const send = (port, text, extra = {}) => httpJSON("POST", port, "/api/send", { body: { text, token: "tok123", ...extra } });

  await test("E1. GET /health 免 token → bridge 形态自报", async () => {
    const { bridge, port } = await startBridge({ resolveTarget: () => ({ conversationId: "conv-1" }) });
    assert.strictEqual(bridge, bridge);
    const res = await httpJSON("GET", port, "/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(res.json.edition, "bridge");
  });

  await test("E2. POST /api/send 缺/错 token → 403", async () => {
    const { port } = await startBridge({});
    const noToken = await httpJSON("POST", port, "/api/send", { body: { text: "hi" } });
    assert.strictEqual(noToken.status, 403);
    assert.ok(noToken.json.error.includes("Token"));
    const badToken = await httpJSON("POST", port, "/api/send", { body: { text: "hi", token: "wrong" } });
    assert.strictEqual(badToken.status, 403);
  });

  await test("E3. 携 Origin 头（浏览器 CSRF 面）→ 403", async () => {
    const { port } = await startBridge({});
    const res = await httpJSON("POST", port, "/api/send", { body: { text: "hi", token: "tok123" }, headers: { Origin: "http://evil.example" } });
    assert.strictEqual(res.status, 403);
    assert.ok(res.json.error.includes("Origin"));
  });

  await test("E4. 未知端点 → 404；GET /api/send（方法不符）→ 404", async () => {
    const { port } = await startBridge({});
    const unknown = await httpJSON("POST", port, "/api/other", { body: { token: "tok123" } });
    assert.strictEqual(unknown.status, 404);
    const wrongMethod = await httpJSON("GET", port, `/api/send?token=tok123`);
    assert.strictEqual(wrongMethod.status, 404);
  });

  await test("E5. 闸门关 = 全自动直发：202 sent + turn-start 带 CLOUD_AI_TAG 前缀 + senderType", async () => {
    const turnEvents = [];
    const { bridge, port } = await startBridge({
      getGate: () => false,
      resolveTarget: () => ({ conversationId: "conv-1" }),
      notifyRenderer: (channel, payload) => turnEvents.push({ channel, payload })
    });
    const res = await send(port, "云端AI问好");
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.json.state, "sent");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const turn = turnEvents.find((e) => e.channel === "agentBridge:turn-start");
    assert.ok(turn, "turn-start 已推送");
    assert.strictEqual(turn.payload.msgId, res.json.msgId);
    assert.strictEqual(turn.payload.conversationId, "conv-1");
    assert.strictEqual(turn.payload.senderType, "cloud-ai");
    assert.ok(turn.payload.text.startsWith(CLOUD_AI_TAG), "主进程注入点收到的文本已带标记前缀");
    // 终态回报 → done → 轮询可得回复
    const reported = bridge.reportResult({ msgId: res.json.msgId, state: "done", reply: "我是 NAS Agent，收到。" });
    assert.strictEqual(reported.ok, true);
    const poll = await httpJSON("GET", port, `/api/message?id=${res.json.msgId}&token=tok123`);
    assert.strictEqual(poll.status, 200);
    assert.strictEqual(poll.json.state, "done");
    assert.strictEqual(poll.json.reply, "我是 NAS Agent，收到。");
  });

  await test("E6. 闸门开 = 人工放行：202 pending → approve 转发 → registry approved", async () => {
    const turnEvents = [];
    const { bridge, port } = await startBridge({
      getGate: () => true,
      resolveTarget: () => ({ conversationId: "conv-2" }),
      notifyRenderer: (channel, payload) => turnEvents.push({ channel, payload })
    });
    const res = await send(port, "需要放行的消息");
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.json.state, "pending");
    assert.ok(res.json.note.includes("放行"));
    const queue = bridge.info().queue;
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].text, "需要放行的消息");
    const approved = bridge.approve(res.json.msgId);
    assert.strictEqual(approved.ok, true);
    assert.strictEqual(approved.turn.conversationId, "conv-2");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const turn = turnEvents.find((e) => e.channel === "agentBridge:turn-start");
    assert.ok(turn && turn.payload.text.startsWith(CLOUD_AI_TAG));
    assert.strictEqual(bridge.info().queue.length, 0, "放行后出队");
    const poll = await httpJSON("GET", port, `/api/message?id=${res.json.msgId}&token=tok123`);
    assert.strictEqual(poll.json.state, "approved");
  });

  await test("E7. 拒绝：出队 + rejected + 拒绝原因可轮询", async () => {
    const { bridge, port } = await startBridge({ resolveTarget: () => ({ conversationId: "conv-2" }) });
    const res = await send(port, "将被拒绝的消息");
    assert.strictEqual(res.json.state, "pending");
    const rejected = bridge.reject(res.json.msgId, "不想让你发");
    assert.strictEqual(rejected.ok, true);
    assert.strictEqual(bridge.info().queue.length, 0);
    const poll = await httpJSON("GET", port, `/api/message?id=${res.json.msgId}&token=tok123`);
    assert.strictEqual(poll.json.state, "rejected");
    assert.strictEqual(poll.json.error, "不想让你发");
    const notInQueue = bridge.reject("nope");
    assert.strictEqual(notInQueue.ok, false);
  });

  await test("E8. 忙碌冲突：上一轮 approved 未收口 → 409", async () => {
    const { port } = await startBridge({ getGate: () => false, resolveTarget: () => ({ conversationId: "conv-1" }) });
    await send(port, "第一轮");
    const second = await send(port, "第二轮");
    assert.strictEqual(second.status, 409);
    assert.ok(second.json.error.includes("还在处理中"), `实际: ${second.json.error}`);
  });

  await test("E9. reportResult busy → failed（忙碌语义在桥侧收口）", async () => {
    const { bridge, port } = await startBridge({ getGate: () => false, resolveTarget: () => ({ conversationId: "conv-1" }) });
    const res = await send(port, "忙碌那轮");
    assert.strictEqual(bridge.reportResult({ msgId: res.json.msgId, state: "busy" }).ok, true);
    const poll = await httpJSON("GET", port, `/api/message?id=${res.json.msgId}&token=tok123`);
    assert.strictEqual(poll.json.state, "failed");
    assert.ok(poll.json.error.includes("正忙"));
  });

  await test("E10. 非法载荷：空文本 400 / 超 8000 字 400 / 非法 JSON 400 / 未知 msgId 404", async () => {
    const { port } = await startBridge({});
    const empty = await send(port, "   ");
    assert.strictEqual(empty.status, 400);
    const tooLong = await send(port, "字".repeat(8001));
    assert.strictEqual(tooLong.status, 400);
    assert.ok(tooLong.json.error.includes("8000"));
    const badJson = await httpJSON("POST", port, "/api/send", { body: "{not-json", headers: { "Content-Type": "application/json" } });
    assert.strictEqual(badJson.status, 400);
    assert.ok(badJson.json.error.includes("JSON"));
    const unknown = await httpJSON("GET", port, "/api/message?id=ghost&token=tok123");
    assert.strictEqual(unknown.status, 404);
  });

  await test("E11. GET /api/status：busy/queueLength/gate/lastReply 形状", async () => {
    const { port } = await startBridge({});
    const res = await httpJSON("GET", port, "/api/status?token=tok123");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.busy, false);
    assert.strictEqual(res.json.queueLength, 0);
    assert.strictEqual(res.json.gate, true);
    assert.strictEqual(res.json.lastReply, null);
    assert.ok(res.json.note.includes("放行"));
  });

  await test("E12. 限频（deps.rateLimit=3）→ 第 4 条 429", async () => {
    const { port } = await startBridge({ rateLimit: 3, maxQueueLength: 50 });
    const r1 = await send(port, "m1");
    assert.strictEqual(r1.status, 202);
    await send(port, "m2");
    await send(port, "m3");
    const r4 = await send(port, "m4");
    assert.strictEqual(r4.status, 429);
    assert.ok(r4.json.error.includes("频率"), `实际: ${r4.json.error}`);
  });

  await test("E13. 队列上限（deps.maxQueueLength=2）→ 第 3 条 429 且 registry 标 failed", async () => {
    const { bridge, port } = await startBridge({ maxQueueLength: 2, rateLimit: 50 });
    await send(port, "q1");
    await send(port, "q2");
    const overflow = await send(port, "q3");
    assert.strictEqual(overflow.status, 429);
    assert.ok(overflow.json.error.includes("队列已满"), `实际: ${overflow.json.error}`);
    const snapshot = bridge.snapshot();
    const failed = snapshot.registry.find((e) => e.text === "q3");
    assert.ok(failed && failed.state === "failed", "溢出条目 failed 可轮询");
  });

  await test("E14. resolveTarget 无目标 → dispatchTurn failed（错误中文可轮询）", async () => {
    const { bridge, port } = await startBridge({ getGate: () => false, resolveTarget: () => null });
    const res = await send(port, "无处可发");
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.json.state, "failed");
    const poll = await httpJSON("GET", port, `/api/message?id=${res.json.msgId}&token=tok123`);
    assert.ok(poll.json.error.includes("没有可用的目标对话"), `实际: ${poll.json.error}`);
    assert.strictEqual(bridge.snapshot().queue.length, 0);
  });

  await test("E15. info() 无函数字段（IPC structuredClone 不炸）", async () => {
    const { bridge } = await startBridge({});
    const info = bridge.info();
    for (const [key, value] of Object.entries(info)) {
      assert.notStrictEqual(typeof value, "function", `info.${key} 不应为函数`);
    }
    const cloned = JSON.parse(JSON.stringify(info));
    assert.ok(Object.keys(cloned).length >= 5);
  });

  // ════════════════ F. renderer vm 假 DOM 冒烟 ════════════════
  console.log("\n=== F. renderer.js vm 假 DOM 冒烟（bridge 门控/徽章/队列/忙报） ===");

  function makeStyle() { return { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" }; }
  function makeFakeEl(tagName = "DIV") {
    const classes = new Set();
    const children = [];
    const el = {
      value: "", checked: false, type: "", placeholder: "", textContent: "", innerHTML: "",
      hidden: false, disabled: false, className: "", tagName, draggable: false,
      scrollTop: 0, scrollHeight: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0,
      files: [], children, style: makeStyle(), dataset: {},
      elements: { namedItem: () => getFake("#form-named-item") },
      form: { elements: { namedItem: () => getFake("#named-form-item") } },
      classList: {
        toggle(name, force) {
          const on = force === undefined ? !classes.has(name) : Boolean(force);
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
        add(...names) { for (const n of names) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); }
      },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false, toggleAttribute: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement: () => null, hasChildNodes: () => children.length > 0,
      append(...nodes) { for (const node of nodes) children.push(node); },
      appendChild(node) { children.push(node); return node; },
      prepend(...nodes) { children.unshift(...nodes); },
      insertBefore(node, ref) {
        if (ref) { const i = children.indexOf(ref); if (i >= 0) { children.splice(i, 0, node); return node; } }
        children.push(node); return node;
      },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      closest() { return null; }, contains() { return false; }, isConnected: true,
      querySelector(sel) { return getFake(sel || "#plan-smoke-inner"); },
      querySelectorAll() { return []; },
      focus() {}, blur() {}, click() {}, select() {}, remove() {},
      showModal() {}, close() {},  // dialog 假元素（boot 必填检查触发 openSettings 时不炸）
      scrollIntoView() {}, scrollBy() {}, scrollTo() {}, setSelectionRange() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
    return el;
  }

  const cache = new Map();
  const getFake = (sel) => {
    const key = String(sel);
    if (!cache.has(key)) cache.set(key, makeFakeEl());
    return cache.get(key);
  };

  const documentStub = { querySelectorAll: () => [], createElement: null };
  documentStub.querySelector = (sel) => getFake(sel || "#plan-smoke-doc");
  documentStub.body = getFake("body");
  documentStub.head = getFake("head");
  documentStub.documentElement = getFake("documentElement");
  documentStub.activeElement = null;
  documentStub.getElementById = (id) => getFake(`#${id}`);
  documentStub.createElement = (tag) => { const el = makeFakeEl(String(tag || "div").toUpperCase()); return el; };
  documentStub.createTextNode = (text) => ({ textContent: String(text), children: [] });
  documentStub.addEventListener = () => {};
  documentStub.removeEventListener = () => {};

  // wakeName 给非空值——boot 末尾「启动必填检查」不触发 openSettings（假元素 DOM 无 dialog 语义）
  const sampleSettings = {
    host: "10.66.1.111", port: 22, username: "demo-user", wakeName: "claude-claude-code", clientLabel: "",
    workingDirectory: "/data", dataDirectory: "",
    skipPermissions: false, showSignalLights: true, connectionMode: "ssh", localEngine: "claude",
    hasPassword: true, hasCloudAiConfig: true,
    cloudAiProvider: "zhipu", cloudAiBaseUrl: "https://open.bigmodel.cn/api/paas/v4", cloudAiModel: "glm-4-flash",
    cloudToolsEnabled: true, cloudRunCommandEnabled: false, cloudWorkingDirectory: "",
    proxyEnabled: false, proxyType: "http",
    compactAuto: true, compactThreshold: 80, compactInstruction: "",
    atomcodeHost: "127.0.0.1", atomcodePort: 13456, customCliCommand: "",
    sshProfiles: [], activeSshProfile: "ssh-1", advanced: null,
    agentBridgeConversationId: "abcd1234-5678-9abc-def0-1234567890ab"
  };

  const captured = [];
  const bridgeInfo = {
    listening: true, port: 21774, gate: true, token: "bridge-token-abc", busy: false,
    queue: [{ msgId: "q-remote-1", text: "云端AI：帮我看看 NAS 状态", at: "2026-01-01T00:00:00.000Z" }],
    lastReply: null
  };
  let smokeEdition = "main";       // 每个用例可通过此闭包变量切换 getEdition 返回
  let hangSendMessage = false;     // 让 window.agentChatPro.sendMessage 永挂（制造忙碌态）
  const turnHandlers = [];
  const queueHandlers = [];

  const editionMain = { edition: "main", productName: "Agent Chat Pro", gates: { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true } };
  const editionBridge = { edition: "bridge", productName: "Agent Chat Pro Bridge", gates: { deviceLink: false, printLink: false, localEngines: false, easterEgg: false, agentBridge: true, cloudChat: true, cacheClean: true, signalLights: true } };

  const overrides = {
    getEdition: async () => (smokeEdition === "bridge" ? editionBridge : editionMain),
    getAgentBridgeInfo: async () => bridgeInfo,
    loadSettings: async () => ({ ...sampleSettings }),
    // boot 路径形状喂全：会话/模式列表必须为数组（conversationCache.forEach / modes 迭代）
    listConversations: async () => [{ id: "smoke-id", title: "新对话", pinned: false, updatedAt: "", sessionId: "", archiveFile: "", lastConnectionMode: "ssh", preview: "" }],
    listModes: async () => [],
    getMode: async () => null,
    createConversation: async () => ({ id: "smoke-id", title: "新对话", sessionId: "", lastConnectionMode: "ssh", createdAt: "", updatedAt: "", pinned: false, messages: [], archiveFile: "", stats: { rounds: 0 } }),
    getConversation: async () => ({ id: "smoke-id", title: "新对话", sessionId: "", lastConnectionMode: "ssh", messages: [], archiveFile: "", createdAt: "", updatedAt: "", pinned: false, stats: { rounds: 0 } }),
    sendMessage: async () => (hangSendMessage ? new Promise(() => {}) : { ...sampleSettings, id: "smoke-id", text: "回复", tools: [], files: [] })
  };
  const bridge = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === "onAgentBridgeTurn") return (handler) => { turnHandlers.push(handler); };
      if (prop === "onAgentBridgeQueue") return (handler) => { queueHandlers.push(handler); };
      if (overrides[prop]) {
        return async (payload) => {
          captured.push({ method: prop, payload });
          return overrides[prop](payload);
        };
      }
      return async (payload) => {
        captured.push({ method: prop, payload });
        return {
          ...sampleSettings,
          id: payload && payload.id !== undefined ? String(payload.id) : "smoke-id",
          version: "bridge-1.0.0",
          ok: true, results: [], conversations: [], items: [], messages: [], tools: [],
          files: [], entries: [], models: [], valid: true, invalidKeys: []
        };
      };
    }
  });

  const windowStub = {
    window: null, self: null,
    agentChatPro: bridge,
    addEventListener() {}, removeEventListener() {},
    location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
    matchMedia: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    open: () => null,
    close() {},
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "smoke" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (cb) => cb(),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    crypto: require("crypto").webcrypto
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;

  class FakeEvent {
    constructor(type, init) {
      this.type = String(type || "");
      Object.assign(this, init || {});
      this.preventDefault = () => {};
      this.stopPropagation = () => {};
    }
  }

  const sandbox = {
    console,
    window: windowStub,
    document: documentStub,
    Event: FakeEvent,
    FormData: class { get() { return ""; } },
    location: windowStub.location,
    navigator: windowStub.navigator,
    localStorage: windowStub.localStorage,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    getComputedStyle: windowStub.getComputedStyle,
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
    AbortController: globalThis.AbortController,
    crypto: require("crypto").webcrypto, // sendMessage 里 crypto.randomUUID()——vm 上下文不继承 Node 全局，缺失则 first 被吞、忙检测失效
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    ReadableStream: undefined,
    structuredClone: globalThis.structuredClone || ((v) => JSON.parse(JSON.stringify(v)))
  };
  vm.createContext(sandbox);

  await test("F1. renderer.js vm 假 DOM 全量求值零异常（含 bridge 门控/队列/回合接线）", () => {
    vm.runInContext(rendererSrc, sandbox, { filename: "renderer.js" });
  });

  await test("F2. 主版形态：applyEdition 后无 bridge body class、本机模式按钮未隐藏", () => {
    const assert_ = require("assert");
    // boot IIFE 已以 main 形态跑过一次 applyEdition
    assert_.strictEqual(getFake("body").classList.contains("edition-bridge"), false);
    assert_.strictEqual(getFake("#mode-local").hidden, false, "本机模式在主版可见");
    assert_.ok(typeof sandbox.applyEdition === "function", "applyEdition 处于顶层作用域");
  });

  await test("F3. bridge 形态：applyEdition 隐藏本机模式/引擎组、放行桥设置卡", async () => {
    const assert_ = require("assert");
    smokeEdition = "bridge";
    await sandbox.applyEdition();
    assert_.strictEqual(getFake("body").classList.contains("edition-bridge"), true, "body 形态类");
    assert_.strictEqual(getFake("#mode-local").hidden, true, "本机模式按钮隐藏");
    assert_.strictEqual(getFake("#local-fields").hidden, true);
    assert_.strictEqual(getFake("#atomcode-fields").hidden, true);
    assert_.strictEqual(getFake("#custom-fields").hidden, true);
    assert_.strictEqual(getFake("#agentbridge-settings").hidden, false, "桥设置卡放行显示");
  });

  await test("F4. 桥设置卡回填：端口/闸门/Token/接入地址/目标对话名", () => {
    const assert_ = require("assert");
    assert_.strictEqual(getFake("#agentbridge-port").value, 21774, "端口回填");
    assert_.strictEqual(getFake("#agentbridge-gate").checked, true, "放行闸回填");
    assert_.strictEqual(getFake("#agentbridge-token").value, "bridge-token-abc", "Token 回填");
    assert_.ok(String(getFake("#agentbridge-url").value).includes("http://127.0.0.1:21774/api/send"), "接入地址回填（#agentbridge-url 是 <input>——显示靠 value，textContent 不渲染，v1.0.0 装机实锤空白）");
    assert_.ok(String(getFake("#agentbridge-target-name").textContent).includes("对话"), "目标对话名回填");
  });

  await test("F5. 放行队列渲染：boot 拉 info → 1 张卡（tag/文本/放行动作）", () => {
    const assert_ = require("assert");
    const queueEl = getFake("#bridge-queue");
    assert_.strictEqual(queueEl.hidden, false);
    assert_.strictEqual(queueEl.children.length, 1, "一张待放行卡");
    const card = queueEl.children[0];
    assert_.ok(String(card.className).includes("bridge-queue-card"), "卡片类名");
    // 假 DOM 不聚合父级 textContent——按结构读
    const head = card.children[0];
    assert_.strictEqual(head.children.length, 1, "卡头一枚标签");
    assert_.ok(String(head.children[0].textContent).includes("等待放行"), "卡头标签文案");
    assert_.ok(String(card.children[1].textContent).includes("帮我看看 NAS 状态"), "消息全文");
    assert_.ok(String(card.children[2].textContent).includes("2026-01-01"), "meta 时间");
    const actions = card.children[3];
    const buttonLabels = actions.children.map((button) => String(button.textContent));
    assert_.deepStrictEqual(buttonLabels, ["放行", "拒绝"], "动作按钮（假 DOM 不触发 click，形状断言）");
  });

  await test("F6. 队列事件监听器已注册 + 清空渲染（hidden + 0 卡）", () => {
    const assert_ = require("assert");
    assert_.strictEqual(queueHandlers.length, 1, "onAgentBridgeQueue 注册在场");
    assert_.strictEqual(turnHandlers.length, 1, "onAgentBridgeTurn 注册在场");
    queueHandlers[0]([]);
    assert_.strictEqual(getFake("#bridge-queue").hidden, true, "空队列隐藏");
    assert_.strictEqual(getFake("#bridge-queue").children.length, 0);
  });

  await test("F7. 云端AI气泡徽章：senderType=cloud-ai → 首子元素为徽章", () => {
    const assert_ = require("assert");
    const item = sandbox.addMessage("user", "来自云端的问题", { senderType: "cloud-ai" });
    assert_.ok(String(item.children[0].className).includes("cloudai-badge"), "徽章类名");
    assert_.strictEqual(item.children[0].textContent, "🤖 云端AI发送 · 非用户本人", "徽章文案");
    assert_.ok(String(item.children[1].textContent).includes("来自云端的问题"), "正文在场");
    const plain = sandbox.addMessage("user", "用户本人消息", {});
    assert_.ok(String(plain.children[0].className).includes("message-content"), "普通消息无徽章");
  });

  await test("F8. 桥回合忙碌回报：全局忙时 runBridgeTurn → reportAgentBridgeResult(failed)", async () => {
    const assert_ = require("assert");
    hangSendMessage = true;
    const first = sandbox.sendMessage("用户直发的消息"); // 同步入 activeId 后挂起
    first.catch(() => {});
    const reportsBefore = captured.filter((c) => c.method === "reportAgentBridgeResult").length;
    await sandbox.runBridgeTurn({ msgId: "m-busy-1", text: "云端AI的问题", conversationId: "smoke-id" });
    const reportsAfter = captured.filter((c) => c.method === "reportAgentBridgeResult");
    assert_.strictEqual(reportsAfter.length, reportsBefore + 1, "忙碌回报恰好一条");
    const report = reportsAfter[reportsAfter.length - 1].payload;
    assert_.strictEqual(report.msgId, "m-busy-1");
    assert_.strictEqual(report.state, "failed");
    assert_.ok(report.error.includes("正忙"), `实际: ${report.error}`);
  });

  await test("F9. turn 事件直触发：监听器 → runBridgeTurn（忙碌面再次回报）", async () => {
    const assert_ = require("assert");
    const reportsBefore = captured.filter((c) => c.method === "reportAgentBridgeResult").length;
    await turnHandlers[0]({ msgId: "m-busy-2", text: "再问一次", conversationId: "smoke-id" });
    const reportsAfter = captured.filter((c) => c.method === "reportAgentBridgeResult");
    assert_.strictEqual(reportsAfter.length, reportsBefore + 1);
    assert_.strictEqual(reportsAfter[reportsAfter.length - 1].payload.msgId, "m-busy-2");
  });

  // ════════════════ G. 构建管线 bridge 目标 ════════════════
  console.log("\n=== G. 构建管线 bridge 目标 ===");

  await test("G1. npm script build:win:bridge 在册；主版版本 ≥ 3.21.2（锚点随行为演进对齐）", () => {
    assert.strictEqual(pkg.scripts["build:win:bridge"], "node scripts/build-pipeline.cjs bridge");
    const rank = pkg.version.split(".").reduce((sum, part) => sum * 1000 + Number(part), 0);
    assert.ok(rank >= 32102, `主版版本 ${pkg.version} 应 ≥ 3.21.2（Bridge 是独立产物线，主版版本只增不减）`);
  });

  await test("G2. 管线：editionInfoFor 随形态出 exe/安装包/清单名", () => {
    assert.ok(pipelineSrc.includes('BRIDGE_PRODUCT = "Agent Chat Pro Bridge"'), "桥产品名常量");
    assert.ok(pipelineSrc.includes('BRIDGE_VERSION = "1.0.1"'), "桥独立版本（1.0.1=接入地址 input/value 错位修复）");
    assert.ok(pipelineSrc.includes("SHA256SUMS-bridge.txt"), "桥清单文件名");
    assert.ok(pipelineSrc.includes("isBridge ? BRIDGE_VERSION : pkg.version"), "版本取值分形态");
    assert.ok(pipelineSrc.includes("applyEditionOverlay(info)"), "构建期形态覆写");
    assert.ok(pipelineSrc.includes('.package.json.main-backup'), "package.json 快照还原");
    assert.ok(/step6_verify\(info\)[\s\S]{0,20}info\.exeName|info\.exeName/.test(pipelineSrc), "验证用形态 exe 名");
  });

  await test("G3. 管线：bridge 覆写剔除设备联动资源但保留 SDK bridge 资源", () => {
    assert.ok(pipelineSrc.includes('from !== "src/device-control"'), "设备联动资源剔除");
    assert.ok(pipelineSrc.includes("pkg.build.nsis.shortcutName"), "快捷方式名随形态");
  });

  await test("G4. set-fuses：ACP_EXE_NAME 环境变量感知", () => {
    assert.ok(fusesSrc.includes("process.env.ACP_EXE_NAME"), "exe 名可注入");
    assert.ok(pipelineSrc.includes("ACP_EXE_NAME: info.exeName"), "管线传入 exe 名");
  });

  await test("G5. 混淆清单：edition.cjs + agent-http-bridge.cjs 在 medium 名单", () => {
    assert.ok(obfuscateSrc.includes('"main/edition.cjs"'), "edition.cjs 进中等混淆");
    assert.ok(obfuscateSrc.includes('"main/agent-http-bridge.cjs"'), "HTTP 桥进中等混淆");
  });

  await test("G6. 桥模块：electron 零依赖（混淆后可独立加载）", () => {
    const bridgeSrc = read("src/main/agent-http-bridge.cjs");
    assert.ok(!bridgeSrc.includes('require("electron")'), "不依赖 electron");
    assert.ok(!bridgeSrc.includes('require("fs")'), "不依赖 fs（纯逻辑模块）");
  });

  // ── 清理：关闭所有桥实例 ──
  for (const instance of instances) {
    await new Promise((resolve) => { instance.stop().then(resolve, resolve); });
  }

  await test("Z1. 全程零未处理 Promise 拒绝（vm boot 路径完整性）", () => {
    assert.strictEqual(unhandledRejection, null, "vm 期间出现未处理拒绝: " + (unhandledRejection?.stack || unhandledRejection));
  });

  console.log(`\n════════ 汇总：${passed} 通过 / ${failed} 失败 ════════`);
  if (failures.length) {
    console.log(failures.join("\n"));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`测试主流程异常: ${error.stack || error.message}`);
  process.exit(1);
});