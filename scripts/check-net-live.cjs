// Live check that Electron really enforces Momo's network allowlist.
//   node_modules\electron\dist\electron.exe scripts\check-net-live.cjs
// Writes the result to D:\dev-cache\net-check.json (a GUI process has no console).
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const { makeAllowedRequest } = require("../electron/netpolicy.cjs");

const OUT = process.env.NET_CHECK_OUT || "D:/dev-cache/net-check.json";

app.whenReady().then(async () => {
  const allowed = makeAllowedRequest(null);
  const cancelled = [];
  const seen = [];
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const ok = allowed(d.url);
    if (d.url.startsWith("http")) (ok ? seen : cancelled).push(new URL(d.url).host);
    cb({ cancel: !ok });
  });
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,<html><body>probe</body></html>");
  const probe = (url) => win.webContents.executeJavaScript(
    `fetch(${JSON.stringify(url)}, { mode: "no-cors" }).then(() => "reached").catch((e) => "failed")`);
  const results = {};
  for (const url of [
    "https://example.com/",
    "https://www.google-analytics.com/collect",
    "http://huggingface.co/",
    "https://huggingface.co.attacker.io/",
    "https://huggingface.co/api/models/Xenova/whisper-base",
  ]) results[url] = await Promise.race([probe(url), new Promise((r) => setTimeout(() => r("timeout"), 15000))]);
  fs.writeFileSync(OUT, JSON.stringify({ results, cancelledHosts: cancelled, allowedHosts: seen }, null, 2));
  app.quit();
});
