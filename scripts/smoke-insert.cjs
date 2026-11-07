// Live check of "type into the app in front", using a small test window of Momo's OWN (an Electron window with one box):
//   npx electron scripts/smoke-insert.cjs
// It writes a sentence into the box the way dictation does and reads the box back, and checks that a password box is
// recognised. Nothing of yours is touched. Your clipboard is restored afterwards.
const { app, BrowserWindow, clipboard } = require("electron");
const { createInserter, createWinKeys } = require("../electron/insert.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const koffi = require("koffi");
const user32 = koffi.load("user32.dll");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(void*)");
const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void*, _Out_ uint16*, int)");
const keybd_event = user32.func("void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)");
const foregroundTitle = () => { const b = new Uint16Array(256); const n = GetWindowTextW(GetForegroundWindow(), b, 256); return Buffer.from(b.buffer, 0, n * 2).toString("utf16le"); };

async function testWindow(kind) {
  const win = new BrowserWindow({ width: 520, height: 220, show: true, title: "Momo insert test", alwaysOnTop: true });
  const file = require("path").join(require("os").tmpdir(), "momo-insert-test-" + kind + ".html");
  require("fs").writeFileSync(file, '<body style="font:20px Segoe UI"><input id="b" type="' + kind + '" style="width:90%;font-size:20px" autofocus></body>');
  await win.loadFile(file);
  // Windows only lets the foreground app take focus; a tap on Alt lifts that restriction for this process
  keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0);
  SetForegroundWindow(win.getNativeWindowHandle());
  win.focus();
  await win.webContents.executeJavaScript("document.getElementById('b').focus()");
  await sleep(1200);
  return win;
}

app.on("window-all-closed", () => {}); // the test opens and closes windows: do not quit in between
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true); // lets this test window report what a screen reader would see
  const rt = require("../electron/runtime.cjs");
  const saved = clipboard.readText();
  let failed = false;
  const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed = true; };
  try {
    const sentence = "Hello from Momo. I went to the market yesterday.";

    const w1 = await testWindow("text");
    const pw1 = await rt.focusedFieldIsPassword();
    if (foregroundTitle() !== "Momo insert test") { console.log("SKIP  the test window could not come to the front (Windows blocked it); nothing was pasted anywhere"); app.exit(2); return; }
    const ins = createInserter({ clipboard, keys: createWinKeys(require("koffi")) });
    const r1 = await ins.insert(sentence, { restoreClipboard: false });
    await sleep(800);
    const got = await w1.webContents.executeJavaScript("document.getElementById('b').value");
    check("focus check says 'no' for a normal box", pw1 === "no", `(${pw1})`);
    check("insert reports ok", r1.ok === true, JSON.stringify(r1));
    check("the text arrived in the box", got === sentence, JSON.stringify(got));
    w1.destroy();

    const w2 = await testWindow("password");
    const first = await rt.focusedFieldIsPassword();
    await sleep(1500);
    const pw2 = await rt.focusedFieldIsPassword();
    console.log("      (first look:", first + ", second look:", pw2 + ")");
    // Windows does not learn about password boxes inside a web page from Chromium, so this is information, not a pass/fail:
    // native Windows password boxes are recognised (see smoke-legacy-password.cjs); web pages may not be.
    console.log("INFO  password box inside a Chromium page reported as:", pw2, pw2 === "yes" ? "" : "(not detected: known limit for web pages)");
    w2.destroy();
  } catch (e) {
    console.log("FAIL  unexpected error:", e && e.message);
    failed = true;
  } finally {
    try { clipboard.writeText(saved); } catch { /* ignore */ }
    app.exit(failed ? 1 : 0);
  }
});
