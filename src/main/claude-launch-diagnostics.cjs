"use strict";

/**
 * Claude 启动失败诊断（v3.7.1）
 *
 * 背景：2026-09-05 用户截图显示 NAS 上装了 musl 版 Claude native binary，
 * 在 glibc 主机上启动即崩，Bridge 把英文原始错误直接透传到界面，用户不知所云。
 * 本模块在主进程侧识别这类启动失败，转成中文友好报错 + 修复指引。
 *
 * 为什么放主进程而不是 Bridge：bridge 是部署到 NAS 的独立文件（旧版本可能
 * 还在 NAS 上跑），改主进程随安装包升级立即生效。
 */

// Claude 启动失败的特征（来自截图错误与常见场景）
// 顺序重要：具体原因（libc/架构/命令不存在）优先于泛化的 launch-failed
const LAUNCH_FAILURE_PATTERNS = [
  { pattern: /\blibc\b|musl|glibc|ld-musl|dynamic loader/i, kind: "libc-mismatch" },
  { pattern: /exec format error/i, kind: "arch-mismatch" },
  { pattern: /command not found|not found.*claude|无法运行 Claude/i, kind: "command-not-found" },
  { pattern: /exists but failed to launch|failed to launch/i, kind: "launch-failed" },
  { pattern: /pathToClaudeCodeExecutable/i, kind: "launch-failed" }
];

const FIX_HINTS = {
  "libc-mismatch": "常见原因：NAS 上安装了 musl 版 Claude，而系统是 glibc Linux（或反之）。",
  "arch-mismatch": "常见原因：Claude 二进制的 CPU 架构与 NAS 不匹配（如 x86_64 机器装了 ARM 版）。",
  "command-not-found": "常见原因：NAS 上未安装 Claude Code，或命令名与「唤醒名」不一致。",
  "launch-failed": "常见原因：NAS 上的 Claude 命令损坏、缺少依赖，或与系统环境不兼容。"
};

const FIX_COMMAND = "修复方法：SSH 登录 NAS 执行 npm install -g @anthropic-ai/claude-code（npm 版自动匹配系统 libc）。";

/**
 * 识别 Claude 启动失败并把错误转成中文友好报错。
 * 非 Claude 启动类错误原样返回（不做无谓包装）。
 * @param {string} raw 原始错误文本（stderr / error.message）
 * @param {{host?: string, local?: boolean}} [context] 场景上下文
 * @returns {string} 友好错误（非启动类错误时返回原文）
 */
function friendlyClaudeLaunchError(raw, context = {}) {
  const message = String(raw || "");
  if (!message.trim()) return message;
  let kind = "";
  for (const { pattern, kind: matched } of LAUNCH_FAILURE_PATTERNS) {
    if (pattern.test(message)) { kind = matched; break; }
  }
  if (!kind) return message;
  const where = context.local ? "这台电脑" : (context.host ? `NAS（${context.host}）` : "NAS");
  const hint = FIX_HINTS[kind] || FIX_HINTS["launch-failed"];
  const parts = [
    `${where}上的 Claude 命令无法启动。`,
    hint,
    FIX_COMMAND,
    `原始错误：${message.length > 600 ? message.slice(0, 600) + "…" : message}`
  ];
  return parts.join("\n");
}

module.exports = { friendlyClaudeLaunchError, LAUNCH_FAILURE_PATTERNS, FIX_COMMAND };