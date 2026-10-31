"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { app } = require("electron");
const { getSettings } = require("./settings.cjs");
const { archiveFileName, archiveMarkdown } = require("./archive.cjs");
const { ARCHIVE_FOLDER, migrateConversationDirectory } = require("./storage.cjs");
let recoveryNotice = "";

// v3.35.6 多智能体工作区（大功能「多 AI 对话（工作）」前置）：
// 每条对话归属工作区标记——single=一对一专攻（存量对话无字段一律视为 single，兼容迁移）；
// team=Agents Chat Pro 多 Agent 协同工作区。历史列表/搜索按工作区物理过滤，严禁串台。
const WORKSPACE_TYPES = ["single", "team"];

function normalizeWorkspaceType(value) {
  const id = String(value || "").trim();
  return WORKSPACE_TYPES.includes(id) ? id : "single";
}

function workspaceTypeOf(conversation) {
  return normalizeWorkspaceType(conversation?.workspaceType);
}

function storagePath(directory = getSettings().dataDirectory) {
  return path.join(directory || app.getPath("userData"), "conversations.json");
}

function archiveDirectory(directory = getSettings().dataDirectory) {
  return path.join(directory || app.getPath("userData"), ARCHIVE_FOLDER);
}

function prepareConversationDirectory(currentDirectory, nextDirectory) {
  return migrateConversationDirectory(
    currentDirectory || app.getPath("userData"),
    nextDirectory || app.getPath("userData")
  );
}

function read() {
  try {
    const value = JSON.parse(fs.readFileSync(storagePath(), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    const source = storagePath();
    const backup = `${source}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    try {
      fs.renameSync(source, backup);
      recoveryNotice = `检测到损坏的聊天记录，原文件已备份为 ${path.basename(backup)}。`;
      return [];
    } catch (backupError) {
      throw new Error("无法读取本地聊天记录，且无法创建恢复备份：" + backupError.message);
    }
  }
}

function write(conversations) {
  fs.mkdirSync(path.dirname(storagePath()), { recursive: true });
  const temporary = `${storagePath()}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(conversations, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, storagePath());
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

// v3.35.6：建对话即归属工作区（渲染层按当前工作区传入；缺省 single 兼容既有调用）
function createConversation(workspaceType = "single") {
  const now = new Date().toISOString();
  const conversation = { id: randomUUID(), workspaceType: normalizeWorkspaceType(workspaceType), title: "新对话", sessionId: "", localSessionId: "", sshSessionId: "", lastConnectionMode: "", createdAt: now, updatedAt: now, pinned: false, messages: [] };
  conversation.archiveFile = archiveFileName(conversation.title, conversation.createdAt, conversation.id);
  const all = read();
  all.unshift(conversation);
  write(all);
  writeArchive(conversation);
  return conversation;
}

// v3.35.6：按工作区过滤（workspaceType 空串=不过滤，保持存量调用语义不变）；无字段的存量数据视作 single
function listConversations(workspaceType = "") {
  return read()
    .filter((conversation) => !workspaceType || workspaceTypeOf(conversation) === normalizeWorkspaceType(workspaceType))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt))
    .map((conversation) => {
      const lastMessage = conversation.messages?.[conversation.messages.length - 1];
      const preview = String(lastMessage?.text || (lastMessage?.attachmentNames?.length ? `附件：${lastMessage.attachmentNames.join("、")}` : "新对话，等待发送"))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      return {
        id: conversation.id,
        title: conversation.title,
        workspaceType: workspaceTypeOf(conversation),
        pinned: Boolean(conversation.pinned),
        updatedAt: conversation.updatedAt,
        sessionId: conversation.sessionId,
        archiveFile: conversation.archiveFile,
        lastConnectionMode: conversation.lastConnectionMode || "",
        preview
      };
    });
}

function setConversationPinned(id, pinned) {
  const all = read();
  const conversation = all.find((item) => item.id === id);
  if (!conversation) throw new Error("找不到此本地对话。请新建对话后重试。");
  conversation.pinned = Boolean(pinned);
  write(all);
  return { id: conversation.id, pinned: conversation.pinned };
}

function getConversation(id) {
  const conversation = read().find((item) => item.id === id) || null;
  return conversation ? { ...conversation, stats: conversationStats(conversation) } : null;
}

function clearConversationSession(id) {
  const all = read();
  const conversation = all.find((item) => item.id === id);
  if (!conversation) return false;
  conversation.sessionId = "";
  conversation.sshSessionId = "";
  for (const key of Object.keys(conversation)) {
    if (key === "localSessionId" || key.startsWith("localSessionId_")) conversation[key] = "";
    // v3.18.0 F4：卡槽会话字段一并清（sshSessionId_ssh2 等）
    if (key.startsWith("sshSessionId_")) conversation[key] = "";
  }
  // v3.35.6 群聊：Agent 实例会话随会话重置一并清空
  conversation.agentSessions = {};
  conversation.lastConnectionMode = "";
  conversation.updatedAt = new Date().toISOString();
  write(all);
  return true;
}

function renameConversation(id, title) {
  const nextTitle = String(title || "").replace(/\s+/g, " ").trim();
  if (!nextTitle) throw new Error("对话名称不能为空。");
  return update(id, (conversation) => {
    conversation.title = nextTitle.slice(0, 80);
  });
}

function deleteConversation(id) {
  const all = read();
  const index = all.findIndex((conversation) => conversation.id === id);
  if (index < 0) return false;
  all.splice(index, 1);
  write(all);
  return true;
}

function addUserMessage(id, text, attachmentNames = [], senderType = "") {
  return update(id, (conversation) => {
    const message = { mid: randomUUID(), role: "user", text, attachmentNames, at: new Date().toISOString() }; // v3.15.5 修复2：mid 删除锚点
    // 阉割版 Bridge Edition：云端AI 经 HTTP 桥注入的消息带 senderType 渲染层徽章；文本前缀已在 chat:send 主进程侧强制追加
    if (senderType) message.senderType = senderType;
    conversation.messages.push(message);
    if (conversation.title === "新对话") conversation.title = makeTitle(text);
    return message;
  });
}

/** local 模式下按引擎隔离会话字段（v3.13.0）：claude 走原 localSessionId；其他引擎存 localSessionId_<engine>；custom 无原生会话 */
function localSessionField(engine) {
  const name = String(engine || "claude").trim();
  if (!name || name === "claude") return "localSessionId";
  if (name === "custom") return "";
  return `localSessionId_${name.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** SSH 模式按卡槽隔离会话字段（v3.18.0 F4，与 localSessionId_<engine> 同构）：
 * ssh-1 走原 sshSessionId（存量会话延续，迁移后 ssh-1=旧单套配置）；ssh-2 走 sshSessionId_ssh-2。
 * v3.19.0 F3：再叠 SSH 适配器维度（adapter 非 claude 时字段尾部追加；各家 CLI 会话互不透传）。 */
function sshSessionField(profileId, adapter = "claude") {
  const id = String(profileId || "").trim();
  const base = (!id || id === "ssh-1") ? "sshSessionId" : `sshSessionId_${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const tail = String(adapter || "claude").trim();
  return tail && tail !== "claude" ? `${base}_${tail.replace(/[^a-zA-Z0-9_-]/g, "")}` : base;
}

/** v3.35.6 群聊：成员会话按 Agent 实例隔离落档（agentSessions[agentId]=sessionId），跨轮续聊不串 */
function saveAgentSession(id, agentId, sessionId) {
  const key = String(agentId || "").trim();
  const trimmed = String(sessionId || "").trim();
  if (!key || !trimmed) return null;
  return update(id, (conversation) => {
    if (!conversation.agentSessions || typeof conversation.agentSessions !== "object") conversation.agentSessions = {};
    conversation.agentSessions[key] = trimmed;
  });
}

/** v3.35.6 群聊：读取成员会话（跨轮续聊用） */
function agentSessionFor(conversation, agentId) {
  const map = conversation?.agentSessions;
  return map && typeof map === "object" ? String(map[agentId] || "") : "";
}

/** v3.35.6 群聊：绑定对话 ↔ 工作组（首次群发时落定） */
function setConversationWorkgroup(id, workgroupId) {
  const value = String(workgroupId || "").trim();
  if (!value) return null;
  return update(id, (conversation) => {
    conversation.workgroupId = value;
    if (!conversation.agentSessions || typeof conversation.agentSessions !== "object") conversation.agentSessions = {};
  });
}

function addAssistantMessage(id, text, sessionId, files = [], tools = [], requestId = "", connectionMode = "ssh", usage, durationMs, engine = "claude", profileId = "", remoteAdapter = "claude", thinking = "", agentMeta = null) {
  return update(id, (conversation) => {
    const draft = requestId
      ? conversation.messages.find((message) => message.role === "assistant" && message.requestId === requestId)
      : null;
    const completed = { mid: draft?.mid || randomUUID(), role: "assistant", text, files, tools, at: draft?.at || new Date().toISOString() }; // v3.15.5 修复2：mid 删除锚点（draft 转正复用原 mid）
    // v3.35.6 群聊：成员身份随消息落库（气泡名牌 + 群聊上下文按成员转录归因）
    if (agentMeta && typeof agentMeta === "object") {
      completed.agent = { id: String(agentMeta.agentId || "").slice(0, 80), name: String(agentMeta.name || "").slice(0, 40) };
    }
    if (usage) completed.usage = usage;
    if (Number.isFinite(Number(durationMs))) completed.durationMs = Math.max(0, Math.round(Number(durationMs)));
    // v3.24.0 思考过程落库：随消息持久化（重放渲染折叠块；上限 200KB 防超长思维链灌库）
    if (thinking) completed.thinking = String(thinking).slice(0, 200000);
    if (draft) {
      Object.assign(draft, completed);
      delete draft.draft;
      delete draft.requestId;
    } else conversation.messages.push(completed);
    if (connectionMode === "local") {
      const field = localSessionField(engine);
      if (field) conversation[field] = sessionId || conversation[field] || "";
    } else {
      // v3.18.0 F4：SSH 会话按卡槽落字段（ssh-1 仍走 sshSessionId，存量会话延续）
      // v3.19.0 F3：再按适配器落字段（claude 不加尾标=存量不动）
      const field = sshSessionField(profileId, remoteAdapter);
      conversation[field] = sessionId || conversation[field] || conversation.sessionId || "";
    }
    conversation.sessionId = sessionId || conversation.sessionId;
    // v3.15.0：记录真实三值模式（ssh/cloud/local）——历史列表模式图标 + 切对话联动连接模式
    conversation.lastConnectionMode = ["ssh", "cloud", "local"].includes(connectionMode) ? connectionMode : "ssh";
  });
}

function saveConversationSession(id, sessionId, connectionMode = "ssh", engine = "claude", profileId = "", remoteAdapter = "claude") {
  const nextSessionId = String(sessionId || "").trim();
  if (!nextSessionId) return null;
  return update(id, (conversation) => {
    if (connectionMode === "local") {
      const field = localSessionField(engine);
      if (field) conversation[field] = nextSessionId;
    } else conversation[sshSessionField(profileId, remoteAdapter)] = nextSessionId; // v3.18.0 按卡槽 / v3.19.0 按适配器落字段
    conversation.sessionId = nextSessionId;
    // v3.15.0：真实三值模式（ssh/cloud/local）
    conversation.lastConnectionMode = ["ssh", "cloud", "local"].includes(connectionMode) ? connectionMode : "ssh";
  });
}

function saveAssistantDraft(id, requestId, text) {
  if (!requestId || !text) return null;
  return update(id, (conversation) => {
    const existing = conversation.messages.find((message) => message.role === "assistant" && message.requestId === requestId);
    if (existing) existing.text = text;
    else conversation.messages.push({
      mid: randomUUID(), // v3.15.5 修复2：mid 删除锚点
      role: "assistant",
      text,
      draft: true,
      requestId,
      at: new Date().toISOString()
    });
  });
}

function sessionForMode(conversation, connectionMode, engine = "claude", profileId = "", remoteAdapter = "claude") {
  if (!conversation) return "";
  if (connectionMode === "local") {
    const field = localSessionField(engine);
    return field ? conversation[field] || "" : "";
  }
  // v3.18.0 F4：SSH 按卡槽取会话字段；ssh-1 兜底旧 sessionId 字段（lastConnectionMode 允许时延续存量）
  if (connectionMode === "ssh") {
    const field = sshSessionField(profileId, remoteAdapter);
    const slotSession = conversation[field] || "";
    if (slotSession) return slotSession;
    if (field !== "sshSessionId") return ""; // ssh-2 等新槽不透传旧通用会话
  }
  return conversation.sshSessionId || (conversation.lastConnectionMode !== "local" ? conversation.sessionId || "" : "");
}

function conversationStats(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const completed = messages.filter((message) => message.role === "assistant" && !message.draft);
  const usageMessages = completed.filter((message) => message.usage && typeof message.usage === "object");
  const inputTokens = usageMessages.reduce((sum, message) => sum + Number(message.usage.inputTokens || 0), 0);
  const outputTokens = usageMessages.reduce((sum, message) => sum + Number(message.usage.outputTokens || 0), 0);
  const cacheCreationInputTokens = usageMessages.reduce((sum, message) => sum + Number(message.usage.cacheCreationInputTokens || 0), 0);
  const cacheReadInputTokens = usageMessages.reduce((sum, message) => sum + Number(message.usage.cacheReadInputTokens || 0), 0);
  const latestCompleted = completed.at(-1);
  return {
    rounds: completed.length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    lastRoundDurationMs: Math.max(0, Number(latestCompleted?.durationMs) || 0),
    usageComplete: completed.length > 0 && usageMessages.length === completed.length
  };
}

function getConversationRecoveryNotice() {
  return recoveryNotice;
}

// v3.35.6：搜索同受工作区物理过滤（不串台红线——搜索结果也不能串）。
// limit 允许 null/undefined（IPC 经序列化丢失默认值时回落 20）
function searchConversations(query, limit = 20, workspaceType = "") {
  const lowerQuery = String(query || "").toLocaleLowerCase().trim();
  if (!lowerQuery) return [];
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
  const all = read().filter((conversation) => !workspaceType || workspaceTypeOf(conversation) === normalizeWorkspaceType(workspaceType));
  const results = [];
  for (const conversation of all) {
    if (!conversation.messages) continue;
    const titleMatch = String(conversation.title || "").toLocaleLowerCase().includes(lowerQuery);
    for (const message of conversation.messages) {
      const textMatch = String(message.text || "").toLocaleLowerCase().includes(lowerQuery);
      if (titleMatch || textMatch) {
        const snippet = textMatch ? String(message.text || "").replace(/\s+/g, " ").trim().slice(0, 120) : String(conversation.title || "");
        results.push({
          id: conversation.id,
          title: conversation.title,
          workspaceType: workspaceTypeOf(conversation),
          updatedAt: conversation.updatedAt,
          pinned: Boolean(conversation.pinned),
          lastConnectionMode: conversation.lastConnectionMode || "",
          snippet,
          role: message.role
        });
        break;
      }
    }
    if (results.length >= boundedLimit) break;
  }
  return results;
}

function update(id, mutate) {
  const all = read();
  const conversation = all.find((item) => item.id === id);
  if (!conversation) throw new Error("找不到此本地对话。请新建对话后重试。");
  const previousArchiveFile = conversation.archiveFile || archiveFileName(conversation.title, conversation.createdAt, conversation.id);
  mutate(conversation);
  conversation.updatedAt = new Date().toISOString();
  conversation.archiveFile = archiveFileName(conversation.title, conversation.createdAt, conversation.id);
  write(all);
  writeArchive(conversation, previousArchiveFile);
  return conversation;
}

// v3.15.5 修复2：删除单条及下方所有落库消息（右键「删除此条及下方所有消息」同步落库，切走切回不再复活）。
// 锚点：优先 mid（本轮起落库消息带 mid），旧数据按 at+role 兜底。
// 注意：update() 的 mutate 回调返回值会被丢弃，删除计数用闭包变量传出。
function truncateConversationMessages(id, anchor = {}) {
  let removedCount = 0;
  update(id, (conversation) => {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    let index = -1;
    const mid = String(anchor.mid || "").trim();
    if (mid) index = messages.findIndex((message) => message.mid === mid);
    if (index === -1) {
      const at = String(anchor.at || "").trim();
      const role = String(anchor.role || "").trim();
      if (at && role) index = messages.findIndex((message) => message.at === at && message.role === role);
    }
    if (index === -1) throw new Error("找不到要删除的消息（对话内容可能已变化），请重新进入对话后重试。");
    removedCount = messages.length - index;
    conversation.messages = messages.slice(0, index);
  });
  return { removed: removedCount };
}

function ensureConversationArchives() {
  const all = read();
  let changed = false;
  for (const conversation of all) {
    if (!conversation.archiveFile) {
      conversation.archiveFile = archiveFileName(conversation.title, conversation.createdAt, conversation.id);
      changed = true;
    }
  }
  if (changed) write(all);
  all.forEach((conversation) => writeArchive(conversation));
  return all.length;
}

function writeArchive(conversation, previousArchiveFile = "") {
  const directory = archiveDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, conversation.archiveFile);
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, archiveMarkdown(conversation), { mode: 0o600 });
    fs.copyFileSync(temporary, destination);
    fs.rmSync(temporary, { force: true });
    if (previousArchiveFile && previousArchiveFile !== conversation.archiveFile) {
      fs.rmSync(path.join(directory, previousArchiveFile), { force: true });
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new Error("无法自动保存会话存档：" + error.message);
  }
}

function makeTitle(text) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  return compact.length > 26 ? compact.slice(0, 26) + "…" : compact || "新对话";
}

module.exports = {
  addAssistantMessage,
  addUserMessage,
  clearConversationSession,
  createConversation,
  deleteConversation,
  ensureConversationArchives,
  getConversation,
  getConversationRecoveryNotice,
  listConversations,
  archiveDirectory,
  prepareConversationDirectory,
  renameConversation,
  setConversationPinned,
  saveConversationSession,
  saveAssistantDraft,
  searchConversations,
  sessionForMode,
  sshSessionField,
  truncateConversationMessages,
  conversationStats,
  saveAgentSession,
  agentSessionFor,
  setConversationWorkgroup,
  normalizeWorkspaceType,
  workspaceTypeOf
};