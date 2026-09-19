"use strict";

const VERSION_PATTERN = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\b|\s)/;

function parseVersion(value) {
  const match = String(value || "").match(VERSION_PATTERN);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : "";
}

function compareVersions(left, right) {
  const a = parseVersion(left).split(".").map(Number);
  const b = parseVersion(right).split(".").map(Number);
  if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function bridgeCompatibility({ cliVersion, sdkVersion, sdkClaudeCodeVersion } = {}) {
  const current = parseVersion(cliVersion);
  const baseline = parseVersion(sdkClaudeCodeVersion);
  if (!sdkVersion) return {
    state: "not-applicable",
    label: "当前模式未使用增强 Bridge SDK",
    checked: false
  };
  if (!current || !baseline) return {
    state: "unknown",
    label: "SDK 或 Claude 版本无法识别，无法判断匹配情况",
    checked: false
  };
  if (current === baseline) return {
    state: "matched",
    label: `已匹配：SDK ${sdkVersion} 对应 Claude ${baseline}`,
    checked: true
  };
  const currentParts = current.split(".");
  const baselineParts = baseline.split(".");
  if (currentParts[0] === baselineParts[0] && currentParts[1] === baselineParts[1]) return {
    state: "review-needed",
    label: `同一 ${currentParts[0]}.${currentParts[1]} 主线：SDK 基线 ${baseline}，当前 Claude ${current}；建议完成一次真实聊天验证`,
    checked: false
  };
  return {
    state: "mismatch",
    label: `版本主线不同：SDK 基线 ${baseline}，当前 Claude ${current}`,
    checked: false
  };
}

function evaluateLiveCompatibility({ cliVersion, sdkVersion, sdkClaudeCodeVersion, checks } = {}) {
  const normalizedChecks = Array.isArray(checks)
    ? checks.map((check) => ({
      id: String(check?.id || "unknown"),
      label: String(check?.label || check?.id || "未知检查"),
      passed: check?.passed === true,
      detail: String(check?.detail || "")
    }))
    : [];
  const failed = normalizedChecks.filter((check) => !check.passed);
  const current = parseVersion(cliVersion);
  const baseline = parseVersion(sdkClaudeCodeVersion);
  const versionAligned = Boolean(current && baseline && current === baseline);
  const versionNote = current && baseline
    ? versionAligned
      ? `版本信息一致：Claude ${current}，SDK 基线 ${baseline}`
      : `版本信息不同：Claude ${current}，SDK 基线 ${baseline}；版本差异不单独判失败`
    : "版本基线不完整；以真实功能测试为准";
  if (!sdkVersion) return {
    state: "not-applicable",
    label: "当前模式未使用增强 Bridge SDK",
    checked: false,
    versionAligned: false,
    versionNote,
    checks: normalizedChecks
  };
  if (!normalizedChecks.length || failed.length) return {
    state: "mismatch",
    label: `实测未完全通过：${failed.length ? failed.map((check) => `${check.label}${check.detail ? `（${check.detail}）` : ""}`).join("；") : "没有取得测试结果"}`,
    checked: true,
    versionAligned,
    versionNote,
    checks: normalizedChecks
  };
  return {
    state: "matched",
    label: `实测匹配：SDK ${sdkVersion} 的 Bridge 启动、首次回复、会话、流式输出、同会话追问、权限策略、工具执行和正常终态全部通过。${versionNote}`,
    checked: true,
    versionAligned,
    versionNote,
    checks: normalizedChecks
  };
}

module.exports = { bridgeCompatibility, compareVersions, evaluateLiveCompatibility, parseVersion };
