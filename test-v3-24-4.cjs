"use strict";
/**
 * v3.24.4 测试 — 高级设置手动组"一点保存就恢复出厂"修复 + 云端工具轮次上限取消
 *   修复①：sanitizeAdvancedNumericGroup 语义重写（字段级钳边界/补默认，组保持手动；旧版
 *     "任一字段非法 → 整组回 null(自动)"，面板全回默认值 = 用户感知的恢复出厂设置）。
 *   需求②：maxToolRounds 上限 50→10000 三处同步（settings ADVANCED_CLAMPS / main 消费校验 /
 *     UI input max），默认 25 不变。
 *   修复③：轮次耗尽报错文案改用实际配置值（旧版硬编码 MAX_TOOL_ROUNDS=25，用户设 50 时提示错误）。
 * 覆盖：sanitize 新语义源码切片真测（钳边界/补默认/保手动/缺组回自动）+ main 消费端接线 +
 *       渲染层钳制提示接线 + saveSettings 集成链真测（mock electron 真实 IO）+
 *       vm 假 DOM 全量求值冒烟 + collectClampedFields 运行时真测。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const Module = require("module");
const assert = require("assert");

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const settingsSrc = read("src/main/settings.cjs");
const mainSrc = read("src/main/main.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const htmlSrc = read("src/renderer/index.html");
const pkg = JSON.parse(read("package.json"));

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

/* ── A 组：sanitize 手动组新语义真测（源码切片 new Function，段内函数零外部依赖） ── */

const advancedFns = new Function(
  settingsSrc.slice(settingsSrc.indexOf("const ADVANCED_ADAPTERS"), settingsSrc.indexOf("/** 合并实值")) +
  "\nreturn { ADVANCED_DEFAULTS, ADVANCED_CLAMPS, sanitizeAdvanced, sanitizeAdvancedNumericGroup, sanitizeSshAdvanced };"
)();

async function runSanitizeTests() {
  console.log("── A 组：sanitize 手动组新语义（字段级钳边界/补默认） ──");

  await test("A1 需求②钳制表：maxToolRounds [5,10000]；其余字段不动", () => {
    assert.deepStrictEqual(advancedFns.ADVANCED_CLAMPS.cloud.maxToolRounds, [5, 10000], "轮次上限应为 [5,10000]");
    assert.deepStrictEqual(advancedFns.ADVANCED_CLAMPS.cloud.connectTimeoutSec, [10, 300], "连接超时钳制不动");
    assert.strictEqual(advancedFns.ADVANCED_DEFAULTS.cloud.maxToolRounds, 25, "默认 25 不变");
  });

  await test("A2 手动组合法值原样保留（四字段全落）", () => {
    const out = advancedFns.sanitizeAdvancedNumericGroup(
      { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30 },
      advancedFns.ADVANCED_CLAMPS.cloud, advancedFns.ADVANCED_DEFAULTS.cloud
    );
    assert.deepStrictEqual(out, { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30 });
  });

  await test("A3 超上界钳到边界：轮次 15000→10000（旧版整组回 null 洗出面板）；组保持手动", () => {
    const out = advancedFns.sanitizeAdvancedNumericGroup(
      { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 15000 },
      advancedFns.ADVANCED_CLAMPS.cloud, advancedFns.ADVANCED_DEFAULTS.cloud
    );
    assert.strictEqual(out.maxToolRounds, 10000, "超上界应钳到 10000");
    assert.strictEqual(out.connectTimeoutSec, 60, "同组合法字段不受波及");
    const big = advancedFns.sanitizeAdvancedNumericGroup(
      { connectTimeoutSec: 4000, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30 },
      advancedFns.ADVANCED_CLAMPS.cloud, advancedFns.ADVANCED_DEFAULTS.cloud
    );
    assert.strictEqual(big.connectTimeoutSec, 300, "连接超时超界同样钳边界 300");
  });

  await test("A4 超下界钳到边界：轮次 3→5", () => {
    const out = advancedFns.sanitizeAdvancedNumericGroup(
      { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 3 },
      advancedFns.ADVANCED_CLAMPS.cloud, advancedFns.ADVANCED_DEFAULTS.cloud
    );
    assert.strictEqual(out.maxToolRounds, 5, "越下界应钳到 5");
  });

  await test("A5 非整数/缺失补默认值；组保持手动（旧版此处整组回 null）", () => {
    const out = advancedFns.sanitizeAdvancedNumericGroup(
      { connectTimeoutSec: "abc", streamIdleTimeoutSec: 600, maxRetries: 1.5, maxToolRounds: 30 },
      advancedFns.ADVANCED_CLAMPS.cloud, advancedFns.ADVANCED_DEFAULTS.cloud
    );
    assert.strictEqual(out.connectTimeoutSec, 120, "非数字应补默认 120");
    assert.strictEqual(out.maxRetries, 0, "小数应补默认 0");
    assert.strictEqual(out.maxToolRounds, 30, "合法字段原值保留");
    const missing = advancedFns.sanitizeAdvancedNumericGroup(
      { streamIdleTimeoutSec: 600 },
      advancedFns.ADVANCED_CLAMPS.cloud, advancedFns.ADVANCED_DEFAULTS.cloud
    );
    assert.deepStrictEqual(missing, { connectTimeoutSec: 120, streamIdleTimeoutSec: 600, maxRetries: 0, maxToolRounds: 25 }, "缺失字段补默认且组仍输出对象");
  });

  await test("A6 整组缺失/非对象回 null（自动识别）；显式 null 恢复自动语义保留", () => {
    assert.strictEqual(advancedFns.sanitizeAdvancedNumericGroup(null, advancedFns.ADVANCED_CLAMPS.cloud, advancedFns.ADVANCED_DEFAULTS.cloud), null);
    assert.strictEqual(advancedFns.sanitizeAdvancedNumericGroup("x", advancedFns.ADVANCED_CLAMPS.cloud, advancedFns.ADVANCED_DEFAULTS.cloud), null, "字符串非对象回 null");
    const viaFull = advancedFns.sanitizeAdvanced({ ssh: null, external: null, cloud: null }, {});
    assert.strictEqual(viaFull.cloud, null, "sanitizeAdvanced 显式 null → 自动");
    assert.strictEqual(viaFull.external, null);
  });

  await test("A7 sanitizeAdvanced 全链：越界手动组保持对象 + 合法组落原值（修复①集成语义）", () => {
    const result = advancedFns.sanitizeAdvanced(
      {
        ssh: { requestTimeoutMin: 5, connectTimeoutSec: 20, sftpTimeoutSec: 60, reconnectAttempts: 4, reconnectBaseMs: 800, keepaliveSec: 20, debugLog: true },
        cloud: { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30 }
      },
      {}
    );
    assert.ok(result.ssh && typeof result.ssh === "object", "SSH 组应保持手动（旧版整组回 null）");
    assert.strictEqual(result.ssh.requestTimeoutMin, 10, "越下界钳到 10");
    assert.strictEqual(result.ssh.debugLog, true, "布尔开关保留");
    assert.deepStrictEqual(result.cloud, { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30 }, "云端组合法原值");
  });

  await test("A8 未提交分组继承 previous（saveSettings 全量语义不受新语义影响）", () => {
    const previous = { ssh: null, external: null, cloud: { connectTimeoutSec: 90, streamIdleTimeoutSec: 300, maxRetries: 1, maxToolRounds: 20 }, adapter: "claude", adapterOptions: { model: "", sandbox: "", provider: "" } };
    assert.strictEqual(advancedFns.sanitizeAdvanced(undefined, previous).cloud.maxToolRounds, 20, "undefined 继承 previous");
  });
}

/* ── B 组：main.cjs 消费端接线（需求②+修复③） ── */

async function runMainWiringTests() {
  console.log("── B 组：main.cjs 消费端接线 ──");

  await test("B1 消费端轮次校验上限放宽 10000，旧 50 校验清除", () => {
    assert.ok(mainSrc.includes("Number(advancedCloud.maxToolRounds) <= 10000"), "消费校验上界应 10000");
    assert.ok(!mainSrc.includes("<= 50"), "旧 <= 50 校验应清除");
    assert.ok(mainSrc.includes("maxToolRounds，5~10000 默认 25"), "注释同步 5~10000");
  });

  await test("B2 修复③：轮次耗尽报错文案用实际配置值 maxToolRounds（旧硬编码 25 清除）", () => {
    assert.ok(mainSrc.includes("已达上限（${maxToolRounds} 轮）"), "文案应引用 maxToolRounds");
    assert.ok(!mainSrc.includes("${MAX_TOOL_ROUNDS} 轮"), "旧 MAX_TOOL_ROUNDS 文案应清除");
    assert.ok(mainSrc.includes(": MAX_TOOL_ROUNDS"), "兜底 fallback 常量保留");
  });
}

/* ── C 组：渲染层 + index.html 接线 ── */

async function runRendererWiringTests() {
  console.log("── C 组：渲染层 + UI 接线 ──");

  await test("C1 index.html：轮次输入框 max=10000（旧 50 清除）", () => {
    assert.ok(htmlSrc.includes('id="adv-cloud-tool-rounds" min="5" max="10000"'), "轮次 input max 应 10000");
    const line = htmlSrc.split("\n").find((l) => l.includes("adv-cloud-tool-rounds"));
    assert.ok(line && !line.includes('max="50"'), "该行不应残留 max=50");
  });

  await test("C2 renderer：collectClampedFields 助手 + 字段中文标签表在册", () => {
    assert.ok(rendererSrc.includes("function collectClampedFields"), "钳制对比助手");
    assert.ok(rendererSrc.includes("const ADV_FIELD_LABELS"), "字段标签表");
    assert.ok(rendererSrc.includes("maxToolRounds: \"工具循环轮次\""), "轮次标签在册");
  });

  await test("C3 修复①文案：越界钳制提示新增 + 旧整组回退提示清除", () => {
    assert.ok(rendererSrc.includes("超出合法范围，已自动修正到边界值"), "钳制提示应新增");
    assert.ok(!rendererSrc.includes("所填值不合法，已整组回退自动识别"), "旧整组回退文案应清除");
    assert.ok(rendererSrc.includes("参数缺失，已回退自动识别"), "缺组兜底提示保留");
  });
}

/* ── D 组：vm 假 DOM 全量求值冒烟（铁律：renderer 接线改动必过）+ collectClampedFields 真测 ── */

async function runVmSmokeTests() {
  console.log("── D 组：vm 假 DOM 全量求值冒烟 ──");

  const captureProps = {};
  function makeStyle() {
    const store = {};
    return new Proxy(store, {
      get(_t, prop) {
        if (prop === "setProperty") return (key, val) => { store[key] = val; };
        if (prop === "removeProperty") return (key) => { delete store[key]; };
        if (prop === "getPropertyValue") return (key) => store[key];
        return store[prop];
      },
      set() { return true; }
    });
  }
  /** 子树选择器匹配（.class / #id / tag 三形态；v3.24.6 H 组思考块子树查询需要） */
  function elementMatches(el, sel) {
    const raw = String(sel || "").trim();
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
      scrollTop: 0, scrollHeight: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0,
      files: [], children, style: makeStyle(), dataset: {},
      elements: { namedItem: () => getFake("#form-named-item") },
      form: { elements: { namedItem: () => getFake("#named-form-item") } },
      classList: {
        toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name);; return on; },
        add(...names) { for (const n of names) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); }
      },
      addEventListener(type, fn) { (this._listeners = this._listeners || {})[String(type || "click")] = fn; },
      removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false, toggleAttribute: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement: () => null, hasChildNodes() { return children.length > 0; },
      append(...nodes) { for (const node of nodes) children.push(node); },
      prepend(...nodes) { for (const node of nodes) children.unshift(node); },
      appendChild(node) { children.push(node); return node; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      before(...nodes) { for (const node of nodes) children.push(node); },
      closest() { return null; }, contains() { return false; },
      querySelector(sel) { return querySubtree({ children }, sel, false); },
      querySelectorAll(sel) { return querySubtree({ children }, sel, true); },
      focus() {}, blur() {}, select() {}, remove() {}, click() {}, scrollIntoView() {}, scrollBy() {}, scrollTo() {}, setSelectionRange() {},
      showModal() {}, close() {}, show() {}, showPicker() {},
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
  const methodMocks = {
    listConversations: async () => [],
    listModes: async () => [],
    getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub }),
    getThinkingProfile: async () => ({ profile: null })
  };
  const defaultResult = () => ({
    edition: "main", productName: "Agent Chat Pro", gates: gatesStub,
    conversations: [], items: [], messages: [], tools: [], files: [], entries: [],
    results: [], valid: true, invalidKeys: [], ok: true, path: "",
    lastConnectionMode: "", version: "3.24.4",
    host: "", port: 22, username: "", wakeName: "", clientLabel: "",
    workingDirectory: "", dataDirectory: "", skipPermissions: false,
    showSignalLights: true, connectionMode: "cloud", localEngine: "claude",
    hasPassword: true, hasCloudAiConfig: true,
    cloudAiProvider: "zhipu", cloudAiBaseUrl: "", cloudAiModel: "glm-4-flash",
    thinkingChoices: {}, theme: "dark"
  });
  const windowStub = {
    window: null, self: null,
    agentChatPro: new Proxy(captureProps, {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop in _t) return _t[prop];
        if (prop in methodMocks) return methodMocks[prop];
        return async () => defaultResult();
      }
    }),
    addEventListener() {}, removeEventListener() {},
    location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
    matchMedia: () => ({ matches: false, media: "", addEventListener() {}, addListener() {}, removeListener() {} }),
    open: () => null, close() {},
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "smoke" },
    // v3.24.6 I 组：localStorage 升级为带真存储的 stub（供折叠/模式记忆断言读取写入值）
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
    queueMicrotask, performance, Buffer,
    process: { env: {}, platform: "win32", versions: process.versions },
    window: windowStub, document: {
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

  const vm = require("vm");
  const source = rendererSrc + "\n;globalThis.__acpSmoke = { collectClampedFields, ADV_FIELD_LABELS, ensureThinkingBlock, appendThinkingDelta, finalizeThinkingSummary, renderStaticThinking, thinkDepthLabel, THINK_DEPTH_TIERS, devPanelAccount, devPanelItems, devPanelToolPath, devPanelBasename, devPanelClock, renderDevPanel, renderDevPanelRole, DEV_PANEL_ROLE_DESC };";
  await test("D1 renderer.js vm 假 DOM 全量求值零异常（v3.24.4 新代码含在内）", () => {
    let error = null;
    try { vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: "renderer.js" }); }
    catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke");
  });

  await test("D2 collectClampedFields 真测：轮次被钳只报该字段，合法字段不误报", () => {
    const fixed = Array.from(sandbox.__acpSmoke.collectClampedFields(
      { cloud: { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 15000 } },
      { cloud: { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 10000 } }
    ));
    assert.deepStrictEqual(fixed, ["工具循环轮次"], "应只报被钳的轮次字段");
  });

  await test("D3 collectClampedFields：ssh/cloud 全一致 → 空数组（不误报 debugLog）", () => {
    const ssh = { requestTimeoutMin: 30, connectTimeoutSec: 15, sftpTimeoutSec: 30, reconnectAttempts: 3, reconnectBaseMs: 600, keepaliveSec: 15 };
    const fixed = Array.from(sandbox.__acpSmoke.collectClampedFields(
      { ssh: { ...ssh, debugLog: true }, cloud: { connectTimeoutSec: 90, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 40 } },
      { ssh: { ...ssh, debugLog: true }, cloud: { connectTimeoutSec: 90, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 40 } }
    ));
    assert.deepStrictEqual(fixed, [], "全一致应为空（布尔开关不参与对比）");
    const fixed2 = Array.from(sandbox.__acpSmoke.collectClampedFields(
      { cloud: { connectTimeoutSec: 45, streamIdleTimeoutSec: 300, maxRetries: 1, maxToolRounds: 30 } },
      { cloud: { connectTimeoutSec: 45, streamIdleTimeoutSec: 300, maxRetries: 1, maxToolRounds: 30 } }
    ));
    assert.deepStrictEqual(fixed2, []);
  });

/* ── H 组（v3.24.6）：思考块元信息（⏱ 耗时 + 🧠 程度标签，豆包同款五档） ── */

async function runThinkMetaTests() {
  console.log("── H 组：思考块元信息（耗时+程度标签） ──");

  await test("H1 五档映射全表（豆包同款五标签不自创，字数边界+非数字安全）", () => {
    const label = sandbox.__acpSmoke.thinkDepthLabel;
    assert.strictEqual(label(0), "little thinking");
    assert.strictEqual(label(499), "little thinking");
    assert.strictEqual(label(500), "thinking");
    assert.strictEqual(label(1999), "thinking");
    assert.strictEqual(label(2000), "thinking more");
    assert.strictEqual(label(4999), "thinking more");
    assert.strictEqual(label(5000), "thinking most");
    assert.strictEqual(label(14999), "thinking most");
    assert.strictEqual(label(15000), "thinking continuously");
    assert.strictEqual(label(99999), "thinking continuously");
    assert.strictEqual(label("abc"), "little thinking", "非数字安全回最低档");
    assert.deepStrictEqual(Array.from(sandbox.__acpSmoke.THINK_DEPTH_TIERS.map((t) => t.min)), [15000, 5000, 2000, 500, 0], "档位阈值守卫");
  });

  await test("H2 流式增量：建块累计字数+进行中+起止时刻记录", () => {
    const item = getFake("#h2-item");
    sandbox.__acpSmoke.appendThinkingDelta(item, "思考第一段。");
    sandbox.__acpSmoke.appendThinkingDelta(item, "续上第二段。");
    const block = item.querySelector(".thinking-block");
    assert.ok(block, "应建折叠块");
    assert.strictEqual(block.tagName, "DETAILS");
    const summary = block.querySelector("summary").textContent;
    assert.ok(summary.includes("12 字"), `累计字数：${summary}`);
    assert.ok(summary.includes("进行中"), "流式期间显示进行中");
    assert.ok(block.dataset.thinkT0 && block.dataset.thinkT1, "应记录起止时刻");
    assert.ok(Number(block.dataset.thinkT1) >= Number(block.dataset.thinkT0), "末时刻不早于起点");
  });

  await test("H3 定稿收敛：⏱ 耗时（一位小数）+ 🧠 程度 + 进行中消失", () => {
    const item = getFake("#h3-item");
    sandbox.__acpSmoke.appendThinkingDelta(item, "一点思考。");
    const block = item.querySelector(".thinking-block");
    block.dataset.thinkT1 = String(Number(block.dataset.thinkT0) + 8300);
    sandbox.__acpSmoke.finalizeThinkingSummary(item);
    const text = item.querySelector(".thinking-block").querySelector("summary").textContent;
    assert.ok(!text.includes("进行中"), "定稿后不应有进行中");
    assert.ok(text.includes("⏱ 8.3s"), `应含耗时：${text}`);
    assert.ok(text.includes("🧠 little thinking"), "5 字应最低档");
    assert.ok(text.includes("5 字"), "字数保留");
  });

  await test("H4 静态重放：字数+程度在册、无耗时段与进行中", () => {
    const item = getFake("#h4-item");
    sandbox.__acpSmoke.renderStaticThinking(item, "落库的历史思考文本九个字哦");
    const text = item.querySelector(".thinking-block").querySelector("summary").textContent;
    assert.ok(text.includes("13 字"), `字数：${text}`);
    assert.ok(text.includes("thinking"), "程度标签在册");
    assert.ok(!text.includes("⏱"), "落库无耗时段");
    assert.ok(!text.includes("进行中"), "静态无进行中");
  });

  await test("H5 大字数最高档 + 空白思考不渲染", () => {
    const item = getFake("#h5-item");
    sandbox.__acpSmoke.renderStaticThinking(item, "云".repeat(20000));
    const text = item.querySelector(".thinking-block").querySelector("summary").textContent;
    assert.ok(text.includes("thinking continuously"), "2 万字应最高档");
    const empty = getFake("#h5-empty");
    sandbox.__acpSmoke.renderStaticThinking(empty, "   ");
    assert.ok(!empty.querySelector(".thinking-block"), "空白思考不渲染");
  });
}

  await runThinkMetaTests();

/* ── I 组（v3.24.6）：开发面板（右侧实时观察 AI 编辑文件；三模式共用工具事件流） ── */

async function runDevPanelTests() {
  console.log("── I 组：开发面板（账本+DOM 渲染+折叠/模式记忆） ──");

  await test("I1 devPanelAccount 账本纯逻辑：写读分流、running/completed/denied 三态、无关工具不入账", () => {
    const acct = sandbox.__acpSmoke.devPanelAccount;
    const ledger = sandbox.__acpSmoke.devPanelItems;
    ledger.clear();
    assert.strictEqual(acct(null), false, "空工具不入账");
    assert.strictEqual(acct({ name: "Bash", status: "running", id: "t0", input: { command: "ls" } }), false, "Bash 不入账");
    assert.strictEqual(acct({ name: "Write", status: "running", id: "w1", input: { file_path: "/proj/a.md" } }), true, "Write 应入账");
    const a = ledger.get("/proj/a.md");
    assert.ok(a, "账本应有 /proj/a.md 条目");
    assert.strictEqual(a.op, "edit");
    assert.strictEqual(a.lastStatus, "queued", "running 态为排队色");
    assert.strictEqual(a.running.size, 1, "活动 id 应在册");
    acct({ name: "Edit", status: "completed", id: "w1", input: { filePath: "/proj/a.md" } });  // 键兼容 filePath
    assert.strictEqual(a.lastStatus, "ok", "completed 态为完成");
    assert.strictEqual(a.running.size, 0, "活动 id 应出册");
    acct({ name: "NotebookEdit", status: "denied", id: "w2", input: { notebook_path: "/proj/a.md" } });
    assert.strictEqual(a.lastStatus, "failed", "denied 归入失败色");
    acct({ name: "read_file", status: "completed", id: "r1", input: { path: "/proj/b.txt" } });
    const b = ledger.get("/proj/b.txt");
    assert.strictEqual(b.op, "read", "read_file 归读取");
    assert.strictEqual(b.lastStatus, "ok");
    assert.strictEqual(ledger.size, 2, "账本应恰好两条");
  });

  await test("I2 devPanelToolPath/Basename：五键兼容、空白不取、双反斜杠与纯文件名", () => {
    const tp = sandbox.__acpSmoke.devPanelToolPath;
    const bn = sandbox.__acpSmoke.devPanelBasename;
    assert.strictEqual(tp({ input: { file_path: "/a/x.md" } }), "/a/x.md");
    assert.strictEqual(tp({ input: { notebook_path: "/a/n.ipynb" } }), "/a/n.ipynb");
    assert.strictEqual(tp({ input: { filePath: "C:\\w\\y.txt" } }), "C:\\w\\y.txt");
    assert.strictEqual(tp({ input: {} }), "", "无路径键应为空");
    assert.strictEqual(tp({ input: { file_path: "   " } }), "", "纯空白路径不取");
    assert.strictEqual(bn("C:\\w\\y.txt"), "y.txt", "Windows 反斜杠也应取尾名");
    assert.strictEqual(bn("/proj/a.md"), "a.md");
    assert.strictEqual(bn("plain.txt"), "plain.txt");
    assert.ok(/^\d{2}:\d{2}$/.test(sandbox.__acpSmoke.devPanelClock(Date.now())), "时钟 hh:mm 格式");
  });

  await test("I3 renderDevPanel DOM：空态→正在编辑→完成收敛 + 折叠窄条 busy/文件名联动", () => {
    const ledger = sandbox.__acpSmoke.devPanelItems;
    const acct = sandbox.__acpSmoke.devPanelAccount;
    const rd = sandbox.__acpSmoke.renderDevPanel;
    ledger.clear();
    const empty = getFake("#dev-empty"), active = getFake("#dev-active"), activeFile = getFake("#dev-active-file"), feed = getFake("#dev-feed");
    empty.hidden = false; active.hidden = false;  // 预置相反态验证翻转
    rd();
    assert.strictEqual(empty.hidden, false, "空账本应显示空态（欣赏一下干净的工作区）");
    assert.strictEqual(active.hidden, true);
    assert.strictEqual(feed.children.length, 0);
    assert.strictEqual(getFake("#dev-rail-dot").classList.contains("busy"), false);
    assert.strictEqual(getFake("#dev-rail-label").textContent, "开发");
    acct({ name: "Edit", status: "running", id: "e1", input: { file_path: "/proj/hero.py" } });
    rd();
    assert.strictEqual(empty.hidden, true);
    assert.strictEqual(active.hidden, false, "有编辑中文件应显示正在编辑区");
    assert.strictEqual(activeFile.textContent, "/proj/hero.py");
    assert.strictEqual(feed.children.length, 1);
    const row = feed.children[0];
    assert.ok(String(row.className).includes("dev-feed-row"));
    assert.ok(String(row.children[0].className).includes("queued"), "running 应黄点");
    assert.strictEqual(row.children[1].textContent, "hero.py");
    assert.strictEqual(row.children[2].textContent, "编辑中");
    assert.ok(/^\d{2}:\d{2}$/.test(row.children[3].textContent));
    assert.strictEqual(getFake("#dev-rail-label").textContent, "hero.py", "折叠窄条应显示正在编辑文件名");
    assert.strictEqual(getFake("#dev-rail-dot").classList.contains("busy"), true, "窄条 busy 点应亮");
    acct({ name: "Edit", status: "completed", id: "e1", input: { file_path: "/proj/hero.py" } });
    rd();
    assert.strictEqual(active.hidden, true, "编辑完成后正在编辑区应收起");
    assert.strictEqual(getFake("#dev-rail-dot").classList.contains("busy"), false, "busy 点应灭");
    assert.strictEqual(feed.children[0].children[2].textContent, "已编辑");
    assert.ok(String(feed.children[0].children[0].className).includes("edit"), "写文件完成转绿点");
  });

  await test("I4 折叠开合 + 主备模式 pill：点击→body.dev-collapsed + localStorage 记忆", () => {
    const body = getFake("body");
    const ls = sandbox.localStorage;
    body.classList.remove("dev-collapsed");
    const collapseBtn = getFake("#dev-collapse");
    assert.ok(collapseBtn._listeners && collapseBtn._listeners.click, "渲染器应绑定折叠钮");
    collapseBtn._listeners.click();
    assert.strictEqual(body.classList.contains("dev-collapsed"), true, "点击折叠钮应加 dev-collapsed");
    assert.strictEqual(ls.getItem("acp-dev-panel-collapsed"), "1", "折叠应记忆");
    const rail = getFake("#dev-rail");
    assert.ok(rail._listeners && rail._listeners.click, "窄条应绑定展开钮");
    rail._listeners.click();
    assert.strictEqual(body.classList.contains("dev-collapsed"), false, "点窄条应展开");
    assert.strictEqual(ls.getItem("acp-dev-panel-collapsed"), "0");
    const leadBtn = getFake("#dev-role-lead"), assistBtn = getFake("#dev-role-assist"), desc = getFake("#dev-role-desc");
    assert.ok(assistBtn.classList.contains("active"), "初始化默认人主机辅");
    assert.ok(desc.textContent.startsWith("人主机辅"), `初始描述：${desc.textContent}`);
    leadBtn._listeners.click();
    assert.ok(leadBtn.classList.contains("active"), "切机主人辅应点亮");
    assert.ok(!assistBtn.classList.contains("active"));
    assert.ok(desc.textContent.startsWith("机主人辅"));
    assert.strictEqual(ls.getItem("acp-dev-panel-role"), "lead", "模式应记忆");
    assistBtn._listeners.click();
    assert.ok(assistBtn.classList.contains("active"));
    assert.ok(desc.textContent.startsWith("人主机辅"));
    assert.strictEqual(ls.getItem("acp-dev-panel-role"), "assist");
  });

  await test("I5 文件级锚：index DOM + styles 样式 + renderer 挂点与主备文案、三模式共用单通道", () => {
    const html = fs.readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8");
    assert.ok(html.includes('id="dev-panel"'), "index 应含 dev-panel 主体");
    assert.ok(html.includes("欣赏一下干净的工作区"), "空态文案");
    assert.ok(html.includes("人主机辅") && html.includes("机主人辅"), "主备 pill 文案");
    assert.ok(html.includes("AI 只是帮忙检查漏洞") && html.includes("用户用来监督和观察"), "主备描述文案");
    assert.ok(html.includes('id="dev-rail"') && html.includes('id="dev-rail-dot"'), "折叠窄条");
    const css = fs.readFileSync(path.join(ROOT, "src/renderer/styles.css"), "utf8");
    assert.ok(css.includes(".dev-panel"), "面板样式");
    assert.ok(css.includes("body.dev-collapsed .dev-panel"), "折叠隐藏规则");
    assert.ok(css.includes(".dev-rail"), "窄条样式");
    assert.ok(css.includes("dev-pulse"), "呼吸动画");
    assert.ok(css.includes(".dev-feed-row"), "活动流行样式");
    assert.ok(rendererSrc.includes("if (devPanelAccount(event.tool)) renderDevPanel()"), "tool 分支挂点（三模式共用通道）");
    assert.ok(rendererSrc.includes("acp-dev-panel-collapsed") && rendererSrc.includes("acp-dev-panel-role"), "两项记忆键");
    assert.ok(rendererSrc.includes("DEV_PANEL_WRITE_TOOLS") && rendererSrc.includes("DEV_PANEL_READ_TOOLS"), "写读工具集");
  });
}

  await runDevPanelTests();
}

/* ── E 组：saveSettings 集成链真测（mock electron 真实 IO，复刻 v3-19-0 手法） ── */

async function runIntegrationTests() {
  console.log("── E 组：saveSettings 集成链（mock electron 真实 IO） ──");

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3244-"));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => workdir, isPackaged: false, whenReady: async () => {} },
        safeStorage: { isEncryptionAvailable: () => true, decryptString: (v) => v, encryptString: (v) => v }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(ROOT, "src/main/settings.cjs"))];
  const settings = require(path.join(ROOT, "src/main/settings.cjs"));
  Module._load = originalLoad;

  const targetFile = path.join(workdir, "connection.json");
  const base = { connectionMode: "ssh", host: "192.168.1.20", port: 22, username: "admin", workingDirectory: "/vol1/1000/proj", password: "secret", networkType: "tcp" };

  await test("E1 修复①集成：SSH 越界组保持手动落盘（钳 10）+ 云端组合法原值（旧版 SSH 组整组回 null）", () => {
    const saved = settings.saveSettings({
      ...base,
      advanced: {
        ssh: { requestTimeoutMin: 5, connectTimeoutSec: 20, sftpTimeoutSec: 60, reconnectAttempts: 4, reconnectBaseMs: 800, keepaliveSec: 20 },
        cloud: { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30 }
      }
    });
    assert.ok(saved.advanced.ssh && typeof saved.advanced.ssh === "object", "SSH 组应保持手动");
    assert.strictEqual(saved.advanced.ssh.requestTimeoutMin, 10, "越下界钳到边界 10");
    assert.strictEqual(saved.advancedEffective.ssh.requestTimeoutMin, 10, "实值应为钳制后 10");
    assert.strictEqual(saved.advanced.cloud.maxToolRounds, 30, "云端组合法原值落盘");
    const raw = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.strictEqual(raw.advanced.ssh.requestTimeoutMin, 10, "落盘为钳制值（不再洗回 null）");
    assert.strictEqual(raw.advanced.cloud.maxToolRounds, 30);
  });

  await test("E2 需求②集成：轮次 15000 落盘钳为 10000；手动组其他超界字段同步边界", () => {
    const saved = settings.saveSettings({
      ...base,
      advanced: { cloud: { connectTimeoutSec: 90, streamIdleTimeoutSec: 60000, maxRetries: 9, maxToolRounds: 15000 } }
    });
    const c = saved.advanced.cloud;
    assert.deepStrictEqual(c, { connectTimeoutSec: 90, streamIdleTimeoutSec: 1800, maxRetries: 3, maxToolRounds: 10000 }, "逐字段钳到边界且组保持手动");
  });

  await test("E3 自动识别与显式 null：默认档自动 + 恢复自动语义零回归", () => {
    const restored = settings.saveSettings({ ...base, advanced: { ssh: null, external: null, cloud: null } });
    assert.strictEqual(restored.advanced.cloud, null, "显式 null → 自动");
    assert.strictEqual(restored.advancedEffective.cloud.maxToolRounds, 25, "自动实值 = 默认 25");
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3244-fresh-"));
    fs.writeFileSync(path.join(fresh, "connection.json"), JSON.stringify({ ...base }), "utf8");
    const originalLoad2 = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === "electron") {
        return {
          app: { getPath: () => fresh, isPackaged: false, whenReady: async () => {} },
          safeStorage: { isEncryptionAvailable: () => true, decryptString: (v) => v, encryptString: (v) => v }
        };
      }
      return originalLoad2.apply(this, arguments);
    };
    delete require.cache[require.resolve(path.join(ROOT, "src/main/settings.cjs"))];
    const settings2 = require(path.join(ROOT, "src/main/settings.cjs"));
    Module._load = originalLoad2;
    const data = settings2.getSettings();
    assert.strictEqual(data.advanced.cloud, null, "无 advanced 档默认自动");
    assert.strictEqual(data.advancedEffective.cloud.maxToolRounds, 25, "默认表 25");
  });
}

/* ── F 组：回归钩子（钳制语义变更后 v3-19-0 A3/G6 同步） ── */

async function runRegressionGuardTests() {
  console.log("── F 组：回归守门 ──");

  await test("F1 v3-19-0 旧断言应已同步新语义（A3 钳制 / G6 文案）", () => {
    const old19 = read("test-v3-19-0.cjs");
    assert.ok(old19.includes("字段级钳制"), "A3 应已改写字段级钳制语义");
    assert.ok(!old19.includes("assert.strictEqual(saved.advanced.ssh, null, \"SSH 组应整组回自动"), "A3 旧整组回自动断言应清除");
    assert.ok(old19.includes("超出合法范围，已自动修正到边界值"), "G6 应断言新钳制提示");
  });
}

(async () => {
  await runSanitizeTests();
  await runMainWiringTests();
  await runRendererWiringTests();
  await runVmSmokeTests();
  await runIntegrationTests();
  await runRegressionGuardTests();
  await test("G1 package.json 版本 = 3.24.6", () => {
    assert.strictEqual(pkg.version, "3.24.6");
  });
  console.log(`\n=== test-v3-24-4.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})().catch((error) => { console.error("测试运行失败：", error); process.exitCode = 1; });