"use strict";

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const os = require("os");
const { writeLog } = require("./logger.cjs");

// 云端品牌服务器地址（可通过 settings 配置，默认为空即禁用品牌验证）
const DEFAULT_BRAND_SERVER_URL = "";
const BRAND_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5分钟
const REQUEST_TIMEOUT_MS = 10 * 1000; // 10秒超时

class CloudBrandManager {
  constructor() {
    this._deviceId = "";
    this._brandConfig = null;     // 云端品牌配置
    this._verified = false;       // 是否通过云端验证
    this._overrideToken = null;   // 管理员覆盖令牌
    this._overrideExpiry = 0;     // 覆盖令牌过期时间
    this._checkTimer = null;
    this._window = null;
    this._appVersion = "";
    this._brandHash = "";         // 本地品牌哈希
    this._brandServerUrl = "";    // 品牌服务器地址（从 settings 读取）
  }

  /** 设置品牌服务器地址（由 main.cjs 从 settings 注入） */
  setBrandServerUrl(url) {
    this._brandServerUrl = String(url || "").trim();
  }

  // ─── 初始化 ───

  /** 初始化：计算设备ID和品牌哈希 */
  initialize() {
    this._computeDeviceId();
    this._brandHash = this._computeBrandHash();
    writeLog("cloud_brand_init", {
      deviceId: this._deviceId,
      brandHash: this._brandHash,
      appVersion: this._appVersion
    });
  }

  /** 计算设备ID（os.hostname + os.userInfo().username + process.platform → SHA256） */
  _computeDeviceId() {
    const raw = [
      os.hostname(),
      os.userInfo().username,
      process.platform
    ].join("|");
    this._deviceId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
  }

  /** 计算本地品牌哈希（appName + appSubtitle + version 拼接 → SHA256 hex） */
  _computeBrandHash() {
    const appName = "Agent Chat Pro";
    const appSubtitle = "三模式 AI 聊天客户端";
    const raw = appName + appSubtitle + this._appVersion;
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  // ─── 属性设置 ───

  /** 设置主窗口引用 */
  setWindow(win) { this._window = win; }

  /** 设置应用版本 */
  setAppVersion(version) {
    this._appVersion = version;
    // 版本变更时重新计算品牌哈希
    this._brandHash = this._computeBrandHash();
  }

  // ─── HTTP 请求封装 ───

  /**
   * HTTP 请求封装（复用 auth-manager 模式）
   * @param {string} method - HTTP 方法
   * @param {string} urlPath - 请求路径（如 /api/brand/config）
   * @param {object|null} body - 请求体（POST/PUT 时使用）
   * @returns {Promise<{status, data}>}
   */
  _request(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
      try {
        const serverUrl = this._brandServerUrl || DEFAULT_BRAND_SERVER_URL;
        if (!serverUrl) {
          // 品牌服务器未配置，直接标记为离线降级
          reject(new Error("品牌服务器未配置，使用本地默认品牌。"));
          return;
        }
        const fullUrl = serverUrl.replace(/\/+$/, "") + urlPath;
        const parsed = new URL(fullUrl);
        const isHttps = parsed.protocol === "https:";
        const client = isHttps ? https : http;

        const options = {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: method.toUpperCase(),
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          }
        };

        const bodyStr = body ? JSON.stringify(body) : null;
        if (bodyStr) {
          options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
        }

        const req = client.request(options, (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            let parsedData;
            try {
              parsedData = data ? JSON.parse(data) : {};
            } catch {
              parsedData = { raw: data };
            }
            resolve({ status: res.statusCode, data: parsedData });
          });
        });

        req.on("error", (err) => {
          writeLog("cloud_brand_request_error", { urlPath, error: err.message });
          reject(err);
        });

        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
          req.destroy();
          reject(new Error(`品牌服务器请求超时: ${urlPath}`));
        });

        if (bodyStr) req.write(bodyStr);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  // ─── 云端交互 ───

  /** 获取云端品牌配置 */
  async fetchBrandConfig() {
    try {
      writeLog("cloud_brand_fetch_config", { deviceId: this._deviceId });
      const res = await this._request("GET", "/api/brand/config");

      if (res.status === 200 && res.data) {
        this._brandConfig = res.data;
        writeLog("cloud_brand_config_ok", {
          appName: res.data.appName,
          appSubtitle: res.data.appSubtitle
        });
      } else {
        writeLog("cloud_brand_config_fallback", { status: res.status });
        // 服务器不可达或返回异常，使用本地默认配置
        this._brandConfig = null;
      }
    } catch (err) {
      writeLog("cloud_brand_config_error", { error: err.message });
      // 服务器不可达，使用本地默认配置
      this._brandConfig = null;
    }

    this._pushBrandConfig();
  }

  /** 验证品牌完整性 */
  async verifyBrand() {
    try {
      writeLog("cloud_brand_verify", {
        deviceId: this._deviceId,
        brandHash: this._brandHash
      });

      const res = await this._request("POST", "/api/brand/verify", {
        deviceId: this._deviceId,
        brandHash: this._brandHash,
        appVersion: this._appVersion
      });

      if (res.status === 200 && res.data) {
        this._verified = !!res.data.verified;
        writeLog("cloud_brand_verify_result", { verified: this._verified });
      } else {
        // 验证请求失败，标记为未验证
        this._verified = false;
        writeLog("cloud_brand_verify_fallback", { status: res.status });
      }
    } catch (err) {
      // 服务器不可达，标记为未验证
      this._verified = false;
      writeLog("cloud_brand_verify_error", { error: err.message });
    }

    this._pushVerificationStatus();
  }

  /** 管理员密码覆盖 */
  async adminOverride(adminPassword) {
    try {
      writeLog("cloud_brand_admin_override", { deviceId: this._deviceId });

      const res = await this._request("POST", "/api/brand/admin-override", {
        adminPassword,
        deviceId: this._deviceId
      });

      if (res.status === 200 && res.data) {
        this._overrideToken = res.data.overrideToken || null;
        this._overrideExpiry = res.data.overrideExpiry || 0;
        writeLog("cloud_brand_override_ok", {
          hasToken: !!this._overrideToken,
          expiry: this._overrideExpiry
        });
        this._pushVerificationStatus();
        return { success: true, message: res.data.message || "管理员覆盖成功" };
      } else {
        writeLog("cloud_brand_override_fail", { status: res.status });
        return { success: false, message: res.data?.message || "管理员密码验证失败" };
      }
    } catch (err) {
      writeLog("cloud_brand_override_error", { error: err.message });
      return { success: false, message: "无法连接品牌服务器" };
    }
  }

  /** 验证覆盖令牌 */
  async verifyOverride() {
    if (!this._overrideToken) {
      return { valid: false, reason: "无覆盖令牌" };
    }

    try {
      const res = await this._request("POST", "/api/brand/verify-override", {
        overrideToken: this._overrideToken,
        deviceId: this._deviceId
      });

      if (res.status === 200 && res.data) {
        const valid = !!res.data.valid;
        if (!valid) {
          // 令牌无效，清除本地覆盖
          this._overrideToken = null;
          this._overrideExpiry = 0;
        }
        this._pushVerificationStatus();
        return { valid, reason: res.data.reason || "" };
      } else {
        return { valid: false, reason: "服务器返回异常" };
      }
    } catch (err) {
      writeLog("cloud_brand_verify_override_error", { error: err.message });
      return { valid: false, reason: "无法连接品牌服务器" };
    }
  }

  // ─── 定期检查 ───

  /** 启动定期检查（每5分钟执行 fetchBrandConfig + verifyBrand） */
  startPeriodicCheck() {
    this.stopPeriodicCheck(); // 先清除旧定时器

    // 启动后立即执行一次
    this._runCheck();

    this._checkTimer = setInterval(() => {
      this._runCheck();
    }, BRAND_CHECK_INTERVAL_MS);

    writeLog("cloud_brand_periodic_started", { intervalMs: BRAND_CHECK_INTERVAL_MS });
  }

  /** 执行一次完整检查 */
  async _runCheck() {
    try {
      await this.fetchBrandConfig();
      await this.verifyBrand();

      // 如果有覆盖令牌，也验证一下
      if (this._overrideToken) {
        await this.verifyOverride();
      }
    } catch (err) {
      writeLog("cloud_brand_check_error", { error: err.message });
    }
  }

  /** 停止定期检查 */
  stopPeriodicCheck() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
      writeLog("cloud_brand_periodic_stopped");
    }
  }

  // ─── 推送到渲染进程 ───

  /** 推送品牌配置到渲染进程 */
  _pushBrandConfig() {
    if (!this._window || this._window.isDestroyed()) return;
    try {
      const config = this.getBrandConfig();
      this._window.webContents.send("brand:config", {
        appName: config.appName,
        appSubtitle: config.appSubtitle,
        appIcon: config.appIcon,
        version: config.version
      });
    } catch (err) {
      writeLog("cloud_brand_push_config_error", { error: err.message });
    }
  }

  /** 推送验证状态到渲染进程 */
  _pushVerificationStatus() {
    if (!this._window || this._window.isDestroyed()) return;
    try {
      this._window.webContents.send("brand:status", {
        verified: this._verified,
        hasOverride: !!(this._overrideToken && Date.now() < this._overrideExpiry),
        overrideExpiry: this._overrideExpiry
      });
    } catch (err) {
      writeLog("cloud_brand_push_status_error", { error: err.message });
    }
  }

  // ─── 公共接口 ───

  /**
   * 获取品牌配置（供渲染进程使用）
   * 云端配置优先，否则返回本地默认
   */
  getBrandConfig() {
    if (this._brandConfig && this._brandConfig.appName) {
      return {
        appName: this._brandConfig.appName,
        appSubtitle: this._brandConfig.appSubtitle || "",
        appIcon: this._brandConfig.appIcon || "🤖",
        version: this._appVersion
      };
    }
    return {
      appName: "Agent Chat Pro",
      appSubtitle: "三模式 AI 聊天客户端",
      appIcon: "🤖",
      version: this._appVersion
    };
  }

  /** 是否已验证（覆盖令牌有效也算通过） */
  get isVerified() {
    if (this._overrideToken && Date.now() < this._overrideExpiry) return true;
    return this._verified;
  }
}

module.exports = { CloudBrandManager, DEFAULT_BRAND_SERVER_URL };