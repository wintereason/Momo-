// Live check of "open Chrome" shown step by step, on the REAL taskbar (nothing is clicked or opened, it only draws):
//   npx vite build && npm run build:runtime && npx electron scripts/demo-open-steps.cjs <outDir> [App name]
const { app, BrowserWindow, protocol, net, screen } = require("electron");
const path = require("path");
const { spawnSync } = require("child_process");
const koffi = require("koffi");
const appProtocol = require("../electron/appProtocol.cjs");
appProtocol.registerScheme(protocol);
const rt = require("../electron/runtime.cjs");
const { createCursorWindow, createCursorScreen } = require("../electron/cursorWindow.cjs");
const { createShadowCursor } = require("../electron/shadowCursor.cjs");

const out = process.argv[2] || ".";
const appName = process.argv[3] || "Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function shot(name) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class D { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][D]::SetProcessDPIAware()
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$s = New-Object System.Drawing.Bitmap 1400, ([int](1400 * $b.Height / $b.Width))
$g2 = [System.Drawing.Graphics]::FromImage($s); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $s.Width, $s.Height)
$s.Save('${path.join(out, name + ".png").replace(/\\/g, "/")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  appProtocol.installHandler(protocol, net, path.join(__dirname, "..", "dist"));
  const secure = () => ({ preload: path.join(__dirname, "..", "electron", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true });
  const shadow = createShadowCursor({
    enabled: () => true,
    win: createCursorWindow({ BrowserWindow, webPreferences: secure, lockDown: () => {}, url: appProtocol.INDEX_URL + "#cursor" }),
    screen: createCursorScreen(screen, koffi),
  });

  const items = await rt.nodeScreen.taskbar();
  console.log("taskbar buttons read:", items ? items.length : null);
  if (!items) { console.log("FAIL  could not read the taskbar"); app.exit(1); return; }
  console.log("buttons:", items.filter((n) => n.type === "Button").map((n) => n.name.slice(0, 28)).slice(0, 14).join(" | "));
  const GENERIC = new Set(["google", "microsoft", "windows", "app", "the", "inc", "corporation"]); // same rule as the tool
  const all = norm(appName).split(" ").filter((w) => w.length > 1);
  const words = (all.filter((w) => !GENERIC.has(w)).length ? all.filter((w) => !GENERIC.has(w)) : all).slice(0, 2);
  const pinned = items.find((n) => n.type === "Button" && n.rect && words.every((w) => norm(n.name).includes(w)));
  const start = items.find((n) => n.type === "Button" && /^start$/i.test(n.name.trim()) && n.rect);
  console.log(`taskbar button for "${appName}":`, pinned ? `${pinned.name.slice(0, 40)} at ${JSON.stringify(pinned.rect)}` : "none (would use Start)", "| Start:", start ? JSON.stringify(start.rect) : "none");

  const mv = (n, action, label, text) => shadow.handle({ type: "cursor.move", x: Math.round(n.rect.l + n.rect.w / 2), y: Math.round(n.rect.t + n.rect.h / 2), w: n.rect.w, h: n.rect.h, action, label, ...(text ? { text } : {}) });
  shadow.handle({ type: "task.state", taskId: "t", state: "working", message: `Starting ${appName}…` });
  await sleep(700);
  if (pinned) {
    mv(pinned, "click", "Taskbar: " + appName);
    await sleep(500); shot("open-1a");
    await sleep(700); shot("open-1b");
    await sleep(1000); shot("open-1c");
    await sleep(500); shot("open-1d");
  }
  if (start) {
    mv(start, "click", "Start");
    await sleep(2300); shot("open-2-start");
    mv(start, "type", "Search", appName);
    await sleep(2700); shot("open-3-typing");
    mv(start, "submit", "Open " + appName);
    await sleep(2200); shot("open-4-enter");
  }
  shadow.handle({ type: "task.completed", taskId: "t", summary: "ok", verified: true });
  await sleep(2400);
  app.exit(0);
});
