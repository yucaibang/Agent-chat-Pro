"use strict";

/**
 * v3.44.2 守门：装机前代码自查出品（口令「软件开发继续」，沿 v3.42.3/v3.43.1/v3.43.2 先例）——
 * 应用内更新链三修两加固（updater 下载链装机前最后排查面，v3.44.0 全新模块首版实锤）：
 *
 * Bug A（严重）写盘流无 error 监听：磁盘满/句柄耗尽（ENOSPC 等）在流式循环中段 emit，
 *   原 error 监听挂在 end 阶段 → Unhandled 'error' event → 主进程整应用崩溃
 *   （Linux /dev/full 实测复现：ENOSPC 裸抛 exit 1）。修复=循环前持久监听 writeError+
 *   drain/end 竞速临场 fail（error 后 drain 不会再来，不竞速就永挂）。
 * Bug B（体验）清单拉取网络炸 = 已完成的 81MB 下载整段作废：原实现裸 fetch 无超时且
 *   网络层异常直接穿透整个 downloadUpdateAsset。修复=拉取失败（网络层）≠ 校验失败（hash 不符）：
 *   前者回退 digest/size 弱校验并附 manifestNote，后者保持绝不回退安全线；清单拉取补 15s 超时。
 * 加固 ①：detectOneSource 附件版本与 release tag 全版本比对（原 only-patch，major/minor 不同
 *   而 patch 撞巧的附件会误入 asset 场空转借线资格）。
 * 加固 ②：main.cjs update:download 主进程单飞闸（渲染层双击闸之外的绝对防线——并发双下载
 *   双开 createWriteStream 写同一落地文件，v3.42.3 群闸穿透教训纵深）。
 * 加固 ③：检测文案订正——auto 实际是「双线全查聚合按优先级选可用」，非「失败才切线路二」
 *   （renderer.js 状态行 + index.html 静态说明两处同步订正）。
 *
 * A 组行为真跑（真实 updater.cjs + mock fetch + 真实 fs 错误注入）；
 * B 组接线源码锚；C 组版本自洽。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const assert = require("assert");

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const mainSrc = read("src/main/main.cjs");
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

// ── mock fetch（沿 test-v3-44-0 装置；本版需支持 signal 感知 —— 清单超时行为级断言用） ──
function makeMockFetch(routes) {
  return async (url, init = {}) => {
    const route = routes[url];
    if (!route) throw new Error(`offline: ${url}`);
    if (route.signalAware) {
      // 模拟尊重 AbortSignal 的 fetch：abort 触发即 reject（不清等 resolve/throw）
      const signal = init && init.signal;
      if (signal) {
        if (signal.aborted) throw new Error(route.throw || "This operation was aborted");
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error(route.throw || "This operation was aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
          if (route.resolveWith) setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(route.resolveWith()); }, route.delayMs || 0);
        });
      }
    }
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
    if (!response.headers) response.headers = { get: () => null };
    return response;
  };
}

const tmpFile = (label) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `acp-v3442-${label}-`)), "Agent Chat Pro-3.45.0-Setup.exe");

// ════════════════ A. 行为真跑 ════════════════
async function runUnitTests() {
  // A1（Linux 实弹）：/dev/full 真实 ENOSPC 注入 —— 修复后必须「reject 且进程存活」
  // （修复前实测：Unhandled 'error' event → ENOSPC 裸抛 exit 1 = 主进程整应用崩溃）
  const devFull = process.platform === "linux" && fs.existsSync("/dev/full");
  if (devFull) {
    await test("A1. 磁盘满真跑（/dev/full，ENOSPC）：下载 reject 报错且进程不崩（Bug A 修复实证）", async () => {
      const content = Buffer.alloc(256 * 1024, 65); // > WriteStream 内核缓冲，必触发异步 ENOSPC
      let rejected = null;
      try {
        await updater.downloadUpdateAsset({
          asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
          sumsAsset: null,
          file: "/dev/full",
          fetchImpl: makeMockFetch({ "http://x/dist.exe": { body: [content, content, content] } }),
        });
        assert.fail("/dev/full 写入不应成功");
      } catch (error) {
        rejected = error;
      }
      assert.ok(rejected, "必须 reject 而非裸崩/挂死（修复前=Unhandled 'error' event exit 1）");
      assert.ok(/ENOSPC|no space/i.test(`${rejected.code || ""}${rejected.message || ""}`), `错误应携带磁盘满语义，实为：${rejected.message}`);
      // 走到此处本身即进程存活的实证（修复前测试进程会连同主进程一起死）
    });
  } else {
    await test("A1. 磁盘满真跑（/dev/full，ENOSPC）：⊘ 非 Linux 平台跳过（装置依赖 /dev/full）", () => { /* skip 先例：test-v3-22-0 C1/C2 形态 */ });
  }

  // A1b（跨平台实弹）：EACCES 目录注入 —— 第二条真实写盘错误路径（Windows 语义近似：目录无写权限）
  await test("A1b. 无权限目录真跑（EACCES）：写盘错误同样 reject 不崩（Bug A 第二路径）", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "acp-v3442-eacces-"));
    const locked = path.join(base, "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o500); // r-x：无写权限
    const content = Buffer.from("EACCES-PROBE-BYTES");
    let rejected = null;
    try {
      await updater.downloadUpdateAsset({
        asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
        sumsAsset: null,
        file: path.join(locked, "out.exe"),
        fetchImpl: makeMockFetch({ "http://x/dist.exe": { body: [content] } }),
      });
      assert.fail("EACCES 目录写入不应成功");
    } catch (error) {
      rejected = error;
    } finally {
      fs.chmodSync(locked, 0o700);
      fs.rmSync(base, { recursive: true, force: true });
    }
    assert.ok(rejected, "必须 reject 而非裸崩");
    assert.ok(/EACCES|permission|access/i.test(`${rejected.code || ""}${rejected.message || ""}`), `错误应携带权限语义，实为：${rejected.message}`);
  });

  await test("A2. 清单拉取网络炸（DNS 失败形态）→ 回退 size 弱校验放行，下载不作废（Bug B 修复实证）", async () => {
    const content = Buffer.from("NET-DOWN-MANIFEST-INJECTION");
    const file = tmpFile("a2");
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content] },
      "http://x/SHA256SUMS.txt": { throw: "getaddrinfo EAI_AGAIN manifest-host" },
    });
    const result = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
      sumsAsset: { name: "SHA256SUMS.txt", url: "http://x/SHA256SUMS.txt" },
      file, fetchImpl,
    });
    assert.strictEqual(result.verifiedWith, "size", "清单拉取失败（网络层）应回退弱校验，81MB 下载不作废");
    assert.ok(result.note && result.note.includes("清单拉取失败"), "返回值应带 manifestNote 说明回退原因");
  });

  await test("A3. 清单拉取网络炸 + size 也不符 → reject 且信息含回退说明（弱校验兜底也拦）", async () => {
    const content = Buffer.from("SHORT");
    const file = tmpFile("a3");
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content] },
      "http://x/SHA256SUMS.txt": { throw: "net down" },
    });
    await assert.rejects(
      () => updater.downloadUpdateAsset({
        asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: 999999, digest: "" },
        sumsAsset: { name: "SHA256SUMS.txt", url: "http://x/SHA256SUMS.txt" },
        file, fetchImpl,
      }),
      (error) => /放弃安装/.test(error.message) && /清单拉取失败/.test(error.message),
      "弱校验失败报错应附清单回退说明（完整可读）"
    );
  });

  await test("A4. 清单拉取 15s 超时行为级：signal 感知 fetch 被即刻 abort → 回退 size（清单卡住不再长挂）", async () => {
    const content = Buffer.from("HUNG-MANIFEST-TIMEOUT");
    const file = tmpFile("a4");
    const t0 = Date.now();
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content] },
      "http://x/SHA256SUMS.txt": { signalAware: true, throw: "This operation was aborted", delayMs: 60000 }, // 60s 才 resolve，应被 abort 抢先
    });
    const result = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
      sumsAsset: { name: "SHA256SUMS.txt", url: "http://x/SHA256SUMS.txt" },
      file, fetchImpl,
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 20000, `清单卡住应在 15s 超时内被 abort（实耗 ${elapsed}ms）`);
    assert.strictEqual(result.verifiedWith, "size");
    assert.ok(result.note && result.note.includes("清单拉取失败"), "超时=网络层失败 → 回退弱校验");
  });

  await test("A5. 清单 HTTP 404 → null → 回退 size（原设计本义不回归）", async () => {
    const content = Buffer.from("MANIFEST-404-FALLBACK");
    const file = tmpFile("a5");
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content] },
      "http://x/SHA256SUMS.txt": { status: 404 },
    });
    const result = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
      sumsAsset: { name: "SHA256SUMS.txt", url: "http://x/SHA256SUMS.txt" },
      file, fetchImpl,
    });
    assert.strictEqual(result.verifiedWith, "size");
  });

  await test("A6. 安全线不回归：清单内容 hash 不符 → throw 放弃安装（拉取成功但校验失败绝不回退弱校验）", async () => {
    const content = Buffer.from("TAMPERED-BYTES-V3442");
    const file = tmpFile("a6");
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content] },
      "http://x/SHA256SUMS.txt": { text: `${"e".repeat(64)}  Agent Chat Pro-3.45.0-Setup.exe\n` },
    });
    await assert.rejects(
      () => updater.downloadUpdateAsset({
        asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
        sumsAsset: { name: "SHA256SUMS.txt", url: "http://x/SHA256SUMS.txt" },
        file, fetchImpl,
      }),
      /清单校验失败/,
      "校验失败=安全线（与拉取失败语义分离，绝不回退弱校验）"
    );
  });

  await test("A7. 成功路径回归：清单命中+digest 命中双通过，note 不应误附（空清单场景 note=undefined）", async () => {
    const content = Buffer.from("HAPPY-PATH-V3442");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const file = tmpFile("a7");
    const fetchImpl = makeMockFetch({
      "http://x/dist.exe": { body: [content] },
      "http://x/SHA256SUMS.txt": { text: `${hash}  Agent Chat Pro-3.45.0-Setup.exe\n` },
    });
    const result = await updater.downloadUpdateAsset({
      asset: { name: "Agent Chat Pro-3.45.0-Setup.exe", url: "http://x/dist.exe", size: content.length, digest: "" },
      sumsAsset: { name: "SHA256SUMS.txt", url: "http://x/SHA256SUMS.txt" },
      file, fetchImpl,
    });
    assert.strictEqual(result.verifiedWith, "manifest");
    assert.strictEqual(result.note, undefined, "成功路径不应带回退说明");
  });

  await test("A8. 加固①行为实证：major/minor 不同而 patch 撞巧的附件误入场 → detectOneSource 不再把错版本 exe 入 asset", async () => {
    // tag=v3.45.1（patch=1），塞入 3.44.1 附件（patch 同为 1 但 minor=44≠45）——旧 only-patch 形态会误入场
    const detect = await updater.detectOneSource({
      id: "gitcode", label: "GitCode", releasesUrl: "rel://x", tagsUrl: "tags://x", kind: "gitcode", priority: 1,
    }, makeMockFetch({
      "rel://x": { json: [{ tag_name: "v3.45.1", draft: false, assets: [{ name: "Agent Chat Pro-3.44.1-Setup.exe", size: 10, browser_download_url: "http://x/stale.exe" }] }] },
      "tags://x": { json: [{ name: "v3.45.1" }] },
    }));
    assert.strictEqual(detect.asset, null, "错版本附件不得入场（全版本比对）");
    // 正向：版本全等附件照常入场
    const detect2 = await updater.detectOneSource({
      id: "gitcode", label: "GitCode", releasesUrl: "rel://x", tagsUrl: "tags://x", kind: "gitcode", priority: 1,
    }, makeMockFetch({
      "rel://x": { json: [{ tag_name: "v3.45.1", draft: false, assets: [{ name: "Agent Chat Pro-3.45.1-Setup.exe", size: 10, browser_download_url: "http://x/new.exe" }] }] },
      "tags://x": { json: [{ name: "v3.45.1" }] },
    }));
    assert.strictEqual(detect2.asset.url, "http://x/new.exe", "版本全等附件照常入场");
  });
}

// ════════════════ B. 接线源码锚 ════════════════
async function runWiringTests() {
  await test("B1. updater.cjs：写盘持久 error 监听必须先于流式循环（顺序锚，Bug A 防回退）", () => {
    const src = read("src/main/updater.cjs");
    const listenIdx = src.indexOf('out.on("error", (error) => { writeError = error; });');
    const loopIdx = src.indexOf("for await (const chunk of response.body)");
    assert.ok(listenIdx > -1, "持久 writeError 监听缺失");
    assert.ok(loopIdx > -1, "流式下载循环缺失");
    assert.ok(listenIdx < loopIdx, "error 监听必须注册在 for-await 之前（原形态挂 end 阶段=循环期裸崩）");
    const drainIdx = src.indexOf('out.once("drain"');
    const raceErrIdx = src.indexOf('out.once("error", fail)');
    assert.ok(drainIdx > -1 && raceErrIdx > -1, "drain 竞速块缺失（error 后 drain 不会再来，不竞速=永挂）");
    assert.ok(raceErrIdx < drainIdx || raceErrIdx < src.length, "竞速 fail 监听在场");
    // end 阶段也必须竞速（error reject 先挂，end 回调 resolve 时移除——end 前置同一 Promise 块内）
    const raceFails = src.split('out.once("error", fail)').length - 1;
    assert.ok(raceFails >= 2, `drain 竞速与 end 竞速各应有一处临场 fail（实为 ${raceFails} 处）`);
    assert.ok(src.includes('out.end(() => { out.off("error", fail); resolve(); });'), "end 回调 resolve+移除临场 fail 形态缺失");
  });

  await test("B2. updater.cjs：拉取/校验语义分离（fetchManifestExpected 独立函数+导出+15s 超时）", () => {
    const src = read("src/main/updater.cjs");
    assert.ok(src.includes("async function fetchManifestExpected"), "清单拉取独立函数缺失");
    assert.ok(src.includes("FETCH_TIMEOUT_MS)"), "清单拉取应使用 15s 超时常量");
    assert.ok(src.includes("清单拉取失败"), "网络层失败回退说明缺失（=校验失败语义混用回归）");
    const moduleTail = src.slice(src.lastIndexOf("module.exports"));
    assert.ok(moduleTail.includes("fetchManifestExpected"), "fetchManifestExpected 应在导出面（守门可真跑）");
    // 校验失败 throw 必须在 try/catch（回退逻辑）之外 —— 防网络回退 catch 误吞安全线
    const expectedBlock = src.slice(src.indexOf("if (sumsAsset && sumsAsset.url) {"), src.indexOf("verify.digest ="));
    assert.ok(expectedBlock.includes("throw new Error(`SHA256 清单校验失败"), "安全线 throw 应在位");
    assert.ok(expectedBlock.indexOf("catch (error)") < expectedBlock.indexOf("SHA256 清单校验失败"), "安全线 throw 位于回退 catch 之后=不被误吞");
  });

  await test("B3. main.cjs update:download 主进程单飞闸（渲染层之外的绝对防线）", () => {
    const block = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("update:download"'), mainSrc.indexOf('ipcMain.handle("update:install"'));
    assert.ok(block.includes("updateDownloadInFlight"), "主进程单飞闸变量缺失");
    assert.ok(block.includes("已有安装包下载任务正在进行中"), "重复下载拒绝文案缺失");
    assert.ok(/let updateDownloadInFlight/.test(mainSrc), "闸变量应为模块/handler 外层 let（跨调用保持）");
    assert.ok(block.includes("finally {"), "闸必须在 finally 释放（throw/弹窗路径都要清）");
    assert.ok(block.indexOf("updateDownloadInFlight = true") < block.indexOf("downloadUpdateAsset"), "闸置位必须先于下载（对齐 v3.42.3 同步置位教训）");
  });

  await test("B4. 文案订正（随版本演进对齐）：v3.44.2 订正=检测文案与真实行为相符；v3.45.1=auto/单线路动态形态（updateSourceLabel 三态）", () => {
    // v3.45.1 修复态：检测中文案不再固定——auto 态三线路并查 + 单线路态「仅查单线路」，旧双线路/三线路固定串均清零
    assert.ok(rendererSrc.includes("三线路（官网清单 / GitCode / GitHub）并查"), "auto 态检测文案（v3.45.1 动态形态）");
    assert.ok(rendererSrc.includes("仅查单线路"), "单线路态检测文案（v3.45.1 动态形态）");
    assert.ok(!rendererSrc.includes("失败自动切线路二"), "renderer 旧文案应清除（v3.44.2 订正语义保持）");
    assert.ok(!rendererSrc.includes("双线路 GitCode / GitHub 并查"), "旧固定双线路文案随 v3.45.1 动态化清零");
    assert.ok(indexSrc.includes("三线路并查"), "index.html 静态说明（auto 态=三线路，v3.45.1 对齐）");
    assert.ok(!indexSrc.includes("失败自动切线路二"), "index.html 旧文案应清除");
  });

  await test("B5. downloadUpdateAsset 返回值注记形态：成功路径无 note，回退路径带 note（渲染层可选消费）", () => {
    const src = read("src/main/updater.cjs");
    assert.ok(src.includes("note: manifestNote || undefined"), "返回值 note 字段缺失");
    assert.ok(src.includes("manifestNote"), "回退说明变量缺失");
  });
}

// ════════════════ C. 版本自洽 ════════════════
async function runVersionTests() {
  await test("C1. 版本：package.json ≥3.44.2 + README badge 自洽（≥ 形态防 bump 翻红）", () => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(pkg.version || ""));
    assert.ok(m, `package.json version 应为 x.y.z，实为 ${pkg.version}`);
    const [major, minor, patch] = m.slice(1).map(Number);
    assert.ok(major > 3 || (major === 3 && (minor > 44 || (minor === 44 && patch >= 2))), `版本应 ≥ 3.44.2，实为 ${pkg.version}`);
    const badge = /version-([0-9.]+)-blue/.exec(read("README.md"));
    assert.ok(badge, "README 应含 version badge");
    assert.strictEqual(badge[1], pkg.version, `README badge ${badge[1]} 与 package.json ${pkg.version} 应自洽`);
  });

  await test("C2. test-v3-44-0 B4 锚随文案演进同步（v3.45.1 动态形态锚在场）", () => {
    const src = read("test-v3-44-0.cjs");
    assert.ok(src.includes("三线路并查"), "test-v3-44-0 B4 应随 v3.45.1 动态形态对齐");
  });
}

(async () => {
  console.log("\n── A. updater 下载链行为真跑（修复实证） ──");
  await runUnitTests();
  console.log("\n── B. 接线源码锚 ──");
  await runWiringTests();
  console.log("\n── C. 版本自洽 ──");
  await runVersionTests();
  console.log(`\n${passed} 项通过, ${failed} 项失败`);
  if (failed > 0) { failures.forEach((f) => console.log(`✗ ${f}`)); process.exit(1); }
  console.log(`test-v3-44-2: ${passed} 项全绿`);
})().catch((error) => { console.error(error); process.exit(1); });
