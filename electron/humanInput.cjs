// The REAL mouse and keyboard, used when Momo acts "like a person" (Settings -> General -> Human-like control).
// It is a narrow tool, not a remote control:
//  * the pointer GLIDES to the target (never teleports) so the user can watch it, together with the shadow cursor, which is driven by
//    the pointer's ACTUAL positions (onTrack), so the two can never drift apart;
//  * before it presses anything it checks which window is under the pointer, and that the window has not moved since it was read;
//  * the USER ALWAYS WINS: while a task is armed, a watchdog notices the user moving the physical mouse or pressing Esc (during the
//    glide, while typing and between steps) and the whole task is stopped at once (onInterrupt);
//  * keys go only to whatever has the focus right now, and the caller has already identified that field.
// Windows only (koffi). Coordinates are physical pixels, the same ones UI Automation reports.
//
// Input safety (phase 3): everything Momo holds down (a mouse button, a key) is recorded in a LEDGER; every operation ends with releaseAll(), an
// abort (Esc, Cancel, quit) releases at once, and a watchdog releases anything held too long. Only what Momo itself pressed is ever released:
// a button or key the USER is holding is never touched (and stops the task: the user wins).
"use strict";

const VK = {
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b,
};
for (let i = 1; i <= 12; i++) VK["f" + i] = 0x6f + i;
const KEYUP = 0x2, UNICODE = 0x4;
const MOUSE_DOWN = 0x2, MOUSE_UP = 0x4, MOUSE_MOVE = 0x1, RIGHT_DOWN = 0x8, RIGHT_UP = 0x10, WHEEL = 0x800;
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

const VK_LBUTTON = 0x01, VK_RBUTTON = 0x02;
/** Modifier keys: if the USER is holding one of these, Momo's shortcuts and typing would be changed by it, so Momo does not act. */
const MODIFIER_VKS = [0x10, 0x11, 0x12, 0x5b, 0x5c];
/** after Momo's own input, the hooks and key states may report it for a moment: that is not the user */
const OWN_INPUT_QUIET_MS = 400;
/** how far the pointer may land from where Momo set it right away (DPI rounding) before it is not taken as "where it is" */
const LAND_SLACK_PX = 6;

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
  const MONINFO = koffi.struct("MomoHiMonInfo", { cbSize: "uint32", rcMonitor: RECT, rcWork: RECT, dwFlags: "uint32" });
  const LASTINPUT = koffi.struct("MomoHiLastInput", { cbSize: "uint32", dwTime: "uint32" });
  const SendInput = user32.func("uint32 __stdcall SendInput(uint32 n, MomoHiInput *p, int cb)");
  const GetCursorPos = user32.func("bool __stdcall GetCursorPos(_Out_ MomoHiPoint *p)");
  const SetCursorPos = user32.func("bool __stdcall SetCursorPos(int x, int y)");
  const WindowFromPoint = user32.func("uintptr_t __stdcall WindowFromPoint(MomoHiPoint p)");
  const GetAncestor = user32.func("uintptr_t __stdcall GetAncestor(uintptr_t h, uint32 flags)");
  const GetClassNameW = user32.func("int __stdcall GetClassNameW(uintptr_t h, _Out_ uint16_t *buf, int n)");
  const GetWindowRect = user32.func("bool __stdcall GetWindowRect(uintptr_t h, _Out_ MomoHiRect *r)");
  const IsWindow = user32.func("bool __stdcall IsWindow(uintptr_t h)");
  const GetForegroundWindow = user32.func("uintptr_t __stdcall GetForegroundWindow()");
  const GetAsyncKeyState = user32.func("int16 __stdcall GetAsyncKeyState(int vk)");
  const MonitorFromPoint = user32.func("uintptr_t __stdcall MonitorFromPoint(MomoHiPoint p, uint32 flags)");
  const GetMonitorInfoW = user32.func("bool __stdcall GetMonitorInfoW(uintptr_t h, _Inout_ MomoHiMonInfo *i)");
  const GetClipCursor = user32.func("bool __stdcall GetClipCursor(_Out_ MomoHiRect *r)");
  const GetLastInputInfo = user32.func("bool __stdcall GetLastInputInfo(_Inout_ MomoHiLastInput *i)");
  const GetTickCount = koffi.load("kernel32.dll").func("uint32 __stdcall GetTickCount()");
  let GetDpiForMonitor = null;
  try { GetDpiForMonitor = koffi.load("shcore.dll").func("int __stdcall GetDpiForMonitor(uintptr_t h, int type, _Out_ uint32_t *x, _Out_ uint32_t *y)"); } catch { /* Windows older than 8.1: no per-monitor DPI */ }
  // coordinates here are PHYSICAL pixels (what UI Automation reports). Electron is already DPI-aware; a plain Node process is not, and
  // would have its coordinates silently scaled, so ask for it (harmless when it is already set).
  try { user32.func("bool __stdcall SetProcessDpiAwarenessContext(intptr_t c)")(-4); } catch { /* already set, or an old Windows */ }
  const cb = koffi.sizeof(INPUT);

  const key = (vk, flags, scan = 0) => ({ type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
  const mouse = (flags, dx = 0, dy = 0) => ({ type: 0, u: { mi: { dx, dy, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
  const rootOf = (h) => (h ? Number(GetAncestor(h, 2)) || h : 0); // GA_ROOT: the top-level window that owns whatever it is
  const root = (x, y) => {
    try { return rootOf(Number(WindowFromPoint({ x: Math.round(x), y: Math.round(y) }))); } catch { return 0; }
  };
  const down = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;
  return {
    pos: () => { const p = { x: 0, y: 0 }; GetCursorPos(p); return p; },
    setPos: (x, y) => { SetCursorPos(x, y); },
    escDown: () => down(VK_ESCAPE),
    /** is this mouse button (or key) physically down right now? */
    buttonDown: (right) => down(right ? VK_RBUTTON : VK_LBUTTON),
    keyIsDown: (vk) => down(vk),
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
        if (!IsWindow(hwnd) || !GetWindowRect(hwnd, r)) return null;
        return { l: r.left, t: r.top, w: r.right - r.left, h: r.bottom - r.top };
      } catch { return null; }
    },
    /** the top-level window that has the keyboard focus right now (0 = none) */
    foregroundRoot: () => { try { return rootOf(Number(GetForegroundWindow())); } catch { return 0; } },
    /** the monitor a point is on (null = on no monitor: off the edge of the screen or in a gap between two) with its bounds and DPI */
    monitorAt: (x, y) => {
      try {
        const h = Number(MonitorFromPoint({ x: Math.round(x), y: Math.round(y) }, 0)); // MONITOR_DEFAULTTONULL
        if (!h) return null;
        const info = { cbSize: koffi.sizeof(MONINFO), rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 }, rcWork: { left: 0, top: 0, right: 0, bottom: 0 }, dwFlags: 0 };
        if (!GetMonitorInfoW(h, info)) return { id: h, rect: null, dpi: 96 };
        let dpi = 96;
        if (GetDpiForMonitor) { try { const dx = [0], dy = [0]; if (GetDpiForMonitor(h, 0, dx, dy) === 0 && dx[0]) dpi = dx[0]; } catch { /* keep 96 */ } }
        const m = info.rcMonitor;
        return { id: h, rect: { l: m.left, t: m.top, w: m.right - m.left, h: m.bottom - m.top }, dpi };
      } catch { return undefined; } // unknown: the caller does not rely on it
    },
    /** true when another program has confined the pointer to a box that leaves this point out (the pointer could not get there) */
    cursorClipped: (x, y) => {
      try {
        const r = {};
        if (!GetClipCursor(r)) return false;
        return x < r.left || x >= r.right || y < r.top || y >= r.bottom;
      } catch { return false; }
    },
    /** how long ago the last input of ANY kind (physical or injected) was, in ms: only used to explain an interruption */
    lastInputAgeMs: () => {
      try { const i = { cbSize: koffi.sizeof(LASTINPUT), dwTime: 0 }; if (!GetLastInputInfo(i)) return null; return (GetTickCount() - i.dwTime) >>> 0; } catch { return null; }
    },
    mouseDown: (right) => SendInput(1, [mouse(right ? RIGHT_DOWN : MOUSE_DOWN)], cb) === 1,
    mouseUp: (right) => { if (SendInput(1, [mouse(right ? RIGHT_UP : MOUSE_UP)], cb) !== 1) throw new Error("SendInput refused the button release"); },
    /** one wheel notch is 120: positive scrolls UP (away from the user), negative scrolls down */
    wheel: (delta) => SendInput(1, [{ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: delta >>> 0, dwFlags: WHEEL, time: 0, dwExtraInfo: 0 } } }], cb) === 1,
    nudge: (dx) => { SendInput(1, [mouse(MOUSE_MOVE, dx, 0)], cb); },
    keyDown: (vk) => { if (SendInput(1, [key(vk, 0)], cb) !== 1) throw new Error("SendInput refused the key press"); },
    keyUp: (vk) => { if (SendInput(1, [key(vk, KEYUP)], cb) !== 1) throw new Error("SendInput refused the key release"); },
    unit: (u) => SendInput(2, [key(0, UNICODE, u), key(0, UNICODE | KEYUP, u)], cb) === 2,
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The logic: gliding, guarding, typing, the held-input ledger and the user-takeover watchdog. Tested with a fake `native`.
 * Optional `native` features (buttonDown, keyIsDown, foregroundRoot, monitorAt, cursorClipped, lastInputAgeMs) are used when present.
 * @param {ReturnType<typeof createNative>} native
 * @param {{ wait?: (ms:number)=>Promise<void>, watchMs?: number, holdWatchMs?: number, staleHoldMs?: number, maxHoldMs?: number,
 *           dragCancel?: "esc" | "origin" | "esc+origin",
 *           onTrack?: (e: { x?: number, y?: number, phase: string, ch?: string, reason?: string }) => void,
 *           onInterrupt?: (reason: "mouse" | "esc", detail?: object) => void,
 *           onRelease?: (info: object) => void }} [opts]
 */
function createPointerFrom(native, opts = {}) {
  const wait = opts.wait || sleep;
  const track = (e) => { try { if (opts.onTrack) opts.onTrack(e); } catch { /* the ghost is decoration: never let it break a click */ } };
  let armed = false;
  let stopped = null;      // "mouse" | "esc" once the user has taken over; sticky until the next task is armed
  let aborted = null;      // "cancel" | "quit" once the app (not the user's hand) has called everything off; sticky until the next task is armed
  let dead = false;        // the app is quitting: never act again
  let expected = null;     // where Momo last put the pointer: anything else means the user moved it
  let moving = false;      // Momo is gliding right now (the glide checks for itself)
  let active = 0;          // operations in progress
  let timer = null;
  let lastInterrupt = null;
  const samples = [];      // the last few pointer positions (coordinates only, in memory): to explain an interruption afterwards
  const sample = (s) => { samples.push({ t: Date.now(), ...s }); if (samples.length > 24) samples.shift(); };

  // Momo's OWN input must not look like the user's: it is ignored for a moment after Momo sends it
  let ignoreEscUntil = 0;
  const ownUntil = { key: 0, wheel: 0, button: 0 };
  const own = (kind, ms = OWN_INPUT_QUIET_MS) => { ownUntil[kind] = Date.now() + ms; };
  const esc = () => Date.now() > ignoreEscUntil && native.escDown();

  // ---------------------------------------------------------------- the ledger: everything Momo holds down
  /** @type {Map<string, {since:number, beat:number}>} */
  const heldButtons = new Map();
  /** @type {Map<number, {since:number, beat:number}>} */
  const heldKeys = new Map();
  let watchdog = null;
  const heldCount = () => heldButtons.size + heldKeys.size;
  const beat = () => { const t = Date.now(); for (const e of heldButtons.values()) e.beat = t; for (const e of heldKeys.values()) e.beat = t; };

  function startWatchdog() {
    if (watchdog) return;
    const stale = opts.staleHoldMs || 1500, max = opts.maxHoldMs || 10_000;
    watchdog = setInterval(() => {
      if (heldCount() === 0) { stopWatchdog(); return; }
      const now = Date.now();
      let bad = false;
      for (const e of [...heldButtons.values(), ...heldKeys.values()]) if (e.failed || now - e.beat > stale || now - e.since > max) bad = true;
      if (bad) {
        const n = releaseAll();
        track({ phase: "stuck-release" });
        try { if (opts.onRelease) opts.onRelease({ released: n, why: "watchdog" }); } catch { /* ignore */ }
      }
    }, opts.holdWatchMs || 250);
    if (watchdog.unref) watchdog.unref();
  }
  function stopWatchdog() { if (watchdog) { clearInterval(watchdog); watchdog = null; } }

  /** press a mouse button and RECORD it first-thing: from here on it is released no matter what happens */
  function pressButton(right) {
    const k = right ? "right" : "left";
    if (heldButtons.has(k)) return true;
    if (native.buttonDown && native.buttonDown(right)) return "user_holding"; // the user already has this button down: it is theirs
    const t = Date.now();
    heldButtons.set(k, { since: t, beat: t });
    startWatchdog();
    let sent = false, threw = false;
    try { sent = native.mouseDown(right); } catch (e) { threw = true; throw e; } finally { if (!sent && !threw) heldButtons.delete(k); } // a refused press is not held; a THROWN one may have gone through, so it stays recorded and is released
    own("button");
    return sent;
  }
  function releaseButton(right) {
    const k = right ? "right" : "left";
    if (!heldButtons.has(k)) return true;
    own("button");
    try { native.mouseUp(right); } catch { const e = heldButtons.get(k); if (e) e.failed = true; return false; } // stays in the ledger: the watchdog and releaseAll try again
    heldButtons.delete(k);
    return true;
  }
  function pressKey(vk) {
    if (heldKeys.has(vk)) return true;
    if (native.keyIsDown && native.keyIsDown(vk)) return "user_holding";
    const t = Date.now();
    heldKeys.set(vk, { since: t, beat: t });
    startWatchdog();
    let ok = false;
    try { native.keyDown(vk); ok = true; } finally { if (!ok) { /* it may have gone through: keep it recorded so it is released */ } }
    own("key");
    return true;
  }
  function releaseKey(vk) {
    if (!heldKeys.has(vk)) return true;
    own("key");
    try { native.keyUp(vk); } catch { const e = heldKeys.get(vk); if (e) e.failed = true; return false; }
    heldKeys.delete(vk);
    return true;
  }
  /** Let go of everything Momo itself is holding (and nothing else). Safe to call any time, any number of times. Returns how many it released. */
  function releaseAll() {
    let n = 0;
    for (const k of [...heldButtons.keys()]) { if (releaseButton(k === "right")) n++; else if (releaseButton(k === "right")) n++; }
    for (const vk of [...heldKeys.keys()].reverse()) { if (releaseKey(vk)) n++; else if (releaseKey(vk)) n++; }
    if (heldCount() === 0) stopWatchdog();
    return n;
  }

  // ---------------------------------------------------------------- stopping
  const abortHooks = new Set(); // an operation that must end in a special way (a drag is cancelled, not dropped) registers one

  let stopping = false;
  function runStopHooks(reason, cause) {
    if (stopping) return; // a hook that moves the pointer must not set off another stop
    stopping = true;
    try { for (const h of [...abortHooks]) { try { h(reason, cause); } catch { /* the release below still happens */ } } }
    finally { stopping = false; }
    releaseAll();
  }

  /** the USER took over (mouse, Esc, keyboard, wheel, a click): stop everything now and let go of what Momo holds */
  function interrupt(reason, detail = {}) {
    if (stopped) return;
    stopped = reason;
    let age = null;
    try { age = native.lastInputAgeMs ? native.lastInputAgeMs() : null; } catch { /* diagnostic only */ }
    lastInterrupt = { reason, cause: detail.cause || reason, ...detail, lastInputAgeMs: age, recent: samples.slice(-6).map((s) => ({ ...s, t: s.t % 100000 })) };
    track({ phase: "stop", reason });
    runStopHooks(reason, "user");
    try { if (opts.onInterrupt) opts.onInterrupt(reason, lastInterrupt); } catch { /* ignore */ }
  }

  /** the APP calls it off (Cancel, quitting, the task ended): same safety, but nobody took the mouse */
  function abort(why = "cancel") {
    if (why === "quit") dead = true;
    aborted = why;
    runStopHooks(why, "app");
  }

  const stoppedResult = () => {
    if (aborted) return { ok: false, reason: "cancelled" };
    return { ok: false, reason: stopped === "esc" ? "stopped" : "user_moved" };
  };
  const mustStop = () => dead || !!aborted || !!stopped;

  /** has the user touched the mouse (away from where Momo left it), pressed Esc, held a button, or aborted? */
  function checkUser() {
    if (mustStop()) return true;
    if (esc()) { interrupt("esc", { cause: "Esc key" }); return true; }
    if (expected || active > 0) {
      if (expected) {
        const p = native.pos();
        const d = dist(p, expected);
        if (d > TAKEOVER_PX) { interrupt("mouse", { cause: "mouse moved", dist: Math.round(d), pos: p, expected }); return true; }
      }
      if (native.buttonDown && Date.now() > ownUntil.button) {
        for (const right of [false, true]) {
          if (!heldButtons.has(right ? "right" : "left") && native.buttonDown(right)) { interrupt("mouse", { cause: right ? "right button held" : "left button held" }); return true; }
        }
      }
    }
    return false;
  }

  /** from the global input hook (main.cjs): the user pressed a key, used the wheel or clicked. Momo's own input is ignored for a moment. */
  function userSignal(kind) {
    if (!armed || mustStop()) return;
    if (kind === "esc") { if (Date.now() > ignoreEscUntil) interrupt("esc", { cause: "Esc key (event)" }); return; }
    if (!(expected || active > 0)) return; // Momo has not used the mouse or keyboard yet in this task: the user is just working
    if (Date.now() < ownUntil[kind === "click" ? "button" : kind]) return;
    interrupt("mouse", { cause: kind === "wheel" ? "mouse wheel" : kind === "click" ? "mouse click" : "keyboard" });
  }

  function startWatch() {
    if (timer) return;
    timer = setInterval(() => { if (armed && !moving && !stopped) checkUser(); }, opts.watchMs || 40);
    if (timer.unref) timer.unref();
  }
  function stopWatch() { if (timer) { clearInterval(timer); timer = null; } }

  /** run one operation: it can never end with something still held, and an exception becomes a failed result */
  async function guarded(fn) {
    active++;
    try { return await fn(); }
    catch { return { ok: false, reason: "failed" }; }
    finally { active--; moving = false; releaseAll(); }
  }

  // ---------------------------------------------------------------- guards before and during acting
  function windowProblem(w) {
    if (!w || !w.rect || !w.hwnd) return null;
    const now = native.windowRect(w.hwnd);
    if (!now) return "gone";
    const r = w.rect;
    return Math.abs(now.l - r.l) > WINDOW_SLACK_PX || Math.abs(now.t - r.t) > WINDOW_SLACK_PX || Math.abs(now.w - r.w) > WINDOW_SLACK_PX || Math.abs(now.h - r.h) > WINDOW_SLACK_PX ? "moved" : null;
  }
  const windowResult = (p) => ({ ok: false, reason: p });
  const modifierHeld = () => !!native.keyIsDown && Date.now() >= ownUntil.key && MODIFIER_VKS.some((vk) => !heldKeys.has(vk) && native.keyIsDown(vk));
  const wrongForeground = (o) => !!o && o.expectForeground && native.foregroundRoot && native.foregroundRoot() !== o.expectForeground;

  /**
   * Last checks, right before a button goes down: the window under the pointer is still the right one, the target window has not moved or
   * closed, the caller's own check of the TARGET still passes (it is asked about this very point), and the user has not touched anything.
   */
  async function beforePress(tx, ty, o) {
    const sync = () => {
      if (checkUser()) return stoppedResult();
      if (o.expectRoot && native.windowAt(tx, ty) !== o.expectRoot) return { ok: false, reason: "covered" };
      if (o.expectClass && !o.expectClass.includes(native.classAt(tx, ty))) return { ok: false, reason: "covered" };
      const wp = windowProblem(o.expectWindow);
      if (wp) return windowResult(wp);
      return null;
    };
    let bad = sync();
    if (bad) return bad;
    if (o.verifyTarget) {
      let v;
      try { v = await o.verifyTarget({ x: tx, y: ty }); } catch { v = { ok: false, reason: "changed" }; } // a check that cannot run is not a pass
      if (v && v.ok === false) return { ok: false, reason: v.reason || "changed" };
      bad = sync(); // that took a moment: look again
      if (bad) return bad;
    }
    return null;
  }

  /**
   * Glide the pointer to a point: null when it arrived, else the result that says why not. Every step: Esc, the user's hand, abort, the
   * target window, and whether Windows really put the pointer where it was told to (it cannot if the point is off every monitor).
   */
  async function glide(x, y, ms, o = {}) {
    const tx = Math.round(x), ty = Math.round(y);
    if (native.monitorAt) {
      const mon = native.monitorAt(tx, ty);
      if (mon === null) return { ok: false, reason: "offscreen" }; // off the edge of the screen or in a gap between monitors: it can never get there
    }
    if (native.cursorClipped && native.cursorClipped(tx, ty)) return { ok: false, reason: "cursor_refused" }; // another program has confined the pointer
    const from = native.pos();
    const total = Math.max(120, Math.min(2500, ms || 700));
    const steps = Math.max(8, Math.round(total / 16));
    let base = from; // where the pointer verifiably is: the next reading must be here, or the user moved it
    moving = true;
    try {
      for (let i = 1; i <= steps; i++) {
        if (mustStop()) return stoppedResult();
        if (esc()) { interrupt("esc", { cause: "Esc key" }); return stoppedResult(); }
        const now = native.pos();
        const d = dist(now, base);
        if (d > TAKEOVER_PX) { interrupt("mouse", { cause: "mouse moved", dist: Math.round(d), pos: now, expected: base, step: i }); return stoppedResult(); } // the user grabbed the mouse
        if (o.watch) { const w = o.watch(); if (w) return { ok: false, reason: w }; }
        beat();
        const k = ease(i / steps);
        const lx = Math.round(from.x + (tx - from.x) * k), ly = Math.round(from.y + (ty - from.y) * k);
        native.setPos(lx, ly);
        const landed = native.pos();
        // Windows may place the pointer a pixel or two off (scaling): that is where it IS. A big difference stays "where Momo wanted it",
        // so the next reading tells whether the user moved it. A point on no monitor is clamped by Windows: not the user either.
        const off = dist(landed, { x: lx, y: ly });
        const onNoMonitor = native.monitorAt ? native.monitorAt(lx, ly) === null : false;
        base = off <= LAND_SLACK_PX || onNoMonitor ? landed : { x: lx, y: ly };
        sample({ x: landed.x, y: landed.y, bx: base.x, by: base.y });
        track({ x: landed.x, y: landed.y, phase: "move" }); // the ghost goes exactly where the real pointer went
        await wait(total / steps);
      }
      const end = native.pos();
      if (dist(end, { x: tx, y: ty }) > TAKEOVER_PX) {
        if (dist(end, base) > TAKEOVER_PX) { interrupt("mouse", { cause: "mouse moved at arrival", dist: Math.round(dist(end, base)), pos: end, expected: base }); return stoppedResult(); }
        return { ok: false, reason: "cursor_refused" }; // it is where Momo left it, just not where it was sent: Windows would not put it there
      }
      expected = { x: end.x, y: end.y };
      return null;
    } finally { moving = false; }
  }

  // ---------------------------------------------------------------- click
  async function click(x, y, o = {}) {
    return guarded(async () => {
      if (mustStop()) return stoppedResult();
      if (checkUser()) return stoppedResult();
      const wp = windowProblem(o.expectWindow);
      if (wp) return windowResult(wp);
      let bad = await glide(x, y, o.ms || 700, { watch: () => windowProblem(o.expectWindow) });
      if (bad) return bad;
      const tx = expected.x, ty = expected.y;
      if (o.expectRoot && native.windowAt(tx, ty) !== o.expectRoot) return { ok: false, reason: "covered" }; // something else is in front there
      if (o.expectClass && !o.expectClass.includes(native.classAt(tx, ty))) return { ok: false, reason: "covered" }; // e.g. the taskbar is hidden behind a full-screen app
      if (checkUser()) return stoppedResult();
      const wp2 = windowProblem(o.expectWindow);
      if (wp2) return windowResult(wp2); // the window was dragged (or closed) while the pointer travelled
      track({ x: tx, y: ty, phase: "hover" });
      // let the target see the pointer ARRIVE (hover states, breadcrumbs, menus need a real mouse-move event before a click counts)
      native.nudge(1); await wait(30); native.nudge(-1);
      await wait(o.hoverMs === undefined ? 110 : o.hoverMs);
      const here = native.pos(); // the nudge pair leaves it exactly where it was, but read it: that is where the click will land
      if (dist(here, { x: tx, y: ty }) > TAKEOVER_PX) { interrupt("mouse", { cause: "mouse moved while hovering", pos: here, expected: { x: tx, y: ty } }); return stoppedResult(); }
      bad = await beforePress(tx, ty, o);
      if (bad) return bad;
      const right = o.button === "right";
      for (let n = 0; n < (o.double && !right ? 2 : 1); n++) {
        const p = pressButton(right);
        if (p === "user_holding") { interrupt("mouse", { cause: "user holds a mouse button" }); return stoppedResult(); }
        if (!p) return { ok: false, reason: "failed" };
        track({ x: tx, y: ty, phase: "press" }); // the ring appears at the moment the button really goes down
        await wait(45);
        releaseButton(right);
        if (heldButtons.has(right ? "right" : "left")) { releaseButton(right); } // one more try: a held button is the worst outcome
        track({ x: tx, y: ty, phase: "release" });
        if (o.double && n === 0) { await wait(70); if (checkUser()) return stoppedResult(); }
      }
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- drag
  /**
   * Drag from one point to another with the left button held (a file onto a folder, a selection of text, a window by its title bar).
   * The button is ALWAYS released again. When the drag has to be called off half-way, it is CANCELLED first (Esc, which is how Windows' own
   * drag and drop is cancelled) so that letting go does not DROP the item wherever the pointer happens to be.
   * @param {{x:number,y:number}} a @param {{x:number,y:number}} b
   */
  async function drag(a, b, o = {}) {
    return guarded(async () => {
      let hook = null;
      const strategy = opts.dragCancel || "esc";
      /** cancel an in-progress drag, then let go. `cause` "user": never move the pointer (it is theirs now). */
      const cancelDrag = (_why, cause) => {
        if (!heldButtons.has("left")) return; // already let go (the stop hook got there first): never send a second, stray Esc
        ignoreEscUntil = Date.now() + 700;
        if (strategy.includes("esc")) { try { native.keyDown(VK_ESCAPE); native.keyUp(VK_ESCAPE); } catch { /* released below anyway */ } }
        if (strategy.includes("origin") && cause !== "user") { try { native.setPos(a.x, a.y); } catch { /* ignore */ } }
        releaseButton(false);
      };
      try {
        if (mustStop()) return stoppedResult();
        if (checkUser()) return stoppedResult();
        const wp = windowProblem(o.expectWindow);
        if (wp) return windowResult(wp);
        let bad = await glide(a.x, a.y, o.ms || 700, { watch: () => windowProblem(o.expectWindow) });
        if (bad) return bad;
        await wait(o.hoverMs === undefined ? 110 : o.hoverMs);
        bad = await beforePress(Math.round(a.x), Math.round(a.y), { ...o, verifyTarget: o.verifySource });
        if (bad) return bad;
        const p = pressButton(false);
        if (p === "user_holding") { interrupt("mouse", { cause: "user holds a mouse button" }); return stoppedResult(); }
        if (!p) return { ok: false, reason: "failed" };
        hook = (why, cause) => cancelDrag(why, cause);
        abortHooks.add(hook);
        track({ x: a.x, y: a.y, phase: "press" });
        await wait(120);
        // from here the button is down: any way out cancels the drag instead of dropping it
        const gone = () => {
          if (o.expectWindow && !native.windowRect(o.expectWindow.hwnd)) return "gone";
          if (o.dropWindow && !native.windowRect(o.dropWindow)) return "gone";
          return null;
        };
        // the destination may be another window (a file dropped onto a folder in another Explorer window): only the start is guarded
        bad = await glide(b.x, b.y, o.ms || 900, { watch: gone });
        if (!bad && o.dropRoot && native.windowAt(Math.round(b.x), Math.round(b.y)) !== o.dropRoot) bad = { ok: false, reason: "covered" };
        if (bad) { cancelDrag("failed", "app"); await wait(60); return bad; }
        await wait(200); // let the target show it will accept the drop
        // last look before letting go: this IS the drop
        if (checkUser()) return stoppedResult(); // (the stop hook already cancelled it)
        if (gone()) { cancelDrag("gone", "app"); return { ok: false, reason: "gone" }; }
        if (o.dropRoot && native.windowAt(Math.round(b.x), Math.round(b.y)) !== o.dropRoot) { cancelDrag("covered", "app"); return { ok: false, reason: "covered" }; }
        if (o.verifyDrop) {
          let v;
          try { v = await o.verifyDrop({ x: Math.round(b.x), y: Math.round(b.y) }); } catch { v = { ok: false, reason: "changed" }; }
          if (mustStop()) return stoppedResult();
          if (v && v.ok === false) { cancelDrag("changed", "app"); return { ok: false, reason: v.reason || "changed" }; }
        }
        releaseButton(false);
        track({ x: b.x, y: b.y, phase: "release" });
        return { ok: true };
      } catch (e) {
        if (heldButtons.has("left")) cancelDrag("exception", "app"); // an exception mid-drag cancels it too
        throw e;
      } finally {
        if (hook) abortHooks.delete(hook);
      }
    });
  }

  // ---------------------------------------------------------------- scroll, keys, typing
  /** Scroll with the wheel at a point: dy > 0 scrolls DOWN by that many notches, dy < 0 up. A few notches at a time so the user can follow. */
  async function scroll(x, y, notches, o = {}) {
    return guarded(async () => {
      if (mustStop()) return stoppedResult();
      if (checkUser()) return stoppedResult();
      const wp = windowProblem(o.expectWindow);
      if (wp) return windowResult(wp);
      const bad = await glide(x, y, o.ms || 600, { watch: () => windowProblem(o.expectWindow) });
      if (bad) return bad;
      if (o.expectRoot && native.windowAt(expected.x, expected.y) !== o.expectRoot) return { ok: false, reason: "covered" };
      track({ x: expected.x, y: expected.y, phase: "hover" });
      const n = Math.max(1, Math.min(30, Math.abs(Math.round(notches))));
      for (let i = 0; i < n; i++) {
        if (checkUser()) return stoppedResult();
        const w2 = windowProblem(o.expectWindow);
        if (w2) return windowResult(w2);
        if (o.expectRoot && native.windowAt(expected.x, expected.y) !== o.expectRoot) return { ok: false, reason: "covered" }; // something opened over it: stop, do not scroll that
        own("wheel");
        if (!native.wheel(notches > 0 ? -120 : 120)) return { ok: false, reason: "failed" };
        track({ x: Math.round(x), y: Math.round(y), phase: "scroll" });
        await wait(90);
      }
      return { ok: true };
    });
  }

  async function press(spec, o = {}) {
    const codes = parseKeys(spec);
    if (!codes) return { ok: false, reason: "failed" };
    return guarded(async () => {
      if (checkUser()) return stoppedResult();
      if (modifierHeld()) { interrupt("mouse", { cause: "user holds a modifier key" }); return stoppedResult(); }
      if (wrongForeground(o)) return { ok: false, reason: "focus_changed" };
      const mods = codes.slice(0, -1), main = codes[codes.length - 1];
      if (codes.includes(VK_ESCAPE)) ignoreEscUntil = Date.now() + 500;
      own("key", 600);
      for (const m of mods) { if (pressKey(m) === "user_holding") { interrupt("mouse", { cause: "user holds a modifier key" }); return stoppedResult(); } }
      if (pressKey(main) === "user_holding") { interrupt("mouse", { cause: "user holds a key" }); return stoppedResult(); }
      track({ phase: "key", ch: String(spec).toLowerCase() === "enter" ? "↵" : "" });
      await wait(40);
      releaseKey(main);
      for (const m of [...mods].reverse()) releaseKey(m);
      return { ok: true };
    });
  }

  async function type(text, perKeyMs = 40, o = {}) {
    return guarded(async () => {
      if (checkUser()) return stoppedResult();
      if (modifierHeld()) { interrupt("mouse", { cause: "user holds a modifier key" }); return stoppedResult(); }
      for (const ch of String(text)) {
        if (checkUser()) return stoppedResult(); // Esc or the mouse, between every single key
        if (wrongForeground(o)) return { ok: false, reason: "focus_changed" }; // a dialog (or anything else) took the keyboard: nothing more is typed
        if (o.expectWindow && !native.windowRect(o.expectWindow)) return { ok: false, reason: "gone" }; // the window being typed into has closed
        own("key", 600);
        for (const unit of [...Buffer.from(ch, "utf16le").reduce((a, _, i, b) => (i % 2 ? a : [...a, b.readUInt16LE(i)]), [])]) {
          if (!native.unit(unit)) return { ok: false, reason: "failed" };
        }
        track({ phase: "key", ch }); // the letter appears in the ghost's bubble when it is really typed
        await wait(perKeyMs);
      }
      return { ok: true };
    });
  }

  return {
    click, press, type, drag, scroll,
    windowAt: native.windowAt, classAt: native.classAt, windowRect: native.windowRect,
    /** a task has started: watch for the user taking over (only after Momo has itself used the mouse) */
    arm() { if (armed) return; armed = true; stopped = null; if (!dead) aborted = null; expected = null; lastInterrupt = null; startWatch(); },
    /** the task is over: stop watching (the pointer is free again), and make sure nothing is left held */
    disarm() { armed = false; expected = null; stopWatch(); releaseAll(); },
    /** Cancel / quit: stop whatever is happening, let go of everything Momo holds, and do nothing more until the next task */
    abort,
    /** let go of everything Momo is holding (idempotent). The app calls it when it exits. */
    releaseAll,
    /** how many buttons and keys Momo is holding right now (0 when nothing is) */
    heldCount,
    /** from the global input hook: "esc" | "key" | "wheel" | "click" (the user's, not Momo's) */
    userSignal,
    /** "mouse" | "esc" if the user took over during this task, else null */
    interrupted: () => stopped,
    /** why (and where) the last interruption happened: cause, distances, last pointer positions (coordinates only, in memory) */
    lastInterrupt: () => lastInterrupt,
    /** stop for good (the app is quitting) */
    dispose() { abort("quit"); stopWatch(); stopWatchdog(); },
  };
}

/** @param {any} koffi the Win32 binding */
function createPointer(koffi, opts = {}) {
  const p = createPointerFrom(createNative(koffi), opts);
  // whatever happens to the app, Momo never leaves a button or key held down
  process.once("exit", () => { try { p.releaseAll(); } catch { /* ignore */ } });
  return p;
}

module.exports = { createPointer, createPointerFrom, createNative, parseKeys, TAKEOVER_PX };
