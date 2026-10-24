"use strict";
/**
 * v3.22.0 测试 — 云办公二期：NAS Docker 沙箱执行形态
 * 背景：v3.14.0 云办公一期工具执行在 Windows 本机（child_process/fs 直碰宿主）。
 *   v3.22.0 拍板：沙箱宿主 = NAS Docker（容器名固定 sandbox；默认断网 isolated internal 网络、
 *   临时联网经 docker network connect/disconnect bridge 插拔；工作卷挂载 /workspace）。
 *   执行通道：主进程 → SSH → NAS `docker exec`；文件三工具在容器内路径视角（POSIX 护栏）。
 * 覆盖：cloud-tools 沙箱分支真单测（mock executor.run）+ POSIX 越界护栏 + main/ssh/settings/
 *       preload/renderer 接线断言 + TDZ 声明位置守门 + NAS 环境锚点（compose/Dockerfile 文件断言）。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const Module = require("module");
const os = require("os");

const ROOT = __dirname;
const TOOLS_PATH = path.join(ROOT, "src", "main", "cloud-tools.cjs");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
const SSH_PATH = path.join(ROOT, "src", "main", "ssh.cjs");
const SETTINGS_PATH = path.join(ROOT, "src", "main", "settings.cjs");
const PRELOAD_PATH = path.join(ROOT, "src", "main", "preload.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
// v3.24.9 清洗对齐说明：宿主测试基建路径（无 IP/用户名/机器名指纹，非部署拓扑）仅对本机环境级断言有意义——
// 公开仓库/其他机器跑=目录不存在时⊘跳过；用 ACP_SANDBOX_BUILD 环境变量可在任意环境注入。
const NAS_SANDBOX_BUILD = process.env.ACP_SANDBOX_BUILD || "/vol2/1000/172GB/agent/sandbox/build";
const hasSandboxBuild = fs.existsSync(path.join(NAS_SANDBOX_BUILD, "docker-compose.yml"))
  && fs.existsSync(path.join(NAS_SANDBOX_BUILD, "Dockerfile"));
const PACKAGE_PATH = path.join(ROOT, "package.json");

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

const settingsSrc = fs.readFileSync(SETTINGS_PATH, "utf8");
const mainSrc = fs.readFileSync(MAIN_PATH, "utf8");
const sshSrc = fs.readFileSync(SSH_PATH, "utf8");
const preloadSrc = fs.readFileSync(PRELOAD_PATH, "utf8");
const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
const htmlSrc = fs.readFileSync(HTML_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

// mock electron 后加载 cloud-tools（protocol.cjs 无依赖；local.cjs 依赖 fs/os 无 electron）
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3220-"));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => workdir, whenReady: async () => {} }, safeStorage: { isEncryptionAvailable: () => true } };
  }
  return originalLoad.apply(this, arguments);
};
const tools = require(TOOLS_PATH);
Module._load = originalLoad;

/** 组装 mock 沙箱执行器：记录收到的 run 参数，返回注入的模拟结果 */
function makeMockExecutor(result) {
  const calls = [];
  return {
    calls,
    executor: {
      enabled: true,
      run: async (input) => { calls.push(input); return typeof result === "function" ? result(input) : result; }
    }
  };
}

async function runSandboxToolTests() {
  await test("A1 沙箱 read_file：命令构造 = docker exec sandbox cat -- '路径'，返回 stdout", async () => {
    const mock = makeMockExecutor({ code: 0, stdout: "hello\nworld", stderr: "" });
    const text = await tools.executeToolCall({ name: "read_file", arguments: { path: "notes/报告.md" } }, { allowCommand: false, sandboxExecutor: mock.executor });
    assert.strictEqual(mock.calls.length, 1);
    const command = mock.calls[0].command;
    assert.ok(command.startsWith("docker exec sandbox cat -- "), `命令前缀不符：${command}`);
    assert.ok(command.endsWith("'/workspace/notes/报告.md'"), `相对路径应解析到容器内绝对路径：${command}`);
    assert.ok(command.includes("/workspace"), `容器内路径应显式出现：${command}`);
    assert.strictEqual(mock.calls[0].stdin, undefined, "read_file 不应有 stdin");
    assert.strictEqual(mock.calls[0].timeoutMs, 120 * 1000, "超时应沿用 120s");
    assert.strictEqual(text, "hello\nworld");
  });

  await test("A2 POSIX 越界护栏：.. 逃逸 / 绝对路径越界 / 空字节 → 拒绝且不触网执行", async () => {
    assert.throws(() => tools.resolveInsideWorkdirPosix("/workspace", "../etc/passwd"), /超出工作目录范围/);
    assert.throws(() => tools.resolveInsideWorkdirPosix("/workspace", "/etc/passwd"), /超出工作目录范围|路径/);
    assert.throws(() => tools.resolveInsideWorkdirPosix("/workspace", "a/../../../etc/passwd"), /超出工作目录范围/);
    // workdir 内部相对路径合法
    assert.strictEqual(tools.resolveInsideWorkdirPosix("/workspace", "sub/x.txt"), "/workspace/sub/x.txt");
    // 空字节拒绝
    assert.throws(() => tools.resolveInsideWorkdirPosix("/workspace", "a\0b"), /非法字符/);
  });

  await test("A3 沙箱 read_file 走到 executor 后退出码非零 → 中文错误（stderr 首行）", async () => {
    const mock = makeMockExecutor({ code: 1, stdout: "", stderr: "cat: /workspace/x.txt: No such file or directory\n" });
    await assert.rejects(
      () => tools.executeToolCall({ name: "read_file", arguments: { path: "x.txt" } }, { allowCommand: false, sandboxExecutor: mock.executor }),
      /No such file or directory/
    );
  });

  await test("A4 沙箱 write_file：stdin 流入 cat 重定向（内容不进命令行）", async () => {
    const mock = makeMockExecutor({ code: 0, stdout: "", stderr: "" });
    const text = await tools.executeToolCall({ name: "write_file", arguments: { path: "out/结果.txt", content: "第一行\n第二行" } }, { allowCommand: false, sandboxExecutor: mock.executor });
    assert.strictEqual(mock.calls.length, 1);
    const command = mock.calls[0].command;
    assert.ok(command.startsWith("docker exec -i sandbox sh -c "), `写入应带 -i（stdin 流入）：${command}`);
    assert.ok(command.includes("sh -c") && command.includes("cat -- >"), `重定向脚本应存在：${command}`);
    assert.ok(command.includes("cat -- > ") && command.includes("/workspace/out/结果.txt"), `目标路径应在重定向后（解析为容器内绝对路径，shellQuote 转义单引号）：${command}`);
    assert.ok(!command.includes("第一行"), "内容不得出现在命令行（防注入+防截断）");
    assert.strictEqual(mock.calls[0].stdin, "第一行\n第二行");
    assert.ok(text.includes("已写入"), `返回文案应确认写入：${text}`);
  });

  await test("A5 沙箱 list_directory：find -printf 命令 + 输出解析 [文件]/[目录] 前缀", async () => {
    const mock = makeMockExecutor({ code: 0, stdout: "d\t子目录\nf\t报告.md\nl\t软链\n", stderr: "" });
    const text = await tools.executeToolCall({ name: "list_directory", arguments: {} }, { allowCommand: false, sandboxExecutor: mock.executor });
    assert.ok(mock.calls[0].command.startsWith("docker exec sandbox find "), `find 应直接跑不套 sh -c：${mock.calls[0].command}`);
    assert.ok(mock.calls[0].command.includes("-printf '%y\\t%f\\n'"), `printf 转义应由 find 解析：${mock.calls[0].command}`);
    assert.ok(text.includes("[目录] 子目录"));
    assert.ok(text.includes("[文件] 报告.md"));
  });

  await test("A6 沙箱 list_directory 500 截断 + 越界拒绝", async () => {
    const many = Array.from({ length: 520 }, (_, i) => `f\t文件${i}.txt`).join("\n") + "\n";
    const mock = makeMockExecutor({ code: 0, stdout: many, stderr: "" });
    const text = await tools.executeToolCall({ name: "list_directory", arguments: {} }, { allowCommand: false, sandboxExecutor: mock.executor });
    assert.ok(text.includes("仅显示前 500 项"), "应截断并提示总数");
    assert.ok(text.split("\n").length === 501, `应恰好 500 项+1 行提示，实际 ${text.split("\n").length}`);
    // 越界
    const mock2 = makeMockExecutor({ code: 0, stdout: "", stderr: "" });
    await assert.rejects(
      () => tools.executeToolCall({ name: "list_directory", arguments: { path: "../outside" } }, { allowCommand: false, sandboxExecutor: mock2.executor }),
      /超出工作目录范围/
    );
  });

  await test("A7 沙箱 run_command：sh -c 包裹 + -w 工作目录 + 输出截断/退出码", async () => {
    const mock = makeMockExecutor({ code: 3, stdout: "OK 输出", stderr: "警告信息" });
    const text = await tools.executeToolCall({ name: "run_command", arguments: { command: "echo hi && ls" } }, { allowCommand: true, sandboxExecutor: mock.executor });
    assert.ok(mock.calls[0].command.startsWith("docker exec -w '/workspace' sandbox /bin/sh -c "), `命令形态：${mock.calls[0].command}`);
    assert.ok(mock.calls[0].command.includes("'+echo hi && ls'") || mock.calls[0].command.includes("echo hi && ls"), `用户命令应经 sh -c 包裹：${mock.calls[0].command}`);
    assert.ok(text.startsWith("退出码 3"), `退出码应透出：${text}`);
    assert.ok(text.includes("OK 输出") && text.includes("警告信息"), `stdout+stderr 应合并：${text}`);
  });

  await test("A8 沙箱 run_command 未授权同样拦截（allowCommand=false）", async () => {
    const mock = makeMockExecutor({ code: 0, stdout: "", stderr: "" });
    await assert.rejects(
      () => tools.executeToolCall({ name: "run_command", arguments: { command: "ls" } }, { allowCommand: false, sandboxExecutor: mock.executor }),
      /命令执行未开启/
    );
    assert.strictEqual(mock.calls.length, 0, "拦截时不得触达执行器");
  });

  await test("A9 sandboxExecutor.run 抛出（SSH 超时）→ 沙箱中文错误", async () => {
    const calls = [];
    const executor = {
      enabled: true,
      run: async (input) => { calls.push(input); throw new Error("远程操作超时（120 秒）…"); }
    };
    await assert.rejects(
      () => tools.executeToolCall({ name: "read_file", arguments: { path: "x" } }, { allowCommand: false, sandboxExecutor: executor }),
      /沙箱读取失败：.*超时/
    );
  });

  await test("A10 web_fetch 不沙箱化（容器默认断网，抓网仍走 ACP 本机）", async () => {
    // executor 假设会记录任何 run——web_fetch 不应触达
    const mock = makeMockExecutor({ code: 0, stdout: "", stderr: "" });
    await assert.rejects(
      () => tools.executeToolCall({ name: "web_fetch", arguments: { url: "http://127.0.0.1:1/nope.invalid" } }, { allowCommand: false, sandboxExecutor: mock.executor }),
      () => true // 本机 fetch 失败（端口无服务）即证明未走沙箱通道
    );
    assert.strictEqual(mock.calls.length, 0, "web_fetch 不得经沙箱执行");
  });

  await test("A11 一期兼容回退：未注入 sandboxExecutor → 本机实现真实读写 tmp 目录", async () => {
    const localDir = path.join(workdir, "云办公一期");
    fs.mkdirSync(localDir, { recursive: true });
    const text = await tools.executeToolCall({ name: "write_file", arguments: { path: "a.txt", content: "本机形态" } }, { workdir: localDir, allowCommand: false });
    assert.ok(text.includes("已写入"));
    assert.strictEqual(fs.readFileSync(path.join(localDir, "a.txt"), "utf8"), "本机形态");
  });
}

async function runWiringTests() {
  await test("B1 main.cjs：沙箱执行器声明前置 runCloudWithTools（TDZ 守门锚点）", () => {
    const sandboxIdx = mainSrc.indexOf("const sandboxExecutor = { enabled: false, run: null };");
    const runnerIdx = mainSrc.indexOf("const runCloudWithTools = async () => {");
    assert.ok(sandboxIdx !== -1 && runnerIdx !== -1, "沙箱执行器/runCloudWithTools 落点缺失");
    assert.ok(sandboxIdx < runnerIdx, "sandboxExecutor 声明必须先于 runCloudWithTools 定义（闭包体静态前置）");
  });

  await test("B2 main.cjs：SSH 通道接线（connect/exec require + getSshConnection + 指纹未信任拒问）", () => {
    assert.ok(mainSrc.includes("connect, connectWithRetry, downloadRemoteFile"), "ssh.cjs connect 未 require");
    assert.ok(mainSrc.includes("exec, finalizeDeviceControl"), "exec 未 require");
    assert.ok(mainSrc.includes("sandboxSshClient = await connect("), "沙箱 SSH 建连缺失");
    assert.ok(mainSrc.includes("getSshConnection()"), "SSH 凭证来源缺失");
    const connectBlock = mainSrc.slice(mainSrc.indexOf("sandboxSshClient = await connect("));
    assert.ok(connectBlock.includes("() => false"), "未信任主机应拒绝询问（不弹 UI）");
  });

  await test("B3 main.cjs：工具循环 context 注入 sandboxExecutor + finally 双路清理", () => {
    const callLine = mainSrc.slice(mainSrc.indexOf("executeToolCall({ id: call.id"), mainSrc.indexOf("executeToolCall({ id: call.id") + 500);
    assert.ok(callLine.includes("sandboxExecutor: sandboxOn ? sandboxExecutor : undefined"), "工具调用未注入沙箱执行器");
    const finallyIdx = mainSrc.indexOf("sandboxSshClient.end()", mainSrc.indexOf("} finally {"));
    assert.ok(finallyIdx !== -1, "finally 未清理沙箱 SSH 连接");
  });

  await test("B4 main.cjs：沙箱 IPC 两通道（setNetwork 网络插拔落盘 + status 探测）", () => {
    assert.ok(mainSrc.includes('ipcMain.handle("sandbox:setNetwork"'), "setNetwork IPC 缺失");
    assert.ok(mainSrc.includes('ipcMain.handle("sandbox:status"'), "status IPC 缺失");
    assert.ok(mainSrc.includes("docker network ${verb} bridge sandbox"), "网络插拔命令缺失");
    assert.ok(mainSrc.includes("{{.State.Running}}"), "容器运行态探测缺失");
    assert.ok(mainSrc.includes("{{range $k, $_ := .NetworkSettings.Networks}}"), "网络枚举探测缺失");
  });

  await test("B5 ssh.cjs：exec 支持 stdin（write_file 内容流）+ connect 已导出", () => {
    assert.ok(sshSrc.includes("if (options.stdin != null)"), "exec stdin 支持缺失");
    assert.ok(sshSrc.includes("module.exports = { buildAttachmentNote, buildDeviceConnectScript, connect,"), "connect 未导出");
  });

  await test("B6 settings.cjs：沙箱字段三面齐（normalize/getCloudAiConfig/save 白名单）", () => {
    assert.ok(settingsSrc.includes("cloudSandboxEnabled: Boolean(raw.cloudSandboxEnabled)"), "getSettings normalize 缺字段");
    assert.ok(settingsSrc.includes("sandboxEnabled: Boolean(raw.cloudSandboxEnabled)"), "getCloudAiConfig 缺字段");
    assert.ok(settingsSrc.includes("cloudSandboxEnabled: Boolean(input.cloudSandboxEnabled)"), "save 白名单缺字段");
  });

  await test("B7 preload：getSandboxStatus/setSandboxNetwork 通道暴露", () => {
    assert.ok(preloadSrc.includes("getSandboxStatus: () => ipcRenderer.invoke(\"sandbox:status\")"), "状态查询通道缺失");
    assert.ok(preloadSrc.includes("setSandboxNetwork: (enabled) => ipcRenderer.invoke(\"sandbox:setNetwork\", enabled)"), "联网切换通道缺失");
  });

  await test("B8 renderer：沙箱控件收集/回填/事件三链齐", () => {
    assert.ok(rendererSrc.includes("cloudSandboxEnabled: document.querySelector(\"#cloud-sandbox-enabled\")"), "保存收集缺沙箱开关");
    assert.ok(rendererSrc.includes("cloudSandboxNetworkEnabled: document.querySelector(\"#cloud-sandbox-network-enabled\")"), "保存收集缺联网开关");
    assert.ok(rendererSrc.includes("#cloud-sandbox-network-enabled\")?.addEventListener(\"change\""), "联网切换事件缺失");
    assert.ok(rendererSrc.includes("#cloud-sandbox-status\")?.addEventListener(\"click\""), "状态按钮事件缺失");
    assert.ok(rendererSrc.includes("toggle.checked = !wanted"), "切换失败应回拨勾选态");
  });

  await test("B9 index.html：沙箱三控件在云办公工具区内", () => {
    const idx = htmlSrc.indexOf('id="cloud-sandbox-enabled"');
    assert.ok(idx > htmlSrc.indexOf('id="cloud-run-command-enabled"'), "沙箱控件应在命令开关之后");
    assert.ok(htmlSrc.includes('id="cloud-sandbox-network-enabled"'), "联网开关缺失");
    assert.ok(htmlSrc.includes('id="cloud-sandbox-status"'), "状态按钮缺失");
  });
}

async function runNasEnvironmentTests() {
  await test("C1 NAS compose：容器名固定 sandbox + internal 隔离网 + 工作卷挂载 + 自启策略", () => {
    if (!hasSandboxBuild) { console.log("  ⊘ 环境无沙箱 build 目录（非 NAS 装机环境），已跳过"); return; }
    const compose = fs.readFileSync(path.join(NAS_SANDBOX_BUILD, "docker-compose.yml"), "utf8");
    assert.ok(compose.includes("container_name: sandbox"), "容器名非固定 sandbox");
    assert.ok(compose.includes("internal: true"), "隔离网络应 internal（无外网出口）");
    assert.ok(compose.includes("../work:/workspace"), "工作卷挂载缺失");
    assert.ok(compose.includes("restart: unless-stopped"), "自启策略缺失");
  });

  await test("C2 NAS Dockerfile：node20/py3 基底 + 常用 CLI 清单", () => {
    if (!hasSandboxBuild) { console.log("  ⊘ 环境无沙箱 build 目录（非 NAS 装机环境），已跳过"); return; }
    const dockerfile = fs.readFileSync(path.join(NAS_SANDBOX_BUILD, "Dockerfile"), "utf8");
    assert.ok(dockerfile.includes("node:20-slim"), "应基于 node20-slim");
    assert.ok(dockerfile.includes("python3"), "缺 python3");
    assert.ok(/git curl wget jq unzip zip/.test(dockerfile), "常用 CLI 清单缺失");
    assert.ok(dockerfile.includes("WORKDIR /workspace"), "工作目录缺失");
  });

  await test("C3 NAS 沙箱镜像与容器实际在线（环境级断言）", () => {
    const image = require("child_process").execSync("docker images --format '{{.Repository}}:{{.Tag}}' acp-sandbox", { encoding: "utf8" }).trim();
    assert.ok(image.includes("acp-sandbox:latest"), "acp-sandbox 镜像不存在");
    const state = require("child_process").execSync("docker inspect sandbox --format '{{.State.Running}}' 2>/dev/null || printf missing", { encoding: "utf8" }).trim();
    assert.strictEqual(state, "true", "sandbox 容器未在运行");
    const networks = require("child_process").execSync("docker inspect sandbox --format '{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null", { encoding: "utf8" }).trim().split(/\s+/);
    assert.ok(!networks.includes("bridge"), `默认应断网（bridge 不在场），实际 ${networks.join(",")}`);
    assert.ok(networks.includes("sandbox-isolated"), "应挂隔离网络");
  });

  await test("C4 NAS 沙箱内 node/python 版本可用（规格验证：node20+ 主版本域；镜像基座漂移实证 2026-10-24 = v22.23.4）", () => {
    const node = require("child_process").execSync("docker exec sandbox node --version", { encoding: "utf8" }).trim();
    const major = Number(String(node).replace(/^v/, "").split(".")[0]);
    assert.ok(major >= 20, `node 应 ≥ 20.x（规格 node20+ 本意），实际 ${node}`);
    const py = require("child_process").execSync("docker exec sandbox python3 --version", { encoding: "utf8" }).trim();
    assert.ok(/^Python 3\./.test(py), `python3 应可用，实际 ${py}`);
  });
}

async function runVersionTests() {
  await test("D1 package.json 版本 ≥ 3.22.0", () => {
    const rank = pkg.version.split(".").reduce((sum, part) => sum * 1000 + Number(part), 0);
    assert.ok(rank >= 32200, `版本 ${pkg.version} 应 ≥ 3.22.0`);
  });
  await test("D2 cloud-tools 沙箱常量与导出在册", () => {
    assert.strictEqual(tools.SANDBOX_CONTAINER, "sandbox");
    assert.strictEqual(tools.SANDBOX_WORKDIR, "/workspace");
    assert.strictEqual(typeof tools.resolveInsideWorkdirPosix, "function");
  });
}

(async () => {
  await runSandboxToolTests();
  await runWiringTests();
  await runNasEnvironmentTests();
  await runVersionTests();
  console.log(`\n=== test-v3-22-0.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})();