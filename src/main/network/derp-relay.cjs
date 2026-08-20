"use strict";

const { Client } = require("ssh2");
const net = require("net");
const { Transport } = require("./transport-base.cjs");

/**
 * DERP 中继 Transport — 通过 DERP 中继服务器转发 SSH 连接到 NAS。
 *
 * 工作原理：
 * 1. 客户端连接到 DERP 中继服务器的 TCP 端口
 * 2. DERP 服务器将连接转发给已注册的 NAS
 * 3. SSH 会话通过中继隧道进行
 *
 * DERP 中继服务器需要单独部署（如 tailscale/derp），
 * 或使用兼容的 TCP 中继服务。
 */
class DerpRelayTransport extends Transport {
  constructor() {
    super("derp-relay");
    /** @type {Client|null} */
    this._client = null;
    /** @type {net.Socket|null} */
    this._relaySocket = null;
    this._hostFingerprint = "";
    this._onUnknownHost = null;
    this._onLog = null;
  }

  async connect(config, onUnknownHost, onLog) {
    if (this.state === "connected") return;
    this.config = config;
    this._onUnknownHost = onUnknownHost;
    this._onLog = onLog;

    const derp = config.derp || {};
    const relayAddr = String(derp.relayAddr || "").trim();
    const relayPort = Number(derp.relayPort) || 3478;

    if (!relayAddr) {
      const error = new Error("DERP 中继服务器地址未配置，请在网络设置中填写。");
      this._setState("error", error.message);
      throw error;
    }

    this._setState("connecting", `DERP 中继连接 ${relayAddr}:${relayPort}…`);
    onLog?.("derp_relay_connect_start", { relayAddr, relayPort });

    try {
      // Step 1: 建立 TCP 连接到 DERP 中继服务器
      this._relaySocket = await this._createRelayConnection(relayAddr, relayPort, onLog);
      onLog?.("derp_relay_tunnel_established", { relayAddr, relayPort });

      // Step 2: 通过中继隧道建立 SSH 连接
      this._client = await this._createSshOverRelay(config, onUnknownHost, onLog);
      this._hostFingerprint = config.hostFingerprint || "";
      this._setState("connected", `DERP 中继已连接 ${relayAddr}:${relayPort}`);
      onLog?.("derp_relay_connected", { relayAddr, relayPort });
    } catch (error) {
      this._cleanup();
      this._setState("error", `DERP 中继连接失败：${this._friendlyError(error)}`);
      onLog?.("derp_relay_connect_failed", { relayAddr, relayPort, error: error.message });
      throw error;
    }
  }

  async disconnect() {
    if (this.state === "offline") return;
    this._setState("disconnecting");
    this._cleanup();
    this._setState("offline", "已断开");
  }

  async exec(command, options) {
    this._requireConnected();
    return this._execOnClient(this._client, command, options?.pty ?? false);
  }

  async ping() {
    this._requireConnected();
    const start = Date.now();
    try {
      const result = await this._execOnClient(this._client, "printf OK", false);
      const latency = Date.now() - start;
      const jitter = this.lastPing ? Math.abs(latency - this.lastPing.latencyMs) : 0;
      this.lastPing = { latencyMs: latency, jitter, mode: this.type };
      this._onLog?.("derp_relay_ping", { latencyMs: latency, jitter });
      return this.lastPing;
    } catch (error) {
      this._onLog?.("derp_relay_ping_failed", { error: error.message });
      throw error;
    }
  }

  // ── 内部方法 ──────────────────────────────────────

  _requireConnected() {
    if (this.state !== "connected" || !this._client) {
      throw new Error("DERP 中继连接未建立，请先连接。");
    }
  }

  _createRelayConnection(relayAddr, relayPort, onLog) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("DERP 中继连接超时，请检查中继服务器地址和端口。"));
      }, 20_000);

      const socket = net.createConnection({ host: relayAddr, port: relayPort }, () => {
        clearTimeout(timeout);
        onLog?.("derp_relay_tcp_connected", { relayAddr, relayPort });
        resolve(socket);
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`DERP 中继 TCP 连接失败：${error.message}`));
      });

      socket.setKeepAlive(true, 30_000);
      socket.setNoDelay(true);
    });
  }

  _createSshOverRelay(config, onUnknownHost, onLog) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error("DERP 中继 SSH 握手超时。"));
      }, 30_000);

      client.once("ready", () => {
        clearTimeout(timeout);
        resolve(client);
      });

      client.once("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(this._friendlyError(error)));
      });

      // 通过中继 socket 建立 SSH 连接
      client.connect({
        sock: this._relaySocket,
        username: config.username,
        password: config.password,
        readyTimeout: 30_000,
        hostHash: "sha256",
        hostVerifier: (key) => {
          const fingerprint = `SHA256:${Buffer.from(key, "hex").toString("base64").replace(/=+$/, "")}`;
          if (config.hostFingerprint) {
            return config.hostFingerprint === fingerprint;
          }
          const trusted = onUnknownHost?.(fingerprint) === true;
          if (trusted) {
            this._hostFingerprint = fingerprint;
            config.hostFingerprint = fingerprint;
          }
          return trusted;
        }
      });
    });
  }

  _execOnClient(client, command, pty) {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      client.exec(command, { pty }, (error, stream) => {
        if (error) return reject(error);
        stream.on("data", (data) => { stdout += data.toString("utf8"); });
        stream.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
        stream.on("error", reject);
        stream.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    });
  }

  _cleanup() {
    try { this._client?.end(); } catch { /* 忽略 */ }
    try { this._relaySocket?.destroy(); } catch { /* 忽略 */ }
    this._client = null;
    this._relaySocket = null;
  }

  _friendlyError(error) {
    const msg = String(error?.message || error);
    if (/authentication|密码|账号/i.test(msg)) return "SSH 账号或密码不正确。";
    if (/ECONNREFUSED/i.test(msg)) return "DERP 中继端口被拒绝，请检查中继服务器配置。";
    if (/ETIMEDOUT|超时/i.test(msg)) return "DERP 中继连接超时，请检查中继服务器是否在线。";
    if (/ENOTFOUND/i.test(msg)) return "DERP 中继域名解析失败，请检查服务器地址。";
    if (/EHOSTUNREACH/i.test(msg)) return "DERP 中继服务器不可达。";
    if (/PROTOCOL|handshake/i.test(msg)) return "SSH 协议握手失败，中继可能未正确转发。";
    return msg;
  }

  _modeLabel() { return "DERP 中继"; }
}

module.exports = { DerpRelayTransport };