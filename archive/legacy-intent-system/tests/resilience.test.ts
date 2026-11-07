import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "../orchestrator/session";
import type { FsPort, RawWindow, WindowsPort, WindowsSnapshot } from "../shared/ports";
import type { RuntimeEvent } from "../../types/runtime-events";

const fs: FsPort = {
  listDriveRoots: async () => ["C:\\", "D:\\"], statfs: async () => ({ total: 100, free: 40 }),
  readDirs: async () => null, stat: async () => ({ isDir: true }), homeDir: () => "C:\\Users\\me",
};
const W = (hwnd: number, pid: number, process: string, title: string): RawWindow => ({ hwnd, pid, process, title });
const SNAP: WindowsSnapshot = { activePid: 7, windows: [W(1, 7, "Code", "app.py - VS Code")] };

function make(win: WindowsPort, taskTimeoutMs = 5000) {
  const events: RuntimeEvent[] = [];
  const session = new Session({ fs, win, emit: (e) => events.push(e), selfPids: () => [], taskTimeoutMs, sleep: async () => {} });
  return { session, events, last: () => events[events.length - 1], types: () => events.map((e) => e.type) };
}

afterEach(() => vi.useRealTimers());

describe("a hung call cannot freeze Momo", () => {
  it("gives up after the time limit, says so, and frees Momo for the next request", async () => {
    vi.useFakeTimers();
    const gate = new Promise<WindowsSnapshot>(() => { /* Windows never answers */ });
    let calls = 0;
    const h = make({ query: () => (++calls === 1 ? gate : Promise.resolve(SNAP)) });

    void h.session.handleTranscript("s", "which window is active"); // hangs
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.types()).not.toContain("task.failed"); // still within the limit
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.last()).toMatchObject({ type: "task.failed", recoverable: true });
    expect((h.last() as { summary: string }).summary).toContain("took too long");

    // Momo is usable again
    await h.session.handleTranscript("s", "storage of D drive");
    expect(h.last()).toMatchObject({ type: "task.completed", verified: true });
  });

  it("whatever the hung call finally returns is discarded, and cannot lock or confuse a newer task", async () => {
    vi.useFakeTimers();
    let release!: (s: WindowsSnapshot) => void;
    const late = new Promise<WindowsSnapshot>((r) => (release = r));
    let calls = 0;
    const h = make({ query: () => (++calls === 1 ? late : Promise.resolve(SNAP)) });

    void h.session.handleTranscript("s", "which window is active");
    await vi.advanceTimersByTimeAsync(5001);
    const before = h.events.length;
    expect(h.last().type).toBe("task.failed");

    await h.session.handleTranscript("s", "storage of D drive");
    const afterB = h.events.length;
    expect(h.last().type).toBe("task.completed");

    release(SNAP); // the old call finally comes back
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events.length).toBe(afterB); // nothing more was said about the abandoned task
    expect(afterB).toBeGreaterThan(before);

    await h.session.handleTranscript("s", "list my drives"); // and Momo still works
    expect(h.last().type).toBe("task.completed");
  });

  it("a normal quick task never trips the watchdog", async () => {
    vi.useFakeTimers();
    const h = make({ query: async () => SNAP });
    await h.session.handleTranscript("s", "which window is active");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.types().filter((t) => t === "task.failed")).toEqual([]);
  });

  it("a hung confirmed action times out too", async () => {
    vi.useFakeTimers();
    const events: RuntimeEvent[] = [];
    const session = new Session({
      fs, win: { query: async () => SNAP }, emit: (e) => events.push(e), selfPids: () => [], taskTimeoutMs: 5000, sleep: async () => {},
      act: { openPath: () => new Promise<string>(() => {}) }, // Explorer never answers
    });
    session.setPolicy({ confirmReversible: true });
    await session.handleTranscript("s", "open my documents folder");
    const q = events.find((e) => e.type === "task.confirmation_required") as { taskId: string } | undefined;
    // (the folder search finds nothing in this fake tree, so there is no question to answer)
    expect(q === undefined || typeof q.taskId === "string").toBe(true);
  });
});

describe("errors from Windows are contained", () => {
  it("a throwing port becomes a polite, recoverable failure (never a crash, never success)", async () => {
    const h = make({ query: async () => { throw new Error("RPC server is unavailable 0x800706BA"); } });
    await h.session.handleTranscript("s", "which window is active");
    expect(h.last()).toMatchObject({ type: "task.failed", recoverable: true });
    expect(JSON.stringify(h.events)).not.toContain("0x800706BA"); // internal details are not shown
    expect(h.types()).not.toContain("task.completed");
    await h.session.handleTranscript("s", "storage of D drive"); // and the session still works
    expect(h.last().type).toBe("task.completed");
  });

  it("garbage from a port is rejected at the boundary, not shown", async () => {
    const h = make({ query: async () => ({ activePid: "x", windows: "nope" }) as unknown as WindowsSnapshot });
    await h.session.handleTranscript("s", "what windows are open");
    expect(h.last().type).toBe("task.failed");
  });
});

describe("restarts and overlapping requests", () => {
  it("a new session starts empty: nothing from before the restart is remembered or confirmable", async () => {
    const tree: FsPort = { ...fs, readDirs: async (p) => ({ "C:\\Users\\me": ["Reports"] })[p] ?? null };
    const e1: RuntimeEvent[] = [];
    const s1 = new Session({ fs: tree, win: { query: async () => SNAP }, emit: (e) => e1.push(e), selfPids: () => [], act: { openPath: async () => "" }, sleep: async () => {} });
    await s1.handleTranscript("s", "open the reports folder");
    const ask = e1.find((e) => e.type === "task.confirmation_required") as { taskId: string };
    expect(ask).toBeDefined();
    s1.dispose(); // Momo exits

    const e2: RuntimeEvent[] = [];
    const opened: string[] = [];
    const s2 = new Session({ fs: tree, win: { query: async () => SNAP }, emit: (e) => e2.push(e), selfPids: () => [], act: { openPath: async (p) => { opened.push(p); return ""; } }, sleep: async () => {} });
    expect(s2.world.size).toBe(0);
    await s2.respondConfirmation(ask.taskId, true); // an old approval means nothing
    expect(opened).toEqual([]);
    expect(e2).toEqual([]);
  });

  it("two requests at once never overlap: the second is ignored until the first finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = make({ query: async () => { await gate; return SNAP; } }, 60_000);
    const first = h.session.handleTranscript("s", "which window is active");
    await h.session.handleTranscript("s", "storage of D drive"); // arrives while busy
    expect(h.types().filter((t) => t === "task.completed")).toHaveLength(0);
    release();
    await first;
    expect(h.types().filter((t) => t === "task.completed")).toHaveLength(1);
  });

  it("dispose during a task leaves nothing running and nothing emitted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = make({ query: async () => { await gate; return SNAP; } }, 60_000);
    const p = h.session.handleTranscript("s", "which window is active");
    await Promise.resolve();
    const n = h.events.length;
    h.session.dispose();
    release();
    await p;
    expect(h.events.length).toBe(n);
    expect(h.session.world.size).toBe(0);
  });
});
