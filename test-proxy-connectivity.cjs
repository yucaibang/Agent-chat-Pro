#!/usr/bin/env node
"use strict";
// v3.7.3 代理连通性测试 — 断言 testProxyConnectivity 行为 + 全链路接线（cloud-chat → main → preload → HTML → renderer → CSS）
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { testProxyConnectivity } = require("./src/main/cloud-chat.cjs");

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
  console.log("── 单元用例 ──");
  let r = await testProxyConnectivity({ enabled: false, host: "127.0.0.1", port: 7890 });
  check("未启用代理 → ok:false", r.ok === false);
  check("未启用代理 → 提示启用", /未启用/.test(r.error || ""));
  check("结果含 latencyMs", typeof r.latencyMs === "number");

  r = await testProxyConnectivity({ enabled: true, host: "127.0.0.1", port: 0 });
  check("缺端口 → ok:false", r.ok === false);

  r = await testProxyConnectivity({ enabled: true, host: "127.0.0.1", port: 1 });
  check("拒绝连接 → ok:false", r.ok === false);
  check("拒绝连接 → ECONNREFUSED 中文提示", /拒绝连接.*ECONNREFUSED/.test(r.error || ""));
  check("拒绝连接 → 快速失败（<5s）", r.latencyMs < 5000);

  console.log("── cloud-chat.cjs ──");
  const cloud = read("src/main/cloud-chat.cjs");
  check("导出 testProxyConnectivity", /module\.exports = \{[^}]*testProxyConnectivity/.test(cloud));
  check("测试 URL 使用轻量 204 端点", /generate_204/.test(cloud));
  check("407 认证失败单独提示", /407/.test(cloud));
  check("10 秒超时常量", /PROXY_TEST_TIMEOUT_MS = 10000/.test(cloud));

  console.log("── main.cjs ──");
  const main = read("src/main/main.cjs");
  check("main 引入 testProxyConnectivity", /testProxyConnectivity[^;]*require\("\.\/cloud-chat\.cjs"\)/.test(main));
  check("main 注册 chat:test-proxy", /ipcMain\.handle\("chat:test-proxy"/.test(main));
  check("main 用 writeLog 记录且不记凭据", /writeLog\("proxy_test"/.test(main) && !/proxy_test.*password/.test(main));
  check("main 表单密码留空时用已保存密码兜底", /cloudConfig\?\.proxy\?\.password/.test(main));

  console.log("── preload.cjs ──");
  const preload = read("src/main/preload.cjs");
  check("preload 暴露 testProxy → chat:test-proxy", /testProxy: \(proxyConfig\) => ipcRenderer\.invoke\("chat:test-proxy"/.test(preload));

  console.log("── renderer ──");
  const html = read("src/renderer/index.html");
  check("HTML 测试按钮 #proxy-test", /id="proxy-test"/.test(html));
  check("HTML 结果行 #proxy-test-result", /id="proxy-test-result"/.test(html));

  const renderer = read("src/renderer/renderer.js");
  check("renderer 绑定 #proxy-test 点击事件", /\#proxy-test"\)\?\.addEventListener\("click"/.test(renderer));
  check("renderer 调用 agentChatPro.testProxy", /agentChatPro\.testProxy\(/.test(renderer));
  check("renderer 测试中禁用按钮防重复点击", /button\.disabled = true;/.test(renderer));

  const css = read("src/renderer/styles.css");
  check("CSS 测试按钮样式", /\.proxy-test-btn/.test(css));
  check("CSS 结果成功/失败色", /\.proxy-test-result\.ok/.test(css) && /\.proxy-test-result\.fail/.test(css));

  console.log(`\n结果：${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
})().catch((error) => {
  console.error("测试异常:", error);
  process.exit(1);
});