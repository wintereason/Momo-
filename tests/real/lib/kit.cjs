"use strict";
// Launching the controlled test applications and reading their own records. Every fixture:
//   - is created from tests/real/apps, with THIS run's id in its title and command line (so the cleanup finds it and nothing else),
//   - keeps its files under the run directory,
//   - closes itself after -MaxSeconds even if the runner is killed outright (a crash cannot leave a window behind for long).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const P = require("./paths.cjs");
const { psq, pidsByCommandLine } = require("./ps.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_SECONDS = 900;

// ---------------------------------------------------------------- seeded layouts (ported from the Phase 6c harness)
const LABELS = ["Preview", "Inspect", "Filter", "Compare", "Sort", "Refresh", "Launch", "Toggle", "Archive", "Merge", "Review", "Connect", "Select all", "New folder", "Open link", "Rotate", "Zoom", "Highlight", "Measure", "Expand", "Collapse", "Duplicate", "Bookmark", "Pan"];
const PALETTE = [[59, 130, 246], [22, 163, 74], [136, 23, 152], [202, 80, 16], [0, 153, 188], [88, 88, 200], [196, 43, 28]];
const rng = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };

/** a window of drawn buttons (logical 820 x 640): same seed, same layout, so a run can be repeated exactly */
function layout(seed, o = {}) {
  const r = rng(seed * 7919 + 13), n = o.n || 5;
  const pool = [...LABELS].sort(() => r() - 0.5).slice(0, n);
  const cells = []; for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) cells.push([col, row]);
  cells.sort(() => r() - 0.5);
  const buttons = pool.map((label, i) => {
    const w = 130 + Math.floor(r() * 50), h = 40 + Math.floor(r() * 12);
    const x = 40 + cells[i][0] * 250 + Math.floor(r() * (230 - w)), y = 100 + cells[i][1] * 140 + Math.floor(r() * (120 - h));
    const color = PALETTE[Math.floor(r() * PALETTE.length)];
    return { label, x, y, w, h, color, fg: [255, 255, 255], font: 15, effect: { status: "Done " + label } };
  });
  return { mode: o.mode || "normal", bg: [32, 34, 40], status: "Ready", buttons };
}
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

const WEB_COLORS = ["#3b82f6", "#16a34a", "#881798", "#ca5010", "#0099bc", "#5858c8", "#c42b1c"];
/** the same idea for the Chrome pages (canvas / WebGL): 220 x 60 buttons in a grid, in CSS pixels */
function webSpec(seed, n = 5) {
  const r = rng(seed * 31 + 7), pool = [...LABELS].sort(() => r() - 0.5).slice(0, n);
  return { buttons: pool.map((label, i) => ({ label, x: 40 + (i % 3) * 300, y: 120 + Math.floor(i / 3) * 170, w: 220, h: 60, color: WEB_COLORS[Math.floor(r() * WEB_COLORS.length)] })) };
}

// ---------------------------------------------------------------- files
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } };
const readLog = (p) => { try { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^\uFEFF/, ""))); } catch { return []; } };

// ---------------------------------------------------------------- processes and windows
/** start one of our PowerShell fixtures. Returns the child; its id is registered with the ledger. */
function spawnPs(ctx, script, args = [], { maxSeconds = MAX_SECONDS } = {}) {
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(P.APPS, script), ...args, "-RunId", ctx.runId, "-MaxSeconds", String(maxSeconds)], { stdio: "ignore" });
  ctx.ledger.track(child.pid);
  return child;
}

/** wait for a top-level window whose title matches (all enumeration goes through Momo's own window listing) */
async function findWindow(ctx, rx, { timeoutMs = 30_000, exclude = null } = {}) {
  const rt = ctx.harness().rt;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = (await rt.nodeWindows.query()).windows.find((x) => rx.test(x.title) && !(exclude && exclude.has(x.hwnd)));
    if (w) return w;
    await sleep(200);
  }
  return null;
}
const titleRx = (ctx, name, painted = true) => new RegExp("^" + ctx.runId + "-" + name + (painted ? " PAINTED" : "") + "$");

async function closeWindow(ctx, win, child) {
  const rt = ctx.harness().rt;
  if (win) { try { await rt.nodeInput.closeWindow(win.hwnd); } catch { /* the sweep below catches it */ } }
  await sleep(150);
  if (child && child.pid) { try { require("./ps.cjs").killTree(child.pid); } catch { /* ledger sweep */ } }
}


/** move a top-level window (physical pixels, position only). Used to place a fixture partly off the screen. */
function moveWindow(hwnd, x, y) {
  psq(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MvW { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f); public static void Go(long h, int x, int y) { SetProcessDPIAware(); SetWindowPos(new IntPtr(h), IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004); } }'; [MvW]::Go(${Number(hwnd)}, ${Math.round(x)}, ${Math.round(y)})`);
}
// ---------------------------------------------------------------- the fixtures
/** the drawn-button application (Phase 6c): returns handles to its own click log and state */
async function launchDrawn(ctx, spec, { aware = false, tag } = {}) {
  const name = "int-" + tag;
  const specP = ctx.ledger.file(`${name}.spec.json`), logP = ctx.ledger.file(`${name}.log`), stP = ctx.ledger.file(`${name}.state.json`);
  fs.writeFileSync(specP, JSON.stringify(spec));
  const child = spawnPs(ctx, "drawn.ps1", ["-Spec", specP, "-Log", logP, "-State", stP, "-Aware", aware ? "1" : "0", "-Tag", tag]);
  const win = await findWindow(ctx, titleRx(ctx, name));
  return {
    child, win, name, specP, logP, stP,
    clicks: () => readLog(logP).filter((l) => l.ev === "click" || l.ev === "click-real").map((l) => l.label),
    events: () => readLog(logP),
    state: () => readJson(stP),
    close: () => closeWindow(ctx, win, child),
  };
}

/** blocks / states windows: normal | offscreen | layered | busy | animate */
async function launchBlocks(ctx, { mode = "normal", aware = true, tag, x = 200, y = 100, blockMs = 4000 } = {}) {
  const marker = ctx.ledger.file(`blocks-${tag}.marker`);
  const child = spawnPs(ctx, "blocks.ps1", ["-Mode", mode, "-Aware", aware ? "1" : "0", "-X", String(x), "-Y", String(y), "-Tag", tag, "-Marker", marker, "-BlockMs", String(blockMs)]);
  const win = await findWindow(ctx, titleRx(ctx, "blocks-" + tag));
  return { child, win, marker, mark: () => { try { return fs.readFileSync(marker, "utf8"); } catch { return ""; } }, close: () => closeWindow(ctx, win, child) };
}

/** forms windows: white | black | late | content | hung | excluded. `late` shows PAINTED only after 1.5 s */
async function launchForms(ctx, { mode, tag, paintedTitle = false, timeoutMs = 30_000 } = {}) {
  const child = spawnPs(ctx, "forms.ps1", ["-Mode", mode, "-Tag", tag]);
  const name = `forms-${mode}-${tag}`;
  const win = await findWindow(ctx, paintedTitle ? titleRx(ctx, name) : new RegExp("^" + ctx.runId + "-" + name + "( PAINTED)?$"), { timeoutMs });
  return { child, win, close: () => closeWindow(ctx, win, child) };
}

/** the WPF window with ordinary accessible controls, which records everything it receives (clicks, text, scroll, keys, activation, position) */
async function launchBasic(ctx, { tag, dup = false, layout = "standard", maxSeconds = MAX_SECONDS } = {}) {
  const name = "basic-" + tag;
  const stP = ctx.ledger.file(`${name}.state.json`);
  const child = spawnPs(ctx, "basic.ps1", ["-State", stP, "-Tag", tag, "-Dup", dup ? "1" : "0", "-Layout", layout], { maxSeconds });
  const win = await findWindow(ctx, new RegExp("^" + ctx.runId + "-" + name + "$"));
  return { child, win, name, stP, state: () => readJson(stP), close: () => closeWindow(ctx, win, child) };
}

/** the context-menu window (submenus), the message box and the file dialog, whose own state is the title */
async function launchTitled(ctx, script, args, tag) {
  const child = spawnPs(ctx, script, [...args, "-Tag", tag]);
  const win = await findWindow(ctx, new RegExp("^" + ctx.runId + "-" + tag + "(-.*)?$"));
  const title = async () => { const rt = ctx.harness().rt; const w = (await rt.nodeWindows.query()).windows.find((x) => new RegExp("^" + ctx.runId + "-" + tag + "(-.*)?$").test(x.title)); return w ? w.title.slice((ctx.runId + "-" + tag).length) : ""; };
  return { child, win, title, close: () => closeWindow(ctx, win, child) };
}

// ---------------------------------------------------------------- Chrome (dedicated profile, never the user's)
/** Chrome processes that are NOT ours: process ids only, plus the window handles Momo's own listing reports for them (no titles are kept) */
async function snapshotOtherChrome(ctx) {
  let procs = [];
  try {
    const out = psq("Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; cmd = [string]$_.CommandLine } } | ConvertTo-Json -Compress");
    const j = out ? JSON.parse(out) : [];
    procs = (Array.isArray(j) ? j : [j]).filter((p) => !(p.cmd || "").includes(ctx.runId)).map((p) => p.pid);
  } catch { /* none */ }
  const rt = ctx.harness().rt;
  const wins = (await rt.nodeWindows.query()).windows.filter((w) => /^chrome/i.test(w.process || "") && !/^momo-click\|/.test(w.title)).map((w) => w.hwnd);
  return { pids: procs.sort((a, b) => a - b), hwnds: wins.sort((a, b) => a - b) };
}

/** open one of tests/real/apps/*.html in Chrome with a fresh throwaway profile under the run directory */
async function launchChromePage(ctx, html, spec, { tag }) {
  const exe = ctx.env.chromePath;
  const profile = ctx.ledger.file("chrome-" + tag);
  const url = "file:///" + path.join(P.APPS, html).split("\\").join("/") + "#" + encodeURIComponent(JSON.stringify(spec));
  const child = spawn(exe, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--new-window", "--window-position=80,60", "--window-size=1100,780", url], { detached: false, stdio: "ignore" });
  ctx.ledger.track(child.pid);
  const win = await findWindow(ctx, /^momo-click\|/, { timeoutMs: 40_000 });
  const read = async () => {
    const rt = ctx.harness().rt;
    const w = win ? (await rt.nodeWindows.query()).windows.find((x) => x.hwnd === win.hwnd) : null;
    const m = w ? /momo-click\|(.*)\|(\d+)/.exec(w.title) : null;   // Chrome appends " - Google Chrome" to the page title
    return m ? { label: m[1], count: Number(m[2]) } : null;
  };
  return { child, win, profile, received: read, close: async () => { await closeWindow(ctx, win, child); } };
}

module.exports = { sleep, LABELS, layout, center, webSpec, readJson, readLog, spawnPs, findWindow, titleRx, closeWindow, launchDrawn, launchBlocks, launchForms, launchBasic, launchTitled, launchChromePage, snapshotOtherChrome, pidsByCommandLine, moveWindow };
