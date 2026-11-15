// A dead-man switch for the real mouse and keyboard (humanInput.cjs).
//
// Everything Momo holds down is normally let go of before an operation ends, by ESC / Cancel, by a watchdog, or when the app quits.
// There is one case that cannot be handled from inside the app: the main process is killed outright (a crash, Task Manager, the
// machine sleeps and the app is forced away). Then its `exit` handlers never run and an injected mouse button or key could stay
// down, so the next click or keystroke would be wrong.
//
// This is a tiny companion process, started with the real pointer, that knows only what is CURRENTLY held (mouse button names and
// virtual-key codes: never text, names, positions or anything about the user) over Electron's private IPC channel. When the main
// process goes away the channel closes; the companion then releases exactly those items and exits. While the app runs it does
// nothing at all. If it cannot start, the app works exactly as before: this is a last line of defence, not a dependency.
"use strict";

const path = require("node:path");

const MOUSE_UP = 0x4, RIGHT_UP = 0x10, KEYUP = 0x2;

/** Release exactly what `held` names, nothing else. One failure never stops the rest. `native` is { sendMouse(up), sendKey(up, vk) }. */
function releaseHeld(native, held) {
  const buttons = Array.isArray(held && held.buttons) ? held.buttons : [];
  const keys = Array.isArray(held && held.keys) ? held.keys : [];
  let n = 0;
  // buttons first: a pointer that is still down is the more dangerous one
  for (const b of buttons) { try { if (native.sendMouse(b === "right")) n++; } catch { /* keep going */ } }
  for (const vk of [...keys].reverse()) { try { if (native.sendKey(Number(vk))) n++; } catch { /* keep going */ } }
  return n;
}

/** The real SendInput side, loaded only when the companion actually has something to release. */
function realNative() {
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const MOUSEINPUT = koffi.struct("MomoDmMouse", { dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" });
  const KEYBDINPUT = koffi.struct("MomoDmKey", { wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" });
  const INPUT = koffi.struct("MomoDmInput", { type: "uint32", u: koffi.union("MomoDmInputU", { mi: MOUSEINPUT, ki: KEYBDINPUT }) });
  const SendInput = user32.func("uint32 __stdcall SendInput(uint32 n, MomoDmInput *p, int cb)");
  const send = (type, mi, ki) => { const i = { type, u: { mi, ki } }; return SendInput(1, [i], koffi.sizeof(INPUT)) > 0; };
  return {
    sendMouse: (right) => send(0, { dx: 0, dy: 0, mouseData: 0, dwFlags: right ? RIGHT_UP : MOUSE_UP, time: 0, dwExtraInfo: 0 }, {}),
    sendKey: (vk) => send(1, {}, { wVk: vk, wScan: 0, dwFlags: KEYUP, time: 0, dwExtraInfo: 0 }),
  };
}

/** The companion itself: remember the last "what is held" message, release it when the parent disappears. */
function child() {
  let held = { buttons: [], keys: [] };
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const empty = !held.buttons.length && !held.keys.length;
    if (!empty) { try { releaseHeld(realNative(), held); } catch { /* nothing more can be done */ } }
    process.exit(0);
  };
  process.on("message", (m) => { if (m && typeof m === "object" && m.held) held = { buttons: m.held.buttons ?? [], keys: m.held.keys ?? [] }; });
  process.on("disconnect", finish);
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
}

let kid = null;

/** Start the companion once (no-op when it is already running or cannot start). */
function start(opts = {}) {
  if (kid) return kid;
  const { spawn } = opts.spawn || require("node:child_process");
  try {
    kid = spawn(process.execPath, [path.join(__dirname, "deadman.cjs"), "--child"], {
      // the same Electron binary, told to behave as plain Node (no window, no app)
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    kid.on("exit", () => { kid = null; });
    kid.on("error", () => { kid = null; });
    if (kid.unref) kid.unref(); // never keep the app alive for the dead-man's sake
    if (kid.channel && kid.channel.unref) kid.channel.unref();
    return kid;
  } catch {
    kid = null;
    return null;
  }
}

/** Tell the companion what is held right now (button names and virtual-key codes only). */
function report(held) {
  const k = kid;
  if (!k || !k.connected) return false;
  try { k.send({ held: { buttons: held?.buttons ?? [], keys: held?.keys ?? [] } }); return true; } catch { return false; }
}

module.exports = { start, report, releaseHeld, realNative, child };

if (process.argv.includes("--child")) child();
