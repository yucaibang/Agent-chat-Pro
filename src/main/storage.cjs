"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const CONVERSATIONS_FILE = "conversations.json";
const ARCHIVE_FOLDER = "会话存档";

function samePath(left, right) {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(String(right || ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function probeWritable(directory) {
  await fs.promises.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.agent-orbit-write-test-${process.pid}-${randomUUID()}`);
  try {
    await fs.promises.writeFile(probe, "ok", { flag: "wx" });
  } catch (error) {
    throw new Error("所选聊天记录目录不可写：" + error.message);
  } finally {
    await fs.promises.rm(probe, { force: true });
  }
}

async function readConversationFile(file, label) {
  try {
    const value = JSON.parse(await fs.promises.readFile(file, "utf8"));
    if (!Array.isArray(value)) throw new Error("内容不是会话列表");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`${label} conversations.json 无法识别，为防止覆盖数据已取消切换：${error.message}`);
  }
}

function mergeConversations(source, destination) {
  const merged = [];
  const seen = new Set();
  for (const conversation of [...source, ...destination]) {
    const id = String(conversation?.id || "");
    const key = id || `legacy:${JSON.stringify(conversation)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(conversation);
  }
  return merged;
}

async function replaceFileSafely(destination, writer) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.migrating-${process.pid}-${randomUUID()}`;
  const backup = `${destination}.backup-${process.pid}-${randomUUID()}`;
  let backedUp = false;
  try {
    await writer(temporary);
    try {
      await fs.promises.rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.promises.rename(temporary, destination);
    if (backedUp) await fs.promises.rm(backup, { force: true });
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    if (backedUp) {
      try { await fs.promises.access(destination); }
      catch {
        try { await fs.promises.rename(backup, destination); } catch {}
      }
    }
    throw error;
  }
}

async function copyArchiveTree(source, destination) {
  try { await fs.promises.access(source); } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  if (samePath(source, destination) || isInside(source, destination)) {
    throw new Error("不能把聊天记录目录选在原来的"会话存档"文件夹内部，否则会造成递归复制。请另选一个独立文件夹。");
  }
  let copied = 0;
  async function visit(from, to) {
    await fs.promises.mkdir(to, { recursive: true });
    for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
      const sourceEntry = path.join(from, entry.name);
      const targetEntry = path.join(to, entry.name);
      if (entry.isDirectory()) await visit(sourceEntry, targetEntry);
      else if (entry.isFile()) {
        await replaceFileSafely(targetEntry, (temporary) => fs.promises.copyFile(sourceEntry, temporary));
        copied += 1;
      }
    }
  }
  await visit(source, destination);
  return copied;
}

async function migrateConversationDirectory(currentDirectory, nextDirectory) {
  const current = path.resolve(String(currentDirectory || ""));
  const target = path.resolve(String(nextDirectory || ""));
  if (!nextDirectory) throw new Error("请选择聊天记录保存文件夹。");
  await probeWritable(target);
  if (samePath(current, target)) {
    return { directory: target, changed: false, conversations: 0, archives: 0, mergedExisting: false };
  }

  const sourceArchive = path.join(current, ARCHIVE_FOLDER);
  const destinationArchive = path.join(target, ARCHIVE_FOLDER);
  if (samePath(sourceArchive, target) || isInside(sourceArchive, target)) {
    throw new Error("不能选择原来的"会话存档"文件夹或它的子文件夹。请新建一个独立文件夹后重试。");
  }

  const sourceFile = path.join(current, CONVERSATIONS_FILE);
  const destinationFile = path.join(target, CONVERSATIONS_FILE);
  const source = await readConversationFile(sourceFile, "原目录的");
  const destination = await readConversationFile(destinationFile, "目标目录已有的");
  const merged = mergeConversations(source, destination);
  if (source.length || destination.length) {
    await replaceFileSafely(destinationFile, (temporary) => {
      return fs.promises.writeFile(temporary, JSON.stringify(merged, null, 2), { mode: 0o600 });
    });
  }
  const archives = await copyArchiveTree(sourceArchive, destinationArchive);
  return {
    directory: target,
    changed: true,
    conversations: merged.length,
    archives,
    mergedExisting: destination.length > 0
  };
}

module.exports = {
  ARCHIVE_FOLDER,
  CONVERSATIONS_FILE,
  isInside,
  mergeConversations,
  migrateConversationDirectory,
  samePath
};