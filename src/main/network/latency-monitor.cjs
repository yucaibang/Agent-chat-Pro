"use strict";

/**
 * 延迟监控器 — 定期 ping 并记录延迟历史，计算连接质量评分。
 *
 * 连接质量评分（0-100）：
 * - 90-100: 优秀（延迟 <50ms，无抖动）
 * - 70-89:  良好（延迟 50-150ms，轻微抖动）
 * - 50-69:  一般（延迟 150-300ms，中度抖动）
 * - 0-49:   差（延迟 >300ms 或频繁丢包）
 */

const QUALITY_LABELS = {
  excellent: { min: 90, label: "优秀", color: "#6eba84" },
  good: { min: 70, label: "良好", color: "#a8d86e" },
  fair: { min: 50, label: "一般", color: "#e4ad6b" },
  poor: { min: 0, label: "差", color: "#e17d72" }
};

class LatencyMonitor {
  /**
   * @param {object} options
   * @param {number} [options.intervalMs=30000] - ping 间隔毫秒
   * @param {number} [options.historySize=20] - 保留最近 N 次记录
   * @param {Function} [options.onUpdate] - 每次更新回调
   */
  constructor(options = {}) {
    this._intervalMs = options.intervalMs || 30_000;
    this._historySize = options.historySize || 20;
    this._onUpdate = options.onUpdate || null;
    /** @type {{latencyMs: number, jitter: number, timestamp: number}[]} */
    this._history = [];
    this._timer = null;
    this._transport = null;
    this._running = false;
  }

  /** 启动监控。 @param {Transport} transport */
  start(transport) {
    this.stop();
    this._transport = transport;
    this._running = true;
    this._doPing();
    this._timer = setInterval(() => this._doPing(), this._intervalMs);
    this._timer.unref?.();
  }

  /** 停止监控。 */
  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._transport = null;
  }

  /** 获取最近延迟记录。 */
  getHistory() { return [...this._history]; }

  /** 获取统计摘要。 */
  getSummary() {
    if (!this._history.length) return { avgLatency: null, jitter: null, quality: 0, label: "未知", color: "#77817e" };
    const latencies = this._history.map((h) => h.latencyMs);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const jitter = this._history.length > 1
      ? this._history.reduce((sum, h, i) => i === 0 ? 0 : sum + Math.abs(h.latencyMs - this._history[i - 1].latencyMs), 0) / (this._history.length - 1)
      : 0;
    const quality = this._calculateQuality(avgLatency, jitter);
    const entry = Object.entries(QUALITY_LABELS).find(([, v]) => quality >= v.min);
    return { avgLatency: Math.round(avgLatency), jitter: Math.round(jitter), quality, label: entry?.[1].label || "未知", color: entry?.[1].color || "#77817e" };
  }

  async _doPing() {
    if (!this._running || !this._transport) return;
    try {
      const result = await this._transport.ping();
      this._history.push({ latencyMs: result.latencyMs, jitter: result.jitter || 0, timestamp: Date.now() });
      if (this._history.length > this._historySize) this._history.shift();
      this._onUpdate?.(this.getSummary());
    } catch {
      // ping 失败由 NetworkManager 心跳处理
    }
  }

  _calculateQuality(avgLatency, jitter) {
    let score = 100;
    score -= Math.min(40, avgLatency / 5);   // 延迟扣分：50ms→10分, 200ms→40分
    score -= Math.min(30, jitter / 3);         // 抖动扣分：30ms→10分, 90ms→30分
    score -= Math.max(0, 30 - this._history.length * 3); // 样本不足扣分
    return Math.max(0, Math.min(100, Math.round(score)));
  }
}

module.exports = { LatencyMonitor, QUALITY_LABELS };