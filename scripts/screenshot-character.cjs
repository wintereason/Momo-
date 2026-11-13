// Draws the Character page's preview in every expression to PNG files (to check the artwork):
//   (dev server on :5173)  CHAR='{"theme":"cyber","presentation":"masculine"}' EXPR=idle,happy npx electron scripts/screenshot-character.cjs <outDir> [prefix]
const { app, BrowserWindow } = require("electron");
const path = require("path"), fs = require("fs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const out = process.argv[2] || ".", prefix = process.argv[3] || "char";
  const win = new BrowserWindow({ width: 1100, height: 1000, show: true, x: 0, y: 0, webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, "..", "electron", "preload.cjs"), contextIsolation: true, sandbox: true } });
  const js = (s) => win.webContents.executeJavaScript(s);
  await win.loadURL("http://localhost:5173/#settings");
  await wait(800);
  // a known starting point: defaults plus the requested character options
  await js(`localStorage.removeItem("momo.prefs.v1")`);
  if (process.env.CHAR) {
    const base = { version: 1, activationMode: "hold", shortcut: "Ctrl+Alt+Space", privacy: { saveTranscriptHistory: false, saveRawAudio: false }, character: JSON.parse(process.env.CHAR) };
    await js(`localStorage.setItem("momo.prefs.v1", ${JSON.stringify(JSON.stringify(base))})`);
  }
  await win.webContents.reloadIgnoringCache(); await wait(1200);
  await js(`[...document.querySelectorAll('.nav')].find(b => b.textContent.includes('Character'))?.click()`);
  await wait(1200);
  const shot = async (name) => {
    await js(`document.querySelector('.content').scrollTop = 0`); await wait(150);
    const r = await js(`(() => { const r = document.querySelector('.stage').getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height)}; })()`);
    let png = Buffer.alloc(0);
    for (let i = 0; i < 4 && png.length < 5000; i++) { png = (await win.webContents.capturePage(r)).toPNG(); if (png.length < 5000) await wait(400); }
    fs.writeFileSync(path.join(out, prefix + "-" + name + ".png"), png);
  };
  const names = process.env.EXPR ? process.env.EXPR.split(",") : ["idle", "friendly", "listening", "thinking", "happy", "excited", "wink", "confused", "surprised", "serious", "sad", "apologetic", "warning", "error"];
  for (const e of names) {
    await js(`[...document.querySelectorAll('.expr-grid .chip')].find(b => b.textContent === ${JSON.stringify(e)}).click()`);
    await wait(1500);
    await shot(e);
  }
  if (process.env.FULL) {
    await js(`document.querySelector('.content').scrollTop = 0`); await wait(200);
    fs.writeFileSync(path.join(out, prefix + "-page.png"), (await win.webContents.capturePage()).toPNG());
  }
  app.exit(0);
});
