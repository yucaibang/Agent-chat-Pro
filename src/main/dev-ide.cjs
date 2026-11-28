"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// v3.47.0 开发面板 IDE 编辑：文件浏览 / 原位读 / 原位写 / 新建文件
//
// 空间路由（与 AI 的执行空间同一目录世界）：
//   SSH 模式  = 远端主机工作目录（config.workingDirectory，SFTP 原位读写——AI 在那台机器
//               干活，你编辑的就是 AI 干活的同一块）；
//   本机/云端 = 本机工作目录（云端 AI 的 write_file 工具也落这里，v3.14.0 五工具本机执行
//               先例同一空间）。
//
// 安全边界：
//   一切路径锁死工作目录内——远端用 POSIX 护栏（assertInsidePosix，cloud-tools
//   resolveInsideWorkdirPosix 同族）、本机用本地护栏（assertInsideLocal）；.. 逃逸、绝对
//   路径、\0 一律拒绝；单文件编辑上限 IDE_MAX_FILE_BYTES；非 UTF-8 文本拒编辑（二进制
//   如实提示）；目录清单单次最多 IDE_DIR_MAX 条（超限如实标 truncated）。
//
// 注入式（可测）：SSH 面（statRemoteFile/listRemoteDir/writeRemoteFile/readRemoteFile/
//   createRemoteFile）与 fs 面由 main.cjs 注入；守门 A 组以假 SSH/假 fs 真跑护栏与路由。
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");

const IDE_MAX_FILE_BYTES = 128 * 1024;
const IDE_DIR_MAX = 500;
/** 自产临时件名痕（与 ssh.cjs sftpTemporaryPath / 本地事务写同族）；文件树里过滤不显 */
const IDE_TEMP_FILE_MARK = ".agent-chat-pro-part";

/**
 * SSH 层「资源不存在」判定（v3.48.1；ssh.cjs isSshResourceMissing 同族语义互指）。
 * ⚠ ssh2 的 SFTP 错误 code 是协议数字（SSH_FX_NO_SUCH_FILE=2），不是 "ENOENT" 字符串。
 */
function isSshResourceMissing(error) {
  if (!error) return false;
  return error.code === 2 || error.code === "ENOENT" || /no such file/i.test(String(error.message || ""));
}

/** 远端 POSIX 路径护栏：目标必须落在工作目录内（绝对/越界/\0 全拒；工作目录自身=浏览根） */
function assertInsidePosix(workdir, relativePath) {
  const raw = String(relativePath || "").trim() || ".";
  if (raw.includes("\0")) throw new Error("路径包含非法字符。");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw new Error("请使用工作目录内的相对路径。");
  const base = path.posix.resolve(String(workdir || "").trim() || "/");
  const target = path.posix.resolve(base, raw);
  const rel = path.posix.relative(base, target);
  if (rel.startsWith("..") || path.posix.isAbsolute(rel)) {
    throw new Error(`路径超出工作目录范围：${raw.length > 120 ? `${raw.slice(0, 120)}…` : raw}`);
  }
  return target;
}

/** 本地路径护栏：同族语义（path.resolve + 相对包含校验；Windows 反斜杠由 resolve 归一） */
function assertInsideLocal(workdir, relativePath) {
  const rawBase = String(workdir || "").trim();
  if (!rawBase) throw new Error("工作目录未配置，请先在连接设置中配置工作目录。"); // 空会落到 cwd，必须在 resolve 前拒
  const base = path.resolve(rawBase);
  const raw = String(relativePath || "").trim() || ".";
  if (raw.includes("\0")) throw new Error("路径包含非法字符。");
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("/")) throw new Error("请使用工作目录内的相对路径。");
  const target = path.resolve(base, raw);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径超出工作目录范围：${raw.length > 120 ? `${raw.slice(0, 120)}…` : raw}`);
  }
  return target;
}

/** 严格 UTF-8 解码（fatal）：非 UTF-8 一律判二进制拒编辑 */
function decodeText(data) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("该文件是二进制内容，不能在编辑器打开。");
  }
}

/** 写回负载：统一转 Buffer + 上限校验（读入 128KB 以内的内容也经此面二次把关） */
function checkTextPayload(content) {
  const data = Buffer.from(String(content ?? ""), "utf8");
  if (data.length > IDE_MAX_FILE_BYTES) {
    throw new Error(`内容超过 ${Math.round(IDE_MAX_FILE_BYTES / 1024)} KB 编辑保存上限。`);
  }
  return data;
}

/** 目录优先 + 中文名序（用户扫文件树时先见目录） */
function sortEntries(entries) {
  return [...entries].sort((a, b) =>
    (Number(b.type === "dir") - Number(a.type === "dir")) ||
    String(a.name).localeCompare(String(b.name), "zh-CN"));
}

function clipEntries(entries) {
  if (entries.length > IDE_DIR_MAX) return { entries: entries.slice(0, IDE_DIR_MAX), truncated: true };
  return { entries, truncated: false };
}

// ── SSH（远端工作目录）──
function makeSshIde(deps) {
  const ssh = deps.ssh;
  return {
    async list({ config, rel, onUnknownHost, onLog }) {
      const abs = assertInsidePosix(config.workingDirectory, rel);
      const raw = await ssh.listRemoteDir(config, abs, onUnknownHost, onLog);
      const entries = (raw || []).map((entry) => ({
        name: String(entry?.name || ""),
        type: entry?.type === "dir" ? "dir" : "file",
        size: Number(entry?.size || 0),
        hidden: String(entry?.name || "").startsWith(".")
      })).filter((entry) => entry.name && entry.name !== "." // 去自引用项（树层去重）
        && !entry.name.includes(IDE_TEMP_FILE_MARK)); // 过滤自身事务写临时件（v3.48.1）
      const clipped = clipEntries(sortEntries(entries));
      return { entries: clipped.entries, truncated: clipped.truncated, abs };
    },
    async read({ config, rel, onUnknownHost, onLog }) {
      const abs = assertInsidePosix(config.workingDirectory, rel);
      let meta;
      try {
        meta = await ssh.statRemoteFile(config, abs, onUnknownHost, onLog);
      } catch (error) {
        // v3.48.1：不存在=友好文案（对齐本机路「文件不存在或不可读。」），其余错误如实上抛
        if (isSshResourceMissing(error)) throw new Error("文件不存在或不可读。");
        throw error;
      }
      if (meta.isDirectory) throw new Error("这是一个目录，请在文件树上浏览。");
      if (meta.size > IDE_MAX_FILE_BYTES) throw new Error(`文件超过 ${Math.round(IDE_MAX_FILE_BYTES / 1024)} KB 编辑打开上限。`);
      const data = await ssh.readRemoteFile(config, abs, IDE_MAX_FILE_BYTES + 1, onUnknownHost, onLog);
      // stat 与 read 之间远端被追加的竞态兜底：截到上限内再解码，防止多字节字符跨端截半被误判二进制
      const clamped = data.length > IDE_MAX_FILE_BYTES ? data.subarray(0, IDE_MAX_FILE_BYTES) : data;
      return { content: decodeText(clamped), size: clamped.length };
    },
    async write({ config, rel, content, onUnknownHost, onLog }) {
      const abs = assertInsidePosix(config.workingDirectory, rel);
      const data = checkTextPayload(content);
      await ssh.writeRemoteFile(config, abs, data, onUnknownHost, onLog);
      return { size: data.length };
    },
    async create({ config, rel, onUnknownHost, onLog }) {
      const abs = assertInsidePosix(config.workingDirectory, rel);
      await ssh.createRemoteFile(config, abs, onUnknownHost, onLog);
      return { size: 0 };
    }
  };
}

// ── 本机（本机/云端工作目录）──
function makeLocalIde(deps) {
  const fs = deps.fs; // fs.promises 面
  return {
    async list({ config, rel }) {
      const abs = assertInsideLocal(config.workingDirectory, rel);
      const dirents = await fs.readdir(abs, { withFileTypes: true });
      const entries = [];
      for (const dirent of dirents || []) {
        const name = String(dirent.name || "");
        if (!name || name === "." || name.includes(IDE_TEMP_FILE_MARK)) continue; // 过滤自身事务写临时件（v3.48.1）
        const type = dirent.isDirectory() ? "dir" : "file";
        let size = 0;
        if (type === "file") {
          try {
            size = (await fs.stat(path.join(abs, name))).size;
          } catch { /* stat 失败按 0 展示，不挡浏览 */ }
        }
        entries.push({ name, type, size, hidden: name.startsWith(".") });
      }
      const clipped = clipEntries(sortEntries(entries));
      return { entries: clipped.entries, truncated: clipped.truncated, abs };
    },
    async read({ config, rel }) {
      const abs = assertInsideLocal(config.workingDirectory, rel);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        throw new Error("文件不存在或不可读。");
      }
      if (stat.isDirectory()) throw new Error("这是一个目录，请在文件树上浏览。");
      if (stat.size > IDE_MAX_FILE_BYTES) throw new Error(`文件超过 ${Math.round(IDE_MAX_FILE_BYTES / 1024)} KB 编辑打开上限。`);
      const data = await fs.readFile(abs);
      return { content: decodeText(data), size: data.length };
    },
    async write({ config, rel, content }) {
      const abs = assertInsideLocal(config.workingDirectory, rel);
      const data = checkTextPayload(content);
      // v3.48.1 事务写：直写流式覆盖在磁盘满/进程被杀半程会把原文件截断成半文件——
      // 先写同目录临时件、成功后原子改名覆盖；两步任一失败都清理临时件并如实上抛。
      const temporary = `${abs}${IDE_TEMP_FILE_MARK}`;
      try {
        await fs.writeFile(temporary, data);
      } catch (error) {
        try { await fs.rm(temporary, { force: true }); } catch { /* 收尾尽力 */ }
        throw error;
      }
      try {
        await fs.rename(temporary, abs); // 同目录改名不跨卷；Node/Win 语义均覆盖已存在目标
      } catch (error) {
        try { await fs.rm(temporary, { force: true }); } catch { /* 收尾尽力 */ }
        throw error;
      }
      return { size: data.length };
    },
    async create({ config, rel }) {
      const abs = assertInsideLocal(config.workingDirectory, rel);
      try {
        await fs.writeFile(abs, Buffer.alloc(0), { flag: "wx" }); // 存在即拒
      } catch (error) {
        if (error.code === "EEXIST") throw new Error("该路径已存在文件或目录。");
        throw error;
      }
      return { size: 0 };
    }
  };
}

/** 统一入口：mode 路由（ssh=远端；cloud/local=本机）——载荷同构 {config, rel, ...} */
function makeIdeToolkit(deps) {
  const ssh = makeSshIde(deps);
  const local = makeLocalIde(deps);
  const pick = (payload) => (payload?.mode === "ssh" ? ssh : local);
  return {
    list: (payload) => pick(payload).list(payload),
    read: (payload) => pick(payload).read(payload),
    write: (payload) => pick(payload).write(payload),
    create: (payload) => pick(payload).create(payload)
  };
}

module.exports = {
  makeIdeToolkit,
  assertInsidePosix,
  assertInsideLocal,
  isSshResourceMissing,
  decodeText,
  checkTextPayload,
  sortEntries,
  clipEntries,
  IDE_MAX_FILE_BYTES,
  IDE_DIR_MAX,
  IDE_TEMP_FILE_MARK
};
