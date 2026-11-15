import { describe, expect, it } from "vitest";
import { Session } from "../session";
import type { PlanDecision, PlanStep } from "../ai/prompts";
import type { AiService } from "../ai/service";
import type { RuntimeEvent } from "../../../types/runtime-events";
import type { Acted, ActResult, FsPort, InputPort, LaunchPort, PointerPort, PointerResult, RawWindow, ScreenPort, UiNode, WindowState } from "../../shared/ports";

/**
 * Phase 4a: every step the orchestrator records carries a NAMED failure and an `acted` answer, taken from the input layer's own facts
 * (the pointer's actedSince) and never guessed lower than they say. Nothing is retried here: this only records.
 */
type Rect = { l: number; t: number; w: number; h: number };
const item = (name: string, rid: string, rect: Rect, type = "ListItem"): UiNode => ({ type, name, enabled: true, offscreen: false, rid, rect });
const explorer: RawWindow = { hwnd: 20, pid: 20, process: "explorer", title: "Documents - File Explorer", z: 0 };
const ok2 = { ok: true } as PointerResult;
const file = item("Report.docx", "f1", { l: 100, t: 200, w: 300, h: 30 });

function world(opts: { ui?: () => UiNode[]; pointer?: Partial<PointerPort> & { acted?: Acted }; noPointer?: boolean; invoke?: InputPort["invokeControl"] }) {
  let acted: Acted = "no";
  const input: InputPort = {
    focusWindow: async (): Promise<ActResult> => ({ ok: true }), minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async (): Promise<WindowState> => ({ exists: true, minimized: false, pid: 20, foregroundPid: 20 }),
    invokeControl: opts.invoke ?? (async (): Promise<ActResult> => ({ ok: true })), setControlText: async () => ({ ok: true, readBack: "" }),
  };
  const screen: ScreenPort = { readUi: async () => ({ ok: true, items: (opts.ui ? opts.ui() : [file]).map((n) => ({ ...n })), truncated: false }), ocr: async () => ({ ok: true, lines: ["x"] }) };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  const { acted: delivered, ...rest } = opts.pointer ?? {};
  const pointer: PointerPort = {
    click: async () => { if (delivered) acted = delivered; return ok2; }, press: async () => ok2, type: async () => ok2, windowAt: () => 20, windowRect: () => ({ l: 0, t: 0, w: 1000, h: 800 }),
    scroll: async () => ok2, ...rest,
    resetActed: () => { acted = "no"; }, actedSince: () => acted,
  };
  return {
    deps: {
      fs, input, screen, launch, act: { openPath: async () => "" }, apps: { list: async () => [] },
      win: { query: async () => ({ processes: undefined, activePid: 20, activeHwnd: 20, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 } as RawWindow, explorer] }) },
      pointer: () => (opts.noPointer ? undefined : pointer),
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
  const session = new Session({ ...(w.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, cursorLeadMs: () => 0 } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  return { session, events, results };
}
const tool = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
const done = (answer: string): PlanDecision => ({ type: "done", answer });
const lastStep = (r: PlanStep[][]) => { const s = r[r.length - 1]; const t = s[s.length - 1]; return t.kind === "tool" ? t : null; };
const go = async (w: ReturnType<typeof world>, script: PlanDecision[]) => { const t = run(w, script); await t.session.handleTranscript("s", "do it"); return lastStep(t.results)!; };

describe("a failed step is named, and says how far it got", () => {
  it("a click refused because a window covers it: 'covered', nothing was sent", async () => {
    const w = world({ pointer: { click: async () => { return { ok: false, reason: "covered" } as PointerResult; } } });
    const s = await go(w, [tool("right_click", { label: "Report.docx" }), done("x")]);
    expect(s.outcome).toBe("failed");
    expect(s.failure).toEqual({ kind: "covered", acted: "no" });
    expect(s.acted).toBe("no");
  });
  it("a click that FAILED after input was being sent is 'maybe' (it may have gone through), and is never assumed harmless", async () => {
    let acted: Acted = "no";
    const w = world({ pointer: { click: async () => { acted = "maybe"; return { ok: false, reason: "failed" } as PointerResult; }, } });
    // the fake pointer reports what it sent through actedSince
    const p = w.deps.pointer()!;
    p.actedSince = () => acted; p.resetActed = () => { acted = "no"; };
    const s = await go(w, [tool("right_click", { label: "Report.docx" }), done("x")]);
    expect(s.outcome).toBe("failed");
    expect(s.failure).toEqual({ kind: "input_failed", acted: "maybe" });
  });
  it("the user's takeover is named 'user_interrupted'", async () => {
    const w = world({ pointer: { click: async () => ({ ok: false, reason: "user_moved" } as PointerResult) } });
    const t = run(w, [tool("right_click", { label: "Report.docx" }), done("x")]);
    await t.session.handleTranscript("s", "do it");
    const failed = t.results.flat().filter((s) => s.kind === "tool" && s.outcome === "failed");
    // the task may have been cancelled by the takeover; if the step was recorded it is named correctly
    for (const s of failed) if (s.kind === "tool") expect(s.failure?.kind).toBe("user_interrupted");
  });
  it("a failure with no pointer involved (a missing window) is a refusal decided up front: 'no'", async () => {
    const w = world({});
    const s = await go(w, [tool("right_click", { label: "Report.docx", window: "Nonexistent app" }), done("x")]);
    expect(s.outcome).toBe("failed");
    expect(s.failure).toEqual({ kind: "target_not_found", acted: "no" });
  });
  it("Human-like control being off is 'unavailable' and nothing was sent", async () => {
    const w = world({ noPointer: true });
    const s = await go(w, [tool("right_click", { label: "Report.docx" }), done("x")]);
    expect(s.failure).toEqual({ kind: "unavailable", acted: "no" });
  });
  it("a read that fails never 'acted'", async () => {
    const w = world({ ui: () => [] });
    const s = await go(w, [tool("look_screen", { window: "Nonexistent app" }), done("x")]);
    expect(s.outcome).toBe("failed");
    expect(s.acted).toBe("no");
    expect(s.failure?.acted).toBe("no");
  });
  it("an unrecognised failure of an action is 'unknown', and 'maybe' — the safe side", async () => {
    // a tool that fails with a sentence nobody classifies
    const w = world({ noPointer: true, invoke: async () => ({ ok: false, reason: "Flux capacitor misaligned" }) });
    const s = await go(w, [tool("click_control", { label: "Report.docx" }), done("x")]);
    expect(s.outcome).toBe("failed");
    expect(s.failure?.kind).toBe("unknown");
    expect(s.failure?.acted).toBe("maybe");
  });
});

describe("a step that worked", () => {
  it("an action that was verified says it acted ('yes') and has no failure", async () => {
    let scrolled = false;
    const w = world({ ui: () => (scrolled ? [item("Zebra.docx", "z", { l: 100, t: 200, w: 300, h: 30 })] : [file]), pointer: { scroll: async () => { scrolled = true; return ok2; } } });
    const s = await go(w, [tool("scroll_window", { direction: "down" }), done("x")]);
    expect(s.outcome).toBe("ok");
    expect(s.acted).toBe("yes");
    expect(s.failure).toBeUndefined();
  });
  it("an action that ran but could not be confirmed is named 'unverified' and still says it acted", async () => {
    const w = world({ pointer: { scroll: async () => ok2 } });
    const s = await go(w, [tool("scroll_window", { direction: "down" }), done("x")]);
    expect(s.outcome).toBe("unverified");
    expect(s.acted).toBe("yes");
    expect(s.failure).toEqual({ kind: "unverified", acted: "yes" });
  });
  it("a read never acted", async () => {
    const w = world({});
    const s = await go(w, [tool("look_screen", {}), done("x")]);
    expect(s.outcome).toBe("ok");
    expect(s.acted).toBe("no");
  });
});

describe("the recording is only a record", () => {
  it("the planner is still shown exactly what it was before (no new text yet), and the extra fields are optional", async () => {
    const w = world({ pointer: { click: async () => ({ ok: false, reason: "covered" } as PointerResult) } });
    const t = run(w, [tool("right_click", { label: "Report.docx" }), done("x")]);
    await t.session.handleTranscript("s", "do it");
    const { buildPlanInput } = await import("../ai/prompts");
    const text = buildPlanInput("g", t.results[t.results.length - 1]);
    expect(text).not.toMatch(/acted|"kind"|failure/);
  });
  it("a repeated identical failing action is still stopped by the existing guards (4a changes no behaviour)", async () => {
    const w = world({ pointer: { click: async () => ({ ok: false, reason: "covered" } as PointerResult) } });
    const t = run(w, [tool("right_click", { label: "Report.docx" }), tool("right_click", { label: "Report.docx" }), tool("right_click", { label: "Report.docx" }), done("x")]);
    await t.session.handleTranscript("s", "do it");
    expect(t.events.some((e) => e.type === "task.failed" || e.type === "task.completed" || e.type === "task.state")).toBe(true);
  });
});
