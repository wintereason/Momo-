// Live check of dictation targeting against real windows (Momo's OWN test windows; nothing of yours is touched):
//   npm run build:runtime && npx electron scripts/smoke-targeting.cjs
// For each case it opens a small window, runs the real Detect -> Identify -> Focus -> Dictate -> Verify pipeline
// (UI Automation + clipboard + Ctrl+V) and reads the page back to see what really happened.
const { app, BrowserWindow, clipboard } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const koffi = require("koffi");
const { createInserter, createWinKeys } = require("../electron/insert.cjs");
const { createTargeting } = require("../electron/targeting.cjs");

const user32 = koffi.load("user32.dll");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(void*)");
const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
const keybd_event = user32.func("void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)");
app.commandLine.appendSwitch("enable-features", "UiaProvider"); // lets this test window report its text boxes to UI Automation, as a browser does
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const foreground = () => { const h = GetForegroundWindow(); return h ? { hwnd: Number(koffi.address(h)) } : null; };

async function open(name, body) {
  const win = new BrowserWindow({ width: 560, height: 320, show: true, title: "Momo targeting test " + name, alwaysOnTop: true });
  const file = path.join(os.tmpdir(), "momo-target-" + name + ".html");
  fs.writeFileSync(file, '<body style="font:18px Segoe UI">' + body + "</body>");
  await win.loadFile(file);
  keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0); // Windows only lets the foreground app take focus; an Alt tap lifts that
  SetForegroundWindow(win.getNativeWindowHandle());
  win.focus();
  await sleep(1000);
  // SAFETY: only ever type when the test window itself is in front, never into one of your own windows
  if (foreground().hwnd !== Number(win.getNativeWindowHandle().readBigUInt64LE(0))) { console.log("SKIP  the test window could not come to the front (Windows blocked it); nothing was typed anywhere"); app.exit(2); }
  return win;
}
const value = (win, id) => win.webContents.executeJavaScript(`document.getElementById('${id}').value`);
const run = (win, js) => win.webContents.executeJavaScript(js);

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  const rt = require("../electron/runtime.cjs");
  const saved = clipboard.readText();
  let failed = false;
  const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed = true; };
  const verbose = !!process.env.MOMO_SMOKE_VERBOSE;
  const uia = verbose ? { ...rt,
    focusField: async (h, r) => { const x = await rt.focusField(h, r); console.log("      focusField ->", JSON.stringify(x)); return x; },
    readBack: async (h, r, n) => { const x = await rt.readBack(h, r, n); console.log("      readBack ->", JSON.stringify(x)); return x; } } : rt;
  const make = () => createTargeting({ uia, foreground, inserter: createInserter({ clipboard, keys: createWinKeys(koffi) }), sleep });
  try {
    // 1. exactly one text box, not focused: Momo finds it, focuses it, writes it, verifies it
    let w = await open("one", '<p>Notes</p><textarea id="a" rows="3" cols="40" aria-label="Notes"></textarea>');
    await run(w, "document.body.focus(); document.activeElement.blur()");
    let t = make(); t.begin();
    let r = await t.deliver("Hello from Momo.");
    check("one field: written", r.kind === "inserted", JSON.stringify(r));
    check("one field: verified by reading it back", r.verification === "confirmed", r.verification);
    check("one field: the page really contains it", (await value(w, "a")) === "Hello from Momo.", JSON.stringify(await value(w, "a")));
    // 2. the field already has text and a cursor in the middle: nothing is overwritten
    await run(w, "(() => { const a=document.getElementById('a'); a.value='Hello world'; a.focus(); a.setSelectionRange(5,5) })()");
    t = make(); t.begin();
    r = await t.deliver(", dear");
    const v2 = await value(w, "a");
    check("cursor in the middle: inserted at the cursor", v2 === "Hello, dear world", JSON.stringify(v2));
    check("cursor in the middle: verified", r.verification === "confirmed", r.verification);
    // 3. a selection is in the way: it is kept, the text goes after it
    await run(w, "(() => { const a=document.getElementById('a'); a.value='keep this'; a.focus(); a.setSelectionRange(0,4) })()");
    t = make(); t.begin();
    r = await t.deliver("!");
    const v3 = await value(w, "a");
    check("selection: existing text is not overwritten", v3.includes("keep this") || v3 === "keep! this", JSON.stringify(v3) + " collapsed=" + r.collapsedSelection);
    w.destroy();

    // 4. several text boxes, none focused: asks, writes nothing until chosen, then writes into the chosen one
    w = await open("many", '<input id="to" aria-label="To"><br><input id="subj" aria-label="Subject"><br><textarea id="body" aria-label="Body"></textarea>');
    await run(w, "document.activeElement.blur()");
    t = make(); t.begin();
    r = await t.deliver("Quarterly update");
    check("several fields: asks", r.kind === "choose" && r.options.length === 3, JSON.stringify(r));
    check("several fields: nothing typed before choosing", (await value(w, "to")) === "" && (await value(w, "subj")) === "" && (await value(w, "body")) === "");
    const idx = r.kind === "choose" ? r.options.findIndex((o) => o.label === "Subject") : -1;
    r = await t.pick(idx);
    check("several fields: written into the chosen one only", (await value(w, "subj")) === "Quarterly update" && (await value(w, "to")) === "" && (await value(w, "body")) === "", JSON.stringify(r));
    w.destroy();

    // 5. no text box at all: asks for a click (and, in this test, the "click" is a real focus change)
    w = await open("none", "<p>Nothing to type into here.</p><button id=b>Button</button>");
    t = make(); t.begin();
    r = await t.deliver("Hello");
    check("no field: asks for a click", r.kind === "click", JSON.stringify(r));
    t.cancel();
    w.destroy();

    // 6. a password box: refused
    w = await open("pw", '<input id="p" type="password" aria-label="Password" autofocus>');
    await run(w, "document.getElementById('p').focus()");
    await sleep(500);
    t = make(); t.begin();
    r = await t.deliver("secret");
    const pv = await value(w, "p");
    check("password box: nothing typed", pv === "", JSON.stringify(pv) + " -> " + JSON.stringify(r));
    w.destroy();
  } catch (e) {
    console.log("FAIL  unexpected error:", e && e.stack);
    failed = true;
  } finally {
    try { clipboard.writeText(saved); } catch { /* ignore */ }
    app.exit(failed ? 1 : 0);
  }
});
