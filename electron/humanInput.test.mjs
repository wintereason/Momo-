import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { parseKeys, createPointerFrom, TAKEOVER_PX } = createRequire(import.meta.url)("./humanInput.cjs");

describe("humanInput key parsing (the only keys Momo may press)", () => {
  it("understands single keys and chords", () => {
    expect(parseKeys("enter")).toEqual([0x0d]);
    expect(parseKeys("ctrl+a")).toEqual([0x11, 0x41]);
    expect(parseKeys("Win")).toEqual([0x5b]);
    expect(parseKeys("f5")).toEqual([0x74]);
  });
  it("refuses anything it does not know", () => {
    expect(parseKeys("")).toBeNull();
    expect(parseKeys("ctrl+alt+del+x+y")).toBeNull();
    expect(parseKeys("launch missiles")).toBeNull();
  });
});

/** A fake Windows: a cursor, a keyboard, a window under the pointer. `onStep` lets a test play the user at a chosen moment. */
function fake(over = {}) {
  const st = { x: 100, y: 100, downs: 0, ups: 0, units: [], esc: false, root: 7, cls: "App", rect: { l: 0, t: 0, w: 800, h: 600 }, steps: 0, onStep: null, keys: [] };
  const native = {
    pos: () => ({ x: st.x, y: st.y }),
    setPos: (x, y) => { st.x = x; st.y = y; st.steps++; if (st.onStep) st.onStep(st); },
    escDown: () => st.esc,
    windowAt: () => st.root,
    classAt: () => st.cls,
    windowRect: () => (st.rect ? { ...st.rect } : null),
    mouseDown: () => { st.downs++; return true; },
    mouseUp: () => { st.ups++; },
    nudge: (dx) => { st.x += dx; },
    keyDown: (vk) => st.keys.push(["down", vk]),
    keyUp: (vk) => st.keys.push(["up", vk]),
    unit: (u) => { st.units.push(u); if (st.onUnit) st.onUnit(st); return true; },
    ...over,
  };
  const tracks = [];
  const interrupts = [];
  const pointer = createPointerFrom(native, { wait: async () => {}, watchMs: 5, onTrack: (e) => tracks.push(e), onInterrupt: (r) => interrupts.push(r) });
  return { st, pointer, tracks, interrupts };
}
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

describe("gliding and clicking", () => {
  it("glides in many small steps, streams each REAL position, then hovers, presses and releases in that order", async () => {
    const f = fake();
    f.pointer.arm();
    const r = await f.pointer.click(500, 300, { ms: 400, expectRoot: 7 });
    expect(r).toEqual({ ok: true });
    const moves = f.tracks.filter((t) => t.phase === "move");
    expect(moves.length).toBeGreaterThanOrEqual(8);
    expect(moves[moves.length - 1]).toMatchObject({ x: 500, y: 300 }); // ends exactly on the target
    for (let i = 1; i < moves.length; i++) expect(moves[i].x).toBeGreaterThanOrEqual(moves[i - 1].x); // a smooth path, not a jump
    const phases = f.tracks.map((t) => t.phase).filter((p) => p !== "move");
    expect(phases).toEqual(["hover", "press", "release"]);
    expect(f.st.downs).toBe(1);
    expect(f.st.ups).toBe(1);
  });
  it("a double click presses twice", async () => {
    const f = fake();
    f.pointer.arm();
    await f.pointer.click(300, 300, { ms: 200, double: true });
    expect(f.st.downs).toBe(2);
  });
  it("never presses when another window is under the pointer, or the taskbar is hidden", async () => {
    const a = fake({ windowAt: () => 99 });
    a.pointer.arm();
    expect(await a.pointer.click(300, 300, { ms: 200, expectRoot: 7 })).toEqual({ ok: false, reason: "covered" });
    expect(a.st.downs).toBe(0);
    const b = fake();
    b.st.cls = "Chrome_WidgetWin_1";
    b.pointer.arm();
    expect(await b.pointer.click(48, 800, { ms: 200, expectClass: ["Shell_TrayWnd"] })).toEqual({ ok: false, reason: "covered" });
    expect(b.st.downs).toBe(0);
  });
});

describe("the window moved since it was read", () => {
  it("refuses to click at a stale position (the window was dragged before the move began)", async () => {
    const f = fake();
    f.pointer.arm();
    const r = await f.pointer.click(500, 300, { ms: 200, expectWindow: { hwnd: 7, rect: { l: 300, t: 200, w: 800, h: 600 } } });
    expect(r).toEqual({ ok: false, reason: "moved" });
    expect(f.st.downs).toBe(0);
  });
  it("refuses if it is dragged WHILE the pointer travels", async () => {
    const f = fake();
    f.st.onStep = (s) => { if (s.steps === 4) s.rect = { l: 40, t: 40, w: 800, h: 600 }; };
    f.pointer.arm();
    const r = await f.pointer.click(500, 300, { ms: 400, expectWindow: { hwnd: 7, rect: { l: 0, t: 0, w: 800, h: 600 } } });
    expect(r).toEqual({ ok: false, reason: "moved" });
    expect(f.st.downs).toBe(0);
  });
  it("a window that has not moved (within a few pixels) is fine", async () => {
    const f = fake();
    f.st.rect = { l: 1, t: 2, w: 801, h: 599 };
    f.pointer.arm();
    expect((await f.pointer.click(500, 300, { ms: 200, expectWindow: { hwnd: 7, rect: { l: 0, t: 0, w: 800, h: 600 } } })).ok).toBe(true);
  });
});

describe("the user always wins", () => {
  it("moving the physical mouse mid-glide stops at once: no click, the task is told, and the ghost is told to stop", async () => {
    const f = fake();
    f.st.onStep = (s) => { if (s.steps === 5) { s.x += 300; s.y += 200; } }; // the user shoves the mouse
    f.pointer.arm();
    const r = await f.pointer.click(700, 500, { ms: 400 });
    expect(r).toEqual({ ok: false, reason: "user_moved" });
    expect(f.st.downs).toBe(0);
    expect(f.interrupts).toEqual(["mouse"]);
    expect(f.tracks.some((t) => t.phase === "stop" && t.reason === "mouse")).toBe(true);
    expect(f.st.steps).toBeLessThan(10); // it did not keep going to the target
  });
  it("pressing Esc mid-glide stops at once", async () => {
    const f = fake();
    f.st.onStep = (s) => { if (s.steps === 3) s.esc = true; };
    f.pointer.arm();
    expect(await f.pointer.click(700, 500, { ms: 400 })).toEqual({ ok: false, reason: "stopped" });
    expect(f.st.downs).toBe(0);
    expect(f.interrupts).toEqual(["esc"]);
  });
  it("once the user has taken over, NOTHING more is done until the next task: not a click, a key or typing", async () => {
    const f = fake();
    f.pointer.arm();
    f.st.esc = true;
    await f.pointer.click(300, 300, { ms: 200 });
    f.st.esc = false;
    expect(f.pointer.interrupted()).toBe("esc");
    expect((await f.pointer.click(300, 300, { ms: 200 })).ok).toBe(false);
    expect((await f.pointer.press("enter")).ok).toBe(false);
    expect((await f.pointer.type("hello")).ok).toBe(false);
    expect(f.st.downs).toBe(0);
    expect(f.st.units).toEqual([]);
    expect(f.st.keys).toEqual([]);
    f.pointer.arm(); // "working" is announced many times during one task: that must NOT undo a stop
    expect(f.pointer.interrupted()).toBe("esc");
    expect((await f.pointer.click(300, 300, { ms: 200 })).ok).toBe(false);
    f.pointer.disarm(); // the task ended...
    f.pointer.arm(); // ...and a new one begins: free again
    expect(f.pointer.interrupted()).toBeNull();
    expect((await f.pointer.click(300, 300, { ms: 200 })).ok).toBe(true);
  });
  it("the watchdog notices the mouse being moved BETWEEN steps (after the click, before the next one)", async () => {
    const f = fake();
    f.pointer.arm();
    expect((await f.pointer.click(500, 300, { ms: 200 })).ok).toBe(true);
    expect(f.interrupts).toEqual([]);
    f.st.x += 200; f.st.y += 100; // the user grabs the mouse while Momo is "thinking"
    await nap(60);
    expect(f.interrupts).toEqual(["mouse"]);
    expect(f.pointer.interrupted()).toBe("mouse");
  });
  it("the watchdog notices Esc between steps too", async () => {
    const f = fake();
    f.pointer.arm();
    await f.pointer.click(500, 300, { ms: 200 });
    f.st.esc = true;
    await nap(60);
    expect(f.interrupts).toEqual(["esc"]);
  });
  it("tiny jitter (under the threshold) is not mistaken for the user", async () => {
    const f = fake();
    f.pointer.arm();
    await f.pointer.click(500, 300, { ms: 200 });
    f.st.x += TAKEOVER_PX - 8;
    await nap(40);
    expect(f.interrupts).toEqual([]);
  });
  it("typing stops between keys when Esc is pressed, with only the keys already typed", async () => {
    const f = fake();
    f.st.onUnit = (s) => { if (s.units.length === 3) s.esc = true; };
    f.pointer.arm();
    const r = await f.pointer.type("hello world");
    expect(r).toEqual({ ok: false, reason: "stopped" });
    expect(f.st.units).toEqual([..."hel"].map((c) => c.charCodeAt(0)));
    expect(f.tracks.filter((t) => t.phase === "key").map((t) => t.ch).join("")).toBe("hel"); // the ghost's bubble shows exactly what was typed
  });
  it("typing stops when the mouse is moved away, too (after a click gave Momo a place for it)", async () => {
    const f = fake();
    f.pointer.arm();
    await f.pointer.click(500, 300, { ms: 200 });
    f.st.onUnit = (s) => { if (s.units.length === 2) { s.x += 250; } };
    const r = await f.pointer.type("abcdef");
    expect(r.ok).toBe(false);
    expect(f.st.units.length).toBeLessThanOrEqual(3);
  });
  it("after disarm() the pointer is simply the user's again: no more watching", async () => {
    const f = fake();
    f.pointer.arm();
    await f.pointer.click(500, 300, { ms: 200 });
    f.pointer.disarm();
    f.st.x += 400;
    f.st.esc = true;
    await nap(60);
    expect(f.interrupts).toEqual([]);
  });
});

describe("typing", () => {
  it("types every character, including non-Latin ones and emoji (as UTF-16 units), and streams each letter as it is typed", async () => {
    const f = fake();
    f.pointer.arm();
    expect((await f.pointer.type("नमस्ते 😀")).ok).toBe(true);
    expect(f.st.units.length).toBe([..."नमस्ते 😀"].reduce((n, c) => n + c.length, 0));
    expect(f.tracks.filter((t) => t.phase === "key").map((t) => t.ch).join("")).toBe("नमस्ते 😀");
  });
});
