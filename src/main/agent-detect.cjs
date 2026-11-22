"use strict";

/**
 * Agent Chat Pro — 本机 Agent 一键检测（v3.48.0）
 *
 * 用户令面（p330tiny）：
 *   「在本机那里搞一个一键检测电脑内注入的 agent，检测到后，就选择要让哪个进行对话使用，
 *    然后选择，于是就这么配置上了，就可以进行使用」——AtomCode 装了不会填配置的痛点根治。
 *   + 追加：「刚好这一个模块也很适用于 SSH，也能适用于来帮你自动切换引擎」。
 *
 * 设计：
 *   - detectLocalAgents(deps)：只读探测四类（零写零删）——
 *       ① claude（ PATH where/which + --version）
 *       ② atomcode（CLI 本体 + ~/.atomcode/daemon-*.json 自动发现端口/token + TCP 探测 daemon 是否在跑）
 *       ③ 常见自定义 CLI 六连探（aider/opencode/qwen/codex/gemini/crush → 命令模板内置映射）
 *     deps 全注入（runProbe/tcpProbe/home/readDir/readFile）→ vm 真跑可注入假面。
 *   - 每个 agent 给 apply 面（localEngine/host/port/模板）——渲染层「选它」即自动切换引擎并填配置。
 *   - SSH 路复用 v3.19.0 settings:detect-ssh-adapter（不动），渲染层检测结果加「选它」联动自动切适配器。
 *   - 安全：探测全部带超时（where/which 2.5s、--version 3s、TCP 1.2s），token 只测存在不回显。
 */

const CUSTOM_TEMPLATES = {
  // 保守基础形；自动填入后用户可在输入框手动调整（模板不含 {message} 时消息走标准输入）
  aider: "aider --message {message}",
  opencode: "opencode run {message}",
  qwen: "qwen -p {message}",
  codex: "codex exec {message}",
  gemini: "gemini -p {message}",
  crush: "crush run {message}"
};

const CUSTOM_LABELS = { aider: "Aider", opencode: "OpenCode", qwen: "Qwen Code", codex: "Codex", gemini: "Gemini CLI", crush: "Crush" };

/** ~/.atomcode/daemon-<端口>.json 文件名解析（非 daemon-*.json → 0） */
function parseDaemonPort(fileName) {
  const match = /^daemon-(\d{1,5})\.json$/.exec(String(fileName || "").trim());
  if (!match) return 0;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : 0;
}

/** daemon-<端口>.json 内 token 字段探测（同 daemon-chat.cjs 键集；只测存在，不取值不回显） */
function parseDaemonToken(raw) {
  try {
    const json = JSON.parse(String(raw || ""));
    return ["token", "api_key", "auth_token", "accessToken", "access_token"].some((key) => {
      const value = json && json[key];
      return typeof value === "string" ? Boolean(value.trim()) : Boolean(value);
    });
  } catch { return false; }
}

/** 自定义 CLI 的 apply 面（引擎切 custom + 内置模板） */
function applyOf(key) {
  if (key === "claude") return { localEngine: "claude" };
  if (key === "atomcode") return { localEngine: "atomcode" };
  if (CUSTOM_TEMPLATES[key]) return { localEngine: "custom", customCliCommand: CUSTOM_TEMPLATES[key] };
  return null;
}

/** 默认探测件：where/which + 子进程 --version（超时全带）；TCP 一次性探测 */
function defaultRunProbe(file, args, timeoutMs, platform) {
  const { execFile } = require("child_process");
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: String(error && error.message || error) });
    }
  });
}

function defaultTcpProbe(port) {
  const net = require("net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; try { socket.destroy(); } catch {} resolve(value); } };
    socket.setTimeout(1200);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    try { socket.connect(Number(port), "127.0.0.1"); } catch { done(false); }
  });
}

/** CLI 在 PATH 上的解析（Windows 用 where，其余用 which）→ { ok, path } */
async function resolveOnPath(deps, cli) {
  const runProbe = deps.runProbe || defaultRunProbe; // 解构不回写 deps——这里必须自兜底
  const platform = deps.platform || process.platform;
  const probe = await runProbe(platform === "win32" ? "where" : "which", [cli], 2500, platform);
  if (!probe.ok) return { ok: false, path: "" };
  const path = String(probe.stdout || "").split(/\r?\n/)[0].trim();
  return { ok: Boolean(path), path };
}

/** --version 抓首行（失败=版本未知，不影响在册判定） */
async function probeVersion(deps, cli, path) {
  const runProbe = deps.runProbe || defaultRunProbe;
  const probe = await runProbe(path || cli, ["--version"], 3000, deps.platform || process.platform);
  const line = String(probe.stdout || "").split(/\r?\n/).find((item) => item.trim()) || "";
  return line.trim().slice(0, 60);
}

/**
 * 一键检测本机 Agent（四类）。deps 注入面：
 *   runProbe(file,args,timeoutMs,platform) → {ok,stdout,stderr}
 *   tcpProbe(port) → boolean（daemon 在跑 = 端口可连）
 *   home → 用户目录；readDir(path) → [文件名]；readFile(path) → 文本；platform
 */
async function detectLocalAgents(deps = {}) {
  // 解构只收左值、零默认值——默认值里挂 require/process 会造扫描误报（test-v3-21-2 scanTdz 的
  // collectIds 把 AssignmentPattern 右值 Identifier 一并收作绑定 → 左值配成假 TDZ 命中）。
  // 兜底全部语句级：声明先于使用，零 TDZ 形态。
  const { tcpProbe, home, readDir, readFile, platform } = Object.assign({}, deps);
  const tcpProbeF = tcpProbe || defaultTcpProbe;
  const homeDir = typeof home === "string" && home ? home : require("os").homedir();
  const readDirF = readDir || ((p) => require("fs").readdirSync(p));
  const readFileF = readFile || ((p) => require("fs").readFileSync(p, "utf8"));
  const platformF = platform || process.platform;
  const agents = [];

  // ① claude（本机 Claude Code）
  {
    const found = await resolveOnPath(deps, "claude");
    if (found.ok) agents.push({
      key: "claude", engine: "claude", name: "Claude Code", status: "ready",
      version: await probeVersion(deps, "claude", found.path),
      detail: found.path ? `路径：${found.path}；内置 direct-cli 链，登录已配好即可对话` : "PATH 命中；内置 direct-cli 链",
      apply: applyOf("claude")
    });
  }

  // ② atomcode（CLI 本体 + daemon 自发现：~/.atomcode/daemon-<端口>.json）
  {
    const found = await resolveOnPath(deps, "atomcode");
    const cliInstalled = found.ok;
    let daemonRunning = null; // { port, hasToken }
    try {
      const names = readDirF(require("path").join(homeDir, ".atomcode")).filter((name) => parseDaemonPort(name) > 0);
      const probed = [];
      for (const name of names) {
        const port = parseDaemonPort(name);
        let hasToken = false;
        try { hasToken = parseDaemonToken(readFileF(require("path").join(homeDir, ".atomcode", name))); } catch { /* 读不了=无 token */ }
        if (await tcpProbeF(port)) probed.push({ port, hasToken });
      }
      probed.sort((a, b) => a.port - b.port);
      daemonRunning = probed[0] || null;
    } catch { /* 无 ~/.atomcode 目录=零 daemon 配置 */ }
    const daemons = [];
    if (daemonRunning) daemons.push(daemonRunning);
    if (daemonRunning) {
      agents.push({
        key: "atomcode", engine: "atomcode", name: "AtomCode", status: "ready",
        version: cliInstalled ? await probeVersion(deps, "atomcode", found.path) : "（daemon 运行中，CLI 版本未知）",
        detail: `daemon 已在跑：127.0.0.1:${daemonRunning.port}${daemonRunning.hasToken ? "；token 已自动发现（daemon-端口.json）" : ""}——选它即自动填好，无需手填`,
        apply: { localEngine: "atomcode", atomcodeHost: "127.0.0.1", atomcodePort: daemonRunning.port }
      });
    } else if (cliInstalled) {
      agents.push({
        key: "atomcode", engine: "atomcode", name: "AtomCode", status: "partial", version: await probeVersion(deps, "atomcode", found.path),
        detail: "CLI 已安装，但 daemon 未运行（~/.atomcode/ 下无在跑端口的 daemon-端口.json）——启动 atomcode-daemon 后重新检测即可自动发现",
        apply: null
      });
    }
  }

  // ③ 常见自定义 CLI 六连探（命中→可接自定义命令：选它自动切 custom + 内置模板）
  for (const cli of Object.keys(CUSTOM_TEMPLATES)) {
    const found = await resolveOnPath(deps, cli);
    if (found.ok) agents.push({
      key: cli, engine: "custom", name: CUSTOM_LABELS[cli] || cli, status: "ready",
      version: await probeVersion(deps, cli, found.path),
      detail: `PATH 命中${found.path ? `：${found.path}` : ""}；选它自动填命令模板（可在输入框调整）`,
      apply: applyOf(cli)
    });
  }

  // ④ 本机 Claude 登录态不作深度校验（test-connection 已有），此处只报「在册」
  if (deps.onLog) {
    try { deps.onLog("local_agent_detect", { platform: platformF, installed: agents.filter((agent) => agent.status === "ready").length, total: agents.length }); } catch { /* 日志失败不碍事 */ }
  }
  return { agents, platform: platformF };
}

module.exports = { detectLocalAgents, parseDaemonPort, parseDaemonToken, applyOf, resolveOnPath, probeVersion, CUSTOM_TEMPLATES, CUSTOM_LABELS, defaultRunProbe, defaultTcpProbe };
