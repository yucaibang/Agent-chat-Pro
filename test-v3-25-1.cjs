"use strict";
/* ═══════════════════════════════════════════════════════════════════
 * test-v3-25-1.cjs — 思考挡位滑动条重构（thumb 正圆 + 轨道刻度 + 文案同几何对齐）
 *
 * 需求来源（2026-10-24 DeepSeek 给的建议，用户转交落地）：
 *   ① thumb 由 v3.24.3 胶囊（26×14）改回正圆小圆点（拖动 scale+发光保留）
 *   ② 轨道内部加与挡位数量相等的刻度点（均匀分布）
 *   ③ 挡位文案与刻度点绝对居中对齐（原 flex space-between 文字中心与
 *      thumb 中心有系统性偏差——首尾挡最明显）
 *   ④ 动态适配：各家挡位数量 2~7 档不等（glm5=7 / deepseek=4 /
 *      kimi/豆包=2 / SSH 5 档），刻度数、间距、文案排版全部 JS 动态计算，
 *      不写死
 * 铁边界：只动渲染层（renderer.js/styles.css/index.html），
 *         thinking-levels.cjs 主进程取值与注入逻辑零触碰
 *
 * 几何核心（renderer.js thinkMarkLefts，calc 形态）：input range 的 thumb 中心可动区
 *   是 [半径R, 轨道宽-R]（首尾挡 thumb 不出轨）→ 第 i 挡中心
 *   left_i = calc(17px + (100% - 34px)*i/(N-1))。刻度点、文案、thumb 三层同用此函数。
 *   （第六发胶囊 26×14 终结于 v3.25.3：用户 2026-10-27 令「我想让滑动条是圆的」+批注图白色圆圈
 *    实锤——thumb=白色正圆、轨道同径、轨道端部全半圆收口=thumb 半径；v3.25.6 半圆直径 16→24px）
 *   （v3.25.4 用户 2026-10-29 令「两端的定位点最左往右/最右往左」：刻度带内收——pad=R8+INSET5=13，
 *    全表在 [13, 宽-13] 等分（公式字面回 13/26 形态）；端点挡白圆覆盖 [0,16] 仍罩住端点刻度；
 *    +浮层纵向拉长（margin 3/8→4/10、文案行 17→20px/+2px）
 *   （v3.25.5 用户 2026-10-29 复验「拉长了，但没拉宽」实锤：min-width 从未起决定作用——浮层
 *    实际宽被顶行长串 max-content≈380+ 撑出 → 改定宽 width:460px 硬拉，滑条/文案随 100% 全变宽）
 * key fix（2026-10-24 装机自查）：left 用 CSS calc 表达式而非「读 clientWidth 算百分数」——
 *   浮层首次打开在 hidden（display:none）态渲染，clientWidth=0 会让百分数几何疯狅乱飞；
 *   calc 由浏览器显示后按真实宽度解析，与时序/隐藏态解耦，B 组假 DOM 也天然无法再掩盖该类 bug。
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
const stylesSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");
const indexSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");

// vm 沙箱 Array/Map 原型与宿主不同，跨 realm 断言一律 JSON 比较（铁律总集 vm 跨 realm 必败教训）
const vmEq = (actual, expected, label) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), label);

/* ── vm 假 DOM 装置（承 v3.24.4/v3.25.0 架子） ── */

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
// gates stub 必须齐全：renderer 顶层 bootstrap 的 loadConversation 读 gates.localEngines 等（v3.24-4 装置同款）
const gatesStub = { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true };
const methodMocks = {
  listConversations: async () => [],
  listModes: async () => [],
  getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub }),
  // B 组里按用例改写：默认 null（不支持档位）/ glm5 七档 / anthropic 等
  getThinkingProfile: async () => ({ profile: null })
};
const defaultResult = () => ({
  edition: "main", productName: "Agent Chat Pro", conversations: [], items: [], messages: [], tools: [],
  files: [], entries: [], results: [], valid: true, invalidKeys: [], ok: true, path: "",
  lastConnectionMode: "", version: "3.25.1",
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
  Event: function FakeEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  CustomEvent: function FakeCustomEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  FormData: function FormData() {},
  alert() {}, confirm: () => false, prompt: () => null,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  addEventListener() {}, removeEventListener() {}
};
sandbox.globalThis = sandbox;

// ── thinking-levels.cjs 家族挡位表（v3.24.0 v3.24.2 实测锚）——glm5 七档为动态适配最大值实锤 ──
const GLM5_LEVELS = [
  { id: "off", label: "关", hint: "thinking.type=disabled" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "超高" },
  { id: "ultra", label: "Ultra" },
  { id: "max", label: "Max", hint: "智谱默认挡" }
];

/* ── A 组：thinkMarkLefts 几何纯函数（calc 形态） ── */

const expLeft = (n, i) => `calc(17px + (100% - 34px)*${i}/${n - 1})`;

async function runGeomTests() {
  console.log("── A 组：thinkMarkLefts 几何纯函数（calc 形态） ──");

  await test("A1 常量与函数在册（渲染层符号）+ 旧 clientWidth 百分比几何清除", () => {
    assert.ok(rendererSrc.includes("const THINK_THUMB_RADIUS = 12;"), "thumb 半径常量（v3.25.6 白圆 24px=半圆直径 24 的半径，与 CSS 同步）");
    assert.ok(rendererSrc.includes("const THINK_TRACK_INSET = 5;"), "刻度带内收常量（v3.25.4 用户令「定位点往里点」）");
    assert.ok(rendererSrc.includes("const thinkMarkLefts = (count) => {"), "calc 几何纯函数在册（签名无 width 参数）");
    assert.ok(!rendererSrc.includes("thinkMarkPcts"), "旧百分比几何函数清除（clientWidth 依赖源）");
  });

  await test("A2 单挡/异常 count 兜底居中；calc 串两端括号+空格符合 CSS calc 语法", () => {
    vmEq(sandbox.__acpSmoke.thinkMarkLefts(0), ["50%"], "count=0 → 单挡居中");
    vmEq(sandbox.__acpSmoke.thinkMarkLefts(-3), ["50%"], "负数 → 单挡居中");
    vmEq(sandbox.__acpSmoke.thinkMarkLefts(1), ["50%"], "单挡 → 全局居中");
    vmEq(sandbox.__acpSmoke.thinkMarkLefts(2.9).length, 2, "小数向下取整 2 项");
    const two = sandbox.__acpSmoke.thinkMarkLefts(2);
    assert.ok(two[0].startsWith("calc(") && two[0].endsWith(")"), "calc 包裹完整");
    assert.ok(two[0].includes("17px + (100% - 34px)"), "+ 号两侧空格（CSS calc 语法硬性要求；pad=R12+INSET5=17）");
  });

  await test("A3 双挡两端对称（首挡=左端+R，末挡=右端-R），thumb 不出轨", () => {
    const two = sandbox.__acpSmoke.thinkMarkLefts(2);
    assert.strictEqual(two[0], expLeft(2, 0), "首挡 calc(17px + …*0/1) = 左端 17px（R12+INSET5 内收）");
    assert.strictEqual(two[1], expLeft(2, 1), "末挡 calc(17px + …*1/1) = 右端 -17px（对称内收）");
  });

  await test("A4 七挡（glm5 实档数上限）逐项等差：第 i 挡系数恰为 i/6", () => {
    const seven = sandbox.__acpSmoke.thinkMarkLefts(7);
    assert.strictEqual(seven.length, 7, "七项");
    for (let i = 0; i < 7; i++) assert.strictEqual(seven[i], expLeft(7, i), `第 ${i} 挡 calc 公式`);
  });

  await test("A5 八挡（eco 前置 glm5=8 刻度实况）+五挡（SSH）公式形态一致", () => {
    const eight = sandbox.__acpSmoke.thinkMarkLefts(8);
    assert.strictEqual(eight.length, 8, "八项");
    assert.strictEqual(eight[7], expLeft(8, 7), "末项 = calc(17px + (100% - 34px)*7/7)");
    const five = sandbox.__acpSmoke.thinkMarkLefts(5);
    assert.strictEqual(five[3], expLeft(5, 3), "SSH medium 挡 calc 公式");
  });
}

/* ── B 组：vm 假 DOM 全链刷新冒烟（renderer 接线改动必过——I 段铁律） ── */

async function runVmSmokeTests() {
  console.log("── B 组：vm 假 DOM 全链刷新冒烟 ──");

  const source = rendererSrc + "\n;globalThis.__acpSmoke = { thinkMarkLefts, THINK_THUMB_RADIUS, THINK_TRACK_INSET, WORK_MODE_EN, THINK_LEVEL_EN, composeThinkTop };";
  await test("B0 renderer.js vm 假 DOM 全量求值零异常（v3.25.1 新代码含在内）", () => {
    let error = null;
    try { vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: "renderer.js" }); }
    catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke");
    assert.ok(sandbox.__acpSmoke.THINK_THUMB_RADIUS === 12, "半径常量导出对位（v3.25.6 白圆 24px 的半径）");
    assert.ok(sandbox.__acpSmoke.THINK_TRACK_INSET === 5, "刻度带内收常量导出对位");
  });
  // B0 之后 sandbox 已 contextified 且 __acpSmoke 已挂 → A 组可直接宿主侧调用（跨 realm 数组一律 vmEq）
  await runGeomTests();

  await test("B1 云端 glm5 七档：eco 前置 8 挡 → 刻度 8 点/文案 8 条同几何，off 挡（index1）active", async () => {
    methodMocks.getThinkingProfile = async () => ({ profile: { family: "zhipu", levels: GLM5_LEVELS } });
    const script = `currentConnectionMode = "cloud"; currentModeId = "regular"; currentLocalEngine = "claude";`;
    vm.runInContext(script, sandbox);
    // 注：不再伪造 clientWidth——几何为 calc 表达式，hidden 态渲染也应正确（本测试即修复实证）
    await vm.runInContext(`refreshComposerModePopup()`, sandbox);
    await new Promise((r) => setTimeout(r, 0));
    const ticks = rt.getFake("#think-ticks");
    const labels = rt.getFake("#think-levels");
    const slider = rt.getFake("#think-slider");
    assert.strictEqual(slider.max, "7", "八挡 → max=7");
    assert.strictEqual(ticks.children.length, 8, "刻度点数量 = 挡位数（动态）");
    assert.strictEqual(labels.children.length, 8, "文案条数 = 挡位数");
    const lefts = sandbox.__acpSmoke.thinkMarkLefts(8);
    for (let i = 0; i < 8; i++) {
      assert.strictEqual(ticks.children[i].style.left, lefts[i], `第 ${i} 刻度 left 与纯函数 calc 一致`);
      assert.strictEqual(labels.children[i].style.left, ticks.children[i].style.left, `第 ${i} 文案 left 与刻度同几何（对齐实锤）`);
    }
    assert.ok(ticks.children[0].classList.contains("eco"), "eco 刻度点带绿系类");
    assert.ok(ticks.children[1].classList.contains("active"), "off 挡（defaultIdx=1）active");
    assert.ok(!ticks.children[1].classList.contains("eco"), "off 刻度点不带 eco 类");
    assert.ok(labels.children[1].classList.contains("active"), "文案 active 与刻度同位");
    // 挡位文案全表中心锚（v3.25.2 装机位移修复，用户拍板 A）——v3.25.1 贴端形态实锤位移作废：
    // 文字中心=刻度中心=胶囊中心三点重合，任何挡位都是同一个锚
    assert.strictEqual(labels.children[0].style.transform, "translateX(-50%)", "首挡 ECO 文案中心锚（与刻度/胶囊三点重合）");
    assert.strictEqual(labels.children[7].style.transform, "translateX(-50%)", "末挡文案中心锚");
    assert.strictEqual(labels.children[1].style.transform, "translateX(-50%)", "中间挡文案中心锚");
  });

  await test("B2 拖动 oninput：active 轻量同步到新挡（DOM 不重建，children 引用不换）", async () => {
    const slider = rt.getFake("#think-slider");
    const ticks = rt.getFake("#think-ticks");
    const labels = rt.getFake("#think-levels");
    assert.ok(typeof slider.oninput === "function", "buildSlider 已挂 oninput");
    const before0 = ticks.children[0];
    slider.value = "3";
    slider.oninput();
    assert.ok(ticks.children[3].classList.contains("active"), "第 3 挡刻度点 active");
    assert.ok(!ticks.children[1].classList.contains("active"), "原 off 点退出 active");
    assert.ok(labels.children[3].classList.contains("active"), "文案 active 同步");
    assert.strictEqual(ticks.children[0], before0, "DOM 未重建（防闪烁实锤）");
  });

  await test("B3 SSH 分支五档（THINK_SSH_LEVELS）：默认 medium → index3 active，刻度 5 点", async () => {
    methodMocks.getThinkingProfile = async () => ({ profile: null }); // SSH 不走 profile
    windowStub._cachedModes = [{ id: "regular", name: "常规", icon: "💬", description: "", isBuiltIn: true, thinkingLevel: "medium" }];
    const slider = rt.getFake("#think-slider");
    slider.disabled = false;
    const script = `currentConnectionMode = "ssh"; currentModeId = "regular";`;
    vm.runInContext(script, sandbox);
    await vm.runInContext(`refreshComposerModePopup()`, sandbox);
    await new Promise((r) => setTimeout(r, 0));
    const ticks = rt.getFake("#think-ticks");
    const labels = rt.getFake("#think-levels");
    assert.strictEqual(ticks.children.length, 5, "SSH 五挡五点");
    assert.strictEqual(labels.children.length, 5, "五条文案");
    assert.ok(ticks.children[3].classList.contains("active"), "medium（index3）active");
    assert.ok(String(labels.children[0].style.color).includes("22, 101, 52"), "ECO 文案深绿（chips 渐进色语义保留）");
    assert.strictEqual(labels.children[0].textContent, "ECO", "ECO 文案名");
    assert.strictEqual(labels.children[1].textContent, "默认", "默认挡文案名");
  });

  await test("B4 不支持挡位：刻度层清空 + levelsRow 报不支持文案（不残留旧点）", async () => {
    methodMocks.getThinkingProfile = async () => ({ profile: null });
    windowStub._cachedModes = [];
    const script = `currentConnectionMode = "cloud"; currentModeId = "regular";`;
    vm.runInContext(script, sandbox);
    await vm.runInContext(`refreshComposerModePopup()`, sandbox);
    await new Promise((r) => setTimeout(r, 0));
    const ticks = rt.getFake("#think-ticks");
    const labels = rt.getFake("#think-levels");
    assert.strictEqual(ticks.children.length, 0, "刻度点清空");
    assert.ok(String(labels.innerHTML).includes("think-unsupported"), "levelsRow 换不支持提示");
  });

  await test("B5 三挡 profile 自适应（DeepSeek 令点名 关/中/Max）：渲染层 ECO 恒前置 → 4 点 4 文案同几何不多不少", async () => {
    const THREE = [
      { id: "off", label: "关" },
      { id: "medium", label: "中" },
      { id: "max", label: "Max" }
    ];
    methodMocks.getThinkingProfile = async () => ({ profile: { family: "gemini3", levels: THREE } });
    windowStub._cachedModes = [{ id: "regular", name: "常规", icon: "💬", description: "", isBuiltIn: true, thinkingLevel: "" }];
    const script = `currentConnectionMode = "cloud"; currentModeId = "regular";`;
    vm.runInContext(script, sandbox);
    await vm.runInContext(`refreshComposerModePopup()`, sandbox);
    await new Promise((r) => setTimeout(r, 0));
    const ticks = rt.getFake("#think-ticks");
    const labels = rt.getFake("#think-levels");
    const slider = rt.getFake("#think-slider");
    assert.strictEqual(slider.max, "3", "三挡 profile + ECO 前置 → max=3（渲染层恒加 ECO 挡，renderer.js 3345 行语义）");
    assert.strictEqual(ticks.children.length, 4, "刻度点=渲染挡位数，不多不少（「多出小圆点」缺陷被数量断言锁死）");
    assert.strictEqual(labels.children.length, 4, "文案 4 条同数");
    const lefts = sandbox.__acpSmoke.thinkMarkLefts(4);
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(ticks.children[i].style.left, lefts[i], `第 ${i} 刻度 calc 一致`);
      assert.strictEqual(labels.children[i].style.left, ticks.children[i].style.left, `第 ${i} 文案与刻度同几何（滑块在哪文字在哪）`);
    }
    assert.strictEqual(labels.children[0].style.color, "rgb(22, 101, 52)", "ECO 文案深绿（渐进色语义）");
    assert.strictEqual(String(labels.children[1].textContent), "关", "第 2 挡文案=profile 首挡 label（动态透传）");
    assert.strictEqual(String(labels.children[3].textContent), "Max", "末挡文案=profile 末挡 label");
    // 三挡场景同锚（v3.25.2 全表中心锚）：首挡 ECO/末挡 Max/中间关 文字中心都与刻度中心重合
    assert.strictEqual(labels.children[0].style.transform, "translateX(-50%)", "三挡首端 ECO 中心锚");
    assert.strictEqual(labels.children[3].style.transform, "translateX(-50%)", "三挡末端 Max 中心锚");
    assert.strictEqual(labels.children[2].style.transform, "translateX(-50%)", "三挡中端中心锚");
    // 大宽裕度下（4 挡中心距 ≈ 91px）文案必然无重叠
    const gap4 = (288 - 34) / 3;
    assert.ok(gap4 > 60, `三挡中心距 ${gap4.toFixed(1)}px 远大于文案半宽和，无挤压重叠`);
  });

  await test("B6 文案挤压不重叠（288px 浮层宽 × 8 挡最挤场景）：相邻文案估算半宽和 < 中心距", () => {
    // 近似字宽（11.5px 字号）：全角≈12.5 / 大写英文≈8.6 / 小写数字≈6.8
    const approxW = (s) => Array.from(s).reduce((sum, ch) => sum + (/[　-鿿！-～]/.test(ch) ? 12.5 : /[A-Z]/.test(ch) ? 8.6 : /[a-z0-9]/.test(ch) ? 6.8 : 6), 0);
    const W = 288;
    const labels8 = ["ECO", ...GLM5_LEVELS.map((l) => l.label)]; // 云端渲染层 ECO 前置实况（B1 同构）
    assert.strictEqual(labels8.length, 8, "八挡最挤场景");
    const gap = (W - 34) / 7; // 相邻中心距 ≈ 36.29px（v3.25.6 pad=R12+INSET5=17，可点区 [17,宽-17]）
    assert.ok(gap >= 36, `八挡中心距 ${gap.toFixed(2)}px 在册`);
    for (let i = 0; i < labels8.length - 1; i++) {
      const need = approxW(labels8[i]) / 2 + approxW(labels8[i + 1]) / 2;
      assert.ok(need < gap, `"${labels8[i]}"→"${labels8[i + 1]}" 半宽和 ${need.toFixed(1)}px < 中心距 ${gap.toFixed(1)}px（不重叠）`);
    }
  });

  await test("B7 顶行体系（用户令三段调整③）：模型名随工作模式+思考挡加英文标——全场景映射表", () => {
    const top = sandbox.__acpSmoke.composeThinkTop;
    const CASES = [
      // 完全权限（automatic→auto）：思考挡 eco/默认/轻度/中等/最高/ultra(云端)/Max(云端)
      ["ssh", "GLM 5.3 flash", "automatic", "eco", "ssh•GLM 5.3 flash auto eco"],
      ["ssh", "GLM 5.3 flash", "automatic", "off", "ssh•GLM 5.3 flash auto"], // 默认不加思考英文
      ["ssh", "GLM 5.3 flash", "automatic", "low", "ssh•GLM 5.3 flash auto low"],
      ["ssh", "GLM 5.3 flash", "automatic", "medium", "ssh•GLM 5.3 flash auto middle"],
      ["ssh", "GLM 5.3 flash", "automatic", "high", "ssh•GLM 5.3 flash auto high"],
      ["cloud", "GLM 5.3 flash", "automatic", "ultra", "cloud•GLM 5.3 flash auto ultra"], // 云端特有挡
      ["cloud", "GLM 5.3 flash", "automatic", "max", "cloud•GLM 5.3 flash auto Max"], // 云端特有挡
      // 高危审批（regular→High-Risk Approval）
      ["ssh", "GLM 5.3 flash", "regular", "eco", "ssh•GLM 5.3 flash High-Risk Approval eco"],
      ["ssh", "GLM 5.3 flash", "regular", "off", "ssh•GLM 5.3 flash High-Risk Approval"],
      ["ssh", "GLM 5.3 flash", "regular", "medium", "ssh•GLM 5.3 flash High-Risk Approval middle"],
      // 按需审批（eco→On-Demand Approval）
      ["ssh", "GLM 5.3 flash", "eco", "eco", "ssh•GLM 5.3 flash On-Demand Approval eco"],
      // 本机连接 + 自定义模式（无英标省略）+ 空模型域
      ["local", "GLM 5.6", "regular", "high", "local•GLM 5.6 High-Risk Approval high"],
      ["ssh", "", "regular", "medium", "ssh•High-Risk Approval middle"], // 模型待取：模型域自动省略
      ["cloud", "", "custom-mode", "off", "cloud•未设置模型"] // 自定义模式无英标+未设置模型占位
    ];
    for (const [conn, model, modeId, levelId, expect] of CASES) {
      assert.strictEqual(top(conn, model, modeId, levelId), expect, `composeThinkTop(${conn},${model || '∅'},${modeId},${levelId})`);
    }
    assert.strictEqual(sandbox.__acpSmoke.WORK_MODE_EN.automatic, "auto", "完全权限→auto");
    assert.strictEqual(sandbox.__acpSmoke.WORK_MODE_EN.regular, "High-Risk Approval", "高危审批→High-Risk Approval");
    assert.strictEqual(sandbox.__acpSmoke.WORK_MODE_EN.eco, "On-Demand Approval", "按需审批→On-Demand Approval");
    assert.strictEqual(sandbox.__acpSmoke.THINK_LEVEL_EN.off, "", "默认挡不加英文");
    assert.strictEqual(sandbox.__acpSmoke.THINK_LEVEL_EN.xhigh, "xhigh", "GLM5「超高」用户表未列→补字面 xhigh（汇报说明项）");
    assert.strictEqual(sandbox.__acpSmoke.THINK_LEVEL_EN.on, "", "kimi/qwen「开」=默认态不加英文");
  });
}

/* ── C 组：源码切片 + 边界（thinking-levels.cjs 零触碰） ── */

async function runSourceTests() {
  console.log("── C 组：源码切片与边界 ──");

  await test("C1 thumb 正圆（v3.25.3 用户令 2026-10-27+批注图实锤：白色圆圈当滑动条，胶囊 26×14 撤销）+拖动手感与蓝绿描边保留", () => {
    assert.ok(stylesSrc.includes("width: 24px; height: 24px; border-radius: 50%;"), "thumb 白圆 24px（v3.25.6 半圆直径 16→24 同步，批注图白色圆圈同形）");
    assert.ok(!stylesSrc.includes("border-radius: 9999px;"), "胶囊 9999px 组合清除（v3.24.3 六发形态终结）");
    assert.ok(stylesSrc.includes("半圆直径 16→24px"), "v3.25.6 半圆直径拉宽注释在册（CSS）");
    assert.ok(rendererSrc.includes("半圆直径 16→24px"), "v3.25.6 半圆直径拉宽注释在册（renderer）");
    assert.ok(stylesSrc.includes("margin-top: 0;   /* thumb 24px = slider 高 24px，天然居中 */"), "圆 thumb 与轨道同径天然居中（无 -1px 偏移）");
    assert.ok(stylesSrc.includes("border-radius: 12px;   /* v3.25.6 用户令「拉宽=半圆边的直径变大」：轨道高 16→24px、半圆直径 24、半径 12=thumb 半径（铁令半径相同） */"), "轨道端部全半圆 12px=thumb 半径（用户令「滑动框半径要和新滑动条相同」持续有效）");
    assert.ok(stylesSrc.includes(".think-slider::-webkit-slider-thumb:active { transform: scale(1.18); }"), "拖动放大保留");
    assert.ok(stylesSrc.includes(".think-slider.blue::-webkit-slider-thumb:active { box-shadow: 0 0 0 3px rgba(56, 120, 240, .22), 0 0 14px rgba(56, 120, 240, .42); }"), "蓝系双层光环（近环+远溢；v3.25.1 配色追改=提取纯蓝 #3878f0 即 rgb(56,120,240)）");
    assert.ok(stylesSrc.includes(".think-slider.eco::-webkit-slider-thumb:active { box-shadow: 0 0 0 3px rgba(22, 163, 74, .22), 0 0 14px rgba(22, 163, 74, .42); }"), "绿系双层光环同步");
    assert.ok(!stylesSrc.includes("rgba(56, 189, 248"), "旧 sky 蓝族光环清除（全量换纯蓝）");
    assert.ok(stylesSrc.includes(".think-slider.blue::-webkit-slider-thumb:hover { box-shadow: 0 0 8px rgba(56, 120, 240, .25); }"), "蓝系 hover 弱光预览（修复令吸收②）");
    assert.ok(stylesSrc.includes(".think-slider.eco::-webkit-slider-thumb:hover { box-shadow: 0 0 8px rgba(22, 163, 74, .25); }"), "绿系 hover 弱光预览（修复令吸收②）");
    assert.ok(
      stylesSrc.indexOf("::-webkit-slider-thumb:hover") < stylesSrc.indexOf("::-webkit-slider-thumb:active { box-shadow"),
      "hover 规则在 :active 之前声明（按住时双层光环覆盖 hover 弱光）"
    );
    assert.ok(stylesSrc.includes("linear-gradient(90deg, #f8fafc 0%, #9db4f7 34%, #3878f0 67%, #1e3a8a 100%)"), "填充层纯蓝渐变（提取色 #3878f0 主调）");
    assert.ok(!stylesSrc.includes("#7dd3fc") && !stylesSrc.includes("#0c4a6e"), "旧 sky 蓝族渐变端点清除");
  });

  await test("C2 轨道刻度层结构与文案绝对定位对齐（垂直对齐实锤：ticks 层与 slider 盒同高）", () => {
    assert.ok(indexSrc.includes('<div class="think-track-wrap">') && indexSrc.includes('<div class="think-ticks" id="think-ticks"'), "index.html 轨道包裹层+刻度层骨架");
    assert.ok(stylesSrc.includes(".think-slider {\n  -webkit-appearance: none; appearance: none;\n  width: 100%; height: 24px; border-radius: 12px; margin: 4px 0 10px;"), "slider 高 24px（v3.25.6 半圆直径 24）+端部圆角 12px 全半圆+margin 4/10（v3.25.4 拉长保留）");
    assert.ok(stylesSrc.includes(".think-ticks { position: absolute; top: 4px; bottom: 10px; left: 0; right: 0; pointer-events: none; z-index: 1; }"), "刻度层 top/bottom 与 slider margin 4/10 联动+层序 z1（inset:0 形态清除）");
    assert.ok(!stylesSrc.includes(".think-ticks { position: absolute; inset: 0;"), "inset:0 形态清除（垂直偏移源）");
    assert.ok(stylesSrc.includes(".think-tick.eco"), "eco 刻度点绿系");
    assert.ok(stylesSrc.includes("transform: translateX(-50%)"), "文案中心锚定（对齐刻度）");
    assert.ok(stylesSrc.includes(".think-levels { position: relative; height: 20px; margin-top: 2px; }"), "文案行定高容器（v3.25.4 拉长 20px/+2px）");
    assert.ok(stylesSrc.includes("width: 460px;"), "浮层定宽 460px（v3.25.5 用户复验「没拉宽」→ min-width 无效改定宽硬拉）");
    // v3.35.8：扫描收窄到思考面板区段（.think-panel … .think-group-slider）——原全域字符串扫描误伤
    // 其他组件的 min-width（如空态容器 .empty-state { min-width: 300px }，与浮层撑宽路线无关）
    const thinkStyles = stylesSrc.slice(
      Math.max(0, stylesSrc.indexOf(".think-panel")),
      stylesSrc.indexOf(".think-group-slider") >= 0 ? stylesSrc.indexOf(".think-group-slider") + 120 : stylesSrc.length
    );
    assert.ok(!thinkStyles.includes("min-width: 350px;") && !thinkStyles.includes("min-width: 300px;"), "min-width 撑宽路线废弃（被顶行 max-content 穿透；v3.35.8 起只扫思考面板区段）");
    // v3.25.2 层序修复锚（装机实锤：白胶囊中央透出刻度点）——轨道渐变拎 ::before + z 三层序
    assert.ok(stylesSrc.includes(".think-track-wrap::before"), "::before 独立轨道渐变层在册");
    assert.ok(rendererSrc.includes("renderTrackMarks(") && rendererSrc.includes("syncMarkActive(ticksRow, levelsRow"), "渲染接线在册");
    assert.ok(!rendererSrc.includes("const renderChips"), "旧 flex 文案渲染函数声明清除");
    const rtmBody = rendererSrc.slice(rendererSrc.indexOf("const renderTrackMarks"), rendererSrc.indexOf("const syncMarkActive"));
    assert.ok(rtmBody.includes("thinkMarkLefts") && !rtmBody.includes("clientWidth"), "renderTrackMarks 零 clientWidth 依赖（hidden 态渲染免疫，装机自查 key fix）");
  });

  await test("C2b 层序三分：轨道渐变(z0::before) < 刻度点(z1) < 原生 thumb(z2) + 变量落 wrap", () => {
    const before = stylesSrc.slice(stylesSrc.indexOf(".think-track-wrap::before"), stylesSrc.indexOf(".think-slider {"));
    assert.ok(before.includes("z-index: 0;") && before.includes("background-image:"), "轨道渐变层（z0）承载三重背景");
    assert.ok(before.includes("var(--fill, 0%) 100%, var(--eco, 0%) 100%"), "--fill/--eco 变量消费在 ::before（继承 wrap）");
    assert.ok(stylesSrc.includes(".think-ticks { position: absolute; top: 4px; bottom: 10px; left: 0; right: 0; pointer-events: none; z-index: 1; }"), "刻度层 z1（夹轨道与 thumb 之间；v3.25.4 margin 4/10 联动）");
    const sliderRule = stylesSrc.slice(stylesSrc.indexOf(".think-slider {"), stylesSrc.indexOf(".think-slider:disabled"));
    assert.ok(sliderRule.includes("background: none;") && sliderRule.includes("z-index: 2;"), "slider 背景清空+thumb 层提到刻度上（z2）");
    assert.ok(!stylesSrc.includes(".think-slider.eco { --eco: 100%; }"), "旧 --eco class 规则清除（变量走 renderSliderTheme 显式落 wrap）");
    const rst = rendererSrc.slice(rendererSrc.indexOf("const renderSliderTheme"), rendererSrc.indexOf("const THINK_CHIP_RAMP"));
    assert.ok(rst.includes("slider.parentElement || slider") && rst.includes('wrap.style.setProperty'), "renderSliderTheme 变量落 wrap（伪元素继承）");
    assert.ok(!rendererSrc.includes('translateX(0)"') && !rendererSrc.includes('translateX(-100%)"'), "贴端三态条件全清除（v3.25.1 位移根因）");
    assert.ok(rendererSrc.includes('label.style.transform = "translateX(-50%)"'), "全表恒中心锚（一点一写）");
  });

  await test("C3 边界：thinking-levels.cjs 零触碰（主进程不引用渲染层符号）+ 家族挡位数动态谱（2~7 档）", () => {
    const tlSrc = fs.readFileSync(path.join(ROOT, "src", "main", "thinking-levels.cjs"), "utf8");
    assert.ok(!tlSrc.includes("think-tick") && !tlSrc.includes("thinkMarkLefts") && !tlSrc.includes("renderTrackMarks"), "主进程挡位表零渲染层符号（铁边界）");
    const tl = require(path.join(ROOT, "src", "main", "thinking-levels.cjs"));
    const counts = {};
    // 真实签名 resolveThinkingProfile(provider, model)（位置参数）——provider "unknown" 不命中精判，走模型前缀链
    for (const model of ["glm-5.0", "deepseek-v4-pro", "kimi-k3", "gemini-3.8-flash", "gemini-2.5-flash", "claude-sonnet-5-5", "grok-4-fast", "xai/llama-3.3-70b"]) {
      const profile = tl.resolveThinkingProfile("unknown", model);
      counts[model] = profile && profile.levels ? profile.levels.length : 0;
    }
    assert.strictEqual(counts["glm-5.0"], 7, "glm5 七档（动态适配最大实锤）");
    assert.strictEqual(counts["deepseek-v4-pro"], 4, "deepseek 四档");
    assert.strictEqual(counts["kimi-k3"], 2, "kimi 两档");
    assert.strictEqual(counts["claude-sonnet-5-5"], 4, "anthropic 预算四档");
    for (const k of Object.keys(counts)) {
      const n = counts[k];
      assert.ok(k === "xai/llama-3.3-70b" ? n === 0 : (n >= 2 && n <= 7), `${k} 档数在 2~7 域内（xai provider 未知时 grok 前缀=2 挡，xai/ 非法前缀=不支持=0）`);
    }
    assert.strictEqual(tl.SSH_LEVELS.length, 5, "SSH 表五档未变（主进程零触碰旁证）");
  });
}

/* ── D 组：版本锚 ── */

async function runVersionTests() {
  console.log("── D 组：版本锚 ──");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  await test("C4 工作模式体系重写（用户令，2026-10-24）：id 保留·名称重定位审批语义 + 顶行唯一写入口径", () => {
    const md = require(path.join(ROOT, "src", "main", "modes", "mode-defaults.cjs"));
    const BUILTIN_MODES = md.BUILTIN_MODES;
    assert.ok(BUILTIN_MODES.automatic && BUILTIN_MODES.regular && BUILTIN_MODES.eco, "三内置 id 全保留（存量偏好/会话快照零破坏）");
    assert.strictEqual(BUILTIN_MODES.automatic.name, "完全权限", "自动化→完全权限");
    assert.strictEqual(BUILTIN_MODES.regular.name, "高危审批", "常规→高危审批");
    assert.strictEqual(BUILTIN_MODES.eco.name, "按需审批", "eco→按需审批（ECO 节能定位移交思考挡位）");
    assert.strictEqual(BUILTIN_MODES.eco.skipPermissions, false, "按需审批语义校正：不再跳权限（原 eco 槽 bypass 与新名自相矛盾）");
    assert.strictEqual(BUILTIN_MODES.eco.permissionMode, "default", "按需审批 permissionMode=default（SSH/本机 CLI 链硬编码 bypass 不受影响，云端审批语义生效）");
    assert.strictEqual(BUILTIN_MODES.automatic.permissionMode, "bypassPermissions", "完全权限保持 bypass（语义自洽）");
    assert.ok(
      !Object.values(BUILTIN_MODES).some((m) => m.name.includes("自动化") || m.name.includes("常规") || m.name.includes("ECO 节能")),
      "三内置 name 域旧名全清除（desc 保留「原 XX」溯引帮助老用户认知）"
    );
    assert.strictEqual(BUILTIN_MODES.automatic.name.indexOf("自动化"), -1, "「自动化模式」退场");
    assert.ok(indexSrc.includes('id="mode-name">高危审批') && indexSrc.includes("🛡 高危审批"), "index.html 静态模式文案同步");
    assert.ok(!indexSrc.includes("常规模式"), "旧静态文案清除");
    assert.ok(rendererSrc.includes("modelEl.textContent = composeThinkTop("), "云端顶行唯一写入=composeThinkTop 全串");
    assert.ok(rendererSrc.includes("modelEl.textContent = stampTop("), "SSH/本机顶行走 stampTop（含后台渐显重拼）");
    assert.ok(rendererSrc.includes('const WORK_MODE_EN = { automatic: "auto", regular: "High-Risk Approval", eco: "On-Demand Approval" };'), "工作模式英标映射表在册");
    assert.ok(rendererSrc.includes("meta.innerHTML = \"\";"), "「当前挡位」行已删（用户令简洁化）");
  });

  await test("D1 package.json 版本与 README badge 同步（≥3.35.x 多 AI 重编制线；v3.35.7 起语义化免随 bump 手改）", () => {
    assert.ok(/^3\.\d+\.\d+$/.test(String(pkg.version)), "版本号 3.x 合法格式");
    assert.ok(Number(String(pkg.version).split(".")[1]) >= 35, "版本 ≥3.35.x（重编制线以上）");
    const badge = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    assert.ok(badge.includes(`version-${pkg.version}-blue`), "README badge 与 package.json 版本一致");
  });
  await test("D2 README badge 同步", () => {
    assert.ok(rendererSrc.includes("v3.25.6（用户令"), "renderer.js v3.25.6 注释在册");
    assert.ok(stylesSrc.includes("v3.25.6 用户令「拉宽=半圆边的直径变大」"), "styles.css v3.25.6 注释在册");
  });
}

(async () => {
  console.log("test-v3-25-1 — 思考挡位滑动条重构（thumb 圆点+轨道刻度+同几何对齐）");
  await runVmSmokeTests(); // B0 求值在最前 → A 组在 B0 后宿主侧直调（跨 realm 铁律）
  await runSourceTests();
  await runVersionTests();
  console.log(`\n通过 ${passCount} 项，失败 ${failCount} 项`);
  if (failCount > 0) process.exit(1);
})();