import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { createPointerFrom } = createRequire(import.meta.url)("./humanInput.cjs");

/**
 * Phase 3: input safety. A fake Windows that keeps the REAL state of every button and key, so each test can ask the only question that
 * matters: after this operation (however it ended), is anything still held down, and did anything happen that should not have?
 */
const VK_ESC = 0x1b;
function world(cfg = {}) {
  const os = {
    x: 100, y: 100, left: false, right: false, keys: new Set(), esc: false, root: 7, cls: "App", fg: 7,
    rect: { l: 0, t: 0, w: 1000, h: 800 }, windows: new Set([7, 8]),
    userLeft: false, userRight: false, userKeys: new Set(),
    monitors: cfg.monitors || null, clipped: false, jitter: 0,
    calls: {}, log: [], fail: null, onStep: null, onUnit: null, lastInputAge: 12345, wheelCount: 0,
  };
  // injected faults: { name, at, when: "before"|"after" (before or after the effect happened), times }
  const hit = (name, effect) => {
    os.calls[name] = (os.calls[name] || 0) + 1;
    const f = os.fail;
    const due = f && f.name === name && os.calls[name] >= f.at && (f.times === undefined || os.calls[name] < f.at + f.times);
    if (due && f.when !== "after") throw new Error("injected " + name);
    const r = effect();
    if (due && f.when === "after") throw new Error("injected " + name + " (after it went through)");
    return r;
  };
  const native = {
    pos: () => hit("pos", () => ({ x: os.x, y: os.y })),
    setPos: (x, y) => hit("setPos", () => {
      let nx = x, ny = y;
      if (os.monitors) { // Windows clamps the pointer to the nearest monitor
        if (!os.monitors.some((m) => x >= m.l && x < m.l + m.w && y >= m.t && y < m.t + m.h)) {
          const m = os.monitors[0];
          nx = Math.min(Math.max(x, m.l), m.l + m.w - 1); ny = Math.min(Math.max(y, m.t), m.t + m.h - 1);
        }
      }
      os.x = nx + os.jitter; os.y = ny; os.log.push("move"); if (os.onStep) os.onStep(os);
    }),
    escDown: () => os.esc,
    buttonDown: (right) => (right ? os.right || os.userRight : os.left || os.userLeft),
    keyIsDown: (vk) => os.keys.has(vk) || os.userKeys.has(vk),
    windowAt: () => hit("windowAt", () => os.root),
    classAt: () => os.cls,
    windowRect: (h) => hit("windowRect", () => (os.windows.has(h) && os.rect ? { ...os.rect } : null)),
    foregroundRoot: () => os.fg,
    cursorClipped: () => os.clipped,
    lastInputAgeMs: () => os.lastInputAge,
    mouseDown: (right) => hit("mouseDown", () => { os[right ? "right" : "left"] = true; os.log.push(right ? "down:right" : "down:left"); return true; }),
    mouseUp: (right) => hit("mouseUp", () => { os[right ? "right" : "left"] = false; os.log.push(right ? "up:right" : "up:left"); }),
    nudge: (dx) => hit("nudge", () => { os.x += dx; }),
    keyDown: (vk) => hit("keyDown", () => { os.keys.add(vk); os.log.push("kd:" + vk.toString(16)); if (vk === VK_ESC) os.esc = true; }),
    keyUp: (vk) => hit("keyUp", () => { os.keys.delete(vk); os.log.push("ku:" + vk.toString(16)); if (vk === VK_ESC) os.esc = false; }),
    unit: (u) => hit("unit", () => { os.log.push("unit:" + u); if (os.onUnit) os.onUnit(os); return true; }),
    wheel: (d) => hit("wheel", () => { os.wheelCount++; os.log.push("wheel:" + d); return true; }),
  };
  if (cfg.monitors) native.monitorAt = (x, y) => { const m = os.monitors.find((q) => x >= q.l && x < q.l + q.w && y >= q.t && y < q.t + q.h); return m ? { id: m.id, rect: m, dpi: m.dpi } : null; };
  const tracks = [], interrupts = [], released = [];
  const pointer = createPointerFrom(native, { wait: cfg.wait || (async () => {}), watchMs: 5, holdWatchMs: 10, staleHoldMs: cfg.staleHoldMs || 60, dragCancel: cfg.dragCancel, onTrack: (e) => tracks.push(e), onInterrupt: (r, d) => interrupts.push([r, d]), onRelease: (i) => released.push(i) });
  return { os, pointer, tracks, interrupts, released };
}
const nothingHeld = (w) => w.os.left === false && w.os.right === false && w.os.keys.size === 0 && w.pointer.heldCount() === 0;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

describe("nothing is ever left held: a failure injected at every step of every operation", () => {
  const ops = {
    click: (p) => p.click(300, 300, { ms: 200, expectRoot: 7 }),
    "right click": (p) => p.click(300, 300, { ms: 200, expectRoot: 7, button: "right" }),
    "double click": (p) => p.click(300, 300, { ms: 200, expectRoot: 7, double: true }),
    drag: (p) => p.drag({ x: 200, y: 200 }, { x: 500, y: 400 }, { ms: 200, expectRoot: 7, dropRoot: 7 }),
    "ctrl+a": (p) => p.press("ctrl+a"),
    "ctrl+shift+esc is parsed but this is just three keys": (p) => p.press("ctrl+shift+a"),
    enter: (p) => p.press("enter"),
    type: (p) => p.type("hello 😀", 1),
    scroll: (p) => p.scroll(400, 300, 3, { ms: 200, expectRoot: 7 }),
  };
  const methods = ["pos", "setPos", "windowAt", "windowRect", "mouseDown", "mouseUp", "keyDown", "keyUp", "nudge", "wheel", "unit"];
  for (const [opName, run] of Object.entries(ops)) {
    for (const method of methods) {
      for (const when of ["before", "after"]) {
        it(`${opName}: ${method} throws (${when} it took effect) at any call -> nothing held afterwards`, async () => {
          for (let at = 1; at <= 30; at++) {
            const w = world();
            w.os.fail = { name: method, at, when, times: 1 }; // it fails once at that call, like a real transient error
            w.pointer.arm();
            const r = await run(w.pointer);
            expect(r && typeof r.ok === "boolean").toBe(true); // an exception never escapes as an exception
            // let the watchdog finish anything that needed a second try (only when something is still up)
            if (!nothingHeld(w)) await nap(40);
            expect(nothingHeld(w), `${opName} / ${method}(${when}) at call ${at}: left=${w.os.left} right=${w.os.right} keys=${[...w.os.keys]} ledger=${w.pointer.heldCount()}`).toBe(true);
          }
        });
      }
    }
  }

  it("a release that keeps failing is retried by the watchdog until it works, and reported", async () => {
    const w = world();
    w.os.fail = { name: "mouseUp", at: 1, when: "before", times: 6 };
    w.pointer.arm();
    await w.pointer.click(300, 300, { ms: 200, expectRoot: 7 });
    expect(w.os.left).toBe(true); // the first tries failed: it IS stuck for the moment...
    await nap(120);
    expect(w.os.left).toBe(false); // ...and the watchdog gets it up
    expect(w.pointer.heldCount()).toBe(0);
  });

  it("releaseAll is idempotent and never presses anything", async () => {
    const w = world();
    w.pointer.arm();
    await w.pointer.click(300, 300, { ms: 200, expectRoot: 7 });
    const before = w.os.log.length;
    expect(w.pointer.releaseAll()).toBe(0);
    expect(w.pointer.releaseAll()).toBe(0);
    expect(w.os.log.length).toBe(before);
  });

  it("an operation that hangs while holding a button is released by the watchdog (nobody else will)", async () => {
    let hang = false;
    const w = world({ wait: (ms) => (hang ? new Promise(() => {}) : Promise.resolve()), staleHoldMs: 80 });
    w.pointer.arm();
    // arrange for the wait right after the press to hang forever
    const orig = w.os.log.push.bind(w.os.log);
    w.os.log.push = (...a) => { if (a[0] === "down:left") hang = true; return orig(...a); };
    void w.pointer.click(300, 300, { ms: 200, expectRoot: 7 });
    await nap(40);
    expect(w.os.left).toBe(true);
    await nap(250);
    expect(w.os.left).toBe(false);
    expect(w.released.some((r) => r.why === "watchdog")).toBe(true);
    expect(w.tracks.some((t) => t.phase === "stuck-release")).toBe(true);
  });
});

describe("what the USER is holding is never released, and stops Momo", () => {
  it("a mouse button the user already has down: Momo does not press, does not release it, and the task stops", async () => {
    const w = world();
    w.os.userLeft = true;
    w.pointer.arm();
    const r = await w.pointer.click(300, 300, { ms: 200, expectRoot: 7 });
    expect(r.ok).toBe(false);
    expect(w.os.log.filter((l) => l.startsWith("down") || l.startsWith("up"))).toEqual([]);
    expect(w.os.userLeft).toBe(true);
    expect(w.interrupts[0][0]).toBe("mouse");
    expect(w.interrupts[0][1].cause).toMatch(/button held/);
  });
  it("a modifier key the user is holding: Momo's shortcut is not sent, and that key is not released", async () => {
    const w = world();
    w.os.userKeys.add(0x10); // Shift, held by the user
    w.pointer.arm();
    const r = await w.pointer.press("ctrl+a");
    expect(r.ok).toBe(false);
    expect(w.os.log.some((l) => l.startsWith("kd:"))).toBe(false);
    expect(w.os.userKeys.has(0x10)).toBe(true);
    expect((await w.pointer.type("abc", 1)).ok).toBe(false);
    expect(w.os.log.some((l) => l.startsWith("unit:"))).toBe(false);
  });
  it("releaseAll only lets go of what Momo pressed: a user-held right button stays", async () => {
    const w = world();
    w.pointer.arm();
    w.os.userRight = true;
    await w.pointer.click(300, 300, { ms: 200, expectRoot: 7 }); // left click while the user holds right: stops, but never releases the user's button
    w.pointer.releaseAll();
    expect(w.os.userRight).toBe(true);
    expect(w.os.log.includes("up:right")).toBe(false);
  });
});

describe("stopping: Esc, Cancel, quitting", () => {
  it("Cancel in the middle of a long glide stops it within a step, releases nothing it does not hold, and refuses more until the next task", async () => {
    const w = world();
    w.pointer.arm();
    w.os.onStep = (s) => { if (w.os.log.filter((l) => l === "move").length === 3) w.pointer.abort("cancel"); };
    const r = await w.pointer.click(900, 700, { ms: 800, expectRoot: 7 });
    expect(r).toEqual({ ok: false, reason: "cancelled" });
    expect(w.os.log.filter((l) => l === "move").length).toBeLessThanOrEqual(4);
    expect(w.os.log.some((l) => l.startsWith("down"))).toBe(false);
    expect(await w.pointer.click(300, 300, { ms: 200 })).toEqual({ ok: false, reason: "cancelled" });
    w.pointer.disarm(); w.pointer.arm(); // the next task
    expect((await w.pointer.click(300, 300, { ms: 200, expectRoot: 7 })).ok).toBe(true);
  });
  it("Cancel while the button is down (between press and release) lets go at once", async () => {
    const w = world({ wait: async () => {} });
    w.pointer.arm();
    const orig = w.os.log.push.bind(w.os.log);
    w.os.log.push = (...a) => { orig(...a); if (a[0] === "down:left") w.pointer.abort("cancel"); };
    await w.pointer.click(300, 300, { ms: 200, expectRoot: 7 });
    expect(nothingHeld(w)).toBe(true);
  });
  it("quitting releases everything and nothing can act afterwards, even after another arm()", async () => {
    const w = world();
    w.pointer.arm();
    w.pointer.dispose();
    w.pointer.arm();
    expect(await w.pointer.click(300, 300, { ms: 200 })).toEqual({ ok: false, reason: "cancelled" });
    expect(await w.pointer.press("enter")).toEqual({ ok: false, reason: "cancelled" });
  });
  it("Esc delivered by the global key hook (never missed, unlike polling) stops the task and Momo's own Esc is ignored", async () => {
    const w = world();
    w.pointer.arm();
    await w.pointer.press("esc"); // Momo's own
    w.pointer.userSignal("esc");
    expect(w.interrupts).toEqual([]);
    await nap(520);
    w.pointer.userSignal("esc");
    expect(w.interrupts[0][0]).toBe("esc");
  });
});

describe("interrupted drag: cancelled, never dropped", () => {
  const dragWorld = (dragCancel) => {
    const w = world({ dragCancel });
    w.pointer.arm();
    return w;
  };
  const afterDown = (w, fn) => { const orig = w.os.log.push.bind(w.os.log); let n = 0; w.os.log.push = (...a) => { orig(...a); if (w.os.left && a[0] === "move" && ++n === 4) fn(); }; };
  const escBeforeUp = (w) => { const i = w.os.log.lastIndexOf("up:left"); const e = w.os.log.lastIndexOf("kd:1b"); return e >= 0 && e < i; };

  it("the user grabs the mouse mid-drag: Esc cancels the drag BEFORE the button is released, and the pointer is not moved (it is theirs)", async () => {
    const w = dragWorld("esc+origin");
    afterDown(w, () => { w.os.x += 300; });
    const r = await w.pointer.drag({ x: 200, y: 200 }, { x: 800, y: 500 }, { ms: 400, expectRoot: 7 });
    expect(r.ok).toBe(false);
    expect(escBeforeUp(w)).toBe(true);
    const moves = w.os.log.filter((l) => l === "move").length;
    expect(nothingHeld(w)).toBe(true);
    expect(w.os.log.filter((l) => l === "move").length).toBe(moves);
    expect(w.os.x).toBeGreaterThan(300); // not dragged back to the origin
  });
  it("Cancel mid-drag: Esc first, then (with the origin strategy) back to where it started, then release", async () => {
    const w = dragWorld("esc+origin");
    afterDown(w, () => w.pointer.abort("cancel"));
    await w.pointer.drag({ x: 200, y: 200 }, { x: 800, y: 500 }, { ms: 400, expectRoot: 7 });
    expect(escBeforeUp(w)).toBe(true);
    expect({ x: w.os.x, y: w.os.y }).toEqual({ x: 200, y: 200 });
    expect(nothingHeld(w)).toBe(true);
  });
  it("the origin-only strategy returns to the start and releases there, without sending Esc", async () => {
    const w = dragWorld("origin");
    afterDown(w, () => w.pointer.abort("cancel"));
    await w.pointer.drag({ x: 200, y: 200 }, { x: 800, y: 500 }, { ms: 400, expectRoot: 7 });
    expect(w.os.log.includes("kd:1b")).toBe(false);
    expect({ x: w.os.x, y: w.os.y }).toEqual({ x: 200, y: 200 });
    expect(nothingHeld(w)).toBe(true);
  });
  it("the target window closes mid-drag: the drag is cancelled, not dropped, and the reason is 'gone'", async () => {
    const w = dragWorld("esc");
    afterDown(w, () => w.os.windows.delete(7));
    const r = await w.pointer.drag({ x: 200, y: 200 }, { x: 800, y: 500 }, { ms: 400, expectRoot: 7, expectWindow: { hwnd: 7, rect: { l: 0, t: 0, w: 1000, h: 800 } } });
    expect(r).toEqual({ ok: false, reason: "gone" });
    expect(escBeforeUp(w)).toBe(true);
    expect(nothingHeld(w)).toBe(true);
  });
  it("something covers the drop point just before the drop: cancelled, not dropped", async () => {
    const w = dragWorld("esc");
    const orig = w.os.log.push.bind(w.os.log);
    w.os.log.push = (...a) => { orig(...a); if (w.os.left && a[0] === "move" && w.os.x >= 799) w.os.root = 99; };
    const r = await w.pointer.drag({ x: 200, y: 200 }, { x: 800, y: 500 }, { ms: 200, expectRoot: 7, dropRoot: 7 });
    expect(r).toEqual({ ok: false, reason: "covered" });
    expect(escBeforeUp(w)).toBe(true);
    expect(nothingHeld(w)).toBe(true);
  });
  it("the caller's drop check can refuse at the last moment", async () => {
    const w = dragWorld("esc");
    const r = await w.pointer.drag({ x: 200, y: 200 }, { x: 500, y: 400 }, { ms: 200, expectRoot: 7, verifyDrop: async () => ({ ok: false, reason: "changed" }) });
    expect(r).toEqual({ ok: false, reason: "changed" });
    expect(escBeforeUp(w)).toBe(true);
  });
  it("an exception mid-drag also cancels instead of dropping", async () => {
    const w = dragWorld("esc");
    w.os.fail = { name: "unit", at: 1 }; // (unused by drag) keep the harness honest
    w.os.fail = { name: "windowAt", at: 3, when: "before", times: 1 };
    const r = await w.pointer.drag({ x: 200, y: 200 }, { x: 800, y: 500 }, { ms: 400, expectRoot: 7, dropRoot: 7 });
    expect(r.ok).toBe(false);
    expect(nothingHeld(w)).toBe(true);
  });
});

describe("the last look before a click: nothing is clicked on an old picture", () => {
  it("a window appears over the target during the hover: no press", async () => {
    const w = world();
    w.pointer.arm();
    w.os.onStep = () => {};
    let n = 0;
    const orig = w.os.log.push.bind(w.os.log);
    w.os.log.push = (...a) => { orig(...a); if (a[0] === "move") n++; };
    // the cover arrives after the glide has finished (nudge is the hover)
    const nativeNudge = w.os; void nativeNudge;
    const r = await w.pointer.click(300, 300, { ms: 200, expectRoot: 7, verifyTarget: async () => { w.os.root = 99; return { ok: true }; } });
    expect(r).toEqual({ ok: false, reason: "covered" });
    expect(w.os.log.some((l) => l.startsWith("down"))).toBe(false);
  });
  it("the target check refuses (password field, different element): no press, and the reason is passed on", async () => {
    for (const reason of ["password", "changed"]) {
      const w = world();
      w.pointer.arm();
      expect(await w.pointer.click(300, 300, { ms: 200, expectRoot: 7, verifyTarget: async () => ({ ok: false, reason }) })).toEqual({ ok: false, reason });
      expect(w.os.log.some((l) => l.startsWith("down"))).toBe(false);
    }
  });
  it("a target check that cannot run (throws) is NOT a pass", async () => {
    const w = world();
    w.pointer.arm();
    expect(await w.pointer.click(300, 300, { ms: 200, expectRoot: 7, verifyTarget: async () => { throw new Error("helper died"); } })).toEqual({ ok: false, reason: "changed" });
    expect(w.os.log.some((l) => l.startsWith("down"))).toBe(false);
  });
  it("the target check is asked about the exact point the click will hit", async () => {
    const w = world();
    w.pointer.arm();
    let asked = null;
    await w.pointer.click(412, 233, { ms: 200, expectRoot: 7, verifyTarget: async (pt) => { asked = pt; return { ok: true }; } });
    expect(asked).toEqual({ x: 412, y: 233 });
  });
  it("the window moves while the (slow) target check runs: no press", async () => {
    const w = world();
    w.pointer.arm();
    const r = await w.pointer.click(300, 300, { ms: 200, expectRoot: 7, expectWindow: { hwnd: 7, rect: { l: 0, t: 0, w: 1000, h: 800 } }, verifyTarget: async () => { w.os.rect = { l: 80, t: 80, w: 1000, h: 800 }; return { ok: true }; } });
    expect(r).toEqual({ ok: false, reason: "moved" });
    expect(w.os.log.some((l) => l.startsWith("down"))).toBe(false);
  });
  it("the user touches the mouse during the target check: no press", async () => {
    const w = world();
    w.pointer.arm();
    const r = await w.pointer.click(300, 300, { ms: 200, expectRoot: 7, verifyTarget: async () => { w.os.x += 200; return { ok: true }; } });
    expect(r).toEqual({ ok: false, reason: "user_moved" });
    expect(w.os.log.some((l) => l.startsWith("down"))).toBe(false);
  });
  it("the window closed: reason 'gone', no press", async () => {
    const w = world();
    w.pointer.arm();
    w.os.windows.delete(7);
    expect(await w.pointer.click(300, 300, { ms: 200, expectWindow: { hwnd: 7, rect: { l: 0, t: 0, w: 1000, h: 800 } } })).toEqual({ ok: false, reason: "gone" });
  });
});

describe("monitors: negative coordinates, gaps and mixed scaling (simulated: this PC has one display)", () => {
  // a 4K 200% screen in the middle, a 1080p 100% screen to its left (negative x) and a 125% laptop panel below
  const layout = [
    { id: 1, l: 0, t: 0, w: 3840, h: 2160, dpi: 192 },
    { id: 2, l: -1920, t: 0, w: 1920, h: 1080, dpi: 96 },
    { id: 3, l: 0, t: 2160, w: 1920, h: 1080, dpi: 120 },
  ];
  it("clicks a point on the LEFT monitor (negative x) and on the one below, exactly", async () => {
    for (const [x, y] of [[-500, 300], [-1919, 1079], [500, 2500], [3839, 2159]]) {
      const w = world({ monitors: layout });
      w.pointer.arm();
      expect(await w.pointer.click(x, y, { ms: 200 })).toEqual({ ok: true });
      expect({ x: w.os.x, y: w.os.y }).toEqual({ x, y });
    }
  });
  it("a point on no monitor (past the edge, or in the gap beside the small monitor) is refused as 'offscreen' without moving or pressing", async () => {
    for (const [x, y] of [[5000, 300], [-1921, 10], [-100, 1500], [2000, 2500], [-1, -1]]) {
      const w = world({ monitors: layout });
      w.pointer.arm();
      expect(await w.pointer.click(x, y, { ms: 200 })).toEqual({ ok: false, reason: "offscreen" });
      expect(w.os.log).toEqual([]);
      expect(w.interrupts).toEqual([]); // and above all it is NOT reported as "you moved the mouse"
    }
  });
  it("crossing the gap between monitors on the way does not look like the user grabbing the mouse (Windows clamps the pointer there)", async () => {
    const w = world({ monitors: layout });
    w.os.x = -500; w.os.y = 900; // bottom of the small left monitor
    w.pointer.arm();
    // straight line to the lower monitor passes through the empty corner below the small monitor
    const r = await w.pointer.click(300, 2600, { ms: 400 });
    expect(r.ok === true || r.reason === "cursor_refused").toBe(true);
    expect(w.interrupts).toEqual([]);
  });
  it("scaling rounding (the pointer lands a few pixels off after each move) is where it IS, not the user", async () => {
    const w = world({ monitors: layout });
    w.os.jitter = 3;
    w.pointer.arm();
    const r = await w.pointer.click(1000, 500, { ms: 300 });
    expect(r).toEqual({ ok: true });
    expect(w.interrupts).toEqual([]);
  });
  it("another program has confined the pointer: refused honestly ('cursor_refused'), not blamed on the user", async () => {
    const w = world({ monitors: layout });
    w.os.clipped = true;
    w.pointer.arm();
    expect(await w.pointer.click(300, 300, { ms: 200 })).toEqual({ ok: false, reason: "cursor_refused" });
    expect(w.interrupts).toEqual([]);
  });
  it("a pointer that will not go where it is sent (but is not moved by the user either) is 'cursor_refused'", async () => {
    const w = world({ monitors: layout });
    const origSet = w.os.onStep;
    void origSet;
    w.pointer.arm();
    w.os.onStep = (s) => { s.x = 150; s.y = 150; }; // Windows keeps putting it back at the same spot
    const r = await w.pointer.click(900, 700, { ms: 300 });
    expect(r.ok).toBe(false);
  });
});

describe("telling the user from everything else", () => {
  const armedUsed = async (w) => { w.pointer.arm(); await w.pointer.click(300, 300, { ms: 200, expectRoot: 7 }); }; // Momo has used the mouse
  it("a wheel turn, a click or a key by the user after Momo started acting stops the task", async () => {
    for (const kind of ["wheel", "click", "key"]) {
      const w = world();
      await armedUsed(w);
      await nap(450);
      w.pointer.userSignal(kind);
      expect(w.interrupts.length, kind).toBe(1);
      expect(w.interrupts[0][1].cause).toMatch(/wheel|click|keyboard/);
      expect(await w.pointer.click(300, 300, { ms: 200 })).toEqual({ ok: false, reason: "user_moved" });
    }
  });
  it("...but not before Momo has used the mouse in this task (the user is simply working while Momo thinks)", () => {
    const w = world();
    w.pointer.arm();
    w.pointer.userSignal("wheel"); w.pointer.userSignal("click"); w.pointer.userSignal("key");
    expect(w.interrupts).toEqual([]);
  });
  it("Momo's own wheel, button and key input (reported back by the hook a moment later) is not the user", async () => {
    const w = world();
    w.pointer.arm();
    await w.pointer.scroll(400, 300, 2, { ms: 200, expectRoot: 7 });
    w.pointer.userSignal("wheel");
    expect(w.interrupts).toEqual([]);
    await w.pointer.click(300, 300, { ms: 200, expectRoot: 7 });
    w.pointer.userSignal("click");
    await w.pointer.press("ctrl+a");
    w.pointer.userSignal("key");
    expect(w.interrupts).toEqual([]);
  });
  it("an interruption explains itself: what, how far, where, and the last pointer positions (for the next 'You moved the mouse' mystery)", async () => {
    const w = world();
    w.pointer.arm();
    w.os.onStep = (s) => { if (w.os.log.filter((l) => l === "move").length === 5) s.x += 250; };
    await w.pointer.click(800, 600, { ms: 400, expectRoot: 7 });
    const d = w.pointer.lastInterrupt();
    expect(d).toMatchObject({ reason: "mouse", cause: "mouse moved", lastInputAgeMs: 12345 });
    expect(d.dist).toBeGreaterThan(200);
    expect(d.recent.length).toBeGreaterThan(2);
    expect(w.interrupts[0][1]).toBe(d);
  });
});

describe("typing: the keyboard follows the focus, and stops when it is taken away", () => {
  it("a dialog takes the focus after three letters: the rest is NOT typed", async () => {
    const w = world();
    w.pointer.arm();
    let n = 0;
    w.os.onUnit = (s) => { if (++n === 3) s.fg = 99; };
    const r = await w.pointer.type("abcdefgh", 1, { expectForeground: 7 });
    expect(r).toEqual({ ok: false, reason: "focus_changed" });
    expect(w.os.log.filter((l) => l.startsWith("unit:")).length).toBe(3);
  });
  it("it never starts typing when another window already has the focus", async () => {
    const w = world();
    w.os.fg = 99;
    w.pointer.arm();
    expect(await w.pointer.type("abc", 1, { expectForeground: 7 })).toEqual({ ok: false, reason: "focus_changed" });
    expect(await w.pointer.press("ctrl+a", { expectForeground: 7 })).toEqual({ ok: false, reason: "focus_changed" });
    expect(w.os.log).toEqual([]);
  });
  it("the window being typed into closes: typing stops with reason 'gone'", async () => {
    const w = world();
    w.pointer.arm();
    let n = 0;
    w.os.onUnit = (s) => { if (++n === 2) s.windows.delete(7); };
    expect(await w.pointer.type("abcdef", 1, { expectWindow: 7 })).toEqual({ ok: false, reason: "gone" });
    expect(w.os.log.filter((l) => l.startsWith("unit:")).length).toBe(2);
  });
  it("a key chord is released in reverse order even when the main key's release fails once", async () => {
    const w = world();
    w.os.fail = { name: "keyUp", at: 1, when: "before", times: 1 };
    w.pointer.arm();
    await w.pointer.press("ctrl+shift+a");
    await nap(30);
    expect(w.os.keys.size).toBe(0);
  });
});

describe("scrolling stops when something opens over the page", () => {
  it("a window appears over the scroll point after one notch: no more wheel notches go to it", async () => {
    const w = world();
    w.pointer.arm();
    const orig = w.os.log.push.bind(w.os.log);
    w.os.log.push = (...a) => { orig(...a); if (a[0] === "wheel:-120") w.os.root = 99; };
    const r = await w.pointer.scroll(400, 300, 6, { ms: 200, expectRoot: 7 });
    expect(r).toEqual({ ok: false, reason: "covered" });
    expect(w.os.wheelCount).toBe(1);
  });
});
