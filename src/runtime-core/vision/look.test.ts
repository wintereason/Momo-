import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualCapture } from "./capture";
import { VisualLook } from "./look";
import type { CaptureTransport } from "../shared/ports";

const grab = (n: number) => ({ ok: true, state: "ready", ready: true, session: 1, frame: n, w: 1640, h: 1280, l: 600, t: 240, pw: 1640, ph: 1280, scale: 1, dpi: 192, mdpi: 192, ms: 30 });
const notReady = (n: number) => ({ ok: true, state: "not_ready", ready: false, session: 1, frame: n });
const detection = (over: Record<string, unknown> = {}) => ({ ok: true, session: 1, frame: 2, w: 1640, h: 1280, shapes: [[80, 140, 260, 100, 92, 236]], crops: [[0, "SAVE", "SAVE"]], words: [["SAVE", 150, 170, 90, 30]], msCopy: 5, msShapes: 22, msCrops: 90, msOcr: 140, ...over });

function fake(o: { grabs?: unknown[]; detects?: unknown[]; info?: unknown } = {}) {
  const calls: string[] = [];
  let g = 0, d = 0;
  const grabs = o.grabs ?? [notReady(1), grab(2)];
  const detects = o.detects ?? [detection()];
  const transport: CaptureTransport = {
    async send(cmd, args) {
      calls.push(args === undefined ? cmd : `${cmd} ${([] as number[]).concat(args).join(" ")}`);
      if (cmd === "capstart") return { ok: true, session: 1, bytes: 1 };
      if (cmd === "capgrab") { const r = grabs[Math.min(g++, grabs.length - 1)]; if (r instanceof Error) throw r; return r; }
      if (cmd === "capdetect") { const r = detects[Math.min(d++, detects.length - 1)]; if (r instanceof Error) throw r; return r; }
      if (cmd === "capinfo") return o.info ?? { ok: true, active: true, session: 1, frame: 2, ageMs: 5, sameRect: true, refusal: null };
      return { ok: true, was: true };
    },
  };
  return { transport, calls };
}
const mkLook = (f: ReturnType<typeof fake>, over: { now?: () => number; maxAgeMs?: number } = {}) => {
  const capture = new VisualCapture(f.transport, { sleep: async () => {}, now: over.now, maxAgeMs: over.maxAgeMs });
  return { capture, look: new VisualLook(capture, f.transport, { now: over.now, maxAgeMs: over.maxAgeMs }) };
};

describe("a visual look", () => {
  it("settles the window, detects on THAT frame (session + frame number), and returns scored candidates with stage timings", async () => {
    const f = fake();
    const { look } = mkLook(f);
    const r = await look.look(42);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(f.calls).toEqual(["capstart 42", "capgrab", "capgrab", "capdetect 1 2"]);
    expect(r.candidates[0]).toMatchObject({ kind: "button_like", text: "SAVE", usable: true, frame: 2, session: 1, hwnd: 42, rect: { l: 680, t: 380, w: 260, h: 100 } });
    expect(r.stages).toMatchObject({ copyMs: 5, shapesMs: 22, cropsMs: 90, ocrMs: 140, captureMs: 30 });
  });

  it("a window that is blank, minimized or capture-excluded is refused with the capture's reason: no detection is even attempted", async () => {
    for (const state of ["blank", "minimized", "excluded"]) {
      const f = fake({ grabs: [{ ok: false, state }] });
      const { look } = mkLook(f);
      const r = await look.look(42);
      expect(r).toMatchObject({ ok: false, state });
      expect(f.calls.some((c) => c.startsWith("capdetect"))).toBe(false);
    }
  });

  it("when another frame replaced the one being read, it looks again instead of trusting the result", async () => {
    const f = fake({ grabs: [grab(2), grab(3)], detects: [{ ok: false, state: "stale" }, detection({ frame: 3 })] });
    const { look } = mkLook(f);
    expect(await look.look(42)).toMatchObject({ ok: true });
    expect(f.calls.filter((c) => c.startsWith("capdetect")).length).toBe(2);
  });

  it("when it keeps going stale it gives up with a plain reason (never a half result)", async () => {
    const f = fake({ detects: [{ ok: false, state: "stale" }] });
    const { look } = mkLook(f);
    expect(await look.look(42)).toMatchObject({ ok: false, state: "stale" });
  });

  it("an answer that is wrong in any field is refused whole", async () => {
    for (const bad of [null, { ok: true }, detection({ w: 5 }), detection({ shapes: [[1, 2]] }), detection({ words: "x" })]) {
      const { look } = mkLook(fake({ detects: [bad] }));
      expect(await look.look(42), JSON.stringify(bad)).toMatchObject({ ok: false, state: "unreadable" });
    }
  });

  it("no text-recognition language on this PC is said plainly", async () => {
    const { look } = mkLook(fake({ detects: [{ ok: false, state: "no_ocr" }] }));
    expect(await look.look(42)).toMatchObject({ ok: false, state: "no_ocr", reason: expect.stringMatching(/no text-recognition language/) });
  });

  it("a detection that throws is 'unavailable', not an empty window", async () => {
    const { look } = mkLook(fake({ detects: [new Error("helper timeout")] }));
    expect(await look.look(42)).toMatchObject({ ok: false, state: "unavailable" });
  });

  it("a cancelled task stops the look and frees the capture", async () => {
    const f = fake();
    const { look, capture } = mkLook(f);
    let live = true;
    const t = { ...f.transport, send: async (c: Parameters<CaptureTransport["send"]>[0], a: number | number[] | undefined, ms: number) => { const r = await f.transport.send(c, a, ms); if (c === "capdetect") live = false; return r; } };
    const capture2 = new VisualCapture(t, { sleep: async () => {} });
    const look2 = new VisualLook(capture2, t);
    expect(await look2.look(42, () => live)).toMatchObject({ ok: false, state: "cancelled" });
    expect(capture2.active()).toBe(false);
    void look; void capture;
  });
});

describe("how long a look's candidates are held", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a candidate can be fetched while the look is fresh, and is GONE (with its text) once it is not", async () => {
    let now = 1000;
    const f = fake();
    const { look } = mkLook(f, { now: () => now, maxAgeMs: 1500 });
    const r = await look.look(42);
    if (!r.ok) throw new Error("setup");
    const id = r.candidates[0].id;
    expect(look.candidate(id)).toMatchObject({ ok: true, candidate: { text: "SAVE" } });
    expect(look.stats().holding).toBe(true);
    now += 1600;
    expect(look.candidate(id)).toMatchObject({ ok: false, reason: expect.stringMatching(/out of date/) });
    expect(look.stats().holding).toBe(false);
  });

  it("the held text is wiped by the timer even when nobody asks", async () => {
    const f = fake();
    const { look } = mkLook(f, { maxAgeMs: 1500 });
    await look.look(42);
    expect(look.stats().holding).toBe(true);
    await vi.advanceTimersByTimeAsync(1700);
    expect(look.stats().holding).toBe(false);
  });

  it("releasing the capture (task end, cancel, idle, another window) wipes it at once", async () => {
    const f = fake();
    const { look, capture } = mkLook(f);
    await look.look(42);
    expect(look.stats().holding).toBe(true);
    await capture.release();
    expect(look.stats().holding).toBe(false);
  });

  it("confirmCandidate asks the helper too: a window that moved, was minimized or lost its frame makes every candidate stale at once", async () => {
    for (const [info, rx] of [
      [{ ok: true, active: true, session: 1, frame: 2, ageMs: 5, sameRect: false, refusal: null }, /moved or changed size/],
      [{ ok: true, active: true, session: 1, frame: 2, ageMs: 5, sameRect: true, refusal: "minimized" }, /minimized/],
      [{ ok: true, active: true, session: 1, frame: 3, ageMs: 5, sameRect: true, refusal: null }, /out of date/],
      [{ ok: true, active: false }, /out of date/],
    ] as const) {
      const { look } = mkLook(fake({ info }));
      const r = await look.look(42);
      if (!r.ok) throw new Error("setup");
      expect(await look.confirmCandidate(r.candidates[0].id), JSON.stringify(info)).toMatchObject({ ok: false, reason: expect.stringMatching(rx) });
      expect(look.stats().holding).toBe(false); // and the text is gone
    }
    const { look } = mkLook(fake());
    const r = await look.look(42);
    if (!r.ok) throw new Error("setup");
    expect(await look.confirmCandidate(r.candidates[0].id)).toMatchObject({ ok: true, candidate: { text: "SAVE" } });
  });

  it("an unknown candidate id is refused", async () => {
    const { look } = mkLook(fake());
    await look.look(42);
    expect(look.candidate("v9.9")).toMatchObject({ ok: false });
  });

  it("the counters hold no text and no window name", async () => {
    const { look } = mkLook(fake());
    await look.look(42);
    expect(JSON.stringify(look.stats())).not.toMatch(/SAVE|42/);
    expect(look.stats()).toMatchObject({ looks: 1, refused: 0 });
  });
});
