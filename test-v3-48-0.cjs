"use strict";

/**
 * v3.48.0 守门：本机 Agent 一键检测与选用（用户令面：装了 AtomCode 不会填配置→一键检测+选它即用）
 * 追加令面：模块也适用于 SSH（SSH 适配器检测结果行内「选它」自动切+保存）+ 自动切换引擎。
 *
 * A 组：agent-detect.cjs 行为级真跑（vm：假 runProbe/tcpProbe/readDir/readFile 全注入）
 * B 组：接线源码锚（main IPC / preload 桥 / 渲染层「选它」联动 local+SSH / 混淆名单）
 * C 组：版本滚动锚
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const detectSrc = read("src/main/agent-detect.cjs");
const mainSrc = read("src/main/main.cjs");
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
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((error) => { failed++; failures.push(`${name}: ${error.message}`); console.log(`  ✗ ${name}: ${error.message}`); });
}

/* ── A 组装置 ── */
function loadDetectModule() {
  const sandbox = {
    require: (name) => {
      if (["path", "os", "net", "child_process"].includes(name)) return require(name);
      throw new Error(`agent-detect.cjs 只允许纯 Node 依赖（收到 ${name}）`);
    },
    module: { exports: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(`(function(){ const process = { platform: "linux", env: {} }; ${detectSrc} })();`, sandbox, { filename: "agent-detect.cjs" });
  return sandbox.module.exports;
}

function makeDeps(overrides = {}) {
  const probeResults = Object.assign({}, overrides.probeResults || {});
  return Object.assign({
    home: "/home/u",
    platform: "linux",
    readDir: () => { throw new Error("ENOENT"); },
    readFile: () => { throw new Error("ENOENT"); },
    tcpProbe: async () => false,
    onLog: null,
    probeResults
  }, overrides, {
    // runProbe 独立装配：probeResults 以 `file args` 为键 → {ok,stdout}
    runProbe: async function (file, args) {
      const key = `${file} ${args.join(" ")}`.trim();
      const matched = Object.keys(probeResults).find((candidate) => key === candidate || key.endsWith(candidate));
      if (matched !== undefined) return probeResults[matched];
      // 兜底：按 file 名匹配（where claude / claude --version）
      const fileMatch = Object.keys(probeResults).find((candidate) => key.startsWith(candidate));
      return fileMatch ? probeResults[fileMatch] : { ok: false, stdout: "" };
    }
  });
}

async function runDetectRuntimeTests() {
  await test("A0. 模块结构锚：七导出 + 模板映射 + 纯 Node 依赖（vm 依赖白名单自证）", () => {
    const detect = loadDetectModule();
    for (const key of ["detectLocalAgents", "parseDaemonPort", "parseDaemonToken", "applyOf", "resolveOnPath", "CUSTOM_TEMPLATES", "CUSTOM_LABELS"]) {
      assert.ok(key in detect, `导出 ${key} 应在册`);
    }
    assert.strictEqual(detect.applyOf("claude").localEngine, "claude");
    assert.strictEqual(detect.applyOf("atomcode").localEngine, "atomcode");
    assert.strictEqual(detect.applyOf("aider").localEngine, "custom");
    assert.strictEqual(detect.applyOf("aider").customCliCommand, "aider --message {message}");
    assert.strictEqual(detect.applyOf("unknown"), null, "未知 key 无 apply");
    assert.ok(!detectSrc.includes('"electron"') && !detectSrc.includes("'electron'"), "零 electron 依赖");
  });

  await test("A1. daemon 文件名/Token 解析真跑：daemon-<端口>.json 四端口形态 + token 五键集", () => {
    const detect = loadDetectModule();
    assert.strictEqual(detect.parseDaemonPort("daemon-13456.json"), 13456);
    assert.strictEqual(detect.parseDaemonPort("daemon-80.json"), 80);
    assert.strictEqual(detect.parseDaemonPort("daemon-0.json"), 0, "0 端口非法");
    assert.strictEqual(detect.parseDaemonPort("daemon-99999.json"), 0, "越界端口拒");
    assert.strictEqual(detect.parseDaemonPort("note.txt"), 0);
    assert.strictEqual(detect.parseDaemonToken(JSON.stringify({ token: "abc" })), true);
    assert.strictEqual(detect.parseDaemonToken(JSON.stringify({ access_token: " " })), false, "空白态值=无 token");
    assert.strictEqual(detect.parseDaemonToken(JSON.stringify({})), false);
    assert.strictEqual(detect.parseDaemonToken("不是 JSON"), false);
  });

  await test("A2. 全链真跑：claude 在册+版本、atomcode daemon 自发现（.atomcode 扫描+TCP 命中+token 在档）→ ready+apply 填端口", async () => {
    const detect = loadDetectModule();
    const deps = makeDeps({
      probeResults: {
        "which claude": { ok: true, stdout: "/usr/local/bin/claude\n" },
        "claude --version": { ok: true, stdout: "2.0.14 (Claude Code)" },
        "which atomcode": { ok: true, stdout: "/usr/local/bin/atomcode\n" },
        "atomcode --version": { ok: true, stdout: "1.2.9" }
      },
      tcpProbe: async (port) => port === 13456,
      readDir: (p) => (p.endsWith(".atomcode") ? ["daemon-13456.json", "daemon-1.json", "note.txt"] : []),
      readFile: (p) => (p.endsWith("daemon-13456.json") ? JSON.stringify({ token: "t" }) : "{}")
    });
    const result = await detect.detectLocalAgents(deps);
    const claude = result.agents.find((agent) => agent.key === "claude");
    assert.ok(claude && claude.status === "ready" && /2\.0\.14/.test(claude.version), "claude 在册带版本");
    const atomcode = result.agents.find((agent) => agent.key === "atomcode");
    assert.ok(atomcode, "atomcode 应在册");
    assert.strictEqual(atomcode.status, "ready", "daemon 在跑→ready");
    assert.strictEqual(atomcode.apply.atomcodePort, 13456, "apply 自动填 daemon 端口");
    assert.strictEqual(atomcode.apply.atomcodeHost, "127.0.0.1");
    assert.ok(/token 已自动发现/.test(atomcode.detail), "token 在档提示");
    assert.ok(atomcode.detail.includes("13456"), "detail 应含端口");
  });

  await test("A3. partial 态真跑：atomcode CLI 在而 daemon 未跑→差一步+apply=null（不出「选它」面）", async () => {
    const detect = loadDetectModule();
    const deps = makeDeps({
      probeResults: {
        "which atomcode": { ok: true, stdout: "/usr/bin/atomcode\n" },
        "atomcode --version": { ok: true, stdout: "1.2.9" }
      },
      readDir: () => [], // 无 daemon-*.json
      tcpProbe: async () => false
    });
    const result = await detect.detectLocalAgents(deps);
    const atomcode = result.agents.find((agent) => agent.key === "atomcode");
    assert.ok(atomcode, "CLI 在册应列 atomcode");
    assert.strictEqual(atomcode.status, "partial");
    assert.strictEqual(atomcode.apply, null, "daemon 未跑不该给 apply（渲染层不出选它）");
    assert.ok(/未运行/.test(atomcode.detail), "差一步提示");
  });

  await test("A4. custom 六连探真跑：aider/opencode 命中→ready+内置模板；qwen 未命中→不在册", async () => {
    const detect = loadDetectModule();
    const deps = makeDeps({
      probeResults: {
        "which aider": { ok: true, stdout: "/opt/aider\n" },
        "aider --version": { ok: true, stdout: "0.61.0" },
        "which opencode": { ok: true, stdout: "/usr/bin/opencode\n" },
        "opencode --version": { ok: true, stdout: "0.3.0" }
      }
    });
    const result = await detect.detectLocalAgents(deps);
    const custom = result.agents.filter((agent) => agent.engine === "custom");
    assert.strictEqual(custom.length, 2, "仅命中的列在册");
    const aider = custom.find((agent) => agent.key === "aider");
    assert.strictEqual(aider.apply.customCliCommand, "aider --message {message}");
    assert.strictEqual(aider.apply.localEngine, "custom");
    assert.ok(!result.agents.some((agent) => agent.key === "qwen"), "未命中不列");
  });

  await test("A5. 空机真跑（零命中）+ onLog 事件与返回形态", async () => {
    const detect = loadDetectModule();
    const logs = [];
    const result = await detect.detectLocalAgents(makeDeps({ onLog: (name, data) => logs.push([name, data]) }));
    assert.strictEqual(result.agents.length, 0, "全未命中=空清单");
    assert.strictEqual(result.platform, "linux");
    assert.ok(logs.some(([name, data]) => name === "local_agent_detect" && data.total === 0), "local_agent_detect 日志双参");
  });

  await test("A6. Windows 形态真跑：where 代替 which（platform=win32）", async () => {
    const detect = loadDetectModule();
    const deps = makeDeps({
      platform: "win32",
      probeResults: {
        "where claude": { ok: true, stdout: "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\n" },
        "claude --version": { ok: true, stdout: "2.0.14" }
      }
    });
    const result = await detect.detectLocalAgents(deps);
    const claude = result.agents.find((agent) => agent.key === "claude");
    assert.ok(claude && claude.status === "ready", "Windows where 命中=在册");
    assert.ok(claude.apply.localEngine === "claude");
  });
}

async function runWiringTests() {
  await test("B1. main.cjs 接线：require + local-agents:detect handler（只读+失败日志）", () => {
    assert.ok(mainSrc.includes('const { detectLocalAgents } = require("./agent-detect.cjs");'), "agent-detect require 应在册");
    assert.ok(mainSrc.includes('ipcMain.handle("local-agents:detect"'), "IPC handler 应在册");
    assert.ok(mainSrc.includes("local_agent_detect_failed"), "失败日志应在册");
    assert.ok(mainSrc.includes("v3.48.0：本机 Agent 一键检测——只读探测"), "根因注释应在册");
  });

  await test("B2. preload 桥：detectLocalAgents", () => {
    assert.ok(preloadSrc.includes('detectLocalAgents: () => ipcRenderer.invoke("local-agents:detect")'), "preload 桥应在册");
  });

  await test("B3. 渲染层：检测按钮/结果面板/选它联动（引擎切换+host/port/模板填充+token 留空口径）", () => {
    for (const anchor of [
      "#local-agent-detect-button",
      "function renderLocalAgentDetect",
      "function applyLocalAgent(",
      'document.querySelector(`[data-local-engine="${apply.localEngine}"]`)',
      '#atomcode-host").value = String(apply.atomcodeHost)',
      '#atomcode-port").value = String(apply.atomcodePort)',
      '#custom-cli-command").value = String(apply.customCliCommand)',
      "token 留空 = daemon-端口.json 自动读取",
      "点「保存连接」即用",
      "🔍 重新检测"
    ]) {
      assert.ok(rendererSrc.includes(anchor), `渲染层锚应在册：${anchor}`);
    }
    for (const htmlAnchor of ['id="local-agent-detect-button"', 'id="local-agent-result"', "🔍 一键检测本机 Agent"]) {
      assert.ok(htmlSrc.includes(htmlAnchor), `index.html 锚应在册：${htmlAnchor}`);
    }
  });

  await test("B4. SSH 联动：renderAdapterDetect 行内「选它」+ applySshAdapter（复用既有切换与保存）", () => {
    assert.ok(rendererSrc.includes("async function applySshAdapter("), "applySshAdapter 应在册");
    assert.ok(rendererSrc.includes('`#adv-panel-adapter [data-adapter-key="${key}"]`'), "复用既有切换逻辑");
    assert.ok(rendererSrc.includes('document.querySelector("#adapter-apply")'), "复用既有保存组");
    assert.ok(rendererSrc.includes("item.status === \"builtin\" || item.status === \"installed\""), "仅可用项出选它");
    assert.ok(/保存结果提示由 #adapter-apply 既有 handler 统一给出/.test(rendererSrc), "不顶掉保存结果的注释应在册");
    assert.ok(stylesSrc.includes(".detect-apply"), "选它按钮样式应在册");
  });

  await test("B5. 混淆名单登记 main/agent-detect.cjs（medium；新主进程模块必登记——铁律）", () => {
    assert.ok(/"main\/agent-detect\.cjs",\s*\/\/.*v3\.48\.0/.test(obfSrc), "medium 名单应登记带 v3.48.0 注记");
    assert.ok(obfSrc.split("main/agent-detect.cjs").length - 1 === 1, "登记应恰好一处");
  });

  await test("B6. 回归面零位移：v3.19.0 detect-ssh-adapter 与 daemon-chat 读 token 键集未被挤掉", () => {
    assert.ok(mainSrc.includes('ipcMain.handle("settings:detect-ssh-adapter"'), "既有 SSH 检测 handler 应保留");
    const daemonSrcLine = read("src/main/daemon-chat.cjs");
    for (const key of ["token", "api_key", "auth_token", "accessToken", "access_token"]) {
      assert.ok(daemonSrcLine.includes(key), `daemon token 键集应保留：${key}`);
    }
    assert.ok(detectSrc.includes("token\", \"api_key\", \"auth_token\", \"accessToken\", \"access_token"), "agent-detect 键集同构 daemon-chat");
  });
}

async function runVersionTests() {
  await test("C1. 版本滚动锚：package.json =3.48.0 且 README badge 自洽", () => {
    const parts = pkg.version.split(".").map(Number);
    assert.ok(parts[0] === 3 && parts[1] === 48 && parts[2] === 0, `版本应为 3.48.0（实际 ${pkg.version}）`);
    assert.ok(readme.includes(`version-${pkg.version}`), "README badge 应与 package.json 一致");
    const badge = (readme.match(/tests-(\d+)%20files/) || [])[1];
    assert.ok(badge && Number(badge) >= 68, `README tests badge 应 ≥68（实际 ${badge}）`);
  });

  await test("C2. 装置自检：守门文件自身在清单（README badge=全部 test-*.cjs 守门件数——版本件+非版本件同口径）", () => {
    const files = fs.readdirSync(ROOT).filter((name) => /^test-.*\.cjs$/.test(name));
    assert.ok(files.includes("test-v3-48-0.cjs"), "新守门应在清单");
    assert.ok(files.length > 60, `版本守门件数应 >60（实际 ${files.length}）`);
    assert.ok(Number(badgeOf(readme)) === files.length, `README tests badge 应=守门文件数（badge=${badgeOf(readme)} files=${files.length}）`);
  });
}

function badgeOf(text) {
  return (text.match(/tests-(\d+)%20files/) || [])[1];
}

(async () => {
  console.log("── A 组：agent-detect 行为级真跑（vm） ──");
  await runDetectRuntimeTests();
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
