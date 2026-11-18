import { describe, expect, it } from "vitest";
import { Session } from "./session";
import type { PlanDecision, PlanStep } from "./ai/prompts";
import type { AiService } from "./ai/service";
import type { RuntimeEvent } from "../../types/runtime-events";
import type { ActResult, FsPort, InputPort, LaunchPort, PlacementResult, PointerPort, PointerResult, PxRect, RawWindow, ScreenPort, WindowState } from "../shared/ports";
import { RESTORE_TOLERANCE_PX } from "./tools";

/**
 * arrange_window "restore" (the A07 defect). Windows keeps, for every window, the NORMAL rectangle a snapped or maximized window returns to. The old tool pressed Win+Down and
 * called any changed rectangle "restored": on a half-snapped window Win+Down gives a QUARTER of the screen, and the tool still said "restored to its normal size". Now the tool
 * puts the window back at the recorded normal placement and says "restored" only when the window is really at that rectangle. The numbers below are the real ones from the
 * A07 run on a 2880x1800 screen with the taskbar on the left.
 */

const NORMAL: PxRect = { l: 1028, t: 340, w: 920, h: 1120 };        // where the window started, and what Windows recorded as its normal rectangle
const HALF: PxRect = { l: 1477, t: 0, w: 1414, h: 1811 };          // after "snap right"
const QUARTER: PxRect = { l: 1477, t: 900, w: 1414, h: 911 };      // after Win+Down on the half-snapped window: a changed rectangle that is NOT a restore
interface Pl { showCmd: number; normal: PxRect; current: PxRect }

const explorer: RawWindow = { hwnd: 20, pid: 20, process: "explorer", title: "Documents - File Explorer", z: 0 };

function world(o: {
  start?: Pl;
  /** what the window looks like after Windows accepts the restore request */
  afterRestore?: (s: Pl) => Pl;
  /** the READ of the placement fails with this reason */
  readFails?: string;
  /** the restore request itself fails with this reason */
  restoreFails?: string;
  /** an older build: the port has no placement methods at all */
  noPlacementPort?: boolean;
  /** the key path's rectangle (older build only) */
  keyRect?: () => PxRect;
}) {
  const calls: string[] = [];
  let state: Pl = o.start ?? { showCmd: 1, normal: NORMAL, current: QUARTER };
  let placementReads = 0;
  const input: InputPort = {
    focusWindow: async (): Promise<ActResult> => ({ ok: true }), minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async (): Promise<WindowState> => ({ exists: true, minimized: false, pid: 20, foregroundPid: 20 }),
    invokeControl: async (): Promise<ActResult> => ({ ok: true }), setControlText: async () => ({ ok: true, readBack: "" }),
    ...(o.noPlacementPort ? {} : {
      windowPlacement: async (): Promise<PlacementResult> => {
        placementReads++; calls.push("windowPlacement");
        return o.readFails ? { ok: false, reason: o.readFails } : { ok: true, showCmd: state.showCmd, normal: { ...state.normal }, current: { ...state.current } };
      },
      restoreWindowPlacement: async (): Promise<ActResult> => {
        calls.push("restoreWindowPlacement");
        if (o.restoreFails) return { ok: false, reason: o.restoreFails };
        if (o.afterRestore) state = o.afterRestore(state);
        return { ok: true };
      },
    }),
  };
  const screen: ScreenPort = {
    readUi: async () => ({ ok: true, items: [], truncated: false }),
    ocr: async () => ({ ok: true, lines: ["x"] }),
    ocrWords: async () => ({ ok: true, words: [] }),
  };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  let keyRect: PxRect = { l: 0, t: 0, w: 1000, h: 800 };
  const pointer = {
    click: async () => ({ ok: true }),
    press: async (k: string) => { calls.push(`press:${k}`); if (o.keyRect) keyRect = o.keyRect(); return { ok: true } as PointerResult; },
    type: async () => ({ ok: true }), windowAt: () => 20, windowRect: () => ({ ...keyRect }),
  } as unknown as PointerPort;
  return {
    calls, placementReads: () => placementReads, state: () => state,
    deps: {
      fs, input, screen, launch, act: { openPath: async () => "" }, apps: { list: async () => [] },
      win: { query: async () => ({ processes: undefined, activePid: 20, activeHwnd: 20, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 } as RawWindow, explorer] }) },
      pointer: () => pointer,
    },
  };
}

function run(w: ReturnType<typeof world>, script: PlanDecision[]) {
  const events: RuntimeEvent[] = [];
  const results: PlanStep[][] = [];
  let i = 0;
  const ai: AiService = {
    ready: () => true, label: () => "TestAI", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_g, steps) { results.push(JSON.parse(JSON.stringify(steps))); return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "TestAI" }; },
  };
  const session = new Session({ ...(w.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, verifyAttempts: 2, cursorLeadMs: () => 0 } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  return { session, events, results };
}
const restore: PlanDecision = { type: "tool", tool: "arrange_window", args: { to: "restore", window: "Documents" } };
const done: PlanDecision = { type: "done", answer: "ok" };
const lastTool = (r: PlanStep[][]) => { const s = r[r.length - 1]; const t = s[s.length - 1]; return t.kind === "tool" ? t : null; };
async function go(w: ReturnType<typeof world>) { const t = run(w, [restore, done]); await t.session.handleTranscript("s", "restore it"); return lastTool(t.results)!; }
const restoredTo = (r: PxRect) => (s: Pl): Pl => ({ ...s, showCmd: 1, current: { ...r } });
const pressed = (w: ReturnType<typeof world>) => w.calls.filter((c) => c.startsWith("press:"));

describe("arrange_window restore: genuine restoration", () => {
  it("puts a quarter-snapped window back at the normal rectangle Windows recorded, with no key pressed, and verifies it against that rectangle", async () => {
    const w = world({ start: { showCmd: 1, normal: NORMAL, current: QUARTER }, afterRestore: restoredTo(NORMAL) });
    const r = await go(w);
    expect(r.outcome).toBe("ok");
    expect(r.text).toMatch(/was restored to its normal size and position \(920×1120 at 1028,340\)/);
    expect(r.text).toMatch(/checked against where it is now/);
    expect(w.calls.filter((c) => c === "restoreWindowPlacement")).toHaveLength(1);
    expect(pressed(w)).toEqual([]);                                   // Win+Down is never pressed: it quarter-snaps a half-snapped window and minimizes a normal one
    expect(w.placementReads()).toBeGreaterThanOrEqual(2);              // read before AND after: read-only
  });

  it("restores a maximized window the same way", async () => {
    const w = world({ start: { showCmd: 3, normal: NORMAL, current: { l: 96, t: 0, w: 2784, h: 1800 } }, afterRestore: restoredTo(NORMAL) });
    const r = await go(w);
    expect(r.outcome).toBe("ok");
    expect(r.text).toMatch(/was restored to its normal size and position/);
  });

  it("a window that is already at its normal place is not touched, and that is reported as a verified fact", async () => {
    const w = world({ start: { showCmd: 1, normal: NORMAL, current: { ...NORMAL } } });
    const r = await go(w);
    expect(r.outcome).toBe("ok");
    expect(r.text).toMatch(/already at its normal size and position/);
    expect(w.calls).not.toContain("restoreWindowPlacement");
    expect(pressed(w)).toEqual([]);
  });

  it(`the tolerance is ${RESTORE_TOLERANCE_PX} px on each of left, top, width and height: inside it is restored, one pixel beyond it is NOT`, async () => {
    const t = RESTORE_TOLERANCE_PX;
    const inside = await go(world({ afterRestore: restoredTo({ l: NORMAL.l + t, t: NORMAL.t - t, w: NORMAL.w + t, h: NORMAL.h - t }) }));
    expect(inside.outcome).toBe("ok");
    for (const off of [{ l: t + 1 }, { t: -(t + 1) }, { w: t + 1 }, { h: -(t + 1) }]) {
      const r = await go(world({ afterRestore: restoredTo({ l: NORMAL.l + (off.l ?? 0), t: NORMAL.t + (off.t ?? 0), w: NORMAL.w + (off.w ?? 0), h: NORMAL.h + (off.h ?? 0) }) }));
      expect(r.outcome).toBe("unverified");
      expect(r.text).toMatch(/cannot say it was restored/);
    }
  });
});

describe("arrange_window restore: never claims success while the window is not at its normal place", () => {
  it("QUARTER-SNAP: Windows accepts the request but the window stays a quarter of the screen: NOT restored, and the answer says where it is", async () => {
    const w = world({ start: { showCmd: 1, normal: NORMAL, current: QUARTER }, afterRestore: (s) => s });
    const r = await go(w);
    expect(r.outcome).toBe("unverified");
    expect(r.text).toMatch(/cannot say it was restored/);
    expect(r.text).toMatch(/1414×911 at 1477,900/);                  // where it really is
    expect(r.text).toMatch(/920×1120 at 1028,340/);                  // where it should be
    expect(r.text).not.toMatch(/was restored to its normal size/);
  });

  it("the window moves, but not to its normal place (a changed rectangle is not a restore): NOT restored", async () => {
    const r = await go(world({ afterRestore: restoredTo(HALF) }));
    expect(r.outcome).toBe("unverified");
    expect(r.text).not.toMatch(/was restored to its normal size/);
    expect(r.text).toMatch(/1414×1811 at 1477,0/);
  });

  it("the rectangle matches but Windows still says the window is maximized: NOT restored", async () => {
    const r = await go(world({ start: { showCmd: 3, normal: NORMAL, current: { ...NORMAL } }, afterRestore: (s) => ({ ...s, showCmd: 3 }) }));
    expect(r.outcome).toBe("unverified");
    expect(r.text).toMatch(/maximized/);
  });

  it("the window is minimized afterwards: NOT restored", async () => {
    const r = await go(world({ afterRestore: (s) => ({ ...s, showCmd: 2 }) }));
    expect(r.outcome).toBe("unverified");
    expect(r.text).toMatch(/minimized/);
  });

  it("the placement cannot be read back after the request: NOT restored, and it says it could not read it", async () => {
    let reads = 0;
    const w = world({ afterRestore: restoredTo(NORMAL) });
    const real = w.deps.input.windowPlacement!;
    (w.deps.input as InputPort).windowPlacement = async (h) => (++reads <= 1 ? real(h) : { ok: false, reason: "Windows didn't answer in time" });
    const r = await go(w);
    expect(r.outcome).toBe("unverified");
    expect(r.text).toMatch(/somewhere I could not read/);
  });
});

describe("arrange_window restore: unavailable or invalid placement information", () => {
  it("the placement cannot be read: the window is NOT touched (no key, no request), and the refusal says nothing was changed", async () => {
    const w = world({ readFails: "Windows wouldn't let me do that" });
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(r.text).toMatch(/did not try to restore it/);
    expect(r.text).toMatch(/Nothing was changed/);
    expect(w.calls).not.toContain("restoreWindowPlacement");
    expect(pressed(w)).toEqual([]);
    expect(r.failure).toMatchObject({ acted: "no" });                // nothing was sent: a retry is safe
  });

  it("the window has closed: the failure is target_gone, nothing is touched", async () => {
    const w = world({ readFails: "that window has closed" });
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(r.failure).toMatchObject({ kind: "target_gone", acted: "no" });
    expect(w.calls).not.toContain("restoreWindowPlacement");
  });

  it("Windows has no usable normal rectangle (zero or tiny): nothing is invented, nothing is touched", async () => {
    for (const normal of [{ l: 0, t: 0, w: 0, h: 0 }, { l: 100, t: 100, w: 30, h: 20 }]) {
      const w = world({ start: { showCmd: 1, normal, current: QUARTER } });
      const r = await go(w);
      expect(r.outcome).toBe("failed");
      expect(r.text).toMatch(/no usable normal size recorded/);
      expect(r.failure).toMatchObject({ kind: "unavailable", acted: "no" });
      expect(w.calls).not.toContain("restoreWindowPlacement");
      expect(pressed(w)).toEqual([]);
    }
  });

  it("Windows refuses the restore request: nothing moved, the answer says so and no restore is claimed", async () => {
    const w = world({ restoreFails: "Windows wouldn't let me do that" });
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(r.text).toMatch(/Nothing was changed/);
    expect(r.failure).toMatchObject({ kind: "unavailable", acted: "no" });
    expect(r.text).not.toMatch(/was restored/);
  });

  it("the restore request gets no answer in time: it MAY have moved, so it is acted=maybe and is never repeated", async () => {
    const w = world({ restoreFails: "Windows didn't answer in time" });
    const r = await go(w);
    expect(r.outcome).toBe("failed");
    expect(r.text).toMatch(/do not know whether it moved/);
    expect(r.failure).toMatchObject({ acted: "maybe" });              // the existing verify-only recovery may relabel the kind; what matters is that it is NOT "no"
    expect(w.calls.filter((c) => c === "restoreWindowPlacement")).toHaveLength(1);   // and the request is never repeated blindly
  });
});

describe("arrange_window restore: an older build without the placement port, and the other actions", () => {
  it("falls back to the key path but NEVER calls a changed rectangle 'restored' (it cannot check against the normal place)", async () => {
    const w = world({ noPlacementPort: true, keyRect: () => ({ l: 1477, t: 900, w: 1414, h: 911 }) });
    const r = await go(w);
    expect(pressed(w)).toEqual(["press:win+down"]);
    expect(r.outcome).toBe("unverified");
    expect(r.text).toMatch(/cannot confirm it is back at its normal size/);
    expect(r.text).not.toMatch(/was restored/);
  });

  it("snap left and maximize are unchanged: they press their key, are verified from the rectangle, and never touch the placement port", async () => {
    for (const [to, key] of [["left", "win+left"], ["maximize", "win+up"]] as const) {
      const w = world({ keyRect: () => ({ l: 0, t: 0, w: 500, h: 800 }) });
      const t = run(w, [{ type: "tool", tool: "arrange_window", args: { to, window: "Documents" } }, done]);
      await t.session.handleTranscript("s", "arrange");
      const r = lastTool(t.results)!;
      expect(pressed(w)).toEqual([`press:${key}`]);
      expect(r.outcome).toBe("ok");
      expect(r.text).toMatch(/1000×800 → 500×800/);
      expect(w.calls).not.toContain("windowPlacement");
      expect(w.calls).not.toContain("restoreWindowPlacement");
    }
  });
});

/**
 * Stability. "Restored" needs the window to HOLD STILL: two consecutive readings that agree (and match the recorded normal rectangle). A last reading that merely happens to
 * match, after a wait that timed out, is not proof: the window may still be moving.
 */
describe("arrange_window restore: the window must hold still before it is called restored", () => {
  const okAt = (r: PxRect, showCmd = 1): PlacementResult => ({ ok: true, showCmd, normal: { ...NORMAL }, current: { ...r } });
  /** after the restore request, the placement reads come from `reads(i)` (undefined = the port gives nothing back); before it, the world's own state */
  function scripted(w: ReturnType<typeof world>, reads: (i: number) => PlacementResult | undefined) {
    const input = w.deps.input as InputPort;
    let restored = false, i = 0;
    const realRestore = input.restoreWindowPlacement!;
    input.restoreWindowPlacement = async (h) => { restored = true; return realRestore(h); };
    const realRead = input.windowPlacement!;
    input.windowPlacement = async (h) => (restored ? (reads(i++) as PlacementResult) : realRead(h));
    return { readsAfterRestore: () => i };
  }
  const restoreCalls = (w: ReturnType<typeof world>) => w.calls.filter((c) => c === "restoreWindowPlacement").length;

  it("ONE matching reading and then no further reading (the wait times out): the last reading matches, but it is NOT confirmed", async () => {
    const w = world({ afterRestore: restoredTo(NORMAL) });
    const s = scripted(w, (i) => (i === 0 ? okAt(NORMAL) : undefined));
    const r = await go(w);
    expect(r.outcome).toBe("unverified");
    expect(r.text).toMatch(/did not hold still for two readings in a row/);
    expect(r.text).toMatch(/cannot confirm it was restored/);
    expect(r.text).not.toMatch(/was restored to its normal size/);
    expect(r.text).toMatch(/920×1120 at 1028,340/);                    // the matching last reading is still reported, honestly, as unconfirmed
    expect(s.readsAfterRestore()).toBeGreaterThan(2);                  // the wait really kept looking until it timed out
    expect(restoreCalls(w)).toBe(1);                                   // and the request was NOT repeated
    expect(pressed(w)).toEqual([]);
  });

  it("a placement that matches within tolerance on every reading but NEVER gives two consecutive identical readings: NOT confirmed", async () => {
    const w = world({ afterRestore: restoredTo(NORMAL) });
    const s = scripted(w, (i) => okAt(i % 2 === 0 ? NORMAL : { ...NORMAL, l: NORMAL.l + 3 }));      // both within the 6 px tolerance, never equal twice in a row
    const r = await go(w);
    expect(r.outcome).toBe("unverified");
    expect(r.text).toMatch(/did not hold still for two readings in a row/);
    expect(r.text).not.toMatch(/was restored to its normal size/);
    expect(s.readsAfterRestore()).toBeGreaterThan(5);
    expect(restoreCalls(w)).toBe(1);
  });

  it("genuine restoration: the window settles (still moving on the first reading), then two consecutive matching readings confirm it", async () => {
    const w = world({ afterRestore: restoredTo(NORMAL) });
    const s = scripted(w, (i) => (i === 0 ? okAt(HALF) : okAt(NORMAL)));
    const r = await go(w);
    expect(r.outcome).toBe("ok");
    expect(r.text).toMatch(/was restored to its normal size and position \(920×1120 at 1028,340\)/);
    expect(s.readsAfterRestore()).toBeGreaterThanOrEqual(3);          // HALF, then two consecutive NORMAL readings
    expect(restoreCalls(w)).toBe(1);
  });

  it("two consecutive matching readings straight away also confirm it, and the wait stops there (it does not poll on to the timeout)", async () => {
    const w = world({ afterRestore: restoredTo(NORMAL) });
    const s = scripted(w, () => okAt(NORMAL));
    const r = await go(w);
    expect(r.outcome).toBe("ok");
    expect(s.readsAfterRestore()).toBe(2);
  });

  it("a stable window that is NOT at the normal rectangle is still not restored (stability alone is never enough)", async () => {
    const w = world({ afterRestore: restoredTo(NORMAL) });
    scripted(w, () => okAt(QUARTER));
    const r = await go(w);
    expect(r.outcome).toBe("unverified");
    expect(r.text).toMatch(/cannot say it was restored/);
    expect(r.text).toMatch(/1414×911 at 1477,900/);
  });

  it("cancelling in the middle of the wait stops at once: nothing is claimed, the task does not complete, and the request is not repeated", async () => {
    const w = world({ afterRestore: restoredTo(NORMAL) });
    const t = run(w, [restore, done]);
    scripted(w, (i) => { if (i === 1) t.session.orchestrator.cancel(); return okAt(i === 0 ? HALF : NORMAL); });
    await t.session.handleTranscript("s", "restore it");
    expect(restoreCalls(w)).toBe(1);
    expect(t.events.some((e) => e.type === "task.completed")).toBe(false);
    const texts = JSON.stringify(t.results) + JSON.stringify(t.events);
    expect(texts).not.toMatch(/was restored to its normal size/);
    expect(pressed(w)).toEqual([]);
  });
});
