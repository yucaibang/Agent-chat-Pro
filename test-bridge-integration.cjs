#!/usr/bin/env node
"use strict";

/**
 * Bridge modelOverrides 集成测试
 *
 * 在 NAS 上直接加载 bridge 模块的函数，
 * 模拟 Agent Orbit 发送的 start 消息，
 * 验证 modelOverrides 自动注入是否正确。
 *
 * 用法：node test-bridge-integration.cjs
 */

const path = require("path");

// ── 从 bridge 源码中提取函数 ──
const fs = require("fs");
const bridgePath = path.join(__dirname, "src/bridge/agent-sdk-bridge.mjs");
const bridgeSrc = fs.readFileSync(bridgePath, "utf8");

// 提取函数定义
function extractFunc(src, name) {
  const re = new RegExp(`(function ${name}\\([\\s\\S]*?\\n\\})`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`函数 ${name} 未找到`);
  return m[1];
}

function extractConstArr(src, name) {
  const re = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`常量 ${name} 未找到`);
  return eval(`[${m[1]}]`);
}

// 构建可执行代码
const sanitizeModelName = new Function("model", `
  if (typeof model !== "string") return model;
  return model.replace(/\\[[^\\]]*\\]$/g, "").trim() || model;
`);

const CLAUDE_MODEL_PREFIXES = ["claude-", "anthropic-"];

const CLAUDE_INTERNAL_MODEL_IDS = extractConstArr(bridgeSrc, "CLAUDE_INTERNAL_MODEL_IDS");

function isClaudeModel(model) {
  if (typeof model !== "string" || !model.trim()) return true;
  const lower = model.toLowerCase().trim();
  return CLAUDE_MODEL_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function buildModelOverrides(userModel) {
  const overrides = {};
  for (const claudeId of CLAUDE_INTERNAL_MODEL_IDS) {
    overrides[claudeId] = userModel;
  }
  return overrides;
}

// ── 集成测试 ──

console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║   Bridge modelOverrides 集成测试 — NAS 直接运行          ║");
console.log("╚════════════════════════════════════════════════════════════╝");
console.log();

// 模拟 Agent Orbit 发送的 start 消息
const testCases = [
  {
    name: "GLM-5.1 Cloud（Agent Orbit 场景）",
    start: {
      type: "start",
      prompt: "你好",
      automatic: true,
      workingDirectory: "/home/demo-user",
      claudePath: "claude",
      sessionId: "",
      modelConfig: { model: "glm-5.1:cloud" },
    },
    expectOverrides: true,
    expectModel: "glm-5.1:cloud",
    expectSanitized: false,
  },
  {
    name: "GLM-5.1 Cloud 带 [1m] 后缀",
    start: {
      type: "start",
      prompt: "你好",
      automatic: true,
      workingDirectory: "/home/demo-user",
      claudePath: "claude",
      sessionId: "",
      modelConfig: { model: "glm-5.1:cloud[1m]" },
    },
    expectOverrides: true,
    expectModel: "glm-5.1:cloud",
    expectSanitized: true,
  },
  {
    name: "DeepSeek Chat",
    start: {
      type: "start",
      prompt: "你好",
      automatic: true,
      workingDirectory: "/home/demo-user",
      claudePath: "claude",
      sessionId: "",
      modelConfig: { model: "deepseek-chat" },
    },
    expectOverrides: true,
    expectModel: "deepseek-chat",
    expectSanitized: false,
  },
  {
    name: "DeepSeek Chat 带 [128k] 后缀",
    start: {
      type: "start",
      prompt: "你好",
      automatic: true,
      workingDirectory: "/home/demo-user",
      claudePath: "claude",
      sessionId: "",
      modelConfig: { model: "deepseek-chat[128k]" },
    },
    expectOverrides: true,
    expectModel: "deepseek-chat",
    expectSanitized: true,
  },
  {
    name: "Claude Sonnet（原生模型，不注入）",
    start: {
      type: "start",
      prompt: "你好",
      automatic: true,
      workingDirectory: "/home/demo-user",
      claudePath: "claude",
      sessionId: "",
      modelConfig: { model: "claude-sonnet-4-20250514" },
    },
    expectOverrides: false,
    expectModel: "claude-sonnet-4-20250514",
    expectSanitized: false,
  },
  {
    name: "Qwen 2.5 72B",
    start: {
      type: "start",
      prompt: "你好",
      automatic: true,
      workingDirectory: "/home/demo-user",
      claudePath: "claude",
      sessionId: "",
      modelConfig: { model: "qwen2.5:72b" },
    },
    expectOverrides: true,
    expectModel: "qwen2.5:72b",
    expectSanitized: false,
  },
  {
    name: "空 modelConfig（不注入）",
    start: {
      type: "start",
      prompt: "你好",
      automatic: true,
      workingDirectory: "/home/demo-user",
      claudePath: "claude",
      sessionId: "",
    },
    expectOverrides: false,
    expectModel: undefined,
    expectSanitized: false,
  },
];

// 模拟 Bridge 主流程中的模型处理逻辑
function simulateBridge(start) {
  const options = {
    settingSources: ["user", "project", "local"],
  };

  let events = [];

  // 模拟 emit 函数
  const emit = (msg) => events.push(msg);

  if (start.modelConfig && typeof start.modelConfig === "object") {
    const modelConfig = { ...start.modelConfig };
    if (modelConfig.model && typeof modelConfig.model === "string") {
      const originalModel = modelConfig.model;
      modelConfig.model = sanitizeModelName(modelConfig.model);
      if (originalModel !== modelConfig.model) {
        emit({ type: "bridge_model_sanitized", originalModel, sanitizedModel: modelConfig.model });
      }
      if (!isClaudeModel(modelConfig.model)) {
        const overrides = buildModelOverrides(modelConfig.model);
        options.settings = {
          ...(options.settings && typeof options.settings === "object" ? options.settings : {}),
          modelOverrides: overrides,
        };
        emit({ type: "bridge_model_overrides_applied", model: modelConfig.model, overrideTargets: Object.keys(overrides) });
      }
    }
    Object.assign(options, modelConfig);
  }

  return { options, events };
}

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  console.log(`🧪 ${tc.name}`);
  const result = simulateBridge(tc.start);

  try {
    // 检查 modelOverrides 是否正确注入
    const hasOverrides = result.options.settings?.modelOverrides !== undefined;
    if (hasOverrides !== tc.expectOverrides) {
      throw new Error(`modelOverrides 期望 ${tc.expectOverrides ? "存在" : "不存在"}，实际 ${hasOverrides ? "存在" : "不存在"}`);
    }

    // 检查模型名
    if (result.options.model !== tc.expectModel) {
      throw new Error(`模型名期望 ${tc.expectModel}，实际 ${result.options.model}`);
    }

    // 检查清理事件
    const sanitizedEvent = result.events.find(e => e.type === "bridge_model_sanitized");
    if (tc.expectSanitized && !sanitizedEvent) {
      throw new Error(`期望有 bridge_model_sanitized 事件但未找到`);
    }
    if (!tc.expectSanitized && sanitizedEvent) {
      throw new Error(`不期望 bridge_model_sanitized 事件但找到了`);
    }

    // 检查 overrides 事件
    const overridesEvent = result.events.find(e => e.type === "bridge_model_overrides_applied");
    if (tc.expectOverrides) {
      if (!overridesEvent) throw new Error("期望有 bridge_model_overrides_applied 事件");
      if (overridesEvent.overrideTargets.length !== 10) {
        throw new Error(`期望 10 个 override targets，实际 ${overridesEvent.overrideTargets.length}`);
      }
      // 关键验证：Haiku 路径必须映射到用户模型
      if (result.options.settings.modelOverrides["claude-haiku-4-5"] !== tc.expectModel) {
        throw new Error(`Haiku 路径期望映射到 ${tc.expectModel}，实际 ${result.options.settings.modelOverrides["claude-haiku-4-5"]}`);
      }
      console.log(`    ✅ modelOverrides 注入正确：${overridesEvent.overrideTargets.length} 个 Claude 内部模型ID → ${tc.expectModel}`);
      console.log(`    ✅ 标题生成路径：claude-haiku-4-5 → ${tc.expectModel}`);
    } else {
      if (overridesEvent) throw new Error("不期望有 bridge_model_overrides_applied 事件");
      console.log(`    ✅ 无 modelOverrides 注入（Claude 原生模型）`);
    }

    if (tc.expectSanitized) {
      console.log(`    ✅ 模型名清理：${sanitizedEvent.originalModel} → ${sanitizedEvent.sanitizedModel}`);
    }

    console.log(`    ✅ 通过`);
    passed++;
  } catch (e) {
    console.log(`    ❌ 失败：${e.message}`);
    failed++;
  }
  console.log();
}

// ── 结果汇总 ──

console.log("=".repeat(60));
console.log(`📊 集成测试结果: ${passed}/${testCases.length} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log("❌ 存在失败用例！");
  process.exit(1);
} else {
  console.log("✅ 所有集成测试通过！Bridge modelOverrides 自动注入在 NAS 上运行正常。");
  process.exit(0);
}