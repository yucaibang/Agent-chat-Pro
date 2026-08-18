"use strict";

const { Client } = require("ssh2");
const { Transport } = require("./transport-base.cjs");
const { shellQuote } = require("../protocol.cjs");

const PING_COMMAND = "printf OK";
const PING_TIMEOUT_MS = 8_000;

/**
 * SSH 直连 Transport — 内网模式。
 * 通过 TCP 直连 NAS/服务器的 SSH 端口，是最低延迟、最稳定的传输方式。
 */
class SshDirectTransport extends Transport {
  constructor() {
    super("ssh-direct");
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
    this._setState("connecting", `SSH 直连 ${config.host}:${config.port}`);
    onLog?.("ssh_direct_connect_start", { host: config.host, port: config.port });

    try {
      this._client = await this._createConnection(config, onUnknownHost, onLog);
      this._hostFingerprint = config.hostFingerprint || "";
      this._setState("connected", `SSH 直连 ${config.host}:${config.port}`);
      onLog?.("ssh_direct_connected", { host: config.host, port: config.port });
    } catch (error) {
      this._setState("error", `SSH 连接失败：${error.message}`);
      onLog?.("ssh_direct_connect_failed", { host: config.host, port: config.port, error: error.message });
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
      const result = await this._execOnClient(this._client, PING_COMMAND, false);
      const latency = Date.now() - start;
      const jitter = this.lastPing ? Math.abs(latency - this.lastPing.latencyMs) : 0;
      this.lastPing = { latencyMs: latency, jitter, mode: this.type };
      this._onLog?.("ssh_direct_ping", { latencyMs: latency, jitter });
      return this.lastPing;
    } catch (error) {
      this._onLog?.("ssh_direct_ping_failed", { error: error.message });
      throw error;
    }
  }

  getClient() {
    this._requireConnected();
    return this._client;
  }

  getHostFingerprint() {
    return this._hostFingerprint;
  }

  // ── 内部方法 ──────────────────────────────────────

  _requireConnected() {
    if (this.state !== "connected" || !this._client) {
      throw new Error("SSH 连接未建立，请先连接。");
    }
  }

  _createConnection(config, onUnknownHost, onLog) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error("SSH 连接超时，请检查地址、端口和服务器是否在线。"));
      }, 15_000);

      client.once("ready", () => {
        clearTimeout(timeout);
        resolve(client);
      });

      client.once("error", (error) => {
        clearTimeout(timeout);
        const message = error.message === "All configured authentication methods failed"
          ? "SSH 账号或密码不正确，请在连接设置中重新填写。"
          : `SSH 连接失败：${error.message}`;
        reject(new Error(message));
      });

      client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        readyTimeout: 15_000,
        hostHash: "sha256",
        hostVerifier: (key) => {
          const fingerprint = `SHA256:${Buffer.from(key, "hex").toString("base64").replace(/=+$/, "")}`;
          if (config.hostFingerprint) {
            const matches = config.hostFingerprint === fingerprint;
            onLog?.("ssh_host_fingerprint", { fingerprint, matches, previouslyTrusted: true });
            return matches;
          }
          const trusted = onUnknownHost?.(fingerprint) === true;
          onLog?.("ssh_host_fingerprint", { fingerprint, trusted, previouslyTrusted: false });
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
}

module.exports = { SshDirectTransport };