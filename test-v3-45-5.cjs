"use strict";

/**
 * v3.45.5 守门：群聊思考面板三连修（拖滑条误关 / 重开回默认回显 / SSH·本机成员独立挡位注入）
 *
 * 修复面：
 *   ① 关闭守卫：模式弹窗的 document click 关闭判定改看「本次按击起点（pointerdown）」——
 *      拖滑条把鼠标拖出面板边界再释放 = 合成 click target 落在面板外公共祖先，旧逻辑一松手面板就消失
 *   ② 回显拉新：群面板展开逐成员挡位时先 listAgentPool 拉池现值（拖动存档后的重开不再被旧快照拉回默认）；
 *      云端/SSH·本机成员 change 存档成功后就地同步 node.thinkingLevel（快照=存档真值）
 *   ③ SSH/本机成员滑条（用户实锤「单模式能调群聊为啥不能调」）：claude 系引擎独立五挡
 *      （eco/off/low/medium/high，展示域 THINK_SSH_LEVELS / 落库域 THINK_CLAUDE_LEVEL_IDS 映射）；
 *      atomcode/custom/qwen/codex/hermes 引擎 CLI 无思考参数 = 如实说明不放假滑条；
 *      主进程 mode-params resolveMode 增 config.thinkingLevelOverride（节点级最高优先，值域校验），
 *      workgroup-chat runRunnerMemberTurn 以池节点 thinkingLevel 随行（云端成员 thinking.choice 同语义）
 *
 * A 组行为级真跑（装置承 45-2/45-3 mkRuntime：renderer 全量 vm 求值 + document handler 收集增强；
 *   mode-params vm 假 require 求值）／B 组源码锚／C 组版本自洽（下限+badge 自洽滚动式，45-1 B3 教训）
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const rendererSrc = read("src/renderer/renderer.js");
const workgroupSrc = read("src/main/workgroup-chat.cjs");
const modeParamsSrc = read("src/main/modes/mode-params.cjs");
const modeDefaults = require("./src/main/modes/mode-defaults.cjs");
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

/* ── 装置（承 test-v3-45-2/45-3 mkRuntime 架子；v3.21.2 教训：vm 跨 realm 断言只用 string/number/boolean） ── */
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

const mkRuntime = () => { /* 装置=45-3 全量同款（含 form.elements.namedItem / querySubtree / append 家族） */
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

const gateStub = { agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true, deviceLink: true, printLink: true, localEngines: true, easterEgg: true };
const timers = { timeouts: [], intervals: [] };

/* document handler 收集（45-5 增强于 45-3 架子：click/pointerdown 可直驱——A1 关闭守卫行为真跑用） */
const documentHandlers = {};
const poolState = { nodes: [] }; // A2/A4 虽走 mode-params 独立装置，fillRows 拉新链若被带出也按空池兜底

const methodMocks = {
  getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gateStub }),
  listConversations: async () => [],
  listModes: async () => [],
  listAgentPool: async () => poolState.nodes,
  updateAgentPoolNode: async () => ({}),
  optimizeMemory: async () => ({ ok: true }),
  getThinkingProfile: async () => ({ profile: null }),
};

const defaultResult = () => ({
  edition: "main", productName: "Agent Chat Pro", conversations: [], items: [], messages: [], tools: [],
  files: [], entries: [], results: [], valid: true, invalidKeys: [], ok: true, path: "",
  lastConnectionMode: "", version: "3.45.5",
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
      if (prop.startsWith("on")) return () => {};
      return async () => defaultResult();
    },
    set(_t, prop, v) { _t[prop] = v; return true; }
  }),
  addEventListener() {}, removeEventListener() {},
  location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
  matchMedia: () => ({ matches: false, media: "", addEventListener() {}, addListener() {}, removeListener() {} }),
  open: () => null, close() {},
  navigator: { clipboard: { writeText: async () => {} }, userAgent: "smoke", mediaDevices: undefined },
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
  gate: gateStub,
  window: windowStub, document: {
    body: rt.getFake("body"), head: rt.getFake("head"), documentElement: rt.getFake("documentElement"),
    activeElement: null,
    querySelector: (sel) => rt.getFake(sel), querySelectorAll: () => [],
    getElementById: (id) => rt.getFake(`#${id}`),
    createElement: (tag) => { const el = rt.makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    addEventListener(type, fn) { (documentHandlers[String(type)] = documentHandlers[String(type)] || []).push(fn); },
    removeEventListener() {}
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

/* 群面板内部态透出口（let 绑定不出 vm 全局，script 附录摘取——closeComposerModePopup/elements 为顶层可达） */
const SOURCE_SUFFIX = "\n;globalThis.__acpModeGate = { press: () => modePopupPress, setOpen: (v) => { composerModePopupOpen = Boolean(v); }, close: closeComposerModePopup, popup: () => elements.composerModePopup };";
const vmSource = rendererSrc + SOURCE_SUFFIX;
try { vm.createContext(sandbox); vm.runInContext(vmSource, sandbox, { filename: "renderer.js" }); } catch (error) { console.error("eval 失败:", error); process.exit(1); }
const GATE = () => sandbox.__acpModeGate;
const flush = () => new Promise((r) => setTimeout(r, 0));

const clickHandlers = () => documentHandlers.click || [];
const pointerHandlers = () => documentHandlers.pointerdown || [];

/* ── A 组：行为级真跑 ── */
async function runBehaviorTests() {
  await test("A0. renderer.js vm 假 DOM 全量求值成功 + __acpModeGate 导出在（新顶层 pointerdown 注册无异常）", () => {
    assert.ok(GATE(), "应挂 __acpModeGate");
    assert.ok(typeof GATE().close === "function", "closeComposerModePopup 应可达");
    assert.ok(typeof GATE().setOpen === "function", "open 态 setter 应可达");
    assert.ok(pointerHandlers().length === 1, "顶层应注册恰好 1 个 pointerdown handler");
    assert.ok(clickHandlers().length >= 1, "click handler 应注册在");
  });

  await test("A1. 关闭守卫：按击起点在面板内（拖滑条出界释放）→ 面板不关；起点在面板外 → 正常关", () => {
    // 注册序第 2 个顶层 document click = 守卫（2400 统一外链拦截 → 4919 守卫；后续 5236 关 app 菜单/5349 其他）
    const guardClick = clickHandlers()[1];
    assert.ok(typeof guardClick === "function", "守卫 click handler 应注册在（注册序第 2）");
    GATE().setOpen(true);
    GATE().popup().hidden = false;
    pointerHandlers()[0]({ target: { closest: (sel) => (sel === ".composer-mode-selector" ? { tag: "inside" } : null) } });
    guardClick({ target: { closest: () => null } }); // 合成 click 落面板外（拖出界释放的坑态）
    assert.strictEqual(GATE().popup().hidden, false, "按击起点在面板内：拖出界释放的 click 不得关面板");
    pointerHandlers()[0]({ target: { closest: () => null } }); // 起点在面板外
    guardClick({ target: { closest: () => null } });
    assert.strictEqual(GATE().popup().hidden, true, "按击起点在面板外面板外点：应正常关闭");
    assert.strictEqual(GATE().press().inside, false, "press 起点态应随 pointerdown 重算");
  });

  await test("A2. resolveMode 节点级 override 最高优先：压过会话偏好 low 与模式默认 none", () => {
    const env = makeModeParamsEnv();
    const mode = env.resolve("regular", { thinkingLevelOverride: "high" }, { thinkingChoices: { ssh: { regular: "low" } } });
    vmEq(mode.thinkingLevel, "high", "override=high 应最高优先（压过偏好 low/默认 none）");
  });

  await test("A3. override 非法/空=不覆盖：回退会话偏好（非法 bogus → 偏好 low；空串 → 偏好 low）", () => {
    const env = makeModeParamsEnv();
    const mode1 = env.resolve("regular", { thinkingLevelOverride: "bogus" }, { thinkingChoices: { ssh: { regular: "low" } } });
    vmEq(mode1.thinkingLevel, "low", "非法 override 应被值域校验拒收，回退会话偏好");
    const mode2 = env.resolve("regular", {}, { thinkingChoices: { ssh: { regular: "low" } } });
    vmEq(mode2.thinkingLevel, "low", "无 override 字段应回退会话偏好");
    const mode3 = env.resolve("regular", {}, { thinkingChoices: {} });
    vmEq(mode3.thinkingLevel, "none", "无 override 且无偏好 → 模式默认挡位");
  });

  await test("A4. override 空白剥离：'  medium ' 同样生效（trim 语义）", () => {
    const env = makeModeParamsEnv();
    const mode = env.resolve("regular", { thinkingLevelOverride: "  medium " }, { thinkingChoices: {} });
    vmEq(mode.thinkingLevel, "medium", "override 应 trim 后生效");
  });
}

/* mode-params.cjs vm 假 require 求值：BUILTIN_MODES 用真模块常量，settings.cjs 延迟 require 由测试按场景投喂 */
function makeModeParamsEnv() {
  const current = { value: {} };
  const sandboxMode = {
    console,
    module: { exports: {} }, // mode-params.cjs 末尾 module.exports=…（vm 无 CommonJS 包装，须补 module 形态）
    require: (p) => {
      if (p.includes("mode-defaults")) return modeDefaults;
      if (p.includes("mode-manager")) return { getMode: (id) => ({ id, thinkingLevel: "none", skipPermissions: true }) };
      if (p.includes("protocol")) return { shellQuote: (s) => String(s) };
      if (p.includes("ask-convention")) return { appendAskConvention: (s) => String(s || "") };
      if (p.includes("settings")) return { getSettings: () => current.value };
      throw new Error("mock require 收到意外路径: " + p);
    }
  };
  sandboxMode.globalThis = sandboxMode;
  vm.createContext(sandboxMode);
  vm.runInContext(modeParamsSrc, sandboxMode, { filename: "mode-params.cjs" });
  return {
    resolve(modeId, config, settings) {
      current.value = settings || {};
      return vm.runInContext(`resolveMode(${JSON.stringify(modeId)}, ${JSON.stringify(config || {})})`, sandboxMode);
    }
  };
}

/* ── B 组：源码锚 ── */
async function runSourceTests() {
  await test("B1. 渲染层锚：fillRows 展开即拉池现值回显（listAgentPool + 按池 id 替换节点 + 失败沿用快照兜底）", () => {
    assert.ok(rendererSrc.includes("listAgentPool()"), "fillRows 应重新拉池");
    assert.ok(rendererSrc.includes("pool.find((item) => item.id === node.id) || node"), "应以池现值替换快照节点");
    assert.ok(rendererSrc.includes("拉取失败沿用已有快照"), "拉池失败应有兜底注释锚");
  });

  await test("B2. 渲染层锚：SSH/本机成员滑条（展示域 THINK_SSH_LEVELS + 落库域映射 + 回显 REVERSE + 引擎说明）", () => {
    assert.ok(rendererSrc.includes("const levels = THINK_SSH_LEVELS;"), "SSH/本机成员应用五挡展示域");
    assert.ok(rendererSrc.includes("THINK_CLAUDE_LEVEL_REVERSE[String(node.thinkingLevel || \"\").trim()] || \"off\""), "回显应经落库→展示域映射");
    assert.ok(rendererSrc.includes("THINK_CLAUDE_LEVEL_IDS[level?.id] || \"none\""), "change 应经展示→落库域映射存池");
    assert.ok(rendererSrc.includes("该引擎（${engine}）暂不支持思考挡位调节"), "非 claude 引擎应如实说明不给滑条");
  });

  await test("B3. 渲染层锚：存档成功后快照就地同步（云端与 SSH/本机两处 change 都有 node.thinkingLevel 同步）", () => {
    const count = rendererSrc.split("node.thinkingLevel = ").length - 1;
    assert.ok(count >= 2, `两处 change 存档后就地同步快照（实测 ${count} 处）`);
    assert.ok(rendererSrc.includes("快照就地同步：面板收展不重拉也能回显真值"), "SSH 分支应带同步注释锚");
  });

  await test("B4. workgroup-chat 锚：SSH/本机成员池节点挡位随行 override（值域内才带，云端 choice 通道不动）", () => {
    assert.ok(workgroupSrc.includes('runnerConfig.thinkingLevelOverride = memberLevel'), "成员轮应注入 thinkingLevelOverride");
    assert.ok(workgroupSrc.includes('["eco", "none", "low", "medium", "high"].includes(memberLevel)'), "应按值域校验后才注入");
    assert.ok(workgroupSrc.includes("thinking: { provider: agent.provider, model: agent.model || \"\", choice: agent.thinkingLevel || \"\" }"), "云端成员 choice 注入通道应保持");
  });

  await test("B5. mode-params 锚：override 校验域与 workgroup-chat 同构（THINKING_LEVEL_VALUES 同域）", () => {
    assert.ok(modeParamsSrc.includes('THINKING_LEVEL_VALUES.includes(override)'), "resolveMode 应按值域校验 override");
    assert.ok(modeParamsSrc.includes("config?.thinkingLevelOverride"), "应读 config.thinkingLevelOverride");
  });

  await test("B6. mode-params 锚：resolveMode 副本绑定可重赋值（const 雷防回归——偏好覆盖=重赋值形态）", () => {
    assert.ok(modeParamsSrc.includes("let mode = { ...(getMode(modeId) || fallback) };"), "副本应为 let 绑定（const 重赋值=严格模式运行时炸）");
    assert.ok(modeParamsSrc.includes("mode = applyThinkingChoice(mode, modeId, readThinkingChoices())"), "偏好覆盖走变量重赋值（挂偏好+节点级 override 两段式）");
  });
}

async function runVersionTests() {
  await test("C1. 版本滚动锚：package.json ≥3.45.5 且 README badge 与版本自洽", () => {
    const major = pkg.version.split(".").map(Number);
    assert.ok(major[0] === 3 && (major[1] > 45 || (major[1] === 45 && major[2] >= 5)), `版本应 ≥3.45.5（实际 ${pkg.version}）`);
    assert.ok(readme.includes(`version-${pkg.version}`), "README badge 应与 package.json 版本一致");
    const badgeTests = (readme.match(/tests-(\d+)%20files/) || [])[1];
    assert.ok(badgeTests && Number(badgeTests) >= 64, `README tests badge 应覆盖本轮（≥64 files，实际 ${badgeTests}）`);
  });
}

(async () => {
  console.log("── A 组：行为级真跑 ──");
  await runBehaviorTests();
  console.log("── B 组：源码锚 ──");
  await runSourceTests();
  console.log("── C 组：版本自洽 ──");
  await runVersionTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`);
  if (failures.length) {
    console.log("\n失败明细：");
    for (const item of failures) console.log("  - " + item);
    process.exit(1);
  }
})();
