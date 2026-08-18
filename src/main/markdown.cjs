"use strict";

const { marked } = require("marked");
const sanitizeHtml = require("sanitize-html");

function renderMarkdown(source) {
  const html = marked.parse(String(source || ""), { gfm: true, breaks: true });
  return sanitizeHtml(html, {
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
  });
}

module.exports = { renderMarkdown };
