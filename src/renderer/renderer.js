"use strict";

const elements = {
  dialog: document.querySelector("#settings-dialog"),
  form: document.querySelector("#settings-form"),
  status: document.querySelector("#settings-status"),
  messages: document.querySelector("#messages"),
  empty: document.querySelector("#empty-state"),
  prompt: document.querySelector("#prompt"),
  filePicker: document.querySelector("#file-picker"),
  attachmentList: document.querySelector("#attachment-list"),
  conversationList: document.querySelector("#conversation-list"),
  conversationSearch: document.querySelector("#conversation-search"),
  historyCount: document.querySelector("#history-count"),
  composer: document.querySelector("#composer"),
  send: document.querySelector("#send"),
  toolMode: document.querySelector("#tool-mode"),
  stateText: document.querySelector("#state-text"),
  stateDot: document.querySelector("#state-dot")
};

let sessionId = "";
let activeId = "";
let conversationId = "";
let attachments = [];
let conversationCache = [];
let automaticTools = false;
let currentConnectionMode = "ssh";
const messages = new Map();

function settingsFromForm() {
  const data = new FormData(elements.form);
  const network = networkSettingsFromForm();
  return {
    connectionMode: data.get("connectionMode"),
    host: data.get("host"),
    port: data.get("port"),
    username: data.get("username"),
    password: data.get("password"),
    wakeName: data.get("wakeName"),
    clientLabel: data.get("clientLabel"),
    workingDirectory: data.get("workingDirectory"),
    dataDirectory: data.get("dataDirectory"),
    skipPermissions: data.get("skipPermissions") === "on",
    workModeId: currentModeId,
    networkType: document.querySelector("#network-type").value,
    externalMethod: document.querySelector("#external-method").value,
    ...network
  };
}

function populateSettings(settings) {
  for (const key of ["host", "port", "username", "wakeName", "clientLabel", "workingDirectory", "dataDirectory"]) {
    const input = elements.form.elements.namedItem(key);
    input.value = settings[key] ?? "";
  }
  elements.form.elements.namedItem("skipPermissions").checked = Boolean(settings.skipPermissions);
  elements.form.elements.namedItem("connectionMode").value = settings.connectionMode || "ssh";
  currentConnectionMode = settings.connectionMode === "local" ? "local" : "ssh";
  updateConnectionModeUI();
  setToolModeAppearance(Boolean(settings.skipPermissions));
  const password = elements.form.elements.namedItem("password");
  password.value = "";
  password.type = "password";
  document.querySelector("#toggle-password").textContent = "显示";
  document.querySelector("#password-hint").textContent = settings.hasPassword
    ? "已安全保存密码；留空不会修改"
    : "尚未保存密码";
  password.placeholder = settings.hasPassword
    ? "已安全保存；留空则不更改"
    : "请输入 SSH 密码";
  const controlSource = document.querySelector("#device-control-source");
  if (!controlSource.value) controlSource.value = settings.host || "";
}

function updateConnectionModeUI() {
  const mode = elements.form.elements.namedItem("connectionMode").value === "local" ? "local" : "ssh";
  currentConnectionMode = mode;
  const local = mode === "local";
  document.querySelector("#mode-ssh").classList.toggle("active", !local);
  document.querySelector("#mode-local").classList.toggle("active", local);
  document.querySelector("#ssh-fields").hidden = local;
  elements.form.elements.namedItem("host").required = !local;
  elements.form.elements.namedItem("username").required = !local;
  document.querySelector("#device-control-settings").hidden = local;
  document.querySelector("#bridge-settings").hidden = local;
  document.querySelector("#working-directory").placeholder = local ? "留空则使用本机默认目录" : "留空则使用 SSH 账号的主目录";
  document.querySelector("#permission-label").textContent = `允许 Agent 在${local ? "本机" : " NAS"}自动执行工具操作`;
  document.querySelector("#permission-hint").textContent = `开启后会传入 Claude Code 的 bypass permissions 参数。仅在你信任${local ? "这台电脑" : "该 NAS"}与当前工作目录时使用。`;
  document.querySelector("#settings-description").textContent = local
    ? "直接使用这台 Windows 电脑上的 Agent CLI（当前适配 Claude Code）。"
    : "通过 SSH 使用 NAS 或服务器上的 Agent CLI（当前适配 Claude Code）。";
  document.querySelector("#connection-subtitle").textContent = local
    ? "使用本机 Windows 上的 Agent CLI"
    : "通过 SSH 使用 NAS 上的 Agent CLI";
  document.querySelector("#empty-description").textContent = local
    ? "输入消息后，客户端会调用本机 Agent 并保留聊天上下文。"
    : "输入消息后，客户端会连接 NAS 并保留本次聊天的上下文。";
  document.querySelector("#security-note").textContent = local
    ? "本机模式不保存 SSH 密码；Agent 登录信息由对应 CLI 自己管理。"
    : "密码仅保存在这台 Windows 电脑的系统加密存储中。";
}

function renderDeviceControlStatus(status) {
  const title = document.querySelector("#device-control-title");
  const detail = document.querySelector("#device-control-detail");
  const badge = document.querySelector("#device-control-badge");
  const info = document.querySelector("#device-control-info");
  const install = document.querySelector("#install-device-control");
  const uninstall = document.querySelector("#uninstall-device-control");
  const source = document.querySelector("#device-control-source");
  const target = document.querySelector("#device-control-target");
  const targetPort = document.querySelector("#device-control-port");
  const permission = document.querySelector("#device-control-permission");
  if (!status.supported) {
    title.textContent = "当前系统不支持";
    detail.textContent = status.reason || "仅支持 Windows 10/11";
    badge.textContent = "不可用";
    badge.classList.remove("installed");
    install.disabled = true;
    uninstall.hidden = true;
    return;
  }
  install.disabled = false;
  if (status.installed) {
    title.textContent = status.serviceRunning ? "联动控件已安装并运行" : "联动控件已安装，但 SSH 服务未运行";
    detail.textContent = `账号 ${status.account} · Windows ${status.windowsRelease}`;
    badge.textContent = status.serviceRunning ? "运行中" : "需修复";
    badge.classList.add("installed");
    source.value = status.sourceAddress || source.value;
    target.value = status.targetAddress || target.value;
    targetPort.value = status.targetPort || targetPort.value || 22;
    permission.value = status.permissionMode || "administrator";
    const addresses = (status.localAddresses || []).join("、") || "未识别";
    const warning = status.existingBroadFirewallWarning ? "；检测到安装前已有较宽的 OpenSSH 防火墙规则，请由管理员复核" : "";
    info.textContent = `本机地址：${addresses}；管理密钥保存在 NAS：${status.managementKeyPath || "已配置"}${warning}`;
    install.textContent = "更新联动配置";
    uninstall.hidden = false;
  } else {
    title.textContent = "未安装 Agent 联动控件";
    detail.textContent = "员工无需创建或提供 Windows 密码";
    badge.textContent = "未安装";
    badge.classList.remove("installed");
    info.textContent = "点击安装后，NAS 为本机生成独立密钥，Windows 弹出一次 UAC 授权；以后 Agent 使用公钥连接，不使用员工密码。";
    install.textContent = "安装联动控件";
    uninstall.hidden = true;
    if (!target.value && status.localAddresses?.length) {
      const prefix = source.value.match(/^(\d+\.\d+\.\d+)\./)?.[1];
      target.value = (prefix && status.localAddresses.find((address) => address.startsWith(prefix + "."))) || status.localAddresses[0];
    }
  }
}

async function refreshDeviceControlStatus() {
  try { renderDeviceControlStatus(await window.claudeNas.getDeviceControlStatus()); }
  catch (error) { document.querySelector("#device-control-info").textContent = "状态检查失败：" + error.message; }
}

function renderBridgeStatus(status) {
  const title = document.querySelector("#bridge-title");
  const detail = document.querySelector("#bridge-detail");
  const badge = document.querySelector("#bridge-badge");
  const install = document.querySelector("#install-bridge");
  const uninstall = document.querySelector("#uninstall-bridge");
  title.textContent = status.ready ? "增强 Bridge 已就绪" : "基础直连聊天可用";
  detail.textContent = status.detail || "未检查";
  badge.textContent = status.ready ? "已就绪" : "可选";
  badge.classList.toggle("installed", Boolean(status.ready));
  install.textContent = status.ready ? "更新增强 Bridge" : "安装增强 Bridge";
  uninstall.hidden = !status.installed;
}

async function refreshBridgeStatus() {
  try { renderBridgeStatus(await window.claudeNas.getBridgeStatus()); }
  catch (error) {
    document.querySelector("#bridge-title").textContent = "尚未连接目标 NAS";
    document.querySelector("#bridge-detail").textContent = error.message;
  }
}

function setToolModeAppearance(enabled) {
  automaticTools = enabled;
  elements.toolMode.className = `tool-mode ${enabled ? "automatic" : "safe"}`;
  elements.toolMode.textContent = enabled ? "⚡" : "🛡";
  elements.toolMode.title = enabled ? "工具权限：自动执行（点击切换为安全模式）" : "工具权限：安全模式（点击允许自动执行）";
  refreshDeniedToolActions();
}

async function changeToolMode(enabled) {
  try {
    const settings = await window.claudeNas.setToolMode(enabled);
    if (settings.cancelled) return false;
    setToolModeAppearance(settings.skipPermissions);
    elements.form.elements.namedItem("skipPermissions").checked = settings.skipPermissions;
    setConnection(settings.skipPermissions ? `已允许 Claude 在${currentConnectionMode === "local" ? "本机" : " NAS"}自动执行工具` : "安全模式：需授权的工具会被拒绝", settings.skipPermissions ? "connected" : "");
    return true;
  } finally {
    elements.toolMode.blur();
    requestAnimationFrame(() => focusPrompt(true));
    setTimeout(() => focusPrompt(true), 80);
  }
}

function setStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.classList.toggle("error", isError);
}

function addMessage(kind, text = "") {
  elements.empty.hidden = true;
  const item = document.createElement("article");
  item.className = `message ${kind}`;
  const content = document.createElement("div");
  content.className = "message-content";
  content.textContent = text;
  item.append(content);
  elements.messages.append(item);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return item;
}

async function renderAssistant(item, text) {
  const content = item.querySelector(".message-content");
  content.innerHTML = await window.claudeNas.renderMarkdown(text);
  content.classList.add("rendered");
  content.querySelectorAll("a[href]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.claudeNas.openLink(link.getAttribute("href")).catch((error) => alert(error.message));
    });
  });
  content.querySelectorAll("pre").forEach((pre) => {
    const copy = document.createElement("button");
    copy.className = "copy-code";
    copy.type = "button";
    copy.textContent = "复制";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(pre.querySelector("code")?.textContent || pre.textContent);
      copy.textContent = "已复制";
      setTimeout(() => { copy.textContent = "复制"; }, 1200);
    });
    pre.append(copy);
  });
}

function renderTool(item, tool) {
  let list = item.querySelector(".tool-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "tool-list";
    item.prepend(list);
  }
  let card = [...list.children].find((child) => child.dataset.toolId === tool.id);
  if (!card) {
    card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.toolId = tool.id;
    list.append(card);
  }
  const labels = { running: "执行中", completed: "已完成", failed: "执行未成功", denied: "未获得权限" };
  const status = normalizedToolStatus(tool);
  card.className = `tool-card ${status}`;
  card.replaceChildren();
  const icon = document.createElement("span");
  icon.className = "tool-icon";
  icon.textContent = status === "completed" ? "✓" : ["failed", "denied"].includes(status) ? "!" : "⋯";
  const description = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = friendlyToolName(tool.name);
  const state = document.createElement("small");
  state.textContent = labels[status] || "处理中";
  description.append(title, state);
  const detail = toolDisplayDetail(tool);
  if (detail) {
    const detailBox = document.createElement("pre");
    detailBox.className = "tool-detail";
    detailBox.textContent = detail;
    detailBox.title = detail;
    description.append(detailBox);
  }
  card.append(icon, description);
  if (status === "denied") {
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = automaticTools ? "权限已开启，请重试" : "允许工具";
    action.addEventListener("click", async () => {
      if (automaticTools) {
        setConnection("自动执行权限已经开启，请重新发送刚才的要求", "connected");
        focusPrompt(true);
        return;
      }
      if (await changeToolMode(true)) {
        action.textContent = "权限已开启，请重试";
        setConnection("已允许自动执行工具，请重新发送刚才的要求", "connected");
      }
    });
    card.append(action);
  }
}

function normalizedToolStatus(tool) {
  if (tool?.status !== "denied") return tool?.status || "running";
  return tool.result === "未获得执行权限" ? "denied" : "failed";
}

function refreshDeniedToolActions() {
  document.querySelectorAll(".tool-card.denied button").forEach((button) => {
    button.textContent = automaticTools ? "权限已开启，请重试" : "允许工具";
  });
}

function finalizeToolList(item, tools) {
  const list = item.querySelector(".tool-list");
  if (!list || !tools.length) return;
  list.querySelector(".tool-summary")?.remove();
  const denied = tools.filter((tool) => normalizedToolStatus(tool) === "denied").length;
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = `tool-summary${denied ? " needs-permission" : ""}`;
  const label = () => denied ? `⚠ ${denied} 项操作需要权限` : `✓ 已执行 ${tools.length} 个操作`;
  summary.textContent = `${label()} · 查看详情`;
  summary.addEventListener("click", () => {
    const expanded = list.classList.toggle("expanded");
    summary.textContent = `${label()} · ${expanded ? "收起详情" : "查看详情"}`;
  });
  list.classList.add("finalized");
  list.prepend(summary);
}

function friendlyToolName(name) {
  return ({ Read: "读取文件", Write: "创建文件", Edit: "编辑文件", Bash: "运行命令", WebFetch: "读取网页", WebSearch: "搜索网页", Glob: "查找文件", Grep: "搜索内容" })[name] || `使用工具：${name || "未知"}`;
}

function toolDisplayDetail(tool) {
  const input = tool?.input || {};
  const value = ({
    Bash: input.command,
    Read: input.file_path,
    Write: input.file_path,
    Edit: input.file_path,
    NotebookEdit: input.notebook_path,
    WebFetch: input.url,
    WebSearch: input.query,
    Glob: [input.path, input.pattern].filter(Boolean).join("  →  "),
    Grep: [input.path, input.pattern].filter(Boolean).join("  →  ")
  })[tool?.name] || input.description || input.prompt || input.path || "";
  return String(value || "").trim();
}

function renderReturnedFiles(item, files = []) {
  item.querySelector(".returned-files")?.remove();
  if (!files.length) return;
  const list = document.createElement("div");
  list.className = "returned-files";
  files.forEach((file) => {
    const card = document.createElement("div");
    card.className = "returned-file";
    if (file.isImage) {
      const preview = document.createElement("img");
      preview.alt = file.name;
      preview.className = "remote-image loading";
      window.claudeNas.previewRemoteFile(file).then((source) => {
        preview.src = source;
        preview.classList.remove("loading");
      }).catch(() => { preview.classList.add("failed"); preview.alt = "图片预览加载失败，可保存后查看"; });
      card.append(preview);
    }
    const details = document.createElement("div");
    details.className = "file-details";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const size = document.createElement("small");
    size.textContent = formatBytes(file.size);
    details.append(name, size);
    const actions = document.createElement("div");
    actions.className = "file-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "另存为";
    save.addEventListener("click", () => runFileAction(save, () => window.claudeNas.saveRemoteFile(file)));
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "打开";
    open.addEventListener("click", () => runFileAction(open, () => window.claudeNas.openRemoteFile(file)));
    actions.append(save, open);
    card.append(details, actions);
    list.append(card);
  });
  item.append(list);
}

function renderSentAttachments(item, files = [], names = []) {
  if (!files.length && !names.length) return;
  const list = document.createElement("div");
  list.className = "sent-files";
  if (files.length) {
    files.forEach((file) => {
      if (file.type.startsWith("image/")) {
        const image = document.createElement("img");
        image.alt = file.name;
        image.className = "sent-image";
        const source = URL.createObjectURL(file);
        image.src = source;
        image.addEventListener("load", () => URL.revokeObjectURL(source), { once: true });
        list.append(image);
      }
      const chip = document.createElement("span");
      chip.textContent = `📎 ${file.name}`;
      list.append(chip);
    });
  } else {
    names.forEach((name) => {
      const chip = document.createElement("span");
      chip.textContent = `📎 ${name}`;
      list.append(chip);
    });
  }
  item.append(list);
}

async function runFileAction(button, action) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中…";
  try { await action(); }
  catch (error) { alert(error.message); }
  finally { button.disabled = false; button.textContent = original; }
}

function formatBytes(size) {
  if (!Number.isFinite(size)) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshConversationList() {
  conversationCache = await window.claudeNas.listConversations();
  const query = elements.conversationSearch.value.trim().toLocaleLowerCase();
  const conversations = query
    ? conversationCache.filter((conversation) => conversation.title.toLocaleLowerCase().includes(query))
    : conversationCache;
  elements.historyCount.textContent = query ? `${conversations.length}/${conversationCache.length}` : String(conversationCache.length);
  elements.conversationList.replaceChildren();
  conversations.forEach((conversation) => {
    const row = document.createElement("div");
    row.className = "conversation-row" + (conversation.id === conversationId ? " active" : "");
    const button = document.createElement("button");
    button.className = "conversation-item";
    button.textContent = conversation.title;
    button.title = conversation.title;
    button.addEventListener("click", () => loadConversation(conversation.id));
    const menu = document.createElement("button");
    menu.className = "conversation-menu";
    menu.type = "button";
    menu.title = "对话操作";
    menu.textContent = "⋯";
    menu.addEventListener("click", (event) => showConversationMenu(event, conversation));
    row.append(button, menu);
    elements.conversationList.append(row);
  });
  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = query ? "没有匹配的对话" : "还没有历史对话";
    elements.conversationList.append(empty);
  }
}

function showConversationMenu(event, conversation) {
  document.querySelector(".conversation-popover")?.remove();
  const popover = document.createElement("div");
  popover.className = "conversation-popover";
  const rename = document.createElement("button");
  rename.textContent = "重命名";
  rename.addEventListener("click", async () => {
    const title = prompt("输入新的对话名称", conversation.title);
    if (title === null) return;
    try { await window.claudeNas.renameConversation(conversation.id, title); await refreshConversationList(); }
    catch (error) { alert(error.message); }
  });
  const archive = document.createElement("button");
  archive.textContent = "打开存档";
  archive.addEventListener("click", async () => {
    try { await window.claudeNas.showConversationArchive(conversation.id); popover.remove(); }
    catch (error) { alert(error.message); }
  });
  const remove = document.createElement("button");
  remove.className = "danger";
  remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    if (!confirm(`确定删除“${conversation.title}”吗？此操作只删除本机聊天记录，NAS 文件不会删除。`)) return;
    await window.claudeNas.deleteConversation(conversation.id);
    popover.remove();
    if (conversation.id === conversationId) {
      const remaining = await window.claudeNas.listConversations();
      if (remaining.length) await loadConversation(remaining[0].id);
      else await createNewConversation();
    } else await refreshConversationList();
  });
  popover.append(rename, archive, remove);
  event.currentTarget.closest(".conversation-row").append(popover);
  const close = (click) => {
    if (!popover.contains(click.target) && click.target !== event.currentTarget) {
      popover.remove();
      document.removeEventListener("click", close, true);
    }
  };
  setTimeout(() => document.addEventListener("click", close, true));
}

async function loadConversation(id) {
  if (activeId) return;
  const conversation = await window.claudeNas.getConversation(id);
  if (!conversation) return;
  conversationId = conversation.id;
  sessionId = conversation.sessionId || "";
  attachments = [];
  renderAttachments();
  elements.messages.replaceChildren();
  conversation.messages.forEach((message) => {
    const item = addMessage(message.role, message.text);
    if (message.role === "user") renderSentAttachments(item, [], message.attachmentNames || []);
    if (message.role === "assistant") {
      if (message.draft) {
        item.classList.add("interrupted");
        const note = document.createElement("div");
        note.className = "draft-note";
        note.textContent = "未完成的回复 · 已自动保存";
        item.prepend(note);
      }
      (message.tools || []).forEach((tool) => renderTool(item, tool));
      finalizeToolList(item, message.tools || []);
      renderReturnedFiles(item, message.files || []);
      renderAssistant(item, message.text);
    }
  });
  elements.empty.hidden = conversation.messages.length > 0;
  setConnection(sessionId ? `已恢复${currentConnectionMode === "local" ? "本机" : " SSH"} Claude 会话` : "新对话，等待发送", "connected");
  refreshConversationList();
}

async function createNewConversation() {
  if (activeId) return;
  const conversation = await window.claudeNas.createConversation();
  await loadConversation(conversation.id);
  elements.prompt.focus();
}

function setConnection(text, state) {
  elements.stateText.textContent = text;
  elements.stateDot.className = state || "";
}

function focusPrompt(force = false) {
  if (elements.dialog.open || elements.prompt.disabled || !document.hasFocus()) return;
  const active = document.activeElement;
  const hasNeutralFocus = !active || active === document.body || active === document.documentElement || active === elements.composer;
  if (force || hasNeutralFocus || active === elements.prompt) {
    elements.prompt.focus({ preventScroll: true });
  }
}

function setBusy(busy) {
  elements.send.disabled = false;
  elements.send.classList.toggle("busy", busy);
  elements.send.classList.remove("stopping");
  elements.send.title = busy ? "停止生成（Esc）" : "发送";
  elements.send.setAttribute("aria-label", busy ? "停止生成，或按 Escape" : "发送消息");
  elements.composer.classList.toggle("busy", busy);
  elements.composer.setAttribute("aria-busy", String(busy));
}

function stopActiveMessage() {
  if (!activeId || elements.send.classList.contains("stopping")) return;
  elements.send.classList.add("stopping");
  elements.send.disabled = true;
  elements.send.title = "正在停止…";
  window.claudeNas.cancelMessage(activeId);
}

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  elements.attachmentList.hidden = attachments.length === 0;
  attachments.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const name = document.createElement("span");
    name.textContent = `📎 ${file.name}`;
    name.title = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "移除此附件";
    remove.textContent = "×";
    remove.addEventListener("click", () => { attachments.splice(index, 1); renderAttachments(); });
    chip.append(name, remove);
    elements.attachmentList.append(chip);
  });
}

function addFiles(files) {
  const permitted = [...files].filter((file) => {
    if (file.size > 30 * 1024 * 1024) { alert(`${file.name} 超过 30 MB，未添加。`); return false; }
    return true;
  });
  attachments = attachments.concat(permitted).slice(0, 10);
  renderAttachments();
  requestAnimationFrame(() => focusPrompt(true));
}

function adjustTextarea() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = Math.min(elements.prompt.scrollHeight, 180) + "px";
}

async function openSettings() {
  setStatus("");
  populateSettings(await window.claudeNas.loadSettings());
  if (currentConnectionMode === "ssh") await refreshDeviceControlStatus();
  elements.dialog.showModal();
}

async function sendMessage() {
  const message = elements.prompt.value.trim();
  if ((!message && !attachments.length) || activeId) return;
  activeId = crypto.randomUUID();
  const userItem = addMessage("user", message);
  renderSentAttachments(userItem, attachments);
  const answer = addMessage("assistant generating");
  messages.set(activeId, answer);
  elements.prompt.value = "";
  adjustTextarea();
  setBusy(true);
  setConnection(currentConnectionMode === "local" ? "正在启动本机 Claude…" : "正在连接 NAS…", "");

  try {
    const preparedAttachments = await Promise.all(attachments.map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      data: await file.arrayBuffer()
    })));
    attachments = [];
    renderAttachments();
    const result = await window.claudeNas.sendMessage({
      id: activeId,
      message,
      sessionId,
      conversationId,
      attachments: preparedAttachments
    });
    if (result.cancelled) {
      answer.classList.remove("generating", "error");
      answer.classList.add("interrupted");
      const partial = result.text || answer.querySelector(".message-content").textContent;
      answer.querySelector(".message-content").textContent = partial
        ? `${partial}\n\n（已停止）`
        : "已停止。";
      setConnection(`${currentConnectionMode === "local" ? "本机 Agent" : "NAS"}已停止当前任务 · 连接正常`, "connected");
      return;
    }
    sessionId = result.sessionId || sessionId;
    const content = answer.querySelector(".message-content");
    if (!content.textContent && result.text) content.textContent = result.text;
    await renderAssistant(answer, result.text || content.textContent);
    (result.tools || []).forEach((tool) => renderTool(answer, tool));
    finalizeToolList(answer, result.tools || []);
    renderReturnedFiles(answer, result.files || []);
    answer.classList.remove("generating");
    setConnection(`${currentConnectionMode === "local" ? "本机 Claude" : "NAS"}已连接 · 会话已保存`, "connected");
    refreshConversationList();
  } catch (error) {
    answer.classList.remove("generating");
    answer.classList.add("error");
    answer.querySelector(".message-content").textContent = "连接或 Claude 执行失败：\n" + error.message;
    setConnection("连接失败", "error");
  } finally {
    messages.delete(activeId);
    activeId = "";
    setBusy(false);
    requestAnimationFrame(() => focusPrompt());
  }
}

document.querySelector("#show-settings").addEventListener("click", openSettings);
document.querySelector("#header-settings").addEventListener("click", openSettings);
document.querySelector("#close-settings").addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("close", async () => {
  try { populateSettings(await window.claudeNas.loadSettings()); }
  catch (error) { setConnection("重新读取设置失败：" + error.message, "error"); }
});
document.querySelector("#new-chat").addEventListener("click", createNewConversation);
elements.conversationSearch.addEventListener("input", refreshConversationList);
elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const saveButton = document.querySelector("#save-settings");
  const originalText = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = "正在保存和迁移…";
  try {
    const settings = await window.claudeNas.saveSettings(settingsFromForm());
    populateSettings(settings);
    await refreshConversationList();
    if (conversationId && conversationCache.some((item) => item.id === conversationId)) await loadConversation(conversationId);
    else if (conversationCache.length) await loadConversation(conversationCache[0].id);
    else await createNewConversation();
    elements.dialog.close();
    setConnection("设置已保存", "connected");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalText;
  }
});
document.querySelector("#test-connection").addEventListener("click", async () => {
  setStatus(currentConnectionMode === "local" ? "正在检查本机 Claude 命令…" : "正在连接并检查 Claude 命令…");
  try {
    const version = await window.claudeNas.testConnection(settingsFromForm());
    setStatus(`${currentConnectionMode === "local" ? "本机" : "SSH"}连接成功：Claude Code ${version}`);
  } catch (error) {
    setStatus(error.message, true);
  }
});
document.querySelector("#open-diagnostics").addEventListener("click", async () => {
  const path = await window.claudeNas.openDiagnostics();
  setStatus(`已打开日志位置：${path}`);
});
document.querySelector("#refresh-device-control").addEventListener("click", refreshDeviceControlStatus);
document.querySelector("#refresh-bridge").addEventListener("click", refreshBridgeStatus);
document.querySelector("#install-bridge").addEventListener("click", async () => {
  const button = document.querySelector("#install-bridge");
  button.disabled = true;
  setStatus("正在部署增强 Bridge 并安装其依赖…");
  try {
    const result = await window.claudeNas.installBridge();
    if (result.cancelled) setStatus("已取消部署。基础直连聊天不受影响。");
    else { renderBridgeStatus(result); setStatus("增强 Bridge 已安装并校验完成。"); }
  } catch (error) { setStatus(error.message, true); await refreshBridgeStatus(); }
  finally { button.disabled = false; }
});
document.querySelector("#uninstall-bridge").addEventListener("click", async () => {
  const button = document.querySelector("#uninstall-bridge");
  button.disabled = true;
  setStatus("正在移除增强 Bridge…");
  try {
    const result = await window.claudeNas.uninstallBridge();
    if (result.cancelled) setStatus("已取消移除。");
    else { renderBridgeStatus(result); setStatus("增强 Bridge 已移除；基础直连聊天仍可使用。"); }
  } catch (error) { setStatus(error.message, true); await refreshBridgeStatus(); }
  finally { button.disabled = false; }
});
document.querySelector("#install-device-control").addEventListener("click", async () => {
  const button = document.querySelector("#install-device-control");
  button.disabled = true;
  setStatus("正在准备联动密钥。确认 Windows 管理员授权后，安装会在后台继续，通常需要几十秒；请留在软件窗口等待结果。");
  try {
    const settings = await window.claudeNas.saveSettings(settingsFromForm());
    populateSettings(settings);
    const status = await window.claudeNas.installDeviceControl({
      sourceAddress: document.querySelector("#device-control-source").value,
      targetAddress: document.querySelector("#device-control-target").value,
      targetPort: document.querySelector("#device-control-port").value,
      permissionMode: document.querySelector("#device-control-permission").value
    });
    if (status.cancelled) setStatus("已取消安装，电脑没有被启用远程控制。", true);
    else {
      renderDeviceControlStatus(status);
      setStatus(status.probe?.ok
        ? "联动控件已安装，NAS 已使用专属密钥回连成功；员工不需要设置 Windows 密码。"
        : `联动控件已安装，但 NAS 回连测试失败：${status.probe?.error || "未知原因"}`, !status.probe?.ok);
    }
  } catch (error) {
    setStatus(error.message, true);
    await refreshDeviceControlStatus();
  } finally { button.disabled = false; }
});
document.querySelector("#uninstall-device-control").addEventListener("click", async () => {
  const button = document.querySelector("#uninstall-device-control");
  button.disabled = true;
  setStatus("正在卸载联动控件…");
  try {
    const status = await window.claudeNas.uninstallDeviceControl();
    if (status.cancelled) setStatus("已取消卸载。", true);
    else {
      renderDeviceControlStatus(status);
      setStatus("联动控件已卸载，Agent 已不能再通过该密钥连接本机。");
    }
  } catch (error) {
    setStatus(error.message, true);
    await refreshDeviceControlStatus();
  } finally { button.disabled = false; }
});
const passwordInput = elements.form.elements.namedItem("password");
document.querySelectorAll("[data-connection-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.form.elements.namedItem("connectionMode").value = button.dataset.connectionMode;
    updateConnectionModeUI();
  });
});
passwordInput.addEventListener("input", () => {
  document.querySelector("#password-hint").textContent = passwordInput.value
    ? `本次输入 ${[...passwordInput.value].length} 个字符，请确认没有重复`
    : "留空则保留已保存的密码";
});
document.querySelector("#toggle-password").addEventListener("click", () => {
  const visible = passwordInput.type === "text";
  passwordInput.type = visible ? "password" : "text";
  document.querySelector("#toggle-password").textContent = visible ? "显示" : "隐藏";
  passwordInput.focus();
});
document.querySelector("#choose-directory").addEventListener("click", async () => {
  const selected = await window.claudeNas.chooseStorageDirectory();
  if (selected) elements.form.elements.namedItem("dataDirectory").value = selected;
});
document.querySelector("#open-directory").addEventListener("click", async () => {
  try {
    await window.claudeNas.openStorageDirectory(elements.form.elements.namedItem("dataDirectory").value);
  } catch (error) {
    setStatus(error.message, true);
  }
});
document.querySelector("#open-archive").addEventListener("click", async () => {
  try {
    const path = await window.claudeNas.openArchiveDirectory();
    setStatus(`已打开会话存档：${path}`);
  } catch (error) {
    setStatus(error.message, true);
  }
});
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (activeId) stopActiveMessage();
  else sendMessage();
});
elements.composer.addEventListener("click", (event) => {
  if (event.target === elements.composer) focusPrompt(true);
});
elements.prompt.addEventListener("input", adjustTextarea);
document.querySelector("#attach").addEventListener("click", () => elements.filePicker.click());
elements.toolMode.addEventListener("click", async () => {
  try { await changeToolMode(!automaticTools); }
  catch (error) {
    setConnection("工具权限切换失败：" + error.message, "error");
    focusPrompt(true);
  }
});
elements.filePicker.addEventListener("change", () => { addFiles(elements.filePicker.files); elements.filePicker.value = ""; });
elements.composer.addEventListener("dragover", (event) => event.preventDefault());
elements.composer.addEventListener("drop", (event) => { event.preventDefault(); addFiles(event.dataTransfer.files); });
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !activeId) { event.preventDefault(); sendMessage(); }
});
window.addEventListener("focus", () => requestAnimationFrame(() => focusPrompt()));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestAnimationFrame(() => focusPrompt());
});
window.claudeNas.onDelta(({ id, text }) => {
  const answer = messages.get(id);
  if (!answer) return;
  answer.querySelector(".message-content").textContent += text;
  elements.messages.scrollTop = elements.messages.scrollHeight;
});
window.claudeNas.onChatEvent((event) => {
  const answer = messages.get(event.id);
  if (event.type === "upload") {
    setConnection(`正在上传 ${event.name} · ${Math.round(event.overall * 100)}%`, "");
  } else if (event.type === "connection") {
    const labels = currentConnectionMode === "local"
      ? { "local-starting": "正在启动本机 Claude…", connected: "本机 Claude 正在处理…" }
      : { connecting: "正在连接 NAS…", reconnecting: "连接中断，正在自动重连…", connected: "已连接，Claude 正在处理…", stopping: "Claude 已收到停止请求，正在结束当前操作…" };
    setConnection(labels[event.status] || "正在处理…", event.status === "connected" ? "connected" : "");
  } else if (event.type === "tool" && answer) {
    renderTool(answer, event.tool);
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }
});
async function runAppAction(action) {
  if (action === "new-chat") await createNewConversation();
  else if (action === "settings") await openSettings();
  else if (action === "archive") {
    try { await window.claudeNas.openArchiveDirectory(); }
    catch (error) { alert(error.message); }
  } else if (action === "diagnostics") {
    try { await window.claudeNas.openDiagnostics(); }
    catch (error) { alert(error.message); }
  }
}

function closeAppMenus(except) {
  document.querySelectorAll(".menu-group.open").forEach((group) => {
    if (group !== except) group.classList.remove("open");
  });
}

document.querySelectorAll(".menu-trigger").forEach((trigger) => {
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const group = trigger.closest(".menu-group");
    const opening = !group.classList.contains("open");
    closeAppMenus(group);
    group.classList.toggle("open", opening);
  });
});
document.querySelectorAll("[data-window-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    closeAppMenus();
    await window.claudeNas.windowAction(button.dataset.windowAction);
  });
});
document.querySelectorAll("[data-app-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    closeAppMenus();
    await runAppAction(button.dataset.appAction);
  });
});
document.addEventListener("click", () => closeAppMenus());
document.querySelector(".titlebar").addEventListener("dblclick", (event) => {
  if (!event.target.closest("button, nav")) window.claudeNas.windowAction("toggle-maximize");
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    runAppAction("new-chat");
  }
  if (event.key === "Escape") {
    closeAppMenus();
    if (activeId) {
      event.preventDefault();
      stopActiveMessage();
    }
  }
});

function setMaximized(maximized) {
  document.body.classList.toggle("maximized", Boolean(maximized));
  const button = document.querySelector("#maximize-window");
  button.classList.toggle("is-restoring", Boolean(maximized));
  button.title = maximized ? "还原" : "最大化";
  button.setAttribute("aria-label", maximized ? "还原" : "最大化");
}

window.claudeNas.onMenuAction(runAppAction);
window.claudeNas.onWindowMaximized(setMaximized);

// ── 模式选择器 ──────────────────────────────────

let currentModeId = "regular";
let modeDropdownOpen = false;

function closeModeDropdown() {
  modeDropdownOpen = false;
  document.querySelector("#mode-dropdown").hidden = true;
}

async function refreshModeSelector() {
  try {
    const modes = await window.claudeNas.listModes();
    const list = document.querySelector("#mode-list");
    list.replaceChildren();
    for (const mode of modes) {
      const item = document.createElement("div");
      item.className = `mode-item${mode.id === currentModeId ? " active" : ""}`;
      item.innerHTML = `<span class="mode-item-icon">${mode.icon}</span><div class="mode-item-info"><span class="mode-item-name">${mode.name}</span><span class="mode-item-desc">${mode.description}</span></div>`;
      item.addEventListener("click", async () => {
        currentModeId = mode.id;
        updateModeDisplay(mode);
        // 保存到设置
        try {
          const settings = await window.claudeNas.saveSettings({ ...(await window.claudeNas.loadSettings()), workModeId: mode.id });
          populateSettings(settings);
        } catch (error) { setConnection("模式切换失败：" + error.message, "error"); }
        closeModeDropdown();
      });
      list.append(item);
    }
  } catch (error) { console.error("Failed to load modes:", error); }
}

function updateModeDisplay(mode) {
  document.querySelector("#mode-icon").textContent = mode.icon;
  document.querySelector("#mode-name").textContent = mode.name;
  document.querySelector("#mode-trigger").title = `${mode.name}：${mode.description}`;
  setToolModeAppearance(mode.skipPermissions);
}

document.querySelector("#mode-trigger").addEventListener("click", (event) => {
  event.stopPropagation();
  modeDropdownOpen = !modeDropdownOpen;
  document.querySelector("#mode-dropdown").hidden = !modeDropdownOpen;
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".mode-selector")) closeModeDropdown();
});

document.querySelector("#mode-edit").addEventListener("click", async () => {
  closeModeDropdown();
  // TODO: 模式编辑弹窗（P6 后续完善）
  alert("自定义模式编辑功能开发中…");
});

document.querySelector("#mode-import").addEventListener("click", async () => {
  closeModeDropdown();
  try {
    const json = prompt("粘贴导出的模式 JSON：");
    if (!json) return;
    const result = await window.claudeNas.importModes(json);
    await refreshModeSelector();
    setConnection(`导入成功：新增 ${result.added} 个模式`, "connected");
  } catch (error) { alert("导入失败：" + error.message); }
});

document.querySelector("#mode-export").addEventListener("click", async () => {
  closeModeDropdown();
  try {
    const json = await window.claudeNas.exportModes();
    await navigator.clipboard.writeText(json);
    alert("自定义模式已复制到剪贴板。");
  } catch (error) { alert("导出失败：" + error.message); }
});

// ── 网络配置 UI ─────────────────────────────────

function updateNetworkModeUI() {
  const mode = document.querySelector("#network-type").value;
  const isExternal = mode === "external";
  document.querySelector("#mode-internal").classList.toggle("active", !isExternal);
  document.querySelector("#mode-external").classList.toggle("active", isExternal);
  document.querySelector("#external-fields").hidden = !isExternal;
  updateExternalMethodUI();
}

function updateExternalMethodUI() {
  const method = document.querySelector("#external-method").value;
  document.querySelector("#frp-config").hidden = method !== "frp";
  document.querySelector("#derp-config").hidden = method !== "derp";
  document.querySelector("#p2p-config").hidden = method !== "p2p";
  document.querySelector("#n2n-config").hidden = method !== "n2n";
  // FRP 参数在 auto 或 frp 时显示
  if (method === "auto") {
    document.querySelector("#frp-config").hidden = false;
    document.querySelector("#derp-config").hidden = false;
  }
}

function populateNetworkSettings(settings) {
  document.querySelector("#network-type").value = settings.networkType || "internal";
  document.querySelector("#external-method").value = settings.externalMethod || "auto";
  if (settings.frp) {
    document.querySelector("#frp-server-addr").value = settings.frp.serverAddr || "";
    document.querySelector("#frp-server-port").value = settings.frp.serverPort || 7000;
    document.querySelector("#frp-local-port").value = settings.frp.localPort || 22;
    document.querySelector("#frp-token").value = settings.frp.token || "";
  }
  if (settings.derp) {
    document.querySelector("#derp-relay-addr").value = settings.derp.relayAddr || "";
    document.querySelector("#derp-relay-port").value = settings.derp.relayPort || 3478;
    document.querySelector("#derp-auth-key").value = settings.derp.authKey || "";
  }
  if (settings.p2p) {
    document.querySelector("#p2p-stun-addr").value = settings.p2p.stunAddr || "stun.l.google.com";
    document.querySelector("#p2p-stun-port").value = settings.p2p.stunPort || 19302;
  }
  if (settings.n2n) {
    document.querySelector("#n2n-supernode-addr").value = settings.n2n.supernodeAddr || "";
    document.querySelector("#n2n-supernode-port").value = settings.n2n.supernodePort || 7777;
    document.querySelector("#n2n-community").value = settings.n2n.community || "";
    document.querySelector("#n2n-key").value = settings.n2n.key || "";
  }
  if (settings.accessPassword) {
    document.querySelector("#access-password").placeholder = "已设置访问密码；留空不修改";
  }
  updateNetworkModeUI();
}

function networkSettingsFromForm() {
  return {
    frp: {
      serverAddr: document.querySelector("#frp-server-addr").value,
      serverPort: Number(document.querySelector("#frp-server-port").value) || 7000,
      localPort: Number(document.querySelector("#frp-local-port").value) || 22,
      token: document.querySelector("#frp-token").value
    },
    derp: {
      relayAddr: document.querySelector("#derp-relay-addr").value,
      relayPort: Number(document.querySelector("#derp-relay-port").value) || 3478,
      authKey: document.querySelector("#derp-auth-key").value
    },
    p2p: {
      stunAddr: document.querySelector("#p2p-stun-addr").value,
      stunPort: Number(document.querySelector("#p2p-stun-port").value) || 19302
    },
    n2n: {
      supernodeAddr: document.querySelector("#n2n-supernode-addr").value,
      supernodePort: Number(document.querySelector("#n2n-supernode-port").value) || 7777,
      community: document.querySelector("#n2n-community").value,
      key: document.querySelector("#n2n-key").value
    },
    accessPassword: document.querySelector("#access-password").value
  };
}

document.querySelectorAll("[data-network-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector("#network-type").value = button.dataset.networkMode;
    updateNetworkModeUI();
  });
});

document.querySelector("#external-method").addEventListener("change", updateExternalMethodUI);

document.querySelector("#toggle-access-password").addEventListener("click", () => {
  const input = document.querySelector("#access-password");
  const visible = input.type === "text";
  input.type = visible ? "password" : "text";
  document.querySelector("#toggle-access-password").textContent = visible ? "显示" : "隐藏";
  input.focus();
});

// ── 网络状态更新 ──────────────────────────────────

function updateNetworkStatus(status) {
  const modeLabel = document.querySelector("#network-mode-label");
  const latencyLabel = document.querySelector("#network-latency-label");
  const networkInfo = document.querySelector("#network-info");

  const modeLabels = {
    "ssh-direct": "内网直连",
    "p2p-nat": "P2P 打洞",
    "derp-relay": "DERP 中继",
    "frp-tunnel": "FRP 穿透",
    "n2n-mesh": "N2N 虚拟局域网"
  };

  if (status.state === "connected" || status.state === "degraded") {
    networkInfo.hidden = false;
    modeLabel.textContent = modeLabels[status.type] || status.mode || "已连接";
    if (status.latencyMs !== null) {
      latencyLabel.textContent = `${status.latencyMs}ms`;
      latencyLabel.className = status.latencyMs < 50 ? "quality-excellent" : status.latencyMs < 150 ? "quality-good" : status.latencyMs < 300 ? "quality-fair" : "quality-poor";
    } else {
      latencyLabel.textContent = "";
      latencyLabel.className = "";
    }
  } else {
    networkInfo.hidden = true;
  }
}

window.claudeNas.onNetworkStatusChange((event) => {
  updateNetworkStatus(networkManager.getStatus());
});

window.claudeNas.onNetworkLatency((summary) => {
  const latencyLabel = document.querySelector("#network-latency-label");
  if (latencyLabel) {
    latencyLabel.textContent = `${summary.avgLatency}ms · ${summary.label}`;
    latencyLabel.className = `quality-${Object.entries({ excellent: 90, good: 70, fair: 50 }).find(([, v]) => summary.quality >= v)?.[0] || "poor"}`;
  }
});

(async () => {
  setMaximized(await window.claudeNas.isWindowMaximized());
  const settings = await window.claudeNas.loadSettings();
  populateSettings(settings);
  // 初始化模式选择器
  currentModeId = settings.workModeId || "regular";
  await refreshModeSelector();
  const currentMode = await window.claudeNas.getMode(currentModeId);
  if (currentMode) updateModeDisplay(currentMode);
  // 初始化网络配置
  populateNetworkSettings(settings);
  const conversations = await window.claudeNas.listConversations();
  if (conversations.length) await loadConversation(conversations[0].id);
  else await createNewConversation();
  if (!settings.wakeName || (settings.connectionMode !== "local" && (!settings.host || !settings.username || !settings.hasPassword))) openSettings();
})();
