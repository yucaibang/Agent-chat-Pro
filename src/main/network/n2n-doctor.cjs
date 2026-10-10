"use strict";

/**
 * N2N 体检 + 一键部署（v3.23.0）
 *
 * 背景：v3.22.0 之前外网 N2N 方式的环境搭建依赖共享盘手动下载工具包跑
 *   n2n-setup.ps1；连接报错只有「未找到 n2n edge 命令，请先安装 n2n。」一句，
 *   用户无从下手。另 2026-10-07 实锤 NAS 侧根因可复用：n2n-supernode 容器
 *   Exited(137) 挂 6 天（docker restart 策略未拉起），这类侧故障用户也该能
 *   自己查到方向。本模块把「检测哪坏、缺哪补哪、stderr 上屏」搬进应用内：
 *
 * 体检五项（只读，无任何安装动作）：
 *   1 platform  —— 目标平台（仅 Windows 支持 N2N 一键部署）
 *   2 edge      —— edge.exe 三态：PATH 可见 / 仅落盘（PATH 不可见） / 未安装
 *   3 tap       —— TAP 虚拟网卡适配器（edge 开虚拟网卡的前提）
 *   4 admin     —— 管理员权限（决定 TAP 驱动走静默还是 UAC 提权）
 *   5 supernode —— 公网入口 TCP 连通（FRP 隧道层；应用层由实际连接验证）
 *
 * 一键部署六步（缺哪补哪，逐行日志上屏）：
 *   资源定位 → 解压 edge → TAP 驱动（管理员静默 / 非管理员 UAC 提权）→
 *   写用户 PATH → edge 自检 → 汇总与公网入口复测。
 *   部署完无需重启 ACP（n2n-mesh v3.23.0 起内置 C:\n2n\edge.exe 绝对路径兜底）。
 *
 * 平台降级：非 Windows 平台体检只剩 platform 一项（其余标记 skip），
 *   部署直接拒绝。全部检测动作在调用方（设置页按钮）主动触发。
 */

const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");

// ── 常量（与共享盘 n2n-工具包/n2n-setup.ps1 保持一致）──

/** edge.exe 一键部署落盘目录（Windows 约定路径，工具包/脚本/兜底三处同口径） */
const EDGE_FALLBACK_DIR = "C:\\n2n";
const EDGE_EXE_PATH = path.join(EDGE_FALLBACK_DIR, "edge.exe");

/** 默认公网入口（用户未配置时体检用） */
const DEFAULT_SUPERNODE = { addr: "entry.example.org", port: 53371 };

/** 内嵌工具包文件名（安装包 extraResources / 项目 build/n2n 各一份） */
const N2N_ZIP_NAME = "n2n_v3_windows_x64_v3.1.1_r1255_static_by_heiye.zip";
const TAP_EXE_NAME = "tap-windows-9.21.2.exe";

/** 体检结果等级 → 展示文案（渲染层直接消费 level） */
const LEVEL_MARK = { ok: "✓", warn: "△", fail: "✗", skip: "—" };

// ── 基础工具 ──────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 单次 PowerShell 命令（windowsHide + 超时保护；resolve 永不 reject） */
function runPowerShell(command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer = null;    // 前置 let：finish 里清除（规避后置引用 TDZ 形态）
    let child = null;    // 前置 let：timer 回调经此杀超时进程
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      resolve({ ok: !patch?.timedOut && patch?.code === 0, code: patch?.code ?? -1, stdout, stderr, timedOut: Boolean(patch?.timedOut) });
    };
    timer = setTimeout(() => {
      if (child) { try { child.kill("SIGKILL"); } catch { /* 忽略 */ } }
      finish({ timedOut: true, code: -1 });
    }, timeoutMs);

    try {
      child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      finish({ timedOut: false, code: -1 });
      return;
    }
    child.stdout.on("data", (data) => { stdout += data.toString("utf8"); });
    child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
    child.once("error", () => finish({ timedOut: false, code: -1 }));
    child.once("close", (code) => finish({ timedOut: false, code: code ?? -1 }));
  });
}

/** TCP 连通探测（连接成功/失败/超时三种终态，永不 reject） */
function probeTcp(addr, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!addr || !port) { resolve(false); return; }
    let settled = false;
    let socket = null;   // 前置 let：finish 里销毁（规避后置引用 TDZ 形态）
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (socket) { try { socket.destroy(); } catch { /* 忽略 */ } }
      resolve(ok);
    };
    socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(Number(port), String(addr));
    } catch {
      finish(false);
    }
  });
}

// ── 批量检测（一次 PowerShell 会话拿 TAP / PATH / admin 三项，省冷启动）──

/** 体检主机快照：admin 布尔、TAP 适配器描述（空=无）、PATH 方式 edge 解析结果（空=不可见） */
async function detectHostSnapshot() {
  const command = [
    "$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    "Write-Output ('===A===' )",
    "Write-Output $admin",
    "$tap = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'TAP' } | Select-Object -First 1 -ExpandProperty InterfaceDescription",
    "Write-Output '===T==='",
    "Write-Output ($tap ?? '')",
    "$edgeCmd = (Get-Command edge -ErrorAction SilentlyContinue).Source",
    "Write-Output '===P==='",
    "Write-Output ($edgeCmd ?? '')"
  ].join("; ");
  const result = await runPowerShell(command, 9000);
  // Get-NetAdapter 不存在等异常 → 降级 ipconfig 文本比对（Win8+ 一般都有，此路兜底）
  if (result.ok && result.stdout.includes("===T===")) {
    return { ...parseSnapshot(result.stdout), degraded: false };
  }
  const legacy = await detectTapFromIpconfig();
  return { admin: null, tapDesc: legacy.tapDesc, edgeCmdPath: "", degraded: true, legacyTapHit: legacy.hit };
}

function parseSnapshot(stdout) {
  const split = (tag) => {
    const start = stdout.indexOf(tag);
    if (start === -1) return "";
    const from = stdout.indexOf("\n", start);
    if (from === -1) return "";
    const tags = ["===A===", "===T===", "===P==="].filter((t) => t !== tag).map((t) => stdout.indexOf(t, from));
    const nextTag = tags.filter((i) => i !== -1).sort((a, b) => a - b)[0];
    return stdout.substring(from + 1, nextTag === undefined ? undefined : nextTag).trim();
  };
  return {
    admin: split("===A===").toUpperCase() === "TRUE",
    tapDesc: split("===T==="),
    edgeCmdPath: split("===P===")
  };
}

/** 降级 TAP 检测：ipconfig /all 文本比对（无 PowerShell cmdlet 可用时） */
async function detectTapFromIpconfig() {
  const result = await runPowerShell("(ipconfig /all) -join [char]10", 9000);
  const hit = /tap/i.test(result.stdout || "");
  return { hit, tapDesc: hit ? "TAP 适配器（ipconfig 降级检测命中）" : "" };
}

/** fs 视角的 edge 落盘态 */
function edgeStatusFromFs() {
  return { installed: fs.existsSync(EDGE_EXE_PATH), path: EDGE_EXE_PATH };
}

// ── 资源定位 ──────────────────────────────────────────

/** 内嵌 n2n 工具包目录：打包态 process.resourcesPath/n2n，开发态项目 build/n2n */
function resolveResourcesDir() {
  let packaged = false;
  try { packaged = Boolean(require("electron").app?.isPackaged); } catch { /* 纯 Node 环境 */ }
  if (packaged) {
    const dir = path.join(process.resourcesPath || "", "n2n");
    if (!fs.existsSync(path.join(dir, N2N_ZIP_NAME)) || !fs.existsSync(path.join(dir, TAP_EXE_NAME))) {
      throw new Error("安装包缺少 n2n 内嵌资源，请重新下载完整安装包。");
    }
    return dir;
  }
  const dir = path.join(__dirname, "..", "..", "build", "n2n");
  if (!fs.existsSync(path.join(dir, N2N_ZIP_NAME)) || !fs.existsSync(path.join(dir, TAP_EXE_NAME))) {
    throw new Error("开发态缺少 build/n2n 工具包（请从共享盘 n2n-工具包 同步 zip 与 TAP 驱动）。");
  }
  return dir;
}

function bytesToLabel(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

// ── 体检 ──────────────────────────────────────────────

/**
 * 运行 N2N 体检（只读）。
 * @param {object} payload { n2n: { supernodeAddr, supernodePort } }（空走默认入口）
 * @param {function} onItem 每项完成回调（渲染层逐项上屏）
 * @returns {Promise<{items: object[], ok: boolean, nextAction: string}>}
 */
async function runN2nDoctor(payload = {}, onItem = () => {}) {
  const items = [];
  const push = (item) => { items.push(item); onItem(item); };

  // 1 平台
  const platformLabel = process.platform === "win32" ? "Windows" : process.platform;
  const platformOk = process.platform === "win32";
  push({
    id: "platform",
    title: "操作系统平台",
    level: platformOk ? "ok" : "fail",
    detail: platformOk ? "Windows 平台，支持 N2N 与一键部署" : `当前平台 ${platformLabel}`,
    hint: platformOk ? "" : "N2N 一键部署仅支持 Windows。Linux/macOS 请参考 n2n 官方文档安装 edge。"
  });

  if (platformOk) {
    // 2 edge（fs 落盘态 + PATH 解析态）
    const edge = edgeStatusFromFs();
    const snapshot = await detectHostSnapshot();
    const pathVisible = snapshot.edgeCmdPath && /edge/i.test(snapshot.edgeCmdPath);
    if (edge.installed && pathVisible) {
      push({
        id: "edge",
        title: "edge 二进制",
        level: "ok",
        detail: `已安装且 PATH 可见（${snapshot.edgeCmdPath}）`,
        hint: ""
      });
    } else if (edge.installed) {
      push({
        id: "edge",
        title: "edge 二进制",
        level: "ok",
        detail: `已安装（${EDGE_EXE_PATH}）；PATH 方式暂不可见`,
        hint: "Agent Chat Pro 会自动改用绝对路径连接，无需重启即可使用。"
      });
    } else if (pathVisible) {
      push({
        id: "edge",
        title: "edge 二进制",
        level: "ok",
        detail: `PATH 方式可见（${snapshot.edgeCmdPath}）`,
        hint: ""
      });
    } else {
      push({
        id: "edge",
        title: "edge 二进制",
        level: "fail",
        detail: "未检测到 n2n edge（既不在 C:\\n2n，PATH 也找不到）",
        hint: "点击「一键部署」自动安装（解压 edge + 装 TAP 驱动 + 配 PATH）。"
      });
    }

    // 3 TAP（快照里已有；降级检测命中也通过）
    const tapDesc = snapshot.tapDesc;
    push({
      id: "tap",
      title: "TAP 虚拟网卡",
      level: tapDesc ? "ok" : "fail",
      detail: tapDesc ? `已就位（${tapDesc}）` : "未检测到 TAP 虚拟网卡",
      hint: tapDesc ? "" : "edge 启动虚拟网卡需要 TAP 驱动。点击「一键部署」自动安装（约 10 秒）。"
    });

    // 4 管理员权限（提示级，不阻断）
    const isAdmin = snapshot.admin === true;
    push({
      id: "admin",
      title: "管理员权限",
      level: isAdmin ? "ok" : "warn",
      detail: isAdmin ? "当前以管理员运行" : "当前未以管理员运行",
      hint: isAdmin ? "" : "影响：装 TAP 驱动会弹 UAC 授权窗。连接 N2N 建议也以管理员启动应用（edge 开虚拟网卡需要权限），否则连接可能超时。"
    });

    // 5 公网入口 TCP 连通（FRP 隧道层）
    const input = payload?.n2n || {};
    const addr = String(input.supernodeAddr || "").trim() || DEFAULT_SUPERNODE.addr;
    const port = Number(input.supernodePort) || DEFAULT_SUPERNODE.port;
    const reachable = await probeTcp(addr, port, 5000);
    push({
      id: "supernode",
      title: "公网入口连通（隧道层）",
      level: reachable ? "ok" : "fail",
      detail: reachable
        ? `${addr}:${port} TCP 可达（FRP 隧道在线）`
        : `5 秒内连不上 ${addr}:${port}`,
      hint: reachable
        ? "TCP 可达只代表隧道层在线，N2N 应用层连通由实际连接验证。"
        : "三种可能：① NAS 侧 n2n-supernode 或 FRPC 容器挂了（可让 Claude 连 SSH 帮查 docker ps）；② FRP 公网服务波动；③ 当前网络限制该端口（可换手机热点再试）。"
    });
  } else {
    for (const id of ["edge", "tap", "admin", "supernode"]) {
      push({ id, title: id, level: "skip", detail: "非 Windows 平台，跳过", hint: "" });
    }
  }

  const blocking = items.filter((item) => item.level === "fail");
  const hintById = Object.fromEntries(items.map((item) => [item.id, item]));
  const nextAction = blocking.length
    ? (hintById.platform?.level === "fail" ? hintById.platform.hint : `下一步：${blocking[0].hint || ""}`)
    : "环境就绪，可直接连接。";

  return { items, ok: blocking.length === 0, nextAction };
}

// ── 一键部署 ──────────────────────────────────────────

/** 用 UAC 提权静默安装 TAP 驱动（Start-Process -Verb RunAs；Minimized 而非 Hidden——
 *  Hidden 与 RunAs 在部分 Windows 版本冲突导致 ExitCode 异常，沿用 device-control 结论） */
function elevateInstallTap(tapPath) {
  return new Promise((resolve) => {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const command = [
      "$process = Start-Process -FilePath " + quote(tapPath),
      "-ArgumentList @('/S')",
      "-Verb RunAs -WindowStyle Minimized -Wait -PassThru; exit $process.ExitCode"
    ].join(" ");
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
    child.once("error", (error) => resolve({ ok: false, code: -1, stderr: error.message, canceled: false }));
    child.once("close", (code) => {
      const unsigned = typeof code === "number" ? code >>> 0 : -1;
      resolve({
        ok: code === 0,
        code: code ?? -1,
        canceled: code === 1223 || /canceled by the user/i.test(stderr),
        uacFailure: unsigned === 0xFFFD0000 || (unsigned >= 0x80000000 && unsigned <= 0x800FFFFF) || unsigned >= 0xFFF00000,
        stderr: stderr.trim()
      });
    });
  });
}

/** 管理员进程内静默安装 TAP（免 UAC） */
function silentInstallTap(tapPath) {
  return new Promise((resolve) => {
    const child = spawn(tapPath, ["/S", "/norestart"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
    child.once("error", (error) => resolve({ ok: false, code: -1, stderr: error.message }));
    child.once("close", (code) => resolve({ ok: code === 0, code: code ?? -1, stderr: stderr.trim() }));
  });
}

/** 用户 PATH 写入（HKCU，普通权限即可；幂等，已含则报 exists） */
async function ensureUserPath() {
  const result = await runPowerShell(
    "$p = [Environment]::GetEnvironmentVariable('Path','User'); " +
    "if ($p -and $p.Contains('C:\\n2n')) { Write-Output 'exists' } " +
    "else { $base = if ($p) { $p.TrimEnd(';') } else { '' }; " +
    "[Environment]::SetEnvironmentVariable('Path', ($base + ';C:\\n2n'), 'User'); Write-Output 'written' }",
    8000
  );
  const outcome = (result.stdout || "").trim();
  if (outcome === "exists") return { written: false, existed: true, ok: true };
  if (outcome === "written") return { written: true, existed: false, ok: true };
  return { written: false, existed: false, ok: false, error: result.stderr || result.stdout || "无输出" };
}

/**
 * 运行 N2N 一键部署（edge+TAP+PATH 缺哪补哪）。
 * @param {function} onLog 逐行日志回调（渲染层步进上屏）
 * @returns {Promise<{ok: boolean, steps: object[], summary: string[]}>}
 */
async function runN2nDeploy(payload = {}, onLog = () => {}) {
  const log = (line) => onLog?.(line);
  if (process.platform !== "win32") throw new Error("一键部署仅支持 Windows。");

  const steps = [];
  const record = (step) => { steps.push(step); return step; };

  log("── N2N 一键部署开始 ──");

  // 步骤 1/6 平台与内嵌工具包定位
  log("▶ 步骤 1/6：检查内嵌工具包…");
  let resDir;
  try {
    resDir = resolveResourcesDir();
  } catch (error) {
    record({ id: "resources", ok: false, detail: error.message });
    log(`✗ ${error.message}`);
    return { ok: false, steps, summary: [error.message] };
  }
  const zipPath = path.join(resDir, N2N_ZIP_NAME);
  const tapPath = path.join(resDir, TAP_EXE_NAME);
  const zipLabel = bytesToLabel(fs.statSync(zipPath).size);
  const tapLabel = bytesToLabel(fs.statSync(tapPath).size);
  log(`✓ 工具包就位（edge 压缩包 ${zipLabel} + TAP 驱动 ${tapLabel}）`);
  record({ id: "resources", ok: true, detail: `zip ${zipLabel} / tap ${tapLabel}` });

  // 步骤 2/6 解压 edge（幂等：已有则跳过）
  log("▶ 步骤 2/6：解压 edge 到 C:\\n2n …");
  if (fs.existsSync(EDGE_EXE_PATH)) {
    log("✓ C:\\n2n\\edge.exe 已存在，跳过解压");
    record({ id: "unzip", ok: true, detail: "已存在，跳过" });
  } else {
    const unzip = await runPowerShell(`Expand-Archive -Path ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(EDGE_FALLBACK_DIR)} -Force`, 60_000);
    if (!unzip.ok || !fs.existsSync(EDGE_EXE_PATH)) {
      const detail = unzip.stderr || unzip.error || "解压后未见 edge.exe";
      record({ id: "unzip", ok: false, detail });
      log(`✗ 解压失败：${detail}`);
      log("  可重试，或手动把工具包 zip 解压到 C:\\n2n 后重新体检。");
      return { ok: false, steps, summary: ["解压 edge 失败：" + detail] };
    }
    log(`✓ 已解压（耗时约 ${"2 秒"}）；C:\\n2n\\edge.exe 就位`);
    record({ id: "unzip", ok: true, detail: EDGE_EXE_PATH });
  }

  // 步骤 3/6 TAP 驱动
  log("▶ 步骤 3/6：检查 TAP 虚拟网卡驱动…");
  let tapDesc = (await detectHostSnapshot()).tapDesc;
  if (tapDesc) {
    log(`✓ TAP 驱动已安装：${tapDesc}`);
    record({ id: "tap", ok: true, installed: false, detail: tapDesc });
  } else {
    log("✗ 未检测到 TAP 适配器，开始安装驱动…");
    const adminSnapshot = await detectHostSnapshot();
    let install;
    if (adminSnapshot.admin === true) {
      log("  当前以管理员运行，直接静默安装（约 10 秒）…");
      install = await silentInstallTap(tapPath);
    } else {
      log("  将弹出 Windows 管理员授权（UAC）窗口，请选择「是」…");
      install = await elevateInstallTap(tapPath);
      if (install.canceled) {
        log("✗ 已取消管理员授权。驱动未安装——可重新点部署，或手动双击 TAP 驱动安装。");
        record({ id: "tap", ok: false, installed: false, canceled: true, detail: "UAC 取消" });
        return { ok: false, steps, summary: ["TAP 驱动未安装（UAC 被取消）"] };
      }
    }
    await sleep(3000); // 驱动设备树刷新缓冲（沿用 n2n-setup.ps1 的 3 秒）
    tapDesc = (await detectHostSnapshot()).tapDesc;
    if (tapDesc) {
      log(`✓ TAP 驱动安装成功：${tapDesc}`);
      record({ id: "tap", ok: true, installed: true, detail: tapDesc });
    } else {
      log(`✗ 驱动安装后仍检测不到 TAP 适配器${install.stderr ? `（${install.stderr}）` : ""}`);
      log("  请手动双击 TAP 驱动安装程序（如弹驱动签名确认请点「仍要安装」），装完重新体检。");
      record({ id: "tap", ok: false, installed: false, detail: install.stderr || "安装后未检出" });
      return { ok: false, steps, summary: ["TAP 驱动未能自动安装，请按日志手动安装"] };
    }
  }

  // 步骤 4/6 用户 PATH
  log("▶ 步骤 4/6：配置用户 PATH…");
  const pathResult = await ensureUserPath();
  if (pathResult.ok) {
    const say = pathResult.existed ? "已包含 C:\\n2n（无需改动）" : "已写入（永久生效）";
    log(`✓ ${say}`);
    record({ id: "path", ok: true, written: pathResult.written, existed: pathResult.existed, detail: say });
  } else {
    log(`✗ PATH 写入失败：${pathResult.error}（不影响本次使用——应用内已内置绝对路径兜底）`);
    record({ id: "path", ok: false, detail: pathResult.error });
  }

  // 步骤 5/6 edge 自检
  log("▶ 步骤 5/6：运行 edge 自检（C:\\n2n\\edge.exe -h）…");
  const edgeCheck = await runPowerShell(`& 'C:\\n2n\\edge.exe' -h 2>&1 | Out-String`, 10_000);
  const edgeOk = edgeCheck.stdout && edgeCheck.stdout.trim().length > 0;
  if (edgeOk) {
    const firstLine = edgeCheck.stdout.trim().split("\n")[0].slice(0, 120);
    log(`✓ edge 可执行（输出首行：${firstLine}）`);
    record({ id: "edge-check", ok: true, detail: firstLine });
  } else {
    const detail = edgeCheck.stderr || edgeCheck.stdout || "无输出";
    log(`✗ edge 自检未通过：${detail.slice(0, 200)}`);
    record({ id: "edge-check", ok: false, detail });
  }

  // 步骤 6/6 汇总 + 公网入口复测
  log("▶ 步骤 6/6：检测公网入口…");
  const input = payload?.n2n || {};
  const addr = String(input.supernodeAddr || "").trim() || DEFAULT_SUPERNODE.addr;
  const port = Number(input.supernodePort) || DEFAULT_SUPERNODE.port;
  const reachable = await probeTcp(addr, port, 5000);
  log(reachable ? `✓ 公网入口 ${addr}:${port} 可达（隧道层在线）` : `✗ 公网入口 ${addr}:${port} 暂不可达——本机环境已就绪，请另查 NAS 侧 supernode 容器或换网络再试`);
  record({ id: "supernode", ok: reachable, detail: `${addr}:${port}` });

  const hardFailure = steps.find((step) => step.id === "resources" && !step.ok);
  const ok = !hardFailure && edgeOk && log.length >= 0;
  const summary = [
    `C:\\n2n\\edge.exe：${edgeOk ? "就绪" : "异常"}；TAP：${tapDesc || "未检出"}；PATH：${pathResult.existed ? "已含" : pathResult.written ? "已写入" : "未写入（不影响）"}`,
    `无需重启应用即可连接（内置 C:\\n2n 绝对路径兜底）。如公网入口不通，让 Claude 连 SSH 查 NAS 的 n2n-supernode 容器。`
  ];
  log("── N2N 一键部署结束 ──");
  return { ok, steps, summary, supernodeReachable: reachable };
}

module.exports = {
  runN2nDoctor,
  runN2nDeploy,
  // 以下内部工具导出仅供测试与后续复用
  probeTcp,
  runPowerShell,
  detectHostSnapshot,
  edgeStatusFromFs,
  resolveResourcesDir,
  ensureUserPath,
  EDGE_EXE_PATH,
  EDGE_FALLBACK_DIR,
  DEFAULT_SUPERNODE,
  N2N_ZIP_NAME,
  TAP_EXE_NAME,
  LEVEL_MARK
};