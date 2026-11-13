// Renders the Settings pages to PNG files (for checking the layout): npx electron scripts/screenshot-ui.cjs <outDir>
const { app, BrowserWindow, protocol, net, ipcMain } = require("electron");
const path = require("path"), fs = require("fs");
const appProtocol = require("../electron/appProtocol.cjs");
appProtocol.registerScheme(protocol);
app.whenReady().then(async () => {
  appProtocol.installHandler(protocol, net, path.join(__dirname, "..", "dist"));
  // stand-in answers so the key screen can be drawn without the real shell
  ipcMain.handle("momo:env-status", () => ({ fileFound: true, files: ["Momo/.env"], ai: { enabled: true, provider: "gemini", ready: true, screenContext: false, requestsToday: 3, limitPerDay: 200, keys: { gemini: true, groq: false, openrouter: false, ollama: false } }, speech: { hfToken: false }, problems: [] }));
  const out = process.argv[2] || ".";
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { preload: path.join(__dirname, "..", "electron", "preload.cjs"), contextIsolation: true, sandbox: true } });
  await win.loadURL(appProtocol.INDEX_URL + "#settings");
  await new Promise((r) => setTimeout(r, 1500));
  for (const label of ["Home", "AI & keys", "Privacy", "Language & voice", "Writing style", "Shortcut", "Ask Momo"]) {
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.nav')].find(b => b.textContent.includes(${JSON.stringify(label)}))?.click()`);
    await new Promise((r) => setTimeout(r, 700));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, "ui-" + label.replace(/\W+/g, "_") + ".png"), img.toPNG());
  }
  app.exit(0);
});
