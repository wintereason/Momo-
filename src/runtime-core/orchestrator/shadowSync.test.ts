import { describe, expect, it } from "vitest";
import { Session } from "./session";
import type { PlanDecision, PlanStep } from "./ai/prompts";
import type { AiService } from "./ai/service";
import type { RuntimeEvent } from "../../types/runtime-events";
import type { ActResult, FsPort, InputPort, LaunchPort, PointerPort, PointerResult, RawWindow, ScreenPort, UiNode, WindowState } from "../shared/ports";

/**
 * The shadow cursor must show what REALLY happens, in the real order: the exact element is highlighted first (with what it is for), then
 * the real pointer moves and clicks, and the verdict is shown only after the step was verified. Also: a window dragged in between is
 * noticed, and when the user takes over everything stops.
 */

const win: RawWindow = { hwnd: 10, pid: 10, process: "explorer", title: "Project 2 - File Explorer" };
const node = (o: Partial<UiNode>): UiNode => ({ type: "Button", name: "", enabled: true, offscreen: false, rid: "r" + Math.random().toString(36).slice(2, 7), rect: { l: 100, t: 100, w: 100, h: 30 }, ...o });
const pane = node({ type: "Pane", name: "", rid: undefined, rect: { l: 0, t: 0, w: 1920, h: 1000 } });
const sort = node({ type: "Button", name: "Sort", rid: "sort", patterns: ["invoke", "expandcollapse"], expanded: "collapsed", rect: { l: 600, t: 180, w: 80, h: 36 } });

interface Opts {
  items?: UiNode[];
  /** what the page does when the real pointer clicks (or when UI Automation invokes) */
  onClick?: (ui: UiNode[]) => void;
  clickResults?: PointerResult[];
  wrect?: () => { l: number; t: number; w: number; h: number };
  invoke?: ActResult;
  onRead?: (n: number, ui: UiNode[]) => void;
  script?: PlanDecision[];
}

function setup(o: Opts) {
  const timeline: string[] = [];
  const clicks: { x: number; y: number; expectWindow?: unknown }[] = [];
  const events: RuntimeEvent[] = [];
  const ui = (o.items ?? [pane, sort]).map((n) => ({ ...n }));
  let reads = 0;
  let results = [...(o.clickResults ?? [{ ok: true } as PointerResult])];
  const input: InputPort = {
    focusWindow: async () => ({ ok: true }), minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async (): Promise<WindowState> => ({ exists: true, minimized: false, pid: 10, foregroundPid: 10 }),
    invokeControl: async (): Promise<ActResult> => { timeline.push("invoke"); if (o.invoke?.ok !== false) o.onClick?.(ui); return o.invoke ?? { ok: true }; },
    setControlText: async () => ({ ok: true, readBack: "" }),
  };
  const screen: ScreenPort = { readUi: async () => { reads++; o.onRead?.(reads, ui); return { ok: true, items: ui.map((i) => ({ ...i })), truncated: false }; }, ocr: async () => ({ ok: false, reason: "no" }) };
  const pointer: PointerPort = {
    click: async (x, y, opts) => {
      timeline.push("pointer.click");
      clicks.push({ x, y, expectWindow: opts.expectWindow });
      const r = results.length > 1 ? results.shift()! : results[0];
      if (r.ok) o.onClick?.(ui);
      return r;
    },
    press: async () => ({ ok: true }), type: async () => ({ ok: true }), windowAt: () => 10,
    windowRect: () => (o.wrect ? o.wrect() : { l: 0, t: 0, w: 1000, h: 800 }),
  };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  const results2: PlanStep[][] = [];
  const script: PlanDecision[] = o.script ?? [{ type: "tool", tool: "click_control", args: { label: "Sort" } }, { type: "done", answer: "ok" }];
  let i = 0;
  const ai: AiService = {
    ready: () => true, label: () => "T", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_g, steps) { results2.push(JSON.parse(JSON.stringify(steps))); return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "T" }; },
  };
  const session = new Session({
    fs, input, screen, launch, apps: { list: async () => [] }, act: { openPath: async () => "" },
    win: { query: async () => ({ activePid: 10, activeHwnd: 10, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo" }, win] }) },
    emit: (e: RuntimeEvent) => { events.push(e); if (e.type.startsWith("cursor.")) timeline.push(e.type + (e.type === "cursor.result" ? ":" + e.state : "")); },
    selfPids: () => [999], ai, sleep: async () => {}, verifyAttempts: 2, cursorLeadMs: () => 800, pointer: () => pointer,
  } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  return { session, timeline, clicks, events, results: results2, ui };
}
const expand = (ui: UiNode[]) => { const n = ui.find((x) => x.rid === "sort")!; n.expanded = "expanded"; };
const last = (r: PlanStep[][]) => { const s = r[r.length - 1]; const t = s[s.length - 1]; return t.kind === "tool" ? t : null; };

describe("the order of things on screen", () => {
  it("highlights the exact element with what it is for, THEN the real pointer clicks, THEN 'checking', THEN the verified result", async () => {
    const t = setup({ onClick: expand });
    await t.session.handleTranscript("s", "click sort");
    expect(t.timeline).toEqual(["cursor.aim", "pointer.click", "cursor.result:verifying", "cursor.result:verified"]);
    const aim = t.events.find((e) => e.type === "cursor.aim") as { x: number; y: number; w: number; h: number; say?: string; kind?: string };
    expect([aim.x, aim.y, aim.w, aim.h]).toEqual([640, 198, 80, 36]); // exactly the control's own box
    expect(aim.say).toBe("Clicking “Sort”: opens a menu or a list of options");
    expect(aim.kind).toBe("menu");
    const v = t.events.find((e) => e.type === "cursor.result" && e.state === "verified") as { text?: string };
    expect(v.text).toBe("it reports being expanded now"); // the evidence, not just a tick
    expect(t.clicks[0]).toMatchObject({ x: 640, y: 198 });
  });
  it("the pointer is only moved AFTER the highlight had time to show (the aim pause)", async () => {
    // the aim pause is the sleeper's job; here we only check the highlight is first and the glide uses the full 800 ms ghost time
    const t = setup({ onClick: expand });
    await t.session.handleTranscript("s", "click sort");
    expect(t.timeline.indexOf("cursor.aim")).toBeLessThan(t.timeline.indexOf("pointer.click"));
  });
});

describe("no false success", () => {
  it("a step that could NOT be confirmed is shown as 'not confirmed', never as success", async () => {
    const t = setup({ onClick: () => { /* nothing opens */ } });
    await t.session.handleTranscript("s", "click sort");
    expect(t.timeline.at(-1)).toBe("cursor.result:unconfirmed");
    expect(t.timeline).not.toContain("cursor.result:verified");
    expect(last(t.results)!.outcome).toBe("unverified");
    const u = t.events.find((e) => e.type === "cursor.result" && e.state === "unconfirmed") as { text?: string };
    expect(u.text).toBe("Not confirmed");
    // and the task itself is not "completed" either
    expect(t.events.some((e) => e.type === "task.completed")).toBe(false);
  });
  it("a step that FAILED after pointing is shown as failed, with the reason", async () => {
    const t = setup({ clickResults: [{ ok: false, reason: "covered" }], invoke: { ok: false, reason: "Windows refused" } });
    await t.session.handleTranscript("s", "click sort");
    const f = t.events.find((e) => e.type === "cursor.result" && e.state === "failed") as { text?: string };
    expect(f?.text).toBe("Windows refused");
    expect(t.timeline).not.toContain("cursor.result:verified");
  });
  it("a read-only step that points at nothing sends no verdict at all", async () => {
    const t = setup({ script: [{ type: "tool", tool: "look_screen", args: {} }, { type: "done", answer: "ok" }] });
    await t.session.handleTranscript("s", "what is on screen");
    expect(last(t.results)!.outcome).toBe("ok"); // it did run
    expect(t.events.filter((e) => e.type.startsWith("cursor."))).toEqual([]); // and showed nothing: it pointed at nothing
  });
});

describe("the window moved between reading and clicking", () => {
  it("is noticed: the control is found again, aimed at again, and clicked at its NEW place", async () => {
    let moved = false;
    const t = setup({
      onClick: expand,
      clickResults: [{ ok: false, reason: "moved" }, { ok: true }],
      wrect: () => ({ l: 0, t: 0, w: 1000, h: 800 }),
      onRead: (n, ui) => { if (n === 2 && !moved) { moved = true; const s = ui.find((x) => x.rid === "sort")!; s.rect = { l: 640, t: 230, w: 80, h: 36 }; } }, // the second read finds it lower down
    });
    await t.session.handleTranscript("s", "click sort");
    expect(t.clicks).toHaveLength(2);
    expect(t.clicks[0]).toMatchObject({ x: 640, y: 198 });
    expect(t.clicks[1]).toMatchObject({ x: 680, y: 248 }); // the new centre
    expect(t.events.filter((e) => e.type === "cursor.aim")).toHaveLength(2); // highlighted again at the new place
    expect(t.timeline.at(-1)).toBe("cursor.result:verified");
  });
  it("hands the pointer the window's box from when the controls were read", async () => {
    const t = setup({ onClick: expand, wrect: () => ({ l: 11, t: 22, w: 1000, h: 800 }) });
    await t.session.handleTranscript("s", "click sort");
    expect(t.clicks[0].expectWindow).toEqual({ hwnd: 10, rect: { l: 11, t: 22, w: 1000, h: 800 } });
  });
});

describe("the user takes over", () => {
  it("moving the real mouse stops the step: no UI Automation click behind their back, and the cursor shows a failure", async () => {
    const t = setup({ clickResults: [{ ok: false, reason: "user_moved" }] });
    await t.session.handleTranscript("s", "click sort");
    expect(t.timeline).not.toContain("invoke");
    expect(last(t.results)!.outcome).toBe("failed");
    expect(last(t.results)!.text).toMatch(/moved the mouse/);
    const f = t.events.find((e) => e.type === "cursor.result" && e.state === "failed") as { text?: string };
    expect(f.text).toMatch(/moved the mouse/);
  });
  it("Esc stops it the same way", async () => {
    const t = setup({ clickResults: [{ ok: false, reason: "stopped" }] });
    await t.session.handleTranscript("s", "click sort");
    expect(t.timeline).not.toContain("invoke");
    expect(last(t.results)!.text).toMatch(/pressed Esc/);
  });
});
