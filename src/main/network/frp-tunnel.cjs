"use strict";

const { Client } = require("ssh2");
const { Transport } = require("./transport-base.cjs");

/**
 * FRP 穿透 Transport — 通过 FRP 服务器暴露的端口 SSH 到 NAS。
 *
 * 前提：NAS 端已运行 frpc，将 SSH 端口映射到 FRP 服务器的 remotePort。
 * 客户端只需 SSH 到 frp.serverAddr:frp.remotePort 即可。
 */
class FrpTunnelTransport extends Transport {
  constructor() {
    super("frp-tunnel");
    /** @type {Client|null} */
    this._client = null;
    this._hostFingerprint = "";
    this._onUnknownHost = null;
    this._onLog = null;
  }

  async connect(config, onUnknownHost, onLog) {
    if (this.state === "connected") return;
    this.config = config;
    this._onUnknownHost = onUnknownHost;
    this._onLog = onLog;

    const frp = config.frp || {};
    const host = String(frp.serverAddr || "").trim();
    const port = Number(frp.remotePort) || 6000;

    if (!host) {
      const error = new Error("FRP 服务器地址未配置，请在网络设置中填写。");
      this._setState("error", error.message);
      throw error;
    }

    this._setState("connecting", `FRP 穿透连接 ${host}:${port}…`);
    onLog?.("frp_tunnel_connect_start", { host, port });

    try {
      this._client = await this._createSshConnection({
        host,
        port,
        username: config.username,
        password: config.password,
        readyTimeout: 30_000,
        hostHash: "sha256",
        hostVerifier: (key) => {
          const fingerprint = `SHA256:${Buffer.from(key, "hex").toString("base64").replace(/=+$/, "")}`;
          if (config.hostFingerprint) {
            const matches = config.hostFingerprint === fingerprint;
            onLog?.("frp_host_fingerprint", { fingerprint, matches, previouslyTrusted: true });
            return matches;
          }
          const trusted = onUnknownHost?.(fingerprint) === true;
          onLog?.("frp_host_fingerprint", { fingerprint, trusted, previouslyTrusted: false });
          if (trusted) {
            this._hostFingerprint = fingerprint;
            config.hostFingerprint = fingerprint;
          }
          return trusted;
        }
      }, onLog, "FRP 穿透");
      this._setState("connected", `FRP 穿透已连接 ${host}:${port}`);
      onLog?.("frp_tunnel_connected", { host, port });
    } catch (error) {
      this._setState("error", `FRP 穿透连接失败：${this._friendlyError(error)}`);
      onLog?.("frp_tunnel_connect_failed", { host, port, error: error.message });
      throw error;
    }
  }

  async disconnect() {
    if (this.state === "offline") return;
    this._setState("disconnecting");
    try { this._client?.end(); } catch { /* 忽略断开错误 */ }
    this._client = null;
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
      this._onLog?.("frp_tunnel_ping", { latencyMs: latency, jitter });
      return this.lastPing;
    } catch (error) {
      this._onLog?.("frp_tunnel_ping_failed", { error: error.message });
      throw error;
    }
  }

  // ── 内部方法 ──────────────────────────────────────

  _requireConnected() {
    if (this.state !== "connected" || !this._client) {
      throw new Error("FRP 穿透连接未建立，请先连接。");
    }
  }

  _createSshConnection(options, onLog, label) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error(`${label}连接超时，请检查 FRP 隧道是否正常。`));
      }, options.readyTimeout || 30_000);

      client.once("ready", () => {
        clearTimeout(timeout);
        resolve(client);
      });

      client.once("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(this._friendlyError(error)));
      });

      client.connect(options);
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

  _friendlyError(error) {
    const msg = String(error?.message || error);
    if (/authentication|密码|账号/i.test(msg)) return "SSH 账号或密码不正确，请检查连接设置。";
    if (/ECONNREFUSED/i.test(msg)) return "FRP 隧道端口被拒绝，请检查 FRP 服务器和端口配置。";
    if (/ETIMEDOUT|超时/i.test(msg)) return "FRP 隧道连接超时，请检查 FRP 服务器是否在线、隧道是否正常。";
    if (/ENOTFOUND/i.test(msg)) return "FRP 服务器域名解析失败，请检查服务器地址。";
    if (/EHOSTUNREACH/i.test(msg)) return "FRP 服务器不可达，请检查网络连接。";
    if (/PROTOCOL|handshake/i.test(msg)) return "SSH 协议握手失败，可能是 FRP 隧道未映射到 SSH 端口。";
    return msg;
  }

  _modeLabel() { return "FRP 穿透"; }
}

module.exports = { FrpTunnelTransport };