"use strict";
/**
 * v3.16.3 回归测试 — 启动性能修复（fuse 全文件读 → 窗口读）+ 日志降噪判重 + locales 瘦身
 *
 * 背景（用户 Test-PC 拍板 2026-10-04）：
 *   ① integrity-guard.cjs _checkFuses() 每次启动 fs.readFileSync 整个 201MB exe 找 30 字节
 *      sentinel —— 同步 IO + 内存压强，是启动变慢实锤主因
 *   ② 信号链日志逐 token 全量落盘且同毫秒双写，2MB/天灌满轮转（日志 IO 无谓消耗）
 *   ③ Electron 打包 locales 全语言 42MB，实际只用 zh-CN/en-US
 * 修复：
 *   ① _readFuseWindow() 窗口读（79% 相对位置起 10MB，实测 sentinel 在 82%），
 *      未命中回退全文件扫描 —— 防破解语义不变
 *   ② logger.writeLog 800ms 同串判重
 *   ③ package.json build.electronLanguages = ["zh-CN","en-US"]
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const INTEGRITY_PATH = path.join(ROOT, "src", "main", "integrity-guard.cjs");
const LOGGER_PATH = path.join(ROOT, "src", "main", "logger.cjs");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const EXE_PATH = path.join(ROOT, "dist", "win-unpacked", "Agent Chat Pro.exe");

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

const integritySrc = fs.readFileSync(INTEGRITY_PATH, "utf8");
const loggerSrc = fs.readFileSync(LOGGER_PATH, "utf8");

(async () => {
  console.log("\n== v3.16.3 启动性能修复回归 ==\n");

  await test("integrity-guard 引入 _readFuseWindow 窗口读方法", () => {
    assert.ok(integritySrc.includes("_readFuseWindow"), "应定义 _readFuseWindow");
    assert.ok(integritySrc.includes("0.79"), "窗口起点应为 79% 相对位置");
    assert.ok(integritySrc.includes("10 * 1024 * 1024"), "窗口长度应为 10MB");
  });

  await test("fallback 全文件扫描保留（防破解语义不降级）", () => {
    assert.ok(integritySrc.includes("| fs.readFileSync(exePath)"), "窗口未命中必须回退全读");
    assert.ok(integritySrc.includes("fuse_sentinel_not_found"), "sentinel 缺失仍应判 tampered");
    assert.ok(integritySrc.includes("fuse_values_mismatch"), "fuse 值错误仍应判 tampered");
    const sentinel = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
    assert.ok(integritySrc.includes(sentinel), "sentinel 常量未变");
  });

  await test("真机验证：窗口读命中真实 201MB exe 的 sentinel", () => {
    if (!fs.existsSync(EXE_PATH)) { console.log("    (跳过：dist 无 win-unpacked，本机未构建)"); return; }
    // v3.16.3 修复依赖 require("electron") 在纯 node 环境 app=undefined 不抛错
    const { IntegrityGuard } = require(INTEGRITY_PATH);
    const guard = new IntegrityGuard();
    const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
    const stat = fs.statSync(EXE_PATH);
    const win = guard._readFuseWindow(EXE_PATH, stat.size, sentinel);
    assert.ok(win, "窗口 Buffer 应命中 sentinel");
    assert.ok(win.indexOf(sentinel) !== -1, "Buffer 内必须含 sentinel");
    // 完整链路：把 process.execPath 临时指向真实 ACP exe，走 _checkFuses 窗口路径
    const realExec = process.execPath;
    Object.defineProperty(process, "execPath", { value: EXE_PATH });
    try {
      const t0 = Date.now();
      const result = guard._checkFuses();
      const dur = Date.now() - t0;
      console.log(`    (fuse 窗口读耗时 ${dur}ms，exe ${Math.round(stat.size / 1048576)}MB)`);
      assert.ok(result && typeof result.criticalFuses === "object", "窗口路径应产出 fuse 解析对象");
      assert.ok(result.tampered === false, `fuse 校验应为干净（得到 ${JSON.stringify(result).slice(0, 120)}）`);
      assert.strictEqual(result.reason, null, "不应带 mismatch 原因");
    } finally {
      Object.defineProperty(process, "execPath", { value: realExec });
    }
  });

  await test("真机验证：sentinel 不在窗口的小文件触发回退（返回 null）", () => {
    const { IntegrityGuard } = require(INTEGRITY_PATH);
    const guard = new IntegrityGuard();
    const os = require("os");
    const tmp = path.join(os.tmpdir(), "acf-fuse-fallback-" + process.pid + ".bin");
    fs.writeFileSync(tmp, Buffer.alloc(1024, 0));
    try {
      const win = guard._readFuseWindow(tmp, 1024, Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"));
      assert.strictEqual(win, null, "无 sentinel 小文件应返回 null 触发回退");
    } finally { fs.rmSync(tmp, { force: true }); }
  });

  await test("logger 判重降噪存在且保留 time 字段", () => {
    assert.ok(loggerSrc.includes("_lastLogPayload"), "应有判重状态");
    assert.ok(loggerSrc.includes("< 800"), "判重窗口应为 800ms");
    assert.ok(/JSON\.stringify\(\{ time: new Date\(\)\.toISOString\(\), \.\.\.body \}\)/.test(loggerSrc), "落盘行必须保留 time 字段");
    assert.ok(loggerSrc.includes("MAX_BYTES = 2 * 1024 * 1024"), "轮转阈值未变");
  });

  await test("package.json：版本 3.16.3 + locales 瘦身", () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
    const [a, b, c] = pkg.version.split(".").map(Number);
    assert.ok(a > 3 || (a === 3 && (b > 16 || (b === 16 && c >= 3))), `版本应 ≥3.16.3（实际 ${pkg.version}）`);
    assert.deepStrictEqual(pkg.build.electronLanguages, ["zh-CN", "en-US"], "electronLanguages 应只留两种语言");
  });

  console.log(`\n== 结果：${passed} 通过 / ${failed} 失败 ==`);
  if (failures.length) { console.log("\n失败详情:\n" + failures.join("\n")); process.exit(1); }
  process.exit(0);
})();