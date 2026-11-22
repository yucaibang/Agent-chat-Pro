"use strict";

// v3.46.1 ACP 启动动画（splash loading）：应用启动到主窗渲染就绪之间的过渡画面。
// 设计要点：
// ── 覆盖式而非前置阻塞式 ── 主窗保持「创建即显示」既有形态不动（回归面最小），splash 作为
//    无边框透明置顶小窗压在主窗之上；主窗 did-finish-load（主窗 HTML 渲染完成、theme/brand
//    初始推送同刻）时淡出关闭，观感=启动画面无缝被主界面替换。
// ── 零 IPC 面 ── 无 preload（跳跳龙 dino 同款先例），关闭只走主进程 executeJavaScript 注入淡出 class。
// ── 零外部资源 ── 动画页整页 data URL 内联（深空近黑底+ACP 字标+光晕呼吸+不定进度细条），
//    无文件依赖、无网络请求；视觉语言沿 v3.46.0 动效层 --ease-pop 强减速与官网“深空旗舰”同族。
// ── 兜底 ── 主窗 did-finish-load 异常不来时，10 秒强制关闭（异常态不永久遮罩主窗）。
// ── API ── createSplash({ BrowserWindow, writeLog, minShowMs }) 纯注入式（可测：守门 A 组以
//    假 BrowserWindow 真跑创建参数/最小时长/关闭链路，不依赖 electron）。

const DEFAULT_MIN_SHOW_MS = 700;   // 最短在场时长：加载太快也至少让动画走完一遍呼吸
const FORCE_CLOSE_MS = 10000;      // 兜底：did-finish-load 未达即强关，不永久遮罩
const FADE_OUT_MS = 220;           // 淡出时长（executeJavaScript 注入 css class + 延时关闭）

function splashPageHtml() {
  const bg = "#0a0e14";
  const accent = "#3fcf8e";
  const text = "#e8eef5";
  const muted = "#7b8590";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body { margin:0; padding:0; height:100%; overflow:hidden; }
  body { background:${bg}; display:flex; align-items:center; justify-content:center; flex-direction:column;
    gap:22px; font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif; user-select:none; cursor:default;
    transition: opacity ${FADE_OUT_MS}ms ease-out; }
  body.bye { opacity: 0; }
  .glow { position:fixed; width:340px; height:340px; border-radius:50%;
    background:radial-gradient(circle, rgba(63,207,142,.16) 0%, rgba(63,207,142,0) 62%);
    animation: breathe 2.4s ease-in-out infinite; }
  .mark { position:relative; font-size:52px; font-weight:800; letter-spacing:14px;
    margin-left:14px; color:${text}; text-shadow:0 0 26px rgba(63,207,142,.35);
    animation: rise .6s cubic-bezier(.16,1,.3,1) backwards; }
  .sub { position:relative; font-size:11px; letter-spacing:6px; margin-left:6px; color:${muted};
    animation: rise .6s cubic-bezier(.16,1,.3,1) .12s backwards; }
  .track { position:relative; width:210px; height:3px; border-radius:2px; background:#1d242c; overflow:hidden; }
  .thumb { position:absolute; top:0; left:0; width:64px; height:100%; border-radius:2px;
    background:linear-gradient(90deg, rgba(63,207,142,0), ${accent}); animation: run 1.15s ease-in-out infinite; }
  .hint { position:relative; font-size:11px; color:${muted}; letter-spacing:2px; }
  .hint .dot { display:inline-block; width:14px; text-align:left; animation: dots 1.2s steps(4) infinite; }
  @keyframes breathe { 0%,100% { opacity:.55; transform:scale(.92); } 50% { opacity:1; transform:scale(1.05); } }
  @keyframes rise { from { opacity:0; transform:translateY(9px); } }
  @keyframes run { 0% { left:-64px; } 100% { left:210px; } }
  @keyframes dots { 0% { clip-path: inset(0 100% 0 0); } 25% { clip-path: inset(0 66% 0 0); }
    50% { clip-path: inset(0 33% 0 0); } 75%,100% { clip-path: inset(0 0 0 0); } }
</style></head>
<body>
  <div class="glow"></div>
  <div class="mark">ACP</div>
  <div class="sub">AGENT CHAT PRO</div>
  <div class="track"><div class="thumb"></div></div>
  <div class="hint">正在启动<span class="dot">…</span></div>
</body></html>`;
}

function createSplash({ BrowserWindow, writeLog, minShowMs = DEFAULT_MIN_SHOW_MS } = {}) {
  if (!BrowserWindow) return null;
  const openedAt = Date.now();
  const splash = new BrowserWindow({
    width: 1120,
    height: 760,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    center: true,
    show: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: null,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  splash.setAlwaysOnTop(true, "screen-saver");
  splash.setMenuBarVisibility(false);
  splash.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(splashPageHtml()));

  let settled = false;
  let closeScheduled = false; // v3.46.1：防重排——ready-to-show 与 did-finish-load 双挂点先后到达不叠 setTimeout
  const forceTimer = setTimeout(() => close(), FORCE_CLOSE_MS);

  function actualClose() {
    if (settled) return;
    settled = true;
    clearTimeout(forceTimer);
    try {
      if (splash.isDestroyed()) return;
      splash.webContents.executeJavaScript("document.body.classList.add('bye')", false)
        .catch(() => {});
    } catch {}
    setTimeout(() => { try { if (!splash.isDestroyed()) splash.destroy(); } catch {} }, FADE_OUT_MS + 60);
    if (typeof writeLog === "function") writeLog("splash_closed", { shownMs: Date.now() - openedAt });
  }

  function close() {
    if (settled || closeScheduled) return;
    closeScheduled = true;
    // 最短在场时长兜底：主窗就绪早于 minShowMs 时，等动画走完一遍呼吸再关（不闪一下就撤）
    const remaining = minShowMs - (Date.now() - openedAt);
    setTimeout(actualClose, Math.max(0, remaining));
  }

  if (typeof writeLog === "function") writeLog("splash_opened", { minShowMs });
  return { window: splash, close, splashPageHtml };
}

module.exports = { createSplash, splashPageHtml, DEFAULT_MIN_SHOW_MS, FORCE_CLOSE_MS, FADE_OUT_MS };
