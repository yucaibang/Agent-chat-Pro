"use strict";

const { SshDirectTransport } = require("./ssh-direct.cjs");
const { writeLog } = require("../logger.cjs");

/**
 * 网络管理器 — 统一调度所有传输方式。
 *
 * 职责：
 * 1. 根据配置选择传输方式（内网SSH直连 / 外网FRP/DERP/P2P/N2N）
 * 2. 自动降级：P2P → DERP → FRP（外网模式下）
 * 3. 心跳保活 + 延迟监控
 * 4. 对外暴露统一的状态和事件
 *
 * Chat 层只通过 NetworkManager 获取 transport，
 * 不需要知道底层是哪种连接方式。
 */

/** 连接状态机 */
const STATES = {
  OFFLINE: "offline",
  PROBING: "probing",
  CONNECTED: "connected",
  DEGRADED: "degraded",
  RECONNECTING: "reconnecting",
  FAILED: "failed"
};

/** 降级优先级（外网模式） */
const FALLBACK_ORDER = ["p2p-nat", "derp-relay", "frp-tunnel"];

/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 心跳连续失败判定断线的阈值 */
const HEARTBEAT_FAIL_THRESHOLD = 3;
/** 每次降级后等待连接的毫秒数 */
const FALLBACK_WAIT_MS = 5_000;

class NetworkManager {
  constructor() {
    /** @type {string} 状态 */
    this.state = STATES.OFFLINE;
    /** @type {Transport|null} 当前活跃的传输实例 */
    this.transport = null;
    /** @type {object} 网络配置 */
    this.config = null;
    /** @type {Function[]} 状态变化监听器 */
    this._listeners = [];
    /** @type {NodeJS.Timer|null} 心跳定时器 */
    this._heartbeatTimer = null;
    /** @type {number} 心跳连续失败次数 */
    this._heartbeatFailCount = 0;
    /** @type {string|null} 当前尝试的传输类型（用于降级链） */
    this._currentAttempt = null;
    /** @type {number} 降级链中当前索引 */
    this._fallbackIndex = -1;
    /** @type {boolean} 心跳是否正在运行 */
    this._heartbeatRunning = false;
    /** @type {{latencyMs: number, mode: string, timestamp: number}[]} 最近延迟记录 */
    this.latencyHistory = [];
  }

  // ── 公共 API ─────────────────────────────────────

  /**
   * 根据配置连接。
   * @param {object} config - 网络配置
   * @param {object} config.connectionType - "internal" | "external"
   * @param {string} config.externalMethod - "auto" | "derp" | "frp" | "p2p" | "n2n"
   * @param {Function} onUnknownHost - SSH 主机指纹回调
   * @param {Function} onLog - 日志回调
   */
  async connect(config, onUnknownHost, onLog) {
    if (this.state === STATES.CONNECTED || this.state === STATES.DEGRADED) {
      await this.disconnect();
    }
    this.config = config;
    this._onLog = onLog || writeLog;
    this._onUnknownHost = onUnknownHost;

    if (config.networkType === "internal") {
      return this._connectDirect(onUnknownHost, onLog);
    }
    return this._connectExternal(config, onUnknownHost, onLog);
  }

  /** 断开当前连接。 */
  async disconnect() {
    this._stopHeartbeat();
    if (this.transport) {
      try { await this.transport.disconnect(); } catch { /* 忽略 */ }
      this.transport = null;
    }
    this._setState(STATES.OFFLINE, "已断开");
  }

  /**
   * 获取当前传输实例。如未连接则抛出错误。
   * @returns {Transport}
   */
  getTransport() {
    if (!this.transport || (this.state !== STATES.CONNECTED && this.state !== STATES.DEGRADED)) {
      throw new Error("网络未连接，请先配置并测试连接。");
    }
    return this.transport;
  }

  /** 获取当前连接状态摘要。 */
  getStatus() {
    const transportStatus = this.transport?.getStatus() || { state: this.state, mode: "未连接", type: "none", latencyMs: null, detail: "" };
    return {
      ...transportStatus,
      networkType: this.config?.networkType || "internal",
      externalMethod: this.config?.externalMethod || "direct",
      state: this.state,
      latencyHistory: this.latencyHistory.slice(-10)
    };
  }

  /** 注册状态变化监听器。 @returns {Function} 取消注册 */
  onStatusChange(callback) {
    this._listeners.push(callback);
    return () => { this._listeners = this._listeners.filter((cb) => cb !== callback); };
  }

  // ── 内网直连 ─────────────────────────────────────

  async _connectDirect(onUnknownHost, onLog) {
    this._setState(STATES.PROBING, "SSH 直连中…");
    this._currentAttempt = "ssh-direct";
    const transport = new SshDirectTransport();
    try {
      await transport.connect(this.config, onUnknownHost, onLog);
      this.transport = transport;
      this._setState(STATES.CONNECTED, `SSH 直连 ${this.config.host}:${this.config.port}`);
      this._startHeartbeat();
      return transport;
    } catch (error) {
      this._setState(STATES.FAILED, `SSH 直连失败：${this._userFriendlyError(error)}`);
      throw error;
    }
  }

  // ── 外网模式（带降级链） ─────────────────────────

  async _connectExternal(config, onUnknownHost, onLog) {
    const method = config.externalMethod || "auto";
    const attempts = method === "auto"
      ? FALLBACK_ORDER
      : [method];

    this._setState(STATES.PROBING, `外网模式：正在尝试 ${this._methodLabel(attempts[0])}…`);
    this._fallbackIndex = 0;

    for (let i = 0; i < attempts.length; i++) {
      const transportType = attempts[i];
      this._currentAttempt = transportType;
      this._fallbackIndex = i;

      this._onLog("network_fallback_attempt", {
        method: transportType,
        attempt: i + 1,
        total: attempts.length
      });

      try {
        const transport = this._createTransport(transportType);
        await transport.connect(config, onUnknownHost, onLog);

        this.transport = transport;
        const label = this._methodLabel(transportType);
        const state = i === 0 ? STATES.CONNECTED : STATES.DEGRADED;
        this._setState(state, `${label}已连接（延迟 ${transport.lastPing?.latencyMs ?? "?"}ms）`);
        this._startHeartbeat();
        return transport;
      } catch (error) {
        this._onLog("network_fallback_failed", {
          method: transportType,
          attempt: i + 1,
          error: error.message
        });

        if (i < attempts.length - 1) {
          this._setState(STATES.PROBING, `${this._methodLabel(transportType)}失败，正在降级尝试 ${this._methodLabel(attempts[i + 1])}…`);
          await new Promise((resolve) => setTimeout(resolve, FALLBACK_WAIT_MS));
        } else {
          this._setState(STATES.FAILED, `所有连接方式均失败：${this._userFriendlyError(error)}`);
          throw error;
        }
      }
    }
  }

  /** 创建指定类型的 Transport 实例。 */
  _createTransport(type) {
    switch (type) {
      case "ssh-direct": return new SshDirectTransport();
      // P2-P/DERP/FRP/N2N 将在后续任务中实现，目前 fallback 到 SSH 直连
      case "p2p-nat":
      case "derp-relay":
      case "frp-tunnel":
      case "n2n-mesh":
        throw new Error(`${this._methodLabel(type)} 尚未实现，请暂时使用 SSH 直连。`);
      default: throw new Error(`未知的传输类型：${type}`);
    }
  }

  // ── 心跳保活 ─────────────────────────────────────

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatFailCount = 0;
    this._heartbeatRunning = true;
    this._heartbeatTimer = setInterval(() => this._doHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this._heartbeatTimer.unref?.();
  }

  _stopHeartbeat() {
    this._heartbeatRunning = false;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async _doHeartbeat() {
    if (!this._heartbeatRunning || !this.transport) return;
    try {
      const result = await this.transport.ping();
      this._heartbeatFailCount = 0;
      this.latencyHistory.push({ latencyMs: result.latencyMs, mode: result.mode, timestamp: Date.now() });
      if (this.latencyHistory.length > 20) this.latencyHistory.shift();
      this._onLog("network_heartbeat_ok", { latencyMs: result.latencyMs, mode: result.mode });
    } catch (error) {
      this._heartbeatFailCount++;
      this._onLog("network_heartbeat_fail", { failCount: this._heartbeatFailCount, error: error.message });
      if (this._heartbeatFailCount >= HEARTBEAT_FAIL_THRESHOLD) {
        this._onLog("network_heartbeat_threshold_exceeded", { failCount: this._heartbeatFailCount });
        this._handleConnectionLost("心跳连续失败，连接可能已断开");
      }
    }
  }

  async _handleConnectionLost(reason) {
    this._stopHeartbeat();
    this._setState(STATES.RECONNECTING, reason);
    this._onLog("network_connection_lost", { reason });

    // 如果是外网模式且有降级空间，尝试降级
    if (this.config?.networkType === "external" && this._fallbackIndex >= 0) {
      const nextMethods = FALLBACK_ORDER.slice(this._fallbackIndex + 1);
      if (nextMethods.length > 0) {
        this._setState(STATES.RECONNECTING, `正在降级到 ${this._methodLabel(nextMethods[0])}…`);
        try {
          await this._connectExternal({ ...this.config, externalMethod: "auto" }, this._onUnknownHost, this._onLog);
        } catch { /* 降级也失败，保持 RECONNECTING 状态 */ }
        return;
      }
    }

    // 内网模式或无降级空间，尝试重连同一种传输
    try {
      if (this.transport) await this.transport.disconnect();
      const newTransport = this._createTransport(this._currentAttempt || "ssh-direct");
      await newTransport.connect(this.config, this._onUnknownHost, this._onLog);
      this.transport = newTransport;
      this._setState(STATES.CONNECTED, "重连成功");
      this._startHeartbeat();
    } catch (error) {
      this._setState(STATES.FAILED, `重连失败：${this._userFriendlyError(error)}`);
    }
  }

  // ── 工具方法 ──────────────────────────────────────

  _setState(newState, detail) {
    const previous = this.state;
    this.state = newState;
    const event = { previous, current: newState, detail, timestamp: Date.now() };
    for (const callback of this._listeners) {
      try { callback(event); } catch { /* 避免回调异常 */ }
    }
  }

  _methodLabel(type) {
    const labels = {
      "ssh-direct": "SSH 直连",
      "p2p-nat": "P2P 打洞",
      "derp-relay": "DERP 中继",
      "frp-tunnel": "FRP 穿透",
      "n2n-mesh": "N2N 虚拟局域网"
    };
    return labels[type] || type;
  }

  _userFriendlyError(error) {
    const msg = String(error?.message || error);
    if (/authentication|密码|账号/i.test(msg)) return "SSH 账号或密码不正确";
    if (/ECONNREFUSED/i.test(msg)) return "连接被拒绝，请检查目标地址和端口";
    if (/ETIMEDOUT|超时/i.test(msg)) return "连接超时，请检查网络和目标服务器是否在线";
    if (/ENOTFOUND/i.test(msg)) return "域名解析失败，请检查地址是否正确";
    if (/EHOSTUNREACH/i.test(msg)) return "目标主机不可达，请检查网络连接";
    if (/PROTOCOL|handshake/i.test(msg)) return "SSH 协议握手失败，请检查端口是否正确";
    return msg;
  }
}

module.exports = { NetworkManager, STATES, FALLBACK_ORDER };