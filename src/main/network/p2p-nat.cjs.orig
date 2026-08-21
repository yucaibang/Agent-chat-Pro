"use strict";

const { Client } = require("ssh2");
const net = require("net");
const dgram = require("dgram");
const { Transport } = require("./transport-base.cjs");

/**
 * P2P 打洞 Transport — 通过 STUN 发现公网端点后直接 P2P 连接到 NAS。
 *
 * 工作原理：
 * 1. 使用 STUN 服务器获取本机公网 IP 和端口
 * 2. 尝试直接连接 NAS 的公网端点（NAS 也需通过 STUN 注册）
 * 3. 如果直连成功，通过 P2P 隧道建立 SSH
 *
 * 纯 P2P 模式不需要中继服务器，但需要两端都能通过 STUN 获取公网端点，
 * 且至少一端的 NAT 类型允许打洞（锥形 NAT）。
 */
class P2pNatTransport extends Transport {
  constructor() {
    super("p2p-nat");
    /** @type {Client|null} */
    this._client = null;
    /** @type {net.Socket|null} */
    this._p2pSocket = null;
    this._hostFingerprint = "";
    this._onUnknownHost = null;
    this._onLog = null;
    this._publicEndpoint = null;
  }

  async connect(config, onUnknownHost, onLog) {
    if (this.state === "connected") return;
    this.config = config;
    this._onUnknownHost = onUnknownHost;
    this._onLog = onLog;

    const p2p = config.p2p || {};
    const stunAddr = String(p2p.stunAddr || "stun.l.google.com").trim();
    const stunPort = Number(p2p.stunPort) || 19302;
    // 目标 NAS 的公网端点（用户需要预先知道）
    const targetHost = config.host;
    const targetPort = Number(p2p.remotePort) || config.port || 22;

    if (!targetHost) {
      const error = new Error("P2P 模式需要配置目标 NAS 的公网地址。");
      this._setState("error", error.message);
      throw error;
    }

    this._setState("connecting", `P2P 打洞连接 ${targetHost}:${targetPort}…`);
    onLog?.("p2p_nat_connect_start", { targetHost, targetPort, stunAddr, stunPort });

    try {
      // Step 1: STUN 发现本机公网端点（用于诊断）
      this._publicEndpoint = await this._stunDiscover(stunAddr, stunPort, onLog);
      onLog?.("p2p_nat_stun_resolved", this._publicEndpoint);

      // Step 2: 直接尝试连接 NAS 的公网端点
      // 如果 NAS 的 NAT 类型允许，可以直接连接
      this._p2pSocket = await this._createDirectConnection(targetHost, targetPort, onLog);

      // Step 3: 通过 P2P 连接建立 SSH
      this._client = await this._createSshOverP2p(config, onUnknownHost, onLog);
      this._hostFingerprint = config.hostFingerprint || "";
      this._setState("connected", `P2P 已连接 ${targetHost}:${targetPort}`);
      onLog?.("p2p_nat_connected", { targetHost, targetPort, publicEndpoint: this._publicEndpoint });
    } catch (error) {
      this._cleanup();
      this._setState("error", `P2P 连接失败：${this._friendlyError(error)}`);
      onLog?.("p2p_nat_connect_failed", { targetHost, targetPort, error: error.message });
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
      this._onLog?.("p2p_nat_ping", { latencyMs: latency, jitter });
      return this.lastPing;
    } catch (error) {
      this._onLog?.("p2p_nat_ping_failed", { error: error.message });
      throw error;
    }
  }

  // ── 内部方法 ──────────────────────────────────────

  _requireConnected() {
    if (this.state !== "connected" || !this._client) {
      throw new Error("P2P 连接未建立，请先连接。");
    }
  }

  _stunDiscover(stunAddr, stunPort, onLog) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      const timeout = setTimeout(() => {
        socket.close();
        // STUN 发现失败不阻断连接，仅记录诊断信息
        onLog?.("p2p_nat_stun_timeout", { stunAddr, stunPort });
        resolve(null);
      }, 5_000);

      socket.once("message", (message) => {
        clearTimeout(timeout);
        socket.close();
        // 解析 STUN 响应中的 XOR-MAPPED-ADDRESS
        try {
          if (message.length < 20 || message.readUInt16BE(0) !== 0x0101) {
            resolve(null);
            return;
          }
          const attrStart = 20;
          let offset = attrStart;
          while (offset + 4 <= message.length) {
            const attrType = message.readUInt16BE(offset);
            const attrLen = message.readUInt16BE(offset + 2);
            if (attrType === 0x0020 && offset + 4 + attrLen <= message.length) {
              // XOR-MAPPED-ADDRESS
              const family = message[offset + 4] ^ 0x01;
              const port = message.readUInt16BE(offset + 5) ^ 0x0101;
              let ip;
              if (family === 0x01) {
                // IPv4
                ip = [
                  (message[offset + 8] ^ 0x21),
                  (message[offset + 9] ^ 0x12),
                  (message[offset + 10] ^ 0xA4),
                  (message[offset + 11] ^ 0x42)
                ].join(".");
              }
              resolve({ ip, port, family: "IPv4" });
              return;
            }
            offset += 4 + Math.ceil(attrLen / 4) * 4;
          }
          resolve(null);
        } catch { resolve(null); }
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        socket.close();
        onLog?.("p2p_nat_stun_error", { error: error.message });
        resolve(null);
      });

      // 发送 STUN Binding Request (RFC 5389)
      const request = Buffer.alloc(20);
      request.writeUInt16BE(0x0001, 0);  // Type: Binding Request
      request.writeUInt16BE(0x0000, 2);  // Length: 0
      request.writeUInt32BE(0x2112A442, 4);  // Magic Cookie
      // Transaction ID (12 bytes random)
      for (let i = 8; i < 20; i++) request[i] = Math.floor(Math.random() * 256);

      socket.send(request, stunPort, stunAddr, (error) => {
        if (error) {
          clearTimeout(timeout);
          socket.close();
          onLog?.("p2p_nat_stun_send_error", { error: error.message });
          resolve(null);
        }
      });
    });
  }

  _createDirectConnection(targetHost, targetPort, onLog) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("P2P 直连超时，目标可能不可达或 NAT 类型不支持打洞。"));
      }, 15_000);

      const socket = net.createConnection({ host: targetHost, port: targetPort }, () => {
        clearTimeout(timeout);
        onLog?.("p2p_nat_direct_connected", { targetHost, targetPort });
        resolve(socket);
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`P2P 直连失败：${error.message}`));
      });

      socket.setKeepAlive(true, 30_000);
      socket.setNoDelay(true);
    });
  }

  _createSshOverP2p(config, onUnknownHost, onLog) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error("P2P SSH 握手超时。"));
      }, 30_000);

      client.once("ready", () => {
        clearTimeout(timeout);
        resolve(client);
      });

      client.once("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(this._friendlyError(error)));
      });

      client.connect({
        sock: this._p2pSocket,
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
    try { this._p2pSocket?.destroy(); } catch { /* 忽略 */ }
    this._client = null;
    this._p2pSocket = null;
  }

  _friendlyError(error) {
    const msg = String(error?.message || error);
    if (/authentication|密码|账号/i.test(msg)) return "SSH 账号或密码不正确。";
    if (/ECONNREFUSED/i.test(msg)) return "P2P 连接被拒绝，目标端口可能不可达。";
    if (/ETIMEDOUT|超时/i.test(msg)) return "P2P 连接超时，NAT 类型可能不支持直接打洞。";
    if (/ENOTFOUND/i.test(msg)) return "目标地址解析失败，请检查 NAS 地址。";
    if (/EHOSTUNREACH/i.test(msg)) return "目标主机不可达，NAT 可能阻止了 P2P 连接。";
    if (/PROTOCOL|handshake/i.test(msg)) return "SSH 握手失败，P2P 隧道可能不稳定。";
    return msg;
  }

  _modeLabel() { return "P2P 打洞"; }
}

module.exports = { P2pNatTransport };