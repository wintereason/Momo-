import { describe, expect, it } from "vitest";
import { Session } from "./session";
import type { PlanDecision, PlanStep } from "./ai/prompts";
import type { AiService } from "./ai/service";
import type { RuntimeEvent } from "../../types/runtime-events";
import type { ActResult, FsPort, InputPort, LaunchPort, PointerPort, PointerResult, RawWindow, ScreenPort, UiNode, WindowState } from "../shared/ports";

/**
 * The real mouse and keyboard, like a person: scroll, right click, drag and drop, shortcuts, window arrangement and the OCR fallback.
 * Each one must look first, act on one exact target, look again, and say "verified" only when the second look shows it.
 */

type Rect = { l: number; t: number; w: number; h: number };
const item = (name: string, rid: string, rect: Rect, type = "ListItem"): UiNode => ({ type, name, enabled: true, offscreen: false, rid, rect });
const explorer: RawWindow = { hwnd: 20, pid: 20, process: "explorer", title: "Documents - File Explorer", z: 0 };

function world(opts: { ui: (hwnd?: number) => UiNode[]; pointer?: Partial<PointerPort> | null; words?: Array<{ text: string; rect: Rect }>; extraWindows?: RawWindow[]; windows?: () => RawWindow[] }) {
  const calls: string[] = [];
  const reads: number[] = [];
  const input: InputPort = {
    focusWindow: async (): Promise<ActResult> => ({ ok: true }), minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async (): Promise<WindowState> => ({ exists: true, minimized: false, pid: 20, foregroundPid: 20 }),
    invokeControl: async (): Promise<ActResult> => ({ ok: true }), setControlText: async () => ({ ok: true, readBack: "" }),
  };
  const screen: ScreenPort = {
    readUi: async (hwnd) => { reads.push(hwnd); return { ok: true, items: opts.ui(hwnd).map((n) => ({ ...n })), truncated: false }; },
    ocr: async () => ({ ok: true, lines: ["x"] }),
    ocrWords: async () => ({ ok: true, words: opts.words ?? [] }),
  };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  const base: PointerPort = {
    click: async (x, y, o) => { calls.push(`click:${x},${y}:${o.button ?? "left"}`); return { ok: true }; },
    press: async (k) => { calls.push(`press:${k}`); return { ok: true }; },
    type: async () => ({ ok: true }), windowAt: () => 20, windowRect: () => ({ l: 0, t: 0, w: 1000, h: 800 }),
  };
  const pointer = opts.pointer === null ? undefined : { ...base, ...opts.pointer } as PointerPort;
  const wrapped = pointer && {
    ...pointer,
    scroll: pointer.scroll && (async (...a: Parameters<NonNullable<PointerPort["scroll"]>>) => { calls.push(`scroll:${a[2]}`); return pointer.scroll!(...a); }),
    drag: pointer.drag && (async (...a: Parameters<NonNullable<PointerPort["drag"]>>) => { calls.push(`drag:${a[0].x},${a[0].y}->${a[1].x},${a[1].y}`); return pointer.drag!(...a); }),
  } as PointerPort;
  return {
    calls,
    reads,
    deps: {
      fs, input, screen, launch, act: { openPath: async () => "" }, apps: { list: async () => [] },
      win: { query: async () => ({ processes: undefined, activePid: 20, activeHwnd: 20, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 } as RawWindow, explorer, ...(opts.windows ? opts.windows() : opts.extraWindows ?? [])] }) },
      pointer: () => wrapped,
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
const tool = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
const done = (answer: string): PlanDecision => ({ type: "done", answer });
const lastTool = (r: PlanStep[][]) => { const s = r[r.length - 1]; const t = s[s.length - 1]; return t.kind === "tool" ? t : null; };
const taskId = (events: RuntimeEvent[]): string => (events.filter((e) => "taskId" in e).pop() as { taskId: string }).taskId;
const ok2 = { ok: true } as PointerResult;

describe("scroll_window", () => {
  it("scrolls with the real wheel and is verified only because the screen then shows other things", async () => {
    let scrolled = false;
    const w = world({
      ui: () => (scrolled ? [item("Zebra.docx", "c", { l: 100, t: 200, w: 300, h: 30 })] : [item("Apple.docx", "a", { l: 100, t: 200, w: 300, h: 30 })]),
      pointer: { scroll: async () => { scrolled = true; return ok2; } },
    });
    const t = run(w, [tool("scroll_window", { direction: "down", amount: 4 }), done("ok")]);
    await t.session.handleTranscript("s", "scroll down");
    expect(w.calls).toContain("scroll:4");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
    expect(lastTool(t.results)!.text).toMatch(/what is on screen changed/);
  });
  it("when the screen did not move (the end of the list) it does NOT claim it scrolled", async () => {
    const w = world({ ui: () => [item("Apple.docx", "a", { l: 100, t: 200, w: 300, h: 30 })], pointer: { scroll: async () => ok2 } });
    const t = run(w, [tool("scroll_window", { direction: "down" }), done("ok")]);
    await t.session.handleTranscript("s", "scroll down");
    expect(lastTool(t.results)!.text).toMatch(/could not confirm/);
  });
  it("with Human-like control off it does nothing and says why", async () => {
    const w = world({ ui: () => [], pointer: null });
    const t = run(w, [tool("scroll_window", { direction: "down" }), done("ok")]);
    await t.session.handleTranscript("s", "scroll down");
    expect(lastTool(t.results)!.text).toMatch(/Human-like control/);
    expect(w.calls).toEqual([]);
  });
  it("the user taking the mouse stops it, and it says so", async () => {
    const w = world({ ui: () => [], pointer: { scroll: async () => ({ ok: false, reason: "user_moved" }) } });
    const t = run(w, [tool("scroll_window", { direction: "up" }), done("ok")]);
    await t.session.handleTranscript("s", "scroll up");
    expect(lastTool(t.results)!.text).toMatch(/moved the mouse/);
  });
});

describe("right_click", () => {
  it("right-clicks the exact item and confirms only when a menu really appeared", async () => {
    let clicked = false;
    const file = item("Report.docx", "f1", { l: 100, t: 200, w: 300, h: 30 });
    const w = world({
      ui: () => (clicked ? [file, item("Open", "m1", { l: 120, t: 240, w: 100, h: 24 }, "MenuItem"), item("Delete", "m2", { l: 120, t: 264, w: 100, h: 24 }, "MenuItem")] : [file]),
      pointer: { click: async (x, y, o) => { w.calls.push(`click:${x},${y}:${o.button ?? "left"}`); clicked = true; return ok2; } },
    });
    const t = run(w, [tool("right_click", { label: "Report.docx" }), done("ok")]);
    await t.session.handleTranscript("s", "right click the report");
    expect(w.calls).toContain("click:250,215:right");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
    expect(lastTool(t.results)!.text).toMatch(/menu or something new appeared/);
  });
  it("reads only the menu window after a right-click, so confirming it does not re-read the whole app", async () => {
    let clicked = false;
    const file = item("Report.docx", "f1", { l: 100, t: 200, w: 300, h: 30 });
    const menu = [item("Open", "m1", { l: 120, t: 240, w: 100, h: 24 }, "MenuItem"), item("Delete", "m2", { l: 120, t: 264, w: 100, h: 24 }, "MenuItem")];
    const w = world({
      ui: (hwnd) => (hwnd === 55 ? menu : [file]),
      pointer: { click: async () => { clicked = true; return ok2; }, windowAt: () => (clicked ? 55 : 20) },
    });
    const t = run(w, [tool("right_click", { label: "Report.docx" }), done("ok")]);
    await t.session.handleTranscript("s", "right click the report");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
    expect(lastTool(t.results)!.text).toMatch(/menu appeared with 2 entries/);
    expect(w.reads.filter((h) => h === 20)).toHaveLength(1); // the Explorer window was read once, before the click
    expect(w.reads).toContain(55); // and the menu window was read on its own
  });
  it("asks which one when two items match, and never guesses", async () => {
    const w = world({ ui: () => [item("Report.docx", "a", { l: 100, t: 200, w: 300, h: 30 }), item("Report.docx", "b", { l: 100, t: 400, w: 300, h: 30 })] });
    const t = run(w, [tool("right_click", { label: "Report.docx" }), done("ok")]);
    await t.session.handleTranscript("s", "right click report");
    expect(t.events.some((e) => e.type === "task.clarification_required")).toBe(true);
    expect(w.calls.some((c) => c.startsWith("click:"))).toBe(false);
  });
});

describe("drag_drop", () => {
  const file = item("Notes.txt", "f", { l: 100, t: 200, w: 200, h: 30 });
  const folder = item("Archive", "d", { l: 100, t: 300, w: 200, h: 30 });
  it("always asks first; then drags from the file to the folder and is verified because the file left the list", async () => {
    let dropped = false;
    const w = world({ ui: () => (dropped ? [folder] : [file, folder]), pointer: { drag: async () => { dropped = true; return ok2; } } });
    const t = run(w, [tool("drag_drop", { from: "Notes.txt", to: "Archive" }), done("ok")]);
    await t.session.handleTranscript("s", "move notes into archive");
    expect(t.events.some((e) => e.type === "task.confirmation_required")).toBe(true);
    expect(w.calls.some((c) => c.startsWith("drag:"))).toBe(false); // nothing was dragged before the user said yes
    await t.session.respondConfirmation(taskId(t.events), true);
    expect(w.calls).toContain("drag:200,215->200,315");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
    expect(lastTool(t.results)!.text).toMatch(/no longer where it was/);
  });
  it("saying no drags nothing", async () => {
    const w = world({ ui: () => [file, folder], pointer: { drag: async () => ok2 } });
    const t = run(w, [tool("drag_drop", { from: "Notes.txt", to: "Archive" }), done("ok")]);
    await t.session.handleTranscript("s", "move notes");
    await t.session.respondConfirmation(taskId(t.events), false);
    expect(w.calls.some((c) => c.startsWith("drag:"))).toBe(false);
  });
  it("if the file is still listed afterwards it is NOT reported as moved", async () => {
    const w = world({ ui: () => [file, folder], pointer: { drag: async () => ok2 } });
    const t = run(w, [tool("drag_drop", { from: "Notes.txt", to: "Archive" }), done("ok")]);
    await t.session.handleTranscript("s", "move notes");
    await t.session.respondConfirmation(taskId(t.events), true);
    expect(lastTool(t.results)!.text).toMatch(/cannot confirm it moved/);
  });
});

describe("press_keys", () => {
  it("never presses keys that lock the PC or open the Run box", async () => {
    const w = world({ ui: () => [] });
    const t = run(w, [tool("press_keys", { keys: "win+l" }), done("ok")]);
    await t.session.handleTranscript("s", "lock");
    expect(w.calls).toEqual([]);
    expect(lastTool(t.results)!.text).toMatch(/will not press/);
  });
  it("asks before shortcuts that close or delete, and does not press them until yes", async () => {
    const w = world({ ui: () => [] });
    const t = run(w, [tool("press_keys", { keys: "alt+f4" }), done("ok")]);
    await t.session.handleTranscript("s", "close it with the keyboard");
    expect(t.events.some((e) => e.type === "task.confirmation_required")).toBe(true);
    expect(w.calls.some((c) => c.startsWith("press:"))).toBe(false);
  });
  it("a harmless shortcut just runs, and success needs the screen to change", async () => {
    let found = false;
    const w = world({ ui: () => (found ? [item("Find", "x", { l: 700, t: 100, w: 200, h: 30 }, "Edit")] : []), pointer: { press: async (k) => { w.calls.push(`press:${k}`); found = true; return ok2; } } });
    const t = run(w, [tool("press_keys", { keys: "Ctrl+F" }), done("ok")]);
    await t.session.handleTranscript("s", "find");
    expect(w.calls).toContain("press:ctrl+f");
    expect(lastTool(t.results)!.text).toMatch(/screen changed/);
  });
  it("presses nothing while a password field has the cursor", async () => {
    const pw: UiNode = { ...item("Password", "p", { l: 100, t: 100, w: 200, h: 30 }, "Edit"), password: true, focused: true };
    const w = world({ ui: () => [pw] });
    const t = run(w, [tool("press_keys", { keys: "tab" }), done("ok")]);
    await t.session.handleTranscript("s", "tab");
    expect(w.calls).toEqual([]);
    expect(lastTool(t.results)!.text).toMatch(/password/);
  });
});

describe("arrange_window", () => {
  it("snaps with the keyboard and is verified from where Windows says the window now is", async () => {
    let rect: Rect = { l: 0, t: 0, w: 1000, h: 800 };
    const w = world({ ui: () => [], pointer: { windowRect: () => ({ ...rect }), press: async (k) => { w.calls.push(`press:${k}`); rect = { l: 0, t: 0, w: 500, h: 800 }; return ok2; } } });
    const t = run(w, [tool("arrange_window", { to: "left" }), done("ok")]);
    await t.session.handleTranscript("s", "snap left");
    expect(w.calls).toContain("press:win+left");
    expect(lastTool(t.results)!.text).toMatch(/snapped to the left half.*1000×800 → 500×800/);
  });
  it("a window that did not change is not reported as arranged", async () => {
    const w = world({ ui: () => [], pointer: {} });
    const t = run(w, [tool("arrange_window", { to: "maximize" }), done("ok")]);
    await t.session.handleTranscript("s", "maximize");
    expect(lastTool(t.results)!.text).toMatch(/cannot confirm/);
  });
});

describe("click_text (the OCR fallback)", () => {
  it("reads the words fresh and clicks the exact spot, then verifies from the screen", async () => {
    let clicked = false;
    const w = world({
      ui: () => (clicked ? [item("Opened", "o", { l: 0, t: 0, w: 10, h: 10 })] : []),
      words: [{ text: "Start", rect: { l: 400, t: 300, w: 60, h: 20 } }, { text: "Game", rect: { l: 470, t: 300, w: 60, h: 20 } }],
      pointer: { click: async (x, y) => { w.calls.push(`click:${x},${y}`); clicked = true; return ok2; } },
    });
    const t = run(w, [tool("click_text", { text: "Start Game" }), done("ok")]);
    await t.session.handleTranscript("s", "click start game");
    expect(w.calls).toContain("click:465,310"); // the middle of both words together
    expect(lastTool(t.results)!.text).toMatch(/found by reading the screen.*screen changed/);
  });
  it("asks which when the words appear twice", async () => {
    const w = world({ ui: () => [], words: [{ text: "Play", rect: { l: 100, t: 100, w: 40, h: 20 } }, { text: "Play", rect: { l: 500, t: 400, w: 40, h: 20 } }] });
    const t = run(w, [tool("click_text", { text: "Play" }), done("ok")]);
    await t.session.handleTranscript("s", "click play");
    expect(t.events.some((e) => e.type === "task.clarification_required")).toBe(true);
    expect(w.calls.some((c) => c.startsWith("click:"))).toBe(false);
  });
  it("does not click words that are not on screen", async () => {
    const w = world({ ui: () => [], words: [{ text: "Cancel", rect: { l: 100, t: 100, w: 40, h: 20 } }] });
    const t = run(w, [tool("click_text", { text: "Start" }), done("ok")]);
    await t.session.handleTranscript("s", "click start");
    expect(w.calls.some((c) => c.startsWith("click:"))).toBe(false);
    expect(lastTool(t.results)!.text).toMatch(/could not see the words/);
  });
  it("asks first for words like Delete", async () => {
    const w = world({ ui: () => [], words: [{ text: "Delete", rect: { l: 100, t: 100, w: 40, h: 20 } }] });
    const t = run(w, [tool("click_text", { text: "Delete" }), done("ok")]);
    await t.session.handleTranscript("s", "click delete");
    expect(t.events.some((e) => e.type === "task.confirmation_required")).toBe(true);
    expect(w.calls.some((c) => c.startsWith("click:"))).toBe(false);
  });
});

describe("a new dialog is noticed", () => {
  it("a window that appears after a click is part of the evidence and is mentioned", async () => {
    let extra: RawWindow[] = [];
    const w = world({
      ui: () => [item("Report.docx", "f1", { l: 100, t: 200, w: 300, h: 30 })],
      windows: () => extra,
      pointer: { click: async () => { extra = [{ hwnd: 77, pid: 77, process: "explorer", title: "Context menu", z: 1 }]; return ok2; } },
    });
    const t = run(w, [tool("right_click", { label: "Report.docx" }), done("ok")]);
    await t.session.handleTranscript("s", "right click");
    expect(lastTool(t.results)!.text).toMatch(/A new window appeared: “Context menu”/);
  });
});
