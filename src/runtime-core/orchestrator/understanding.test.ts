import { describe, expect, it } from "vitest";
import { Session } from "./session";
import type { PlanDecision, PlanStep } from "./ai/prompts";
import type { AiService } from "./ai/service";
import type { RuntimeEvent } from "../../types/runtime-events";
import type { ActResult, FsPort, InputPort, LaunchPort, OcrResult, RawWindow, ScreenPort, SubmitResult, UiNode, WindowState } from "../shared/ports";

/**
 * Understanding what controls are FOR: the tools that explain a window, the check before touching a control, and the check afterwards.
 * Runs on a small fake PC (a File Explorer-like window).
 */

const win: RawWindow = { hwnd: 10, pid: 10, process: "explorer", title: "Project 2 - File Explorer" };
const node = (o: Partial<UiNode>): UiNode => ({ type: "Button", name: "", enabled: true, offscreen: false, rid: "r" + Math.random().toString(36).slice(2, 7), rect: { l: 100, t: 100, w: 100, h: 30 }, ...o });
const pane = node({ type: "Pane", name: "", rid: undefined, rect: { l: 0, t: 0, w: 1920, h: 1000 } });

function pc(initial: UiNode[], o: { ocr?: (rect: { l: number; t: number }) => string[]; onInvoke?: (rid: string, ui: UiNode[]) => void; ai?: Partial<AiService> } = {}) {
  const log: string[] = [];
  const ui = initial.map((n) => ({ ...n }));
  const input: InputPort = {
    focusWindow: async () => ({ ok: true }), minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async (): Promise<WindowState> => ({ exists: true, minimized: false, pid: 10, foregroundPid: 10 }),
    invokeControl: async (_h, rid, name): Promise<ActResult> => { log.push(`invoke:${name || rid}`); o.onInvoke?.(rid, ui); return { ok: true }; },
    setControlText: async () => ({ ok: true, readBack: "" }),
    focusControl: async (_h, rid, name): Promise<ActResult> => { log.push(`focus:${name}`); ui.forEach((n) => { n.focused = n.rid === rid; }); return { ok: true }; },
    submitControl: async (_h, _rid, name): Promise<SubmitResult> => { log.push(`enter:${name}`); return { ok: true, changed: true }; },
  };
  const screen: ScreenPort = {
    readUi: async () => ({ ok: true, items: ui.map((i) => ({ ...i })), truncated: false }),
    ocr: async () => ({ ok: false, reason: "no" }),
    ocrRegion: async (_h, r): Promise<OcrResult> => { log.push(`ocr:${r.l},${r.t}`); return { ok: true, lines: o.ocr ? o.ocr(r) : [] }; },
    capture: async () => { log.push("capture"); return { ok: true, png: "AAAA", width: 10, height: 10 }; },
  };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  return {
    log, ui,
    deps: { fs, input, screen, launch, apps: { list: async () => [] }, act: { openPath: async () => "" }, win: { query: async () => ({ activePid: 10, activeHwnd: 10, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo" }, win] }) } },
    ai: o.ai,
  };
}

function run(p: ReturnType<typeof pc>, script: PlanDecision[]) {
  const events: RuntimeEvent[] = [];
  const results: PlanStep[][] = [];
  let i = 0;
  const ai: AiService = {
    ready: () => true, label: () => "TestAI", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_g, steps) { results.push(JSON.parse(JSON.stringify(steps))); return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "TestAI" }; },
    ...p.ai,
  };
  const session = new Session({ ...(p.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, verifyAttempts: 2 } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  return { session, events, results, last: () => events[events.length - 1] };
}
const tool = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
const done = (answer: string): PlanDecision => ({ type: "done", answer });
const lastStep = (r: PlanStep[][]) => { const s = r[r.length - 1]; const t = s[s.length - 1]; return t.kind === "tool" ? t : null; };

const searchBox = node({ type: "Edit", name: "Search Project 2", rid: "q", patterns: ["value"], rect: { l: 1500, t: 100, w: 300, h: 40 } });
const addressBox = node({ type: "Edit", name: "Address Bar", rid: "a", patterns: ["value"], rect: { l: 300, t: 100, w: 900, h: 40 } });
const iconOnly = node({ type: "Button", name: "", rid: "icon", rect: { l: 1850, t: 20, w: 32, h: 32 } });
const sort = node({ type: "Button", name: "Sort", rid: "sort", patterns: ["invoke", "expandcollapse"], expanded: "collapsed", rect: { l: 600, t: 180, w: 80, h: 36 } });
const darkMode = node({ type: "CheckBox", name: "Dark mode", rid: "dm", state: "off", patterns: ["toggle"], rect: { l: 100, t: 400, w: 200, h: 30 } });

describe("understand_screen", () => {
  it("says WHAT each search box searches, flags the control it cannot explain, and reads that one's picture on this PC", async () => {
    const p = pc([pane, searchBox, addressBox, iconOnly, sort], { ocr: (r) => (r.l < 1900 && r.l > 1800 ? ["Settings"] : []) });
    const t = run(p, [tool("understand_screen"), done("ok")]);
    await t.session.handleTranscript("s", "what is on screen");
    const text = lastStep(t.results)!.text;
    expect(text).toMatch(/search box.*Search Project 2.*searches: files and folders inside “Project 2”/);
    expect(text).toMatch(/address box.*Address Bar/);
    expect(text).toMatch(/Sort.*opens a menu/);
    expect(text).toMatch(/opens settings or options \(reads “Settings”\)/); // the unlabeled icon was read by OCR
    expect(text).toMatch(/ocr/); // and the answer says it came from a picture
    expect(p.log.filter((l) => l.startsWith("ocr:"))).toHaveLength(1); // only the one control that needed it
  });
  it("an unlabeled control nothing explains stays UNKNOWN and shows a ref to inspect it by", async () => {
    const p = pc([pane, iconOnly]);
    const t = run(p, [tool("understand_screen", { only: "unclear" }), done("ok")]);
    await t.session.handleTranscript("s", "what is unclear");
    const text = lastStep(t.results)!.text;
    expect(text).toMatch(/purpose UNKNOWN/);
    expect(text).toMatch(/\[ref 1850,20\]/);
  });
});

describe("before touching a control, Momo knows what it is for", () => {
  it("never clicks an unlabeled control on a guess: it asks, saying what it could and could not find out", async () => {
    const p = pc([pane, iconOnly]);
    const t = run(p, [tool("click_control", { ref: "1850,20" }), done("ok")]);
    await t.session.handleTranscript("s", "click that icon");
    expect(t.last()).toMatchObject({ type: "task.confirmation_required", summary: expect.stringMatching(/isn't sure what it does/) });
    expect(p.log.some((l) => l.startsWith("invoke:"))).toBe(false);
  });
  it("even when OCR names it, a picture alone is not enough to click without the user's OK", async () => {
    const p = pc([pane, iconOnly], { ocr: () => ["Settings"] });
    const t = run(p, [tool("click_control", { ref: "1850,20" }), done("ok")]);
    await t.session.handleTranscript("s", "click that icon");
    expect(t.last()).toMatchObject({ type: "task.confirmation_required" });
    expect(p.log.some((l) => l.startsWith("invoke:"))).toBe(false);
    await t.session.respondConfirmation((t.last() as { taskId: string }).taskId, true); // the user agrees
    expect(p.log.some((l) => l.startsWith("invoke:"))).toBe(true);
  });
  it("a labeled control with a clear purpose is just clicked, and the answer says what it was understood to be", async () => {
    const p = pc([pane, sort], { onInvoke: (rid, ui) => { const n = ui.find((x) => x.rid === rid)!; n.expanded = "expanded"; } });
    const t = run(p, [tool("click_control", { label: "Sort" }), done("ok")]);
    await t.session.handleTranscript("s", "click sort");
    const s = lastStep(t.results)!;
    expect(s.outcome).toBe("ok");
    expect(s.text).toMatch(/it reports being expanded now/);
    expect(s.text).toMatch(/Momo understood it as: opens a menu/);
  });
});

describe("after touching it, the SPECIFIC expected effect is checked", () => {
  it("a menu button that opened nothing is reported as not confirmed, even if something else on screen changed", async () => {
    const p = pc([pane, sort, node({ type: "Text", name: "clock", rid: undefined })], { onInvoke: (_rid, ui) => { ui[2].name = "clock 12:01"; } });
    const t = run(p, [tool("click_control", { label: "Sort" }), done("ok")]);
    await t.session.handleTranscript("s", "click sort");
    const s = lastStep(t.results)!;
    expect(s.outcome).toBe("unverified");
    expect(s.text).toMatch(/what it should do did not happen \(no menu or list opened\)/);
  });
  it("a switch is verified only if it really flipped", async () => {
    const flips = pc([pane, darkMode], { onInvoke: (rid, ui) => { const n = ui.find((x) => x.rid === rid)!; n.state = "on"; } });
    const a = run(flips, [tool("click_control", { label: "Dark mode" }), done("ok")]);
    await a.session.handleTranscript("s", "turn on dark mode");
    expect(lastStep(a.results)!.outcome).toBe("ok");
    expect(lastStep(a.results)!.text).toMatch(/it was off and is now on/);
    const stuck = pc([pane, darkMode], { onInvoke: (_rid, ui) => { ui.push(node({ type: "Text", name: "toast", rid: undefined })); } });
    const b = run(stuck, [tool("click_control", { label: "Dark mode" }), done("ok")]);
    await b.session.handleTranscript("s", "turn on dark mode");
    expect(lastStep(b.results)!.outcome).toBe("unverified");
  });
});

describe("several search boxes: which one searches what", () => {
  it("asks which one, and describes each by what it searches", async () => {
    const web = node({ type: "Edit", name: "Search", rid: "w", panel: "Sidebar", rect: { l: 600, t: 10, w: 500, h: 30 } });
    const p = pc([pane, searchBox, web]);
    const t = run(p, [tool("select_field", { label: "search bar" }), done("ok")]);
    await t.session.handleTranscript("s", "select the search bar");
    const q = t.last() as { type: string; question: string; options?: { label: string; detail?: string }[] };
    expect(q.type).toBe("task.clarification_required");
    const details = (q.options ?? []).map((o) => o.detail ?? "").join(" | ");
    expect(details).toMatch(/searches: files and folders inside “Project 2”/);
    expect(details).toMatch(/searches: what is inside “Sidebar”/); // the second one is told apart by where it sits
    expect(p.log.filter((l) => l.startsWith("focus:"))).toEqual([]);
  });
  it("selecting one search box says what it searches", async () => {
    const p = pc([pane, searchBox]);
    const t = run(p, [tool("select_field", { label: "search" }), done("ok")]);
    await t.session.handleTranscript("s", "select the search bar");
    expect(lastStep(t.results)!.text).toMatch(/searches: files and folders inside “Project 2”/);
  });
  it("Enter runs at once only in a box that was UNDERSTOOD to be a search box; anywhere else it asks", async () => {
    const focusedSearch = { ...searchBox, focused: true };
    const a = pc([pane, focusedSearch]);
    const ta = run(a, [tool("press_enter"), done("ok")]);
    await ta.session.handleTranscript("s", "search");
    expect(a.log).toContain("enter:Search Project 2");
    const msg = node({ type: "Edit", name: "Type a message", rid: "m", focused: true, patterns: ["value"], rect: { l: 100, t: 900, w: 800, h: 40 } });
    const b = pc([pane, msg]);
    const tb = run(b, [tool("press_enter"), done("ok")]);
    await tb.session.handleTranscript("s", "send it");
    expect(tb.last()).toMatchObject({ type: "task.confirmation_required" });
    expect(b.log.some((l) => l.startsWith("enter:"))).toBe(false);
  });
});

describe("inspect_component and the visual AI", () => {
  const vision = (answer: { confident: boolean; purpose: string; kind?: string }, calls: string[]): Partial<AiService> => ({
    canSeeImages: () => true, visionLabel: () => "TestVision",
    describeImage: async (png) => { calls.push(png); return { ok: true, answer: { kind: answer.kind ?? "icon_button", purpose: answer.purpose, scope: null, confident: answer.confident, seen: "a gear" }, source: "TestVision" }; },
  });
  it("reads the picture on this PC first, and says honestly when it still cannot tell", async () => {
    const p = pc([pane, iconOnly]);
    const t = run(p, [tool("inspect_component", { ref: "1850,20" }), done("ok")]);
    await t.session.handleTranscript("s", "what is that icon");
    const text = lastStep(t.results)!.text;
    expect(text).toMatch(/purpose UNKNOWN/);
    expect(text).toMatch(/Momo does not know what this is for: ask the user/);
    expect(p.log).not.toContain("capture"); // no picture was taken or sent
  });
  it("with visual:true but no visual AI available, it says so and sends nothing", async () => {
    const p = pc([pane, iconOnly]);
    const t = run(p, [tool("inspect_component", { ref: "1850,20", visual: true }), done("ok")]);
    await t.session.handleTranscript("s", "what is that icon");
    expect(lastStep(t.results)!.text).toMatch(/no visual AI is available/);
    expect(p.log).not.toContain("capture");
  });
  it("shows the picture to a visual AI ONLY after the user agrees, and records the answer as 'from a picture'", async () => {
    const sent: string[] = [];
    const p = pc([pane, iconOnly], { ai: vision({ confident: true, purpose: "a gear icon that opens settings" }, sent) });
    const t = run(p, [tool("inspect_component", { ref: "1850,20", visual: true }), done("ok")]);
    await t.session.handleTranscript("s", "what is that icon");
    expect(t.last()).toMatchObject({ type: "task.confirmation_required", summary: expect.stringMatching(/small picture of just this one control.*TestVision.*leaves this PC/) });
    expect(sent).toEqual([]); // nothing sent yet
    expect(p.log).not.toContain("capture");
    await t.session.respondConfirmation((t.last() as { taskId: string }).taskId, true);
    expect(sent).toEqual(["AAAA"]);
    const text = lastStep(t.results)!.text;
    expect(text).toMatch(/gear icon that opens settings/);
    expect(text).toMatch(/vision/);
    expect(text).toMatch(/NOT SURE|fairly sure/); // never "sure" from a picture alone
  });
  it("declining sends nothing", async () => {
    const sent: string[] = [];
    const p = pc([pane, iconOnly], { ai: vision({ confident: true, purpose: "x" }, sent) });
    const t = run(p, [tool("inspect_component", { ref: "1850,20", visual: true }), done("ok")]);
    await t.session.handleTranscript("s", "what is that icon");
    await t.session.respondConfirmation((t.last() as { taskId: string }).taskId, false);
    expect(sent).toEqual([]);
    expect(p.log).not.toContain("capture");
  });
  it("a visual AI that is not confident adds no purpose", async () => {
    const sent: string[] = [];
    const p = pc([pane, iconOnly], { ai: vision({ confident: false, purpose: "maybe something" }, sent) });
    const t = run(p, [tool("inspect_component", { ref: "1850,20", visual: true }), done("ok")]);
    await t.session.handleTranscript("s", "what is that icon");
    await t.session.respondConfirmation((t.last() as { taskId: string }).taskId, true);
    expect(lastStep(t.results)!.text).toMatch(/could not tell either/);
    expect(lastStep(t.results)!.text).toMatch(/purpose UNKNOWN/);
  });
});
