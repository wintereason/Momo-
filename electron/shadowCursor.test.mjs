import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { createShadowCursor, LINGER_MS } = createRequire(import.meta.url)("./shadowCursor.cjs");

const screenA = { x: 0, y: 0, width: 1920, height: 1080 };
const screenB = { x: 1920, y: 0, width: 1920, height: 1080 };

function make({ enabled = true } = {}) {
  const sent = [];
  const log = [];
  const timers = [];
  const state = { enabled };
  const c = createShadowCursor({
    enabled: () => state.enabled,
    win: { show: (b) => log.push("show:" + b.x), send: (m) => sent.push(m), hide: () => log.push("hide") },
    screen: {
      mouse: () => ({ bounds: screenA, x: 300, y: 200 }),
      windowRect: (h) => (h === 7 ? { l: 200, t: 100, w: 1000, h: 600 } : null),
      // physical 2x display: a point at physical (3000, 400) is on screen B at DIP (1500 → 3000/2)
      locate: (x, y, w, h) => { const dx = x / 2, dy = y / 2; const b = dx >= 1920 ? screenB : screenA; return { bounds: b, x: dx - b.x, y: dy - b.y, w: w / 2, h: h / 2 }; },
    },
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: (id) => { timers[id - 1] = () => {}; }, // a cleared timer never fires
  });
  return { c, sent, log, timers, state };
}
const working = { type: "task.state", taskId: "t", state: "working", message: "x" };
const move = (x, y) => ({ type: "cursor.move", x, y, w: 200, h: 40, action: "select", label: "Search" });

describe("shadow cursor", () => {
  it("does not exist until a task works: nothing shown, nothing sent", () => {
    const m = make();
    m.c.handle({ type: "voice.started", sessionId: "s" });
    m.c.handle({ type: "transcript.ready", sessionId: "s", text: "hi" });
    expect(m.c.isVisible()).toBe(false);
    expect(m.sent).toEqual([]);
    expect(m.log).toEqual([]);
  });
  it("appears at the real mouse position when a task starts, glides to each control, and fades out after the task", () => {
    const m = make();
    m.c.handle(working);
    expect(m.sent[0]).toEqual({ kind: "show", x: 300, y: 200 });
    m.c.handle(move(800, 300));
    expect(m.sent.find((s) => s.kind === "move")).toMatchObject({ kind: "move", x: 400, y: 150, w: 100, h: 20, action: "select", label: "Search" });
    m.c.handle({ type: "task.completed", taskId: "t", summary: "ok", verified: true });
    expect(m.sent.at(-1)).toEqual({ kind: "done", ok: true, result: "ok" });
    expect(m.c.isVisible()).toBe(true); // lingers a moment
    m.timers[0]();
    expect(m.c.isVisible()).toBe(false);
    expect(m.sent.at(-1)).toEqual({ kind: "hide" });
    expect(m.log.at(-1)).toBe("hide");
  });
  it("says what Momo is doing, from the task's own status line", () => {
    const m = make();
    m.c.handle({ type: "task.state", taskId: "t", state: "working", message: "Opening Documents…" });
    expect(m.sent).toContainEqual({ kind: "say", text: "Opening Documents…" });
  });
  it("aims at the right part of a window: its X to close, its title bar to switch or show it opened", () => {
    const m = make();
    m.c.handle(working);
    m.c.handle({ type: "cursor.window", hwnd: 7, action: "close" });
    expect(m.sent.at(-1)).toMatchObject({ kind: "move", action: "click", label: "Close", x: (200 + 1000 - 24) / 2, y: (100 + 18) / 2 });
    m.c.handle({ type: "cursor.window", hwnd: 7, action: "minimize" });
    expect(m.sent.at(-1)).toMatchObject({ action: "click", label: "Minimize", x: (200 + 1000 - 116) / 2 });
    m.c.handle({ type: "cursor.window", hwnd: 7, action: "open", label: "Projects" });
    expect(m.sent.at(-1)).toMatchObject({ action: "look", label: "Projects", x: 350, y: 60 });
    m.c.handle({ type: "cursor.window", hwnd: 7, action: "focus", label: "Notes" });
    expect(m.sent.at(-1)).toMatchObject({ action: "select", x: 350 });
  });
  it("a window that cannot be found just leaves the cursor where it is", () => {
    const m = make();
    m.c.handle(working);
    const n = m.sent.length;
    m.c.handle({ type: "cursor.window", hwnd: 99, action: "open" });
    expect(m.sent).toHaveLength(n);
  });
  it("a failed task ends it too, marked as stopped", () => {
    const m = make();
    m.c.handle(working);
    m.c.handle({ type: "task.failed", taskId: "t", summary: "no", recoverable: true });
    expect(m.sent.at(-1)).toEqual({ kind: "done", ok: false, result: "failed" });
  });
  it("a question or confirmation keeps it where it is (the task is still open)", () => {
    const m = make();
    m.c.handle(working);
    m.c.handle({ type: "task.confirmation_required", taskId: "t", summary: "sure?" });
    expect(m.c.isVisible()).toBe(true);
    expect(m.sent.some((s) => s.kind === "done")).toBe(false);
  });
  it("follows the target onto another screen", () => {
    const m = make();
    m.c.handle(working);
    m.c.handle(move(4000, 400)); // 2000 DIP: on screen B
    expect(m.log).toContain("show:1920");
    expect(m.sent.at(-1)).toMatchObject({ kind: "move", x: 80 });
  });
  it("a new task during the linger keeps one cursor instead of flashing", () => {
    const m = make();
    m.c.handle(working);
    m.c.handle({ type: "task.completed", taskId: "t", summary: "ok", verified: true });
    m.c.handle(working);
    m.timers[0](); // the old hide timer was cancelled by the new task
    expect(m.c.isVisible()).toBe(true);
    expect(m.sent.filter((s) => s.kind === "show")).toHaveLength(1);
  });
  it("switched off in Settings: never shown, and hides if it was showing", () => {
    const m = make({ enabled: false });
    m.c.handle(working);
    m.c.handle(move(100, 100));
    expect(m.sent).toEqual([]);
    const n = make();
    n.c.handle(working);
    n.state.enabled = false;
    n.c.handle(move(100, 100));
    expect(n.c.isVisible()).toBe(false);
  });
  it("cancel hides it at once", () => {
    const m = make();
    m.c.handle(working);
    m.c.cancel();
    expect(m.c.isVisible()).toBe(false);
    expect(m.log.at(-1)).toBe("hide");
  });
  it("lingers for a short, fixed time", () => { expect(LINGER_MS).toBeGreaterThan(500); expect(LINGER_MS).toBeLessThan(5000); });

  it("a task that finished with something UNCONFIRMED is never shown as done", () => {
    const m = make();
    m.c.handle(working);
    m.c.handle({ type: "task.state", taskId: "t", state: "partial_success", message: "x" });
    expect(m.sent.at(-1)).toEqual({ kind: "done", ok: false, result: "unconfirmed" });
  });
});

describe("aim: the exact element is highlighted BEFORE anything moves", () => {
  it("sends the element's box (converted for a 2x display) with what it is for", () => {
    const m = make();
    m.c.handle(working);
    m.c.handle({ type: "cursor.aim", x: 800, y: 300, w: 200, h: 40, label: "Sort", say: "Clicking “Sort”: opens a menu", kind: "menu" });
    expect(m.sent.at(-1)).toEqual({ kind: "aim", x: 400, y: 150, w: 100, h: 20, label: "Sort", say: "Clicking “Sort”: opens a menu", tone: "menu" });
  });
  it("follows the target onto another screen", () => {
    const m = make();
    m.c.handle(working);
    m.c.handle({ type: "cursor.aim", x: 4000, y: 300, w: 100, h: 40 });
    expect(m.log).toContain("show:1920");
  });
});

describe("tracking the REAL pointer", () => {
  it("places the ghost exactly at each real position, converted per display, and never glides on its own", () => {
    const m = make();
    m.c.handle(working);
    m.c.track({ x: 1000, y: 600, phase: "move" });
    m.c.track({ x: 1200, y: 640, phase: "move" });
    expect(m.sent.filter((s) => s.kind === "track")).toEqual([
      { kind: "track", phase: "move", x: 500, y: 300 },
      { kind: "track", phase: "move", x: 600, y: 320 },
    ]);
  });
  it("hover, press and release are passed on at the moment they really happen", () => {
    const m = make();
    m.c.handle(working);
    for (const phase of ["hover", "press", "release"]) m.c.track({ x: 1000, y: 600, phase });
    expect(m.sent.filter((s) => s.kind === "track").map((s) => s.phase)).toEqual(["hover", "press", "release"]);
  });
  it("typed letters are passed on one by one, as they are really typed", () => {
    const m = make();
    m.c.handle(working);
    for (const ch of "hi") m.c.track({ phase: "key", ch });
    expect(m.sent.filter((s) => s.kind === "track")).toEqual([{ kind: "track", phase: "key", ch: "h" }, { kind: "track", phase: "key", ch: "i" }]);
  });
  it("crosses to the other monitor with the pointer", () => {
    const m = make();
    m.c.handle(working);
    m.c.track({ x: 4000, y: 400, phase: "move" });
    expect(m.log).toContain("show:1920");
    expect(m.sent.at(-1)).toEqual({ kind: "track", phase: "move", x: 80, y: 200 });
  });
  it("does nothing when no task is running, or when the ghost is switched off", () => {
    const m = make();
    m.c.track({ x: 1000, y: 600, phase: "move" });
    expect(m.sent).toEqual([]);
    const off = make({ enabled: false });
    off.c.track({ x: 1, y: 1, phase: "move" });
    expect(off.sent).toEqual([]);
  });
});

describe("results: only ever what Momo verified", () => {
  it("passes the verdict on while the task is open", () => {
    const m = make();
    m.c.handle(working);
    m.c.handle({ type: "cursor.result", state: "verifying" });
    m.c.handle({ type: "cursor.result", state: "unconfirmed", text: "Not confirmed" });
    expect(m.sent.filter((s) => s.kind === "result")).toEqual([{ kind: "result", state: "verifying" }, { kind: "result", state: "unconfirmed", text: "Not confirmed" }]);
  });
  it("a result with no task running shows nothing", () => {
    const m = make();
    m.c.handle({ type: "cursor.result", state: "verified" });
    expect(m.sent).toEqual([]);
  });
});

describe("the user takes over", () => {
  it("stops at once, says why, and nothing after it (not even the task's own ending) overrides that", () => {
    const m = make();
    m.c.handle(working);
    m.c.track({ phase: "stop", reason: "mouse" });
    expect(m.sent.at(-1)).toEqual({ kind: "stop", reason: "mouse" });
    const n = m.sent.length;
    m.c.track({ x: 10, y: 10, phase: "move" });
    m.c.handle({ type: "cursor.result", state: "verified" });
    m.c.handle({ type: "task.completed", taskId: "t", summary: "ok", verified: true });
    expect(m.sent.length).toBe(n); // no late "success"
    m.timers[0]();
    expect(m.c.isVisible()).toBe(false);
  });
  it("Esc is reported as Esc", () => {
    const m = make();
    m.c.handle(working);
    m.c.stop("esc");
    expect(m.sent.at(-1)).toEqual({ kind: "stop", reason: "esc" });
  });
  it("a new task after the stop starts clean", () => {
    const m = make();
    m.c.handle(working);
    m.c.stop("mouse");
    m.timers[0]();
    m.c.handle(working);
    m.c.track({ x: 1000, y: 600, phase: "move" });
    expect(m.sent.at(-1)).toMatchObject({ kind: "track", phase: "move" });
  });
});

describe("the overlay stays above everything", () => {
  it("raises itself on every aim, so an always-on-top app that was just clicked cannot cover the ghost", () => {
    const m = make();
    let raised = 0;
    const win = { show: () => {}, send: (x) => m.sent.push(x), hide: () => {}, raise: () => raised++ };
    const c = createShadowCursor({ enabled: () => true, win, screen: { mouse: () => ({ bounds: screenA, x: 1, y: 1 }), windowRect: () => null, locate: (x, y, w, h) => ({ bounds: screenA, x, y, w, h }) }, setTimer: () => 1, clearTimer: () => {} });
    c.handle(working);
    c.handle({ type: "cursor.aim", x: 10, y: 10, w: 5, h: 5 });
    c.handle({ type: "cursor.aim", x: 20, y: 20, w: 5, h: 5 });
    expect(raised).toBe(2);
  });
});

describe("the overlay comes back above a window that was just clicked", () => {
  it("raises itself when the button goes down and comes up, and when a verdict is shown", () => {
    const m = make();
    let raised = 0;
    const win = { show: () => {}, send: (x) => m.sent.push(x), hide: () => {}, raise: () => raised++ };
    const c = createShadowCursor({ enabled: () => true, win, screen: { mouse: () => ({ bounds: screenA, x: 1, y: 1 }), windowRect: () => null, locate: (x, y, w, h) => ({ bounds: screenA, x, y, w, h }) }, setTimer: () => 1, clearTimer: () => {} });
    c.handle(working);
    c.track({ x: 5, y: 5, phase: "move" });
    expect(raised).toBe(0); // gliding does not need it
    c.track({ x: 5, y: 5, phase: "press" });
    c.track({ x: 5, y: 5, phase: "release" });
    c.handle({ type: "cursor.result", state: "verified", text: "ok" });
    expect(raised).toBe(3);
  });
});
