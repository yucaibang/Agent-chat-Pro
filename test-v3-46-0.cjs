"use strict";

/**
 * v3.46.0 守门：全 UI 动效整包（纯 CSS 轮——renderer.js/index.html 逻辑零改动）
 *
 * 用户令面：所有菜单/弹窗开合、上拉（模式弹窗）/下拉（首部菜单）栏、侧栏与开发面板真伸缩、
 *   内部菜单每一选项 hover/级联过渡。
 * 纯 CSS 双机理（styles.css 动效层段）：
 *   ① display:none 或 [hidden]（UA display:none）隐藏元素「重新显示」=新动画会话→弹层打开自动重播、
 *     关闭保持瞬时（桌面手感）；② dialog showModal=display 切换同机理 → dialog[open] 统一接管。
 * 侧栏/dev 面板真伸缩=display:none 换 margin 滑出（整块平移不出挤压折行，主区跟随展开）。
 * 系统偏好：prefers-reduced-motion 全闸（含既有指示动画一并尊重）。
 *
 * A 组：styles.css 结构完整性行为校验（配平/关键块锚）
 * B 组：动效映射全清单源码锚（弹层八挂载/菜单级联/delay 序列/margin 滑出两行/transition 三容器）
 * C 组：零改动红线锚（renderer.js/index.html 不得含 v3.46.0 触点——纯 CSS 轮的回归边界）
 * C 组：版本滚动锚（45-1 B3 教训：下限+badge 自洽，不硬钉）
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const css = read("src/renderer/styles.css");
const rendererSrc = read("src/renderer/renderer.js");
const htmlSrc = read("src/renderer/index.html");
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

/* ── A 组：结构完整性 ── */
async function runStructureTests() {
  await test("A0. styles.css 花括号配平（CSS 结构健康）", () => {
    const open = (css.match(/\{/g) || []).length, close = (css.match(/\}/g) || []).length;
    assert.strictEqual(open, close, `花括号应配平（实测 ${open}/${close}）`);
    assert.ok(open > 700, `规则块规模应保有存量（实测 ${open}）`);
  });

  await test("A1. 动效层段在册+四组 keyframes 全挂", () => {
    assert.ok(css.includes("v3.46.0 全局动效层"), "动效层段标头应在册");
    assert.ok(css.includes("v3.46.0 动效层结束"), "动效层段闭合标记应在册");
    for (const key of ["acp-pop-in", "acp-slide-in", "acp-fade-in", "acp-dialog-in"]) {
      assert.ok(css.includes(`@keyframes ${key}`), `${key} keyframes 应在册`);
    }
    for (const token of ["--ease-pop", "--dur-pop", "--dur-panel", "--dur-hover"]) {
      assert.ok(css.includes(token), `${token} 动效变量应在册`);
    }
  });

  await test("A2. 机理注释在册（display/hidden 新动画会话 + dialog showModal + reduced-motion 全闸）", () => {
    assert.ok(css.includes("[hidden]（=UA display:none）"), "机理①注释（hidden=新动画会话）应在册");
    assert.ok(css.includes("dialog showModal"), "机理②注释应在册");
    assert.ok(css.includes("prefers-reduced-motion: reduce"), "系统减动效全闸应在册");
    assert.ok(/animation-duration:\s*0s\s*!important/.test(css) && /transition-duration:\s*0s\s*!important/.test(css), "全闸应置零动画与过渡");
  });
}

/* ── B 组：动效映射全清单锚 ── */
async function runMapTests() {
  await test("B1. 弹层八挂载：hidden/display 两系 + @ 成员浮层动态插入", () => {
    assert.ok(css.includes(".workspace-dropdown, #mode-dropdown, .composer-mode-popup, .context-menu,"), "弹层清单第一行应在册");
    assert.ok(css.includes(".model-popover, #think-group-rows, #at-popover"), "弹层清单第二行应在册");
    assert.ok(/{ animation: acp-pop-in/.test(css), "弹层 animation 挂载应在册");
  });

  await test("B2. 首部菜单：open 弹入 + 选项逐项级联（delay 0→98ms 全序列）", () => {
    assert.ok(css.includes(".menu-group.open .menu-dropdown { animation: acp-pop-in"), "菜单弹入应挂载");
    assert.ok(css.includes(".menu-group.open .menu-dropdown > button,"), "选项级联基线应在册");
    for (const idx of [1, 2, 3, 4, 5, 6, 7]) {
      assert.ok(css.includes(`.menu-group.open .menu-dropdown > :nth-child(${idx}) { animation-delay:`), `级联第 ${idx} 项 delay 应在册`);
    }
    assert.ok(css.includes("nth-child(n+8) { animation-delay: 98ms; }"), "级联 8 项外兜底应在册");
  });

  await test("B3. 七弹窗统一入场：dialog[open] + backdrop 淡入", () => {
    assert.ok(css.includes("dialog[open] { animation: acp-dialog-in"), "dialog 入场应挂载");
    assert.ok(css.includes("dialog[open]::backdrop { animation: acp-fade-in"), "backdrop 淡入应挂载");
  });

  await test("B4. 侧栏/dev 面板真伸缩：display:none 已改 margin 滑出 + transition 容器两挂", () => {
    assert.ok(css.includes("body.sidebar-collapsed .sidebar { margin-left: -262px; opacity: 0;"), "侧栏收起应 margin 滑出（不再 display:none）");
    assert.ok(css.includes("body.dev-collapsed .dev-panel { margin-right: -282px; opacity: 0;"), "开发面板收起应 margin 滑出");
    assert.ok(!/body\.sidebar-collapsed \.sidebar \{ display: none;/.test(css), "侧栏旧 display:none 应清零");
    assert.ok(!/body\.dev-collapsed \.dev-panel \{ display: none;/.test(css), "开发面板旧 display:none 应清零");
    assert.ok(css.includes(".sidebar { transition: margin-left"), "侧栏 transition 应挂载");
    assert.ok(css.includes(".dev-panel { transition: margin-right"), "开发面板 transition 应挂载");
  });

  await test("B5. 设置面板切换滑入 + 选项 hover 微位移批挂（translateX(2px) 移位在册）", () => {
    assert.ok(css.includes(".settings-panel.active { animation: acp-slide-in"), "设置面板滑入应挂载");
    assert.ok(css.includes("transform: translateX(2px);"), "选项 hover 微位移应在册");
    assert.ok(css.includes("details > summary,"), "details 摘要 hover 批挂应在册");
  });
}

/* ── C 组：零改动红线 + 版本滚动锚 ── */
async function runGuardTests() {
  await test("C1. 零改动红线：renderer.js/index.html 不含 v3.46.0 触点（纯 CSS 轮）", () => {
    assert.ok(!rendererSrc.includes("v3.46.0"), "renderer.js 不应有 v3.46.0 改动（纯 CSS 轮）");
    assert.ok(!htmlSrc.includes("v3.46.0"), "index.html 不应有 v3.46.0 改动");
  });

  await test("C2. 版本滚动锚：package.json ≥3.46.0 且 README badge 自洽（tests-65）", () => {
    const major = pkg.version.split(".").map(Number);
    assert.ok(major[0] === 3 && (major[1] > 46 || (major[1] === 46 && major[2] >= 0)), `版本应 ≥3.46.0（实际 ${pkg.version}）`);
    assert.ok(readme.includes(`version-${pkg.version}`), "README badge 应与 package.json 版本一致");
    const badgeTests = (readme.match(/tests-(\d+)%20files/) || [])[1];
    assert.ok(badgeTests && Number(badgeTests) >= 65, `README tests badge 应覆盖本轮（≥65 files，实际 ${badgeTests}）`);
  });
}

(async () => {
  console.log("── A 组：结构完整性 ──");
  await runStructureTests();
  console.log("── B 组：动效映射源码锚 ──");
  await runMapTests();
  console.log("── C 组：零改动红线 + 版本 ──");
  await runGuardTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`);
  if (failures.length) {
    console.log("\n失败明细：");
    for (const item of failures) console.log("  - " + item);
    process.exit(1);
  }
})();
