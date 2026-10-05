"use strict";
/**
 * v3.18.0 测试 — F2 模型页（设置中心第 6 导航）+ F4 SSH 双卡槽
 * 覆盖：
 *   A. model-config.cjs 行为真单测（五项表/单项写入/自动压缩阈值/模型名校验）
 *   B. local.cjs 本地写链（接线 + ENOENT 种子修复 + .bak-model 备份）
 *   C. ssh.cjs 远端写链（applyRemoteModelSettings 写前备份语义 + 三入口）
 *   D. settings.cjs 双卡槽（mock electron 真实 IO：迁移 v2/物化/保存镜像/切换/指纹）
 *   E. conversations.cjs 会话隔离（sshSessionField/双槽互不透传）
 *   F. main.cjs IPC 接线（model:update-entry / model:update-compact / settings:switch-ssh-profile）
 *   G. preload / renderer / index / styles 接线
 *   H. 版本号 3.18.0
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const modelConfigSrc = read("src/main/model-config.cjs");
const localSrc = read("src/main/local.cjs");
const sshSrc = read("src/main/ssh.cjs");
const settingsSrc = read("src/main/settings.cjs");
const conversationsSrc = read("src/main/conversations.cjs");
const mainSrc = read("src/main/main.cjs");
const preloadSrc = read("src/main/preload.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const indexSrc = read("src/renderer/index.html");
const stylesSrc = read("src/renderer/styles.css");
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

// ════════════════ A. model-config.cjs 行为真单测（零依赖可直接 require） ════════════════
async function runModelConfigTests() {
  delete require.cache[require.resolve(path.join(ROOT, "src/main/model-config.cjs"))];
  const mc = require(path.join(ROOT, "src/main/model-config.cjs"));

  await test("A1. 五项表与 AO 官方语义 1:1（id → env key 齐全）", () => {
    const byId = new Map(mc.MODEL_ENTRIES.map((entry) => [entry.id, entry]));
    for (const [id, key] of [
      ["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
      ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
      ["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
      ["subagent", "CLAUDE_CODE_SUBAGENT_MODEL"],
      ["small-fast", "ANTHROPIC_SMALL_FAST_MODEL"]
    ]) {
      const entry = byId.get(id);
      assert.ok(entry, `缺档位 ${id}`);
      assert.strictEqual(entry.key, key, `${id} 的 env key 应为 ${key}`);
      assert.ok(entry.label, `${id} 需有展示名`);
    }
    assert.strictEqual(mc.MODEL_ENTRIES.length, 5, "五项表定死为 5 个档位");
  });

  await test("A2. replaceSingleModelSetting：只改目标项，其余档位原样保留", () => {
    const source = JSON.stringify({
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "old-opus",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "keep-sonnet",
        ANTHROPIC_SMALL_FAST_MODEL: "keep-sub"
      }
    });
    const result = mc.replaceSingleModelSetting(source, "opus", "new-opus");
    const parsed = JSON.parse(result.settings);
    assert.strictEqual(parsed.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "new-opus");
    assert.strictEqual(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "keep-sonnet", "sonnet 不得被波及");
    assert.strictEqual(parsed.env.ANTHROPIC_SMALL_FAST_MODEL, "keep-sub", "subagent 不得被波及");
    assert.deepStrictEqual(result.changedKeys, ["ANTHROPIC_DEFAULT_OPUS_MODEL"], "变更披露只含目标键");
  });

  await test("A3. replaceSingleModelSetting：新档位首次写入（无预置 key）也能落键", () => {
    const result = mc.replaceSingleModelSetting('{"env":{}}', "haiku", "glm-4.6");
    assert.strictEqual(JSON.parse(result.settings).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-4.6");
  });

  await test("A4. 单项写入：缺 env 配置/坏 JSON 报错文案可循（不静默吞错）", () => {
    expectThrow(() => mc.replaceSingleModelSetting('{"apiKey":"x"}', "opus", "m"), "缺少 env 配置");
    expectThrow(() => mc.replaceSingleModelSetting('{坏', "opus", "m"), "不是有效 JSON");
    expectThrow(() => mc.replaceSingleModelSetting('{"env":{}}', "gpt-x", "m-coder-1"), "未知的 Claude 模型配置项");
  });

  await test("A5. validateModelName 抛错语义：拒终端碎片「[1m]」/空串/空白/超长", () => {
    expectThrow(() => mc.validateModelName("claude-opus-4.5[1m]"), "模型名称无效");
    expectThrow(() => mc.validateModelName("with space"), "模型名称无效");
    expectThrow(() => mc.validateModelName(""), "请填写模型名称");
    expectThrow(() => mc.validateModelName("a".repeat(201)), "模型名称无效");
  });

  await test("A6. validateModelName：放行正常模型名（含三方命名）", () => {
    assert.strictEqual(mc.validateModelName("glm-4.6"), "glm-4.6");
    assert.strictEqual(mc.validateModelName("kimi-k2-0711-preview"), "kimi-k2-0711-preview");
    assert.strictEqual(mc.validateModelName("qwen3-coder-30b"), "qwen3-coder-30b");
    assert.strictEqual(mc.validateModelName("deepseek-v3.2:snap"), "deepseek-v3.2:snap");
    assert.strictEqual(mc.validateModelName("  claude-sonnet-4  "), "claude-sonnet-4", "首尾空白裁剪");
    assert.strictEqual(mc.validateModelName("a".repeat(200)), "a".repeat(200), "恰 200 放行");
  });

  await test("A7. 自动压缩阈值落笔：fixed 值写入顶层独立键", () => {
    const result = mc.replaceAutoCompactWindowSetting('{"env":{}}', 200000);
    const parsed = JSON.parse(result.settings);
    assert.strictEqual(parsed.autoCompactWindow, 200000, "阈值应为顶层 settings.json 键");
    assert.ok(result.settings.includes("env"), "不得破坏 env");
  });

  await test("A8. auto 模式落笔 = 删除键（还原官方默认行为）", () => {
    const result = mc.replaceAutoCompactWindowSetting('{"autoCompactWindow":300000,"env":{}}', "auto");
    const parsed = JSON.parse(result.settings);
    assert.strictEqual(parsed.autoCompactWindow, undefined, "auto = 删除自定义阈值");
    assert.ok("env" in parsed, "其余字段保留");
  });

  await test("A9. 阈值边界：100K~1M 之外/非整数拒绝，字符串数字收敛接受", () => {
    expectThrow(() => mc.replaceAutoCompactWindowSetting('{"env":{}}', 50000), "100K");
    expectThrow(() => mc.replaceAutoCompactWindowSetting('{"env":{}}', 2000000), "1M");
    expectThrow(() => mc.replaceAutoCompactWindowSetting('{"env":{}}', 250000.5), "100K");
    assert.strictEqual(JSON.parse(mc.replaceAutoCompactWindowSetting('{"env":{}}', "300000").settings).autoCompactWindow, 300000, "字符串数字按 AO 语义收敛");
  });

  await test("A10. readAutoCompactWindow 三态：缺省 auto / 固定 / 非法", () => {
    assert.deepStrictEqual(mc.readAutoCompactWindow({}), { mode: "auto", tokens: null, valid: true });
    assert.deepStrictEqual(mc.readAutoCompactWindow({ autoCompactWindow: 300000 }), { mode: "fixed", tokens: 300000, valid: true });
    const invalid = mc.readAutoCompactWindow({ autoCompactWindow: 250000.5 });
    assert.strictEqual(invalid.mode, "invalid");
    assert.strictEqual(invalid.valid, false);
  });

  await test("A11. readModelSettings：状态形状含 entries/autoCompactWindow/invalidKeys（增量字段）", () => {
    const status = mc.readModelSettings('{"env":{"ANTHROPIC_DEFAULT_OPUS_MODEL":"m1"}}');
    assert.ok(Array.isArray(status.entries) && status.entries.length === 5);
    assert.strictEqual(status.autoCompactWindow.mode, "auto");
    assert.ok("invalidKeys" in status && "consistent" in status && "models" in status, "既有形状不丢");
    const broken = mc.readModelSettings('{"env":{"ANTHROPIC_DEFAULT_OPUS_MODEL":"claude[1m]"}}');
    assert.ok(!broken.valid && broken.invalidKeys.includes("ANTHROPIC_DEFAULT_OPUS_MODEL"), "非法模型名经 invalidKeys 披露");
  });
}

// ════════════════ B. local.cjs 本地写链 ════════════════
async function runLocalTests() {
  await test("B1. 单项写链 local.updateLocalClaudeModelEntry 存在并导出", () => {
    assert.ok(localSrc.includes("async function updateLocalClaudeModelEntry("), "函数应存在");
    assert.ok(/updateLocalClaudeModelEntry[,\n]/.test(localSrc), "应导出");
    assert.ok(localSrc.includes("replaceSingleModelSetting"), "应走单项替换");
  });

  await test("B2. 自动压缩写链 updateLocalAutoCompactWindow 存在并导出", () => {
    assert.ok(localSrc.includes("async function updateLocalAutoCompactWindow("), "函数应存在");
    assert.ok(/updateLocalAutoCompactWindow[,\n]/.test(localSrc), "应导出");
    assert.ok(localSrc.includes("replaceAutoCompactWindowSetting"), "应走阈值替换");
  });

  await test("B3. ENOENT 种子修复：空对象改用 {\"env\":{}} 而非 \"{}\"", () => {
    const bad = /replaceModelSettings\(\s*current\s*\|\|\s*"\{\}"|replaceModelSettings\("\{\}"/;
    assert.ok(!bad.test(localSrc), "「{}」种子会撞「缺少 env 配置」——空文件须以 {\"env\":{}} 起底");
    assert.ok(localSrc.includes('{"env":{}}'), "空文件种子应带 env 骨架");
  });

  await test("B4. 写前备份 .bak-model + 审计日志 local_claude_model_changed 接线", () => {
    assert.ok(localSrc.includes(".bak-model"), "本地写前也应有备份");
    assert.ok(localSrc.includes("local_claude_model_changed"), "审计事件应落");
  });

  await test("B5. 本地模型状态读取接线（getLocalClaudeModelStatus 状态化）", () => {
    assert.ok(localSrc.includes("async function getLocalClaudeModelStatus("), "状态函数应存在");
    assert.ok(localSrc.includes("readModelSettings"), "应接 readModelSettings 状态化读取");
  });
}

// ════════════════ C. ssh.cjs 远端写链 ════════════════
async function runSshTests() {
  const chainAt = sshSrc.indexOf("async function applyRemoteModelSettings(");
  const chain = sshSrc.slice(chainAt, chainAt + 2600);

  await test("C1. 远端统一写链 applyRemoteModelSettings 存在且先备份后写", () => {
    assert.ok(chainAt >= 0, "统一写链应存在");
    const cpAt = chain.indexOf("cp -f --");
    const sftpAt = chain.indexOf("openSftp");
    assert.ok(cpAt >= 0, "写前备份 cp 应存在");
    assert.ok(sftpAt > cpAt, "备份必须先于落笔（cp 在 SFTP 写之前）");
    assert.ok(chain.includes(".bak-model"), "备份固定 .bak-model 后缀");
    assert.ok(chain.includes("写前备份创建失败"), "备份失败必须中止写链并明示");
    assert.ok(chain.includes("claude_model_changed"), "写链落审计");
  });

  await test("C2. 远端写链语义：SFTP 临时文件 + chmod 600 + 原子 mv + 读回校验", () => {
    assert.ok(chain.includes(".tmp"), "临时文件落笔");
    assert.ok(chain.includes("chmod 600"), "远端配置须 600");
    assert.ok(chain.includes("getModelStatusFromClient"), "写后读回校验（getModelStatusFromClient）");
    assert.ok(chain.includes("rm -f --"), "失败清理临时文件");
  });

  await test("C3. 三入口齐备：单项 / 整套主模型 / 自动压缩均走统一写链", () => {
    for (const name of ["updateClaudeModelEntry", "updateClaudeAutoCompactWindow", "updateClaudeModel"]) {
      const at = sshSrc.indexOf(`function ${name}(`);
      assert.ok(at >= 0, `${name} 应存在`);
      const body = sshSrc.slice(at, at + 1800);
      assert.ok(body.includes("applyRemoteModelSettings"), `${name} 应统一走 applyRemoteModelSettings`);
    }
    assert.ok(/updateClaudeModelEntry[,\n]/.test(sshSrc), "导出 updateClaudeModelEntry");
    assert.ok(/updateClaudeAutoCompactWindow[,\n]/.test(sshSrc), "导出 updateClaudeAutoCompactWindow");
  });

  await test("C4. 报错文案映射：远端错误须指向「目标 NAS 的 Claude 配置」而非本机", () => {
    assert.ok(chain.includes("目标 NAS 的 Claude 配置"), "错误文案应避免误导用户改错机器");
  });

  await test("C5. 模型状态读取扩展：状态形状含 entries/autoCompactWindow（增量字段）", () => {
    assert.ok(sshSrc.includes("entries") && sshSrc.includes("autoCompactWindow"), "远端状态应带五项表 + 阈值");
    assert.ok(sshSrc.includes("invalidKeys"), "非法键披露应透传");
  });
}

// ════════════════ D. settings.cjs 双卡槽（mock electron 真实 IO） ════════════════
async function runSettingsTests() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3180-"));
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

  await test("D1. schemaVersion 升 2 + 迁移备份 .schema-v1.bak 生成", () => {
    fs.writeFileSync(targetFile, JSON.stringify({
      schemaVersion: 1,
      theme: "dark",
      connectionMode: "ssh",
      host: "192.168.1.20",
      port: 22,
      username: "admin",
      workingDirectory: "/vol1/1000/proj",
      skipPermissions: true,
      networkType: "tcp",
      hasPassword: true
    }), "utf8");
    const data = settings.getSettings();
    assert.strictEqual(data.schemaVersion, undefined, "白名单不透传");
    const current = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.strictEqual(current.schemaVersion, 2, "落盘应升 schemaVersion 2");
    const backupFile = path.join(workdir, "connection.json.schema-v1.bak");
    assert.ok(fs.existsSync(backupFile), "升版前应有 .schema-v1 备份");
    const backup = JSON.parse(fs.readFileSync(backupFile, "utf8"));
    assert.strictEqual(backup.schemaVersion, 1, "备份应为迁移前原文（v1 形态）");
    assert.strictEqual(backup.host, "192.168.1.20");
  });

  await test("D2. 迁移继承：getSettings → ssh-1 承接旧单套配置，ssh-2 为空槽（惰性物化）", () => {
    const data = settings.getSettings();
    assert.ok(Array.isArray(data.sshProfiles), "getSettings 应暴露规范化双槽");
    assert.strictEqual(data.sshProfiles.length, 2, "初始双槽");
    const slot1 = data.sshProfiles.find((p) => p.id === "ssh-1");
    const slot2 = data.sshProfiles.find((p) => p.id === "ssh-2");
    assert.ok(slot1 && slot2, "两槽均在");
    assert.strictEqual(slot1.host, "192.168.1.20", "槽 1 承接旧 host");
    assert.strictEqual(slot1.configured, true, "有完整配置的槽标记 configured");
    assert.strictEqual(slot1.active, true, "默认活跃槽 ssh-1");
    assert.strictEqual(slot2.configured, false, "空槽未配置");
    assert.ok(!slot2.hasPassword, "空槽无密码");
  });

  await test("D3. 脱敏暴露：sshProfiles 无密码泄漏 + 平铺字段仍是活跃槽镜像", () => {
    const data = settings.getSettings();
    for (const profile of data.sshProfiles) {
      assert.strictEqual(profile.password, undefined, "槽密码不得透传（脱敏）");
      assert.ok("hasPassword" in profile && "configured" in profile && "active" in profile);
    }
    assert.strictEqual(data.host, "192.168.1.20", "物化：顶层 host 平铺仍指向活跃槽");
    assert.strictEqual(data.activeSshProfile, "ssh-1");
  });

  await test("D4. 保存镜像：saveSettings 修改连接参数 → 同步写入活跃槽（槽 2 不动）", () => {
    settings.saveSettings({
      connectionMode: "ssh",
      host: "10.0.0.9",
      port: 2222,
      username: "dev",
      workingDirectory: "/tmp/ws",
      skipPermissions: true,
      hasPassword: true,
      password: "slot1-pass"
    });
    const current = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.strictEqual(current.schemaVersion, 2, "保存后落盘带 v2 版本标");
    const slot1 = current.sshProfiles.find((p) => p.id === "ssh-1");
    const slot2 = current.sshProfiles.find((p) => p.id === "ssh-2");
    assert.strictEqual(slot1.host, "10.0.0.9", "槽 1 随保存更新（本次保存后 sshProfiles 落盘）");
    assert.strictEqual(slot1.port, 2222);
    assert.strictEqual(slot1.configured, true);
    assert.ok(!slot2.host, "槽 2 不得被波及");
    assert.strictEqual(current.host, "10.0.0.9", "顶层平铺仍指向活跃槽");
  });

  await test("D5. 密码加密落槽 + 槽间不混（safeStorage 层）", () => {
    const current = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    const slot1 = current.sshProfiles.find((p) => p.id === "ssh-1");
    const slot2 = current.sshProfiles.find((p) => p.id === "ssh-2");
    assert.ok(slot1.password, "槽 1 密码应加密落槽");
    assert.ok(!slot2.password, "槽 2 不得继承槽 1 密码（槽间不混）");
  });

  await test("D6. 未保存密码的槽发连接 → 明确提示而非静默失败", () => {
    assert.ok(settingsSrc.includes("请先在连接设置中保存密码"), "getSshConnection 空槽密码提示语义");
  });

  await test("D7. switchSshProfile：切到空槽物化为空 host + 切回槽 1 完整还原", () => {
    const empty = settings.switchSshProfile("ssh-2");
    assert.strictEqual(empty.activeSshProfile, "ssh-2");
    assert.strictEqual(empty.host, "", "未配置槽 host 应为空");
    assert.strictEqual(empty.hasPassword, false, "空槽无密码");
    const persisted = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.strictEqual(persisted.sshProfiles.find((p) => p.id === "ssh-2").host, "", "物化后槽信息落盘");
    const back = settings.switchSshProfile("ssh-1");
    assert.strictEqual(back.activeSshProfile, "ssh-1");
    assert.strictEqual(back.host, "10.0.0.9", "切回槽 1 需完整还原");
    assert.strictEqual(back.hasPassword, true, "槽 1 密码还原");
    assert.strictEqual(back.port, 2222);
    assert.strictEqual(back.workingDirectory, "/tmp/ws", "工作目录随槽还原");
  });

  await test("D8. switchSshProfile 校验：未知槽 id 抛错拒绝", () => {
    expectThrow(() => settings.switchSshProfile("ssh-9"), "未知的 SSH 卡槽");
    expectThrow(() => settings.switchSshProfile("ssh-3"), "未知的 SSH 卡槽");
    expectThrow(() => settings.switchSshProfile(""), "未知的 SSH 卡槽");
  });

  await test("D9. trustHostFingerprint 同时落活跃槽（信任指纹不串槽丢失）", () => {
    assert.ok(/function trustHostFingerprint/.test(settingsSrc), "信任指纹入口存在");
    assert.ok(/function trustHostFingerprint[^]*?sshProfiles\[/s.test(settingsSrc), "应同步写活跃槽 hostFingerprint");
  });

  await test("D10. 结构防御：sshProfiles 非数组/含未知 id → 自愈规范化", () => {
    fs.writeFileSync(targetFile, JSON.stringify({
      schemaVersion: 2,
      sshProfiles: [{ id: "ssh-1", host: "1.1.1.1", port: 22, username: "u" }, "bad-slot"],
      host: "1.1.1.1"
    }), "utf8");
    const data = settings.getSettings();
    assert.ok(Array.isArray(data.sshProfiles), "规范化后仍为数组");
    assert.strictEqual(data.sshProfiles.filter((p) => p && p.id).length, 2, "坏槽被规范化而非崩溃");
    assert.ok(data.sshProfiles.every((p) => ["ssh-1", "ssh-2"].includes(p.id)), "只认白名单槽 id");
  });
}

// ════════════════ E. conversations.cjs 会话隔离 ════════════════
async function runConversationsTests() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3180c-"));
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
  require.cache[require.resolve(path.join(ROOT, "src/main/settings.cjs"))] &&
    delete require.cache[require.resolve(path.join(ROOT, "src/main/settings.cjs"))];
  delete require.cache[require.resolve(path.join(ROOT, "src/main/conversations.cjs"))];
  delete require.cache[require.resolve(path.join(ROOT, "src/main/archive.cjs"))];
  delete require.cache[require.resolve(path.join(ROOT, "src/main/storage.cjs"))];
  const conversations = require(path.join(ROOT, "src/main/conversations.cjs"));
  Module._load = originalLoad;

  await test("E1. sshSessionField：ssh-1/空 → 旧字段 sshSessionId（兼容老会话），ssh-2 → 独立字段", () => {
    assert.strictEqual(conversations.sshSessionField("ssh-1"), "sshSessionId");
    assert.strictEqual(conversations.sshSessionField(""), "sshSessionId");
    assert.strictEqual(conversations.sshSessionField("ssh-2"), "sshSessionId_ssh-2");
  });

  await test("E2. sessionForMode：ssh-2 读独立字段，无记录时回空串（不透传旧 sshSessionId）", () => {
    // 实现字段名为 sshSessionId_ssh-2（sanitize 保留连字符）
    const legacyOnly = { sshSessionId: "legacy-session", lastConnectionMode: "ssh" };
    assert.ok(!conversations.sessionForMode(legacyOnly, "ssh", "claude", "ssh-2"), "ssh-2 无独立字段必须回空，不得偷用槽 1 会话");
    assert.strictEqual(conversations.sessionForMode(legacyOnly, "ssh", "claude", "ssh-1"), "legacy-session", "ssh-1 走旧字段");
    const withSlot2 = { sshSessionId: "legacy-session", "sshSessionId_ssh-2": "slot2-session", lastConnectionMode: "ssh" };
    assert.strictEqual(conversations.sessionForMode(withSlot2, "ssh", "claude", "ssh-2"), "slot2-session", "独立字段取槽 2 会话");
  });

  await test("E3. saveConversationSession 双槽互不覆盖", () => {
    const created = conversations.createConversation();
    conversations.saveConversationSession(created.id, "sess-slot1", "ssh", "claude", "ssh-1");
    conversations.saveConversationSession(created.id, "sess-slot2", "ssh", "claude", "ssh-2");
    const saved = conversations.getConversation(created.id);
    assert.ok(saved, "会话应落库");
    assert.strictEqual(saved.sshSessionId, "sess-slot1", "槽 1 走旧字段");
    assert.strictEqual(saved.sshSessionId_ssh2 || saved["sshSessionId_ssh-2"], "sess-slot2", "槽 2 独立字段");
    conversations.deleteConversation(created.id);
  });

  await test("E4. addAssistantMessage 按 taskProfile 落对字段（切槽不串会话）", () => {
    const created = conversations.createConversation();
    conversations.addAssistantMessage(created.id, "槽 2 回答", "sess-slot2-abc", [], [], "", "ssh", null, 0, "claude", "ssh-2");
    const saved = conversations.getConversation(created.id);
    assert.strictEqual(saved.sshSessionId, "", "槽 2 回答不得污染槽 1 字段");
    assert.strictEqual(saved["sshSessionId_ssh-2"], "sess-slot2-abc", "槽 2 会话落独立字段");
    assert.strictEqual(saved.lastConnectionMode, "ssh", "真实三值模式记录");
    conversations.deleteConversation(created.id);
  });

  await test("E5. 清理会话：clearConversationSession 连 sshSessionId_* 一并清空", () => {
    const created = conversations.createConversation();
    conversations.saveConversationSession(created.id, "s1", "ssh", "claude", "ssh-1");
    conversations.saveConversationSession(created.id, "s2", "ssh", "claude", "ssh-2");
    assert.strictEqual(conversations.clearConversationSession(created.id), true, "清理应成功");
    const saved = conversations.getConversation(created.id);
    assert.ok(!saved.sshSessionId, "旧字段应清");
    assert.ok(!saved["sshSessionId_ssh-2"], "新槽字段应清");
    conversations.deleteConversation(created.id);
  });
}

// ════════════════ F. main.cjs IPC 接线 ════════════════
async function runMainTests() {
  await test("F1. 三条新 IPC 齐备", () => {
    for (const channel of ["model:update-entry", "model:update-compact", "settings:switch-ssh-profile"]) {
      assert.ok(mainSrc.includes(`"${channel}"`), `缺 IPC ${channel}`);
    }
  });

  await test("F2. 新模型通道与 model:update 同等级防护（管理员密码 + 确认弹窗）", () => {
    const at = mainSrc.indexOf("model:update-entry");
    assert.ok(at >= 0);
    const body = mainSrc.slice(at, at + 2400);
    assert.ok(body.includes("assertModelAdminPassword"), "单项修改须过管理员密码");
    assert.ok(body.includes("showMessageBox"), "须有确认弹窗");
  });

  await test("F3. 云端模式闸：云端不提供五项模型配置（清晰文案）", () => {
    assert.ok(mainSrc.includes("云端模式不使用 Claude 五项模型配置"), "云端闸文案应落");
  });

  await test("F4. 任务启动槽快照 taskProfile（切槽不杀任务/不串会话）", () => {
    assert.ok(mainSrc.includes("taskProfile"), "任务启动应快照活跃槽");
    const at = mainSrc.indexOf("const taskProfile = activeSshProfileOf(config)");
    assert.ok(at >= 0, "turn 开始处快照");
    const after = mainSrc.slice(at, at + 26000);
    assert.ok(after.includes("saveConversationSession("), "落库调用在快照之后");
    assert.ok(after.includes("taskProfile"), "会话字段取快照槽");
  });

  await test("F5. model:status 模式感知（云端/本地引擎不再误走 SSH 读链）", () => {
    assert.ok(/connectionMode:\s*"cloud"/.test(mainSrc), "云端状态应自报 connectionMode=cloud");
    assert.ok(/noClaudeConfig:\s*true/.test(mainSrc), "本地引擎应自报无 Claude 配置");
  });

  await test("F6. 切槽 IPC 接 settings.switchSshProfile（切槽不杀任务）", () => {
    const at = mainSrc.indexOf("settings:switch-ssh-profile");
    assert.ok(at >= 0);
    const body = mainSrc.slice(at, at + 1200);
    assert.ok(body.includes("switchSshProfile"), "接 settings.switchSshProfile");
  });
}

// ════════════════ G. preload / renderer / index / styles 接线 ════════════════
async function runWiringTests() {
  await test("G1. preload 三新 API 齐备", () => {
    assert.ok(preloadSrc.includes("model:update-entry"), "updateModelEntry");
    assert.ok(preloadSrc.includes("model:update-compact"), "updateAutoCompactWindow");
    assert.ok(preloadSrc.includes("settings:switch-ssh-profile"), "switchSshProfile");
  });

  await test("G2. 设置中心第 6 导航「模型」与面板落位", () => {
    assert.ok(indexSrc.includes('data-settings-tab="models"'), "导航应有 models 页签");
    assert.ok(indexSrc.includes('data-settings-panel="models"'), "应有 models 面板");
    assert.ok(indexSrc.includes("model-entry-list"), "五项表容器");
    assert.ok(indexSrc.includes("auto-compact-setting"), "自动压缩阈值区");
  });

  await test("G3. 管理员密码三态弹窗（missing/invalid 初始化 + ready 确认）", () => {
    assert.ok(indexSrc.includes("model-password-dialog"), "密码弹窗应存在");
    assert.ok(rendererSrc.includes("openModelPasswordDialog"), "初始化弹窗入口");
    assert.ok(rendererSrc.includes("initializeModelAdminPassword"), "初始化 IPC 调用");
  });

  await test("G4. 卡槽 UI：切换条/命名输入/槽信息/隐藏活跃槽字段", () => {
    assert.ok(indexSrc.includes("ssh-profile-bar"), "卡槽切换条");
    assert.ok(indexSrc.includes("data-ssh-profile-id"), "切换按钮组");
    assert.ok(indexSrc.includes("sshProfileName"), "槽命名输入");
    assert.ok(indexSrc.includes('name="activeSshProfile"'), "活跃槽回显字段");
  });

  await test("G5. renderer 卡槽渲染与切换接线（含重载会话）", () => {
    assert.ok(rendererSrc.includes("renderSshProfiles"), "渲染函数");
    assert.ok(rendererSrc.includes("switchSshProfile"), "切换 IPC 调用");
    assert.ok(rendererSrc.includes('"models"'), "models 页签分发");
    assert.ok(rendererSrc.includes("refreshModelsPage"), "模型页刷新");
    assert.ok(rendererSrc.includes("renderModelEntryRow"), "五项表行渲染");
  });

  await test("G6. renderer 安全：远端 settings.json 值不经 innerHTML 注入", () => {
    const at = rendererSrc.indexOf("renderModelEntryRow");
    const body = rendererSrc.slice(at, at + 4000);
    if (body.includes("innerHTML")) {
      assert.ok(body.includes("textContent"), "含 innerHTML 时须有 textContent 防注入组合");
    }
    assert.ok(body.includes("createElement") || body.includes("textContent"), "以 DOM API 为主");
  });

  await test("G7. 五项表 UI 元素 + 保存按钮接线", () => {
    assert.ok(indexSrc.includes('id="save-model"'), "整套主模型保存");
    assert.ok(indexSrc.includes('id="model-entry-list"'), "五项表 DOM id");
    assert.ok(indexSrc.includes('id="save-auto-compact"'), "阈值保存按钮");
    assert.ok(rendererSrc.includes("updateModelEntry"), "renderer 调单项 IPC");
    assert.ok(rendererSrc.includes("updateAutoCompactWindow"), "renderer 调阈值 IPC");
  });

  await test("G8. 样式：五项表/卡槽条主题（含 light 皮肤）", () => {
    assert.ok(stylesSrc.includes(".model-entry-row"), "五项表行样式");
    assert.ok(stylesSrc.includes('[data-theme="light"] .model-entry-row'), "light 皮肤样式");
    assert.ok(stylesSrc.includes("#ssh-profile-bar"), "卡槽条样式");
    assert.ok(stylesSrc.includes('[data-theme="light"] #ssh-profile-bar'), "卡槽条 light 皮肤");
  });

  await test("G9. 版本号 3.18.0", () => {
    assert.strictEqual(pkg.version, "3.18.0");
  });
}

async function run() {
  console.log("══ Agent-Chat-Pro v3.18.0（F2 模型页 + F4 SSH 双卡槽）══");
  await runModelConfigTests();
  await runLocalTests();
  await runSshTests();
  await runSettingsTests();
  await runConversationsTests();
  await runMainTests();
  await runWiringTests();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failures.length) {
    console.log("\n失败明细：");
    for (const item of failures) console.log(`  - ${item}`);
    process.exitCode = 1;
  }
}

run();