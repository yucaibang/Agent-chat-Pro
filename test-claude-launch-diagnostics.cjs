"use strict";

/**
 * Claude 启动失败诊断测试（v3.7.1）
 *
 * 验证 friendlyClaudeLaunchError：
 *   1. 截图真实错误（musl/glibc libc 不匹配）→ 中文 libc 提示优先
 *   2. 架构不匹配（Exec format error）
 *   3. 命令不存在（command not found）
 *   4. 泛化启动失败（failed to launch 无其他特征）
 *   5. 非启动类错误原样透传
 *   6. 场景区分（NAS / 本机 / 带主机名）
 *   7. 接线点验证（ssh.cjs / local.cjs 的 require 与调用存在）
 */

const assert = require("assert");
const fs = require("fs");
const { friendlyClaudeLaunchError, LAUNCH_FAILURE_PATTERNS, FIX_COMMAND } = require("./src/main/claude-launch-diagnostics.cjs");

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

const SCREENSHOT_ERROR = `Agent SDK bridge failed: ReferenceError: Claude Code native binary at /usr/local/bin/claude exists but failed to launch. This usually means the binary does not match this system's libc — e.g. spawning a musl-linked binary on a glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary with options.pathToClaudeCodeExecutable.
    at ChildProcess.<anonymous> (file:///home/demo-user/agent_.orbit/bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:121:107222)
    at ChildProcess.emit (node:events:531:35)
    at ChildProcess._handle.onexit (node:internal/child_process:291:12)`;

test("截图真实错误 → 中文 libc 提示优先（非泛化提示）", () => {
  const result = friendlyClaudeLaunchError(SCREENSHOT_ERROR, { host: "10.66.1.99" });
  assert.ok(result.includes("NAS（10.66.1.99）上的 Claude 命令无法启动"), "首行应带主机名：" + result.split("\n")[0]);
  assert.ok(result.includes("musl 版 Claude"), "应命中 libc 专项提示");
  assert.ok(!result.includes("损坏、缺少依赖"), "不应落回泛化提示");
  assert.ok(result.includes("npm install -g @anthropic-ai/claude-code"), "应含修复命令");
  assert.ok(result.includes("原始错误：Agent SDK bridge failed"), "应保留原始错误");
  assert.ok(result.includes("pathToClaudeCodeExecutable"), "原始堆栈关键内容应保留");
});
test("libc 特征（无 launch 字样）也命中", () => {
  const result = friendlyClaudeLaunchError("spawning a musl-linked binary fails", {});
  assert.ok(result.includes("musl 版 Claude"));
});
test("架构不匹配（Exec format error）→ 架构提示", () => {
  const result = friendlyClaudeLaunchError("Exec format error: /usr/local/bin/claude", { host: "nas" });
  assert.ok(result.includes("CPU 架构"), "应命中架构提示：" + result.split("\n")[1]);
});
test("命令不存在 → 未安装提示", () => {
  const result = friendlyClaudeLaunchError("bash: claude: command not found", {});
  assert.ok(result.includes("未安装 Claude Code"));
});
test("泛化启动失败（无具体特征）→ 兼容性提示", () => {
  const result = friendlyClaudeLaunchError("Claude Code native binary exists but failed to launch.", { host: "x" });
  assert.ok(result.includes("损坏、缺少依赖"));
});
test("本机场景措辞切换（local: true）", () => {
  const result = friendlyClaudeLaunchError("musl dynamic loader missing", { local: true });
  assert.ok(result.startsWith("这台电脑上的 Claude 命令无法启动"), "首行应为本机措辞：" + result.split("\n")[0]);
});
test("非启动类错误原样透传", () => {
  assert.strictEqual(friendlyClaudeLaunchError("usage limit reached"), "usage limit reached");
  assert.strictEqual(friendlyClaudeLaunchError(""), "");
  assert.strictEqual(friendlyClaudeLaunchError(null), "");
});
test("超长原始错误截断到 600 字符", () => {
  const long = "musl error " + "x".repeat(2000);
  const result = friendlyClaudeLaunchError(long, {});
  assert.ok(result.length < 1000, `应截断：${result.length}`);
  assert.ok(result.endsWith("…"), "应以省略号结尾");
});
test("特征清单与修复命令导出完整", () => {
  assert.ok(Array.isArray(LAUNCH_FAILURE_PATTERNS) && LAUNCH_FAILURE_PATTERNS.length >= 4);
  assert.ok(FIX_COMMAND.includes("npm install -g"));
});
test("接线点：ssh.cjs verifyConnection + 两处 runClaude 均已套用", () => {
  const ssh = fs.readFileSync("src/main/ssh.cjs", "utf8");
  assert.ok(ssh.includes('require("./claude-launch-diagnostics.cjs")'), "ssh.cjs 应 require 诊断模块");
  const throws = (ssh.match(/friendlyClaudeLaunchError\(/g) || []).length;
  assert.strictEqual(throws, 3, `ssh.cjs 应有 3 处调用（verifyConnection + direct-cli + bridge）：实际 ${throws}`);
});
test("接线点：local.cjs verifyLocalConnection + runLocalClaude 均已套用", () => {
  const local = fs.readFileSync("src/main/local.cjs", "utf8");
  assert.ok(local.includes('require("./claude-launch-diagnostics.cjs")'));
  const throws = (local.match(/friendlyClaudeLaunchError\(/g) || []).length;
  assert.strictEqual(throws, 2, `local.cjs 应有 2 处调用（verifyLocalConnection + runLocalClaude）：实际 ${throws}`);
});
test("接线点：混淆清单已纳入诊断模块", () => {
  const obf = fs.readFileSync("scripts/obfuscate.cjs", "utf8");
  assert.ok(obf.includes("main/claude-launch-diagnostics.cjs"), "obfuscate.cjs 应含诊断模块");
});

console.log(`\n==================================================\n📊 测试结果: ${pass} 通过, ${fail} 失败, 共 ${pass + fail} 项`);
if (fail > 0) process.exit(1);
console.log("✅ 所有诊断测试通过！截图错误已中文化，防复发接线完整。");