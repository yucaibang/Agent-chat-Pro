"use strict";

/**
 * v3.45.2 守门：语音链「听说」三修（v3.36.0 落地后首次自查，装机前代码自查先例沿 v3.45.1）
 *
 * Bug A（中·资源泄漏）startVoiceInput 起始 await 窗口（voiceInfo IPC + getUserMedia 授权弹窗可达数秒）
 *   无重入闸——二连点=双会话，前会话引用被覆盖丢失：麦克风常热不松手、processor 每秒 ~190KB 吃内存、旧 interval 永挂。
 *   → 修复=voiceStarting 同步重入闸 + 起始窗口按钮 disabled 双保险 + AudioContext 构造失败收流兜底。
 * Bug B（中高·失败提示被吞）stopVoiceInput 转录失败分支 voiceShowTip 刚写进 placeholder，
 *   finally 同 tick 清回默认——用户永远看不到失败原因（v3.45.1「用户看不见的文案」同病根重演）。
 *   → 修复=失败路径交给 voiceShowTip（10s 还原），finally 只收口按钮态；成功路径在 try 内恢复 placeholder。
 * Bug C（低）录音启动不清 voiceTipTimer——上一条失败提示的 10s 定时器在录音中把「正在听说…」清回默认。
 *   → 修复=录音成功建立 session 时 clearTimeout(voiceTipTimer)。
 *
 * A 组 vm 假 DOM 行为真跑（装置承 test-v3-44-0 mkRuntime 架子；v3.21.2 教训：vm 跨 realm 断言只用 string/number/boolean）
 * B 组源码锚
 * C 组版本自洽
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const rendererSrc = read("src/renderer/renderer.js");
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

/* ── 装置（承 test-v3-44-0 mkRuntime 架子，扩展 voice 面：受控定时器/getUserMedia/AudioContext/btoa） ── */
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
const windowKeydownHandlers = [];
const gatesStub = { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true };
const methodMocks = {
  listConversations: async () => [],
  listModes: async () => [],
  getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub }),
  getThinkingProfile: async () => ({ profile: null })
};
const defaultResult = () => ({
  edition: "main", productName: "Agent Chat Pro", conversations: [], items: [], messages: [], tools: [],
  files: [], entries: [], results: [], valid: true, invalidKeys: [], ok: true, path: "",
  lastConnectionMode: "", version: "3.45.2",
  host: "", port: 22, username: "", wakeName: "", clientLabel: "",
  workingDirectory: "", dataDirectory: "", skipPermissions: false,
  showSignalLights: true, connectionMode: "cloud", localEngine: "claude",
  hasPassword: true, hasCloudAiConfig: true,
  cloudAiProvider: "zhipu", cloudAiBaseUrl: "", cloudAiModel: "glm-5",
  thinkingChoices: {}, theme: "dark"
});

/* 麦克风/转录面 mock（每测试重置） */
const voiceState = {
  infoCalls: 0, transcribeCalls: 0, micCalls: 0, trackStops: 0,
  infoMock: null, transcribeMock: null,
  hang: false, pendingResolvers: [],
  reset() { this.infoCalls = 0; this.transcribeCalls = 0; this.micCalls = 0; this.trackStops = 0; this.hang = false; this.pendingResolvers = []; }
};
methodMocks.voiceInfo = async () => { voiceState.infoCalls++; return (voiceState.infoMock || (() => ({ ok: true, provider: "zhipu", supported: true, maxSeconds: 8, hasKey: true, reason: "" })))(); };
methodMocks.voiceTranscribe = async (payload) => { voiceState.transcribeCalls++; return (voiceState.transcribeMock || (() => ({ ok: true, text: "你好世界" })))({ payload }); };

const makeStream = () => ({
  getTracks: () => [{
    stopped: false,
    stop() { this.stopped = true; voiceState.trackStops++; }
  }]
});

const windowStub = {
  window: null, self: null,
  AudioContext: undefined, webkitAudioContext: undefined,
  agentChatPro: new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop in _t) return _t[prop];
      if (prop in methodMocks) return methodMocks[prop];
      return async () => defaultResult();
    },
    set(_t, prop, v) { _t[prop] = v; return true; }
  }),
  addEventListener(type, fn) { if (String(type) === "keydown") windowKeydownHandlers.push(fn); },
  removeEventListener() {},
  location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
  matchMedia: () => ({ matches: false, media: "", addEventListener() {}, addListener() {}, removeListener() {} }),
  open: () => null, close() {},
  navigator: {
    clipboard: { writeText: async () => {} },
    userAgent: "smoke",
    mediaDevices: {
      getUserMedia(constraints) {
        voiceState.micCalls++;
        if (voiceState.hang) return new Promise((resolve) => { voiceState.pendingResolvers.push(resolve); });
        return Promise.resolve(makeStream());
      }
    }
  },
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

/* AudioContext 桩：⚠ 命名类表达式 `class FakeX` 的自名绑定会遮蔽宿主同名 const（构造器内 wrapper 属性变 undefined）——用平铺 registry 规避 */
const AUDIO_INSTANCES = [];
class FakeAudioContextClass {
  constructor() {
    this.sampleRate = 48000;
    this.destination = { fake: "dest" };
    this._closed = false;
    this._processor = null;
    AUDIO_INSTANCES.push(this);
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() {
    const proc = { onaudioprocess: null, connect() {}, disconnect() {} };
    this._processor = proc;
    return proc;
  }
  close() { this._closed = true; }
}
windowStub.AudioContext = FakeAudioContextClass;

/* 受控定时器（录音入口 clearTimeout 断言用） */
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
  btoa: (input) => Buffer.from(String(input), "binary").toString("base64"),
  alert() {}, confirm: () => false, prompt: () => null,
  setTimeout: (fn) => { timers.timeouts.push(fn); return timers.timeouts.length - 1; },
  clearTimeout: (id) => { if (timers.timeouts[id]) timers.timeouts[id] = null; },
  setInterval: (fn) => { timers.intervals.push(fn); return timers.intervals.length - 1; },
  clearInterval: (id) => { if (timers.intervals[id]) timers.intervals[id] = null; },
  addEventListener() {}, removeEventListener() {}
};
sandbox.globalThis = sandbox;

/* 语音内部态透出口（let 绑定不出 vm 全局，须同 script 附录摘取） */
const SOURCE_SUFFIX = "\n;globalThis.__acpVoice = { session: () => voiceSession, startVoiceInput, stopVoiceInput, voiceTeardown, voiceShowTip, defaultPlaceholder: VOICE_DEFAULT_PLACEHOLDER, starting: () => voiceStarting, clearStarting: () => { voiceStarting = false; } };";
const vmSource = rendererSrc + SOURCE_SUFFIX;
try { vm.createContext(sandbox); vm.runInContext(vmSource, sandbox, { filename: "renderer.js" }); } catch (error) { console.error("eval 失败:", error); process.exit(1); }
const V = () => sandbox.__acpVoice;
const flush = () => new Promise((r) => setTimeout(r, 0));

async function resetVoice() {
  if (V().session()) V().voiceTeardown();
  V().voiceTeardown();
  V().clearStarting(); // 测试隔离兜底：前序测试悬挂在挂起态时不毒害后续测试
  const btn = rt.getFake("#voice");
  btn.classList.remove("recording", "working");
  btn.disabled = false;
  btn.textContent = "";
  const promptEl = rt.getFake("#prompt");
  promptEl.placeholder = "";
  promptEl.value = "";
  voiceState.reset();
  AUDIO_INSTANCES.length = 0;
  timers.timeouts.length = 0;
  timers.intervals.length = 0;
  await flush();
}

/* 建 session：默认 ugm 立即 resolve */
async function bootVoice() {
  await V().startVoiceInput();
  await flush();
  if (!V().session()) console.log("DBG 会话未建立: mic=%s ctx=%s placeholder=%j starting=%s", voiceState.micCalls, AUDIO_INSTANCES.length, rt.getFake("#prompt").placeholder, V().starting());
  assert.ok(V().session(), "bootVoice：语音会话应已建立");
  return V().session();
}

/* ── A 组：vm 行为真跑 ── */
async function runVoiceBehaviorTests() {
  await test("A0. renderer.js vm 假 DOM 全量求值 + __acpVoice 导出在（语音链可驱动）", () => {
    assert.ok(sandbox.__acpVoice, "应挂 __acpVoice");
    assert.ok(typeof sandbox.__acpVoice.startVoiceInput === "function", "startVoiceInput 应为顶层函数");
    assert.ok(typeof sandbox.__acpVoice.stopVoiceInput === "function", "stopVoiceInput 应为顶层函数");
  });

  await test("A1. 起始窗口重入闸：挂起（授权弹窗）期二连点 → getUserMedia 恰 1 次、按钮不可点、无泄漏会话", async () => {
    await resetVoice();
    voiceState.hang = true;
    const p1 = V().startVoiceInput();
    await flush(); await flush(); // voiceInfo IPC 往返后进入 ugm 挂起
    const snapshot = {
      mic1: voiceState.micCalls,
      starting: V().starting(),
      disabled: rt.getFake("#voice").disabled
    };
    const p2 = V().startVoiceInput();
    assert.strictEqual(typeof (p2 && p2.then), "function", "第二次调用即时返回 promise（跨 realm 不用 instanceof）");
    voiceState.pendingResolvers.shift()(makeStream()); // 先收口再断言：防 assert 抛错把 voiceStarting 悬挂毒害后续测试
    await p1;
    await p2;
    await flush();
    assert.strictEqual(snapshot.mic1, 1, "首次调用只发起一次 getUserMedia");
    assert.strictEqual(snapshot.starting, true, "挂起期 voiceStarting 置位");
    assert.strictEqual(snapshot.disabled, true, "挂起期按钮 disabled（真实 DOM 二连点进不来）");
    assert.strictEqual(voiceState.micCalls, 1, "重入被闸挡下：不再发起第二个 getUserMedia（修 Bug A 主断言）");
    assert.ok(V().session(), "挂起 resolve 后会话建立");
    assert.ok(!rt.getFake("#voice").disabled, "录音中按钮恢复可点（点=停止）");
    assert.ok(rt.getFake("#voice").classList.contains("recording"), "录音态样式在");
    assert.strictEqual(timers.intervals.length, 1, "仅本会话的自动截止 interval（无泄漏 interval 残留）");
  });

  await test("A2. 转录失败提示不被吞：失败原因驻留 placeholder，不被 finally 同 tick 清回默认（修 Bug B 主断言）", async () => {
    await resetVoice();
    const session = await bootVoice();
    session.startedAt = Date.now() - 1200; // 计时前移：绕开「太短」短路
    session.processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Array(6144).fill(0.1) } });
    voiceState.transcribeMock = () => ({ ok: false, reason: "请求被拒绝（400）：录音格式不合规" });
    const stop = V().stopVoiceInput(true);
    await flush(); await flush();
    await stop;
    const promptEl = rt.getFake("#prompt");
    assert.strictEqual(promptEl.placeholder, "请求被拒绝（400）：录音格式不合规", "失败原因应驻留 placeholder（旧代码被 finally 清回默认=用户永远看不到）");
    assert.notStrictEqual(promptEl.placeholder, V().defaultPlaceholder, "不得被清回默认串");
    assert.ok(!V().session(), "会话已收口");
    assert.ok(!rt.getFake("#voice").disabled, "按钮恢复可点");
  });

  await test("A3. 转录成功：文字插入输入框 + placeholder 恢复默认 + 按钮还原", async () => {
    await resetVoice();
    const session = await bootVoice();
    session.startedAt = Date.now() - 1200;
    session.processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Array(6144).fill(0.2) } });
    voiceState.transcribeMock = () => ({ ok: true, text: "你好世界" });
    await V().stopVoiceInput(true);
    await flush(); await flush();
    assert.ok(String(rt.getFake("#prompt").value).includes("你好世界"), "转录文字应插入输入框");
    assert.strictEqual(rt.getFake("#prompt").placeholder, V().defaultPlaceholder, "成功路径恢复默认 placeholder");
    assert.ok(!V().session(), "会话已收口");
  });

  await test("A4. Esc 中止：流收掉、不调转录、无会话残留", async () => {
    await resetVoice();
    await bootVoice();
    assert.ok(windowKeydownHandlers.length >= 1, "keydown 处理器已在求值时注册");
    const escapeEvent = { key: "Escape", defaultPrevented: false, stopPropagation() {}, preventDefault() {} };
    for (const handler of windowKeydownHandlers) handler(escapeEvent);
    await flush();
    assert.ok(voiceState.trackStops >= 1, "麦克风流必须被收掉");
    assert.strictEqual(V().session(), null, "会话终止");
    assert.strictEqual(voiceState.transcribeCalls, 0, "中止不调转录");
    assert.strictEqual(String(rt.getFake("#voice").textContent), "🎤 听说", "按钮还原");
  });

  await test("A5. 太短录音：不调转录 + 「录音太短」提示在（不进 try/finally 不被吞）", async () => {
    await resetVoice();
    await bootVoice();
    await V().stopVoiceInput(true);
    await flush();
    assert.strictEqual(voiceState.transcribeCalls, 0, "太短不调转录");
    assert.ok(String(rt.getFake("#prompt").placeholder).includes("录音太短"), "太短提示驻留");
  });

  await test("A6. 录音启动清 voiceTipTimer：上一条失败提示的 10s 定时器被取消（修 Bug C 主断言）", async () => {
    await resetVoice();
    V().voiceShowTip("旧提示占位");
    assert.strictEqual(timers.timeouts.length, 1, "旧提示定时器已挂");
    await V().startVoiceInput();
    await flush();
    assert.ok(V().session(), "会话建立");
    assert.ok(timers.timeouts[0] === null, "旧提示定时器应被录音启动清掉（否则 10s 后把「正在听说…」清回默认）");
    assert.ok(String(rt.getFake("#prompt").placeholder).includes("正在听说"), "录音提示接管 placeholder");
  });

  await test("A7. AudioContext 构造失败兜底：麦克风流收掉、无会话残留、如实报错（不闪退不静默）", async () => {
    await resetVoice();
    FakeAudioContextClass.prototype.createScriptProcessor = () => { throw new Error("构造失败"); };
    try {
      await V().startVoiceInput();
      await flush();
      assert.strictEqual(voiceState.trackStops, 1, "构造失败必须收掉麦克风流（否则录音灯常亮+流泄漏）");
      assert.strictEqual(V().session(), null, "无会话残留");
      assert.ok(String(rt.getFake("#prompt").placeholder).includes("无法启动录音"), "失败原因如实上屏");
    } finally {
      FakeAudioContextClass.prototype.createScriptProcessor = function () {
        const proc = { onaudioprocess: null, connect() {}, disconnect() {} };
        this._processor = proc;
        return proc;
      };
    }
  });
}

/* ── B 组：源码锚 ── */
async function runSourceTests() {
  await test("B1. 重入闸源码锚：voiceStarting 在册 + disabled 置位先于首个 await（挂起窗口不可点）", () => {
    const startIdx = rendererSrc.indexOf("let voiceStarting");
    assert.ok(startIdx > 0, "voiceStarting 重入闸在册");
    assert.ok(rendererSrc.indexOf("if (voiceSession || voiceStarting) return;") > startIdx, "闸条件双查在册");
    const disabledIdx = rendererSrc.indexOf("voiceButton.disabled = true", startIdx);
    const firstAwaitIdx = rendererSrc.indexOf("await window.agentChatPro.voiceInfo", startIdx);
    assert.ok(disabledIdx > 0 && firstAwaitIdx > disabledIdx, "disabled 置位行应先于首个 await");
  });

  await test("B2. 失败提示防线源码锚：finally 只收口按钮态，成功路径在 try 内恢复 placeholder", () => {
    const stopIdx = rendererSrc.indexOf("async function stopVoiceInput");
    assert.ok(stopIdx > 0, "stopVoiceInput 在册");
    const stopSlice = rendererSrc.slice(stopIdx, stopIdx + 2600);
    assert.ok(/} finally \{\s*\n\s*voiceIdle\(\);\s*\n\s*\}/.test(stopSlice), "stopVoiceInput 的 finally 不得再清 placeholder（只 voiceIdle）");
    assert.ok(stopSlice.includes("if (elements.prompt) elements.prompt.placeholder = VOICE_DEFAULT_PLACEHOLDER;"), "成功路径恢复 placeholder 在 try 内");
    assert.ok(!/finally \{\s*\n\s*if \(elements\.prompt\)/.test(stopSlice), "finally 开头即清 placeholder 的旧形态不复存在（⚠ 锚只查 stop 切片：!commit 分支合法含同形串）");
  });

  await test("B3. Bug C 源码锚：clearTimeout(voiceTipTimer) 落在 startVoiceInput 录音启动段", () => {
    const startIdx = rendererSrc.indexOf("let voiceStarting");
    const stopIdx = rendererSrc.indexOf("async function stopVoiceInput");
    const clearIdx = rendererSrc.indexOf("clearTimeout(voiceTipTimer)", startIdx);
    assert.ok(clearIdx > startIdx && clearIdx < stopIdx, "clearTimeout(voiceTipTimer) 应在 startVoiceInput 区间");
  });

  await test("B4. 泄漏防线源码锚：AudioContext 构造 catch 先收流再报错", () => {
    const startIdx = rendererSrc.indexOf("let voiceStarting");
    const guardIdx = rendererSrc.indexOf("try { stream.getTracks().forEach((track) => track.stop()); }", startIdx);
    const tipIdx = rendererSrc.indexOf("无法启动录音：", startIdx);
    assert.ok(guardIdx > startIdx, "构造失败收流兜底在册");
    assert.ok(tipIdx > guardIdx, "收流先于提示（防提示先抛中断流回收）");
  });
}

/* ── C 组：版本自洽 ── */
async function runVersionTests() {
  await test("C1. package.json ≥ 3.45.2 且 README badge 自洽（44-2 同款下限+自洽滚动形态；硬钉 3.45.2 在 v3.45.3 升位时碎——45-1 B3 同教训）", () => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version || ""));
    assert.ok(m, `package.json version 应为 x.y.z，实为 ${pkg.version}`);
    const major = m ? Number(m[1]) : 0;
    const minor = m ? Number(m[2]) : 0;
    const patch = m ? Number(m[3]) : 0;
    assert.ok(major > 3 || (major === 3 && (minor > 45 || (minor === 45 && patch >= 2))), `版本应 ≥ 3.45.2，实为 ${pkg.version}`);
    assert.strictEqual(String(readme.match(/badge\/version-([v\d.]+)-blue\.svg/)?.[1] || ""), pkg.version, `README badge 与 package.json ${pkg.version} 应自洽`);
  });
}

(async () => {
  console.log("\n── A. vm 假 DOM 行为真跑（语音链三修） ──");
  await runVoiceBehaviorTests();
  console.log("\n── B. 源码锚 ──");
  await runSourceTests();
  console.log("\n── C. 版本自洽 ──");
  await runVersionTests();
  console.log("");
  if (failed) { console.error(`test-v3-45-2 ✗ ${failed} 项失败`); failures.forEach((f) => console.log(`✗ ${f}`)); process.exit(1); }
  console.log(`test-v3-45-2: ${passed} 项全绿`);
})().catch((error) => { console.error(error); process.exit(1); });
