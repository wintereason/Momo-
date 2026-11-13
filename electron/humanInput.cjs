// The REAL mouse and keyboard, used when Momo acts "like a person" (Settings -> General -> Human-like control).
// It is a narrow tool, not a remote control:
//  * the pointer GLIDES to the target (never teleports) so the user can watch it, together with the shadow cursor, which is driven by
//    the pointer's ACTUAL positions (onTrack), so the two can never drift apart;
//  * before it presses anything it checks which window is under the pointer, and that the window has not moved since it was read;
//  * the USER ALWAYS WINS: while a task is armed, a watchdog notices the user moving the physical mouse or pressing Esc (during the
//    glide, while typing and between steps) and the whole task is stopped at once (onInterrupt);
//  * keys go only to whatever has the focus right now, and the caller has already identified that field.
// Windows only (koffi). Coordinates are physical pixels, the same ones UI Automation reports.
"use strict";

const VK = {
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b,
};
for (let i = 1; i <= 12; i++) VK["f" + i] = 0x6f + i;
const KEYUP = 0x2, UNICODE = 0x4;
const MOUSE_DOWN = 0x2, MOUSE_UP = 0x4, MOUSE_MOVE = 0x1;
const VK_ESCAPE = 0x1b;
/** how far the real pointer may be from where Momo put it before we decide the user grabbed the mouse */
const TAKEOVER_PX = 28;
/** a window counts as "has not moved" when its box is within this many pixels of when it was read */
const WINDOW_SLACK_PX = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Which keys are meant by "ctrl+a" / "enter" / "win": [modifiers..., key], or null when anything is unknown. */
function parseKeys(spec) {
  const parts = String(spec).toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return null;
  const codes = [];
  for (const p of parts) {
    if (VK[p] !== undefined) codes.push(VK[p]);
    else if (/^[a-z0-9]$/.test(p)) codes.push(p.toUpperCase().charCodeAt(0));
    else return null;
  }
  return codes;
}

/** The Win32 side (koffi). Everything the logic below needs from Windows, so the logic can be tested with a fake. */
function createNative(koffi) {
  const user32 = koffi.load("user32.dll");
  const POINT = koffi.struct("MomoHiPoint", { x: "int32", y: "int32" });
  void POINT;
  const RECT = koffi.struct("MomoHiRect", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
  void RECT;
  const MOUSEINPUT = koffi.struct("MomoHiMouse", { dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" });
  const KEYBDINPUT = koffi.struct("MomoHiKey", { wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" });
  const INPUT = koffi.struct("MomoHiInput", { type: "uint32", u: koffi.union("MomoHiInputU", { mi: MOUSEINPUT, ki: KEYBDINPUT }) });
  const SendInput = user32.func("uint32 __stdcall SendInput(uint32 n, MomoHiInput *p, int cb)");
  const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ MomoHiPoint *p)");
  const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int x, int y)");
  const WindowFromPoint = user32.func("uintptr_t __stdcall WindowFromPoint(MomoHiPoint p)");
  const GetAncestor = user32.func("uintptr_t __stdcall GetAncestor(uintptr_t h, uint32 flags)");
  const GetClassNameW = user32.func("int __stdcall GetClassNameW(uintptr_t h, _Out_ uint16_t *buf, int n)");
  const GetWindowRect = user32.func("bool __stdcall GetWindowRect(uintptr_t h, _Out_ MomoHiRect *r)");
  const GetAsyncKeyState = user32.func("int16 __stdcall GetAsyncKeyState(int vk)");
  // coordinates here are PHYSICAL pixels (what UI Automation reports). Electron is already DPI-aware; a plain Node process is not, and
  // would have its coordinates silently scaled, so ask for it (harmless when it is already set).
  try { user32.func("bool __stdcall SetProcessDpiAwarenessContext(intptr_t c)")(-4); } catch { /* already set, or an old Windows */ }
  const cb = koffi.sizeof(INPUT);

  const key = (vk, flags, scan = 0) => ({ type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
  const mouse = (flags, dx = 0, dy = 0) => ({ type: 0, u: { mi: { dx, dy, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
  const root = (x, y) => {
    try {
      const h = Number(WindowFromPoint({ x: Math.round(x), y: Math.round(y) }));
      return h ? Number(GetAncestor(h, 2)) || h : 0; // GA_ROOT: the top-level window that owns whatever is under the pointer
    } catch { return 0; }
  };
  return {
    pos: () => { const p = { x: 0, y: 0 }; GetCursorPos(p); return p; },
    setPos: (x, y) => { SetCursorPos(x, y); },
    escDown: () => (GetAsyncKeyState(VK_ESCAPE) & 0x8000) !== 0,
    windowAt: root,
    classAt: (x, y) => {
      try {
        const h = root(x, y);
        if (!h) return "";
        const buf = new Array(128).fill(0);
        const n = GetClassNameW(h, buf, 128);
        return String.fromCharCode(...buf.slice(0, Math.max(0, n)));
      } catch { return ""; }
    },
    windowRect: (hwnd) => {
      try {
        const r = {};
        if (!GetWindowRect(hwnd, r)) return null;
        return { l: r.left, t: r.top, w: r.right - r.left, h: r.bottom - r.top };
      } catch { return null; }
    },
    mouseDown: () => SendInput(1, [mouse(MOUSE_DOWN)], cb) === 1,
    mouseUp: () => { SendInput(1, [mouse(MOUSE_UP)], cb); },
    nudge: (dx) => { SendInput(1, [mouse(MOUSE_MOVE, dx, 0)], cb); },
    keyDown: (vk) => { SendInput(1, [key(vk, 0)], cb); },
    keyUp: (vk) => { SendInput(1, [key(vk, KEYUP)], cb); },
    unit: (u) => SendInput(2, [key(0, UNICODE, u), key(0, UNICODE | KEYUP, u)], cb) === 2,
  };
}

/**
 * The logic: gliding, guarding, typing, and the user-takeover watchdog. Tested with a fake `native`.
 * @param {ReturnType<typeof createNative>} native
 * @param {{ wait?: (ms:number)=>Promise<void>, watchMs?: number,
 *           onTrack?: (e: { x?: number, y?: number, phase: string, ch?: string, reason?: string }) => void,
 *           onInterrupt?: (reason: "mouse" | "esc") => void }} [opts]
 */
function createPointerFrom(native, opts = {}) {
  const wait = opts.wait || sleep;
  const track = (e) => { try { if (opts.onTrack) opts.onTrack(e); } catch { /* the ghost is decoration: never let it break a click */ } };
  let armed = false;
  let stopped = null;      // "mouse" | "esc" once the user has taken over; sticky until the next task is armed
  let expected = null;     // where Momo last put the pointer: anything else means the user moved it
  let moving = false;      // Momo is gliding right now (the glide checks for itself)
  let timer = null;

  const stoppedResult = () => ({ ok: false, reason: stopped === "esc" ? "stopped" : "user_moved" });

  function interrupt(reason) {
    if (stopped) return;
    stopped = reason;
    track({ phase: "stop", reason });
    try { if (opts.onInterrupt) opts.onInterrupt(reason); } catch { /* ignore */ }
  }

  /** has the user touched the mouse (away from where Momo left it) or pressed Esc? */
  function checkUser() {
    if (stopped) return true;
    if (native.escDown()) { interrupt("esc"); return true; }
    if (expected) {
      const p = native.pos();
      if (Math.hypot(p.x - expected.x, p.y - expected.y) > TAKEOVER_PX) { interrupt("mouse"); return true; }
    }
    return false;
  }

  function startWatch() {
    if (timer) return;
    timer = setInterval(() => { if (armed && !moving && !stopped) checkUser(); }, opts.watchMs || 40);
    if (timer.unref) timer.unref();
  }
  function stopWatch() { if (timer) { clearInterval(timer); timer = null; } }

  function windowMoved(w) {
    if (!w || !w.rect || !w.hwnd) return false;
    const now = native.windowRect(w.hwnd);
    if (!now) return true; // it is gone
    const r = w.rect;
    return Math.abs(now.l - r.l) > WINDOW_SLACK_PX || Math.abs(now.t - r.t) > WINDOW_SLACK_PX || Math.abs(now.w - r.w) > WINDOW_SLACK_PX || Math.abs(now.h - r.h) > WINDOW_SLACK_PX;
  }

  async function click(x, y, o) {
    try {
      if (stopped) return stoppedResult();
      if (checkUser()) return stoppedResult();
      if (windowMoved(o.expectWindow)) return { ok: false, reason: "moved" };
      const ms = Math.max(120, Math.min(2500, o.ms || 700));
      const from = native.pos();
      const tx = Math.round(x), ty = Math.round(y);
      const steps = Math.max(8, Math.round(ms / 16));
      let lx = from.x, ly = from.y;
      moving = true;
      try {
        for (let i = 1; i <= steps; i++) {
          if (native.escDown()) { interrupt("esc"); return stoppedResult(); }
          const now = native.pos();
          if (Math.hypot(now.x - lx, now.y - ly) > TAKEOVER_PX) { interrupt("mouse"); return stoppedResult(); } // the user grabbed the mouse
          const k = ease(i / steps);
          lx = Math.round(from.x + (tx - from.x) * k); ly = Math.round(from.y + (ty - from.y) * k);
          native.setPos(lx, ly);
          track({ x: lx, y: ly, phase: "move" }); // the ghost goes exactly where the real pointer went
          await wait(ms / steps);
        }
        const end = native.pos();
        if (Math.hypot(end.x - tx, end.y - ty) > TAKEOVER_PX) { interrupt("mouse"); return stoppedResult(); }
        expected = { x: tx, y: ty };
        if (o.expectRoot && native.windowAt(tx, ty) !== o.expectRoot) return { ok: false, reason: "covered" }; // something else is in front there
        if (o.expectClass && !o.expectClass.includes(native.classAt(tx, ty))) return { ok: false, reason: "covered" }; // e.g. the taskbar is hidden behind a full-screen app
        if (native.escDown()) { interrupt("esc"); return stoppedResult(); }
        if (windowMoved(o.expectWindow)) return { ok: false, reason: "moved" }; // the window was dragged while the pointer travelled
        track({ x: tx, y: ty, phase: "hover" });
        // let the target see the pointer ARRIVE (hover states, breadcrumbs, menus need a real mouse-move event before a click counts)
        native.nudge(1); await wait(30); native.nudge(-1);
        await wait(o.hoverMs === undefined ? 110 : o.hoverMs);
      } finally { moving = false; }
      if (checkUser()) return stoppedResult();
      for (let n = 0; n < (o.double ? 2 : 1); n++) {
        if (!native.mouseDown()) return { ok: false, reason: "failed" };
        track({ x: tx, y: ty, phase: "press" }); // the ring appears at the moment the button really goes down
        await wait(45);
        native.mouseUp();
        track({ x: tx, y: ty, phase: "release" });
        if (o.double && n === 0) await wait(70);
      }
      return { ok: true };
    } catch { moving = false; return { ok: false, reason: "failed" }; }
  }

  async function press(spec) {
    const codes = parseKeys(spec);
    if (!codes) return { ok: false, reason: "failed" };
    try {
      if (checkUser()) return stoppedResult();
      const mods = codes.slice(0, -1), main = codes[codes.length - 1];
      for (const m of mods) native.keyDown(m);
      native.keyDown(main);
      track({ phase: "key", ch: String(spec).toLowerCase() === "enter" ? "↵" : "" });
      await wait(40);
      native.keyUp(main);
      for (const m of mods.reverse()) native.keyUp(m);
      return { ok: true };
    } catch { return { ok: false, reason: "failed" }; }
  }

  async function type(text, perKeyMs = 40) {
    try {
      for (const ch of String(text)) {
        if (checkUser()) return stoppedResult(); // Esc or the mouse, between every single key
        for (const unit of [...Buffer.from(ch, "utf16le").reduce((a, _, i, b) => (i % 2 ? a : [...a, b.readUInt16LE(i)]), [])]) {
          if (!native.unit(unit)) return { ok: false, reason: "failed" };
        }
        track({ phase: "key", ch }); // the letter appears in the ghost's bubble when it is really typed
        await wait(perKeyMs);
      }
      return { ok: true };
    } catch { return { ok: false, reason: "failed" }; }
  }

  return {
    click, press, type,
    windowAt: native.windowAt, classAt: native.classAt, windowRect: native.windowRect,
    /** a task has started: watch for the user taking over (only after Momo has itself used the mouse) */
    arm() { if (armed) return; armed = true; stopped = null; expected = null; startWatch(); },
    /** the task is over: stop watching (the pointer is free again) */
    disarm() { armed = false; expected = null; stopWatch(); },
    /** "mouse" | "esc" if the user took over during this task, else null */
    interrupted: () => stopped,
  };
}

/** @param {any} koffi the Win32 binding */
function createPointer(koffi, opts = {}) {
  return createPointerFrom(createNative(koffi), opts);
}

module.exports = { createPointer, createPointerFrom, createNative, parseKeys, TAKEOVER_PX };
