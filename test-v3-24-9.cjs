"use strict";
/**
 * v3.24.9 测试 — 「云端 AI 干活到一半莫名停止、没有任何提示」修复
 *   根因①：max_tokens=4096 硬编码（免费档常被截断）+ 工具循环不检查 stopReason——
 *     半截文本静默当「正常完成」落库，UI 零提示。现改为自动续写（上限 3 段）+ 可见徽标。
 *   根因②：cloud-chat close 分支把「收到过一点数据的断流」静默按「正常完成」resolve（旧注释自陈）。
 *     现引入 sawFinish 收尾标记（finish_reason/message_stop/[DONE]），end/close 双分支无标记断流→报错。
 *   配套：高级设置新增 cloud.maxTokens（4096~32000 默认 8192，三处同步：
 *     settings ADVANCED_DEFAULTS/ADVANCED_CLAMPS + main requestOnce 三级链 + UI 输入框）；
 *     data handler 重置 timer 硬编码 300000 → streamIdleTimeoutMs（高级设置改短后真正生效）。
 * 覆盖：isTruncatedStopReason 真测 + cloud-chat 截断/断流结构切片 + main 续写接线切片 +
 *       settings 钳制真测（新字段）+ 渲染层 mark 徽标接线 + UI/样式 + 版本锚。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const cloudSrc = read("src/main/cloud-chat.cjs");
const mainSrc = read("src/main/main.cjs");
const settingsSrc = read("src/main/settings.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const htmlSrc = read("src/renderer/index.html");
const cssSrc = read("src/renderer/styles.css");
const pkg = JSON.parse(read("package.json"));
const cloudModule = require("./src/main/cloud-chat.cjs");
const settingsModule = require("./src/main/settings.cjs");

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

/* ── A 组：截断判定纯函数 + cloud-chat 断流/收尾结构 ── */

async function runAGroup() {
  console.log("── A 组：isTruncatedStopReason 真测 + cloud-chat 截断/断流结构切片 ──");

  await test("A1 isTruncatedStopReason：各端点截断写法全命中", () => {
    const fn = cloudModule.isTruncatedStopReason;
    assert.ok(typeof fn === "function", "cloud-chat.cjs 应导出 isTruncatedStopReason");
    assert.strictEqual(fn("max_tokens"), true, "OpenAI 系主形态");
    assert.strictEqual(fn("length"), true, "OpenAI 系变体");
    assert.strictEqual(fn("MAX_OUTPUTTOKENS".replace("_", "")), true, "大小写不敏感（驼峰归一）");
    assert.strictEqual(fn("MaxOutputTokens"), true, "大小写不敏感变体");
    assert.strictEqual(fn("token_limit"), true, "中转站变体");
    assert.strictEqual(fn("max_tokens_reached"), true, "部分 Anthropic 中转变体");
  });

  await test("A2 非截断 stop_reason 一律不命中（stop/null/空/工具流/未知值）", () => {
    const fn = cloudModule.isTruncatedStopReason;
    assert.strictEqual(fn("stop"), false, "正常结束 stop");
    assert.strictEqual(fn("end_turn"), false, "Anthropic 正常结束");
    assert.strictEqual(fn("tool_use"), false, "Anthropic 工具流");
    assert.strictEqual(fn("function_call"), false, "OpenAI 工具流");
    assert.strictEqual(fn("content_filter"), false, "内容过滤非截断（不续写，如实中止）");
    assert.strictEqual(fn(""), false); assert.strictEqual(fn(null), false); assert.strictEqual(fn(undefined), false);
  });

  await test("A3 sawFinish 收尾标记存在且四处赋值点全部接线", () => {
    assert.ok(cloudSrc.includes("let sawFinish = false"), "应声明收尾标记");
    const markAnthropic = cloudSrc.match(/if \(result\.stopReason\) \{ stopReason = result\.stopReason; sawFinish = true; \}/g) || [];
    assert.strictEqual(markAnthropic.length, 2, "Anthropic 侧 data+end 两处赋值点");
    const markOpenAi = cloudSrc.match(/if \(choice\?\.finish_reason\) \{ stopReason = choice\.finish_reason; sawFinish = true; \}/g) || [];
    assert.strictEqual(markOpenAi.length, 2, "OpenAI 侧 data+end 两处赋值点");
    const done = cloudSrc.match(/"\[DONE\]"\) \{ sawFinish = true; continue; \}/g) || [];
    assert.strictEqual(done.length, 1, "data handler [DONE] 标记");
    assert.ok(cloudSrc.includes('if (data === "[DONE]") sawFinish = true;'), "end 残留处理 [DONE] 标记（不规范端点不发 finish_reason 也算正常收尾）");
  });

  await test("A4 end 分支：无收尾标记+有内容 → 报错（不再静默按完成落库）", () => {
    assert.ok(cloudSrc.includes("cloud_chat_ended_broken"), "应打断流日志");
    assert.ok(cloudSrc.includes("云端 AI 响应被服务商提前结束"), "断流报错文案");
    assert.ok(cloudSrc.includes("未收到正常收尾标记"), "文案应说明原因（收尾标记缺失）");
    assert.ok(cloudSrc.includes("endedCleanly: true"), "正常结束应携带 endedCleanly");
  });

  await test("A5 close 分支：无收尾标记+有内容 → 断流报错（旧版静默 resolve 当完成）", () => {
    assert.ok(cloudSrc.includes("cloud_chat_close_abrupt"), "应打 close 断流日志");
    const block = cloudSrc.slice(cloudSrc.indexOf('res.on("close"'));
    const order = [
      block.indexOf("!sawFinish && fullText.length > 0"),
      block.indexOf("cloud_chat_close_abrupt"),
      block.indexOf("cloud_chat_close_with_data"),
      block.indexOf("云端 AI 连接意外关闭")
    ];
    assert.ok(order.every((i) => i > -1), "close 分支四处应齐");
    assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3], "断流分支应排在正常收尾分支之前");
  });

  await test("A6 兜底 8192：buildAnthropicBody/buildChatBody 两处不再硬编码 4096", () => {
    const hits = (cloudSrc.match(/max_tokens: options\.maxTokens \|\| 8192,/g) || []).length;
    assert.strictEqual(hits, 2, "两处兜底应为 8192");
    assert.ok(!cloudSrc.includes("options.maxTokens || 4096"), "4096 硬编码应绝迹");
  });

  await test("A7 data handler 重置 timer 用可配空闲秒数（旧版硬编码 300000）", () => {
    const start = cloudSrc.indexOf("收到数据，重置响应超时");
    const dataBlock = cloudSrc.slice(start, cloudSrc.indexOf('res.on("end"', start));
    assert.ok(dataBlock.includes("}, streamIdleTimeoutMs);"), "重置 timer 应回可配值");
    assert.ok(!dataBlock.includes("300000"), "data handler 不应再有硬编码 300000");
    assert.ok(dataBlock.includes("秒未收到数据"), "文案应带实际生效秒数");
  });
}

/* ── B 组：main.cjs 续写接线 ── */

async function runBGroup() {
  console.log("── B 组：main.cjs 截断自动续写接线 ──");

  await test("B1 require 接线：isTruncatedStopReason 已解构", () => {
    assert.ok(mainSrc.includes("accumulateUsage, isTruncatedStopReason } = require(\"./cloud-chat.cjs\")"), "require 应解构 isTruncatedStopReason");
  });

  await test("B2 maxTokens 三级链（模式 → 服务商 → 设置中心 → 兜底 8192）", () => {
    assert.ok(mainSrc.includes("modeConfig?.maxTokens || cloudConfig.maxTokens"), "前两级链保留");
    assert.ok(mainSrc.includes("cloudConfig.advancedEffective?.cloud?.maxTokens"), "第三级：设置中心高级设置");
    assert.ok(mainSrc.includes("|| 8192,"), "兜底 8192");
    assert.ok(!mainSrc.includes("cloudConfig.maxTokens || 4096"), "main.cjs 不应再有 4096 硬编码链");
  });

  await test("B3 续写块：判定→计数→徽标→续写消息→continue，全部接线", () => {
    assert.ok(mainSrc.includes("isTruncatedStopReason(result.stopReason)"), "循环内应判定截断");
    assert.ok(mainSrc.includes("let autoContinues = 0"), "续写计数应声明");
    assert.ok(mainSrc.includes("autoContinues < 3"), "续写上限 3 段（防雪崩）");
    assert.ok(mainSrc.includes("cloud_auto_continue"), "续写应打日志");
    assert.ok(mainSrc.includes("✂ 输出被截断（服务商输出上限），已自动续写（第"), "流内续写徽标文案");
    assert.ok(mainSrc.includes("请从中断处续写，不要重复已输出的内容"), "续写 user 消息文案");
    assert.ok(mainSrc.includes("已自动续写 3 段仍被截断，停止续写"), "上限提示文案（不再静默）");
    assert.ok(mainSrc.includes("建议拆小任务，或在设置中心"), "上限提示应指引调配置");
  });

  await test("B4 续写块位置：在 cancelled return 之后、toolCalls 读取之前（截断轮不执行残缺工具）", () => {
    const loopSrc = mainSrc.slice(mainSrc.indexOf("for (let round = 0; round <= maxToolRounds;"), mainSrc.indexOf("工具执行轮数已达上限"));
    const cancelledIdx = loopSrc.indexOf("if (result.cancelled) return");
    const continueIdx = loopSrc.indexOf("isTruncatedStopReason(result.stopReason)");
    const toolCallsIdx = loopSrc.indexOf("const toolCalls = toolsEnabled");
    assert.ok(cancelledIdx > -1 && continueIdx > -1 && toolCallsIdx > -1, "三处应都在循环体内");
    assert.ok(cancelledIdx < continueIdx && continueIdx < toolCallsIdx, "顺序应为 cancelled → 截断续写 → toolCalls");
    const continueBlock = loopSrc.slice(continueIdx, toolCallsIdx);
    assert.ok(continueBlock.includes("continue;"), "截断轮应 continue 跳过工具执行");
  });
}

/* ── C 组：settings 新字段钳制 ── */

const advancedFns = new Function(
  settingsSrc.slice(settingsSrc.indexOf("const ADVANCED_ADAPTERS"), settingsSrc.indexOf("/** 合并实值")) +
  "\nreturn { ADVANCED_DEFAULTS, ADVANCED_CLAMPS, sanitizeAdvanced, sanitizeAdvancedNumericGroup, sanitizeSshAdvanced };"
)();

async function runCGroup() {
  console.log("── C 组：settings ADVANCED maxTokens 钳制真测 ──");

  await test("C1 默认值与钳制表：maxTokens 8192 / [4096, 32000]", () => {
    assert.strictEqual(advancedFns.ADVANCED_DEFAULTS.cloud.maxTokens, 8192, "默认应为 8192");
    assert.deepStrictEqual(advancedFns.ADVANCED_CLAMPS.cloud.maxTokens, [4096, 32000], "钳制区间 [4096,32000]");
  });

  await test("C2 合法值原样保留；超界钳两端；缺失/非整数补默认 8192", () => {
    const clamps = advancedFns.ADVANCED_CLAMPS.cloud;
    const defaults = advancedFns.ADVANCED_DEFAULTS.cloud;
    const ok = advancedFns.sanitizeAdvancedNumericGroup({ connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30, maxTokens: 16384 }, clamps, defaults);
    assert.strictEqual(ok.maxTokens, 16384, "合法值保留");
    const hi = advancedFns.sanitizeAdvancedNumericGroup({ maxTokens: 99999 }, clamps, defaults);
    assert.strictEqual(hi.maxTokens, 32000, "超上界钳 32000");
    const lo = advancedFns.sanitizeAdvancedNumericGroup({ maxTokens: 1000 }, clamps, defaults);
    assert.strictEqual(lo.maxTokens, 4096, "越下界钳 4096");
    const bad = advancedFns.sanitizeAdvancedNumericGroup({ connectTimeoutSec: 120, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 25, maxTokens: "abc" }, clamps, defaults);
    assert.strictEqual(bad.maxTokens, 8192, "非整数补默认 8192");
  });

  await test("C3 整组合法全落（五字段含 maxTokens 一并保留，组保持手动）", () => {
    const out = advancedFns.sanitizeAdvancedNumericGroup(
      { connectTimeoutSec: 120, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 25, maxTokens: 8192 },
      advancedFns.ADVANCED_CLAMPS.cloud, advancedFns.ADVANCED_DEFAULTS.cloud
    );
    assert.deepStrictEqual(out, { connectTimeoutSec: 120, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 25, maxTokens: 8192 }, "五字段全等");
  });

  await test("C4 settings.cjs 导出层：advancedEffective 云端组展开含 maxTokens（null 分组展开默认值表）", () => {
    const eff = settingsModule.buildEffectiveSettings ? settingsModule.buildEffectiveSettings({ advanced: null }) : null;
    if (eff && eff.advancedEffective?.cloud) {
      assert.strictEqual(eff.advancedEffective.cloud.maxTokens, 8192, "自动识别应展开默认 8192");
    } else {
      assert.ok(settingsSrc.includes("maxTokens: 8192"), "默认值表应存在 maxTokens 展开源");
    }
  });
}

/* ── D 组：渲染层 mark 徽标 + 设置面板 ── */

async function runDGroup() {
  console.log("── D 组：渲染层续写徽标接线 + 云端设置面板 ──");

  await test("D1 appendRoundMark：mark 第三参 + 自定义文案 + notice 样式类", () => {
    assert.ok(rendererSrc.includes("function appendRoundMark(answer, round, mark)"), "函数签名应有 mark 参");
    assert.ok(rendererSrc.includes("mark ? String(mark) :"), "mark 有值走自定义文案");
    assert.ok(rendererSrc.includes('className = "round-mark" + (mark ? " round-mark--notice" : "")'), "notice 样式类接线");
  });

  await test("D2 round 事件透传 event.mark（主进程续写徽标可见）", () => {
    assert.ok(rendererSrc.includes("appendRoundMark(answer, event.round, event.mark)"), "事件处理应透传 mark");
    assert.ok(rendererSrc.includes("续写提示徽标"), "应有 v3.24.9 注释锚");
  });

  await test("D3 设置中心高级设置读写链：采集/回填/字段名标签", () => {
    assert.ok(rendererSrc.includes('advFieldValue("#adv-cloud-max-tokens", 8192)'), "采集接线");
    assert.ok(rendererSrc.includes('document.querySelector("#adv-cloud-max-tokens").value = advanced.cloud?.maxTokens ?? effCloud.maxTokens ?? 8192'), "回填接线");
    assert.ok(rendererSrc.includes('maxTokens: "输出上限 tokens"'), "ADV_FIELD_LABELS 应含新字段（钳制提示联动）");
  });

  await test("D4 index.html：输出上限 tokens 输入框（4096~32000）+ 提示文案更新", () => {
    assert.ok(htmlSrc.includes('id="adv-cloud-max-tokens"'), "输入框应存在");
    assert.ok(htmlSrc.includes('id="adv-cloud-max-tokens" min="4096" max="32000"'), "输入框边界应与钳制表一致");
    assert.ok(htmlSrc.includes("输出上限 tokens"), "字段标签");
    assert.ok(htmlSrc.includes("截断后会自动续写、最多 3 段"), "field-hint 应说明自动续写行为");
  });

  await test("D5 styles.css：round-mark--notice 变体（琥珀色区分常规轮次徽标）", () => {
    assert.ok(cssSrc.includes(".round-mark--notice"), "变体类应存在");
    assert.ok(cssSrc.includes('[data-theme="light"] .round-mark--notice'), "浅色主题适配");
  });
}

/* ── E 组：版本锚 ── */

async function runEGroup() {
  console.log("── E 组：版本锚 ──");

  // v3.25.0 锚点对齐：版本不断演进，断言放宽为「≥ 3.24.9」（test-v3-24-4 G1 同款语义），不再写死
  await test("E1 package.json 版本 ≥ 3.24.9", () => {
    const [rmaj, rmin, rpatch] = "3.24.9".split(".").map(Number);
    const [maj, min, patch] = pkg.version.split(".").map(Number);
    assert.ok(
      maj > rmaj || (maj === rmaj && (min > rmin || (min === rmin && patch >= rpatch))),
      `pkg.version ${pkg.version} 应 ≥ 3.24.9`
    );
  });

  await test("E2 版本注释锚：cloud-chat/main/settings 三文件 v3.24.9 注释齐", () => {
    assert.ok(cloudSrc.includes("v3.24.9"), "cloud-chat 注释锚");
    assert.ok(mainSrc.includes("v3.24.9"), "main.cjs 注释锚");
    assert.ok(settingsSrc.includes("v3.24.9"), "settings.cjs 注释锚");
  });
}

(async () => {
  await runAGroup();
  await runBGroup();
  await runCGroup();
  await runDGroup();
  await runEGroup();
  console.log("── 完成 ──");
  console.log(`通过 ${passed} 失败 ${failed}`);
  if (failed > 0) {
    for (const line of failures) console.log(`  ✗ ${line}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();