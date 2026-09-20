#!/usr/bin/env node
"use strict";
// v3.12.1 上下文检测修复测试
// 修复 1：renderer usage 字段风格错配 —— SSH/local 模式 protocol 已归一驼峰，
//         旧代码只读下划线 → confirmedTokens 恒 0（确认机制失效）；
//         云端模式 prompt_tokens 是整轮请求总输入（含全部历史），全量累加 → 累计 token 平方级膨胀
// 修复 2：切换对话后上下文进度条归零不回填 —— main 有 lastKnownContext 但从不回发
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
  console.log("── 修复 1：renderer usage 字段风格 + 累计口径 ──");
  const renderer = read("src/renderer/renderer.js");
  check("usage 分支读驼峰 inputTokens（SSH/local 归一风格）", /usage\.inputTokens \?\? usage\.input_tokens \?\? usage\.prompt_tokens/.test(renderer));
  check("usage 分支读驼峰 outputTokens", /usage\.outputTokens \?\? usage\.output_tokens \?\? usage\.completion_tokens/.test(renderer));
  check("confirmedTokens 只记本轮真实输出（防平方级膨胀）", /confirmedTokens = outputTokens;/.test(renderer));
  check("旧的含输入全量累加已移除", !/confirmedTokens = inputTokens \+ outputTokens/.test(renderer));
  check("口径注释在位（含全部历史上下文）", /含全部历史上下文/.test(renderer));

  console.log("── 修复 2：切换对话回填上下文进度条 ──");
  const main = read("src/main/main.cjs");
  const preload = read("src/main/preload.cjs");
  check("main 新增 context:get handler", /ipcMain\.handle\("context:get"/.test(main));
  check("handler 从 lastKnownContext 取值", /lastKnownContext\.get\(String\(conversationId \|\| ""\)\)/.test(main));
  check("preload 暴露 getConversationContext", /getConversationContext: \(conversationId\) => ipcRenderer\.invoke\("context:get", conversationId\)/.test(preload));
  check("renderer 切换对话时调用回填", /getConversationContext\?\.\(conversationId\)/.test(renderer));
  check("回填 tokens 与 limit 双字段", /contextTokens = Number\(known\.tokens\) \|\| 0;/.test(renderer) && /contextLimit = Number\(known\.limit\) \|\| 0;/.test(renderer));
  check("回填在 resetContextBar 之后（先清零再回填）", renderer.indexOf("resetContextBar(); // 切换对话时重置上下文进度条") < renderer.indexOf("getConversationContext?.(conversationId)"));

  console.log("── 回归：旧断言不回退 ──");
  check("onContextEvent 三类分派仍在", /type === "model"/.test(renderer) && /type === "usage"/.test(renderer) && /type === "compact"/.test(renderer));
  check("chat:compact handler 仍唯一", (main.match(/ipcMain\.handle\("chat:compact"/g) || []).length === 1);
  check("onUsage 仍写 lastKnownContext", /lastKnownContext\.set\(input\.conversationId, \{ \.\.\.state, tokens: contextTokens \}\)/.test(main));

  console.log("── 模拟验证：累计口径（3 轮对话数值推演）──");
  // 旧口径：每轮 confirmed = input(整轮上下文) + output → 3 轮后远超真实值
  const rounds = [
    { input: 1000, output: 500 },   // 第 1 轮请求总输入 1000
    { input: 1700, output: 500 },   // 第 2 轮（含第 1 轮全部）
    { input: 2400, output: 500 },   // 第 3 轮（含前两轮全部）
  ];
  const oldStyle = rounds.reduce((sum, r) => sum + r.input + r.output, 0); // 7200
  const newStyle = rounds.reduce((sum, r) => sum + r.output, 0);           // 1500（+ 用户消息估算）
  const realOutput = rounds.reduce((sum, r) => sum + r.output, 0);
  check("旧口径 3 轮膨胀至 6600（4.4 倍）", oldStyle === 6600);
  check("新口径 3 轮 = 真实输出 1500", newStyle === realOutput && newStyle === 1500);

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error("测试执行失败：", error);
  process.exit(1);
});