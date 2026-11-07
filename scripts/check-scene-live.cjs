// Live check of the 3D scene in real Electron/WebGL: screenshots of several states, and frame-cost measurements.
//   node_modules\electron\dist\electron.exe scripts\check-scene-live.cjs [characterId] [2d|3d] [url]
// It uses its OWN temporary profile (your Momo settings are untouched), needs the dev server on :5173, and shows a
// window for about a minute (a hidden window is not drawn, by design, so it can't be tested hidden).
const { app, BrowserWindow, protocol, net, session } = require("electron");
const appProtocol = require("../electron/appProtocol.cjs");
const { makeAllowedRequest } = require("../electron/netpolicy.cjs");
const fs = require("node:fs");
const path = require("node:path");

const id = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "mochi";
const view = process.argv[3] === "3d" ? "3d" : "2d";
const PROD = process.argv[4] === "prod";
const url = PROD ? appProtocol.INDEX_URL : process.argv[4] || "http://localhost:5173/";
if (PROD) appProtocol.registerScheme(protocol); // exactly what the real app does, before ready
const OUT = "D:/dev-cache/scene-check";
fs.mkdirSync(OUT, { recursive: true });
app.setPath("userData", path.join(OUT, "profile"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prefs = {
  version: 1, companionId: id, activationMode: "hold", shortcut: "Ctrl+Alt+Space", showRecordingIndicator: true,
  voiceInput: "mock", speechEngine: "local", speechLanguage: "en", localModelConsent: false, speechDisclosureAccepted: false,
  microphoneId: null, inactivityMinutes: 30,
  widget: { x: null, y: null, size: 1, opacity: 1, compact: false, reduceMotion: false },
  visuals: { quality: "standard", characterView: view },
  voiceOutput: { enabled: false, voiceURI: null, rate: 1 },
  permissions: { confirmReversible: true, confirmScreenRead: true },
  privacy: { saveTranscriptHistory: false, saveRawAudio: false },
};

app.whenReady().then(async () => {
  if (PROD) {
    appProtocol.installHandler(protocol, net, path.resolve(__dirname, "..", "dist"));
    const allowed = makeAllowedRequest(null);
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !allowed(d.url) })); // the real network policy
  }
  const win = new BrowserWindow({ width: 960, height: 820, x: 60, y: 30, show: true, backgroundColor: "#2a1d35", webPreferences: { contextIsolation: true } });
  const errors = [];
  win.webContents.on("console-message", (_e, level, msg) => { if (level >= 2) errors.push(msg.slice(0, 200)); });
  await win.loadURL(url);
  await win.webContents.executeJavaScript(`localStorage.setItem("momo.prefs.v1", ${JSON.stringify(JSON.stringify(prefs))}); true`);
  await win.loadURL(url);
  await sleep(2500);

  const js = (code) => win.webContents.executeJavaScript(code);
  const hasScene = PROD ? await js(`!!document.querySelector(".scene3d canvas")`) : await js(`!!window.__momoScene`);
  const report = { id, view, prod: PROD, hasScene, errors: [], states: {} };
  if (!hasScene) { report.errors = errors; fs.writeFileSync(path.join(OUT, `report-${id}-${view}.json`), JSON.stringify(report, null, 2)); app.quit(); return; }

  const rect = await js(`(() => { const r = document.querySelector(".scene3d").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const states = ["idle", "listening", "thinking", "asking", "working", "success", "sorry", "sleeping"];
  for (const s of states) {
    await js(`[...document.querySelectorAll(".state-grid button")].find((b) => b.textContent.trim() === ${JSON.stringify(s)})?.click(); true`);
    await sleep(s === "success" ? 900 : 1300);
    const img = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.join(OUT, `${id}-${view}-${s}.png`), img.toPNG());
    if (!PROD) report.states[s] = await js(`JSON.parse(JSON.stringify(window.__momoScene.stats()))`);
  }
  if (PROD) { report.errors = errors.filter((e) => !/Electron Security Warning/.test(e)); fs.writeFileSync(path.join(OUT, `report-${id}-${view}.json`), JSON.stringify(report, null, 2)); app.quit(); return; }

  // frame cost while "working" (the busiest state, 30 fps target) for 5 s
  await js(`[...document.querySelectorAll(".state-grid button")].find((b) => b.textContent.trim() === "working")?.click(); true`);
  await sleep(600);
  const a = await js(`JSON.parse(JSON.stringify(window.__momoScene.stats()))`);
  await sleep(5000);
  const b = await js(`JSON.parse(JSON.stringify(window.__momoScene.stats()))`);
  const frames = b.frames - a.frames;
  report.busy = { fps: +(frames / 5).toFixed(1), avgWorkMsOverall: +b.avgWorkMs.toFixed(2), usingModel: b.usingModel };
  // idle: should draw far less
  await js(`[...document.querySelectorAll(".state-grid button")].find((b) => b.textContent.trim() === "idle")?.click(); true`);
  await sleep(800);
  const c = await js(`JSON.parse(JSON.stringify(window.__momoScene.stats()))`);
  await sleep(4000);
  const d = await js(`JSON.parse(JSON.stringify(window.__momoScene.stats()))`);
  report.idle = { fps: +((d.frames - c.frames) / 4).toFixed(1) };
  report.stillThere = await js(`!!document.querySelector(".scene3d canvas")`);
  report.errors = errors;
  fs.writeFileSync(path.join(OUT, `report-${id}-${view}.json`), JSON.stringify(report, null, 2));
  app.quit();
});
