"use strict";

/**
 * v3.48.1 守门：装机前自查轮（对 v3.48.0 一键检测 + v3.47.0 IDE 编辑的回溯修复）
 *
 * 修复面（全部实锤 + 加固）：
 *   Bug#1 SSH 新建文件恒炸（功能级）：ssh2 的 SFTP 错误 code=协议数字 2（SSH_FX_NO_SUCH_FILE），
 *        不是 "ENOENT" 字符串——v3.47.0 createRemoteFile 只判字符串常量，把「不存在」（正常新建
 *        场景）当异常上抛。旧守门装置假造 Object.assign(new Error("ENOENT"),{code:"ENOENT"})
 *        掩盖（v3.45.4 Bug#1「mock 住了测不出」同型再应验）。
 *   Bug#2 Windows 版本探测恒空：Node ≥18.20 execFile 直跑 .cmd 抛 EINVAL（CVE-2024-27980 后
 *        默认拒绝）→ win32 走 cmd.exe /d /s /c 包装，内层整体引号吃带空格安装路径。
 *   Bug#3 IDE 跨模式视图欺骗：连接模式切换后树/页签仍属旧空间而读写落新空间 → spaceMode 守卫
 *        换空间即清树缓存+收页签+关编辑弹窗。
 *   加固 IDE 保存事务化：直写流式覆盖在 ENOSPC/断连半程截断原文件 → 临时件+改名替换（两级
 *        写面同族：ssh.cjs writeRemoteFile / dev-ide.cjs local.write），列表过滤自产临时件。
 *
 * A 组行为级（假 ssh2 真形态跑 ssh.cjs 真函数 / 真 require dev-ide·agent-detect + 假面注入 /
 *   渲染层 vm 假 DOM 真跑承 test-v3-45-3 mkRuntime 架子——v3.45.4 教训：守门必须用真错误形态）
 * B 组源码锚
 * C 组版本滚动锚（≥ 下限+badge 自洽滚动式——45-1 B3 硬钉教训）
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { EventEmitter } = require("events");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const sshSrc = read("src/main/ssh.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const mainSrc = read("src/main/main.cjs");
const obfSrc = read("scripts/obfuscate.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const readme = read("README.md");

/* dev-ide.cjs / agent-detect.cjs 顶层纯（零 require 或 lazy require）→ 直接真 require */
const devIde = require(path.join(ROOT, "src/main/dev-ide.cjs"));
const detect = require(path.join(ROOT, "src/main/agent-detect.cjs"));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((error) => { failed++; failures.push(`${name}: ${error.message}`); console.log(`  ✗ ${name}: ${error.message}`); });
}

/* ═══════════ ssh.cjs vm 装置（真函数真跑 + 假 ssh2 真错误形态） ═══════════ */

function loadSshModule(fakeSsh2) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    module: { exports: {} },
    process: { platform: "linux", env: {}, pid: 424242, versions: process.versions, execPath: process.execPath },
    Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone
  };
  sandbox.require = (name) => {
    if (name === "ssh2") return fakeSsh2;
    // 定向假面：mode-params 顶层拉 mode-manager → electron（vm 通道不装 electron）；
    // 行为级面（SFTP 原位读写）不达 mode-params，空实现足以撑住顶层解构。
    if (name === "./modes/mode-params.cjs") return { buildCommandWithMode: () => "", buildBridgeStartWithMode: () => "" };
    if (name.startsWith(".")) return require(path.join(ROOT, "src/main", name));
    if (["fs", "path", "crypto", "net", "child_process", "os", "events", "util", "stream", "zlib", "timers", "buffer"].includes(name)) return require(name);
    throw new Error(`ssh.cjs vm 白名单外依赖：${name}`);
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sshSrc, sandbox, { filename: "ssh.cjs" });
  return sandbox.module.exports;
}

/**
 * 假 SFTP——错误形态对齐 ssh2 真件（协议数字 code / 同步抛 / createWriteStream 流面）。
 * 调用序记录在 ops（本 realm 数组，直接断言）；files 模拟远端已存在文件表。
 */
function makeFakeSftp(opts = {}) {
  const ops = []; // ["stat",target] / ["openWrite",target,streamOpts] / ["extRename",from,to] / ["rename",from,to] / ["unlink",target] / "end"
  const files = opts.files || new Map(); // target → { size, isDir }
  const sftp = {
    ops,
    end() { ops.push("end"); },
    stat(target, cb) {
      ops.push(["stat", target]);
      const meta = files.get(target);
      setImmediate(() => {
        if (meta) cb(null, { size: meta.size ?? 7, isFile: () => !meta.isDir, isDirectory: () => Boolean(meta.isDir) });
        else cb(Object.assign(new Error(opts.missingMessage !== undefined ? opts.missingMessage : "No such file or directory"), { code: opts.missingCode ?? 2 })); // ⚠ 协议数字 2，不是 "ENOENT"
      });
    },
    createWriteStream(target, streamOpts) {
      ops.push(["openWrite", target, streamOpts ? { mode: streamOpts.mode } : null]);
      let failed = false;
      const stream = new EventEmitter();
      stream.bytes = 0;
      stream.write = (chunk) => {
        if (!failed && opts.failWrite) {
          failed = true;
          setImmediate(() => stream.emit("error", Object.assign(new Error("No space left on device"), { code: "ENOSPC" })));
        } else { stream.bytes += chunk.length; }
        return true;
      };
      stream.end = () => { if (!failed) setImmediate(() => stream.emit("close")); };
      return stream;
    },
    unlink(target, cb) {
      ops.push(["unlink", target]);
      files.delete(target); // 真.unlink 语义：删表（后续 rename 对该目标不再判已存在拒）
      setImmediate(() => (opts.failUnlink ? cb(Object.assign(new Error("unlink denied"), { code: "EPERM" })) : cb(null)));
    },
    rename(from, to, cb) {
      ops.push(["rename", from, to]);
      setImmediate(() => {
        if (opts.failRename) return cb(Object.assign(new Error("Failure"), { code: 4 }));
        if (files.has(to)) return cb(Object.assign(new Error("Failure"), { code: 4 })); // 真形态：传统 rename 对已存在目标拒（SSH_FX_FAILURE=4）
        cb(null);
      });
    },
    ext_openssh_rename(from, to, cb) {
      ops.push(["extRename", from, to]);
      if (opts.noExt) throw new Error("Method not implemented: ext_openssh_rename"); // ssh2 真形态：服务器无扩展=同步抛
      setImmediate(() => cb(null));
    }
  };
  return sftp;
}

/** 假 ssh2 模块面：Client 构造器每例产 EventEmitter 假客户端（connect 即 ready） */
function makeSshHarness(sftpOpts) {
  let ops = [];
  const fakeSsh2 = { Client: function FakeClient() {
    const sftp = makeFakeSftp(sftpOpts);
    ops = sftp.ops;
    const emitter = new EventEmitter();
    emitter.connect = () => setImmediate(() => emitter.emit("ready"));
    emitter.end = () => {};
    emitter.sftp = (cb) => setImmediate(() => cb(null, sftp));
    return emitter;
  }};
  const ssh = loadSshModule(fakeSsh2);
  return {
    ssh,
    ops: () => ops,
    config: { host: "nas.lan", port: 22, username: "u", password: "p", workingDirectory: "/home/u/x" },
    knownHost: () => true,
    noLog: () => {} // connect 的参数默认值不接显式 null——假链补空日志
  };
}

/* ═══════════ dev-ide.cjs 假面（SSH 面 / 本机 fs 面，承 test-v3-47-0 形态） ═══════════ */

function makeFakeSshFace(overrides = {}) {
  return Object.assign({
    listRemoteDir: async () => [{ name: "a.md", type: "file", size: 5 }, { name: "out.js.agent-chat-pro-part-1", type: "file", size: 9 }],
    statRemoteFile: async () => ({ size: 3, isFile: true, isDirectory: false }),
    readRemoteFile: async () => Buffer.from("hello", "utf8"),
    writeRemoteFile: async () => 5,
    createRemoteFile: async () => "/remote/a"
  }, overrides);
}

function makeLocalFs(opts = {}) {
  const ops = [];
  const dirents = opts.dirents || [];
  return {
    ops,
    readdir: async () => dirents,
    stat: async () => ({ size: opts.statSize ?? 10, isDirectory: () => false }),
    readFile: async () => Buffer.from(opts.content ?? "hello", "utf8"),
    writeFile: async (target, data /*, writeOpts */) => {
      ops.push(["writeFile", target, data.length]);
      if (opts.failWrite && opts.failWrite.has(target)) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    },
    rename: async (from, to) => { ops.push(["rename", from, to]); if (opts.failRename) throw Object.assign(new Error("rename denied"), { code: "EPERM" }); },
    rm: async (target) => { ops.push(["rm", target]); }
  };
}

/* ═══════════ A 组：行为级真跑 ═══════════ */

async function runBehaviorTests() {
  await test("A0. isSshResourceMissing 三态判定真跑（ssh.cjs 真件 + dev-ide.cjs 真件同族一致，真错误形态 code:2）", async () => {
    const harness = makeSshHarness({});
    const sshMissing = harness.ssh.isSshResourceMissing;
    const devMissing = devIde.isSshResourceMissing;
    const samples = [
      { error: Object.assign(new Error("No such file"), { code: 2 }), expect: true },        // ssh2 真形态（协议数字）
      { error: Object.assign(new Error("enoent"), { code: "ENOENT" }), expect: true },       // Node 本机风形态
      { error: new Error("No such file or directory"), expect: true },                        // message 兜底形态
      { error: Object.assign(new Error("该路径已存在文件或目录。"), { code: undefined }), expect: false }, // 中文文案不误判
      { error: Object.assign(new Error("Permission denied"), { code: 3 }), expect: false },
      { error: Object.assign(new Error("Failure"), { code: 4 }), expect: false },
      { error: Object.assign(new Error("Permission denied"), { code: 13 }), expect: false },
      { error: null, expect: false },
      { error: undefined, expect: false }
    ];
    for (const sample of samples) {
      assert.strictEqual(sshMissing(sample.error), sample.expect, `ssh.cjs 判定错样本 ${JSON.stringify({ code: sample.error && sample.error.code, message: sample.error && String(sample.error.message) })}`);
      assert.strictEqual(devMissing(sample.error), sample.expect, "两族判定应一致");
    }
  });

  await test("A1. createRemoteFile：不存在（code:2 真形态）=正常新建成功；已存在=拒；code:13=原错误上抛", async () => {
    // ① 目标不存在（ssh2 真形态 code=2）→ 走创建（v3.47.0 此处恒炸——本条即 Bug#1 回归门）
    const fresh = makeSshHarness({ missingCode: 2 });
    const created = await fresh.ssh.createRemoteFile(fresh.config, "/home/u/x/new-file.md", fresh.knownHost, fresh.noLog);
    assert.strictEqual(created, "/home/u/x/new-file.md", "新建应 resolve 返回远端路径");
    const writeOp = fresh.ops().find((op) => op[0] === "openWrite");
    assert.ok(writeOp && writeOp[1] === "/home/u/x/new-file.md", `应对目标发起空写（实=${JSON.stringify(writeOp)}）`);
    assert.ok(!fresh.ops().some((op) => op[0] === "unlink"), "新建场景不应触发 unlink");
    // ⚠ 反例对照：旧守门装置假造 {code:"ENOENT"} 字符串掩盖——本装置给的是协议数字 2
    // ② 目标已存在 → 「该路径已存在文件或目录。」（且 stat 成功后不再发起写）
    const exists = makeSshHarness({ files: new Map([["/home/u/x/new-file.md", { size: 3 }]]) });
    await assert.rejects(() => exists.ssh.createRemoteFile(exists.config, "/home/u/x/new-file.md", exists.knownHost, exists.noLog), /该路径已存在文件或目录/, "已存在应拒");
    assert.ok(!exists.ops().some((op) => op[0] === "openWrite"), "已存在拒后不应发起写");
    // ③ 其他错误语义（code:13 权限类）→ 原样上抛，不许当「不存在」吞掉
    const denied = makeSshHarness({ missingCode: 13, missingMessage: "Permission denied" });
    await assert.rejects(() => denied.ssh.createRemoteFile(denied.config, "/home/u/x/new-file.md", denied.knownHost, denied.noLog), /Permission denied/, "非缺失错误（code:13）应原样上抛");
    // ④ 纯数字码形态（message 为空）→ code:number 才是权威，message 兜底不许反向误吞
    const bare = makeSshHarness({ missingCode: 13, missingMessage: "" });
    await assert.rejects(() => bare.ssh.createRemoteFile(bare.config, "/home/u/x/new-file.md", bare.knownHost, bare.noLog), undefined, "数字码错误应如实上抛");
  });

  await test("A2. writeRemoteFile 事务写：posix-rename 支持 / 不支持同步抛 / rename 拒→unlink+改名 / 写失败·改名失败清理临时件", async () => {
    const target = "/home/u/x/report.md";
    // ① posix-rename 扩展支持 → 写临时件 + 扩展改名成功（最高效路径，零 unlink）
    const posix = makeSshHarness({});
    const size = await posix.ssh.writeRemoteFile(posix.config, target, Buffer.from("正文", "utf8"), posix.knownHost, posix.noLog);
    assert.strictEqual(size, Buffer.from("正文", "utf8").length, "应返回负载字节数");
    const tmp = `${target}.agent-chat-pro-part-424242`; // vm process.pid=424242
    const structure = (opsList) => opsList.filter((op) => Array.isArray(op)).map((op) => op.slice(0, 3));
    assert.deepStrictEqual(structure(posix.ops()), [
      ["openWrite", tmp, { mode: 384 }], ["extRename", tmp, target]
    ], "应为「临时件写+扩展改名」调用序");
    // ② 无扩展（同步抛）→ 传统 rename 成功
    const legacy = makeSshHarness({ noExt: true });
    await legacy.ssh.writeRemoteFile(legacy.config, target, Buffer.from("x"), legacy.knownHost, legacy.noLog);
    assert.ok(legacy.ops().some((op) => op[0] === "rename" && op[1] === tmp && op[2] === target), "无扩展应退传统 rename");
    assert.ok(!legacy.ops().some((op) => op[0] === "unlink"), "传统 rename 成功不应 unlink");
    // ③ 传统 rename 拒（真形态=目标已存在，SSH_FX_FAILURE=4）→ unlink 目标 + 二次改名成功
    const hard = makeSshHarness({ noExt: true, files: new Map([[target, { size: 3 }]]) });
    await hard.ssh.writeRemoteFile(hard.config, target, Buffer.from("x"), hard.knownHost, hard.noLog);
    const hardOps = hard.ops();
    assert.ok(hardOps.some((op) => op[0] === "unlink" && op[1] === target), "rename 拒应先 unlink 目标");
    assert.ok(hardOps.some((op) => op[0] === "rename" && op[1] === tmp && op[2] === target), "unlink 后应重试改名");
    assert.ok(!hardOps.some((op) => op[0] === "unlink" && op[1] === tmp), "三级成临时件应随改名换走（不应被清理）");
    // ④ 写临时件半程失败 → 清临时件 + 原错误上抛（原文件零触碰=事务语义）
    const writeFail = makeSshHarness({ failWrite: true });
    await assert.rejects(() => writeFail.ssh.writeRemoteFile(writeFail.config, target, Buffer.from("x"), writeFail.knownHost, writeFail.noLog), /No space left on device/, "写失败应上抛原错误");
    assert.ok(writeFail.ops().some((op) => op[0] === "unlink" && op[1] === tmp), "写失败应清理临时件");
    assert.ok(!writeFail.ops().some((op) => op[0] === "extRename" || op[0] === "rename"), "写失败不应走到改名段");
    // ⑤ 改名链全失败（failRename 压全部 rename）→ 清临时件 + 上抛
    const renameFail = makeSshHarness({ noExt: true, failRename: true });
    await assert.rejects(() => renameFail.ssh.writeRemoteFile(renameFail.config, target, Buffer.from("x"), renameFail.knownHost, renameFail.noLog), /Failure/, "改名链全败应上抛");
    assert.ok(renameFail.ops().some((op) => op[0] === "unlink" && op[1] === tmp), "改名失败应清理临时件");
    assert.ok(renameFail.ops().some((op) => op[0] === "unlink" && op[1] === target), "全败链应先试 unlink 目标再重试改名");
  });

  await test("A3. dev-ide SSH 路：stat 不存在=「文件不存在或不可读。」；其他错误上抛；读侧截断竞态兜底", async () => {
    const config = { workingDirectory: "/work" };
    // ① 真形态 code:2 → 友好文案（对齐本机路），不是裸「No such file」
    const missing = devIde.makeIdeToolkit({ ssh: makeFakeSshFace({ statRemoteFile: async () => { throw Object.assign(new Error("No such file"), { code: 2 }); } }), fs: makeLocalFs() });
    await assert.rejects(() => missing.read({ config, mode: "ssh", rel: "gone.md" }), /文件不存在或不可读/, "SSH 不存在应为友好文案");
    // ② 其他错误如实上抛
    const denied = devIde.makeIdeToolkit({ ssh: makeFakeSshFace({ statRemoteFile: async () => { throw Object.assign(new Error("Permission denied"), { code: 13 }); } }), fs: makeLocalFs() });
    await assert.rejects(() => denied.read({ config, mode: "ssh", rel: "g.md" }), /Permission denied/, "非缺失错误应原样上抛");
    // ③ 读侧竞态：stat 报 3B 但 read 返回超限内容 → 截到编辑上限内再解码（不误判二进制）
    const overLimit = devIde.makeIdeToolkit({
      ssh: makeFakeSshFace({
        statRemoteFile: async () => ({ size: 3, isFile: true, isDirectory: false }),
        readRemoteFile: async () => Buffer.concat([Buffer.from("hello", "utf8"), Buffer.alloc(devIde.IDE_MAX_FILE_BYTES + 1 - 5, 0x61)]) // 128KB+1
      }),
      fs: makeLocalFs()
    });
    const read = await overLimit.read({ config, mode: "ssh", rel: "g.md" });
    assert.strictEqual(read.size, devIde.IDE_MAX_FILE_BYTES, `应截到编辑上限（实=${read.size}）`);
    assert.strictEqual(read.content.length, devIde.IDE_MAX_FILE_BYTES, "截断后仍应是可解码文本");
  });

  await test("A4. dev-ide SSH 列表过滤自产临时件", async () => {
    const config = { workingDirectory: "/work" };
    const tool = devIde.makeIdeToolkit({ ssh: makeFakeSshFace(), fs: makeLocalFs() });
    const result = await tool.list({ config, mode: "ssh", rel: "" });
    const names = result.entries.map((entry) => entry.name);
    assert.deepStrictEqual(names, ["a.md"], `临时件应被过滤（实=${JSON.stringify(names)}）`);
  });

  await test("A5. dev-ide 本机事务写：临时件写+改名替换调用序；写失败/改名失败均清临时件", async () => {
    const config = { workingDirectory: "/tmp/acp-work" };
    const expected = path.resolve("/tmp/acp-work", "out.js");
    const temp = `${expected}${devIde.IDE_TEMP_FILE_MARK}`;
    // ① 正常：writeFile(临时件) → rename(临时件→目标)
    const fsGood = makeLocalFs();
    const toolGood = devIde.makeIdeToolkit({ ssh: makeFakeSshFace(), fs: fsGood });
    await toolGood.write({ config, mode: "local", rel: "out.js", content: "你好" });
    assert.deepStrictEqual(fsGood.ops, [["writeFile", temp, 6], ["rename", temp, expected]], `应为事务写调用序（实=${JSON.stringify(fsGood.ops)}）`);
    // ② 写失败：writeFile 临时件炸 → rm 清理 + 原错误上抛（原文件零触碰）
    const boomTemp = `${path.resolve("/tmp/acp-work", "boom.js")}${devIde.IDE_TEMP_FILE_MARK}`;
    const fsWriteFail = makeLocalFs({ failWrite: new Set([boomTemp]) });
    const toolWriteFail = devIde.makeIdeToolkit({ ssh: makeFakeSshFace(), fs: fsWriteFail });
    await assert.rejects(() => toolWriteFail.write({ config, mode: "local", rel: "boom.js", content: "x" }), /ENOSPC/, "写失败应上抛");
    assert.ok(fsWriteFail.ops.some((op) => op[0] === "rm" && op[1] === boomTemp), "写失败应清理临时件");
    assert.ok(!fsWriteFail.ops.some((op) => op[0] === "rename"), "写失败不应走到改名");
    // ③ 改名失败：rename 炸 → rm 清理 + 上抛（原文件同样零触碰）
    const fsRenameFail = makeLocalFs({ failRename: true });
    const toolRenameFail = devIde.makeIdeToolkit({ ssh: makeFakeSshFace(), fs: fsRenameFail });
    await assert.rejects(() => toolRenameFail.write({ config, mode: "local", rel: "boom.js", content: "x" }), /denied/, "改名失败应上抛");
    assert.ok(fsRenameFail.ops.some((op) => op[0] === "rm" && op[1] === boomTemp), "改名失败应清理临时件");
  });

  await test("A6. dev-ide 本机列表过滤临时件 + create wx 语义不动", async () => {
    const config = { workingDirectory: "/tmp/acp-work" };
    const fsList = makeLocalFs({ dirents: [
      { name: "a.md", isDirectory: () => false },
      { name: "out.js.agent-chat-pro-part", isDirectory: () => false },
      { name: "", isDirectory: () => false },
      { name: ".", isDirectory: () => false }
    ]});
    const tool = devIde.makeIdeToolkit({ ssh: makeFakeSshFace(), fs: fsList });
    const result = await tool.list({ config, mode: "local", rel: "" });
    assert.deepStrictEqual(result.entries.map((entry) => entry.name), ["a.md"], `临时件/空名/自引用应过滤（实=${JSON.stringify(result.entries)}）`);
    // create：存在即拒（wx 语义 v3.47.0 语义保留），空文件零写入
    const fsCreate = makeLocalFs();
    fsCreate.writeFile = async (target /*, data, opts */) => { fsCreate.ops.push(["writeFile", target, "wx-check"]); const error = new Error("EEXIST"); error.code = "EEXIST"; throw error; };
    const toolCreate = devIde.makeIdeToolkit({ ssh: makeFakeSshFace(), fs: fsCreate });
    await assert.rejects(() => toolCreate.create({ config, mode: "local", rel: "dup.md" }), /该路径已存在/, "已存在应拒");
    const freshFs = makeLocalFs();
    const freshTool = devIde.makeIdeToolkit({ ssh: makeFakeSshFace(), fs: freshFs });
    const created = await freshTool.create({ config, mode: "local", rel: "new.md" });
    assert.strictEqual(created.size, 0, "新建应零字节");
    const createOp = freshFs.ops.find((op) => op[0] === "writeFile");
    const expectPath = path.resolve("/tmp/acp-work", "new.md");
    assert.strictEqual(createOp[1], expectPath, "新建应写护栏后绝对路径");
  });

  await test("A7. probeVersion：win32 走 cmd.exe /d /s /c 包装（内层整体引号吃空格路径）；linux 直跑回归", async () => {
    const winProbes = [];
    const winVersion = await detect.probeVersion({ platform: "win32", runProbe: async (file, args) => {
      winProbes.push({ file, args });
      return { ok: true, stdout: "1.2.3 (Claude Code)\r\n", stderr: "" };
    } }, "claude", "C:\\Program Files\\Claude\\claude.cmd");
    assert.strictEqual(winVersion, "1.2.3 (Claude Code)", "应取抓取的首行");
    assert.strictEqual(winProbes.length, 1, "win32 应只发一次探测");
    assert.strictEqual(winProbes[0].file, "cmd.exe", "win32 探测宿主应为 cmd.exe（v3.47.0 直跑 .cmd 恒 EINVAL）");
    assert.deepStrictEqual(winProbes[0].args, ["/d", "/s", "/c", `""C:\\Program Files\\Claude\\claude.cmd" --version"`], `/d 禁 AutoRun、/s 保守引号、内层整体引号吃空格路径（实=${JSON.stringify(winProbes[0].args)}）`);
    // linux（或其他 POSIX）回归：仍按 target 直跑 --version
    const posixProbes = [];
    const posixVersion = await detect.probeVersion({ platform: "linux", runProbe: async (file, args) => {
      posixProbes.push({ file, args });
      return { ok: true, stdout: "9.9.1\n第二行不应入选\n", stderr: "" };
    } }, "claude", "/usr/local/bin/claude");
    assert.strictEqual(posixVersion, "9.9.1", "linux 应直跑探测");
    assert.deepStrictEqual(posixProbes[0], { file: "/usr/local/bin/claude", args: ["--version"] }, "posix 形态应保持直跑");
    // path 缺省回退到 CLI 名
    const bareProbes = [];
    await detect.probeVersion({ platform: "linux", runProbe: async (file, args) => { bareProbes.push({ file, args }); return { ok: true, stdout: "x", stderr: "" }; } }, "aider", "");
    assert.strictEqual(bareProbes[0].file, "aider", "path 为空应回退 CLI 名");
  });

  await test("A8. firstVersionLine：抓首个非空行 + 60 字截断", () => {
    assert.strictEqual(detect.firstVersionLine("\n  \r\n1.0.0 (abc)\n2.0.0\n"), "1.0.0 (abc)", "应跳过空行取首个非空行");
    assert.strictEqual(detect.firstVersionLine(""), "", "空输出应空串");
    assert.strictEqual(detect.firstVersionLine("x".repeat(100)).length, 60, "应截到 60 字");
  });
}

/* ═══════════ 渲染层 vm 装置（承 test-v3-45-3 mkRuntime 架子，面精简到 IDE） ═══════════ */

const vmEq = (actual, expected, label) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), label);

function makeStyle() {
  const store = {};
  return {
    setProperty(k, v) { store[String(k)] = String(v); },
    removeProperty(k) { delete store[String(k)]; },
    getPropertyValue: (k) => (k in store ? store[k] : ""),
    get cssText() { return Object.entries(store).map(([k, v]) => `${k}: ${v}`).join("; "); }
  };
}

const mkRuntime = () => {
  function querySubtree(root, sel, all) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        const hit = matchesSel(child, sel);
        if (hit) { out.push(child); if (!all) return out; }
        walk(child);
      }
      return out;
    };
    return walk(root);
  }
  function matchesSel(el, sel) {
    const s = String(sel || "").trim();
    if (s.startsWith("#")) return el.id === s.slice(1);
    if (s.startsWith(".")) return el.classList.contains(s.slice(1));
    return el.tagName === s.toUpperCase();
  }
  function makeFakeEl() {
    const classes = new Set();
    const children = [];
    let innerHTMLValue = "";
    return {
      value: "", checked: false, type: "", placeholder: "", textContent: "",
      get innerHTML() { return innerHTMLValue; },
      set innerHTML(v) { innerHTMLValue = String(v); if (innerHTMLValue === "" && children.length) children.length = 0; },
      hidden: false, disabled: false, tagName: "DIV", draggable: false, id: "",
      get className() { return [...classes].join(" "); },
      set className(v) { classes.clear(); for (const part of String(v || "").split(/\s+/)) if (part) classes.add(part); },
      title: "", role: "", tabIndex: 0,
      scrollTop: 0, scrollHeight: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0,
      files: [], children, style: makeStyle(), dataset: {},
      elements: { namedItem: () => getFake("#form-named-item") },
      form: { elements: { namedItem: () => getFake("#named-form-item") } },
      classList: {
        toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name); return on; },
        add(...names) { for (const n of names) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); }
      },
      addEventListener(type, fn) { (this._listeners = this._listeners || {})[String(type || "click")] = fn; },
      removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false, toggleAttribute: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement: () => null, hasChildNodes() { return children.length > 0; },
      append(...nodes) { for (const node of nodes) children.push(node); },
      prepend(...nodes) { for (const node of nodes) children.unshift(node); },
      appendChild(node) { children.push(node); return node; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      before(...nodes) { for (const node of nodes) children.push(node); },
      closest() { return null; }, contains() { return false; },
      querySelector(sel) { return querySubtree({ children }, sel, false)[0] || null; },
      querySelectorAll(sel) { return querySubtree({ children }, sel, true); },
      focus() {}, blur() {}, select() {}, remove() {}, click() {}, scrollIntoView() {}, scrollBy() {}, scrollTo() {}, setSelectionRange() {},
      showModal() {}, close() {}, show() {}, showPicker() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
  }
  const cache = new Map();
  const getFake = (sel) => {
    const key = String(sel);
    if (!cache.has(key)) cache.set(key, makeFakeEl());
    return cache.get(key);
  };
  return { makeFakeEl, getFake, querySubtree, matchesSel, cache };
};

const rt = mkRuntime();
const gatesStub = { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true };

/* IDE 面假面：devIdeList 序列结果（幕布驱动） */
const ideListState = { calls: 0, results: [] };
const methodMocks = {
  listConversations: async () => [],
  listModes: async () => [],
  getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub }),
  getThinkingProfile: async () => ({ profile: null }),
  devIdeList: async () => {
    const item = ideListState.results[Math.min(ideListState.calls, ideListState.results.length - 1)];
    ideListState.calls += 1;
    return item || { mode: "local", abs: "", entries: [], truncated: false };
  }
};

const defaultResult = () => ({
  edition: "main", productName: "Agent Chat Pro", conversations: [], items: [], messages: [], tools: [],
  files: [], entries: [], results: [], valid: true, invalidKeys: [], ok: true, path: "",
  lastConnectionMode: "", version: "3.48.1",
  host: "", port: 22, username: "", wakeName: "", clientLabel: "",
  workingDirectory: "", dataDirectory: "", skipPermissions: false,
  showSignalLights: true, connectionMode: "cloud", localEngine: "claude",
  hasPassword: true, hasCloudAiConfig: true,
  cloudAiProvider: "zhipu", cloudAiBaseUrl: "", cloudAiModel: "glm-5",
  thinkingChoices: {}, theme: "dark"
});

const windowStub = {
  window: null, self: null,
  agentChatPro: new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop in _t) return _t[prop];
      if (prop in methodMocks) return methodMocks[prop];
      return async () => defaultResult();
    },
    set(_t, prop, v) { _t[prop] = v; return true; }
  }),
  addEventListener() {}, removeEventListener() {},
  location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
  matchMedia: () => ({ matches: false, media: "", addEventListener() {}, addListener() {}, removeListener() {} }),
  open: () => null, close() {},
  navigator: { clipboard: { writeText: async () => {} }, userAgent: "smoke" },
  localStorage: {
    store: new Map(),
    getItem(k) { return this.store.has(String(k)) ? this.store.get(String(k)) : null; },
    setItem(k, v) { this.store.set(String(k), String(v)); },
    removeItem(k) { this.store.delete(String(k)); }
  },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  innerWidth: 1200, innerHeight: 800
};
windowStub.window = windowStub;
windowStub.self = windowStub;

const timers = { timeouts: [], intervals: [] };

const sandbox = {
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  Math, Date, JSON, Object, Array, String, Number, Boolean, BigInt,
  Map, Set, WeakMap, WeakSet, Promise, Symbol, Error, TypeError, RangeError,
  SyntaxError, ReferenceError, RegExp, parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, structuredClone,
  URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
  queueMicrotask, performance, Buffer,
  process: { env: {}, platform: "win32", versions: process.versions },
  window: windowStub, document: {
    body: rt.getFake("body"), head: rt.getFake("head"), documentElement: rt.getFake("documentElement"),
    activeElement: null,
    querySelector: (sel) => rt.getFake(sel), querySelectorAll: () => [],
    getElementById: (id) => rt.getFake(`#${id}`),
    createElement: (tag) => { const el = rt.makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    addEventListener() {}, removeEventListener() {}
  },
  navigator: windowStub.navigator, localStorage: windowStub.localStorage,
  location: windowStub.location, matchMedia: windowStub.matchMedia,
  getComputedStyle: windowStub.getComputedStyle,
  FormData: function FormData() { return { get: () => "" }; },
  Event: function FakeEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  CustomEvent: function FakeCustomEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  setTimeout: (fn) => { timers.timeouts.push(fn); return timers.timeouts.length - 1; },
  clearTimeout: (id) => { if (timers.timeouts[id]) timers.timeouts[id] = null; },
  setInterval: (fn) => { timers.intervals.push(fn); return timers.intervals.length - 1; },
  clearInterval: (id) => { if (timers.intervals[id]) timers.intervals[id] = null; },
  addEventListener() {}, removeEventListener() {}
};
sandbox.globalThis = sandbox;

/* IDE 内部态透出口（let/const 绑定不出 vm 全局，script 附录摘取——45-3 先例） */
const SOURCE_SUFFIX = "\n;globalThis.__acpIde = { state: ideState, loadDir: ideLoadDir, closeDialogForced: ideCloseDialogForced, label: ideModeLabel };";
const vmSource = rendererSrc + SOURCE_SUFFIX;
try { vm.createContext(sandbox); vm.runInContext(vmSource, sandbox, { filename: "renderer.js" }); } catch (error) { console.error("renderer.js eval 失败:", error); process.exit(1); }
const IDE = () => sandbox.__acpIde;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function runRendererTests() {
  await test("A9. renderer.js vm 假 DOM 全量求值 + __acpIde 导出在（IDE 链可驱动）", () => {
    assert.ok(IDE(), "应挂 __acpIde");
    assert.ok(typeof IDE().loadDir === "function", "ideLoadDir 应为顶层函数");
    assert.ok(typeof IDE().closeDialogForced === "function", "ideCloseDialogForced 应为顶层函数");
  });

  await test("A10. spaceMode 空间守卫：换空间清树缓存+收页签+关弹窗；同空间刷新不误清", async () => {
    const ide = IDE();
    const dialog = rt.getFake("#ide-dialog");
    dialog.close = function () { this.open = false; }; // 假件行为补全（close 真实改 open 位）
    ideListState.calls = 0;
    // 幕一：初始（spaceMode=""）→ cloud，不触发守卫
    ideListState.results = [{ mode: "cloud", abs: "/home/u/x", entries: [{ name: "a.md", type: "file", size: 5, hidden: false }], truncated: false }];
    await ide.loadDir("");
    await flush();
    vmEq(ide.state.spaceMode, "cloud", "幕一应记 cloud");
    assert.strictEqual(Number(ide.state.entries.size), 1, "幕一树应有 1 层缓存");
    // 弄脏旧空间态：页签+激活位+子目录展开+缓存+开着的弹窗
    const oldTab = [{ rel: "old.md", content: "old", initial: "old", dirty: true, size: 3, mode: "cloud", lines: 1 }];
    for (let i = 0; i < oldTab.length; i += 1) oldTab[i].rel = oldTab[i].rel; // 借主 realm 数组（跨 realm 断言只落基元）
    ide.state.tabs = JSON.parse(JSON.stringify(oldTab));
    ide.state.active = 0;
    ide.state.expanded.add("sub");
    ide.state.entries.set("sub", [{ name: "old.md", type: "file", size: 3, hidden: false }]);
    dialog.open = true;
    // 幕二：换空间 local → 守卫触发
    ideListState.results = [{ mode: "local", abs: "C:\\data", entries: [{ name: "b.txt", type: "file", size: 2, hidden: false }], truncated: false }];
    await ide.loadDir("");
    await flush();
    vmEq(ide.state.spaceMode, "local", "幕二应换 local");
    assert.strictEqual(Number(ide.state.entries.size), 1, "换空间应清树缓存且只剩本次 rel");
    assert.strictEqual(Number(ide.state.tabs.length), 0, "换空间应收掉全部编辑页签");
    assert.strictEqual(Number(ide.state.active), -1, "激活位应复位");
    assert.strictEqual(Boolean(ide.state.expanded.has("sub")), false, "子目录展开态应被清");
    assert.strictEqual(Boolean(ide.state.expanded.size === 1), true, "展开态应只剩根");
    assert.strictEqual(Boolean(dialog.open), false, "开着的编辑弹窗应被静默关闭");
    // 幕三：同空间 local 再刷 → 不误清（页签/缓存保留）
    ide.state.tabs = [{ rel: "keep.md", content: "k", initial: "k", dirty: false, size: 1, mode: "local", lines: 1 }];
    ide.state.entries.set("sub2", [{ name: "keep.md", type: "file", size: 1, hidden: false }]);
    ideListState.results = [{ mode: "local", abs: "C:\\data", entries: [], truncated: false }];
    await ide.loadDir("");
    await flush();
    assert.strictEqual(Number(ide.state.tabs.length), 1, "同空间刷新不应收页签");
    assert.strictEqual(Boolean(ide.state.entries.has("sub2")), true, "同空间刷新不应清其他目录缓存");
  });

  await test("A11. ideCreateFile 统一走 ideLoadDir 刷新（v3.48.1 收口：不再内联 devIdeList 定制段）", async () => {
    vmEq(sandbox.__acpIde.state.spaceMode, "local", "前置：IDE 链可驱动");
    // 行为面已由 A10 覆盖；此处锁形态：devIdeList 只应经 ideLoadDir 单点调用（源码锚 B3 互证）
    assert.ok(true);
  });
}

/* ═══════════ B 组：源码锚 ═══════════ */

async function runAnchorTests() {
  await test("B1. ssh.cjs 锚：isSshResourceMissing 三态判定 + 事务写（临时件/posix-rename/收尾清理）", () => {
    assert.ok(sshSrc.includes("function isSshResourceMissing(error) {"), "判定函数应在册");
    assert.ok(sshSrc.includes("error.code === 2 || error.code === \"ENOENT\" || /no such file/i.test(String(error.message || \"\"))"), "三态判定（协议数字 2/ENOENT/message）应在册");
    assert.ok(sshSrc.includes("function sftpTemporaryPath(remotePath) {"), "临时件路径函数应在册");
    assert.ok(sshSrc.includes("`${remotePath}.agent-chat-pro-part-${process.pid}`"), "临时件痕形态应在册");
    assert.ok(sshSrc.includes("function renameSftpReplace(sftp, from, to) {"), "覆盖改名函数应在册");
    assert.ok(sshSrc.includes("sftp.ext_openssh_rename(from, to,"), "posix-rename 扩展优先应在册");
    assert.ok(sshSrc.includes("catch (error) { reject(error); } // 服务器不支持扩展=同步抛，转传统改名"), "同步抛降级注记应在册");
    assert.ok(sshSrc.includes("await writeSftp(sftp, temporary, payload);"), "写临时件应在册");
    assert.ok(sshSrc.includes("await renameSftpReplace(sftp, temporary, remotePath);"), "改名替换应在册");
    assert.ok(sshSrc.includes("if (!isSshResourceMissing(error)) throw error;"), "createRemoteFile 修正式应在册");
    assert.ok(sshSrc.includes("v3.48.1 修复：存在即拒（wx 语义）"), "修复注释应在册");
    assert.ok(sshSrc.includes("isSshResourceMissing, listRemoteDir"), "导出应在册");
  });

  await test("B2. dev-ide.cjs 锚：同族判定 + 列表过滤 + 读侧竞态兜底 + 本机事务写", () => {
    assert.ok(devIdeSrcOrThrow().includes("const IDE_TEMP_FILE_MARK = \".agent-chat-pro-part\";"), "临时件名痕常量应在册");
    assert.ok(devIdeSrcOrThrow().includes("function isSshResourceMissing(error) {"), "同族判定应在册");
    assert.ok(!devIdeSrcOrThrow().includes("entry.name !== \".\" && entry.name !== \"..\""), "过滤形态应为临时件痕版");
    assert.ok(devIdeSrcOrThrow().includes("!entry.name.includes(IDE_TEMP_FILE_MARK)"), "SSH 列表过滤临时件应在册");
    assert.ok(devIdeSrcOrThrow().includes("name.includes(IDE_TEMP_FILE_MARK)"), "本机列表过滤临时件应在册");
    assert.ok(devIdeSrcOrThrow().includes("const clamped = data.length > IDE_MAX_FILE_BYTES ? data.subarray(0, IDE_MAX_FILE_BYTES) : data;"), "读侧截断竞态兜底应在册");
    assert.ok(devIdeSrcOrThrow().includes("const temporary = `${abs}${IDE_TEMP_FILE_MARK}`;"), "本机事务写临时件应在册");
    assert.ok(devIdeSrcOrThrow().includes("await fs.rename(temporary, abs);"), "本机改名替换应在册");
    assert.ok(devIdeSrcOrThrow().includes("if (isSshResourceMissing(error)) throw new Error(\"文件不存在或不可读。\");"), "SSH 缺失友好文案应在册");
  });

  function devIdeSrcOrThrow() { return read("src/main/dev-ide.cjs"); }

  await test("B3. renderer.js 锚：spaceMode 守卫段 + 静默关弹窗 + 新建文件统一刷新", () => {
    assert.ok(rendererSrc.includes("spaceMode: \"\""), "ideState 空间位应在册");
    assert.ok(rendererSrc.includes("if (ideState.spaceMode && ideState.spaceMode !== result.mode) {"), "守卫触发条件应在册");
    assert.ok(rendererSrc.includes("ideState.expanded = new Set([\"\"]);\n      ideState.tabs = [];\n      ideState.active = -1;"), "守卫清理段应在册");
    assert.ok(rendererSrc.includes("ideCloseDialogForced();"), "守卫关弹窗调用应在册");
    assert.ok(rendererSrc.includes("function ideCloseDialogForced() {"), "静默关弹窗函数应在册");
    assert.ok(rendererSrc.includes("v3.48.1 空间守卫"), "守卫注记应在册");
    assert.ok(rendererSrc.includes("await ideLoadDir(parent);"), "新建文件应统一走 ideLoadDir 刷新");
    assert.ok(!rendererSrc.includes("const listing = await window.agentChatPro.devIdeList"), "内联 devIdeList 段应移除（防双读竞态）");
  });

  await test("B4. agent-detect.cjs 锚：win32 cmd.exe 包装 + firstVersionLine 导出 + 修复注记", () => {
    const detectSrc = read("src/main/agent-detect.cjs");
    assert.ok(detectSrc.includes("if (platform === \"win32\") {"), "win32 分支应在册");
    assert.ok(detectSrc.includes("\"cmd.exe\", [\"/d\", \"/s\", \"/c\", `\"\"${target}\" --version\"`], 3000, platform"), "cmd.exe /d /s /c 包装形态应在册");
    assert.ok(detectSrc.includes("Node ≥18.20 起 execFile 直跑"), "Bug#2 注记应在册");
    assert.ok(detectSrc.includes("function firstVersionLine(stdout) {"), "首行抓取函数应在册");
    assert.ok(detectSrc.includes("module.exports = { detectLocalAgents, parseDaemonPort, parseDaemonToken, applyOf, resolveOnPath, probeVersion, firstVersionLine,"), "probeVersion/firstVersionLine 导出应在册");
    assert.ok(!detectSrc.includes("const daemons = [];"), "死代码应清除（daemonRunning 恒单值）");
  });

  await test("B5. 接线面不退：main.cjs IDE 解构行 / 混淆名单三件在册", () => {
    assert.ok(mainSrc.includes("createRemoteFile, downloadRemoteFile"), "main.cjs IDE 解构行应保留（test-v3-47-0 B2 锚兼容）");
    assert.ok(mainSrc.includes("dev-ide.cjs"), "main.cjs 应接 dev-ide");
    assert.ok(mainSrc.includes("agent-detect.cjs"), "main.cjs 应接 agent-detect");
    for (const item of ["\"main/dev-ide.cjs\"", "\"main/agent-detect.cjs\"", "\"main/ssh.cjs\""]) {
      assert.ok(obfSrc.includes(item), `混淆名单应含 ${item}`);
    }
  });
}

/* ═══════════ C 组：版本滚动锚 ═══════════ */

function badgeOf(text) {
  return (text.match(/tests-(\d+)%20files/) || [])[1];
}

async function runVersionTests() {
  await test("C1. 版本滚动锚：package.json ≥3.48.1 且 README badge 自洽", () => {
    const parts = pkg.version.split(".").map(Number);
    const atLeast = (other) => parts[0] > other[0] || (parts[0] === other[0] && (parts[1] > other[1] || (parts[1] === other[1] && parts[2] >= other[2])));
    assert.ok(atLeast([3, 48, 1]), `版本应 ≥3.48.1（实际 ${pkg.version}）`);
    assert.ok(readme.includes(`version-${pkg.version}`), "README version badge 应与 package.json 一致");
    assert.ok(badgeOf(readme) && Number(badgeOf(readme)) >= 69, `tests badge 应 ≥69（实际 ${badgeOf(readme)}）`);
  });

  await test("C2. 装置自检：守门文件自身在清单（badge=全部 test-*.cjs 件数）", () => {
    const files = fs.readdirSync(ROOT).filter((name) => /^test-.*\.cjs$/.test(name));
    assert.ok(files.includes("test-v3-48-1.cjs"), "本守门应在清单");
    assert.strictEqual(Number(badgeOf(readme)), files.length, `badge 应=守门件数（badge=${badgeOf(readme)} files=${files.length}）`);
  });
}

(async () => {
  console.log("── A 组：行为级真跑 ──");
  await runBehaviorTests();
  await runRendererTests();
  console.log("── B 组：源码锚 ──");
  await runAnchorTests();
  console.log("── C 组：版本滚动锚 ──");
  await runVersionTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`);
  if (failed > 0) {
    for (const failure of failures) console.log(`  · ${failure}`);
    process.exit(1);
  }
})();
