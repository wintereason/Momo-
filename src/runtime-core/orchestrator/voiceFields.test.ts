import { describe, expect, it } from "vitest";
import { Session } from "./session";
import type { PlanDecision, PlanStep } from "./ai/prompts";
import type { AiService } from "./ai/service";
import type { RuntimeEvent } from "../../types/runtime-events";
import type { ActResult, FsPort, InputPort, LaunchPort, RawWindow, ScreenPort, SubmitResult, UiNode, WindowState } from "../shared/ports";

/** "select the search bar" -> dictate -> "search": the two tools behind it, on a small fake PC. */

const win: RawWindow = { hwnd: 10, pid: 10, process: "chrome", title: "Google Chrome" };
const node = (over: Partial<UiNode>): UiNode => ({ type: "Edit", name: "x", enabled: true, offscreen: false, rid: "r", ...over });

function pc(items: UiNode[], opts: { changed?: boolean; focusOk?: boolean } = {}) {
  const log: string[] = [];
  const ui = items.map((i) => ({ ...i }));
  const input: InputPort = {
    focusWindow: async () => ({ ok: true }), minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async (): Promise<WindowState> => ({ exists: true, minimized: false, pid: 10, foregroundPid: 10 }),
    invokeControl: async () => ({ ok: true }), setControlText: async () => ({ ok: true, readBack: "" }),
    focusControl: async (_h, rid, name): Promise<ActResult> => {
      log.push(`focus:${name}`); log.push(`rid:${rid}`);
      if (opts.focusOk === false) return { ok: false, reason: "I couldn't put the cursor in that field" };
      ui.forEach((n) => { n.focused = n.rid === rid; });
      return { ok: true };
    },
    submitControl: async (_h, _rid, name): Promise<SubmitResult> => { log.push(`enter:${name}`); return { ok: true, changed: opts.changed !== false }; },
  };
  const screen: ScreenPort = { readUi: async () => ({ ok: true, items: ui.map((i) => ({ ...i })), truncated: false }), ocr: async () => ({ ok: false, reason: "no" }) };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  return {
    log, ui,
    deps: {
      fs, input, screen, launch, apps: { list: async () => [] }, act: { openPath: async () => "" },
      win: { query: async () => ({ activePid: 10, activeHwnd: 10, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo" }, win] }) },
    },
  };
}

function run(items: UiNode[], script: PlanDecision[], o: { changed?: boolean; focusOk?: boolean } = {}) {
  const p = pc(items, o);
  const events: RuntimeEvent[] = [];
  const calls: PlanStep[][] = [];
  let i = 0;
  const ai: AiService = {
    ready: () => true, label: () => "TestAI", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_goal, steps) { calls.push(JSON.parse(JSON.stringify(steps))); return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "TestAI" }; },
  };
  const session = new Session({ ...(p.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, verifyAttempts: 2 } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  return { session, p, events, calls, last: () => events[events.length - 1] };
}
const tool = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
const done = (answer: string): PlanDecision => ({ type: "done", answer });

const rect = { l: 400, t: 100, w: 600, h: 40 };
const bar = node({ name: "Address and search bar", rid: "omni", rect });
const pageSearch = node({ name: "Search", rid: "q", rect: { l: 100, t: 300, w: 300, h: 30 } });
const compose = node({ name: "Type a message", rid: "msg", rect: { l: 100, t: 700, w: 800, h: 40 } });
const pwd = node({ name: "Password", rid: "pw", password: true });
const button = node({ type: "Button", name: "Go", rid: "go" });

describe("select the search bar", () => {
  it("puts the cursor in the field it was asked for, and says so only after Windows saw the focus move", async () => {
    const t = run([bar, button], [tool("select_field", { label: "search bar" }), done("Selected.")]);
    await t.session.handleTranscript("s", "select the search bar");
    expect(t.p.log.filter((l) => l.startsWith("focus:"))).toEqual(["focus:Address and search bar"]);
    expect(t.last()).toMatchObject({ type: "task.completed", verified: true });
  });
  it("understands 'the search bar' when the field is just called 'Search'", async () => {
    const t = run([pageSearch], [tool("select_field", { label: "the search bar" }), done("ok")]);
    await t.session.handleTranscript("s", "select the search bar");
    expect(t.p.log.filter((l) => l.startsWith("focus:"))).toEqual(["focus:Search"]);
  });
  it("asks which one when two fields match, and selects nothing until you choose", async () => {
    const t = run([bar, node({ name: "Search the web", rid: "web", rect })], [tool("select_field", { label: "search" }), done("ok")]);
    await t.session.handleTranscript("s", "select search");
    expect(t.last()).toMatchObject({ type: "task.clarification_required" });
    expect(t.p.log).toEqual([]);
  });
  it("never selects a password field, and a failure is reported, not hidden", async () => {
    const a = run([pwd], [tool("select_field", { label: "password" }), { type: "fail", reason: "no" }]);
    await a.session.handleTranscript("s", "select the password box");
    expect(a.p.log).toEqual([]);
    const b = run([bar], [tool("select_field", { label: "search bar" }), { type: "fail", reason: "could not" }], { focusOk: false });
    await b.session.handleTranscript("s", "select the search bar");
    expect(b.calls[1][0]).toMatchObject({ kind: "tool", tool: "select_field", outcome: "failed" });
  });
});

describe("search / okay = Enter in the selected field", () => {
  it("in a search or address box it just runs, and is verified by the page changing", async () => {
    const t = run([{ ...bar, focused: true }], [tool("press_enter"), done("Searched.")]);
    await t.session.handleTranscript("s", "search");
    expect(t.p.log).toEqual(["enter:Address and search bar"]);
    expect(t.last()).toMatchObject({ type: "task.completed", verified: true });
  });
  it("if nothing changed afterwards it is NOT reported as done", async () => {
    const t = run([{ ...bar, focused: true }], [tool("press_enter"), done("Searched.")], { changed: false });
    await t.session.handleTranscript("s", "search");
    expect(t.last()).toMatchObject({ type: "task.state", state: "partial_success" });
  });
  it("in any other field (it could send a message) it asks first, and sends nothing until you say yes", async () => {
    const t = run([{ ...compose, focused: true }], [tool("press_enter"), done("Sent.")]);
    await t.session.handleTranscript("s", "okay");
    expect(t.last()).toMatchObject({ type: "task.confirmation_required", summary: expect.stringContaining("Type a message") });
    expect(t.p.log).toEqual([]);
    await t.session.respondConfirmation((t.last() as { taskId: string }).taskId, true);
    expect(t.p.log).toEqual(["enter:Type a message"]);
  });
  it("with no field selected it presses nothing", async () => {
    const t = run([bar, button], [tool("press_enter"), { type: "fail", reason: "no field" }]);
    await t.session.handleTranscript("s", "search");
    expect(t.p.log).toEqual([]);
    expect(t.calls[1][0]).toMatchObject({ outcome: "failed" });
  });
  it("never presses Enter in a password field", async () => {
    const t = run([{ ...pwd, focused: true, type: "Edit" }], [tool("press_enter"), { type: "fail", reason: "no" }]);
    await t.session.handleTranscript("s", "okay");
    expect(t.p.log).toEqual([]);
  });
});

describe("the shadow cursor is told where Momo acts, and only while it acts", () => {
  it("emits a validated cursor.move for the field it selects and the one it presses Enter in", async () => {
    const t = run([{ ...bar, focused: true }], [tool("select_field", { label: "search bar" }), tool("press_enter"), done("ok")]);
    await t.session.handleTranscript("s", "select the search bar then search");
    const moves = t.events.filter((e) => e.type === "cursor.move");
    expect(moves.map((m) => (m as { action: string }).action)).toEqual(["select", "submit"]);
    expect(moves[0]).toMatchObject({ x: 700, y: 120, w: 600, h: 40, label: "Address and search bar" });
  });
  it("no cursor event for a task that touches no control", async () => {
    const t = run([bar], [done("Paris.")]);
    await t.session.handleTranscript("s", "capital of France");
    expect(t.events.some((e) => e.type === "cursor.move")).toBe(false);
  });
});

describe("the ghost gets to arrive before Momo acts, and shows window-level tasks too", () => {
  function runLead(items: UiNode[], script: PlanDecision[], lead: number) {
    const p = pc(items);
    const events: RuntimeEvent[] = [];
    const order: string[] = [];
    let i = 0;
    const ai: AiService = {
      ready: () => true, label: () => "TestAI", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
      polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
      async plan() { return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "TestAI" }; },
    };
    const inp = p.deps.input as InputPort;
    const realFocus = inp.focusControl!;
    inp.focusControl = async (h, r, n) => { order.push("act"); return realFocus(h, r, n); };
    const session = new Session({
      ...(p.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => { events.push(e); order.push(e.type); }, selfPids: () => [999], ai,
      sleep: async (ms: number) => { order.push(`wait:${ms}`); }, verifyAttempts: 2, cursorLeadMs: () => lead,
    } as never);
    session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
    return { session, events, order };
  }

  it("with the shadow cursor on, Momo waits for the ghost to arrive and only then acts", async () => {
    const t = runLead([bar], [tool("select_field", { label: "search bar" }), done("ok")], 800);
    await t.session.handleTranscript("s", "select the search bar");
    const at = t.order.indexOf("cursor.move");
    expect(at).toBeGreaterThan(-1);
    expect(t.order[at + 1]).toBe("wait:800");
    expect(t.order.indexOf("act")).toBeGreaterThan(at + 1);
  });
  it("with it off there is no waiting at all", async () => {
    const t = runLead([bar], [tool("select_field", { label: "search bar" }), done("ok")], 0);
    await t.session.handleTranscript("s", "select the search bar");
    expect(t.order.some((o) => o.startsWith("wait:800"))).toBe(false);
  });
  it("switching to, minimizing or closing a window points the ghost at that window first", async () => {
    for (const [name, action] of [["focus_window", "focus"], ["minimize_window", "minimize"], ["close_window", "close"]] as const) {
      const t = runLead([bar], [tool(name, { window: "Google Chrome" }), done("ok")], 800);
      await t.session.handleTranscript("s", name);
      // closing is a decision: the ghost only goes there once you have said yes
      if (name === "close_window") {
        expect(t.events.some((e) => e.type === "cursor.window")).toBe(false);
        await t.session.respondConfirmation((t.events[t.events.length - 1] as { taskId: string }).taskId, true);
      }
      const ev = t.events.find((e) => e.type === "cursor.window");
      expect(ev, name).toMatchObject({ type: "cursor.window", hwnd: 10, action });
    }
  });
});

describe("select the search bar: only the one SHOWN on screen, and ask which panel when there are look-alikes", () => {
  const winBox = node({ type: "Window", name: "Google Chrome", rid: "w", rect: { l: 0, t: 0, w: 1000, h: 800 } });
  const topBar = node({ name: "Search", rid: "top", panel: "Toolbar", rect: { l: 300, t: 40, w: 400, h: 36 } });
  const sideBar = node({ name: "Search", rid: "side", panel: "Sidebar", rect: { l: 20, t: 400, w: 200, h: 30 } });

  it("ignores a search box that is hidden or scrolled out of the window, and selects the visible one directly", async () => {
    const hidden = node({ name: "Search", rid: "h1", offscreen: true, rect: { l: 300, t: 100, w: 400, h: 36 } });
    const scrolledOut = node({ name: "Search", rid: "h2", rect: { l: 300, t: 3000, w: 400, h: 36 } });
    const t = run([winBox, hidden, scrolledOut, topBar], [tool("select_field", { label: "search bar" }), done("ok")]);
    await t.session.handleTranscript("s", "select the search bar");
    expect(t.last()).toMatchObject({ type: "task.completed" });
    expect(t.p.log).toEqual(["focus:Search", "rid:top"]);
  });
  it("with two visible search bars it asks WHICH panel, describing where each one is", async () => {
    const t = run([winBox, topBar, sideBar], [tool("select_field", { label: "search bar" }), done("ok")]);
    await t.session.handleTranscript("s", "select the search bar");
    const q = t.last() as { type: string; question: string; options?: { label: string; detail?: string }[] };
    expect(q.type).toBe("task.clarification_required");
    expect(q.options).toHaveLength(2);
    expect(q.options![0].detail).toMatch(/top centre.*Toolbar/);
    expect(q.options![1].detail).toMatch(/left side.*Sidebar/);
    expect(t.p.log).toEqual([]); // nothing selected until you choose
  });
  it("then selects exactly the one you picked, straight away, without asking again", async () => {
    const t = run([winBox, topBar, sideBar], [tool("select_field", { label: "search bar" }), done("ok")]);
    await t.session.handleTranscript("s", "select the search bar");
    await t.session.handleTranscript("s2", "2"); // "the second one"
    expect(t.p.log).toEqual(["focus:Search", "rid:side"]);
    expect(t.events.filter((e) => e.type === "task.clarification_required")).toHaveLength(1);
  });
});

describe("opening things: the ghost acts out the steps a person would take, before Momo does it", () => {
  const taskbar = (extra: UiNode[] = []): UiNode[] => [
    node({ type: "Button", name: "Start", rid: "s", rect: { l: 10, t: 1000, w: 48, h: 48 } }),
    node({ type: "Button", name: "Search", rid: "se", rect: { l: 70, t: 1000, w: 200, h: 48 } }),
    ...extra,
  ];
  function runOpen(tb: UiNode[] | null, script: PlanDecision[], lead = 800) {
    const p = pc([]);
    const order: string[] = [];
    const events: RuntimeEvent[] = [];
    const deps = p.deps as Record<string, unknown> & { screen: ScreenPort; launch: LaunchPort; apps: unknown };
    deps.screen = { ...deps.screen, taskbar: async () => tb } as ScreenPort;
    deps.launch = { ...(deps.launch as object), launchApp: async (id: string) => { order.push(`LAUNCH:${id}`); return { ok: true }; } } as unknown as LaunchPort;
    deps.apps = { list: async () => [{ name: "Google Chrome", id: "Chrome" }] };
    // Chrome is NOT running here (a running app is brought forward instead of being started: see desktopControl.test.ts)
    (deps as Record<string, unknown>).win = { query: async () => ({ activePid: 50, activeHwnd: 50, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo" }, { hwnd: 50, pid: 50, process: "notepad", title: "notes - Notepad" }] }) };
    let i = 0;
    const ai: AiService = {
      ready: () => true, label: () => "TestAI", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
      polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
      async plan() { return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "TestAI" }; },
    };
    const session = new Session({ ...deps, emit: (e: RuntimeEvent) => { events.push(e); if (e.type === "cursor.move") order.push(`${e.action}:${e.label ?? ""}${e.text ? `:${e.text}` : ""}`); }, selfPids: () => [999], ai, sleep: async () => {}, verifyAttempts: 1, cursorLeadMs: () => lead } as never);
    session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
    return { session, order, events };
  }

  it("a pinned app: glides to its taskbar icon and clicks it, THEN launches", async () => {
    const chrome = node({ type: "Button", name: "Google Chrome - 2 running windows", rid: "c", rect: { l: 300, t: 1000, w: 48, h: 48 } });
    const t = runOpen(taskbar([chrome]), [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    const click = t.order.findIndex((o) => o.startsWith("click:Taskbar"));
    expect(click).toBe(0);
    expect(t.order.indexOf("LAUNCH:Chrome")).toBeGreaterThan(click);
    const move = t.events.find((e) => e.type === "cursor.move") as { x: number; y: number };
    expect([move.x, move.y]).toEqual([324, 1024]); // the centre of THAT icon
  });
  it("an app that is not on the taskbar: Start, type its name, press Enter, THEN launches", async () => {
    const t = runOpen(taskbar(), [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await t.session.handleTranscript("s", "open chrome");
    expect(t.order.slice(0, 3)).toEqual(["click:Start", "type:Search:Google Chrome", "submit:Open Google Chrome"]);
    expect(t.order.indexOf("LAUNCH:Chrome")).toBe(3);
  });
  it("without a readable taskbar, or with the shadow cursor off, it just opens it", async () => {
    const a = runOpen(null, [tool("open_app", { app: "Google Chrome" }), done("ok")]);
    await a.session.handleTranscript("s", "open chrome");
    expect(a.order).toEqual(["LAUNCH:Chrome"]);
    const b = runOpen(taskbar(), [tool("open_app", { app: "Google Chrome" }), done("ok")], 0);
    await b.session.handleTranscript("s", "open chrome");
    expect(b.order).toEqual(["LAUNCH:Chrome"]);
  });
});
