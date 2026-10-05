"use strict";

const { Client } = require("ssh2");
const { spawn } = require("child_process");
const net = require("net");
const { Transport } = require("./transport-base.cjs");

/**
 * N2N 虚拟局域网 Transport — 通过 N2N 虚拟网络 SSH 到 NAS。
 *
 * 工作原理：
 * 1. 启动本地 n2n edge 进程，加入虚拟局域网
 * 2. 等待虚拟 IP 分配（edge 会自动从 supernode 获取）
 * 3. 通过虚拟 IP 直接 SSH 到 NAS 的虚拟 IP
 * 4. 断开时终止 edge 进程
 *
 * 传输模式自动兼容（v3.12.3）：
 * - 默认先尝试 UDP 模式（edge 原生方式）
 * - 网络就绪超时自动降级 TCP 模式（-S2，edge 全流量走 supernode TCP）——
 *   适配 supernode 经由 FRP TCP 隧道暴露的场景（UDP 包无法进入 TCP 隧道）
 * - 成功模式按「supernodeAddr:port」缓存，同进程内重连直接用已验证模式
 *
 * 前提：需要本机安装 n2n（edge 命令），NAS 端也需运行 edge 加入同一社区。
 */

/** 每个超级节点入口上次成功的传输模式（"udp" | "tcp"），进程内记忆 */
const MODE_CACHE = new Map();

class N2nMeshTransport extends Transport {
  constructor() {
    super("n2n-mesh");
    /** @type {Client|null} */
    this._client = null;
    /** @type {ChildProcess|null} */
    this._edgeProcess = null;
    this._hostFingerprint = "";
    this._onUnknownHost = null;
    this._onLog = null;
    this._virtualIp = null;
  }

  async connect(config, onUnknownHost, onLog) {
    if (this.state === "connected") return;
    this.config = config;
    this._onUnknownHost = onUnknownHost;
    this._onLog = onLog;

    const n2n = config.n2n || {};
    const supernodeAddr = String(n2n.supernodeAddr || "").trim();
    const supernodePort = Number(n2n.supernodePort) || 7777;
    const community = String(n2n.community || "").trim();
    const key = String(n2n.key || "").trim();
    // NAS 在 N2N 网络中的虚拟 IP（用户需要配置）
    const targetHost = config.host;
    const targetPort = config.port || 22;

    if (!supernodeAddr) {
      const error = new Error("N2N 超级节点地址未配置，请在网络设置中填写。");
      this._setState("error", error.message);
      throw error;
    }
    if (!community) {
      const error = new Error("N2N 社区名未配置，请在网络设置中填写。");
      this._setState("error", error.message);
      throw error;
    }

    this._setState("connecting", `N2N 虚拟网络连接中…`);
    onLog?.("n2n_mesh_connect_start", { supernodeAddr, supernodePort, community: "[REDACTED]" });

    // Step 1+2: 建立虚拟网络（UDP 自动兼容降级 TCP）
    // v3.19.0 F3：高级设置手动面（-A 加密方式 / -z 压缩 / -H 头加密 / 手动协议不探测）
    const tunables = config?.advancedEffective?.external?.n2n || {};
    try {
      await this._establishN2nNetwork({
        supernodeAddr,
        supernodePort,
        community,
        key,
        cipher: String(tunables.cipher || ""),
        compression: String(tunables.compression || ""),
        headerEncryption: Boolean(tunables.headerEncryption),
        manualProtocol: tunables.protocol === "udp" || tunables.protocol === "tcp" ? tunables.protocol : ""
      }, targetHost, targetPort, onLog);
    } catch (error) {
      this._cleanup();
      this._setState("error", `N2N 连接失败：${this._friendlyError(error)}`);
      onLog?.("n2n_mesh_connect_failed", { error: error.message });
      throw error;
    }

    // Step 3: 网络已就绪，通过 N2N 虚拟网络建立 SSH 连接
    // （此阶段失败是 SSH 层问题，不再切换传输模式）
    try {
      this._client = await this._createSshOverN2n(config, onUnknownHost, onLog);
      this._hostFingerprint = config.hostFingerprint || "";
      this._setState("connected", `N2N 虚拟网络已连接 ${targetHost}:${targetPort}`);
      onLog?.("n2n_mesh_connected", { targetHost, targetPort });
    } catch (error) {
      this._cleanup();
      this._setState("error", `N2N 连接失败：${this._friendlyError(error)}`);
      onLog?.("n2n_mesh_connect_failed", { error: error.message });
      throw error;
    }
  }

  /**
   * 建立 N2N 虚拟网络（自动兼容 UDP/TCP 传输模式）：
   * 1. 查缓存：该 supernode 入口上次成功是 tcp → 直接 TCP；否则先 UDP 后 TCP
   * 2. UDP 阶段：启动 edge（默认模式）→ 缩短轮询（8 次）
   * 3. UDP 失败 → 结束进程 → TCP 阶段：edge 加 -S2 → 完整轮询（15 次）
   * 4. 任一阶段网络就绪即返回成功模式，并写入缓存
   */
  async _establishN2nNetwork(edgeOptions, targetHost, targetPort, onLog) {
    const modeKey = `${edgeOptions.supernodeAddr}:${edgeOptions.supernodePort}`;
    const cached = MODE_CACHE.get(modeKey);
    // v3.19.0 F3：手动协议=固定模式不探测（udp/tcp）；自动=UDP 失败降级 TCP（tcp 缓存命中则直连 tcp）
    const modes = edgeOptions.manualProtocol ? [edgeOptions.manualProtocol] : (cached === "tcp" ? ["tcp"] : ["udp", "tcp"]);

    let lastError = null;
    for (const mode of modes) {
      const isTcp = mode === "tcp";
      if (isTcp && !cached) {
        onLog?.("n2n_mesh_udp_fallback_tcp", { reason: lastError?.message || "udp 未就绪" });
      }
      try {
        onLog?.("n2n_mesh_mode_attempt", { mode });
        this._edgeProcess = await this._startEdgeProcess(edgeOptions, onLog, isTcp);
        onLog?.("n2n_mesh_edge_started", { supernodeAddr: edgeOptions.supernodeAddr, community: "[REDACTED]", mode });
        await this._waitForNetworkReady(targetHost, targetPort, onLog, isTcp ? 15 : 8);
        // 网络就绪 → 记录成功模式
        if (MODE_CACHE.get(modeKey) !== mode) {
          MODE_CACHE.set(modeKey, mode);
          onLog?.("n2n_mesh_mode_cached", { mode, cached: Boolean(cached) });
        }
        return mode;
      } catch (error) {
        lastError = error;
        // 清理本次失败的 edge 进程，为下一模式让路
        if (this._edgeProcess) {
          try { this._edgeProcess.kill("SIGTERM"); } catch { /* 忽略 */ }
          this._edgeProcess = null;
        }
        if (isTcp) {
          // TCP 也失败：两种模式都未通
          throw new Error(
            `N2N 虚拟网络就绪失败（已自动尝试 UDP 和 TCP 两种模式）。` +
            `请检查超级节点地址/端口是否正确、本机是否已安装 n2n、NAS 端 edge 是否在线。原因：${error.message}`
          );
        }
        onLog?.("n2n_mesh_udp_attempt_failed", { error: error.message });
      }
    }
    throw lastError || new Error("N2N 虚拟网络连接失败。");
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
      this._onLog?.("n2n_mesh_ping", { latencyMs: latency, jitter });
      return this.lastPing;
    } catch (error) {
      this._onLog?.("n2n_mesh_ping_failed", { error: error.message });
      throw error;
    }
  }

  // ── 内部方法 ──────────────────────────────────────

  _requireConnected() {
    if (this.state !== "connected" || !this._client) {
      throw new Error("N2N 虚拟网络连接未建立，请先连接。");
    }
  }

  _startEdgeProcess(options, onLog, isTcp = false) {
    return new Promise((resolve, reject) => {
      const args = [
        "-l", `${options.supernodeAddr}:${options.supernodePort}`,
        "-c", options.community,
        "-f"  // foreground mode (we manage the process lifecycle)
      ];
      if (isTcp) {
        // -S2：不 P2P，全流量经 supernode 中继且 edge↔supernode 走 TCP
        // （适配 supernode 经 FRP TCP 隧道暴露：UDP 无法穿过 TCP 隧道）
        args.push("-S2");
      }
      if (options.key) {
        args.push("-k", options.key);
      }
      // v3.19.0 F3：手动加密方式 / 压缩 / 头加密（空值=n2n 默认行为，不带参数）
      if (options.cipher && /^A[2-5]$/.test(options.cipher)) {
        args.push(`-A${options.cipher}`);
      }
      if (options.compression === "lzo1x") args.push("-z1");
      if (options.compression === "zstd") args.push("-z2");
      if (options.headerEncryption) args.push("-H");

      const timeout = setTimeout(() => {
        reject(new Error("N2N edge 启动超时，请确保已安装 n2n（edge 命令）。"));
      }, 10_000);

      let resolved = false;
      let lastStderr = "";

      try {
        const edge = spawn("edge", args, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: false
        });

        edge.once("error", (error) => {
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            if (error.code === "ENOENT") {
              reject(new Error("未找到 n2n edge 命令，请先安装 n2n。"));
            } else {
              reject(new Error(`N2N edge 启动失败：${error.message}`));
            }
          }
        });

        edge.stderr.on("data", (data) => {
          lastStderr = data.toString().trim();
          // edge 就绪的标志：看到 "edge is running" 或类似日志
          if (!resolved && (/edge.*running|joined.*community|virtual.*ip|tap.*device/i.test(lastStderr))) {
            clearTimeout(timeout);
            resolved = true;
            resolve(edge);
          }
        });

        edge.on("exit", (code) => {
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            reject(new Error(`N2N edge 进程退出（代码 ${code}）：${lastStderr}`));
          }
        });

        // 如果10秒内没有识别到就绪日志，也视为启动成功
        // 因为 edge 可能已就绪但日志格式不同
        setTimeout(() => {
          if (!resolved && !edge.killed) {
            clearTimeout(timeout);
            resolved = true;
            resolve(edge);
          }
        }, 5_000);
      } catch (error) {
        clearTimeout(timeout);
        reject(new Error(`N2N edge 启动失败：${error.message}`));
      }
    });
  }

  _waitForNetworkReady(targetHost, targetPort, onLog, maxAttempts = 15) {
    return new Promise((resolve, reject) => {
      const interval = 1_000;
      let attempts = 0;

      const tryConnect = () => {
        attempts++;
        const socket = new net.Socket();
        socket.setTimeout(2_000);

        socket.on("connect", () => {
          socket.destroy();
          onLog?.("n2n_mesh_network_ready", { targetHost, targetPort, attempts });
          resolve();
        });

        socket.on("error", () => {
          socket.destroy();
          if (attempts >= maxAttempts) {
            reject(new Error(`N2N 虚拟网络就绪超时（已尝试 ${attempts} 次）。请检查 NAS 是否已加入同一 N2N 社区。`));
          } else {
            setTimeout(tryConnect, interval);
          }
        });

        socket.on("timeout", () => {
          socket.destroy();
          if (attempts >= maxAttempts) {
            reject(new Error("N2N 虚拟网络就绪超时。"));
          } else {
            setTimeout(tryConnect, interval);
          }
        });

        socket.connect(targetPort, targetHost);
      };

      tryConnect();
    });
  }

  _createSshOverN2n(config, onUnknownHost, onLog) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error("N2N SSH 握手超时。"));
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
        host: config.host,
        port: config.port || 22,
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
    this._client = null;
    if (this._edgeProcess && !this._edgeProcess.killed) {
      try {
        this._edgeProcess.kill("SIGTERM");
        // 给进程2秒时间优雅退出
        setTimeout(() => {
          try { this._edgeProcess?.kill("SIGKILL"); } catch { /* 忽略 */ }
        }, 2_000);
      } catch { /* 忽略 */ }
    }
    this._edgeProcess = null;
  }

  _friendlyError(error) {
    const msg = String(error?.message || error);
    // 双模式自动兼容的完整结论保留原文，不做泛化改写
    if (/已自动尝试 UDP 和 TCP/.test(msg)) return msg;
    if (/authentication|密码|账号/i.test(msg)) return "SSH 账号或密码不正确。";
    if (/ECONNREFUSED/i.test(msg)) return "N2N 虚拟网络连接被拒绝，请检查 NAS 是否已加入同一社区。";
    if (/ETIMEDOUT|超时/i.test(msg)) return "N2N 虚拟网络连接超时，请检查 N2N 配置和 NAS 状态。";
    if (/ENOTFOUND/i.test(msg)) return "N2N 目标地址解析失败。";
    if (/EHOSTUNREACH/i.test(msg)) return "N2N 虚拟网络中目标不可达。";
    if (/ENOENT|未找到.*edge/i.test(msg)) return "未找到 n2n edge 命令，请先安装 n2n。";
    if (/PROTOCOL|handshake/i.test(msg)) return "SSH 握手失败，N2N 隧道可能不稳定。";
    return msg;
  }

  _modeLabel() { return "N2N 虚拟局域网"; }
}

module.exports = { N2nMeshTransport };