"use strict";
/**
 * repetition-guard.cjs — 复读检测折叠（v3.15.5 修复1）
 * 背景：Test-PC 云端模式单条回复内同一段话复读 13 遍（末段细微变体）。
 *   生成式模型在重复上下文下会陷入复读循环（degeneration）：整段复读、末段细微变体。
 * 算法：按空行分段 → 同段（空白归一化后相同）出现 ≥ minRepeat 次且去除占比 ≥ minRatio
 *   → 折叠（每段保留首次出现）+ 尾注提示。
 * 防误伤：短段（< minSegmentLength 字符）、`---` 分隔段不参与判定；占比不足不强折；
 *   折叠结果自身幂等（再折叠无变化）。
 */

const DEFAULTS = Object.freeze({ minRepeat: 3, minSegmentLength: 8, minRatio: 0.3 });
const COLLAPSE_NOTE_TPL = "（⚠ 已折叠 {collapsed} 段重复输出，去除 {removed} 段重复内容。模型可能陷入复读循环，建议右键「重新生成」或换个问法。）";

/** 段落归一化：连续空白折叠为单个空格，便于忽略换行差异比较 */
function normalizeSegment(segment) {
  return String(segment).replace(/\s+/g, " ").trim();
}

/**
 * 折叠文本中的重复段落。
 * @param {string} text 原文
 * @param {{minRepeat?:number, minSegmentLength?:number, minRatio?:number}} [options] 阈值（默认见 DEFAULTS）
 * @returns {{text:string, collapsed:number, removed:number}} text=折叠后文本（未触发则原样），collapsed=涉及的去重段数，removed=去除的重复段数
 */
function collapseRepetition(text, options = {}) {
  if (typeof text !== "string" || !text) return { text, collapsed: 0, removed: 0 };
  const source = text;
  const minRepeat = Number(options.minRepeat) || DEFAULTS.minRepeat;
  const minSegmentLength = Number(options.minSegmentLength) || DEFAULTS.minSegmentLength;
  const minRatio = options.minRatio === undefined ? DEFAULTS.minRatio : Number(options.minRatio);
  // 按空行分段；剔除 --- 分隔段（跨轮分隔符）与空白段
  const segments = source
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && !/^-{3,}$/.test(segment));
  if (segments.length < minRepeat) return { text: source, collapsed: 0, removed: 0 };
  const normalized = segments.map(normalizeSegment);
  // 统计段频（短段不参与判定，避免「好的。」「……」之类误伤）
  const counts = new Map();
  normalized.forEach((norm) => {
    if (norm.length < minSegmentLength) return;
    counts.set(norm, (counts.get(norm) || 0) + 1);
  });
  const repeated = new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count >= minRepeat)
      .map(([norm]) => norm)
  );
  if (!repeated.size) return { text: source, collapsed: 0, removed: 0 };
  // 折叠：重复段保留首次出现
  const keptSeen = new Set();
  const kept = [];
  let removed = 0;
  segments.forEach((segment, index) => {
    const norm = normalized[index];
    if (repeated.has(norm)) {
      if (keptSeen.has(norm)) {
        removed += 1;
        return;
      }
      keptSeen.add(norm);
    }
    kept.push(segment);
  });
  if (!removed) return { text: source, collapsed: 0, removed: 0 };
  // 占比保护：去除占比不足不强折（防正常文本里的局部重复被误伤）
  if (segments.length > 0 && removed / segments.length < minRatio) {
    return { text: source, collapsed: 0, removed: 0 };
  }
  const collapsedCount = keptSeen.size;
  const note = COLLAPSE_NOTE_TPL
    .replace("{collapsed}", String(collapsedCount))
    .replace("{removed}", String(removed));
  return { text: kept.join("\n\n") + "\n\n" + note, collapsed: collapsedCount, removed };
}

/** 只探测不改动：返回 { collapsed, removed }（按折叠结果统计） */
function detectRepetition(text, options = {}) {
  const result = collapseRepetition(text, options);
  return { collapsed: result.collapsed, removed: result.removed };
}

module.exports = { collapseRepetition, detectRepetition, DEFAULTS, COLLAPSE_NOTE_TPL };