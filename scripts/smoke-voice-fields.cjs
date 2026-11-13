// Live check of "select the search bar" -> dictate -> "search" (Enter), on Momo's OWN test window (nothing of yours is touched):
//   npm run build:runtime && npx electron scripts/smoke-voice-fields.cjs
// It uses the real UI Automation ports: read the window (bounds + focus), put the cursor in a field, dictate into it, press Enter
// in it, and read what the page really did.
const { app, BrowserWindow, clipboard } = require("electron");
app.commandLine.appendSwitch("enable-features", "UiaProvider"); // lets this test window report its text boxes to UI Automation, as a browser does
const path = require("path"), os = require("os"), fs = require("fs");
const koffi = require("koffi");
const rt = require("../electron/runtime.cjs");
const { createInserter, createWinKeys } = require("../electron/insert.cjs");

const user32 = koffi.load("user32.dll");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(void*)");
const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
const keybd_event = user32.func("void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const saved = clipboard.readText();
  let failed = false;
  const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed = true; };
  try {
    const win = new BrowserWindow({ width: 640, height: 360, show: true, title: "Momo voice-field test", alwaysOnTop: true });
    const file = path.join(os.tmpdir(), "momo-voicefield-test.html");
    fs.writeFileSync(file, `<body style="font:18px Segoe UI"><input id="q" aria-label="Search" style="width:80%"><br><input id="other" aria-label="Notes" style="width:80%">
      <script>document.getElementById('q').addEventListener('keydown', e => { if (e.key === 'Enter') { document.title = 'Results for ' + e.target.value; e.target.value = ''; } });</script></body>`);
    await win.loadFile(file);
    keybd_event(0x12, 0, 0, 0); keybd_event(0x12, 0, 2, 0);
    SetForegroundWindow(win.getNativeWindowHandle());
    win.focus();
    await sleep(1200);
    const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));
    // SAFETY: only ever type when the test window itself is in front
    if (Number(koffi.address(GetForegroundWindow())) !== hwnd) { console.log("SKIP  the test window could not come to the front (Windows blocked it); nothing was typed anywhere"); app.exit(2); return; }
    await win.webContents.executeJavaScript("document.activeElement.blur()");

    // 1. the UI reader now reports where each control is and which one has the cursor
    let ui = await rt.nodeScreen.readUi(hwnd);
    const search = ui.ok && ui.items.find((n) => n.type === "Edit" && n.name === "Search");
    check("the reader finds the Search box with an on-screen rectangle", !!search && !!search.rect && search.rect.w > 50, JSON.stringify(search && search.rect));
    check("nothing has the cursor yet", ui.ok && !ui.items.some((n) => n.focused && n.type === "Edit"));

    // 2. "select the search bar": the cursor really moves into it
    const f = await rt.nodeInput.focusControl(hwnd, search.rid, search.name);
    check("select_field: focus reported", f.ok === true, JSON.stringify(f));
    ui = await rt.nodeScreen.readUi(hwnd);
    check("the page agrees: the Search box has the cursor", ui.ok && ui.items.some((n) => n.focused && n.name === "Search"));
    check("the page agrees (from inside the page)", (await win.webContents.executeJavaScript("document.activeElement.id")) === "q");

    // 3. dictate into it (the normal dictation paste)
    const ins = createInserter({ clipboard, keys: createWinKeys(koffi) });
    const r = await ins.insert("best pizza near me", {});
    await sleep(600);
    check("dictation went into the selected box", (await win.webContents.executeJavaScript("document.getElementById('q').value")) === "best pizza near me" && r.ok, JSON.stringify(r));
    check("and not into the other box", (await win.webContents.executeJavaScript("document.getElementById('other').value")) === "");

    // 4. "search" / "okay": Enter, in that field only, verified by what the page did
    // like the real tool: read the window again, take the field that has the cursor, then press Enter in exactly that one
    ui = await rt.nodeScreen.readUi(hwnd);
    const focusedNode = ui.items.find((n) => n.focused && n.type === "Edit");
    check("the field that has the cursor is the Search box", !!focusedNode && focusedNode.name === "Search");
    const s = await rt.nodeInput.submitControl(hwnd, focusedNode.rid, focusedNode.name);
    check("press_enter: reports the page changed", s.ok === true && s.changed === true, JSON.stringify(s));
    check("the page really ran the search", (await win.webContents.executeJavaScript("document.title")) === "Results for best pizza near me");

    // 5. Enter is refused when the cursor is NOT in the identified field
    await win.webContents.executeJavaScript("document.getElementById('other').focus()");
    await sleep(500);
    const bad = await rt.nodeInput.submitControl(hwnd, focusedNode.rid, focusedNode.name);
    check("Enter is refused when the cursor is elsewhere", bad.ok === false, JSON.stringify(bad));
    check("and nothing was submitted", (await win.webContents.executeJavaScript("document.title")) === "Results for best pizza near me");
    win.destroy();
  } catch (e) {
    console.log("FAIL  unexpected error:", e && e.stack);
    failed = true;
  } finally {
    try { clipboard.writeText(saved); } catch { /* ignore */ }
    app.exit(failed ? 1 : 0);
  }
});
