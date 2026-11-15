import { describe, expect, it } from "vitest";
import { Session } from "./session";
import type { PlanDecision, PlanStep } from "./ai/prompts";
import type { AiService } from "./ai/service";
import type { RuntimeEvent } from "../../types/runtime-events";
import type { ChangeEvent, ChangeSource } from "../shared/changeWatch";
import type { ActResult, FsPort, InputPort, LaunchPort, PointerPort, PointerResult, RawWindow, ScreenPort, UiNode, WindowState } from "../shared/ports";

/**
 * Condition-based waiting (Phase 2): an action is judged by looking again until the screen shows the effect, or until a time limit,
 * instead of after one fixed pause. Delayed apps still verify; a missing effect is reported as unconfirmed, never as success.
 */
type Rect = { l: number; t: number; w: number; h: number };
const item = (name: string, rid: string, rect: Rect, type = "ListItem"): UiNode => ({ type, name, enabled: true, offscreen: false, rid, rect });
const explorer: RawWindow = { hwnd: 20, pid: 20, process: "explorer", title: "Documents - File Explorer", z: 0 };
const ok2 = { ok: true } as PointerResult;

function world(opts: { ui: (n: number) => UiNode[]; state?: (n: number) => WindowState; scroll?: PointerPort["scroll"] }) {
  let reads = 0, states = 0;
  const input: InputPort = {
    focusWindow: async (): Promise<ActResult> => ({ ok: true }), minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async (): Promise<WindowState> => opts.state?.(states++) ?? { exists: true, minimized: false, pid: 20, foregroundPid: 20 },
    invokeControl: async (): Promise<ActResult> => ({ ok: true }), setControlText: async () => ({ ok: true, readBack: "" }),
  };
  const screen: ScreenPort = { readUi: async () => ({ ok: true, items: opts.ui(reads++).map((n) => ({ ...n })), truncated: false }), ocr: async () => ({ ok: true, lines: ["x"] }) };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  const pointer: PointerPort = {
    click: async () => ok2, press: async () => ok2, type: async () => ok2, windowAt: () => 20, windowRect: () => ({ l: 0, t: 0, w: 1000, h: 800 }),
    scroll: opts.scroll ?? (async () => ok2),
  };
  return {
    stats: () => ({ reads, states }),
    deps: {
      fs, input, screen, launch, act: { openPath: async () => "" }, apps: { list: async () => [] },
      win: { query: async () => ({ processes: undefined, activePid: 20, activeHwnd: 20, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 } as RawWindow, explorer] }) },
      pointer: () => pointer,
    },
  };
}

function run(w: ReturnType<typeof world>, script: PlanDecision[], changes?: ChangeSource) {
  const events: RuntimeEvent[] = [];
  const results: PlanStep[][] = [];
  let i = 0;
  const ai: AiService = {
    ready: () => true, label: () => "TestAI", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_g, steps) { results.push(JSON.parse(JSON.stringify(steps))); return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "TestAI" }; },
  };
  const session = new Session({ ...(w.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, cursorLeadMs: () => 0, changes } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  return { session, events, results };
}
const tool = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
const done = (answer: string): PlanDecision => ({ type: "done", answer });
const lastTool = (r: PlanStep[][]) => { const s = r[r.length - 1]; const t = s[s.length - 1]; return t.kind === "tool" ? t : null; };

const apple = item("Apple.docx", "a", { l: 100, t: 200, w: 300, h: 30 });
const zebra = item("Zebra.docx", "z", { l: 100, t: 200, w: 300, h: 30 });

describe("a delayed application response", () => {
  it("scroll: an app that redraws late (after several looks) is still confirmed, because the wait looks again", async () => {
    let scrolledAt = -1;
    const w = world({ ui: (n) => (scrolledAt >= 0 && n >= scrolledAt + 3 ? [zebra] : [apple]), scroll: async () => { scrolledAt = w.stats().reads; return ok2; } });
    const t = run(w, [tool("scroll_window", { direction: "down" }), done("ok")]);
    await t.session.handleTranscript("s", "scroll down");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
    expect(lastTool(t.results)!.text).toMatch(/what is on screen changed/);
  });

  it("scroll: a half-drawn state is not taken as the result: the change must hold for a second look", async () => {
    let scrolledAt = -1;
    const mid = item("Loading", "m", { l: 100, t: 200, w: 300, h: 30 });
    const w = world({ ui: (n) => { if (scrolledAt < 0) return [apple]; const k = n - scrolledAt; return k < 2 ? [apple] : k === 2 ? [mid] : [zebra]; }, scroll: async () => { scrolledAt = w.stats().reads; return ok2; } });
    const t = run(w, [tool("scroll_window", { direction: "down" }), done("ok")]);
    await t.session.handleTranscript("s", "scroll down");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
    expect(lastTool(t.results)!.text).toMatch(/changed/);
  });

  it("minimize: Windows reports it a few looks later, and that is confirmed", async () => {
    const w = world({ ui: () => [], state: (n) => ({ exists: true, minimized: n >= 3, pid: 20, foregroundPid: 20 }) });
    const t = run(w, [tool("minimize_window", { window: "Documents" }), done("ok")]);
    await t.session.handleTranscript("s", "minimize it");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
    expect(lastTool(t.results)!.text).toMatch(/Windows confirms/);
  });

  it("minimize: an effect that never happens is reported as NOT confirmed, after a bounded number of looks", async () => {
    const w = world({ ui: () => [], state: () => ({ exists: true, minimized: false, pid: 20, foregroundPid: 20 }) });
    const t = run(w, [tool("minimize_window", { window: "Documents" }), done("ok")]);
    await t.session.handleTranscript("s", "minimize it");
    expect(lastTool(t.results)!.text).toMatch(/still is not/);
    expect(w.stats().states).toBeLessThan(40); // bounded: a timeout, not a spin
  });

  it("scroll: nothing ever changes -> 'could not confirm', never 'scrolled'", async () => {
    const w = world({ ui: () => [apple] });
    const t = run(w, [tool("scroll_window", { direction: "down" }), done("ok")]);
    await t.session.handleTranscript("s", "scroll down");
    expect(lastTool(t.results)!.text).toMatch(/could not confirm/);
  });
});

describe("with change events", () => {
  class Src implements ChangeSource {
    s = 0; ok: boolean; held = 0; released = 0; log: Array<{ seq: number; events: ChangeEvent[] }> = []; waiters: Array<() => void> = [];
    constructor(ok = true) { this.ok = ok; }
    healthy() { return this.ok; }
    seq() { return this.s; }
    push(...events: ChangeEvent[]) { this.s++; this.log.push({ seq: this.s, events }); for (const x of this.waiters.splice(0)) x(); }
    next(since: number, ms: number) {
      const grab = () => ({ seq: this.s, events: this.log.filter((b) => b.seq > since).flatMap((b) => b.events) });
      if (this.s > since || ms <= 0) return Promise.resolve(grab());
      return new Promise<{ seq: number; events: ChangeEvent[] }>((res) => { const t = setTimeout(() => res(grab()), ms); this.waiters.push(() => { clearTimeout(t); res(grab()); }); });
    }
    acquire() { this.held++; return () => { this.released++; }; }
  }

  it("an event ends the wait early, and the source is handed back afterwards", async () => {
    const src = new Src();
    let scrolled = false;
    const w = world({ ui: () => (scrolled ? [zebra] : [apple]), scroll: async () => { scrolled = true; setTimeout(() => src.push({ kind: "name", root: 20 }), 20); return ok2; } });
    const t = run(w, [tool("scroll_window", { direction: "down" }), done("ok")], src);
    await t.session.handleTranscript("s", "scroll down");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
    expect(src.held).toBeGreaterThan(0);
    expect(src.released).toBe(src.held); // never left on
  });

  it("when events never arrive (dropped) the slower look still confirms it", async () => {
    const src = new Src(true); // says healthy, delivers nothing
    let scrolled = false;
    const w = world({ ui: () => (scrolled ? [zebra] : [apple]), scroll: async () => { setTimeout(() => { scrolled = true; }, 50); return ok2; } });
    const t = run(w, [tool("scroll_window", { direction: "down" }), done("ok")], src);
    await t.session.handleTranscript("s", "scroll down");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
  });

  it("a source that throws (helper crashed) is treated as absent: the action is still verified by polling", async () => {
    const broken: ChangeSource = { healthy: () => { throw new Error("helper died"); }, seq: () => { throw new Error("x"); }, next: () => Promise.reject(new Error("x")), acquire: () => { throw new Error("x"); } };
    let scrolled = false;
    const w = world({ ui: () => (scrolled ? [zebra] : [apple]), scroll: async () => { scrolled = true; return ok2; } });
    const t = run(w, [tool("scroll_window", { direction: "down" }), done("ok")], broken);
    await t.session.handleTranscript("s", "scroll down");
    expect(lastTool(t.results)).toMatchObject({ outcome: "ok" });
  });

  it("an unhealthy source (no heartbeat) means plain polling, with the same verdicts", async () => {
    const src = new Src(false);
    const w = world({ ui: () => [apple] });
    const t = run(w, [tool("scroll_window", { direction: "down" }), done("ok")], src);
    await t.session.handleTranscript("s", "scroll down");
    expect(lastTool(t.results)!.text).toMatch(/could not confirm/);
  });
});

describe("arrange_window", () => {
  it("Win+Down minimized the window instead of restoring it: that is reported as NOT done, and the window is brought back", async () => {
    let focused = 0, pressed = false;
    const w = world({ ui: () => [], state: () => ({ exists: true, minimized: pressed, pid: 20, foregroundPid: 20 }) });
    w.deps.pointer()!.press = async () => { pressed = true; return ok2; };
    (w.deps.input as InputPort).focusWindow = async () => { focused++; return { ok: true }; };
    const t = run(w, [tool("arrange_window", { to: "restore", window: "Documents" }), done("ok")]);
    await t.session.handleTranscript("s", "restore it");
    const r = lastTool(t.results)!;
    expect(r.text).toMatch(/minimized/);
    expect(r.text).toMatch(/brought it back/);
    expect(focused).toBeGreaterThan(0);
  });
});
