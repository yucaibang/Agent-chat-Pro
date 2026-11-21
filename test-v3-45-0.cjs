"use strict";

/**
 * v3.45.0 守门：官网更新线路（线路三 · kind=manifest）—— 口令「软件开发继续」立项+用户责令接线
 *
 * 背景（用户质问「辛辛苦苦搞的官网就没用上？」）：官网 Agent-Chat-Pro-Web 自 2026-11-15 起备好
 * latest.json 契约（manifestVersion 1 / base_urls failover / installer.sha256 直供校验值），
 * 官网 README 明文约定「应用内更新程序（v3.45.0 起，kind=manifest）与本页使用同一份 latest.json」。
 *
 * 本版接线设计与官网 README 契约同源：
 *   ① UPDATE_SOURCES 增线路三 { id:"web", kind:"manifest", priority:0(主位) }，manifestUrls failover
 *   ② 清单自 installer.sha256 = 最强校验凭证 → 直供现有三层校验框架的 digest 层（框架零改动）
 *   ③ 字节流仍指 GitCode 附件直链（file_base_urls，joinAssetUrl 同构官网 url() 形态）→ 不新增下载源
 *   ④ 结构性防线 DOWNLOAD_HOST_PATTERN：清单被缓存劫持时 hash 可自签闭环，host 白名单是唯一结构防线
 *   ⑤ published=false → 版本照报无 asset → 聚合自然 asset-missing（发版窗口期如实语义）
 *   ⑥ 治理红线：内核更新源 ≤ 3 条（GitCode/GitHub/官网 manifest），UPDATE_SOURCES.length===3 守门
 *
 * A 组行为真跑（真实 updater.cjs + mock fetch + 真实 fs）；B 组接线源码锚；C 组版本自洽。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const settingsSrc = read("src/main/settings.cjs");
const rendererSrc = read("src/renderer/renderer.js");
const indexSrc = read("src/renderer/index.html");
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


// ── mock fetch（沿 test-v3-44-0/2 装置；route.throw → 网络层失败，route.json → JSON 响应） ──
function makeMockFetch(routes) {
  return async (url, init = {}) => {
    const route = routes[url];
    if (!route) throw new Error(`offline: ${url}`);
    if (route.throw) throw new Error(route.throw);
    const response = { ok: route.status ? route.status === 200 : true, status: route.status || 200 };
    if (route.json !== undefined) {
      response.json = async () => JSON.parse(JSON.stringify(route.json));
      const text = JSON.stringify(route.json);
      response.text = async () => text;
    }
    if (route.body !== undefined) {
      const chunks = Array.isArray(route.body) ? route.body : [route.body];
      response.body = (async function* () { for (const chunk of chunks) yield chunk; })();
    } else {
      response.body = (async function* () { yield Buffer.alloc(0); })();
    }
    if (route.headers) response.headers = { get: (key) => route.headers[key] ?? null };
    if (!response.headers) response.headers = { get: () => null };
    return response;
  };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3450-"));

// ── 官网 latest.json 合规样例（形态对齐 Agent-Chat-Pro-Web/latest.json 结构） ──
const SHA_45 = crypto.createHash("sha256").update("agent-chat-pro-v3450-payload").digest("hex");
const SHA_45_BAD = crypto.createHash("sha256").update("tampered-payload").digest("hex");
const GITCODE_BASE = "https://gitcode.com/xiaolaoyu/Agent-chat-Pro/releases/download/v3.45.0";

function makeManifest(overrides = {}) {
  return {
    manifestVersion: 1,
    version: "3.45.0",
    channel: "stable",
    platform: "win-x64",
    releaseDate: "2026-11-16T02:59:00+08:00",
    download: {
      base_urls: ["https://agent-chatp.agent--orbit.com"],
      file_base_urls: [GITCODE_BASE],
      fallback: { label: "蓝奏云网盘", url: "" },
    },
    installer: {
      published: true,
      file: "Agent Chat Pro-3.45.0-Setup.exe",
      sha256: SHA_45,
      size: 82000000,
    },
    files: [],
    ...overrides,
  };
}

// ════════════════ A. 行为真跑 ════════════════
async function runUnitTests() {
  const webSource = updater.UPDATE_SOURCES.find((item) => item.kind === "manifest");
  const gitRouteKeys = [
    webSource && webSource.manifestUrls[0],
    ...updater.UPDATE_SOURCES.filter((item) => item.kind !== "manifest").flatMap((item) => [item.releasesUrl, item.tagsUrl]),
  ].filter(Boolean).reduce((acc, url) => { acc[url] = { throw: "offline-mock" }; return acc; }, {});

  await test("A1. parseManifestPayload 合规清单：releaseVersion=v3.45.0 + asset（digest 直取 installer.sha256 + URL %20 编码直链）", async () => {
    const payload = updater.parseManifestPayload(makeManifest());
    assert.strictEqual(payload.releaseVersion, "v3.45.0", "releaseVersion 应为 v 前缀形态");
    assert.ok(payload.asset, "published=true 应产出 asset");
    assert.strictEqual(payload.asset.digest, SHA_45, "digest 应直取 installer.sha256（最强凭证直供校验层）");
    assert.strictEqual(payload.asset.size, 82000000);
    assert.strictEqual(payload.asset.name, "Agent Chat Pro-3.45.0-Setup.exe");
    assert.ok(payload.asset.url.includes("Agent%20Chat%20Pro-3.45.0-Setup.exe"), "URL 空格必须 %20 编码（GitCode 直链实弹：裸空格 curl 直接拒）");
    assert.ok(payload.asset.url.startsWith(GITCODE_BASE), "字节流源=file_base_urls（官网不下发安装包，红线不破）");
  });

  await test("A2. published=false：releaseVersion 照报 + asset=null（版本发现先行，聚合自然 asset-missing）", () => {
    const payload = updater.parseManifestPayload(makeManifest({ installer: { published: false, file: "Agent Chat Pro-3.45.0-Setup.exe", sha256: SHA_45, size: 1 } }));
    assert.strictEqual(payload.releaseVersion, "v3.45.0", "版本发现不因附件未上架而漏报");
    assert.strictEqual(payload.asset, null, "未上架绝不给下载地址");
  });

  await test("A3. 非法清单全拒绝：version 乱码 / 非 object → parseManifestPayload=null（不误报）；缺 installer → 版本照报 asset=null", () => {
    assert.strictEqual(updater.parseManifestPayload(null), null);
    assert.strictEqual(updater.parseManifestPayload("poison"), null);
    assert.strictEqual(updater.parseManifestPayload({ version: "not-a-version" }), null);
    const bare = updater.parseManifestPayload({ version: "3.45.0" });
    assert.strictEqual(bare.releaseVersion, "v3.45.0", "缺 installer 不影响版本发现");
    assert.strictEqual(bare.asset, null, "缺 installer 绝不产 asset");
  });

  await test("A4. 下载源结构防线：非 https / host 白名单外 → asset=null（hash 同源自签闭环的唯一结构防线，不设 asset）", () => {
    const plain = updater.parseManifestPayload(makeManifest({ download: { file_base_urls: ["http://gitcode.com/x/y"], base_urls: [] } }));
    assert.strictEqual(plain.asset, null, "非 https 拒绝");
    const evil = updater.parseManifestPayload(makeManifest({ download: { file_base_urls: ["https://evil-cdn.attacker.example/releases/v3.45.0"], base_urls: [] } }));
    assert.strictEqual(evil.asset, null, "host 白名单外拒绝");
    assert.ok(updater.DOWNLOAD_HOST_PATTERN.test(new URL("https://gitcode.com/x").hostname), "白名单应含 gitcode.com");
    assert.ok(updater.DOWNLOAD_HOST_PATTERN.test(new URL("https://api.github.com/x").hostname), "白名单应含 github.com");
    assert.ok(updater.DOWNLOAD_HOST_PATTERN.test(new URL("https://objects.githubusercontent.com/x").hostname), "白名单应含 githubusercontent.com");
    assert.ok(!updater.DOWNLOAD_HOST_PATTERN.test(new URL("https://evil.com/x").hostname), "白名单不含陌生域");
  });

  await test("A5. joinAssetUrl 同构官网 url()：去尾斜杠 + 全量编码（空格→%20、路径字符分段编码）", () => {
    assert.strictEqual(updater.joinAssetUrl("https://x.com/p/", "Agent Chat Pro-3.45.0-Setup.exe"), "https://x.com/p/Agent%20Chat%20Pro-3.45.0-Setup.exe");
    assert.strictEqual(updater.joinAssetUrl("https://x.com/p/", "a/b c.txt"), "https://x.com/p/a/b%20c.txt", "路径分段编码，不吞路径分隔符");
  });

  await test("A6. detectManifestSource failover：第一 DNS 位失败 → 第二位成功；全败 → error 带 manifest: 前缀", async () => {
    const source = { id: "web", label: "官网", kind: "manifest", priority: 0, manifestUrls: ["https://down.example/latest.json", "https://back.example/latest.json"] };
    const routes = {
      "https://down.example/latest.json": { throw: "getaddrinfo ENOTFOUND" },
      "https://back.example/latest.json": { json: makeManifest() },
    };
    const hit = await updater.detectManifestSource(source, makeMockFetch(routes));
    assert.strictEqual(hit.error, null);
    assert.strictEqual(hit.releaseVersion, "v3.45.0");
    const dead = await updater.detectManifestSource({ ...source, manifestUrls: ["https://down.example/latest.json"] }, makeMockFetch(routes));
    assert.ok(dead.error && dead.error.startsWith("manifest:"), `全败应报 manifest: 前缀，实际=${dead.error}`);
    assert.strictEqual(dead.releaseVersion, null);
  });

  await test("A7. 端到端 auto 三线路：官网通 → remoteVersion=v3.45.0 + status=update + sourceId=web（priority 0 主位借线）", async () => {
    const routes = { ...gitRouteKeys };
    routes[webSource.manifestUrls[0]] = { json: makeManifest() };
    const result = await updater.checkForUpdate({ mode: "auto", currentVersion: "3.45.0-rc" === "3.44.2" ? "3.44.2" : "3.44.2", fetchImpl: makeMockFetch(routes) });
    assert.strictEqual(result.status, "update", `应报有新版，实际=${result.status}(${result.remoteVersion})`);
    assert.strictEqual(result.remoteVersion, "v3.45.0");
    assert.strictEqual(result.sourceId, "web", "官网清单线路主位借线");
    assert.strictEqual(result.asset.digest, SHA_45, "asset.digest=清单 sha256（下载三层校验 digest 层直供）");
    assert.ok(result.attempts.some((line) => String(line).startsWith("gitcode:")), "gitcode 失败原因应随结果带上");
    assert.ok(result.attempts.some((line) => String(line).startsWith("github:")), "github 失败原因应随结果带上");
  });

  await test("A8. mode=web 单线路：只查官网清单（gitcode/github 即便正常也不看）", async () => {
    const routes = { ...gitRouteKeys };
    routes[webSource.manifestUrls[0]] = { json: makeManifest() };
    // gitcode/github 路由已 throw（offline-mock）——若单线路误查会进 attempts；断言 attempts 无 gitcode/github
    const result = await updater.checkForUpdate({ mode: "web", currentVersion: "3.44.2", fetchImpl: makeMockFetch(routes) });
    assert.strictEqual(result.status, "update");
    assert.strictEqual(result.sourceId, "web");
    assert.ok(!result.attempts.some((line) => String(line).startsWith("gitcode:")), "单线路模式不得查 gitcode");
    assert.ok(!result.attempts.some((line) => String(line).startsWith("github:")), "单线路模式不得查 github");
  });

  await test("A9. 下载校验 digest 层真跑：官网清单 sha256 命中 → verifiedWith=digest；digest 假+size 真 → size 弱校验兜底放行；digest/size 双假 → throw 安全线", async () => {
    const payload = Buffer.from("agent-chat-pro-v3450-payload");
    const hit = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "https://gitcode.com/ignore", size: payload.length, digest: SHA_45 },
      sumsAsset: null,
      file: path.join(tmpDir(), "Agent Chat Pro-3.45.0-Setup.exe"),
      fetchImpl: makeMockFetch({ "https://gitcode.com/ignore": { body: [payload], headers: { "content-length": String(payload.length) } } }),
    });
    assert.strictEqual(hit.verifiedWith, "digest", "无清单附件（官网 asset 无 sumsAsset）时 digest 直供校验层");
    // 三层校验「过一即放行」语义回归：digest 不符但 size 相符 → size 层放行（与 GitCode 线路同语义，不误作废）
    const sizeHit = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "https://gitcode.com/ignore", size: payload.length, digest: SHA_45_BAD },
      sumsAsset: null,
      file: path.join(tmpDir(), "Agent Chat Pro-3.45.0-Setup.exe"),
      fetchImpl: makeMockFetch({ "https://gitcode.com/ignore": { body: [payload] } }),
    });
    assert.strictEqual(sizeHit.verifiedWith, "size", "digest 假、size 真 → 弱校验兜底放行（三层框架既有语义不回归）");
    const tampered = path.join(tmpDir(), "Agent Chat Pro-3.45.0-Setup.exe");
    await assert.rejects(
      () => updater.downloadUpdateAsset({
        asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "https://gitcode.com/ignore", size: payload.length + 1, digest: SHA_45_BAD },
        sumsAsset: null,
        file: tampered,
        fetchImpl: makeMockFetch({ "https://gitcode.com/ignore": { body: [payload] } }),
      }),
      /校验失败|放弃安装/,
      "digest/size 双不符必须 throw（官网接线不得绕过安全线）"
    );
  });

  await test("A10. 治理红线守门：UPDATE_SOURCES 恰 3 条（web/gitcode/github），priority 严格 0/1/2 升序", () => {
    assert.strictEqual(updater.UPDATE_SOURCES.length, 3, `内核更新源 ≤3 红线（官网 README 同源治理语义）；实际=${updater.UPDATE_SOURCES.length}`);
    assert.deepStrictEqual(updater.UPDATE_SOURCES.map((item) => item.id), ["web", "gitcode", "github"]);
    assert.deepStrictEqual(updater.UPDATE_SOURCES.map((item) => item.priority), [0, 1, 2], "官网清单主位优先级 0");
    assert.deepStrictEqual(updater.UPDATE_SOURCES.map((item) => item.kind), ["manifest", "gitcode", "github"]);
  });
}

// ════════════════ B. 接线源码锚 ════════════════
async function runWiringTestsReal() {
  await test("B1. settings.cjs normalizeUpdateChannel 白名单含 web（模块内部函数，源码锚）", () => {
    const fn = settingsSrc.match(/function normalizeUpdateChannel\(value\) \{[\s\S]*?\n\}/);
    assert.ok(fn, "normalizeUpdateChannel 函数缺失");
    assert.ok(fn[0].includes('"web"'), "白名单必须含 web");
    assert.ok(fn[0].includes('"gitcode"') && fn[0].includes('"github"'), "白名单须完整含 gitcode/github（防 web 覆盖式改写）");
  });

  await test("B2. renderer.js 白名单两处含 web + 检测文案随 mode 动态（v3.45.1 修复态对齐：auto=三线路并查、单线路=仅查该线路）", () => {
    assert.ok(rendererSrc.includes('["web", "gitcode", "github"]'), "settings 采集白名单需含 web");
    assert.ok(rendererSrc.includes('["auto", "web", "gitcode", "github"]'), "select 回填白名单需含 web");
    // v3.45.1 修复：检测中文案不再固定三线路——auto 态三线路并查 + 单线路态「仅查单线路」
    assert.ok(rendererSrc.includes("三线路（官网清单 / GitCode / GitHub）并查"), "auto 态检测文案（三线路并查）");
    assert.ok(rendererSrc.includes("仅查单线路"), "单线路态检测文案（仅查单线路）");
    assert.ok(rendererSrc.includes("updateSourceLabel"), "v3.45.1 借线来源三态映射（官网线路不再错报线路一）");
    assert.ok(!rendererSrc.includes("双线路 GitCode / GitHub 并查"), "旧双线路文案应清零");
    assert.ok(!rendererSrc.includes("两条线路均未取得"), "旧「两条线路」兜底文案应清零");
  });

  await test("B3. 应用内 index.html：web option + 官网清单说明 + 三线路 hint", () => {
    assert.ok(indexSrc.includes('<option value="web">'), "web option 缺失");
    assert.ok(indexSrc.includes("三线路并查"), "三线路说明缺失");
    assert.ok(indexSrc.includes("官网 = 清单线路"), "官网线路定位说明缺失");
    assert.ok(!indexSrc.includes("双线路并查"), "旧双线路说明应清零");
  });

  await test("B4. updater.cjs：manifestUrls 指官网域 + host 白名单与 joinAssetUrl 导出（测试/回归面）", () => {
    const web = updater.UPDATE_SOURCES.find((item) => item.kind === "manifest");
    assert.ok(web, "manifest 线路缺失");
    assert.ok(Array.isArray(web.manifestUrls) && web.manifestUrls.every((url) => url.startsWith("https://agent-chatp.agent--orbit.com/")), "manifestUrls 必须钉在官网域");
    assert.strictEqual(typeof updater.joinAssetUrl, "function", "joinAssetUrl 应导出");
    assert.strictEqual(typeof updater.parseManifestPayload, "function", "parseManifestPayload 应导出");
    assert.ok(updater.DOWNLOAD_HOST_PATTERN instanceof RegExp, "DOWNLOAD_HOST_PATTERN 应导出");
  });
}

// ════════════════ C. 版本自洽 ════════════════
function runVersionTests() {
  const group = async () => {
    await test("C1. 版本自洽：package.json ≈ 3.45.0（≥ 宽松锚，下一版不翻红）", () => {
      assert.ok(updater.compareVersions(pkg.version, "3.45.0") === 0 || updater.compareVersions(pkg.version, "3.45.0") > 0, `实际=${pkg.version}`);
    });
  };
  return group();
}

(async () => {
  console.log("════ A. 行为真跑 ════");
  await runUnitTests();
  console.log("════ B. 接线源码锚 ════");
  await runWiringTestsReal();
  console.log("════ C. 版本自洽 ════");
  await runVersionTests();
  console.log(`\n通过 ${passed} / ${passed + failed}`);
  if (failed > 0) {
    console.error("失败明细：");
    for (const line of failures) console.error("  - " + line);
    process.exit(1);
  }
})().catch((error) => { console.error(error); process.exit(1); });
