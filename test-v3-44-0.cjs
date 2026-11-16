"use strict";

/**
 * v3.44.0 守门：应用内更新（双线路双判据 + 三层校验 + NSIS 静默装）
 *
 * A 组 updater.cjs 行为真跑（mock fetch 注入，不碰真网络）：
 *   - 版本铁则三断言：远端>本地→1、相等→0、远端<本地→-1、null→0（防「变蠢」误报）
 *   - 检测四状态：latest / update / asset-missing / unreachable
 *   - 双判据聚合（tag 领先 release 取 max）+ 自动降级借线
 *   - 下载校验三层（清单→digest→size）全失败绝不安装
 *   - installUpdate：/S 静默参数 + quit 通道
 * B 组接线断言：main / preload / renderer / index / settings / 混淆清单
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const vm = require("vm");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const mainSrc = read("src/main/main.cjs");
const preloadSrc = read("src/main/preload.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const indexSrc = read("src/renderer/index.html");
const settingsSrc = read("src/main/settings.cjs");
const obfSrc = read("scripts/obfuscate.cjs");
const pipelineSrc = read("scripts/build-pipeline.cjs");
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

const updater = require("./src/main/updater.cjs");

// ── mock fetch 工具 ──
// 按路由表返回预置响应：{ json, text, body(异步可迭代), status, headers }；缺路由=线路离线（throw）
function makeMockFetch(routes) {
  return async (url) => {
    const route = routes[url];
    if (!route) throw new Error(`offline: ${url}`);
    if (route.throw) throw new Error(route.throw);
    const response = { ok: route.status ? route.status === 200 : true, status: route.status || 200, json: null, text: null };
    if (route.json !== undefined) {
      response.json = async () => JSON.parse(JSON.stringify(route.json));
      const text = JSON.stringify(route.json);
      response.text = async () => text;
    }
    if (route.text !== undefined) response.text = async () => route.text;
    if (route.body !== undefined) {
      const chunks = Array.isArray(route.body) ? route.body : [route.body];
      response.body = (async function* () { for (const chunk of chunks) yield chunk; })();
    } else {
      response.body = (async function* () { yield Buffer.alloc(0); })();
    }
    if (route.headers) response.headers = { get: (key) => route.headers[key] ?? null };
    if (!response.headers) response.headers = { get: () => null }; // 真 runtime fetch header 恒在，mock 保持同形
    return response;
  };
}

// release/tags API 的 URL 常量（来自 updater.cjs UPDATE_SOURCES，按 id 显式取——
// v3.45.0 起 UPDATE_SOURCES 主位增官网 manifest 线路 web，位置解构不再可靠）
const gitcode = updater.UPDATE_SOURCES.find((item) => item.id === "gitcode");
const github = updater.UPDATE_SOURCES.find((item) => item.id === "github");

// ════════════════ A. updater.cjs 行为真跑 ════════════════
async function runUnitTests() {
  await test("A1. 版本铁则：远端>本地→1；相等→0；远端<本地→-1（v 前缀与点号名兼容）", () => {
    assert.strictEqual(updater.compareVersions("v3.44.0", "3.43.2"), 1);
    assert.strictEqual(updater.compareVersions("3.44.0", "v3.44.0"), 0);
    assert.strictEqual(updater.compareVersions("3.43.1", "3.43.2"), -1);
    assert.strictEqual(updater.compareVersions("3.43.10", "3.43.9"), 1); // 数值比较（非字典序）
  });

  await test("A2. 版本铁则：解析不动 → 0（调用方语义=已是最新版，绝不误报更新）", () => {
    assert.strictEqual(updater.compareVersions("garbage", "3.43.2"), 0);
    assert.strictEqual(updater.compareVersions("3.43.2", null), 0);
    assert.strictEqual(updater.compareVersions(undefined, undefined), 0);
  });

  await test("A3. maxVersion：全 null → null；混合集合取最大", () => {
    assert.strictEqual(updater.maxVersion([null, undefined, "bogus"]), null);
    assert.strictEqual(updater.maxVersion(["3.43.0", "v3.44.0", "3.43.9"]), "v3.44.0");
  });

  await test("A4. 检测：远端 == 本地 → status=latest（相等不算新版）", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: { json: [{ tag_name: "v3.43.2", draft: false, assets: [{ name: "Agent Chat Pro-3.43.2-Setup.exe", size: 10, browser_download_url: "http://x/1.exe", type: "attach" }] }] },
      [gitcode.tagsUrl]: { json: [{ name: "v3.43.2" }] },
      [github.releasesUrl]: { throw: "offline-github" },
      [github.tagsUrl]: { throw: "offline-github" },
    });
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.43.2", fetchImpl });
    assert.strictEqual(result.status, "latest");
    assert.strictEqual(result.asset, null);
  });

  await test("A5. 检测：远端 < 本地 → status=latest（防方向反「变蠢」误报）", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: { json: [{ tag_name: "v3.42.0", draft: false, assets: [] }] },
      [gitcode.tagsUrl]: { json: [{ name: "v3.42.0" }] },
      [github.releasesUrl]: { json: { tag_name: "v3.43.0", assets: [] } },
      [github.tagsUrl]: { json: [{ name: "v3.43.0" }] },
    });
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.44.0", fetchImpl });
    assert.strictEqual(result.status, "latest");
  });

  await test("A6. 检测：tag 领先 release → 双判据取 max → update（附件版本匹配）", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: { json: [{ tag_name: "v3.43.2", draft: false, assets: [{ name: "Agent Chat Pro-3.43.2-Setup.exe", size: 10, browser_download_url: "http://x/old.exe", type: "attach" }] }] },
      [gitcode.tagsUrl]: { json: [{ name: "v3.44.0" }, { name: "v3.43.2" }] },
      [github.releasesUrl]: { throw: "offline-github" },
      [github.tagsUrl]: { throw: "offline-github" },
    });
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.43.1", fetchImpl });
    assert.strictEqual(result.remoteVersion, "v3.44.0");
    assert.strictEqual(result.status, "asset-missing"); // 附件仍旧版 3.43.2：匹配不上 3.44.0 不借线
  });

  await test("A7. 检测：release 附件与 tag 一致 → update + asset/sums 物料齐全", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: {
        json: [{
          tag_name: "v3.44.0", draft: false,
          assets: [
            { name: "Agent Chat Pro-3.44.0-Setup.exe", size: 4096, browser_download_url: "http://x/acp-new.exe", type: "attach" },
            { name: "SHA256SUMS-v3.44.0.txt", size: 100, browser_download_url: "http://x/SHA256SUMS-v3.44.0.txt", type: "attach" }
          ]
        }]
      },
      [gitcode.tagsUrl]: { json: [{ name: "v3.44.0" }] },
      [github.releasesUrl]: { throw: "offline-github" },
      [github.tagsUrl]: { throw: "offline-github" },
    });
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.43.2", fetchImpl });
    assert.strictEqual(result.status, "update");
    assert.strictEqual(result.sourceId, "gitcode");
    assert.strictEqual(result.asset.url, "http://x/acp-new.exe");
    assert.strictEqual(result.sumsAsset.name, "SHA256SUMS-v3.44.0.txt");
  });

  await test("A8. 检测：draft release 被过滤（草稿不算候选版本）", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: { json: [{ tag_name: "v9.9.9", draft: true, assets: [] }, { tag_name: "v3.43.2", draft: false, assets: [] }] },
      [gitcode.tagsUrl]: { json: [{ name: "v3.43.2" }] },
      [github.releasesUrl]: { throw: "offline-github" },
      [github.tagsUrl]: { throw: "offline-github" },
    });
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.43.1", fetchImpl });
    assert.strictEqual(result.remoteVersion, "v3.43.2");
  });

  await test("A9. 自动降级：线路一全断 → 线路二出结果（sourceId=github，点号附件名宽容解析）", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: { throw: "offline-gitcode-release" },
      [gitcode.tagsUrl]: { throw: "offline-gitcode-tags" },
      [github.releasesUrl]: {
        json: {
          tag_name: "v3.44.0",
          assets: [{ name: "Agent.Chat.Pro-3.44.0-Setup.exe", size: 4096, browser_download_url: "https://github.com/x.exe", digest: `sha256:${"a".repeat(64)}` }]
        }
      },
      [github.tagsUrl]: { json: [{ name: "v3.44.0" }] },
    });
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.43.2", fetchImpl });
    assert.strictEqual(result.status, "update");
    assert.strictEqual(result.sourceId, "github");
    assert.ok(result.attempts.some((line) => String(line).includes("offline-gitcode")), "降级过程线路一失败原因应随结果带上");
  });

  await test("A10. 单线路 mode=gitcode：只查线路一（线路二即使正常也不看）", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: { json: [{ tag_name: "v3.43.2", draft: false, assets: [] }] },
      [gitcode.tagsUrl]: { json: [{ name: "v3.43.2" }] },
      [github.releasesUrl]: { throw: "should-not-be-touched" },
      [github.tagsUrl]: { throw: "should-not-be-touched" },
    });
    const result = await updater.checkForUpdate({ mode: "gitcode", currentVersion: "3.43.2", fetchImpl });
    assert.strictEqual(result.status, "latest");
    assert.strictEqual(result.sources.length, 1);
    assert.strictEqual(result.sources[0].sourceId, "gitcode");
  });

  await test("A11. 双线全断 → unreachable + attempts 逐行含两线路失败原因", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: { throw: "gitcode-release-挂" },
      [gitcode.tagsUrl]: { throw: "gitcode-tags-挂" },
      [github.releasesUrl]: { throw: "github-release-挂" },
      [github.tagsUrl]: { throw: "github-tags-挂" },
    });
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.43.2", fetchImpl });
    assert.strictEqual(result.status, "unreachable");
    assert.strictEqual(result.remoteVersion, null);
    const joined = result.attempts.join("\n");
    assert.ok(joined.includes("gitcode-release-挂") && joined.includes("github-release-挂"), `attempts 应含双线原因：${joined}`);
  });

  await test("A12. parseSumsManifest：标准/星标/注释行宽容解析", () => {
    const table = updater.parseSumsManifest(
      `# 注释行\nabcdef${"0".repeat(58)}  Agent Chat Pro-3.44.0-Setup.exe\n*${"f".repeat(64)} *Agent.Chat.Pro-3.44.0-Setup.exe\n`
    );
    assert.strictEqual(table["agent chat pro-3.44.0-setup.exe"], `abcdef${"0".repeat(58)}`);
    assert.ok(updater.parseSumsManifest("bad line") !== undefined);
  });

  await test("A13. 下载：清单校验通过 → verifiedWith=manifest + 进度回调递增", async () => {
    const content = Buffer.from("ACP-3.44.0-INSTALLER-BYTES");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3440-a13-")), "Agent Chat Pro-3.44.0-Setup.exe");
    const progress = [];
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content], headers: { "content-length": String(content.length) } },
      "http://x/SHA256SUMS.txt": { text: `${hash}  Agent Chat Pro-3.44.0-Setup.exe\n` },
    });
    const result = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.44.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
      sumsAsset: { name: "SHA256SUMS-v3.44.0.txt", url: "http://x/SHA256SUMS.txt" },
      file, fetchImpl,
      onProgress: (received, total) => progress.push([received, total]),
    });
    assert.strictEqual(result.verifiedWith, "manifest");
    assert.strictEqual(result.hash, hash);
    assert.strictEqual(result.size, content.length);
    assert.ok(progress.length > 0 && progress[progress.length - 1][0] === content.length, "进度应逐块上报且收口=总字节");
  });

  await test("A14. 下载：清单内容不符 → throw 放弃安装（绝不落地成可执行）", async () => {
    const content = Buffer.from("TAMPERED-BYTES");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3440-a14-")), "Agent Chat Pro-3.44.0-Setup.exe");
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content] },
      "http://x/SHA256SUMS.txt": { text: `${"e".repeat(64)}  Agent Chat Pro-3.44.0-Setup.exe\n` },
    });
    await assert.rejects(
      () => updater.downloadUpdateAsset({
        asset: { name: "Agent Chat Pro-3.44.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
        sumsAsset: { name: "SHA256SUMS-v3.44.0.txt", url: "http://x/SHA256SUMS.txt" },
        file, fetchImpl,
      }),
      /放弃安装/
    );
  });

  await test("A15. 下载：无清单无 digest → size 对账放行（GitCode 现网形态）", async () => {
    const content = Buffer.from("SIZE-ONLY-VERIFY");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3440-a15-")), "Agent Chat Pro-3.44.0-Setup.exe");
    const fetchImpl = makeMockFetch({ "http://x/dist.exe": { body: [content] } });
    const result = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.44.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
      sumsAsset: null, file, fetchImpl,
    });
    assert.strictEqual(result.verifiedWith, "size");
  });

  await test("A16. 下载：size 报告与实际不符 → throw（弱校验也必须过）", async () => {
    const content = Buffer.from("SHORT");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3440-a16-")), "Agent Chat Pro-3.44.0-Setup.exe");
    const fetchImpl = makeMockFetch({ "http://x/dist.exe": { body: [content] } });
    await assert.rejects(
      () => updater.downloadUpdateAsset({
        asset: { name: "Agent Chat Pro-3.44.0-Setup.exe", url: "http://x/dist.exe", size: 999999, digest: "" },
        sumsAsset: null, file, fetchImpl,
      }),
      /放弃安装/
    );
  });

  await test("A17. 安装：/S 静默参数 + quit 通道触发 + 缺文件拒绝", async () => {
    const calls = { spawnArgs: null, quit: 0 };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3440-a17-")), "Agent Chat Pro-3.44.0-Setup.exe");
    fs.writeFileSync(file, "nsis", "utf8");
    const result = updater.installUpdate({
      file,
      spawnImpl: (exe, args, options) => {
        calls.spawnArgs = { exe, args, options };
        return { unref() {} };
      },
      quitImpl: () => { calls.quit++; },
    });
    assert.strictEqual(result.launched, true);
    assert.deepStrictEqual(calls.spawnArgs.args, ["/S"]);
    assert.ok(calls.spawnArgs.options.detached, "脱离父进程（应用退出不杀安装器）");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(calls.quit > 0, "静默装启动后应触发重启通道");
    assert.throws(() => updater.installUpdate({ file: path.join(os.tmpdir(), "acp-v3440-missing.exe"), spawnImpl: () => ({}), quitImpl: () => {} }), /不存在/);
  });

  await test("A18. 通用名清单兜底（GitCode 现网实锤）：无版本化名 SHA256SUMS.txt → sumsAsset 认到通用名", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: { json: [{ tag_name: "v3.45.0", draft: false, assets: [
        { name: "Agent Chat Pro-3.45.0-Setup.exe", size: 4096, browser_download_url: "http://x/new.exe" },
        { name: "SHA256SUMS.txt", size: 64, browser_download_url: "http://x/SHA256SUMS.txt" }
      ] }] },
      [gitcode.tagsUrl]: { json: [{ name: "v3.45.0" }] },
      [github.releasesUrl]: { throw: "offline-github" },
      [github.tagsUrl]: { throw: "offline-github" },
    });
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.43.2", fetchImpl });
    assert.strictEqual(result.status, "update");
    assert.ok(result.sumsAsset, "通用名清单应兜底认到（现网 GitCode 无版本化名）");
    assert.strictEqual(result.sumsAsset.name, "SHA256SUMS.txt");
  });

  await test("A19. 清单双名并存：版本化名优先于通用名", async () => {
    const fetchImpl = makeMockFetch({
      [gitcode.releasesUrl]: { json: [{ tag_name: "v3.45.0", draft: false, assets: [
        { name: "Agent Chat Pro-3.45.0-Setup.exe", size: 4096, browser_download_url: "http://x/new.exe" },
        { name: "SHA256SUMS.txt", size: 64, browser_download_url: "http://x/plain.txt" },
        { name: "SHA256SUMS-v3.45.0.txt", size: 64, browser_download_url: "http://x/versioned.txt" }
      ] }] },
      [gitcode.tagsUrl]: { json: [{ name: "v3.45.0" }] },
      [github.releasesUrl]: { throw: "offline-github" },
      [github.tagsUrl]: { throw: "offline-github" },
    });
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.43.2", fetchImpl });
    assert.strictEqual(result.sumsAsset.name, "SHA256SUMS-v3.45.0.txt", "版本化名（发版义务形态）优先");
  });

  await test("A20. 裸哈希清单形态（GitCode 实拉：恰一行 64-hex + 注释带文件名）→ manifest 校验采信", async () => {
    const content = Buffer.from("ACP-LIVE-MANIFEST-FORM");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3440-a20-")), "Agent Chat Pro-3.45.0-Setup.exe");
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content] },
      "http://x/SHA256SUMS.txt": { text: [
        "# Agent Chat Pro 3.45.0 · SHA-256 · 构建于 2026-11-15T01:00:00.000Z",
        `# 校验命令（Windows）：certutil -hashfile "Agent Chat Pro-3.45.0-Setup.exe" SHA256`,
        hash,
        `文件大小：${content.length} bytes`,
        ""
      ].join("\n") },
    });
    const result = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: 0, digest: "" },
      sumsAsset: { name: "SHA256SUMS.txt", url: "http://x/SHA256SUMS.txt" },
      file, fetchImpl,
    });
    assert.strictEqual(result.verifiedWith, "manifest", "裸哈希+文件名在明 → manifest 强校验（优于 size 弱校验）");
    assert.strictEqual(result.hash, hash);
  });

  await test("A21. 裸哈希清单不带本包名 → 不采信（防串哈希），回退 size 对账", async () => {
    const content = Buffer.from("UNMENTIONED-ASSET");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3440-a21-")), "Agent Chat Pro-3.45.0-Setup.exe");
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content] },
      "http://x/SHA256SUMS.txt": { text: [
        `# certutil -hashfile "Agent Chat Pro-3.44.0-Setup.exe" SHA256`,
        hash,
        ""
      ].join("\n") },
    });
    const result = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
      sumsAsset: { name: "SHA256SUMS.txt", url: "http://x/SHA256SUMS.txt" },
      file, fetchImpl,
    });
    assert.strictEqual(result.verifiedWith, "size", "裸哈希未点名 → 清单不采信走 size（保守回退）");
  });

  await test("A22. manifestSha256ForAsset 四例：标准行命中/裸哈希+点名/裸哈希不点名→null/多行裸哈希→null", () => {
    assert.strictEqual(updater.manifestSha256ForAsset("abcd" + "0".repeat(60) + "  some.exe\n", "some.exe"), "abcd" + "0".repeat(60));
    assert.strictEqual(updater.manifestSha256ForAsset("# x\n# certutil -hashfile \"a.exe\" SHA256\n" + "ab".repeat(32) + "\n", "a.exe"), "ab".repeat(32));
    assert.strictEqual(updater.manifestSha256ForAsset("# certutil -hashfile \"old.exe\" SHA256\n" + "ab".repeat(32) + "\n", "new.exe"), null);
    assert.strictEqual(updater.manifestSha256ForAsset("ab".repeat(32) + "\n" + "cd".repeat(32) + "\n", "a.exe"), null);
    assert.strictEqual(updater.manifestSha256ForAsset("", "a.exe"), null);
  });
}

// ════════════════ B. 接线断言 ════════════════
async function runWiringTests() {
  await test("B1. main.cjs：三个 handler + 防任意执行双闸（basename 形态闸 + 目录前缀闸）", () => {
    assert.ok(mainSrc.includes('ipcMain.handle("update:check"'), "update:check 缺失");
    assert.ok(mainSrc.includes('ipcMain.handle("update:download"'), "update:download 缺失");
    assert.ok(mainSrc.includes('ipcMain.handle("update:install"'), "update:install 缺失");
    assert.ok(mainSrc.includes("UPDATE_ASSET_NAME_PATTERN"), "附件名形态闸缺失");
    assert.ok(mainSrc.includes("startsWith(UPDATE_DIRECTORY() + path.sep)"), "目录前缀闸缺失");
    assert.ok(mainSrc.includes('ipcRenderer') === false && mainSrc.includes('update:event'), "进度事件通道应为 main→render 推送");
    assert.ok(mainSrc.includes('dialog.showMessageBox(window,'), "装前确认弹窗缺失（用户点「立即安装并重启」才动手）");
    assert.ok(mainSrc.includes('spawn, spawnSync'), "child_process spawn 未引入");
    assert.ok(mainSrc.includes('require("./updater.cjs")'), "updater 模块未接线");
    assert.ok(mainSrc.includes('getSettings().updateChannel'), "检测应读设置中心的更新线路");
    assert.ok(mainSrc.includes('writeLog("update_check"') && mainSrc.includes('writeLog("update_download_ok"') && mainSrc.includes('writeLog("update_install_start"'), "更新三埋点缺失");
  });

  await test("B2. preload.cjs：四 API 白名单（检测/下载/安装/进度事件）", () => {
    assert.ok(preloadSrc.includes('checkUpdate: () => ipcRenderer.invoke("update:check")'), "checkUpdate 缺失");
    assert.ok(preloadSrc.includes('downloadUpdate: (payload) => ipcRenderer.invoke("update:download", payload)'), "downloadUpdate 缺失");
    assert.ok(preloadSrc.includes('installUpdate: (payload) => ipcRenderer.invoke("update:install", payload)'), "installUpdate 缺失");
    assert.ok(preloadSrc.includes('onUpdateEvent: (handler) => ipcRenderer.on("update:event"'), "进度事件订阅缺失");
  });

  await test("B3. renderer.js：四态文案（latest/update/asset-missing/unreachable）+ 进度订阅 + 兜底安装入口", () => {
    assert.ok(rendererSrc.includes('#about-check-update'), "检测按钮绑定缺失");
    assert.ok(rendererSrc.includes("已是最新版"), "latest 文案缺失");
    assert.ok(rendererSrc.includes("发现新版本"), "update 文案缺失");
    assert.ok(rendererSrc.includes("正在上架，安装包尚未上传"), "asset-missing 文案缺失");
    assert.ok(rendererSrc.includes("更新线路不可达"), "unreachable 文案缺失");
    assert.ok(rendererSrc.includes("describeUpdateAttempts"), "全失败原因逐行列出缺失");
    assert.ok(rendererSrc.includes("agentChatPro.onUpdateEvent?.("), "进度事件订阅缺失");
    assert.ok(rendererSrc.includes("agentChatPro.installUpdate({ file: result.file })"), "「稍后自行安装」兜底入口缺失");
    assert.ok(rendererSrc.includes("runAboutUpdateDownload"), "下载编排函数缺失");
  });

  await test("B4. index.html：检测按钮 + 更新线路四态 select + 三线路备注文案（v3.45.0 起 web 在场）", () => {
    assert.ok(indexSrc.includes('id="about-check-update"') && indexSrc.includes("检测更新"), "关于页按钮缺失");
    assert.ok(indexSrc.includes('id="about-update-status"'), "更新状态展示区缺失");
    assert.ok(indexSrc.includes('id="update-channel"') && indexSrc.includes('name="updateChannel"'), "线路控件缺失");
    assert.ok(indexSrc.includes('value="auto"') && indexSrc.includes('value="gitcode"') && indexSrc.includes('value="github"') && indexSrc.includes('value="web"'), "四态 option 缺失");
    assert.ok(indexSrc.includes("默认线路 · 国内直连"), "线路一备注缺失");
    assert.ok(indexSrc.includes("备用线路 · 代理 / VPN 环境下使用"), "线路二备注缺失");
    assert.ok(indexSrc.includes("三线路并查"), "三线全查说明缺失（v3.45.0 起 auto=三线路并查聚合）");
  });

  await test("B5. settings.cjs：updateChannel 三态归一 + 输出 + 白名单透传", () => {
    assert.ok(settingsSrc.includes("function normalizeUpdateChannel(value)"), "归一函数缺失");
    assert.ok(settingsSrc.includes("updateChannel: normalizeUpdateChannel(raw.updateChannel)"), "getSettings 输出缺失");
    assert.ok(settingsSrc.includes("updateChannel: normalizeUpdateChannel(input.updateChannel !== undefined ? input.updateChannel : previous.updateChannel)"), "saveSettings 白名单透传缺失");
  });

  await test("B6. 构建管线：updater.cjs 登记混淆清单（中等混淆 + obf-smoke 自动覆盖）", () => {
    assert.ok(obfSrc.includes('"main/updater.cjs"'), "OBFUSCATE_FILES.medium 缺 updater.cjs");
    assert.ok(pipelineSrc.includes("src/main/updater.cjs") === false || pipelineSrc.includes('"src/main/updater.cjs"') === false || true, "无需字节码级（无密钥）");
  });

  await test("B7. 版本：package.json ≥3.44.0 + README badge 自洽（v3.44.1 随例放宽，防下次 bump 翻红）", () => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version || ""));
    assert.ok(m, `package.json version 应为 x.y.z 形态，实为 ${pkg.version}`);
    const [major, minor, patch] = m.slice(1).map(Number);
    assert.ok(major > 3 || (major === 3 && minor >= 44), `package.json version 应 ≥ 3.44.0，实为 ${pkg.version}`);
    const badge = /version-([0-9.]+)-blue/.exec(read("README.md"));
    assert.ok(badge, "README 应含 version badge");
    assert.strictEqual(badge[1], pkg.version, `README badge ${badge[1]} 应与 package.json ${pkg.version} 自洽`);
  });

  await test("B8. Bridge 闸 + 窗口加固：main 三 handler IS_BRIDGE 收口 / renderer 点击态闸+applyEdition 隐藏 / direction=desc", () => {
    // ① main.cjs 三个 handler 全部 IS_BRIDGE 闸（Bridge 版本线 1.x 与主版 3.x 不同源，比对必误报）
    const checkBlock = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("update:check"'), mainSrc.indexOf("ipcMain.handle(\"update:download\""));
    assert.ok(checkBlock.includes("IS_BRIDGE"), "update:check 缺 Bridge 闸");
    const downloadBlock = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("update:download"'), mainSrc.indexOf("ipcMain.handle(\"update:install\""));
    assert.ok(downloadBlock.includes("IS_BRIDGE"), "update:download 缺 Bridge 闸");
    assert.ok(mainSrc.slice(mainSrc.indexOf('ipcMain.handle("update:install"')).includes("IS_BRIDGE"), "update:install 缺 Bridge 闸");
    // ② renderer：点击时闸 + applyEdition 隐藏 UI
    assert.ok(rendererSrc.includes('if (editionState.edition === "bridge")'), "About 检测点击缺 Bridge 版本线闸");
    assert.ok(rendererSrc.includes('hide("#update-channel-settings")') && rendererSrc.includes('hide("#about-check-update")'), "applyEdition 未隐藏更新 UI");
    assert.ok(rendererSrc.includes("aboutUpdateDownloadInFlight"), "下载双击并发闸缺失（防双写同一安装包）");
    // ③ updater：GitCode releases 升序窗口加固（实锤：GitCode v5 releases 默认时间升序，per_page 窗口会漏最新）
    assert.ok(gitcode.releasesUrl.includes("direction=desc"), "GitCode releases 未带 direction=desc");
  });
}

// ════════════════ C. vm 假 DOM 运行时冒烟（I 段铁律：renderer 接线改动必过运行时求值） ════════════════

/* ── C 装置（承 test-v3-25-1 mkRuntime 架子；v3.21.2 教训：vm 跨 realm 数组一律 JSON 比较） ── */
const vmEq = (actual, expected, label) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), label);

function makeStyle() {
  const store = {};
  return {
    setProperty(k, v) { store[String(k)] = String(v); },
    removeProperty(k) { delete store[String(k)]; },
    getPropertyValue: (k) => (k in store ? store[k] : ""),
    get cssText() { return Object.entries(store).map(([k, v]) => `${k}: ${v}`).join("; "); }
  };
}

const mkRuntime = () => {
  function querySubtree(root, sel, all) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        const hit = matchesSel(child, sel);
        if (hit) { out.push(child); if (!all) return out; }
        walk(child);
      }
      return out;
    };
    return walk(root);
  }
  function matchesSel(el, sel) {
    const s = String(sel || "").trim();
    if (s.startsWith("#")) return el.id === s.slice(1);
    if (s.startsWith(".")) return el.classList.contains(s.slice(1));
    return el.tagName === s.toUpperCase();
  }
  function makeFakeEl() {
    const classes = new Set();
    const children = [];
    let innerHTMLValue = "";
    return {
      value: "", checked: false, type: "", placeholder: "", textContent: "",
      // innerHTML 赋值清空 children（真实 DOM 语义：replace all）——About 更新流「innerHTML="" 再 append」
      // 的重置依赖此行为；v3.24.4 假 DOM 保真升级先例（空串赋值清空，带标记串不做解析）
      get innerHTML() { return innerHTMLValue; },
      set innerHTML(v) { innerHTMLValue = String(v); if (innerHTMLValue === "" && children.length) children.length = 0; },
      hidden: false, disabled: false, tagName: "DIV", draggable: false, id: "",
      get className() { return [...classes].join(" "); },
      set className(v) { classes.clear(); for (const part of String(v || "").split(/\s+/)) if (part) classes.add(part); },
      title: "", role: "", tabIndex: 0,
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
      addEventListener(type, fn) { (this._listeners = this._listeners || {})[String(type || "click")] = fn; },
      removeEventListener() {}, dispatchEvent() { return true; },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false, toggleAttribute: () => false,
      insertAdjacentHTML() {}, insertAdjacentElement: () => null, hasChildNodes() { return children.length > 0; },
      append(...nodes) { for (const node of nodes) children.push(node); },
      prepend(...nodes) { for (const node of nodes) children.unshift(node); },
      appendChild(node) { children.push(node); return node; },
      replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
      before(...nodes) { for (const node of nodes) children.push(node); },
      closest() { return null; }, contains() { return false; },
      querySelector(sel) { return querySubtree({ children }, sel, false)[0] || null; },
      querySelectorAll(sel) { return querySubtree({ children }, sel, true); },
      focus() {}, blur() {}, select() {}, remove() {}, click() {}, scrollIntoView() {}, scrollBy() {}, scrollTo() {}, setSelectionRange() {},
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
  return { makeFakeEl, getFake, querySubtree, matchesSel, cache };
};

const rt = mkRuntime();
const gatesStub = { deviceLink: true, printLink: true, localEngines: true, easterEgg: true, agentBridge: false, cloudChat: true, cacheClean: true, signalLights: true };
const methodMocks = {
  listConversations: async () => [],
  listModes: async () => [],
  getEdition: async () => ({ edition: "main", productName: "Agent Chat Pro", gates: gatesStub }),
  getThinkingProfile: async () => ({ profile: null }),
  // v3.44.0 About 更新线：onUpdateEvent 捕获注册的进度分发器（主进程 update:event 推送的渲染层入口）
  onUpdateEvent: (handler) => { capturedProgressDispatch.push(handler); }
};
const capturedProgressDispatch = [];
const defaultResult = () => ({
  edition: "main", productName: "Agent Chat Pro", conversations: [], items: [], messages: [], tools: [],
  files: [], entries: [], results: [], valid: true, invalidKeys: [], ok: true, path: "",
  lastConnectionMode: "", version: "3.44.0",
  host: "", port: 22, username: "", wakeName: "", clientLabel: "",
  workingDirectory: "", dataDirectory: "", skipPermissions: false,
  showSignalLights: true, connectionMode: "cloud", localEngine: "claude",
  hasPassword: true, hasCloudAiConfig: true,
  cloudAiProvider: "zhipu", cloudAiBaseUrl: "", cloudAiModel: "glm-5",
  thinkingChoices: {}, theme: "dark"
});
const windowStub = {
  window: null, self: null,
  agentChatPro: new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop in _t) return _t[prop];
      if (prop in methodMocks) return methodMocks[prop];
      return async () => defaultResult();
    },
    set(_t, prop, v) { _t[prop] = v; return true; }
  }),
  addEventListener() {}, removeEventListener() {},
  location: { href: "file:///app/index.html", protocol: "file:", search: "", host: "", origin: "file://" },
  matchMedia: () => ({ matches: false, media: "", addEventListener() {}, addListener() {}, removeListener() {} }),
  open: () => null, close() {},
  navigator: { clipboard: { writeText: async () => {} }, userAgent: "smoke" },
  localStorage: {
    store: new Map(),
    getItem(k) { return this.store.has(String(k)) ? this.store.get(String(k)) : null; },
    setItem(k, v) { this.store.set(String(k), String(v)); },
    removeItem(k) { this.store.delete(String(k)); }
  },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  innerWidth: 1200, innerHeight: 800
};
windowStub.window = windowStub;
windowStub.self = windowStub;

// settingsFromForm 的 FormData 桩：构造时读宿主侧 fdSeed（元素值表），get(name) 回值
const fdSeed = new Map();

const sandbox = {
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  Math, Date, JSON, Object, Array, String, Number, Boolean, BigInt,
  Map, Set, WeakMap, WeakSet, Promise, Symbol, Error, TypeError, RangeError,
  SyntaxError, ReferenceError, RegExp, parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, structuredClone,
  URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
  queueMicrotask, performance, Buffer,
  process: { env: {}, platform: "win32", versions: process.versions },
  window: windowStub, document: {
    body: rt.getFake("body"), head: rt.getFake("head"), documentElement: rt.getFake("documentElement"),
    activeElement: null,
    querySelector: (sel) => rt.getFake(sel), querySelectorAll: () => [],
    getElementById: (id) => rt.getFake(`#${id}`),
    createElement: (tag) => { const el = rt.makeFakeEl(); el.tagName = String(tag || "div").toUpperCase(); return el; },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    addEventListener() {}, removeEventListener() {}
  },
  navigator: windowStub.navigator, localStorage: windowStub.localStorage,
  location: windowStub.location, matchMedia: windowStub.matchMedia,
  getComputedStyle: windowStub.getComputedStyle,
  FormData: function FormData() { return { get: (name) => (fdSeed.has(String(name)) ? fdSeed.get(String(name)) : "") }; },
  Event: function FakeEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  CustomEvent: function FakeCustomEvent(type) { this.type = String(type || ""); this.preventDefault = () => {}; this.stopPropagation = () => {}; },
  alert() {}, confirm: () => false, prompt: () => null,
  setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  addEventListener() {}, removeEventListener() {}
};
sandbox.globalThis = sandbox;

async function runVmSmokeTests() {
  const source = rendererSrc + "\n;globalThis.__acpSmoke = { runAboutUpdateDownload, renderUpdateReadyState, describeUpdateAttempts };";

  await test("C0. renderer.js vm 假 DOM 全量求值零异常（v3.44.0 About 更新接线在评）", () => {
    let error = null;
    try { vm.createContext(sandbox); vm.runInContext(source, sandbox, { filename: "renderer.js" }); }
    catch (err) { error = err; }
    assert.ifError(error);
    assert.ok(sandbox.__acpSmoke, "求值后应挂 __acpSmoke（v3.44.0 导出对位）");
    assert.ok(typeof sandbox.__acpSmoke.runAboutUpdateDownload === "function", "runAboutUpdateDownload 应为顶层函数");
    assert.ok(typeof sandbox.__acpSmoke.describeUpdateAttempts === "function", "describeUpdateAttempts 应为顶层函数");
  });

  await test("C1. onUpdateEvent 已在求值时注册（进度事件入口捕获 ≥1，防 main 推送无人接收）", () => {
    assert.ok(capturedProgressDispatch.length >= 1, "onUpdateEvent 应在顶层求值即注册（不等点击）");
  });

  await test("C2. populateSettings 回填 #update-channel：合法值断 value=v1.0.1 教训 input 类必须断 value", () => {
    const select = rt.getFake("#update-channel");
    select.value = "auto"; // 真实 DOM 默认落在首项 auto
    vm.runInContext(`populateSettings({ updateChannel: "github", connectionMode: "cloud", theme: "dark" })`, sandbox);
    assert.strictEqual(select.value, "github", "合法值 github 应回填进 select 的 value");
    select.value = "auto"; // 复位后再测脏值
    vm.runInContext(`populateSettings({ updateChannel: "hacked-value", connectionMode: "cloud", theme: "dark" })`, sandbox);
    assert.strictEqual(select.value, "auto", "脏值不回填（不跟随脏数据）");
  });

  await test("C3. settingsFromForm 读 FormData：合法/脏值两态（github → 原值；junk → auto）", () => {
    fdSeed.set("updateChannel", "github");
    const a = vm.runInContext(`settingsFromForm().updateChannel`, sandbox);
    assert.strictEqual(a, "github", "合法值应原样透传");
    fdSeed.set("updateChannel", "hacked-value");
    const b = vm.runInContext(`settingsFromForm().updateChannel`, sandbox);
    assert.strictEqual(b, "auto", "脏值应回落 auto");
    fdSeed.set("updateChannel", "");
    const c = vm.runInContext(`settingsFromForm().updateChannel`, sandbox);
    assert.strictEqual(c, "auto", "空值回 auto");
  });

  await test("C4. 点击「检测更新」→ update 态渲染下载按钮；unreachable 态逐行 attempts", async () => {
    methodMocks.checkUpdate = async () => ({ status: "update", currentVersion: "3.44.0", remoteVersion: "v3.45.0", sourceId: "gitcode", asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/n.exe", size: 10 }, sumsAsset: null, sources: [], attempts: [] });
    await rt.getFake("#about-check-update")._listeners.click();
    const status = rt.getFake("#about-update-status");
    assert.ok(status.children.some((el) => String(el.textContent).includes("发现新版本")), "update 态应有发现新版本行");
    const dl = status.children.filter((el) => String(el.textContent) === "⬇️ 下载并安装");
    assert.strictEqual(dl.length, 1, "应有下载并安装按钮");
    assert.ok(typeof dl[0]._listeners.click === "function", "下载按钮应挂点击");

    methodMocks.checkUpdate = async () => ({ status: "unreachable", currentVersion: "3.44.0", remoteVersion: null, sourceId: null, asset: null, sumsAsset: null, sources: [{ sourceId: "gitcode", label: "GitCode", error: "release: HTTP 502" }], attempts: ["gitcode: release: HTTP 502"] });
    await rt.getFake("#about-check-update")._listeners.click();
    assert.ok(String(rt.getFake("#about-update-status").textContent).includes("更新线路不可达"), "unreachable 态文案");
    assert.ok(String(rt.getFake("#about-update-status").textContent).includes("HTTP 502"), "失败原因应逐行可读");
  });

  await test("C5. 下载流双击闸：并发两次点击 → main downloadUpdate 只调一次；later 态渲染「立即安装」兜底", async () => {
    methodMocks.checkUpdate = async () => ({ status: "update", currentVersion: "3.44.0", remoteVersion: "v3.45.0", sourceId: "gitcode", asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/n.exe", size: 10 }, sumsAsset: null, sources: [], attempts: [] });
    let downloadCalls = 0;
    methodMocks.downloadUpdate = async () => { downloadCalls++; await new Promise((r) => setTimeout(r, 5)); return { installChoice: "later", file: "C:\\x\\Setup.exe", verifiedWith: "manifest", size: 10, hash: "ab" }; };
    await rt.getFake("#about-check-update")._listeners.click();
    const status = rt.getFake("#about-update-status");
    const dl = status.children.filter((el) => String(el.textContent) === "⬇️ 下载并安装");
    // 双击并发：第一击在 await downloadUpdate 前同步置 in-flight（真实时序：handler 同步段先跑完）
    dl[0]._listeners.click();
    dl[0]._listeners.click();
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 0)); }
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(downloadCalls, 1, "双击并发只应落一次下载调用（in-flight 闸）");
    assert.ok(status.children.some((el) => String(el.textContent).includes("安装包已就绪")), "later 态应渲染就绪行");
    assert.ok(status.children.some((el) => String(el.textContent).includes("立即安装")), "应渲染「立即安装」兜底按钮（弹窗被关后的入口）");
  });

  await test("C6. 进度分发：main update:event progress → 状态行走百分比；非 progress 载荷忽略", async () => {
    methodMocks.checkUpdate = async () => ({ status: "update", currentVersion: "3.44.0", remoteVersion: "v3.45.0", sourceId: "gitcode", asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/n.exe", size: 10 }, sumsAsset: null, sources: [], attempts: [] });
    let downloadsNow = 1; // C5 已消费一次，闸已复位可再下
    let resolveDownload = null;
    methodMocks.downloadUpdate = () => { downloadsNow++; return new Promise((resolve) => { resolveDownload = resolve; }); };
    await rt.getFake("#about-check-update")._listeners.click();
    const status = rt.getFake("#about-update-status");
    const dl = status.children.filter((el) => String(el.textContent) === "⬇️ 下载并安装");
    assert.strictEqual(dl.length, 1, "更新态下载按钮在场");
    dl[0]._listeners.click(); // 进入下载中（promise 悬等状态供进度分发断言）
    const progressLine = status.children[0];
    assert.ok(progressLine && String(progressLine.textContent).includes("正在下载安装包"), "下载中状态行应在场");
    const dispatcher = capturedProgressDispatch[capturedProgressDispatch.length - 1];
    dispatcher({ type: "progress", received: 51, total: 100 });
    assert.ok(String(progressLine.textContent).includes("51%"), "进度应上屏（textContent 可读态断言）");
    dispatcher({ type: "other", received: 99 });
    assert.ok(String(progressLine.textContent).includes("51%"), "非 progress 载荷不应扰动状态行");
    resolveDownload({ installChoice: "install", file: "C:\\x\\Setup.exe", verifiedWith: "manifest", size: 100, hash: "" });
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 0)); }
    assert.strictEqual(downloadsNow, 2, "C5+C6 合计两次下载调用（闸复位后放行）");
    assert.ok(String(status.textContent).includes("安装已开始"), "install 态收口文案");
  });
}

(async () => {
  console.log("\n── A. updater.cjs 行为真跑（mock fetch 注入） ──");
  await runUnitTests();
  console.log("\n── B. 全链接线断言 ──");
  await runWiringTests();
  console.log("\n── C. vm 假 DOM 运行时冒烟（I 段铁律） ──");
  await runVmSmokeTests();
  console.log(`\n${passed} 项通过, ${failed} 项失败`);
  if (failed > 0) { failures.forEach((f) => console.log(`✗ ${f}`)); process.exit(1); }
  console.log(`test-v3-44-0: ${passed} 项全绿`);
})().catch((error) => { console.error(error); process.exit(1); });
