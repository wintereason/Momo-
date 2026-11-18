"use strict";
// The real OS input state, read directly from Windows (koffi is already a dependency of Momo's pointer). Used to prove that no key or
// mouse button is left held after a test, and to play the part of "the user grabs the mouse" in the takeover tests.
const P = require("./paths.cjs");

let api = null;
function load() {
  if (api) return api;
  const koffi = require(P.ROOT + "/node_modules/koffi");
  koffi.struct("MomoRealPt", { x: "int32", y: "int32" });
  koffi.struct("MomoRealRc", { l: "int32", t: "int32", r: "int32", b: "int32" });
  koffi.struct("MomoRealWp", { length: "uint32", flags: "uint32", showCmd: "uint32", ptMin: "MomoRealPt", ptMax: "MomoRealPt", rcNormal: "MomoRealRc" });
  const user32 = koffi.load("user32.dll");
  api = {
    koffi,
    key: user32.func("int16 __stdcall GetAsyncKeyState(int vk)"),
    set: user32.func("bool __stdcall SetCursorPos(int x, int y)"),
    get: user32.func("bool __stdcall GetCursorPos(_Out_ MomoRealPt *p)"),
    placement: user32.func("bool __stdcall GetWindowPlacement(uintptr_t h, _Inout_ MomoRealWp *wp)"),
    desktop: user32.func("uintptr_t __stdcall GetDesktopWindow()"),
  };
  return api;
}

// left, right, middle button; shift, ctrl, alt; both Windows keys. (Esc is left out: a person may legitimately be pressing it to stop the run.)
const HELD_VKS = [0x01, 0x02, 0x04, 0x10, 0x11, 0x12, 0x5b, 0x5c];

/** virtual-key codes of anything that is down right now */
function heldInputs(read = (vk) => load().key(vk)) { return HELD_VKS.filter((vk) => (read(vk) & 0x8000) !== 0); }
function cursor() { const p = {}; load().get(p); return { x: p.x, y: p.y }; }
function setCursor(x, y) { return load().set(x, y); }

/**
 * READ-ONLY: the window's placement as Windows keeps it: showCmd (1 normal, 2 minimized, 3 maximized) and rcNormalPosition, the "normal" rectangle a snapped or
 * maximized window returns to. These are WORKSPACE coordinates (relative to the work area, so a taskbar on the left shifts x). Returns null if it cannot be read.
 */
function windowPlacement(hwnd) {
  try {
    const a = load();
    const wp = { length: 44, flags: 0, showCmd: 0, ptMin: { x: 0, y: 0 }, ptMax: { x: 0, y: 0 }, rcNormal: { l: 0, t: 0, r: 0, b: 0 } };
    if (!a.placement(Number(hwnd), wp)) return null;
    return { showCmd: wp.showCmd, flags: wp.flags, normalPx: { l: wp.rcNormal.l, t: wp.rcNormal.t, w: wp.rcNormal.r - wp.rcNormal.l, h: wp.rcNormal.b - wp.rcNormal.t } };
  } catch { return null; }
}
const desktopWindow = () => Number(load().desktop());

module.exports = { heldInputs, cursor, setCursor, windowPlacement, desktopWindow, HELD_VKS, load };
