"use strict";

// v3.41.0（任务完成系统推送通知）：决策与文案纯函数模块（零 electron 依赖，可独立单测+混淆保护）。
// 背景：用户给云端 AI 粘贴超长任务单后切去刷抖音，几小时后才发现 AI 一小时前就干完了——
//       需要系统级提醒「AI 干完活了」。桌面端等价交互（参考 ChatGPT APP 推送）：
//       系统通知负责「提醒」+ 点击「回到对话」，输入框自动聚焦，用户直接打字续聊
//       （Windows 原生 toast 通知不支持内嵌输入框，Electron Notification 也无 actions，故走点击回跳路线）。
//
// 三方分工：
//   渲染层 = 上报点（单聊完成/失败、AI 提问悬等、群聊全员收工）＋ 会话身份（发起会话 id/标题/是否后台）；
//   主进程 = 结合窗口焦点状态与设置开关，最终决定弹与不弹，并处理点击回跳（还原+聚焦+回发 activated）；
//   本模块 = 决策矩阵与通知文案纯函数（无 IO，便于单测与守门）。

// 刚失焦完成的回复不弹——用户可能只是切走一眼马上回来，此时弹通知反而打扰
const NOTIFICATION_BLUR_GRACE_MS = 8000;
// 通知 body 摘要截断长度（含省略号）
const NOTIFY_SUMMARY_MAX = 160;
// 会话名在通知标题中的截断长度（避免长标题撑爆 toast 首行）
const NOTIFY_LABEL_MAX = 24;

// ── 触发种类白名单：done=回复完成 / error=执行失败 / ask=AI 提问悬等 / group=群聊全员收工 ──
const TASK_NOTIFY_KINDS = ["done", "error", "ask", "group"];

/** 入参净化：渲染层/IPC 来的数据一律不可信，字段逐项白名单化（未知 kind 兜底 done，数字兜底 0） */
function sanitizeTaskNotifyPayload(input = {}) {
  const kind = TASK_NOTIFY_KINDS.includes(String(input && input.kind)) ? String(input.kind) : "done";
  return {
    kind,
    conversationId: String((input && input.conversationId) || ""),
    conversationTitle: String((input && input.conversationTitle) || ""),
    summary: String((input && input.summary) || ""),
    force: Boolean(input && input.force),
    totalMembers: Number(input && input.totalMembers) || 0,
    failedCount: Number(input && input.failedCount) || 0
  };
}

/** 单行化＋截断：通知 body 不要换行不要超长（空白字符合并） */
function truncateSummary(text, max) {
  const limit = Number(max) || NOTIFY_SUMMARY_MAX;
  const flat = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…`;
}

/** 通知标题与正文构造（payload 应先过 sanitizeTaskNotifyPayload） */
function notificationTitleBody(payload) {
  const clean = sanitizeTaskNotifyPayload(payload);
  const label = truncateSummary(clean.conversationTitle, NOTIFY_LABEL_MAX) || "Agent 任务";
  if (clean.kind === "error") {
    return {
      title: `⚠️ ${label} · 任务执行失败`,
      body: truncateSummary(clean.summary) || "AI 中途停止，点击回到对话查看详情"
    };
  }
  if (clean.kind === "ask") {
    return {
      title: `❓ ${label} · AI 在等你的回答`,
      body: truncateSummary(clean.summary) || "AI 提出了一个需要你选择的问题"
    };
  }
  if (clean.kind === "group") {
    const total = clean.totalMembers;
    const failed = clean.failedCount;
    const body = total > 0
      ? (failed > 0
        ? `共 ${total} 位成员：${total - failed} 位完成，${failed} 位失败`
        : `共 ${total} 位成员回复完成`)
      : "本轮群聊已收工";
    return { title: `✅ 群聊 ${label} · 本轮收工`, body };
  }
  return {
    title: `✅ ${label} · AI 回复完成`,
    body: truncateSummary(clean.summary) || "AI 已完成本轮任务，点击回到对话继续"
  };
}

/**
 * 弹与不弹的决策矩阵（主进程在收到上报时调用）。
 * windowState: {
 *   notificationAllowed: 设置开关（settings.taskCompleteNotifications !== false 由调用方预判），
 *   focused / minimized / visible: 窗口态（isFocused/isMinimized/isVisible），
 *   lastBlurAt: 最近一次失焦时间戳（毫秒，0=从未失焦），
 *   now: 当前时间戳（测试注入），blurGraceMs: 失焦宽限（默认 NOTIFICATION_BLUR_GRACE_MS）
 * }
 * 返回 { show, reason, title, body }；reason 枚举用于日志与守门测试：
 *   notifications-disabled / window-hidden-or-minimized / background-conversation /
 *   just-blurred / window-unfocused / focused-on-window
 */
function decideTaskNotification(input = {}) {
  const payload = sanitizeTaskNotifyPayload(input.payload);
  const state = input.windowState || {};
  const now = Number(input.now) || Date.now();
  if (state.notificationAllowed === false) {
    return { show: false, reason: "notifications-disabled", title: "", body: "" };
  }
  // 计算文案在决策外也保留——即便不弹，日志仍可带标题定位
  const { title, body } = notificationTitleBody(payload);
  if (state.minimized || state.visible === false) {
    return { show: true, reason: "window-hidden-or-minimized", title, body };
  }
  if (payload.force) {
    return { show: true, reason: "background-conversation", title, body };
  }
  if (!state.focused) {
    const grace = Number(state.blurGraceMs) || NOTIFICATION_BLUR_GRACE_MS;
    const lastBlur = Number(state.lastBlurAt) || 0;
    if (lastBlur && now - lastBlur < grace) {
      return { show: false, reason: "just-blurred", title, body };
    }
    return { show: true, reason: "window-unfocused", title, body };
  }
  return { show: false, reason: "focused-on-window", title, body };
}

// notificationTitleBody / sanitizeTaskNotifyPayload 内部互查可复核——对外仅暴露本文件五个入口
module.exports = {
  NOTIFICATION_BLUR_GRACE_MS,
  NOTIFY_SUMMARY_MAX,
  NOTIFY_LABEL_MAX,
  TASK_NOTIFY_KINDS,
  sanitizeTaskNotifyPayload,
  truncateSummary,
  notificationTitleBody,
  decideTaskNotification
};