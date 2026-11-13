// Draws the shadow cursor overlay with sample messages and saves a PNG: npx electron scripts/screenshot-cursor.cjs <outDir>
const { app, BrowserWindow, protocol, net } = require("electron");
const path = require("path"), fs = require("fs");
const appProtocol = require("../electron/appProtocol.cjs");
appProtocol.registerScheme(protocol);
app.whenReady().then(async () => {
  appProtocol.installHandler(protocol, net, path.join(__dirname, "..", "dist"));
  const out = process.argv[2] || ".";
  const win = new BrowserWindow({ width: 900, height: 420, show: false, transparent: false, backgroundColor: "#eef0f4", webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, "..", "electron", "preload.cjs"), contextIsolation: true, sandbox: true } });
  await win.loadURL(appProtocol.INDEX_URL + "#cursor");
  await new Promise((r) => setTimeout(r, 800));
  win.webContents.executeJavaScript("document.documentElement.style.background='#eef0f4'; document.body.style.background='#eef0f4'");
  win.webContents.send("momo:cursor", { kind: "show", x: 120, y: 90 });
  await new Promise((r) => setTimeout(r, 300));
  win.webContents.send("momo:cursor", { kind: "move", x: 520, y: 200, w: 420, h: 44, action: "select", label: "Address and search bar" });
  await new Promise((r) => setTimeout(r, 2200)); win.webContents.invalidate(); await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(path.join(out, "cursor-select.png"), (await win.webContents.capturePage()).toPNG());
  win.webContents.send("momo:cursor", { kind: "done", ok: true });
  await new Promise((r) => setTimeout(r, 900));
  fs.writeFileSync(path.join(out, "cursor-done.png"), (await win.webContents.capturePage()).toPNG());
  app.exit(0);
});
