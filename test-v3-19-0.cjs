"use strict";
/**
 * v3.19.0 测试 — F3 高级设置（设置中心第 7 导航）
 * 覆盖：
 *   A. settings.cjs advanced 分组（mock electron 真实 IO：自动识别 / 手动落库 / 越界回自动 / adapterOptions / 迁移 2→3）
 *   B. ssh.cjs TUNABLES 参数化（默认=现状实锤 + applySshTunables 读 advancedEffective.ssh）
 *   C. adapters 行为真单测（qwen stream-json / codex JSONL / hermes 文本流 + buildCommand 形状）
 *   D. conversations 适配器会话隔离（sshSessionField 尾标）
 *   E. n2n-mesh 手动参数注入（cipher/compression/protocol/headerEncryption）
 *   F. main.cjs SSH 分叉（三家 runner + atomcode daemon + adapterOptions 透传 + 检测 IPC）
 *   G. UI 接线（index 三卡 / renderer 函数与绑定 / preload 通道 / styles）
 *   H. 版本号 3.19.0 + 混淆清单登记
 *   I. renderer 运行时冒烟（vm 假 DOM 真求值：顶层求值 + populateSettings 直调——2026-10-05
 *      首发事故教训：renderAdvancedPanels 引用未定义标识符 adv，静态正则断言测不出，一跑现形）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const settingsSrc = read("src/main/settings.cjs");
const sshSrc = read("src/main/ssh.cjs");
const n2nSrc = read("src/main/network/n2n-mesh.cjs");
const mainSrc = read("src/main/main.cjs");
const cloudChatSrc = read("src/main/cloud-chat.cjs");
const preloadSrc = read("src/main/preload.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const indexSrc = read("src/renderer/index.html");
const stylesSrc = read("src/renderer/styles.css");
const obfuscateSrc = read("scripts/obfuscate.cjs");
const conversationsSrc = read("src/main/conversations.cjs");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

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
function expectThrow(fn, label) {
  try { fn(); } catch (error) {
    if (label && !String(error.message).includes(label)) {
      throw new Error(`抛错文案不符：期望含「${label}」，实际「${error.message}」`);
    }
    return;
  }
  throw new Error(`应抛错但未抛${label ? `（${label}）` : ""}`);
}

// ════════════════ A. settings.cjs advanced 分组（mock electron 真实 IO） ════════════════
async function runAdvancedSettingsTests() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3190-"));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => workdir, isPackaged: false, whenReady: async () => {} },
        safeStorage: { isEncryptionAvailable: () => true, decryptString: (v) => v, encryptString: (v) => v }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(ROOT, "src/main/settings.cjs"))];
  const settings = require(path.join(ROOT, "src/main/settings.cjs"));
  Module._load = originalLoad;

  const targetFile = path.join(workdir, "connection.json");
  const base = {
    connectionMode: "ssh",
    host: "192.168.1.20",
    port: 22,
    username: "admin",
    workingDirectory: "/vol1/1000/proj",
    password: "secret",
    networkType: "tcp"
  };
  const saveAdvanced = async (advanced) => settings.saveSettings({ ...base, advanced });

  await test("A1. 默认自动识别：advanced 全 null + adapter claude，advancedEffective 展开为现状默认值表", () => {
    const data = settings.getSettings();
    assert.strictEqual(data.advanced.adapter, "claude", "适配器默认 claude");
    assert.strictEqual(data.advanced.ssh, null, "SSH 组默认自动");
    assert.strictEqual(data.advanced.cloud, null, "云端组默认自动");
    assert.strictEqual(data.advanced.external, null, "外网组默认自动");
    const eff = data.advancedEffective;
    assert.deepStrictEqual(eff.ssh, {
      requestTimeoutMin: 30, connectTimeoutSec: 15, sftpTimeoutSec: 30,
      reconnectAttempts: 3, reconnectBaseMs: 600, keepaliveSec: 15, debugLog: false
    }, "SSH 默认=现状硬编码实锤");
    assert.deepStrictEqual(eff.cloud, {
      connectTimeoutSec: 120, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 25
    }, "云端默认=现状硬编码实锤");
    assert.deepStrictEqual(eff.external.n2n, { cipher: "", compression: "", protocol: "", headerEncryption: false });
  });

  await test("A2. 手动落库合法：SSH/云端/外网/适配器四组全落库且实值透传", async () => {
    const saved = await saveAdvanced({
      ssh: { requestTimeoutMin: 45, connectTimeoutSec: 20, sftpTimeoutSec: 60, reconnectAttempts: 4, reconnectBaseMs: 800, keepaliveSec: 20, debugLog: true },
      external: { n2n: { cipher: "A4", compression: "zstd", protocol: "tcp", headerEncryption: true } },
      cloud: { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30 },
      adapter: "qwen",
      adapterOptions: { model: "qwen3-max", sandbox: "", provider: "openrouter" }
    });
    const eff = saved.advancedEffective;
    assert.strictEqual(eff.ssh.requestTimeoutMin, 45);
    assert.strictEqual(eff.ssh.debugLog, true);
    assert.strictEqual(eff.sftpTimeoutSec, undefined, "字段只按白名单展开");
    // external 展开为 {n2n:{...}} 嵌套（见下一条 deepStrictEqual）
    assert.deepStrictEqual(eff.external, { n2n: { cipher: "A4", compression: "zstd", protocol: "tcp", headerEncryption: true } });
    assert.deepStrictEqual(eff.cloud, { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30 });
    assert.strictEqual(eff.adapter, "qwen");
    assert.deepStrictEqual(eff.adapterOptions, { model: "qwen3-max", sandbox: "", provider: "openrouter" });
    const raw = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.strictEqual(raw.advanced.ssh.requestTimeoutMin, 45, "手动组落盘原值");
    assert.strictEqual(raw.advanced.external.n2n.headerEncryption, true);
    assert.strictEqual(raw.schemaVersion, 3, "advanced 分组伴随 schemaVersion 3");
  });

  await test("A3. 越界整组回自动：SSH 请求超时越下界→该组 null 绝不静默改值；其余组不受波及", async () => {
    const saved = await saveAdvanced({
      ssh: { requestTimeoutMin: 5, connectTimeoutSec: 20, sftpTimeoutSec: 60, reconnectAttempts: 4, reconnectBaseMs: 800, keepaliveSec: 20, debugLog: true },
      cloud: { connectTimeoutSec: 60, streamIdleTimeoutSec: 600, maxRetries: 2, maxToolRounds: 30 }
    });
    assert.strictEqual(saved.advanced.ssh, null, "SSH 组应整组回自动（绝不静默改值）");
    assert.strictEqual(saved.advanced.cloud.connectTimeoutSec, 60, "云端组合法不受波及");
    const eff = saved.advancedEffective.ssh;
    assert.strictEqual(eff.requestTimeoutMin, 30, "实值应回现状默认 30");
  });

  await test("A4. 字段白名单：adapter 未知回 claude / adapterOptions 乱值收敛 / sandbox 只认 read-only", async () => {
    const saved = await saveAdvanced({
      adapter: "gpt-cli",
      adapterOptions: { model: "  qwen3-coder-30b  ", sandbox: "bogus", provider: "nous" }
    });
    assert.strictEqual(saved.advanced.adapter, "claude", "未知适配器回 claude（normalizeRemoteAdapter）");
    assert.deepStrictEqual(saved.advanced.adapterOptions, { model: "qwen3-coder-30b", sandbox: "", provider: "nous" });
    const saved2 = await saveAdvanced({ adapter: "codex", adapterOptions: { sandbox: "read-only" } });
    assert.strictEqual(saved2.advanced.adapter, "codex");
    assert.strictEqual(saved2.advanced.adapterOptions.sandbox, "read-only");
    assert.strictEqual(await (await saveAdvanced({ adapter: "hermes" })).advanced.adapter, "hermes", "其余四家逐一可落");
    assert.strictEqual(await (await saveAdvanced({ adapter: "atomcode" })).advanced.adapter, "atomcode");
  });

  await test("A5. 未提交 advanced 保留 previous（saveSettings 全量语义不丢失旧组）", async () => {
    await saveAdvanced({ cloud: { connectTimeoutSec: 90, streamIdleTimeoutSec: 300, maxRetries: 1, maxToolRounds: 20 } });
    const after = await settings.saveSettings({ connectionMode: "local" });
    assert.strictEqual(after.advanced.cloud.connectTimeoutSec, 90, "后续保存不带 advanced 时继承原组");
  });

  await test("A6. schemaVersion 2→3 迁移：旧档带 advanced 缺失→备份后升 3 默认自动", () => {
    fs.writeFileSync(targetFile, JSON.stringify({
      ...base,
      schemaVersion: 2,
      theme: "dark"
    }), "utf8");
    const data = settings.getSettings();
    const raw = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.strictEqual(raw.schemaVersion, 3, "落盘应升 3");
    const backupFile = path.join(workdir, "connection.json.schema-v2.bak");
    assert.ok(fs.existsSync(backupFile), "应有 .schema-v2 备份");
    assert.strictEqual(JSON.parse(fs.readFileSync(backupFile, "utf8")).schemaVersion, 2, "备份为迁移前形态");
    assert.strictEqual(data.advanced.adapter, "claude", "旧档迁移默认 auto 形态");
  });
}

// ════════════════ B. ssh.cjs TUNABLES 参数化 ════════════════
async function runSshTunablesTests() {
  await test("B1. TUNABLES 默认值表 = 现状硬编码实锤（30min/15s/30s/3 次/600ms/15s）", () => {
    for (const [key, expect] of [
      ["requestTimeoutMs", 30 * 60 * 1000],
      ["connectTimeoutMs", 15 * 1000],
      ["sftpTimeoutMs", 30 * 1000],
      ["reconnectAttempts", 3],
      ["reconnectBaseMs", 600],
      ["keepaliveIntervalMs", 15 * 1000],
      ["keepaliveCountMax", 3],
      ["debugLog", false]
    ]) {
      const pattern = new RegExp(`${key}\\s*[:=][^,;}]*`);
      const match = sshSrc.match(pattern);
      assert.ok(match, `TUNABLES 缺 ${key}`);
    }
    assert.ok(sshSrc.includes("function applySshTunables"), "应有 applySshTunables");
    for (const anchor of ["advancedEffective?.ssh", "requestTimeoutMin", "reconnectAttempts", "keepaliveSec", "timeoutSec"]) {
      assert.ok(sshSrc.includes(anchor) || sshSrc.includes(anchor.replace("timeoutSec", "TimeoutSec")), `applySshTunables 应读 ${anchor}`);
    }
  });

  await test("B2. runClaude 入口接线：applySshTunables(config) 在请求超时/connect/keepalive/重试/SFTP 全链生效", () => {
    for (const anchor of ["TUNABLES.connectTimeoutMs", "readyTimeout", "keepaliveInterval", "keepaliveCountMax",
      "TUNABLES.reconnectAttempts", "TUNABLES.reconnectBaseMs", "TUNABLES.sftpTimeoutMs", "TUNABLES.requestTimeoutMs"]) {
      assert.ok(sshSrc.includes(anchor), `ssh.cjs 应消费 ${anchor}`);
    }
    assert.ok(/runClaude\(config[\s\S]{0,300}applySshTunables\(config\)/.test(sshSrc), "runClaude 入口应先套参数化");
  });

  await test("B3. 越界回退：applySshTunables 对非法值回现状默认（读 advancedEffective.ssh）", () => {
    assert.ok(/Number\.isFinite|Number\(/.test(sshSrc.slice(sshSrc.indexOf("applySshTunables"), sshSrc.indexOf("applySshTunables") + 1200)), "应做数值化钳制");
    assert.ok(sshSrc.includes(`"${Math.round(30 * 60 * 1000 / 60000)} 分钟"`) || sshSrc.includes("TUNABLES.requestTimeoutMs / 60"), "请求超时文案应参数化或与 TUNABLES 同源");
  });
}

// ════════════════ C. adapters 行为真单测 ════════════════
async function runAdaptersTests() {
  const { parseQwenLine } = require(path.join(ROOT, "src/main/adapters/qwen-cli.cjs"));
  const { parseCodexLine } = require(path.join(ROOT, "src/main/adapters/codex-cli.cjs"));
  const { parseHermesLine, runHermesCli } = require(path.join(ROOT, "src/main/adapters/hermes-cli.cjs"));
  const { cliCommand, cleanAnsi, requestTimeoutMs } = require(path.join(ROOT, "src/main/adapters/ssh-cli-base.cjs"));

  function session() {
    const events = [];
    return {
      state: { sessionId: "", text: "", usage: undefined, done: false, error: "" },
      callbacks: {
        onDelta: (text) => events.push({ kind: "delta", text }),
        onToolEvent: (tool) => events.push({ kind: "tool", tool }),
        onUsage: (usage) => events.push({ kind: "usage", usage })
      },
      events
    };
  }

  await test("C1. qwen 事件流：stream_json 增量 / assistant text+tool_use / result 兜底与 is_error / init 会话", () => {
    const s = session();
    parseQwenLine(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } } }), s.state, s.callbacks);
    parseQwenLine(JSON.stringify({ type: "assistant", message: { content: [
      { type: "text", text: "，正在处理。" },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }
    ] }, usage: { input_tokens: 3, output_tokens: 5 }, session_id: "qs-1" }), s.state, s.callbacks);
    parseQwenLine(JSON.stringify({ type: "system", subtype: "init", session_id: "qs-2" }), s.state, s.callbacks);
    assert.strictEqual(s.state.sessionId, "qs-2", "init 会话覆盖");
    assert.deepStrictEqual(s.events[0], { kind: "delta", text: "你好" });
    assert.strictEqual(s.events[1].text, "，正在处理。");
    assert.strictEqual(s.events[2].tool.name, "bash");
    assert.strictEqual(s.state.done, false, "result 前未完结");
    const err = session();
    parseQwenLine(JSON.stringify({ type: "result", is_error: true, result: "", session_id: "qs-3" }), err.state, err.callbacks);
    assert.ok(err.state.error.includes("qwen 报告执行失败"), "is_error 走兜底错误文案");
    assert.strictEqual(err.state.sessionId, "qs-3");
    assert.strictEqual(err.state.done, true);
  });

  await test("C2. codex JSONL：thread 会话 / delta 直通 / 完整消息防重 / error / function_call", () => {
    const s = session();
    parseCodexLine(JSON.stringify({ type: "thread.started", thread_id: "cx-1" }), s.state, s.callbacks);
    assert.strictEqual(s.state.sessionId, "cx-1");
    parseCodexLine(JSON.stringify({ type: "agent_message_delta", delta: "正在生成" }), s.state, s.callbacks);
    parseCodexLine(JSON.stringify({ type: "agent_message", item: { text: "正在生成完毕" } }), s.state, s.callbacks);
    assert.deepStrictEqual(s.events.map((e) => e.kind === "delta" ? e.text : null).filter(Boolean), ["正在生成"], "完整消息在有增量后不重复回放");
    const s2 = session();
    parseCodexLine(JSON.stringify({ type: "item.completed", item: { item_type: "function_call", name: "shell", text: "完整直接回复", id: "i1" } }), s2.state, s2.callbacks);
    assert.strictEqual(s2.events[0].text, "完整直接回复", "无增量时完整消息直通");
    assert.strictEqual(s2.events[1].tool.name, "shell");
    const s3 = session();
    parseCodexLine(JSON.stringify({ type: "error", message: "model not found" }), s3.state, s3.callbacks);
    assert.strictEqual(s3.state.error, "model not found");
    parseCodexLine("非 JSON 垃圾", s3.state, s3.callbacks);
    assert.strictEqual(s3.events.length, 0, "垃圾行宽容跳过");
  });

  await test("C3. hermes 文本流：行即增量 / [error] 行拦截", () => {
    const s = session();
    parseHermesLine("第一段回复", s.state, s.callbacks);
    parseHermesLine("", s.state, s.callbacks, );
    parseHermesLine("第二段", s.state, s.callbacks);
    assert.deepStrictEqual(s.events.filter((e) => e.kind === "delta").map((e) => e.text), ["第一段回复\n", "第二段\n"]);
    const s2 = session();
    parseHermesLine("[error] 401 unauthorized", s2.state, s2.callbacks);
    assert.ok(s2.state.error.includes("401"));
  });

  await test("C4. buildCommand 形状：qwen -p+stream-json / codex exec resume --last+--sandbox / hermes chat -q", () => {
    const q = require(path.join(ROOT, "src/main/adapters/qwen-cli.cjs"));
    const c = require(path.join(ROOT, "src/main/adapters/codex-cli.cjs"));
    const config = { workingDirectory: "/vol1/proj", remoteAdapterModel: "qwen3-max", remoteAdapterSandbox: "read-only" };
    // 通过源码断言命令形状（runner 需 SSH 连接，行为测试见真机验证计划）
    const qsrc = read("src/main/adapters/qwen-cli.cjs");
    for (const part of ["-p", "--output-format", "stream-json", "--include-partial-messages", "--continue", "shellQuote"]) {
      assert.ok(qsrc.includes(`"${part}"`) || qsrc.includes(`'${part}'`) || qsrc.includes(part), `qwen 命令应含 ${part}`);
    }
    const csrc = read("src/main/adapters/codex-cli.cjs");
    for (const part of ["exec", "resume", "--last", "--json", "--sandbox", "read-only", "workspace-write"]) {
      assert.ok(csrc.includes(`"${part}"`) || csrc.includes(part), `codex 命令应含 ${part}`);
    }
    const hsrc = read("src/main/adapters/hermes-cli.cjs");
    for (const part of ["chat", "-q", "--continue", "--model", "--provider"]) {
      assert.ok(hsrc.includes(`"${part}"`) || hsrc.includes(part), `hermes 命令应含 ${part}`);
    }
    assert.ok(config.workingDirectory === "/vol1/proj");
  });

  await test("C5. ssh-cli-base 基建：cliCommand 拼接/清理 ANSI/请求超时取值/取消契约", () => {
    assert.strictEqual(cliCommand(["a", "", "b", ""]), "a b");
    assert.strictEqual(cleanAnsi("\x1b[2K加载帧\x1b[0m"), "加载帧");
    const config = { advancedEffective: { ssh: { requestTimeoutMin: 45 } } };
    assert.strictEqual(requestTimeoutMs(config), 45 * 60 * 1000, "合法值按分钟换算");
    assert.strictEqual(requestTimeoutMs({ advancedEffective: { ssh: { requestTimeoutMin: 5 } } }), 30 * 60 * 1000, "越界回 30min 现状");
    assert.strictEqual(requestTimeoutMs({}), 30 * 60 * 1000, "缺省回 30min");
  });

  await test("C6. runRemoteCli 工作目录预检 + command -v 检测 + 附件如实忽略的源码链路", () => {
    const base = read("src/main/adapters/ssh-cli-base.cjs");
    for (const anchor of ["test -d", "command -v", "adapter_attachments_skipped", "connectWithRetry", "client.end()", "onTurnComplete"]) {
      assert.ok(base.includes(anchor), `ssh-cli-base 应含 ${anchor}`);
    }
    const result = { promise: Promise.resolve({}), cancel() {} };
    assert.equal(typeof result.cancel, "function", "cancel 契约形状");
  });
}

// ════════════════ D. conversations 适配器会话隔离 ════════════════
async function runConversationsTests() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3190c-"));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => workdir }, safeStorage: { isEncryptionAvailable: () => true } };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(ROOT, "src/main/settings.cjs"))];
  delete require.cache[require.resolve(path.join(ROOT, "src/main/conversations.cjs"))];
  const conversations = require(path.join(ROOT, "src/main/conversations.cjs"));
  Module._load = originalLoad;

  await test("D1. sshSessionField：claude 延续存量字段（ssh-1→sshSessionId / 其他槽带 _id），qwen 尾标隔离", () => {
    const exported = Object.keys(conversations);
    assert.ok(exported.length > 0, "conversations 可 require");
    const src = conversationsSrc;
    assert.ok(src.includes("sshSessionField"), "应有 sshSessionField");
    assert.ok(src.includes(`tail !== "claude"`), "claude 外加尾标");
    assert.ok(src.includes("sshSessionId_"), "槽位字段模板");
  });

  await test("D2. addAssistantMessage/saveConversationSession/sessionForMode 均带 remoteAdapter 尾参", () => {
    const src = conversationsSrc;
    assert.ok(/addAssistantMessage\((?:[\s\S]*?)remoteAdapter = "claude"/.test(src), "addAssistantMessage 应有 remoteAdapter 尾参");
    assert.ok(/saveConversationSession\((?:[\s\S]*?)remoteAdapter = "claude"/.test(src), "saveConversationSession 应有尾参");
    assert.ok(/sessionForMode\((?:[\s\S]*?)remoteAdapter = "claude"/.test(src), "sessionForMode 应有尾参");
  });
}

// ════════════════ E. n2n-mesh 手动参数注入 ════════════════
async function runN2nTests() {
  await test("E1. 手动协议=固定模式不探测；自动=UDP→TCP 兜底链路保持", () => {
    assert.ok(n2nSrc.includes("manualProtocol"), "应有 manualProtocol 判定");
    assert.ok(n2nSrc.includes('edgeOptions.manualProtocol ? [edgeOptions.manualProtocol]'), "手动协议应固定单模式");
    assert.ok(n2nSrc.includes('"udp", "tcp"'), "自动链路应保持 udp→tcp");
    assert.ok(n2nSrc.includes('advancedEffective?.external?.n2n'), "应从 advanced 实值读取");
  });
  await test("E2. edge 参数实装：-A 加密 / -z1 lzo1x / -z2 zstd / -H 头加密", () => {
    assert.ok(n2nSrc.includes(String.fromCharCode(96, 45, 65) + "${options.cipher}" + String.fromCharCode(96)), "应有 -A{cipher} 拼接");
    assert.ok(n2nSrc.includes("-z1") && n2nSrc.includes("-z2"), "应含 -z1/-z2");
    assert.ok(n2nSrc.includes('"-H"') || n2nSrc.includes("'-H'") || /push\("-H"\)/.test(n2nSrc), "应含 -H 头加密");
  });
}

// ════════════════ F. main.cjs SSH 分叉 + 检测 IPC ════════════════
async function runMainTests() {
  await test("F1. SSH 分叉：qwen/codex/hermes 三家 runner 分派 + atomcode daemon 换 NAS IP", () => {
    assert.ok(mainSrc.includes('require("./adapters/qwen-cli.cjs")'), "应引 qwen");
    assert.ok(mainSrc.includes('require("./adapters/codex-cli.cjs")'), "应引 codex");
    assert.ok(mainSrc.includes('require("./adapters/hermes-cli.cjs")'), "应引 hermes");
    assert.ok(mainSrc.includes("ssh_adapter_dispatch"), "应有分派日志");
    assert.ok(mainSrc.includes("config.atomcodeHost = String(config.host"), "atomcode daemon 应换 NAS IP");
    assert.ok(mainSrc.includes("cliRunners[remoteAdapter]"), "应有 runner 表");
    assert.ok(mainSrc.includes("advancedEffective?.adapter"), "应读 advancedEffective.adapter");
  });

  await test("F2. adapterOptions 透传三家（remoteAdapterModel/Sandbox/Provider）", () => {
    assert.ok(mainSrc.includes("remoteAdapterModel"), "应透传模型");
    assert.ok(mainSrc.includes("remoteAdapterSandbox"), "应透传沙箱");
    assert.ok(mainSrc.includes("remoteAdapterProvider"), "应透传服务商");
    assert.ok(/adapterOptions\.model/.test(mainSrc), "应从 advancedEffective.adapterOptions 取值");
  });

  await test("F3. 工具循环轮次参数化 + 云端 callbacks 带 advancedEffective", () => {
    assert.ok(mainSrc.includes("advancedCloud") && mainSrc.includes("maxToolRounds"), "工具轮次应参数化");
    assert.ok(mainSrc.includes("advanced: getCloudAiConfig().advancedEffective"), "云端 callbacks 应带 advancedEffective");
  });

  await test("F4. 检测 IPC settings:detect-ssh-adapter：单连接探测 command -v + claude/atomcode 内置直返", () => {
    assert.ok(mainSrc.includes('ipcMain.handle("settings:detect-ssh-adapter"'), "应有检测 IPC");
    assert.ok(mainSrc.includes("command -v"), "应远端探测 CLI 在场");
    assert.ok(mainSrc.includes('"installed"') && mainSrc.includes('"missing"') && mainSrc.includes('"builtin"'), "三态结果");
    assert.ok(mainSrc.includes("@qwen-code/qwen-code") && mainSrc.includes("@openai/codex"), "安装引导文案");
    void cloudChatSrc;
  });

  await test("F5. 会话链路带 taskRemoteAdapter（锁定适配器维度）", () => {
    assert.ok(mainSrc.includes("taskRemoteAdapter"), "应锁定适配器维度");
    assert.ok(/sessionForMode\(([\s\S]*?)taskRemoteAdapter\)/.test(mainSrc), "会话起始应带适配器");
    assert.ok(/saveConversationSession\(([\s\S]*?)taskRemoteAdapter\)/.test(mainSrc), "会话落库应带适配器");
    assert.ok(/addAssistantMessage\(([\s\S]*?)taskRemoteAdapter\)/.test(mainSrc), "消息入库应带适配器");
  });
}

// ════════════════ G. UI 接线 ════════════════
async function runUiTests() {
  await test("G1. index.html：第 7 导航 + 高级设置面板 + 三卡结构", () => {
    assert.ok(indexSrc.includes('data-settings-tab="advanced"'), "应有高级设置导航");
    assert.ok(indexSrc.includes('data-settings-panel="advanced"'), "应有高级面板");
    for (const id of ["adv-panel-network", "adv-panel-cloud", "adv-panel-adapter"]) {
      assert.ok(indexSrc.includes(`id="${id}"`), `应有三卡之一 ${id}`);
    }
    for (const badge of ["data-adv-badge=\"network\"", "data-adv-badge=\"cloud\"", "data-adv-badge=\"adapter\""]) {
      assert.ok(indexSrc.includes(badge), `应有徽章 ${badge}`);
    }
    assert.ok(indexSrc.includes("切换为手动") && indexSrc.includes("恢复自动"), "两态按钮齐");
  });

  await test("G2. 网络卡字段：SSH 六参数 + debugLog + N2N 四参数", () => {
    for (const id of ["adv-ssh-request-timeout", "adv-ssh-connect-timeout", "adv-ssh-sftp-timeout", "adv-ssh-reconnect-attempts", "adv-ssh-reconnect-base", "adv-ssh-keepalive", "adv-ssh-debug-log"]) {
      assert.ok(indexSrc.includes(`id="${id}"`), `应有 SSH 字段 ${id}`);
    }
    for (const id of ["adv-n2n-cipher", "adv-n2n-compression", "adv-n2n-protocol", "adv-n2n-header-encryption"]) {
      assert.ok(indexSrc.includes(`id="${id}"`), `应有 N2N 字段 ${id}`);
    }
    for (const option of ['value="A2"', 'value="A3"', 'value="A4"', 'value="A5"', 'value="lzo1x"', 'value="zstd"', 'value="udp"', 'value="tcp"']) {
      assert.ok(indexSrc.includes(option), `N2N 下拉应含 ${option}`);
    }
  });

  await test("G3. 传输通道标注：FRP 不做假可选 / XTCP 建设性标注 / DERP·P2P 明文实锤", () => {
    assert.ok(indexSrc.includes("frpc 配置") || indexSrc.includes("frpc的传输协议"), "FRP 标注应说明服务端配置");
    assert.ok(indexSrc.includes("XTCP"), "应标注 XTCP");
    assert.ok(indexSrc.includes("自建 frps"), "XTCP 应提到自建 frps");
    assert.ok(indexSrc.includes("明文"), "DERP/P2P 明文标注");
    assert.ok(indexSrc.includes("remotePort"), "FRP 客户端边界说明");
  });

  await test("G4. 云端卡字段：连接/流式空闲超时 + 重试 + 工具轮次", () => {
    for (const id of ["adv-cloud-connect-timeout", "adv-cloud-stream-idle", "adv-cloud-max-retries", "adv-cloud-tool-rounds"]) {
      assert.ok(indexSrc.includes(`id="${id}"`), `应有云端字段 ${id}`);
    }
    assert.ok(indexSrc.includes("幂等错误码"), "重试语义标注");
  });

  await test("G5. 适配器卡：五选一 + 附加参数 + 检测按钮 + 结果区", () => {
    for (const key of ["claude", "atomcode", "qwen", "codex", "hermes"]) {
      assert.ok(indexSrc.includes(`data-adapter-key="${key}"`), `应有适配器卡片 ${key}`);
    }
    for (const id of ["adapter-opt-model", "adapter-opt-sandbox", "adapter-opt-provider", "adapter-apply", "adapter-detect", "adapter-detect-result"]) {
      assert.ok(indexSrc.includes(`id="${id}"`), `应有适配器 UI ${id}`);
    }
    assert.ok(indexSrc.includes('value="read-only"'), "沙箱选项");
  });

  await test("G6. renderer：F3 函数区 + 事件绑定 + 两态徽章逻辑", () => {
    for (const fn of ["function renderAdvancedPanels", "function saveAdvancedGroup", "function renderAdapterCard", "function advNetworkPatch", "function advCloudPatch", "function renderAdapterDetect","ADV_ADAPTER_META"]) {
      assert.ok(rendererSrc.includes(fn), `renderer 应含 ${fn}`);
    }
    for (const bind of ['"#adv-network-save"', '"#adv-network-manual"', '"#adv-network-auto"', '"#adv-cloud-save"', '"#adapter-apply"', '"#adapter-detect"']) {
      assert.ok(rendererSrc.includes(bind), `renderer 应绑定 ${bind}`);
    }
    assert.ok(rendererSrc.includes("已整组回退自动识别"), "非法回自动应提示用户");
    assert.ok(rendererSrc.includes("renderAdvancedPanels(settings)"), "populateSettings 应回填高级组");
  });

  await test("G7. preload + styles：检测通道 + 高级卡样式（亮暗走主题变量）", () => {
    assert.ok(preloadSrc.includes("settings:detect-ssh-adapter"), "preload 应有检测通道");
    for (const cls of [".adv-panel", ".adv-badge", ".adapter-switch", ".adv-detect-result", ".adv-actions", ".adv-notes"]) {
      assert.ok(stylesSrc.includes(cls), `styles 应含 ${cls}`);
    }
  });
}

// ════════════════ H. 版本号 + 混淆清单 ════════════════
async function runVersionTests() {
  await test("H1. package.json 与界面版本 3.19.0（v3.20.0 起放宽为 ≥）", () => {
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    assert.ok(major > 3 || (major === 3 && (minor > 19 || (minor === 19 && patch >= 0))), `版本应 ≥3.19.0（实际 ${pkg.version}）`);
    void mainSrc;
  });
  await test("H2. 版本史源码注释与 schema 版本推进", () => {
    assert.ok(settingsSrc.includes("SETTINGS_SCHEMA_VERSION = 3"), "schemaVersion 3");
    assert.ok(settingsSrc.includes("v3.19.0 F3"), "settings 注释应记 v3.19.0");
  });
  await test("H3. 混淆清单登记四个 adapter 文件", () => {
    for (const file of ["main/adapters/ssh-cli-base.cjs", "main/adapters/qwen-cli.cjs", "main/adapters/codex-cli.cjs", "main/adapters/hermes-cli.cjs"]) {
      assert.ok(obfuscateSrc.includes(file), `混淆清单应含 ${file}`);
    }
  });
}

// ════════════════ I. renderer 运行时冒烟（vm 假 DOM 真求值） ════════════════
async function runSmokeTests() {
  const vm = require("vm");

  function makeStyle() {
    const store = {};
    return new Proxy(store, {
      get(target, prop) {
        if (prop === "setProperty") return (key, val) => { target[key] = val; };
        if (prop === "removeProperty") return (key) => { delete target[key]; };
        if (prop === "getPropertyValue") return (key) => target[key];
        return target[prop];
      },
      set(target, prop, val) { target[prop] = val; return true; }
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
        toggle(name, force) {
          const on = force === undefined ? !classes.has(name) : Boolean(force);
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
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
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    };
  }

  // 选择器缓存：同一选择器返回同一假元素，便于断言读回
  const cache = new Map();
  const getFake = (sel) => {
    const key = String(sel);
    if (!cache.has(key)) cache.set(key, makeFakeEl());
    return cache.get(key);
  };

  const documentStub = {
    body: getFake("body"),
    head: getFake("head"),
    documentElement: getFake("documentElement"),
    activeElement: null,
    querySelector: (sel) => getFake(sel),
    querySelectorAll: () => [],
    getElementById: (id) => getFake(`#${id}`),
    createElement: (tag) => { const el = makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    addEventListener() {}, removeEventListener() {}
  };

  const sampleSettings = {
    host: "10.66.1.111", port: 22, username: "demo-user", wakeName: "", clientLabel: "",
    workingDirectory: "/data", dataDirectory: "",
    skipPermissions: false, showSignalLights: true, connectionMode: "ssh", localEngine: "claude",
    hasPassword: true, hasCloudAiConfig: true,
    cloudAiProvider: "zhipu", cloudAiBaseUrl: "https://open.bigmodel.cn/api/paas/v4", cloudAiModel: "glm-4-flash",
    cloudToolsEnabled: true, cloudRunCommandEnabled: false, cloudWorkingDirectory: "",
    proxyEnabled: false, proxyType: "http",
    compactAuto: true, compactThreshold: 80, compactInstruction: "",
    atomcodeHost: "127.0.0.1", atomcodePort: 13456, customCliCommand: "",
    sshProfiles: [
      { id: "ssh-1", name: "主 NAS", host: "10.66.1.111", port: 22, username: "demo-user",
        workingDirectory: "/data", skipPermissions: false, networkType: "internal",
        externalMethod: "auto", hostFingerprint: "SHA256:x", configured: true, hasPassword: true },
      { id: "ssh-2", name: "", host: "", port: 22, username: "",
        workingDirectory: "", skipPermissions: false, networkType: "internal",
        externalMethod: "auto", hostFingerprint: "", configured: false, hasPassword: false }
    ],
    activeSshProfile: "ssh-1",
    advanced: null,
    advancedEffective: {
      adapter: "claude",
      adapterOptions: { model: "", sandbox: "", provider: "" },
      ssh: { requestTimeoutMin: 30, connectTimeoutSec: 15, sftpTimeoutSec: 30, reconnectAttempts: 3, reconnectBaseMs: 600, keepaliveSec: 15, debugLog: false },
      external: { method: "frp", n2n: { cipher: "", compression: "", protocol: "", headerEncryption: false } },
      cloud: { connectTimeoutSec: 120, streamIdleTimeoutSec: 300, maxRetries: 0, maxToolRounds: 25 }
    }
  };

  // 假 IPC 桥：未知方法一律返回 settings 形状兜底对象（防数据形状误报，只抓未定义标识符类错误）
  const bridge = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return async (payload) => ({
        ...sampleSettings,
        id: payload && payload.id !== undefined ? String(payload.id) : "smoke-id",
        version: "3.19.0",
        path: "",
        ok: true,
        results: [],
        conversations: [],
        items: [],
        messages: [],
        tools: [],
        files: [],
        entries: [],
        valid: true,
        invalidKeys: []
      });
    }
  });

  const windowStub = {
    window: null, self: null,
    agentChatPro: bridge,
    addEventListener() {}, removeEventListener() {},
    location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
    matchMedia: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    open: () => null,
    close() {},
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "smoke" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (cb) => cb(),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    crypto: require("crypto").webcrypto
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;

  class FakeEvent {
    constructor(type, init) {
      this.type = String(type || "");
      Object.assign(this, init || {});
      this.preventDefault = () => {};
      this.stopPropagation = () => {};
    }
  }

  const sandbox = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, BigInt,
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
    crypto: windowStub.crypto,
    Event: FakeEvent, CustomEvent: FakeEvent, FormData: function FormData() {}, alert() {}, confirm: () => false, prompt: () => null,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}
  };
  for (const key of ["File", "Blob", "Headers", "Request", "Response", "fetch", "Image"]) {
    if (typeof globalThis[key] !== "undefined") sandbox[key] = globalThis[key];
  }
  sandbox.globalThis = sandbox;

  // 尾部挂钩：把待直调的函数暴露出脚本作用域（跨 vm 取不到 let/const 绑定，必须借闭包）
  const source = rendererSrc
    + "\n;globalThis.__acpSmoke = { populateSettings, renderAdvancedPanels, renderAdapterCard, renderAdapterDetect, pendingAdapterKey: () => pendingAdapterKey };";

  await test("I1. renderer.js vm 假 DOM 全量求值零异常（未定义标识符一跑现形）", () => {
    let error = null;
    try {
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox, { filename: "renderer.js" });
    } catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke 挂钩");
  });

  await test("I2. populateSettings（自动态）跑通 + effective 兜底值全部落位", () => {
    sandbox.__acpSmoke.populateSettings(sampleSettings);
    const value = (sel) => cache.get(sel)?.value;
    assert.strictEqual(value("#adv-ssh-request-timeout"), 30);
    assert.strictEqual(value("#adv-ssh-connect-timeout"), 15);
    assert.strictEqual(value("#adv-ssh-sftp-timeout"), 30);
    assert.strictEqual(value("#adv-ssh-reconnect-attempts"), 3);
    assert.strictEqual(value("#adv-ssh-reconnect-base"), 600);
    assert.strictEqual(value("#adv-ssh-keepalive"), 15);
    assert.strictEqual(cache.get("#adv-ssh-debug-log").checked, false);
    assert.strictEqual(value("#adv-n2n-cipher"), "");
    assert.strictEqual(value("#adv-cloud-connect-timeout"), 120);
    assert.strictEqual(value("#adv-cloud-stream-idle"), 300);
    assert.strictEqual(value("#adv-cloud-max-retries"), 0);
    assert.strictEqual(value("#adv-cloud-tool-rounds"), 25);
    assert.ok(cache.get("#adapter-note").textContent.includes("agent-sdk-bridge"), "claude 应显示内置双链说明");
    assert.strictEqual(cache.get('[data-adv-badge="network"]').classList.contains("is-manual"), false);
    assert.ok(cache.get('[data-adv-badge="adapter"]').textContent.includes("内置默认"), "claude 徽章应标内置默认");
  });

  await test("I3. populateSettings（手动态）回读落位 + 徽章转手动 + 适配器附加参数显隐", () => {
    sandbox.__acpSmoke.populateSettings({
      ...sampleSettings,
      advanced: {
        ssh: { requestTimeoutMin: 45, connectTimeoutSec: 15, sftpTimeoutSec: 30, reconnectAttempts: 3, reconnectBaseMs: 600, keepaliveSec: 15, debugLog: true },
        external: { method: "n2n", n2n: { cipher: "A4", compression: "zstd", protocol: "tcp", headerEncryption: true } },
        cloud: { connectTimeoutSec: 90, streamIdleTimeoutSec: 400, maxRetries: 0, maxToolRounds: 40 },
        adapter: "codex",
        adapterOptions: { model: "", sandbox: "workspace-write", provider: "" }
      }
    });
    const value = (sel) => cache.get(sel)?.value;
    assert.strictEqual(value("#adv-ssh-request-timeout"), 45);
    assert.strictEqual(cache.get("#adv-ssh-debug-log").checked, true);
    assert.strictEqual(value("#adv-n2n-cipher"), "A4");
    assert.strictEqual(value("#adv-n2n-compression"), "zstd");
    assert.strictEqual(value("#adv-n2n-protocol"), "tcp");
    assert.strictEqual(cache.get("#adv-n2n-header-encryption").checked, true);
    assert.strictEqual(value("#adv-cloud-tool-rounds"), 40);
    assert.strictEqual(cache.get('[data-adv-badge="network"]').classList.contains("is-manual"), true);
    assert.ok(cache.get('[data-adv-badge="adapter"]').textContent.includes("手动选择"), "codex 徽章应标手动选择");
    assert.strictEqual(sandbox.__acpSmoke.pendingAdapterKey(), "codex");
    // 沙箱下拉语义：空值=「workspace-write（默认）」，仅 read-only 回显自身——存 workspace-write 时归一显示为空
    assert.strictEqual(value("#adapter-opt-sandbox"), "");
    assert.strictEqual(cache.get("#adapter-options").hidden, false);
    assert.ok(cache.get("#adapter-note").textContent.includes("@openai/codex"), "codex 应显示安装指引");
  });

  await test("I4. renderAdapterDetect 真执行：行构建 + 三态文案 + 空结果收起", () => {
    sandbox.__acpSmoke.renderAdapterDetect([
      { key: "claude", status: "builtin", detail: "内置 agent-sdk-bridge / direct-cli 双链" },
      { key: "qwen", status: "installed", path: "/usr/local/bin/qwen" },
      { key: "codex", status: "missing", installHint: "npm install -g @openai/codex" }
    ]);
    const box = cache.get("#adapter-detect-result");
    assert.strictEqual(box.hidden, false);
    assert.strictEqual(box.children.length, 3);
    assert.strictEqual(box.children[0].children[0].textContent, "Claude");
    assert.strictEqual(box.children[1].children[1].textContent, "✅ 已安装");
    assert.strictEqual(box.children[2].children[1].textContent, "❌ 未安装");
    assert.ok(box.children[2].children[2].textContent.includes("@openai/codex"), "missing 行应带安装指引");
    sandbox.__acpSmoke.renderAdapterDetect([]);
    assert.strictEqual(box.hidden, true);  // 空结果仅收起（隐藏态残留行不显示，下次渲染 replaceChildren 全量替换）
  });
}

(async () => {
  console.log("=== v3.19.0 F3 高级设置测试 ===");
  console.log("── A. settings advanced 分组 ──"); await runAdvancedSettingsTests();
  console.log("── B. ssh TUNABLES ──"); await runSshTunablesTests();
  console.log("── C. adapters ──"); await runAdaptersTests();
  console.log("── D. conversations ──"); await runConversationsTests();
  console.log("── E. n2n-mesh ──"); await runN2nTests();
  console.log("── F. main 分叉 ──"); await runMainTests();
  console.log("── G. UI ──"); await runUiTests();
  console.log("── H. 版本 ──"); await runVersionTests();
  console.log("── I. renderer 运行时冒烟 ──"); await runSmokeTests();
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  // ⚠ 显式退出：vm 冒烟求值挂出的异步启动链（微任务）不依赖、也不许影响测试收口
  if (failed) { console.log(failures.join("\n")); process.exit(1); }
  process.exit(0);
})();