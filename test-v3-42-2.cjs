"use strict";
/* test-v3-42-2.cjs — v3.42.2 守门：建群对话框云端节点「不显示/无法建群」三断点修复
 *
 * 用户报障（LISA-PC，v3.42.1 后实测）：「保存云端节点后点击工作群，不显示云端节点的选项，
 * 导致无法创建工作群」。根因三断点（渲染层，与 v3.35.6 池规格独立计费红线无关）：
 *   ① pool-cloud-save 保存成功只刷池列表、漏刷工作组勾选框（SSH/本机实例双刷，云端单独漏）
 *   ② tab 切换不重拉——工作组 tab 呈现对话框打开瞬间的旧快照，任何时点保存的节点都不出现
 *   ③ 池空时勾选框区域全空白零引导——用户不知道云端成员要去「Agent 池」页独立入池
 *      （主云端连接与成员池是两套存储：独立计费、密钥不共用，主连接保存≠池里有节点）
 * 附加加固：renderSetupPoolList/renderSetupWgList 读取失败从「静默空白」改显性反白上报。
 *
 * 断言策略：渲染层 DOM 行为依赖 Electron 真窗，本文件做源码形态断言（对照 v3.42.1 C 组先例）
 * + 版本断言；真求值由 test-v3-19-0.cjs（vm 假 DOM 真求值 38 项）+ test-v3-21-2.cjs（TDZ）守门。
 */

const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}`); }
}

const ROOT = __dirname;
const rendererSource = fs.readFileSync(path.join(ROOT, "src/renderer/renderer.js"), "utf8");

console.log("━━━ test-v3-42-2 · v3.42.2 建群对话框云端节点三断点修复守门 ━━━");

console.log("── A 组：renderer.js 源码断言 ──");

// A1 修复①：云端节点保存成功后同步刷工作组勾选框（与 SSH/本机实例同口径双刷新）
{
  const poolCloudSave = rendererSource.slice(
    rendererSource.indexOf('#pool-cloud-save"'),
    rendererSource.indexOf("bindInstanceForm(")
  );
  check("A1a pool-cloud-save handler 含 renderSetupWgList 调用", poolCloudSave.includes("renderSetupWgList()"));
  check("A1b 顺序=先池列表后工作组列表（renderSetupPoolList 在前）",
    poolCloudSave.indexOf("renderSetupPoolList()") !== -1 &&
    poolCloudSave.indexOf("renderSetupPoolList()") < poolCloudSave.indexOf("renderSetupWgList()"));
}

// A2 修复②：tab 切换重拉对应列表（workgroups→renderSetupWgList / pool→renderSetupPoolList）
{
  const tabHandler = rendererSource.slice(
    rendererSource.indexOf('data-group-tab]').forEach,
    rendererSource.indexOf("group-setup-close")
  );
  check("A2a tab=workgroups 时重拉 renderSetupWgList", /tabId === "workgroups"\)\s*void renderSetupWgList\(\)/.test(tabHandler));
  check("A2b tab=pool 时重拉 renderSetupPoolList", /tabId === "pool"\)\s*void renderSetupPoolList\(\)/.test(tabHandler));
}

// A3 修复③：空池勾选框引导（点名 Agent 池页 + 主连接不自动入池 + 独立计费语义）
check("A3a 空池引导文案在场（还没有可勾选的成员）", rendererSource.includes("还没有可勾选的成员"));
check("A3b 引导指向「Agent 池」页添加", rendererSource.includes("还没有可勾选的成员：请切到「Agent 池」页添加节点"));
check("A3c 引导点破两套存储语义（不会自动入池+独立计费）",
  rendererSource.includes("主设置里的云端连接不会自动入池") &&
  rendererSource.includes("独立计费"));
{
  // 引导必须挂在 wg-member-checks 勾选框区（不再是只有工作组列表的既有提示）
  const renderSetupWgList = rendererSource.slice(
    rendererSource.indexOf("async function renderSetupWgList"),
    rendererSource.indexOf("async function createWorkgroupFromForm")
  );
  check("A3d 空池引导落在 renderSetupWgList 的 checks 区（nodes.length===0 分支）",
    renderSetupWgList.includes("checks.append(hint)"));
}

// A4 加固：读取失败的显性上报（两渲染函数 try/catch + 反白文案，禁静默空白）
{
  const renderSetupPoolList = rendererSource.slice(
    rendererSource.indexOf("async function renderSetupPoolList"),
    rendererSource.indexOf("/** 池节点行：")
  );
  check("A4a renderSetupPoolList 读取 try/catch 容错",
    renderSetupPoolList.includes("try {") && renderSetupPoolList.includes("Agent 池读取失败"));
  const renderSetupWgList = rendererSource.slice(
    rendererSource.indexOf("async function renderSetupWgList"),
    rendererSource.indexOf("async function createWorkgroupFromForm")
  );
  check("A4b renderSetupWgList 读取 try/catch 容错",
    renderSetupWgList.includes("try {") && renderSetupWgList.includes("读取失败"));
}

// A5 护栏：修复不得破坏既存语义——工作组列表的空组提示仍由自身渲染（与 A3 空池引导共存）
check("A5 既存空组提示仍在（还没有工作组：勾选成员后创建一个）",
  rendererSource.includes("还没有工作组：勾选成员后创建一个"));

console.log("── B 组：版本断言 ──");
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  check("B1 package.json version ≥ 3.42.2", major > 3 || (major === 3 && minor > 42) || (major === 3 && minor === 42 && patch >= 2));
}
{
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const pkg2 = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  // v3.42.3 起 B2 放宽为「README badge 与 package.json 同步自洽」——不再写死版本号随 bump 翻红（v3.25.0 E1 先例）
  check("B2 README badge 版本与 package.json 一致", readme.includes(`version-${pkg2.version}-blue`));
}

console.log(`━━━ test-v3-42-2 共 ${passed + failed} 项 · 通过 ${passed} · 失败 ${failed} ━━━`);
process.exit(failed ? 1 : 0);
