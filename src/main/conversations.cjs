"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { app } = require("electron");
const { getSettings } = require("./settings.cjs");
const { archiveFileName, archiveMarkdown } = require("./archive.cjs");
const { ARCHIVE_FOLDER, migrateConversationDirectory } = require("./storage.cjs");

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
    throw new Error("无法读取本地聊天记录：" + error.message);
  }
}

function write(conversations) {
  fs.mkdirSync(path.dirname(storagePath()), { recursive: true });
  const temporary = storagePath() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(conversations, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, storagePath());
}

function createConversation() {
  const now = new Date().toISOString();
  const conversation = { id: randomUUID(), title: "新对话", sessionId: "", createdAt: now, updatedAt: now, messages: [] };
  conversation.archiveFile = archiveFileName(conversation.title, conversation.createdAt);
  const all = read();
  all.unshift(conversation);
  write(all);
  writeArchive(conversation);
  return conversation;
}

function listConversations() {
  return read()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ id, title, updatedAt, sessionId, archiveFile }) => ({ id, title, updatedAt, sessionId, archiveFile }));
}

function getConversation(id) {
  return read().find((conversation) => conversation.id === id) || null;
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

function addAssistantMessage(id, text, sessionId, files = [], tools = [], requestId = "", connectionMode = "ssh") {
  return update(id, (conversation) => {
    const draft = requestId
      ? conversation.messages.find((message) => message.role === "assistant" && message.requestId === requestId)
      : null;
    const completed = { role: "assistant", text, files, tools, at: draft?.at || new Date().toISOString() };
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

function update(id, mutate) {
  const all = read();
  const conversation = all.find((item) => item.id === id);
  if (!conversation) throw new Error("找不到此本地对话。请新建对话后重试。");
  const previousArchiveFile = conversation.archiveFile || archiveFileName(conversation.title, conversation.createdAt);
  mutate(conversation);
  conversation.updatedAt = new Date().toISOString();
  conversation.archiveFile = archiveFileName(conversation.title, conversation.createdAt);
  write(all);
  writeArchive(conversation, previousArchiveFile);
  return conversation;
}

function ensureConversationArchives() {
  const all = read();
  let changed = false;
  for (const conversation of all) {
    if (!conversation.archiveFile) {
      conversation.archiveFile = archiveFileName(conversation.title, conversation.createdAt);
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

function sessionForMode(conversation, connectionMode) {
  if (!conversation) return "";
  if (connectionMode === "local") return conversation.localSessionId || "";
  return conversation.sshSessionId || (conversation.lastConnectionMode !== "local" ? conversation.sessionId || "" : "");
}

module.exports = {
  addAssistantMessage,
  addUserMessage,
  createConversation,
  deleteConversation,
  ensureConversationArchives,
  getConversation,
  listConversations,
  archiveDirectory,
  prepareConversationDirectory,
  renameConversation,
  saveAssistantDraft,
  sessionForMode
};
