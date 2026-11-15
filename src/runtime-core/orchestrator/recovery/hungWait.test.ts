import { describe, expect, it } from "vitest";
import { Verifier } from "../../verifier";
import { HUNG_WAIT_MS, waitResponsive } from "./hung";
import type { ReadOnlyView } from "./verifyOnly";
import type { WindowState } from "../../shared/ports";

function view(states: Array<WindowState | Error>, over: Partial<ReadOnlyView> = {}) {
  const log = { reads: 0, slept: 0 };
  const v: ReadOnlyView = {
    live: () => true, interrupted: () => false,
    sleep: async (ms) => { log.slept += ms; },
    windowState: async () => { const s = states[Math.min(log.reads++, states.length - 1)]; if (s instanceof Error) throw s; return s; },
    windows: async () => ({ windows: [] }) as never, readWindow: async () => ({ ok: true, items: [], truncated: false }), verifier: new Verifier(),
    ...over,
  };
  return { v, log };
}
const hung: WindowState = { exists: true, minimized: false, pid: 1, foregroundPid: 1, hung: true };
const ok: WindowState = { ...hung, hung: false };
const gone: WindowState = { exists: false, minimized: false, pid: 0, foregroundPid: null };

describe("waiting for a frozen window (read-only, bounded)", () => {
  it("returns 'responsive' as soon as Windows stops calling it hung", async () => {
    const { v, log } = view([hung, hung, ok]);
    expect(await waitResponsive(v, 5)).toBe("responsive");
    expect(log.reads).toBe(3);
  });
  it("gives up at the limit with 'still_hung': never waits longer than asked", async () => {
    const { v, log } = view([hung]);
    expect(await waitResponsive(v, 5, 1000, 250)).toBe("still_hung");
    expect(log.slept).toBeLessThanOrEqual(1000);
    expect(log.reads).toBeLessThanOrEqual(6);
  });
  it("the default limit is a few seconds, not minutes", () => { expect(HUNG_WAIT_MS).toBeLessThanOrEqual(5000); });
  it("a window that disappears is 'gone'", async () => {
    expect(await waitResponsive(view([hung, gone]).v, 5)).toBe("gone");
  });
  it("a state read that fails once does not end the wait early", async () => {
    expect(await waitResponsive(view([hung, new Error("helper died"), ok]).v, 5)).toBe("responsive");
  });
  it("cancel or takeover ends it at once, before and between reads", async () => {
    const a = view([hung], { live: () => false });
    expect(await waitResponsive(a.v, 5)).toBe("cancelled");
    expect(a.log.reads).toBe(0);
    let taken = false;
    const b = view([hung], { interrupted: () => taken, windowState: async () => { taken = true; return hung; } });
    expect(await waitResponsive(b.v, 5)).toBe("cancelled");
  });
  it("it only ever reads and sleeps (the view has nothing else)", () => {
    expect(Object.keys(view([ok]).v).sort()).toEqual(["interrupted", "live", "readWindow", "sleep", "verifier", "windowState", "windows"]);
  });
});
