"use strict";

const GROUPS = Object.freeze({ foundation: "软件底座", conversation: "对话通讯", agent: "Agent", status: "状态监控" });
const LIGHT_COUNT = 16;
const REPAIR_LIGHT_INDEX = LIGHT_COUNT - 1;
const DEFAULT_VISIBLE_TRANSITION_MS = 200;
const LIGHT_STRIP_PROJECTION_CONTRACT = Object.freeze({
  version: 2,
  lampCount: LIGHT_COUNT,
  normalWorkingCapacity: LIGHT_COUNT,
  repairReservedLamp: REPAIR_LIGHT_INDEX + 1,
  repairWorkingCapacity: REPAIR_LIGHT_INDEX,
  greenProjection: "left-contiguous-prefix",
  maximumOrangeLamps: 2,
  orangeProjection: "immediately-after-green-prefix",
  skippedProjection: "journal-only-no-lamp",
  completedProjection: "all-used-lamps-green-before-clear",
  minimumVisibleTransitionMs: DEFAULT_VISIBLE_TRANSITION_MS,
  successHoldMs: 900
});

function groupFor(moduleId) {
  const id = String(moduleId || "");
  if (id.startsWith("foundation.")) return "foundation";
  if (id.startsWith("conversation.")) return "conversation";
  if (id.startsWith("agent.")) return "agent";
  return "status";
}

function rootFor(requestId) { return String(requestId || "").split(":", 1)[0]; }
const LIGHT_STATES = new Set(["orange", "green", "grey", "red"]);
function stateFor(light) {
  const state = String(light || "");
  return LIGHT_STATES.has(state) ? state : "";
}
function invalidLightState(item) {
  return {
    ...item,
    light: "red",
    error: {
      ...(item?.error || {}),
      code: "AO.CONTRACT.INVALID_LIGHT_STATE",
      expected: "orange|green|grey|red",
      actual: String(item?.light ?? "")
    }
  };
}
function isTerminal(state) { return state === "green" || state === "grey"; }
function isUserConversationStart(item) {
  return item?.moduleId === "conversation.turn-orchestrator" && item?.operation === "submit" && stateFor(item?.light) === "orange";
}
function blankLights() { return Array.from({ length: LIGHT_COUNT }, () => ({ state: "idle", label: "等待信号" })); }

function createSignalLightStrip({ publish = () => {}, writeFault = () => {}, setTimer = setTimeout, cancelTimer = clearTimeout, successHoldMs = 900, visibleTransitionMs = DEFAULT_VISIBLE_TRANSITION_MS } = {}) {
  let rootId = "";
  let frozen = false;
  let repairPending = false;
  let chatRound = false;
  let lights = blankLights();
  let nextPosition = 0;
  let positions = new Map();
  let groups = new Map();
  let clearTimer = null;
  let transitionTimer = null;
  let transitionQueue = [];
  let queuedStates = new Map();
  let completeRequestedFor = "";
  const emit = () => publish({ lights: lights.map((light) => ({ ...light })), repairPending, frozen });
  const snapshot = () => ({ lights: lights.map((light) => ({ ...light })), repairPending, frozen });
  const cancelClear = () => { if (clearTimer !== null) { cancelTimer(clearTimer); clearTimer = null; } };
  const cancelTransitions = () => { if (transitionTimer !== null) { cancelTimer(transitionTimer); transitionTimer = null; } transitionQueue = []; queuedStates = new Map(); };
  const workingCapacity = () => repairPending ? REPAIR_LIGHT_INDEX : LIGHT_COUNT;
  const reset = (nextRoot) => {
    cancelClear(); rootId = nextRoot; frozen = false; chatRound = false; completeRequestedFor = ""; lights = blankLights(); nextPosition = 0; positions = new Map(); groups = new Map();
    if (repairPending) lights[REPAIR_LIGHT_INDEX] = { state: "red", label: "上一轮需要检修" };
  };
  const allocate = () => nextPosition < workingCapacity() ? nextPosition++ : -1;
  const majorCanFinish = (group) => {
    const entry = groups.get(group);
    return Boolean(entry && entry.children.size && lights[entry.major]?.state !== "red" && [...entry.children].every((position) => isTerminal(lights[position]?.state)));
  };
  const refreshMajor = (group) => {
    if (!majorCanFinish(group)) return false;
    const entry = groups.get(group);
    if (lights[entry.major]?.state === "green") return false;
    lights[entry.major] = { state: "green", label: GROUPS[group] };
    return true;
  };
  const startGroup = (group) => {
    let entry = groups.get(group);
    if (entry) return entry;
    const major = allocate();
    if (major < 0) return null;
    entry = { major, children: new Set(), starting: true };
    groups.set(group, entry);
    return entry;
  };
  const removeLamp = (position) => {
    if (position < 0 || position >= nextPosition) return;
    for (let index = position; index < nextPosition - 1; index += 1) lights[index] = lights[index + 1];
    nextPosition -= 1;
    lights[nextPosition] = { state: "idle", label: "等待信号" };
    for (const [key, value] of positions.entries()) {
      if (value > position) positions.set(key, value - 1);
    }
    for (const entry of groups.values()) {
      if (entry.major > position) entry.major -= 1;
      entry.children = new Set([...entry.children].map((value) => value > position ? value - 1 : value));
    }
  };
  const moveMajorToFrontier = (entry) => {
    if (entry.major === nextPosition - 1) return;
    removeLamp(entry.major);
    entry.major = allocate();
  };
  const groupContaining = (position) => {
    for (const [group, entry] of groups.entries()) if (entry.children.has(position)) return [group, entry];
    return [null, null];
  };
  const removeSkippedStation = (key) => {
    const position = positions.get(key);
    if (position === undefined) return false;
    const [group, entry] = groupContaining(position);
    positions.delete(key);
    if (entry) entry.children.delete(position);
    removeLamp(position);
    if (!entry) return true;
    if (!entry.children.size) {
      const major = entry.major;
      groups.delete(group);
      removeLamp(major);
    } else if (majorCanFinish(group)) {
      refreshMajor(group);
    }
    return true;
  };
  const hasWorkingStation = () => [...positions.values()].some((position) => lights[position]?.state === "orange");
  const journalFault = (item, errorCode, position) => {
    cancelClear(); frozen = true; repairPending = true;
    writeFault({
      requestId: rootId,
      lampIndex: position + 1,
      moduleId: item?.moduleId || "foundation.signal-light-strip",
      operation: item?.operation || "allocate",
      errorCode,
      startedAt: item?.startedAt || null,
      completedAt: item?.completedAt || null,
      elapsedMs: Number.isFinite(item?.elapsedMs) ? item.elapsedMs : null,
      expected: item?.error?.expected || "",
      actual: item?.error?.actual || "",
      lights: lights.map((light) => ({ ...light }))
    });
  };
  const capacityFault = (item) => {
    const position = REPAIR_LIGHT_INDEX;
    lights[position] = { state: "red", label: "灯位容量不足" };
    journalFault(item, "AO.CONTRACT.LIGHT_CAPACITY_EXCEEDED", position);
  };
  const clearSuccessfulRound = () => {
    clearTimer = null;
    if (frozen) return;
    lights = blankLights(); nextPosition = 0; positions = new Map(); groups = new Map();
    if (repairPending) lights[REPAIR_LIGHT_INDEX] = { state: "red", label: "上一轮需要检修" };
    emit();
  };
  const scheduleSuccessfulClear = () => {
    if (frozen || !nextPosition || clearTimer !== null) return;
    if (![...lights.slice(0, workingCapacity())].every((light) => light.state === "idle" || isTerminal(light.state))) return;
    clearTimer = setTimer(clearSuccessfulRound, Math.max(0, Number(successHoldMs) || 0));
  };
  const finishQueuedRound = () => {
    if (!completeRequestedFor || completeRequestedFor !== rootId || frozen) return;
    completeRequestedFor = "";
    for (const group of groups.keys()) refreshMajor(group);
    if (![...groups.values()].every((entry) => isTerminal(lights[entry.major]?.state))) return;
    scheduleSuccessfulClear();
    emit();
  };
  const applyStation = ({ group, groupEntry, position, state, item }) => {
    const completesMajor = state === "green"
      && lights[groupEntry.major]?.state === "orange"
      && [...groupEntry.children].every((child) => child === position || isTerminal(lights[child]?.state));
    // A green child to the right of an orange major is visually backwards.  Finish
    // the major first, then show the child's own green state on the next 200ms beat.
    if (completesMajor) {
      lights[groupEntry.major] = { state: "green", label: GROUPS[group] };
      transitionQueue.unshift({ kind: "station", group, groupEntry, position, state, item });
      emit();
      return;
    }
    lights[position] = { state, label: `${item.moduleId} / ${item.operation}` };
    if (state === "red") { journalFault(item, item.error?.code || "AO.CONTRACT.FAILED", position); emit(); return; }
    const completeMajor = majorCanFinish(group);
    emit();
    if (completeMajor) transitionQueue.unshift({ kind: "major-complete", group });
  };
  const applyTransition = (item) => {
    const root = rootFor(item?.requestId);
    if (!root) return;
    if (!stateFor(item?.light)) return applyTransition(invalidLightState(item));
    if (frozen) {
      if (root !== rootId && isUserConversationStart(item)) reset(root);
      else return;
    } else if (root !== rootId) reset(root);
    if (isUserConversationStart(item)) chatRound = true;
    const state = stateFor(item.light);
    const group = groupFor(item.moduleId);
    const groupEntry = startGroup(group);
    if (!groupEntry) { capacityFault(item); emit(); return; }
    const key = String(item.requestId || "");
    let position = positions.get(key);
    if (position === undefined && state === "orange" && !groupEntry.starting) moveMajorToFrontier(groupEntry);
    if (position === undefined) {
      position = allocate();
      if (position < 0) { capacityFault(item); emit(); return; }
      positions.set(key, position);
      groupEntry.children.add(position);
    }
    if (state === "red") { applyStation({ group, groupEntry, position, state, item }); return; }
    const startMajor = groupEntry.starting || (state === "orange" && lights[groupEntry.major]?.state !== "orange");
    if (startMajor) {
      groupEntry.starting = false;
      cancelClear();
      lights[groupEntry.major] = { state: "orange", label: GROUPS[group] };
      transitionQueue.unshift({ kind: "station", group, groupEntry, position, state, item });
      emit();
      return;
    }
    applyStation({ group, groupEntry, position, state, item });
  };
  const drainTransitions = () => {
    transitionTimer = null;
    const item = transitionQueue.shift();
    if (!item) {
      finishQueuedRound();
      if (!chatRound && !frozen) {
        for (const group of groups.keys()) refreshMajor(group);
        scheduleSuccessfulClear();
        emit();
      }
      return;
    }
    cancelClear();
    if (item.kind === "station") applyStation(item);
    else if (item.kind === "major-complete") { if (refreshMajor(item.group)) emit(); }
    else if (stateFor(item.light) === "orange" && !positions.has(String(item.requestId || "")) && hasWorkingStation()) {
      const key = String(item.requestId || "");
      const deferredTerminals = transitionQueue.filter((entry) => String(entry?.requestId || "") === key && isTerminal(stateFor(entry?.light)));
      transitionQueue = transitionQueue.filter((entry) => !deferredTerminals.includes(entry));
      const activeKeys = new Set([...positions.entries()]
        .filter(([, position]) => lights[position]?.state === "orange")
        .map(([activeKey]) => activeKey));
      let insertAt = 0;
      transitionQueue.forEach((entry, index) => {
        if (activeKeys.has(String(entry?.requestId || "")) && isTerminal(stateFor(entry?.light))) insertAt = index + 1;
      });
      transitionQueue.splice(insertAt, 0, item, ...deferredTerminals);
    } else if (isTerminal(stateFor(item.light)) && !positions.has(String(item.requestId || ""))) {
      const key = String(item.requestId || "");
      const matchingWork = transitionQueue.findIndex((entry) => String(entry?.requestId || "") === key && stateFor(entry?.light) === "orange");
      if (matchingWork < 0) applyTransition(item);
      else transitionQueue.splice(matchingWork + 1, 0, item);
    }
    else applyTransition(item);
    transitionTimer = setTimer(drainTransitions, Math.max(0, Number(visibleTransitionMs) || 0));
  };
  const queueTransition = (item) => {
    const root = rootFor(item?.requestId);
    if (!root) return;
    const state = stateFor(item.light);
    if (!state) { cancelTransitions(); applyTransition(invalidLightState(item)); return; }
    if (state === "red") { cancelTransitions(); applyTransition(item); return; }
    cancelClear();
    if (root !== rootId) cancelTransitions();
    const key = String(item.requestId || "");
    const signature = `${state}|${item?.phase || ""}`;
    if (state === "grey") {
      const matchesStation = (entry) => String(entry?.requestId || entry?.item?.requestId || "") === key;
      transitionQueue = transitionQueue.filter((entry) => !matchesStation(entry));
      queuedStates.set(key, signature);
      if (removeSkippedStation(key)) emit();
      return;
    }
    if (queuedStates.get(key) === signature) return;
    queuedStates.set(key, signature);
    // A terminal signal is allowed to overtake later work that was announced in the
    // same millisecond.  This preserves the real completion while keeping the only
    // orange lamps at the right-hand work frontier.
    const position = positions.get(key);
    if (isTerminal(state) && position !== undefined && lights[position]?.state === "orange") transitionQueue.unshift(item);
    else transitionQueue.push(item);
    if (transitionTimer === null) drainTransitions();
  };
  return Object.freeze({
    snapshot,
    transition: queueTransition,
    completeRound(requestId) {
      if (frozen || rootFor(requestId) !== rootId) return;
      completeRequestedFor = rootId;
      if (transitionTimer === null && !transitionQueue.length) finishQueuedRound();
    }
  });
}

module.exports = { GROUPS, LIGHT_STRIP_PROJECTION_CONTRACT, createSignalLightStrip };
