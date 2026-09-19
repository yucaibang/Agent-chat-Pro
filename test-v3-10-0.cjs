#!/usr/bin/env node
"use strict";
// v3.10.0 上下文压缩 + Windows 缓存清理测试
// 覆盖：protocol 新函数单元 + cache-cleaner 行为 + main/ssh/local/preload/renderer 接线断言 + 构建链路
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}`);
  }
}

(async () => {
  console.log("── protocol.cjs 上下文解析（单元）──");
  const protocol = require("./src/main/protocol.cjs");
  const { contextTokensFromUsage, contextLimitFromModel, modelFromEvent, compactEventFromEvent, usageFromEvent } = protocol;
  check("contextTokensFromUsage 三项求和", contextTokensFromUsage({ inputTokens: 1000, cacheCreationInputTokens: 200, cacheReadInputTokens: 400 }) === 1600);
  check("contextTokensFromUsage 下划线字段兼容", contextTokensFromUsage({ input_tokens: 10, cache_read_input_tokens: 5 }) === 15);
  check("contextTokensFromUsage 空对象 → 0", contextTokensFromUsage({}) === 0);
  check("contextTokensFromUsage null → 0", contextTokensFromUsage(null) === 0);
  check("contextTokensFromUsage 不计 outputTokens", contextTokensFromUsage({ inputTokens: 100, outputTokens: 999 }) === 100);
  check("contextLimitFromModel [1m] → 1,000,000", contextLimitFromModel("glm-5.3-flash:cloud[1m]") === 1_000_000);
  check("contextLimitFromModel [128k] → 128,000", contextLimitFromModel("deepseek-chat[128k]") === 128_000);
  check("contextLimitFromModel [200k] → 200,000", contextLimitFromModel("qwen-max[200k]") === 200_000);
  check("contextLimitFromModel 无标记 Claude 默认 200,000", contextLimitFromModel("claude-sonnet-4-5") === 200_000);
  check("contextLimitFromModel 空值 → 200,000", contextLimitFromModel("") === 200_000);
  check("contextLimitFromModel [1.5m] → 1,500,000", contextLimitFromModel("claude-sonnet-4-5[1.5m]") === 1_500_000);
  check("contextLimitFromModel 非法标记 → 200,000", contextLimitFromModel("model[bogus]") === 200_000);
  check("modelFromEvent 提取 system/init 的 model", modelFromEvent({ type: "system", subtype: "init", model: "glm-4.6" }) === "glm-4.6");
  check("modelFromEvent 非 init 返回 undefined", modelFromEvent({ type: "assistant", model: "x" }) === undefined);
  check("modelFromEvent null → undefined", modelFromEvent(null) === undefined);

  console.log("── protocol.cjs 压缩事件解析（单元）──");
  const started = compactEventFromEvent({ type: "system", subtype: "status", status: "compacting" });
  check("compacting → started", started && started.phase === "started");
  const finishedOk = compactEventFromEvent({ type: "system", subtype: "status", compact_result: "success" });
  check("compact_result success → finished/success", finishedOk && finishedOk.phase === "finished" && finishedOk.success === true);
  const finishedFail = compactEventFromEvent({ type: "system", subtype: "status", compact_result: "failed", compact_error: "boom" });
  check("compact_result failed → finished/failure/error 透传", finishedFail && finishedFail.phase === "finished" && finishedFail.success === false && finishedFail.error === "boom");
  const boundary = compactEventFromEvent({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 150_000, post_tokens: 20_000, trigger: "auto", duration_ms: 3400 } });
  check("compact_boundary → boundary + pre/post/trigger/duration", boundary && boundary.phase === "boundary" && boundary.preTokens === 150_000 && boundary.postTokens === 20_000 && boundary.trigger === "auto" && boundary.durationMs === 3400);
  check("manual trigger 归一化", (compactEventFromEvent({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } }) || {}).trigger === "manual");
  check("非 system 事件 → undefined", compactEventFromEvent({ type: "assistant" }) === undefined);
  const assistantUsage = usageFromEvent({ type: "assistant", message: { usage: { input_tokens: 500, output_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000 } } });
  check("usageFromEvent 新增 assistant 分支（下划线字段）", assistantUsage && assistantUsage.inputTokens === 500 && assistantUsage.cacheReadInputTokens === 1000);
  check("导出新函数五件套", [contextTokensFromUsage, contextLimitFromModel, modelFromEvent, compactEventFromEvent, usageFromEvent].every((fn) => typeof fn === "function"));

  console.log("── cache-cleaner.cjs（单元，非 Windows 平台行为）──");
  const cacheCleaner = require("./src/main/cache-cleaner.cjs");
  check("CACHE_TARGET_COUNT = 7", cacheCleaner.CACHE_TARGET_COUNT === 7);
  check("scanSystemCaches 返回 targets（非 Windows 降级不可用）", await (async () => {
    const scan = await cacheCleaner.scanSystemCaches();
    return scan.targets.length === 7 && (process.platform === "win32" ? scan.supported === true : scan.supported === false);
  })());
  const scanItems = await (async () => (await cacheCleaner.scanSystemCaches()).targets)();
  check("扫描项含 id/name/risk/description/location", scanItems.every((t) => t.id && t.name && ["safe", "advanced", "admin"].includes(t.risk) && typeof t.description === "string" && typeof t.location === "string"));
  check("清理项 id 唯一", new Set(scanItems.map((t) => t.id)).size === scanItems.length);
  check("分级齐全（safe/advanced/admin 都有）", ["safe", "advanced", "admin"].every((risk) => scanItems.some((t) => t.risk === risk)));
  const cacheSource = read("src/main/cache-cleaner.cjs");
  const cacheCode = cacheSource.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n"); // 过滤注释后检查
  check("高危项明确排除（无 Prefetch/WinSxS/Windows.old/Winsock 清理逻辑）", !/prefetch|winsxs|windows\.old|winsock/i.test(cacheCode));
  if (process.platform !== "win32") {
    let threw = "";
    try { await cacheCleaner.cleanSystemCaches(["user-temp"], () => {}); } catch (error) { threw = error.message; }
    check("非 Windows cleanSystemCaches 抛中文错误", threw.includes("仅支持 Windows"));
  }

  console.log("── main.cjs 自动压缩接线 ──");
  const main = read("src/main/main.cjs");
  check("executeCompact 定义", /const executeCompact = async \(sender, sessionId, conversationId, instruction = "", options = \{\}\)/.test(main));
  check("maybeAutoCompact 定义", /const maybeAutoCompact = \(sender, sessionId, conversationId\)/.test(main));
  check("compactingSessions 防重入", /compactingSessions\.add\(sid\)/.test(main) && /compactingSessions\.delete\(sid\)/.test(main));
  check("chat:compact handler 走 executeCompact", /ipcMain\.handle\("chat:compact", async \(event, payload\) => \{\s*return executeCompact/.test(main));
  check("旧内联 chat:compact 已移除（防重复注册）", (main.match(/ipcMain\.handle\("chat:compact"/g) || []).length === 1);
  check("自动压缩触发于请求完成后", /maybeAutoCompact\(event\.sender, result\.sessionId \|\| latestSessionId, input\.conversationId\)/.test(main));
  check("onUsage 更新 lastKnownContext.tokens", /lastKnownContext\.set\(input\.conversationId, \{ \.\.\.state, tokens: contextTokens \}\)/.test(main));
  check("onModelChange 更新 lastKnownContext.limit", /lastKnownContext\.set\(input\.conversationId, \{ \.\.\.state, limit:/ .test(main));
  check("boundary postTokens 回写 lastKnownContext", /compactEvent\.phase === "boundary" && Number\(compactEvent\.postTokens\) > 0/.test(main));
  check("Agent 回复中禁止压缩", /Agent 正在回复，暂时不能压缩上下文/.test(main));
  check("云端模式拒绝压缩", /云端模式直连 API，没有上下文压缩/.test(main));
  check("自动压缩读取 compactAuto/compactThreshold/compactInstruction", /autoSettings\.compactAuto/.test(main) && /autoSettings\.compactThreshold/.test(main) && /autoSettings\.compactInstruction/.test(main));
  check("自动压缩失败仅写日志不抛出", /context_compact_auto_failed/.test(main));

  console.log("── settings.cjs 压缩设置 ──");
  const settings = read("src/main/settings.cjs");
  check("normalizeCompactThreshold 范围钳制 50–95", /Math\.min\(95, Math\.max\(50, Math\.round\(num\)\)\)/.test(settings));
  check("normalizeCompactInstruction 300 字符截断", /text\.slice\(0, 300\)/.test(settings));
  check("getSettings 暴露 compactThreshold/compactAuto/compactInstruction", /compactThreshold: normalizeCompactThreshold/.test(settings) && /compactAuto: Boolean\(raw\.compactAuto\)/.test(settings));
  check("saveSettings 持久化三字段", /compactThreshold: normalizeCompactThreshold\(input\.compactThreshold/.test(settings) && /compactAuto: input\.compactAuto !== undefined \? Boolean\(input\.compactAuto\)/.test(settings));

  console.log("── ssh.cjs / local.cjs / preload.cjs 接线 ──");
  const ssh = read("src/main/ssh.cjs");
  const local = read("src/main/local.cjs");
  const preload = read("src/main/preload.cjs");
  check("ssh.cjs 引入三个新解析函数", /compactEventFromEvent,/.test(ssh) && /contextLimitFromModel,/.test(ssh) && /modelFromEvent,/.test(ssh));
  check("ssh.cjs 接线 onModelChange", /callbacks\.onModelChange\?\.\(\{ model: foundModel, contextLimit: contextLimitFromModel\(foundModel\) \}\)/.test(ssh));
  check("ssh.cjs 接线 onCompactEvent", /callbacks\.onCompactEvent\?\.\(compactEvent\)/.test(ssh));
  check("local.cjs 同样接线（两处）", (local.match(/callbacks\.onModelChange\?\.\(/g) || []).length >= 1 && (local.match(/callbacks\.onCompactEvent\?\.\(/g) || []).length >= 1);
  check("preload 暴露 compactContext", /compactContext: \(payload\) => ipcRenderer\.invoke\("chat:compact", payload\)/.test(preload));
  check("preload 暴露 scanSystemCaches/cleanSystemCaches", /scanSystemCaches: \(\) => ipcRenderer\.invoke\("cache:scan"\)/.test(preload) && /cleanSystemCaches: \(targets\) => ipcRenderer\.invoke\("cache:clean", targets\)/.test(preload));
  check("preload 暴露 onContextEvent", /onContextEvent: \(handler\) => ipcRenderer\.on\("chat:context"/.test(preload));

  console.log("── renderer.js / index.html / styles.css ──");
  const renderer = read("src/renderer/renderer.js");
  const html = read("src/renderer/index.html");
  const css = read("src/renderer/styles.css");
  check("onContextEvent 注册并分派三类", /onContextEvent\?\.\(\(event\) => \{/.test(renderer) && /type === "model"/.test(renderer) && /type === "usage"/.test(renderer) && /type === "compact"/.test(renderer));
  check("handleCompactEvent 处理 started/boundary/finished", /phase === "started"/.test(renderer) && /phase === "boundary"/.test(renderer) && /phase === "finished"/.test(renderer));
  check("压缩按钮点击调 compactContext", /window\.agentChatPro\.compactContext\(\{ sessionId, conversationId, instruction: "" \}\)/.test(renderer));
  check("切换对话重置进度条（resetContextBar）", /resetContextBar\(\); \/\/ 切换对话时重置上下文进度条/.test(renderer));
  check("颜色分级 70/90（warn/danger）", /percent >= 70 && percent < 90/.test(renderer) && /percent >= 90/.test(renderer));
  check("index.html 进度条结构", /context-bar-row/.test(html) && /context-bar-fill/.test(html) && /context-compact/.test(html) && /token-counter-row/.test(html));
  check("index.html 压缩设置面板", /id="compact-settings"/.test(html) && /id="compact-auto"/.test(html) && /id="compact-threshold"/.test(html) && /id="compact-instruction"/.test(html));
  check("index.html 缓存清理面板", /id="cache-settings"/.test(html) && /id="cache-scan"/.test(html) && /id="cache-target-list"/.test(html) && /id="cache-clean"/.test(html));
  check("styles.css 进度条 + 风险徽章样式", /\.context-bar-fill/.test(css) && /\.cache-risk-badge\.admin/.test(css) && /\.context-compact-button\.compacting/.test(css));
  check("styles.css 亮色主题适配", /\[data-theme="light"\] \.context-bar-fill\.danger/.test(css) && /\[data-theme="light"\] \.cache-risk-badge\.safe/.test(css));
  check("渲染层安全级默认勾选", /checkbox\.checked = target\.risk === "safe"/.test(renderer));

  console.log("── 构建链路（混淆 + 字节码）──");
  const obfuscate = read("scripts/obfuscate.cjs");
  const pipeline = read("scripts/build-pipeline.cjs");
  check("cache-cleaner.cjs 纳入中等混淆", /"main\/cache-cleaner\.cjs"/.test(obfuscate));
  check("v3.9.0 遗漏补齐：status 两模块纳入混淆", /"main\/modules\/status\/status-audit-journal\.cjs"/.test(obfuscate) && /"main\/modules\/status\/status-lifecycle\.cjs"/.test(obfuscate));
  check("cache-cleaner.cjs 纳入 V8 字节码编译", /"src\/main\/cache-cleaner\.cjs"/.test(pipeline));
  check("版本号 ≥ 3.10.0（语义比较）", (() => {
    const m = read("package.json").match(/"version": "(\d+)\.(\d+)\.(\d+)"/);
    if (!m) return false;
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return maj > 3 || (maj === 3 && (min > 10 || (min === 10 && pat >= 0)));
  })());
  check("v3.11.0 跨平台构建跳过字节码", /bytecodeEnabled\(\)/.test(pipeline) && /跨 OS 不兼容/.test(pipeline));

  console.log("── bridge MessageQueue 修复（上轮半成品）──");
  const bridge = read("src/bridge/agent-sdk-bridge.mjs");
  check("close() 正确唤醒 waiter（shift()() 调用）", /this\.#waiters\.length\) this\.#waiters\.shift\(\)\(\{ value: undefined, done: true \}\)/.test(bridge));

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error("测试执行失败：", error);
  process.exit(1);
});