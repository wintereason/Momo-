import { describe, expect, it } from "vitest";
import { Session } from "./session";
import type { PlanDecision, PlanStep } from "./ai/prompts";
import type { AiService } from "./ai/service";
import type { RuntimeEvent } from "../../types/runtime-events";
import type { ActResult, AppEntry, FsPort, InputPort, LaunchPort, PointerPort, PointerResult, RawWindow, ScreenPort, UiNode, WindowState } from "../shared/ports";

/**
 * Screen-aware, human-like control on a small fake PC: apps that are already running (in front, behind, minimized, several windows),
 * the real pointer (guarded, interruptible), and File Explorer navigation decided from what is on screen after every step.
 */

interface FakeWin extends RawWindow { minimized?: boolean; maximized?: boolean; z: number }

function pc(opts: { processes?: string[]; windows: FakeWin[]; ui?: (hwnd: number) => UiNode[]; pointer?: (calls: string[]) => PointerPort | undefined; apps?: AppEntry[]; pointerResult?: PointerResult }) {
  const log: string[] = [];
  const wins = opts.windows.map((w) => ({ ...w }));
  let fg = wins.find((w) => w.z === 0)?.hwnd ?? 0;
  const byHwnd = (h: number) => wins.find((w) => w.hwnd === h);
  const input: InputPort = {
    focusWindow: async (h): Promise<ActResult> => { log.push(`focus:${h}`); const w = byHwnd(h); if (!w) return { ok: false, reason: "gone" }; w.minimized = false; fg = h; wins.forEach((x) => { x.z = x.hwnd === h ? 0 : x.z + 1; }); return { ok: true }; },
    minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async (h): Promise<WindowState> => { const w = byHwnd(h); return { exists: !!w, minimized: !!w?.minimized, pid: w?.pid ?? 0, foregroundPid: byHwnd(fg)?.pid ?? null }; },
    invokeControl: async (_h, rid): Promise<ActResult> => { log.push(`invoke:${rid}`); return { ok: true }; },
    setControlText: async () => ({ ok: true, readBack: "" }),
  };
  const screen: ScreenPort = {
    readUi: async (h) => ({ ok: true, items: (opts.ui?.(h) ?? []).map((n) => ({ ...n })), truncated: false }),
    ocr: async () => ({ ok: false, reason: "no" }),
    taskbar: async () => [{ type: "Button", name: "Google Chrome - 1 running window", enabled: true, offscreen: false, rid: "tb1", rect: { l: 300, t: 1040, w: 48, h: 40 } }, { type: "Button", name: "Calculator", enabled: true, offscreen: false, rid: "tb2", rect: { l: 360, t: 1040, w: 48, h: 40 } }],
  };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async (id: string) => { log.push(`launch:${id}`); return { ok: true }; }, openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  const pointer = opts.pointer?.(log);
  return {
    log, wins, fgOf: () => fg,
    deps: {
      fs, input, screen, launch, act: { openPath: async () => "" },
      apps: { list: async () => opts.apps ?? [{ name: "Google Chrome", id: "chrome.id" }, { name: "Calculator", id: "calc.id" }, { name: "File Explorer", id: "explorer.id" }] },
      win: { query: async () => ({ processes: opts.processes, activePid: byHwnd(fg)?.pid ?? null, activeHwnd: fg, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 } as RawWindow, ...wins] }) },
      pointer: () => pointer,
    },
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
  };
  const session = new Session({ ...(p.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, verifyAttempts: 2 } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  return { session, events, results, last: () => events[events.length - 1] };
}
const tool = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
const done = (answer: string): PlanDecision => ({ type: "done", answer });
const lastStep = (r: PlanStep[][]) => { const s = r[r.length - 1]; const t = s[s.length - 1]; return t.kind === "tool" ? t : null; };

const chrome = (z: number, over: Partial<FakeWin> = {}): FakeWin => ({ hwnd: 20, pid: 20, process: "chrome", title: "Docs - Google Chrome", z, ...over });
const notepad = (z: number, over: Partial<FakeWin> = {}): FakeWin => ({ hwnd: 30, pid: 30, process: "notepad", title: "notes - Notepad", z, ...over });

describe("an app that is already running is not started twice", () => {
  it("restores a MINIMIZED window instead of launching another copy", async () => {
    const p = pc({ windows: [notepad(0), chrome(3, { minimized: true })] });
    const t = run(p, [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(p.log.some((l) => l.startsWith("launch:"))).toBe(false);
    expect(p.log).toContain("focus:20");
    expect(p.fgOf()).toBe(20);
    expect(lastStep(t.results)).toMatchObject({ outcome: "ok" });
    expect(lastStep(t.results)!.text).toMatch(/already running \(minimized\).*did not start another/);
  });
  it("brings a window forward that is BEHIND others", async () => {
    const p = pc({ windows: [notepad(0), chrome(2)] });
    const t = run(p, [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(p.log.some((l) => l.startsWith("launch:"))).toBe(false);
    expect(p.fgOf()).toBe(20);
    expect(lastStep(t.results)!.text).toMatch(/behind other windows/);
  });
  it("does nothing when it is already in front", async () => {
    const p = pc({ windows: [chrome(0), notepad(1)] });
    const t = run(p, [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(p.log).toEqual([]);
    expect(lastStep(t.results)!.text).toMatch(/already open and in front/);
  });
  it("with SEVERAL windows and none in front, it does not guess: it asks which, naming each with its state", async () => {
    const p = pc({ windows: [notepad(0), chrome(4, { hwnd: 21, pid: 20, title: "Mail - Google Chrome", minimized: true }), chrome(1)] });
    const t = run(p, [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    const q = t.last() as { type: string; question: string; options?: { label: string; detail?: string }[] };
    expect(q.type).toBe("task.clarification_required");
    expect(q.options!.map((o) => o.label)).toEqual(["Docs - Google Chrome", "Mail - Google Chrome"]); // front-most first
    expect(q.options!.map((o) => o.detail)).toEqual(["open behind other windows", "minimized"]);
    expect(p.log).toEqual([]); // nothing was touched, nothing launched
  });
  it("brings forward exactly the window the user picked (and restores it if minimized)", async () => {
    const p = pc({ windows: [notepad(0), chrome(4, { hwnd: 21, pid: 21, title: "Mail - Google Chrome", minimized: true }), chrome(1)] });
    const t = run(p, [tool("open_app", { app: "Google Chrome", _hwnd: 21 }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(p.log).toContain("focus:21");
    expect(p.log).not.toContain("focus:20");
    expect(p.log.some((l) => l.startsWith("launch:"))).toBe(false);
    expect(p.fgOf()).toBe(21);
  });
  it("a window hint from the user ('the mail one') picks it without asking", async () => {
    const p = pc({ windows: [notepad(0), chrome(4, { hwnd: 21, pid: 21, title: "Mail - Google Chrome" }), chrome(1)] });
    const t = run(p, [tool("open_app", { app: "Google Chrome", window: "mail" }), done("ok")]);
    await t.session.handleTranscript("s", "open the mail chrome window");
    expect(p.fgOf()).toBe(21);
    expect(t.events.some((e) => e.type === "task.clarification_required")).toBe(false);
  });
  it("a hint that matches several windows still asks, and a hint that matches none asks too", async () => {
    const p = pc({ windows: [notepad(0), chrome(4, { hwnd: 21, pid: 21, title: "Mail - Google Chrome" }), chrome(1)] });
    const t = run(p, [tool("open_app", { app: "Google Chrome", window: "google" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(t.last()).toMatchObject({ type: "task.clarification_required" });
    const p2 = pc({ windows: [notepad(0), chrome(4, { hwnd: 21, pid: 21, title: "Mail - Google Chrome" }), chrome(1)] });
    const t2 = run(p2, [tool("open_app", { app: "Google Chrome", window: "zzz" }), done("ok")]);
    await t2.session.handleTranscript("s", "open chrome");
    expect(t2.last()).toMatchObject({ type: "task.clarification_required" });
  });
  it("when one of several windows is already in front, that is the one in use: no question, and it says the others exist", async () => {
    const p = pc({ windows: [chrome(0), chrome(3, { hwnd: 21, pid: 21, title: "Mail - Google Chrome" }), notepad(1)] });
    const t = run(p, [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(p.log).toEqual([]);
    expect(lastStep(t.results)!.text).toMatch(/already open and in front.*1 other window of it is open too/);
  });
  it("a MAXIMIZED window behind others is brought forward as it is (not un-maximized)", async () => {
    const p = pc({ windows: [notepad(0), chrome(2, { maximized: true })] });
    const t = run(p, [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(p.fgOf()).toBe(20);
    expect(lastStep(t.results)!.text).toMatch(/maximized, behind other windows/);
    expect(p.wins.find((w) => w.hwnd === 20)!.maximized).toBe(true);
  });
  it("an app running with NO window (in the tray) is recognised as running in the background; it is then asked to come up, and the answer says so", async () => {
    const p = pc({ windows: [notepad(0)], processes: ["notepad", "calculator"], apps: [{ name: "Calculator", id: "calc.id" }] });
    const t = run(p, [tool("open_app", { app: "Calculator" }), done("ok")]);
    // the fake launch makes a window appear, like Windows bringing the running copy up
    const orig = p.deps.launch.launchApp;
    p.deps.launch.launchApp = async (id: string) => { const r = await orig(id); p.wins.push({ hwnd: 77, pid: 77, process: "ApplicationFrameHost", title: "Calculator", z: 0 }); return r; };
    await t.session.handleTranscript("s", "open calculator");
    expect(lastStep(t.results)!.text).toMatch(/already running in the background \(no window\)/);
  });
  it("an app that is not running at all gets no 'background' claim", async () => {
    const p = pc({ windows: [notepad(0)], processes: ["notepad"], apps: [{ name: "Calculator", id: "calc.id" }] });
    const t = run(p, [tool("open_app", { app: "Calculator" }), done("ok")]);
    const orig = p.deps.launch.launchApp;
    p.deps.launch.launchApp = async (id: string) => { const r = await orig(id); p.wins.push({ hwnd: 77, pid: 77, process: "ApplicationFrameHost", title: "Calculator", z: 0 }); return r; };
    await t.session.handleTranscript("s", "open calculator");
    expect(lastStep(t.results)!.text).not.toMatch(/background/);
  });
  it("starts a new copy only when asked for one (newWindow)", async () => {
    const p = pc({ windows: [chrome(0)] });
    const t = run(p, [tool("open_app", { app: "Google Chrome", newWindow: true }), done("ok")]);
    await t.session.handleTranscript("s", "open another chrome window");
    expect(p.log).toContain("launch:chrome.id");
  });
  it("launches an app that is not running", async () => {
    const p = pc({ windows: [notepad(0)] });
    const t = run(p, [tool("open_app", { app: "Calculator" }), done("ok")]);
    await t.session.handleTranscript("s", "open calculator");
    expect(p.log).toContain("launch:calc.id");
  });
  it("with one window and the real pointer, clicks its taskbar button like a person, and only if the taskbar is really under the pointer", async () => {
    const clicks: { at: string; classes?: string[] }[] = [];
    const p: ReturnType<typeof pc> = pc({
      windows: [notepad(0), chrome(3, { minimized: true })],
      pointer: () => ({
        click: async (x, y, o) => {
          clicks.push({ at: `${x},${y}`, classes: o.expectClass });
          // Windows restores the window when its taskbar button is clicked
          const w = p.wins.find((q) => q.hwnd === 20)!; w.minimized = false; await p.deps.input.focusWindow(20);
          p.log.length = 0;
          return { ok: true };
        },
        press: async () => ({ ok: true }), type: async () => ({ ok: true }), windowAt: () => 0,
      }),
    });
    const t = run(p, [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(clicks).toEqual([{ at: "324,1060", classes: ["Shell_TrayWnd", "Shell_SecondaryTrayWnd"] }]); // the centre of Chrome's taskbar button
    expect(p.log.some((l) => l.startsWith("launch:"))).toBe(false);
    expect(lastStep(t.results)!.text).toMatch(/clicked its taskbar button/);
  });
  it("a taskbar hidden behind a full-screen app is NOT clicked: Windows is asked instead", async () => {
    const p = pc({
      windows: [notepad(0), chrome(3, { minimized: true })],
      pointer: () => ({ click: async () => ({ ok: false, reason: "covered" }), press: async () => ({ ok: true }), type: async () => ({ ok: true }), windowAt: () => 0 }),
    });
    const t = run(p, [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(p.log).toContain("focus:20");
    expect(p.fgOf()).toBe(20);
  });
});

describe("the real pointer", () => {
  const items = (over: Partial<UiNode> = {}): UiNode[] => [
    { type: "Button", name: "Open", enabled: true, offscreen: false, rid: "b1", rect: { l: 100, t: 200, w: 80, h: 30 }, ...over },
    { type: "Text", name: "Status: idle", enabled: true, offscreen: false },
  ];
  function withPointer(result: PointerResult, calls: { x: number; y: number; opts: Record<string, unknown> }[], state: { changed: boolean }) {
    return pc({
      windows: [chrome(0)],
      ui: () => (state.changed ? [{ type: "Button", name: "Open", enabled: true, offscreen: false, rid: "b1", rect: { l: 100, t: 200, w: 80, h: 30 } }, { type: "Text", name: "Status: opened", enabled: true, offscreen: false }] : items()),
      pointer: () => ({
        click: async (x, y, o) => { calls.push({ x, y, opts: o as never }); if (result.ok) state.changed = true; return result; },
        press: async () => ({ ok: true }), type: async () => ({ ok: true }), windowAt: () => 20,
      }),
    });
  }
  it("moves to the control's centre, clicks it itself, and checks the screen changed", async () => {
    const calls: { x: number; y: number; opts: Record<string, unknown> }[] = [];
    const p = withPointer({ ok: true }, calls, { changed: false });
    const t = run(p, [tool("click_control", { label: "Open" }), done("ok")]);
    await t.session.handleTranscript("s", "click open");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ x: 140, y: 215, opts: { expectRoot: 20 } });
    expect(p.log.some((l) => l.startsWith("invoke:"))).toBe(false); // no silent UI Automation click
    expect(lastStep(t.results)).toMatchObject({ outcome: "ok" });
  });
  it("double-clicks when asked to OPEN an item", async () => {
    const calls: { x: number; y: number; opts: Record<string, unknown> }[] = [];
    const p = withPointer({ ok: true }, calls, { changed: false });
    const t = run(p, [tool("click_control", { label: "Open", open: true }), done("ok")]);
    await t.session.handleTranscript("s", "open it");
    expect(calls[0].opts.double).toBe(true);
  });
  it("falls back to UI Automation when another window covers the target", async () => {
    const calls: { x: number; y: number; opts: Record<string, unknown> }[] = [];
    const p = withPointer({ ok: false, reason: "covered" }, calls, { changed: false });
    const t = run(p, [tool("click_control", { label: "Open" }), done("ok")]);
    await t.session.handleTranscript("s", "click open");
    expect(p.log).toContain("invoke:b1");
  });
  it("STOPS when the user grabs the mouse: nothing else is done", async () => {
    const calls: { x: number; y: number; opts: Record<string, unknown> }[] = [];
    const p = withPointer({ ok: false, reason: "user_moved" }, calls, { changed: false });
    const t = run(p, [tool("click_control", { label: "Open" }), done("ok")]);
    await t.session.handleTranscript("s", "click open");
    expect(p.log.some((l) => l.startsWith("invoke:"))).toBe(false);
    expect(lastStep(t.results)).toMatchObject({ outcome: "failed" });
    expect(lastStep(t.results)!.text).toMatch(/moved the mouse/);
  });
  it("brings a minimized window forward, reads it again, and only then clicks", async () => {
    const calls: { x: number; y: number; opts: Record<string, unknown> }[] = [];
    const state = { changed: false };
    const p = pc({
      windows: [notepad(0), chrome(3, { minimized: true })],
      ui: (h) => (h === 20 ? items() : []),
      pointer: () => ({ click: async (x, y, o) => { calls.push({ x, y, opts: o as never }); state.changed = true; return { ok: true }; }, press: async () => ({ ok: true }), type: async () => ({ ok: true }), windowAt: () => 20 }),
    });
    const t = run(p, [tool("click_control", { label: "Open", window: "Docs" }), done("ok")]);
    await t.session.handleTranscript("s", "click open in docs");
    expect(p.log[0]).toBe("focus:20");
    expect(calls).toHaveLength(1);
  });
  it("is never used when human-like control is off", async () => {
    const p = pc({ windows: [chrome(0)], ui: () => items() });
    const t = run(p, [tool("click_control", { label: "Open" }), done("ok")]);
    await t.session.handleTranscript("s", "click open");
    expect(p.log).toContain("invoke:b1");
  });
});

describe("observing the screen", () => {
  it("lists every window with its state, front to back, and what the front window shows", async () => {
    const p = pc({
      windows: [chrome(0, { maximized: true }), notepad(2, { minimized: true })],
      ui: (h) => (h === 20 ? [
        { type: "Pane", name: "", enabled: true, offscreen: false, rect: { l: 0, t: 0, w: 1920, h: 1000 } },
        { type: "Edit", name: "Address and search bar", enabled: true, offscreen: false, value: "https://example.com", rid: "a", rect: { l: 10, t: 10, w: 500, h: 30 } },
        { type: "ListItem", name: "Local Disk (D:)", enabled: true, offscreen: false, rid: "d", state: "selected", rect: { l: 10, t: 100, w: 200, h: 30 } },
      ] : []),
    });
    const t = run(p, [tool("look_screen"), done("ok")]);
    await t.session.handleTranscript("s", "what is on my screen");
    const text = lastStep(t.results)!.text;
    expect(text).toMatch(/\[in front\] Docs - Google Chrome \(chrome, maximized\)/);
    expect(text).toMatch(/notes - Notepad \(notepad, minimized\)/);
    expect(text).toMatch(/address: https:\/\/example\.com/);
    expect(text).toMatch(/Items: Local Disk \(D:\) \(selected\)/);
  });
});

describe("navigating File Explorer step by step", () => {
  // a tiny Explorer: This PC -> Local Disk (D:) -> Projects. What is listed depends on where it is NOW.
  it("opens Explorer, then finds the drive and the folder from what is on screen each time, with real double-clicks", async () => {
    let where = "This PC";
    const listing: Record<string, string[]> = { "This PC": ["Local Disk (C:)", "Local Disk (D:)"], "Local Disk (D:)": ["Games", "Projects"], Projects: ["readme.txt"] };
    const rows = () => (listing[where] ?? []).map((name, i): UiNode => ({ type: "ListItem", name, enabled: true, offscreen: false, rid: `${where}:${name}`, rect: { l: 300, t: 200 + i * 40, w: 300, h: 30 } }));
    const explorer: FakeWin = { hwnd: 40, pid: 40, process: "explorer", title: "This PC - File Explorer", z: 0 };
    const doubleClicks: string[] = [];
    const p = pc({
      windows: [{ ...notepad(0) }, { ...explorer, z: 2, minimized: true }],
      ui: (h) => (h === 40 ? [{ type: "Pane", name: "", enabled: true, offscreen: false, rect: { l: 0, t: 0, w: 1920, h: 1000 } }, { type: "Edit", name: "Address", enabled: true, offscreen: false, value: where, rid: "addr", rect: { l: 300, t: 100, w: 400, h: 30 } }, ...rows()] : []),
      pointer: () => ({
        click: async (_x, y, o) => {
          const i = Math.round((y - 215) / 40);
          const name = (listing[where] ?? [])[i];
          if (name && o.double) { doubleClicks.push(name); where = name; }
          return { ok: true };
        },
        press: async () => ({ ok: true }), type: async () => ({ ok: true }), windowAt: () => 40,
      }),
    });
    const t = run(p, [
      tool("open_app", { app: "File Explorer" }),
      tool("look_screen"),
      tool("click_control", { label: "Local Disk (D:)", open: true }),
      tool("look_screen"),
      tool("click_control", { label: "Projects", open: true }),
      tool("look_screen"),
      done("Opened Projects on D:."),
    ]);
    await t.session.handleTranscript("s", "open the D drive then the Projects folder");
    expect(p.log.some((l) => l.startsWith("launch:"))).toBe(false); // the running (minimized) Explorer was reused
    expect(doubleClicks).toEqual(["Local Disk (D:)", "Projects"]);
    expect(where).toBe("Projects");
    expect(t.last()).toMatchObject({ type: "task.completed", verified: true });
    const texts = t.results[t.results.length - 1].filter((s) => s.kind === "tool").map((s) => (s as { text: string }).text);
    expect(texts[1]).toMatch(/Items: Local Disk \(C:\) \| Local Disk \(D:\)/); // observed BEFORE the first click
    expect(texts[3]).toMatch(/Items: Games \| Projects/); // and AFTER it, which is what decided the next click
    expect(texts[5]).toMatch(/Items: readme\.txt/);
  });
});
