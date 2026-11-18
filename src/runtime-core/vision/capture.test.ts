import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { VisualCapture } from "./capture";
import type { CaptureTransport } from "../shared/ports";
import { CAPTURE_SOURCE, CAPTURE_PS } from "../shared/captureHelper";
import { HELPER_SCRIPT, UiaHost } from "../shared/uiaHelper";
import { Session } from "../orchestrator/session";

type Reply = Record<string, unknown> | Error;
const frame = (n: number, over: Record<string, unknown> = {}) => ({ ok: true, state: "ready", ready: true, session: 1, frame: n, w: 1640, h: 1280, l: 100, t: 50, dpi: 96, mdpi: 192, ms: 60, ...over });
const notReady = (n: number) => ({ ok: true, state: "not_ready", ready: false, session: 1, frame: n });

/** a scripted helper: grabs answer in order (the last one repeats); every command is recorded */
function fake(grabs: Reply[], o: { start?: Reply; info?: Reply } = {}) {
  const calls: string[] = [];
  let i = 0;
  const transport: CaptureTransport = {
    async send(cmd, hwnd) {
      calls.push(hwnd === undefined ? cmd : `${cmd} ${([] as number[]).concat(hwnd).join(" ")}`);
      const give = (r: Reply) => { if (r instanceof Error) throw r; return r; };
      if (cmd === "capstart") return give(o.start ?? { ok: true, session: 1, bytes: 8_396_800 });
      if (cmd === "capgrab") return give(grabs[Math.min(i++, grabs.length - 1)]);
      if (cmd === "capinfo") return give(o.info ?? { ok: true, active: true, session: 1, frame: 1, ageMs: 10, sameRect: true, refusal: null });
      return { ok: true, was: true };
    },
  };
  return { transport, calls };
}
const quick = { sleep: async () => {} };

describe("window capture: readiness (Phase 6a)", () => {
  it("needs successive agreeing frames: a first frame alone is not ready, the second that agrees is", async () => {
    const f = fake([notReady(1), frame(2)]);
    const cap = new VisualCapture(f.transport, quick);
    const r = await cap.observe(42);
    expect(r).toMatchObject({ ok: true, frame: { frame: 2, w: 1640, h: 1280, l: 100, t: 50, dpi: 96, monitorDpi: 192 } });
    expect(f.calls).toEqual(["capstart 42", "capgrab", "capgrab"]);
  });

  it("a window that keeps changing never becomes ready: it is reported as changing, not as content", async () => {
    const f = fake([{ ok: true, state: "changing", ready: false, session: 1, frame: 1 }]);
    const r = await new VisualCapture(f.transport, quick).observe(42);
    expect(r).toMatchObject({ ok: false, state: "changing" });
  });

  it.each(["blank", "black", "incomplete"] as const)("a %s frame is never valid content, however many times it is tried", async (state) => {
    const f = fake([{ ok: false, state, ready: false, session: 1, frame: 1 }]);
    const cap = new VisualCapture(f.transport, quick);
    const r = await cap.observe(42);
    expect(r).toMatchObject({ ok: false, state });
    expect((r as { reason: string }).reason).toMatch(/cannot tell what is in it/);
    expect(f.calls.filter((c) => c === "capgrab").length).toBe(6); // it tried to wait for the window to paint, then said so
  });

  it("a window that paints late is accepted once it settles (blank frames first, then two good ones)", async () => {
    const f = fake([{ ok: false, state: "blank" }, { ok: false, state: "black" }, notReady(3), frame(4)]);
    expect(await new VisualCapture(f.transport, quick).observe(42)).toMatchObject({ ok: true, frame: { frame: 4 } });
  });

  it.each(["minimized", "hidden", "excluded", "hung", "gone", "too_big", "too_small"] as const)("a %s window is refused at once, with no retries, and nothing is held afterwards", async (state) => {
    const f = fake([{ ok: false, state }]);
    const cap = new VisualCapture(f.transport, quick);
    expect(await cap.observe(42)).toMatchObject({ ok: false, state });
    expect(f.calls.filter((c) => c === "capgrab").length).toBe(1);
    expect(cap.active()).toBe(false);
    expect(f.calls).toContain("capstop");
  });

  it("refusals of the start (a capture-excluded or minimized window) are carried through and nothing is started", async () => {
    for (const state of ["excluded", "minimized"] as const) {
      const f = fake([frame(1)], { start: { ok: false, state } });
      const cap = new VisualCapture(f.transport, quick);
      expect(await cap.observe(42)).toMatchObject({ ok: false, state });
      expect(f.calls).toEqual(["capstart 42"]);
      expect(cap.active()).toBe(false);
    }
  });

  it("an answer that is not understood, or says 'ready' without the facts that prove it, is not ready", async () => {
    for (const bad of [null, {}, { state: "weird" }, { ok: true, state: "ready" }, { ok: true, state: "ready", ready: true, session: 99, frame: 1, w: 10, h: 10, l: 0, t: 0 }, { ok: true, state: "ready", ready: true, session: 1, frame: 1, w: NaN, h: 10, l: 0, t: 0 }]) {
      const f = fake([bad as Reply]);
      const r = await new VisualCapture(f.transport, quick).observe(42);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("with no helper at all, or one that throws, the answer is 'unavailable', never an empty window", async () => {
    expect(await new VisualCapture(undefined).observe(42)).toMatchObject({ ok: false, state: "unavailable" });
    const f = fake([new Error("helper unavailable")]);
    const cap = new VisualCapture(f.transport, quick);
    expect(await cap.observe(42)).toMatchObject({ ok: false, state: "unavailable" });
    expect(cap.active()).toBe(false);
  });

  it("100 trials of blank, black, changing and half-painted frames: not one is ever reported as valid content", async () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const bad = ["blank", "black", "incomplete", "changing", "not_ready"];
    let wrong = 0;
    for (let t = 0; t < 100; t++) {
      const seq: Reply[] = Array.from({ length: 6 }, () => ({ ok: false, state: bad[Math.floor(rnd() * bad.length)], ready: false, session: 1, frame: 1 }));
      const r = await new VisualCapture(fake(seq).transport, quick).observe(42);
      if (r.ok) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it("the reasons are fixed sentences: no window number, title or content can be in one", async () => {
    const states = ["blank", "black", "minimized", "excluded", "hung", "gone", "changing"] as const;
    for (const s of states) {
      const r = await new VisualCapture(fake([{ ok: false, state: s }]).transport, quick).observe(123456789);
      expect((r as { reason: string }).reason).not.toMatch(/\d/);
    }
  });
});

describe("window capture: lifetime, memory and cleanup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("release() frees the helper's bitmap once, is safe to repeat, and never wakes the helper when nothing was started", async () => {
    const f = fake([frame(1)]);
    const cap = new VisualCapture(f.transport, quick);
    await cap.release();
    expect(f.calls).toEqual([]); // nothing started: no request at all
    await cap.observe(42);
    expect(cap.active()).toBe(true);
    await cap.release(); await cap.release();
    expect(f.calls.filter((c) => c === "capstop").length).toBe(1);
    expect(cap.active()).toBe(false);
    expect(cap.stats()).toMatchObject({ starts: 1, releases: 1, active: false });
  });

  it("an idle capture is released by itself", async () => {
    const f = fake([frame(1)]);
    const cap = new VisualCapture(f.transport, { ...quick, idleMs: 5000 });
    await cap.observe(42);
    expect(cap.active()).toBe(true);
    await vi.advanceTimersByTimeAsync(5001);
    expect(cap.active()).toBe(false);
    expect(f.calls).toContain("capstop");
  });

  it("looking at another window frees the first window's capture before starting the next", async () => {
    const f = fake([frame(1)]);
    const cap = new VisualCapture(f.transport, quick);
    await cap.observe(42);
    await cap.observe(43);
    expect(f.calls).toEqual(["capstart 42", "capgrab", "capstop", "capstart 43", "capgrab"]);
  });

  it("a cancelled task stops the look at once and releases the capture", async () => {
    const f = fake([notReady(1), notReady(2), frame(3)]);
    const cap = new VisualCapture(f.transport, quick);
    let live = true;
    const wrapped: CaptureTransport = { send: async (c, h, t) => { const r = await f.transport.send(c, h, t); if (c === "capgrab") live = false; return r; } };
    const c2 = new VisualCapture(wrapped, quick);
    const r = await c2.observe(42, () => live);
    expect(r).toMatchObject({ ok: false, state: "cancelled" });
    expect(c2.active()).toBe(false);
    void cap;
  });

  it("looks queue: two at once never interleave their requests", async () => {
    const f = fake([frame(1)]);
    const cap = new VisualCapture(f.transport, quick);
    await Promise.all([cap.observe(42), cap.observe(42)]);
    expect(f.calls.filter((c) => c === "capstart 42").length).toBe(1); // the second reused the capture
  });
});

describe("window capture: a window that sticks out past the desktop", () => {
  const onDesktop = { vl: 0, vt: 0, vw: 2880, vh: 1800 };
  it("is flagged clipped when any part of it is outside the desktop's bounds, and not otherwise", async () => {
    const inside = await new VisualCapture(fake([frame(1, onDesktop)]).transport, quick).observe(42);
    const below = await new VisualCapture(fake([frame(1, { ...onDesktop, t: 1000, h: 1280 })]).transport, quick).observe(42);   // 1000 + 1280 > 1800
    const left = await new VisualCapture(fake([frame(1, { ...onDesktop, l: -50 })]).transport, quick).observe(42);
    const right = await new VisualCapture(fake([frame(1, { ...onDesktop, l: 1300 })]).transport, quick).observe(42);           // 1300 + 1640 > 2880
    if (!inside.ok || !below.ok || !left.ok || !right.ok) throw new Error("setup");
    expect(inside.frame.clipped).toBe(false);
    expect(below.frame.clipped).toBe(true);
    expect(left.frame.clipped).toBe(true);
    expect(right.frame.clipped).toBe(true);
    expect(inside.frame.visible).toEqual({ l: 0, t: 0, w: 2880, h: 1800 });
  });
  it("the invisible resize border of a maximized window (a few px past the edge) is not clipping, but a real overhang is", async () => {
    const border = await new VisualCapture(fake([frame(1, { ...onDesktop, l: -15, t: -13, w: 2910, h: 1826 })]).transport, quick).observe(42);   // 15 px past the left/top edge
    const real = await new VisualCapture(fake([frame(1, { ...onDesktop, l: -60 })]).transport, quick).observe(42);
    if (!border.ok || !real.ok) throw new Error("setup");
    expect(border.frame.clipped).toBe(false);
    expect(real.frame.clipped).toBe(true);
  });
  it("a second monitor to the left (negative coordinates) is part of the desktop", async () => {
    const r = await new VisualCapture(fake([frame(1, { vl: -2560, vt: 0, vw: 5440, vh: 1800, l: -2000, t: 100 })]).transport, quick).observe(42);
    if (!r.ok) throw new Error("setup");
    expect(r.frame.clipped).toBe(false);
  });
  it("when the helper does not say where the desktop is, nothing is claimed to be outside it", async () => {
    const r = await new VisualCapture(fake([frame(1)]).transport, quick).observe(42);
    if (!r.ok) throw new Error("setup");
    expect(r.frame.clipped).toBe(false);
  });
});

describe("window capture: a busy window (Phase 6d)", () => {
  it("a window that does not answer in time is reported 'busy' at once: no retries within the look, nothing held, a fixed sentence", async () => {
    const f = fake([{ ok: false, state: "busy" }]);
    const cap = new VisualCapture(f.transport, quick);
    const r = await cap.observe(42);
    expect(r).toMatchObject({ ok: false, state: "busy" });
    expect((r as { reason: string }).reason).toMatch(/busy and did not answer in time/);
    expect((r as { reason: string }).reason).not.toMatch(/\d/);
    expect(f.calls.filter((c) => c === "capgrab").length).toBe(1);
    expect(cap.active()).toBe(false);
    expect(f.calls).toContain("capstop");
  });

  it("'busy' is never read as content, and the next look can succeed once the window answers again", async () => {
    const f = fake([{ ok: false, state: "busy" }, frame(2)]);
    const cap = new VisualCapture(f.transport, quick);
    expect((await cap.observe(42)).ok).toBe(false);
    expect(await cap.observe(42)).toMatchObject({ ok: true });
  });

  it("the helper's capture waits for PrintWindow only on a worker thread, for a bounded time, with a scratch bitmap of its own (source guard)", () => {
    expect(CAPTURE_SOURCE).toMatch(/PrintBounded/);
    expect(CAPTURE_SOURCE).toMatch(/Done\.WaitOne\(PrintTimeoutMs\)/);
    // PrintWindow is called from exactly one place: inside the worker
    const calls = [...CAPTURE_SOURCE.matchAll(/(?<!extern bool )(?<![\w.])PrintWindow\(/g)].length;
    expect(calls).toBe(1);
    expect(CAPTURE_SOURCE).toMatch(/new Thread\(delegate \(\) \{\s*try \{ j\.Ok = PrintWindow\(/);
    // an abandoned worker frees only ITS scratch bitmap, never the session's
    expect(CAPTURE_SOURCE).toMatch(/drop = j\.Abandoned; if \(drop\) j\.Free\(\);/);
    // bounded: at most three abandoned workers, never two for one window
    expect(CAPTURE_SOURCE).toMatch(/Stuck\.Count >= 3/);
  });
});

describe("window capture: the helper gives its per-frame resources back (Phase 6e)", () => {
  it("every frame's worker event is closed, by the capture itself when the window answered and by the abandoned worker when it did not (source guard)", () => {
    expect(CAPTURE_SOURCE).toMatch(/j\.Done\.Close\(\);\s*\/\/ answered in time/);
    expect(CAPTURE_SOURCE).toMatch(/if \(drop\) j\.Done\.Close\(\)/);
  });
  it("releasing a session collects the per-frame thread handles at once instead of leaving them to the collector (source guard)", () => {
    expect(CAPTURE_SOURCE).toMatch(/public static string Stop\(\) \{[^}]*\}\s*GC\.Collect\(\); GC\.WaitForPendingFinalizers\(\);/s);
  });
});

describe("window capture: freshness", () => {
  it("a frame is fresh only while it is the latest, young, and the window is where it was", async () => {
    let now = 1000;
    const f = fake([frame(5)], { info: { ok: true, active: true, session: 1, frame: 5, ageMs: 200, sameRect: true, refusal: null } });
    const cap = new VisualCapture(f.transport, { ...quick, now: () => now, maxAgeMs: 1500 });
    const r = await cap.observe(42);
    if (!r.ok) throw new Error("setup");
    expect(cap.isFresh(r.frame)).toBe(true);
    expect(await cap.confirmFresh(r.frame)).toEqual({ ok: true });
    now += 1600; // too old
    expect(cap.isFresh(r.frame)).toBe(false);
    expect(await cap.confirmFresh(r.frame)).toMatchObject({ ok: false, reason: expect.stringMatching(/out of date/) });
  });

  it("a moved or resized window makes the frame stale (the coordinates no longer match)", async () => {
    const f = fake([frame(5)], { info: { ok: true, active: true, session: 1, frame: 5, ageMs: 100, sameRect: false, refusal: null } });
    const cap = new VisualCapture(f.transport, quick);
    const r = await cap.observe(42); if (!r.ok) throw new Error("setup");
    expect(await cap.confirmFresh(r.frame)).toMatchObject({ ok: false, reason: expect.stringMatching(/moved or changed size/) });
  });

  it("a window that was minimized, hidden or lost after the frame makes it stale", async () => {
    const f = fake([frame(5)], { info: { ok: true, active: true, session: 1, frame: 5, ageMs: 100, sameRect: true, refusal: "minimized" } });
    const cap = new VisualCapture(f.transport, quick);
    const r = await cap.observe(42); if (!r.ok) throw new Error("setup");
    expect(await cap.confirmFresh(r.frame)).toMatchObject({ ok: false, reason: expect.stringMatching(/minimized/) });
  });

  it("an older frame is stale once a newer one exists, and after release nothing is fresh", async () => {
    const f = fake([frame(5), frame(6)]);
    const cap = new VisualCapture(f.transport, quick);
    const a = await cap.observe(42); const b = await cap.observe(42);
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(cap.isFresh(a.frame)).toBe(false);
    expect(cap.isFresh(b.frame)).toBe(true);
    await cap.release();
    expect(cap.isFresh(b.frame)).toBe(false);
  });
});

describe("window capture: privacy (no image data anywhere)", () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

  it("the TypeScript side never touches the disk or the network, and has no field that could hold pixels", () => {
    const code = src("capture.ts");
    expect(code).not.toMatch(/from "node:|require\(|\bfs\b|fetch\(|XMLHttpRequest|WebSocket|Buffer|Uint8Array|ImageData|toDataURL|base64/);
    expect(code).not.toMatch(/console\.(log|info|warn|error)/);
  });

  it("the helper's capture code keeps pixels in one in-memory bitmap: it writes no file, encodes nothing and sends nothing out", () => {
    expect(CAPTURE_SOURCE).not.toMatch(/System\.IO|File\.|WriteAll|\.Save\(|FileStream|Bitmap\b|(?<![A-Za-z])Image\b|Convert\.ToBase64|Console\.|Socket|WebClient|HttpClient|Clipboard/);
    // Pixels are copied out of the bitmap in ONE place (the temporary copy that detection works on, handed to the caller and dropped at once),
    // and nothing is ever encoded or serialised from them.
    expect([...CAPTURE_SOURCE.matchAll(/Marshal\.Copy/g)].length).toBe(1);
    expect(CAPTURE_SOURCE).toMatch(/public static byte\[\] Frame\([^]*?Marshal\.Copy/);
    expect(CAPTURE_SOURCE).not.toMatch(/ToArray\(|ToBase64|Convert\./);
  });

  it("every reply field is a number, a flag or a fixed state word", async () => {
    const f = fake([frame(1)]);
    const r = await new VisualCapture(f.transport, quick).observe(42);
    if (!r.ok) throw new Error("setup");
    // every value, however deeply nested, is a number or a flag: a string (and so any content) cannot ride along in a frame
    const leaves = (o: unknown): unknown[] => (o !== null && typeof o === "object" ? Object.values(o as object).flatMap(leaves) : [o]);
    const all = leaves(r.frame);
    expect(all.length).toBeGreaterThan(10);
    for (const v of all) expect(["number", "boolean"]).toContain(typeof v);
  });

  it("the helper script includes the capture code, compiled lazily (not on start-up)", () => {
    expect(HELPER_SCRIPT).toContain("function Load-Capture");
    expect(HELPER_SCRIPT).toContain("capstart");
    expect(CAPTURE_PS).toContain("Add-Type");
    // the loader is only called from the capture commands
    const loads = [...HELPER_SCRIPT.matchAll(/Load-Capture/g)].length;
    expect(loads).toBe(5); // the definition, detection's own call, and the capstart / capgrab / capselftest commands
  });
});

describe("window capture: the task end releases it", () => {
  it("a Session releases the capture when a task ends, is cancelled, or is disposed", async () => {
    const f = fake([frame(1)]);
    const session = new Session({
      fs: { homeDir: () => "C:\\", listDriveRoots: async () => [], statfs: async () => null, readDirs: async () => [], stat: async () => null } as never,
      win: { query: async () => ({ activePid: null, windows: [] }) },
      emit: () => {}, capture: f.transport,
    } as never);
    await session.visualCapture.observe(42);
    expect(session.visualCapture.active()).toBe(true);
    session.orchestrator.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(session.visualCapture.active()).toBe(false);
    expect(f.calls.filter((c) => c === "capstop").length).toBe(1);
    await session.visualCapture.observe(42);
    session.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(session.visualCapture.active()).toBe(false);
  });
});

describe("window capture: the REAL helper", () => {
  // The C# is only compiled by Windows PowerShell on the first capture request: a typo would silently turn capture off.
  it.runIf(process.platform === "win32")("compiles, refuses a window that does not exist, and holds nothing", async () => {
    const h = new UiaHost();
    try {
      expect(await h.request("capinfo", 30_000)).toMatchObject({ ok: true, active: false });            // before any capture: nothing compiled, nothing held
      expect(await h.request("capstart 1", 60_000)).toMatchObject({ ok: false, state: "gone" });          // first capture request compiles the class
      expect(await h.request("capgrab", 10_000)).toMatchObject({ ok: false, state: "no_session" });
      expect(await h.request("capinfo", 10_000)).toMatchObject({ ok: true, active: false });
      expect(await h.request("capstop", 10_000)).toMatchObject({ ok: true, was: false });
      expect(h.stats().failures).toBe(0);
    } finally { h.stop(); }
  }, 90_000);

  // Phase 6b: the shape finder runs in the same compiled class. A made-up picture with known rectangles needs no window and no screen.
  it.runIf(process.platform === "win32")("the shape finder finds the known rectangles of a made-up picture, and only those", async () => {
    const h = new UiaHost();
    try {
      const r = await h.request<{ ok: boolean; shapes: number[][] }>("capselftest", 60_000);
      expect(r.ok).toBe(true);
      const has = (l: number, t: number, w: number, hh: number) => r.shapes.some((s) => Math.abs(s[0] - l) <= 2 && Math.abs(s[1] - t) <= 2 && Math.abs(s[2] - w) <= 4 && Math.abs(s[3] - hh) <= 4);
      expect(has(40, 60, 130, 50)).toBe(true);   // the blue button, with its label drawn over it
      expect(has(200, 60, 60, 50)).toBe(true);   // the green icon-only button
      expect(has(220, 190, 150, 100)).toBe(true); // the panel
      expect(has(40, 220, 130, 50)).toBe(true);   // a button filled with a GRADIENT
      expect(has(202, 127, 136, 40)).toBe(true);  // an OUTLINED button (the inside of its border)
      expect(r.shapes.some((s) => Math.abs(s[0] - 40) <= 2 && Math.abs(s[1] - 160) <= 2)).toBe(false); // the almost-background rectangle is NOT an object
      expect(r.shapes.length).toBe(5);
      expect(await h.request("capdetect 1 1", 30_000)).toMatchObject({ ok: false, state: "stale" }); // no capture session: nothing to detect on
      expect(h.stats().failures).toBe(0);
    } finally { h.stop(); }
  }, 90_000);
});
