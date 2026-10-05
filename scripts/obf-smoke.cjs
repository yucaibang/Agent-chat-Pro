"use strict";

/**
 * 混淆后主进程模块加载冒烟（v3.21.1）
 *
 * 背景：v3.21.0 装机事故——controlFlowFlattening/deadCodeInjection 随机重排语句致
 *   chat:send 内 TDZ ReferenceError（Cannot access '_0x4b1a81' before initialization），
 *   云端/SSH 发消息即炸。根因开关已在 obfuscate.cjs 永久禁用；本脚本为本事故的第二道防线：
 *   混淆后立即对全部名单模块做「mock electron 顶层求值」——顶层求值级错误
 *   （语法破坏/未定义标识符/接线断裂）在构建期拦截，不再等到装机才现形。
 *
 * 用法：node scripts/obf-smoke.cjs [modulesDir相对路径，默认 src]
 *   退出码 0=全过；1=有模块顶层求值抛异常（构建中止）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const { OBFUSCATE_FILES } = require("./obfuscate.cjs");
if (!OBFUSCATE_FILES) {
  console.error("obf-smoke: obfuscate.cjs 未导出 OBFUSCATE_FILES");
  process.exit(1);
}
// 冒烟范围=主进程 medium 名单（renderer 是渲染进程模块，需真实 DOM——由 test-* 的 vm 假 DOM 冒烟覆盖）
const TARGETS = OBFUSCATE_FILES.medium;

// ── electron mock：whenReady 永挂（异步初始化不展开，只验顶层同步求值） ──
const silent = () => {};
const fakeWebContents = new Proxy({}, {
  get(_t, prop) {
    if (prop === "send" || prop === "on" || prop === "once") return silent;
    if (prop === "session") return fakeWebContents;
    return silent;
  }
});
class FakeBrowserWindow {
  constructor() { this.webContents = fakeWebContents; this.on = silent; this.once = silent; }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  show() {} close() {} destroy() {} focus() {} hide() {}
  setTitle() {} setSize() {} setBounds() {}
}
const fakeElectron = {
  app: {
    getPath: () => path.join(os.tmpdir(), "acp-obf-smoke"),
    on: silent, once: silent, whenReady: () => new Promise(() => {}), // 永挂——顶层求值即返回
    isReady: () => true, quit: silent, exit: silent, getVersion: () => "0",
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: silent, setAppUserModelId: silent,
    requestSingleInstanceLock: () => true, isInSingleInstanceMode: false,
    commandLine: { appendSwitch: silent, appendArgument: silent },
    name: "Agent Chat Pro", setAsDefaultProtocolClient: silent
  },
  ipcMain: { handle: silent, on: silent, removeHandler: silent, removeAllListeners: silent },
  ipcRenderer: { invoke: async () => ({}), send: silent, on: silent, once: silent, removeListener: silent },
  BrowserWindow: FakeBrowserWindow,
  contextBridge: { exposeInMainWorld: silent },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (b) => Buffer.from(b),
    decryptString: (b) => Buffer.from(b)
  },
  shell: { openExternal: async () => {}, openPath: async () => "", showItemInFolder: silent, trashItem: async () => {} },
  dialog: { showMessageBox: async () => ({ response: 0 }), showError: async () => {}, showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  session: new Proxy({}, { get: () => () => ({ on: silent, setProxy: async () => {} }) }),
  net: { fetch: (u, opt) => fetch(u, opt) },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: silent },
  Notification: class { show() {} on() {} },
  Tray: class { constructor() { this.on = silent; } setToolTip() {} setImage() {} destroy() {} },
  nativeTheme: { on: silent, shouldUseDarkColors: false },
  screen: { on: silent, getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, scaleFactors: [1] }) },
  powerMonitor: { on: silent },
  powerSaveBlocker: { start: () => 1, stop: silent, isStarted: () => false },
  clipboard: { writeText: silent, readText: () => "" },
  systemPreferences: { on: silent, getUserDefault: () => "", isAeroGlassEnabled: () => true },
  crashReporter: { start: silent, addExtraParameter: silent },
  protocol: { registerFileProtocol: (s, cb) => ({ on: silent }), interceptFileProtocol: silent, registerSchemesAsPrivileged: silent, handle: async () => true },
  globalShortcut: { register: () => true, unregister: silent, unregisterAll: silent },
  desktopCapturer: { getSources: async () => [] }
};

// require.cache 注入 electron mock
const electronPath = require.resolve("electron");
const electronMod = require.cache[electronPath] ? require.cache[electronPath] : (require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {} });
// electron 的 CJS 入口通常导出字符串路径（非渲染环境）——直接覆盖 exports 为 mock 对象
electronMod.exports = fakeElectron;

let pass = 0, fail = 0;
const failures = [];

console.log("🧪 混淆后主进程模块加载冒烟（v3.21.1）...");
for (const rel of TARGETS) {
  const full = path.join(PROJECT_ROOT, "src", rel);
  if (!fs.existsSync(full)) {
    console.log(`  ⚠ 跳过（不存在）: ${rel}`);
    continue;
  }
  try {
    delete require.cache[full]; // 逐模块独立求值（清自身缓存防「已被依赖链加载过」跳过求值）
    require(full);
    pass += 1;
    console.log(`  ✓ ${rel}`);
  } catch (error) {
    fail += 1;
    failures.push(`  ✗ ${rel}: ${error.message}`);
    console.log(`  ✗ ${rel}: ${error.message}`);
  }
}

console.log(`\n冒烟: ${pass + fail} 模块 · 通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.log(failures.join("\n"));
  process.exit(1);
}
process.exit(0);