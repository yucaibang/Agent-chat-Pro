"use strict";

// marked 和 sanitize-html 均为纯 ESM 或依赖链含 ESM-only 包，
// 不能使用顶层 require()，改为动态 import + Promise 缓存。

let markedPromise = null;
async function loadMarked() {
  if (!markedPromise) markedPromise = import("marked").then((mod) => mod.marked || mod);
  return markedPromise;
}

let sanitizePromise = null;
async function loadSanitize() {
  if (!sanitizePromise) sanitizePromise = import("sanitize-html").then((mod) => mod.default || mod);
  return sanitizePromise;
}

const SANITIZE_OPTIONS = {
  allowedTags: [
    "p", "br", "strong", "em", "del", "blockquote", "ul", "ol", "li",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "pre", "code", "table",
    "thead", "tbody", "tr", "th", "td", "a", "kbd", "details", "summary"
  ],
  allowedAttributes: { a: ["href", "title"], code: ["class"] },
  allowedSchemes: ["http", "https"],
  transformTags: {
    a: (_tag, attrs) => ({ tagName: "a", attribs: { href: attrs.href || "", title: attrs.title || "" } })
  }
};

async function renderMarkdown(source) {
  const [marked, sanitizeHtml] = await Promise.all([loadMarked(), loadSanitize()]);
  const html = marked.parse(String(source || ""), { gfm: true, breaks: true });
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

module.exports = { renderMarkdown };