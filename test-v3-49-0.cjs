"use strict";

/**
 * v3.49.0 守门：十项功能更改（用户 2026-11-28 直接指派轮）
 *
 *   ① eco 真实省（用户实测：默认档 vs eco 发问号 token 仅差 15=v3.24.2 零注入旧语义虚假节省实锤）
 *     ——云端 ecoChoiceFor 映射该模型真实最低挡（off/minimal/low/兜底首挡）；anthropic eco→off；
 *      SSH/本机 THINKING_MAP.eco=--thinking-level low（resolveMode 汇聚点一处覆盖四链）
 *   ② 思考程度框缩短 ③ 挡位文案挪轨道上方+meta 居中+英标小写统一
 *   ④ 云端顶行可点快捷切换模型（∧/∨ 箭头+浮层=拉取清单+视觉/文本分组）⑤ 侧栏模式选择块删除
 *     （编辑/导入/导出迁思考面板 manage chips）⑥ 主区顶部文案清理 ⑦ 折叠卡状态色（执行中黄/失败红）
 *   ⑧ 外观颜色板（挪动取色实时应用+亮度+恢复默认+持久化）⑨ 浅色主题滚动条随色（color-scheme light）
 *   ⑩ 启动静默检测新版→侧栏底部红条→点击跳关于页自动检测+自动下载安装
 *
 * A 组行为级（真 require thinking-levels/mode-defaults/mode-manager）
 * B 组源码锚（含测试 mock DOM 兼容防御锚：getContext 缺失不炸启动链——本轮实锤）
 * C 组版本滚动锚（≥ 下限+badge 自洽滚动式——48-1 同款）
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const levels = require(path.join(ROOT, "src/main/thinking-levels.cjs"));
const defaults = require(path.join(ROOT, "src/main/modes/mode-defaults.cjs"));
const managerSrc = read("src/main/modes/mode-manager.cjs");
const modeParamsSrc = read("src/main/modes/mode-params.cjs");
const settingsSrc = read("src/main/settings.cjs");
const mainSrc = read("src/main/main.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const htmlSrc = read("src/renderer/index.html");
const stylesSrc = read("src/renderer/styles.css");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const readme = read("README.md");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((error) => { failed++; failures.push(`${name}: ${error.message}`); console.log(`  ✗ ${name}: ${error.message}`); });
}

/* ═══════════ A 组：eco 真实省行为级 ═══════════ */

async function runEcoTests() {
  await test("A1 THINKING_MAP.eco=--thinking-level low（SSH/本机/群成员四链汇聚点）", () => {
    assert.strictEqual(defaults.THINKING_MAP.eco, "--thinking-level low", "v3.49.0：eco 改真实省强制浅思考");
    assert.strictEqual(defaults.THINKING_MAP.none, "", "none 挡语义不变（不传 flag）");
    assert.ok(modeParamsSrc.includes("THINKING_MAP[mode.thinkingLevel]"), "mode-params 汇聚点在册（一处改全链覆盖）");
    assert.ok(managerSrc.includes('v3.49.0：eco 改真实省'), "mode-manager validateThinkingLevel 注释与新语义同步");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(defaults.BUILTIN_MODES.eco.thinkingLevel)), defaults.BUILTIN_MODES.eco.thinkingLevel, "BUILTIN_MODES.eco 存在");
  });

  await test("A2 ecoChoiceFor 优先级映射（off → minimal → low → 兜底首挡/空串）", () => {
    assert.strictEqual(levels.ecoChoiceFor([{ id: "on" }, { id: "off" }, { id: "low" }]), "off", "off 优先于 low");
    assert.strictEqual(levels.ecoChoiceFor([{ id: "low" }, { id: "high" }]), "low", "无 off/minimal → low");
    assert.strictEqual(levels.ecoChoiceFor([{ id: "on" }, { id: "dynamic" }]), "on", "兜底取首挡");
    assert.strictEqual(levels.ecoChoiceFor([]), "", "空挡位集 → 空串");
    assert.strictEqual(levels.ecoChoiceFor(null), "", "null 安全");
  });

  await test("A3 云端开关系 eco→off=关思考注入（GLM-5 / DeepSeek 真跑）", () => {
    const body = { model: "glm-5", messages: [] };
    assert.strictEqual(levels.applyOpenAiThinking(body, { provider: "zhipu", model: "glm-5", choice: "eco" }), true, "GLM-5 eco 映射注入");
    assert.deepStrictEqual(body.thinking, { type: "disabled" }, "GLM-5 eco=thinking.type=disabled");
    const body2 = { model: "deepseek-chat", messages: [] };
    assert.strictEqual(levels.applyOpenAiThinking(body2, { provider: "deepseek", model: "deepseek-chat", choice: "eco" }), true, "DeepSeek eco 映射注入");
    assert.deepStrictEqual(body2.thinking, { type: "disabled" }, "DeepSeek eco=thinking.type=disabled");
  });

  await test("A4 云端 effort 族 eco→最低 eff 挡（xAI grok-4 → low）", () => {
    const body = { model: "grok-4", messages: [] };
    assert.strictEqual(levels.applyOpenAiThinking(body, { provider: "xai", model: "grok-4", choice: "eco" }), true, "xAI eco 映射注入");
    assert.strictEqual(body.reasoning_effort, "low", "xAI eco=reasoning_effort low（表内无 off→次低挡）");
  });

  await test("A5 Anthropic 原生 eco→off=关扩展思考（零 thinking 字段=真省零开销）", () => {
    const body = { max_tokens: 8192 };
    assert.strictEqual(levels.applyAnthropicThinking(body, { provider: "anthropic", model: "claude-sonnet-4", choice: "eco" }), false, "eco→off 归一（不注入）");
    assert.ok(!("thinking" in body), "请求体零思考字段");
    // 非 eco 挡不受归一污染：low 挡照常注入 budget
    const body2 = { max_tokens: 8192 };
    assert.strictEqual(levels.applyAnthropicThinking(body2, { provider: "anthropic", model: "claude-sonnet-4", choice: "low" }), true, "low 挡常规注入不回退");
    assert.ok(body2.thinking && body2.thinking.budget_tokens === 4096, "low=4096 预算原语义保留");
  });

  await test("A6 非 eco 常规挡零污染（GLM high 照旧注入 enabled+effort）", () => {
    const body = { model: "glm-5", messages: [] };
    assert.strictEqual(levels.applyOpenAiThinking(body, { provider: "zhipu", model: "glm-5", choice: "high" }), true, "high 挡照常注入");
    assert.deepStrictEqual(body.thinking, { type: "enabled" }, "high=enabled");
    assert.strictEqual(body.reasoning_effort, "high", "effort=high 原语义");
  });

  await test("A7 渲染层 eco 文案与主进程同源（SSH hint + 云端前置 hint 双锚）", () => {
    assert.ok(rendererSrc.includes("真实省 token：强制浅思考（--thinking-level low）"), "THINK_SSH_LEVELS.eco hint=真实省");
    assert.ok(rendererSrc.includes('hint: "真实省 token：强制该模型最低思考（关思考或最低挡）"'), "云端前置 eco hint=真实省");
    assert.ok(read("src/main/thinking-levels.cjs").includes("真实省 token：强制浅思考（--thinking-level low）"), "SSH_LEVELS 主进程 hint 同步");
  });
}

/* ═══════════ B 组：源码锚 ═══════════ */

async function runAnchorTests() {
  await test("B1 任务#2/#3 思考面板：挡位文案挪轨道上方 + 轨道缩短 + meta 居中", () => {
    const levelsIdx = stylesSrc.indexOf(".think-levels { position: relative; height: 20px; margin-top: 6px; margin-bottom: 1px; }");
    assert.ok(levelsIdx >= 0, "think-levels 新间距（缩短+上移占位）在册");
    assert.ok(htmlSrc.indexOf("think-levels") > 0, "HTML 文案行走动态渲染（单聊 renderTrackMarks；骨架位=levelsRow 于 track-wrap 之前）");
    assert.ok(rendererSrc.includes("section.append(labelsRow, wrap);"), "群聊 SSH 成员节 labelsRow 上移（轨道前）");
    assert.ok(rendererSrc.includes("section.append(labelsRow, wrap, costRow);"), "群聊云端成员节 labelsRow 上移");
    assert.ok(stylesSrc.includes(".think-meta") && /text-align: center/.test(stylesSrc.slice(stylesSrc.indexOf(".think-meta {"), stylesSrc.indexOf(".think-meta {") + 400)), "think-meta 居中");
    assert.ok(rendererSrc.includes('const WORK_MODE_EN = { automatic: "auto", regular: "high-risk approval", eco: "on-demand approval" };'), "英标小写统一：工作模式");
    assert.ok(rendererSrc.includes('max: "max", on: "" }'), "英标小写统一：挡位 max");
  });

  await test("B2 任务#4 快捷切换模型：箭头+浮层+开关符号（∧ 展开/∨ 缩回）", () => {
    assert.ok(htmlSrc.includes('<button type="button" class="think-model-arrow" id="think-model-arrow" title="切换模型" hidden>∨</button>'), "箭头按钮骨架在册");
    assert.ok(htmlSrc.includes('<div class="think-model-popover" id="think-model-popover" hidden></div>'), "浮层骨架在册");
    assert.ok(rendererSrc.includes('arrowEl.textContent = thinkModelSwitcherOpen ? "∧" : "∨"'), "展开=∧ 缩回=∨（用户给符）");
    assert.ok(rendererSrc.includes("const bindThinkModelSwitcher = (provider, model) => {"), "绑定函数在册（modelEl+箭头双入口）");
    assert.ok(rendererSrc.includes("async function renderThinkModelPopover"), "浮层渲染函数在册");
    assert.ok(rendererSrc.includes("window.agentChatPro.fetchCloudModels"), "模型清单走拉取链（官方 /models 同源）");
  });

  await test("B3 任务#4 分组语义：视觉/文本两组+按官网序+custom 提示+落盘 cloudAiModel", () => {
    assert.ok(rendererSrc.includes("const splitThinkModelGroups = (models) => {"), "分组函数在册");
    assert.ok(rendererSrc.includes('buildGroup("视觉", vision)') && rendererSrc.includes('buildGroup("文本", text)'), "两组标签在册（视觉在上/文本在下）");
    assert.ok(rendererSrc.includes("/vision/i"), "视觉词根正则一");
    assert.ok(rendererSrc.includes("isThinkVisionModel"), "判定函数在册");
    assert.ok(rendererSrc.includes("saveSettings({ ...fresh, cloudAiModel: String(m.value || \"\") })"), "选模保存=cloudAiModel 即生效链");
    assert.ok(rendererSrc.includes("renderThinkModelPopoverSeq"), "浮层独立竞态序号（不劫持面板 stamp）");
  });

  await test("B4 任务#5 侧栏模式块删除：绑定删除+守卫空转+三入口迁移 manage chips", () => {
    assert.ok(!htmlSrc.includes('id="mode-selector"') && !htmlSrc.includes('id="mode-list"') && !htmlSrc.includes('id="mode-edit"'), "HTML 侧栏块整体删除");
    assert.ok(!rendererSrc.includes('document.querySelector("#mode-trigger").addEventListener'), "#mode-trigger 顶层绑定删除（元素已不存在）");
    assert.ok(!rendererSrc.includes('document.querySelector("#mode-edit").addEventListener'), "#mode-edit 顶层绑定删除");
    assert.ok(!rendererSrc.includes('document.querySelector("#mode-import").addEventListener'), "#mode-import 顶层绑定删除");
    assert.ok(!rendererSrc.includes('document.querySelector("#mode-export").addEventListener'), "#mode-export 顶层绑定删除");
    assert.ok(rendererSrc.includes("async function importWorkModes") && rendererSrc.includes("async function exportWorkModes"), "导入/导出抽函数在册");
    assert.ok(rendererSrc.includes('manageChip("编辑"') && rendererSrc.includes('manageChip("导入"') && rendererSrc.includes('manageChip("导出"'), "三 manage chips 在册（思考面板承接）");
    assert.ok(rendererSrc.includes("const list = document.querySelector(\"#mode-list\");\n    if (!list) return;"), "refreshModeSelector null 守卫（仅刷缓存）");
    assert.ok(rendererSrc.includes("classList.add('think-selectable')") || rendererSrc.includes('classList.add("think-selectable")'), "云端顶行可点态");
    assert.ok(rendererSrc.includes('classList.remove("think-selectable")') && rendererSrc.includes('classList.remove("think-selectable");'), "非云端/群聊清理可点态");
  });

  await test("B5 任务#6 主区顶部文案清理：头部三件删除+守卫空转", () => {
    assert.ok(!/<h1/.test(htmlSrc), "h1 文案删除（含注释字面不计——按标签清点）");
    assert.ok(!htmlSrc.includes('id="connection-subtitle"'), "connection-subtitle 删除");
    assert.ok(!htmlSrc.includes('id="chat-mode-badge"'), "chat-mode-badge 删除");
    const guard = rendererSrc.slice(rendererSrc.indexOf("#connection-subtitle") - 200, rendererSrc.indexOf("#connection-subtitle") + 700);
    assert.ok(guard.includes("if (connectionSubtitle)"), "#connection-subtitle 更新代码守卫空转");
    assert.ok(rendererSrc.includes("badge（v3.49.0 任务#6：badge 元素已随头部文案删除——守卫空转）"), "badge 守卫注释在册");
    assert.ok(rendererSrc.includes('id="sidebar-toggle"') || htmlSrc.includes('id="sidebar-toggle"'), "侧栏开关保留");
    assert.ok(htmlSrc.includes('id="header-appearance"'), "外观按钮保留");
  });

  await test("B6 任务#7 折叠卡状态色：执行中黄/失败红/需要授权红（可叠加）", () => {
    assert.ok(rendererSrc.includes('${running ? " running" : ""}${denied ? " needs-permission" : ""}'), "summary 类名组合（running+denied 可叠加）");
    assert.ok(stylesSrc.includes(".tool-card.running .tool-icon { background: #5c4a21; color: #f0d488; }"), "tool-icon 执行中黄");
    assert.ok(stylesSrc.includes(".tool-summary.running { border-color: #6d5a25; background: #2d2712; color: #e9cf8a; }"), "summary 执行中黄");
    assert.ok(stylesSrc.includes(".tool-card.failed .tool-icon { background: #5e342f; color: #f0afa6; }"), "tool-card failed 红（与 needs-permission 同红族）");
    assert.ok(stylesSrc.includes(".tool-summary.needs-permission"), "needs-permission 红保留");
  });

  await test("B7 任务#8 颜色板：骨架四件+取色应用持久化+亮度+恢复默认+启动恢复", () => {
    assert.ok(htmlSrc.includes('id="accent-palette-canvas"') && htmlSrc.includes('id="accent-palette-preview"') && htmlSrc.includes('id="accent-palette-hex"') && htmlSrc.includes('id="accent-brightness-range"') && htmlSrc.includes('id="accent-palette-reset"'), "HTML 骨架五件在册");
    assert.ok(rendererSrc.includes("const hslToHex = (h, s, l) => {") && rendererSrc.includes("const hexToHsl = (hex) => {") && rendererSrc.includes("const brightenAccent = (hex) => {"), "色彩转换三函数在册");
    assert.ok(rendererSrc.includes("const applyAccentColor = (hex)") && rendererSrc.includes("const persistAccent = async ()"), "应用+落盘在册");
    assert.ok(rendererSrc.includes('paletteCanvas.addEventListener("mousemove", pickAccent)'), "挪动=实时取色应用（用户语义）");
    assert.ok(rendererSrc.includes('paletteCanvas.addEventListener("mouseleave", () => persistAccent())'), "离开=以最后停留色落盘");
    assert.ok(rendererSrc.includes('paletteBright.addEventListener("input"'), "亮度滑块重绘");
    assert.ok(rendererSrc.includes('root.style.setProperty("--accent"') && rendererSrc.includes('root.style.setProperty("--accent-bright"'), "全局双变量应用（--accent/--accent-bright）");
    assert.ok(rendererSrc.includes('root.style.removeProperty("--accent"'), "恢复默认=移除行内变量（回落主题默认档）");
    assert.ok(rendererSrc.includes('typeof paletteCanvas.getContext !== "function"'), "mock DOM 兼容防御（本轮实锤：无 getContext 不炸启动链）");
    assert.ok(rendererSrc.includes("accentSettings.accentColor"), "启动恢复读 accentColor");
    assert.ok(stylesSrc.includes("#accent-palette-canvas { flex: 0 0 auto; width: 300px; height: 124px;"), "画布样式在册");
  });

  await test("B8 任务#8 settings.cjs：normalizeAccentColor + get/save 双写", () => {
    assert.ok(/function normalizeAccentColor\(value\) \{[^}]*\[0-9a-f]\{6\}/is.test(settingsSrc) || settingsSrc.includes("#[0-9a-f]{6}") || settingsSrc.includes("#[0-9a-fA-F]{6}"), "normalizeAccentColor 校验在册");
    assert.ok(settingsSrc.includes("accentColor: normalizeAccentColor(raw.accentColor)"), "getSettings 出口盖章");
    assert.ok(settingsSrc.includes("accentColor: input.accentColor !== undefined ? normalizeAccentColor(input.accentColor) : (previous.accentColor || \"\")"), "saveSettings 空串透传+缺省沿用");
  });

  await test("B9 任务#9 浅色滚动条随色：color-scheme light + 自定义滚动条主题变量", () => {
    assert.ok(stylesSrc.includes(':root[data-theme="light"] { color-scheme: light; }'), "浅色 UA 控件随主题（黑滚动条根因修复）");
    assert.ok(stylesSrc.includes("*::-webkit-scrollbar {"), "自定义滚动条在册（全 UA 控件统一）");
    assert.ok(/thumb { background: var\(--border-popover/.test(stylesSrc), "scrollbar-thumb 用主题变量（随强调色/主题变更）");
  });

  await test("B10 任务#10 启动检测：红条+点击跳关于页自动检测+自动下载", () => {
    assert.ok(htmlSrc.includes('<button id="update-toast" type="button" class="update-toast" hidden title="查看并安装新版本"></button>'), "红条按钮骨架在册（security-note 上挪后腾位）");
    assert.ok(htmlSrc.indexOf("security-note") < htmlSrc.indexOf('id="show-settings"'), "小字提醒上挪（更新条空间让位）");
    assert.ok(stylesSrc.includes(".update-toast {"), "红条样式在册");
    assert.ok(stylesSrc.includes("#5c1f1a") || stylesSrc.includes("#742620"), "红条红系配色锚");
    assert.ok(rendererSrc.includes("window.agentChatPro.checkUpdate()"), "检测走既有 IPC 链");
    assert.ok(rendererSrc.includes("}, 4000);"), "启动 4s 静默检测（等 boot/edition 门控）");
    assert.ok(rendererSrc.includes("if (editionState.edition === \"bridge\") return;"), "Bridge Edition 启动检测跳过（版本线不同源）");
    assert.ok(rendererSrc.includes('aboutCheckUpdateButton.click(); // 复用关于页检测体'), "点击红条→复用关于页检测（同一实现）");
    assert.ok(rendererSrc.includes("runAboutUpdateDownload(); // 检测完自动开始更新"), "检测完自动下载安装（用户原话「检测完更新就开始做更新的东西」）");
    assert.ok(rendererSrc.includes("result.remoteVersion"), "红条文案含版本号");
    assert.ok(rendererSrc.includes('🆕 发现新版本 v${result.remoteVersion} · 点击立即更新'), "红条文案在册");
  });

  await test("B11 群聊成员节 labelsRow 上移（SSH+云端两分支与单聊对齐）", () => {
    assert.ok(rendererSrc.includes("section.append(labelsRow, wrap); // v3.49.0 任务#3"), "SSH 成员节顺序（文案在轨道上方）");
    assert.ok(rendererSrc.includes("section.append(labelsRow, wrap, costRow); // v3.49.0 任务#3"), "云端成员节顺序");
    assert.ok(rendererSrc.includes("arrowGroupEl.hidden = true") && rendererSrc.includes("popoverGroupEl.replaceChildren()"), "群聊态模型浮层让位清理");
  });

  await test("B12 测试 mock DOM 兼容（本轮 9 测试 TypeError 实锤防回归）", () => {
    assert.ok(rendererSrc.includes("// v3.49.0 守门兼容：测试套 mock DOM 画布无 2D 上下文（getContext 缺失）——防御返回不炸启动链"), "防御注释在册");
    const iife = rendererSrc.slice(rendererSrc.lastIndexOf("// 启动恢复：读存档强调色"), rendererSrc.indexOf("})();", rendererSrc.lastIndexOf("// 启动恢复")));
    assert.ok(iife.includes("drawAccentPalette();") && iife.includes("try {"), "启动恢复 try 包裹（loadSettings 异常不炸）");
  });

  await test("B13 模型拉取链沿用（main.cjs cloud:fetch-models 密钥兜底/官方端点不动）", () => {
    const cloudModelsSrc = read("src/main/cloud-models.cjs");
    assert.ok(mainSrc.includes("cloud:fetch-models"), "IPC 通道在册");
    assert.ok(mainSrc.includes("fetchProviderModels"), "主链调用在册");
    assert.ok(cloudModelsSrc.includes("PULL_ENDPOINTS"), "官方端点表在册（cloud-models.cjs）");
    assert.ok(rendererSrc.includes("usedFallback"), "拉取失败回退内置清单（usedFallback 标注）");
  });
}

/* ═══════════ C 组：版本滚动锚 ═══════════ */

function badgeOf(text) {
  return (text.match(/tests-(\d+)%20files/) || [])[1];
}

async function runVersionTests() {
  await test("C1. 版本滚动锚：package.json ≥3.49.0 且 README badge 自洽", () => {
    const parts = pkg.version.split(".").map(Number);
    const atLeast = (other) => parts[0] > other[0] || (parts[0] === other[0] && (parts[1] > other[1] || (parts[1] === other[1] && parts[2] >= other[2])));
    assert.ok(atLeast([3, 49, 0]), `版本应 ≥3.49.0（实际 ${pkg.version}）`);
    assert.ok(readme.includes(`version-${pkg.version}`), "README version badge 应与 package.json 一致");
    assert.ok(badgeOf(readme) && Number(badgeOf(readme)) >= 70, `tests badge 应 ≥70（实际 ${badgeOf(readme)}）`);
  });

  await test("C2. 装置自检：守门文件自身在清单（badge=全部 test-*.cjs 件数）", () => {
    const files = fs.readdirSync(ROOT).filter((name) => /^test-.*\.cjs$/.test(name));
    assert.ok(files.includes("test-v3-49-0.cjs"), "本守门应在清单");
    assert.strictEqual(Number(badgeOf(readme)), files.length, `badge 应=守门件数（badge=${badgeOf(readme)} files=${files.length}）`);
  });
}

(async () => {
  console.log("── A 组：eco 真实省行为级 ──");
  await runEcoTests();
  console.log("── B 组：源码锚 ──");
  await runAnchorTests();
  console.log("── C 组：版本滚动锚 ──");
  await runVersionTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`);
  if (failed > 0) {
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exit(1);
  }
})();
