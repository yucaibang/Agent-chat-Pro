"use strict";
// ═══════════════════════════════════════════════════════════════════
// v3.20.0 F5 Agent plan（云端路）— ```plan 约定块 prompt 注入
//
// 三模式数据源分派（2026-10-05 用户拍板「Agent plan 是在每一个模式都要有的哦」）：
//   结构化 TodoWrite 路 = SSH 远程 + 本机 claude 引擎（工具事件管线特化渲染，不经本模块）
//   约定 ```plan 块路  = 云端 AI + 本机 atomcode/custom 引擎（本模块只负责云端 prompt 注入；
//                        atomcode daemon / custom CLI 无 system prompt 通道，靠渲染层
//                        extractPlanBlocks 检测兜底——模型输出了 plan 块即渲染）
//
// 设计原则（新功能规划说明书 §4.2）：不用 function calling 注册内部工具，
// 只在 system prompt 追加约定段——plan 块是纯文本约定，兼容所有 provider。
// ═══════════════════════════════════════════════════════════════════

// 注入标记：渲染层解析以 ```plan 语言标记为准；此标记仅用于幂等判重（防工作模式
// prompt 被多次组装时约定段重复叠加）
const PLAN_PROMPT_MARKER = "ACP_AGENT_PLAN_CONVENTION_V1";

const PLAN_CONVENTION_PROMPT = [
  `- 长任务计划展示约定（${PLAN_PROMPT_MARKER}）：当用户请求需要多个步骤、多个目标或较长时间完成时，`,
  `请在回复最开头用一个独立的多行代码块展示计划，代码块语言标记必须写成 plan，内部每行一条编号目标：`,
  "```plan",
  "1. 第一个目标",
  "2. 第二个目标",
  "3. 第三个目标",
  "```",
  "- 计划展示的其他要求：①每行只写目标本身，不写状态符、进度或完成情况；②每完成阶段性进展后，重新输出一个完整的 plan 代码块反映最新全局进度（客户端只展示最新一次）；③plan 代码块之外不要重复罗列同样的计划条目；④简单短任务、单步问答、闲聊不需要输出 plan 块。"
].join("\n");

function hasPlanConvention(systemPrompt) {
  return typeof systemPrompt === "string" && systemPrompt.includes(PLAN_PROMPT_MARKER);
}

/** 幂等追加：已有约定不再叠加；空/非字符串入参安全（工作模式 prompt 可能缺失） */
function appendPlanConvention(systemPrompt) {
  const base = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  if (hasPlanConvention(base)) return base;
  return base ? `${base}\n\n${PLAN_CONVENTION_PROMPT}` : PLAN_CONVENTION_PROMPT;
}

module.exports = { PLAN_PROMPT_MARKER, PLAN_CONVENTION_PROMPT, hasPlanConvention, appendPlanConvention };