"use strict";

/**
 * Agent 联动控件共存扫描器（v3.16.2）
 *
 * 背景：同一台 Windows 可能并存两套 Agent 联动控件——Agent Chat Pro 与
 * Agent Orbit / Claude NAS 系（老谱系品牌资源：ClaudeAgentControl 账号、
 * C:\ProgramData\ClaudeNasAgent 目录、CLAUDE NAS AGENT CONTROL/LISTENER marker）。
 * v3.16.1 之前两套互相踩：本方区块可能嵌进对方区块内部（任一方卸载即连带删掉另一方）。
 *
 * 本模块做「使用时」的轻量只读扫描（不提权、不弹窗）：
 *   - 家族在场识别（目录 / install-state.json / 账号 / 防火墙规则）
 *   - sshd_config marker 区间解析（尽力而为：普通用户可能读不到该文件）
 *   - 结构冲突判定：嵌套 / 同名区间重复 / 未闭合 marker
 *
 * 提权路径的全量扫描 + Windows 原生弹窗在 device-control.ps1（Install/Uninstall 前必扫）。
 */

const fs = require("fs");
const path = require("path");

const FAMILIES = [
  {
    id: "agent-chat-pro",
    label: "Agent Chat Pro",
    folder: "AgentChatProAgent",
    account: "AgentChatProControl",
    firewallRule: "AgentChatPro-Agent-Control",
    markerFamily: "AGENT CHAT PRO CONTROL"
  },
  {
    id: "claude-nas-line",
    label: "Agent Orbit / Claude NAS 系",
    folder: "ClaudeNasAgent",
    account: "ClaudeAgentControl",
    firewallRule: "ClaudeNAS-Agent-Control",
    markerFamily: "CLAUDE NAS AGENT CONTROL",
    listenerMarkerFamily: "CLAUDE NAS AGENT LISTENER"
  }
];

const BEGIN_PATTERN = /^[ \t]*#[ \t]*BEGIN[ \t]+([A-Z][A-Z ]+?)[ \t]+(CONTROL|LISTENER)[ \t]*$/;
const END_PATTERN = /^[ \t]*#[ \t]*END[ \t]+([A-Z][A-Z ]+?)[ \t]+(CONTROL|LISTENER)[ \t]*$/;

function programDataRoot() {
  return process.env.ProgramData || "C:\\ProgramData";
}

function familyStatePath(family) {
  return path.join(programDataRoot(), family.folder, "install-state.json");
}

function familyRootPath(family) {
  return path.join(programDataRoot(), family.folder);
}

/** 解析 sshd_config 内容中全部 Agent marker 区间（字符 offset，同名 BEGIN/END 配对，防交错错配）。 */
function parseMarkerRegions(content) {
  const lines = String(content || "").split(/\r?\n/);
  const markers = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const beginMatch = line.match(BEGIN_PATTERN);
    if (beginMatch) markers.push({ kind: "begin", family: `${beginMatch[1]} ${beginMatch[2]}`, start: offset, length: line.length });
    const endMatch = line.match(END_PATTERN);
    if (endMatch) markers.push({ kind: "end", family: `${endMatch[1]} ${endMatch[2]}`, start: offset, length: line.length });
    offset += line.length + 1; // split 吃掉了换行符
  }
  const regions = [];
  const consumed = new Set();
  for (const begin of markers.filter((m) => m.kind === "begin")) {
    const end = markers.find((m) => m.kind === "end" && m.family === begin.family && m.start > begin.start && !consumed.has(m.start));
    if (end) consumed.add(end.start);
    regions.push({
      markerFamily: begin.family,
      start: begin.start,
      end: end ? end.start + end.length : -1,
      unclosed: !end
    });
  }
  return regions;
}

/** 结构冲突判定：嵌套 / 同名区间重复 / 未闭合。与 device-control.ps1 的 Find-AgentConflicts 同构。 */
function findCoexistenceConflicts(content) {
  const regions = parseMarkerRegions(content);
  const conflicts = [];
  for (const region of regions) {
    if (region.unclosed) {
      conflicts.push({
        type: "unclosed",
        markerFamily: region.markerFamily,
        message: `SSH 配置中「${region.markerFamily}」区块缺少结束标记（配置可能被破坏）`
      });
      continue;
    }
    for (const other of regions) {
      if (other.markerFamily === region.markerFamily) continue;
      if (other.start > region.start && other.end > 0 && other.end <= region.end) {
        conflicts.push({
          type: "nested",
          markerFamily: region.markerFamily,
          nestedFamily: other.markerFamily,
          message: `SSH 配置中「${other.markerFamily}」区块嵌进了「${region.markerFamily}」区块内部（卸载任一方会连带删掉另一方，导致联动反复失效）`
        });
      }
    }
  }
  const familyCounts = new Map();
  for (const region of regions) familyCounts.set(region.markerFamily, (familyCounts.get(region.markerFamily) || 0) + 1);
  for (const [family, count] of familyCounts) {
    if (count > 1) {
      conflicts.push({
        type: "duplicate",
        markerFamily: family,
        message: `SSH 配置中出现 ${count} 处「${family}」区块（重复写入）`
      });
    }
  }
  return conflicts;
}

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

/** 轻量只读扫描（无提权、无弹窗）。sshd_config 普通用户可能读不到 → configReadable=false 降级。 */
function scanCoexistence() {
  const supported = process.platform === "win32";
  if (!supported) {
    return { supported: false, configReadable: false, families: [], conflicts: [], coexistence: false, otherFamilyPresent: false, otherFamilyInUse: false, legacyOrphan: false };
  }
  const families = [];
  let otherFamilyPresent = false;
  let otherFamilyInUse = false;
  let legacyOrphan = false;
  for (const family of FAMILIES) {
    const root = familyRootPath(family);
    const folderPresent = fs.existsSync(root);
    const state = readJsonSafe(familyStatePath(family));
    const installed = Boolean(state && state.installed);
    families.push({
      id: family.id,
      label: family.label,
      folderPresent,
      installed,
      account: family.account,
      accountPresent: Boolean(installed && state.account),
      firewallRulePresent: Boolean(installed && state.sourceAddress), // 防火墙规则无轻量探测路径，用 state 在用近似
      installedAt: (state && state.installedAt) || "",
      deviceId: (state && state.deviceId) || "",
      sourceAddress: (state && state.sourceAddress) || "",
      permissionMode: (state && state.permissionMode) || "",
      targetAddress: (state && state.targetAddress) || "",
      targetPort: (state && state.targetPort) || 22
    });
    if (family.id !== FAMILIES[0].id) {
      // 另一套（非首个家族 = 本应用）
      otherFamilyPresent = otherFamilyPresent || folderPresent;
      otherFamilyInUse = otherFamilyInUse || installed;
      legacyOrphan = legacyOrphan || (folderPresent && !installed);
    }
  }

  const sshdConfig = path.join(programDataRoot(), "ssh", "sshd_config");
  const configText = readFileMaybe(sshdConfig);
  const configReadable = configText !== null;
  const conflicts = configText !== null ? findCoexistenceConflicts(configText) : [];

  const coexistence = otherFamilyPresent || otherFamilyInUse || legacyOrphan;
  return {
    supported: true,
    configReadable,
    families,
    conflicts,
    coexistence,
    otherFamilyPresent,
    otherFamilyInUse,
    legacyOrphan
  };
}

function readFileMaybe(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return null; }
}

/** 渲染层/日志用的中文摘要（无冲突时为空字符串）。 */
function summarizeCoexistence(scan) {
  if (!scan || !scan.supported) return "";
  const lines = [];
  const other = (scan.families || []).find((f) => f.id === "claude-nas-line");
  if (scan.otherFamilyInUse && other) {
    lines.push(`检测到另一套联动控件在使用中：${other.label}（账号 ${other.account}），双方隔离共存、互不删改`);
  } else if (scan.legacyOrphan && other) {
    lines.push(`检测到旧版联动控件遗留（${other.label}，无人认领）`);
  }
  for (const conflict of scan.conflicts || []) lines.push(conflict.message);
  return lines.join("\n");
}

module.exports = {
  FAMILIES,
  findCoexistenceConflicts,
  parseMarkerRegions,
  programDataRoot,
  scanCoexistence,
  summarizeCoexistence
};