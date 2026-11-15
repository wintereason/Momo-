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
 * Phase 4b: an action that MAY have run, or ran and could not be confirmed, is LOOKED AT (read-only), never repeated, and only real evidence
 * turns it into a success. Cancellation and takeover end all of it. Uses small scripted tools so every case is exact.
 */
const explorer: RawWindow = { hwnd: 20, pid: 20, process: "explorer", title: "Documents - File Explorer", z: 0 };
const CANARY = "CANARY-private-field-value-5521";

function world(opts: { state?: () => WindowState; pointerInterrupted?: () => boolean; delivered?: () => Acted } = {}) {
  const actCalls: string[] = [];
  const stateCalls: number[] = [];
  const queryCalls = { n: 0 };
  const readCalls = { n: 0 };
  const act = (name: string) => async (): Promise<ActResult> => { actCalls.push(name); return { ok: true }; };
  const input: InputPort = {
    focusWindow: act("focus"), minimizeWindow: act("minimize"), closeWindow: act("close"),
    windowState: async (): Promise<WindowState> => { stateCalls.push(1); return opts.state ? opts.state() : { exists: true, minimized: false, pid: 20, foregroundPid: 20, hung: false }; },
    invokeControl: async () => { actCalls.push("invoke"); return { ok: true }; }, setControlText: async () => { actCalls.push("settext"); return { ok: true, readBack: "" }; },
  };
  const screen: ScreenPort = { readUi: async () => { readCalls.n++; return { ok: true, items: [], truncated: false }; }, ocr: async () => ({ ok: true, lines: [] }) };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  const ok: PointerResult = { ok: true };
  const pointer: PointerPort = {
    click: async () => { actCalls.push("click"); return ok; }, press: async () => { actCalls.push("press"); return ok; }, type: async () => { actCalls.push("type"); return ok; },
    scroll: async () => { actCalls.push("scroll"); return ok; }, drag: async () => { actCalls.push("drag"); return ok; },
    windowAt: () => 20, windowRect: () => ({ l: 0, t: 0, w: 1000, h: 800 }),
    resetActed: () => {}, actedSince: () => (opts.delivered ? opts.delivered() : "no"), interrupted: () => (opts.pointerInterrupted?.() ? "mouse" : null),
  };
  return {
    actCalls, stateCalls, queryCalls, readCalls,
    deps: {
      fs, input, screen, launch, act: { openPath: async () => "" }, apps: { list: async () => [] },
      win: { query: async () => { queryCalls.n++; return { processes: undefined, activePid: 20, activeHwnd: 20, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 } as RawWindow, explorer] }; } },
      pointer: () => pointer,
    },
  };
}

interface FakeTool { runs: number; confirms: number; def: ToolDef }
function fakeTool(name: string, outcome: () => ToolOutcome | Promise<ToolOutcome>, confirm?: ToolDef["confirm"], risk: "read" | "reversible" | "consequential" = "reversible"): FakeTool {
  const t: FakeTool = { runs: 0, confirms: 0, def: null as unknown as ToolDef };
  t.def = {
    name, signature: `${name}({})`, description: "test tool", schema: z.object({ label: z.string().optional(), text: z.string().optional() }).strict() as never,
    sensitive: false, risk: () => risk, describe: () => name, working: () => "…",
    run: async () => { t.runs++; return outcome(); },
    ...(confirm ? { confirm: async (a, target, view) => { t.confirms++; return confirm(a, target, view); } } : {}),
  };
  return t;
}

function run(w: ReturnType<typeof world>, tools: FakeTool[], script: PlanDecision[]) {
  const events: RuntimeEvent[] = [];
  const results: PlanStep[][] = [];
  let i = 0;
  const ai: AiService = {
    ready: () => true, label: () => "TestAI", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_g, steps) { results.push(JSON.parse(JSON.stringify(steps))); return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "TestAI" }; },
  };
  const session = new Session({ ...(w.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, cursorLeadMs: () => 0 } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  (session.orchestrator as unknown as { tools: ToolDef[] }).tools.push(...tools.map((t) => t.def));
  return { session, events, results };
}
const tool = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
const done = (answer: string): PlanDecision => ({ type: "done", answer });
const stepsOf = (results: PlanStep[][]) => results[results.length - 1].filter((s) => s.kind === "tool") as Extract<PlanStep, { kind: "tool" }>[];
const unverifiedOk = (extra: Record<string, unknown> = {}): ToolOutcome => ({ ok: true, brief: "Did it, but could not confirm.", report: "x", verified: false, ...extra }) as ToolOutcome;
const confirmYes: Confirmation = { verified: true, evidence: [{ kind: "window_state", ok: true }] };

describe("an action that may have executed is never repeated", () => {
  it("a failed step that may have gone through is looked at once, and the SAME call is not run again (not by recovery, not by the planner)", async () => {
    const w = world({ delivered: () => "maybe" });
    const t = fakeTool("do_thing", () => ({ ok: false, reason: "The mouse or keyboard action did not go through." }), async () => ({ verified: null, evidence: [] }));
    const bump = fakeTool("bump", () => ({ ok: true, brief: "Did something else.", report: "x", verified: true })); // the screen moves on in between
    const r = run(w, [t, bump], [tool("do_thing", { label: "x" }), tool("bump", {}), tool("do_thing", { label: "x" }), done("stop")]);
    await r.session.handleTranscript("s", "go");
    expect(t.runs).toBe(1);                 // exactly one real run
    expect(t.confirms).toBe(1);             // one read-only look
    const s = stepsOf(r.results);
    expect(s[0]).toMatchObject({ outcome: "failed", failure: { kind: "input_failed", acted: "maybe" } });
    expect(s.some((x) => /could not be verified/.test(x.text))).toBe(true); // the planner's repeat (after the screen changed) was refused and told to look first
  });
  it("recovery never touches the mouse, keyboard, window controls or UI Automation actions", async () => {
    const w = world({ delivered: () => "yes" });
    const t = fakeTool("do_thing", () => unverifiedOk({ target: { hwnd: 20, pid: 20 } }), async (_a, _t, view) => { await view.windowState(20); await view.windows(); await view.readWindow(20); return { verified: null, evidence: [] }; });
    const r = run(w, [t], [tool("do_thing", { label: "x" }), done("ok")]);
    await r.session.handleTranscript("s", "go");
    expect(w.actCalls).toEqual([]); // not one click, key, scroll, drag, focus, close, minimize, invoke or set-text
    expect(t.runs).toBe(1);
  });
  it("a failure whose look proves the effect is absent may be tried again by the planner (that is a decision for the planner, not recovery)", async () => {
    const w = world({ delivered: () => "maybe" });
    const t = fakeTool("do_thing", () => ({ ok: false, reason: "The mouse or keyboard action did not go through." }), async () => ({ verified: false, evidence: [{ kind: "window_state", ok: false }] }));
    const bump = fakeTool("bump", () => ({ ok: true, brief: "Did something else.", report: "x", verified: true }));
    const r = run(w, [t, bump], [tool("do_thing", { label: "x" }), tool("bump", {}), tool("do_thing", { label: "x" }), done("ok")]);
    await r.session.handleTranscript("s", "go");
    expect(t.runs).toBe(2);
  });
  it("a step that sent nothing (delivered 'no', refused up front) triggers no look at all", async () => {
    const w = world({ delivered: () => "no" });
    const t = fakeTool("do_thing", () => ({ ok: false, reason: 'No open window matches "zzz".' }), async () => confirmYes);
    const r = run(w, [t], [tool("do_thing", { label: "x" }), done("ok")]);
    await r.session.handleTranscript("s", "go");
    expect(t.confirms).toBe(0);
    expect(w.stateCalls.length).toBe(0);
  });
});

describe("an unverified action triggers a read-only observation", () => {
  it("the tool's own check is called with a read-only view, and what Windows says about the window is read", async () => {
    const w = world();
    const t = fakeTool("do_thing", () => unverifiedOk({ target: { hwnd: 20, pid: 20 } }), async () => ({ verified: null, evidence: [] }));
    const r = run(w, [t], [tool("do_thing", { label: "x" }), done("ok")]);
    await r.session.handleTranscript("s", "go");
    expect(t.confirms).toBe(1);
    expect(w.stateCalls.length).toBeGreaterThan(0);
    const j = r.session.orchestrator.journal()[0];
    expect(j.trail).toEqual(["started", "ran", "observing", "unconfirmed"]);
    expect(j.evidence).toEqual(expect.arrayContaining([{ kind: "tool_unverified", ok: null }, { kind: "window_exists", ok: true }]));
  });
  it("a tool with no check of its own still gets a look at the desktop, and stays unverified", async () => {
    const w = world();
    const t = fakeTool("do_thing", () => unverifiedOk());
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    await r.session.handleTranscript("s", "go");
    expect(w.queryCalls.n).toBeGreaterThan(0);
    expect(stepsOf(r.results)[0].outcome).toBe("unverified");
    expect(r.session.orchestrator.journal()[0].evidence).toContainEqual({ kind: "no_probe", ok: null });
  });
  it("verified actions and reads are not re-examined (no extra cost on the success path)", async () => {
    const w = world();
    const good = fakeTool("do_good", () => ({ ok: true, brief: "Done.", report: "x", verified: true }), async () => confirmYes);
    const read = fakeTool("look_thing", () => ({ ok: true, brief: "Saw.", report: "x", verified: false }), async () => confirmYes, "read");
    const r = run(w, [good, read], [tool("do_good", {}), tool("look_thing", {}), done("ok")]);
    await r.session.handleTranscript("s", "go");
    expect(good.confirms).toBe(0);
    expect(read.confirms).toBe(0);
    expect(w.stateCalls.length).toBe(0);
  });
});

describe("verified effects are recognised, and only with evidence", () => {
  it("an unverified action whose effect the look PROVES becomes a verified success, and the task completes as verified", async () => {
    const w = world();
    const t = fakeTool("do_thing", () => unverifiedOk({ target: { hwnd: 20, pid: 20 } }), async () => confirmYes);
    const r = run(w, [t], [tool("do_thing", { label: "x" }), done("It is done.")]);
    await r.session.handleTranscript("s", "go");
    expect(stepsOf(r.results)[0].outcome).toBe("ok");
    expect(r.events.some((e) => e.type === "task.completed" && (e as { verified?: boolean }).verified === true)).toBe(true);
    expect(r.session.orchestrator.journal()[0].trail).toEqual(["started", "ran", "observing", "verified"]);
    expect(t.runs).toBe(1);
  });
  it("a step that reported a failure but whose effect the look proves is recorded as done, with the failure not hidden", async () => {
    const w = world({ delivered: () => "maybe" });
    const t = fakeTool("do_thing", () => ({ ok: false, reason: "Windows didn't answer in time" }), async () => confirmYes);
    const r = run(w, [t], [tool("do_thing", { label: "x" }), done("ok")]);
    await r.session.handleTranscript("s", "go");
    const s = stepsOf(r.results)[0];
    expect(s.outcome).toBe("ok");
    expect(s.text).toMatch(/didn't answer in time/);
    expect(s.text).toMatch(/Looking afterwards shows it did happen/);
    expect(t.runs).toBe(1);
  });
  it("the real window tools: Windows says it is minimized after the tool's own wait gave up -> confirmed afterwards", async () => {
    // first learn how many state reads the tool's own wait makes, then let the window become minimized only AFTER that
    let calls = 0, minimizedFrom = Number.POSITIVE_INFINITY;
    const w = world({ state: () => ({ exists: true, minimized: ++calls > minimizedFrom, pid: 20, foregroundPid: 20, hung: false }) });
    const first = run(w, [], [tool("minimize_window", { window: "Documents" }), done("ok")]);
    await first.session.handleTranscript("s", "minimize");
    const own = calls; // includes the one recovery look (the window never minimized in this run)
    expect(stepsOf(first.results)[0].outcome).toBe("unverified");
    calls = 0; minimizedFrom = own - 1; // minimized only on the LAST read: the recovery look
    const w2 = world({ state: () => ({ exists: true, minimized: ++calls > minimizedFrom, pid: 20, foregroundPid: 20, hung: false }) });
    const second = run(w2, [], [tool("minimize_window", { window: "Documents" }), done("ok")]);
    await second.session.handleTranscript("s", "minimize");
    expect(stepsOf(second.results)[0].outcome).toBe("ok");
    expect(second.session.orchestrator.journal()[0].trail).toContain("verified");
    expect(w2.actCalls.filter((c) => c === "minimize").length).toBe(1); // asked to minimize exactly once
  });
});

describe("uncertain effects stay unverified", () => {
  it("'cannot tell', a bare claim and a thrown check all leave the step unverified and the task a partial success", async () => {
    for (const confirm of [
      async (): Promise<Confirmation> => ({ verified: null, evidence: [] }),
      async (): Promise<Confirmation> => ({ verified: true, evidence: [] }),
      async (): Promise<Confirmation> => { throw new Error("boom"); },
    ]) {
      const w = world();
      const t = fakeTool("do_thing", () => unverifiedOk({ target: { hwnd: 20, pid: 20 } }), confirm);
      const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
      await r.session.handleTranscript("s", "go");
      expect(stepsOf(r.results)[0].outcome).toBe("unverified");
      expect(r.events.some((e) => e.type === "task.completed")).toBe(false);
      expect(r.events.some((e) => e.type === "task.state" && (e as { state?: string }).state === "partial_success")).toBe(true);
    }
  });
  it("a hung window is not asked about its content, and the failure is named app_unresponsive", async () => {
    const w = world({ delivered: () => "maybe", state: () => ({ exists: true, minimized: false, pid: 20, foregroundPid: 20, hung: true }) });
    const t = fakeTool("do_thing", () => ({ ok: false, reason: "Windows didn't answer in time" }), async () => confirmYes);
    // (a failure carries no target of its own: give the tool one through its own check path by using an unverified ok)
    const u = fakeTool("do_other", () => unverifiedOk({ target: { hwnd: 20, pid: 20 } }), async () => confirmYes);
    const r = run(w, [t, u], [tool("do_other", {}), done("ok")]);
    await r.session.handleTranscript("s", "go");
    expect(u.confirms).toBe(0);
    expect(stepsOf(r.results)[0].outcome).toBe("unverified");
    expect(r.session.orchestrator.journal()[0].evidence).toEqual(expect.arrayContaining([{ kind: "window_hung", ok: true }, { kind: "observation_skipped", ok: null }]));
  });
});

describe("cancellation, Esc and takeover end all recovery activity", () => {
  it("cancelled while the tool was running: no look is made at all", async () => {
    const w = world({ delivered: () => "maybe" });
    let session: Session | null = null;
    let queriesAtCancel = -1;
    const t = fakeTool("do_thing", () => { queriesAtCancel = w.queryCalls.n; session!.orchestrator.cancel(); return unverifiedOk({ target: { hwnd: 20, pid: 20 } }); }, async () => confirmYes);
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    session = r.session;
    await r.session.handleTranscript("s", "go");
    expect(t.confirms).toBe(0);
    expect(w.stateCalls.length).toBe(0);
    expect(w.queryCalls.n).toBe(queriesAtCancel); // (the desktop was listed once before the step started; not once after the cancel)
    expect(r.session.orchestrator.journal()[0].phase).toBe("cancelled");
    expect(r.events.some((e) => e.type === "task.completed")).toBe(false);
  });
  it("cancelled DURING the look: even a 'verified' answer is discarded and nothing is recorded as done", async () => {
    const w = world();
    let session: Session | null = null;
    const t = fakeTool("do_thing", () => unverifiedOk({ target: { hwnd: 20, pid: 20 } }), async () => { session!.orchestrator.cancel(); return confirmYes; });
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    session = r.session;
    await r.session.handleTranscript("s", "go");
    expect(r.results.every((rs) => rs.every((s) => !(s.kind === "tool" && s.outcome === "ok")))).toBe(true);
    expect(r.session.orchestrator.journal()[0].phase).toBe("cancelled");
    expect(r.events.some((e) => e.type === "task.completed")).toBe(false);
  });
  it("the user took the mouse (physical takeover): the look is not started", async () => {
    const w = world({ delivered: () => "maybe", pointerInterrupted: () => true });
    const t = fakeTool("do_thing", () => unverifiedOk({ target: { hwnd: 20, pid: 20 } }), async () => confirmYes);
    const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
    await r.session.handleTranscript("s", "go");
    expect(t.confirms).toBe(0);
    expect(w.stateCalls.length).toBe(0);
    expect(stepsOf(r.results).every((s) => s.outcome !== "ok")).toBe(true);
  });
  it("a failure that IS the user's takeover or a cancel is never looked at", async () => {
    for (const reason of ["You pressed Esc, so I stopped.", "You moved the mouse, so I stopped and left it to you."]) {
      const w = world({ delivered: () => "maybe" });
      const t = fakeTool("do_thing", () => ({ ok: false, reason }), async () => confirmYes);
      const r = run(w, [t], [tool("do_thing", {}), done("ok")]);
      await r.session.handleTranscript("s", "go");
      expect(t.confirms, reason).toBe(0);
    }
  });
});

describe("the journal inside a real task", () => {
  it("records every step with its phase, acted and evidence, and none of the content", async () => {
    const w = world({ delivered: () => "yes" });
    const t = fakeTool("type_it", () => unverifiedOk({ target: { hwnd: 20, pid: 20 } }), async () => ({ verified: null, evidence: [] }));
    const r = run(w, [t], [tool("type_it", { label: "Password box", text: CANARY }), done("ok")]);
    await r.session.handleTranscript("s", `type ${CANARY}`);
    const j = r.session.orchestrator.journal();
    expect(j.length).toBe(1);
    expect(j[0]).toMatchObject({ tool: "type_it", acted: "yes", phase: "unconfirmed", argKeys: ["label", "text"] });
    expect(JSON.stringify(j)).not.toContain(CANARY);
    expect(JSON.stringify(j)).not.toContain("Password box");
  });
  it("never holds more than 50 steps however long the task runs", async () => {
    const w = world();
    const t = fakeTool("peek", () => ({ ok: true, brief: "ok", report: "x", verified: true }), undefined, "read");
    const script: PlanDecision[] = [];
    for (let i = 0; i < 70; i++) script.push(tool("peek", { label: `n${i}` }));
    script.push(done("ok"));
    const events: RuntimeEvent[] = [];
    const ai: AiService = { ready: () => true, label: () => "T", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }), polish: async () => ({ ok: false, reason: "disabled", message: "off" }), async plan() { return { ok: true, decision: script.shift()!, source: "T" }; } };
    const session = new Session({ ...(w.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, cursorLeadMs: () => 0, maxSteps: 80 } as never);
    session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
    (session.orchestrator as unknown as { tools: ToolDef[] }).tools.push(t.def);
    await session.handleTranscript("s", "go");
    const j = session.orchestrator.journal();
    expect(j.length).toBe(50);
    expect(j[49].seq).toBeGreaterThanOrEqual(60);
  });
  it("a new task starts a new journal (the old one is gone)", async () => {
    const w = world();
    const t = fakeTool("peek", () => ({ ok: true, brief: "ok", report: "x", verified: true }), undefined, "read");
    const r = run(w, [t], [tool("peek", {}), done("ok")]);
    await r.session.handleTranscript("s", "first");
    expect(r.session.orchestrator.journal().length).toBe(1);
    await r.session.handleTranscript("s2", "second");
    expect(r.session.orchestrator.journal().length).toBeLessThanOrEqual(1);
  });
});
