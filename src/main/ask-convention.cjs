"use strict";
// ═══════════════════════════════════════════════════════════════════
// v3.25.0 AI 选择题三模式补全 — ```ask_user 约定块 prompt 注入
//
// 背景（2026-10-20 用户拍板 B 路）：v3.24.0 云端 ask_user 是真悬等（工具调用
// + IPC 回传），但 SSH/本机 claude 引擎依赖 CLI 的 AskUserQuestion 工具事件——
// Claude CLI v2.1.187 起 plain -p（headless 单发）模式硬禁用该工具（官方
// issue #77994：无通道交付问题/回收选择），事件永远不来 → 用户只在云端看到卡。
//
// 方案（复用 v3.20.0 F5 plan 块先例）：约定块是纯文本约定——在 claude 链的
// system prompt 注入约定，教 AI 需要用户决策时输出 ```ask_user 块（问题+选项）
// 即停止等待下一条消息；渲染层 extractAskBlocks 检测到块就渲染成与云端同款的
// 选择卡，点选=把选择作为新消息发出（近似体验）。atomcode/custom 引擎无 system
// prompt 通道、不注入——但渲染层 renderAssistant 是全部模式 assistant 正文的
// 唯一汇聚点，模型只要输出块即渲染（检测兜底，与 plan 块同哲学）。
//
// 注入通道（mode-params.cjs 三 builder 统一接线）：
//   direct-cli / local claude → --append-system-prompt（不污染用户正文、不进 resume 历史；
//     顺带修复工作模式 systemPrompt 在这两路此前从未传给 CLI 的既有缺陷）
//   bridge                     → start JSON 既有 systemPrompt 字段（agent-sdk-bridge.mjs 已实锤支持）
//   云端                       → 不注入（已有 ask_user 工具真悬等，不叠加约定防双形态）
// ═══════════════════════════════════════════════════════════════════

// 注入标记：渲染层解析以 ```ask_user 语言标记为准；此标记仅用于幂等判重
// （防同一 prompt 多次组装时约定段重复叠加）
const ASK_PROMPT_MARKER = "ACP_ASK_USER_CONVENTION_V1";

const ASK_CONVENTION_PROMPT = [
  `- 向用户提问约定（${ASK_PROMPT_MARKER}）：当任务需要用户在有限选项中做决策（选方案/确认操作/补关键信息）时，且仅当确实需要时，`,
  `请在回复末尾用一个独立的多行代码块向用户提问，代码块语言标记必须写成 ask_user，内部首行写「问题：」一句话说明要决策什么，随后每行一个编号选项（最多 4 个，选项可带「——」衔接一句话说明）：`,
  "```ask_user",
  "问题：采用哪种实现方式？",
  "1. 方案 A —— 更快但更耗额度",
  "2. 方案 B —— 更省额度但耗时",
  "```",
  "- 提问的其他要求：①ask_user 代码块之外不要重复罗列这些选项；②块内只写问题与选项，不写其他内容；③输出该块即表示把决策交还用户——输出块后停止陈述并等待用户的下一条消息，严禁基于自己的假设替用户做选择继续执行；④不需要用户做决策的普通任务、闲聊严禁输出该块。"
].join("\n");

function hasAskConvention(systemPrompt) {
  return typeof systemPrompt === "string" && systemPrompt.includes(ASK_PROMPT_MARKER);
}

/** 幂等追加：已有约定不再叠加；空/非字符串入参安全（工作模式 prompt 可能缺失） */
function appendAskConvention(systemPrompt) {
  const base = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  if (hasAskConvention(base)) return base;
  return base ? `${base}\n\n${ASK_CONVENTION_PROMPT}` : ASK_CONVENTION_PROMPT;
}

module.exports = { ASK_PROMPT_MARKER, ASK_CONVENTION_PROMPT, hasAskConvention, appendAskConvention };