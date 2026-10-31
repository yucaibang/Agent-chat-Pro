"use strict";
/**
 * v3.21.2 测试 — TDZ 原源码级修复 + 作用域树守门
 *
 * 背景：v3.21.1 修复（关混淆 controlFlowFlattening/deadCodeInjection）后装机仍炸
 *   chat:send ReferenceError: Cannot access '_0x27f1ac' before initialization——
 *   深挖实锤：这次不是混淆——是原源码 v3.19.0 F3 引入的 TDZ bug：
 *   main.cjs chat:send handler 内云端分支（在前）的 runCloudWithTools 引用
 *   `config.advancedEffective?.cloud`，而 `const config = getConnection()` 声明
 *   在云端分支之后（SSH/本机模式开头）→ 云端路径 return 后声明永不执行 → TDZ。
 *   v3.19.0/v3.20.0 装机没炸纯属混淆器洗牌（CF）恰好把声明排前的侥幸掩护。
 *
 * 覆盖：
 *   A. TDZ 作用域树全量扫描（52 模块）——修复点 config 消失 + 白名单名字集合快照
 *   B. 云端块专项断言（本事故形态 = 0 命中）
 *   C. 混淆双开关永久禁用守门（v3.21.1 铁闸续守）
 *   D. 防线接线（obf-smoke + build-pipeline）
 *   E. 版本 3.21.2
 *   F. 历史测试复跑
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const acorn = require("acorn");
const { execFileSync } = require("child_process");
const { OBFUSCATE_FILES } = require("./scripts/obfuscate.cjs");

const ROOT = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let passed = 0, failed = 0;
const failures = [];
const test = (name, fn) => Promise.resolve().then(fn)
  .then(() => { passed += 1; console.log(`  ✓ ${name}`); })
  .catch((e) => { failed += 1; failures.push(`  ✗ ${name}\n    ${e.message}`); console.log(`  ✗ ${name}`); });

// ── TDZ 作用域树扫描器（遮蔽感知）──
const FN = (n) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";
const collectIds = (n) => {
  const out = [];
  (function w(x) {
    if (!x || typeof x !== "object") return;
    if (x.type === "Identifier") out.push(x);
    for (const k of Object.keys(x)) { const v = x[k]; if (v && typeof v === "object") (Array.isArray(v) ? v : [v]).forEach(w); }
  })(n);
  return out;
};

/**
 * 扫描 src：返回「引用解析到声明在引用之后」的全命中
 * [{ name, use, decl, kind, crossFn }]——crossFn = 引用与声明作用域之间跨了 ≥1 个函数层级
 */
function scanTdz(src) {
  const ast = acorn.parse(src, { ecmaVersion: "latest" });
  const parent = new Map();
  (function wp(n, p) {
    if (!n || typeof n.type !== "string") return;
    parent.set(n, p);
    for (const k of Object.keys(n)) {
      if (k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(c => c && typeof c.type === "string" && wp(c, n));
      else if (v && typeof v.type === "string") wp(v, n);
    }
  })(ast, null);

  // 作用域树：Program/函数/块都是 scope；var/function 提升、const/let 就近
  const scopeOf = new Map(); // node → scope
  const makeScope = (node, kind, par) => { const s = { node, kind, parent: par, binds: new Map() }; scopeOf.set(node, s); return s; };
  let findings = [];
  (function build(node, s) {
    let cur = s;
    if (node.type === "Program") cur = makeScope(node, "program", s);
    else if (FN(node)) { cur = makeScope(node, "function", s); for (const p of (node.params || [])) for (const id of collectIds(p)) cur.binds.set(id.name, { pos: node.start, kind: "param" }); }
    else if (node.type === "BlockStatement") cur = makeScope(node, "block", s);
    else if (node.type === "CatchClause") {
      // catch param 的作用域 = catch body（独立块 scope）——不同 catch 的同名 param 隔离绑定
      cur = makeScope(node.body, "block", cur);
      if (node.param) for (const id of collectIds(node.param)) cur.binds.set(id.name, { pos: node.start, kind: "catch-param" });
    }
    if (node.type === "VariableDeclaration") {
      let t = cur;
      if (node.kind === "var") { while (t && t.kind === "block") t = t.parent; }
      for (const d of node.declarations) for (const id of collectIds(d.id)) if (t) t.binds.set(id.name, { pos: id.start, kind: node.kind });
    }
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) if (cur) cur.binds.set(node.id.name, { pos: node.start, kind: "decl" });
    for (const k of Object.keys(node)) {
      if (k === "start" || k === "end") continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(c => c && typeof c.type === "string" && build(c, cur));
      else if (v && typeof v.type === "string") build(v, cur);
    }
  })(ast, null);

  // node 祖先链中最近的 scope
  const nearestScope = (node) => {
    let anc = node;
    while (anc && !scopeOf.get(anc)) anc = parent.get(anc);
    return anc ? scopeOf.get(anc) : null;
  };
  (function check(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "Identifier" && parent.has(n)) {
      const p = parent.get(n);
      const isKey = (p.type === "MemberExpression" && p.property === n && !p.computed) || (p.type === "Property" && p.key === n && !p.computed);
      const isDecl = (p.type === "VariableDeclarator" && p.id === n);
      if (!isKey && !isDecl) {
        let s = nearestScope(p), crossFn = 0;
        while (s) {
          if (s.binds.has(n.name)) {
            const b = s.binds.get(n.name);
            if (b.pos > n.start) findings.push({ name: n.name, use: n.start, decl: b.pos, kind: b.kind, crossFn });
            break;
          }
          if (s.kind === "function") crossFn += 1;
          s = s.parent;
        }
      }
    }
    for (const k of Object.keys(n)) {
      if (k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(c => c && typeof c.type === "string" && check(c));
      else if (v && typeof v.type === "string") check(v);
    }
  })(ast);
  findings.sort((a, b) => a.use - b.use);
  return findings;
}

async function main() {
  console.log("\n=== A. TDZ 作用域树全量扫描（52 模块） ===");

  await test("A1. main.cjs：config 引用已消失（修复点守门）", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/main/main.cjs"), "utf8");
    const hits = scanTdz(src).filter(h => h.name === "config");
    assert.strictEqual(hits.length, 0, hits.map(h => `use@${h.use}`).join(", "));
  });

  await test("A2. main.cjs：TDZ 风险白名单快照（已知 8 处合法形态，新名字 = 0）", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/main/main.cjs"), "utf8");
    const hits = scanTdz(src);
    const names = [...new Set(hits.map(h => h.name))].sort();
    const WHITE = ["executeCompact", "groupDeps", "lastKnownContext", "maybeAutoCompact", "statusCenter"].sort(); // v3.26.0 +groupDeps（群聊 handler 局部依赖构造器，先声明后用合法形态）
    assert.deepStrictEqual(names, WHITE, `main.cjs 出现非白名单 TDZ 形态：${names.join(",")}`);
    assert.strictEqual(hits.length, 8, `main.cjs 命中应为已知 8 处（v3.26.0 +groupDeps 1；statusCenter 1 + lastKnownContext 4 + maybeAutoCompact 1 + executeCompact 1），实际 ${hits.length}`);
  });

  await test("A3. 其余模块 TDZ 白名单快照（timer/socket/stream/responseTimer/signal-chain 合法形态；其余模块 0 命中）", () => {
    const WHITE = {
      "main/ssh.cjs": ["timer"],
      "main/network/derp-relay.cjs": ["socket"],
      "main/network/p2p-nat.cjs": ["socket"],
      "main/cloud-chat.cjs": ["responseTimer"],
      "main/adapters/ssh-cli-base.cjs": ["stream"],
      "main/modules/foundation/signal-contract/signal-chain.cjs": ["moduleId", "operation", "action", "opened"],
    };
    const others = [...OBFUSCATE_FILES.medium, "main/cloud-models.cjs"].filter(rel => !WHITE[rel] && rel !== "main/main.cjs");
    for (const rel of Object.keys(WHITE)) {
      const src = fs.readFileSync(path.join(ROOT, "src", rel), "utf8");
      const names = [...new Set(scanTdz(src).map(h => h.name))].sort();
      assert.deepStrictEqual(names, WHITE[rel].sort(), `${rel} 白名单漂移：${names.join(",")}`);
    }
    for (const rel of others) {
      const full = path.join(ROOT, "src", rel);
      if (!fs.existsSync(full)) continue;
      const hits = scanTdz(fs.readFileSync(full, "utf8"));
      assert.strictEqual(hits.length, 0, `${rel} 出现 TDZ 形态命中：${JSON.stringify(hits.slice(0, 3))}`);
    }
  });

  console.log("\n=== B. 云端块专项断言（本事故形态） ===");

  await test("B1. chat:send 云端块内不再引用「声明在云端块之后」的 handler 顶层变量", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/main/main.cjs"), "utf8");
    const ast = acorn.parse(src, { ecmaVersion: "latest" });
    const parent = new Map();
    (function wp(n, p) {
      if (!n || typeof n.type !== "string") return;
      parent.set(n, p);
      for (const k of Object.keys(n)) {
        if (k === "start" || k === "end") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(c => c && typeof c.type === "string" && wp(c, n));
        else if (v && typeof v.type === "string") wp(v, n);
      }
    })(ast, null);
    let cb = null;
    (function find(n) {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression"
        && n.callee.object && n.callee.object.name === "ipcMain" && n.callee.property && n.callee.property.name === "handle"
        && n.arguments[0] && n.arguments[0].value === "chat:send") cb = n.arguments[1];
      for (const k of Object.keys(n)) {
        if (k === "start" || k === "end") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(c => c && typeof c.type === "string" && find(c));
        else if (v && typeof v.type === "string") find(v);
      }
    })(ast);
    assert.ok(cb, "chat:send handler 在场");
    const cloudIf = cb.body.body.filter(s => s.type === "IfStatement").find(s => /runCloudWithTools/.test(src.slice(s.start, s.end)));
    assert.ok(cloudIf, "云端 if 块在场");
    // handler 顶层声明（在云端块之后声明）
    const later = [];
    for (const st of cb.body.body) if (st.type === "VariableDeclaration")
      for (const d of st.declarations) for (const id of collectIds(d.id)) if (st.start >= cloudIf.end) later.push(id.name);
    assert.ok(later.includes("config"), "config 声明在云端块之后（结构前提成立）");
    // 云端块内命中（用作用域树扫描 + 过滤 use ∈ 云端块）
    const hits = scanTdz(src).filter(h => h.use >= cloudIf.start && h.use < cloudIf.end && later.includes(h.name));
    assert.strictEqual(hits.length, 0, hits.map(h => `${h.name} use@${h.use}`).join(", ") || "无");
  });

  console.log("\n=== C. 混淆双开关守门（v3.21.1 铁闸续守） ===");

  await test("C1. obfuscate.cjs medium/light 两开关恒 false", () => {
    const s = fs.readFileSync(path.join(ROOT, "scripts/obfuscate.cjs"), "utf8");
    for (const cfg of ["light", "medium"]) {
      const start = s.indexOf(`${cfg}: {`);
      const block = s.slice(start, s.indexOf("},", start));
      assert.ok(/controlFlowFlattening:\s*false/.test(block), `${cfg}.controlFlowFlattening`);
      assert.ok(/deadCodeInjection:\s*false/.test(block), `${cfg}.deadCodeInjection`);
    }
  });

  console.log("\n=== D. 防线接线 ===");

  await test("D1. obf-smoke 在场 + build-pipeline step1 挂载", () => {
    assert.ok(fs.existsSync(path.join(ROOT, "scripts/obf-smoke.cjs")), "obf-smoke.cjs");
    const s = fs.readFileSync(path.join(ROOT, "scripts/build-pipeline.cjs"), "utf8");
    assert.ok(s.includes('run("node scripts/obf-smoke.cjs")'), "step1 冒烟接线");
    assert.ok(s.indexOf("obf-smoke.cjs") > s.indexOf("obfuscate.cjs obfuscate"), "冒烟在混淆后");
  });

  console.log("\n=== E. 版本 ===");

  await test("E1. package.json 版本为 semver 形态（v3.21.3 起按先例放宽不写死——版本升级后历史测试仍需全绿）", () => {
    assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `version=${pkg.version}`);
    console.log("  （当前版本：" + pkg.version + "）");
  });

  console.log("\n=== F. 历史测试复跑 ===");

  await test("F1. test-v3-21-1.cjs 8 项复跑", () => {
    let out;
    try {
      out = execFileSync("node", [path.join(ROOT, "test-v3-21-1.cjs")], { encoding: "utf8", cwd: ROOT, timeout: 180000 });
    } catch (e) {
      throw new Error(`v3-21-1 复跑失败：${(e.stdout || "").split("\n").filter(l => l.includes("✗")).slice(0, 3).join(" | ")}`);
    }
    assert.ok(/通过 8 · 失败 0/.test(out), out.split("\n").slice(-2).join(" "));
  });

  await test("F2. test-v3-21-0.cjs 37 项复跑", () => {
    let out;
    try {
      out = execFileSync("node", [path.join(ROOT, "test-v3-21-0.cjs")], { encoding: "utf8", cwd: ROOT, timeout: 240000 });
    } catch (e) {
      throw new Error(`v3-21-0 复跑失败：${(e.stdout || "").split("\n").filter(l => l.includes("✗")).slice(0, 3).join(" | ")}`);
    }
    assert.ok(/通过 37 · 失败 0/.test(out), out.split("\n").slice(-2).join(" "));
  });

  console.log(`\n━━━ test-v3-21-2 共 ${passed + failed} 项 · 通过 ${passed} · 失败 ${failed} ━━━`);
  if (failed) { console.log(failures.join("\n")); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });