"use strict";
/* ═══════════════════════════════════════════════════════════════════
 * agent-pool.cjs — 多 AI 对话（工作）· Agent 池与工作组建档（v3.35.6 模块一）
 *
 * 规格来源（2026-10-31 用户令，DeepSeek 终极规格书 模块一）：
 *   ① 云端 API 池：无限扩容节点，每节点 = 自定义名称 + Provider + API Key + 自定义模型名
 *   ② SSH/本机多实例：同一 NAS 连接可添加多次（@NAS-Dev / @NAS-Test），互独立会话
 *   ③ 工作组（Workgroup）：勾选多个实例组成群 + 顺序（自主讨论按序接力用）
 *
 * 数据落盘：agent-pool.json（dataDirectory 下，与 conversations.json 同域 0o600 原子写）。
 * 云端节点 API Key：safeStorage 加密落盘（与 settings.cjs 云端密钥同机制同等级）；
 *   加密不可用时拒绝保存（不留明文密钥红线）。解密仅在派发任务时取用，列表 API 永不回传密钥。
 * ═══════════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { app, safeStorage } = require("electron");
const { getSettings } = require("./settings.cjs");

const POOL_KINDS = ["cloud", "ssh", "local"];

function storagePath(directory = getSettings().dataDirectory) {
  return path.join(directory || app.getPath("userData"), "agent-pool.json");
}

function read() {
  try {
    const value = JSON.parse(fs.readFileSync(storagePath(), "utf8"));
    const base = value && typeof value === "object" ? value : {};
    return { pool: Array.isArray(base.pool) ? base.pool : [], workgroups: Array.isArray(base.workgroups) ? base.workgroups : [] };
  } catch (error) {
    if (error.code === "ENOENT") return { pool: [], workgroups: [] };
    const source = storagePath();
    const backup = `${source}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    try {
      fs.renameSync(source, backup);
      return { pool: [], workgroups: [] };
    } catch { // 备份也失败只好抛出，避免静默吞掉用户的池数据
      throw new Error("无法读取 Agent 池数据：" + error.message);
    }
  }
}

function write(state) {
  fs.mkdirSync(path.dirname(storagePath()), { recursive: true });
  const temporary = `${storagePath()}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, storagePath());
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

/** 名称规范化：去掉首尾空白与首字符 "@"（显示层再统一补 @，存储存裸名）；名称唯一（冲突拒绝） */
function normalizeAgentName(name) {
  return String(name || "").replace(/^@/, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function encryptSecret(plain, label) {
  const text = String(plain || "").trim();
  if (!text) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error(`${label}：系统加密不可用（safeStorage），无法安全保存，已拒绝。`);
  return safeStorage.encryptString(text).toString("base64");
}

function decryptSecret(encoded, label) {
  const value = String(encoded || "").trim();
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error(`${label}：系统加密不可用，无法解密。`);
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch (error) {
    throw new Error(`${label}解密失败（密钥库可能迁移过系统），请重新填写。`);
  }
}

/** 池节点公开形态（永不携带 decrypted key——列表/编辑界面只给 hasKey 探针与脱敏尾号） */
function publicNode(node) {
  if (!node) return null;
  const encryptedTail = node.cloud?.apiSecretEnc
    ? (() => { try { const key = decryptSecret(node.cloud.apiSecretEnc, "云端密钥"); return key ? `…${key.slice(-4)}` : ""; } catch { return "…解密失败"; } })()
    : "";
  return {
    id: node.id,
    name: node.name,
    kind: node.kind || "cloud",
    thinkingLevel: node.thinkingLevel || "",
    createdAt: node.createdAt || "",
    cloud: node.kind === "cloud"
      ? { provider: node.cloud?.provider || "", model: node.cloud?.model || "", baseURL: node.cloud?.baseURL || "", hasKey: Boolean(node.cloud?.apiSecretEnc), keyTail: encryptedTail }
      : undefined,
    ssh: node.kind === "ssh"
      ? { profileId: node.ssh?.profileId || "ssh-1", adapter: node.ssh?.adapter || "claude" }
      : undefined,
    local: node.kind === "local"
      ? { engine: node.local?.engine || "claude" }
      : undefined
  };
}

/* ── 池 CRUD ───────────────────────────────────────────── */

function listPool() {
  return read().pool.map(publicNode);
}

/** 添加云端节点（模块一①）：{ name, provider, apiKey, model, baseURL?, thinkingLevel? } */
function addCloudNode(input) {
  const name = normalizeAgentName(input?.name);
  if (!name) throw new Error("云端节点的自定义名称不能为空。");
  const provider = String(input?.provider || "").trim() || "zhipu";
  const apiKey = String(input?.apiKey || "").trim();
  if (!apiKey) throw new Error("云端节点的 API Key 不能为空（群成员独立计费，不复用主设置密钥）。");
  const model = String(input?.model || "").trim();
  if (!model) throw new Error("云端节点的模型名不能为空。");
  const state = read();
  if (state.pool.some((node) => node.name === name)) throw new Error(`名称「${name}」已被占用，请换一个。`);
  const node = {
    id: `ap-${randomUUID()}`,
    name,
    kind: "cloud",
    createdAt: new Date().toISOString(),
    thinkingLevel: String(input?.thinkingLevel || "").trim(),
    cloud: {
      provider,
      model,
      apiSecretEnc: encryptSecret(apiKey, "云端节点密钥"),
      baseURL: String(input?.baseURL || "").trim() // 自定义中转可带；留空走 provider 默认
    }
  };
  state.pool.push(node);
  write(state);
  return publicNode(node);
}

/** 添加 SSH/本机实例（模块一②）：同一 SSH 卡槽/本机引擎可注册多次，群内互独立会话 */
function addInstanceNode(input) {
  const name = normalizeAgentName(input?.name);
  if (!name) throw new Error("实例的自定义名称不能为空。");
  const kind = input?.kind === "local" ? "local" : "ssh";
  const state = read();
  if (state.pool.some((node) => node.name === name)) throw new Error(`名称「${name}」已被占用，请换一个。`);
  const node = {
    id: `ap-${randomUUID()}`,
    name,
    kind,
    createdAt: new Date().toISOString(),
    thinkingLevel: "",
    ssh: kind === "ssh"
      ? { profileId: String(input?.profileId || "ssh-1").trim() || "ssh-1", adapter: String(input?.adapter || "claude").trim() || "claude" }
      : undefined,
    local: kind === "local"
      ? { engine: String(input?.engine || "claude").trim() || "claude" }
      : undefined
  };
  state.pool.push(node);
  write(state);
  return publicNode(node);
}

function updatePoolNode(id, patch) {
  const state = read();
  const node = state.pool.find((item) => item.id === id);
  if (!node) throw new Error("找不到该 Agent 节点。");
  if (patch.name !== undefined) {
    const name = normalizeAgentName(patch.name);
    if (!name) throw new Error("名称不能为空。");
    if (name !== node.name && state.pool.some((item) => item.name === name)) throw new Error(`名称「${name}」已被占用。`);
    node.name = name;
  }
  if (patch.thinkingLevel !== undefined) node.thinkingLevel = String(patch.thinkingLevel || "").trim(); // 模块二：独立挡位落档（A 不污染 B）
  if (patch.model !== undefined && node.kind === "cloud") node.cloud.model = String(patch.model || "").trim() || node.cloud.model;
  if (patch.apiKey !== undefined && node.kind === "cloud") {
    const key = String(patch.apiKey || "").trim();
    if (key) node.cloud.apiSecretEnc = encryptSecret(key, "云端节点密钥");
  }
  if (patch.baseURL !== undefined && node.kind === "cloud") node.cloud.baseURL = String(patch.baseURL || "").trim();
  write(state);
  return publicNode(node);
}

function removePoolNode(id) {
  const state = read();
  const index = state.pool.findIndex((item) => item.id === id);
  if (index < 0) return false;
  state.pool.splice(index, 1);
  state.workgroups.forEach((group) => { group.members = (group.members || []).filter((member) => member.agentId !== id); });
  write(state);
  return true;
}

/* ── 工作组 CRUD ───────────────────────────────────────── */

function listWorkgroups() {
  return read().workgroups.map((group) => ({ ...group, members: (group.members || []).map((member) => ({ ...member })) }));
}

function createWorkgroup(input) {
  const name = normalizeAgentName(input?.name) || "协作组";
  const memberIds = Array.isArray(input?.agentIds) ? input.agentIds.map(String) : [];
  const state = read();
  const members = [];
  for (const agentId of memberIds) {
    if (!state.pool.some((node) => node.id === agentId)) throw new Error("工作组成员必须在 Agent 池中存在。");
    if (!members.some((member) => member.agentId === agentId)) members.push({ agentId, order: members.length });
  }
  if (!members.length) throw new Error("工作组至少要勾选一个 Agent 实例（群主视角：勾选即成群）。");
  let nameTaken = name;
  let suffix = 2;
  while (state.workgroups.some((group) => group.name === nameTaken)) nameTaken = `${name} ${suffix++}`;
  const group = { id: `wg-${randomUUID()}`, name: nameTaken, members, maxTurns: clampMaxTurns(input?.maxTurns), createdAt: new Date().toISOString() };
  state.workgroups.push(group);
  write(state);
  return group;
}

/** 红线③：max_turns 上限（自主讨论轮次环数）默认 5，可自定义 1~10，防无限套娃 */
function clampMaxTurns(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= 1 ? Math.min(number, 10) : 5;
}

function updateWorkgroup(id, patch) {
  const state = read();
  const group = state.workgroups.find((item) => item.id === id);
  if (!group) throw new Error("找不到该工作组。");
  if (patch.name !== undefined) {
    const name = normalizeAgentName(patch.name);
    if (name) group.name = state.workgroups.some((item) => item.id !== id && item.name === name) ? group.name : name;
  }
  if (Array.isArray(patch.agentIds)) {
    const members = [];
    for (const agentId of patch.agentIds.map(String)) {
      if (!state.pool.some((node) => node.id === agentId)) continue;
      if (!members.some((member) => member.agentId === agentId)) members.push({ agentId, order: members.length });
    }
    if (!members.length) throw new Error("工作组至少要保留一个成员。");
    group.members = members;
  }
  if (patch.maxTurns !== undefined) group.maxTurns = clampMaxTurns(patch.maxTurns);
  write(state);
  return group;
}

function deleteWorkgroup(id) {
  const state = read();
  const index = state.workgroups.findIndex((item) => item.id === id);
  if (index < 0) return false;
  state.workgroups.splice(index, 1);
  write(state);
  return true;
}

/** 群内成员解析（按工作组顺序返回池节点全量配置；解密 cloud key 仅供派发，绝不外传完整密钥）
 *  v3.42.0：幽灵引用不再静默出局——已删池节点的成员收集进 ghosts（agentId），编排层出缺席提示轮，
 *  用户不再遇到「发言的成员变少了却不知道为什么」（v3.41.1 连带缺陷清单第三条）。 */
function resolveGroupAgents(workgroupId) {
  const state = read();
  const group = state.workgroups.find((item) => item.id === workgroupId);
  if (!group) throw new Error("找不到该工作组（可能已被删除）。");
  const members = (group.members || []).slice().sort((a, b) => a.order - b.order);
  const agents = [];
  const ghosts = [];
  for (const member of members) {
    const node = state.pool.find((item) => item.id === member.agentId);
    if (!node) {
      ghosts.push(member.agentId); // 已删节点自动出局，但必须让用户知道它缺席了
      continue;
    }
    const config = node.kind === "cloud"
      ? {
          kind: "cloud",
          agentId: node.id,
          name: node.name,
          provider: node.cloud.provider || "zhipu",
          model: node.cloud.model || "",
          baseURL: node.cloud.baseURL || "",
          apiKey: decryptSecret(node.cloud.apiSecretEnc, `成员「${node.name}」的密钥`),
          thinkingLevel: node.thinkingLevel || ""
        }
      : node.kind === "ssh"
      ? { kind: "ssh", agentId: node.id, name: node.name, profileId: node.ssh.profileId, adapter: node.ssh.adapter, thinkingLevel: node.thinkingLevel || "" }
      : { kind: "local", agentId: node.id, name: node.name, engine: node.local.engine, thinkingLevel: node.thinkingLevel || "" };
    agents.push(config);
  }
  return { group, agents, ghosts };
}

/** 子 Agent 权限白名单（模块四）：子 Agent 模型池严格受限 = 仅用户配置的云端 API 池节点 */
function whitelistedCloudTargets() {
  return read().pool.filter((node) => node.kind === "cloud").map((node) => ({
    agentId: node.id,
    name: node.name,
    provider: node.cloud.provider || "zhipu",
    model: node.cloud.model || "",
    baseURL: node.cloud.baseURL || "",
    apiKey: decryptSecret(node.cloud.apiSecretEnc, `成员「${node.name}」的密钥`)
  }));
}

module.exports = {
  POOL_KINDS,
  listPool,
  addCloudNode,
  addInstanceNode,
  updatePoolNode,
  removePoolNode,
  listWorkgroups,
  createWorkgroup,
  updateWorkgroup,
  deleteWorkgroup,
  resolveGroupAgents,
  whitelistedCloudTargets,
  clampMaxTurns,
  normalizeAgentName
};