"use strict";

/**
 * Claude 适配器契约 — 定义合法的回调字段白名单。
 *
 * 所有通过适配器传入的回调必须在 STANDARD_CALLBACKS 列表中，
 * 否则 assertCallbacks() 会立即抛出错误。
 */

const STANDARD_CALLBACKS = Object.freeze([
  "onDelta",
  "onUploadProgress",
  "onToolEvent",
  "onUsage",
  "onStatus",
  "onSessionId",
  "onTurnComplete",
  "onPermissionRequest",
  "onUnknownHost",
  "onAudit",
  "onLog"
]);

function assertCallbacks(callbacks) {
  if (!callbacks || typeof callbacks !== "object") return;
  const unknown = Object.keys(callbacks).filter((key) => !STANDARD_CALLBACKS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`未知的回调字段：${unknown.join("、")}。合法字段：${STANDARD_CALLBACKS.join("、")}。`);
  }
}

module.exports = { STANDARD_CALLBACKS, assertCallbacks };