"use strict";
/**
 * v3.21.4 测试 — 外观设置持久化修复（毛玻璃参数落盘 + 背景透明度语义统一）
 * 背景：渲染层外观面板三组滑杆的提交被 settings.cjs 落盘白名单部分丢弃——
 *   ①frostedBlur/frostedOpacity（毛玻璃模糊/透明度）完全不在白名单 → 拖杆值重启丢失
 *   ②backgroundOpacity 兜底默认 0.15（旧 0-1 比例语义）vs 渲染层 0-100 百分比语义 → 首次安装读到 0.15 ≈ 全透明
 * 修复：settings.cjs 落盘白名单补毛玻璃两字段 + clampAppearanceRange 统一 clamp（滑杆合法域）
 *   + 旧残留（<10 的 0-1 比例值）迁移 + save 链边界值同样过 clamp。
 * 覆盖：settings.cjs 真单测（mock electron 数据写临时目录）+ 渲染层/主进程接线断言 + 版本号 + 滑杆域一致。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const SETTINGS_PATH = path.join(ROOT, "src", "main", "settings.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const PACKAGE_PATH = path.join(ROOT, "package.json");

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

const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
const settingsSource = fs.readFileSync(SETTINGS_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

// ── A 段：settings.cjs 真单测（mock electron，数据写临时目录） ─────────────────
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3214-"));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => workdir, whenReady: async () => {} },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text).toString("base64"),
        decryptString: (buf) => Buffer.from(buf, "base64").toString("utf8")
      }
    };
  }
  return originalLoad.apply(this, arguments);
};
const settings = require(SETTINGS_PATH);
Module._load = originalLoad;

/** 直写 connection.json 原始字段（绕过 sanitize，模拟任意落盘态） */
function writeRawSettings(patch) {
  const file = path.join(workdir, "connection.json");
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  Object.assign(raw, patch);
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}

/** 仅重置文件（模拟全新安装首次读盘；cloud 模式避免 SSH 必填校验拦截——外观字段与连接模式无关） */
function resetRawSettings(raw = { connectionMode: "cloud" }) {
  fs.writeFileSync(path.join(workdir, "connection.json"), JSON.stringify(raw, null, 2));
}

async function runSettingsTests() {
  resetRawSettings();
  await test("A1 毛玻璃字段落盘：saveSettings 提交 40/70 读回 40/70", () => {
    const current = settings.getSettings();
    settings.saveSettings({ ...current, frostedBlur: 40, frostedOpacity: 70 });
    const saved = settings.getSettings();
    assert.strictEqual(saved.frostedBlur, 40, "frostedBlur 应落盘读回 40");
    assert.strictEqual(saved.frostedOpacity, 70, "frostedOpacity 应落盘读回 70");
  });

  await test("A2 首次安装无毛玻璃字段 → 读回默认 20/85（与渲染层滑杆默认一致）", () => {
    resetRawSettings();
    const saved = settings.getSettings();
    assert.strictEqual(saved.frostedBlur, 20, "默认应为 20（与滑杆 value 一致）");
    assert.strictEqual(saved.frostedOpacity, 85, "默认应为 85（与滑杆 value 一致）");
  });

  await test("A3 旧残留迁移：backgroundOpacity=0.15（旧 0-1 比例）读回 100", () => {
    writeRawSettings({ backgroundOpacity: 0.15, backgroundBlur: 0, frostedGlass: true });
    const saved = settings.getSettings();
    assert.strictEqual(saved.backgroundOpacity, 100, "残留 0.15 应迁移为 100");
  });

  await test("A4 clamp 上界：frostedBlur=200→60、backgroundOpacity=500→100", () => {
    writeRawSettings({ frostedBlur: 200, backgroundOpacity: 500, frostedOpacity: 999 });
    const saved = settings.getSettings();
    assert.strictEqual(saved.frostedBlur, 60);
    assert.strictEqual(saved.backgroundOpacity, 100);
    assert.strictEqual(saved.frostedOpacity, 100);
  });

  await test("A5 非法/负值输入回退默认：frostedOpacity=字符串→85、backgroundBlur=-5→0", () => {
    writeRawSettings({ frostedOpacity: "not-a-number", backgroundBlur: -5 });
    const saved = settings.getSettings();
    assert.strictEqual(saved.frostedOpacity, 85);
    assert.strictEqual(saved.backgroundBlur, 0);
  });

  await test("A6 save 链继承：仅提交 backgroundOpacity=50 → previous 毛玻璃值保留", () => {
    const current = settings.getSettings();
    const expectedBlur = current.frostedBlur;
    const expectedFrostedOpacity = current.frostedOpacity;
    settings.saveSettings({ ...current, backgroundOpacity: 50 });
    const saved = settings.getSettings();
    assert.strictEqual(saved.backgroundOpacity, 50);
    assert.strictEqual(saved.frostedBlur, expectedBlur, "未提交的毛玻璃字段应继承 previous");
    assert.strictEqual(saved.frostedOpacity, expectedFrostedOpacity);
  });

  await test("A7 backgroundBlur=0 合法（滑杆允许 0 值不被误兜为 fallback）", () => {
    const current = settings.getSettings();
    settings.saveSettings({ ...current, backgroundBlur: 0, backgroundImage: "data:image/png;base64,x" });
    const saved = settings.getSettings();
    assert.strictEqual(saved.backgroundBlur, 0, "合法 0 值应保留");
  });

  await test("A8 save 链越界输入被 clamp：frostedBlur=200→60、opacity=5→下界回退", () => {
    const current = settings.getSettings();
    settings.saveSettings({ ...current, frostedBlur: 200, frostedOpacity: 5 });
    const saved = settings.getSettings();
    assert.strictEqual(saved.frostedBlur, 60, "save 输入 200 应 clamp 至 60");
    assert.strictEqual(saved.frostedOpacity, 85, "save 输入 5 低于滑杆下界 20 应回退默认 85");
  });

  await test("A9 全链幂等：getSettings 结果原样 saveSettings 再读回不变", () => {
    const current = settings.getSettings();
    settings.saveSettings({ ...current });
    const roundTrip = settings.getSettings();
    assert.strictEqual(roundTrip.frostedBlur, current.frostedBlur);
    assert.strictEqual(roundTrip.frostedOpacity, current.frostedOpacity);
    assert.strictEqual(roundTrip.backgroundOpacity, current.backgroundOpacity);
    assert.strictEqual(roundTrip.backgroundBlur, current.backgroundBlur);
  });
}

// ── B 段：接线断言（渲染层提交字段名与落盘白名单匹配——防再脱节） ─────────────────
async function runWiringTests() {
  await test("B1 渲染层毛玻璃滑杆提交含 frostedBlur/frostedOpacity 且被 settings 白名单收编", () => {
    assert.ok(rendererSrc.includes("frostedBlur: appearanceSettings.frostedBlur"), "渲染层毛玻璃模糊提交缺失");
    assert.ok(rendererSrc.includes("frostedOpacity: appearanceSettings.frostedOpacity"), "渲染层毛玻璃透明度提交缺失");
    assert.ok(settingsSource.includes("frostedBlur: input.frostedBlur !== undefined"), "settings 落盘白名单缺 frostedBlur");
    assert.ok(settingsSource.includes("frostedOpacity: input.frostedOpacity !== undefined"), "settings 落盘白名单缺 frostedOpacity");
  });

  await test("B2 normalize 输出面同时带毛玻璃两字段（渲染层读回链闭合）", () => {
    assert.ok(settingsSource.includes("frostedBlur: clampAppearanceRange(raw.frostedBlur"), "normalize 缺 frostedBlur");
    assert.ok(settingsSource.includes("frostedOpacity: clampAppearanceRange(raw.frostedOpacity"), "normalize 缺 frostedOpacity");
  });

  await test("B3 backgroundOpacity 兜底统一 0-100 百分比语义（0.15 残留兜 100）", () => {
    assert.ok(!settingsSource.includes("backgroundOpacity || 0.15"), "旧 0-1 比例兜底应已移除");
    assert.ok(!settingsSource.includes("backgroundOpacity: 0.15"), "旧 0.15 默认应已移除");
    assert.ok(settingsSource.includes("backgroundOpacity, 10, 100, 100"), "应 clamp 至 10-100 域兜底 100");
  });

  await test("B4 渲染层读回兜底与主进程语义一致（0-100）", () => {
    assert.ok(rendererSrc.includes("Number(settings.backgroundOpacity) || 100"), "渲染层透明度兜底应为 100");
    assert.ok(rendererSrc.includes("Number(settings.frostedBlur) || 20"), "渲染层毛玻璃模糊兜底应为 20");
    assert.ok(rendererSrc.includes("Number(settings.frostedOpacity) || 85"), "渲染层毛玻璃透明度兜底应为 85");
  });

  await test("B5 clampAppearanceRange helper 已存在", () => {
    assert.ok(settingsSource.includes("function clampAppearanceRange"), "helper 缺失");
    assert.strictEqual(typeof settings.getSettings, "function");
    assert.strictEqual(typeof settings.saveSettings, "function");
  });
}

// ── C 段：版本号 + 滑杆域一致 ─────────────────
async function runVersionTests() {
  await test("C1 package.json 版本 = 3.21.4", () => {
    assert.strictEqual(pkg.version, "3.21.4");
  });

  await test("C2 渲染层滑杆 min/max 与 clamp 域一致（4-60 / 20-100 / 0-30 / 10-100）", () => {
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(html.includes('id="frosted-blur-range" min="4" max="60"'), "毛玻璃模糊滑杆域漂移");
    assert.ok(html.includes('id="frosted-opacity-range" min="20" max="100"'), "毛玻璃透明滑杆域漂移");
    assert.ok(html.includes('id="background-blur-range" min="0" max="30"'), "背景模糊滑杆域漂移");
    assert.ok(html.includes('id="background-opacity-range" min="10" max="100"'), "背景透明滑杆域漂移");
  });
}

(async () => {
  await runSettingsTests();
  await runWiringTests();
  await runVersionTests();
  console.log(`\n=== test-v3-21-4.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})();