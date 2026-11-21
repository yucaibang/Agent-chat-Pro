"use strict";

/**
 * v3.45.3 守门：百宝箱（缓存清理迁入 + 内存优化 + 今日幸运值）+ 关于页官网直链
 *
 * 功能面：
 *   ① 设置导航「🧹 缓存清理」→「🎁 百宝箱」，缓存面板迁移（cache-* 元素 ID 全保留=渲染层逻辑零改动）
 *   ② 内存优化：IPC memory:optimize → memory-optimizer.cjs（主进程 v8 GC + 堆快照 + getAppMetrics 聚合）→ renderer 报告
 *   ③ 今日幸运值：0/100 二选一 + 每数值 10 条台词全不同 + 一天一次（localStorage 按本地日期锁定）
 *   ④ 关于页加官网直链 agent-chat-pro.pages.dev（a 标签走 v3.15.7 统一外链拦截）
 *
 * A 组 vm 假 DOM 行为真跑（装置承 test-v3-45-2/44-0 mkRuntime 架子；v3.21.2 教训：vm 跨 realm
 *   断言只用 string/number/boolean）
 * B 组源码锚 / C 组版本自洽（下限+badge 自洽滚动形态——45-1 B3 / 45-2 C1 硬钉升位即碎教训）
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const rendererSrc = read("src/renderer/renderer.js");
const settingsHtml = read("src/renderer/index.html");
const preloadSrc = read("src/main/preload.cjs");
const mainSrc = read("src/main/main.cjs");
const optimizerSrc = read("src/main/memory-optimizer.cjs");
const cssSrc = read("src/renderer/styles.css");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const readme = read("README.md");

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

/* ── 装置（承 test-v3-45-2 mkRuntime 架子，精简到百宝箱面所需） ── */
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

/* 百宝箱·内存优化 mock（每测试重置） */
const memoryState = { calls: 0, mock: null, lastArg: null };
const methodMocks = {
  listConversations: async () => [],
  listModes: async () => [],
  getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub }),
  getThinkingProfile: async () => ({ profile: null }),
  optimizeMemory: async (arg) => {
    memoryState.calls++;
    memoryState.lastArg = arg;
    return memoryState.mock ? memoryState.mock(arg) : { ok: true, gcRan: true, beforeMb: 12.5, afterMb: 8.1, freedMb: 4.4, memoryParts: ["主 86 MB", "渲染 200 MB"], totalMb: 296.5 };
  }
};
const defaultResult = () => ({
  edition: "main", productName: "Agent Chat Pro", conversations: [], items: [], messages: [], tools: [],
  files: [], entries: [], results: [], valid: true, invalidKeys: [], ok: true, path: "",
  lastConnectionMode: "", version: "3.45.3",
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
  setTimeout: (fn) => { timers.timeouts.push(fn); return timers.timeouts.length - 1; },
  clearTimeout: (id) => { if (timers.timeouts[id]) timers.timeouts[id] = null; },
  setInterval: (fn) => { timers.intervals.push(fn); return timers.intervals.length - 1; },
  clearInterval: (id) => { if (timers.intervals[id]) timers.intervals[id] = null; },
  addEventListener() {}, removeEventListener() {}
};
sandbox.globalThis = sandbox;

/* 百宝箱内部态透出口（let 绑定不出 vm 全局，script 附录摘取） */
const SOURCE_SUFFIX = "\n;globalThis.__acpLuck = { lines: LUCK_LINES, ymd: luckLocalYmd, read: luckReadRecord, key: LUCK_STORAGE_KEY };";
const vmSource = rendererSrc + SOURCE_SUFFIX;
try { vm.createContext(sandbox); vm.runInContext(vmSource, sandbox, { filename: "renderer.js" }); } catch (error) { console.error("eval 失败:", error); process.exit(1); }
const LUCK = () => sandbox.__acpLuck;
const flush = () => new Promise((r) => setTimeout(r, 0));

const luckBtn = () => rt.getFake("#luck-draw");
const luckResult = () => rt.getFake("#luck-result");
const memBtn = () => rt.getFake("#memory-optimize");
const memResult = () => rt.getFake("#memory-optimize-result");

async function resetLuck() {
  windowStub.localStorage.store.clear();
  const btn = luckBtn();
  btn.disabled = false;
  const result = luckResult();
  result.hidden = true; result.textContent = ""; result.className = "";
  await flush();
}

/* Math.random 受控（宿主对象=vm 同对象；测试内 stub、finally 必还） */
const realRandom = Math.random;
function withRandom(sequence, fn) {
  let i = 0;
  Math.random = () => (i < sequence.length ? sequence[i++] : 0);
  return Promise.resolve()
    .then(fn)
    .finally(() => { Math.random = realRandom; });
}

/* ── A 组：vm 行为真跑 ── */
async function runTreasureBehaviorTests() {
  await test("A0. renderer.js vm 假 DOM 全量求值 + __acpLuck 导出在（百宝箱链可驱动）", () => {
    assert.ok(LUCK(), "应挂 __acpLuck");
    assert.ok(typeof LUCK().ymd === "function", "luckLocalYmd 应为顶层函数");
    assert.ok(typeof LUCK().read === "function", "luckReadRecord 应为顶层函数");
  });

  await test("A1. 抽到 0：随机 0/100 二选一的低值分支 + 台词从对应池出 + 记录落 localStorage", async () => {
    await resetLuck();
    await withRandom([0.2, 0], async () => { // 0.2<0.5 → value=0；0 → pool[0]
      luckBtn()._listeners["click"]();
      await flush();
    });
    const result = luckResult();
    assert.strictEqual(result.hidden, false, "结果应可见");
    assert.ok(result.textContent.startsWith("今日幸运值 0——"), `应含低值前缀，实=${result.textContent}`);
    assert.ok(LUCK().lines[0].includes(result.textContent.replace("今日幸运值 0——", "")), "台词应出自 0 池");
    assert.strictEqual(luckBtn().disabled, true, "抽后按钮锁死（一天一次）");
    const saved = JSON.parse(windowStub.localStorage.getItem(LUCK().key) || "null");
    vmEq([saved.value, LUCK().lines[0].includes(saved.line), saved.ymd, LUCK().key], [0, true, LUCK().ymd(), "acp-luck-daily"], "localStorage 记录应与展示一致");
  });

  await test("A2. 抽到 100：高值分支 + 100 池台词", async () => {
    await resetLuck();
    await withRandom([0.9, 0.5], async () => { // 0.9≥0.5 → value=100；0.5 → pool[5]
      luckBtn()._listeners["click"]();
      await flush();
    });
    const result = luckResult();
    assert.ok(result.textContent.startsWith("今日幸运值 100——"), `应含高值前缀，实=${result.textContent}`);
    assert.ok(LUCK().lines[100].includes(result.textContent.replace("今日幸运值 100——", "")), "台词应出自 100 池");
    const saved = JSON.parse(windowStub.localStorage.getItem(LUCK().key) || "null");
    assert.strictEqual(saved.value, 100, "记录应为 100");
  });

  await test("A3. 一天一次铁规矩：已抽不重抽（次抽文案=已抽过 + 记录不被改写）", async () => {
    await resetLuck();
    await withRandom([0.2, 0], async () => {
      luckBtn()._listeners["click"]();
      await flush();
    });
    const first = luckResult().textContent;
    const savedBefore = windowStub.localStorage.getItem(LUCK().key);
    const snap = { value0Lines: [...LUCK().lines[0]] };
    let redrew = false;
    Math.random = () => { redrew = true; return 0.9; }; // 若重抽必得 100
    try {
      luckBtn()._listeners["click"]();
      await flush();
    } finally {
      Math.random = realRandom;
    }
    const result = luckResult();
    assert.ok(result.textContent.startsWith("今天已抽过（0）："), `应显已抽文案，实=${result.textContent}`);
    assert.ok(result.textContent.includes(first.replace("今日幸运值 0——", "")), "重放原句台词");
    assert.strictEqual(windowStub.localStorage.getItem(LUCK().key), savedBefore, "记录不得被改写");
    assert.strictEqual(redrew, false, "不得重抽（random 不应被调用）");
    vmEq([...LUCK().lines[0]], snap.value0Lines, "台词池不得被改动");
  });

  await test("A4. 跨天解锁：旧记录 ymd 过期 → 可再抽（记录被新值覆盖）", async () => {
    await resetLuck();
    // 先手写一条「昨天」的记录
    windowStub.localStorage.setItem(LUCK().key, JSON.stringify({ ymd: "2000-01-01", value: 100, line: LUCK().lines[100][0] }));
    await withRandom([0.2, 0], async () => {
      luckBtn()._listeners["click"]();
      await flush();
    });
    const result = luckResult();
    assert.ok(result.textContent.startsWith("今日幸运值 0——"), `旧记录过期应重新抽，实=${result.textContent}`);
    const saved = JSON.parse(windowStub.localStorage.getItem(LUCK().key) || "null");
    assert.strictEqual(saved.ymd, LUCK().ymd(), "记录 ymd 应=今天");
    assert.strictEqual(saved.value, 0, "记录应被新值覆盖");
  });

  await test("A5. 台词池铁则：0/100 各 10 条 + 20 条互不重复 + 记录台词必在池内", () => {
    const zero = [...LUCK().lines[0]];
    const hundred = [...LUCK().lines[100]];
    assert.strictEqual(zero.length, 10, `0 池应 10 条，实=${zero.length}`);
    assert.strictEqual(hundred.length, 10, `100 池应 10 条，实=${hundred.length}`);
    const all = [...zero, ...hundred];
    assert.strictEqual(new Set(all).size, 20, `20 条应样样不一样，实唯 ${new Set(all).size}`);
    assert.strictEqual(new Set(zero).size, 10, "0 池内部无重复");
    assert.strictEqual(new Set(hundred).size, 10, "100 池内部无重复");
    assert.ok(!zero.some((l) => hundred.includes(l)), "两池零交叉");
  });

  await test("A6. 记录修复容错：损坏 JSON/缺字段/台词不在池 → 视为未抽", async () => {
    await resetLuck();
    windowStub.localStorage.setItem(LUCK().key, "{broken json");
    assert.strictEqual(LUCK().read(), null, "损坏 JSON 应视为未抽");
    windowStub.localStorage.setItem(LUCK().key, JSON.stringify({ ymd: LUCK().ymd(), value: 77, line: "x" }));
    assert.strictEqual(LUCK().read(), null, "非法数值应视为未抽");
    windowStub.localStorage.setItem(LUCK().key, JSON.stringify({ ymd: LUCK().ymd(), value: 0, line: "池外假台词" }));
    assert.strictEqual(LUCK().read(), null, "台词不在池内应视为未抽（防手改记录冒领）");
  });

  await test("A7. 内存优化成功路径：报告含回收差值+体检聚合，按钮态复原", async () => {
    await resetLuck();
    memoryState.mock = () => ({ ok: true, gcRan: true, beforeMb: 12.5, afterMb: 8.1, freedMb: 4.4, memoryParts: ["主 86 MB", "渲染 200 MB"], totalMb: 296.5 });
    try {
      await memBtn()._listeners["click"]();
      await flush();
    } finally {
      memoryState.mock = null;
    }
    const result = memResult();
    assert.strictEqual(result.hidden, false, "报告应可见");
    assert.ok(result.textContent.includes("12.5 MB → 8.1 MB"), `应含前后堆差值，实=${result.textContent}`);
    assert.ok(result.textContent.includes("释放 4.4 MB"), "应含释放量");
    assert.ok(result.textContent.includes("主 86 MB / 渲染 200 MB") && result.textContent.includes("共 296.5 MB"), "应含体检聚合行");
    assert.ok([...memResult().className.split(/\s+/)].includes("ok"), "成功态样式");
    assert.strictEqual(memBtn().disabled, false, "按钮应复原");
  });

  await test("A8. 内存优化失败路径：reason 如实可见（finally 处理器不吞提示——v3.45.2 Bug#2 同标准）", async () => {
    await resetLuck();
    memoryState.mock = () => ({ ok: false, reason: "内存优化失败：Boom" });
    try {
      await memBtn()._listeners["click"]();
      await flush();
    } finally {
      memoryState.mock = null;
    }
    const result = memResult();
    assert.ok(result.textContent.includes("内存优化失败：Boom"), `失败原因应可见，实=${result.textContent}`);
    assert.ok([...result.className.split(/\s+/)].includes("fail"), "失败态样式");
    assert.strictEqual(memBtn().disabled, false, "按钮应复原");
  });

  await test("A9. 内存优化 IPC 抛错兜底：错误文案可见", async () => {
    await resetLuck();
    methodMocks.optimizeMemory = async () => { throw new Error("IPC 炸了"); };
    try {
      await memBtn()._listeners["click"]();
      await flush();
    } finally {
      methodMocks.optimizeMemory = async (arg) => { memoryState.calls++; memoryState.lastArg = arg; return { ok: true, gcRan: true, beforeMb: 12.5, afterMb: 8.1, freedMb: 4.4, memoryParts: [], totalMb: 0 }; };
    }
    assert.ok(memResult().textContent.includes("内存优化失败") && memResult().textContent.includes("IPC 炸了"), "错误应如实显报告");
  });
}

/* ── B 组：源码锚 ── */
async function runSourceAnchorTests() {
  await test("B1. 导航与面板：treasure 在位 + cache tab/面板清零 + cache-settings 归入 Treasure 面板区间", () => {
    assert.ok(settingsHtml.includes('data-settings-tab="treasure"'), "nav 应有 treasure（百宝箱）");
    assert.ok(!settingsHtml.includes('data-settings-tab="cache"'), "cache 导航 tab 应清零");
    assert.ok(settingsHtml.includes('data-settings-panel="treasure"'), "treasure 面板应在");
    assert.ok(!settingsHtml.includes('data-settings-panel="cache"'), "cache 面板应清零（迁移非残留）");
    const treasure = settingsHtml.indexOf('data-settings-panel="treasure"');
    const about = settingsHtml.indexOf('data-settings-panel="about"');
    const pos = settingsHtml.indexOf('<details id="cache-settings"');
    assert.ok(pos > treasure && pos < about, "cache-settings 应在 treasure 面板与 about 面板之间（面板内迁入）");
    for (const id of ["cache-scan", "cache-target-list", "cache-clean", "cache-clean-result"]) {
      assert.ok(settingsHtml.includes(`id="${id}"`), `缓存面板元素 ${id} ID 应保留（渲染层零改）`);
    }
  });

  await test("B2. 百宝箱新面板元素齐备：memory-optimize / luck-draw 双按钮与结果位", () => {
    for (const id of ["memory-optimize", "memory-optimize-result", "luck-draw", "luck-result"]) {
      assert.ok(settingsHtml.includes(`id="${id}"`), `百宝箱元素 ${id} 应在`);
    }
    assert.ok(settingsHtml.includes("百宝箱"), "「百宝箱」导航文案应在");
    assert.ok(!settingsHtml.includes("data-settings-tab=\"cache\">🧹 缓存清理"), "旧导航按钮应清零");
  });

  await test("B3. preload/main 接线齐：optimizeMemory 桥 API + memory:optimize handler + expose-gc 注入", () => {
    assert.ok(preloadSrc.includes('optimizeMemory: () => ipcRenderer.invoke("memory:optimize")'), "preload 应暴露 optimizeMemory");
    assert.ok(mainSrc.includes('ipcMain.handle("memory:optimize"'), "main 应接 memory:optimize");
    assert.ok(mainSrc.includes('require("./memory-optimizer.cjs")'), "main 应引 memory-optimizer.cjs");
    assert.ok(mainSrc.includes('v8.setFlagsFromString("--expose-gc")'), "main 应开 --expose-gc 动态 flag");
    assert.ok(optimizerSrc.includes("function optimizeMemory"), "memory-optimizer.cjs 应导出 optimizeMemory");
  });

  await test("B4. 关于页官网直链：a 标签 + href + 渲染层 bindExternalLinks 接管 + 样式", () => {
    const anchor = settingsHtml.match(/<a id="about-website"[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/) || [];
    assert.strictEqual(anchor[1], "https://agent-chat-pro.pages.dev", "官网 href 应= pages.dev 主址");
    assert.ok(settingsHtml.includes('class="about-link"'), "官网链接样式类应在");
    assert.ok(rendererSrc.includes('bindExternalLinks(document.querySelector(".about-info"))'), "渲染层应给 .about-info 容器接管外链");
    assert.ok(cssSrc.includes(".about-link {"), "styles.css 应有 .about-link 样式");
  });

  await test("B5. 渲染层走桥 API 与防吞写法：optimizeMemory 调用在 + 失败文案给 resultEl（不给死 finally）", () => {
    assert.ok(rendererSrc.includes("window.agentChatPro.optimizeMemory()"), "渲染层应调 optimizeMemory 桥 API");
    const memorySlice = rendererSrc.slice(rendererSrc.indexOf("#memory-optimize"), rendererSrc.indexOf("#memory-optimize") + 2200);
    assert.ok(memorySlice.includes("内存优化失败"), "失败文案应在");
    assert.ok(!/finally \{\s*\n\s*if \(resultEl\)/.test(memorySlice), "finally 不得清 resultEl（v3.45.2 Bug#2 同款防治）");
  });
}

/* ── C 组：版本自洽 ── */
async function runVersionTests() {
  await test("C1. package.json ≥ 3.45.3 且 README badge 自洽（44-2 同款下限+自洽滚动形态；45-1 B3/45-2 C2 硬钉升位即碎教训）", () => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version || ""));
    assert.ok(m, `package.json version 应为 x.y.z，实为 ${pkg.version}`);
    const major = m ? Number(m[1]) : 0;
    const minor = m ? Number(m[2]) : 0;
    const patch = m ? Number(m[3]) : 0;
    assert.ok(major > 3 || (major === 3 && (minor > 45 || (minor === 45 && patch >= 3))), `版本应 ≥ 3.45.3，实为 ${pkg.version}`);
    assert.strictEqual(String(readme.match(/badge\/version-([v\d.]+)-blue\.svg/)?.[1] || ""), pkg.version, `README badge 与 package.json ${pkg.version} 应自洽`);
  });
}

(async () => {
  console.log("\n── A. vm 假 DOM 行为真跑（百宝箱：幸运值 + 内存优化） ──");
  await runTreasureBehaviorTests();
  console.log("\n── B. 源码锚 ──");
  await runSourceAnchorTests();
  console.log("\n── C. 版本自洽 ──");
  await runVersionTests();
  console.log("");
  if (failed) { console.error(`test-v3-45-3 ✗ ${failed} 项失败`); for (const f of failures) console.error(`    - ${f}`); process.exit(1); }
  console.log(`test-v3-45-3 全绿（${passed} 项）`);
})().catch((error) => {
  console.error("测试执行失败：", error);
  process.exit(1);
});
