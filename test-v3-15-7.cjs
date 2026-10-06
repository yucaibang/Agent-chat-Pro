"use strict";
/**
 * v3.15.7 回归测试 — 云端服务商注册链接劫持主窗口（无返回键只能关掉应用重开）
 * 用户反馈（Test-PC）：跳转云端页面（如「点击注册 DeepSeek」）后没有返回键，主窗口被外部
 * 网站整个替换，只能关掉应用重开。
 * 根因（两层）：
 *   ① 消息区/文件预览的链接都接了「preventDefault + openLink 走系统浏览器」，唯独设置页
 *      #cloud-key-hint 的服务商注册链接（renderer.js keyHint.innerHTML = config.hint）漏接
 *   ② main.cjs 无 will-navigate / setWindowOpenHandler 兜底——Electron 默认把主窗口内部
 *      导航到 http(s) 外链，聊天 UI 被替换且 Electron 无物理返回键
 * 修复：bindExternalLinks 通用函数（收编消息区/预览 + 接入密钥提示 + 静态初始接线）
 *   + index.html 静态死链 href="#" 换真实智谱地址 + 主进程双兜底（setWindowOpenHandler + will-navigate）。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = __dirname;
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
const INDEX_PATH = path.join(ROOT, "src", "renderer", "index.html");
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

const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
const mainSrc = fs.readFileSync(MAIN_PATH, "utf8");
const indexSrc = fs.readFileSync(INDEX_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

function extractBetween(src, start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `源码片段提取失败：${start}`);
  return src.slice(i, j);
}

const bindFn = extractBetween(rendererSrc, "function bindExternalLinks", "async function renderAssistant");
const renderAssistantHead = rendererSrc.slice(rendererSrc.indexOf("async function renderAssistant"), rendererSrc.indexOf("async function renderAssistant") + 700);
const settingsBlock = extractBetween(
  rendererSrc,
  'document.querySelector("#cloud-provider")?.addEventListener',
  'document.querySelector("#toggle-cloud-key")?.addEventListener'
);
const navGuard = extractBetween(mainSrc, "v3.15.7 窗口导航兜底", "window.loadFile");

async function runTests() {
  await test("渲染层：bindExternalLinks 函数存在", () => {
    assert.ok(/function bindExternalLinks\(/.test(bindFn), "应有 bindExternalLinks(container, onError) 函数");
  });

  await test("bindExternalLinks 拦截语义：preventDefault + openLink 走系统浏览器", () => {
    assert.ok(bindFn.includes("event.preventDefault()"), "必须 preventDefault 阻止主窗口内导航");
    assert.ok(bindFn.includes("window.agentChatPro.openLink("), "必须走 openLink（IPC → shell.openExternal）");
  });

  await test("bindExternalLinks 死链只拦不放：href 为空或 # 时不弹浏览器", () => {
    assert.ok((bindFn.match(/href === "" \|\| href === "#"/g) || []).length >= 1, "应拦截空 href 与 \"#\" 占位死链");
  });

  await test("消息区链接接管沿用 bindExternalLinks（防回归 v3.15.5 链接口径）", () => {
    const seg = renderAssistantHead.slice(0, renderAssistantHead.indexOf("content.querySelectorAll(\"pre\")"));
    assert.ok(/bindExternalLinks\(content/.test(seg), "renderAssistant 应改用 bindExternalLinks(content)");
    assert.ok(seg.includes("(error) => alert(error.message)"), "失败仍应有 alert 反馈（原行为保留）");
    // 旧的裸循环不再存在于消息区（避免双绑定）
    const rest = rendererSrc.slice(rendererSrc.indexOf("async function renderAssistant"), rendererSrc.indexOf("content.querySelectorAll(\"pre\")"));
    assert.ok(!/\.querySelectorAll\("a\[href\]"\)\.forEach/.test(rest), "renderAssistant 不应残留裸 querySelectorAll 链接循环");
  });

  await test("文件预览链接拦截收编到 bindExternalLinks", () => {
    const i = rendererSrc.indexOf("preview.innerHTML = html;");
    assert.ok(i >= 0, "preview 赋值段应存在");
    const seg = rendererSrc.slice(i, i + 400);
    assert.ok(/bindExternalLinks\(preview\)/.test(seg), "preview 段应改用 bindExternalLinks(preview)");
    const after = rendererSrc.slice(i, rendererSrc.indexOf("} catch", i));
    assert.ok(!/preview\.querySelectorAll\("a\[href\]"\)/.test(after), "preview 不应残留裸链接循环");
  });

  await test("根修①：设置页密钥提示 innerHTML 后重新绑定注册链接", () => {
    // v3.21.x 后 keyHint 赋值抽进 applyCloudProviderChange 函数（原在两 listener 之间）——改全局定位
    const i = rendererSrc.indexOf("keyHint.innerHTML = config.hint;");
    assert.ok(i >= 0, "应有 keyHint.innerHTML = config.hint;");
    const seg = rendererSrc.slice(i, i + 200);
    assert.ok(/bindExternalLinks\(keyHint\)/.test(seg), "innerHTML 赋值后必须 bindExternalLinks(keyHint)（漏接即窗口劫持）");
  });

  await test("根修②：静态初始提示（智谱注册链接）加载时接管", () => {
    assert.ok(rendererSrc.includes('bindExternalLinks(document.querySelector("#cloud-key-hint"));'), "页面加载时应对静态 #cloud-key-hint 接线");
    assert.ok(/bindExternalLinks\(document\.querySelector\("#cloud-key-hint"\)\);/.test(settingsBlock + rendererSrc), "静态接线应紧跟服务商 change 监听器注册");
  });

  await test("index.html 静态死链 href=\"#\" 换真实智谱注册地址", () => {
    assert.ok(indexSrc.includes('href="#" id="cloud-register-link"') === false, "不应再是 # 死链");
    assert.ok(indexSrc.includes("https://open.bigmodel.cn/user/apikey"), "应为智谱真实注册地址（与 renderer.js 智谱 hint 一致）");
  });

  await test("兜底①：main.cjs setWindowOpenHandler 拒开子窗口改系统浏览器", () => {
    assert.ok(navGuard.includes("setWindowOpenHandler"), "应有 setWindowOpenHandler");
    assert.ok(navGuard.includes('return { action: "deny" }'), "子窗口必须 deny");
    assert.ok(navGuard.includes("shell.openExternal(url)"), "url 应转交系统浏览器");
  });

  await test("兜底②：main.cjs will-navigate 拦外链走系统浏览器", () => {
    assert.ok(navGuard.includes('on("will-navigate"'), "应有 will-navigate 监听");
    assert.ok(navGuard.includes("event.preventDefault()"), "必须 preventDefault");
    assert.ok(navGuard.includes("shell.openExternal(url)"), "应转交系统浏览器");
    assert.ok(navGuard.includes("external_link_intercepted"), "应有日志埋点");
  });

  await test("兜底只拦 http/https——file:// 页面与锚点不受影响", () => {
    const hits = (navGuard.match(/\/\^https\?:\/i/g) || []).length;
    assert.ok(hits >= 2, `setWindowOpenHandler 与 will-navigate 均应按 ^https?: 判定（实际 ${hits} 处）`);
    assert.ok(!/test\("file:/.test(navGuard), "不应拦截 file://（防误伤自身页面/锚点导航）");
  });

  await test("openLink 的 IPC 接口未被破坏（preload link:open 通道仍在）", () => {
    const preload = fs.readFileSync(path.join(ROOT, "src", "main", "preload.cjs"), "utf8");
    assert.ok(preload.includes('ipcRenderer.invoke("link:open", url)'), "preload link:open 通道应保留");
  });

  await test("版本号 ≥3.15.7", () => {
    const parts = pkg.version.split(".").map(Number);
    const ok = parts[0] > 3 || (parts[0] === 3 && (parts[1] > 15 || (parts[0] === 3 && parts[1] === 15 && parts[2] >= 7)));
    assert.ok(ok, `版本号应为 ≥3.15.7，实际 ${pkg.version}`);
  });

  console.log(`\n${passed} 通过, ${failed} 失败`);
  if (failed) {
    console.log("\n失败项：");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

runTests().catch((error) => { console.error(error); process.exit(1); });