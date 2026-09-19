"use strict";

function createToolPermissionService({ getSettings, saveSettings, showConfirmation, restoreFocus, writeLog }) {
  if (typeof getSettings !== "function" || typeof saveSettings !== "function" || typeof showConfirmation !== "function") {
    throw new Error("工具权限模块缺少受控依赖。");
  }
  return Object.freeze({
    async setAutomaticMode(enabled, signal) {
      const current = getSettings();
      const payload = { connectionMode: current.connectionMode === "local" ? "local" : "ssh", automatic: Boolean(enabled) };
      try {
        signal?.permissionReceived(payload);
        if (enabled) {
          const localMode = current.connectionMode === "local";
          const answer = await showConfirmation({
            type: "warning",
            title: "允许 Agent 自动执行工具",
            message: `允许 Agent 在${localMode ? "这台电脑" : " NAS"}上自动执行工具操作？`,
            detail: `开启后，Agent 可以在${localMode ? "本机" : " NAS"}读取、创建、修改文件并运行命令。仅在信任当前${localMode ? "电脑" : " NAS"}和工作目录时开启。`,
            buttons: ["取消", "允许自动执行"],
            defaultId: 0,
            cancelId: 0
          });
          if (answer.response !== 1) { signal?.cancelled("user-declined-tool-mode"); return { ...current, cancelled: true }; }
        }
        signal?.permissionToSettings(payload);
        const saved = saveSettings({ ...current, skipPermissions: Boolean(enabled) }, signal);
        writeLog?.("tool_permission_mode_changed", { automatic: saved.skipPermissions });
        return saved;
      } catch (error) {
        signal?.failed(error);
        throw error;
      } finally {
        restoreFocus?.();
      }
    }
  });
}

module.exports = { createToolPermissionService };
