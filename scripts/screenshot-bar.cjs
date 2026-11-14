// Screenshots the dictation bar with a given character (dev server on :5173).
//   CHAR='{"art":"dark","view":"compact"}' npx electron scripts/screenshot-bar.cjs <outDir> [prefix]
const { app, BrowserWindow } = require("electron");
const path = require("path"), fs = require("fs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const out = process.argv[2] || ".", prefix = process.argv[3] || "bar";
  const win = new BrowserWindow({
    width: 360, height: 460, show: true, frame: false, backgroundColor: "#3a4050",
    webPreferences: { preload: path.join(__dirname, "..", "electron", "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  await win.loadURL("http://localhost:5173/#bar");
  await wait(600);
  const base = { version: 1, activationMode: "hold", shortcut: "Ctrl+Alt+Space", privacy: { saveTranscriptHistory: false, saveRawAudio: false }, character: JSON.parse(process.env.CHAR || "{}") };
  await win.webContents.executeJavaScript(`localStorage.setItem("momo.prefs.v1", ${JSON.stringify(JSON.stringify(base))})`);
  await win.webContents.reloadIgnoringCache();
  await wait(1500);
  fs.writeFileSync(path.join(out, prefix + ".png"), (await win.webContents.capturePage()).toPNG());
  app.exit(0);
});
