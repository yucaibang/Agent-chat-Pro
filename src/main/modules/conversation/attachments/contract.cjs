"use strict";

/**
 * 附件规范 — 定义附件的限制常量和工具函数。
 */

const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_ATTACHMENT_PREVIEW_BYTES = 900 * 1024;  // 900 KB 预览图上限
const SAFE_IMAGE_PATTERN = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

function attachmentNames(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((a) => a?.name || "未命名文件");
}

function attachmentPreviews(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a) => a?.preview && SAFE_IMAGE_PATTERN.test(a.preview))
    .map((a) => a.preview);
}

module.exports = {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_PREVIEW_BYTES,
  SAFE_IMAGE_PATTERN,
  attachmentNames,
  attachmentPreviews
};