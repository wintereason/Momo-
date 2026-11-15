import { describe, expect, it, vi } from "vitest";
import { Verifier } from "../../verifier";
import { verifyOnly, type ReadOnlyView, type Confirmation } from "./verifyOnly";
import type { WindowState } from "../../shared/ports";

const healthy: WindowState = { exists: true, minimized: false, pid: 5, foregroundPid: 5, hung: false };
function view(over: Partial<ReadOnlyView> = {}, state: WindowState = healthy) {
  const calls: string[] = [];
  const v: ReadOnlyView = {
    live: () => true, interrupted: () => false, sleep: async () => {},
    windowState: async () => { calls.push("state"); return state; },
    windows: async () => { calls.push("windows"); return { windows: [1, 2, 3].map((n) => ({ hwnd: n })) } as never; },
    readWindow: async () => { calls.push("read"); return { ok: true, items: [], truncated: false }; },
    verifier: new Verifier(),
    ...over,
  };
  return { v, calls };
}
const yes: Confirmation = { verified: true, evidence: [{ kind: "window_state", ok: true }] };

describe("verify-only recovery looks, and only looks", () => {
  it("the view it is given has nothing that can act: only reading calls", () => {
    const { v } = view();
    expect(Object.keys(v).sort()).toEqual(["interrupted", "live", "readWindow", "sleep", "verifier", "windowState", "windows"]);
  });
  it("it asks Windows about the window the step acted on, and records yes/no facts only", async () => {
    const { v, calls } = view();
    const r = await verifyOnly({ target: { hwnd: 7, pid: 5 }, view: v });
    expect(calls).toContain("state");
    expect(r.observed).toBe(true);
    expect(r.facts).toMatchObject({ windowExists: true, windowHung: false, windowMinimized: false });
    expect(r.evidence).toEqual(expect.arrayContaining([{ kind: "window_exists", ok: true }, { kind: "window_hung", ok: false }]));
  });
  it("without a probe for that kind of step it can only list the desktop: that is NOT evidence, and the verdict stays 'unconfirmed'", async () => {
    const { v } = view();
    const r = await verifyOnly({ view: v });
    expect(r.verdict).toBe("unconfirmed");
    expect(r.evidence).toEqual(expect.arrayContaining([{ kind: "windows_listed", ok: null, n: 3 }, { kind: "no_probe", ok: null }]));
  });
});

describe("only real evidence makes it verified", () => {
  it("a check that says true WITH positive evidence is verified", async () => {
    const r = await verifyOnly({ view: view().v, target: { hwnd: 7, pid: 5 }, confirm: async () => yes });
    expect(r.verdict).toBe("verified");
  });
  it("a bare claim of success (no positive evidence behind it) is not enough", async () => {
    for (const c of [{ verified: true, evidence: [] }, { verified: true, evidence: [{ kind: "window_state", ok: null }] }, { verified: true, evidence: [{ kind: "window_state", ok: false }] }] as Confirmation[]) {
      const r = await verifyOnly({ view: view().v, target: { hwnd: 7, pid: 5 }, confirm: async () => c });
      expect(r.verdict).toBe("unconfirmed");
    }
  });
  it("'cannot tell' stays unconfirmed", async () => {
    const r = await verifyOnly({ view: view().v, confirm: async () => ({ verified: null, evidence: [] }) });
    expect(r.verdict).toBe("unconfirmed");
  });
  it("a check that finds the effect really absent says so ('absent'), but only with a negative fact behind it", async () => {
    expect((await verifyOnly({ view: view().v, confirm: async () => ({ verified: false, evidence: [{ kind: "window_state", ok: false }] }) })).verdict).toBe("absent");
    expect((await verifyOnly({ view: view().v, confirm: async () => ({ verified: false, evidence: [] }) })).verdict).toBe("unconfirmed");
  });
  it("a check that throws is unconfirmed, with the failure recorded as a fact", async () => {
    const r = await verifyOnly({ view: view().v, confirm: async () => { throw new Error("boom"); } });
    expect(r.verdict).toBe("unconfirmed");
    expect(r.evidence).toContainEqual({ kind: "observation_failed", ok: null });
  });
  it("a window state that cannot be read does not break it", async () => {
    const { v } = view({ windowState: async () => { throw new Error("helper died"); } });
    const r = await verifyOnly({ target: { hwnd: 7, pid: 5 }, view: v });
    expect(r.verdict).toBe("unconfirmed");
    expect(r.evidence).toContainEqual({ kind: "observation_failed", ok: null });
  });
});

describe("a frozen window is not asked anything", () => {
  it("the content check is skipped (and not waited on) when Windows says the window is hung", async () => {
    const confirm = vi.fn(async () => yes);
    const { v } = view({}, { ...healthy, hung: true });
    const r = await verifyOnly({ target: { hwnd: 7, pid: 5 }, confirm, view: v });
    expect(confirm).not.toHaveBeenCalled();
    expect(r.verdict).toBe("unconfirmed");
    expect(r.facts.windowHung).toBe(true);
    expect(r.evidence).toContainEqual({ kind: "observation_skipped", ok: null });
  });
});

describe("cancellation and takeover stop it at once", () => {
  it("already cancelled: not a single look is made", async () => {
    const confirm = vi.fn(async () => yes);
    const { v, calls } = view({ live: () => false });
    const r = await verifyOnly({ target: { hwnd: 7, pid: 5 }, confirm, view: v });
    expect(calls).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(r).toMatchObject({ cancelled: true, observed: false, verdict: "unconfirmed" });
  });
  it("the user already has the mouse: nothing is looked at", async () => {
    const { v, calls } = view({ interrupted: () => true });
    const r = await verifyOnly({ target: { hwnd: 7, pid: 5 }, view: v });
    expect(calls).toEqual([]);
    expect(r.cancelled).toBe(true);
  });
  it("cancelled after the first look: the tool's own check is never started", async () => {
    let live = true;
    const confirm = vi.fn(async () => yes);
    const { v, calls } = view({ live: () => live, windowState: async () => { live = false; return healthy; } });
    const r = await verifyOnly({ target: { hwnd: 7, pid: 5 }, confirm, view: v });
    expect(confirm).not.toHaveBeenCalled();
    expect(r.cancelled).toBe(true);
    expect(r.verdict).toBe("unconfirmed");
    expect(calls).toEqual([]); // (the state read itself was the one that cancelled)
  });
  it("cancelled during the tool's check: even a 'verified' answer is thrown away", async () => {
    let live = true;
    const r = await verifyOnly({ view: view({ live: () => live }).v, confirm: async () => { live = false; return yes; } });
    expect(r.cancelled).toBe(true);
    expect(r.verdict).toBe("unconfirmed");
  });
  it("takeover during the check is the same", async () => {
    let taken = false;
    const r = await verifyOnly({ view: view({ interrupted: () => taken }).v, confirm: async () => { taken = true; return yes; } });
    expect(r.cancelled).toBe(true);
    expect(r.verdict).toBe("unconfirmed");
  });
  it("a view whose live() throws counts as stopped", async () => {
    const r = await verifyOnly({ view: view({ live: () => { throw new Error("x"); } }).v });
    expect(r.cancelled).toBe(true);
  });
});
