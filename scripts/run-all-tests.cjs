#!/usr/bin/env node
"use strict";

// ── v3.40.0（atomcode 建议 #2）：统一测试入口 ─────────────────────────────────
// 修复「无统一 test 入口/CI」：`npm test` 一条命令跑完全仓测试。
// 范围 = 根目录全部 test-v3-*.cjs（版本级行为测试）+ 专项白名单（不随版本号命名、
// 但同属回归面的测试）。逐个串行执行，任何一个非 0 退出即判失败；
// 汇总「通过 N / 失败 M」，M>0 时整体 exit 1（供 CI / 提交前守门使用）。
//
// 说明：测试默认串行——多个测试会创建/读写仓库内临时目录与 userData 目录，
// 并行会互相踩踏；本入口不是性能优化点，是确定性保障点。

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

// 专项白名单：不匹配 test-v3-* 命名、但必须纳入统一回归的测试。
// 新增专项测试时把文件名加进这里（并在 README 测试徽章口径里同步 +1）。
const EXTRA_TESTS = [
  "test-agent-http-bridge.cjs",
  "test-bridge-integration.cjs",
  "test-bytecode.cjs",
  "test-bytecode-fallback.cjs",
  "test-claude-launch-diagnostics.cjs",
  "test-proxy-connectivity.cjs",
  "test-signal-chain.cjs",
  "test-tier2-modules.cjs"
];

function collectTests() {
  const files = fs
    .readdirSync(repoRoot)
    .filter((name) => /^test-v3-.*\.cjs$/.test(name))
    .sort(cmpVersion);
  for (const name of EXTRA_TESTS) {
    if (!fs.existsSync(path.join(repoRoot, name))) {
      console.error(`[run-all-tests] 白名单里的专项测试不存在：${name}`);
      process.exit(1);
    }
    files.push(name);
  }
  return files;
}

// test-v3-<major>-<minor>-<patch>.cjs 按版本号升序（保证 3.10 < 3.12 < 3.15 这种字典序会错的顺序正确）
function cmpVersion(a, b) {
  const parse = (name) => {
    const m = /^test-v3-(\d+)-(\d+)-(\d+)\.cjs$/.exec(name);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return a.localeCompare(b);
}

function main() {
  // --only=<名,名…>：只跑指定文件（调试单个测试用；名字带不带 .cjs 后缀都接受）；默认全量
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg
    ? onlyArg
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((n) => (n.endsWith(".cjs") ? n : `${n}.cjs`))
    : null;

  const all = collectTests();
  const tests = only ? all.filter((name) => only.includes(name)) : all;
  if (tests.length === 0) {
    console.error("[run-all-tests] 没有匹配到任何测试文件");
    process.exit(1);
  }

  console.log(`[run-all-tests] 共 ${tests.length} 个测试文件（全仓清单 ${all.length}），串行执行…\n`);

  const failed = [];
  const startedAll = Date.now();
  for (let i = 0; i < tests.length; i += 1) {
    const name = tests[i];
    const label = `[${i + 1}/${tests.length}] ${name}`;
    console.log(`──────── ${label} ────────`);
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(repoRoot, name)], {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status === 0) {
      console.log(`✓ ${name} 通过（${seconds}s）\n`);
    } else {
      const why = result.error ? ` ${result.error.message}` : ` 退出码 ${result.status}`;
      console.error(`✗ ${name} 失败（${seconds}s，${why}）\n`);
      failed.push(name);
    }
  }

  const totalSeconds = ((Date.now() - startedAll) / 1000).toFixed(1);
  console.log("════════════════════════════════════");
  console.log(`[run-all-tests] 汇总：通过 ${tests.length - failed.length} / ${tests.length}，失败 ${failed.length}（总耗时 ${totalSeconds}s）`);
  if (failed.length > 0) {
    for (const name of failed) console.error(`  ✗ ${name}`);
    process.exit(1);
  }
}

if (require.main === module) main();