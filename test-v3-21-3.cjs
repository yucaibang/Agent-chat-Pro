"use strict";
/**
 * v3.21.3 测试 — 云端模式三连修
 *   修复① token 计量漏账：OpenAI 兼容流式缺 stream_options.include_usage + 渲染层只记输出 + 多轮不累计
 *         → 真实账目 = Σ每轮(输入+输出)——跨轮累计器 + cumulative 事件 + 落库 usage
 *   修复② 工具轮分隔线堆叠：emitRoundSeparator 把 markdown `---` 拼进正文（draft/重放全污染）
 *         → 改推 round 专用事件 + 渲染层轮次徽标 + 历史孤立 hr 清洗
 *   修复③ 高级设置「切换为手动」吞改动：manual 按钮用落盘旧值覆盖输入框已改未存值（40→25 现场）
 *         → manual 改为以输入框当前值为准收集（advCloudPatch/advNetworkPatch）
 *
 * ── 测试红线（v3.21.0/1 TDZ 事故教训）──
 * - main.cjs 任何新增「闭包引用静态后置声明」形态禁止：usageTotal 必须声明在 runCloudWithTools
 *   定义之前（B6 位置断言守门，防混淆器语句重排 TDZ 复发——铁律 §9）。
 * - vm.createContext 沙箱不继承 Node 全局：crypto 必须显式注入（历史坑）；
 *   跨 realm 数组断言用 JSON.stringify（v3.20.0 先例）。
 *
 * 段结构：A. cloud-chat 直测（include_usage + accumulateUsage）
 *         B. main.cjs 修复①② 落点断言（含 usageTotal 位置守门）
 *         C. renderer.js vm 假 DOM 冒烟（round 徽标 / cumulative 事件 / strip / manual 收集源）
 *         D. 复跑历史回归
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const ROOT = __dirname;

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; failures.push(`${name}\n    ${error.message}`); console.log(`  ✗ ${name}\n    ${error.message}`); }
}

// ════════════════ A. cloud-chat 直测 ════════════════
async function runCloudChatTests() {
  const cc = require("./src/main/cloud-chat.cjs");

  await test("A1. buildChatBody（OpenAI 兼容）带 stream_options.include_usage——流式端点回传 usage 的开关", () => {
    const body = cc.buildChatBody([{ role: "user", content: "hi" }], { model: "glm-4-flash" });
    assert.strictEqual(body.stream, true);
    assert.ok(body.stream_options && body.stream_options.include_usage === true,
      `stream_options=${JSON.stringify(body.stream_options)}`);
  });

  await test("A2. buildChatBody 保留 tools/temperature 等原有字段（回归性）", () => {
    const body = cc.buildChatBody([{ role: "user", content: "hi" }], { model: "m", tools: [{ type: "function", function: { name: "t" } }], temperature: 0.3 });
    assert.ok(Array.isArray(body.tools) && body.tools.length === 1);
    assert.strictEqual(body.temperature, 0.3);
    assert.ok(body.stream_options.include_usage === true);
  });

  await test("A3. buildAnthropicBody 不受影响（Anthropic 原生 message_delta 自带 usage，无 stream_options 字段）", () => {
    const body = cc.buildAnthropicBody([{ role: "system", content: "s" }, { role: "user", content: "hi" }], { model: "claude-sonnet-4-5" });
    assert.ok(body.stream === true);
    assert.strictEqual(body.stream_options, undefined);
    assert.ok(body.system === "s");
  });

  await test("A4. accumulateUsage：多轮累计 = Σ每轮(输入+输出)——财务口径", () => {
    const total = { prompt: 0, completion: 0, total: 0, requests: 0 };
    assert.strictEqual(cc.accumulateUsage(total, { prompt_tokens: 100000, completion_tokens: 800 }), 100800);
    assert.strictEqual(cc.accumulateUsage(total, { prompt_tokens: 115000, completion_tokens: 1200 }), 116200);
    assert.strictEqual(cc.accumulateUsage(total, { prompt_tokens: 130000, completion_tokens: 900 }), 130900);
    assert.strictEqual(total.prompt, 345000);
    assert.strictEqual(total.completion, 2900);
    assert.strictEqual(total.total, 347900);
    assert.strictEqual(total.requests, 3);
  });

  await test("A5. accumulateUsage：三种字段风格兼容 + 空值守卫（null/零值不推进 requests）", () => {
    const t = { prompt: 0, completion: 0, total: 0, requests: 0 };
    cc.accumulateUsage(t, { input_tokens: 10, output_tokens: 5 });        // Anthropic 归一形态
    cc.accumulateUsage(t, { inputTokens: 10, outputTokens: 5 });          // 驼峰
    cc.accumulateUsage(t, { promptTokens: 10, completionTokens: 5 });     // camel 别名
    assert.strictEqual(t.total, 45);
    assert.strictEqual(t.requests, 3);
    assert.strictEqual(cc.accumulateUsage(t, null), 0);
    assert.strictEqual(cc.accumulateUsage(t, {}), 0);
    assert.strictEqual(cc.accumulateUsage(t, { prompt_tokens: 0, completion_tokens: 0 }), 0);
    assert.strictEqual(t.requests, 3, "空 usage 不应产生虚假请求计数");
  });
}

// ════════════════ B. main.cjs 落点断言 ════════════════
async function runMainTests() {
  const src = fs.readFileSync(path.join(ROOT, "src/main/main.cjs"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  await test("B1. main.cjs 引入 accumulateUsage", () => {
    assert.ok(src.includes("accumulateUsage } = require(\"./cloud-chat.cjs\")"));
  });

  await test("B2. emitRoundSeparator 不再污染正文（无 --- 拼接 streamedText）+ 改推 round 事件", () => {
    const seg = src.slice(src.indexOf("emitRoundSeparator"), src.indexOf("emitRoundSeparator") + 700);
    assert.ok(seg.includes('type: "round"'), "应推 type:round 专用事件");
    assert.ok(!seg.includes("---"), "emitRoundSeparator 块内不应再有 --- 分隔符拼接");
    // 全 main.cjs 不再出现正文注入形态
    assert.ok(!src.includes('streamedText += separator'), "不能把分隔符累计进 streamedText");
  });

  await test("B3. 工具循环：usageTotal 累加 + 轮末推 cumulative usage 事件", () => {
    assert.ok(src.includes("accumulateUsage(usageTotal, result.usage)"), "每轮累加");
    assert.ok(src.includes('type: "usage"') && src.includes("cumulative: true"), "轮末累计事件");
    assert.ok(src.includes("cloud_round_usage"), "累计日志埋点");
  });

  await test("B4. 落库 usage 挂载（取消分支 + 完成分支）", () => {
    assert.ok(src.includes("usageTotal.requests ? { inputTokens: usageTotal.prompt"), "取消分支入账");
    assert.ok(src.match(/addAssistantMessage\([^)]*"cloud",\s*\n?\s*cumulativeUsage[^)]*\)/), "完成分支落库挂累计 usage"); // v3.24.0 起 cumulativeUsage 后还有 thinking 尾参
  });

  await test("B5. settings:save advanced 落盘摘要埋点（真机排障入口）", () => {
    assert.ok(src.includes("settings_advanced_saved"), "埋点事件名");
    assert.ok(src.includes("cloudRounds"));
  });

  await test("B6. ⚠ usageTotal 声明位置守门：必须先于 runCloudWithTools 定义（TDZ 禁形态——铁律 §9）", () => {
    const decl = src.indexOf("const usageTotal = { prompt: 0");
    const runner = src.indexOf("const runCloudWithTools = async () =>");
    assert.ok(decl > 0 && runner > 0, "两处声明都应存在");
    assert.ok(decl < runner, `usageTotal 声明(@${decl})必须先于 runCloudWithTools 定义(@${runner})——闭包体静态后置引用是 v3.21.0 混淆 TDZ 事故形态`);
  });

  await test("B7. 版本 ≥ 3.21.3", () => {
    const rank = pkg.version.split(".").reduce((sum, part) => sum * 1000 + Number(part), 0);
    assert.ok(rank >= 32103, `版本 ${pkg.version} 应 ≥ 3.21.3`);
  });
}

// ════════════════ C. renderer.js vm 假 DOM 冒烟 ════════════════
async function runSmokeTests() {
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
    return {
      value: "", checked: false, type: "", placeholder: "", textContent: "", innerHTML: "",
      hidden: false, disabled: false, className: "", tagName: "DIV", draggable: false,
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
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false, toggleAttribute: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement: () => null, hasChildNodes: () => false,
      append(...nodes) { for (const node of nodes) children.push(node); },
      appendChild(node) { children.push(node); return node; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      closest() { return null; }, contains() { return false; },
      querySelector(sel) { return getFake(sel || "#inner"); },
      querySelectorAll() { return []; },
      focus() {}, blur() {}, click() {}, select() {}, remove() {},
      scrollIntoView() {}, scrollBy() {}, scrollTo() {}, setSelectionRange() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
  }

  const cache = new Map();
  const getFake = (sel) => {
    const key = String(sel);
    if (!cache.has(key)) cache.set(key, makeFakeEl());
    return cache.get(key);
  };

  const documentStub = {
    body: getFake("body"),
    head: getFake("head"),
    documentElement: getFake("documentElement"),
    activeElement: null,
    querySelector: (sel) => getFake(sel),
    querySelectorAll: () => [],
    getElementById: (id) => getFake(`#${id}`),
    createElement: (tag) => { const el = makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    addEventListener() {}, removeEventListener() {}
  };

  const sampleSettings = {
    host: "", port: 22, username: "", wakeName: "", clientLabel: "",
    workingDirectory: "", dataDirectory: "", skipPermissions: false,
    statusSignalCapture: false, showSignalLights: true, connectionMode: "cloud", localEngine: "claude",
    hasPassword: true, hasCloudAiConfig: true,
    cloudAiProvider: "zhipu", cloudAiBaseUrl: "https://open.bigmodel.cn/api/paas/v4", cloudAiModel: "glm-4-flash",
    cloudToolsEnabled: true, cloudRunCommandEnabled: false, cloudWorkingDirectory: "",
    proxyEnabled: false, proxyType: "http",
    compactAuto: true, compactThreshold: 80, compactInstruction: "",
    atomcodeHost: "127.0.0.1", atomcodePort: 13456, customCliCommand: "",
    sshProfiles: [
      { id: "ssh-1", name: "", host: "", port: 22, username: "", workingDirectory: "", skipPermissions: false, networkType: "internal", externalMethod: "auto", hostFingerprint: "", configured: false, hasPassword: false, active: true },
      { id: "ssh-2", name: "", host: "", port: 22, username: "", workingDirectory: "", skipPermissions: false, networkType: "internal", externalMethod: "auto", hostFingerprint: "", configured: false, hasPassword: false, active: false }
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

  const registeredHandlers = {};  // 捕获渲染层经 IPC 桥注册的回调
  const captureProps = {};        // 注册形态监听优先于兜底（get trap 特判 in）
  for (const key of ["onDelta", "onChatEvent", "onContextEvent", "onBridgeForceClosed", "onWorkStatus", "onAgentBridgeQueue", "onAgentBridgeTurn", "onModeEvent", "onNetworkEvent", "onUpdateAvailable", "onUpdateNotFound", "onUpdateError", "onDownloadProgress", "onSettingsSaved", "onThemeChanged", "onEditionChanged", "onSignalLed", "onToolPermissionRequest", "onCompactEvent", "onDraftRecovered", "onBackgroundSaved", "onSshEvent", "onLocalEvent"]) {
    captureProps[key] = (handler) => { registeredHandlers[key] = handler; return undefined; };
  }
  const bridge = new Proxy(captureProps, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop in _target) return _target[prop];
      return async (payload) => ({
        ...sampleSettings,
        id: payload && payload.id !== undefined ? String(payload.id) : "smoke-id",
        version: "3.21.3", path: "", ok: true, results: [], conversations: [], items: [],
        messages: [], tools: [], files: [], entries: [], valid: true, invalidKeys: []
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
    Event: function FakeEvent(type, init) { this.type = String(type || ""); Object.assign(this, init || {}); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
    CustomEvent: function FakeEvent(type, init) { this.type = String(type || ""); Object.assign(this, init || {}); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
    FormData: function FormData() {},
    alert() {}, confirm: () => false, prompt: () => null,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}
  };
  sandbox.globalThis = sandbox;

  const rendererSrc = fs.readFileSync(path.join(ROOT, "src/renderer/renderer.js"), "utf8");
  // 尾部挂钩：待直调函数暴露出脚本作用域（跨 vm 取不到 let/const 绑定，必须借闭包）
  const source = rendererSrc
    + "\n;globalThis.__acpSmoke = { appendRoundMark, stripSeparatorLines, tokensForMessage, advFieldValue, advCloudPatch, advNetworkPatch, populateSettings };";

  await test("C1. renderer.js vm 假 DOM 全量求值零异常", () => {
    let error = null;
    try { vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: "renderer.js" }); }
    catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke 挂钩");
  });

  await test("C2. appendRoundMark：.round-mark 徽标 + 第 N 轮文案 + 容器挂载", () => {
    const answer = getFake("#round-msg");
    sandbox.__acpSmoke.appendRoundMark(answer, 3);
    const mark = answer.children.find((c) => c.className === "round-mark");
    assert.ok(mark, "应插入 .round-mark 子节点");
    assert.ok(mark.textContent.includes("第 3 轮"), `textContent=${mark.textContent}`);
    sandbox.__acpSmoke.appendRoundMark(answer, 0);  // 容错：非法 round 回退 1
    const all = answer.children.filter((c) => c.className === "round-mark");
    assert.ok(all.at(-1).textContent.includes("第 1 轮"), "非法轮次回退第 1 轮");
  });

  await test("C3. stripSeparatorLines：剥孤立 --- 行，正文与内容行保留", () => {
    const dirty = "分析完成\n\n---\n\n下一步开始处理\n\n---\n\n结论已经得出：";
    const clean = sandbox.__acpSmoke.stripSeparatorLines(dirty);
    assert.ok(!/[ \t]*-{3,}/.test(clean), "不应残留孤立分隔线");
    assert.ok(clean.includes("分析完成") && clean.includes("下一步开始处理") && clean.includes("结论已经得出："), "正文全保留");
    assert.strictEqual(sandbox.__acpSmoke.stripSeparatorLines(""), "");
    // 正文行内短横线不误伤
    assert.ok(sandbox.__acpSmoke.stripSeparatorLines("state---machine").includes("state---machine"));
  });

  await test("C4. usage cumulative 事件：真实账目替换确认值（confirmedTokens 直落 #token-count）", async () => {
    const handler = registeredHandlers.onChatEvent;
    assert.ok(typeof handler === "function", "onChatEvent handler 应在求值时注册到桥");
    await handler({ id: "smoke-id", type: "usage", usage: { inputTokens: 345000, outputTokens: 2900, totalTokens: 347900, cumulative: true, requests: 3 } });
    const count = getFake("#token-count").textContent;
    assert.ok(count.replace(/,/g, "") === "347900", `#token-count=${count} 应为真实累计 347,900`);
    // 同一流内先到的估算 streamingTokens 已被清零（cumulative 权威替换）
    // 非累计（轮内实时）事件维持旧口径：只记本轮输出
    await handler({ id: "smoke-id", type: "usage", usage: { prompt_tokens: 100000, completion_tokens: 500 } });
    const fallback = getFake("#token-count").textContent.replace(/,/g, "");
    assert.ok(fallback === "500", `轮内实时事件应只记输出 500，实际 ${fallback}`);
  });

  await test("C5. tokensForMessage：云端累计消息用真实账目、其余回退估算", () => {
    assert.strictEqual(
      sandbox.__acpSmoke.tokensForMessage({ usage: { cumulative: true, totalTokens: 347900 }, text: "正文" }),
      347900);
    assert.ok(sandbox.__acpSmoke.tokensForMessage({ text: "hello world" }) > 0, "无 usage 回退估算");
    assert.strictEqual(sandbox.__acpSmoke.tokensForMessage({ usage: { inputTokens: 99 }, text: "" }), 0, "非 cumulative usage 不进重算（SSH 口径不动）");
  });

  await test("C6. manual 按钮收集源断言：以输入框当前值为准（不再引用 effective 覆盖）", () => {
    assert.ok(!/adv-cloud-manual.+?effective\.cloud/s.test(rendererSrc), "云端 manual 不应用 effective.cloud 覆盖（吞改动根因）");
    assert.ok(!/adv-network-manual[\s\S]*?effective\.ssh[\s\S]*?adv-network-auto/.test(rendererSrc.slice(0, rendererSrc.indexOf("adv-network-auto") + 60)), "网络 manual 不应用 effective 覆盖");
    // 两个 manual handler 都走输入框收集函数
    const cloudSeg = rendererSrc.slice(rendererSrc.indexOf('"#adv-cloud-manual"') || rendererSrc.indexOf("#adv-cloud-manual"), rendererSrc.indexOf("#adv-cloud-auto"));
    assert.ok(cloudSeg.includes("advCloudPatch()"), "云端 manual 应收集 advCloudPatch()");
    const netSeg = rendererSrc.slice(rendererSrc.indexOf("#adv-network-manual"), rendererSrc.indexOf("#adv-network-save"));
    assert.ok(netSeg.includes("advNetworkPatch()"), "网络 manual 应收集 advNetworkPatch()");
  });

  await test("C7. advCloudPatch 空框 fallback 与填值读取（advFieldValue 行为）", () => {
    const patch = sandbox.__acpSmoke.advCloudPatch();
    assert.deepStrictEqual(
      JSON.stringify(Object.keys(patch.cloud).sort()),
      JSON.stringify(["connectTimeoutSec", "maxRetries", "maxToolRounds", "streamIdleTimeoutSec"]));
    // 空 DOM（默认 fallback）→ 四字段全合法，40 填入后读 40
    getFake("#adv-cloud-tool-rounds").value = "40";
    const patch40 = sandbox.__acpSmoke.advCloudPatch();
    assert.strictEqual(patch40.cloud.maxToolRounds, 40, "用户改 40 后收集应得 40");
  });
}

// ════════════════ D. 复跑历史回归 ════════════════
async function runRegression() {
  const { execFileSync } = require("child_process");
  for (const t of ["test-v3-21-2.cjs", "test-v3-21-0.cjs", "test-v3-20-0.cjs", "test-v3-19-0.cjs", "test-v3-18-0.cjs", "test-v3-17-0.cjs"]) {
    await test(`D. ${t} 复跑全绿`, () => {
      execFileSync(process.execPath, [path.join(ROOT, t)], { stdio: "pipe", timeout: 120000 });
    });
  }
}

(async () => {
  console.log("=== v3.21.3 云端模式三连修测试 ===");
  console.log("── A. cloud-chat：include_usage + accumulateUsage ──"); await runCloudChatTests();
  console.log("── B. main.cjs 落点断言 ──"); await runMainTests();
  console.log("── C. renderer vm 假 DOM 冒烟 ──"); await runSmokeTests();
  console.log("── D. 历史回归 ──"); await runRegression();
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed) { console.log(failures.join("\n")); process.exit(1); }
  process.exit(0);
})();