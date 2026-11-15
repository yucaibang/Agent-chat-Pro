"use strict";
/**
 * v3.44.0 应用内更新检测（双线路 · 双判据）—— 口令「软件开发继续」立项
 *
 * 线路一 GitCode（默认 · 国内直连）：gitcode.com/api/v5（Gitee v5 兼容形态）
 * 线路二 GitHub（备用 · 需代理/VPN 环境）：api.github.com
 *
 * 版本判据（双保障，实测 2026-11-15）：
 *   ① Release 附件（主）：releases API → 最新正式 release 的 tag_name + assets 里的安装包
 *      （GitCode：assets[].type==="attach" 带 size；GitHub：assets[].digest 自带 sha256 强校验）
 *   ② tag（兜底）：tags API → 最新 tag 名 —— 双端 tag 常领先 release（发版先 push tag、
 *      附件后手动传），tag 与 release 两者取 max，杜绝漏报。
 *   ③ 版本铁则（防变蠢，守门钉死）：远端 > 本地才算「有新版」；远端 ≤ 本地一律「已是最新版」；
 *      两端全不可达 → "unreachable"；检测到新版但安装包未上架 → "asset-missing"（不误报）。
 *
 * 下载校验三层（过一即放行，全失败绝不安装）：
 *   ① SHA256 清单附件（SHA256SUMS-vX.Y.Z.txt，v3.44.0 起发版义务，两端都要传）
 *   ② GitHub asset.digest（API 自带 sha256）
 *   ③ API 报告的 asset.size 对账（弱校验，仅在 ①② 双缺场；GitCode 现网形态）
 *
 * 模块零 electron 依赖：fetch/spawn/quit 全部依赖注入，守门测试可真跑。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const USER_AGENT = "Agent-Chat-Pro-Updater/1.0";
const FETCH_TIMEOUT_MS = 15000;
const ASSET_EXE_PATTERN = /agent[ ._-]?chat[ ._-]?pro-([0-9]+\.[0-9]+\.[0-9]+)-setup\.exe$/i;
const SUMS_PATTERN = /^SHA256SUMS-v([0-9]+\.[0-9]+\.[0-9]+)\.txt$/i;
// 通用名清单（v3.44.0 现网实锤：GitCode 历史 release 传的是不带版本号的 SHA256SUMS.txt）——
// 版本化名优先，通用名兜底；两形态都不含文件行时再退化走裸哈希形态解析
const SUMS_PLAIN_PATTERN = /^SHA256SUMS\.txt$/i;

/** 线路常量（v3.44.0 UI 备注同源）：新增线路=在此登记并实现 releases/tags 两个字段即可 */
const UPDATE_SOURCES = [
  {
    id: "gitcode",
    label: "GitCode",
    hint: "默认线路 · 国内直连",
    releasesUrl: "https://gitcode.com/api/v5/repos/xiaolaoyu/Agent-chat-Pro/releases?per_page=50&direction=desc",
    tagsUrl: "https://gitcode.com/api/v5/repos/xiaolaoyu/Agent-chat-Pro/tags?per_page=30",
    kind: "gitcode",
    priority: 1,
  },
  {
    id: "github",
    label: "GitHub",
    hint: "备用线路 · 代理 / VPN 环境下使用",
    releasesUrl: "https://api.github.com/repos/yucaibang/Agent-chat-Pro/releases/latest",
    tagsUrl: "https://api.github.com/repos/yucaibang/Agent-chat-Pro/tags?per_page=30",
    kind: "github",
    priority: 2,
  },
];

// ────────────────────────── 版本号工具 ──────────────────────────

/** "v3.44.0" / "3.44.0" → {major,minor,patch}；解析不动 → null（铁则：不确定不算新版） */
function normalizeVersion(value) {
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(String(value || "").trim());
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  return { major, minor, patch };
}

/**
 * 版本比较铁则（v3.44.0 守门三断言锚）：
 *   返回 1 仅当 a > b；a === b → 0；a < b → -1。
 *   任一 null → 0（调用方语义=「无法判定」→ 按「已是最新版」收口，绝不误报更新）。
 */
function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  if (!left || !right) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] > right[key]) return 1;
    if (left[key] < right[key]) return -1;
  }
  return 0;
}

/** 版本集合取最大（全是 null → null） */
function maxVersion(versions) {
  let best = null;
  for (const version of versions) {
    if (!normalizeVersion(version)) continue;
    if (!best || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

async function fetchJson(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────── 单线路检测 ──────────────────────────

/**
 * 检测单一线路 → { sourceId, label, releaseVersion, tagVersion, asset, sumsAsset, error }
 * asset={url,size,digest,name}（digest 仅 GitHub API 提供）；找不到附件时不设 asset。
 */
async function detectOneSource(source, fetchImpl = fetch) {
  const result = {
    sourceId: source.id,
    label: source.label,
    priority: source.priority,
    releaseVersion: null,
    tagVersion: null,
    asset: null,
    sumsAsset: null,
    error: null,
  };
  try {
    // ① Release 判据
    let releases = await fetchJson(fetchImpl, source.releasesUrl);
    if (!Array.isArray(releases)) releases = [releases]; // GitHub /latest 返回单对象
    const withVersion = releases
      .filter((item) => item && item.draft !== true && normalizeVersion(item.tag_name))
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
    const latestRelease = withVersion[0] || null;
    if (latestRelease) {
      result.releaseVersion = latestRelease.tag_name;
      const assets = Array.isArray(latestRelease.assets) ? latestRelease.assets : [];
      const target = normalizeVersion(latestRelease.tag_name).patch;
      const exe = assets.find((item) => item && item.name && ASSET_EXE_PATTERN.test(String(item.name).trim())
        && normalizeVersion(ASSET_EXE_PATTERN.exec(String(item.name).trim())?.[1])?.patch === target);
      if (exe) {
        result.asset = {
          name: String(exe.name).trim(),
          url: exe.browser_download_url,
          size: Number(exe.size) || 0,
          digest: String(exe.digest || "").startsWith("sha256:") ? String(exe.digest).slice(7) : "",
        };
        // 清单附件匹配：版本化名（SHA256SUMS-vX.Y.Z.txt，发版义务形态）优先，通用名（SHA256SUMS.txt）兜底
        const sums = assets.find((item) => item && SUMS_PATTERN.test(String(item.name || "").trim()))
          || assets.find((item) => item && SUMS_PLAIN_PATTERN.test(String(item.name || "").trim()));
        if (sums) result.sumsAsset = { name: String(sums.name).trim(), url: sums.browser_download_url };
      }
    }
  } catch (error) {
    result.error = `release: ${String(error.message || error)}`;
  }
  try {
    // ② tag 兜底判据（tag 常领先 release——发版先 push tag、附件后手动传）
    const tags = await fetchJson(fetchImpl, source.tagsUrl);
    const names = (Array.isArray(tags) ? tags : []).map((item) => item && item.name).filter(Boolean);
    result.tagVersion = maxVersion(names);
    // asset 与「最新版本」的匹配不在本函数做——checkForUpdate 聚合阶段按 remoteVersion 统一挑
    // （tag 领先 release/附件的窗口期，该线路 asset 留着旧版，匹配不上 remoteVersion 自然不借线，不在此误删）
  } catch (error) {
    result.error = result.error ? `${result.error}; tags: ${String(error.message || error)}` : `tags: ${String(error.message || error)}`;
  }
  return result;
}

// ────────────────────────── 聚合检测 ──────────────────────────

/**
 * 聚合检测（check 更新主入口）：
 *   mode = "auto"（默认，双线路全查+自动降级）/ "gitcode"（仅线路一）/ "github"（仅线路二）
 * 返回：
 *   { status: "latest" | "update" | "asset-missing" | "unreachable",
 *     currentVersion, remoteVersion, asset, sumsAsset, sourceId, sources, attempts }
 */
async function checkForUpdate({ mode = "auto", currentVersion, fetchImpl = fetch } = {}) {
  const list = mode === "gitcode" || mode === "github"
    ? UPDATE_SOURCES.filter((item) => item.id === mode)
    : UPDATE_SOURCES;
  const sources = [];
  const attempts = [];
  for (const source of list) {
    try {
      sources.push(await detectOneSource(source, fetchImpl));
    } catch (error) {
      attempts.push(`${source.id}: ${String(error.message || error)}`);
    }
  }
  for (const detection of sources) if (detection.error) attempts.push(`${detection.sourceId}: ${detection.error}`);

  // 聚合版本：release/tag 全集合取 max（双判据双保障）
  const remoteVersion = maxVersion(
    sources.flatMap((item) => [item.releaseVersion, item.tagVersion]).filter(Boolean)
  );
  if (!remoteVersion) {
    return { status: "unreachable", currentVersion, remoteVersion: null, asset: null, sumsAsset: null, sourceId: null, sources, attempts };
  }

  const verdict = compareVersions(remoteVersion, currentVersion);
  if (verdict <= 0) {
    // 铁则：远端 ≤ 本地 一律「已是最新版」（equal/lower 都不走「有新版」路径）
    return { status: "latest", currentVersion, remoteVersion, asset: null, sumsAsset: null, sourceId: null, sources, attempts };
  }

  // 找该版本的安装包（匹配按 remoteVersion 严格相等；自动模式：线路优先级升序借线；单线路模式：只认自己）
  let asset = null;
  let sumsAsset = null;
  let sourceId = null;
  for (const candidate of sources.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99))) {
    if (!candidate.asset) continue;
    const assetVersion = ASSET_EXE_PATTERN.exec(candidate.asset.name)?.[1];
    if (assetVersion && compareVersions(assetVersion, remoteVersion) === 0) {
      asset = candidate.asset;
      sumsAsset = candidate.sumsAsset;
      sourceId = candidate.sourceId; // detectOneSource 返回结构字段名（借线来源展示用它，别取 item.id）
      break;
    }
  }
  if (!asset) {
    return { status: "asset-missing", currentVersion, remoteVersion, asset: null, sumsAsset: null, sourceId: null, sources, attempts };
  }
  return { status: "update", currentVersion, remoteVersion, asset, sumsAsset, sourceId, sources, attempts };
}

// ────────────────────────── 下载 + 校验 ──────────────────────────

/** 解析 SHA256SUMS 清单文本 → { 文件名: hash }（宽松匹配空格分隔与注释行） */
function parseSumsManifest(text) {
  const table = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) table[match[2].trim().toLowerCase()] = match[1];
  }
  return table;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const MANIFEST_ROW_PATTERN = /^([0-9a-f]{64})\s+\*?(.+)$/i;
const MANIFEST_BARE_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * 清单里取「该安装包」的期望 sha256（v3.44.0 现网三形态全兼容）：
 *   ① 标准行：`<hash>  <文件名>`（共享盘清单/发版义务形态）
 *   ② 裸哈希形态（GitCode 历史 release 实拉：恰一行独立 64-hex，注释里 certutil 命令带文件名）
 *      ——仅在文本明确提到该附件名时采信，恰一行防串哈希，否则回 null 走 size 校验
 * 解析不出 → null（调用方回退 digest/size，绝不误配）
 */
function manifestSha256ForAsset(text, assetName) {
  const content = String(text || "");
  const name = String(assetName || "").trim();
  const table = parseSumsManifest(content);
  const rowHit = table[name.toLowerCase()];
  if (rowHit) return rowHit.toLowerCase();
  if (!name || !content.includes(name)) return null;
  const bareHashes = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => MANIFEST_BARE_PATTERN.test(line));
  return bareHashes.length === 1 ? bareHashes[0].toLowerCase() : null;
}

/**
 * 下载安装包（流式 + 进度）→ 校验三层（清单 → digest → size）→ 落地 filePath
 * onProgress(received, total)；全失败抛错（调用方绝不触发安装）。
 */
async function downloadUpdateAsset({ asset, sumsAsset, file, fetchImpl = fetch, onProgress } = {}) {
  if (!asset || !asset.url) throw new Error("缺少安装包下载地址");
  if (!file) throw new Error("缺少落地路径");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // —— 安装包流式下载
  const response = await fetchImpl(asset.url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok || !response.body) throw new Error(`安装包下载失败：HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || asset.size || 0;
  let received = 0;
  const out = fs.createWriteStream(file);
  for await (const chunk of response.body) {
    received += chunk.length;
    if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    if (typeof onProgress === "function") onProgress(received, total || asset.size || 0);
  }
  await new Promise((resolve, reject) => { out.end(resolve); out.on("error", reject); });
  const realSize = fs.statSync(file).size;

  // —— 校验三层：① SHA256 清单附件 ② GitHub digest ③ size 对账
  const verify = { manifest: false, digest: false, size: false };
  const localHash = sha256File(file);
  if (sumsAsset && sumsAsset.url) {
    const manifestRes = await fetchImpl(sumsAsset.url, { headers: { "User-Agent": USER_AGENT } });
    if (manifestRes.ok) {
      // manifestSha256ForAsset 兼容标准行/裸哈希两形态（GitCode 历史清单实拉形态），解析不出 → 回退 digest/size
      const expected = manifestSha256ForAsset(await manifestRes.text(), asset.name);
      if (expected) {
        verify.manifest = expected.toLowerCase() === localHash;
        if (!verify.manifest) throw new Error(`SHA256 清单校验失败（清单 ${expected} vs 实际 ${localHash}）——为安全起见已放弃安装`);
      }
    }
  }
  verify.digest = Boolean(asset.digest) && asset.digest.toLowerCase() === localHash;
  if (!verify.manifest && !verify.digest) {
    verify.size = Boolean(asset.size) && asset.size === realSize;
    if (!verify.size) {
      if (asset.size) throw new Error(`校验失败（size ${asset.size} vs 实际 ${realSize}）——为安全起见已放弃安装`);
      throw new Error("无可校验凭证（清单/digest/size 全缺）——为安全起见已放弃安装");
    }
  }
  return { file, size: realSize, hash: localHash, verifiedWith: verify.manifest ? "manifest" : verify.digest ? "digest" : "size" };
}

// ────────────────────────── 安装（NSIS 静默） ──────────────────────────

/**
 * 静默安装：NSIS /S（electron-builder per-user 装法，无管理员弹窗；装完 NSIS 自带
 * runAfterFinish 启动新版）。spawnImpl/quitImpl 注入（守门测试真跑用）。
 */
function installUpdate({ file, spawnImpl, quitImpl } = {}) {
  if (!file || !fs.existsSync(file)) throw new Error("安装包不存在");
  const child = spawnImpl(file, ["/S"], { detached: true, stdio: "ignore" });
  child.unref();
  setTimeout(() => { try { quitImpl(); } catch { /* 重启通道失败不影响安装进程 */ } }, 500);
  return { launched: true, file };
}

module.exports = {
  UPDATE_SOURCES,
  USER_AGENT,
  normalizeVersion,
  compareVersions,
  maxVersion,
  detectOneSource,
  checkForUpdate,
  parseSumsManifest,
  manifestSha256ForAsset,
  sha256File,
  downloadUpdateAsset,
  installUpdate,
};
