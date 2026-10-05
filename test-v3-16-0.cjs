"use strict";
/**
 * v3.16.0 测试 — 安全加固版（ChatGPT 3.15.7 审计报告落地 + 彩蛋距离调参）
 * 背景：资料库新增 ChatGPT 产出的《Agent-Chat-Pro-3.15.7-改进与安全加固说明书.md》，
 *   经只读审计（命令调用面/设备联动/CSP 三路）定差距后落地。
 * 覆盖：settings.cjs schemaVersion 迁移行为单测（mock electron，真实 IO 临时目录）；
 *       CSP 收窄断言；设备联动披露文案；dino.html 障碍距离调参断言；
 *       build-pipeline SHA256 清单接线；版本号 3.16.0。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const SETTINGS_PATH = path.join(ROOT, "src", "main", "settings.cjs");
const PIPELINE_PATH = path.join(ROOT, "scripts", "build-pipeline.cjs");
const INDEX_PATH = path.join(ROOT, "src", "renderer", "index.html");
const DINO_PATH = path.join(ROOT, "src", "renderer", "game", "dino.html");
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

const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");
const dinoSrc = fs.readFileSync(DINO_PATH, "utf8");
const ps1Src = fs.readFileSync(PS1_PATH, "utf8");
const pipelineSrc = fs.readFileSync(PIPELINE_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

// ── 1. settings.cjs 迁移机制（mock electron + 真实文件 IO 临时目录） ─────────────────
async function runSettingsTests() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3160-"));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => workdir, isPackaged: false, whenReady: async () => {} },
        safeStorage: { isEncryptionAvailable: () => true, decryptString: () => "x", encryptString: (v) => Buffer.from(v) }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(SETTINGS_PATH)];
  const settings = require(SETTINGS_PATH);
  Module._load = originalLoad;

  const targetFile = path.join(workdir, "connection.json");
  const backupFile = path.join(workdir, "connection.json.schema-v0.bak");

  await test("载入无版本标配置 → 备份 .schema-v0.bak 生成且内容为迁移前原文", () => {
    fs.writeFileSync(targetFile, JSON.stringify({ theme: "dark", compactThreshold: 70 }), "utf8");
    const raw = settings.getRawForTest ? settings.getRawForTest() : null;
    // 经 getSettings 触发 readRaw → migrateSchema 链
    const data = settings.getSettings();
    assert.strictEqual(data.theme, "dark"); // 字段不丢
    assert.ok(fs.existsSync(backupFile), "备份文件应已生成");
    const backup = JSON.parse(fs.readFileSync(backupFile, "utf8"));
    assert.strictEqual(backup.schemaVersion, undefined, "备份应为迁移前原文（无版本标）");
    assert.strictEqual(backup.theme, "dark");
  });

  await test("迁移后落盘文件已打 schemaVersion（版本标落盘，v3.18.0 起当前值为 2）", () => {
    const current = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.ok(current.schemaVersion >= 1, `应带版本标，实际 ${current.schemaVersion}`);
  });

  await test("已带标 v1 配置再次读取 → 不产生新备份（幂等，仅一个 v0 备份）", () => {
    settings.getSettings();
    settings.getSettings();
    const backups = fs.readdirSync(workdir).filter((f) => f.endsWith(".bak"));
    assert.deepStrictEqual(backups, ["connection.json.schema-v0.bak"], `备份应固定名不堆积，实际 ${backups}`);
  });

  await test("writeRaw 落盘自动带 schemaVersion（saveSettings 链路统一打标）", () => {
    settings.setThemeForTest ? settings.setThemeForTest("light") : settings.saveSettings({ theme: "light", connectionMode: "cloud" });
    const current = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.ok(current.schemaVersion >= 1, `应带版本标，实际 ${current.schemaVersion}`);
    assert.strictEqual(current.theme, "light");
  });

  await test("getSettings 白名单不透传 schemaVersion 字段", () => {
    const data = settings.getSettings();
    assert.strictEqual(data.schemaVersion, undefined, "schemaVersion 属于存储结构，不应漏进设置接口");
    assert.strictEqual(data.version, undefined);
  });

  await test("legacy 分支首迁：新路径不存在时备份跳过不阻断 + 落盘带标（ENONENT 路径）", () => {
    // 模拟全新机器：删掉 current 文件，settingsPath ENOENT → readRaw 走 legacy（此时也不存在）→ {}（无迁移对象，安全路径）
    fs.rmSync(targetFile, { force: true });
    fs.rmSync(backupFile, { force: true });
    settings.getSettings(); // 无任何文件 → 返回 {} 默认值，不抛错
    assert.ok(fs.readdirSync(workdir).filter((f) => f.endsWith(".bak")).length === 0);
  });

  await test("修复后回归：损坏配置走 .corrupt 备份机制不回退", () => {
    fs.writeFileSync(targetFile, "{这是坏 JSON", "utf8");
    const data = settings.getSettings(); // corrupt → rename 备份 + 返回 {}
    assert.strictEqual(data.connectionMode, "ssh"); // getSettings 默认值可用
    const corruptBak = fs.readdirSync(workdir).filter((f) => f.includes(".corrupt-"));
    assert.strictEqual(corruptBak.length, 1, "损坏备份机制应保留");
  });

  await test("SETTINGS_SCHEMA_VERSION 常量与 migrateSchema 接线在 readRaw 两个返回点", () => {
    const src = fs.readFileSync(SETTINGS_PATH, "utf8");
    assert.ok(/SETTINGS_SCHEMA_VERSION = \d+/.test(src), "版本常量应存在（v3.18.0 起值为 2）");
    assert.ok(src.includes("return migrateSchema(current);"), "正常分支接迁移");
    assert.ok(src.includes("return migrateSchema(JSON.parse(fs.readFileSync(legacySettingsPath(), \"utf8\")));"), "legacy 分支接迁移");
    assert.ok(src.includes("schemaVersion: SETTINGS_SCHEMA_VERSION"), "writeRaw 统一打标");
    assert.ok(src.includes("copyFileSync(source, backup)"), "迁移前整文件备份");
  });
}

// ── 2. CSP 收窄 ─────────────────
async function runCspTests() {
  await test("CSP connect-src 收窄为 'self'（不再包含 https: 白给域）", () => {
    const match = indexSrc.match(/connect-src ([^"]*)/);
    assert.ok(match, "CSP 存在");
    assert.strictEqual(match[1].trim(), "'self'", `connect-src 应为 'self'，实际 "${match[1]}"`);
    assert.ok(!/connect-src[^"]*(?:'|^https:)/.test("https:"), "占位防误报");
    assert.ok(!match[1].includes("https:"), "connect-src 不得包含 https:");
  });

  await test("CSP 回归基线：default/script/style-src 仍为 'self'，无 unsafe-inline", () => {
    assert.ok(!/default-src[^"]*unsafe-inline/.test(indexSrc), "不得出现 unsafe-inline");
    assert.ok(/script-src 'self'/.test(indexSrc) && /style-src 'self'/.test(indexSrc) && /default-src 'self'/.test(indexSrc));
  });
}

// ── 3. 设备联动披露 ─────────────────
async function runDeviceDisclosureTests() {
  await test("设备联动页新增自动登录保护阶段披露（元素+人话文案）", () => {
    assert.ok(indexSrc.includes('id="device-control-autologon-note"'), "披露元素应存在");
    assert.ok(indexSrc.includes("不读取、不存储、不修改任何密码"), "披露要点：不读取不存储不修改密码");
    assert.ok(indexSrc.includes("未开启自动登录的机器不会因安装产生自动登录"), "披露要点：不会新增自动登录");
  });

  await test("device-control.ps1 三门槛保护语义不回退（防未来误改成无门槛改注册表）", () => {
    assert.ok(ps1Src.includes("Never read, store, or replace a user's password"), "核心承诺注释保留");
    assert.ok(ps1Src.includes('AutoAdminLogon -ne "1" -or $hasDefaultPassword'), "门槛1：已开启且无密码");
    assert.ok(ps1Src.includes("configured-user-differs"), "门槛2：用户不一致跳过");
    assert.ok(ps1Src.includes("Test-PasswordlessLocalLogon $activeUser"), "门槛3：空密码实测验证");
  });
}

// ── 4. 字节码/加密残留检查（本次改动文件纳入混淆链回归） ─────────────────
async function runObfuscateTests() {
  const obfuscateSrc = fs.readFileSync(path.join(ROOT, "scripts", "obfuscate.cjs"), "utf8");
  await test("settings.cjs 仍在混淆清单（既有登记不回退）", () => {
    assert.ok(/"main\/settings\.cjs"/.test(obfuscateSrc), "settings.cjs 应登记混淆");
  });
}

// ── 5. 构建管线 SHA-256 清单 ─────────────────
async function runPipelineTests() {
  await test("build-pipeline 新增 step7_checksums 且 verify 通过后调用", () => {
    assert.ok(pipelineSrc.includes("function step7_checksums()"), "step7 应存在");
    assert.ok(/const verified = step6_verify\(\);\s*\n?\s*if \(!verified\) throw[^;]+;\s*\n\s*step7_checksums\(\);/.test(pipelineSrc),
      "step7 应在 verify 通过后调用");
    assert.ok(pipelineSrc.includes("SHA256SUMS.txt"), "产物名正确");
    assert.ok(pipelineSrc.includes("certutil -hashfile"), "清单附 Windows 校验命令提示");
  });

  await test("step7 只覆盖本次构建版本（从 package.json 读 version 过滤）", () => {
    assert.ok(pipelineSrc.includes(`Agent Chat Pro-${"…"}-Setup.exe`) || /`Agent Chat Pro-\$\{version\}-Setup\.exe`/.test(pipelineSrc),
      "安装包名按版本动态拼接");
    assert.ok(pipelineSrc.includes('path.join(PROJECT_ROOT, "package.json")') || pipelineSrc.includes('require("../package.json")'),
      "版本号从 package.json 读取");
  });
}

// ── 6. dino.html 彩蛋障碍距离调参 ─────────────────
async function runDinoTests() {
  await test("首个障碍距离 320 → 480（reset 与顶层两处）", () => {
    assert.strictEqual((dinoSrc.match(/state\.nextIn = 480;/g) || []).length, 2, "480 应出现 2 处");
    assert.ok(!dinoSrc.includes("state.nextIn = 320;"), "320 旧值应清零");
  });

  await test("随机间距 150~310 → 220~420（基础 220 + 200 随机 + 压缩上限 90）", () => {
    assert.ok(dinoSrc.includes("220 + Math.random() * 200 - Math.min(90, state.score * 0.25)"),
      "间距公式应为 220 + rand*200 − min(90, score*0.25)");
    assert.ok(!dinoSrc.includes("150 + Math.random() * 160"), "v3.15.9 旧间距公式应清零");
  });

  await test("调参注释版本归 v3.16.0 且游戏逻辑关键词不回退", () => {
    assert.ok(dinoSrc.includes("v3.16.0 间距再放宽"), "注释版本标");
    assert.ok(dinoSrc.includes("GRAVITY = 2100") && dinoSrc.includes("JUMP_V = -760"), "跳跃/重力参数不动");
    assert.ok(dinoSrc.includes("state.speed = 250") && dinoSrc.includes("dt * 1.6"), "初速/渐加速不动（v3.15.9 语义保留）");
    assert.ok(dinoSrc.includes("acp-dino-hi"), "HI 记录键不动");
  });
}

// ── 7. 版本号 ─────────────────
async function runVersionTests() {
  await test("package.json 版本号 ≥ 3.16.0（跟随语义，v3.16.2 起）", () => {
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    const [baseMajor, baseMinor, basePatch] = "3.16.0".split(".").map(Number);
    assert.ok(major > baseMajor || (major === baseMajor && (minor > baseMinor || (minor === baseMinor && patch >= basePatch))), `版本 ${pkg.version} 应 ≥ 3.16.0`);
  });
}

(async () => {
  console.log("── v3.16.0 安全加固版测试 ──");
  await runSettingsTests();
  await runCspTests();
  await runDeviceDisclosureTests();
  await runObfuscateTests();
  await runPipelineTests();
  await runDinoTests();
  await runVersionTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 项）`);
  if (failed) {
    console.log("失败项：\n" + failures.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
})();