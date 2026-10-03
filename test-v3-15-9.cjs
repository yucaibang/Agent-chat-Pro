"use strict";
/**
 * v3.15.9 测试 — 跳跳龙彩蛋速度调优
 * 用户（Test-PC）反馈：「彩蛋小游戏有个 bug，速度太快了」。
 * 调参：初速 340→250 px/s、加速 3.2→1.6 /s、首个障碍距离 60→320 px、
 *   障碍间距 90~200 → 150~310 px（随分数压缩更缓 0.4→0.25、上限 45→70）、计分速率 0.12→0.1。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const DINO_PATH = path.join(ROOT, "src", "renderer", "game", "dino.html");
const PACKAGE_PATH = path.join(ROOT, "package.json");

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((error) => { failed++; failures.push(`${name}: ${error.message}`); console.log(`  ✗ ${name}: ${error.message}`); });
}

const dinoSrc = fs.readFileSync(DINO_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

async function runTests() {
  await test("初速度 340 → 250 px/s", () => {
    assert.ok(dinoSrc.includes("state.speed = 250;"), "reset 应以 250 起步");
    assert.ok(!dinoSrc.includes("state.speed = 340"), "初版 340 不应残留");
  });

  await test("渐加速 3.2 → 1.6 /s（防陡增）", () => {
    assert.ok(dinoSrc.includes("state.speed += dt * 1.6;"), "加速率应为 1.6");
    assert.ok(!dinoSrc.includes("dt * 3.2"), "旧加速率 3.2 不应残留");
  });

  await test("首个障碍距离：开局缓冲（v3.15.9 为 320，v3.16.0 起放宽至 480）", () => {
    assert.ok(!dinoSrc.includes("state.nextIn = 60;"), "旧值 60 不应残留");
    assert.ok((dinoSrc.match(/state\.nextIn = 480;/g) || []).length === 2, "reset 与初始两处均应 480（v3.16.0 起值）");
  });

  await test("障碍间距放宽到 220~420 px，随分数压缩更缓（v3.16.0 起值）", () => {
    assert.ok(dinoSrc.includes("220 + Math.random() * 200 - Math.min(90, state.score * 0.25)"), "间距公式应为 v3.16.0 版（220~420）");
    assert.ok(!dinoSrc.includes("150 + Math.random() * 160"), "v3.15.9 旧间距不应残留");
    assert.ok(!dinoSrc.includes("90 + Math.random() * 110"), "初版旧间距不应残留");
  });

  await test("计分速率微调 0.12 → 0.1", () => {
    assert.ok(dinoSrc.includes("state.score + dt * state.speed * 0.1"), "计分系数应为 0.1");
  });

  await test("游戏性防回归：跳跃/重力/跑动两帧/死亡帧/海浪文字/记录仍在", () => {
    for (const kw of ["GRAVITY = 2100, JUMP_V = -760", '"run-a"', '"run-b"', '"dead"', 'const WAVE_TEXT = "user\'s word";', "acp-dino-hi"]) {
      assert.ok(dinoSrc.includes(kw), `关键实现不应丢失：${kw}`);
    }
  });

  await test("版本号 ≥3.15.9", () => {
    const parts = pkg.version.split(".").map(Number);
    const ok = parts[0] > 3 || (parts[0] === 3 && (parts[1] > 15 || (parts[0] === 3 && parts[1] === 15 && parts[2] >= 9)));
    assert.ok(ok, `版本号应为 ≥3.15.9，实际 ${pkg.version}`);
  });

  console.log(`\n${passed} 通过, ${failed} 失败`);
  if (failed) { console.log("\n失败项："); failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
}

runTests().catch((error) => { console.error(error); process.exit(1); });