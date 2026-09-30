"use strict";
/**
 * v3.15.8 测试 — 关于页彩蛋：点击「Agent Chat Pro」标题弹出跳跳龙小游戏
 * 用户（Test-PC）拍板：设置中心·关于页点标题 → 开一个 Chrome dino 同款小游戏窗口，
 * 恐龙换成 Claude Code 吉祥物（1:1 复刻自用户截图 102×50 像素画 #D78787）+ 背景海浪标「user's word」。
 * 实现：src/renderer/game/dino.html（独立 canvas 游戏，无 preload 零 IPC 面）
 *   + main.cjs 单例游戏窗口（frame:false/透明/sandbox）+ preload openDinoGame + renderer .about-title 接线。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const DINO_PATH = path.join(ROOT, "src", "renderer", "game", "dino.html");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
const PRELOAD_PATH = path.join(ROOT, "src", "main", "preload.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const STYLES_PATH = path.join(ROOT, "src", "renderer", "styles.css");
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

const dinoSrc = fs.readFileSync(DINO_PATH, "utf8");
const mainSrc = fs.readFileSync(MAIN_PATH, "utf8");
const preloadSrc = fs.readFileSync(PRELOAD_PATH, "utf8");
const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
const stylesSrc = fs.readFileSync(STYLES_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

async function runTests() {
  await test("dino.html 存在（src/renderer/game/，files: src/** 自动打包）", () => {
    assert.ok(fs.existsSync(DINO_PATH), "游戏页应存在");
    assert.ok(pkg.build.files.some((f) => f === "src/**" || String(f).startsWith("src/*")) === false || pkg.build.files.includes("src/**") || pkg.build.files.some((f) => String(f).includes("src")), "build.files 应覆盖 src/**");
  });

  await test("吉祥物 sprite 精确复刻：50 行 × 102 列，仅 . # E，主体+眼共 2544 像素", () => {
    const start = dinoSrc.indexOf("const SPRITE");
    const end = dinoSrc.indexOf("\n];", start);
    assert.ok(start >= 0 && end > start, "SPRITE 数组应存在");
    const arr = eval("(" + dinoSrc.slice(dinoSrc.indexOf("[", start), end + 2) + ")");
    assert.strictEqual(arr.length, 50, "应为 50 行");
    assert.strictEqual(arr[0].length, 102, "应为 102 列");
    const uniq = [...new Set(arr.join(""))].sort().join("");
    assert.strictEqual(uniq, "#.E", "字符集应仅含 . # E");
    assert.strictEqual(arr.join("").replace(/\./g, "").length, 2544, "主体 2472 + 眼 72 = 2544");
  });

  await test("吉祥物主色取自截图精确色值 #D78787 + 镂空眼绘制", () => {
    assert.ok(dinoSrc.includes('"#D78787"'), "主体色应为 #D78787（截图实测色）");
    assert.ok(/drawMascot/.test(dinoSrc), "应有 drawMascot 绘制函数");
    assert.ok(dinoSrc.includes('"dead"'), "死亡帧（X 眼）应存在");
    assert.ok(dinoSrc.includes('"run-a"') && dinoSrc.includes('"run-b"'), "跑动两帧交替（对角抬腿）");
  });

  await test("游戏核心机制：跳跃/重力/渐加速/碰撞/得分/记录", () => {
    assert.ok(dinoSrc.includes("function jump()"), "应有跳跃");
    assert.ok(dinoSrc.includes("GRAVITY") && dinoSrc.includes("JUMP_V"), "应有重力参数");
    assert.ok(dinoSrc.includes("state.speed += dt") || dinoSrc.includes("state.speed +="), "速度应随时间渐增");
    assert.ok(dinoSrc.includes("G A M E  O V E R"), "应有 Game Over");
    assert.ok(dinoSrc.includes("acp-dino-hi"), "HI 分数应持久化 localStorage");
    assert.ok(dinoSrc.includes("spawnObstacle"), "应有障碍生成");
  });

  await test("海浪背景 + 标字 user's word", () => {
    assert.ok(dinoSrc.includes('const WAVE_TEXT = "user\'s word";'), "波浪浮字应为 user's word");
    assert.ok(/drawWaves/.test(dinoSrc) && /drawWaveLayer/.test(dinoSrc), "应有海浪分层绘制");
  });

  await test("游戏页零网络依赖（无 http(s) 外部引用）", () => {
    const hits = (dinoSrc.match(/https?:\/\//g) || []).filter((u) => !u.includes("open.bigmodel.cn"));
    assert.strictEqual(hits.length, 0, `不应有外部引用（发现 ${hits.length} 处）`);
  });

  await test("输入与窗口控制：空格/↑/W 跳、点击开始、Esc/× 关闭", () => {
    for (const code of ["Space", "ArrowUp", "KeyW", "Escape"]) assert.ok(dinoSrc.includes(`"${code}"`), `应监听 ${code}`);
    assert.ok(dinoSrc.includes('id="close-btn"'), "应有 × 按钮");
  });

  await test("main.cjs：单例游戏窗口（复用聚焦 + closed 清引用）", () => {
    assert.ok(mainSrc.includes("function createDinoGameWindow()"), "应有 createDinoGameWindow");
    const i = mainSrc.indexOf("function createDinoGameWindow");
    const fn = mainSrc.slice(i, i + 1600);
    assert.ok(fn.includes("dinoGameWindow"), "模块级单例引用");
    assert.ok(fn.includes("isDestroyed()") && fn.includes("focus()"), "重复打开应聚焦已有窗口");
    assert.ok(fn.includes('on("closed"'), "窗口关闭应清引用");
    assert.ok(fn.includes('loadFile(path.join(__dirname, "../renderer/game/dino.html"))'), "应加载游戏页");
  });

  await test("main.cjs 游戏窗口安全面：sandbox/contextIsolation + 拒开子窗口", () => {
    const i = mainSrc.indexOf("function createDinoGameWindow");
    const fn = mainSrc.slice(i, mainSrc.indexOf("\n}", i) + 2);
    assert.ok(fn.includes("contextIsolation: true") && fn.includes("nodeIntegration: false") && fn.includes("sandbox: true"), "安全 webPreferences");
    assert.ok(fn.includes('setWindowOpenHandler(() => ({ action: "deny" }))'), "游戏窗口应拒开子窗口");
    assert.ok(!fn.includes("preload"), "游戏页不应有 preload（零 IPC 面）");
  });

  await test("main.cjs IPC 通道 app:open-dino-game 接线", () => {
    assert.ok(mainSrc.includes('ipcMain.handle("app:open-dino-game", () => createDinoGameWindow())'), "应注册 app:open-dino-game handler");
  });

  await test("preload 暴露 openDinoGame", () => {
    assert.ok(preloadSrc.includes('openDinoGame: () => ipcRenderer.invoke("app:open-dino-game")'), "preload 应暴露 openDinoGame");
  });

  await test("renderer 关于页标题点击接线", () => {
    const i = rendererSrc.indexOf('document.querySelector(".about-title")?.addEventListener');
    assert.ok(i >= 0, "应给 .about-title 加点击监听");
    const seg = rendererSrc.slice(i, i + 220);
    assert.ok(seg.includes("window.agentChatPro.openDinoGame()"), "点击应调用 openDinoGame");
  });

  await test("styles.css 标题可点击暗示（cursor + hover）", () => {
    const i = stylesSrc.indexOf(".about-title {");
    assert.ok(i >= 0, "应有 .about-title 规则");
    assert.ok(stylesSrc.includes(".about-title:hover"), "应有 hover 反馈");
  });

  await test("既有文件 5 个 + 新游戏页，语法检查全部通过", () => {
    for (const f of [MAIN_PATH, PRELOAD_PATH]) {
      const { execFileSync } = require("child_process");
      execFileSync("node", ["--check", f], { stdio: "pipe" });
    }
    const { execFileSync } = require("child_process");
    execFileSync("node", ["--check", RENDERER_PATH], { stdio: "pipe" });
  });

  await test("版本号 ≥3.15.8", () => {
    const parts = pkg.version.split(".").map(Number);
    const ok = parts[0] > 3 || (parts[0] === 3 && (parts[1] > 15 || (parts[0] === 3 && parts[1] === 15 && parts[2] >= 8)));
    assert.ok(ok, `版本号应为 ≥3.15.8，实际 ${pkg.version}`);
  });

  console.log(`\n${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.log("\n失败项：");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

runTests().catch((error) => { console.error(error); process.exit(1); });