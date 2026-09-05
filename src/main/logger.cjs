"use strict";

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 2 * 1024 * 1024;
const PRIVATE_KEYS = /password|secret|token|prompt|message|content|data|apiKey|authKey|key|community|credential/i;
const CREDENTIAL_IN_URL = /\/\/[^/:]+:[^/@]+@/;

function logPath() {
  const { app } = require("electron");
  return path.join(app.getPath("logs"), "agent-chat-pro.log");
}

function writeLog(event, details = {}) {
  try {
    const target = logPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfNeeded(target);
    fs.appendFileSync(target, JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...sanitize(details)
    }) + "\n", "utf8");
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
