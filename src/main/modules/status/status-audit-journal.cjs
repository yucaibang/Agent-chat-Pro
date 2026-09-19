"use strict";

const { AUDIT_FILE_FORMATS, AUDIT_TOOL_ACTIONS } = require("../../status-event-normalizer.cjs");

const REQUEST_ID = /^[0-9a-f-]{36}$/i;
const STATES = new Set(["idle", "connected", "working", "proxy", "danger", "error"]);
const STATUSES = new Set(["connecting", "reconnecting", "connected", "continuing", "stopping", "local-starting", "running", "completed", "failed", "denied", "waiting", "allowed", "started", "finished", "cancelled"]);
const DIRECTIONS = new Set(["renderer-sent", "preload-sent", "main-received", "executor-emitted", "main-sent", "preload-received", "renderer-received"]);
const SIGNALS = new Set(["chat-send", "chat-cancel", "chat-delta", "chat-event", "runner-event", "transport-event", "request-outcome"]);
const DISPOSITIONS = new Set(["received", "accepted", "current", "stale", "missing-answer", "invalid", "attempt", "emitted", "started", "completed", "failed", "cancelled"]);
const EVENT_TYPES = new Set(["connection", "upload", "tool", "permission", "usage", "delta", "lifecycle", "transport"]);

function safeToken(value, fallback = "") {
  return String(value || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80) || fallback;
}

function requestId(value) {
  return REQUEST_ID.test(String(value || "")) ? value : "";
}

function numberInRange(value, maximum) {
  return Math.max(0, Math.min(maximum, Number(value) || 0));
}

function validFormats(value) {
  return Array.isArray(value) ? [...new Set(value.filter((format) => AUDIT_FILE_FORMATS.has(format)))].slice(0, 16) : [];
}

function validTargets(value) {
  return Array.isArray(value) ? [...new Set(value.map((target) => safeToken(target)).filter(Boolean))].slice(0, 8) : [];
}

function journalEntry(input = {}) {
  const outcomes = new Set(["applied", "suppressed"]);
  return {
    requestId: requestId(input.requestId),
    outcome: outcomes.has(input.outcome) ? input.outcome : "applied",
    state: STATES.has(input.state) ? input.state : "idle",
    previousState: STATES.has(input.previousState) ? input.previousState : "idle",
    source: String(input.source || "direct").replace(/[^a-z-]/gi, "").slice(0, 40) || "direct",
    label: String(input.label || "其他活动").slice(0, 80)
  };
}

function signalEntry(input = {}) {
  return {
    requestId: requestId(input.requestId),
    direction: DIRECTIONS.has(input.direction) ? input.direction : "renderer-received",
    signal: SIGNALS.has(input.signal) ? input.signal : "chat-event",
    disposition: DISPOSITIONS.has(input.disposition) ? input.disposition : "invalid",
    eventType: EVENT_TYPES.has(input.eventType) ? input.eventType : "",
    eventStatus: STATUSES.has(input.eventStatus) ? input.eventStatus : "",
    toolId: safeToken(input.toolId),
    toolName: safeToken(input.toolName),
    toolStatus: STATUSES.has(input.toolStatus) ? input.toolStatus : "",
    textLength: numberInRange(input.textLength, 10000000),
    attachmentCount: numberInRange(input.attachmentCount, 10),
    attempt: numberInRange(input.attempt, 12),
    uploadPercent: numberInRange(input.uploadPercent, 100),
    transport: safeToken(input.transport),
    parser: new Set(["parsed", "unparsed", "empty"]).has(input.parser) ? input.parser : "",
    rawType: safeToken(input.rawType),
    rawEventType: safeToken(input.rawEventType),
    rawContentKind: safeToken(input.rawContentKind),
    rawLength: numberInRange(input.rawLength, 10000000),
    toolAction: AUDIT_TOOL_ACTIONS.has(input.toolAction) ? input.toolAction : "",
    fileFormats: validFormats(input.fileFormats),
    executionTarget: safeToken(input.executionTarget),
    toolTargets: validTargets(input.toolTargets)
  };
}

function toolLifecycleEntry(input = {}) {
  const tones = new Set(["working", "proxy", "danger", "error"]);
  const statuses = new Set(["running", "completed", "failed", "denied"]);
  const tool = input.tool || {};
  const list = (value) => Array.isArray(value) ? value.slice(0, 30).map((item) => ({
    id: safeToken(item?.id),
    tone: tones.has(item?.tone) ? item.tone : "",
    status: statuses.has(item?.status) ? item.status : ""
  })).filter((item) => item.id) : [];
  return {
    requestId: requestId(input.requestId),
    transition: safeToken(input.transition, "unknown"),
    toolId: safeToken(tool.toolId || tool.id),
    toolName: safeToken(tool.toolName || tool.name),
    toolStatus: statuses.has(tool.toolStatus || tool.status) ? (tool.toolStatus || tool.status) : "",
    toolAction: AUDIT_TOOL_ACTIONS.has(tool.toolAction) ? tool.toolAction : "",
    fileFormats: validFormats(tool.fileFormats),
    toolTargets: validTargets(tool.toolTargets),
    previousState: tones.has(input.previousState) || input.previousState === "idle" || input.previousState === "connected" ? input.previousState : "",
    displayedState: tones.has(input.displayedState) || input.displayedState === "idle" || input.displayedState === "connected" ? input.displayedState : "",
    previousTools: list(input.previousTools),
    activeTools: list(input.activeTools),
    selectedToolId: safeToken(input.selectedToolId),
    selectedToolTone: tones.has(input.selectedToolTone) ? input.selectedToolTone : ""
  };
}

module.exports = { journalEntry, signalEntry, toolLifecycleEntry };
