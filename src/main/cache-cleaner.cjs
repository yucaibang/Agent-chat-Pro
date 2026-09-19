"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

/**
 * Windows 系统缓存清理（v3.10.0）
 *
 * 分级：
 *   safe     — 用户级、无风险（默认勾选）
 *   advanced — 影响轻微但需知情（手动勾选）
 *   admin    — 需要管理员权限（UAC 提权，逐项确认）
 *
 * 明确不清理：Prefetch（清后短期变慢）、WinSxS 组件库（耗时且高风险）、
 * Windows.old（不可逆、丢失系统回滚能力）、Winsock（仅网络故障时手动）。
 */

const IS_WINDOWS = process.platform === "win32";

function runPowerShell(script, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    if (!IS_WINDOWS) return resolve({ code: -1, stdout: "", stderr: "非 Windows 环境" });
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout || ""),
          stderr: error ? String(error.stderr || error.message || "") : ""
        });
      }
    );
  });
}

/** 递归统计目录大小（跳过无权限/占用中条目） */
function measureDirectory(target, state) {
  const stats = { size: 0, files: 0 };
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return stats;
  }
  for (const entry of entries) {
    if (state.aborted) break;
    const full = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) {
        if (entry.name === "system32" || entry.name === "syswow64") continue; // 永不深入系统核心目录
        const nested = measureDirectory(full, state);
        stats.size += nested.size;
        stats.fileCount += nested.fileCount;
      } else if (entry.isFile()) {
        stats.size += fs.statSync(full).size;
        stats.fileCount += 1;
      }
    } catch {
      // 权限/占用 — 跳过
    }
  }
  return stats;
}

/** 清空目录内容（保留目录本身；占用中文件静默跳过） */
function deleteDirectoryContents(target, log) {
  let freed = 0;
  let failed = 0;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { freed, failed };
    throw new Error(`无法访问目录：${target}`);
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    const before = entry.isFile() ? (() => { try { return fs.statSync(full).size; } catch { return 0; } })() : 0;
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
      freed += before;
    } catch {
      failed += 1;
      // rmSync 失败（占用中）— 尝试统计原大小不计入 freed
      log?.(`skip_busy:${entry.name}`);
    }
  }
  return { freed, failed };
}

const userTempDir = () => os.tmpdir();
const windowsTempDir = () => path.join(process.env.SystemRoot || "C:\\Windows", "Temp");
const thumbnailDir = () => path.join(process.env.APPDATA || "", "..", "Local", "Microsoft", "Windows", "Explorer");
const storeCacheDir = () => path.join(process.env.APPDATA || "", "..", "Local", "Packages", "Microsoft.WindowsStore_8wekyb3d8bbwe", "LocalCache");
const updateCacheDir = () => path.join(process.env.SystemRoot || "C:\\Windows", "SoftwareDistribution", "Download");

const CACHE_TARGETS = [
  {
    id: "user-temp",
    name: "用户临时文件",
    risk: "safe",
    description: "应用与安装程序留下的临时文件（%TEMP%）",
    location: () => userTempDir(),
    measure: (state) => measureDirectory(userTempDir(), state),
    clean: async (log) => {
      // 排除本应用正在使用的文件（在自身 Temp 下运行时跳过活跃句柄）
      const result = deleteDirectoryContents(userTempDir(), log);
      return { freed: result.freed, message: result.failed ? `完成，${result.failed} 个占用中文件已跳过` : "完成" };
    }
  },
  {
    id: "recycle-bin",
    name: "回收站",
    risk: "safe",
    description: "清空回收站（删除后不可恢复）",
    location: () => "C:\\$Recycle.Bin",
    measure: (state) => measureDirectory("C:\\$Recycle.Bin", state),
    clean: async () => {
      const result = await runPowerShell("Clear-RecycleBin -Force -ErrorAction SilentlyContinue; Write-Output OK", 60_000);
      if (!/OK/.test(result.stdout) && result.code !== 0) throw new Error("回收站清理失败");
      return { freed: 0, freedUnknown: true, message: "已清空回收站" };
    }
  },
  {
    id: "thumbnails",
    name: "缩略图与图标缓存",
    risk: "safe",
    description: "Explorer 缩略图缓存（thumbcache/iconcache，重启资源管理器后自动重建）",
    location: () => thumbnailDir(),
    measure: (state) => {
      let size = 0;
      let fileCount = 0;
      const dir = thumbnailDir();
      let entries;
      try { entries = fs.readdirSync(dir); } catch { return { size, fileCount }; }
      for (const name of entries) {
        if (!/^(thumbcache_|iconcache_).*\.db$/i.test(name)) continue;
        try { size += fs.statSync(path.join(dir, name)).size; fileCount += 1; } catch {}
      }
      return { size, fileCount };
    },
    clean: async (log) => {
      const dir = thumbnailDir();
      let freed = 0;
      let failed = 0;
      let entries;
      try { entries = fs.readdirSync(dir); } catch { return { freed, message: "目录不存在" }; }
      for (const name of entries) {
        if (!/^(thumbcache_|iconcache_).*\.db$/i.test(name)) continue;
        const full = path.join(dir, name);
        try {
          const size = fs.statSync(full).size;
          fs.rmSync(full, { force: true, maxRetries: 2, retryDelay: 120 });
          freed += size;
        } catch {
          failed += 1;
          log?.(`skip_busy:${name}`);
        }
      }
      return { freed, message: failed ? `完成，${failed} 个占用中文件已跳过` : "完成" };
    }
  },
  {
    id: "dns",
    name: "DNS 解析缓存",
    risk: "safe",
    description: "刷新本机 DNS 缓存（ipconfig /flushdns，无文件删除）",
    location: () => "（内存缓存）",
    measure: () => ({ size: 0, fileCount: 0 }),
    clean: async () => {
      const result = await runPowerShell("ipconfig /flushdns", 30_000);
      if (!/成功刷新|successfully flushed/i.test(result.stdout + result.stderr)) {
        throw new Error("DNS 缓存刷新失败：" + (result.stderr || result.stdout).slice(0, 120));
      }
      return { freed: 0, freedUnknown: true, message: "DNS 缓存已刷新" };
    }
  },
  {
    id: "windows-temp",
    name: "系统临时文件",
    risk: "advanced",
    description: "C:\\Windows\\Temp（部分文件需要管理员权限，无权限时自动跳过）",
    location: () => windowsTempDir(),
    measure: (state) => measureDirectory(windowsTempDir(), state),
    clean: async (log) => {
      const result = deleteDirectoryContents(windowsTempDir(), log);
      return { freed: result.freed, message: result.failed ? `完成，${result.failed} 个无权限/占用中文件已跳过` : "完成" };
    }
  },
  {
    id: "store-cache",
    name: "Microsoft Store 缓存",
    risk: "advanced",
    description: "商店应用下载与图片缓存（清除后首次打开商店会重新下载）",
    location: () => storeCacheDir(),
    measure: (state) => measureDirectory(storeCacheDir(), state),
    clean: async (log) => {
      const result = deleteDirectoryContents(storeCacheDir(), log);
      return { freed: result.freed, message: result.failed ? `完成，${result.failed} 个占用中文件已跳过` : "完成" };
    }
  },
  {
    id: "update-cache",
    name: "Windows Update 缓存",
    risk: "admin",
    description: "更新下载残留（SoftwareDistribution\\Download，需管理员权限；更新会重新下载）",
    location: () => updateCacheDir(),
    measure: (state) => measureDirectory(updateCacheDir(), state),
    clean: async () => {
      // UAC 提权执行：停服务 → 删缓存 → 启服务
      const script = [
        "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -Command \"",
        "Stop-Service wuauserv -Force -ErrorAction SilentlyContinue; ",
        "Stop-Service bits -Force -ErrorAction SilentlyContinue; ",
        "Remove-Item -Path \\\"$env:SystemRoot\\\\SoftwareDistribution\\\\Download\\\\*\\\" -Recurse -Force -ErrorAction SilentlyContinue; ",
        "Start-Service bits -ErrorAction SilentlyContinue; ",
        "Start-Service wuauserv -ErrorAction SilentlyContinue\"'",
      ].join("");
      const result = await runPowerShell(script, 180_000);
      if (result.code !== 0 && !result.stdout.trim()) {
        throw new Error("需要管理员权限（请在弹出的 UAC 窗口中确认）");
      }
      return { freed: 0, freedUnknown: true, message: "已通过管理员权限清理" };
    }
  }
];

/** 扫描全部缓存项：返回各项大小与可清理性 */
async function scanSystemCaches() {
  const state = { aborted: false };
  const results = [];
  for (const target of CACHE_TARGETS) {
    const item = {
      id: target.id,
      name: target.name,
      risk: target.risk,
      description: target.description,
      location: typeof target.location === "function" ? target.location() : target.location(),
      available: IS_WINDOWS
    };
    if (!IS_WINDOWS) {
      item.available = false;
      item.size = 0;
      item.fileCount = 0;
      results.push(item);
      continue;
    }
    try {
      const measured = target.measure(state);
      item.size = measured.size || 0;
      item.fileCount = measured.fileCount || 0;
      // DNS/回收站等无文件统计项：大小为 0 但仍可清理
    } catch (error) {
      item.size = 0;
      item.fileCount = 0;
      item.error = error.message;
    }
    results.push(item);
  }
  return { platform: process.platform, supported: IS_WINDOWS, targets: results };
}

/** 执行清理：targets 为勾选的 id 数组，onLog 收集逐条日志 */
async function cleanSystemCaches(targets, onLog) {
  const log = (message) => { try { onLog?.(message); } catch { /* 忽略 */ } };
  if (!IS_WINDOWS) throw new Error("缓存清理仅支持 Windows 系统。");
  const wanted = new Set(Array.isArray(targets) ? targets : []);
  const results = [];
  for (const target of CACHE_TARGETS) {
    if (!wanted.has(target.id)) continue;
    const entry = { id: target.id, name: target.name };
    try {
      const outcome = await target.clean(log);
      entry.ok = true;
      entry.freed = outcome.freed || 0;
      entry.freedUnknown = Boolean(outcome.freedUnknown);
      entry.message = outcome.message || "完成";
    } catch (error) {
      entry.ok = false;
      entry.message = error.message;
    }
    results.push(entry);
  }
  return { results };
}

module.exports = { scanSystemCaches, cleanSystemCaches, CACHE_TARGET_COUNT: CACHE_TARGETS.length };