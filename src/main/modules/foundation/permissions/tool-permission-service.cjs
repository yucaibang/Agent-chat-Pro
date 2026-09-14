"use strict";

/**
 * 工具权限服务 — 管理自动/手动工具执行模式的切换逻辑。
 *
 * 开启自动模式时弹出确认对话框，明确告知用户风险。
 * 通过信号链报告进度，写入审计日志。
 * 无论成功失败，最终恢复窗口焦点。
 */

function createToolPermissionService({ getSettings, saveSettings, showConfirmation, onLog, restoreFocus }) {
  let currentMode = false;

  function getMode() {
    return currentMode;
  }

  async function setAutomaticMode(enabled, signal) {
    if (enabled === currentMode) return currentMode;

    if (enabled) {
      // 开启自动模式需要确认
      const confirmed = await showConfirmation({
        type: "warning",
        title: "允许 Agent 自动执行工具",
        message: "自动模式允许 Agent 不经确认直接执行所有工具操作，包括文件修改、命令运行等。",
        detail: "仅在你信任当前任务时启用。随时可以切回安全模式。",
        buttons: ["保持安全模式", "启用自动模式"],
        defaultId: 0,
        cancelId: 0
      });
      if (confirmed !== true) {
        if (typeof restoreFocus === "function") restoreFocus();
        return currentMode;
      }
    }

    const previousMode = currentMode;
    currentMode = enabled;

    // 持久化
    try {
      const settings = typeof getSettings === "function" ? getSettings() : {};
      settings.toolMode = enabled ? "automatic" : "safe";
      if (typeof saveSettings === "function") await saveSettings(settings);
    } catch (error) {
      if (typeof onLog === "function") onLog("tool_permission_save_failed", { enabled, error: String(error) });
    }

    if (typeof onLog === "function") {
      onLog("tool_permission_mode_changed", { from: previousMode ? "automatic" : "safe", to: currentMode ? "automatic" : "safe" });
    }

    if (typeof restoreFocus === "function") restoreFocus();
    return currentMode;
  }

  // 从设置中恢复模式
  function restoreFromSettings(settings) {
    currentMode = settings?.toolMode === "automatic";
    return currentMode;
  }

  return Object.freeze({ getMode, setAutomaticMode, restoreFromSettings });
}

module.exports = { createToolPermissionService };