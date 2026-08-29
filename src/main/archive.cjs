"use strict";

function archiveFileName(title, createdAt, conversationId = "") {
  const cleaned = String(title || "新对话")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80) || "新对话";
  const firstSegment = cleaned.split(".")[0];
  const safeTitle = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(firstSegment) ? `_${cleaned}` : cleaned;
  const suffix = String(conversationId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8);
  return `${safeTitle}_${localTimestamp(createdAt)}${suffix ? `_${suffix}` : ""}.md`;
}

function archiveMarkdown(conversation) {
  const lines = [
    `# ${conversation.title || "新对话"}`,
    "",
    `- 创建时间：${displayTime(conversation.createdAt)}`,
    `- 最后更新：${displayTime(conversation.updatedAt)}`,
    `- 会话编号：\`${conversation.id || ""}\``,
    (conversation.sshSessionId || (conversation.lastConnectionMode !== "local" && conversation.sessionId)) ? `- SSH Claude 会话：\`${conversation.sshSessionId || conversation.sessionId}\`` : "- SSH Claude 会话：尚未建立",
    conversation.localSessionId ? `- 本机 Claude 会话：\`${conversation.localSessionId}\`` : "- 本机 Claude 会话：尚未建立",
    "",
    "---",
    ""
  ];

  for (const message of conversation.messages || []) {
    const role = message.role === "assistant" ? "Claude" : "用户";
    lines.push(`## ${role} · ${displayTime(message.at)}`, "", String(message.text || ""), "");
    if (message.attachmentNames?.length) {
      lines.push("附件：", ...message.attachmentNames.map((name) => `- ${name}`), "");
    }
    if (message.tools?.length) {
      lines.push("工具执行：", ...message.tools.map((tool) => `- ${tool.name || "工具"}：${toolStatus(tool.status)}`), "");
    }
    if (message.files?.length) {
      lines.push("Claude 返回的文件：", ...message.files.map((file) => `- ${file.name || "文件"}（\`${file.localPath || file.remotePath || ""}\`）`), "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

function localTimestamp(value) {
  const date = validDate(value);
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-")
    + "_" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds()), String(date.getMilliseconds()).padStart(3, "0")].join("-");
}

function displayTime(value) {
  const date = validDate(value);
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function validDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function toolStatus(status) {
  return ({ running: "执行中", completed: "已完成", failed: "执行未成功", denied: "未获得权限" })[status] || status || "未知";
}

module.exports = { archiveFileName, archiveMarkdown, localTimestamp };