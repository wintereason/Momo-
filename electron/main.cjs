// Momo desktop shell (Electron main process).
// Two windows: a small always-on-top BAR (the dictation indicator, like Wispr Flow's) and a normal SETTINGS window.
// Security posture: contextIsolation on, no node in the renderer, sandboxed, navigation and new windows denied,
// only the microphone permission is granted, and IPC is a small validated surface (see preload.cjs).
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session, globalShortcut, protocol, net, clipboard } = require("electron");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const { ChordTracker, toAccelerator } = require("./chord.cjs");
const { makeAllowedRequest } = require("./netpolicy.cjs");
const { createInserter, createWinKeys } = require("./insert.cjs");
const { createStt } = require("./stt.cjs");
const appProtocol = require("./appProtocol.cjs");
const envConfig = require("./env.cjs");
const path = require("node:path");
const fs = require("node:fs");

const DEV_URL = process.env.MOMO_DEV_URL || null;
require("node:dns").setDefaultResultOrder("ipv4first"); // some networks reset IPv6 connections to the AI and model hosts
// the built app is served from momo://app/ (see appProtocol.cjs); this must be declared before the app is ready
appProtocol.registerScheme(protocol);
const ROOT = path.join(__dirname, "..");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/** @type {BrowserWindow | null} the dictation bar */
let barWin = null;
/** @type {BrowserWindow | null} the settings window (created when opened) */
let settingsWin = null;
/** @type {Tray | null} */
let tray = null;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const pageUrl = (hash) => (DEV_URL ? DEV_URL : appProtocol.INDEX_URL) + "#" + hash;
const secureWebPreferences = () => ({
  preload: path.join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
});
function lockDown(w) {
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith(appProtocol.ORIGIN + "/");
    if (!allowed) e.preventDefault();
  });
}

// ---- The bar: a passive indicator at the bottom centre of the screen. It never takes focus (so the text goes to the
// app you were in) and never catches clicks.
const BAR = { width: 560, height: 260, gap: 10 };
function placeBar() {
  if (!barWin || barWin.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  barWin.setBounds({
    x: Math.round(wa.x + (wa.width - BAR.width) / 2),
    y: Math.round(wa.y + wa.height - BAR.height - BAR.gap),
    width: BAR.width,
    height: BAR.height,
  });
}
function createBar() {
  barWin = new BrowserWindow({
    width: BAR.width, height: BAR.height,
    transparent: true, frame: false, resizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    focusable: false, skipTaskbar: true, show: false, backgroundColor: "#00000000", title: "Momo bar",
    webPreferences: secureWebPreferences(),
  });
  barWin.setAlwaysOnTop(true, "screen-saver");
  barWin.setIgnoreMouseEvents(true);
  placeBar();
  lockDown(barWin);
  barWin.once("ready-to-show", () => barWin && barWin.showInactive());
  barWin.on("closed", () => { barWin = null; });
  barWin.loadURL(pageUrl("bar"));
}
function toggleBar() {
  if (!barWin) return createBar();
  if (barWin.isVisible()) barWin.hide();
  else { placeBar(); barWin.showInactive(); }
}

// ---- Settings: an ordinary window.
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 1000, height: 700, minWidth: 760, minHeight: 520,
    show: false, title: "Momo", backgroundColor: "#faf7f8", autoHideMenuBar: true,
    icon: iconImage() || undefined,
    webPreferences: secureWebPreferences(),
  });
  settingsWin.setMenuBarVisibility(false);
  lockDown(settingsWin);
  settingsWin.once("ready-to-show", () => settingsWin && settingsWin.show());
  settingsWin.on("closed", () => { settingsWin = null; });
  settingsWin.loadURL(pageUrl("settings"));
}

function iconImage() {
  const img = nativeImage.createFromPath(path.join(ROOT, "assets", "icon.png"));
  return img.isEmpty() ? null : img;
}
function createTray() {
  const img = iconImage();
  tray = new Tray(img ? img.resize({ width: 24, height: 24 }) : nativeImage.createEmpty());
  tray.setToolTip("Momo");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Momo settings", click: openSettings },
    { label: "Show / hide the bar", click: toggleBar },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", openSettings);
}

// ---- IPC (validated; only accepted from our own windows)
function fromOurWindow(e) {
  const s = e.sender;
  return (!!barWin && s === barWin.webContents) || (!!settingsWin && s === settingsWin.webContents);
}
function fromBar(e) {
  return !!barWin && e.sender === barWin.webContents;
}
ipcMain.on("momo:open-settings", (e) => { if (fromOurWindow(e)) openSettings(); });
// The bar is click-through, except while it shows a question or a yes/no card.
ipcMain.on("momo:bar-interactive", (e, on) => {
  if (!fromBar(e) || typeof on !== "boolean" || !barWin || barWin.isDestroyed()) return;
  barWin.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on("momo:quit", (e) => { if (fromOurWindow(e)) app.quit(); });

// ---- Which window was the user in before they turned to Momo? (so "read this window" means THAT window)
// Cheap native calls (~0.1 ms) on a timer. Only the handle, process id and title of the foreground window
// are kept, in memory, and only the most recent one that is not Momo's own.
let lastExternal = null;
let foregroundTimer = null;
function startForegroundTracker() {
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
    const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void*, _Out_ uint32*)");
    const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void*, _Out_ uint16*, int)");
    let mine = new Set();
    let mineAt = 0;
    foregroundTimer = setInterval(() => {
      try {
        const now = Date.now();
        if (now - mineAt > 3000) { mine = new Set(app.getAppMetrics().map((m) => m.pid)); mineAt = now; }
        const h = GetForegroundWindow();
        if (!h) return;
        const pid = [0];
        GetWindowThreadProcessId(h, pid);
        if (mine.has(pid[0])) return; // Momo itself: keep the previous window
        const buf = new Uint16Array(256);
        const n = GetWindowTextW(h, buf, 256);
        if (n <= 0) return; // taskbar, desktop and other untitled shell windows are not what the user means
        lastExternal = { hwnd: Number(koffi.address(h)), pid: pid[0], title: Buffer.from(buf.buffer, 0, n * 2).toString("utf16le") };
      } catch { /* keep the last known window */ }
    }, 400);
  } catch (err) {
    console.error("Momo couldn't start the foreground tracker:", err && err.message);
  }
}

// ---- Runtime: the AI helper, the "Ask Momo" commands (typed in Settings) and dictation clean-up.
let runtime = null;
let focusRuntime = null; // focusedFieldIsPassword from the runtime bundle
function broadcast(channel, payload) {
  for (const w of [barWin, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}
function sendToSettings(channel, payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
}
function startRuntime() {
  try {
    const rt = require("./runtime.cjs");
    focusRuntime = rt.focusedFieldIsPassword;
    startForegroundTracker();
    readEnv(); // API keys and settings from .env: they stay in this process
    runtime = rt.createRuntime({
      // The AI brain. The config is rebuilt on every use, so editing .env and clicking "Re-read .env" takes effect at once.
      ai: { config: () => rt.buildAiConfig(envValues), usage: aiUsage },
      foreground: { lastExternal: () => lastExternal },
      emit: (event) => broadcast("momo:runtime-event", event),
      // Momo's own processes, so it can tell its window apart from the user's
      selfPids: () => app.getAppMetrics().map((m) => m.pid),
      // The only thing Momo can do to the PC from a command: open a folder. The runtime validates the path and asks first.
      act: { openPath: (p) => require("electron").shell.openPath(p) },
    });
  } catch (err) {
    console.error("Momo runtime failed to start (run `npm run build:runtime`):", err && err.message);
  }
}
ipcMain.on("momo:submit-transcript", (e, p) => {
  if (!fromOurWindow(e) || !p || typeof p.text !== "string" || typeof p.sessionId !== "string") return;
  if (!runtime) {
    sendToSettings("momo:runtime-event", { type: "runtime.error", code: "runtime_unavailable", message: "Momo's runtime isn't running. Rebuild it with npm run build:runtime." });
    return;
  }
  void runtime.handleTranscript(p.sessionId.slice(0, 128), p.text.slice(0, 2000));
});
ipcMain.on("momo:cancel-task", (e) => { if (fromOurWindow(e)) runtime?.cancelTask(); });
// The Confirm/Cancel buttons. The runtime ignores ids that don't match the question that is actually open.
ipcMain.on("momo:respond-confirmation", (e, p) => {
  if (!fromOurWindow(e) || !p || typeof p.taskId !== "string" || typeof p.approved !== "boolean") return;
  void runtime?.respondConfirmation(p.taskId.slice(0, 128), p.approved);
});

// ---- Speech recognition: Whisper runs natively on this PC, in a worker thread of this process (see stt.cjs).
// The audio is passed in memory and discarded. The model is downloaded once (from the model hub only) into Momo's data folder.
let stt = null;
function getStt() {
  if (!stt) stt = createStt({ cacheDir: path.join(app.getPath("userData"), "speech-model"), workerPath: path.join(__dirname, "stt.worker.cjs") });
  return stt;
}
ipcMain.handle("momo:stt-status", (e) => (fromOurWindow(e) ? getStt().status() : null));
// Load the model (downloading it the first time). Progress goes back to the window that asked.
ipcMain.handle("momo:stt-load", async (e) => {
  if (!fromOurWindow(e)) return { ok: false, error: "Not allowed." };
  const sender = e.sender;
  try {
    await getStt().load((p) => { if (!sender.isDestroyed()) sender.send("momo:stt-progress", p); });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
  }
});
ipcMain.handle("momo:stt-transcribe", async (e, p) => {
  if (!fromBar(e)) return { ok: false, reason: "Not allowed." };
  if (!p || !(p.audio instanceof Float32Array) || typeof p.language !== "string") return { ok: false, reason: "Bad request." };
  try {
    return { ok: true, text: await getStt().transcribe(p.audio, p.language) };
  } catch {
    return { ok: false, reason: "The speech engine could not read that." };
  }
});

// ---- Dictation: what was said -> clean text -> typed into the app that has the focus.
let inserter = null;
function getInserter() {
  if (!inserter) inserter = createInserter({ clipboard, keys: createWinKeys(require("koffi")) });
  return inserter;
}
// Started when the user begins to speak, so the answer is ready long before they finish.
let passwordCheck = null;
ipcMain.on("momo:dictation-begin", (e) => {
  if (!fromBar(e)) return;
  passwordCheck = focusRuntime ? focusRuntime().catch(() => "unknown") : Promise.resolve("unknown");
});
ipcMain.handle("momo:dictate", async (e, p) => {
  if (!fromBar(e)) return { ok: false, reason: "Not allowed." };
  if (!p || typeof p.text !== "string") return { ok: false, reason: "Nothing to write." };
  const style = p.style === "off" || p.style === "light" ? p.style : "polish";
  const mode = p.mode === "copy" ? "copy" : "type";
  if (!runtime) return { ok: false, reason: "Momo's runtime isn't running." };
  const out = await runtime.dictate(p.text.slice(0, 4000), style);
  if (!out.ok) return out;
  const result = { ok: true, text: out.text, polished: out.polished, source: out.source, note: out.note, inserted: false, copied: false };
  if (mode === "copy") {
    clipboard.writeText(out.text);
    return { ...result, copied: true };
  }
  // Never type into a password box.
  const pw = passwordCheck ? await passwordCheck : "unknown";
  passwordCheck = null;
  if (pw === "yes") return { ...result, blocked: "password" };
  const r = await getInserter().insert(out.text, { restoreClipboard: p.restoreClipboard === true });
  if (r.ok) return { ...result, inserted: true, copied: true };
  return { ...result, copied: r.copied, blocked: r.reason };
});

// ---- API keys and settings from the .env file. Values stay in THIS process; the UI only gets booleans (env.cjs).
let envValues = {};
let envFiles = [];
// How many AI requests were sent today (a date and a number: the only thing kept about AI use). It keeps Momo inside the
// free tiers even across restarts.
const usageFile = () => path.join(app.getPath("userData"), "ai-usage.json");
const localDate = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const aiUsage = {
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(usageFile(), "utf8"));
      if (typeof j.date === "string" && Number.isInteger(j.count) && j.count >= 0) return { date: j.date, count: j.count };
    } catch { /* none yet */ }
    return { date: "", count: 0 };
  },
  save(u) {
    try { fs.writeFileSync(usageFile(), JSON.stringify({ date: String(u.date), count: Number(u.count) })); } catch { /* non-fatal */ }
  },
};

function readEnv() {
  const r = envConfig.load({
    files: [path.join(ROOT, ".env"), path.join(app.getPath("userData"), ".env")],
    processEnv: process.env,
  });
  envValues = r.values;
  envFiles = r.files;
  const s = envConfig.status(envValues, envFiles);
  // plain numbers for the Settings screen
  let limit = 200;
  try { limit = require("./runtime.cjs").buildAiConfig(envValues).maxRequestsPerDay; } catch { /* runtime not built yet */ }
  const u = aiUsage.load();
  s.ai.requestsToday = u.date === localDate() ? u.count : 0;
  s.ai.limitPerDay = limit;
  return s;
}
ipcMain.handle("momo:env-status", (e) => (fromOurWindow(e) ? readEnv() : null));

// "Delete everything Momo stored on this PC": the AI request counter plus ALL Chromium storage
// (settings, the downloaded speech model, caches). The UI removes its own preferences first.
ipcMain.handle("momo:wipe-data", async (e) => {
  if (!fromOurWindow(e)) return { ok: false };
  try {
    runtime?.cancelTask();
    getStt().deleteModel(); // the downloaded speech model
    try { fs.unlinkSync(usageFile()); } catch { /* nothing was saved */ }
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// Permission policy from Settings (only known boolean keys are accepted).
ipcMain.on("momo:set-policy", (e, p) => {
  if (!fromOurWindow(e) || !p) return;
  const policy = {};
  if (typeof p.confirmReversible === "boolean") policy.confirmReversible = p.confirmReversible;
  if (typeof p.confirmScreenRead === "boolean") policy.confirmScreenRead = p.confirmScreenRead;
  runtime?.setPolicy(policy);
});

// ---- Global shortcuts (hold or toggle): one to DICTATE, one to give Momo a GOAL. The bar owns the activation logic;
// this only reports which chord was pressed or released. A low-level hook is needed because Windows hotkeys have no
// key-up event. globalShortcut is used to claim a chord (so other apps don't also receive it) and to detect conflicts.
const ROLES = ["dictate", "agent"];
const keys = { dictate: { tracker: null, claimed: null, status: { ok: false, reason: "The shortcut is not set up yet." } }, agent: { tracker: null, claimed: null, status: { ok: false, reason: "The shortcut is not set up yet." } } };
let shortcutMode = "hold";
function clearShortcut(role) {
  const k = keys[role];
  if (k.claimed) { try { globalShortcut.unregister(k.claimed); } catch { /* ignore */ } k.claimed = null; }
  k.tracker?.reset();
  k.tracker = null;
}
function applyShortcut(role, chord, m) {
  clearShortcut(role);
  let t;
  try { t = new ChordTracker(chord, UiohookKey); } catch { return { ok: false, reason: "That key combination is not supported." }; }
  const acc = toAccelerator(chord);
  if (acc) {
    let ok = false;
    try { ok = globalShortcut.register(acc, () => {}); } catch { ok = false; }
    if (!ok) return { ok: false, reason: chord + " is already used by Windows or another app. Pick a different combination." };
    keys[role].claimed = acc;
  }
  keys[role].tracker = t;
  shortcutMode = m;
  return acc ? { ok: true } : { ok: true, note: "Modifier-only shortcuts can't be reserved, so other apps may also see these keys." };
}
function sendShortcut(role, kind) {
  if (barWin && !barWin.isDestroyed()) barWin.webContents.send("momo:shortcut", { role, kind });
}
function startKeyHook() {
  uIOhook.on("keydown", (e) => {
    for (const role of ROLES) {
      const r = keys[role].tracker?.down(e.keycode);
      if (r === "press") sendShortcut(role, "press"); // key-repeat ("repeat") is dropped here
    }
  });
  uIOhook.on("keyup", (e) => {
    for (const role of ROLES) {
      const r = keys[role].tracker?.up(e.keycode);
      // The inactive mode's handler does not run: toggle mode never receives releases.
      if (r === "release" && shortcutMode === "hold") sendShortcut(role, "release");
    }
  });
  uIOhook.start();
}
// The bar registers the shortcuts, and Settings asks whether each is active (the answer is the same for both windows).
ipcMain.handle("momo:set-shortcut", (e, payload) => {
  if (!fromOurWindow(e) || !payload || typeof payload.chord !== "string" || payload.chord.length > 64) return { ok: false, reason: "Invalid request." };
  if (payload.mode !== "hold" && payload.mode !== "toggle") return { ok: false, reason: "Invalid mode." };
  if (!ROLES.includes(payload.role)) return { ok: false, reason: "Invalid shortcut." };
  keys[payload.role].status = applyShortcut(payload.role, payload.chord, payload.mode);
  return keys[payload.role].status;
});
ipcMain.handle("momo:shortcut-status", (e, role) => (fromOurWindow(e) && ROLES.includes(role) ? keys[role].status : null));

// ---- Network allowlist: only the speech-model host (see netpolicy.cjs). Everything else is cancelled.
const allowedRequest = makeAllowedRequest(DEV_URL);

// ---- A crash in one place must not take Momo down, and must not leak what the user was doing.
process.on("uncaughtException", (err) => console.error("Momo recovered from an internal error:", err && err.message));
process.on("unhandledRejection", (err) => console.error("Momo recovered from an internal error:", err && err.message));

app.whenReady().then(() => {
  if (!DEV_URL) appProtocol.installHandler(protocol, net, path.join(ROOT, "dist"));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowedRequest(details.url) });
  });

  // Only the microphone is ever granted, and only to our own pages.
  const ours = (url) => (DEV_URL ? url.startsWith(DEV_URL) : url.startsWith(appProtocol.ORIGIN + "/"));
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(permission === "media" && ours(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => permission === "media" && ours(origin || ""));

  createBar();
  createTray();
  startKeyHook();
  startRuntime();
  screen.on("display-metrics-changed", placeBar);
  // Starting Momo opens its Settings window (the app); the bar lives at the bottom of the screen.
  openSettings();
});

app.on("second-instance", () => openSettings());
// Closing Settings leaves the bar running (like a tray app); Quit is in the tray menu and in Settings.
app.on("window-all-closed", () => app.quit());
// Session state lives only in memory and is discarded on exit.
app.on("before-quit", () => {
  runtime?.dispose(); // explicit session cleanup: the world model and task state are discarded
  runtime = null;
  stt?.unload();
  if (foregroundTimer) clearInterval(foregroundTimer);
  lastExternal = null;
  passwordCheck = null;
  for (const role of ROLES) clearShortcut(role);
  globalShortcut.unregisterAll();
  try { uIOhook.stop(); } catch { /* not started */ }
});
