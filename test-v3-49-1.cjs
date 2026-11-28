"use strict";

/**
 * v3.49.1 守门：自查轮（装机前代码自查，对 v3.49.0 十项功能更改代码面深度自查修复）
 *
 *   本轮零新功能，纯正确性修复。三实锤 bug 全部施工完毕：
 *
 *   Bug#1（功能级·云端模型快捷切换 custom 死胡同）
 *     main.cjs cloud:fetch-models handler 只兜底 merged.apiKey，不兜底 baseUrl——
 *     输入栏浮层 renderThinkModelPopover 对 custom 服务商只传静态表 baseUrl=""，
 *     用户已存的自定义 API 地址（settings cloudAiBaseUrl）永远到不了拉取端点 →
 *     恒报「请先填写 API 地址再拉取」（明明已填过）。修复=custom 时兜底已存地址；
 *     非 custom 拉取端点不读 baseUrl（PULL_ENDPOINTS 官方固定端点），兜底零侵入。
 *
 *   Bug#2（显示级·启动红条双 v，v3.49.0 十项⑨红条文案）
 *     updater.cjs remoteVersion = maxVersion(原始串) 恒带 v 前缀（官网 manifest=`v${版本}`、
 *     GitCode/GitHub tag=`v3.49.0`）——红条文案再拼 `v${remoteVersion}` → 显示「vv3.49.0」。
 *     修复=与关于页同形态（remoteVersion 已带 v，不再二次加前缀）。
 *
 *   Bug#3（状态级·cloud→SSH/群聊→cloud 顶行可点态被 bound 早退吞掉）
 *     bindThinkModelSwitcher 把 addClass("think-selectable")+title 赋值放在
 *     `if (bound) return` 之后——SSH/本机/群聊态的让位清理（remove 类+title 改写为
 *     「工作模式/逐成员挡位」）之后切回云端，恢复动作被早退吞掉：顶行永远停留在
 *     SSH/群聊提示态（实际点击仍弹浮层=显示与功能错位）。修复=可点态与标题挪到早退
 *     之前每次重挂（事件仍只绑一次）。
 *
 * A 组行为级（真 require cloud-models + vm 假 DOM 全 renderer 真跑——48-1 mkRuntime 架子）
 * B 组源码锚（三修复注记在册+回归面零位移）
 * C 组版本滚动锚（≥ 下限+badge 自洽滚动式——49-0 同款）
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const mainSrc = read("src/main/main.cjs");
const updaterSrc = read("src/main/updater.cjs");
const cloudModelsModule = require(path.join(ROOT, "src/main/cloud-models.cjs"));
const rendererSrc = read("src/renderer/renderer.js");
const htmlSrc = read("src/renderer/index.html");
const stylesSrc = read("src/renderer/styles.css");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const readme = read("README.md");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((error) => { failed++; failures.push(`${name}: ${error.message}`); console.log(`  ✗ ${name}: ${error.message}`); });
}

/* ═══════════ A 组：行为级真跑 ═══════════ */

async function runBehaviorTests() {
  // ── Bug#1：custom 拉取链行为真跑（handler 兜底合并后的 merged 形态直喂真函数）──
  await test("A1 Bug#1 拉取链真跑：custom+已存地址直通官方约定 <baseUrl>/models；空 baseUrl=修复前死胡同形态如实拒；非 custom 不被 baseUrl 劫", async () => {
    const { fetchProviderModels } = cloudModelsModule;
    assert.strictEqual(typeof fetchProviderModels, "function", "fetchProviderModels 应在册");
    const captured = [];
    const fakeFetch = async (url, init) => {
      captured.push({ url: String(url), headers: { ...((init && init.headers) || {}) } });
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ data: [{ id: "gpt-5.4-mini" }, { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }] })
      };
    };
    // 幕一：custom + 兜底后的已存地址（main handler merged 形态）→ 应真实请求 <地址>/models
    captured.length = 0;
    const okRes = await fetchProviderModels({ provider: "custom", apiKey: "k-test", baseUrl: "https://relay.example.com/v1/" }, fakeFetch);
    assert.strictEqual(okRes.ok, true, `幕一应拉取成功（实际 ${okRes.reason || ""}）`);
    assert.strictEqual(okRes.count, 2, "幕一应解析出 2 个模型");
    assert.strictEqual(captured.length, 1, "幕一应只发一次请求");
    assert.strictEqual(captured[0].url, "https://relay.example.com/v1/models", "幕一 URL 应=尾斜杠剥掉后拼 /models（modelsUrlForCustom 契约）");
    assert.strictEqual(captured[0].headers.Authorization, "Bearer k-test", "幕一鉴权头=Bearer（custom 默认 bearer 族）");
    // 幕二：修复前死胡同形态（浮层只传静态表 baseUrl=""）→ 如实拒+零发出（锁兜底必要性）
    captured.length = 0;
    const emptyRes = await fetchProviderModels({ provider: "custom", apiKey: "k-test", baseUrl: "" }, fakeFetch);
    assert.strictEqual(emptyRes.ok, false, "幕二应拒绝");
    assert.strictEqual(emptyRes.reason, "请先填写 API 地址再拉取", "幕二文案应=「请先填写 API 地址再拉取」（修复前 custom 浮层恒报这句）");
    assert.strictEqual(captured.length, 0, "幕二不应发出请求");
    // 幕三：非 custom 不被 baseUrl 兜底劫走——zhipu 始终走 PULL_ENDPOINTS 官方端点（兜底零侵入的行为证据）
    captured.length = 0;
    const zhipuRes = await fetchProviderModels({ provider: "zhipu", apiKey: "k-test", baseUrl: "https://evil.example.com" }, fakeFetch);
    assert.strictEqual(zhipuRes.ok, true, "幕三官方链应拉取成功");
    assert.strictEqual(captured[0].url, "https://open.bigmodel.cn/api/paas/v4/models", "幕三 URL 应=官方固定端点（baseUrl 兜底不侵入非 custom 路径）");
  });

  await test("A2 main.cjs handler 兜底合并真形态：merged 双字段+仅 custom 兜底地址（源码锚，行为面由 A1 直喂真函数覆盖）", () => {
    assert.ok(mainSrc.includes("let savedBaseUrlForCustom = \"\";"), "custom 兜底地址变量在册（v3.49.1 修复）");
    assert.ok(mainSrc.includes('if (String(savedConfig.provider || "") === "custom") savedBaseUrlForCustom = String(savedConfig.baseURL || "").trim();'), "仅 custom 服务商兜底已存地址");
    assert.ok(mainSrc.includes("baseUrl: String(payload.baseUrl || \"\").trim() || savedBaseUrlForCustom"), "merged.baseUrl 兜底链在册（payload 优先→已存地址兜底）");
    assert.ok(mainSrc.includes("apiKey: String(payload.apiKey || \"\").trim() || savedApiKey"), "apiKey 兜底链不变（v3.21.0 行为保留）");
    assert.ok(mainSrc.includes("const savedConfig = getCloudAiConfig();"), "已存配置读取在册");
    assert.ok(mainSrc.includes("v3.49.1 自查修复（快捷切换模型浮层 custom 死胡同）"), "修复注记在册");
  });

  // ── Bug#2：启动红条文案真跑（vm 假 DOM 全 renderer + 推进 4s 静默检测计时器）──

  await test("A3 Bug#2/Bug#3 vm 假 DOM 全 renderer 真跑求值+__acpThink 导出在（渲染链可驱动）", async () => {
    assert.strictEqual(typeof THINK().refresh, "function", "refreshComposerModePopup 应经后门摘出");
    assert.ok(typeof THINK() === "object" && THINK().refresh === THINK().refresh, "导出应稳定");
  });

  await test("A4 Bug#2 红条文案真跑：4s 静默检测+checkUpdate=update 态 → toast 文案单 v（remoteVersion 恒带 v 前缀不再二次加）", async () => {
    checkUpdateState.result = null;
    checkUpdateState.throwError = new Error("网络断开");
    rt.getFake("#update-toast").textContent = "";
    rt.getFake("#update-toast").hidden = true;
    // 幕零：检测抛错 → 完全静默（失败/latest 不惊扰用户）
    const fourSecond = timers.timeouts.find((item) => item.ms === 4000);
    assert.ok(fourSecond, "启动 4s 静默检测计时器应经真跑在册");
    await fourSecond.fn();
    assert.strictEqual(String(rt.getFake("#update-toast").textContent), "", "抛错幕 toast 应保持空白");
    assert.strictEqual(Boolean(rt.getFake("#update-toast").hidden), true, "抛错幕 toast 应保持隐藏");
    // 幕一：checkUpdate=update+remoteVersion 恒带 v 形态 → 文案单 v（修复前显示「vv3.49.1」）+亮条
    checkUpdateState.throwError = null;
    checkUpdateState.result = { status: "update", remoteVersion: "v3.49.1", currentVersion: "3.49.1", sourceId: "web" };
    await fourSecond.fn();
    assert.strictEqual(String(rt.getFake("#update-toast").textContent), "🆕 发现新版本 v3.49.1 · 点击立即更新", "文案应=单 v（v3.49.1 修复：与关于页同形态）");
    assert.strictEqual(Boolean(rt.getFake("#update-toast").hidden), false, "update 态 toast 应点亮");
  });

  await test("A5 Bug#3 顶行可点态恢复真跑：cloud 初绑可点 → 模拟 SSH/群聊让位清理 → 切回 cloud refresh 恢复可点态+标题（修复前被 bound 早退吞掉）", async () => {
    // 前置：连接模式拨云端（产线同链：写表单值→updateConnectionModeUI 解析 currentConnectionMode；
    // elements.form.elements.namedItem → #form-named-item 假件）
    rt.getFake("#form-named-item").value = "cloud";
    await THINK().setMode();
    await flush();
    const modelEl = rt.getFake("#think-model");
    // 幕一：初次 refresh（cloud 态）→ 可点+标题
    await THINK().refresh();
    assert.strictEqual(Boolean(modelEl.classList.contains("think-selectable")), true, "幕一应有可点态");
    assert.strictEqual(String(modelEl.title), "点击切换模型（按官方模型列表，分视觉 / 文本两组）", "幕一标题应在册");
    // 幕二：模拟 SSH/本机/群聊态让位清理（与产线 SSH 分支/群聊段同形态：remove 类+title 改写）
    modelEl.classList.remove("think-selectable");
    modelEl.title = "工作模式";
    assert.strictEqual(Boolean(modelEl.classList.contains("think-selectable")), false, "幕二前置：让位清理已摘可点态");
    // 幕三：切回云端（cloud 态再 refresh）→ 可点态与标题必须恢复（修复③：每次 bind 重挂可点态/标题）
    await THINK().refresh();
    assert.strictEqual(Boolean(modelEl.classList.contains("think-selectable")), true, "切回云端应重挂可点态（v3.49.1 修复）");
    assert.strictEqual(String(modelEl.title), "点击切换模型（按官方模型列表，分视觉 / 文本两组）", "切回云端标题应恢复（修复前停留「工作模式」）");
    // 幕四：事件只绑一次（修复③定案=三态拔顶层，bound 跨 refresh 持久）——
    // 修复前 ctx 在 refresh 体内每次重置=bound 门永不生效：两次 refresh 累计绑 2 个 click 监听器（泄漏+点击闪断）
    const clickCount = (el) => Number((el._listeners && el._listeners.click ? el._listeners.click.length : 0));
    assert.strictEqual(clickCount(modelEl), 1, `两次 refresh 后 #think-model click 监听器应恰 1 个（实际 ${clickCount(modelEl)}——修复前=2 泄漏）`);
    assert.strictEqual(clickCount(rt.getFake("#think-model-arrow")), 1, `箭头 click 监听器应恰 1 个（实际 ${clickCount(rt.getFake("#think-model-arrow"))}）`);
    // 再来一轮 refresh 复核幂等（修复后继续多轮重开不再累加）
    await THINK().refresh();
    assert.strictEqual(clickCount(modelEl), 1, `第三次 refresh 后仍应 1 个（实际 ${clickCount(modelEl)}）`);
  });
}

/* ═══════════ vm 假 DOM 装置（承 test-v3-48-1 mkRuntime 架子） ═══════════ */

const vmEq = (actual, expected, label) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), label);

function makeStyle() {
  const store = {};
  return {
    setProperty(k, v) { store[String(k)] = String(v); },
    removeProperty(k) { delete store[String(k)]; },
    getPropertyValue: (k) => (k in store ? store[k] : ""),
    get cssText() { return Object.entries(store).map(([k, v]) => `${k}: ${v}`).join("; "); }
  };
}

const mkRuntime = () => {
  function querySubtree(root, sel, all) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        const hit = matchesSel(child, sel);
        if (hit) { out.push(child); if (!all) return out; }
        walk(child);
      }
      return out;
    };
    return walk(root);
  }
  function matchesSel(el, sel) {
    const s = String(sel || "").trim();
    if (s.startsWith("#")) return el.id === s.slice(1);
    if (s.startsWith(".")) return el.classList.contains(s.slice(1));
    return el.tagName === s.toUpperCase();
  }
  function makeFakeEl() {
    const classes = new Set();
    const children = [];
    let innerHTMLValue = "";
    return {
      value: "", checked: false, type: "", placeholder: "", textContent: "",
      get innerHTML() { return innerHTMLValue; },
      set innerHTML(v) { innerHTMLValue = String(v); if (innerHTMLValue === "" && children.length) children.length = 0; },
      hidden: false, disabled: false, tagName: "DIV", draggable: false, id: "",
      get className() { return [...classes].join(" "); },
      set className(v) { classes.clear(); for (const part of String(v || "").split(/\s+/)) if (part) classes.add(part); },
      title: "", role: "", tabIndex: 0,
      scrollTop: 0, scrollHeight: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0,
      files: [], children, style: makeStyle(), dataset: {},
      elements: { namedItem: () => getFake("#form-named-item") },
      form: { elements: { namedItem: () => getFake("#named-form-item") } },
      classList: {
        toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name); return on; },
        add(...names) { for (const n of names) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); }
      },
      addEventListener(type, fn) { const k = String(type || "click"); (this._listeners = this._listeners || {})[k] = [...(this._listeners[k] || []), fn]; },
      removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false, toggleAttribute: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement: () => null, hasChildNodes() { return children.length > 0; },
      append(...nodes) { for (const node of nodes) children.push(node); },
      prepend(...nodes) { for (const node of nodes) children.unshift(node); },
      appendChild(node) { children.push(node); return node; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      before(...nodes) { for (const node of nodes) children.push(node); },
      closest() { return null; }, contains() { return false; },
      querySelector(sel) { return querySubtree({ children }, sel, false)[0] || null; },
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
  return { makeFakeEl, getFake, querySubtree, matchesSel, cache };
};

const rt = mkRuntime();
const gatesStub = { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true };

/* checkUpdate 假面（幕布驱动）+ 通用方法缺省 */
const checkUpdateState = { result: null, throwError: null };
const methodMocks = {
  listConversations: async () => [],
  listModes: async () => [],
  getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub }),
  getThinkingProfile: async () => ({ profile: null }),
  checkUpdate: async () => {
    if (checkUpdateState.throwError) throw checkUpdateState.throwError;
    if (checkUpdateState.result) return checkUpdateState.result;
    return { status: "latest", currentVersion: "3.49.1" };
  }
};

const defaultResult = () => ({
  edition: "main", productName: "Agent Chat Pro", conversations: [], items: [], messages: [], tools: [],
  files: [], entries: [], results: [], valid: true, invalidKeys: [], ok: true, path: "",
  lastConnectionMode: "", version: "3.49.1",
  host: "", port: 22, username: "", wakeName: "", clientLabel: "",
  workingDirectory: "", dataDirectory: "", skipPermissions: false,
  showSignalLights: true, connectionMode: "cloud", localEngine: "claude",
  hasPassword: true, hasCloudAiConfig: true,
  cloudAiProvider: "zhipu", cloudAiBaseUrl: "", cloudAiModel: "glm-5",
  thinkingChoices: {}, theme: "dark"
});

const windowStub = {
  window: null, self: null,
  agentChatPro: new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop in _t) return _t[prop];
      if (prop in methodMocks) return methodMocks[prop];
      return async () => defaultResult();
    },
    set(_t, prop, v) { _t[prop] = v; return true; }
  }),
  addEventListener() {}, removeEventListener() {},
  location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
  matchMedia: () => ({ matches: false, media: "", addEventListener() {}, addListener() {}, removeListener() {} }),
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

const timers = { timeouts: [], intervals: [] };

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
    body: rt.getFake("body"), head: rt.getFake("head"), documentElement: rt.getFake("documentElement"),
    activeElement: null,
    querySelector: (sel) => rt.getFake(sel), querySelectorAll: () => [],
    getElementById: (id) => rt.getFake(`#${id}`),
    createElement: (tag) => { const el = rt.makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    addEventListener() {}, removeEventListener() {}
  },
  navigator: windowStub.navigator, localStorage: windowStub.localStorage,
  location: windowStub.location, matchMedia: windowStub.matchMedia,
  getComputedStyle: windowStub.getComputedStyle,
  FormData: function FormData() { return { get: () => "" }; },
  Event: function FakeEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  CustomEvent: function FakeCustomEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  setTimeout: (fn, ms) => { timers.timeouts.push({ fn, ms: Number(ms || 0) }); return timers.timeouts.length - 1; },
  clearTimeout: (id) => { if (timers.timeouts[id]) timers.timeouts[id] = null; },
  setInterval: (fn) => { timers.intervals.push(fn); return timers.intervals.length - 1; },
  clearInterval: (id) => { if (timers.intervals[id]) timers.intervals[id] = null; },
  addEventListener() {}, removeEventListener() {}
};
sandbox.globalThis = sandbox;

/* 渲染层内部态透出口（refreshComposerModePopup/updateConnectionModeUI 顶层函数直取——48-1 SOURCE_SUFFIX 先例） */
const SOURCE_SUFFIX = "\n;globalThis.__acpThink = { refresh: refreshComposerModePopup, setMode: updateConnectionModeUI };";
const vmSource = rendererSrc + SOURCE_SUFFIX;
try { vm.createContext(sandbox); vm.runInContext(vmSource, sandbox, { filename: "renderer.js" }); } catch (error) { console.error("renderer.js eval 失败:", error); process.exit(1); }
const THINK = () => sandbox.__acpThink;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

void vmEq;

/* ═══════════ B 组：源码锚 ═══════════ */

async function runAnchorTests() {
  await test("B1 修复②锚：红条文案单 v（与关于页同形态）+ 旧双 v 形态不得再现", () => {
    assert.ok(rendererSrc.includes("🆕 发现新版本 ${result.remoteVersion} · 点击立即更新"), "新单 v 文案在册");
    assert.ok(!rendererSrc.includes("发现新版本 v${result.remoteVersion}"), "旧双 v 文案（v${remoteVersion}）不得再现");
    assert.ok(rendererSrc.includes("v3.49.1 自查修复"), "红条修复注记在册");
    // 关于页形态本就正确（v3.49.0 在册），回归面零位移
    assert.ok(rendererSrc.includes("发现新版本 ${result.remoteVersion}（当前 ${result.currentVersion} · ${updateSourceLabel(result.sourceId)}）"), "关于页文案形态不变");
  });

  await test("B2 修复②根因锚：updater.cjs remoteVersion 恒带 v 前缀的三条来源（官网 manifest/释放 tag）", () => {
    assert.ok(updaterSrc.includes('releaseVersion: `v${releaseVersion}`'), "官网 manifest 线路 releaseVersion 带 v 前缀");
    assert.ok(updaterSrc.includes("result.releaseVersion = latestRelease.tag_name;"), "Release 线路=tag_name 原始串（用户 tag 全 v 形态）");
    assert.ok(updaterSrc.includes("const remoteVersion = maxVersion("), "remoteVersion=maxVersion(原始串) 在册");
    assert.ok(updaterSrc.includes("sources.flatMap((item) => [item.releaseVersion, item.tagVersion]).filter(Boolean)"), "release/tag 全集合聚合在册");
  });

  await test("B3 修复③锚：可点态与标题必须在 bound 早退之前（源码顺序断言）", () => {
    const addIdx = rendererSrc.indexOf('modelEl.classList.add("think-selectable");\n    modelEl.title = "点击切换模型');
    assert.ok(addIdx > 0, "addClass+title 相邻赋值形态应在册");
    const earlyReturnIdx = rendererSrc.indexOf("if (thinkModelSwitcherCtx.bound) return;");
    assert.ok(earlyReturnIdx > addIdx, `可点态/标题赋值应先于 bound 早退（add=${addIdx} return=${earlyReturnIdx}）`);
    assert.ok(rendererSrc.includes("v3.49.1 自查修复：可点态与标题必须在 bound 早退**之前**每次重挂"), "修复注记在册");
    // 让位清理保留（非云端/群聊仍要摘）：
    assert.ok(rendererSrc.includes('modelEl.classList.remove("think-selectable");'), "SSH/本机让位清理保留");
    assert.ok(rendererSrc.includes('modelEl.title = "工作模式";'), "SSH 标题改写保留");
  });

  await test("B4 回归面零位移：v3.49.0 十件关键锚抽查（红条骨架/箭头浮层/eco 注入/分组/拉取链兜底）", () => {
    // ⑩ 红条骨架与点击链
    assert.ok(htmlSrc.includes('<button id="update-toast" type="button" class="update-toast" hidden title="查看并安装新版本"></button>'), "红条按钮骨架在册");
    assert.ok(rendererSrc.includes("aboutCheckUpdateButton.click(); // 复用关于页检测体"), "点击红条→复用关于页检测在册");
    assert.ok(rendererSrc.includes("runAboutUpdateDownload(); // 检测完自动开始更新"), "自动下载链在册");
    // ④ 箭头/浮层骨架
    assert.ok(htmlSrc.includes('id="think-model-arrow"'), "箭头元素在册");
    assert.ok(htmlSrc.includes('id="think-model-popover"'), "浮层容器在册");
    assert.ok(rendererSrc.includes("const bindThinkModelSwitcher = (provider, model) => {"), "绑定函数在册（函数本体零位移）");
    // ① eco 真实省
    assert.ok(rendererSrc.includes("真实省 token：强制该模型最低思考（关思考或最低挡）"), "eco 云端 hint 在册");
    assert.ok(mainSrc.includes("fetchProviderModels(merged)"), "拉取主链调用在册");
    // ⑦ 状态色/⑨ 滚动条（styles.css 零位移抽查）
    assert.ok(stylesSrc.includes(".tool-summary.running"), "折叠卡执行中黄在册");
    assert.ok(stylesSrc.includes('[data-theme="light"] { color-scheme: light; }'), "浅色 color-scheme 在册");
  });
}

/* ═══════════ C 组：版本滚动锚 ═══════════ */

function badgeOf(text) {
  return (text.match(/tests-(\d+)%20files/) || [])[1];
}

async function runVersionTests() {
  await test("C1. 版本滚动锚：package.json ≥3.49.0 且 README badge 自洽", () => {
    const parts = pkg.version.split(".").map(Number);
    const atLeast = (other) => parts[0] > other[0] || (parts[0] === other[0] && (parts[1] > other[1] || (parts[1] === other[1] && parts[2] >= other[2])));
    assert.ok(atLeast([3, 49, 0]), `版本应 ≥3.49.0（实际 ${pkg.version}）`);
    assert.ok(readme.includes(`version-${pkg.version}`), "README version badge 应与 package.json 一致");
    assert.ok(badgeOf(readme) && Number(badgeOf(readme)) >= 70, `tests badge 应 ≥70（实际 ${badgeOf(readme)}）`);
  });

  await test("C2. 装置自检：守门文件自身在清单（badge=全部 test-*.cjs 件数）", () => {
    const files = fs.readdirSync(ROOT).filter((name) => /^test-.*\.cjs$/.test(name));
    assert.ok(files.includes("test-v3-49-1.cjs"), "本守门应在清单");
    assert.strictEqual(Number(badgeOf(readme)), files.length, `badge 应=守门件数（badge=${badgeOf(readme)} files=${files.length}）`);
  });
}

(async () => {
  console.log("── A 组：三修复行为级真跑 ──");
  await runBehaviorTests();
  console.log("── B 组：源码锚 ──");
  await runAnchorTests();
  console.log("── C 组：版本滚动锚 ──");
  await runVersionTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`);
  if (failed > 0) {
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exit(1);
  }
})();
