// LIVE check of input safety (phase 3) on REAL Windows windows. It only uses its own test window and a throwaway folder; nothing of
// yours is touched. Hands off the mouse and keyboard while it runs.
//   npm run build:runtime && node scripts/live-safety.cjs
//
// What it proves, with the same humanInput the app uses:
//   1. SOAK: many real clicks, shortcuts and typing in a row; the ledger is empty after every single one, and Windows itself reports no
//      mouse button or modifier still down at the end.
//   2. RIGHT-CLICK: a real context menu opens; the menu's own window is found under the pointer and read on its own (measuring how long
//      that takes, which is what the popup-only read is for).
//   3. ESC-DRAG: a real drag on a real file is cancelled with Esc half-way; the file is NOT dropped where the pointer happened to be.
//   4. TYPING GUARD: typing stops the moment the window it was typing into does not have the keyboard any more.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const koffi = require("koffi");
const rt = require("../electron/runtime.cjs");
const { createPointer } = require("../electron/humanInput.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };

const user32 = koffi.load("user32.dll");
const SetForegroundWindow = user32.func("bool __stdcall SetForegroundWindow(uintptr_t h)");
const ShowWindow = user32.func("bool __stdcall ShowWindow(uintptr_t h, int cmd)");
const GetAsyncKeyState = user32.func("int16 __stdcall GetAsyncKeyState(int vk)");
const keybd_event = user32.func("void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)");
const escTap = async () => { keybd_event(0x1b, 0, 0, 0); await sleep(60); keybd_event(0x1b, 0, 2, 0); };
const down = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;

let pointer = null;
const p = () => pointer;
const held = () => (pointer ? pointer.heldCount() : 0);
const clean = (why) => { if (held() !== 0) { pointer.releaseAll(); throw new Error("left something held after " + why + ": " + held()); } };

const windows = async () => (await rt.nodeWindows.query()).windows;
async function waitWindow(re, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const w = (await windows()).find((q) => re.test(q.title || ""));
    if (w) return w;
    await sleep(200);
  }
  return null;
}
const front = async (w) => { ShowWindow(w.hwnd, 9); SetForegroundWindow(w.hwnd); await sleep(350); };
const read = async (hwnd) => (await rt.nodeScreen.readUi(hwnd));
const find = (ui, re, type) => ui.ok && ui.items.find((n) => re.test(n.name || "") && n.rect && (!type || n.type === type));
const box = (n) => ({ x: Math.round(n.rect.l + n.rect.w / 2), y: Math.round(n.rect.t + n.rect.h / 2) });

async function main() {
  // ---------------------------------------------------------------- our own harmless test window
  const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "test-window.ps1"), "-Seconds", "240"], { windowsHide: true });
  const testWin = await waitWindow(/^Momo Test Window$/);
  if (!testWin) throw new Error("the test window did not open");
  await front(testWin);
  const ui0 = await read(testWin.hwnd);
  const clickMe = find(ui0, /^Click me$/, "Button");
  const search = find(ui0, /^Search box$/, "Edit");
  const item = find(ui0, /^Report\.docx$/, "ListItem");
  check("the test window is readable", !!(clickMe && search && item), `${ui0.ok ? ui0.items.length : "?"} controls`);

  pointer = createPointer(koffi, { onTrack() {}, onInterrupt() {} });
  pointer.arm();

  // ---------------------------------------------------------------- 1. soak: click, shortcut, type, repeat
  let okClicks = 0, firstBad = "";
  for (let i = 0; i < 12; i++) {
    const r = await p().click(box(clickMe).x, box(clickMe).y, { ms: 220, expectRoot: testWin.hwnd });
    if (r.ok) okClicks++; else if (!firstBad) firstBad = `click ${i + 1}: ${r.reason || (r.ok ? "" : "?")}`;
    clean(`click ${i + 1}`);
    const k = await p().press(i % 2 ? "ctrl+a" : "enter");
    if (!k.ok && !firstBad) firstBad = `press ${i + 1}: ${k.reason}`;
    clean(`key ${i + 1}`);
  }
  const ui1 = await read(testWin.hwnd);
  const status = find(ui1, /^Clicked \d+ times$/, "Text");
  check("12 real clicks in a row all landed, ledger empty after each", okClicks === 12 && !!status, `${okClicks}/12 ${status ? "(" + status.name + ")" : firstBad}`);

  // shortcuts and typing into a real text box (careful: ctrl+a selects; nothing is deleted)
  await p().click(box(search).x, box(search).y, { ms: 220, expectRoot: testWin.hwnd });
  const typed = await p().type("soak test 123", 6, { expectForeground: testWin.hwnd, expectWindow: testWin.hwnd });
  clean("typing");
  const ui2 = await read(testWin.hwnd);
  const box2 = ui2.ok && ui2.items.find((n) => /^Search box$/.test(n.name || ""));
  check("typing lands in the real text box and nothing stays held", typed.ok && !!box2 && /soak test 123/.test(box2.value || ""), box2 ? JSON.stringify(box2.value) : "no box");

  // ---------------------------------------------------------------- 2. right-click: the menu is its own window, read on its own
  pointer.disarm(); pointer.arm();
  await front(testWin);
  const ui3 = await read(testWin.hwnd);
  const file = find(ui3, /^Report\.docx$/, "ListItem");
  const t0 = Date.now();
  const rc = await p().click(box(file).x, box(file).y, { ms: 250, expectRoot: testWin.hwnd, button: "right" });
  let popup = 0;
  for (let i = 0; i < 40 && !popup; i++) { for (const [dx, dy] of [[0, 0], [6, 6], [12, 12]]) { const h = p().windowAt(box(file).x + dx, box(file).y + dy); if (h && h !== testWin.hwnd) { popup = h; break; } } if (!popup) await sleep(25); }
  let menuNames = [];
  let readMs = 0, readMs2 = 0;
  if (popup) {
    const r0 = Date.now(); const m = await read(popup); readMs = Date.now() - r0; if (m.ok) menuNames = m.items.map((n) => n.name).filter(Boolean);
    const r1 = Date.now(); await read(popup); readMs2 = Date.now() - r1; // a second look: the steady-state cost of a menu read
  }
  const uniq = [...new Set(menuNames)];
  const found = ["Open", "Rename", "Delete"].every((w) => uniq.includes(w));
  check("real context menu opens, is found under the pointer, and is read on its own", rc.ok && !!popup && found, `${Date.now() - t0} ms total, menu read ${readMs || "?"} ms (again ${readMs2 || "?"} ms): ${uniq.slice(0, 6).join(", ")}`);
  clean("right-click");
  await escTap(); // close the menu; the pointer sees Esc as a takeover, which is correct
  await sleep(250);

  // ---------------------------------------------------------------- 4. typing guard: not the focused window -> not a single key
  pointer.disarm(); pointer.arm();
  await front(testWin);
  const guard = await p().type("this must not be typed", 5, { expectForeground: testWin.hwnd + 1 });
  check("typing refuses when the window does not have the keyboard", !guard.ok && guard.reason === "focus_changed", guard.reason || "typed anyway");
  clean("typing guard");

  // ---------------------------------------------------------------- 3. Esc half-way through a real drag: the file is not dropped
  const root = path.join(os.tmpdir(), "momo-drag-test-" + Date.now());
  fs.mkdirSync(path.join(root, "Target"), { recursive: true });
  const filePath = path.join(root, "MoveMe.txt");
  fs.writeFileSync(filePath, "Momo drag test: with Esc this file must NOT be moved.\n");
  const ex = spawn("explorer.exe", [root], { detached: true, stdio: "ignore" });
  ex.unref();
  const exWin = await waitWindow(new RegExp(path.basename(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), 15000);
  let dragDetail = "Explorer window did not open";
  let notMoved = false;
  if (exWin) {
    await front(exWin);
    await sleep(600);
    const ue = await read(exWin.hwnd);
    const src = ue.ok && ue.items.find((n) => /^MoveMe\.txt$/i.test(n.name || "") && n.rect);
    const dst = ue.ok && ue.items.find((n) => /^Target$/i.test(n.name || "") && n.rect);
    if (src && dst) {
      pointer.disarm(); pointer.arm();
      const drag = p().drag(box(src), box(dst), { ms: 900, expectRoot: exWin.hwnd });
      await sleep(450); // mid-drag
      await escTap(); // the user cancels it
      const r = await drag;
      await sleep(400);
      notMoved = fs.existsSync(filePath) && !fs.existsSync(path.join(root, "Target", "MoveMe.txt"));
      dragDetail = `drag ${r.ok ? "reported ok" : r.reason}, file ${notMoved ? "still in place" : "WAS MOVED"}`;
      clean("esc-drag");
    } else dragDetail = `source ${!!src} / target ${!!dst} not both found (${ue.ok ? ue.items.length : "read failed"})`;
  }
  check("Esc half-way through a real file drag cancels it: the file is not dropped", notMoved, dragDetail);
  try { await rt.nodeInput.closeWindow(exWin.hwnd); } catch { /* the window may already be gone */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the shell may still hold it; it is a temp folder */ }

  // ---------------------------------------------------------------- nothing left down, according to Windows itself
  const stuck = [[0x01, "left button"], [0x02, "right button"], [0x10, "Shift"], [0x11, "Ctrl"], [0x12, "Alt"], [0x5b, "Win"], [0x0d, "Enter"], [0x41, "A"]].filter(([vk]) => down(vk)).map(([, n]) => n);
  check("Windows reports no button or key still down at the end", stuck.length === 0 && held() === 0, stuck.length ? "still down: " + stuck.join(", ") : "ledger 0");

  pointer.dispose();
  ps.kill();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("LIVE SAFETY FAILED:", e && e.message); try { pointer?.releaseAll(); } catch { /* ignore */ } process.exit(1); });
