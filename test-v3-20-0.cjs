"use strict";
/**
 * v3.20.0 测试 — F5 Agent plan 面板（三模式全覆盖）
 * 覆盖：
 *   A. plan-convention.cjs 真单测（约定注入：追加位置 / 幂等 / 非字符串入参 / 约定语义完整性）
 *   B. main.cjs 接线（require + cloud 分支 systemPrompt 挂约定）
 *   C. renderer.js 静态接线（renderTool TodoWrite 分派 / renderAssistant 抽离 / finalizeToolList 过滤 / supersede）
 *   D. styles.css 断言（面板主样式 / 折叠与被覆盖态 / 三状态视觉 / 亮色主题变量）
 *   E. 版本号 3.20.0 + 混淆清单登记
 *   F. renderer 运行时冒烟（vm 假 DOM 真求值 = v3.19.0 装机事故铁律——renderer 接线改动必过运行时冒烟）：
 *      全量求值 + extractPlanBlocks / planTodosFromTool / renderPlanPanel / renderTool 分派 /
 *      finalizeToolList 过滤 / supersede 逻辑直调
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const convention = require("./src/main/plan-convention.cjs");
const mainSrc = read("src/main/main.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const stylesSrc = read("src/renderer/styles.css");
const obfuscateSrc = read("scripts/obfuscate.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
    .catch((error) => { failed += 1; failures.push(`  ✗ ${name}\n    ${error.message}`); console.log(`  ✗ ${name}`); });
}

async function main() {
  console.log("\n=== A. plan-convention.cjs 真单测 ===");

  await test("A1. 空入参 → 纯约定段（含 marker/plan 语言标记/编号格式行）", () => {
    const out = convention.appendPlanConvention("");
    assert.ok(out.includes(convention.PLAN_PROMPT_MARKER), "含注入标记");
    assert.ok(out.includes("```plan"), "含 ```plan 开头示例");
    assert.ok(out.includes("3. 第三个目标"), "含编号格式示例行");
  });

  await test("A2. 追加到已有工作模式 prompt → 原内容保留在最前", () => {
    const base = "你是 NAS 运维助手，语气简洁。";
    const out = convention.appendPlanConvention(base);
    assert.ok(out.startsWith(base), "原始 prompt 保留在最前");
    assert.ok(convention.hasPlanConvention(out), "追加后含 marker");
  });

  await test("A3. 幂等：双层包裹与单层逐字节一致（防重复注入）", () => {
    const once = convention.appendPlanConvention("基础提示词");
    assert.strictEqual(convention.appendPlanConvention(once), once);
  });

  await test("A4. 非字符串入参（undefined/null/数字）→ 纯约定不炸", () => {
    for (const value of [undefined, null, 42]) {
      const out = convention.appendPlanConvention(value);
      assert.ok(convention.hasPlanConvention(out), `入参 ${value} 应出纯约定段`);
    }
  });

  await test("A5. 约定语义完整：一轮结束重出块/块外不重复罗列/短任务不输出", () => {
    const text = convention.PLAN_CONVENTION_PROMPT;
    assert.ok(text.includes("重新输出一个完整的 plan 代码块"), "应约定每轮更新整块");
    assert.ok(text.includes("不要重复罗列"), "应约定块外不重复罗列条目");
    assert.ok(text.includes("不需要输出 plan 块"), "应约定短任务不输出");
    assert.ok(text.includes("不写状态符"), "应约定行内不带状态（状态由面板管理）");
  });

  console.log("\n=== B. main.cjs 接线 ===");

  await test("B1. require plan-convention + 云端分支 systemPrompt 挂约定", () => {
    assert.ok(mainSrc.includes('require("./plan-convention.cjs")'), "main.cjs 应 require plan-convention");
    assert.ok(
      mainSrc.includes('appendPlanConvention(modeConfig?.systemPrompt || "")'),
      "云端 systemPrompt 应经 appendPlanConvention（幂等注入）"
    );
    const cloudIndex = mainSrc.indexOf('if (connectionMode === "cloud")');
    const hookIndex = mainSrc.indexOf("appendPlanConvention(modeConfig");
    assert.ok(cloudIndex > -1 && hookIndex > -1 && hookIndex > cloudIndex && hookIndex < cloudIndex + 2000,
      "注入点应落在 cloud 分支内（而非 ssh/local 分支）");
    assert.strictEqual(mainSrc.split("appendPlanConvention(modeConfig").length - 1, 1, "注入点唯一（不重复挂接）");
  });

  console.log("\n=== C. renderer.js 静态接线 ===");

  await test("C1. renderTool 开头分派 TodoWrite → plan 面板（防走通用卡）", () => {
    const body = rendererSrc.slice(rendererSrc.indexOf("function renderTool"), rendererSrc.indexOf("function normalizedToolStatus"));
    const dispatch = body.indexOf("if (isPlanTool(tool))");
    const panelCall = body.indexOf("renderPlanPanel(item, planTodosFromTool(tool), true)");
    const returnIndex = body.indexOf("return;", dispatch);
    const listCreateIndex = body.indexOf("let list = item.querySelector");
    assert.ok(dispatch > -1 && dispatch < 200, "分派应紧跟函数开头");
    assert.ok(panelCall > -1, "结构化路入参（TodoWrite → planTodosFromTool）");
    assert.ok(returnIndex > -1 && listCreateIndex > -1 && returnIndex < listCreateIndex,
      "分派分支应先于通用卡 list 创建 return（plan 不进 tool-list）");
  });

  await test("C2. renderAssistant 抽离 plan 块 → 面板 + 正文剥离", () => {
    const body = rendererSrc.slice(rendererSrc.indexOf("async function renderAssistant"), rendererSrc.indexOf("function renderTool"));
    assert.ok(body.includes("extractPlanBlocks(text)"), "应从 assistant 文本抽离");
    assert.ok(body.includes("if (plan.hasPlan) renderPlanPanel"), "hasPlan 才渲染（AI 没列就零渲染）");
    assert.ok(body.includes('renderPlanPanel(item, plan.last.map((line, i) => ({ index: i + 1, text: line, status: "" })), false)'), "约定路无状态语义");
    // v3.25.0 锚点对齐：renderAssistant 增加 ask_user 约定块处理，正文改为渲染 asks.rest
    // （语义等价——无 ask 块时 asks.rest === plan.rest）
    assert.ok(body.includes("renderMarkdown(asks.rest)"), "正文应渲染剥离后的 rest（plan→asks 链）");
    assert.ok(!body.includes("renderMarkdown(text)"), "不应再渲染原始全文（plan 块不重复显示）");
  });

  await test("C3. finalizeToolList 过滤 TodoWrite（不计入已执行操作数）", () => {
    const body = rendererSrc.slice(rendererSrc.indexOf("function finalizeToolList"), rendererSrc.indexOf("function friendlyToolName"));
    assert.ok(body.includes("const shown = tools.filter((tool) => !isPlanTool(tool))"), "应过滤 plan 工具");
    assert.ok(body.includes("if (!shown.length) return;"), "全 plan 时不出摘要条");
    assert.ok(body.includes("已执行 ${shown.length} 个操作"), "计数用过滤后集合");
  });

  await test("C4. 面板组件关键件齐备（原位更新 / supersede / 折叠 / activeForm / 徽标）", () => {
    assert.ok(rendererSrc.includes("item.__planPanel"), "同消息原位更新应挂面板引用");
    assert.ok(rendererSrc.includes("function supersedeOtherPlanPanels"), "新一轮覆盖上一轮应有 supersede 逻辑");
    assert.ok(rendererSrc.includes('panel.classList.add("superseded", "collapsed")'), "旧面板收成紧凑态可点开回看");
    assert.ok(rendererSrc.includes('panel.classList.toggle("collapsed")'), "折叠交互存在");
    assert.ok(rendererSrc.includes("item.insertBefore(panel, content)"), "面板应插在工具区之下正文之上");
    assert.ok(rendererSrc.includes('entry.status === "in_progress" && entry.activeForm ? entry.activeForm : entry.text'), "进行中优先显示 activeForm");
    assert.ok(rendererSrc.includes("structured ? `${done}/${total}` : `计划 · ${total} 项`"), "结构化进度徽标 + 约定路计划徽标");
  });

  console.log("\n=== D. styles.css 断言 ===");

  await test("D1. 面板主样式（草图形态：左竖线 / 内部滚动上限 / 箭头列）", () => {
    assert.ok(stylesSrc.includes(".plan-panel {"), "面板主样式块存在");
    assert.ok(stylesSrc.includes("border-left: 3px solid var(--accent)"), "草图左侧竖线");
    assert.ok(stylesSrc.includes(".plan-items { max-height: 248px; overflow-y: auto;"), ">8 条内部滚动");
    assert.ok(stylesSrc.includes(".plan-arrow { color: var(--text-plan-arrow); font: 10px/1.5 monospace;"), "|→ 箭头列");
  });

  await test("D2. 折叠/被覆盖态 + 三状态视觉（completed 划线 / in_progress 高亮）", () => {
    assert.ok(stylesSrc.includes(".plan-panel.collapsed .plan-items"), "折叠收起条目区");
    assert.ok(stylesSrc.includes(".plan-panel.superseded { opacity: .58;"), "被新一轮覆盖的旧面板淡化");
    assert.ok(stylesSrc.includes(".plan-item.completed .plan-text"), "completed 样式");
    assert.ok(stylesSrc.includes("text-decoration: line-through"), "完成划线");
    assert.ok(stylesSrc.includes(".plan-item.in_progress .plan-text { color: var(--accent-bright);"), "进行中高亮");
    assert.ok(stylesSrc.includes(".plan-item.convention .plan-text"), "约定路条目样式");
  });

  await test("D3. 亮暗两主题变量齐全（7 个 plan 专属变量）", () => {
    const lightIndex = stylesSrc.indexOf('data-theme="light"');
    for (const variable of ["--bg-plan-panel", "--border-progress", "--bg-progress", "--text-plan-status", "--text-plan-arrow", "--text-plan-index", "--border-draft"]) {
      assert.ok(stylesSrc.slice(0, lightIndex).includes(`${variable}: #`), `${variable} 应在暗色 :root 定义`);
      assert.ok(stylesSrc.slice(lightIndex).includes(`${variable}: #`), `${variable} 应在亮色主题覆盖`);
    }
  });

  console.log("\n=== E. 版本与混淆登记 ===");

  await test("E1. package.json 版本号存在且为 3.x.y 形态（不写死——版本升级后历史测试仍需全绿）", () => {
    assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `version=${pkg.version}`);
  });

  await test("E2. plan-convention.cjs 进混淆清单", () => {
    assert.ok(obfuscateSrc.includes('"main/plan-convention.cjs"'), "新模块应登记混淆");
  });

  // ════════════════ F. renderer 运行时冒烟（vm 假 DOM 真求值） ════════════════
  console.log("\n=== F. renderer 运行时冒烟（vm 假 DOM） ===");
  await runSmokeTests(rendererSrc);

  console.log(`\n━━━ test-v3-20-0 共 ${passed + failed} 项 · 通过 ${passed} · 失败 ${failed} ━━━`);
  if (failed) { console.log(failures.join("\n")); process.exit(1); }
  process.exit(0);
}

async function runSmokeTests(rendererSrc) {
  const vm = require("vm");

  function makeStyle() {
    const store = {};
    return new Proxy(store, {
      get(target, prop) {
        if (prop === "setProperty") return (key, val) => { target[key] = val; };
        if (prop === "removeProperty") return (key) => { delete target[key]; };
        if (prop === "getPropertyValue") return (key) => target[key];
        return target[prop];
      },
      set(target, prop, val) { target[prop] = val; return true; }
    });
  }

  function makeFakeEl() {
    const classes = new Set();
    const children = [];
    const el = {
      value: "", checked: false, type: "", placeholder: "", textContent: "", innerHTML: "",
      hidden: false, disabled: false, className: "", tagName: "DIV", draggable: false,
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
      scrollIntoView() {}, scrollBy() {}, scrollTo() {}, setSelectionRange() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
    return el;
  }

  // 选择器缓存：同一选择器返回同一假元素，便于断言读回
  const cache = new Map();
  const getFake = (sel) => {
    const key = String(sel);
    if (!cache.has(key)) cache.set(key, makeFakeEl());
    return cache.get(key);
  };

  const documentStub = { querySelectorAll: () => [], createElement: null };
  documentStub.querySelector = (sel) => getFake(sel || "#plan-smoke-doc");
  documentStub.querySelectorAll = () => [];
  documentStub.body = getFake("body");
  documentStub.head = getFake("head");
  documentStub.documentElement = getFake("documentElement");
  documentStub.activeElement = null;
  documentStub.getElementById = (id) => getFake(`#${id}`);
  documentStub.createElement = (tag) => { const el = makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; };
  documentStub.createTextNode = (text) => ({ textContent: String(text), children: [] });
  documentStub.addEventListener = () => {};
  documentStub.removeEventListener = () => {};

  // 假 IPC 桥：未知方法一律返回 settings 形状兜底对象（防数据形状误报，只抓未定义标识符类错误）
  const sampleSettings = {
    host: "10.66.1.111", port: 22, username: "demo-user", wakeName: "", clientLabel: "",
    workingDirectory: "/data", dataDirectory: "",
    skipPermissions: false, showSignalLights: true, connectionMode: "ssh", localEngine: "claude",
    hasPassword: true, hasCloudAiConfig: true,
    cloudAiProvider: "zhipu", cloudAiBaseUrl: "https://open.bigmodel.cn/api/paas/v4", cloudAiModel: "glm-4-flash",
    cloudToolsEnabled: true, cloudRunCommandEnabled: false, cloudWorkingDirectory: "",
    proxyEnabled: false, proxyType: "http",
    compactAuto: true, compactThreshold: 80, compactInstruction: "",
    atomcodeHost: "127.0.0.1", atomcodePort: 13456, customCliCommand: "",
    sshProfiles: [
      { id: "ssh-1", name: "主 NAS", host: "10.66.1.111", port: 22, username: "demo-user",
        workingDirectory: "/data", skipPermissions: false, networkType: "internal",
        externalMethod: "auto", hostFingerprint: "SHA256:x", configured: true, hasPassword: true },
      { id: "ssh-2", name: "", host: "", port: 22, username: "",
        workingDirectory: "", skipPermissions: false, networkType: "internal",
        externalMethod: "auto", hostFingerprint: "", configured: false, hasPassword: false }
    ],
    activeSshProfile: "ssh-1",
    advanced: null,
    advancedEffective: {
      adapter: "claude",
      adapterOptions: { model: "", sandbox: "", provider: "" },
      ssh: { requestTimeoutMin: 30, connectTimeoutSec: 15, sftpTimeoutSec: 30, reconnectAttempts: 3, reconnectBaseMs: 600, keepaliveSec: 15, debugLog: false },
      external: { method: "frp", n2n: { cipher: "", compression: "", protocol: "", headerEncryption: false } },
      cloud: { connectTimeoutSec: 120, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 25 }
    }
  };
  const bridge = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return async (payload) => ({
        ...sampleSettings,
        id: payload && payload.id !== undefined ? String(payload.id) : "smoke-id",
        version: "3.20.0",
        path: "",
        ok: true,
        results: [],
        conversations: [],
        items: [],
        messages: [],
        tools: [],
        files: [],
        entries: [],
        valid: true,
        invalidKeys: []
      });
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
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, BigInt,
    Map, Set, WeakMap, WeakSet, Promise, Symbol, Error, TypeError, RangeError,
    SyntaxError, ReferenceError, RegExp, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, structuredClone,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    queueMicrotask, performance, Buffer,
    process: { env: {}, platform: "win32", versions: process.versions },
    window: windowStub, document: documentStub,
    navigator: windowStub.navigator, localStorage: windowStub.localStorage,
    location: windowStub.location, matchMedia: windowStub.matchMedia,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    getComputedStyle: windowStub.getComputedStyle,
    crypto: windowStub.crypto,
    Event: FakeEvent, CustomEvent: FakeEvent, FormData: function FormData() {}, alert() {}, confirm: () => false, prompt: () => null,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}
  };
  for (const key of ["File", "Blob", "Headers", "Request", "Response", "fetch", "Image"]) {
    if (typeof globalThis[key] !== "undefined") sandbox[key] = globalThis[key];
  }
  sandbox.globalThis = sandbox;

  // 尾部挂钩：跨 vm 取不到 let/const 绑定，借闭包把待直调函数暴露出脚本作用域
  const source = rendererSrc
    + "\n;globalThis.__acpSmoke = { extractPlanBlocks, planTodosFromTool, renderPlanPanel, renderTool, finalizeToolList, isPlanTool, normalizePlanItemStatus, supersedeOtherPlanPanels };";

  const hooks = () => sandbox.__acpSmoke;
  const makeItem = () => sandbox.document.createElement("article");

  await test("F1. renderer.js vm 假 DOM 全量求值零异常（含 F5 新函数区）", () => {
    let error = null;
    try {
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox, { filename: "renderer.js" });
    } catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke 挂钩");
    for (const name of ["extractPlanBlocks", "planTodosFromTool", "renderPlanPanel", "renderTool", "finalizeToolList", "isPlanTool", "normalizePlanItemStatus", "supersedeOtherPlanPanels"]) {
      assert.strictEqual(typeof hooks()[name], "function", `${name} 应在挂钩中暴露为函数`);
    }
  });

  await test("F2. extractPlanBlocks：完整块抽离 + 编号剥离 + 无块原样返回", () => {
    let out = hooks().extractPlanBlocks("前言文字\n```plan\n1. 搭好骨架\n2. 写测试\n3. 交付\n```\n后记");
    assert.strictEqual(out.hasPlan, true);
    assert.strictEqual(JSON.stringify(out.last), JSON.stringify(["搭好骨架", "写测试", "交付"]), "编号剥离 + 空行剔除（vm 跨 realm 数组改用 JSON 比较）");
    assert.ok(out.rest.includes("前言文字") && out.rest.includes("后记"), "正文保留");
    assert.ok(!out.rest.includes("```plan"), "正文剥离 plan 块");
    out = hooks().extractPlanBlocks("普通回复，没有计划。");
    assert.strictEqual(out.hasPlan, false);
    assert.strictEqual(out.last, null);
    assert.ok(out.rest.includes("普通回复"), "无块时正文原样");
  });

  await test("F3. extractPlanBlocks：多块取最后一块 + 全部剥离（新一轮覆盖上一轮）", () => {
    const text = [
      "先看初始计划：", "```plan", "1. 旧目标 A", "2. 旧目标 B", "```", "中途叙述。",
      "```plan", "1. 新目标 A", "2. 新目标 B", "3. 新目标 C", "```", "收尾。"
    ].join("\n");
    const out = hooks().extractPlanBlocks(text);
    assert.strictEqual(out.blocks.length, 2, "应抽出两个块");
    assert.strictEqual(JSON.stringify(out.last), JSON.stringify(["新目标 A", "新目标 B", "新目标 C"]), "只取最后一块（跨 realm 用 JSON 比较）");
    assert.ok(!out.rest.includes("旧目标") && !out.rest.includes("新目标"), "正文两个块都剥离");
  });

  await test("F4. extractPlanBlocks：普通/其他语言代码块不受影响 + fence 容错 + 非字符串", () => {
    const out = hooks().extractPlanBlocks("先 ```js\nconst a=1;\n``` 再说话。\n```PLAN\n1. 不该命中（大小写敏感）\n```");
    assert.strictEqual(out.hasPlan, false, "js 块与大写 PLAN 块都不抽离");
    assert.ok(out.rest.includes("```js"), "普通代码块保留");
    assert.strictEqual(JSON.stringify(hooks().extractPlanBlocks("```plan  \n1. 间距容错\n```").last), JSON.stringify(["间距容错"]), "plan 标记行尾空格容错");
    assert.strictEqual(hooks().extractPlanBlocks(undefined).hasPlan, false, "非字符串入参不炸");
    assert.strictEqual(hooks().extractPlanBlocks(null).rest, "");
  });

  await test("F5. planTodosFromTool：对象/JSON 字符串 input、缺条目剔除、连续重编号", () => {
    const h = hooks();
    let todos = h.planTodosFromTool({
      id: "t1", name: "TodoWrite", status: "running",
      input: { todos: [
        { content: "设计面板", status: "completed" },
        { content: "写单测", status: "in_progress", activeForm: "正在写 Agent plan 单测" },
        { content: "构建安装包", status: "pending" }
      ] }
    });
    assert.strictEqual(todos.length, 3);
    assert.deepStrictEqual(todos.map((t) => t.index), [1, 2, 3]);
    assert.strictEqual(todos[1].activeForm, "正在写 Agent plan 单测");
    assert.strictEqual(todos[2].status, "pending");
    todos = h.planTodosFromTool({ name: "TodoWrite", input: JSON.stringify({ todos: [{ content: "目标一" }, { content: "目标二", status: "completed" }] }) });
    assert.strictEqual(todos.length, 2, "JSON 字符串形状容错");
    assert.strictEqual(todos[1].status, "completed");
    todos = h.planTodosFromTool({ name: "TodoWrite", input: { todos: [{ content: "有效目标" }, { content: "" }, {}, "  "] } });
    assert.strictEqual(todos.length, 1, "空条目剔除");
    assert.strictEqual(todos[0].index, 1, "剔除后连续重编号不跳号");
    assert.strictEqual(h.planTodosFromTool({ name: "TodoWrite", input: { todos: [{ content: "x", status: "doing" }] } })[0].status, "pending", "未知 status 归 pending");
    assert.strictEqual(h.planTodosFromTool({ name: "TodoWrite", input: {} }).length, 0);
    assert.strictEqual(h.planTodosFromTool(null).length, 0);
  });

  await test("F6. renderPlanPanel 结构化三状态渲染（面板/条目/徽标/activeForm 文本）", () => {
    const item = makeItem();
    hooks().renderPlanPanel(item, [
      { index: 1, text: "已完成目标", status: "completed" },
      { index: 2, text: "进行中目标", activeForm: "正在干活", status: "in_progress" },
      { index: 3, text: "待开始目标", status: "pending" }
    ], true);
    const panel = item.__planPanel;
    assert.ok(panel, "应创建面板并挂 __planPanel 引用");
    assert.ok(String(panel.className).includes("plan-panel"), "类名 plan-panel");
    const header = panel.children[0];
    assert.ok(header.children[0].textContent.includes("Agent plan"), "标题");
    assert.strictEqual(header.children[1].textContent, "1/3", "完成度徽标 1/3");
    const list = panel.children[1];
    assert.strictEqual(list.children.length, 3);
    const row1 = list.children[0];
    assert.ok(row1.className.includes("plan-item") && row1.className.includes("completed"), "1 行 completed 类");
    assert.strictEqual(row1.children[1].textContent, "1.", "序号");
    assert.strictEqual(row1.children[2].textContent, "已完成目标");
    assert.strictEqual(row1.children[3].textContent, "✓", "完成图标");
    const row2 = list.children[1];
    assert.ok(row2.className.includes("in_progress"), "2 行 in_progress 类");
    assert.strictEqual(row2.children[2].textContent, "正在干活", "进行中优先显示 activeForm");
    assert.strictEqual(row2.children[3].textContent, "●", "进行中图标");
    const row3 = list.children[2];
    assert.ok(row3.className.includes("pending") && row3.children[3].textContent === "○", "3 行 pending");
  });

  await test("F7. renderPlanPanel 原位更新：同消息二次渲染不新建面板且数据取新", () => {
    const item = makeItem();
    hooks().renderPlanPanel(item, hooks().planTodosFromTool({ name: "TodoWrite", input: { todos: [{ content: "目标 A", status: "pending" }, { content: "目标 B", status: "pending" }] } }), true);
    const panelRef = item.__planPanel;
    hooks().renderPlanPanel(item, hooks().planTodosFromTool({ name: "TodoWrite", input: { todos: [{ content: "目标 A", status: "completed" }, { content: "目标 B", status: "in_progress" }, { content: "目标 C", status: "pending" }] } }), true);
    assert.strictEqual(item.__planPanel, panelRef, "同一面板引用（原位更新，非新建堆叠）");
    assert.strictEqual(panelRef.children.length, 2, "面板仍是 header+list 两子节点");
    assert.strictEqual(panelRef.children[0].children[1].textContent, "1/3", "徽标随最新一轮更新");
    assert.strictEqual(panelRef.children[1].children.length, 3, "条目数随最新一轮");
  });

  await test("F8. renderPlanPanel 约定路：convention 类 + 「计划」徽标 + 无状态图标占位", () => {
    const item = makeItem();
    hooks().renderPlanPanel(item, [
      { index: 1, text: "目标一", status: "" },
      { index: 2, text: "目标二", status: "" }
    ], false);
    const panel = item.__planPanel;
    const meta = panel.children[0].children[1];
    assert.ok(String(meta.className).includes("plan-meta-draft"), "约定路徽标类");
    assert.strictEqual(meta.textContent, "计划 · 2 项", "约定路标「计划」而非进度");
    const row = panel.children[1].children[0];
    assert.ok(String(row.className).includes("convention"), "约定路条目类");
    assert.strictEqual(row.children[3].textContent, "·", "无状态语义图标占位");
  });

  await test("F9. renderTool 分派冒烟：TodoWrite 不进通用卡、plan 面板唯一挂入", () => {
    const item1 = makeItem();
    hooks().renderTool(item1, { id: "tu1", name: "TodoWrite", status: "running", input: { todos: [{ content: "目标一", status: "pending" }] } });
    assert.ok(item1.__planPanel, "TodoWrite 应创建 plan 面板");
    assert.strictEqual(item1.children.length, 1, "不经通用工具卡路径（tool-list 未挂入）");
    assert.ok(String(item1.children[0].className).includes("plan-panel"), "面板即唯一挂入节点");
    const item2 = makeItem();
    hooks().renderTool(item2, { id: "b1", name: "Bash", status: "running", input: { command: "ls" } });
    assert.strictEqual(item2.__planPanel, undefined, "普通工具不建 plan 面板");
    // fake 的 querySelector 恒 truthy → renderTool 走「已有 list」分支（真 DOM 语义为新建+prepend）；
    // 语义等价断言：通用卡（.tool-list 缓存对象）收到 tool-card 子节点
    assert.ok(getFake(".tool-list").children.some((c) => String(c.className).includes("tool-card")), "通用工具卡路径生效");
  });

  await test("F10. finalizeToolList 过滤冒烟：TodoWrite 不计入「已执行 N 个操作」", () => {
    const item1 = makeItem();
    hooks().renderTool(item1, { id: "b1", name: "Bash", status: "completed", input: { command: "ls" } });
    hooks().renderTool(item1, { id: "tu1", name: "TodoWrite", status: "completed", input: { todos: [{ content: "计划项", status: "completed" }] } });
    const list = item1.querySelector(".tool-list");
    hooks().finalizeToolList(item1, [
      { id: "b1", name: "Bash", status: "completed", input: { command: "ls" } },
      { id: "tu1", name: "TodoWrite", status: "completed", input: { todos: [{ content: "计划项", status: "completed" }] } }
    ]);
    const summary = list.children.find((child) => String(child.className).includes("tool-summary"));
    assert.ok(summary, "摘要条存在");
    assert.strictEqual(summary.textContent, "✓ 已执行 1 个操作 · 查看详情", "TodoWrite 不计入操作数");
    const item2 = makeItem();
    hooks().finalizeToolList(item2, [{ id: "t", name: "TodoWrite", status: "completed", input: { todos: [] } }]);
    assert.strictEqual(item2.children.length, 0, "全 plan 无 list 时零渲染");
  });

  await test("F11. supersede 冒烟：新一轮面板出现时旧消息面板收成紧凑态、新面板不受牵连", () => {
    const oldItem = makeItem();
    hooks().renderPlanPanel(oldItem, [{ index: 1, text: "旧计划", status: "pending" }], true);
    const oldPanel = oldItem.__planPanel;
    assert.strictEqual(oldPanel.classList.contains("superseded"), false, "首轮创建不受影响");
    // 第二消息渲染时：querySelectorAll 返回旧面板，closest 返回 null（≠ 当前 item）→ 应被标 superseded
    const docRef = sandbox.document;
    const originalQueryAll = docRef.querySelectorAll;
    const originalQuerySel = docRef.querySelector;
    docRef.querySelectorAll = () => [oldPanel];
    docRef.querySelector = () => null;
    let newItem;
    try {
      newItem = docRef.createElement("article");
      hooks().renderPlanPanel(newItem, [{ index: 1, text: "新计划", status: "pending" }], true);
    } finally {
      docRef.querySelectorAll = originalQueryAll;
      docRef.querySelector = originalQuerySel;
      sandbox.document = docRef;
    }
    assert.strictEqual(oldPanel.classList.contains("superseded"), true, "旧面板标 superseded");
    assert.strictEqual(oldPanel.classList.contains("collapsed"), true, "旧面板默认折叠（可点开回看）");
    assert.strictEqual(newItem.__planPanel.classList.contains("superseded"), false, "新面板自身不被误标");
    // 新消息无 .message-content（querySelector=null 分支）也应创建成功
    assert.ok(String(newItem.__planPanel.className).includes("plan-panel"));
  });

  await test("F12. isPlanTool / normalizePlanItemStatus 边界", () => {
    const h = hooks();
    assert.strictEqual(h.isPlanTool({ name: "TodoWrite" }), true);
    assert.strictEqual(h.isPlanTool({ name: "todowrite " }), true, "大小写/空格容错");
    assert.strictEqual(h.isPlanTool({ name: "Bash" }), false);
    assert.strictEqual(h.isPlanTool(null), false);
    assert.strictEqual(h.normalizePlanItemStatus("IN_PROGRESS"), "in_progress");
    assert.strictEqual(h.normalizePlanItemStatus("unknown"), "pending");
    assert.strictEqual(h.normalizePlanItemStatus(undefined), "pending");
  });
}

main().catch((error) => { console.error(error); process.exit(1); });