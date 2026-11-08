"use strict";

/**
 * v3.24.0 模型思考调节（Codex 风格挡位面板）——挡位表 + 四字段族参数映射。
 *
 * 背景调研结论（2026-10-13，官方文档一手交叉验证：DeepSeek/阿里百炼/OpenAI Codex/硅基流动/
 * aiproxy 归一化矩阵）：各家「原生思考挡位」是四字段族并存的现实，不存在统一参数——
 *  ① reasoning_effort（枚举挡位）：OpenAI（minimal~xhigh，挡位随模型各异）、DeepSeek（low/high/max）、
 *     智谱 GLM（七档，默认 max）、xAI Grok（low/high）、Gemini OpenAI 兼容层（none/low/medium/high）
 *  ② thinking.type（开关）：智谱/Kimi（enabled/disabled）、豆包（auto/disabled）、DeepSeek（开关+effort 并存）
 *  ③ enable_thinking（布尔）：阿里百炼（Qwen 系）、硅基流动（Qwen3/GLM-4.6/DeepSeek-V3.2）
 *  ④ thinking_budget（数字）：豆包/Qwen/硅基流动（超限模型立即收输出）
 * 另：Anthropic 原生 Messages 分支走 thinking.budget_tokens（数字挡，≤max_tokens）；
 *  Gemini 3 系 OpenAI 兼容层 reasoning_effort=none/low/high。
 *
 * 设计：resolveThinkingProfile(provider, model) 按服务商+模型返回该模型的「原生挡位集」，
 * 输入栏面板按挡位集渲染滑条；applyOpenAiThinking / applyAnthropicThinking 把用户选的挡位
 * 注入请求体（未命中模型/未选择挡位 → 零注入，绝不给未知端点乱传参数）。
 * SSH/本机 claude 引擎不走此表——走工作模式 thinkingLevel（--thinking-level，已有机制）。
 */

const SS = { off: "关", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "超高", ultra: "Ultra", max: "Max", on: "开", auto: "自动", none: "关", dynamic: "动态" };

/** 挡位 → UI 标签（label 优先取挡位表自带，缺省查 SS） */
function levelLabel(level) {
  const raw = typeof level === "object" && level !== null ? level : { id: level };
  if (raw.label) return raw.label;
  return `${SS[raw.id] || raw.id}`;
}

/** SSH / 本机 claude 引擎挡位（模式 thinkingLevel 同款语义，none=不传 --thinking-level）
 *  v3.24.2：eco 挡插最前（节能零注入，CLI 与 off 同=不传参），挡位文案统一 默认/轻度/中等/最高 */
const SSH_LEVELS = [
  { id: "eco", label: "ECO", hint: "零思考注入，最省 token（CLI 与默认挡一致）" },
  { id: "off", label: "默认", hint: "不传 --thinking-level（CLI 默认）" },
  { id: "low", label: "轻度", hint: "较浅思考，省 token 且更快" },
  { id: "medium", label: "中等", hint: "常规深度（Claude 默认档位）" },
  { id: "high", label: "最高", hint: "最深思考，适合复杂任务" }
];

/** Anthropic 原生分支挡位：预算数字挡（budget_tokens），off=关闭 extended thinking */
const ANTHROPIC_BUDGET = { off: 0, low: 4096, medium: 12288, high: 24576 };

/** 家族注入器：把用户选挡位写进 OpenAI 兼容请求体（body 原地改；choice 无效则不动） */
const INJECTORS = {
  /** 纯 reasoning_effort 枚举（OpenAI/xAI/Gemini 兼容层） */
  reasoning_effort(body, choice, levels) {
    if (!hasChoice(levels, choice)) return false;
    body.reasoning_effort = choice === "off" ? "none" : choice === "dynamic" ? body.reasoning_effort : choice;
    if (choice === "dynamic") delete body.reasoning_effort; // 动态=服务商默认
    return true;
  },
  /** thinking.type 开关（+可选 effort）——OpenAI 兼容 Chat Completions 顶层参数 */
  thinking_type_effort(body, choice, levels, meta) {
    if (!hasChoice(levels, choice)) return false;
    if (choice === "off") {
      body.thinking = { type: "disabled" };
      if (meta.offDeletesEffort) delete body.reasoning_effort;
      return true;
    }
    body.thinking = { type: meta.enabledValue || "enabled" };
    if (meta.effortFor) { const mapped = meta.effortFor(choice); if (mapped) body.reasoning_effort = mapped; }
    return true;
  },
  /** enable_thinking 布尔 + thinking_budget（百炼/硅基流动） */
  enable_thinking_budget(body, choice, levels) {
    if (!hasChoice(levels, choice)) return false;
    if (choice === "off") { body.enable_thinking = false; delete body.thinking_budget; return true; }
    body.enable_thinking = true;
    const level = levels.find((l) => l.id === choice);
    let budget = level && level.budget;
    if (budget === -1) delete body.thinking_budget; // 动态=不限制
    else if (budget) body.thinking_budget = budget;
    return true;
  }
};

function hasChoice(levels, choice) {
  return levels.some((l) => l.id === choice);
}

/** 模型挡位表（匹配链：provider 精判 → 模型前缀判；未命中=null=不支持思考调节） */
function resolveThinkingProfile(provider, model) {
  const p = normalizeProvider(provider);
  const m = String(model || "").toLowerCase().trim();
  if (!m) return null;
  const isProvider = (ids) => ids.includes(p);

  // Anthropic 原生 Messages 分支（provider=anthropic 或 claude 系模型）
  if (isProvider(["anthropic"]) || /^claude/.test(m)) {
    return { family: "anthropic_budget", model, levels: levelsOf("anthropic") };
  }
  // DeepSeek：thinking.type 开关 + reasoning_effort 三档（low/high/max）
  if (isProvider(["deepseek"]) || /^deepseek/.test(m)) {
    return { family: "deepseek", model, levels: levelsOf("deepseek") };
  }
  // 智谱 GLM：5.x 系七挡（effort+开关并存）；4.x 纯开关闭挡
  if (isProvider(["zhipu"]) || /^glm/.test(m)) {
    const levels = /^glm-?(5|v?\d+\.\d+)/.test(m) && /^glm-?5/.test(m) ? levelsOf("glm5") : levelsOf("glmswitch");
    return { family: "zhipu", model, levels };
  }
  // Kimi（moonshot）：thinking.type 纯开关
  if (isProvider(["moonshot"]) || /^(kimi|moonshot)/.test(m)) {
    return { family: "kimi", model, levels: levelsOf("kimi") };
  }
  // 豆包 Seed 系：thinking.type auto/disabled（Seed 系深思考常开）
  if (isProvider(["doubao"]) || /^doubao/.test(m)) {
    return { family: "doubao", model, levels: levelsOf("doubao") };
  }
  // Gemini：3 系两挡（none/low/high）；2.5 系四挡（兼容层 reasoning_effort）
  if (isProvider(["google"]) || /^gemini/.test(m)) {
    const levels = /^gemini-?3/.test(m) ? levelsOf("gemini3") : levelsOf("gemini2");
    return { family: "google", model, levels };
  }
  // 硅基流动：模型前缀混合（qwen3.5+ / glm-5 / deepseek-v4 → effort 族；qwen3-/glm-4/deepseek-v3.2 → 开关族）
  if (isProvider(["siliconflow"])) {
    if (/^qwen3\.[5-9]/.test(m)) return { family: "siliconflow_effort", model, levels: levelsOf("qwenEffort") };
    if (/^glm-?5/.test(m)) return { family: "siliconflow_effort", model, levels: levelsOf("glm5") };
    if (/^deepseek-?v4/.test(m)) return { family: "siliconflow_effort", model, levels: levelsOf("deepseek") };
    if (/^(qwen3-|glm-?4\.6|deepseek-?v3\.2)/.test(m)) return { family: "siliconflow_switch", model, levels: levelsOf("siliconswitch") };
    return null; // 硅基流动其余模型（非思考类）不注入
  }
  // xAI：grok 系支持 reasoning_effort 两挡（官方实锤 low/high；xai provider 下非 grok 模型零注入）
  if (isProvider(["xai"]) || /^grok/.test(m)) {
    if (!/^grok/.test(m)) return null;
    return { family: "xai", model, levels: levelsOf("xai") };
  }
  // OpenAI：effort 枚举（codex 系/新旗舰附超高挡）
  if (isProvider(["openai"]) || /^(gpt-|o[134])/.test(m)) {
    const levels = levelsOf("openai", m);
    if (!levels) return null;
    return { family: "openai", model, levels };
  }
  // 阿里百炼（qwen provider）：Qwen 系 enable_thinking + thinking_budget
  if (isProvider(["qwen", "dashscope"]) || /^qwen/.test(m)) {
    if (/^qwen3\.[5-9]/.test(m)) return { family: "qwen", model, levels: levelsOf("qwenEffort") };
    return { family: "qwen", model, levels: levelsOf("qwenSwitch") };
  }
  return null; // custom / 未知模型零注入（防未知端点拒收非标参数）
}

function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase();
}

/**
 * v3.35.7 群聊思考面板「预计消耗倍数」表（用户需求：群内成员档位叠在输入栏面板里、
 * 每节下方显示预计消耗倍数）。口径：相对「无思考注入」请求的 token 总消耗倍率估算
 * （思考 token 演进档位成本单调上升；off/on/开 关系型挡位=不注入基准 ×1）。
 * 纯 UI 展示值，不参与注入/计费（真实计费依服务商账单）。
 */
const LEVEL_COST = {
  off: 1, on: 1, none: 1, dynamic: 1, eco: 1,           // 不注入/开关类 = 基准倍数
  minimal: 1.1,
  low: 1.6,
  medium: 2.5,
  high: 4,
  xhigh: 6,
  ultra: 8,
  max: 10
};

/** 挡位集出口统一盖 cost 章（群聊面板按 cost 渲染「预计消耗倍数 ×N」） */
function withCost(levels) {
  return (Array.isArray(levels) ? levels : []).map((l) => ({ ...l, cost: l.cost ?? LEVEL_COST[l.id] ?? 1 }));
}

/** 挡位集构造（集中定义便于单测断言「挡位随模型各异」） */
function levelsOf(kind, extra) {
  return withCost(levelsRaw(kind, extra));
}

function levelsRaw(kind, extra) {
  switch (kind) {
    case "anthropic":
      return [
        { id: "off", label: "关", hint: "关闭扩展思考（默认）" },
        { id: "low", label: "低", hint: "思考预算 4096" },
        { id: "medium", label: "中", hint: "思考预算 12288" },
        { id: "high", label: "高", hint: "思考预算 24576（自动钳进 max_tokens）" }
      ];
    case "deepseek":
      return [
        { id: "off", label: "关", hint: "thinking.type=disabled" },
        { id: "low", label: "低", hint: "reasoning_effort=low" },
        { id: "high", label: "高", hint: "reasoning_effort=high（官方默认）" },
        { id: "max", label: "Max", hint: "reasoning_effort=max（最深思考）" }
      ];
    case "glm5":
      return [
        { id: "off", label: "关", hint: "thinking.type=disabled" },
        { id: "low", label: "低" },
        { id: "medium", label: "中" },
        { id: "high", label: "高" },
        { id: "xhigh", label: "超高" },
        { id: "ultra", label: "Ultra" },
        { id: "max", label: "Max", hint: "智谱默认挡" }
      ];
    case "glmswitch":
    case "kimi":
      return [
        { id: "off", label: "关", hint: "thinking.type=disabled" },
        { id: "on", label: "开", hint: "thinking.type=enabled（默认）" }
      ];
    case "siliconswitch":
      return [
        { id: "off", label: "关", hint: "enable_thinking=false" },
        { id: "on", label: "开", hint: "enable_thinking=true（默认）" }
      ];
    case "doubao":
      return [
        { id: "auto", label: "自动", hint: "thinking.type=auto（默认）" },
        { id: "off", label: "关", hint: "thinking.type=disabled" }
      ];
    case "gemini3":
      return [
        { id: "off", label: "关", hint: "reasoning_effort=none" },
        { id: "low", label: "低" },
        { id: "high", label: "高" }
      ];
    case "gemini2":
      return [
        { id: "off", label: "关", hint: "reasoning_effort=none" },
        { id: "low", label: "低" },
        { id: "medium", label: "中" },
        { id: "high", label: "高" }
      ];
    case "openai": {
      const m = String(extra || "").toLowerCase();
      const levels = [
        { id: "minimal", label: "最低", hint: "近乎不思考，最快最省" },
        { id: "low", label: "低" },
        { id: "medium", label: "中", hint: "默认挡" },
        { id: "high", label: "高" }
      ];
      // Codex 系/新旗舰支持 Extra high（调研实锤：挡位随模型各异）
      if (/codex/.test(m) || /gpt-5\.[1-9]/.test(m)) levels.push({ id: "xhigh", label: "超高", hint: "仅部分模型支持" });
      return levels;
    }
    case "xai":
      return [
        { id: "low", label: "低", hint: "reasoning_effort=low" },
        { id: "high", label: "高", hint: "reasoning_effort=high（官方仅 low/high 两挡）" }
      ];
    case "qwenEffort":
      return [
        { id: "off", label: "关", hint: "enable_thinking=false" },
        { id: "low", label: "低", hint: "思考预算 1024", budget: 1024 },
        { id: "medium", label: "中", hint: "思考预算 8192", budget: 8192 },
        { id: "high", label: "高", hint: "思考预算 32768", budget: 32768 }
      ];
    case "qwenSwitch":
      return [
        { id: "off", label: "关", hint: "enable_thinking=false" },
        { id: "on", label: "开", hint: "enable_thinking=true（默认思考，预算交给服务商）" }
      ];
    default:
      return [];
  }
}

/**
 * OpenAI 兼容请求体注入（buildChatBody 末尾调用；未命中/无 choice/无效 choice=零注入）
 * @returns {boolean} 是否发生注入（供测试断言与日志）
 */
function applyOpenAiThinking(body, context) {
  const { provider, model, choice } = context || {};
  if (!body || typeof body !== "object" || !choice) return false;
  const profile = resolveThinkingProfile(provider, model);
  if (!profile) return false;
  const { family, levels } = profile;
  switch (family) {
    case "anthropic_budget":
      return false; // Anthropic 原生体只在 applyAnthropicThinking 注入
    case "openai":
    case "xai":
      return INJECTORS.reasoning_effort(body, choice, levels);
    case "google":
      return INJECTORS.reasoning_effort(body, choice, levels);
    case "deepseek":
      return INJECTORS.thinking_type_effort(body, choice, levels, {
        enabledValue: "enabled",
        effortFor: (c) => (["low", "high", "max"].includes(c) ? c : "")
      });
    case "zhipu":
      return INJECTORS.thinking_type_effort(body, choice, levels, {
        enabledValue: "enabled",
        effortFor: (c) => (["off", "on"].includes(c) ? "" : c) // GLM-4.x 纯开关不带 effort
      });
    case "kimi":
      return INJECTORS.thinking_type_effort(body, choice, levels, { enabledValue: "enabled" });
    case "doubao":
      return INJECTORS.thinking_type_effort(body, choice, levels, { enabledValue: "auto" });
    case "siliconflow_switch":
      return INJECTORS.enable_thinking_budget(body, choice, levels); // 调研实锤：qwen3-/glm-4.6/deepseek-v3.2 用 enable_thinking 布尔
    case "qwen":
    case "siliconflow_effort":
      if (/^qwen3\.[5-9]/.test(String(model).toLowerCase())) {
        return INJECTORS.enable_thinking_budget(body, choice, levels);
      }
      if (family === "siliconflow_effort" && /^deepseek-?v4/.test(String(model).toLowerCase())) {
        return INJECTORS.thinking_type_effort(body, choice, levels, {
          enabledValue: "enabled",
          effortFor: (c) => (["low", "high", "max"].includes(c) ? c : "")
        });
      }
      if (family === "siliconflow_effort" && /^glm-?5/.test(String(model).toLowerCase())) {
        return INJECTORS.thinking_type_effort(body, choice, levels, { enabledValue: "enabled" });
      }
      return INJECTORS.enable_thinking_budget(body, choice, levels);
    default:
      return false;
  }
}

/**
 * Anthropic 原生 Messages 请求体注入（buildAnthropicBody 末尾调用）
 * 挡位→thinking.budget_tokens（数字挡）；off=不注入 thinking（官方默认关闭）。
 * budget 必须 < max_tokens（官方硬约束），超限自动钳到 max_tokens - 1024，最低 1024。
 * @returns {boolean}
 */
function applyAnthropicThinking(body, context) {
  const { provider, model, choice, maxTokens } = context || {};
  if (!body || typeof body !== "object" || !choice || choice === "off") return false;
  const profile = resolveThinkingProfile(provider, model);
  if (!profile || profile.family !== "anthropic_budget") return false;
  if (!hasChoice(profile.levels, choice)) return false;
  const budget = ANTHROPIC_BUDGET[choice] || 0;
  if (!budget) return false;
  const maxTokensNum = Number(body.max_tokens || maxTokens || 4096);
  const headroom = maxTokensNum - 1024; // 官方约束 budget < max_tokens，留 1024 输出余量
  if (headroom < 1024) return false; // max_tokens 太小放不下最小心智预算（1024），放弃注入
  body.thinking = { type: "enabled", budget_tokens: Math.min(budget, headroom) };
  return true;
}

/** 挡位记忆归一（settings.thinkingChoices：仅允许对象/字符串值，防呆不防语义） */
function normalizeThinkingChoices(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const key of Object.keys(input)) {
    if (!key) continue;
    const value = input[key];
    if (typeof value === "string") out[key] = value.slice(0, 32);
    else if (value === null || value === undefined) out[key] = "";
    else if (typeof value === "object") {
      const nested = {};
      for (const k of Object.keys(value)) if (typeof value[k] === "string") nested[k] = value[k].slice(0, 32);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

module.exports = {
  SSH_LEVELS,
  ANTHROPIC_BUDGET,
  levelLabel,
  resolveThinkingProfile,
  applyOpenAiThinking,
  applyAnthropicThinking,
  normalizeThinkingChoices
};