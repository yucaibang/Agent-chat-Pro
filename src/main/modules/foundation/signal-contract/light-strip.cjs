"use strict.";

/**
 * 信号灯条 — 将抽象信号状态映射到 16 盏灯的物理灯带。
 *
 * UI 层隐藏（信号灯条不可见），但后端通道保留，
 * 用于未来启用时直接对接。
 *
 * 四组分配：
 *   foundation (软件底座) — 灯 1-4
 *   conversation (对话通讯) — 灯 5-8
 *   agent (Agent) — 灯 9-12
 *   status (状态监控) — 灯 13-16
 *
 * 每组第一盏是主灯（显示组名），后续是子操作灯。
 */

const GROUPS = Object.freeze({
  foundation: { label: "软件底座", start: 0, count: 4 },
  conversation: { label: "对话通讯", start: 4, count: 4 },
  agent: { label: "Agent", start: 8, count: 4 },
  status: { label: "状态监控", start: 12, count: 4 }
});

const TOTAL_LIGHTS = 16;
const DEFAULT_VISIBLE_TRANSITION_MS = 200;
const SUCCESS_HOLD_MS = 900;

function createLightStrip(options = {}) {
  const { onLog } = options;
  const lights = new Array(TOTAL_LIGHTS).fill(null);
  // null = 未使用，{ group, label, light, contract, requestId, startedAt } = 已分配
  const transitionQueue = [];
  let repairPending = false;

  function log(detail) {
    if (typeof onLog === "function") onLog("light-strip", detail);
  }

  function allocate(groupKey, label, contractInfo, requestId) {
    const group = GROUPS[groupKey];
    if (!group) return null;
    // 找组内空灯位
    for (let i = group.start; i < group.start + group.count; i++) {
      if (lights[i] === null) {
        lights[i] = {
          group: groupKey,
          label,
          light: "orange",
          contract: contractInfo,
          requestId,
          startedAt: Date.now()
        };
        log({ action: "allocate", index: i, label, group: groupKey });
        return i;
      }
    }
    // 组满了，复用主灯位
    const mainIndex = group.start;
    lights[mainIndex] = {
      group: groupKey,
      label,
      light: "orange",
      contract: contractInfo,
      requestId,
      startedAt: Date.now()
    };
    log({ action: "reallocate", index: mainIndex, label, group: groupKey });
    return mainIndex;
  }

  function setGreen(index) {
    if (index < 0 || index >= TOTAL_LIGHTS || !lights[index]) return;
    lights[index].light = "green";
    log({ action: "set-green", index, label: lights[index].label });
  }

  function setRed(index) {
    if (index < 0 || index >= TOTAL_LIGHTS || !lights[index]) return;
    lights[index].light = "red";
    repairPending = true;
    log({ action: "set-red", index, label: lights[index].label });
  }

  function setGrey(index) {
    if (index < 0 || index >= TOTAL_LIGHTS || !lights[index]) return;
    lights[index].light = "grey";
    log({ action: "set-grey", index, label: lights[index].label });
    // 灰色灯位立即回收
    lights[index] = null;
  }

  function clear(index) {
    if (index < 0 || index >= TOTAL_LIGHTS) return;
    lights[index] = null;
    log({ action: "clear", index });
  }

  function clearAll() {
    for (let i = 0; i < TOTAL_LIGHTS; i++) lights[i] = null;
    repairPending = false;
    log({ action: "clear-all" });
  }

  function snapshot() {
    return lights.map((entry, index) => ({
      index,
      active: entry !== null,
      group: entry?.group || null,
      label: entry?.label || null,
      light: entry?.light || null,
      contract: entry?.contract || null,
      requestId: entry?.requestId || null
    }));
  }

  function isRepairPending() {
    return repairPending;
  }

  return Object.freeze({
    allocate,
    setGreen,
    setRed,
    setGrey,
    clear,
    clearAll,
    snapshot,
    isRepairPending,
    GROUPS,
    TOTAL_LIGHTS
  });
}

module.exports = { createLightStrip, GROUPS, TOTAL_LIGHTS };