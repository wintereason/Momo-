import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Session } from "../session";
import type { ToolDef, ToolOutcome } from "../tools";
import type { PlanDecision, PlanStep } from "../ai/prompts";
import type { AiService } from "../ai/service";
import type { RuntimeEvent } from "../../../types/runtime-events";
import type { Acted, ActResult, FsPort, InputPort, LaunchPort, PointerPort, PointerResult, RawWindow, ScreenPort, WindowState } from "../../shared/ports";
import type { Confirmation } from "./verifyOnly";

/**
 * Phases 4c and 4d, end to end with scripted tools: bounded retries decided in one place, fresh target resolution, shared budgets, no duplicate
 * actions, and frozen applications, UI Automation failures, unexpected dialogs, takeover and cancellation.
 */
const explorer: RawWindow = { hwnd: 20, pid: 20, process: "explorer", title: "Documents - File Explorer", z: 0 };

interface WorldOpts {
  state?: (n: number) => WindowState;
  windows?: (n: number) => RawWindow[];
  interrupted?: () => boolean;
  foreground?: boolean;
}
function world(o: WorldOpts = {}) {
  const calls = { act: [] as string[], state: 0, query: 0, abort: [] as string[], sleep: 0 };
  const act = (n: string) => async (): Promise<ActResult> => { calls.act.push(n); return { ok: true }; };
  const input: InputPort = {
    focusWindow: act("focus"), minimizeWindow: act("minimize"), closeWindow: act("close"),
    windowState: async (): Promise<WindowState> => { const n = calls.state++; return o.state ? o.state(n) : { exists: true, minimized: false, pid: 20, foregroundPid: 20, hung: false, modal: false }; },
    invokeControl: async () => { calls.act.push("invoke"); return { ok: true }; }, setControlText: async () => { calls.act.push("settext"); return { ok: true, readBack: "" }; },
  };
  const screen: ScreenPort = { readUi: async () => ({ ok: true, items: [], truncated: false }), ocr: async () => ({ ok: true, lines: [] }) };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  const okR: PointerResult = { ok: true };
  let delivered: Acted = "no";
  const pointer: PointerPort = {
    click: async () => { calls.act.push("click"); return okR; }, press: async () => { calls.act.push("press"); return okR; }, type: async () => { calls.act.push("type"); return okR; },
    windowAt: () => 20, windowRect: () => ({ l: 0, t: 0, w: 1000, h: 800 }),
    resetActed: () => { delivered = "no"; }, actedSince: () => delivered, interrupted: () => (o.interrupted?.() ? "mouse" : null),
    abort: (why) => { calls.abort.push(String(why)); },
  };
  return {
    calls, setDelivered: (a: Acted) => { delivered = a; },
    deps: {
      fs, input, screen, launch, act: { openPath: async () => "" }, apps: { list: async () => [] },
      win: { query: async () => { const n = calls.query++; return { processes: undefined, activePid: 20, activeHwnd: 20, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 } as RawWindow, explorer, ...(o.windows ? o.windows(n) : [])] }; } },
      pointer: () => pointer,
      ...(o.foreground ? { foreground: { lastExternal: () => ({ hwnd: 20, pid: 20, title: "Documents - File Explorer" }) } } : {}),
    },
  };
}

type RunFn = (n: number, args: Record<string, unknown>) => ToolOutcome | Promise<ToolOutcome>;
interface FakeTool { runs: number; argsSeen: Record<string, unknown>[]; confirms: number; def: ToolDef }
function fakeTool(name: string, outcome: RunFn, o: { risk?: "read" | "reversible" | "consequential"; confirm?: ToolDef["confirm"]; setDelivered?: (n: number) => void } = {}): FakeTool {
  const t: FakeTool = { runs: 0, argsSeen: [], confirms: 0, def: null as unknown as ToolDef };
  t.def = {
    name, signature: `${name}({})`, description: "test", schema: z.object({ label: z.string().optional(), _box: z.string().optional(), _rid: z.string().optional() }).strict() as never,
    sensitive: false, risk: () => o.risk ?? "reversible", describe: () => name, working: () => "…",
    run: async (a) => { const n = t.runs++; t.argsSeen.push({ ...a }); o.setDelivered?.(n); return outcome(n, a); },
    ...(o.confirm ? { confirm: async (a, tg, v) => { t.confirms++; return o.confirm!(a, tg, v); } } : {}),
  };
  return t;
}

function run(w: ReturnType<typeof world>, tools: FakeTool[], script: PlanDecision[], extra: Record<string, unknown> = {}) {
  const events: RuntimeEvent[] = [];
  const results: PlanStep[][] = [];
  let i = 0;
  const ai: AiService = {
    ready: () => true, label: () => "T", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_g, steps) { results.push(JSON.parse(JSON.stringify(steps))); return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "T" }; },
  };
  const session = new Session({ ...(w.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => { w.calls.sleep++; }, cursorLeadMs: () => 0, ...extra } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  (session.orchestrator as unknown as { tools: ToolDef[] }).tools.push(...tools.map((t) => t.def));
  return { session, events, results };
}
const tool = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
const done = (a: string): PlanDecision => ({ type: "done", answer: a });
const steps = (results: PlanStep[][]) => results[results.length - 1].filter((s) => s.kind === "tool") as Extract<PlanStep, { kind: "tool" }>[];
const good = (): ToolOutcome => ({ ok: true, brief: "Done.", report: "x", verified: true });
const bad = (reason: string): ToolOutcome => ({ ok: false, reason });
const UIA = 'Could not look inside "x" (y).';
const yes: Confirmation = { verified: true, evidence: [{ kind: "window_state", ok: true }] };
const go = async (r: ReturnType<typeof run>) => { await r.session.handleTranscript("s", "go"); };

describe("4c: one bounded retry, decided centrally", () => {
  it("a read that fails with a UI Automation hiccup (nothing sent) is retried once, and the second result is used and verified", async () => {
    const w = world();
    const t = fakeTool("look_thing", (n) => (n === 0 ? bad(UIA) : good()), { risk: "read" });
    const r = run(w, [t], [tool("look_thing", { label: "a" }), done("ok")]);
    await go(r);
    expect(t.runs).toBe(2);
    expect(steps(r.results)[0].outcome).toBe("ok");
    const j = r.session.orchestrator.journal();
    expect(j.map((e) => e.attempt)).toEqual([1, 2]);
    expect(j[0].trail).toContain("retrying");
    expect(j[0].evidence).toContainEqual({ kind: "retry_decided", ok: true });
    expect(r.events.some((e) => e.type === "task.completed")).toBe(true);
  });
  it("a reversible step that sent nothing and failed with 'timeout' is retried once too", async () => {
    const w = world();
    const t = fakeTool("do_thing", (n) => (n === 0 ? bad("Windows didn't answer in time") : good()));
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(2);
  });
  it("only ONE retry per call: a second failure is final (a third run never happens)", async () => {
    const w = world();
    const t = fakeTool("look_thing", () => bad(UIA), { risk: "read" });
    const r = run(w, [t], [tool("look_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(2);
    expect(steps(r.results)[0].outcome).toBe("failed");
  });
  it("the budget is shared by the whole task: two retries in total, whichever tools use them", async () => {
    const w = world();
    const mk = (n: string) => fakeTool(n, () => bad(UIA), { risk: "read" });
    const a = mk("a"), b = mk("b"), c = mk("c");
    const r = run(w, [a, b, c], [tool("a", {}), tool("b", {}), tool("c", {}), done("ok")]);
    await go(r);
    expect([a.runs, b.runs, c.runs]).toEqual([2, 2, 1]); // a and b got their retry; c did not
  });
  it("the retry looks for the target again: its old position is dropped, what was asked for stays", async () => {
    const w = world();
    const t = fakeTool("click_thing", (n) => (n === 0 ? bad("The window moved while I was aiming, so I stopped. Look at the screen again.") : good()));
    const r = run(w, [t], [tool("click_thing", { label: "Save", _rid: "1.2", _box: "10,10,50,20" }), done("ok")]);
    await go(r);
    expect(t.runs).toBe(2);
    expect(t.argsSeen[0]).toEqual({ label: "Save", _rid: "1.2", _box: "10,10,50,20" });
    expect(t.argsSeen[1]).toEqual({ label: "Save", _rid: "1.2" });
  });
  it("a retry does not use up the planner's steps and is announced", async () => {
    const w = world();
    const t = fakeTool("look_thing", (n) => (n === 0 ? bad(UIA) : good()), { risk: "read" });
    const r = run(w, [t], [tool("look_thing", {}), done("ok")]);
    await go(r);
    expect(r.results.length).toBe(2); // plan(tool), plan(done): the retry was not a planner step
    expect(r.events.some((e) => e.type === "task.state" && /trying once more/i.test((e as { message?: string }).message ?? ""))).toBe(true);
  });
});

describe("4c: no duplicate actions", () => {
  it("anything that may have reached the app is not retried (maybe and yes), and is not repeated by the planner either", async () => {
    for (const delivered of ["maybe", "yes"] as Acted[]) {
      const w = world();
      const t = fakeTool("do_thing", () => bad("The mouse or keyboard action did not go through."), { setDelivered: () => w.setDelivered(delivered) });
      const bump = fakeTool("bump", () => good());
      const r = run(w, [t, bump], [tool("do_thing", { label: "x" }), tool("bump", {}), tool("do_thing", { label: "x" }), done("ok")]);
      await go(r);
      expect(t.runs, delivered).toBe(1);
    }
  });
  it("a consequential action is never retried, even when nothing was sent", async () => {
    const w = world();
    const t = fakeTool("send_it", () => bad(UIA), { risk: "consequential" });
    const r = run(w, [t], [tool("send_it", {}), done("ok")], {});
    (r.session as unknown as { setPolicy(p: unknown): void }).setPolicy({ confirmReversible: false, confirmScreenRead: false, confirmConsequential: false });
    await go(r);
    // (it may have been held for confirmation by policy: either way it was never run twice)
    expect(t.runs).toBeLessThanOrEqual(1);
  });
  it("a retry that ITSELF sends something is final: no third try", async () => {
    const w = world();
    const t = fakeTool("do_thing", (n) => (n === 0 ? bad(UIA) : bad("The mouse or keyboard action did not go through.")), { setDelivered: (n) => w.setDelivered(n === 0 ? "no" : "maybe") });
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(2);
    const s = steps(r.results)[0];
    expect(s.outcome).toBe("failed");
    expect(s.failure).toMatchObject({ acted: "maybe" });
  });
  it("the same call that may already have run earlier in the task is not retried when it later fails with nothing sent", async () => {
    const w = world();
    const t = fakeTool("do_thing", (n) => (n === 0 ? bad("The mouse or keyboard action did not go through.") : bad(UIA)), { setDelivered: (n) => w.setDelivered(n === 0 ? "maybe" : "no") });
    const bump = fakeTool("bump", () => good());
    const r = run(w, [t, bump], [tool("do_thing", { label: "x" }), tool("bump", {}), tool("do_thing", { label: "x" }), done("ok")]);
    await go(r);
    expect(t.runs).toBe(1); // the planner's repeat is refused outright: it may already have happened
  });
  it("failures that need a person (ambiguous, not found, policy, user takeover) are never retried", async () => {
    const reasons = ['No open window matches "zzz".', "I never type into password fields.", "You pressed Esc, so I stopped.", "Flux capacitor misaligned", "That window isn't open any more.", '"Search" is disabled right now.'];
    for (const reason of reasons) {
      const w = world();
      const t = fakeTool("do_thing", () => bad(reason));
      const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
      await go(r);
      expect(t.runs, reason).toBe(1);
    }
  });
  it("an ambiguous result asks the user and is not retried", async () => {
    const w = world();
    const t = fakeTool("pick_thing", () => ({ ok: false, ambiguous: { noun: "fields", labels: ["a", "b"], patches: [{ label: "a" }, { label: "b" }] } }));
    const r = run(w, [t], [tool("pick_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(1);
    expect(r.events.some((e) => e.type === "task.clarification_required")).toBe(true);
  });
});

describe("4d: user takeover and cancellation", () => {
  it("the user took the mouse after the first try: no retry", async () => {
    let taken = false;
    const w = world({ interrupted: () => taken });
    const t = fakeTool("look_thing", () => { taken = true; return bad(UIA); }, { risk: "read" });
    const r = run(w, [t], [tool("look_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(1);
  });
  it("cancelled during the first try: no retry, no look, nothing recorded as done", async () => {
    const w = world();
    let session: Session | null = null;
    const t = fakeTool("look_thing", () => { session!.orchestrator.cancel(); return bad(UIA); }, { risk: "read" });
    const r = run(w, [t], [tool("look_thing", {}), done("ok")]);
    session = r.session;
    await go(r);
    expect(t.runs).toBe(1);
    expect(r.events.some((e) => e.type === "task.completed")).toBe(false);
  });
  it("cancelling tells the real mouse and keyboard to stop and let go of everything, at once", async () => {
    const w = world();
    const r = run(w, [], [done("ok")]);
    r.session.orchestrator.cancel();
    expect(w.calls.abort).toEqual(["cancel"]);
  });
  it("cancelled in the middle of waiting for a frozen window: the wait ends and nothing more happens", async () => {
    let session: Session | null = null;
    const w = world({ foreground: true, state: (n) => { if (n >= 2) session!.orchestrator.cancel(); return { exists: true, minimized: false, pid: 20, foregroundPid: 20, hung: true }; } });
    const t = fakeTool("do_thing", () => ({ ok: true, brief: "Did it.", report: "x", verified: false }), { setDelivered: () => w.setDelivered("yes"), confirm: async () => yes });
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    session = r.session;
    await go(r);
    expect(w.calls.state).toBeLessThanOrEqual(4);
    expect(t.confirms).toBe(0);
    expect(r.events.some((e) => e.type === "task.completed")).toBe(false);
  });
});

describe("4d: frozen applications", () => {
  it("a window that is frozen and STAYS frozen: nothing more is sent to it, the wait is bounded, and the step says why", async () => {
    const w = world({ foreground: true, state: () => ({ exists: true, minimized: false, pid: 20, foregroundPid: 20, hung: true }) });
    const t = fakeTool("do_thing", () => ({ ok: true, brief: "Did it, but could not confirm.", report: "x", verified: false }), { setDelivered: () => w.setDelivered("yes"), confirm: async () => yes });
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(1);
    expect(t.confirms).toBe(0);                          // a frozen window is not asked about its content
    expect(w.calls.act).toEqual([]);                     // and nothing is sent to it
    expect(w.calls.state).toBeLessThan(25);              // the wait is bounded
    const s = steps(r.results)[0];
    expect(s.outcome).toBe("unverified");
    expect(s.text).toMatch(/not responding/i);
    const e = r.session.orchestrator.journal()[0].evidence;
    expect(e).toEqual(expect.arrayContaining([{ kind: "window_hung", ok: true }, { kind: "still_hung", ok: true }]));
  });
  it("a window that was frozen and answers again is LOOKED AT again, and an effect that really landed in the meantime is confirmed", async () => {
    const w = world({ foreground: true, state: (n) => ({ exists: true, minimized: false, pid: 20, foregroundPid: 20, hung: n < 2, modal: false }) });
    const t = fakeTool("do_thing", () => ({ ok: true, brief: "Did it, but could not confirm.", report: "x", verified: false }), { setDelivered: () => w.setDelivered("yes"), confirm: async () => yes });
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(1);                              // never repeated
    expect(t.confirms).toBe(1);                          // asked once, after it answered
    expect(steps(r.results)[0].outcome).toBe("ok");
    const j = r.session.orchestrator.journal()[0];
    expect(j.trail).toEqual(expect.arrayContaining(["observing", "waiting", "verified"]));
    expect(j.evidence).toContainEqual({ kind: "responsive_again", ok: true });
    expect(w.calls.act).toEqual([]);
  });
  it("a frozen window turns an unexplained timeout into app_unresponsive, and it is not retried", async () => {
    const w = world({ foreground: true, state: () => ({ exists: true, minimized: false, pid: 20, foregroundPid: 20, hung: true }) });
    const t = fakeTool("look_thing", () => bad("Windows didn't answer in time"), { risk: "read" });
    const r = run(w, [t], [tool("look_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(1);
    expect(steps(r.results)[0].failure?.kind).toBe("app_unresponsive");
  });
});

describe("4d: UI Automation failures", () => {
  it("a read that fails once is retried and succeeds; one that keeps failing is reported as a UI Automation failure, not a success", async () => {
    const w = world();
    const flaky = fakeTool("look_thing", (n) => (n === 0 ? bad(UIA) : good()), { risk: "read" });
    const r1 = run(w, [flaky], [tool("look_thing", {}), done("ok")]);
    await go(r1);
    expect(steps(r1.results)[0].outcome).toBe("ok");
    const w2 = world();
    const dead = fakeTool("look_thing", () => bad(UIA), { risk: "read" });
    const r2 = run(w2, [dead], [tool("look_thing", {}), done("ok")]);
    await go(r2);
    expect(steps(r2.results)[0]).toMatchObject({ outcome: "failed", failure: { kind: "uia_failed", acted: "no" } });
    expect(r2.events.some((e) => e.type === "task.completed")).toBe(false);
  });
});

describe("4d: unexpected dialogs", () => {
  it("a dialog that blocks the window (modal): named popup_interrupted, nothing clicked in it, not retried, and the step tells the planner", async () => {
    const w = world({ foreground: true, state: () => ({ exists: true, minimized: false, pid: 20, foregroundPid: 20, hung: false, modal: true }) });
    const t = fakeTool("do_thing", () => bad("The mouse or keyboard action did not go through."), { setDelivered: () => w.setDelivered("maybe") });
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(1);
    expect(w.calls.act).toEqual([]);
    const s = steps(r.results)[0];
    expect(s.failure?.kind).toBe("popup_interrupted");
    expect(s.text).toMatch(/dialog or new window appeared/i);
    expect(r.session.orchestrator.journal()[0].evidence).toContainEqual({ kind: "window_modal", ok: true });
  });
  it("a new window that appeared while the step ran is counted (never named) and also treated as a dialog", async () => {
    const w = world({ windows: (n) => (n === 0 ? [] : [{ hwnd: 77, pid: 77, process: "x", title: "Confirm replace", z: 1 } as RawWindow]) });
    const t = fakeTool("do_thing", () => bad("Windows didn't answer in time"), { setDelivered: () => w.setDelivered("yes") });
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    await go(r);
    expect(t.runs).toBe(1);
    const j = r.session.orchestrator.journal()[0];
    expect(j.evidence).toContainEqual({ kind: "new_windows", ok: true, n: 1 });
    expect(JSON.stringify(j)).not.toContain("Confirm replace");
    expect(steps(r.results)[0].failure?.kind).toBe("popup_interrupted");
    expect(w.calls.act).toEqual([]);
  });
  it("no dialog: nothing is added to the step text", async () => {
    const w = world({ foreground: true });
    const t = fakeTool("do_thing", () => ({ ok: true, brief: "Did it, but could not confirm.", report: "x", verified: false }), { setDelivered: () => w.setDelivered("yes") });
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    await go(r);
    expect(steps(r.results)[0].text).toBe("Did it, but could not confirm.");
  });
});

describe("fault-injection matrix: whatever fails, however, nothing is ever run twice unless it is provably safe", () => {
  const sentences: Array<[string, boolean]> = [
    [UIA, true], ["Windows didn't answer in time", true], ["The window moved while I was aiming, so I stopped.", true], ["Another window took the keyboard, so I stopped.", true], ["The mouse or keyboard action did not go through.", true],
    ["Another window is in front of that spot.", false], ['No open window matches "x".', false], ["I never type into password fields.", false], ["You pressed Esc, so I stopped.", false], ["Flux capacitor misaligned", false],
    ["That window isn't open any more.", false], ['"x" is disabled right now.', false],
  ];
  it("runs = 2 only for (nothing sent) + (not consequential) + (a retryable failure) + (no takeover); otherwise exactly 1", async () => {
    let cases = 0;
    for (const [reason, retryable] of sentences) for (const risk of ["read", "reversible", "consequential"] as const) for (const delivered of ["no", "maybe", "yes"] as Acted[]) for (const taken of [false, true]) {
      const w = world({ interrupted: () => taken });
      const t = fakeTool("probe", () => bad(reason), { risk, setDelivered: () => w.setDelivered(delivered) });
      const r = run(w, [t], [tool("probe", {}), done("ok")]);
      (r.session as unknown as { setPolicy(p: unknown): void }).setPolicy({ confirmReversible: false, confirmScreenRead: false, confirmConsequential: false });
      await go(r);
      cases++;
      const expectTwo = retryable && delivered === "no" && risk !== "consequential" && !taken;
      // a consequential step may be held for the user's approval instead of running at all
      if (risk === "consequential" && t.runs === 0) continue;
      expect(t.runs, `${reason} / ${risk} / ${delivered} / taken=${taken}`).toBe(expectTwo ? 2 : 1);
    }
    expect(cases).toBe(sentences.length * 3 * 3 * 2);
  });
});

describe("4d: the real tools state when they failed before sending anything", () => {
  it("type_text whose window cannot be read (UI Automation failed) is retried once, and nothing was typed before the retry", async () => {
    // a real tool over fake ports: the first read of the window fails, the second works
    const w = world({ foreground: true });
    let reads = 0;
    (w.deps.screen as ScreenPort).readUi = async () => (reads++ === 0 ? { ok: false, reason: "Windows UI Automation couldn't read that window" } : { ok: true, items: [{ type: "Edit", name: "Search", enabled: true, offscreen: false, rid: "1.1", rect: { l: 1, t: 1, w: 100, h: 20 }, value: "" }], truncated: false });
    const r = run(w, [], [tool("type_text", { label: "Search", text: "abc" }), done("ok")]);
    await go(r);
    expect(reads).toBeGreaterThanOrEqual(2);
    const j = r.session.orchestrator.journal();
    expect(j[0]).toMatchObject({ tool: "type_text", attempt: 1, acted: "no", failure: "uia_failed" });
    expect(j[1]).toMatchObject({ tool: "type_text", attempt: 2 });
    expect(j[0].evidence).toContainEqual({ kind: "retry_decided", ok: true });
  });
  it("...and a window that can never be read ends as a UI Automation failure after exactly one retry", async () => {
    const w = world({ foreground: true });
    let reads = 0;
    (w.deps.screen as ScreenPort).readUi = async () => { reads++; return { ok: false, reason: "Windows UI Automation couldn't read that window" }; };
    const r = run(w, [], [tool("type_text", { label: "Search", text: "abc" }), done("ok")]);
    await go(r);
    expect(reads).toBe(2);
    expect(steps(r.results)[0]).toMatchObject({ outcome: "failed", failure: { kind: "uia_failed", acted: "no" } });
    expect(w.calls.act).toEqual([]);
  });
});
