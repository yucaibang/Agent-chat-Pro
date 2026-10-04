"use strict";

/**
 * 运行时完整性自检模块 — 防破解关键防线
 *
 * 检查项：
 * 1. Fuse 状态自检（主进程启动时验证关键 Fuse 是否已烧录）
 * 2. ASAR 完整性自检（验证当前进程是否从 ASAR 加载）
 * 3. 品牌验证篡改检测（检测 _verified 是否被运行时修改）
 * 4. 调试器检测（检测 --inspect / DevTools 附加）
 * 5. 环境变量注入检测（检测 NODE_OPTIONS 是否被滥用）
 *
 * 设计原则：
 * - 检测到调试行为不崩溃，而是返回虚假数据或静默降级
 * - 所有检查在主进程启动时运行一次
 * - 定期复查关键状态
 */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class IntegrityGuard {
  constructor() {
    this._checkResults = {};
    this._checkTimer = null;
    this._tampered = false;
    this._fakeData = this._generateFakeData();
  }

  /**
   * 生成虚假数据 — 检测到调试/篡改时返回这些数据迷惑攻击者
   */
  _generateFakeData() {
    return {
      brandHash: crypto.randomBytes(32).toString("hex"),
      deviceId: crypto.randomBytes(16).toString("hex"),
      verified: false,
      overrideToken: null,
    };
  }

  /**
   * 启动所有自检，返回检查结果
   */
  async performFullCheck() {
    const results = {
      fuses: this._checkFuses(),
      asarIntegrity: this._checkAsarIntegrity(),
      debugDetection: this._checkDebugEnvironment(),
      nodeOptions: this._checkNodeOptions(),
      timestamp: Date.now(),
    };

    this._checkResults = results;
    this._tampered = Object.values(results).some(
      (v) => v && typeof v === "object" && v.tampered === true
    );

    // 启动定期复查
    if (!this._checkTimer) {
      this._checkTimer = setInterval(() => {
        this._performPeriodicCheck();
      }, 5 * 60 * 1000); // 每5分钟复查
    }

    return results;
  }

  /**
   * 检查1: Fuse 状态验证
   * 读取自身 exe 的 Fuse sentinel，验证关键 Fuse 是否正确烧录
   */
  /**
   * v3.16.3 启动提速：只读 fuse sentinel 的预估窗口段（79% 相对位置起 10MB）。
   * 命中返回窗口 Buffer，未命中/读取异常返回 null（由调用方回退全文件扫描）。
   */
  _readFuseWindow(exePath, fileSize, sentinel) {
    try {
      const start = Math.max(0, Math.floor(fileSize * 0.79));
      const length = Math.min(10 * 1024 * 1024, fileSize - start);
      if (length < sentinel.length + 16) return null;
      const fd = fs.openSync(exePath, "r");
      try {
        const buf = Buffer.alloc(length);
        const read = fs.readSync(fd, buf, 0, length, start);
        if (read < length) return buf.subarray(0, read).indexOf(sentinel) === -1 ? null : buf.subarray(0, read);
        return buf.indexOf(sentinel) === -1 ? null : buf;
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      return null;
    }
  }

  _checkFuses() {
    try {
      const exePath = process.execPath;
      // v3.16.3 启动性能修复：fuse sentinel 实测位于 exe 固定相对位置（v3.16.2 实测 201233408 字节 exe、
      // 偏移 165194160 ≈ 82%）。改为只读 79% 起 10MB 窗口（约 5% 覆盖带，留 Electron 版本漂移余量），
      // 窗口未命中时回退原全文件扫描——防破解语义与检出能力完全不变，启动 IO 从 201MB 降至 ~10MB。
      const stat = fs.statSync(exePath);
      const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
      const data = this._readFuseWindow(exePath, stat.size, sentinel) || fs.readFileSync(exePath);
      const pos = data.indexOf(sentinel);

      if (pos === -1) {
        return { tampered: true, reason: "fuse_sentinel_not_found" };
      }

      const after = data.slice(pos + sentinel.length, pos + sentinel.length + 10);
      const version = after[0];
      const count = after[1];
      const values = after.slice(2, 2 + count).toString("ascii");

      // 期望值: RunAsNode=0, Cookie=1, NodeOpts=0, Inspect=0, AsarInt=1, OnlyAsar=1, V8Snap=0, FilePriv=0
      const expected = "01001100";
      const criticalFuses = {
        EnableEmbeddedAsarIntegrityValidation: values[4] === "1",
        OnlyLoadAppFromAsar: values[5] === "1",
        RunAsNode: values[0] === "0",
        EnableNodeOptionsEnvironment: values[2] === "0",
        EnableNodeCliInspectArguments: values[3] === "0",
      };

      const fusesOK = values.startsWith(expected);
      return {
        tampered: !fusesOK,
        version,
        values,
        expected,
        criticalFuses,
        reason: fusesOK ? null : "fuse_values_mismatch",
      };
    } catch (error) {
      // 读取失败时静默返回（可能是在开发环境中运行）
      return { tampered: false, reason: "check_skipped_dev_mode" };
    }
  }

  /**
   * 检查2: ASAR 完整性验证
   * 确认主进程是从 ASAR 加载，且 ASAR 文件未被篡改
   */
  _checkAsarIntegrity() {
    try {
      const mainModulePath = __filename;
      const isFromAsar = mainModulePath.includes(".asar");

      if (!isFromAsar) {
        return { tampered: true, reason: "not_running_from_asar" };
      }

      // 检查 ASAR 文件是否存在
      const asarPath = mainModulePath.split(".asar")[0] + ".asar";
      if (!fs.existsSync(asarPath)) {
        return { tampered: true, reason: "asar_file_missing" };
      }

      return { tampered: false, isFromAsar: true };
    } catch (error) {
      return { tampered: false, reason: "check_skipped" };
    }
  }

  /**
   * 检查3: 调试环境检测
   * 不崩溃，只记录状态，检测到时返回虚假数据
   */
  _checkDebugEnvironment() {
    const indicators = {
      hasInspectArg: process.argv.some(
        (arg) => arg.startsWith("--inspect") || arg.startsWith("--inspect-brk")
      ),
      hasRemoteDebugging: !!process.env.ELECTRON_RUN_AS_NODE,
      hasDevTools: false, // 运行时从 renderer 侧检测
    };

    const isDebugging =
      indicators.hasInspectArg || indicators.hasRemoteDebugging;

    return {
      tampered: isDebugging,
      indicators,
      reason: isDebugging ? "debug_environment_detected" : null,
    };
  }

  /**
   * 检查4: NODE_OPTIONS 注入检测
   */
  _checkNodeOptions() {
    const nodeOpts = process.env.NODE_OPTIONS || "";
    const suspiciousPatterns = [
      /--require/i,
      /--loader/i,
      /--import/i,
      /-r\s/i,
      /--preload/i,
    ];

    const suspicious = suspiciousPatterns.some((p) => p.test(nodeOpts));

    return {
      tampered: suspicious,
      nodeOptionsPresent: nodeOpts.length > 0,
      reason: suspicious ? "suspicious_node_options" : null,
    };
  }

  /**
   * 定期复查
   */
  _performPeriodicCheck() {
    const debugCheck = this._checkDebugEnvironment();
    const nodeOptsCheck = this._checkNodeOptions();

    if (debugCheck.tampered || nodeOptsCheck.tampered) {
      this._tampered = true;
      this._fakeData = this._generateFakeData(); // 刷新虚假数据
    }
  }

  /**
   * 获取是否被篡改
   */
  get isTampered() {
    return this._tampered;
  }

  /**
   * 获取虚假数据 — 供品牌验证等模块使用
   * 当检测到篡改时，返回虚假数据迷惑攻击者
   */
  get fakeData() {
    return this._tampered ? this._fakeData : null;
  }

  /**
   * 停止定期检查
   */
  stop() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }
}

module.exports = { IntegrityGuard };