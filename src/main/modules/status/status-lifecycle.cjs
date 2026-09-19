"use strict";

const TERMINAL_STATUSES = new Set(["finished", "failed", "cancelled"]);

function isTerminalLifecycle(status) {
  return TERMINAL_STATUSES.has(status);
}

module.exports = { isTerminalLifecycle };
