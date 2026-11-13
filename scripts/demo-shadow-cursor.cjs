// Live demo + check of the shadow cursor on the REAL screen, with the same code the app uses:
//   npx vite build && npm run build:runtime && npx electron scripts/demo-shadow-cursor.cjs <outDir>
// It opens a small test window (Momo's own), drives the ghost through select -> type -> Enter -> close with real UI Automation
// positions, and saves screenshots of the screen at moments in between, so you can SEE it move. Nothing of yours is touched.
const { app, BrowserWindow, protocol, net, screen } = require("electron");
app.commandLine.appendSwitch("enable-features", "UiaProvider");
const path = require("path"), fs = require("fs"), os = require("os");
const { spawnSync } = require("child_process");
const koffi = require("koffi");
const appProtocol = require("../electron/appProtocol.cjs");
appProtocol.registerScheme(protocol);
const rt = require("../electron/runtime.cjs");
const { createCursorWindow, createCursorScreen } = require("../electron/cursorWindow.cjs");
const { createShadowCursor } = require("../electron/shadowCursor.cjs");

const out = process.argv[2] || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // a test window with a search box, away from the top-left so the glide is long enough to see
  const win = new BrowserWindow({ x: 700, y: 420, width: 760, height: 380, show: true, title: "Momo demo window", alwaysOnTop: false });
  const f = path.join(os.tmpdir(), "momo-cursor-demo.html");
  fs.writeFileSync(f, '<body style="font:20px Segoe UI;padding:24px"><h3>Search the web</h3><input id=q aria-label="Search" style="width:90%;font-size:22px;padding:8px"><p><button>Go</button></p></body>');
  await win.loadFile(f);
  const user32 = koffi.load("user32.dll");
  const SFW = user32.func("bool __stdcall SetForegroundWindow(void*)");
  const kb = user32.func("void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)");
  kb(0x12, 0, 0, 0); kb(0x12, 0, 2, 0); SFW(win.getNativeWindowHandle()); win.focus(); // a browser page exposes its boxes once it is in front
  await sleep(1500);
  const GFW = user32.func("void* __stdcall GetForegroundWindow()");
  console.log("test window in front:", Number(koffi.address(GFW())) === Number(win.getNativeWindowHandle().readBigUInt64LE(0)));
  await win.webContents.executeJavaScript("document.getElementById('q').focus(); document.activeElement.blur()");
  await sleep(600);
  const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));
  // The box's position, taken from the page itself (CSS px = DIP), converted to the PHYSICAL pixels UI Automation would report.
  // (Windows may refuse to bring a test window to the front while you use another one, and then UI Automation cannot see
  // inside it; the shell code under test starts from the same physical rectangle either way.)
  const r = await win.webContents.executeJavaScript("(()=>{const b=document.getElementById('q').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})()");
  const content = win.getContentBounds();
  const tl = screen.dipToScreenPoint({ x: content.x + r.x, y: content.y + r.y });
  const k = screen.getDisplayNearestPoint({ x: content.x + r.x, y: content.y + r.y }).scaleFactor || 1;
  const node = { rect: { l: tl.x, t: tl.y, w: Math.round(r.w * k), h: Math.round(r.h * k) } };
  const mouse = screen.getCursorScreenPoint();
  console.log("real mouse (DIP):", mouse.x, mouse.y, " search box (physical):", JSON.stringify(node.rect));

  const send = (e) => shadow.handle(e);
  send({ type: "task.state", taskId: "t", state: "working", message: "Selecting the search box…" });
  await sleep(500);   shot("demo-1-appears");
  send({ type: "cursor.move", x: Math.round(node.rect.l + node.rect.w / 2), y: Math.round(node.rect.t + node.rect.h / 2), w: node.rect.w, h: node.rect.h, action: "select", label: "Search" });
  await sleep(1300);  shot("demo-2-mid-glide");
  await sleep(1000);  shot("demo-3-arrived-select");
  send({ type: "task.state", taskId: "t", state: "working", message: "Typing…" });
  send({ type: "cursor.move", x: Math.round(node.rect.l + node.rect.w / 2), y: Math.round(node.rect.t + node.rect.h / 2), w: node.rect.w, h: node.rect.h, action: "type", label: "Search" });
  await sleep(1600);  shot("demo-4-typing");
  send({ type: "cursor.move", x: Math.round(node.rect.l + node.rect.w / 2), y: Math.round(node.rect.t + node.rect.h / 2), w: node.rect.w, h: node.rect.h, action: "submit", label: "Search" });
  await sleep(2500);  shot("demo-5-enter");
  send({ type: "cursor.window", hwnd, action: "close", label: "Momo demo window" });
  await sleep(2200);  shot("demo-6-close");
  send({ type: "task.completed", taskId: "t", summary: "ok", verified: true });
  await sleep(500);   shot("demo-7-done");
  await sleep(2400);
  console.log("after the linger the ghost is hidden:", !shadow.isVisible());
  app.exit(0);
});
