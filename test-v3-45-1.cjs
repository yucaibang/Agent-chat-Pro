"use strict";
/**
 * test-v3-45-1.cjs — v3.45.1 守门（口令「软件开发继续」装机前代码自查出品，沿 v3.42.3/v3.43.1/v3.43.2/v3.44.2 先例）
 *
 * 自查盲区实锤（test-v3-44-0 C 段 mock 全用 gitcode，官网线路借线形态零覆盖）：
 *   Bug #1 关于页「发现新版本」行「来源」三元只认两线路——v3.45.0 官网线路（priority 0 借线主位）
 *          借线成功时 sourceId="web" 落 else 错报「线路一 GitCode」（核心验收点②显示错报）
 *   Bug #2 检测中文案固定「三线路并查」——updateChannel 单线路 mode（web/gitcode/github）时与真实行为不符
 *          （v3.44.2 曾订正过同款「失败自动切线路二」与真实行为不符）
 *   Bug #3 unreachable 兜底文案「两条线路均未取得版本信息」——三线路时代未同步
 *   Bug #4 settings.cjs normalizeUpdateChannel 注释/渲染层收集链注释停留三态口径（v3.45.0 漏同步）
 *
 * 修复形态（renderer.js）：updateSourceLabel(sourceId) 三态显式映射 + 未知兜底；
 *   检测中 hint 随 #update-channel select 当前值动态；兜底文案去线路数硬编码。
 * 装置承 test-v3-44-0 C 段架构（vm 假 DOM 运行时冒烟，I 段铁律：renderer 接线改动必过运行时求值）。
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = __dirname;
const rendererSrc = fs.readFileSync(path.join(ROOT, "src/renderer/renderer.js"), "utf8");
const settingsSrc = fs.readFileSync(path.join(ROOT, "src/main/settings.cjs"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (error) { failed += 1; console.error(`  ❌ ${label}\n${String(error && error.stack || error)}`); }
};

/* ── 装置（承 test-v3-44-0 mkRuntime 架子；vm 跨 realm 数组一律 JSON 比较） ── */
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
const methodMocks = {
  listConversations: async () => [],
  listModes: async () => [],
  getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub }),
  getThinkingProfile: async () => ({ profile: null }),
  onUpdateEvent: (handler) => { capturedProgressDispatch.push(handler); }
};
const capturedProgressDispatch = [];
const defaultResult = () => ({
  edition: "main", productName: "Agent Chat Pro", conversations: [], items: [], messages: [], tools: [],
  files: [], entries: [], results: [], valid: true, invalidKeys: [], ok: true, path: "",
  lastConnectionMode: "", version: "3.45.1",
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

const fdSeed = new Map();

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
    querySelector: (sel) => rt.getFake(sel), querySelectorAll: (sel) => rt.getFake(sel).querySelectorAll(sel),
    getElementById: (id) => rt.getFake(`#${id}`),
    createElement: (tag) => { const el = rt.makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    addEventListener() {}, removeEventListener() {}
  },
  navigator: windowStub.navigator, localStorage: windowStub.localStorage,
  location: windowStub.location, matchMedia: windowStub.matchMedia,
  getComputedStyle: windowStub.getComputedStyle,
  FormData: function FormData() { return { get: (name) => (fdSeed.has(String(name)) ? fdSeed.get(String(name)) : "") }; },
  Event: function FakeEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  CustomEvent: function FakeCustomEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  alert() {}, confirm: () => false, prompt: () => null,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  addEventListener() {}, removeEventListener() {}
};
sandbox.globalThis = sandbox;

/* ── A. vm 假 DOM 运行时冒烟（修复态行为断言） ── */
async function runVmSmokeTests() {
  const source = rendererSrc + "\n;globalThis.__acpSmoke = { runAboutUpdateDownload, renderUpdateReadyState, describeUpdateAttempts, updateSourceLabel };";

  await test("A1. renderer.js vm 假 DOM 全量求值零异常（v3.45.1 导出含 updateSourceLabel）", () => {
    let error = null;
    try { vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: "renderer.js" }); }
    catch (err) { error = err; }
    assert.ifError(error);
    const smoke = sandbox.__acpSmoke;
    assert.ok(smoke, "求值后应挂 __acpSmoke（v3.45.1 导出对位）");
    assert.ok(typeof smoke.updateSourceLabel === "function", "updateSourceLabel 应为顶层函数");
    vmEq(smoke.updateSourceLabel("web"), "线路三 官网清单（安装包走附件直链）", "web 态文案");
    vmEq(smoke.updateSourceLabel("gitcode"), "线路一 GitCode", "gitcode 态文案");
    vmEq(smoke.updateSourceLabel("github"), "线路二 GitHub", "github 态文案");
    vmEq(smoke.updateSourceLabel("other"), "来源 other", "未知态兜底（不再落 else 错报）");
  });

  await test("A2. Bug#1 修复态：sourceId=web 借线 → 「发现新版本」行显「线路三 官网清单」，不再错报 GitCode（修复前=两线路三元落 else）", async () => {
    methodMocks.checkUpdate = async () => ({ status: "update", currentVersion: "3.45.1", remoteVersion: "v3.46.0", sourceId: "web", asset: { name: "Agent Chat Pro-3.46.0-Setup.exe", url: "http://x/n.exe", size: 10 }, sumsAsset: null, sources: [], attempts: [] });
    await rt.getFake("#about-check-update")._listeners.click();
    const status = rt.getFake("#about-update-status");
    const found = status.children.find((el) => String(el.textContent).includes("发现新版本"));
    assert.ok(found, "update 态应有发现新版本行");
    assert.ok(String(found.textContent).includes("线路三 官网清单"), "官网借线应显线路三（修复核心断言）");
    assert.ok(!String(found.textContent).includes("线路一 GitCode"), "不得错报线路一（修复前形态死断言）");
  });

  await test("A3. 回归：sourceId=gitcode/github 两线路文案照旧（不因三态化破坏既有形态）", async () => {
    methodMocks.checkUpdate = async () => ({ status: "update", currentVersion: "3.45.1", remoteVersion: "v3.46.0", sourceId: "github", asset: { name: "Agent Chat Pro-3.46.0-Setup.exe", url: "http://x/n.exe", size: 10 }, sumsAsset: null, sources: [], attempts: [] });
    await rt.getFake("#about-check-update")._listeners.click();
    const found = rt.getFake("#about-update-status").children.find((el) => String(el.textContent).includes("发现新版本"));
    assert.ok(found && String(found.textContent).includes("线路二 GitHub"), "github 借线应显线路二");
    methodMocks.checkUpdate = async () => ({ status: "update", currentVersion: "3.45.1", remoteVersion: "v3.46.0", sourceId: "gitcode", asset: { name: "Agent Chat Pro-3.46.0-Setup.exe", url: "http://x/n.exe", size: 10 }, sumsAsset: null, sources: [], attempts: [] });
    await rt.getFake("#about-check-update")._listeners.click();
    const found2 = rt.getFake("#about-update-status").children.find((el) => String(el.textContent).includes("发现新版本"));
    assert.ok(found2 && String(found2.textContent).includes("线路一 GitCode"), "gitcode 借线应显线路一");
  });

  await test("A4. Bug#2 修复态：检测中文案随 #update-channel 当前值动态（auto=三线路并查；web=仅查单线路）", async () => {
    rt.getFake("#update-channel").value = "auto";
    methodMocks.checkUpdate = async () => new Promise((resolve) => { /* 挂住：读检测中文案后再放行 */ });
    const pending = rt.getFake("#about-check-update")._listeners.click();
    assert.ok(String(rt.getFake("#about-update-status").textContent).includes("三线路（官网清单 / GitCode / GitHub）并查"), "auto 态应显三线路并查");
    assert.ok(String(rt.getFake("#about-update-status").textContent).includes("正在检测更新"), "检测中文案在场");
    pending.then(() => {}, () => {});
    methodMocks.checkUpdate = async () => ({ status: "latest", currentVersion: "3.45.1", remoteVersion: "3.45.1", sourceId: null, asset: null, sumsAsset: null, sources: [], attempts: [] });
    await rt.getFake("#about-check-update")._listeners.click();

    rt.getFake("#update-channel").value = "web";
    let releaseSecond = () => {};
    methodMocks.checkUpdate = () => new Promise((resolve) => { releaseSecond = resolve; });
    const pending2 = rt.getFake("#about-check-update")._listeners.click();
    const hint2 = String(rt.getFake("#about-update-status").textContent);
    assert.ok(hint2.includes("仅查单线路"), "web 单线路态应显「仅查单线路」（不再固定三线路并查）");
    assert.ok(hint2.includes("官网清单"), "单线路名随所选线路");
    releaseSecond({ status: "latest", currentVersion: "3.45.1", remoteVersion: "3.45.1", sourceId: null, asset: null, sumsAsset: null, sources: [], attempts: [] });
    await pending2;
    assert.ok(!String(rt.getFake("#about-update-status").textContent).includes("仅查单线路"), "悬等放行后检测中态清理");
  });

  await test("A5. Bug#3 修复态：unreachable 全空兜底文案不再含「两条线路」（三线路时代硬编码死断言）", () => {
    const text = sandbox.__acpSmoke.describeUpdateAttempts({ attempts: [], sources: [] });
    assert.ok(String(text).includes("未取得任何线路"), "兜底文案=线路数无关形态");
    assert.ok(!String(text).includes("两条线路"), "修复前「两条线路」硬编码死断言");
    // 常规形态回归：attempts 逐行 + sources 兜底路径不变
    const withAttempts = sandbox.__acpSmoke.describeUpdateAttempts({ attempts: ["web: manifest: HTTP 404"], sources: [] });
    assert.ok(String(withAttempts).includes("web: manifest: HTTP 404"), "attempts 逐行形态不变");
    const withSources = sandbox.__acpSmoke.describeUpdateAttempts({ attempts: [], sources: [{ label: "gitcode", error: "release: HTTP 502" }] });
    assert.ok(String(withSources).includes("gitcode：release: HTTP 502"), "sources 兜底形态不变");
  });
}

/* ── B. 源码锚 / 版本自洽 ── */
async function runSourceTests() {
  await test("B1. renderer.js 源码锚：updateSourceLabel 三态显式映射在场；两线路三元死形态清零", () => {
    assert.ok(rendererSrc.includes('function updateSourceLabel'), "updateSourceLabel 定义缺失");
    assert.ok(rendererSrc.includes('if (sourceId === "web") return "线路三 官网清单'), "web 态映射缺失");
    assert.ok(!rendererSrc.includes('sourceId === "github" ? "线路二 GitHub" : "线路一 GitCode"'), "修复前两线路三元残留（v3.44.0 死形态）");
    assert.ok(!rendererSrc.includes("两条线路均未取得"), "修复前「两条线路」兜底文案残留");
  });

  await test("B2. settings.cjs / renderer.js 收集链注释四态同步（v3.45.0 漏同步的注释陈旧一并清）", () => {
    assert.ok(settingsSrc.includes("v3.45.0 起含官网 manifest"), "normalizeUpdateChannel 注释应提官网 manifest");
    assert.ok(!settingsSrc.includes("三态 auto（默认双线路自动降级）"), "settings.cjs 三态旧注释残留");
    assert.ok(rendererSrc.includes("v3.44.0 更新线路（四态，v3.45.0 起含官网 manifest）"), "收集链注释应同步四态");
    assert.ok(!rendererSrc.includes("v3.44.0 更新线路：auto（默认）/ gitcode（仅线路一）/ github（仅线路二）"), "收集链三态旧注释残留");
  });

  await test("B3. 版本自洽：package.json=3.45.1 且 README badge 对齐（v3.43.2 D1 教训）", () => {
    assert.strictEqual(pkg.version, "3.45.1", "package.json version");
    assert.ok(readme.includes("version-3.45.1-blue.svg"), "README version badge");
  });
}

(async () => {
  console.log("\n── A. vm 假 DOM 运行时冒烟（关于页三线路文案修复态） ──");
  await runVmSmokeTests();
  console.log("\n── B. 源码锚 / 版本自洽 ──");
  await runSourceTests();
  console.log("");
  if (failed) { console.error(`test-v3-45-1 ✗ ${failed} 项失败`); process.exit(1); }
  console.log("test-v3-45-1 全绿");
})();
