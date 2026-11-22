"use strict";

/**
 * v3.46.1 守门：ACP 启动动画（splash loading）
 *
 * 用户令面：应用启动时的 loading 动画。
 * 实现面（src/main/splash.cjs + main.cjs 接线）：
 *   ── 覆盖式 ── 主窗「创建即显示」形态不动，splash 为无边框透明置顶窗压在主窗上；
 *   ── 关闭链 ── ready-to-show（首帧渲染完成）主挂点 + did-finish-load 兜底 + minShow 700ms
 *     最短在场（不闪一下就撤）+ 10s 兜底强关（异常态不永久遮罩）+ executeJavaScript 注入
 *     淡出 class → destroy（零 IPC 面：无 preload，dino 同款先例）；
 *   ── 零外部资源 ── 动画页整页 data URL 内联（ACP 字标+光晕呼吸+不定进度条，沿 3.46.0
 *     --ease-pop 语法）；obfuscate medium 名单登记（v3.45.4 Bug#2 同型教训）。
 *
 * A 组：vm 假 BrowserWindow+假钟+假计时器真跑 createSplash（创建参数/关闭链路/最短在场/兜底）
 * B 组：main.cjs 接线源码锚 + obfuscate 名单登记 + splash.cjs 结构锚
 * C 组：版本滚动锚（45-1 B3 教训：下限+badge 自洽，不硬钉）
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const splashSrc = read("src/main/splash.cjs");
const mainSrc = read("src/main/main.cjs");
const obfSrc = read("scripts/obfuscate.cjs");
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

/* ── A 组装置：假钟 + 假计时器 + 假 BrowserWindow ─────────────────────────
 * 假钟：控制 Date.now（splash 以时刻差算 minShow 剩余量）。bump=裸推进原语（计时器专用）。
 * 假计时器：dueAt = now + ms，advance 推进假钟并按调度序执行到期未清任务。
 * 假窗：opts/事件注册/loadURL/executeJavaScript 全记录，destroy 置标。
 */
function makeClock() {
  let now = 1_000_000;
  const bump = (ms) => { now += Number(ms || 0); };
  return { now: () => now, bump, advance: bump };
}

function makeTimers(clock) {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, ms) {
      const t = { fn, ms, dueAt: clock.now() + Number(ms || 0), cleared: false, fired: false };
      scheduled.push(t);
      return t;
    },
    clearTimeout(t) { if (t) t.cleared = true; },
    advance(ms) {
      /* 分段推进：clock.bump 裸钟（不得走 clock.advance——会覆盖成联合入口致递归）。
       * 逐「最早触发点」切段，保证 actualClose 等触发于真实时刻、其后继排程
       * （如淡出 destroy 延时）落在正确时点上再被扫出——全量 bump 模型会压实后继任务。 */
      const target = clock.now() + Number(ms || 0);
      let guard = 0;
      while (guard++ < 10000) {
        let minDue = Infinity;
        for (const t of scheduled) if (!t.cleared && !t.fired) minDue = Math.min(minDue, t.dueAt);
        if (minDue === Infinity || minDue > target) break;
        clock.bump(minDue - clock.now());
        for (const t of scheduled) {
          if (!t.cleared && !t.fired && t.dueAt <= minDue) { t.fired = true; t.fn(); }
        }
      }
      clock.bump(target - clock.now());
    }
  };
}

function makeBrowserWindowStub() {
  const wins = [];
  class FakeWin {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.loadURLcalls = [];
      this.alwaysTopCalls = [];
      this.menuCalls = [];
      this.destroyCalls = 0;
      this.destroyed = false;
      this.executeScriptCalls = [];
      this.execJSImpl = (code) => { this.executeScriptCalls.push(code); return Promise.resolve(); };
      this.webContents = { executeJavaScript: (code, flag) => this.execJSImpl(code, flag) };
      wins.push(this);
    }
    on(type, fn) { (this.handlers[String(type)] = this.handlers[String(type)] || []).push(fn); }
    setAlwaysOnTop(...a) { this.alwaysTopCalls.push(a); }
    setMenuBarVisibility(v) { this.menuCalls.push(v); }
    loadURL(u) { this.loadURLcalls.push(u); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyCalls++; this.destroyed = true; }
  }
  return { FakeWin, wins };
}

/* vm 求值 splash.cjs：零依赖模块（无 require），只需注入假钟/假计时器与 module 出口。
 * 装置统一入口：clock.advance 即「推钟 + 执行到期任务」（覆盖 makeClock 裸推进）。 */
function loadSplashModule({ clock, timers } = {}) {
  const clockRef = clock || makeClock();
  const timersRef = timers || makeTimers(clockRef);
  clockRef.advance = (ms) => timersRef.advance(ms);
  const sandbox = {
    module: { exports: {} },
    setTimeout: timersRef.setTimeout,
    clearTimeout: timersRef.clearTimeout,
    Date: { now: () => clockRef.now() }
  };
  vm.createContext(sandbox);
  vm.runInContext(splashSrc, sandbox, { filename: "splash.cjs" });
  return { exports: sandbox.module.exports, clock: clockRef, timers: timersRef };
}

/* ── A 组：行为级真跑 ── */
async function runSplashRuntimeTests() {
  await test("A0. 模块结构锚：五导出 + 阈值常量 + 零 require 零 IPC 面（零依赖自证）", () => {
    const { exports } = loadSplashModule();
    for (const key of ["createSplash", "splashPageHtml", "DEFAULT_MIN_SHOW_MS", "FORCE_CLOSE_MS", "FADE_OUT_MS"]) {
      assert.ok(key in exports, `导出 ${key} 应在册`);
    }
    assert.strictEqual(exports.DEFAULT_MIN_SHOW_MS, 700, "默认最短在场 700ms");
    assert.strictEqual(exports.FORCE_CLOSE_MS, 10000, "兜底强关 10s");
    assert.ok(!/\brequire\s*\(/.test(splashSrc), "splash.cjs 应零依赖（不含 require 调用）");
    assert.ok(!splashSrc.includes("ipcMain") && !splashSrc.includes("ipcRenderer"), "零 IPC 面（无 ipc 引用）");
  });

  await test("A1. 创建参数全锚：覆盖式置顶窗（frameless/透明/skipTaskbar/sandbox/preload:null）+ data URL 页面内容", () => {
    const { exports } = loadSplashModule();
    const { FakeWin, wins } = makeBrowserWindowStub();
    const handle = exports.createSplash({ BrowserWindow: FakeWin, writeLog: () => {} });
    assert.strictEqual(wins.length, 1, "应创建一扇 splash 窗");
    const w = wins[0];
    assert.strictEqual(handle.window, w, "返回句柄应携带窗引用");
    assert.strictEqual(w.opts.width, 1120, "splash 宽应与主窗一致（覆盖观感）");
    assert.strictEqual(w.opts.height, 760, "splash 高应与主窗一致");
    assert.strictEqual(w.opts.frame, false, "无边框");
    assert.strictEqual(w.opts.transparent, true, "透明窗体");
    assert.strictEqual(w.opts.hasShadow, false, "无投影");
    assert.strictEqual(w.opts.resizable, false, "不可调整尺寸");
    assert.strictEqual(w.opts.movable, false, "不可拖动");
    assert.strictEqual(w.opts.center, true, "居中");
    assert.strictEqual(w.opts.skipTaskbar, true, "不占任务栏");
    assert.strictEqual(w.opts.alwaysOnTop, true, "置顶（压主窗之上）");
    const pref = w.opts.webPreferences;
    assert.strictEqual(pref.preload, null, "无 preload（零 IPC 面）");
    assert.strictEqual(pref.sandbox, true, "沙箱开");
    assert.strictEqual(pref.nodeIntegration, false, "无 node 集成");
    assert.strictEqual(vPrefContextIsolation(pref), true, "上下文隔离");
    assert.deepStrictEqual(w.alwaysTopCalls[0], [true, "screen-saver"], "置顶应落到 screen-saver 级");
    assert.deepStrictEqual(w.menuCalls, [false], "菜单栏隐藏");
    // 页面：data URL 内联 + 内容锚
    const url = w.loadURLcalls[0];
    assert.ok(String(url).startsWith("data:text/html;charset=utf-8,"), "页面应走 data URL（零外部资源）");
    const html = decodeURIComponent(String(url).slice("data:text/html;charset=utf-8,".length));
    for (const anchor of [">ACP<", "AGENT CHAT PRO", "正在启动", "@keyframes breathe", "@keyframes run", "@keyframes rise", "cubic-bezier(.16,1,.3,1)", "#0a0e14", "#3fcf8e"]) {
      assert.ok(html.includes(anchor), `页面应含锚 ${anchor}`);
    }
  });

  await test("A2. 关闭链路真跑：minShow 最短在场 + 淡出注入 + 到点 destroy + 兜底计时器随挂", () => {
    const { clock, timers, exports } = loadSplashModule();
    const { FakeWin, wins } = makeBrowserWindowStub();
    const handle = exports.createSplash({ BrowserWindow: FakeWin, writeLog: () => {}, minShowMs: 700 });
    const w = wins[0];
    assert.ok(timers.scheduled.some((t) => !t.cleared && t.ms === 10000), "创建即挂 10s 兜底强关计时器");
    // 100ms 时主窗 ready → close：应等 remaining=600，不立即淡出
    clock.advance(100);
    handle.close();
    assert.strictEqual(w.executeScriptCalls.length, 0, "minShow 未满不应立即淡出");
    clock.advance(599);
    assert.strictEqual(w.executeScriptCalls.length, 0, "差 1ms 仍未到点");
    clock.advance(1); // 700ms 到点 → actualClose
    assert.strictEqual(w.executeScriptCalls.length, 1, "到点应注入淡出 class");
    assert.ok(w.executeScriptCalls[0].includes("classList.add('bye')"), "淡出应为 body.bye 注入");
    assert.strictEqual(w.destroyCalls, 0, "淡出期内未 destroy");
    clock.advance(279); // FADE_OUT_MS+60=280 差 1
    assert.strictEqual(w.destroyed, false, "差 1ms 未 destroy");
    clock.advance(1);
    assert.strictEqual(w.destroyCalls, 1, "淡出后应 destroy");
    // 兜底计时器应被清（actualClose clearTimeout）
    assert.ok(timers.scheduled.every((t) => t.cleared || t.fired), "关闭后兜底计时器应清/已发");
  });

  await test("A3. 双挂点防重排：close 重复调用不叠 setTimeout（closeScheduled 挡）", () => {
    const { clock, timers, exports } = loadSplashModule();
    const { FakeWin, wins } = makeBrowserWindowStub();
    const handle = exports.createSplash({ BrowserWindow: FakeWin, writeLog: () => {}, minShowMs: 700 });
    clock.advance(50);
    handle.close();
    const scheduledAfterFirst = timers.scheduled.length;
    handle.close();
    handle.close();
    assert.strictEqual(timers.scheduled.length, scheduledAfterFirst, "重复 close 不应叠加排程");
    clock.advance(1000);
    const w = wins[0];
    assert.strictEqual(w.executeScriptCalls.length, 1, "淡出注入仅一次");
    assert.strictEqual(w.destroyCalls, 1, "destroy 仅一次");
  });

  await test("A4. 10s 兜底强关真跑：did-finish-load 未达，advance 到点自动走关闭链", () => {
    const clock = makeClock();
    const { exports } = loadSplashModule({ clock, timers: makeTimers(clock) });
    const { FakeWin, wins } = makeBrowserWindowStub();
    const handle = exports.createSplash({ BrowserWindow: FakeWin, writeLog: () => {}, minShowMs: 700 });
    const w = wins[0];
    clock.advance(9999);
    assert.strictEqual(w.executeScriptCalls.length, 0, "未到 10s 不应关");
    clock.advance(1); // 10000ms 到点
    assert.strictEqual(w.executeScriptCalls.length, 1, "兜底应触发淡出注入");
    clock.advance(1000);
    assert.strictEqual(w.destroyed, true, "兜底后应 destroy");
    assert.ok(handle.window.isDestroyed(), "窗销毁态一致");
  });

  await test("A5. 异常鲁棒：executeJavaScript 同步抛 + 窗已 destroy 均不炸关闭链", () => {
    const { clock, exports } = loadSplashModule();
    // 变体一：executeJavaScript 同步 throw
    const { FakeWin, wins } = makeBrowserWindowStub();
    const handle = exports.createSplash({ BrowserWindow: FakeWin, writeLog: () => {}, minShowMs: 0 });
    wins[0].execJSImpl = () => { throw new Error("sandbox exploded"); };
    handle.close();
    clock.advance(1000);
    assert.strictEqual(wins[0].destroyCalls, 1, "同步抛不阻 destroy 关链");
    // 变体二：actualClose 前窗已被destroyed
    const clock2 = makeClock();
    const { exports: exports2 } = loadSplashModule({ clock: clock2, timers: makeTimers(clock2) });
    const stub2 = makeBrowserWindowStub();
    const handle2 = exports2.createSplash({ BrowserWindow: stub2.FakeWin, writeLog: () => {}, minShowMs: 0 });
    handle2.window.destroy();
    clock2.advance(2000);
    handle2.close();
    clock2.advance(500);
    assert.ok(true, "已 destroy 场景全程未抛");
  });

  await test("A6. 无 BrowserWindow 注入返回 null（可测性守卫）+ writeLog 事件双发（opened/closed）", () => {
    const { exports, clock } = loadSplashModule();
    const log = [];
    const stub = makeBrowserWindowStub();
    const handle = exports.createSplash({ BrowserWindow: stub.FakeWin, writeLog: (e) => log.push(e), minShowMs: 0 });
    assert.ok(Array.isArray(log) && log[0] === "splash_opened", "创建时应发 splash_opened");
    clock.advance(100);
    handle.close();
    clock.advance(500);
    assert.ok(log.includes("splash_closed"), "实际关闭时应发 splash_closed");
    assert.strictEqual(exports.createSplash({}), null, "无 BrowserWindow 应返回 null");
  });
}

function vPrefContextIsolation(pref) {
  return pref.contextIsolation === undefined ? true : pref.contextIsolation;
}

/* ── B 组：接线源码锚 ── */
async function runWiringTests() {
  await test("B1. main.cjs 接线：require + splashRef 声明 + createWindow() 前创建", () => {
    assert.ok(mainSrc.includes('const { createSplash } = require("./splash.cjs");'), "splash require 应在册");
    assert.ok(mainSrc.includes("let splashRef = null;"), "splashRef 声明应在册");
    const createLine = mainSrc.indexOf("splashRef = createSplash({ BrowserWindow, writeLog });");
    assert.ok(createLine > -1, "createSplash 接线行应在册");
    const winCallLine = mainSrc.indexOf("  createWindow();", createLine);
    assert.ok(winCallLine > createLine, "createWindow() 应晚于 splash 创建（覆盖式遮罩时序）");
    assert.ok(mainSrc.includes('app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) { splashRef = null; createWindow(); } }),') || mainSrc.includes('app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) { splashRef = null; createWindow(); } });'), "activate 重开应先清 splashRef");
  });

  await test("B2. main.cjs 关闭链：ready-to-show 主挂点 + did-finish-load 兜底点（双 close 同挂）", () => {
    const readyI = mainSrc.indexOf('window.webContents.on("ready-to-show"');
    const finishI = mainSrc.indexOf('window.webContents.on("did-finish-load"');
    assert.ok(readyI > -1, "ready-to-show 主挂点应在册");
    assert.ok(finishI > -1, "did-finish-load 兜底点应在册");
    const readyBlock = mainSrc.slice(readyI, mainSrc.indexOf("}));", readyI) + 4);
    assert.ok(readyBlock.includes("splashRef.close()"), "ready-to-show 应触发 splash 关闭");
    const finishZone = mainSrc.slice(finishI, finishI + 500);
    assert.ok(finishZone.includes("splashRef.close()"), "did-finish-load 应回关 splash");
  });

  await test("B3. obfuscate 名单登记 main/splash.cjs（medium；v3.45.4 Bug#2 同型教训对齐）", () => {
    assert.ok(/"main\/splash\.cjs",\s*\/\/.*v3\.46\.1/.test(obfSrc), "medium 名单应登记 splash.cjs 并带 v3.46.1 注记");
  });

  await test("B4. splash.cjs 结构自锚：覆盖式注释/关闭链注释/兜底注释/data URL 内联", () => {
    assert.ok(splashSrc.includes("覆盖式而非前置阻塞式"), "覆盖式设计注释应在册");
    assert.ok(splashSrc.includes("main/splash.cjs") || splashSrc.includes("v3.46.1"), "版本注记应在册");
    assert.ok(splashSrc.includes("FORCE_CLOSE_MS = 10000"), "10s 兜底常量应在册");
    assert.ok(splashSrc.includes('splash.loadURL("data:text/html;charset=utf-8,"'), "data URL 加载应在册");
    assert.ok(splashSrc.includes("closeScheduled"), "防重排守门变量应在册");
  });
}

/* ── C 组：版本滚动锚 ── */
async function runVersionTests() {
  await test("C1. 版本滚动锚：package.json ≥3.46.1 且 README badge 自洽（tests-66）", () => {
    const major = pkg.version.split(".").map(Number);
    assert.ok(major[0] === 3 && (major[1] > 46 || (major[1] === 46 && major[2] >= 1)), `版本应 ≥3.46.1（实际 ${pkg.version}）`);
    assert.ok(readme.includes(`version-${pkg.version}`), "README badge 应与 package.json 版本一致");
    const badgeTests = (readme.match(/tests-(\d+)%20files/) || [])[1];
    assert.ok(badgeTests && Number(badgeTests) >= 66, `README tests badge 应覆盖本轮（≥66 files，实际 ${badgeTests}）`);
  });

  await test("C2. 零改动红线：renderer.js/index.html 不含 v3.46.1 触点（主进程轮）", () => {
    const rendererSrc = read("src/renderer/renderer.js");
    const htmlSrc = read("src/renderer/index.html");
    assert.ok(!rendererSrc.includes("v3.46.1"), "renderer.js 不应有 v3.46.1 改动（主进程 splash 轮）");
    assert.ok(!htmlSrc.includes("v3.46.1"), "index.html 不应有 v3.46.1 改动");
  });
}

(async () => {
  console.log("── A 组：splash 行为级真跑 ──");
  await runSplashRuntimeTests();
  console.log("── B 组：接线源码锚 ──");
  await runWiringTests();
  console.log("── C 组：版本滚动锚 ──");
  await runVersionTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`);
  if (failures.length) {
    console.log("\n失败明细：");
    for (const item of failures) console.log("  - " + item);
    process.exit(1);
  }
})();
