"use strict";
/**
 * v3.16.2 测试 — 双联动控件共存隔离（ACP ↔ Agent Orbit / Claude NAS 系）
 * 背景：client-pc 双装联动控件后结构冲突——ACP 块嵌进对方块内部、卸载互删，
 *   一键修复后问题反复。本轮：隔离不互删（对方在用零触碰）+ 安全插入位（平级化）
 *   + 三触发面扫描（安装/更新/使用）+ Windows 原生 MessageBox 选择弹窗。
 * 覆盖：coexistence-scanner.cjs 真单测（区间解析/冲突判定/mock Windows 文件树）；
 *       device-control.ps1 隔离改造断言（legacy 清理条件化/安全插入/弹窗/result 回传/BOM）；
 *       main.cjs 接线（启动扫描/安装卸载确认带共存提示）；渲染层接线；版本号 3.16.2。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");

const ROOT = __dirname;
const SCANNER_PATH = path.join(ROOT, "src", "main", "coexistence-scanner.cjs");
const DC_PATH = path.join(ROOT, "src", "main", "device-control.cjs");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
const PRELOAD_PATH = path.join(ROOT, "src", "main", "preload.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const INDEX_PATH = path.join(ROOT, "src", "renderer", "index.html");
const STYLES_PATH = path.join(ROOT, "src", "renderer", "styles.css");
const PS1_PATH = path.join(ROOT, "src", "device-control", "device-control.ps1");
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

const scannerSrc = fs.readFileSync(SCANNER_PATH, "utf8");
const dcSrc = fs.readFileSync(DC_PATH, "utf8");
const mainSrc = fs.readFileSync(MAIN_PATH, "utf8");
const preloadSrc = fs.readFileSync(PRELOAD_PATH, "utf8");
const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");
const stylesSrc = fs.readFileSync(STYLES_PATH, "utf8");
const ps1Buf = fs.readFileSync(PS1_PATH);
const ps1Src = ps1Buf.toString("utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

// client-pc 实测嵌套结构样本（2026-10-03 只读诊断实录，做回归基准）
const NESTED_CONFIG_SAMPLE = [
  "# BEGIN CLAUDE NAS AGENT LISTENER",
  "# Managed listener; the ClaudeNAS-Agent-Control firewall rule restricts TCP 22 to the configured manager.",
  "ListenAddress 0.0.0.0",
  "# END CLAUDE NAS AGENT LISTENER",
  "# BEGIN CLAUDE NAS AGENT CONTROL",
  "# BEGIN AGENT CHAT PRO CONTROL",
  "Match User agentchatprocontrol",
  "    PasswordAuthentication no",
  "    AuthorizedKeysFile C:/ProgramData/AgentChatProAgent/authorized_keys",
  "# END AGENT CHAT PRO CONTROL",
  "Match User claudeagentcontrol",
  "    PasswordAuthentication no",
  "    AuthorizedKeysFile C:/ProgramData/ClaudeNasAgent/authorized_keys",
  "# END CLAUDE NAS AGENT CONTROL",
  "Match Group administrators",
  "       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys"
].join("\r\n");

// 平级干净共存样本（目标态）
const FLAT_COEXIST_SAMPLE = [
  "# BEGIN CLAUDE NAS AGENT CONTROL",
  "Match User claudeagentcontrol",
  "    PasswordAuthentication no",
  "    AuthorizedKeysFile C:/ProgramData/ClaudeNasAgent/authorized_keys",
  "# END CLAUDE NAS AGENT CONTROL",
  "# BEGIN AGENT CHAT PRO CONTROL",
  "Match User agentchatprocontrol",
  "    PasswordAuthentication no",
  "    AuthorizedKeysFile C:/ProgramData/AgentChatProAgent/authorized_keys",
  "# END AGENT CHAT PRO CONTROL",
  "Match Group administrators",
  "       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys"
].join("\r\n");

// ── 1. scanner：区间解析 ───────────────────────────────────────────────
async function runParserTests() {
  const scanner = require(SCANNER_PATH);

  await test("parseMarkerRegions：嵌套样本解析出 3 区间（LISTENER/CLAUDE CONTROL/ACP CONTROL）", () => {
    const regions = scanner.parseMarkerRegions(NESTED_CONFIG_SAMPLE);
    assert.strictEqual(regions.filter((r) => !r.unclosed).length, 3, `实际区间数：${JSON.stringify(regions)}`);
  });

  await test("parseMarkerRegions：三区间家族名正确且不互相吞没", () => {
    const regions = scanner.parseMarkerRegions(NESTED_CONFIG_SAMPLE);
    const names = regions.map((r) => r.markerFamily).sort();
    assert.deepStrictEqual(names, [
      "AGENT CHAT PRO CONTROL",
      "CLAUDE NAS AGENT CONTROL",
      "CLAUDE NAS AGENT LISTENER"
    ], `实际：${JSON.stringify(names)}`);
  });

  await test("findCoexistenceConflicts：client-pc 实录嵌套结构 → 判定 nested", () => {
    const conflicts = scanner.findCoexistenceConflicts(NESTED_CONFIG_SAMPLE);
    const nested = conflicts.find((c) => c.type === "nested");
    assert.ok(nested, `实际冲突：${JSON.stringify(conflicts)}`);
    assert.match(nested.message, /嵌进/);
    assert.match(nested.message, /连(带|贯)删|连带/);
  });

  await test("findCoexistenceConflicts：平级干净共存 → 零冲突", () => {
    const conflicts = scanner.findCoexistenceConflicts(FLAT_COEXIST_SAMPLE);
    assert.strictEqual(conflicts.length, 0, `平级结构不应报冲突：${JSON.stringify(conflicts)}`);
  });

  await test("findCoexistenceConflicts：同名 marker 重复写入 → 判定 duplicate", () => {
    const dup = FLAT_COEXIST_SAMPLE + "\r\n" + [
      "# BEGIN AGENT CHAT PRO CONTROL",
      "Match User agentchatprocontrol",
      "    AuthorizedKeysFile C:/ProgramData/AgentChatProAgent/authorized_keys",
      "# END AGENT CHAT PRO CONTROL"
    ].join("\r\n");
    const conflicts = scanner.findCoexistenceConflicts(dup);
    const duplicate = conflicts.find((c) => c.type === "duplicate");
    assert.ok(duplicate, `实际：${JSON.stringify(conflicts)}`);
  });

  await test("findCoexistenceConflicts：marker 未闭合 → 判定 unclosed", () => {
    const unclosed = "# BEGIN AGENT CHAT PRO CONTROL\r\nMatch User agentchatprocontrol\r\n    PasswordAuthentication no\r\n";
    const conflicts = scanner.findCoexistenceConflicts(unclosed);
    assert.ok(conflicts.find((c) => c.type === "unclosed"), `实际：${JSON.stringify(conflicts)}`);
  });

  await test("parseMarkerRegions：异族 END 不串配对（交错防错配）", () => {
    // 在 ACP 区间内部出现的 END AGENT CHAT PRO CONTROL 不能错误闭合外部 CLAUDE 区间
    const regions = scanner.parseMarkerRegions(NESTED_CONFIG_SAMPLE);
    const claude = regions.find((r) => r.markerFamily === "CLAUDE NAS AGENT CONTROL");
    const acp = regions.find((r) => r.markerFamily === "AGENT CHAT PRO CONTROL");
    assert.ok(claude.end > acp.end, `CLAUDE 区间(${claude.end})必须包到 ACP 区间(${acp.end})结束位置之后`);
  });
}

// ── 2. scanner：scanCoexistence（mock Windows 文件树） ────────────────
async function runScanCoexistenceTests() {
  const scanner = require(SCANNER_PATH);

  await test("scanCoexistence：非 Windows 平台 → supported:false 不扫", () => {
    const scan = scanner.scanCoexistence();
    assert.strictEqual(scan.supported, false);
    assert.strictEqual(scan.coexistence, false);
  });

  await test("scanCoexistence：mock win32 + 实录结构 → 识别双家族在用 + nested 冲突", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3162-"));
    fs.mkdirSync(path.join(workdir, "AgentChatProAgent"), { recursive: true });
    fs.mkdirSync(path.join(workdir, "ClaudeNasAgent"), { recursive: true });
    fs.mkdirSync(path.join(workdir, "ssh"), { recursive: true });
    fs.writeFileSync(path.join(workdir, "AgentChatProAgent", "install-state.json"), JSON.stringify({ installed: true, account: "AgentChatProControl", sourceAddress: "10.66.1.99", deviceId: "876948cb-x" }));
    fs.writeFileSync(path.join(workdir, "ClaudeNasAgent", "install-state.json"), JSON.stringify({ installed: true, account: "ClaudeAgentControl", sourceAddress: "10.66.1.99", deviceId: "deb8f470-x" }));
    fs.writeFileSync(path.join(workdir, "ssh", "sshd_config"), NESTED_CONFIG_SAMPLE);
    const originalPlatform = process.platform;
    const originalProgramData = process.env.ProgramData;
    const originalModulePath = require.cache[require.resolve(SCANNER_PATH)];
    delete require.cache[require.resolve(SCANNER_PATH)];
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.ProgramData = workdir;
    try {
      const winScanner = require(SCANNER_PATH);
      const scan = windowedScan(winScanner);
      assert.strictEqual(scan.supported, true);
      assert.strictEqual(scan.otherFamilyInUse, true, "另一套（Claude NAS 系）在用应被识别");
      assert.strictEqual(scan.legacyOrphan, false, "installed=true 不是遗留");
      assert.strictEqual(scan.coexistence, true);
      assert.ok(scan.conflicts.some((c) => c.type === "nested"), "实录嵌套结构应报 nested");
      assert.strictEqual(scan.families.length, 2);
      const acpFamily = scan.families.find((f) => f.id === "agent-chat-pro");
      assert.strictEqual(acpFamily.installed, true);
      assert.strictEqual(acpFamily.account, "AgentChatProControl");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", { value: originalPlatform });
      if (originalProgramData !== undefined) process.env.ProgramData = originalProgramData;
      else delete process.env.ProgramData;
      if (originalModulePath) require.cache[require.resolve(SCANNER_PATH)] = originalModulePath;
    }
    function windowedScan(mod) { return mod.scanCoexistence(); }
  });

  await test("scanCoexistence：sshd_config 读不到 → configReadable:false 降级不误报", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3162-noread-"));
    const originalPlatform = process.platform;
    const originalProgramData = process.env.ProgramData;
    delete require.cache[require.resolve(SCANNER_PATH)];
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.ProgramData = workdir; // 空树：目录不存在 + config 读不到
    try {
      const winScanner = require(SCANNER_PATH);
      const scan = winScanner.scanCoexistence();
      assert.strictEqual(scan.configReadable, false);
      assert.deepStrictEqual(scan.conflicts, [], "读不到配置时不得凭空报结构冲突");
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", { value: originalPlatform });
      if (originalProgramData !== undefined) process.env.ProgramData = originalProgramData;
      else delete process.env.ProgramData;
    }
  });

  await test("scanCoexistence：仅目录遗存（无 state）→ legacyOrphan 判定", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3162-orphan-"));
    fs.mkdirSync(path.join(workdir, "ClaudeNasAgent"), { recursive: true }); // 无 install-state.json
    const originalPlatform = process.platform;
    const originalProgramData = process.env.ProgramData;
    delete require.cache[require.resolve(SCANNER_PATH)];
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.ProgramData = workdir;
    try {
      const winScanner = require(SCANNER_PATH);
      const scan = winScanner.scanCoexistence();
      assert.strictEqual(scan.legacyOrphan, true);
      assert.strictEqual(scan.otherFamilyInUse, false);
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", { value: originalPlatform });
      if (originalProgramData !== undefined) process.env.ProgramData = originalProgramData;
      else delete process.env.ProgramData;
    }
  });
}

// ── 3. ps1 隔离改造断言 ───────────────────────────────────────────────
async function runPs1IsolationTests() {
  await test("ps1：UTF-8 BOM 在位（防 PS5.1 无 BOM 读中文乱码回归）", () => {
    assert.strictEqual(ps1Buf[0], 0xef, "首字节应为 BOM EF");
    assert.strictEqual(ps1Buf[1], 0xbb);
    assert.strictEqual(ps1Buf[2], 0xbf);
  });

  await test("ps1：家族识别表含两套控件资源（与 scanner FAMILIES 同源）", () => {
    assert.match(ps1Src, /"agent-chat-pro"[^}]*folder\s*=\s*"AgentChatProAgent"/);
    assert.match(ps1Src, /"claude-nas-line"[^}]*folder\s*=\s*"ClaudeNasAgent"/);
    assert.match(ps1Src, /markerFamily\s*=\s*"AGENT CHAT PRO CONTROL"/);
    assert.match(ps1Src, /markerFamily\s*=\s*"CLAUDE NAS AGENT CONTROL"/);
    assert.match(ps1Src, /listenerMarkerFamily\s*=\s*"CLAUDE NAS AGENT LISTENER"/);
  });

  await test("ps1：legacy 防火墙规则删除必须条件化（cleanLegacy 才清）", () => {
    // 不再有无条件 Remove-NetFirewallRule -Name $legacyFirewallRule
    assert.doesNotMatch(ps1Src, /^ {2,4}Remove-NetFirewallRule -Name \$legacyFirewallRule\s*$/m, "legacy 防火墙规则删除脱离了 cleanLegacy 条件");
    assert.match(ps1Src, /if \(\$cleanLegacy\) \{ Remove-NetFirewallRule -Name \$legacyFirewallRule/);
  });

  await test("ps1：legacy 目录清理必须条件化（cleanLegacy -and Test-Path）", () => {
    assert.match(ps1Src, /if \(\$cleanLegacy -and \(Test-Path \$legacyAgentRoot\)\)/);
  });

  await test("ps1：legacy 账号清理必须进 cleanLegacy 分支", () => {
    const m = ps1Src.match(/if \(\$cleanLegacy\) \{[\s\S]*?\$legacyUser[\s\S]*?Remove-LocalUser -Name \$legacyAccountName/);
    assert.ok(m, "legacy 账号删除应在 cleanLegacy 分支内");
  });

  await test("ps1：Test-ClaudeNasControlInUse / Test-LegacyOrphan 在用判定存在", () => {
    assert.match(ps1Src, /function Test-ClaudeNasControlInUse/);
    assert.match(ps1Src, /function Test-LegacyOrphan/);
    assert.match(ps1Src, /return \[bool\]\(\$legacyState -and \$legacyState\.installed\)/, "在用判定读对方 install-state.json 的 installed 字段");
    assert.match(ps1Src, /return -not \[bool\]\(\$legacyState -and \$legacyState\.installed\)/, "遗留判定 = 资源在机但无人认领");
  });

  await test("ps1：卸载扫描钩子（Scan 阶段进 Uninstall-Control + 在场即弹窗）", () => {
    assert.match(ps1Src, /\$legacyStatePath = Join-Path \$legacyAgentRoot "install-state\.json"[\s\S]{0,600}\$script:stage = "scan-coexistence"/, "Uninstall 入口应有共存扫描阶段");
    assert.match(ps1Src, /Show-ConflictWindow \$script:coexistenceReport "Uninstall" \$legacyOrphan/, "卸载时在场即弹窗");
    assert.match(ps1Src, /\$cleanLegacy = \(\$script:coexistenceChoice -eq "clean-legacy-orphan"\)/);
  });

  await test("ps1：卸载在用 → cancelled 即中止不动任何东西", () => {
    assert.match(ps1Src, /User cancelled the device-control uninstall after the coexistence scan\. Nothing was changed\./);
  });

  await test("ps1：卸载前先摊平（Repair-NestedAgents 防连坐）再删自家区间", () => {
    const m = ps1Src.match(/# 先摊平嵌套[\s\S]{0,300}\$content = Repair-NestedAgents[\s\S]{0,200}Remove-AgentBlock/);
    assert.ok(m, "卸载流程应先摊平嵌套再 Remove 自家区块");
  });

  await test("ps1：安装扫描钩子（Install 入口 scan-coexistence + 弹窗 + cancelled 中止）", () => {
    assert.match(ps1Src, /\$script:stage = "scan-coexistence"[\s\S]{0,300}Find-AgentConflicts \$configText/, "Install 入口应有共存扫描阶段");
    assert.match(ps1Src, /Show-ConflictWindow \$script:coexistenceReport "Install" \$legacyOrphan/, "结构冲突/首次共存必弹窗");
    assert.match(ps1Src, /User cancelled the device-control install after the coexistence scan/);
  });

  await test("ps1：安装首次共存 ack（coexistenceAcked 机制）", () => {
    assert.match(ps1Src, /coexistenceAcked/);
    assert.match(ps1Src, /\$shouldPrompt = \$hasStructuralConflicts -or \(\$otherFamilyPresent -and -not \$ackedBefore\)/);
  });

  await test("ps1：安全插入位——默认路径走 Find-SafeInsertOffset，KeepStructure 才走旧行为", () => {
    assert.match(ps1Src, /function Find-SafeInsertOffset/);
    const safeBranch = ps1Src.match(/if \(\$KeepStructure\) \{[\s\S]{0,500}?\} else \{\s*\$safeOffset = Find-SafeInsertOffset \$content/);
    assert.ok(safeBranch, "Set-AgentBlock 应含 KeepStructure 分支 + 安全位默认分支");
    assert.match(ps1Src, /安全插入位/, "安全插入位设计注释在位");
  });

  await test("ps1：Find-SafeInsertOffset 未闭合区间后方全部视为危险", () => {
    const m = ps1Src.match(/function Find-SafeInsertOffset[\s\S]*?else \{ if \(\$pos -gt \$region\.start\) \{ \$inside = \$true \} \}/);
    assert.ok(m, "未闭合（end=-1）区间后的 Match 行必须视为 inside");
  });

  await test("ps1：Windows 原生弹窗（System.Windows.Forms MessageBox + 顶层置位 + YesNoCancel）", () => {
    assert.match(ps1Src, /function Show-ConflictWindow/);
    assert.match(ps1Src, /Add-Type -AssemblyName System\.Windows\.Forms/);
    assert.match(ps1Src, /MessageBoxButtons\]::YesNoCancel/);
    assert.match(ps1Src, /MessageBoxButtons\]::YesNo/);
    assert.match(ps1Src, /MessageBoxOptions\]262144/, "MB_TOPMOST(0x40000) 置位防弹窗被埋");
    assert.match(ps1Src, /MessageBoxIcon\]::Warning/);
  });

  await test("ps1：三键语义齐全（repair-coexist / keep-structure / clean-legacy-orphan / cancelled）", () => {
    assert.match(ps1Src, /return "repair-coexist"/);
    assert.match(ps1Src, /return "keep-structure"/);
    assert.match(ps1Src, /return "clean-legacy-orphan"/);
    assert.match(ps1Src, /return "cancelled"/);
    assert.match(ps1Src, /return "keep-both-uninstall-self"/);
  });

  await test("ps1：成功路径回传 JSON（coexistence 报告 + choice 进 result 文件）", () => {
    assert.match(ps1Src, /\$resultPayload = \[ordered\]@\{[\s\S]*?ok = \$true[\s\S]*?coexistence = \[ordered\]@\{[\s\S]*?conflicts = \$conflictTypes/);
    assert.match(ps1Src, /WriteAllText\(\$ResultPath, \(\$resultPayload \| ConvertTo-Json -Depth 5\)/);
  });

  await test("ps1：错误路径保持纯文本 [stage] 格式（不破坏 localizedInstallerError 解析）", () => {
    assert.match(ps1Src, /WriteAllText\(\$ResultPath, \$message, \(New-Object Text\.UTF8Encoding\(\$false\)\)\)/);
  });

  await test("ps1：Repair-NestedAgents 幂等轮次与 Move-RegionToSafePosition 存在", () => {
    assert.match(ps1Src, /function Repair-NestedAgents/);
    assert.match(ps1Src, /function Move-RegionToSafePosition/);
    assert.match(ps1Src, /for \(\$pass = 0; \$pass -lt 4; \$pass\+\+\)/, "摊平必须有轮次上限（防无限循环）");
  });

  await test("ps1：Get-CoexistingFamilies 枚举双家族（在场/账号/规则）", () => {
    assert.match(ps1Src, /function Get-CoexistingFamilies/);
    assert.match(ps1Src, /Get-LocalUser -Name \$family\.account/);
    assert.match(ps1Src, /Get-NetFirewallRule -Name \$family\.firewallRule/);
  });
}

// ── 4. main.cjs 接线 ──────────────────────────────────────────────────
async function runMainWiringTests() {
  await test("main.cjs：require coexistence-scanner + summarizeCoexistence", () => {
    assert.match(mainSrc, /require\("\.\/coexistence-scanner\.cjs"\)/);
    assert.match(mainSrc, /\{ scanCoexistence, summarizeCoexistence \}/);
  });

  await test("main.cjs：启动即扫描（coexistence_scan_complete 日志埋点）", () => {
    assert.match(mainSrc, /writeLog\("coexistence_scan_complete"/);
    assert.match(mainSrc, /coexistence_scan_failed/);
  });

  await test("main.cjs：安装确认弹窗带共存扫描提示", () => {
    assert.match(mainSrc, /installCoexistenceNote = summarizeCoexistence\(initialStatus\.coexistence\)/);
    assert.match(mainSrc, /共存扫描：\$\{installCoexistenceNote\}/);
    assert.match(mainSrc, /Windows 会再弹出一次共存选择窗口/);
  });

  await test("main.cjs：卸载确认弹窗带共存扫描提示 + 确认前先取状态", () => {
    assert.match(mainSrc, /uninstallCoexistenceNote = summarizeCoexistence\(currentBeforeConfirm\.coexistence\)/);
    assert.match(mainSrc, /coexistenceChoice: status\.coexistenceChoice \|\| "none"/);
  });

  await test("device-control.cjs：getDeviceControlStatus 并入 coexistence 字段", () => {
    assert.match(dcSrc, /let coexistence = null;\s*\n\s*try \{ coexistence = scanCoexistence\(\); \} catch/);
    assert.match(dcSrc, /coexistence\s*\n  \};/);
  });

  await test("device-control.cjs：runElevated 成功路径回读 result JSON", () => {
    assert.match(dcSrc, /let successPayload = null;/);
    assert.match(dcSrc, /resultText\.startsWith\("\{"\)/);
    assert.match(dcSrc, /resolve\(\{ ok: true, coexistence: \(successPayload && successPayload\.coexistence\) \|\| null \}\)/);
  });

  await test("device-control.cjs：install/uninstall 返回带 coexistenceChoice", () => {
    assert.match(dcSrc, /status\.coexistenceChoice = elevated\.coexistence\.choice; status\.coexistenceDetected = elevated\.coexistence\.detected; \}/g);
  });
}

// ── 5. 渲染层接线 ─────────────────────────────────────────────────────
async function runRendererWiringTests() {
  await test("renderer：共存区渲染函数存在且接 #device-control-coexistence", () => {
    assert.match(rendererSrc, /function renderDeviceControlCoexistence\(coexistence\)/);
    assert.match(rendererSrc, /document\.querySelector\("#device-control-coexistence"\)/);
    assert.match(rendererSrc, /renderDeviceControlCoexistence\(status\.coexistence\)/);
  });

  await test("renderer：冲突与在用文案分离（⚠ 冲突 / 隔离共存 / 遗留）", () => {
    assert.match(rendererSrc, /检测到另一套联动控件在使用中：\$\{other\.label\}（账号 \$\{other\.account\}/);
    assert.match(rendererSrc, /检测到旧版联动控件遗留：/);
    assert.match(rendererSrc, /box\.classList\.add\("conflict"\)/);
  });

  await test("index.html：设备卡片含共存状态区元素", () => {
    assert.match(indexSrc, /<div id="device-control-coexistence" class="coexistence-note" hidden>/);
    const devicePanel = indexSrc.match(/data-settings-panel="device"[\s\S]*?<\/section>/);
    assert.ok(devicePanel && devicePanel[0].includes("device-control-coexistence"), "共存区必须在设备联动面板内");
  });

  await test("styles.css：共存区暗/亮双主题样式（含冲突黄提示）", () => {
    assert.match(stylesSrc, /\.coexistence-note \{/);
    assert.match(stylesSrc, /\.coexistence-note\.conflict \{/);
    assert.match(stylesSrc, /\[data-theme="light"\] \.coexistence-note \{/);
    assert.match(stylesSrc, /\[data-theme="light"\] \.coexistence-note\.conflict \{/);
  });

  await test("renderer：切换到设备联动页即刷新（使用时扫描钩子）", () => {
    assert.match(rendererSrc, /if \(tab === "device" && currentConnectionMode === "ssh"\) refreshDeviceControlStatus\(\);/);
  });

  await test("preload：设备联动三通道保持暴露（status 携带 coexistence，无需新通道）", () => {
    assert.match(preloadSrc, /getDeviceControlStatus: \(\) => ipcRenderer\.invoke\("device-control:status"\)/);
    assert.match(preloadSrc, /installDeviceControl:/);
    assert.match(preloadSrc, /uninstallDeviceControl:/);
  });
}

// ── 6. 家族表同源交叉验证 + 版本 ──────────────────────────────────────
async function runCrossFamilyTests() {
  await test("家族表同源：scanner FAMILIES 与 ps1 managedFamilies 资源一致", () => {
    const scanner = require(SCANNER_PATH);
    for (const family of scanner.FAMILIES) {
      assert.ok(ps1Src.includes(`"${family.folder}"`), `ps1 缺少目录 ${family.folder}`);
      assert.ok(ps1Src.includes(`"${family.account}"`), `ps1 缺少账号 ${family.account}`);
      assert.ok(ps1Src.includes(`"${family.firewallRule}"`), `ps1 缺少防火墙规则 ${family.firewallRule}`);
      assert.ok(ps1Src.includes(`"${family.markerFamily}"`), `ps1 缺少 marker ${family.markerFamily}`);
    }
  });

  await test("版本号 ≥3.16.2（v3.16.3 起性能修复顺延）", () => {
    assert.ok(pkg.version === "3.16.2" || pkg.version === "3.16.3", `版本应为 3.16.2 或 3.16.3（实际 ${pkg.version}）`);
  });

  await test("既往不回退：v3.16.0 的 autologon 披露与 schemaVersion 仍在", () => {
    assert.match(indexSrc, /device-control-autologon-note/);
    const settingsSrc = fs.readFileSync(path.join(ROOT, "src", "main", "settings.cjs"), "utf8");
    assert.match(settingsSrc, /SETTINGS_SCHEMA_VERSION|migrateSchema/);
  });

  await test("既往不回退：v3.16.1 打印联动通道仍在", () => {
    assert.match(preloadSrc, /printDetect|printSend/);
  });
}

(async () => {
  console.log("── v3.16.2 双联动控件共存隔离测试 ──");
  await runParserTests();
  await runScanCoexistenceTests();
  await runPs1IsolationTests();
  await runMainWiringTests();
  await runRendererWiringTests();
  await runCrossFamilyTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
  if (failed) {
    console.log("失败项：\n" + failures.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
})();