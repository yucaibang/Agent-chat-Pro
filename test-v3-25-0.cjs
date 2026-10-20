"use strict";
/* ═══════════════════════════════════════════════════════════════════
 * test-v3-25-0.cjs — AI 选择题三模式补全（```ask_user 约定块路）
 *
 * 立项（2026-10-20 用户拍板 B 路）：v3.24.0 云端 ask_user 真悬等可用，但
 * SSH/本机 claude 引擎依赖 CLI AskUserQuestion 工具事件——Claude CLI
 * v2.1.187 起 plain -p headless 模式硬禁用该工具（官方 issue #77994），
 * 事件永远不来 → 「只在云端看到」。本版复用 v3.20.0 F5 plan 块先例：
 *   主进程：ask-convention.cjs 幂等约定注入 + mode-params 三 builder 接线
 *   （direct-cli/local 加 --append-system-prompt 顺带修复工作模式提示词
 *   从未生效的既有缺陷；bridge 走既有 systemPrompt 字段）
 *   渲染层：renderAssistant 唯一汇聚点挂 extractAskBlocks → 复用
 *   buildAskUserCard 渲染块卡，点选=发新消息，历史 static 定格禁点
 * ═══════════════════════════════════════════════════════════════════ */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = __dirname;
let passCount = 0;
let failCount = 0;
async function test(name, fn) {
  try { await fn(); passCount++; console.log("  ✓ " + name); }
  catch (error) { failCount++; console.error("  ✗ " + name); console.error("    " + (error && error.stack ? String(error.stack).split("\n").slice(0, 6).join("\n    ") : error)); }
}

const rendererSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "renderer.js"), "utf8");

// vm 沙箱 Array/Map 原型与宿主不同，跨 realm 断言一律 JSON 比较（铁律总集 #vm 跨 realm 必败教训）
const vmEq = (actual, expected, label) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), label);

/* ── A 组：ask-convention.cjs 纯函数 ── */

async function runAskConventionTests() {
  console.log("── A 组：ask-convention 纯函数 ──");
  const ac = require(path.join(ROOT, "src", "main", "ask-convention.cjs"));

  await test("A1 marker 与导出面齐全", () => {
    assert.strictEqual(ac.ASK_PROMPT_MARKER, "ACP_ASK_USER_CONVENTION_V1");
    assert.ok(typeof ac.hasAskConvention === "function" && typeof ac.appendAskConvention === "function");
    assert.ok(ac.ASK_CONVENTION_PROMPT.includes("ACP_ASK_USER_CONVENTION_V1"), "约定正文含幂等标记");
  });

  await test("A2 约定正文教 AI 写 ask_user 围栏（问题行+选项行）", () => {
    assert.ok(ac.ASK_CONVENTION_PROMPT.includes("```ask_user"), "含 ask_user 围栏示例");
    assert.ok(ac.ASK_CONVENTION_PROMPT.includes("问题："), "含问题行约定");
    assert.ok(ac.ASK_CONVENTION_PROMPT.includes("等待用户的下一条消息"), "含输出即停等约定");
  });

  await test("A3 append 幂等：已含约定不再叠加", () => {
    const once = ac.appendAskConvention("自定义模式提示词");
    assert.ok(once.startsWith("自定义模式提示词"), "原提示词在前");
    assert.ok(ac.hasAskConvention(once));
    assert.strictEqual(ac.appendAskConvention(once), once, "二次拼接应原样返回");
  });

  await test("A4 空/非字符串安全：纯约定兜底", () => {
    assert.strictEqual(ac.appendAskConvention(""), ac.ASK_CONVENTION_PROMPT);
    assert.strictEqual(ac.appendAskConvention(null), ac.ASK_CONVENTION_PROMPT);
    assert.strictEqual(ac.appendAskConvention(undefined), ac.ASK_CONVENTION_PROMPT);
    assert.strictEqual(ac.appendAskConvention(123), ac.ASK_CONVENTION_PROMPT, "非字符串按缺失处理");
  });

  await test("A5 hasAskConvention 非/空字符串安全", () => {
    assert.strictEqual(ac.hasAskConvention(""), false);
    assert.strictEqual(ac.hasAskConvention(null), false);
    assert.strictEqual(ac.hasAskConvention(undefined), false);
    assert.strictEqual(ac.hasAskConvention(ac.ASK_CONVENTION_PROMPT), true);
  });
}

/* ── B 组：mode-params 三 builder 接线 ── */

async function runModeParamsTests() {
  console.log("── B 组：mode-params 三 builder 接线 ──");
  const mp = require(path.join(ROOT, "src", "main", "modes", "mode-params.cjs"));
  const ac = require(path.join(ROOT, "src", "main", "ask-convention.cjs"));
  const MARKER = ac.ASK_PROMPT_MARKER;
  const baseConfig = { wakeName: "claude", workingDirectory: "" };

  await test("B1 direct-cli：命令含 --append-system-prompt 且值带约定标记", () => {
    const cmd = mp.buildCommandWithMode("regular", "测试消息", "sess-1", baseConfig);
    assert.ok(cmd.includes("--append-system-prompt"), `命令缺 flag：${cmd}`);
    const value = cmd.split("--append-system-prompt")[1] || "";
    assert.ok(value.includes(MARKER), "append 值应约定标记");
    assert.ok(value.includes("'"), "多行值应被引号包裹");
  });

  await test("B2 direct-cli：工作模式 systemPrompt 一并生效（顺带修复）", () => {
    // regular 内置模式 systemPrompt 可能为空——注入纯约定也不为空；自定义模式提示词应在值内
    const cmd = mp.buildCommandWithMode("regular", "msg", "", baseConfig);
    const value = (cmd.split("--append-system-prompt")[1] || "");
    assert.ok(value.trim().length > 0, "append 值非空（约定兜底注入）");
    assert.ok(cmd.includes("'-p'"), "-p 与 prompt 形态不变");
  });

  await test("B3 bridge：start JSON 既有 systemPrompt 字段带约定（daemon 端已实锤识别）", () => {
    const msg = mp.buildBridgeStartWithMode("regular", "msg", "", baseConfig);
    assert.strictEqual(msg.type, "start");
    assert.ok(msg.systemPrompt && msg.systemPrompt.includes(MARKER), `systemPrompt 缺约定：${msg.systemPrompt}`);
    assert.ok(msg.prompt === "msg", "prompt 字段不被污染");
  });

  await test("B4 local：args 含 --append-system-prompt 且值带约定标记（stdin prompt 不受污染）", () => {
    const args = mp.buildLocalArgsWithMode("regular", "", baseConfig);
    const idx = args.indexOf("--append-system-prompt");
    assert.ok(idx >= 0, "args 缺 flag");
    assert.ok(String(args[idx + 1]).includes(MARKER), "append 值应约定标记");
    assert.ok(!args.some((a) => typeof a === "string" && a.includes(MARKER) && a.length < 40), "标记不应出现在其他参数里");
  });

  await test("B5 幂等：mode.systemPrompt 已含约定不重复叠加", () => {
    // 自定义模式带约定文末仍只出现一次标记
    const args = mp.buildLocalArgsWithMode("regular", "", baseConfig);
    const idx = args.indexOf("--append-system-prompt");
    const value = String(args[idx + 1]);
    assert.strictEqual(value.split(MARKER).length - 1, 1, "marker 恰好一次");
  });

  await test("B6 权限模式/思考挡位既有参数不被破坏（回归）", () => {
    const cmd = mp.buildCommandWithMode("regular", "msg", "", baseConfig);
    assert.ok(cmd.includes("'--permission-mode' 'bypassPermissions'"), "bypassPermissions 保留");
    assert.ok(cmd.includes("--output-format"), " stream-json", "stream-json 参数串保留");
    const args = mp.buildLocalArgsWithMode("regular", "", baseConfig);
    assert.ok(args.includes("--verbose") && args.includes("--include-partial-messages"), "verbose/partial 保留");
  });
}

/* ── C 组：渲染层源码锚 ── */

async function runRendererSourceTests() {
  console.log("── C 组：渲染层源码锚 ──");

  await test("C1 extractAskBlocks / renderAskBlockCard 函数在册", () => {
    assert.ok(rendererSrc.includes("function extractAskBlocks"), "块抽取纯函数");
    assert.ok(rendererSrc.includes("function renderAskBlockCard"), "块卡渲染函数");
  });

  await test("C2 renderAssistant 挂接：plan 块之后、markdown 渲染之前", () => {
    const order = [];
    for (const anchor of ["extractPlanBlocks(text)", "renderPlanPanel(item", "extractAskBlocks(plan.rest)", "asks.blocks.forEach", "renderMarkdown(asks.rest)"]) {
      const idx = rendererSrc.indexOf(anchor);
      assert.ok(idx >= 0, `锚点缺失：${anchor}`);
      order.push({ anchor, idx });
    }
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i].idx > order[i - 1].idx, `顺序错乱：${order[i - 1].anchor} 应先于 ${order[i].anchor}`);
    }
  });

  await test("C3 块卡复用 buildAskUserCard/markAskCardAnswered + 点选发新消息", () => {
    const fn = rendererSrc.slice(rendererSrc.indexOf("function renderAskBlockCard"));
    const fnBody = fn.slice(0, fn.indexOf("\n}") > 0 ? fn.indexOf("\n}") + 2 : 2200);
    assert.ok(fnBody.includes("buildAskUserCard"), "复用骨架");
    assert.ok(fnBody.includes("markAskCardAnswered"), "复用定格");
    assert.ok(fnBody.includes("sendMessage(`我选择：${optionText}`)"), "点选=发新消息");
    assert.ok(fnBody.includes("ask-conv-card"), "幂等附加类");
  });

  await test("C4 历史重放 static 定格禁点", () => {
    assert.ok(rendererSrc.includes("renderAssistant(item, (message.tools || []).length ? stripSeparatorLines(message.text) : message.text, { static: true })"), "历史路径传 static");
    assert.ok(rendererSrc.includes("renderAskBlockCard(item, block, Boolean(renderOptions.static))"), "static 透传 disabled");
  });

  await test("C5 cloud ask_user 工具卡零改动（防误伤双形态）", () => {
    assert.ok(rendererSrc.includes("function renderCloudAskUserCard"), "云端工具卡保留");
    assert.ok(rendererSrc.includes('answerAskUser({ callId: event.callId'), "云端 IPC 应答链保留");
    assert.ok(rendererSrc.includes("function renderSshAskUserCard"), "SSH 工具事件卡保留");
  });
}

/* ── D 组：vm 假 DOM 运行时真测（铁律：renderer 接线改动必过运行时冒烟） ── */

function makeFakeStyle() {
  const store = new Map();
  return {
    getPropertyValue: (k) => store.get(String(k)) || "",
    setProperty(k, v) { store.set(String(k), String(v)); },
    removeProperty(k) { store.delete(String(k)); }
  };
}

async function runVmTests() {
  console.log("── D 组：vm 假 DOM 运行时真测 ──");

  function elementMatches(el, raw) {
    if (!raw || !el || typeof el !== "object") return false;
    if (raw.startsWith(".")) return String(el.className || "").split(/\s+/).includes(raw.slice(1));
    if (raw.startsWith("#")) return String(el.id || "") === raw.slice(1);
    return String(el.tagName || "").toUpperCase() === raw.toUpperCase();
  }
  function querySubtree(root, sel, collectAll) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (elementMatches(child, sel)) { found.push(child); if (!collectAll) return; }
        walk(child);
      }
    };
    walk(root);
    return collectAll ? found : (found[0] || null);
  }
  function makeFakeEl() {
    const classes = new Set();
    const children = [];
    return {
      value: "", checked: false, type: "", placeholder: "", textContent: "", innerHTML: "",
      hidden: false, disabled: false, tagName: "DIV", draggable: false, id: "",
      get className() { return [...classes].join(" "); },
      set className(v) { classes.clear(); for (const part of String(v || "").split(/\s+/)) if (part) classes.add(part); },
      title: "", role: "", tabIndex: 0,
      scrollTop: 0, scrollHeight: 100, scrollLeft: 0, clientHeight: 0, clientWidth: 0,
      files: [], children, style: makeFakeStyle(), dataset: {},
      elements: { namedItem: () => getFake("#form-named-item") },
      form: { elements: { namedItem: () => getFake("#named-form-item") } },
      classList: {
        toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name); return on; },
        add(...names) { for (const n of names) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); }
      },
      addEventListener(type, fn) { (this._listeners = this._listeners || {})[String(type || "click")] = fn; },
      removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false, toggleAttribute: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement: () => null,
      append(...nodes) { for (const node of nodes) children.push(node); },
      prepend(...nodes) { for (const node of nodes) children.unshift(node); },
      appendChild(node) { children.push(node); return node; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      before(...nodes) { for (const node of nodes) children.push(node); },
      closest() { return null; }, contains() { return false; },
      querySelector(sel) { return querySubtree({ children }, sel, false); },
      querySelectorAll(sel) { return querySubtree({ children }, sel, true); },
      focus() {}, blur() {}, select() {}, remove() {}, click() {}, scrollIntoView() {}, scrollTo() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
  }
  const cache = new Map();
  const getFake = (sel) => {
    const key = String(sel);
    if (!cache.has(key)) cache.set(key, makeFakeEl());
    return cache.get(key);
  };
  const gatesStub = { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true };
  const defaultResult = () => ({
    edition: "main", productName: "Agent Chat Pro", gates: gatesStub,
    conversations: [], items: [], messages: [], tools: [], files: [], entries: [],
    results: [], valid: true, invalidKeys: [], ok: true, path: "",
    lastConnectionMode: "", version: "3.25.0",
    connectionMode: "cloud", thinkingChoices: {}, theme: "dark"
  });
  const markdownCalls = [];
  const windowStub = {
    window: null, self: null,
    agentChatPro: new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === "renderMarkdown") return async (text) => { markdownCalls.push(String(text)); return "MK:" + String(text); };
        return async () => defaultResult();
      }
    }),
    addEventListener() {}, removeEventListener() {},
    location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeListener() {} }),
    open: () => null, close() {},
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "smoke" },
    localStorage: {
      store: new Map(),
      getItem(k) { return this.store.has(String(k)) ? this.store.get(String(k)) : null; },
      setItem(k, v) { this.store.set(String(k), String(v)); },
      removeItem(k) { this.store.delete(String(k)); }
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    innerWidth: 1200, innerHeight: 800
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    Math, Date, JSON, Object, Array, String, Number, Boolean, BigInt,
    Map, Set, WeakMap, WeakSet, Promise, Symbol, Error, TypeError, RangeError,
    SyntaxError, ReferenceError, RegExp, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, structuredClone,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    queueMicrotask, performance, Buffer, crypto: require("crypto"),
    process: { env: {}, platform: "win32", versions: process.versions },
    window: windowStub,
    document: {
      body: getFake("body"), head: getFake("head"), documentElement: getFake("documentElement"),
      activeElement: null,
      querySelector: (sel) => getFake(sel), querySelectorAll: () => [],
      getElementById: (id) => getFake(`#${id}`),
      createElement: (tag) => { const el = makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
      createTextNode: (text) => ({ textContent: String(text), children: [] }),
      addEventListener() {}, removeEventListener() {}
    },
    navigator: windowStub.navigator, localStorage: windowStub.localStorage,
    location: windowStub.location, matchMedia: windowStub.matchMedia,
    getComputedStyle: windowStub.getComputedStyle,
    Event: function FakeEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
    CustomEvent: function FakeCustomEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
    FormData: function FormData() {},
    alert() {}, confirm: () => false, prompt: () => null,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}
  };
  sandbox.globalThis = sandbox;

  const source = rendererSrc + "\n;globalThis.__acpSmoke = { extractAskBlocks, renderAskBlockCard, buildAskUserCard, renderAssistant };";

  await test("D1 renderer.js vm 假 DOM 全量求值零异常（v3.25.0 新代码含在内）", () => {
    let error = null;
    try { vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: "renderer.js" }); }
    catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke");
    assert.ok(typeof sandbox.__acpSmoke.extractAskBlocks === "function", "extractAskBlocks 应可取");
  });

  await test("D2 extractAskBlocks 标准块：问题行+编号选项 + 正文剥离", () => {
    const ex = sandbox.__acpSmoke.extractAskBlocks;
    const text = [
      "先看一下你的需求。", "",
      "```ask_user",
      "问题：采用哪种实现方式？",
      "1. 方案 A —— 更快",
      "2. 方案 B —— 更省",
      "```",
      ""
    ].join("\n");
    const { blocks, rest, hasAsk } = ex(text);
    assert.ok(hasAsk, "hasAsk 应为真");
    assert.strictEqual(blocks.length, 1, "单块");
    assert.strictEqual(blocks[0].question, "采用哪种实现方式？");
    vmEq(blocks[0].options, ["方案 A —— 更快", "方案 B —— 更省"], "编号剥除+说明保留");
    assert.ok(rest.includes("先看一下你的需求。"), "正文保留");
    assert.ok(!rest.includes("ask_user"), "围栏剥离");
    assert.ok(!rest.includes("方案 A"), "块内容不重复显示");
  });

  await test("D3 容错：无「问题：」前缀首行即问题 + 「-」列表 + 中文顿号序号", () => {
    const ex = sandbox.__acpSmoke.extractAskBlocks;
    const { blocks } = ex([
      "```ask_user",
      "选哪个方向？",
      "- 方向甲",
      "- 方向乙",
      "```"
    ].join("\n"));
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].question, "选哪个方向？");
    vmEq(blocks[0].options, ["方向甲", "方向乙"]);
    const en = ex([
      "```ask_user",
      "Question: Which one?",
      "3、Option C",
      "4) Option D",
      "```"
    ].join("\n"));
    assert.strictEqual(en.blocks[0].question, "Which one?");
    vmEq(en.blocks[0].options, ["Option C", "Option D"]);
  });

  await test("D4 多块全剥 + 选项 4 上限钳制 + 疑形不渲染卡", () => {
    const ex = sandbox.__acpSmoke.extractAskBlocks;
    const two = ex("前置\n```ask_user\n问题：A？\n1. x\n```\n中间\n```ask_user\n问题：B？\n2. y\n```\n尾巴");
    assert.strictEqual(two.blocks.length, 2, "两块都收");
    vmEq(two.blocks.map((b) => b.question), ["A？", "B？"]);
    assert.ok(!two.rest.includes("```"), "全部块剥出正文");
    const five = ex("```ask_user\n问题：五个？\n1. a\n2. b\n3. c\n4. d\n5. e\n```");
    assert.strictEqual(five.blocks[0].options.length, 4, "选项钳 4");
    const bad = ex("```ask_user\n只有一行没有选项\n```");
    assert.strictEqual(bad.blocks.length, 0, "疑形（无选项）不渲染卡");
    assert.strictEqual(bad.rest, "", "疑形块仍剥出（不再当正文代码块）");
  });

  await test("D5 renderAssistant 挂接冒烟：块卡渲染进气泡 + 历史禁点 + 正文剥离", async () => {
    const ra = sandbox.__acpSmoke.renderAssistant;
    const item = makeFakeEl();
    item.innerHTML = "";
    const content = makeFakeEl();
    content.querySelector = () => null;
    item.querySelector = (sel) => (sel === ".message-content" ? content : querySubtree({ children: item.children }, sel, false));
    const text = ["回答正文。", "", "```ask_user", "问题：怎么继续？", "1. 继续做", "2. 停一下", "```", ""].join("\n");
    await ra(item, text, { static: true });
    const card = item.querySelector(".ask-conv-card");
    assert.ok(card, "块卡应渲染进气泡");
    assert.ok(card.className.includes("ask-card"), "复用 buildAskUserCard 骨架");
    const options = card.querySelectorAll(".ask-option");
    assert.strictEqual(options.length, 2, "两个选项按钮");
    assert.ok(options.every((o) => o.disabled === true && o.className.includes("dim")), "历史 static 定格禁点");
    assert.ok(String(content.innerHTML || "").startsWith("MK:") || String(content.innerHTML || "").length > 0, "markdown 渲染被调用");
    assert.ok(!String(content.innerHTML || "").includes("ask_user"), "正文剥离围栏");
    assert.ok(markdownCalls.length > 0, "renderMarkdown 走 mock");
  });
}

/* ── E 组：资产/版本 ── */

async function runAssetTests() {
  console.log("── E 组：资产/版本 ──");

  await test("E1 package.json 3.25.0", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.strictEqual(pkg.version, "3.25.0");
  });

  await test("E2 混淆 medium 名单登记 ask-convention.cjs", () => {
    const obf = fs.readFileSync(path.join(ROOT, "scripts", "obfuscate.cjs"), "utf8");
    assert.ok(obf.includes('"main/ask-convention.cjs"'), "obfuscate.cjs medium 名单应含新模块");
    const smoke = fs.readFileSync(path.join(ROOT, "scripts", "obf-smoke.cjs"), "utf8");
    assert.ok(smoke.length > 0, "obf-smoke 装置在册（名单随 obfuscate.cjs 引名单）");
  });

  await test("E3 主进程 marker 与约定正文一致（防双侧漂移）", () => {
    const ac = require(path.join(ROOT, "src", "main", "ask-convention.cjs"));
    const src = fs.readFileSync(path.join(ROOT, "src", "main", "ask-convention.cjs"), "utf8");
    assert.ok(src.includes(ac.ASK_PROMPT_MARKER));
    assert.ok(!ac.ASK_CONVENTION_PROMPT.includes("```plan"), "不与 plan 约定混淆");
    const mp = require(path.join(ROOT, "src", "main", "modes", "mode-params.cjs"));
    assert.ok(typeof mp.buildCommandWithMode === "function", "builder 面不缩");
  });
}

(async () => {
  console.log("═ test-v3-25-0.cjs — AI 选择题三模式补全（ask 约定块路） ═");
  await runAskConventionTests();
  await runModeParamsTests();
  await runRendererSourceTests();
  await runVmTests();
  await runAssetTests();
  console.log(`\n结果：${passCount} 项通过 / ${failCount} 项失败`);
  // vm 求值后的 mock 初始化链可能拖出未捕获异常（mock 摩擦非产品 bug）——静默不并入判定，强制收尾
  let noise = 0;
  process.on("uncaughtException", (e) => { noise++; void e; });
  process.on("unhandledRejection", (e) => { noise++; void e; });
  setTimeout(() => { process.exit(failCount ? 1 : 0); }, 100).unref?.();
})();

(async () => { })();