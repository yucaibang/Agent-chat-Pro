"use strict";

/**
 * 内置工作模式定义。
 *
 * v3.25.1 模式体系重写（用户拍板 2026-10-24）：三内置名重定位为审批语义——
 * - 完全权限：跳过所有权限确认，Agent 全自动执行（原「自动化模式」，id 保留 automatic）
 * - 高危审批：高危工具操作执行前需审批确认（原「常规模式」，id 保留 regular）
 * - 按需审批：工具操作按需逐项征求你的确认；节能省额度（原「ECO 节能模式」，id 保留 eco）——
 *   ECO 的节能定位移交思考挡位调节（思考滑条首挡，v3.24.2 起），本槽职责重定位为审批+节能
 * ⚠ id 全保留（存量会话/偏好/自定义模式引用零破坏），仅 name/icon/description/权限域重写；
 * SSH/本机 CLI 链硬编码 bypassPermissions（无法交互确认），审批语义在云端/桥等可交互连接生效。
 * Bridge 模式下通过 onPermissionRequest 回调实现交互式权限确认。
 *
 * 自定义模式可覆盖所有参数 + systemPrompt + modelConfig。
 */

const BUILTIN_MODES = {
  automatic: {
    id: "automatic",
    name: "完全权限",
    icon: "⚡",
    description: "零审批全自动执行：所有工具操作直接放行（原自动化模式）",
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
    name: "高危审批",
    icon: "🛡",
    description: "高危工具操作执行前弹审批确认，其余直放（Bridge 等可交互连接生效）",
    isBuiltIn: true,
    skipPermissions: false,
    permissionMode: "default",
    maxTokens: 16384,
    thinkingLevel: "medium",
    hallucinationControl: "standard",
    energyPriority: "balanced",
    systemPrompt: "",
    modelConfig: {}
  },
  eco: {
    id: "eco",
    name: "按需审批",
    icon: "🌿",
    description: "工具操作按需逐项征求你的确认；省额度浅思考（ECO 节能定位已移交思考挡位）",
    isBuiltIn: true,
    skipPermissions: false,
    permissionMode: "default",
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
  // v3.24.2：eco 挡=节能零思考注入，CLI 层与默认同（不传 --thinking-level，省 token 靠 CLI 默认策略）
  eco: "",
  low: "--thinking-level low",
  medium: "--thinking-level medium",
  high: "--thinking-level high"
};

/** maxTokens 合法值 */
const MAX_TOKENS_OPTIONS = [4096, 8192, 16384, 32768];

module.exports = { BUILTIN_MODES, HALLUCINATION_MAP, ENERGY_MAP, THINKING_MAP, MAX_TOKENS_OPTIONS };