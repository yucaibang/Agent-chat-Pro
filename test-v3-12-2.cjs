#!/usr/bin/env node
"use strict";
// v3.12.2 设置中心重构测试（参照 Agent Orbit 截图：左导航 + 右内容）
// v3.12.4 模块重整：五导航页 = 连接设置 / 插件(压缩+Bridge) / 设备联动 / 缓存清理 / 关于
// v3.12.4 修复：面板 hidden 与 .active 同步切换（修复除默认页外全部空白的 bug）
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
  check("导航五项：连接设置/插件/设备联动/缓存清理/关于", ["connection", "plugins", "device", "cache", "about"].every((t) => html.includes(`data-settings-tab="${t}"`)));
  check("五面板齐全", ["connection", "plugins", "device", "cache", "about"].every((t) => html.includes(`data-settings-panel="${t}"`)));
  check("connection 面板默认 active", /class="settings-panel active" data-settings-panel="connection"/.test(html));
  check("其余四面板默认隐藏（hidden 属性）", ["plugins", "device", "cache", "about"].every((t) => new RegExp(`data-settings-panel="${t}" hidden`).test(html)));
  check("close-settings 移入 settings-body（settings-close 类）", /class="close-button settings-close" id="close-settings"/.test(html));
  check("settings-layout/settings-body 壳存在", /class="settings-layout"/.test(html) && /class="settings-body"/.test(html));

  console.log("── 模块归属（v3.12.4 重整：插件页只留聊天链路增强）──");
  const panelStart = html.indexOf('data-settings-panel="plugins"');
  const panelDevice = html.indexOf('data-settings-panel="device"');
  const panelCache = html.indexOf('data-settings-panel="cache"');
  const panelEnd = html.indexOf('data-settings-panel="about"');
  check("面板顺序：plugins < device < cache < about", panelStart > 0 && panelStart < panelDevice && panelDevice < panelCache && panelCache < panelEnd);
  for (const id of ["compact-settings", "bridge-settings"]) {
    const pos = html.indexOf(`<details id="${id}"`);
    check(`${id} 归入插件页`, pos > panelStart && pos < panelDevice);
  }
  {
    const pos = html.indexOf(`<details id="device-control-settings"`);
    check("device-control-settings 归入设备联动页", pos > panelDevice && pos < panelCache);
  }
  {
    const pos = html.indexOf(`<details id="cache-settings"`);
    check("cache-settings 归入缓存清理页", pos > panelCache && pos < panelEnd);
  }
  check("插件页空态提示在位", /更多插件能力规划中/.test(html));

  console.log("── 关于页内容 ──");
  check("about-hero/logo/title/tagline", /about-hero/.test(html) && /about-logo/.test(html) && /about-title/.test(html) && /about-tagline/.test(html));
  check("版本占位（运行时填充）", /id="about-version"/.test(html));
  check("作者与沿革", /jiang1688/.test(html) && /项目沿革/.test(html));

  console.log("── 渲染层交互（renderer.js）──");
  const renderer = read("src/renderer/renderer.js");
  check("switchSettingsTab 同步切换 active class + hidden（v3.12.4 修复）", /function switchSettingsTab\(tab\)/.test(renderer) && /panel\.classList\.toggle\("active", active\)/.test(renderer) && /panel\.hidden = !active/.test(renderer));
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
  check("双显示模型共存：[hidden]!important 与 .settings-panel.active（v3.12.4 回归基线）", /\[hidden\] \{ display: none !important; \}/.test(css) && /\.settings-panel\.active \{ display: block/.test(css));
  check("settings-body 滚动 + dialog 溢出收窄", /\.settings-body \{ position: relative; flex: 1; min-width: 0; overflow-y: auto/.test(css) && /#settings-dialog \{ width: min\(880px/.test(css));
  check("关于页样式", /\.about-hero/.test(css) && /\.about-info/.test(css));
  check("亮色主题适配", /\[data-theme="light"\] \.settings-nav-item\.active/.test(css));

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error("测试执行失败：", error);
  process.exit(1);
});