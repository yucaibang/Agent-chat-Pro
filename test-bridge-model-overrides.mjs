/**
 * Bridge modelOverrides 自动注入 — 单元测试
 *
 * 测试 agent-sdk-bridge.mjs 中的模型兼容逻辑：
 *   - sanitizeModelName(): 清理模型名后缀
 *   - isClaudeModel(): 检测是否为 Claude 原生模型
 *   - buildModelOverrides(): 构建模型覆盖映射
 *   - 非Claude模型自动注入 modelOverrides
 *   - Claude模型不注入 modelOverrides
 */

// ── 直接复制待测函数（与 bridge 源码保持一致） ──

function sanitizeModelName(model) {
  if (typeof model !== "string") return model;
  return model.replace(/\[[^\]]*\]$/g, "").trim() || model;
}

const CLAUDE_MODEL_PREFIXES = ["claude-", "anthropic-"];

const CLAUDE_INTERNAL_MODEL_IDS = [
  // 当前代（2025）
  "claude-haiku-4-5",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5",
  "claude-opus-4-20250514",
  "claude-opus-4-5",
  // 上一代（2024）
  "claude-3-5-haiku-20241022",
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229",
  "claude-3-haiku-20240307",
  "claude-3-5-sonnet-20240620",
];

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

// ── 测试框架 ──

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failures.push(name);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "断言失败");
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || ""} 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`);
  }
}

// ── sanitizeModelName 测试 ──

console.log("\n🧪 sanitizeModelName 测试");
console.log("─".repeat(50));

test("清理 [1m] 后缀", () => {
  assertEqual(sanitizeModelName("glm-5.1:cloud[1m]"), "glm-5.1:cloud");
});

test("清理 [128k] 后缀", () => {
  assertEqual(sanitizeModelName("deepseek-chat[128k]"), "deepseek-chat");
});

test("Claude 模型名不变", () => {
  assertEqual(sanitizeModelName("claude-sonnet-4-20250514"), "claude-sonnet-4-20250514");
});

test("无后缀模型名不变", () => {
  assertEqual(sanitizeModelName("glm-5.1:cloud"), "glm-5.1:cloud");
});

test("空字符串返回空", () => {
  assertEqual(sanitizeModelName(""), "");
});

test("非字符串原样返回", () => {
  assertEqual(sanitizeModelName(123), 123);
  assertEqual(sanitizeModelName(null), null);
});

// ── isClaudeModel 测试 ──

console.log("\n🧪 isClaudeModel 测试");
console.log("─".repeat(50));

test("claude-sonnet-4-20250514 → true", () => {
  assert(isClaudeModel("claude-sonnet-4-20250514") === true);
});

test("claude-haiku-4-5 → true", () => {
  assert(isClaudeModel("claude-haiku-4-5") === true);
});

test("claude-opus-4-5 → true", () => {
  assert(isClaudeModel("claude-opus-4-5") === true);
});

test("glm-5.1:cloud → false", () => {
  assert(isClaudeModel("glm-5.1:cloud") === false);
});

test("deepseek-chat → false", () => {
  assert(isClaudeModel("deepseek-chat") === false);
});

test("grok-3 → false", () => {
  assert(isClaudeModel("grok-3") === false);
});

test("anthropic- 前缀 → true", () => {
  assert(isClaudeModel("anthropic-claude") === true);
});

test("空字符串 → true（安全默认）", () => {
  assert(isClaudeModel("") === true);
});

test("null → true（安全默认）", () => {
  assert(isClaudeModel(null) === true);
});

test("大小写不敏感", () => {
  assert(isClaudeModel("Claude-Sonnet-4") === true);
  assert(isClaudeModel("CLAUDE-HAIKU-4-5") === true);
});

// ── buildModelOverrides 测试 ──

console.log("\n🧪 buildModelOverrides 测试");
console.log("─".repeat(50));

test("glm-5.1:cloud → 10个映射", () => {
  const overrides = buildModelOverrides("glm-5.1:cloud");
  assertEqual(Object.keys(overrides).length, 10);
  assertEqual(overrides["claude-haiku-4-5"], "glm-5.1:cloud");
  assertEqual(overrides["claude-sonnet-4-20250514"], "glm-5.1:cloud");
  assertEqual(overrides["claude-opus-4-20250514"], "glm-5.1:cloud");
});

test("deepseek-chat → 所有映射值相同", () => {
  const overrides = buildModelOverrides("deepseek-chat");
  assertEqual(Object.keys(overrides).length, 10);
  for (const key of Object.keys(overrides)) {
    assertEqual(overrides[key], "deepseek-chat", `${key}`);
  }
});

test("所有 Claude 内部 ID 都有映射", () => {
  const overrides = buildModelOverrides("test-model");
  for (const id of CLAUDE_INTERNAL_MODEL_IDS) {
    assert(overrides[id] === "test-model", `${id} 应有映射`);
  }
});

// ── Bridge 主流程模拟测试 ──

console.log("\n🧪 Bridge 主流程模拟测试");
console.log("─".repeat(50));

function simulateBridgeModelHandling(startModelConfig) {
  const options = {
    cwd: "/home/demo-user",
    permissionMode: "bypassPermissions",
    settingSources: ["user", "project", "local"],
  };

  if (startModelConfig && typeof startModelConfig === "object") {
    const modelConfig = { ...startModelConfig };
    if (modelConfig.model && typeof modelConfig.model === "string") {
      const originalModel = modelConfig.model;
      modelConfig.model = sanitizeModelName(modelConfig.model);
      let sanitized = originalModel !== modelConfig.model;
      let overridesApplied = false;
      let overrideTargets = [];

      if (!isClaudeModel(modelConfig.model)) {
        const overrides = buildModelOverrides(modelConfig.model);
        options.settings = {
          ...(options.settings && typeof options.settings === "object" ? options.settings : {}),
          modelOverrides: overrides,
        };
        overridesApplied = true;
        overrideTargets = Object.keys(overrides);
      }

      return {
        options,
        originalModel,
        sanitizedModel: modelConfig.model,
        wasSanitized: sanitized,
        overridesApplied,
        overrideTargets,
      };
    }
  }

  return { options, overridesApplied: false };
}

test("非Claude模型 → 注入 modelOverrides", () => {
  const result = simulateBridgeModelHandling({ model: "glm-5.1:cloud" });
  assert(result.overridesApplied === true, "应注入 modelOverrides");
  assert(result.options.settings.modelOverrides["claude-haiku-4-5"] === "glm-5.1:cloud");
  assert(result.options.settings.modelOverrides["claude-sonnet-4-20250514"] === "glm-5.1:cloud");
});

test("Claude模型 → 不注入 modelOverrides", () => {
  const result = simulateBridgeModelHandling({ model: "claude-sonnet-4-20250514" });
  assert(result.overridesApplied === false, "Claude模型不应注入 modelOverrides");
  assert(result.options.settings === undefined, "不应有 settings");
});

test("带后缀模型 → 先清理后映射", () => {
  const result = simulateBridgeModelHandling({ model: "glm-5.1:cloud[1m]" });
  assert(result.wasSanitized === true, "应清理后缀");
  assertEqual(result.sanitizedModel, "glm-5.1:cloud");
  assert(result.overridesApplied === true, "应注入 modelOverrides");
  assert(result.options.settings.modelOverrides["claude-haiku-4-5"] === "glm-5.1:cloud");
});

test("空模型名 → 不注入 modelOverrides", () => {
  const result = simulateBridgeModelHandling({ model: "" });
  assert(result.overridesApplied === false, "空模型名不应注入");
});

test("无 modelConfig → 不注入 modelOverrides", () => {
  const result = simulateBridgeModelHandling(undefined);
  assert(result.overridesApplied === false, "无 modelConfig 不应注入");
});

test("DeepSeek 模型 → 完整映射", () => {
  const result = simulateBridgeModelHandling({ model: "deepseek-chat" });
  assert(result.overridesApplied === true, "应注入 modelOverrides");
  assertEqual(result.overrideTargets.length, 10, "应覆盖10个Claude模型ID");
  assert(result.options.settings.modelOverrides["claude-haiku-4-5"] === "deepseek-chat");
});

// ── 真实场景测试 ──

console.log("\n🧪 真实场景测试（与 Agent Orbit 相同配置）");
console.log("─".repeat(50));

test("Agent Orbit 场景: glm-5.1:cloud → 解决 unrecognized_model", () => {
  const result = simulateBridgeModelHandling({ model: "glm-5.1:cloud" });
  assert(result.overridesApplied === true, "应注入 modelOverrides");

  // 关键验证：标题生成路径（Haiku）应映射到 glm-5.1:cloud
  assert(
    result.options.settings.modelOverrides["claude-haiku-4-5"] === "glm-5.1:cloud",
    "标题生成路径：claude-haiku-4-5 → glm-5.1:cloud"
  );
  // 主模型路径（Sonnet）也应映射
  assert(
    result.options.settings.modelOverrides["claude-sonnet-4-20250514"] === "glm-5.1:cloud",
    "主模型路径：claude-sonnet-4-20250514 → glm-5.1:cloud"
  );
  console.log(`    → 映射覆盖了 ${result.overrideTargets.length} 个 Claude 内部模型ID`);
  console.log(`    → 标题生成不再报 unrecognized_model ✅`);
});

test("Ollama 场景: qwen2.5:72b → 解决 unrecognized_model", () => {
  const result = simulateBridgeModelHandling({ model: "qwen2.5:72b" });
  assert(result.overridesApplied === true, "应注入 modelOverrides");
  assert(result.options.settings.modelOverrides["claude-haiku-4-5"] === "qwen2.5:72b");
});

test("带上下文窗口标记: deepseek-chat[128k] → 清理+映射", () => {
  const result = simulateBridgeModelHandling({ model: "deepseek-chat[128k]" });
  assert(result.wasSanitized === true, "应清理后缀");
  assertEqual(result.sanitizedModel, "deepseek-chat");
  assert(result.overridesApplied === true, "应注入 modelOverrides");
  assert(result.options.settings.modelOverrides["claude-haiku-4-5"] === "deepseek-chat");
});

// ── 结果汇总 ──

console.log("\n" + "=".repeat(50));
console.log(`📊 测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
if (failed > 0) {
  console.log("❌ 失败用例:");
  failures.forEach(f => console.log(`   - ${f}`));
  process.exit(1);
} else {
  console.log("✅ 所有测试通过！modelOverrides 自动注入逻辑正确。");
  process.exit(0);
}