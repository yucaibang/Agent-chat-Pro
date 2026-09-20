#!/usr/bin/env node
"use strict";
// v3.12.2 设置中心重构测试（参照 Agent Orbit 截图：左导航 + 右内容）
// 导航三模块：连接设置 / 插件 / 关于；扩展功能（压缩/Bridge/联动/缓存）归入插件页
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}`);
  }
}

(async () => {
  console.log("── 设置中心结构（index.html）──");
  const html = read("src/renderer/index.html");
  check("左导航容器 settings-nav 存在", /class="settings-nav"/.test(html));
  check("导航三项：连接设置/插件/关于", /data-settings-tab="connection"/.test(html) && /data-settings-tab="plugins"/.test(html) && /data-settings-tab="about"/.test(html));
  check("三面板齐全", /data-settings-panel="connection"/.test(html) && /data-settings-panel="plugins"/.test(html) && /data-settings-panel="about"/.test(html));
  check("connection 面板默认 active", /class="settings-panel active" data-settings-panel="connection"/.test(html));
  check("plugins/about 面板默认隐藏", /data-settings-panel="plugins" hidden/.test(html) && /data-settings-panel="about" hidden/.test(html));
  check("close-settings 移入 settings-body（settings-close 类）", /class="close-button settings-close" id="close-settings"/.test(html));
  check("settings-layout/settings-body 壳存在", /class="settings-layout"/.test(html) && /class="settings-body"/.test(html));

  console.log("── 插件页归属（四个扩展功能块移入 plugins 面板）──");
  const panelStart = html.indexOf('data-settings-panel="plugins"');
  const panelEnd = html.indexOf('data-settings-panel="about"');
  check("面板顺序：plugins 在 connection 之后、about 之前", panelStart > 0 && panelStart < panelEnd);
  for (const id of ["compact-settings", "bridge-settings", "device-control-settings", "cache-settings"]) {
    const pos = html.indexOf(`<details id="${id}"`);
    check(`${id} 在 plugins 面板内`, pos > panelStart && pos < panelEnd);
  }
  check("插件页空态提示在位", /更多插件能力规划中/.test(html));

  console.log("── 关于页内容 ──");
  check("about-hero/logo/title/tagline", /about-hero/.test(html) && /about-logo/.test(html) && /about-title/.test(html) && /about-tagline/.test(html));
  check("版本占位（运行时填充）", /id="about-version"/.test(html));
  check("作者与沿革", /jiang1688/.test(html) && /项目沿革/.test(html));

  console.log("── 渲染层交互（renderer.js）──");
  const renderer = read("src/renderer/renderer.js");
  check("switchSettingsTab 切换 active + hidden", /function switchSettingsTab\(tab\)/.test(renderer) && /panel\.hidden = panel\.dataset\.settingsPanel !== tab/.test(renderer));
  check("导航点击绑定", /data-settings-tab\]"\)\.forEach/.test(renderer));
  check("关于页版本填充（fillAboutVersion）", /fillAboutVersion/.test(renderer) && /#about-version/.test(renderer));
  check("菜单「关于」打开设置中心并切 about 页", /dataset\.windowAction === "about"/.test(renderer) && /switchSettingsTab\("about"\)/.test(renderer));

  console.log("── 版本 IPC 通道 ──");
  const preload = read("src/main/preload.cjs");
  const main = read("src/main/main.cjs");
  check("preload 暴露 getAppVersion", /getAppVersion: \(\) => ipcRenderer\.invoke\("app:version"\)/.test(preload));
  check("main 提供 app:version handler", /ipcMain\.handle\("app:version", \(\) => app\.getVersion\(\)\)/.test(main));

  console.log("── 样式（styles.css）──");
  const css = read("src/renderer/styles.css");
  check("布局/导航/胶囊选中样式", /\.settings-layout/.test(css) && /\.settings-nav-item\.active/.test(css));
  check("settings-body 滚动 + dialog 溢出收窄", /\.settings-body \{ position: relative; flex: 1; min-width: 0; overflow-y: auto/.test(css) && /#settings-dialog \{ width: min\(880px/.test(css));
  check("关于页样式", /\.about-hero/.test(css) && /\.about-info/.test(css));
  check("亮色主题适配", /\[data-theme="light"\] \.settings-nav-item\.active/.test(css));

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error("测试执行失败：", error);
  process.exit(1);
});