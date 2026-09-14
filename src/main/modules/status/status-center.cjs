"use strict";

/**
 * 状态中心 — 门面对象，整合状态规范化、审计日志和观察者。
 *
 * 提供 normalize()、auditToolDetails()、journalEntry()、signalEntry()、toolLifecycleEntry()
 * 等统一入口，替代 main.cjs 中分散的日志调用。
 */

const { auditToolDetails, normalizeStatusEvent } = require("../../status-event-normalizer.cjs");

function createStatusCenter({ onGap } = {}) {
  const observer = createStatusSignalObserver({ enabled: true, onGap });
  return Object.freeze({
    normalize(event, config) {
      const normalized = normalizeStatusEvent(event, { connection: config });
      if (config?.statusSignalCapture) observer.observe(normalized);
      return normalized;
    },
    auditToolDetails,
    journalEntry(entry) {
      return {
        type: "journalEntry",
        timestamp: Date.now(),
        ...entry
      };
    },
    signalEntry(entry) {
      return {
        type: "signalEntry",
        timestamp: Date.now(),
        ...entry
      };
    },
    toolLifecycleEntry(entry) {
      return {
        type: "toolLifecycleEntry",
        timestamp: Date.now(),
        ...entry
      };
    }
  });
}

function createStatusSignalObserver({ enabled = true, onGap } = {}) {
  if (!enabled) {
    return Object.freeze({ observe: () => {}, report: () => ({ total: 0, classified: 0, unclassified: 0, review: 0 }), reset: () => {} });
  }
  const byRequest = new Map();

  function observe(normalized) {
    if (!normalized?.requestId) return;
    const requestId = normalized.requestId;
    if (!byRequest.has(requestId)) byRequest.set(requestId, { classified: 0, unclassified: 0, review: 0 });
    const bucket = byRequest.get(requestId);
    const disposition = normalized.disposition || "unclassified";
    if (bucket[disposition] !== undefined) bucket[disposition]++;
    else bucket.unclassified++;
    if (disposition === "unclassified" || disposition === "review") {
      if (typeof onGap === "function") onGap({ requestId, disposition, normalized });
    }
  }

  function report() {
    let total = 0, classified = 0, unclassified = 0, review = 0;
    for (const bucket of byRequest.values()) {
      classified += bucket.classified || 0;
      unclassified += bucket.unclassified || 0;
      review += bucket.review || 0;
    }
    total = classified + unclassified + review;
    return { total, classified, unclassified, review };
  }

  function reset() {
    byRequest.clear();
  }

  return Object.freeze({ observe, report, reset });
}

module.exports = { createStatusCenter, createStatusSignalObserver };