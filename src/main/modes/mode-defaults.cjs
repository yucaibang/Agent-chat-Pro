"use strict";

/**
 * 内置工作模式定义。
 *
 * 三种模式覆盖常见使用场景：
 * - 自动化：跳过所有权限确认，Agent 全自动执行
 * - 常规：Agent 自动执行（Bridge 模式下弹窗确认敏感操作）
 * - ECO：最小能耗，适合简单问答
 *
 * 重要：SSH 直连模式下无法交互式确认权限，所有模式均使用 bypassPermissions。
 * Bridge 模式下通过 onPermissionRequest 回调实现交互式权限确认。
 *
 * 自定义模式可覆盖所有参数 + systemPrompt + modelConfig。
 */

const BUILTIN_MODES = {
  automatic: {
    id: "automatic",
    name: "自动化模式",
    icon: "⚡",
    description: "跳过权限确认，Agent 自动执行所有工具操作",
    isBuiltIn: true,
    skipPermissions: true,
    permissionMode: "bypassPermissions",
    maxTokens: 8192,
    thinkingLevel: "none",
    // 幻觉抑制：strict=0.3+0.8, standard=0.7+1.0, creative=0.9+1.0
    hallucinationControl: "standard",
    // 能耗优先：quality=全功能, balanced=适度截断, economy=maxTurns减半
    energyPriority: "quality",
    systemPrompt: "",
    modelConfig: {}
  },
  regular: {
    id: "regular",
    name: "常规模式",
    icon: "🛡",
    description: "Agent 自动执行工具（Bridge 模式下弹窗确认敏感操作）",
    isBuiltIn: true,
    // SSH 直连模式无法交互确认权限，必须 bypassPermissions 才能正常使用工具
    // Bridge 模式下由 onPermissionRequest 回调处理交互式确认
    skipPermissions: true,
    permissionMode: "bypassPermissions",
    maxTokens: 16384,
    thinkingLevel: "medium",
    hallucinationControl: "standard",
    energyPriority: "balanced",
    systemPrompt: "",
    modelConfig: {}
  },
  eco: {
    id: "eco",
    name: "ECO 节能模式",
    icon: "🌿",
    description: "最小能耗，适合简单问答",
    isBuiltIn: true,
    skipPermissions: true,
    permissionMode: "bypassPermissions",
    maxTokens: 4096,
    thinkingLevel: "none",
    hallucinationControl: "strict",
    energyPriority: "economy",
    systemPrompt: "",
    modelConfig: {}
  }
};

/** 幻觉抑制参数映射 */
const HALLUCINATION_MAP = {
  strict: { temperature: 0.3, topP: 0.8 },
  standard: { temperature: 0.7, topP: 1.0 },
  creative: { temperature: 0.9, topP: 1.0 }
};

/** 能耗优先参数映射 */
const ENERGY_MAP = {
  quality: { maxTurns: null },
  balanced: { maxTurns: 10 },
  economy: { maxTurns: 5 }
};

/** 思考等级映射 */
const THINKING_MAP = {
  none: "",
  low: "--thinking-level low",
  medium: "--thinking-level medium",
  high: "--thinking-level high"
};

/** maxTokens 合法值 */
const MAX_TOKENS_OPTIONS = [4096, 8192, 16384, 32768];

module.exports = { BUILTIN_MODES, HALLUCINATION_MAP, ENERGY_MAP, THINKING_MAP, MAX_TOKENS_OPTIONS };