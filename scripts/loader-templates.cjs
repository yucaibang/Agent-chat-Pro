"use strict";

/**
 * Agent Chat Pro fallback loader 桥模板（v3.12.0）
 *
 * 独立模块（无副作用、可被测试 require）——build-pipeline.cjs step2 生成各 .cjs 的 loader 桥用。
 *
 * fallbackLoaderTemplate（有 .jsc）：
 *   同平台：require("./x.jsc") 成功 → 字节码直接生效。
 *   跨平台：.jsc 抛 cachedDataRejected → isCachedDataError 放行 → 解密 "./x.enc" 执行。
 *   其他错误（真 bug / MODULE_NOT_FOUND，如 .jsc 被删）原样抛出——防篡改从严，不静默降级。
 *
 * encOnlyLoaderTemplate（仅 .enc）：.jsc 编译失败/逃生门时的纯降级形态。
 */

function fallbackLoaderTemplate(cjsBasename) {
  const jscRef = `./${cjsBasename.replace(/\.cjs$/, ".jsc")}`;
  const encRef = `./${cjsBasename.replace(/\.cjs$/, ".enc")}`;
  return [
    `"use strict";`,
    `try {`,
    `  require("bytenode");`,
    `  module.exports = require("${jscRef}");`,
    `} catch (__e) {`,
    `  const __fb = require("./bytecode-fallback.cjs");`,
    `  if (!__fb.isCachedDataError(__e)) throw __e;`,
    `  module.exports = __fb.executeFallback(__filename, "${encRef}");`,
    `}`,
    ``,
  ].join("\n");
}

function encOnlyLoaderTemplate(cjsBasename) {
  const encRef = `./${cjsBasename.replace(/\.cjs$/, ".enc")}`;
  return [
    `"use strict";`,
    `module.exports = require("./bytecode-fallback.cjs").executeFallback(__filename, "${encRef}");`,
    ``,
  ].join("\n");
}

module.exports = { fallbackLoaderTemplate, encOnlyLoaderTemplate };