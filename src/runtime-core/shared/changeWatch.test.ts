import { describe, expect, it } from "vitest";
import { waitFor, relevantTo, type ChangeEvent, type ChangeSource } from "./changeWatch";

/** A scripted change source: tests push events on purpose, drop them on purpose, and turn its health on and off. */
class FakeSource implements ChangeSource {
  s = 0; ok = true; held = 0; released = 0;
  log: Array<{ seq: number; events: ChangeEvent[] }> = [];
  waiters: Array<() => void> = [];
  healthy() { return this.ok; }
  seq() { return this.s; }
  push(...events: ChangeEvent[]) { this.s++; this.log.push({ seq: this.s, events }); for (const w of this.waiters.splice(0)) w(); }
  next(since: number, ms: number) {
    const grab = () => ({ seq: this.s, events: this.log.filter((b) => b.seq > since).flatMap((b) => b.events) });
    if (this.s > since || ms <= 0) return Promise.resolve(grab());
    return new Promise<{ seq: number; events: ChangeEvent[] }>((res) => { const t = setTimeout(() => res(grab()), ms); this.waiters.push(() => { clearTimeout(t); res(grab()); }); });
  }
  acquire() { this.held++; return () => { this.released++; }; }
}
const ev = (kind: string, root = 1): ChangeEvent => ({ kind, root });

describe("waiting for a change", () => {
  it("returns at once when the first look already finds it, without waiting", async () => {
    const r = await waitFor(async () => "here", { timeoutMs: 5000, sleep: async () => { throw new Error("must not sleep"); } });
    expect(r).toMatchObject({ value: "here", timedOut: false, via: "immediate", looks: 1 });
  });

  it("an event wakes the wait right away: it does not sit out the poll interval", async () => {
    const src = new FakeSource();
    let ready = false;
    setTimeout(() => { ready = true; src.push(ev("show")); }, 60);
    const t0 = Date.now();
    const r = await waitFor(async () => ready, { timeoutMs: 3000, source: src, fallbackMs: 2000, sleep: async () => {} });
    expect(r.value).toBe(true);
    expect(r.via).toBe("event");
    expect(Date.now() - t0).toBeLessThan(600); // far less than the 2 s fallback
  });

  it("a LOST event is not fatal: the slower fallback look still finds the change", async () => {
    const src = new FakeSource(); // healthy, but the event for this change never arrives
    let ready = false;
    setTimeout(() => { ready = true; /* no push */ }, 40);
    const r = await waitFor(async () => ready, { timeoutMs: 3000, source: src, fallbackMs: 150, sleep: async () => {} });
    expect(r.value).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it("without healthy events it polls, and still finds the change", async () => {
    const src = new FakeSource(); src.ok = false;
    let n = 0;
    const r = await waitFor(async () => ++n >= 4, { timeoutMs: 5000, source: src, pollMs: 100, sleep: async () => {} });
    expect(r.value).toBe(true);
    expect(r.via).toBe("poll");
    expect(r.looks).toBe(4);
  });

  it("works with no source at all (polling only)", async () => {
    let n = 0;
    const r = await waitFor(async () => ++n >= 3, { timeoutMs: 5000, pollMs: 50, sleep: async () => {} });
    expect(r.value).toBe(true);
  });

  it("times out, and says so: the budget counts requested waits, so an instant fake sleep cannot spin forever", async () => {
    let looks = 0;
    const r = await waitFor(async () => { looks++; return false; }, { timeoutMs: 1000, pollMs: 200, sleep: async () => {} });
    expect(r).toMatchObject({ timedOut: true, cancelled: false });
    expect(r.value).toBeUndefined();
    expect(looks).toBeGreaterThanOrEqual(5);
    expect(looks).toBeLessThanOrEqual(7);
  });

  it("a healthy source that stays quiet also times out", async () => {
    const src = new FakeSource();
    const r = await waitFor(async () => false, { timeoutMs: 300, source: src, fallbackMs: 100, sleep: async () => {} });
    expect(r.timedOut).toBe(true);
    expect(r.looks).toBeGreaterThan(1);
  });

  it("an event from an unrelated window does not make it look again", async () => {
    const src = new FakeSource();
    let looks = 0;
    const p = waitFor(async () => { looks++; return false; }, { timeoutMs: 400, source: src, fallbackMs: 400, relevant: relevantTo(7), sleep: async () => {} });
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 30)); src.push(ev("name", 999)); } // a chatty background app
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(looks).toBeLessThanOrEqual(3);
  });

  it("window-wide events count from any window; a name change counts only from the watched one", () => {
    const rel = relevantTo(7);
    expect(rel(ev("fg", 1))).toBe(true);
    expect(rel(ev("menu", 1))).toBe(true);
    expect(rel(ev("show", 1))).toBe(true);
    expect(rel(ev("name", 7))).toBe(true);
    expect(rel(ev("name", 8))).toBe(false);
    expect(rel(ev("create", 8))).toBe(false);
  });

  it("a change that lands WHILE a look is running is looked at again at once (no missed wake-up)", async () => {
    const src = new FakeSource();
    let state = 0, looks = 0;
    const r = await waitFor(async () => {
      looks++;
      const seen = state;
      if (looks === 1) { state = 1; src.push(ev("show")); } // the change and its event arrive during the first look
      return seen === 1;
    }, { timeoutMs: 3000, source: src, fallbackMs: 2500, sleep: async () => {} });
    expect(r.value).toBe(true);
    expect(r.ms).toBeLessThan(500);
  });

  it("stops at once when the task is cancelled, and gives the source back", async () => {
    const src = new FakeSource();
    let live = true;
    setTimeout(() => { live = false; src.push(ev("fg")); }, 40);
    const r = await waitFor(async () => false, { timeoutMs: 5000, source: src, live: () => live, sleep: async () => {} });
    expect(r.cancelled).toBe(true);
    expect(src.held).toBe(1);
    expect(src.released).toBe(1);
  });

  it("gives the source back even when the look throws", async () => {
    const src = new FakeSource();
    await expect(waitFor(async () => { throw new Error("boom"); }, { timeoutMs: 1000, source: src })).rejects.toThrow("boom");
    expect(src.released).toBe(1);
  });
});
