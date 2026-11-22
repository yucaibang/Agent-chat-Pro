"use strict";

/**
 * v3.47.0 守门：五项捆绑（3 bug + 工具折叠 + 开发面板 IDE 编辑）
 *
 * 用户令面（p330tiny）：
 *   ① 压缩上下文「先完成 → 几秒后未完成」双文案（bug）
 *   ② 全屏盖不住任务栏（bug）
 *   ③ 异常退出（未响应/强杀）对话保留 + 损坏自愈（bug）
 *   ④ 工具流折叠：执行中即折叠 + 类型统计头（只读/写入/删除/命令/网络/其它）（功能）
 *   ⑤ 开发面板 IDE 编辑：文件树/原位读/原位写/新建文件（功能，上一轮令面并入）
 *
 * A 组：dev-ide.cjs 行为级真跑（vm：路径护栏/编解码/负载上限/目录整理/假 SSH 假 fs 全链路）
 * B 组：接线源码锚（①②③④⑤全量触点 + 混淆名单登记）
 * C 组：版本滚动锚
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const devIdeSrc = read("src/main/dev-ide.cjs");
const mainSrc = read("src/main/main.cjs");
const sshSrc = read("src/main/ssh.cjs");
const conversationsSrc = read("src/main/conversations.cjs");
const preloadSrc = read("src/main/preload.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const htmlSrc = read("src/renderer/index.html");
const stylesSrc = read("src/renderer/styles.css");
const obfSrc = read("scripts/obfuscate.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const readme = read("README.md");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((error) => {
      failed++;
      failures.push(`${name}: ${error.message}`);
      console.log(`  ✗ ${name}: ${error.message}`);
    });
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/* ── A 组装置：vm 求值 dev-ide.cjs（真 path + 注入依赖面） ── */
function loadIdeModule() {
  const sandbox = {
    require: (name) => {
      if (name === "path") return require("path");
      throw new Error(`dev-ide.cjs 只允许 require path（收到 ${name}）`);
    },
    Buffer, // vm 上下文不继承宿主全局——decodeText/Buffer 转换必需注回
    TextDecoder, // TextDecoder（fatal 解码）同理
    TextEncoder,
    module: { exports: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(devIdeSrc, sandbox, { filename: "dev-ide.cjs" });
  return sandbox.module.exports;
}

function makeFakeSsh() {
  const calls = [];
  return {
    calls,
    statRemoteFile: async (config, remotePath, onUnknownHost, onLog) => {
      calls.push(["statRemoteFile", remotePath]);
      return { size: Number(config.__size ?? 4), isFile: true, isDirectory: Boolean(config.__dir) };
    },
    listRemoteDir: async (config, remotePath) => {
      calls.push(["listRemoteDir", remotePath]);
      return config.__entries || [];
    },
    writeRemoteFile: async (config, remotePath, data) => {
      calls.push(["writeRemoteFile", remotePath]);
      return data.length;
    },
    readRemoteFile: async (config, remotePath, maximumBytes) => {
      calls.push(["readRemoteFile", remotePath, maximumBytes]);
      return Buffer.from("data", "utf8");
    },
    createRemoteFile: async (config, remotePath) => {
      calls.push(["createRemoteFile", remotePath]);
      return remotePath;
    }
  };
}

function makeFakeFs(opts = {}) {
  const calls = [];
  const exists = new Map(Object.entries(opts.exists || {}));
  return {
    calls,
    __exists: exists,
    readdir: async (abs) => {
      calls.push(["readdir", abs]);
      return (exists.get(abs)?.entries || []).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.type === "dir"
      }));
    },
    stat: async (target) => {
      calls.push(["stat", target]);
      const meta = exists.get(target);
      if (!meta) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isDirectory: () => false, size: meta.size };
    },
    readFile: async (target) => {
      calls.push(["readFile", target]);
      const meta = exists.get(target);
      if (!meta) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (meta.binary) return Buffer.from([0xff, 0xfe, 0x01, 0x02]);
      return Buffer.from("hello", "utf8");
    },
    writeFile: async (target, data, options) => {
      calls.push(["writeFile", target, String(options?.flag || "w")]);
      if (options?.flag === "wx" && exists.has(target)) {
        const error = new Error("EEXIST");
        error.code = "EEXIST";
        throw error;
      }
    }
  };
}

/* ── A 组：dev-ide.cjs 行为级真跑 ── */
async function runIdeRuntimeTests() {
  await test("A0. 模块结构锚：五导出 + 上限常量 + 仅依赖 path（vm 依赖白名单自证）", () => {
    const ide = loadIdeModule();
    for (const key of ["makeIdeToolkit", "assertInsidePosix", "assertInsideLocal", "decodeText", "checkTextPayload", "sortEntries", "clipEntries", "IDE_MAX_FILE_BYTES", "IDE_DIR_MAX"]) {
      assert.ok(key in ide, `导出 ${key} 应在册`);
    }
    assert.strictEqual(ide.IDE_MAX_FILE_BYTES, 128 * 1024, "单编辑文件上限 128KB");
    assert.strictEqual(ide.IDE_DIR_MAX, 500, "目录清单一次最多 500 条");
    assert.ok(!devIdeSrc.includes("require(\"electron\")") && !devIdeSrc.includes("require('electron')"), "零 electron 依赖（注入式）；");
  });

  await test("A1. POSIX 护栏真跑：越界/绝对/盘符/\\0 全拒，嵌套相对与根目录放行", () => {
    const ide = loadIdeModule();
    assert.strictEqual(ide.assertInsidePosix("/home/u/proj", "src"), "/home/u/proj/src", "正常相对路径放行");
    assert.strictEqual(ide.assertInsidePosix("/home/u/proj", "src/../a.js"), "/home/u/proj/a.js", "回根内的 .. 放行");
    assert.strictEqual(ide.assertInsidePosix("/home/u/proj", ""), "/home/u/proj", "空=浏览根放行");
    assert.ok(ide.assertInsidePosix("/home/u/proj", ".").endsWith("proj"), "点=根放行");
    for (const bad of ["../x", "/etc/passwd", "C:/x", "a/../../x", "a\0b"]) {
      assert.throws(() => ide.assertInsidePosix("/home/u/proj", bad), `护栏应拒 ${bad}`);
    }
  });

  await test("A2. 本地护栏真跑：绝对路径/越界/\\0 全拒 + 正常相对放行", () => {
    const ide = loadIdeModule();
    const base = "/vol2/workdir/proj";
    const out = ide.assertInsideLocal(base, "src/a.js");
    assert.ok(out === path.resolve(base, "src/a.js"), "本地护栏应返回解析后的绝对路径");
    assert.strictEqual(ide.assertInsideLocal(base, ""), path.resolve(base), "空=根放行");
    for (const bad of ["../x", "/etc", "a\0b"]) {
      assert.throws(() => ide.assertInsideLocal(base, bad), `本地护栏应拒 ${bad}`);
    }
    assert.throws(() => ide.assertInsideLocal("", "a.js"), "未配置工作目录应拒");
  });

  await test("A3. 编解码与负载护栏：非 UTF-8 判二进制拒编辑 + 超上限拒保存", () => {
    const ide = loadIdeModule();
    assert.strictEqual(ide.decodeText(Buffer.from("你好", "utf8")), "你好", "UTF-8 正常解码");
    assert.throws(() => ide.decodeText(Buffer.from([0xff, 0xfe, 0x01])), /二进制/, "无效字节应判二进制拒");
    assert.throws(() => ide.checkTextPayload("x".repeat(ide.IDE_MAX_FILE_BYTES + 1)), /编辑保存上限/, "超上限应拒");
    assert.ok(ide.checkTextPayload("你好").length === 6, "多字节汉字负载按字节计（2 字 ×3B）");
  });

  await test("A4. 目录整理真跑：目录优先排序 + 超限截断标注 truncated", () => {
    const ide = loadIdeModule();
    const sorted = ide.sortEntries([
      { name: "b.txt", type: "file" },
      { name: "src", type: "dir" },
      { name: "a.txt", type: "file" }
    ]);
    assert.strictEqual(sorted[0].type, "dir", "目录应排最前");
    const few = ide.clipEntries([1, 2, 3]);
    assert.strictEqual(few.truncated, false, "未超限不标截断");
    const many = ide.clipEntries(Array.from({ length: 501 }, () => ({})));
    assert.strictEqual(many.entries.length, 500, "超限截到 500 条");
    assert.strictEqual(many.truncated, true, "超限应标 truncated");
  });

  await test("A5. 本机组全链路真跑（假 fs）：list/read/write/create + 栏拒/二进制拒/超限拒/已存在拒", async () => {
    const ide = loadIdeModule();
    const ssh = makeFakeSsh();
    const abs = "/vol2/workdir/proj";
    const fakeFs = makeFakeFs({
      exists: {
        [abs]: { entries: [{ name: "a.js", type: "file" }, { name: ".env", type: "file" }, { name: "src", type: "dir" }] },
        [`${abs}/a.js`]: { size: 5 },
        [`${abs}/.env`]: { size: 20 },
        [`${abs}/big.js`]: { size: 200 * 1024 },
        [`${abs}/taken.js`]: { size: 1 }
      }
    });
    const local = ide.makeIdeToolkit({ ssh, fs: fakeFs });

    // list：目录在档 + 护栏后的绝对路径传达 fs 面
    const listing = await local.list({ config: { workingDirectory: abs }, mode: "local", rel: "" });
    assert.strictEqual(fakeFs.calls[0][0], "readdir");
    assert.strictEqual(fakeFs.calls[0][1], abs, "根路径应传工作目录自身");
    assert.ok(listing.entries.some((entry) => entry.name === "src" && entry.type === "dir"), "目录条目在档");
    assert.ok(listing.entries.some((entry) => entry.name === ".env" && entry.hidden), "隐藏文件在档且标 hidden");
    assert.strictEqual(listing.mode, undefined, "mode 由主进程 handler 附加（模块层不掺）");

    // read：正常过 + 缺失拒 + 二进制拒 + 超限拒
    const reading = await local.read({ config: { workingDirectory: abs }, mode: "local", rel: "a.js" });
    assert.strictEqual(reading.content, "hello", "文本应解码为字符串");
    assert.strictEqual(reading.size, 5, "字节面如实返回");
    await assert.rejects(() => local.read({ config: { workingDirectory: abs }, mode: "local", rel: "nope.js" }), /不存在/, "缺失文件应拒");
    const fakeFsBinary = makeFakeFs({ exists: { [`${abs}/bin.dat`]: { size: 4, binary: true } } });
    assert.rejects(() => ide.makeIdeToolkit({ ssh, fs: fakeFsBinary }).read({ config: { workingDirectory: abs }, mode: "local", rel: "bin.dat" }), () => true, "非 UTF-8 应判二进制拒编辑");
    const fakeFsBig = makeFakeFs({ exists: { [`${abs}/big.js`]: { size: 200 * 1024 } } });
    await assert.rejects(() => ide.makeIdeToolkit({ ssh, fs: fakeFsBig }).read({ config: { workingDirectory: abs }, mode: "local", rel: "big.js" }), () => true, "超上限应拒打开");

    // write：护栏后的绝对路径+Buffer 负载
    await local.write({ config: { workingDirectory: abs }, mode: "local", rel: "out.js", content: "你好" });
    const writeCall = fakeFs.calls.find((call) => call[0] === "writeFile");
    assert.ok(writeCall[1] === `${abs}/out.js`, "写目标应为护栏后绝对路径");

    // create：不存在→wx 新建；已存在→拒
    await local.create({ config: { workingDirectory: abs }, mode: "local", rel: "fresh.js" });
    const createCall = fakeFs.calls.find((call) => call[0] === "writeFile" && call[1] === `${abs}/fresh.js`);
    assert.strictEqual(createCall[2], "wx", "新建应走 wx 旗标（存在即拒语义）");
    await assert.rejects(() => local.create({ config: { workingDirectory: abs }, mode: "local", rel: "taken.js" }), () => true, "已存在应拒");
    await assert.rejects(() => local.list({ config: { workingDirectory: abs }, mode: "local", rel: "../etc" }), () => true, "越界应拒");
  });

  await test("A6. SSH 组全链路真跑（假 ssh）：list/read/write/create + 尺寸链 + 越限/目录拒", async () => {
    const ide = loadIdeModule();
    const ssh = makeFakeSsh();
    const tool = ide.makeIdeToolkit({ ssh, fs: makeFakeFs() });
    const abs = "/remote/proj";

    const listing = await tool.list({ config: { workingDirectory: abs, __entries: [{ name: "x.ts", type: "file", size: 12 }, { name: "lib", type: "dir", size: 0 }] }, mode: "ssh", rel: "" });
    assert.strictEqual(ssh.calls[0][0], "listRemoteDir", "list 应走 listRemoteDir");
    assert.ok(ssh.calls[0][1] === abs, "listRemoteDir 应收到护栏后工作目录");
    assert.ok(listing.entries.some((entry) => entry.name === "lib" && entry.type === "dir"), "远端目录条目在档");
    assert.ok(listing.entries[0].type === "dir", "排序:目录优先");

    const reading = await tool.read({ config: { workingDirectory: abs, __size: 4 }, mode: "ssh", rel: "data.txt" });
    assert.strictEqual(reading.content, "data", "远端读取应解码");
    assert.ok(ssh.calls.some((call) => call[0] === "readRemoteFile" && call[2] === ide.IDE_MAX_FILE_BYTES + 1), "readRemoteFile 上限应带 128K+1 二次保险");
    assert.ok(ssh.calls.some((call) => call[0] === "statRemoteFile" && call[1] === `${abs}/data.txt`), "read 前应先 stat 校型/校尺寸");

    const huge = makeFakeSsh();
    const bigTool = ide.makeIdeToolkit({ ssh: huge, fs: makeFakeFs() });
    await assert.rejects(() => bigTool.read({ config: { workingDirectory: abs, __size: 999999 }, mode: "ssh", rel: "data.txt" }), () => true, "远端超上限应拒");

    const dirTool = ide.makeIdeToolkit({ ssh: makeFakeSsh(), fs: makeFakeFs() });
    const sshRef = { statRemoteFile: async () => ({ size: 1, isFile: false, isDirectory: true }), listRemoteDir: () => [], writeRemoteFile: async () => 0, readRemoteFile: async () => Buffer.alloc(0), createRemoteFile: async () => "" };
    const sshConfig = ide.makeIdeToolkit({ ssh: sshRef, fs: makeFakeFs() });
    await assert.rejects(() => sshConfig.read({ config: { workingDirectory: abs }, mode: "ssh", rel: "lib" }), () => true, "远端目录应拒当文件读");

    await tool.write({ config: { workingDirectory: abs }, mode: "ssh", rel: "out.txt", content: "hi" });
    const writeCall = ssh.calls.find((call) => call[0] === "writeRemoteFile");
    assert.strictEqual(writeCall[1], `${abs}/out.txt`, "writeRemoteFile 应收防护后绝对路径");
    await tool.create({ config: { workingDirectory: abs }, mode: "ssh", rel: "new.txt" });
    const createCall = ssh.calls.find((call) => call[0] === "createRemoteFile");
    assert.strictEqual(createCall[1], `${abs}/new.txt`, "createRemoteFile 应收防护后绝对路径");
  });

  await test("A7. mode 路由真跑：ssh→SSH 面 / cloud·local→fs 面 / 缺省落本机面", async () => {
    const ide = loadIdeModule();
    let sshCalls = 0;
    let fsCalls = 0;
    const sshFake = {
      statRemoteFile: async () => { sshCalls++; return { size: 1, isFile: true, isDirectory: false }; },
      listRemoteDir: async () => { sshCalls++; return []; },
      writeRemoteFile: async () => { sshCalls++; return 0; },
      readRemoteFile: async () => { sshCalls++; return Buffer.alloc(0); },
      createRemoteFile: async () => { sshCalls++; return "x"; }
    };
    const fsFake = {
      readdir: async () => { fsCalls++; return []; },
      stat: async () => { fsCalls++; return { isDirectory: () => false, size: 0 }; },
      readFile: async () => { fsCalls++; return Buffer.alloc(0); },
      writeFile: async () => { fsCalls++; }
    };
    const tool = ide.makeIdeToolkit({ ssh: sshFake, fs: fsFake });
    await tool.list({ config: { workingDirectory: "/r" }, mode: "ssh", rel: "" });
    await tool.list({ config: { workingDirectory: "/l" }, mode: "local", rel: "" });
    await tool.list({ config: { workingDirectory: "/c" }, mode: "cloud", rel: "" });
    await tool.list({ config: { workingDirectory: "/d" }, rel: "" });
    assert.strictEqual(sshCalls, 1, "仅 ssh 模式走 SSH 面");
    assert.strictEqual(fsCalls, 3, "local/cloud/缺省全走本机面");
  });

  await test("A8. ssh.cjs IDE 面结构锚：四函数+读写骨架同族（connectWithRetry/openSftp/finally 双层收尾）", () => {
    for (const fn of ["async function statRemoteFile", "async function writeRemoteFile", "async function createRemoteFile", "async function listRemoteDir"]) {
      assert.ok(sshSrc.includes(fn), `${fn} 应在册`);
    }
    assert.ok(sshSrc.includes('module.exports = { buildAttachmentNote, buildDeviceConnectScript, connect, cleanupRemoteAttachments, connectWithRetry, createRemoteFile,'), "导出已更新（createRemoteFile）");
    assert.ok(/module\.exports = \{[^}]*listRemoteDir[^}]*\}/.test(sshSrc), "导出含 listRemoteDir");
    assert.ok(/module\.exports = \{[^}]*statRemoteFile[^}]*\}/.test(sshSrc), "导出含 statRemoteFile");
    assert.ok(/module\.exports = \{[^}]*writeRemoteFile[^}]*\}/.test(sshSrc), "导出含 writeRemoteFile");
    assert.ok(sshSrc.includes("该路径已存在文件或目录。"), "create 存在即拒文案应在册");
    assert.ok(sshSrc.includes("逃逸防护由 dev-ide.cjs 的护栏"), "双层校验分工注释应在册");
  });
}

/* ── B 组：接线源码锚 ── */
async function runWiringTests() {
  await test("B1. Bug①主进程：终态不翻案 + settle 宽限窗常量", () => {
    assert.ok(mainSrc.includes("const COMPACT_SETTLE_MS = 1500;"), "settle 宽限常量应在册");
    assert.ok(mainSrc.includes("// v3.47.0 Bug①修复：终态权威收敛"), "收敛注释应在册");
    const catchZone = mainSrc.slice(mainSrc.indexOf("writeLog(\"context_compact_failed\""), mainSrc.indexOf("} finally {", mainSrc.indexOf("writeLog(\"context_compact_failed\"")));
    assert.ok(catchZone.includes('if (lastEvent && lastEvent.phase === "finished") {'), "catch 应先查终态");
    assert.ok(catchZone.includes("const settled = Boolean(lastEvent.success);"), "终态时以 lastEvent 结果收尾");
    assert.ok(catchZone.indexOf('sendWorkStatusSignal(sender, "chat:context",') > catchZone.indexOf("if (lastEvent && lastEvent.phase") + 10, "");
  });

  await test("B2. Bug①渲染层：终态幂等挡板 + 按钮 handler 三分支静默收敛", () => {
    assert.ok(rendererSrc.includes("let compactPromptSettled = false;"), "幂等状态位声明应在册（含注释）");
    assert.ok(rendererSrc.includes("compactPromptSettled = false; // v3.47.0 Bug①：新一轮压缩开始"), "started 应重置挡板");
    assert.ok(rendererSrc.includes("const settled = compactPromptSettled;"), "finished 应先取挡板态");
    assert.ok(rendererSrc.includes("if (settled) return; // 已有终态文案在牌上"), "翻案事件应被静默");
    const handlerZone = rendererSrc.slice(rendererSrc.indexOf('await window.agentChatPro.compactContext('), rendererSrc.indexOf("} finally {", rendererSrc.indexOf('await window.agentChatPro.compactContext(')));
    assert.ok(handlerZone.includes("if (!compactPromptSettled)"), "按钮 handler 文案须经挡板");
    assert.ok(handlerZone.includes("resultFinished && resultFinished.success"), "finished 成功事件兜底分支应在册");
  });

  await test("B3. Bug②全屏 kiosk：Windows 走 setKiosk + 态广播 + preload 桥 + 渲染层同步", () => {
    assert.ok(mainSrc.includes("const entering = !window.isKiosk();"), "Windows 全屏应走 kiosk 切换");
    assert.ok(mainSrc.includes("// v3.47.0 Bug②修复：主窗是 frame:false + transparent:true"), "根因注释应在册");
    assert.ok(mainSrc.includes("function publishWindowState() {"), "全屏态广播函数应在册");
    assert.ok(mainSrc.includes('window.webContents.send("window:fullscreen", window.isKiosk() || window.isFullScreen())'), "广播应含全屏态");
    assert.ok(mainSrc.includes('window.on("enter-full-screen", publishState);') && mainSrc.includes('window.on("leave-full-screen", publishState);'), "非 Windows 全屏事件挂点应在册");
    assert.ok(preloadSrc.includes('onWindowFullscreen: (handler) => ipcRenderer.on("window:fullscreen"'), "preload 全屏态桥应在册");
    assert.ok(rendererSrc.includes("window.agentChatPro.onWindowFullscreen?.(setFullscreen);"), "渲染层应接全屏态");
    assert.ok(rendererSrc.includes('button.textContent = on ? "退出全屏" : "全屏";'), "按钮文案应随态切换");
  });

  await test("B4. Bug③持久化加固：异步单飞队列 + .bak 自愈 + 退出兜底 + 崩溃钩子快照", () => {
    for (const anchor of ["let storeCache = null;", "let storeDirty = false;", "let storeFlushing = false;", "async function flushStoreLoop()", "async function flushStoreAtomically(", "function flushNowSync()", "function readFromDisk(source) {", "已从上次备份自动恢复", ".corrupt-", "copyFile(source, `${source}.bak`)"]) {
      assert.ok(conversationsSrc.includes(anchor), `conversations.cjs 锚应在册：${anchor}`);
    }
    assert.ok(conversationsSrc.includes("module.exports = {") && conversationsSrc.includes("flushNowSync\n"), "flushNowSync 应导出");
    assert.ok(mainSrc.includes("flushNowSync, // v3.47.0 Bug③：退出兜底同步落盘"), "main 应导入 flushNowSync");
    assert.ok(mainSrc.includes("try { flushNowSync(); } catch {}"), "before-quit 应兜底同步落盘");
    assert.ok(mainSrc.includes("function flushAllDrafts(reason) {"), "崩溃快照函数应在册");
    assert.ok(countOccurrences(mainSrc, "flushDraft: persistDraft") >= 3, "三路活跃请求应挂 flushDraft");
    assert.ok(mainSrc.includes('flushAllDrafts("unresponsive")') && mainSrc.includes('flushAllDrafts("render-process-gone")'), "未响应/渲染崩溃两钩子应触发快照");
    assert.ok(mainSrc.includes("draft_emergency_flush"), "快照事件日志应在册");
  });

  await test("B5. 折叠带：账本虚拟化 + 类型统计 + 收起清明细 + 上限省略", () => {
    for (const anchor of ["const TOOL_DETAIL_MAX = 200;", "const TOOL_KIND_ORDER", "const TOOL_KIND_LABELS", "function toolKindOf", "const toolLedgers = new WeakMap();", "function refreshToolSummary", "function toggleToolList", "function clearToolCards", "function buildOutstandingCards", "function upsertToolCard", "正在执行：", "已省略（计数仍包含在上方统计中）", "list.className = \"tool-list finalized\""]) {
      assert.ok(rendererSrc.includes(anchor), `折叠带锚应在册：${anchor}`);
    }
    for (const label of ["只读", "写入", "删除", "命令", "网络", "其它"]) {
      assert.ok(rendererSrc.includes(label), `类型计数应含 ${label}`);
    }
    assert.ok(stylesSrc.includes(".tool-live-line"), "执行中一行样式应在册");
    assert.ok(stylesSrc.includes(".tool-omitted"), "省略提示样式应在册");
    assert.ok(stylesSrc.includes(".tool-list.finalized:not(.expanded) .tool-card { display: none; }"), "折叠藏明细规则应在册");
    assert.ok(rendererSrc.includes("function finalizeToolList") && rendererSrc.includes("const ledger = getToolLedger(list, true);"), "finalize 应对账本收敛");
    assert.ok(rendererSrc.includes("else clearToolCards(list); // 收起即清明细 DOM"), "收起应清明细（9000 卡不压 DOM）");
    // 折叠带：历史重放路径同走折叠（renderTool 统一入口——finalizeToolList 保持两处调用）
    assert.ok(countOccurrences(rendererSrc, "finalizeToolList(") >= 3, "finalize 定义+两调用点应在册");
  });

  await test("B6. IDE 编辑接线：四 IPC + 四 preload 桥 + UI 骨架 + Ctrl+S + 新建文件", () => {
    for (const anchor of ['ipcMain.handle("dev-ide:list"', 'ipcMain.handle("dev-ide:read"', 'ipcMain.handle("dev-ide:write"', 'ipcMain.handle("dev-ide:create"', "const ideToolkit = makeIdeToolkit(", "dev-ide.cjs", "SSH 工作目录未配置"]) {
      assert.ok(mainSrc.includes(anchor), `main.cjs IDE 锚应在册：${anchor}`);
    }
    for (const bridge of ["devIdeList:", "devIdeRead:", "devIdeWrite:", "devIdeCreate:"]) {
      assert.ok(preloadSrc.includes(bridge), `preload 桥应在册：${bridge}`);
    }
    for (const anchor of ['id="ide-dialog"', 'id="ide-tabs"', 'id="ide-editor"', 'id="ide-gutter"', 'id="ide-save"', 'id="ide-status"', 'id="dev-tab-files"', 'id="dev-tab-files-toggle"', 'id="dev-files-refresh"', 'id="dev-files-new"']) {
      assert.ok(htmlSrc.includes(anchor), `index.html IDE 锚应在册：${anchor}`);
    }
    for (const anchor of ["function renderDevTree()", "async function ideOpenFile(", "async function ideSave()", "function ideCloseDialog()", "async function ideCreateFile()", "ideSwitchPanelTab", "String(event.key).toLowerCase() === \"s\"", "已保存"]) {
      const found = rendererSrc.includes(anchor) || htmlSrc.includes(anchor);
      assert.ok(found, `前端 IDE 锚应在册：${anchor}`);
    }
  });

  await test("B7. 混淆名单登记 main/dev-ide.cjs（medium；新主进程模块必登记——v3.45.4 Bug#2 同型教训）", () => {
    assert.ok(/"main\/dev-ide\.cjs",\s*\/\/.*v3\.47\.0/.test(obfSrc), "medium 名单应登记 dev-ide.cjs 并带 v3.47.0 注记");
    // dev-ide.cjs 无独立 preload/无 renderer 依赖——名单仅 medium 一处即可
    assert.ok(countOccurrences(obfSrc, "main/dev-ide.cjs") === 1, "登记应恰好一处");
  });
}

/* ── C 组：版本滚动锚 ── */
async function runVersionTests() {
  await test("C1. 版本滚动锚：package.json =3.47.0 且 README badge 自洽", () => {
    const parts = pkg.version.split(".").map(Number);
    assert.ok(parts[0] === 3 && parts[1] === 47 && parts[2] === 0, `版本应为 3.47.0（实际 ${pkg.version}）`);
    assert.ok(readme.includes(`version-${pkg.version}`), "README badge 应与 package.json 版本一致");
    const badgeTests = (readme.match(/tests-(\d+)%20files/) || [])[1];
    assert.ok(badgeTests && Number(badgeTests) >= 66, `README tests badge 应 ≥66（实际 ${badgeTests}）`);
  });

  await test("C2. 回归面：v3.46.1 splash 链路锚未动（ready-to-show/did-finish-load 双挂点仍在）", () => {
    assert.ok(mainSrc.includes('const { createSplash } = require("./splash.cjs");'), "splash require 应在册");
    assert.ok(mainSrc.includes("let splashRef = null;"), "splashRef 应在册");
    assert.ok(mainSrc.includes('window.webContents.on("ready-to-show"'), "ready-to-show 挂点应在册");
    assert.ok(read("src/main/splash.cjs").includes("DEFAULT_MIN_SHOW_MS = 700"), "splash 常量未动");
  });

  await test("C3. 渲染层零越界：renderer.js 不含主进程专属 API（fs/require 主进程模块）", () => {
    assert.ok(!/\brequire\s*\(\s*["']fs["']\s*\)/.test(rendererSrc), "渲染层不得 require('fs')");
    assert.ok(!rendererSrc.includes('require("./dev-ide.cjs")'), "渲染层不得直接 require 主进程模块");
  });
}

(async () => {
  console.log("── A 组：dev-ide 行为级真跑（vm） ──");
  await runIdeRuntimeTests();
  console.log("── B 组：接线源码锚 ──");
  await runWiringTests();
  console.log("── C 组：版本滚动锚 ──");
  await runVersionTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项`);
  if (failures.length) {
    console.log("\n失败明细：");
    for (const item of failures) console.log("  - " + item);
    process.exit(1);
  }
})();
