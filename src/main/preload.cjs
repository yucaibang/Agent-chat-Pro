"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("claudeNas", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  setToolMode: (enabled) => ipcRenderer.invoke("settings:tool-mode", enabled),
  listConversations: () => ipcRenderer.invoke("conversations:list"),
  createConversation: () => ipcRenderer.invoke("conversations:create"),
  getConversation: (id) => ipcRenderer.invoke("conversations:get", id),
  renameConversation: (id, title) => ipcRenderer.invoke("conversations:rename", id, title),
  deleteConversation: (id) => ipcRenderer.invoke("conversations:delete", id),
  openDiagnostics: () => ipcRenderer.invoke("diagnostics:open"),
  getDeviceControlStatus: () => ipcRenderer.invoke("device-control:status"),
  installDeviceControl: (options) => ipcRenderer.invoke("device-control:install", options),
  uninstallDeviceControl: () => ipcRenderer.invoke("device-control:uninstall"),
  getBridgeStatus: () => ipcRenderer.invoke("bridge:status"),
  installBridge: () => ipcRenderer.invoke("bridge:install"),
  uninstallBridge: () => ipcRenderer.invoke("bridge:uninstall"),
  chooseStorageDirectory: () => ipcRenderer.invoke("storage:choose"),
  openStorageDirectory: (directory) => ipcRenderer.invoke("storage:open", directory),
  openArchiveDirectory: () => ipcRenderer.invoke("archive:open"),
  showConversationArchive: (id) => ipcRenderer.invoke("archive:show", id),
  renderMarkdown: (source) => ipcRenderer.invoke("markdown:render", source),
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  previewRemoteFile: (file) => ipcRenderer.invoke("file:preview", file),
  saveRemoteFile: (file) => ipcRenderer.invoke("file:save", file),
  openRemoteFile: (file) => ipcRenderer.invoke("file:open", file),
  testConnection: (settings) => ipcRenderer.invoke("connection:test", settings),
  sendMessage: (input) => ipcRenderer.invoke("chat:send", input),
  cancelMessage: (id) => ipcRenderer.invoke("chat:cancel", id),
  windowAction: (action) => ipcRenderer.invoke("window:action", action),
  isWindowMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onDelta: (handler) => ipcRenderer.on("chat:delta", (_event, payload) => handler(payload)),
  onChatEvent: (handler) => ipcRenderer.on("chat:event", (_event, payload) => handler(payload)),
  onMenuAction: (handler) => ipcRenderer.on("app:menu", (_event, action) => handler(action)),
  onWindowMaximized: (handler) => ipcRenderer.on("window:maximized", (_event, value) => handler(value))
});
