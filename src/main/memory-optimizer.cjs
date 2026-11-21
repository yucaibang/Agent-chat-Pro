"use strict";
// v3.45.3 百宝箱·内存优化：主进程 V8 垃圾回收 + 前后堆快照 + 应用内存体检聚合。
// 设计（与 voice-transcribe.cjs 同款环境无关模式）：
//   - gc 由 main.cjs 注入：v8.setFlagsFromString("--expose-gc") 后取 global.gc；本模块自身
//     不开 V8 flag（模块可被 vm 单测直接 require，flag 语义不受污染）。
//   - metrics = app.getAppMetrics() 快照（{ type, pid, memory: { workingSetSize } }，KB 口径），
//     按 type 聚合成「主 / 渲染 / GPU / 服务 / 其他」体检行 + 总量。

const MB = 1048576;
const GROUPS = [
  ["Browser", "主"],
  ["Renderer", "渲染"],
  ["GPU", "GPU"],
  ["Utility", "服务"],
];

function kbToMb(kb) {
  return Math.round(((Number(kb) || 0) / 1024) * 10) / 10;
}

/** getHeapStatistics 快照 → used_heap_size（MB 口径） */
function heapUsedMb(statistics) {
  return Math.round(((Number(statistics?.used_heap_size) || 0) / MB) * 10) / 10;
}

/** type 聚合工作集（KB → MB）：主/渲染/GPU/服务各一行 + 其他兜底 + 总量 */
function summarizeMetrics(metrics = []) {
  const list = Array.isArray(metrics) ? metrics : [];
  const groups = {};
  let totalKb = 0;
  for (const item of list) {
    const kb = Number(item?.memory?.workingSetSize) || 0;
    totalKb += kb;
    const type = String(item?.type || "Other");
    groups[type] = (groups[type] || 0) + kb;
  }
  const parts = [];
  for (const [type, label] of GROUPS) {
    if (groups[type]) parts.push(`${label} ${kbToMb(groups[type])} MB`);
  }
  const known = GROUPS.map(([type]) => type);
  const restKb = Object.keys(groups).filter((type) => !known.includes(type)).reduce((sum, type) => sum + groups[type], 0);
  if (restKb) parts.push(`其他 ${kbToMb(restKb)} MB`);
  return { memoryParts: parts, totalMb: kbToMb(totalKb) };
}

/**
 * 执行一轮内存优化：before 堆快照 → 注入的 gc()（可空=只体检不回收）→ after 快照 → 差值报告。
 * 返回 { ok, gcRan, beforeMb, afterMb, freedMb, memoryParts, totalMb }。
 */
function optimizeMemory({ gc = null, metrics = [] } = {}) {
  const v8 = require("v8");
  const before = v8.getHeapStatistics();
  let gcRan = false;
  if (typeof gc === "function") {
    gc();
    gcRan = true;
  }
  const after = v8.getHeapStatistics();
  const beforeMb = heapUsedMb(before);
  const afterMb = heapUsedMb(after);
  const freedMb = Math.max(0, Math.round((beforeMb - afterMb) * 10) / 10);
  const { memoryParts, totalMb } = summarizeMetrics(metrics);
  return { ok: true, gcRan, beforeMb, afterMb, freedMb, memoryParts, totalMb };
}

module.exports = { optimizeMemory, summarizeMetrics };
