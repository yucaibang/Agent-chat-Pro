"use strict";

/**
 * Transport 抽象基类 — 所有网络传输插件的统一接口。
 *
 * 每种网络方案（SSH直连/FRP/DERP/P2P/N2N）实现此接口，
 * NetworkManager 根据当前配置选取对应 Transport 实例。
 *
 * 生命周期：connect() → [exec()/ping()]* → disconnect()
 * 状态：offline → connecting → connected → disconnecting → offline
 */
class Transport {
  /** @param {string} type 传输类型标识，如 "ssh-direct"、"frp-tunnel" */
  constructor(type) {
    /** @type {string} 传输类型 */
    this.type = type;
    /** @type {string} 连接状态：offline / connecting / connected / disconnecting / error */
    this.state = "offline";
    /** @type {{ latencyMs: number, jitter: number, mode: string }|null} 最近一次 ping 结果 */
    this.lastPing = null;
    /** @type {Function[]} 状态变化回调 */
    this._statusCallbacks = [];
    /** @type {object|null} 连接配置（子类在 connect 时赋值） */
    this.config = null;
  }

  // ── 子类必须实现 ────────────────────────────────

  /**
   * 建立连接。
   * @param {object} config - 连接配置（含 host/port/username 等通用字段 + 子类特有字段）
   * @param {Function} onUnknownHost - SSH 主机指纹确认回调
   * @param {Function} onLog - 日志回调
   * @returns {Promise<void>}
   */
  async connect(config, onUnknownHost, onLog) {
    throw new Error(`${this.type}: connect() 未实现`);
  }

  /** 断开连接。 @returns {Promise<void>} */
  async disconnect() {
    throw new Error(`${this.type}: disconnect() 未实现`);
  }

  /**
   * 在远端执行命令，返回 {code, stdout, stderr}。
   * @param {string} command
   * @param {object} [options]
   * @returns {Promise<{code: number, stdout: string, stderr: string}>}
   */
  async exec(command, options) {
    throw new Error(`${this.type}: exec() 未实现`);
  }

  /**
   * 检测连接延迟。返回 {latencyMs, jitter, mode}。
   * @returns {Promise<{latencyMs: number, jitter: number, mode: string}>}
   */
  async ping() {
    throw new Error(`${this.type}: ping() 未实现`);
  }

  /**
   * 获取当前连接状态详情。
   * @returns {{state: string, mode: string, type: string, latencyMs: number|null, detail: string}}
   */
  getStatus() {
    return {
      state: this.state,
      mode: this._modeLabel(),
      type: this.type,
      latencyMs: this.lastPing?.latencyMs ?? null,
      detail: this._stateDetail()
    };
  }

  // ── 通用方法 ────────────────────────────────────

  /** 注册状态变化回调。 @param {Function} callback @returns {Function} 取消注册函数 */
  onStatusChange(callback) {
    this._statusCallbacks.push(callback);
    return () => { this._statusCallbacks = this._statusCallbacks.filter((cb) => cb !== callback); };
  }

  /** 通知状态变化。 @param {string} newState @param {object} [detail] */
  _setState(newState, detail) {
    const previous = this.state;
    this.state = newState;
    const event = { previous, current: newState, type: this.type, detail: detail || "", timestamp: Date.now() };
    for (const callback of this._statusCallbacks) {
      try { callback(event); } catch { /* 避免回调异常中断 */ }
    }
  }

  /** 子类可覆盖：返回模式描述文字。 */
  _modeLabel() {
    return this.type;
  }

  /** 子类可覆盖：返回状态详情文字。 */
  _stateDetail() {
    const labels = {
      offline: "未连接", connecting: "正在连接…", connected: "已连接",
      disconnecting: "正在断开…", error: "连接异常"
    };
    return labels[this.state] || this.state;
  }
}

module.exports = { Transport };