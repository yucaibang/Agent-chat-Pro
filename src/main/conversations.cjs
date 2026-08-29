"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { app } = require("electron");
const { getSettings } = require("./settings.cjs");
const { archiveFileName, archiveMarkdown } = require("./archive.cjs");
const { ARCHIVE_FOLDER, migrateConversationDirectory } = require("./storage.cjs");
let recoveryNotice = "";

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

function createConversation() {
  const now = new Date().toISOString();
  const conversation = { id: randomUUID(), title: "新对话", sessionId: "", localSessionId: "", sshSessionId: "", lastConnectionMode: "", createdAt: now, updatedAt: now, pinned: false, messages: [] };
  conversation.archiveFile = archiveFileName(conversation.title, conversation.createdAt, conversation.id);
  const all = read();
  all.unshift(conversation);
  write(all);
  writeArchive(conversation);
  return conversation;
}

function listConversations() {
  return read()
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
        pinned: Boolean(conversation.pinned),
        updatedAt: conversation.updatedAt,
        sessionId: conversation.sessionId,
        archiveFile: conversation.archiveFile,
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
  conversation.localSessionId = "";
  conversation.sshSessionId = "";
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

function addUserMessage(id, text, attachmentNames = []) {
  return update(id, (conversation) => {
    conversation.messages.push({ role: "user", text, attachmentNames, at: new Date().toISOString() });
    if (conversation.title === "新对话") conversation.title = makeTitle(text);
  });
}

function addAssistantMessage(id, text, sessionId, files = [], tools = [], requestId = "", connectionMode = "ssh", usage, durationMs) {
  return update(id, (conversation) => {
    const draft = requestId
      ? conversation.messages.find((message) => message.role === "assistant" && message.requestId === requestId)
      : null;
    const completed = { role: "assistant", text, files, tools, at: draft?.at || new Date().toISOString() };
    if (usage) completed.usage = usage;
    if (Number.isFinite(Number(durationMs))) completed.durationMs = Math.max(0, Math.round(Number(durationMs)));
    if (draft) {
      Object.assign(draft, completed);
      delete draft.draft;
      delete draft.requestId;
    } else conversation.messages.push(completed);
    if (connectionMode === "local") conversation.localSessionId = sessionId || conversation.localSessionId || "";
    else conversation.sshSessionId = sessionId || conversation.sshSessionId || conversation.sessionId || "";
    conversation.sessionId = sessionId || conversation.sessionId;
    conversation.lastConnectionMode = connectionMode === "local" ? "local" : "ssh";
  });
}

function saveConversationSession(id, sessionId, connectionMode = "ssh") {
  const nextSessionId = String(sessionId || "").trim();
  if (!nextSessionId) return null;
  return update(id, (conversation) => {
    if (connectionMode === "local") conversation.localSessionId = nextSessionId;
    else conversation.sshSessionId = nextSessionId;
    conversation.sessionId = nextSessionId;
    conversation.lastConnectionMode = connectionMode === "local" ? "local" : "ssh";
  });
}

function saveAssistantDraft(id, requestId, text) {
  if (!requestId || !text) return null;
  return update(id, (conversation) => {
    const existing = conversation.messages.find((message) => message.role === "assistant" && message.requestId === requestId);
    if (existing) existing.text = text;
    else conversation.messages.push({
      role: "assistant",
      text,
      draft: true,
      requestId,
      at: new Date().toISOString()
    });
  });
}

function sessionForMode(conversation, connectionMode) {
  if (!conversation) return "";
  if (connectionMode === "local") return conversation.localSessionId || "";
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

function searchConversations(query, limit = 20) {
  const lowerQuery = String(query || "").toLocaleLowerCase().trim();
  if (!lowerQuery) return [];
  const all = read();
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
          updatedAt: conversation.updatedAt,
          pinned: Boolean(conversation.pinned),
          snippet,
          role: message.role
        });
        break;
      }
    }
    if (results.length >= limit) break;
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
  conversationStats
};