"use strict";

const { app, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { writeLog } = require("../logger.cjs");

/**
 * Agent Chat Pro 授权管理器
 *
 * 核心规则：
 * 1. 未填写有效授权码 → 仅开放基础云端AI聊天功能，SSH/外网模块完全锁定
 * 2. 违规阶梯警告：1次弹窗、2次弹窗、3次终止进程
 * 3. 3次违规后，下次启动只弹授权码输入弹窗，禁止进入主程序
 * 4. 违规次数本地+远端双写，删除本地文件无法清除远端记录
 * 5. 外网转发权限最终判断在NAS后端，客户端篡改无法绕过
 * 6. 授权码不在本地存储，仅提交到后端验证
 */

// ── 配置 ──────────────────────────────────────────────

// 敏感字符串混淆：运行时拼接 AUTH_SERVER_URL
const _urlSegs = ["http://192", ".168.0.", "99:9090"];
const AUTH_SERVER_URL = _urlSegs.join("");

const AUTH_FILE = "auth-state.json";
const MAX_VIOLATIONS = 3;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5分钟检查一次后端授权状态

// API 路径混淆：运行时拼接
function _apiPath(segs) { return segs.join(""); }
const _API_VERIFY = _apiPath(["/api", "/auth", "/verify"]);
const _API_UNLOCK = _apiPath(["/api", "/auth", "/unlock"]);
const _API_VIOLATION = _apiPath(["/api", "/auth", "/violation"]);
const _API_CHECK = _apiPath(["/api", "/auth", "/check"]);

// ── 加密常量 ──────────────────────────────────────────

const ENCRYPTION_KEY_SALT = "ACP1-S4LT-2024-X9K7M3P2";
const STATE_FILE_HEADER = Buffer.from("ACP1");

// ── 设备ID生成 ────────────────────────────────────────

function getDeviceId() {
  const raw = [
    os.hostname(),
    os.userInfo().username,
    process.platform,
    os.arch(),
    // 用用户数据目录路径作为额外区分
    app.getPath("userData")
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// ── 加密密钥派生 ──────────────────────────────────────

/**
 * 用 PBKDF2 从设备ID + 盐值派生 32 字节密钥
 * @param {string} deviceId - 设备ID
 * @returns {Buffer} 32字节 AES密钥
 */
function deriveEncryptionKey(deviceId) {
  return crypto.pbkdf2Sync(deviceId, ENCRYPTION_KEY_SALT, 100000, 32, "sha256");
}

// ── 本地状态管理 ──────────────────────────────────────

function authFilePath() {
  return path.join(app.getPath("userData"), AUTH_FILE);
}

const _emptyState = Object.freeze({ violations: 0, authorized: false, expiresAt: null, lastCheck: null });

function readLocalState() {
  try {
    const raw = fs.readFileSync(authFilePath()); // 读取为 Buffer（不指定编码）
    // 检查是否为加密格式（以 ACP1 头部开头）
    if (raw.length >= 4 && raw.slice(0, 4).equals(STATE_FILE_HEADER)) {
      // 加密格式: ACP1(4) + IV(12) + AUTH_TAG(16) + CIPHERTEXT
      if (raw.length < 32) {
        writeLog("auth_state_encrypted_too_short");
        return { ..._emptyState };
      }
      const iv = raw.slice(4, 16);
      const authTag = raw.slice(16, 32);
      const ciphertext = raw.slice(32);
      const key = deriveEncryptionKey(getDeviceId());
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      let payload;
      try {
        payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        // 解密失败 - 视为空状态（防篡改）
        writeLog("auth_state_decrypt_failed");
        return { ..._emptyState };
      }
      // 提取 HMAC(32字节) + 明文
      if (payload.length < 32) {
        writeLog("auth_state_payload_too_short");
        return { ..._emptyState };
      }
      const storedHmac = payload.slice(0, 32);
      const plaintext = payload.slice(32).toString("utf8");
      // 验证 HMAC
      const expectedHmac = crypto.createHmac("sha256", key).update(plaintext).digest();
      if (!crypto.timingSafeEqual(storedHmac, expectedHmac)) {
        // HMAC 不匹配 - 视为空状态（防篡改）
        writeLog("auth_state_hmac_mismatch");
        return { ..._emptyState };
      }
      return JSON.parse(plaintext);
    } else {
      // 明文 JSON（旧格式） - 自动迁移为加密格式
      const jsonStr = raw.toString("utf8");
      const state = JSON.parse(jsonStr);
      writeLocalState(state); // 重新写入加密格式（覆盖明文）
      writeLog("auth_state_migrated_to_encrypted");
      return state;
    }
  } catch {
    return { ..._emptyState };
  }
}

function writeLocalState(state) {
  try {
    const key = deriveEncryptionKey(getDeviceId());
    const plaintext = JSON.stringify(state, null, 2);
    // HMAC 签名
    const hmac = crypto.createHmac("sha256", key).update(plaintext).digest();
    // 组合 payload = HMAC(32) + 明文
    const payload = Buffer.concat([hmac, Buffer.from(plaintext, "utf8")]);
    // AES-256-GCM 加密
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // 组合文件内容: ACP1(4) + IV(12) + AUTH_TAG(16) + CIPHERTEXT
    const fileData = Buffer.concat([STATE_FILE_HEADER, iv, authTag, encrypted]);
    fs.writeFileSync(authFilePath(), fileData);
  } catch (error) {
    writeLog("auth_state_write_failed", { error: error.message });
  }
}

// ── 后端通信 ──────────────────────────────────────────

/**
 * 通用 HTTP/HTTPS 请求封装
 */
function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, AUTH_SERVER_URL);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: { "Content-Type": "application/json" },
      timeout: 10000
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`响应解析失败: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("授权服务器连接超时")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── 授权管理器 ────────────────────────────────────────

class AuthManager {
  constructor() {
    this.deviceId = getDeviceId();
    this._state = readLocalState();
    this._checkTimer = null;
    this._window = null;
    this._expectedHash = ""; // 打包脚本自动填充，空字符串表示跳过检查
    this._integrityResult = null; // 缓存完整性检查结果
    this._debuggerDetected = false; // 反调试检测标志
    writeLog("auth_init", { deviceId: this.deviceId, violations: this._state.violations, authorized: this._state.authorized });
  }

  /** 设置主窗口引用（用于弹窗） */
  setWindow(win) {
    this._window = win;
  }

  // ── 反调试检测 ────────────────────────────────────────

  /**
   * 反调试检查：用 performance.now() 检测断点暂停
   * 两次 now() 间隔 > 1000ms 视为调试器暂停
   * 检测到时不是直接退出，而是让授权验证返回"未授权"
   */
  _antiDebugCheck() {
    const t1 = performance.now();
    // 空操作 — 如果调试器在此设断点，t2-t1 将超过阈值
    const t2 = performance.now();
    if (t2 - t1 > 1000) {
      this._debuggerDetected = true;
      writeLog("auth_debugger_detected", { delayMs: t2 - t1 });
    }
    return this._debuggerDetected;
  }

  // ── 防篡改检查 ────────────────────────────────────────

  /**
   * 验证自身源码完整性
   * 读取 auth-manager.cjs 自身源码，计算 SHA256 哈希，
   * 与硬编码的预期哈希比较。不匹配则让 isAuthorized 返回 false（静默失效）。
   * _expectedHash 为空字符串时跳过检查（打包脚本自动填充）。
   */
  _verifyIntegrity() {
    if (this._integrityResult !== null) return this._integrityResult;
    if (!this._expectedHash) {
      // 空字符串表示跳过检查
      this._integrityResult = true;
      return true;
    }
    try {
      const selfPath = __filename;
      const source = fs.readFileSync(selfPath, "utf8");
      const hash = crypto.createHash("sha256").update(source).digest("hex");
      this._integrityResult = (hash === this._expectedHash);
      if (!this._integrityResult) {
        writeLog("auth_integrity_check_failed", { expected: this._expectedHash, actual: hash });
      }
      return this._integrityResult;
    } catch {
      // 无法读取自身源码时不阻止（可能是 asar 打包环境）
      this._integrityResult = true;
      return true;
    }
  }

  // ── 授权状态 ────────────────────────────────────────

  /** 是否已授权（本地缓存 + 后端验证） */
  get isAuthorized() {
    // 反调试检测 — 检测到调试器时返回未授权
    if (this._debuggerDetected) return false;
    // 防篡改检查 — 不匹配时静默返回 false
    if (!this._verifyIntegrity()) return false;
    if (!this._state.authorized) return false;
    if (this._state.expiresAt && Date.now() > this._state.expiresAt) {
      // 授权已过期
      this._state.authorized = false;
      writeLocalState(this._state);
      return false;
    }
    return true;
  }

  /** 是否被锁定（违规≥3次） */
  get isLocked() {
    return this._state.violations >= MAX_VIOLATIONS;
  }

  /** 违规次数 */
  get violationCount() {
    return this._state.violations || 0;
  }

  /** 是否允许使用SSH/外网功能 */
  get canUseAdvancedFeatures() {
    return this.isAuthorized && !this.isLocked;
  }

  // ── 授权验证 ────────────────────────────────────────

  /**
   * 验证授权码
   * @param {string} code - 用户输入的授权码
   * @returns {Promise<{valid: boolean, expiresAt?: number, message: string}>}
   */
  async verifyCode(code) {
    try {
      const result = await request("POST", _API_VERIFY, {
        code: code.trim(),
        deviceId: this.deviceId
      });
      if (result.valid) {
        this._state.authorized = true;
        this._state.expiresAt = result.expiresAt;
        this._state.lastCheck = Date.now();
        writeLocalState(this._state);
        writeLog("auth_verify_success", { expiresAt: result.expiresAt });
        // 验证成功后清除违规锁定
        if (this.isLocked || this._state.violations > 0) {
          this._state.violations = 0;
          writeLocalState(this._state);
          writeLog("auth_lock_cleared_after_verify", { admin: Boolean(result.admin) });
        }
        // 通知后端解锁设备
        try {
          await request("POST", _API_UNLOCK, { deviceId: this.deviceId });
          writeLog("auth_device_unlocked_on_server");
        } catch (unlockError) {
          writeLog("auth_device_unlock_failed", { error: unlockError.message });
        }
      } else {
        writeLog("auth_verify_failed", { message: result.message });
      }
      return result;
    } catch (error) {
      writeLog("auth_verify_error", { error: error.message });
      return { valid: false, message: `验证失败: ${error.message}` };
    }
  }

  /**
   * 检查后端授权状态（后端最终判断）
   * @returns {Promise<{authorized: boolean, locked?: boolean, expiresAt?: number}>}
   */
  async checkAuthFromServer() {
    try {
      const result = await request("GET", `${_API_CHECK}?deviceId=${encodeURIComponent(this.deviceId)}`);
      this._state.authorized = result.authorized;
      this._state.expiresAt = result.expiresAt || null;
      this._state.lastCheck = Date.now();
      if (result.locked) {
        this._state.violations = MAX_VIOLATIONS;
      }
      writeLocalState(this._state);
      writeLog("auth_check_success", { authorized: result.authorized, locked: result.locked });
      return result;
    } catch (error) {
      writeLog("auth_check_error", { error: error.message });
      // 后端不可达时，使用本地缓存（但外网功能必须在后端确认后才开放）
      return { authorized: false, error: error.message };
    }
  }

  // ── 违规处理 ────────────────────────────────────────

  /**
   * 上报违规
   * @param {string} type - 违规类型（如 "force_ssh", "force_external", "bypass_lock"）
   * @returns {Promise<{violations: number, locked: boolean}>}
   */
  async reportViolation(type) {
    this._state.violations = (this._state.violations || 0) + 1;
    writeLocalState(this._state);
    writeLog("auth_violation_local", { type, count: this._state.violations });

    // 同时上报后端
    try {
      const result = await request("POST", _API_VIOLATION, {
        deviceId: this.deviceId,
        type
      });
      // 同步后端的违规计数（可能更高）
      this._state.violations = Math.max(this._state.violations, result.violations);
      writeLocalState(this._state);
      writeLog("auth_violation_remote", { violations: result.violations, locked: result.locked });
      return result;
    } catch (error) {
      writeLog("auth_violation_remote_failed", { error: error.message });
      // 后端不可达时，仅本地记录
      return { violations: this._state.violations, locked: this._state.violations >= MAX_VIOLATIONS };
    }
  }

  /**
   * 执行阶梯警告策略
   * @param {string} type - 违规类型
   * @returns {Promise<boolean>} true=应继续阻止, false=用户选择忽略（不会发生，因为强制阻止）
   */
  async enforceViolationPolicy(type) {
    const currentCount = this._state.violations || 0;

    if (currentCount < MAX_VIOLATIONS - 1) {
      // 第1次或第2次违规：弹窗警告
      const remaining = MAX_VIOLATIONS - currentCount - 1;
      const result = await this.reportViolation(type);

      if (this._window && !this._window.isDestroyed()) {
        await dialog.showMessageBox(this._window, {
          type: "warning",
          title: "功能未解锁",
          message: "未解锁高级网络功能",
          detail: `SSH 远程连接和外网转发功能需要授权码才能使用。\n\n这是第 ${result.violations} 次违规尝试，还剩 ${Math.max(0, MAX_VIOLATIONS - result.violations)} 次机会后软件将被锁定。\n\n请获取授权码以解锁全部功能。`,
          buttons: ["我知道了"],
          defaultId: 0
        });
      }
      return true; // 阻止操作
    } else {
      // 第3次违规：终止进程
      await this.reportViolation(type);
      if (this._window && !this._window.isDestroyed()) {
        await dialog.showMessageBox(this._window, {
          type: "error",
          title: "违规次数已满",
          message: "软件即将关闭",
          detail: "您已多次尝试使用未授权的高级功能，软件即将关闭。\n下次启动时将需要输入有效授权码才能继续使用。",
          buttons: ["确定"],
          defaultId: 0
        });
      }
      app.quit();
      return true; // 永远阻止
    }
  }

  // ── 功能门控 ────────────────────────────────────────

  /**
   * 检查是否可以使用 SSH 功能
   * @returns {boolean} true=允许, false=拒绝
   */
  canUseSSH() {
    if (this.canUseAdvancedFeatures) return true;
    // 未授权时阻止
    this.enforceViolationPolicyAsync("force_ssh");
    return false;
  }

  /**
   * 检查是否可以使用外网转发功能
   * @returns {boolean} true=允许, false=拒绝
   */
  canUseExternalNetwork() {
    if (this.canUseAdvancedFeatures) return true;
    this.enforceViolationPolicyAsync("force_external");
    return false;
  }

  /**
   * 异步执行违规策略（不阻塞调用方）
   */
  enforceViolationPolicyAsync(type) {
    this.enforceViolationPolicy(type).catch((error) => {
      writeLog("auth_violation_enforce_error", { error: error.message });
    });
  }

  /**
   * 检查是否可以使用云端AI功能（始终允许）
   */
  canUseCloudAI() {
    return true; // 云端AI始终开放
  }

  // ── 启动检查 ────────────────────────────────────────

  /**
   * 启动时检查授权状态
   * @returns {Promise<'ok'|'locked'|'expired'|'unauthorized'|'error'>}
   */
  async startupCheck() {
    // 反调试检测 — 检测到调试器时静默返回未授权
    if (this._antiDebugCheck()) {
      writeLog("auth_startup_debugger_detected");
      return "unauthorized";
    }

    // 先检查本地是否被锁定
    if (this.isLocked) {
      // 检查后端是否仍然锁定（可能管理员已解锁）
      const remoteCheck = await this.checkAuthFromServer();
      if (remoteCheck.locked) {
        writeLog("auth_startup_locked", { violations: this._state.violations });
        return "locked";
      }
      // 后端已解锁
      if (remoteCheck.authorized) {
        this._state.violations = 0;
        this._state.authorized = true;
        writeLocalState(this._state);
        return "ok";
      }
    }

    // 检查本地授权是否过期
    if (this._state.authorized && this._state.expiresAt) {
      if (Date.now() > this._state.expiresAt) {
        // 本地授权过期，检查后端
        const remoteCheck = await this.checkAuthFromServer();
        if (remoteCheck.authorized) {
          return "ok";
        }
        writeLog("auth_startup_expired");
        return "expired";
      }
      // 授权仍在有效期内，后端确认
      await this.checkAuthFromServer();
      return "ok";
    }

    // 未授权
    if (!this._state.authorized) {
      const remoteCheck = await this.checkAuthFromServer();
      if (remoteCheck.authorized) {
        return "ok";
      }
      return "unauthorized";
    }

    return "ok";
  }

  /**
   * 启动定期检查
   */
  startPeriodicCheck() {
    if (this._checkTimer) clearInterval(this._checkTimer);
    this._checkTimer = setInterval(() => {
      this.checkAuthFromServer().catch((error) => {
        writeLog("auth_periodic_check_error", { error: error.message });
      });
    }, CHECK_INTERVAL_MS);
    writeLog("auth_periodic_check_started", { intervalMs: CHECK_INTERVAL_MS });
  }

  /**
   * 停止定期检查
   */
  stopPeriodicCheck() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  // ── 工具 ────────────────────────────────────────────

  /** 获取授权状态摘要（供渲染进程使用） */
  getStatus() {
    return {
      authorized: this.isAuthorized,
      locked: this.isLocked,
      violations: this._state.violations || 0,
      expiresAt: this._state.expiresAt,
      deviceId: this.deviceId,
      canUseSSH: this.canUseAdvancedFeatures,
      canUseExternalNetwork: this.canUseAdvancedFeatures,
      canUseCloudAI: true
    };
  }
}

module.exports = { AuthManager, AUTH_SERVER_URL };