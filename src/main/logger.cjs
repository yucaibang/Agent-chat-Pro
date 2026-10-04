"use strict";

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 2 * 1024 * 1024;
const PRIVATE_KEYS = /password|secret|token|prompt|message|content|data|apiKey|authKey|key|community|credential/i;
const CREDENTIAL_IN_URL = /\/\/[^/:]+:[^/@]+@/;
// v3.16.3 日志降噪：同一事件串（序列化后完全相同）在 800ms 窗口内重复提交时只落盘一次。
// 背景：信号链在 SSH 流事件上存在同毫秒双写回环，逐 token 全量落盘导致日志 2MB/天灌满轮转。
let _lastLogPayload = "";
let _lastLogAt = 0;

function logPath() {
  const { app } = require("electron");
  return path.join(app.getPath("logs"), "agent-chat-pro.log");
}

function writeLog(event, details = {}) {
  try {
    const body = { event, ...sanitize(details) };
    // v3.16.3 降噪：800ms 内与上一条完全相同的串只落盘一次（payload 不含 time，保证判重可比）
    const payload = JSON.stringify(body);
    const now = Date.now();
    if (payload === _lastLogPayload && now - _lastLogAt < 800) return;
    _lastLogPayload = payload;
    _lastLogAt = now;
    const target = logPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfNeeded(target);
    fs.appendFileSync(target, JSON.stringify({ time: new Date().toISOString(), ...body }) + "\n", "utf8");
  } catch (error) {
    console.error("Diagnostic logging failed:", error);
  }
}

function rotateIfNeeded(target) {
  try {
    if (fs.statSync(target).size < MAX_BYTES) return;
    fs.rmSync(target + ".1", { force: true });
    fs.renameSync(target, target + ".1");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function sanitize(value, key = "") {
  if (PRIVATE_KEYS.test(key)) return "[REDACTED]";
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message), stack: value.stack ? sanitize(value.stack) : undefined };
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  }
  if (typeof value === "string") {
    // 脱敏 URL 中嵌入的凭据 (user:pass@host → [REDACTED]@host)
    if (CREDENTIAL_IN_URL.test(value)) {
      return value.replace(/\/\/([^/:]+):([^/@]+)@/, "//$1:[REDACTED]@");
    }
    if (value.length > 500) return value.slice(0, 500) + "…";
  }
  return value;
}

module.exports = { logPath, sanitize, writeLog };
