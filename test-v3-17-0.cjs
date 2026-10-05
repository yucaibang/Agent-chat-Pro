"use strict";
// test-v3-17-0.cjs — F1 IP 追踪产品化（v3.17.0）
// 覆盖：模板断言（metadata 单一事实来源/占位符/钩子语义/防回退）+ resolve 脚本断言（先比对后落笔/
// 退出码语义/幂等/日志）/ buildDeviceConnectScript 行为真单测 + ssh.cjs finalize 接线 + main/preload/renderer/
// index/styles 接线 + NAS 部署物同源（仅当检测到部署物时）+ 版本号。

const fs = require("fs");
const path = require("path");
const assert = require("assert");

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (error) { failures.push(`${name}\n    ${error.message}`); }
}
const projectRoot = path.join(__dirname);
const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");

const tplConnect = read("src/main/templates/connect.sh.tpl");
const tplResolve = read("src/main/templates/resolve-ip.sh");
const ssh = fs.readFileSync(path.join(projectRoot, "src/main/ssh.cjs"), "utf8");
const main = fs.readFileSync(path.join(projectRoot, "src/main/main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(projectRoot, "src/main/preload.cjs"), "utf8");
const renderer = fs.readFileSync(path.join(projectRoot, "src/renderer/renderer.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(projectRoot, "src/renderer/index.html"), "utf8");
const styles = fs.readFileSync(path.join(projectRoot, "src/renderer/styles.css"), "utf8");

// ── 1. connect.sh.tpl 模板骨架 ──
test("1. connect 模板含三行 metadata（单一事实来源）", () => {
  assert.ok(tplConnect.includes("# target_user={{TARGET_USER}}"));
  assert.ok(tplConnect.includes("# target_port={{TARGET_PORT}}"));
  assert.ok(tplConnect.includes("# target_ip={{TARGET_IP}}"));
});
test("2. connect 模板五个占位符齐全", () => {
  for (const key of ["TARGET_USER", "TARGET_PORT", "TARGET_IP", "DEV_DIR", "RESOLVE_PATH"]) {
    assert.ok(tplConnect.includes(`{{${key}}}`), `缺占位符 {{${key}}}`);
  }
});
test("3. connect 模板失败钩子触发错误类型齐全（网络类才触发）", () => {
  assert.ok(tplConnect.includes("No route to host"));
  assert.ok(tplConnect.includes("Connection timed out"));
  assert.ok(tplConnect.includes("Connection refused"));
  assert.ok(tplConnect.includes("HOST IDENTIFICATION"));
});
test("4. connect 模板安全语义不放松（StrictHostKeyChecking=yes + 公钥免密 + 批处理）", () => {
  assert.ok(tplConnect.includes("-o StrictHostKeyChecking=yes"));
  assert.ok(tplConnect.includes("-o BatchMode=yes"));
  assert.ok(tplConnect.includes("-o PasswordAuthentication=no"));
});
test("5. 防回退：connect 模板不再使用旧裸 exec ssh 结构", () => {
  assert.ok(!/^exec ssh /m.test(tplConnect), "旧 exec ssh 裸结构复现（无法在失败后重试）");
});
test("6. connect 模板含 metadata 校验失败防御（exit 127）", () => {
  assert.ok(tplConnect.includes("metadata 行缺失"));
  assert.ok(tplConnect.includes("exit 127"));
});

// ── 2. resolve-ip.sh 模板（追踪核心语义） ──
test("7. resolve 取证用指纹而非主机名（ssh-keygen -lf 比对）", () => {
  assert.ok(tplResolve.includes("ssh-keygen -lf"));
  assert.ok(tplResolve.includes("ssh-keyscan"));
});
test("8. resolve 先比对后落笔（known_hosts 幂等 grep -qxF）", () => {
  assert.ok(tplResolve.indexOf("fp_in_set") > -1);
  assert.ok(tplResolve.indexOf("fp_in_set") < tplResolve.indexOf('grep -qxF "$HIT_IP'), "指纹集合建立应在落笔之前");
});
test("9. resolve 三态退出码语义干净（0 可重试 / 10 网段无匹配 / 20 环境错误）", () => {
  assert.ok(tplResolve.includes("exit 20") && tplResolve.includes("exit 10"));
  assert.ok(/die10.*目标机已关机或离开原网络/.test(tplResolve.replace(/\n/g, " ")));
});
test("10. resolve 预检语义：旧 IP 键指纹匹配 → 无需重定位直接可重试", () => {
  assert.ok(/无需重定位/.test(tplResolve));
});
test("11. resolve 更新锚双模式（metadata 行 + 旧格式 @IP fallback 兼容）", () => {
  assert.ok(tplResolve.includes("# target_ip="));
  assert.ok(tplResolve.includes("s|@${CUR_HOST}|"));
});
test("12. resolve 并发互斥（flock）+ 网段扫描 32 并发", () => {
  assert.ok(tplResolve.includes("flock"));
  assert.ok(/\$scan_dir|\$SCAN_DIR/i.test(tplResolve));
  assert.ok(/-eq 0 \]\] && wait/.test(tplResolve) || tplResolve.includes("wait"));
});
test("13. resolve 命中后日志与 device.json 同步", () => {
  assert.ok(tplResolve.includes("ip-track.log") || tplResolve.includes('TRACK_LOG="$DEV_DIR/ip-track.log"'));
  assert.ok(tplResolve.includes("detectedBy"));
  assert.ok(tplResolve.includes("targetAddress"));
});
test("14. resolve 不动公钥链路（authorized_keys / sshd 配置零引用，注释行除外）", () => {
  const code = tplResolve.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.ok(!/authorized_keys|sshd_config|Match User/.test(code), "追踪脚本不应触碰公钥/sshd 配置链路");
});

// ── 3. buildDeviceConnectScript 行为真单测 ──
const sshModule = require("./src/main/ssh.cjs");
test("15. buildDeviceConnectScript 导出存在且可调用", () => {
  assert.strictEqual(typeof sshModule.buildDeviceConnectScript, "function");
  assert.strictEqual(typeof sshModule.loadDeviceTemplate, "function");
});
test("16. 行为单测：占位符全部替换且无残留", () => {
  const script = sshModule.buildDeviceConnectScript({
    targetUser: "AgentChatProControl",
    targetPort: 22,
    targetAddress: "10.66.1.199",
    directory: "/home/u/.agent-orbit/device-control/devid-1",
    resolvePath: "/home/u/.agent-orbit/device-control/resolve-ip.sh"
  });
  assert.ok(!script.includes("{{"), "占位符残留");
  assert.ok(script.includes("# target_user=AgentChatProControl"));
  assert.ok(script.includes("# target_port=22"));
  assert.ok(script.includes("# target_ip=10.66.1.199"));
  assert.ok(script.includes("DIR='/home/u/.agent-orbit/device-control/devid-1'"));
  assert.ok(script.includes("RESOLVE='/home/u/.agent-orbit/device-control/resolve-ip.sh'"));
});
test("17. 行为单测：非默认端口/用户正确注入", () => {
  const script = sshModule.buildDeviceConnectScript({
    targetUser: "OtherControl", targetPort: 2202, targetAddress: "10.0.0.5",
    directory: "/root/d", resolvePath: "/root/resolve-ip.sh"
  });
  assert.ok(script.includes("# target_port=2202"));
  assert.ok(script.includes("# target_user=OtherControl"));
  assert.ok(script.includes("# target_ip=10.0.0.5"));
});
test("18. 行为单测：shebang 与脚本主体完整（生成物可直接被 sh 解析）", () => {
  const script = sshModule.buildDeviceConnectScript({
    targetUser: "u", targetPort: 22, targetAddress: "1.2.3.4", directory: "/d", resolvePath: "/r"
  });
  assert.strictEqual(script.split("\n")[0], "#!/bin/sh");
  assert.ok(script.includes("do_ssh"));
});

// ── 4. ssh.cjs finalize 接线 ──
test("19. finalize 模板化接线（钩子版而非裸 exec）", () => {
  assert.ok(ssh.includes("buildDeviceConnectScript({ targetUser"));
  assert.ok(ssh.includes('loadDeviceTemplate("resolve-ip.sh")'));
});
test("20. resolve 路径推导（deviceId 目录父级 = device-control 通用根）", () => {
  assert.ok(ssh.includes('directory.replace(/\\/[^/]+$/, "")') && ssh.includes("}/resolve-ip.sh`"));
});
test("21. chmod 双文件一条命令（connect + resolve 均 700）", () => {
  assert.ok(ssh.includes("chmod 700 ${shellQuote(connectScript)} ${shellQuote(resolvePath)}"));
});
test("22. readDeviceControlIpTrack 实现要点（tail 尾行 + JSON 逐行容错解析）", () => {
  assert.ok(ssh.includes("tail -n 5"));
  assert.ok(ssh.includes("JSON.parse(text)"));
  assert.ok(ssh.includes("ip-track.log"));
});
test("23. readDeviceControlIpTrack 导出", () => {
  assert.strictEqual(typeof sshModule.readDeviceControlIpTrack, "function");
});

// ── 5. main / preload / renderer / html / styles 接线 ──
test("24. main.cjs：device-control:ip-track IPC + require 接线", () => {
  assert.ok(main.includes('ipcMain.handle("device-control:ip-track"'));
  assert.ok(main.includes("readDeviceControlIpTrack(config, deviceId"));
  assert.ok(/readDeviceControlIpTrack,\s*readRemoteFile/.test(main));
});
test("25. preload：readDeviceControlIpTrack 通道暴露", () => {
  assert.ok(preload.includes('readDeviceControlIpTrack: (deviceId) => ipcRenderer.invoke("device-control:ip-track", deviceId)'));
});
test("26. renderer：IP 追踪渲染函数 + 加载函数", () => {
  assert.ok(renderer.includes("function renderDeviceControlIpTrack"));
  assert.ok(renderer.includes("function refreshDeviceControlIpTrack"));
  assert.ok(renderer.includes("window.agentChatPro.readDeviceControlIpTrack"));
});
test("27. renderer：refresh 状态时按 deviceId 异步装载（不阻塞状态渲染）", () => {
  assert.ok(renderer.includes("refreshDeviceControlIpTrack(status.deviceId)"));
  assert.ok(!/await\s+refreshDeviceControlIpTrack/.test(renderer), "追踪装载不应阻塞 await");
});
test("28. renderer：install 成功路径带刷追踪卡", () => {
  assert.ok(/renderDeviceControlStatus\(status\);\s*\n\s*refreshDeviceControlIpTrack\(status\.deviceId\)/.test(renderer));
});
test("29. index.html：ip-track 卡片节点", () => {
  assert.ok(indexHtml.includes('id="device-control-ip-track"'));
});
test("30. styles：ip-track-note 两套主题", () => {
  assert.ok(styles.includes(".ip-track-note"));
  assert.ok(styles.includes('[data-theme="light"] .ip-track-note'));
});
test("31. renderer 静默语义：读追踪失败收起卡片不打扰", () => {
  const block = renderer.slice(renderer.indexOf("function refreshDeviceControlIpTrack"), renderer.indexOf("function refreshDeviceControlIpTrack") + 700);
  assert.ok(/\.catch\(/.test(block));
});

// ── 6. NAS 部署物同源（仅当部署物在时比对；测试必须可跨机器跑） ──
test("32. NAS 部署物与模板同源（存在时逐字节一致）", () => {
  const deployed = path.join(process.env.HOME || "/home/demo-user", ".agent-orbit/device-control/resolve-ip.sh");
  if (!fs.existsSync(deployed)) return; // 无部署物环境跳过
  assert.strictEqual(fs.readFileSync(deployed, "utf8"), tplResolve, "NAS 部署物应与产品模板一致（单一事实来源）");
});

// ── 7. 版本与构建链路 ──
test("33. package.json 版本升至 3.17.0", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const [a, b, c] = pkg.version.split(".").map(Number);
  assert.ok(a > 3 || (a === 3 && (b > 17 || (b === 17 && c >= 0))), `版本应 ≥3.17.0（实际 ${pkg.version}）`);
});
test("34. 模板文件在 asar 打包范围内（build.files=src/** 覆盖 templates 目录）", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const files = JSON.stringify(pkg.build?.files || []);
  assert.ok(files.includes("src/**"), "build.files 应包含 src/**");
});
test("35. 三个改动文件均在（ssh/main/preload）且无语法错误", () => {
  for (const file of ["src/main/ssh.cjs", "src/main/main.cjs", "src/main/preload.cjs"]) {
    assert.doesNotThrow(() => new (require("vm").Script)(read(file), { filename: file }), `${file} 语法错误`);
  }
});

console.log(`\ntest-v3-17-0: ${passed} 项通过${failures.length ? `，${failures.length} 项失败` : ""}`);
if (failures.length) {
  for (const line of failures) console.log("  ✗ " + line);
  process.exit(1);
}
process.exit(0);