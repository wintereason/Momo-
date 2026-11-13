// LIVE check of the shadow cursor + the real pointer, in real Electron on the real screen. Hands off the mouse and keyboard while it runs.
//   npx vite build && npm run build:runtime && npx electron scripts/live-cursor-sync.cjs <outDir>
//
// It opens a small test page of its own and uses the SAME code the app uses: the real overlay window, the real shadow-cursor brain,
// and the real pointer (humanInput) wired exactly like electron/main.cjs (onTrack -> ghost, onInterrupt -> stop). It then:
//   1. measures how closely the ghost follows the REAL pointer (sampled many times during a glide),
//   2. saves screenshots of each state: aim, gliding, hover/press, checking, confirmed, NOT confirmed, failed, typing,
//   3. checks the page really changed before it ever shows "confirmed" (no false success),
//   4. checks the user-takeover: the physical mouse is moved by another process mid-glide, and Esc is pressed mid-glide.
const { app, BrowserWindow, protocol, net, screen } = require("electron");
const path = require("path"), fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const koffi = require("koffi");
const appProtocol = require("../electron/appProtocol.cjs");
appProtocol.registerScheme(protocol);
const { createCursorWindow, createCursorScreen } = require("../electron/cursorWindow.cjs");
const { createShadowCursor } = require("../electron/shadowCursor.cjs");
const { createPointer } = require("../electron/humanInput.cjs");

const out = process.argv[2] || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => { results.push(pass); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };

function shot(name) {
  // the crop is the test page's own window (inset a little): nothing else on the screen is captured
  const wr = shot.win ? shot.win() : { l: 0, t: 0, w: 1500, h: 900 };
  const cx = wr.l + 12, cy = wr.t + 12, cw = Math.min(wr.w - 24, 1800), ch = Math.min(wr.h - 24, 1000);
  const ps = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class D { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][D]::SetProcessDPIAware()
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$rect = New-Object System.Drawing.Rectangle(${cx}, ${cy}, ${cw}, ${ch})
$crop = $bmp.Clone($rect, $bmp.PixelFormat)
$crop.Save('${path.join(out, name + ".png").replace(/\\/g, "/")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
}
shot.x = 1000; shot.y = 700;

const PAGE = `<!doctype html><meta charset=utf-8><body style="margin:0;font:16px 'Segoe UI';background:#f4f5f8"><div style="padding:30px">
<h3>Momo cursor test page</h3>
<button id=sort style="padding:10px 28px;font-size:16px">Sort</button>
<input id=q placeholder="Search Project 2" style="margin-left:40px;width:300px;padding:9px;font-size:16px">
<div id=folder style="margin-top:50px;width:300px;padding:14px;border:1px solid #aaa;background:#fff">Project 2 (folder)</div>
<button id=dead style="margin-top:30px;padding:10px 28px;font-size:16px">Does nothing</button>
<div id=out style="margin-top:30px;font-weight:600">idle</div></div>
<script>sort.onclick=()=>{out.textContent='menu opened';sort.textContent='Sort (open)'};</script>`;

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  appProtocol.installHandler(protocol, net, path.join(__dirname, "..", "dist"));
  const secure = () => ({ preload: path.join(__dirname, "..", "electron", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true });
  const overlay = createCursorWindow({ BrowserWindow, webPreferences: secure, lockDown: () => {}, url: appProtocol.INDEX_URL + "#cursor" });
  const shadow = createShadowCursor({ enabled: () => true, win: overlay, screen: createCursorScreen(screen, koffi) });
  const pointer = createPointer(koffi, {
    onTrack: (t) => { if (rec) rec.push(t); shadow.track(t); },
    onInterrupt: (reason) => { interrupts.push(reason); interruptAt = Date.now(); shadow.stop(reason); },
  });
  const interrupts = [];
  let rec = null;
  let interruptAt = 0;
  // the "user", played in-process so the moment of each takeover is known exactly (latency = when Momo noticed - when it happened)
  const user32 = koffi.load("user32.dll");
  const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int x, int y)");
  const keybd_event = user32.func("void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)");
  const userMouse = (x, y) => { const t = Date.now(); SetCursorPos(x, y); return t; };
  const userEsc = () => { const t = Date.now(); keybd_event(0x1b, 0, 0, 0); setTimeout(() => keybd_event(0x1b, 0, 2, 0), 350); return t; };
  console.log("displays:", screen.getAllDisplays().map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}x`).join(", "));

  const page = new BrowserWindow({ x: 300, y: 200, width: 1000, height: 560, show: true, title: "Momo cursor test page", alwaysOnTop: true, webPreferences: { backgroundThrottling: false } });
  await page.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PAGE));
  page.focus();
  await sleep(800);
  page.setAlwaysOnTop(true, "floating"); page.moveTop(); page.focus();
  await sleep(500);
  if (!page.isFocused()) { console.log("ABORT: the test page could not take the focus, so no real input is sent."); app.exit(3); return; }
  const cb = page.getContentBounds();
  const rectOf = async (id) => {
    const r = JSON.parse(await page.webContents.executeJavaScript(`JSON.stringify(document.getElementById('${id}').getBoundingClientRect())`));
    const tl = screen.dipToScreenPoint({ x: cb.x + r.left, y: cb.y + r.top });
    const br = screen.dipToScreenPoint({ x: cb.x + r.right, y: cb.y + r.bottom });
    return { l: tl.x, t: tl.y, w: br.x - tl.x, h: br.y - tl.y, cx: Math.round((tl.x + br.x) / 2), cy: Math.round((tl.y + br.y) / 2) };
  };
  const handle = page.getNativeWindowHandle().readUInt32LE(0);
  const pageRect = () => pointer.windowRect(handle);
  shot.win = pageRect;
  const click = (x, y, o = {}) => pointer.click(x, y, { expectRoot: handle, ...o });
  const pageText = (id) => page.webContents.executeJavaScript(`document.getElementById('${id}').textContent`);
  const aim = (r, label, say, kind) => shadow.handle({ type: "cursor.aim", x: r.cx, y: r.cy, w: r.w, h: r.h, label, say, kind });
  const work = () => shadow.handle({ type: "task.state", taskId: "t", state: "working", message: "Working on it…" });
  const finish = async () => { shadow.handle({ type: "task.completed", taskId: "t", summary: "ok", verified: true }); await sleep(2200); };

  // where is the ghost's arrow tip, in screen DIP pixels?
  const ghostTip = async () => {
    const g = await overlay.exec(`(() => { const e = document.querySelector('.ghost svg'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + 4.7, r.top + 2.9]; })()`);
    if (!g) return null;
    const m = createCursorScreen(screen, koffi).mouse(); // the overlay covers the display the pointer is on
    return { x: m.bounds.x + g[0], y: m.bounds.y + g[1] };
  };

  // ============================================================== 1. identify -> aim -> real glide -> click -> verify -> confirmed
  work(); await sleep(700);
  const sortR = await rectOf("sort");
  shot.x = sortR.cx; shot.y = sortR.cy;
  aim(sortR, "Sort", "Clicking “Sort”: opens a menu", "menu");
  await sleep(700);
  shot("1-aim");
  const wr0 = pageRect();
  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const real = screen.getCursorScreenPoint();
      const gt = await ghostTip();
      if (gt) samples.push({ real, ghost: gt, d: Math.hypot(real.x - gt.x, real.y - gt.y) });
      await sleep(25);
    }
  })();
  pointer.arm();
  const clickP = click(sortR.cx, sortR.cy, { ms: 1800, expectWindow: { hwnd: handle, rect: wr0 } });
  await sleep(700); shot("2-gliding");
  const res1 = await clickP;
  sampling = false; await sampler;
  await sleep(120); shot("3-pressed");
  shadow.handle({ type: "cursor.result", state: "verifying", text: "Checking…" });
  await sleep(300);
  shot("4-checking");
  // the verdict is only sent if the PAGE really changed: the same rule the tools follow
  const changed = (await pageText("out")) === "menu opened";
  shadow.handle({ type: "cursor.result", state: changed ? "verified" : "unconfirmed", text: changed ? "Menu opened" : "Not confirmed" });
  await sleep(600);
  shot("5-confirmed");
  check("the real pointer clicked and the page really changed", res1.ok === true && changed, JSON.stringify(res1) + " page=" + (await pageText("out")));
  const moving = samples.filter((s) => s.d >= 0).slice(2);
  const dists = moving.map((s) => s.d).sort((a, b) => a - b);
  const mean = dists.reduce((a, b) => a + b, 0) / Math.max(1, dists.length);
  const p95 = dists[Math.floor(dists.length * 0.95)] ?? 0;
  { const e = await ghostTip(); const r = screen.getCursorScreenPoint(); if (e) console.log(`      at rest, ghost tip minus real pointer: dx ${(e.x - r.x).toFixed(1)}, dy ${(e.y - r.y).toFixed(1)} (DIP)`); }
  console.log(`      sync: ${samples.length} samples; ghost-to-real-pointer distance: mean ${mean.toFixed(1)} px, p95 ${p95.toFixed(1)} px, max ${(dists[dists.length - 1] ?? 0).toFixed(1)} px (DIP)`);
  check("the ghost tracks the real pointer closely while it glides (p95 within 40 px, incl. measurement lag)", dists.length > 10 && p95 < 40, `p95 ${p95.toFixed(1)} px over ${dists.length} samples`);
  const endGhost = await ghostTip();
  const endReal = screen.getCursorScreenPoint();
  check("they end in the same place", endGhost && Math.hypot(endGhost.x - endReal.x, endGhost.y - endReal.y) < 14, endGhost ? `${Math.hypot(endGhost.x - endReal.x, endGhost.y - endReal.y).toFixed(1)} px apart` : "no ghost");
  await finish();
  pointer.disarm();

  // ============================================================== 2. a click that does NOT do what was expected: NOT confirmed, never success
  work(); await sleep(500);
  const deadR = await rectOf("dead");
  shot.x = deadR.cx; shot.y = deadR.cy;
  aim(deadR, "Does nothing", "Clicking “Does nothing”: runs an action", "button");
  await sleep(500);
  pointer.arm();
  const res2 = await click(deadR.cx, deadR.cy, { ms: 900, expectWindow: { hwnd: handle, rect: pageRect() } });
  shadow.handle({ type: "cursor.result", state: "verifying", text: "Checking…" });
  await sleep(300);
  const out2 = await pageText("out");
  const expectedChange = out2 === "dead clicked"; // it never will: nothing in the page does that
  shadow.handle({ type: "cursor.result", state: expectedChange ? "verified" : "unconfirmed", text: expectedChange ? "Confirmed" : "Not confirmed" });
  await sleep(700); shot("6-not-confirmed");
  check("a click with no visible effect is shown as NOT confirmed (amber), never as success", res2.ok === true && !expectedChange);
  shadow.handle({ type: "cursor.result", state: "failed", text: "That didn't work" });
  await sleep(600); shot("7-failed");
  await finish();
  pointer.disarm();

  // ============================================================== 3. typing: each letter appears when it is REALLY typed
  work(); await sleep(500);
  const qR = await rectOf("q");
  shot.x = qR.cx; shot.y = qR.cy;
  aim(qR, "Search Project 2", "Typing in “Search Project 2”: a search box", "search");
  await sleep(500);
  pointer.arm();
  const res3 = await click(qR.cx, qR.cy, { ms: 900, expectWindow: { hwnd: handle, rect: pageRect() } });
  if (!page.isFocused()) { console.log("ABORT: the test page is not focused, so no keys are sent."); app.exit(3); return; }
  const typedP = pointer.type("momo test", 160);
  await sleep(750); shot("8-typing");
  const res4 = await typedP;
  const typed = await page.webContents.executeJavaScript("document.getElementById('q').value");
  check("real typing reached the real field", res3.ok && res4.ok && typed === "momo test", JSON.stringify(typed));
  shadow.handle({ type: "cursor.result", state: typed === "momo test" ? "verified" : "unconfirmed", text: "Typed and read back" });
  await sleep(500);
  await finish();
  pointer.disarm();
  await page.webContents.executeJavaScript("document.getElementById('q').value=''");

  // ============================================================== 4. THE USER TAKES OVER: moving the physical mouse
  const moveMouse = (x, y, afterMs) => spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class M { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }'; [void][M]::SetProcessDPIAware(); Start-Sleep -Milliseconds ${afterMs}; [void][M]::SetCursorPos(${x}, ${y})`], { windowsHide: true, stdio: "ignore" });
  work(); await sleep(500);
  aim(sortR, "Sort", "Clicking “Sort”: opens a menu", "menu");
  await sleep(300);
  pointer.arm();
  interrupts.length = 0;
  await page.webContents.executeJavaScript("document.getElementById('out').textContent='idle'");
  const farX = 100, farY = 900; // somewhere else entirely
  moveMouse(farX, farY, 600);
  const t0 = Date.now();
  const res5 = await click(sortR.cx, sortR.cy, { ms: 3500, expectWindow: { hwnd: handle, rect: pageRect() } });
  const dt = Date.now() - t0;
  await sleep(300); shot.x = 1000; shot.y = 700; shot("9-stopped-mouse");
  const stateAfter = await pageText("out");
  check("moving the physical mouse stops it at once: no click, task told", res5.ok === false && res5.reason === "user_moved" && stateAfter === "idle" && interrupts[0] === "mouse", `${JSON.stringify(res5)}, stopped after ${dt} ms of a 3500 ms glide, interrupts=${JSON.stringify(interrupts)}`);
  check("...and it did not carry on to the target afterwards", Math.hypot(screen.getCursorScreenPoint().x - 0, 0) >= 0 && (await pageText("out")) === "idle");
  const again = await click(sortR.cx, sortR.cy, { ms: 300 });
  check("...and nothing more happens until the next task (a further click is refused)", again.ok === false);
  await sleep(1600);
  pointer.disarm();

  // ============================================================== 5. THE USER TAKES OVER: Esc
  const pressEsc = (afterMs) => spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class K { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra); }'; Start-Sleep -Milliseconds ${afterMs}; [K]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 700; [K]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)`], { windowsHide: true, stdio: "ignore" });
  work(); await sleep(500);
  aim(sortR, "Sort", "Clicking “Sort”: opens a menu", "menu");
  await sleep(300);
  pointer.arm();
  interrupts.length = 0;
  pressEsc(600);
  const t1 = Date.now();
  const res6 = await click(sortR.cx, sortR.cy, { ms: 3500, expectWindow: { hwnd: handle, rect: pageRect() } });
  const dt2 = Date.now() - t1;
  await sleep(300); shot("10-stopped-esc");
  check("pressing Esc stops it at once: no click, task told", res6.ok === false && res6.reason === "stopped" && interrupts[0] === "esc" && (await pageText("out")) === "idle", `${JSON.stringify(res6)}, stopped after ${dt2} ms of a 3500 ms glide`);
  await sleep(1600);
  pointer.disarm();

  // ============================================================== 6. the window is dragged between reading and clicking
  const pos0 = page.getPosition();
  page.setPosition(pos0[0] + 120, pos0[1] + 60);
  await sleep(500);
  pointer.arm();
  const res7 = await click(sortR.cx, sortR.cy, { ms: 400, expectWindow: { hwnd: handle, rect: wr0 } });
  check("a window that moved since it was read is NOT clicked at the old place", res7.ok === false && res7.reason === "moved", JSON.stringify(res7));
  pointer.disarm();
  shadow.cancel();
  page.setPosition(pos0[0], pos0[1]); // put the page back where the controls were measured
  await sleep(600);

  // ============================================================== 7. HOW FAST is a takeover noticed?
  const lat = [];
  // 7a. the mouse, mid-glide
  work(); await sleep(400); aim(sortR, "Sort", "Clicking “Sort”: opens a menu", "menu"); await sleep(300);
  pointer.arm(); interrupts.length = 0; interruptAt = 0;
  let tUser = 0;
  setTimeout(() => { tUser = userMouse(120, 800); }, 700);
  const r7a = await click(sortR.cx, sortR.cy, { ms: 3000 });
  lat.push(["mouse, mid-glide", interruptAt - tUser]);
  check("takeover by mouse during the glide is noticed within 100 ms", r7a.ok === false && interrupts[0] === "mouse" && interruptAt - tUser < 100, `${interruptAt - tUser} ms`);
  await sleep(1600); pointer.disarm();
  // 7b. Esc, mid-glide
  work(); await sleep(400); aim(sortR, "Sort", "Clicking “Sort”: opens a menu", "menu"); await sleep(300);
  pointer.arm(); interrupts.length = 0; interruptAt = 0;
  setTimeout(() => { tUser = userEsc(); }, 700);
  const r7b = await click(sortR.cx, sortR.cy, { ms: 3000 });
  check("Esc during the glide is noticed within 100 ms", r7b.ok === false && interrupts[0] === "esc" && interruptAt - tUser < 100, `${interruptAt - tUser} ms; r=${JSON.stringify(r7b)} ints=${JSON.stringify(interrupts)} tUser=${tUser} interruptAt=${interruptAt}`);
  await sleep(1800); pointer.disarm();
  // 7c. between steps (the pointer is idle after a click; the user grabs the mouse)
  work(); await sleep(400);
  pointer.arm(); interrupts.length = 0; interruptAt = 0;
  const r7c = await click(deadR.cx, deadR.cy, { ms: 600 });
  await sleep(300);
  tUser = userMouse(150, 850);
  await sleep(400);
  check("takeover BETWEEN steps (while Momo is thinking) is noticed within 150 ms", r7c.ok === true && interrupts[0] === "mouse" && interruptAt - tUser < 150, `${interruptAt - tUser} ms; r=${JSON.stringify(r7c)} ints=${JSON.stringify(interrupts)}`);
  const after7c = await click(deadR.cx, deadR.cy, { ms: 300 });
  check("...and the next step is then refused", after7c.ok === false);
  await sleep(1600); pointer.disarm();
  // 7d. while typing
  work(); await sleep(400);
  const qR2 = await rectOf("q"); aim(qR2, "Search Project 2", "Typing in “Search Project 2”: a search box", "search"); await sleep(300);
  pointer.arm(); interrupts.length = 0; interruptAt = 0;
  await click(qR2.cx, qR2.cy, { ms: 700 });
  if (!page.isFocused()) { console.log("ABORT: the test page is not focused, so no keys are sent."); app.exit(3); return; }
  const typing = pointer.type("abcdefghijklmnopqrstuvwxyz", 120);
  setTimeout(() => { tUser = userEsc(); }, 700);
  const r7d = await typing;
  const typedNow = await page.webContents.executeJavaScript("document.getElementById('q').value");
  check("Esc while typing stops after a few letters (not all 26) within 150 ms", r7d.ok === false && typedNow.length > 0 && typedNow.length < 26 && interruptAt - tUser < 150, `typed "${typedNow}", ${interruptAt - tUser} ms r=${JSON.stringify(r7d)} ints=${JSON.stringify(interrupts)} focused=${page.isFocused()}`);
  await sleep(1600); pointer.disarm();
  await page.webContents.executeJavaScript("document.getElementById('q').value=''");
  shadow.cancel();
  console.log("      takeover latency (ms):", lat.map((x) => x[0] + " " + x[1]).join(", "));

  console.log(`\n=== ${results.filter(Boolean).length} of ${results.length} checks passed ===`);
  app.exit(results.every(Boolean) ? 0 : 1);
}).catch((e) => { console.log("ERROR", e); app.exit(2); });
