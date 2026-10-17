"use strict";
/**
 * v3.23.0 测试 — N2N 体检 + 一键部署（检测哪坏、缺哪补哪、stderr 上屏）
 * 背景：v3.22.0 之前 edge 缺环境只报一句「未找到 n2n edge 命令」；2026-10-07 实锤
 *   NAS 侧根因（n2n-supernode 容器 Exited(137) 挂 6 天）——体检把「supernode 公网入口」
 *   连通性纳入检测，用户可自判故障侧（本机 / NAS 侧 / 网络路由）。
 * 覆盖：n2n-doctor 真/mock 单测（平台早退 + win32 分支 + probeTcp 本机真测）+
 *       n2n-mesh 绝对路径兜底真单测（PATH ENOENT → C:\n2n\edge.exe 重试）+
 *       main/preload/renderer/index.html 接线断言 + 内嵌资产断言 +
 *       vm 假 DOM 全量求值冒烟（renderer 改动必过）+ 版本。
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const Module = require("module");
const os = require("os");
const net = require("net");
const events = require("events");
const realChildProcess = require("child_process");

const ROOT = __dirname;
const DOCTOR_PATH = path.join(ROOT, "src", "main", "network", "n2n-doctor.cjs");
const MESH_PATH = path.join(ROOT, "src", "main", "network", "n2n-mesh.cjs");
const MAIN_PATH = path.join(ROOT, "src", "main", "main.cjs");
const PRELOAD_PATH = path.join(ROOT, "src", "main", "preload.cjs");
const RENDERER_PATH = path.join(ROOT, "src", "renderer", "renderer.js");
const HTML_PATH = path.join(ROOT, "src", "renderer", "index.html");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const N2N_ASSET_DIR = path.join(ROOT, "build", "n2n");

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

const doctorSrc = fs.readFileSync(DOCTOR_PATH, "utf8");
const meshSrc = fs.readFileSync(MESH_PATH, "utf8");
const mainSrc = fs.readFileSync(MAIN_PATH, "utf8");
const preloadSrc = fs.readFileSync(PRELOAD_PATH, "utf8");
const rendererSrc = fs.readFileSync(RENDERER_PATH, "utf8");
const htmlSrc = fs.readFileSync(HTML_PATH, "utf8");
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

/** 临时切 platform（体检/部署的 win32 分支在 Linux 上必须借此真跑） */
function withPlatform(value, fn) {
  return () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value, configurable: true });
    return Promise.resolve().then(fn).finally(() => {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    });
  };
}

/** fake PowerShell/安装器 子进程（events.EventEmitter 伪装 ChildProcess） */
function makeFakeChild() {
  const child = new events.EventEmitter();
  child.stdout = new events.EventEmitter();
  child.stderr = new events.EventEmitter();
  child.pid = 4321;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

/** mock spawn 加载阶段：powershell.exe / .exe 安装器走脚本，其余转发原版 */
function loadDoctorWithMocks({ powershellScript, installerScript, edgeExists = false } = {}) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return { app: { isPackaged: false, getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3230-")) } };
    }
    if (request === "child_process") {
      return {
        ...realChildProcess,
        spawn: (exe, args, opts) => {
          const commandText = Array.isArray(args) ? String(args[args.length - 1] || "") : "";
          if (typeof powershellScript === "function" && exe === "powershell.exe") {
            const scripted = powershellScript(commandText, args) || {};
            const child = makeFakeChild();
            setImmediate(() => {
              if (scripted.stdout) child.stdout.emit("data", Buffer.from(scripted.stdout));
              if (scripted.stderr) child.stderr.emit("data", Buffer.from(scripted.stderr));
              child.emit("close", scripted.code ?? 0);
            });
            return child;
          }
          if (typeof installerScript === "function" && String(exe).endsWith(".exe")) {
            const scripted = installerScript(exe, args) || {};
            const child = makeFakeChild();
            setImmediate(() => {
              if (scripted.stderr) child.stderr.emit("data", Buffer.from(scripted.stderr));
              child.emit("close", scripted.code ?? 0);
            });
            return child;
          }
          return realChildProcess.spawn(exe, args, opts);
        }
      };
    }
    if (request === "fs") {
      return {
        __proto__: fs,
        existsSync: (filePath) => {
          if (/n2n/i.test(String(filePath)) && /edge\.exe/i.test(String(filePath))) return edgeExists;
          return fs.existsSync(filePath);
        }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  const doctor = require(DOCTOR_PATH);
  Module._load = originalLoad;
  return doctor;
}

// ── A 组：Linux 真跑（体检平台早退 / probeTcp 本机真测 / 部署拒绝）──

async function runLinuxRealTests() {
  const doctorReal = require(DOCTOR_PATH);

  await test("A1 体检（本机 Linux 真跑）：平台 fail + 其余 skip + ok=false + nextAction 指引", async () => {
    const items = [];
    const result = await doctorReal.runN2nDoctor({}, (item) => items.push(item));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(items.length, 5, `应恰好 5 项，实际 ${items.length}`);
    assert.strictEqual(items[0].id, "platform");
    assert.strictEqual(items[0].level, "fail");
    const skipped = items.slice(1);
    assert.ok(skipped.every((item) => item.level === "skip"), "非 Windows 其余项应全部 skip");
    assert.ok(result.nextAction.includes("仅支持 Windows"), `nextAction 应指向平台不支持：${result.nextAction}`);
  });

  await test("A2 probeTcp 本机真测：监听端口 true / 关闭后 false / 超时参数生效", async () => {
    const server = net.createServer(() => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const ok = await doctorReal.probeTcp("127.0.0.1", port, 2000);
    assert.strictEqual(ok, true, "监听端口应连通");
    server.close();
    await new Promise((resolve) => server.close(resolve));
    const refused = await doctorReal.probeTcp("127.0.0.1", port, 2000);
    assert.strictEqual(refused, false, "关闭后应拒绝");
    const timedOut = await doctorReal.probeTcp("127.0.0.1", 1, 800);
    assert.strictEqual(timedOut, false, "拒绝/无服务应返回 false");
  });

  await test("A3 部署（本机 Linux）：直接拒绝仅支持 Windows", async () => {
    const lines = [];
    await assert.rejects(
      () => doctorReal.runN2nDeploy({}, (line) => lines.push(line)),
      /仅支持 Windows/
    );
    assert.ok(lines.length === 0, "拒绝前不应有日志（平台检查最前）");
  });
}

// ── B 组：win32 分支 mock 真单测（platform 切换 + fake powershell 脚本）──

/** 标准 powershell 脚本：快照命令（真命令串含 IsInRole）按场景回放 */
function snapshotScript({ admin = "True", tapDesc = "TAP-Windows Adapter V9", edgePath = "" } = {}) {
  return (commandText) => {
    if (/IsInRole/.test(commandText)) {
      return { code: 0, stdout: `===A===\r\n${admin}\r\n===T===\r\n${tapDesc}\r\n===P===\r\n${edgePath}\r\n` };
    }
    if (/Expand-Archive/.test(commandText)) return { code: 0, stdout: "" };
    if (/GetEnvironmentVariable\('Path'/.test(commandText)) return { code: 0, stdout: "written" };
    if (/Out-String/.test(commandText)) return { code: 0, stdout: "Usage: edge [OPTION...]\n" };
    return { code: 0, stdout: "" };
  };
}

async function runWin32MockTests() {
  await withPlatform("win32", async () => {
    await test("B1 体检 win32：快照解析（admin/描述/PATH 路径）+ edge 已装且 PATH 可见 → ok", async () => {
      const doctor = loadDoctorWithMocks({ powershellScript: snapshotScript({ edgePath: "C:\\n2n\\EDGE.EXE" }), edgeExists: true });
      const items = [];
      const result = await doctor.runN2nDoctor({ n2n: { supernodeAddr: "127.0.0.1", supernodePort: 53371 } }, (item) => items.push(item));
      assert.strictEqual(items.length, 5, `应 5 项，实际 ${items.length}`);
      assert.strictEqual(items[0].level, "ok", "win32 平台应 ok");
      const edge = items.find((item) => item.id === "edge");
      assert.strictEqual(edge.level, "ok");
      assert.ok(/已安装且 PATH 可见/.test(edge.detail), `edge 详情：${edge.detail}`);
      assert.strictEqual(items.find((item) => item.id === "tap").level, "ok");
      assert.strictEqual(items.find((item) => item.id === "admin").level, "ok");
      // 127.0.0.1:53371 未监听 → fail（probeTcp 真探测）
      assert.strictEqual(items.find((item) => item.id === "supernode").level, "fail");
      assert.strictEqual(result.ok, false);
      assert.ok(result.nextAction.includes("一键部署") || result.nextAction.includes("supernode"), `nextAction：${result.nextAction}`);
    });

    await test("B2 体检 edge 落盘在 PATH 不可见 → ok 文案含绝对路径兜底说明", async () => {
      const doctor = loadDoctorWithMocks({ powershellScript: snapshotScript({ tapDesc: "TAP-Windows Adapter", edgePath: "" }), edgeExists: true });
      const items = [];
      await doctor.runN2nDoctor({}, (item) => items.push(item));
      const edge = items.find((item) => item.id === "edge");
      assert.strictEqual(edge.level, "ok");
      assert.ok(/无需重启即可使用/.test(edge.hint), `兜底说明应出现：${edge.hint}`);
    });

    await test("B3 体检 edge 未装 → fail + hint 指向一键部署", async () => {
      const doctor = loadDoctorWithMocks({ powershellScript: snapshotScript(), edgeExists: false });
      const items = [];
      const result = await doctor.runN2nDoctor({}, (item) => items.push(item));
      const edge = items.find((item) => item.id === "edge");
      assert.strictEqual(edge.level, "fail");
      assert.ok(/一键部署/.test(edge.hint), `hint：${edge.hint}`);
      assert.strictEqual(result.ok, false);
    });

    await test("B4 部署全绿流程：资源→解压(已存在跳过)→TAP(已有)→PATH→自检→公网复测", async () => {
      const doctor = loadDoctorWithMocks({
        powershellScript: snapshotScript({ admin: "True", tapDesc: "TAP-Windows Adapter V9", edgePath: "" }),
        edgeExists: true
      });
      const lines = [];
      const result = await doctor.runN2nDeploy({}, (line) => lines.push(line));
      assert.strictEqual(lines.length > 0, true, "应有步进日志上屏");
      assert.ok(lines[0].includes("一键部署开始"), `首行应开始标记：${lines[0]}`);
      assert.ok(lines.some((l) => /步骤 1\/6/.test(l)), "应含步骤 1/6");
      assert.ok(lines.some((l) => /步骤 6\/6/.test(l)), "应含步骤 6/6");
      assert.ok(lines.some((l) => l.includes("已存在，跳过解压")), "edge 已装应跳过解压");
      assert.ok(lines.some((l) => l.includes("TAP 驱动已安装")), "TAP 已装应跳过");
      assert.ok(result.ok, `部署应全绿，summary：${JSON.stringify(result.summary)}`);
    });

    await test("B5 部署 TAP 缺失（管理员）：静默安装后复检成功", async () => {
      let powershellCalls = 0;
      const doctor = loadDoctorWithMocks({
        powershellScript: (commandText) => {
          powershellCalls++;
          if (/IsInRole/.test(commandText)) {
            // 前 4 次快照无 TAP，第 5 次起（安装后复检）报出
            const tapDesc = powershellCalls >= 5 ? "TAP-Windows Adapter V9" : "";
            return { code: 0, stdout: `===A===\r\nTrue\r\n===T===\r\n${tapDesc}\r\n===P===\r\n\r\n` };
          }
          if (/Expand-Archive/.test(commandText)) return { code: 0, stdout: "" };
          if (/GetEnvironmentVariable\('Path'/.test(commandText)) return { code: 0, stdout: "written" };
          if (/Out-String/.test(commandText)) return { code: 0, stdout: "Usage:\n" };
          return { code: 0, stdout: "" };
        },
        installerScript: () => ({ code: 0 }),
        edgeExists: true
      });
      const lines = [];
      const result = await doctor.runN2nDeploy({}, (line) => lines.push(line));
      assert.ok(lines.some((l) => /静默安装/.test(l)), `应走静默安装：${lines.join("\n")}`);
      assert.ok(result.ok, "TAP 静默安装后应成功");
    });

    await test("B6 部署 TAP 缺失（非管理员）：UAC 取消 → 中止 + 中文取消提示", async () => {
      let calls = 0;
      const doctor = loadDoctorWithMocks({
        powershellScript: (commandText) => {
          calls++;
          if (/IsInRole/.test(commandText)) {
            const tapDesc = calls >= 5 ? "TAP" : "";
            return { code: 0, stdout: `===A===\r\nFalse\r\n===T===\r\n${tapDesc}\r\n===P===\r\n\r\n` };
          }
          return { code: 0, stdout: "" };
        },
        installerScript: () => ({ code: 1223 }),
        edgeExists: true
      });
      const lines = [];
      const result = await doctor.runN2nDeploy({}, (line) => lines.push(line));
      assert.strictEqual(result.ok, false);
      assert.ok(lines.some((l) => /已取消管理员授权/.test(l)), `UAC 取消提示应在：${lines.join("\n")}`);
    });

    await test("B7 部署解压失败：中文错误 + 不再继续后续步骤", async () => {
      const doctor = loadDoctorWithMocks({
        powershellScript: (commandText) => {
          if (/Expand-Archive/.test(commandText)) return { code: 1, stderr: "路径不存在", stdout: "" };
          return { code: 0, stdout: "" };
        },
        edgeExists: false
      });
      const lines = [];
      const result = await doctor.runN2nDeploy({}, (line) => lines.push(line));
      assert.strictEqual(result.ok, false);
      assert.ok(lines.some((l) => /解压失败/.test(l)), `解压失败行：${lines.join("\n")}`);
      assert.ok(!lines.some((l) => /步骤 3\/6/.test(l)), "解压失败后不应进入 TAP 步");
    });

    await test("B8 probeTcp 默认入口真实探测（entry.example.org 不在 payload 时回落默认）", async () => {
      const doctor = loadDoctorWithMocks({ powershellScript: snapshotScript({ edgePath: "C:\\n2n\\edge.exe" }), edgeExists: true });
      const doctorOk = await doctor.runN2nDoctor({ n2n: { supernodeAddr: "", supernodePort: "" } }, () => {});
      const supernode = doctorOk.items.find((item) => item.id === "supernode");
      assert.ok(supernode.detail.includes(doctor.DEFAULT_SUPERNODE.addr), `空 payload 应回落默认入口：${supernode.detail}`);
    });
  });
}

// ── C 组：n2n-mesh 绝对路径兜底真单测 ──

async function runMeshFallbackTests() {
  const spawnCalls = [];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "child_process") {
      return {
        ...realChildProcess,
        spawn: (exe, args, opts) => {
          spawnCalls.push({ exe, args: [...(args || [])] });
          const child = makeFakeChild();
          setImmediate(() => {
            if (exe === "edge") {
              // PATH 方式：模拟 ENOENT（spawn 失败走 error 事件，pid 未分配）
              child.emit("error", Object.assign(new Error("spawn edge ENOENT"), { code: "ENOENT" }));
            } else {
              // 绝对路径兜底实例：stderr 发就绪日志
              child.stderr.emit("data", Buffer.from("edgetunnel: edge is running\r\n"));
            }
          });
          return child;
        }
      };
    }
    if (request === "fs") {
      return {
        __proto__: fs,
        existsSync: (filePath) => /n2n/i.test(String(filePath)) && /edge\.exe/i.test(String(filePath))
          ? true
          : fs.existsSync(filePath)
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(MESH_PATH)];
  const { N2nMeshTransport } = require(MESH_PATH);
  Module._load = originalLoad;

  await test("C1 PATH ENOENT → 绝对路径兜底重试一次 → stderr 就绪 resolve", async () => {
    const transport = new N2nMeshTransport();
    const logs = [];
    const edge = await transport._startEdgeProcess({ supernodeAddr: "entry.example.org", supernodePort: 53371, community: "demo-community", key: "k" }, (...args) => logs.push(args[0]), false);
    assert.ok(edge, "应为就绪 edge 实例 resolve");
    assert.strictEqual(spawnCalls.length, 2, `应 spawn 两次（PATH→兜底），实际 ${spawnCalls.length}`);
    assert.strictEqual(spawnCalls[0].exe, "edge", "首次应 PATH 方式");
    assert.strictEqual(spawnCalls[1].exe, "C:\\n2n\\edge.exe", `第二次应为兜底绝对路径，实际 ${spawnCalls[1].exe}`);
    assert.ok(logs.includes("n2n_mesh_edge_fallback"), `应记 fallback 日志事件：${JSON.stringify(logs)}`);
    const argStr = spawnCalls[1].args.join(" ");
    assert.ok(argStr.includes("entry.example.org:0") && argStr.includes("demo-community"), `兜底实例参数完整：${argStr}`);
  });

  await test("C2 兜底不可用（fs.exists false）→ 保留一键部署指引文案", async () => {
    // 再加载一份：fs.exists 返回 false
    Module._load = function (request, parent, isMain) {
      if (request === "child_process") {
        return {
          ...realChildProcess,
          spawn: (exe, args, opts) => {
            const child = makeFakeChild();
            setImmediate(() => child.emit("error", Object.assign(new Error("spawn edge ENOENT"), { code: "ENOENT" })));
            return child;
          }
        };
      }
      if (request === "fs") {
        return { __proto__: fs, existsSync: () => false };
      }
      return originalLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(MESH_PATH)];
    const { N2nMeshTransport: NoFallbackTransport } = require(MESH_PATH);
    Module._load = originalLoad;
    const transport = new NoFallbackTransport();
    await assert.rejects(
      () => transport._startEdgeProcess({ supernodeAddr: "", supernodePort: 7777, community: "x" }, () => {}, false),
      /一键部署/
    );
    delete require.cache[require.resolve(MESH_PATH)];
  });

  await test("C3 源码断言：EDGE_FALLBACK_PATH 常量 + ENOENT 分支 existsSync 判定在位", () => {
    assert.ok(meshSrc.includes('const EDGE_FALLBACK_PATH = "C:\\\\n2n\\\\edge.exe"'), "兜底常量缺失");
    assert.ok(meshSrc.includes('spawnEdge(EDGE_FALLBACK_PATH, false)'), "ENOENT → 兜底重试缺失");
    assert.ok(meshSrc.includes("fs.existsSync(EDGE_FALLBACK_PATH)"), "兜底存在性判定缺失");
    assert.ok(meshSrc.includes("n2n_mesh_edge_fallback"), "fallback 上屏日志事件缺失");
    assert.ok(/一键部署/.test(meshSrc), "ENOENT 文案应指向一键部署");
  });
}

// ── D 组：接线断言 ──

async function runWiringTests() {
  await test("D1 main.cjs：doctor/deploy require + IPC 双通道 + isDestroyed 防护", () => {
    assert.ok(mainSrc.includes('require("./network/n2n-doctor.cjs")'), "n2n-doctor 未 require");
    assert.ok(mainSrc.includes('ipcMain.handle("n2n:doctor"'), "doctor IPC 缺失");
    assert.ok(mainSrc.includes('ipcMain.handle("n2n:deploy"'), "deploy IPC 缺失");
    assert.ok(mainSrc.includes('sender.send("n2n:doctor:item", item)'), "doctor 逐项推送缺失");
    assert.ok(mainSrc.includes('sender.send("n2n:deploy:line", line)'), "deploy 逐行推送缺失");
    const deployBlock = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("n2n:deploy"'));
    assert.ok(deployBlock.includes("sender.isDestroyed()"), "deploy 推送应防窗口销毁");
    assert.ok(deployBlock.includes("开始自动安装 N2N 环境？"), "部署前应弹确认窗");
    assert.ok(deployBlock.includes("n2n_deploy_start"), "deploy 应落审计日志");
  });

  await test("D2 preload：四通道暴露（doctor/deploy invoke + item/line 事件）", () => {
    assert.ok(preloadSrc.includes('runN2nDoctor: (payload) => ipcRenderer.invoke("n2n:doctor", payload)'), "doctor invoke 缺失");
    assert.ok(preloadSrc.includes('runN2nDeploy: (payload) => ipcRenderer.invoke("n2n:deploy", payload)'), "deploy invoke 缺失");
    assert.ok(preloadSrc.includes('onN2nDoctorItem: (handler) => ipcRenderer.on("n2n:doctor:item"'), "doctor item 事件缺失");
    assert.ok(preloadSrc.includes('onN2nDeployLine: (handler) => ipcRenderer.on("n2n:deploy:line"'), "deploy line 事件缺失");
  });

  await test("D3 renderer：两按钮监听 + 逐项/逐行注册 + 就绪判定文案", () => {
    assert.ok(rendererSrc.includes('#n2n-doctor-run")?.addEventListener("click"'), "体检按钮监听缺失");
    assert.ok(rendererSrc.includes('#n2n-deploy-run")?.addEventListener("click"'), "部署按钮监听缺失");
    assert.ok(rendererSrc.includes("window.agentChatPro?.onN2nDoctorItem?.("), "体检逐项注册缺失");
    assert.ok(rendererSrc.includes("window.agentChatPro?.onN2nDeployLine?.("), "部署逐行注册缺失");
    assert.ok(rendererSrc.includes("collectN2nFormPayload"), "payload 收集函数缺失");
    assert.ok(rendererSrc.includes("n2nDoctorRunning || n2nDeployRunning"), "体检/部署应互斥");
    assert.ok(rendererSrc.includes("n2nDoctorItemNode"), "体检项渲染函数缺失");
  });

  await test("D4 index.html：N2N 卡片内按钮/结果区/日志区三控件", () => {
    const cardStart = htmlSrc.indexOf('id="n2n-config"');
    const cardEnd = htmlSrc.indexOf("</details>", cardStart);
    const card = htmlSrc.slice(cardStart, cardEnd);
    assert.ok(card.includes('id="n2n-doctor-run"'), "体检按钮缺失");
    assert.ok(card.includes('id="n2n-deploy-run"'), "部署按钮缺失");
    assert.ok(card.includes('id="n2n-doctor-result"'), "体检结果区缺失");
    assert.ok(card.includes('id="n2n-deploy-log"'), "部署日志区缺失");
    assert.ok(card.includes("N2N 体检") && card.includes("一键部署"), "按钮文案缺失");
  });

  await test("D5 styles.css：N2N 结果区/日志区/检查行样式落位", () => {
    const css = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");
    assert.ok(css.includes(".n2n-doctor-result"), "结果区样式缺失");
    assert.ok(css.includes(".n2n-deploy-log"), "日志区样式缺失");
    assert.ok(/\.n2n-check-ok [^{]*\{[^}]*var\(--success\)/.test(css), "ok 级配绿缺失");
    assert.ok(/\.n2n-check-fail [^{]*\{[^}]*var\(--error\)/.test(css), "fail 级配红缺失");
  });
}

// ── E 组：内嵌资产 + 版本 ──

async function runAssetTests() {
  await test("E1 build/n2n：edge zip + TAP 驱动两件齐且体积合格", () => {
    const zip = path.join(N2N_ASSET_DIR, "n2n_v3_windows_x64_v3.1.1_r1255_static_by_heiye.zip");
    const tap = path.join(N2N_ASSET_DIR, "tap-windows-9.21.2.exe");
    assert.ok(fs.existsSync(zip), "edge zip 缺失");
    assert.ok(fs.existsSync(tap), "TAP 驱动缺失");
    assert.ok(fs.statSync(zip).size > 2 * 1024 * 1024, `zip 应 >2MB，实际 ${fs.statSync(zip).size}`);
    assert.ok(fs.statSync(tap).size > 200 * 1024, `TAP 应 >200KB，实际 ${fs.statSync(tap).size}`);
  });

  await test("E2 package.json：extraResources 含 build/n2n → n2n 映射", () => {
    const mapped = (pkg.build.extraResources || []).find((item) => item.from === "build/n2n");
    assert.ok(mapped, "extraResources 缺 n2n 映射");
    assert.strictEqual(mapped.to, "n2n");
  });

  await test("E3 doctor 常量与工具包口径一致（zip 名 / TAP 名 / 默认入口）", () => {
    assert.ok(doctorSrc.includes('const N2N_ZIP_NAME = "n2n_v3_windows_x64_v3.1.1_r1255_static_by_heiye.zip"'), "zip 名不一致");
    assert.ok(doctorSrc.includes('const TAP_EXE_NAME = "tap-windows-9.21.2.exe"'), "TAP 名不一致");
    assert.ok(doctorSrc.includes('addr: "entry.example.org"') && doctorSrc.includes("port: 53371"), "默认入口不一致");
    assert.ok(doctorSrc.includes('"C:\\\\n2n"'), "落盘目录口径");
  });

  await test("E4 部署文案含 supernode 根因指引（容器挂死 → 让 Claude 查 docker ps）", () => {
    assert.ok(doctorSrc.includes("n2n-supernode 或 FRPC 容器挂了"), "根因指引缺失");
    assert.ok(doctorSrc.includes("让 Claude 连 SSH 帮查 docker ps"), "SSH 排查指引缺失");
    assert.ok(doctorSrc.includes("可换手机热点"), "换网络建议缺失");
  });
}

// ── F 组：vm 假 DOM 全量求值冒烟（renderer 改动必过）──

async function runVmSmokeTests() {
  const captureProps = {};
  const registeredHandlers = {};
  for (const key of ["onN2nDoctorItem", "onN2nDeployLine"]) {
    captureProps[key] = (handler) => { registeredHandlers[key] = handler; return undefined; };
  }
  function makeStyle() {
    const store = {};
    return new Proxy(store, {
      get(_t, prop) {
        if (prop === "setProperty") return (key, val) => { store[key] = val; };
        if (prop === "removeProperty") return (key) => { delete store[key]; };
        if (prop === "getPropertyValue") return (key) => store[key];
        return store[prop];
      },
      set() { return true; }
    });
  }
  function makeFakeEl() {
    const classes = new Set();
    const children = [];
    return {
      value: "", checked: false, type: "", placeholder: "", textContent: "", innerHTML: "",
      hidden: false, disabled: false, className: "", tagName: "DIV", draggable: false,
      scrollTop: 0, scrollHeight: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0,
      files: [], children, style: makeStyle(), dataset: {},
      elements: { namedItem: () => getFake("#form-named-item") },
      form: { elements: { namedItem: () => getFake("#named-form-item") } },
      classList: {
        toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name); return on; },
        add(...names) { for (const n of names) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); }
      },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false, toggleAttribute: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement: () => null, hasChildNodes: () => false,
      append(...nodes) { for (const node of nodes) children.push(node); },
      appendChild(node) { children.push(node); return node; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      closest() { return null; }, contains() { return false; },
      querySelector(sel) { return getFake(sel || "#inner"); },
      querySelectorAll() { return []; },
      focus() {}, blur() {}, click() {}, select() {}, remove() {},
      scrollIntoView() {}, scrollBy() {}, scrollTo() {}, setSelectionRange() {},
      showModal() {}, close() {}, show() {}, showPicker() {},
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
  }
  const cache = new Map();
  const getFake = (sel) => {
    const key = String(sel);
    if (!cache.has(key)) cache.set(key, makeFakeEl());
    return cache.get(key);
  };
  const documentStub = {
    body: getFake("body"), head: getFake("head"), documentElement: getFake("documentElement"),
    activeElement: null,
    querySelector: (sel) => getFake(sel), querySelectorAll: () => [],
    getElementById: (id) => getFake(`#${id}`),
    createElement: (tag) => { const el = makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    addEventListener() {}, removeEventListener() {}
  };
  // 桥方法级 mock：列表/形态等结构化返回与真实面一致
  const sampleSettings = {
    host: "", port: 22, username: "", wakeName: "", clientLabel: "",
    workingDirectory: "", dataDirectory: "", skipPermissions: false,
    statusSignalCapture: false, showSignalLights: true, connectionMode: "cloud", localEngine: "claude",
    hasPassword: true, hasCloudAiConfig: true,
    cloudAiProvider: "zhipu", cloudAiBaseUrl: "https://open.bigmodel.cn/api/paas/v4", cloudAiModel: "glm-4-flash",
    cloudToolsEnabled: true, cloudRunCommandEnabled: false, cloudWorkingDirectory: "",
    proxyEnabled: false, proxyType: "http",
    compactAuto: true, compactThreshold: 80, compactInstruction: "",
    sshProfiles: [
      { id: "ssh-1", name: "", host: "", port: 22, username: "", workingDirectory: "", skipPermissions: false, networkType: "internal", externalMethod: "auto", hostFingerprint: "", configured: false, hasPassword: false, active: true },
      { id: "ssh-2", name: "", host: "", port: 22, username: "", workingDirectory: "", skipPermissions: false, networkType: "internal", externalMethod: "auto", hostFingerprint: "", configured: false, hasPassword: false, active: false }
    ],
    activeSshProfile: "ssh-1",
    advanced: null,
    advancedEffective: {
      adapter: "claude",
      adapterOptions: { model: "", sandbox: "", provider: "" },
      ssh: { requestTimeoutMin: 30, connectTimeoutSec: 15, sftpTimeoutSec: 30, reconnectAttempts: 3, reconnectBaseMs: 600, keepaliveSec: 15, debugLog: false },
      external: { method: "frp", n2n: { cipher: "", compression: "", protocol: "", headerEncryption: false } },
      cloud: { connectTimeoutSec: 120, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 25 }
    },
    theme: "dark"
  };
  const gatesStub = { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true };
  const methodMocks = {
    listConversations: async () => [],
    listModes: async () => [],
    getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub })
  };
  const defaultResult = () => ({
    ...sampleSettings,
    edition: "main", productName: "Agent Chat Pro", gates: gatesStub,
    conversations: [], items: [], messages: [], tools: [], files: [], entries: [],
    results: [], valid: true, invalidKeys: [], ok: true, path: "",
    lastConnectionMode: "", version: "3.23.0"
  });
  const windowStub = {
    window: null, self: null,
    agentChatPro: new Proxy(captureProps, {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop in _t) return _t[prop];
        if (prop in methodMocks) return methodMocks[prop];
        return async () => defaultResult();
      }
    }),
    addEventListener() {}, removeEventListener() {},
    location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
    matchMedia: () => ({ matches: false, media: "", addEventListener() {}, addListener() {}, removeListener() {} }),
    open: () => null, close() {},
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "smoke" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    innerWidth: 1200, innerHeight: 800
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    Math, Date, JSON, Object, Array, String, Number, Boolean, BigInt,
    Map, Set, WeakMap, WeakSet, Promise, Symbol, Error, TypeError, RangeError,
    SyntaxError, ReferenceError, RegExp, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, structuredClone,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
    queueMicrotask, performance, Buffer,
    process: { env: {}, platform: "win32", versions: process.versions },
    window: windowStub, document: documentStub,
    navigator: windowStub.navigator, localStorage: windowStub.localStorage,
    location: windowStub.location, matchMedia: windowStub.matchMedia,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    getComputedStyle: windowStub.getComputedStyle,
    Event: function FakeEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
    CustomEvent: function FakeCustomEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
    FormData: function FormData() {},
    alert() {}, confirm: () => false, prompt: () => null,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}
  };
  sandbox.globalThis = sandbox;

  const vm = require("vm");
  const rendererCode = fs.readFileSync(RENDERER_PATH, "utf8");
  const source = rendererCode + "\n;globalThis.__acpSmoke = { n2nDoctorItemNode, appendN2nDeployLine, collectN2nFormPayload };";
  await test("F1 renderer.js vm 假 DOM 全量求值零异常（新 N2N 代码含在内）", () => {
    let error = null;
    try { vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: "renderer.js" }); }
    catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke");
  });

  await test("F2 体检项节点：等级徽标 + 标题/详情/hint 三段结构", () => {
    const node = sandbox.__acpSmoke.n2nDoctorItemNode({ id: "edge", title: "edge 二进制", level: "ok", detail: "已安装", hint: "无需重启" });
    assert.strictEqual(node.className, "n2n-check n2n-check-ok");
    const mark = node.children[0];
    assert.strictEqual(mark.textContent, "✓");
    const body = node.children[1];
    const smalls = body.children.filter((child) => child.tagName === "SMALL");
    assert.ok(smalls.some((child) => child.textContent === "已安装"), "详情应上屏");
    assert.ok(smalls.some((child) => child.textContent === "无需重启"), "hint 应上屏");
    const noHint = sandbox.__acpSmoke.n2nDoctorItemNode({ id: "x", title: "t", level: "warn", detail: "d", hint: "" });
    assert.strictEqual(noHint.className, "n2n-check n2n-check-warn");
    assert.strictEqual(noHint.children[0].textContent, "△", "warn 级应为 △");
  });

  await test("F3 部署日志追加：逐行 + 滚动 + hidden 解除", () => {
    sandbox.__acpSmoke.appendN2nDeployLine("▶ 步骤 1/6：检查内嵌工具包…");
    sandbox.__acpSmoke.appendN2nDeployLine("✓ 工具包就位");
    const box = getFake("#n2n-deploy-log");
    assert.strictEqual(box.hidden, false, "日志区应解除隐藏");
    assert.ok(box.textContent.includes("步骤 1/6") && box.textContent.includes("工具包就位"), `应两行都在：${box.textContent}`);
    assert.ok(box.textContent.endsWith("\n"), "每行应带换行");
  });

  await test("F4 payload 收集：表单值透传（空输入不带默认重写）", () => {
    const addrInput = getFake("#n2n-supernode-addr");
    const portInput = getFake("#n2n-supernode-port");
    addrInput.value = "  my-node.example.com  ";
    portInput.value = "53371";
    const payload = sandbox.__acpSmoke.collectN2nFormPayload();
    assert.strictEqual(payload.n2n.supernodeAddr, "my-node.example.com", "地址应 trim");
    assert.strictEqual(payload.n2n.supernodePort, 53371, "端口应转数字");
    portInput.value = "";
    assert.strictEqual(sandbox.__acpSmoke.collectN2nFormPayload().n2n.supernodePort, 7777, "空端口回 7777");
  });

  await test("F5 桥事件注册在求值时完成（onN2nDoctorItem/onN2nDeployLine 顶到桥）", () => {
    assert.ok(typeof registeredHandlers.onN2nDoctorItem === "function", "体检逐项 handler 应已注册");
    assert.ok(typeof registeredHandlers.onN2nDeployLine === "function", "部署逐行 handler 应已注册");
    registeredHandlers.onN2nDeployLine("── 测试行 ──");
    assert.ok(getFake("#n2n-deploy-log").textContent.includes("测试行"), "部署行 handler 直通日志区");
  });
}

(async () => {
  await runLinuxRealTests();
  await runWin32MockTests();
  await runMeshFallbackTests();
  await runWiringTests();
  await runAssetTests();
  await runVmSmokeTests();
  await test("G1 package.json 版本 ≥ 3.23.0（放宽锚点：后续版本继续在册）", () => {
    const [maj, min, patch] = pkg.version.split(".").map(Number);
    const [rmaj, rmin, rpatch] = "3.23.0".split(".").map(Number);
    assert.ok(maj > rmaj || (maj === rmaj && (min > rmin || (min === rmin && patch >= rpatch))), `应 ≥ 3.23.0，实际 ${pkg.version}`);
  });
  await test("G2 doctor 导出面在册（测试复用面 + IPC 面）", () => {
    const doctor = require(DOCTOR_PATH);
    for (const key of ["runN2nDoctor", "runN2nDeploy", "probeTcp", "runPowerShell", "detectHostSnapshot", "EDGE_EXE_PATH", "DEFAULT_SUPERNODE"]) {
      assert.ok(key in doctor, `导出缺 ${key}`);
    }
  });
  console.log(`\n=== test-v3-23-0.cjs：${passed} 通过 / ${failed} 失败 ===`);
  if (failures.length) { console.log(failures.map((item) => `  ✗ ${item}`).join("\n")); process.exitCode = 1; }
})();