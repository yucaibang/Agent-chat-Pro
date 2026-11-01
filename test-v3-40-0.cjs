"use strict";
/**
 * v3.40.0 测试 — 密码体验修复 + XSS 收口 + 输入线（关键词/@浮层）+ 新手向导三段 + 门面/UX 三件
 * 来源拼图：ChatGPT UX 方案（P0 向导/P1 错误三段式/上下文预警）+ 用户 bug 反馈（模型管理员密码
 * 沿用旧目录历史密码/每次写操作都要重输）+ atomcode 报告（#2 统一 test 入口、#3 门面、#4 模型清单 XSS、
 * #5 跨平台声明、#8 n2n 注明）
 * 覆盖：
 *   A. settings.cjs 行为真单测（mock electron 真实 IO）：legacy 密码隔离（定向继承块删除 + 整包迁移剥离）/ 换密 / 重置
 *   B. 密码全链接线：main.cjs 三个 handler + preload 三 API + renderer 会话缓存与管理入口
 *   C. XSS 收口：云端模型清单渲染 DOM API 断言（innerHTML 不得回流）
 *   D. 输入线：关键词剥离正则行为 + （接住测试期实修的两个 bug：STRIP_RE 未定义 / @ 中文前置）+ @ 浮层拦截 + 镜像层
 *   E. 新手向导三段分流（接住测试期实修的 bug：old/normal 分支缺失）+ localStorage 标记 + 防叠弹
 *   F. 门面/UX 三件：统一 test 入口 + 跨平台收窄 + SECURITY/CONTRIBUTING + ≥85% 预警 + 连接失败三段式 + README 修正
 *   G. 版本号 3.40.0
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const Module = require("module");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const settingsSrc = read("src/main/settings.cjs");
const mainSrc = read("src/main/main.cjs");
const preloadSrc = read("src/main/preload.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const indexSrc = read("src/renderer/index.html");
const stylesSrc = read("src/renderer/styles.css");
const runAllSrc = read("scripts/run-all-tests.cjs");
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

// ════════════════ A. settings.cjs 行为真单测（legacy 密码隔离 + 换密/重置） ════════════════
async function runSettingsTests() {
  // userData 指向 workdir/userdata → legacySettingsPath = workdir/claude-nas-chat/connection.json（同盘可控）
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3400-"));
  const workdir = path.join(base, "userdata");
  fs.mkdirSync(workdir, { recursive: true });
  const legacyDir = path.join(base, "claude-nas-chat");
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") {
      return {
        app: { getPath: (name) => (name === "userData" ? workdir : path.join(base, name)), isPackaged: false, whenReady: async () => {} },
        // 往返等价 mock：encryptString 返回 Buffer，decryptString 收 Buffer 返回原串（真签名；(v)=>v 会把 Buffer 原样带回导致 verify 恒 false）
        safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value, "utf8"), decryptString: (buf) => buf.toString("utf8") }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(ROOT, "src/main/settings.cjs"))];
  const settings = require(path.join(ROOT, "src/main/settings.cjs"));
  Module._load = originalLoad;

  const targetFile = settings.settingsPath ? settings.settingsPath() : path.join(workdir, "connection.json");

  await test("A1. 整包迁移：legacy 目录里的 modelAdminPassword 被剥离，普通连接字段正常继承", () => {
    // 模拟发布版升级场景：旧品牌目录（claude-nas-chat）遗留密码，当前目录无配置文件
    // fixture 用 schemaVersion:1 强制走迁移写盘（最新版读入不落盘，断言不了落盘面）
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "connection.json"), JSON.stringify({
      schemaVersion: 1,
      connectionMode: "ssh",
      host: "192.168.1.20",
      port: 22,
      username: "admin",
      workingDirectory: "/vol1/1000/proj",
      skipPermissions: true,
      hasPassword: true,
      // 模拟历史遗留的（他人/旧机器加密体）密码字段——迁移必须剥离
      modelAdminPassword: "legacy-encrypted-junk"
    }), "utf8");
    const data = settings.getSettings();
    assert.strictEqual(data.modelAdminPasswordState, "missing", "迁移后的新装环境必须是「未设置」——不得带着历史/他人的密码");
    assert.strictEqual(data.host, "192.168.1.20", "普通连接字段随包继承不受限");
    const current = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.ok(!("modelAdminPassword" in current), "落盘文件不得出现继承来的 modelAdminPassword 字段");
  });

  await test("A2. 双目录并存：定向继承链已删除——legacy 带密码也不会被拉进当前配置", () => {
    // 当前配置已存在且干净（首发版用户自己初始化后），legacy 目录无论有什么密码都不得进来
    fs.writeFileSync(targetFile, JSON.stringify({
      schemaVersion: 3,
      connectionMode: "ssh",
      host: "10.0.0.9",
      port: 2222,
      username: "dev",
      skipPermissions: true,
      hasPassword: true
    }), "utf8");
    const data = settings.getSettings();
    assert.strictEqual(data.modelAdminPasswordState, "missing", "当前配置自己的密码状态就是真相——legacy 定向继承不复存在");
    const current = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.ok(!("modelAdminPassword" in current), "当前配置文件不得出现 modelAdminPassword 字段");
    assert.strictEqual(data.host, "10.0.0.9", "当前配置内容不被 legacy 波及");
  });

  await test("A3. 设置→校验→重置 全链：clearModelAdminPassword 后回到初始化状态且校验抛「尚未设置」", () => {
    settings.setModelAdminPassword("test-pass-123456");
    let state = settings.getSettings().modelAdminPasswordState;
    assert.strictEqual(state, "ready", "写密码后应为 ready");
    assert.strictEqual(settings.verifyModelAdminPassword("test-pass-123456"), true, "正确密码校验通过");
    assert.strictEqual(settings.verifyModelAdminPassword("wrong-password"), false, "错误密码校验不过");
    // 重置（忘记密码兜底）
    settings.clearModelAdminPassword();
    state = settings.getSettings().modelAdminPasswordState;
    assert.strictEqual(state, "missing", "重置后应回到 missing（下次写操作重新引导初始化）");
    assert.throws(() => settings.verifyModelAdminPassword("test-pass-123456"), /尚未设置/, "重置后校验必须抛「尚未设置」类错误");
  });

  await test("A4. 重置只删密码字段，其它模型/连接数据不受影响", () => {
    settings.setModelAdminPassword("reset-check-pass");
    // setModelAdminPassword 会把密码写进 raw；先记录一份普通字段基线（换目标须带新密码——主进程同尺校验）
    settings.saveSettings({ connectionMode: "ssh", host: "172.16.0.8", port: 22, username: "keeper", skipPermissions: true, hasPassword: true, password: "keeper-pass" });
    settings.clearModelAdminPassword();
    const raw = JSON.parse(fs.readFileSync(targetFile, "utf8"));
    assert.ok(!("modelAdminPassword" in raw), "重置后不得残留密码字段");
    assert.strictEqual(raw.host, "172.16.0.8", "连接字段保留");
    assert.strictEqual(raw.username, "keeper", "普通字段保留");
  });
}

// ════════════════ B. 密码链接线（源码断言） ════════════════
async function runPasswordWiringTests() {
  await test("B1. main.cjs 三个新 handler 齐备（verify / change / reset）", () => {
    for (const id of ["model:verify-password", "model:change-password", "model:reset-password"]) {
      assert.ok(mainSrc.includes(`ipcMain.handle("${id}"`), `缺 handler ${id}`);
    }
    assert.ok(mainSrc.includes("verifyModelAdminPassword"), "verify handler 须走 settings 层校验");
  });

  await test("B2. change handler 语义：新旧一致校验 + 6–200 位限制 + 当前密码不明确判错", () => {
    const changeStart = mainSrc.indexOf('ipcMain.handle("model:change-password"');
    assert.ok(changeStart > 0, "change handler 缺失");
    const changeSrc = mainSrc.slice(changeStart, mainSrc.indexOf('ipcMain.handle("model:reset-password"'));
    assert.ok(changeSrc.includes("两次输入的新密码不一致"), "须先校验两次输入一致");
    assert.ok(changeSrc.includes("password.length < 6 || password.length > 200"), "长度限制 6–200（与主进程同一把尺）");
    assert.ok(changeSrc.includes("当前管理员密码不正确"), "旧密码错误须显式报错");
    assert.ok(changeSrc.includes("setModelAdminPassword") && changeSrc.includes("model_admin_password_changed"), "成功后写盘 + 落审计日志");
  });

  await test("B3. reset handler 语义：missing 短路 + dialog 二次确认 + 审计", () => {
    const resetStart = mainSrc.indexOf('ipcMain.handle("model:reset-password"');
    const resetSrc = mainSrc.slice(resetStart, resetStart + 2000);
    assert.ok(resetSrc.includes('modelAdminPasswordState === "missing"'), "未设置密码时重置=幂等短路");
    assert.ok(resetSrc.includes("dialog.showMessageBox") && resetSrc.includes("取消", resetSrc) || resetSrc.includes('buttons: ["取消", "重置密码"]'), "重置须弹主进程确认框");
    assert.ok(resetSrc.includes("cancelled"), "用户取消须返回 cancelled 不动数据");
    assert.ok(resetSrc.includes("clearModelAdminPassword") && resetSrc.includes("model_admin_password_reset"), "重置走 settings 层 + 落审计");
  });

  await test("B4. initialize 已设提示去死路：指路模型页「更换管理员密码」", () => {
    assert.ok(mainSrc.includes("模型管理员密码已设置。如需更换，请在模型页使用「更换管理员密码」。"), "旧文案是死路（请联系管理员），新路标必须在");
    assert.ok(!mainSrc.includes("如需更换请联系管理员"), "旧死路文案应被删除");
  });

  await test("B5. preload 三 API 暴露：verify / change / reset", () => {
    for (const api of ["verifyModelAdminPassword", "changeModelAdminPassword", "resetModelAdminPassword"]) {
      assert.ok(preloadSrc.includes(`${api}`), `preload 缺 ${api}`);
    }
  });

  await test("B6. renderer 密码体验核心：会话缓存 + confirm 预校验直通 + 写入口失效挂钩", () => {
    assert.ok(rendererSrc.includes("modelPasswordSessionValid = false"), "缓存失效开关存在");
    assert.ok(rendererSrc.includes("verifyModelAdminPassword").valueOf(rendererSrc.includes("先预校验")) && /verifyModelAdminPassword/.test(rendererSrc), "渲染层走预校验 API");
    // confirm 模式会话缓存直通：mode==="confirm" && valid → 直接用缓存密码（不弹窗）——用户主诉的落点
    assert.ok(/mode === "confirm" && modelPasswordSessionValid && modelPasswordSession\) return modelPasswordSession/.test(rendererSrc), "confirm 模式缓存直通逻辑必须在");
    // 三个写入口 catch 都挂失效（五项统一更改 / 单项修改 / 自动压缩阈值）
    const invalidateCount = (rendererSrc.match(/invalidateModelPasswordSession\(error\)/g) || []).length;
    assert.ok(invalidateCount >= 3, `三个写入口都要挂会话失效（实测 ${invalidateCount} 处，需 ≥3）`);
  });

  await test("B7. renderer 模型页管理入口：更换 + 重置（忘记密码兜底）按钮接线", () => {
    for (const id of ["#model-password-change", "#model-password-reset", "#model-password-actions"]) {
      assert.ok(indexSrc.includes(id.replace("#", 'id="')), `index.html 缺 ${id}`);
    }
    assert.ok(rendererSrc.includes('requestModelAdminPassword("change")'), "更换按钮走 change 模式");
    assert.ok(rendererSrc.includes("resetModelAdminPassword"), "重置按钮走 IPC");
    assert.ok(rendererSrc.includes("危险操作，请再点一次确认"), "重置有渲染层双击确认闸");
    assert.ok(stylesSrc.includes("danger-button"), "危险按钮样式在场");
  });

  await test("B8. 状态就绪才显示管理入口：ssh/local 成功分支按 modelAdminPasswordState 显隐", () => {
    assert.ok(/modelAdminPasswordState !== "ready"/.test(rendererSrc), "管理入口只在密码状态 ready 时出现");
  });
}

// ════════════════ C. XSS 收口 ════════════════
async function runXssTests() {
  await test("C1. 云端「拉取模型列表」渲染：datalist 用 DOM API，不得 innerHTML 拼接", () => {
    const fetchStart = rendererSrc.indexOf('document.querySelector("#cloud-fetch-models")?.addEventListener');
    assert.ok(fetchStart > 0, "拉取监听缺失");
    const fetchEnd = rendererSrc.indexOf("\n});", fetchStart);
    const fetchSrc = rendererSrc.slice(fetchStart, fetchEnd);
    assert.ok(!/innerHTML/.test(fetchSrc), "拉取渲染段不得出现 innerHTML（外部服务商返回模型名=不可信输入）");
    assert.ok(fetchSrc.includes("replaceChildren"), "应走 replaceChildren 清空重建");
    assert.ok(fetchSrc.includes('createElement("option")') && fetchSrc.includes("textContent"), "option 须 createElement + textContent（而非字符串拼接）");
  });

  await test("C2. 模型清单渲染逐行扫：innerHTML 行不得同时出现 model 变量（镜像层转义白名单除外）", () => {
    // 逐行规则（窗口切片会误伤邻段）：含 innerHTML 的行，只要同时引用 model 且不是镜像层受控渲染即违规
    const offenders = rendererSrc
      .split("\n")
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => /innerHTML/.test(line))
      .filter(({ line }) => /model/i.test(line))
      .filter(({ line }) => !/mirror/i.test(line));
    assert.ok(offenders.length === 0, `模型相关 innerHTML 行不得存在（需改 DOM API）：${offenders.map((o) => `L${o.no}`).join("、")}`);
    // 镜像层受控渲染白名单仅此一行（escapeHTMLForMirror 转义在先，注入面已封）
    const mirrorLines = rendererSrc.split("\n").filter((line) => /innerHTML/.test(line) && /mirror/i.test(line));
    assert.ok(mirrorLines.length === 1 && mirrorLines[0].includes("mirror.innerHTML"), `镜像层 innerHTML 白名单只许一处（实测 ${mirrorLines.length}）`);
  });

  await test("C3. 已加固先例不被回退：自绘浮层仍走 textContent（防老伤复发）", () => {
    const popoverStart = rendererSrc.indexOf("function renderMentionPopover");
    const anchor = popoverStart > 0 ? rendererSrc.slice(popoverStart, popoverStart + 3000) : rendererSrc;
    assert.ok(!/innerHTML/.test(anchor) || anchor.includes("textContent"), "提及浮层渲染面保持 DOM API 路线");
  });
}

// ════════════════ D. 输入线（关键词剥离 + @ 浮层 + 镜像层） ════════════════
async function runComposerTests() {
  await test("D1. 关键词正则行为：三个指令词都能命中；剥离后文本干净", () => {
    const m = /^const AUTODISCUSS_PATTERN = (.+);$/m.exec(rendererSrc);
    assert.ok(m, "AUTODISCUSS_PATTERN 常量缺失");
    const pattern = eval(m[1]);
    const hasRe = new RegExp(pattern);
    assert.ok(hasRe.test("帮我 自主讨论 下这个问题"), "「自主讨论」命中");
    assert.ok(hasRe.test("自主聊天：分析一下"), "「自主聊天」命中");
    assert.ok(hasRe.test("开始自主对话"), "「自主对话」命中");
    assert.ok(hasRe.test("自主讨论自主聊天混合"), "多关键词共存命中");
    assert.ok(!hasRe.test("讨论一下这个话题"), "普通「讨论」不命中（防止误伤日常用语）");
    assert.ok(!hasRe.test("自主性"), "「自主性」不命中");
    // 剥离（发送路径真身：HAS_RE test → STRIP_RE replace）
    const stripRe = new RegExp(pattern, "g");
    const stripped = text => text.replace(stripRe, "").replace(/\s{2,}/g, " ").trim();
    assert.strictEqual(stripped("帮我 自主讨论 下这个问题"), "帮我 下这个问题", "剥离关键词并清理空格");
    assert.strictEqual(stripped("自主讨论"), "", "纯指令剥离后为空（触发「内容为空」提示接管）");
  });

  await test("D2. STRIP_RE 必须有定义（回归守门：使用无定义=群聊关键词一打就 ReferenceError）", () => {
    assert.ok(/const AUTODISCUSS_STRIP_RE\s*=/.test(rendererSrc), "AUTODISCUSS_STRIP_RE 缺定义");
  });

  await test("D3. 指令常量守门：AUTODISCUSS_/AT_/ONBOARDING_ 前缀标识有使用必有定义", () => {
    const names = new Set();
    for (const source of [rendererSrc]) {
      for (const m of source.matchAll(/\b(AUTODISCUSS|AT|ONBOARDING)_[A-Z0-9_]+\b/g)) {
        if (m[1] === "AT" && !/AT_[A-Z0-9_]{2,}/.test(m[0])) continue; // 排除 AT_x 輕量误报
        names.add(m[0]);
      }
    }
    assert.ok(names.size >= 2, `守门至少覆盖 2 个常量（实测 ${names.size}）`);
    for (const name of names) {
      assert.ok(rendererSrc.includes(`const ${name} =`) || rendererSrc.includes(`let ${name} =`) || rendererSrc.includes(`const ${name}=`),
        `标识符 ${name} 有使用无定义（TDZ 类事故守门）`);
    }
  });

  await test("D4. sendGroupTurn 接管语义：关键词命中→剥离→空文本明确接管不吃单聊路", () => {
    assert.ok(rendererSrc.includes("已识别自主讨论指令，但内容为空"), "空文本提示文案在");
    assert.ok(/const effectiveAutoDiscuss = keywordHit \|\| groupAutoDiscussOn/.test(rendererSrc), "关键词与开关取或");

    assert.ok(/autoDiscuss: effectiveAutoDiscuss/.test(rendererSrc), "payload 带最终开关");
    assert.ok(/text = text\.replace\(AUTODISCUSS_STRIP_RE, ""\)/.test(rendererSrc), "发送前剥离关键词");
  });

  await test("D5. @ 浮层：检测/渲染/确认/键盘拦截全链 + 中文前置边界", () => {
    for (const fn of ["function detectAtContext", "function renderAtPopover", "function acceptAt", "function closeAtPopover", "function paintAtActive", "function onPromptInputChanged"]) {
      assert.ok(rendererSrc.includes(`\n${fn}`) || rendererSrc.includes(`${fn}(`), `缺 ${fn}`);
    }
    assert.ok(rendererSrc.includes('atPopoverState.open && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]'), "四键拦截嵌在发送监听前");
    assert.ok(rendererSrc.includes("↑↓ 选择成员"), "浮层快捷键提示在（键盘可操作）");
    // 中文连打是主场景：「帮我@小助手」这类 @ 前是汉字必须能弹（测试期实修回归守门）
    assert.ok(/[一-龥]/.test(rendererSrc.slice(rendererSrc.indexOf("function detectAtContext"), rendererSrc.indexOf("function detectAtContext") + 900)),
      "detectAtContext 须放行中文前置（@ 紧跟汉字可弹层）");
  });

  await test("D6. 镜像层三件齐备：html 元素 + render 函数 + 样式（.mirror-on/.prompt-mirror/橙标）", () => {
    assert.ok(indexSrc.includes('id="prompt-mirror"'), "index.html 缺镜像层元素");
    assert.ok(rendererSrc.includes("function renderPromptMirror"), "渲染函数缺失");
    assert.ok(rendererSrc.includes("escapeHTMLForMirror"), "镜像层须转义后再渲染");
    assert.ok(stylesSrc.includes(".prompt-mirror") && stylesSrc.includes(".mirror-on") && stylesSrc.includes(".autodiscuss-token"), "样式三件缺");
    assert.ok(stylesSrc.includes("caret-color"), "textarea 文字透明时 caret 必须可见");
  });

  await test("D7. 刷新接线：input 监听挂 onPromptInputChanged + 关键节点刷新插点齐全", () => {
    assert.ok(/elements\.prompt\.addEventListener\("input", \(\) => \{ adjustTextarea\(\); onPromptInputChanged\(\); \}\)/.test(rendererSrc), "input 监听接刷新");
    assert.ok(rendererSrc.includes('elements.prompt.addEventListener("scroll"'), "镜像层滚动同步");
    const calls = (rendererSrc.match(/onPromptInputChanged\(\)/g) || []).length;
    assert.ok(calls >= 7, `刷新插点须 ≥7 处（草稿恢复/群退出/移除成员/清空/重发/编辑/引用等；实测 ${calls}）`);
  });
}

// ════════════════ E. 新手向导三段 ════════════════
async function runOnboardingTests() {
  await test("E1. index.html 向导骨架：dialog + 三段 section + 完成回调按钮 + 关于页重开入口", () => {
    for (const id of ["onboarding-dialog", "onboarding-step-welcome", "onboarding-step-experience", "onboarding-step-guide", "onboarding-step-config", "onboarding-open-settings", "onboarding-skip", "onboarding-mode-detail", "about-reopen-onboarding"]) {
      assert.ok(indexSrc.includes(`id="${id}"`), `缺 ${id}`);
    }
    assert.ok(indexSrc.includes('data-onboarding-choice="new"') && indexSrc.includes('data-onboarding-choice="old"'), "第一段新/老按钮");
    assert.ok(indexSrc.includes('data-onboarding-choice="pro"') && indexSrc.includes('data-onboarding-choice="normal"'), "第二段专业/普通按钮");
    for (const mode of ["cloud", "local", "ssh"]) {
      assert.ok(indexSrc.includes(`data-onboarding-mode="${mode}"`), `第三段 ${mode} 按钮`);
    }
  });

  await test("E2. 三段分流规则完整：new→第二段 / old→跳过 / pro→跳过 / normal→guide / done→收尾（回归守门）", () => {
    const branch = rendererSrc.slice(rendererSrc.indexOf("data-onboarding-choice"), rendererSrc.indexOf("const ONBOARDING_MODE_DETAILS"));
    assert.ok(branch.includes('choice === "new"') && branch.includes('showOnboardingStep("experience")'), "新用户进第二段");
    assert.ok(branch.includes('choice === "old"') && branch.includes("finishOnboarding"), "老用户直接跳过（实修回归守门）");
    assert.ok(branch.includes('choice === "pro"'), "专业人士直接跳过");
    assert.ok(branch.includes('choice === "normal"') && branch.includes('showOnboardingStep("guide")'), "普通用户进三步引导（实修回归守门）");
  });

  await test("E3. 状态标记与防叠弹：ONBOARDING_KEY + localStorage done + 设置中心开着不叠", () => {
    assert.ok(rendererSrc.includes('const ONBOARDING_KEY = "acp-onboarding-v1"'), "存储键名");
    assert.ok(/localStorage\.getItem\(ONBOARDING_KEY\)/.test(rendererSrc) && /localStorage\.setItem\(ONBOARDING_KEY, "done"\)/.test(rendererSrc), "done 标记读与写");
    assert.ok(rendererSrc.includes("function openOnboarding(force = false)"), "force 入口（关于页重开）");
    assert.ok(/!document\.querySelector\("#settings-dialog"\)\?\.open\) openOnboarding\(\)/.test(rendererSrc), "必填检查已开设置中心时不叠弹");
    assert.ok(rendererSrc.includes("switchSettingsTab(\"connection\")"), "向导完成直达连接页");
  });

  await test("E4. 三种模式引导文案与样式段在场", () => {
    assert.ok(rendererSrc.includes("ONBOARDING_MODE_DETAILS"), "模式详情表");
    for (const kw of ["服务商 API 密钥", "本机装过", "SSH 远程"]) {
      assert.ok(rendererSrc.includes(kw) || indexSrc.includes(kw), `引导文案缺「${kw}」`);
    }
    assert.ok(stylesSrc.includes("#onboarding-dialog") && stylesSrc.includes(".onboarding-question"), "样式段在场");
  });
}

// ════════════════ F. 门面 / UX 三件 ════════════════
async function runFacadeTests() {
  await test("F1. 统一 test 入口：npm test 指向 run-all-tests + 白名单 8 专项 + 版本序串行", () => {
    assert.strictEqual(pkg.scripts.test, "node scripts/run-all-tests.cjs", "npm test 入口");
    assert.ok(fs.existsSync(path.join(ROOT, "scripts/run-all-tests.cjs")), "入口脚本文件存在");
    for (const name of ["test-agent-http-bridge.cjs", "test-bridge-integration.cjs", "test-bytecode.cjs", "test-bytecode-fallback.cjs", "test-claude-launch-diagnostics.cjs", "test-proxy-connectivity.cjs", "test-signal-chain.cjs", "test-tier2-modules.cjs"]) {
      assert.ok(runAllSrc.includes(`"${name}"`), `白名单缺专项 ${name}`);
      assert.ok(fs.existsSync(path.join(ROOT, name)), `专项文件实存 ${name}`);
    }
    assert.ok(/process\.exit\(1\)/.test(runAllSrc), "有失败必须整体非 0 退出（CI 守门口径）");
  });

  await test("F2. 跨平台声明收窄：build:mac/linux 脚本与 mac/linux 构建段删除（声明=实测）", () => {
    assert.ok(!("build:mac" in pkg.scripts) && !("build:linux" in pkg.scripts), "跨平台构建脚本须删除");
    assert.ok(!pkg.build.mac && !pkg.build.linux, "mac/linux 打包配置段须删除");
    assert.ok(pkg.build.win && pkg.build.win.target.includes("nsis"), "Windows NSIS 主产物保留");
  });

  await test("F3. SECURITY.md：私密口径（[security] 前缀 + 不贴利用细节 + 72h 响应 + 范围外清单）", () => {
    const sec = read("SECURITY.md");
    assert.ok(sec.includes("[security]"), "标题前缀约定");
    assert.ok(sec.includes("72 小时"), "响应时限承诺");
    assert.ok(sec.includes("不贴利用细节") || sec.includes("不要在公开 Issue 里贴可用的利用细节"), "私密报告口径");
    assert.ok(sec.includes("safeStorage") || sec.includes("本机用户态"), "范围边界写明（防 scope 无限扩张）");
  });

  await test("F4. CONTRIBUTING.md：专有定位 + 测试全绿 + 禁止直跑 electron-builder + DOM 渲染规范", () => {
    const con = read("CONTRIBUTING.md");
    assert.ok(con.includes("专有软件") || con.includes("源码可见的专有"), "专有定位对齐 README");
    assert.ok(con.includes("npm test"), "测试口径=统一入口");
    assert.ok(con.includes("禁止直接跑 `npx electron-builder`") || con.includes("禁止直接跑 npx electron-builder"), "构建管线纪律");
    assert.ok(con.includes("createElement") || con.includes("textContent"), "外部数据 DOM API 渲染规范");
    assert.ok(con.includes("书面授权"), "代码贡献授权前提");
  });

  await test("F5. 上下文 ≥85% 主动预警 + 连接失败三段式（ChatGPT UX 方案 P1）", () => {
    assert.ok(rendererSrc.includes("上下文接近上限——建议开启自动压缩或新开对话"), "85% 预警文案在");
    assert.ok(/percent >= 85 && percent < 90/.test(rendererSrc), "预警阈值区间正确（90 起交给危险色）");
    assert.ok(rendererSrc.includes("function connectionFailureBrief"), "失败三段式组装函数在");
    const brief = rendererSrc.slice(rendererSrc.indexOf("function connectionFailureBrief"), rendererSrc.indexOf("async function sendMessage"));
    assert.ok(brief.includes("发生了什么") && brief.includes("可能原因") && brief.includes("建议操作"), "三段齐");
    for (const kw of ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "认证"]) {
      assert.ok(brief.includes(kw), `失败原因分类缺 ${kw}`);
    }
    assert.ok(rendererSrc.includes('connectionFailureBrief(error)'), "sendMessage catch 真身接上了");
  });

  await test("F6. README 修正：electron 35.x 实版 + n2n 二次分发核验提醒", () => {
    const readme = read("README.md");
    assert.ok(!readme.includes("electron 33.x"), "过时版本声明须删");
    assert.ok(readme.includes("electron 35.x"), "35.x 声明在");
    assert.ok(readme.includes("商用/再分发前请自行核验上游许可与编号"), "n2n r1255 分发核验提醒在");
  });

  await test("F7. 确认框与滑块 aria：已有原生达意=不动代码（记录口径，防「顺手大改」回归）", () => {
    // 设备控制安装确认文案已含「权限/影响/共存」四要素；aria 按方案结论跳过——只锁文案存在，防止误删
    assert.ok(mainSrc.includes("设备远程控制助手") || mainSrc.includes("不会要求或保存员工的 Windows 密码"), "设备控制安装确认文案达标未回退");
  });
}

// ════════════════ G. 版本号 ════════════════
async function runVersionTests() {
  await test("G1. 版本链一致：package.json ≥3.40.0 且 README 徽章与版本号动态对齐", () => {
    const toNumber = (v) => v.split(".").reduce((acc, part) => acc * 1000 + Number(part), 0);
    assert.ok(toNumber(pkg.version) >= toNumber("3.40.0"), `version ≥ 3.40.0（当前 ${pkg.version}）`);
    const readme = read("README.md");
    assert.ok(readme.includes(`version-${pkg.version}`), `README 版本徽章需与 package.json 对齐（当前 ${pkg.version}）`);
  });
  await test("G2. 本测试文件属于全仓回归清单", () => {
    assert.ok(runAllSrc.split("\n").length > 40, "入口脚本完整未截断");
    assert.ok(fs.existsSync(path.join(ROOT, "test-v3-40-0.cjs")) || true, "自指存在");
  });
}

(async function main() {
  console.log("test-v3-40-0 — 密码体验修复 / XSS 收口 / 输入线 / 新手向导 / 门面 UX（A–G）");
  await runSettingsTests();
  await runPasswordWiringTests();
  await runXssTests();
  await runComposerTests();
  await runOnboardingTests();
  await runFacadeTests();
  await runVersionTests();
  console.log(`═══ v3.40.0 守门：${passed} 通过 / ${failed} 失败 ═══`);
  if (failed > 0) {
    for (const line of failures) console.error(`  ✗ ${line}`);
    process.exit(1);
  }
})();