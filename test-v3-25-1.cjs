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
 * 几何核心（renderer.js thinkMarkPcts）：input range 的 thumb 中心可动区
 *   是 [半径R, 轨道宽-R]（首尾挡 thumb 不出轨）→ 第 i 挡中心
 *   pct_i = padPct + spanPct·i，padPct=R/W*100，spanPct=(100-2pad)/(N-1)。
 *   刻度点、文案、thumb 三层同用此函数 → 绝对居中重合。
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

/* ── A 组：thinkMarkPcts 几何纯函数 ── */

async function runGeomTests() {
  console.log("── A 组：thinkMarkPcts 几何纯函数 ──");

  await test("A1 常量与函数在源码在册（渲染层符号，thinking-levels.cjs 零触碰见 C 组）", () => {
    assert.ok(rendererSrc.includes("const THINK_THUMB_RADIUS = 7;"), "thumb 半径常量（与 CSS 14px 直径同步）");
    assert.ok(rendererSrc.includes("const thinkMarkPcts = (count, widthPx) => {"), "几何纯函数在册");
  });

  await test("A2 单挡居中 / 双挡两端对称（pad 区对称，末挡 = 100-首挡）", () => {
    const p1 = sandbox.__acpSmoke.thinkMarkPcts(1, 288);
    vmEq(p1, [50], "单挡 = 居中");
    const p2 = sandbox.__acpSmoke.thinkMarkPcts(2, 288);
    assert.strictEqual(p2.length, 2, "双挡两项");
    const pad = (7 / 288) * 100;
    assert.ok(Math.abs(p2[0] - pad) < 1e-9, `首挡 = padPct(${pad.toFixed(4)}%)`);
    assert.ok(Math.abs(p2[1] - (100 - pad)) < 1e-9, "末挡 = 100-pad（对称，首尾 thumb 不出轨）");
  });

  await test("A3 五挡等距（SSH 实档数）：相邻间距恒定且首尾对称", () => {
    const p = sandbox.__acpSmoke.thinkMarkPcts(5, 288);
    assert.strictEqual(p.length, 5, "五项");
    const span = (100 - (7 / 288) * 100 * 2) / 4;
    for (let i = 0; i < 5; i++) {
      const expect = (7 / 288) * 100 + span * i;
      assert.ok(Math.abs(p[i] - expect) < 1e-9, `第 ${i} 挡 = ${expect.toFixed(4)}%（实 ${p[i].toFixed(4)}%）`);
    }
    assert.ok(Math.abs(p[0] + p[4] - 100) < 1e-9, "首尾对称");
  });

  await test("A4 七挡（glm5 实档数上限）：间距恒定收窄、全部落在 (0,100) 开区间内", () => {
    const p = sandbox.__acpSmoke.thinkMarkPcts(7, 288);
    assert.strictEqual(p.length, 7, "七项");
    let spanDelta = p[1] - p[0];
    for (let i = 2; i < 7; i++) assert.ok(Math.abs((p[i] - p[i - 1]) - spanDelta) < 1e-9, "等距");
    assert.ok(p[0] > 0 && p[6] < 100, "首尾不出轨（pad 区缓冲）");
  });

  await test("A5 防御：count 0/负数/小数 与 width 0/undefined 均不炸（w 兜 1、n 兜 1）", () => {
    vmEq(sandbox.__acpSmoke.thinkMarkPcts(0, 288), [50], "count=0 → 单挡居中");
    vmEq(sandbox.__acpSmoke.thinkMarkPcts(-3, 288), [50], "负数 → 单挡居中");
    vmEq(sandbox.__acpSmoke.thinkMarkPcts(2.9, 288).length, 2, "小数向下取整 2 项");
    const narrow = sandbox.__acpSmoke.thinkMarkPcts(3, 0);
    assert.strictEqual(narrow.length, 3, "width=0 → w 兜 1 不除零");
    const noW = sandbox.__acpSmoke.thinkMarkPcts(4, undefined);
    assert.strictEqual(noW.length, 4, "width=undefined → 不炸返回四项");
  });
}

/* ── B 组：vm 假 DOM 全链刷新冒烟（renderer 接线改动必过——I 段铁律） ── */

async function runVmSmokeTests() {
  console.log("── B 组：vm 假 DOM 全链刷新冒烟 ──");

  const source = rendererSrc + "\n;globalThis.__acpSmoke = { thinkMarkPcts, THINK_THUMB_RADIUS };";
  await test("B0 renderer.js vm 假 DOM 全量求值零异常（v3.25.1 新代码含在内）", () => {
    let error = null;
    try { vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: "renderer.js" }); }
    catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke");
    assert.ok(sandbox.__acpSmoke.THINK_THUMB_RADIUS === 7, "半径常量导出对位");
  });
  // B0 之后 sandbox 已 contextified 且 __acpSmoke 已挂 → A 组可直接宿主侧调用（跨 realm 数组一律 vmEq）
  await runGeomTests();

  await test("B1 云端 glm5 七档：eco 前置 8 挡 → 刻度 8 点/文案 8 条同几何，off 挡（index1）active", async () => {
    methodMocks.getThinkingProfile = async () => ({ profile: { family: "zhipu", levels: GLM5_LEVELS } });
    const script = `currentConnectionMode = "cloud"; currentModeId = "regular"; currentLocalEngine = "claude";`;
    vm.runInContext(script, sandbox);
    rt.getFake("#think-slider").clientWidth = 288;
    await vm.runInContext(`refreshComposerModePopup()`, sandbox);
    await new Promise((r) => setTimeout(r, 0));
    const ticks = rt.getFake("#think-ticks");
    const labels = rt.getFake("#think-levels");
    const slider = rt.getFake("#think-slider");
    assert.strictEqual(slider.max, "7", "八挡 → max=7");
    assert.strictEqual(ticks.children.length, 8, "刻度点数量 = 挡位数（动态）");
    assert.strictEqual(labels.children.length, 8, "文案条数 = 挡位数");
    const pcts = sandbox.__acpSmoke.thinkMarkPcts(8, 288);
    for (let i = 0; i < 8; i++) {
      assert.strictEqual(ticks.children[i].style.left, `${pcts[i]}%`, `第 ${i} 刻度 left 与纯函数一致`);
      assert.strictEqual(labels.children[i].style.left, `${pcts[i]}%`, `第 ${i} 文案 left 与刻度同几何（对齐实锤）`);
    }
    assert.ok(ticks.children[0].classList.contains("eco"), "eco 刻度点带绿系类");
    assert.ok(ticks.children[1].classList.contains("active"), "off 挡（defaultIdx=1）active");
    assert.ok(!ticks.children[1].classList.contains("eco"), "off 刻度点不带 eco 类");
    assert.ok(labels.children[1].classList.contains("active"), "文案 active 与刻度同位");
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
}

/* ── C 组：源码切片 + 边界（thinking-levels.cjs 零触碰） ── */

async function runSourceTests() {
  console.log("── C 组：源码切片与边界 ──");

  await test("C1 thumb 正圆（v3.24.3 胶囊回退，用户拍板）+拖动手感与蓝绿描边保留", () => {
    assert.ok(stylesSrc.includes("width: 14px; height: 14px; border-radius: 50%;"), "thumb 正圆 14px");
    assert.ok(!stylesSrc.includes("border-radius: 9999px"), "胶囊 9999px 已清除");
    assert.ok(stylesSrc.includes(".think-slider::-webkit-slider-thumb:active { transform: scale(1.18); }"), "拖动放大保留");
    assert.ok(stylesSrc.includes(".think-slider.blue::-webkit-slider-thumb { border-color: #38bdf8; }") && stylesSrc.includes(".think-slider.eco::-webkit-slider-thumb { border-color: #16a34a; }"), "蓝绿双系描边保留");
  });

  await test("C2 轨道刻度层结构与文案绝对定位对齐", () => {
    assert.ok(indexSrc.includes('<div class="think-track-wrap">') && indexSrc.includes('<div class="think-ticks" id="think-ticks"'), "index.html 轨道包裹层+刻度层骨架");
    assert.ok(stylesSrc.includes(".think-ticks { position: absolute; inset: 0; pointer-events: none; }"), "刻度层覆盖轨道且不抢指针（拖动不受影响）");
    assert.ok(stylesSrc.includes(".think-tick.eco"), "eco 刻度点绿系");
    assert.ok(stylesSrc.includes("transform: translateX(-50%)"), "文案中心锚定（对齐刻度）");
    assert.ok(stylesSrc.includes(".think-levels { position: relative; height: 17px; margin-top: -2px; }"), "文案行定高容器");
    assert.ok(rendererSrc.includes("renderTrackMarks(") && rendererSrc.includes("syncMarkActive(ticksRow, levelsRow"), "渲染接线在册");
    assert.ok(!rendererSrc.includes("const renderChips"), "旧 flex 文案渲染函数声明清除");
  });

  await test("C3 边界：thinking-levels.cjs 零触碰（主进程不引用渲染层符号）+ 家族挡位数动态谱（2~7 档）", () => {
    const tlSrc = fs.readFileSync(path.join(ROOT, "src", "main", "thinking-levels.cjs"), "utf8");
    assert.ok(!tlSrc.includes("think-tick") && !tlSrc.includes("thinkMarkPcts") && !tlSrc.includes("renderTrackMarks"), "主进程挡位表零渲染层符号（铁边界）");
    const tl = require(path.join(ROOT, "src", "main", "thinking-levels.cjs"));
    const counts = {};
    // 真实签名 resolveThinkingProfile(provider, model)（位置参数）——provider "unknown" 不命中精判，走模型前缀链
    for (const model of ["glm-5.0", "deepseek-v4-pro", "kimi-k3", "gemini-3.8-flash", "gemini-2.5-flash", "claude-sonnet-5-5", "groq/llama-3.3-70b"]) {
      const profile = tl.resolveThinkingProfile("unknown", model);
      counts[model] = profile && profile.levels ? profile.levels.length : 0;
    }
    assert.strictEqual(counts["glm-5.0"], 7, "glm5 七档（动态适配最大实锤）");
    assert.strictEqual(counts["deepseek-v4-pro"], 4, "deepseek 四档");
    assert.strictEqual(counts["kimi-k3"], 2, "kimi 两档");
    assert.strictEqual(counts["claude-sonnet-5-5"], 4, "anthropic 预算四档");
    for (const k of Object.keys(counts)) {
      const n = counts[k];
      assert.ok(k === "groq/llama-3.3-70b" ? (n === 0 || n === 3) : (n >= 2 && n <= 7), `${k} 档数在 2~7 域内（groq 非 gpt-oss 前缀=不支持=0）`);
    }
    assert.strictEqual(tl.SSH_LEVELS.length, 5, "SSH 表五档未变（主进程零触碰旁证）");
  });
}

/* ── D 组：版本锚 ── */

async function runVersionTests() {
  console.log("── D 组：版本锚 ──");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  await test("D1 package.json 版本 3.25.1", () => {
    assert.strictEqual(pkg.version, "3.25.1", "版本号 = 3.25.1");
  });
  await test("D2 README badge 同步", () => {
    assert.ok(rendererSrc.includes("v3.25.1 轨道刻度"), "renderer.js 版本注释在册");
    assert.ok(stylesSrc.includes("v3.25.1"), "styles.css 版本注释在册");
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