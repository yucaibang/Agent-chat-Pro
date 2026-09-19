#!/usr/bin/env node
"use strict";
// v3.9.0 Tier-2 模块真迁移测试 — Orbit 0.9.6 真实现接线断言 + 行为冒烟
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
  console.log("── tool-permission-service（Orbit 真实现）──");
  const perm = read("src/main/modules/foundation/permissions/tool-permission-service.cjs");
  check("受控依赖检查（getSettings/saveSettings/showConfirmation 必传）", /缺少受控依赖/.test(perm));
  check("使用 skipPermissions 字段（全栈语义统一）", /skipPermissions: Boolean\(enabled\)/.test(perm));
  check("确认弹窗拒绝走 signal.cancelled", /cancelled\("user-declined-tool-mode"\)/.test(perm));
  check("restoreFocus 在 finally 恢复焦点", /finally[\s\S]*restoreFocus\?\.\(\)/.test(perm));

  const main = read("src/main/main.cjs");
  check("main 实例化 createToolPermissionService", /createToolPermissionService\(\{/.test(main));
  check("handler 走 service.setAutomaticMode", /toolPermissionService\.setAutomaticMode\(enabled, signal\)/.test(main));
  check("handler 传 signalMonitor.createToolPermission 信号", /signalMonitor\.createToolPermission\(/.test(main));
  check("旧内联弹窗逻辑已删除", !/允许 Agent 在\$\{localMode/.test(main));
  check("renderer 全栈仍是 skipPermissions（无 toolMode 残留）", /skipPermissions/.test(read("src/renderer/renderer.js")) && !/settings\.toolMode/.test(read("src/renderer/renderer.js")));

  console.log("── runtime-compatibility（Orbit 真实现 + ssh.cjs 集成）──");
  const rt = read("src/main/modules/agent/claude/runtime-compatibility.cjs");
  check("对象参数接口 bridgeCompatibility({ cliVersion, ... })", /cliVersion, sdkVersion, sdkClaudeCodeVersion/.test(rt));
  check("导出 parseVersion", /module\.exports = \{ bridgeCompatibility, compareVersions, evaluateLiveCompatibility, parseVersion \}/.test(rt));
  const ssh = read("src/main/ssh.cjs");
  check("ssh.cjs 引入 bridgeCompatibility + parseVersion", /require\("\.\/modules\/agent\/claude\/runtime-compatibility\.cjs"\)/.test(ssh));
  check("getAgentSdkBridgeStatus 返回 compatibility", /return \{ path: bridgePath.*compatibility \};/s.test(ssh));
  check("SDK 版本经 cat package.json 探测", /claude-agent-sdk\/package\.json/.test(ssh));
  check("CLI 版本经 claude --version 探测", /claude --version/.test(ssh));
  check("版本解析失败兜底 unknown", /SDK 或 Claude 版本无法识别/.test(ssh));

  console.log("── status 全家桶（audit-journal + lifecycle 迁移）──");
  const journal = read("src/main/modules/status/status-audit-journal.cjs");
  check("audit-journal 迁移且引用 ACP normalizer 常量", /require\("\.\.\/\.\.\/status-event-normalizer\.cjs"\)/.test(journal));
  check("导出 journalEntry/signalEntry/toolLifecycleEntry", /module\.exports = \{ journalEntry, signalEntry, toolLifecycleEntry \}/.test(journal));
  const lifecycle = read("src/main/modules/status/status-lifecycle.cjs");
  check("lifecycle 迁移（isTerminalLifecycle）", /isTerminalLifecycle/.test(lifecycle));
  check("main.cjs 内联三函数已删除", !/function statusJournalEntry\(input = \{\}\) \{/.test(main) && !/function statusToolLifecycleEntry\(input = \{\}\) \{/.test(main));
  check("main.cjs require audit-journal（别名接线 24 调用点不变）", /journalEntry: statusJournalEntry, signalEntry: statusSignalEntry, toolLifecycleEntry: statusToolLifecycleEntry/.test(main));
  const normalizer = read("src/main/status-event-normalizer.cjs");
  check("normalizer 终态判断接线 isTerminalLifecycle（2 处）", (normalizer.match(/isTerminalLifecycle\(/g) || []).length >= 2);
  check("normalizer 不再手写终态数组", !/["']finished["'], ["']failed["'], ["']cancelled["']\]\.includes/.test(normalizer));
  const statusCenter = read("src/main/modules/status/status-center.cjs");
  check("status-center 三 entry 接 audit-journal 规范化", /normalizeJournalEntry\(entry\)/.test(statusCenter) && /normalizeToolLifecycleEntry\(entry\)/.test(statusCenter));

  console.log("── 行为冒烟 ──");
  const { bridgeCompatibility, parseVersion } = require("./src/main/modules/agent/claude/runtime-compatibility.cjs");
  check("版本匹配 → matched", bridgeCompatibility({ cliVersion: "2.0.1", sdkVersion: "0.3.263", sdkClaudeCodeVersion: "2.0.1" }).state === "matched");
  check("主线不同 → mismatch", bridgeCompatibility({ cliVersion: "1.5.0", sdkVersion: "0.3.263", sdkClaudeCodeVersion: "2.0.1" }).state === "mismatch");
  check("parseVersion 从 CLI 输出提取版本", parseVersion("claude 2.0.1 (Claude Code)") === "2.0.1");
  const { signalEntry, toolLifecycleEntry } = require("./src/main/modules/status/status-audit-journal.cjs");
  check("signalEntry 枚举校验（非法值兜底 invalid）", signalEntry({ direction: "hacker", disposition: "bad" }).disposition === "invalid");
  check("signalEntry 合法值透传", signalEntry({ requestId: "0a000000-0000-0000-0000-000000000001", direction: "main-received", disposition: "completed" }).direction === "main-received");
  check("toolLifecycleEntry 工具列表截断 30", toolLifecycleEntry({ requestId: "0a000000-0000-0000-0000-000000000001", transition: "start", previousTools: Array.from({ length: 40 }, (_, i) => ({ id: `t${i}` })) }).previousTools.length === 30);
  const { isTerminalLifecycle } = require("./src/main/modules/status/status-lifecycle.cjs");
  check("终态判断 finished/failed/cancelled", isTerminalLifecycle("finished") && isTerminalLifecycle("cancelled") && !isTerminalLifecycle("running"));
  const { createStatusCenter } = require("./src/main/modules/status/status-center.cjs");
  const sc = createStatusCenter({});
  check("statusCenter.signalEntry 走规范化", sc.signalEntry({ direction: "x", disposition: "y" }).disposition === "invalid");
  check("statusCenter.entry 保留 type/timestamp", (() => { const e = sc.journalEntry({}); return e.type === "journalEntry" && typeof e.timestamp === "number"; })());

  console.log(`\n结果：${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error("测试异常:", error);
  process.exit(1);
});