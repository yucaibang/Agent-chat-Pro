"use strict.";

/**
 * 运行时兼容性检测 — 检查 Claude CLI / SDK 版本与 Bridge 的兼容性。
 *
 * 静态检查：比对 CLI 版本与 SDK 基线版本。
 * 返回：matched / review-needed / mismatch / unknown / not-applicable
 */

const SDK_BASELINE_VERSION = "0.3.263";

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function bridgeCompatibility(cliVersion, sdkVersion) {
  if (!cliVersion) return "unknown";
  if (!sdkVersion) return "not-applicable";

  const cliCmp = compareVersions(cliVersion, sdkVersion);
  if (cliCmp >= 0) return "matched";

  // 小版本差距 = review-needed，大版本差距 = mismatch
  const cliParts = String(cliVersion).split(".").map(Number);
  const sdkParts = String(sdkVersion).split(".").map(Number);
  if (cliParts[0] < sdkParts[0]) return "mismatch";
  if (cliParts[1] < sdkParts[1] - 1) return "mismatch";
  return "review-needed";
}

function evaluateLiveCompatibility(results) {
  if (!results || typeof results !== "object") return { compatible: false, score: 0, details: [] };

  const checks = [
    { key: "bridgeStart", label: "Bridge 启动", weight: 20 },
    { key: "sessionEstablished", label: "会话建立", weight: 15 },
    { key: "streamingReply", label: "流式回复", weight: 15 },
    { key: "firstReply", label: "首次响应", weight: 10 },
    { key: "followUpReceived", label: "追问接收", weight: 10 },
    { key: "followUpReply", label: "追问回复", weight: 10 },
    { key: "permissionPolicy", label: "权限策略", weight: 5 },
    { key: "toolStart", label: "工具开始", weight: 5 },
    { key: "toolComplete", label: "工具完成", weight: 5 },
    { key: "normalTermination", label: "正常终态", weight: 5 }
  ];

  let score = 0;
  const details = [];
  for (const check of checks) {
    const passed = Boolean(results[check.key]);
    if (passed) score += check.weight;
    details.push({ ...check, passed });
  }

  return {
    compatible: score >= 80,
    score,
    details
  };
}

module.exports = { SDK_BASELINE_VERSION, compareVersions, bridgeCompatibility, evaluateLiveCompatibility };