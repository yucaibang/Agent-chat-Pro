"use strict";
// v3.45.3 百宝箱·内存优化：主进程 V8 垃圾回收 + 前后堆快照 + 应用内存体检聚合。
// 设计（与 voice-transcribe.cjs 同款环境无关模式）：
//   - gc 由 resolveGc()（v3.45.4）提供：优先取启动期 global.gc，否则 vm 新 context 方案；
//     main.cjs 经注入传参调用（不再裸 setFlagsFromString——v3.45.4 Bug#1 详见 resolveGc 注释）。
//     模块顶层仍无副作用，vm 单测直接 require 不受污染。
//   - metrics = app.getAppMetrics() 快照（{ type, pid, memory: { workingSetSize } }，KB 口径），
//     按 type 聚合成「主 / 渲染 / GPU / 服务 / 其他」体检行 + 总量。

const MB = 1048576;
const GROUPS = [
  ["Browser", "主"],
  ["Renderer", "渲染"],
  ["GPU", "GPU"],
  ["Utility", "服务"],
];

// v3.45.4 自查修复（Bug#1）：--expose-gc 是 V8 bootstrap flag——运行时
// v8.setFlagsFromString() 只改 flag 位、不会回头给已存在的全局对象补挂 gc
// （实测 Node v22：动态设置后 typeof global.gc === "undefined"；只有进程启动时
// 带 flag 才有 global.gc）。main.cjs 旧写法因此恒拿不到 gc → 垃圾回收从不执行。
// 修法（实测生效）：vm 新建 context 的全局初始化会重新读当前 flag 位把 gc 注册进
// 新 context → 从那里取出函数引用，调的是同一 V8 isolate 的全部堆，跨 context 生效。
// 结果按探测一次缓存：undefined=未探测 / null=不可用（如实上报）/ function=可用。
let cachedGc; // undefined=未探测；null=不可用；function=已就绪
function resolveGc() {
  if (cachedGc !== undefined) return cachedGc;
  if (typeof global.gc === "function") {
    cachedGc = global.gc; // 启动期已开 flag 的环境（--expose-gc 进程参数）直接用
    return cachedGc;
  }
  try {
    const vm = require("vm");
    if (typeof vm.createContext !== "function") throw new Error("vm 不可用");
    require("v8").setFlagsFromString("--expose-gc");
    const found = vm.runInContext("gc", vm.createContext({}));
    cachedGc = typeof found === "function" ? found : null;
  } catch {
    cachedGc = null; // 取不到如实上报：只体检不回收，渲染层按 gcRan=false 呈现
  }
  return cachedGc;
}

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

module.exports = { optimizeMemory, summarizeMetrics, resolveGc };
