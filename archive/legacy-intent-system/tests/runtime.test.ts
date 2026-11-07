import { describe, expect, it } from "vitest";
import { WorldModel, FRESHNESS_MS } from "../verifier";
import { FileSystemAgent } from "../filesystem";
import { DesktopAgent, sanitizeTitle } from "../desktop";
import { Verifier } from "../verifier";
import { classify, extractDrive, resolveChoice } from "./intent";
import { Session } from "./session";
import type { FsPort, RawWindow, WindowsPort, WindowsSnapshot } from "../shared/ports";
import { RuntimeEventSchema, type RuntimeEvent } from "../../types/runtime-events";

const GB = 1024 ** 3;

// ---------- fakes ----------
function fakeFs(opts: {
  drives?: Record<string, { total: number; free: number }>;
  tree?: Record<string, string[]>;
  statfsThrows?: boolean;
} = {}) {
  const drives = opts.drives ?? { C: { total: 256 * GB, free: 40 * GB }, D: { total: 512 * GB, free: 188 * GB } };
  const tree = opts.tree ?? {};
  const counts = { readDirs: 0, statfs: 0 };
  const exists = new Set<string>();
  const add = (p: string) => exists.add(p.toLowerCase());
  for (const [dir, kids] of Object.entries(tree)) { add(dir); kids.forEach((k) => add(`${dir.replace(/\\$/, "")}\\${k}`)); }
  const port: FsPort = {
    listDriveRoots: async () => Object.keys(drives).map((l) => `${l}:\\`),
    statfs: async (root) => {
      counts.statfs++;
      if (opts.statfsThrows) throw new Error("EIO");
      return drives[root[0].toUpperCase()];
    },
    readDirs: async (p) => { counts.readDirs++; return tree[p] ?? null; },
    stat: async (p) => (exists.has(p.toLowerCase()) ? { isDir: true } : null),
    homeDir: () => "C:\\Users\\me",
  };
  return { port, counts, remove: (p: string) => exists.delete(p.toLowerCase()) };
}

function fakeWin(snapshot: WindowsSnapshot, delay?: Promise<void>) {
  const state = { snap: snapshot, calls: 0 };
  const port: WindowsPort = { query: async () => { state.calls++; if (delay) await delay; return state.snap; } };
  return { port, state };
}
const W = (hwnd: number, pid: number, process: string, title: string): RawWindow => ({ hwnd, pid, process, title });

function makeSession(fs = fakeFs(), win = fakeWin({ activePid: null, windows: [] }), now = () => 1000) {
  const events: RuntimeEvent[] = [];
  const session = new Session({ fs: fs.port, win: win.port, emit: (e) => events.push(e), selfPids: () => [999], now });
  return { session, events, fs, win };
}
const last = (events: RuntimeEvent[]) => events[events.length - 1];

// ---------- world model ----------
describe("WorldModel", () => {
  it("treats observations as current only while fresh", () => {
    let t = 0;
    const w = new WorldModel(() => t);
    w.upsert({ id: "window:1", type: "window", props: {}, source: "win32.windows", confidence: 1 });
    expect(w.getFresh("window:1")).toBeDefined();
    t = FRESHNESS_MS.window + 1;
    expect(w.getFresh("window:1")).toBeUndefined(); // expired
    expect(w.get("window:1")).toBeDefined(); // still stored, just not "current"
  });

  it("invalidates affected observations when the environment changes", () => {
    const w = new WorldModel(() => 0);
    w.upsert({ id: "window:1", type: "window", props: {}, source: "win32.windows", confidence: 1 });
    w.upsert({ id: "drive:D", type: "drive", props: {}, source: "fs.statfs", confidence: 1 });
    expect(w.notify("focus_changed")).toBe(1);
    expect(w.getFresh("window:1")).toBeUndefined();
    expect(w.getFresh("drive:D")).toBeDefined(); // a focus change does not affect drives
    w.notify("fs_changed");
    expect(w.getFresh("drive:D")).toBeUndefined();
  });

  it("records source, confidence and parent links; clear() empties it", () => {
    const w = new WorldModel(() => 5);
    w.upsert({ id: "window:1", type: "window", parentId: "desktop:main", props: { a: 1 }, source: "win32.windows", confidence: 0.9 });
    expect(w.get("window:1")).toMatchObject({ source: "win32.windows", confidence: 0.9, observedAt: 5, stale: false });
    expect(w.children("desktop:main")).toHaveLength(1);
    w.clear();
    expect(w.size).toBe(0);
  });
});

// ---------- filesystem agent ----------
describe("FileSystemAgent", () => {
  it("reads a drive with real sizes and records it in the world model", async () => {
    const f = fakeFs();
    const w = new WorldModel();
    const a = new FileSystemAgent(w, f.port);
    const r = await a.drive("d");
    expect(r).toMatchObject({ kind: "ok", info: { letter: "D", total: 512 * GB, free: 188 * GB, used: 324 * GB } });
    expect(w.get("drive:D")).toMatchObject({ source: "fs.statfs", confidence: 1 });
  });

  it("reports a missing drive and which ones exist", async () => {
    const a = new FileSystemAgent(new WorldModel(), fakeFs().port);
    expect(await a.drive("Z")).toEqual({ kind: "not_found", letter: "Z", available: ["C", "D"] });
  });

  it("skips unreadable drives when listing all", async () => {
    const f = fakeFs();
    const bad: FsPort = { ...f.port, statfs: async (r) => { if (r.startsWith("D")) throw new Error("not ready"); return f.port.statfs(r); } };
    const list = await new FileSystemAgent(new WorldModel(), bad).allDrives();
    expect(list.map((d) => d.letter)).toEqual(["C"]);
  });

  const tree = {
    "C:\\Users\\me": ["Documents", "Context Companion"],
    "C:\\Users\\me\\Context Companion": ["node_modules"],
    "C:\\Users\\me\\Context Companion\\node_modules": ["context-companion-dep"],
    "D:\\": ["Project 2", "Notes"],
    "D:\\Project 2": ["Context Companion Ai", "momo-project"],
  };

  it("finds folders by partial name, ignores noise like node_modules, and returns every candidate", async () => {
    const f = fakeFs({ tree });
    const r = await new FileSystemAgent(new WorldModel(), f.port).findFolders("context companion");
    expect(r.matches.map((m) => m.path)).toEqual(["C:\\Users\\me\\Context Companion", "D:\\Project 2\\Context Companion Ai"]);
    expect(r.matches.some((m) => m.path.includes("node_modules"))).toBe(false);
  });

  it("prefers the user's own profile and ignores hidden folders and other profiles", async () => {
    const f = fakeFs({
      tree: {
        "C:\\Users": ["Default", "me"],
        "C:\\Users\\Default": ["Downloads"],
        "C:\\Users\\me": ["Downloads", ".claude"],
        "C:\\Users\\me\\.claude": ["downloads"],
        "D:\\": ["Share", "downloads"],
        "C:\\": ["Users"],
      },
    });
    const r = await new FileSystemAgent(new WorldModel(), f.port).findFolders("downloads");
    expect(r.matches.map((m) => m.path)).toEqual(["C:\\Users\\me\\Downloads", "D:\\downloads"]);
  });

  it("puts exact-name matches first", async () => {
    const f = fakeFs({ tree });
    const r = await new FileSystemAgent(new WorldModel(), f.port).findFolders("Context Companion");
    expect(r.matches[0].name).toBe("Context Companion");
  });

  it("stops at its time budget and says so", async () => {
    let t = 0;
    const f = fakeFs({ tree });
    const agent = new FileSystemAgent(new WorldModel(), f.port, () => (t += 4000)); // every check advances the clock 4 s
    const r = await agent.findFolders("context");
    expect(r.truncated).toBe(true);
  });

  it("returns nothing for an empty query", async () => {
    expect((await new FileSystemAgent(new WorldModel(), fakeFs().port).findFolders("   ")).matches).toEqual([]);
  });
});

// ---------- desktop agent ----------
describe("DesktopAgent", () => {
  it("identifies the active window, tells Momo's own windows apart and sanitises titles", async () => {
    const win = fakeWin({
      activePid: 20,
      windows: [W(1, 10, "chrome", "Docs\u0007 — Chrome"), W(2, 20, "Code", "momo-project - VS Code"), W(3, 999, "electron", "Momo")],
    });
    const w = new WorldModel();
    const snap = await new DesktopAgent(w, win.port, () => [999]).snapshot();
    expect(snap.active).toMatchObject({ process: "Code", active: true, isMomo: false });
    expect(snap.windows.find((x) => x.hwnd === 3)?.isMomo).toBe(true);
    expect(snap.windows.find((x) => x.hwnd === 1)?.title).toBe("Docs — Chrome");
    expect(w.get("desktop:main")?.props.activeWindowId).toBe("window:2");
  });

  it("replaces the previous picture of the desktop instead of accumulating it", async () => {
    const win = fakeWin({ activePid: 1, windows: [W(1, 1, "a", "A"), W(2, 2, "b", "B")] });
    const w = new WorldModel();
    const agent = new DesktopAgent(w, win.port);
    await agent.snapshot();
    win.state.snap = { activePid: 2, windows: [W(2, 2, "b", "B")] };
    await agent.snapshot();
    expect(w.list("window").map((e) => e.id)).toEqual(["window:2"]);
  });

  it("neutralises control characters and caps length", () => {
    expect(sanitizeTitle("a\u0000b\u202ec\n d")).toBe("a b c d");
    expect(sanitizeTitle("x".repeat(500))).toHaveLength(200);
  });
});

// ---------- verification ----------
describe("Verifier", () => {
  const v = new Verifier();
  const ok = { letter: "D", root: "D:\\", total: 100, free: 40, used: 60 };
  it("accepts consistent numbers", () => expect(v.drive(ok).verified).toBe(true));
  it("rejects impossible numbers", () => {
    expect(v.drive({ ...ok, free: 200, used: -100 }).verified).toBe(false);
    expect(v.drive({ ...ok, total: 0, free: 0, used: 0 }).verified).toBe(false);
    expect(v.drive({ ...ok, used: 50 }).verified).toBe(false);
    expect(v.drive({ ...ok, total: NaN }).verified).toBe(false);
    expect(v.drive({ ...ok, letter: "DD" }).verified).toBe(false);
  });
  it("re-checks folders on disk", async () => {
    const f = fakeFs({ tree: { "D:\\": ["x"] } });
    const r = await v.folders([{ path: "D:\\x", name: "x", parent: "D:\\" }, { path: "D:\\gone", name: "gone", parent: "D:\\" }], f.port);
    expect(r.confirmed.map((m) => m.path)).toEqual(["D:\\x"]);
    expect((await v.folders([{ path: "D:\\gone", name: "gone", parent: "D:\\" }], f.port)).verdict.verified).toBe(false);
  });
});

// ---------- intent router ----------
describe("intent router", () => {
  it.each([
    ["Tell me the storage of D drive", { kind: "drive_space", drive: "D" }],
    ["how much free space is on D: ?", { kind: "drive_space", drive: "D" }],
    ["Momo, how much space is left on drive C", { kind: "drive_space", drive: "C" }],
    ["how much storage do I have", { kind: "drive_space", drive: undefined }],
    ["list my drives", { kind: "drive_space", drive: undefined }],
    ["which window is active", { kind: "active_window" }],
    ["what app am I using", { kind: "active_window" }],
    ["what windows are open", { kind: "list_windows" }],
    ["show my open apps", { kind: "list_windows" }],
    ["find my context companion project folder", { kind: "find_folder", query: "context companion" }],
    ["where is the downloads folder", { kind: "find_folder", query: "downloads" }],
  ])("%s", (text, expected) => expect(classify(text)).toMatchObject(expected as object));

  it("treats ordinary speech as unrelated", () => {
    for (const t of ["and then he said we should go to lunch", "I think it's going to rain", "", "   ", "yeah okay sure"]) {
      expect(classify(t).kind).toBe("unrelated");
    }
  });
  it("asks instead of guessing when addressed but unclear", () => {
    expect(classify("what can you do").kind).toBe("ambiguous");
    expect(classify("Momo?").kind).toBe("ambiguous");
    expect(classify("find the folder").kind).toBe("ambiguous");
  });
  it("recognises tasks it cannot do yet", () => {
    expect(classify("open WhatsApp and send hello to Sumeet")).toEqual({ kind: "unsupported", verb: "more than one step" });
    expect(classify("delete my downloads")).toEqual({ kind: "unsupported", verb: "delete" });
  });
  it("does not mistake the words 'a drive' for drive A", () => {
    expect(extractDrive("how much space on a drive")).toBeUndefined();
    expect(extractDrive("space on drive D")).toBe("D");
    expect(extractDrive("the A: drive")).toBe("A");
  });
});

describe("resolveChoice", () => {
  const opts = ["C:\\Users\\me\\Context Companion", "D:\\Project 2\\Context Companion Ai"];
  it("understands ordinals, text hints, cancel", () => {
    expect(resolveChoice("the second one", opts)).toEqual({ kind: "pick", index: 1 });
    expect(resolveChoice("1", opts)).toEqual({ kind: "pick", index: 0 });
    expect(resolveChoice("the one on D", ["C:\\a", "D:\\a"]).kind).toBe("unclear"); // 'd' is too short to trust
    expect(resolveChoice("the Project 2 one", opts)).toEqual({ kind: "pick", index: 1 });
    expect(resolveChoice("never mind", opts)).toEqual({ kind: "cancel" });
  });
  it("never guesses between several matches", () => {
    expect(resolveChoice("context companion", opts).kind).toBe("unclear");
    expect(resolveChoice("hmm", opts).kind).toBe("unclear");
  });
  it("confirms a single candidate with yes", () => {
    expect(resolveChoice("yes", ["D:\\x"])).toEqual({ kind: "pick", index: 0 });
  });
});

// ---------- orchestrator (end to end through Session) ----------
describe("Phase C exit criterion: storage of D drive", () => {
  it("returns real values, verified, with no other agent touched", async () => {
    const h = makeSession();
    await h.session.handleTranscript("s1", "Tell me the storage of D drive");
    const done = last(h.events);
    expect(done).toMatchObject({ type: "task.completed", verified: true });
    expect((done as { summary: string }).summary).toBe("D: 512.0 GB total, 188.0 GB free (324.0 GB used).");
    expect(h.fs.counts.statfs).toBe(1);
    expect(h.fs.counts.readDirs).toBe(0); // no folder crawling for a simple question
    expect(h.win.state.calls).toBe(0); // desktop agent not started
    expect(h.session.desktopAgent.calls).toBe(0);
    // there is no UI-automation or action capability in this runtime at all, so Explorer can't be opened
  });

  it("emits a working state first and only schema-valid events", async () => {
    const h = makeSession();
    await h.session.handleTranscript("s1", "how much space is free on drive C");
    expect(h.events.map((e) => e.type)).toEqual(["task.state", "task.completed"]);
    for (const e of h.events) expect(RuntimeEventSchema.safeParse(e).success).toBe(true);
  });

  it("answers for all drives when none is named", async () => {
    const h = makeSession();
    await h.session.handleTranscript("s1", "list my drives");
    expect((last(h.events) as { summary: string }).summary).toContain("C: 256.0 GB");
    expect((last(h.events) as { summary: string }).summary).toContain("D: 512.0 GB");
  });
});

describe("orchestrator honesty", () => {
  it("unknown drive: fails with what exists, never success", async () => {
    const h = makeSession();
    await h.session.handleTranscript("s1", "free space on drive Z");
    expect(last(h.events)).toMatchObject({ type: "task.failed", recoverable: true });
    expect((last(h.events) as { summary: string }).summary).toContain("C:, D:");
    expect(h.events.some((e) => e.type === "task.completed")).toBe(false);
  });

  it("does not report numbers that fail verification", async () => {
    const h = makeSession(fakeFs({ drives: { D: { total: 100, free: 500 } } }));
    await h.session.handleTranscript("s1", "storage of D drive");
    expect(last(h.events).type).toBe("task.failed");
    expect(h.events.some((e) => e.type === "task.completed")).toBe(false);
  });

  it("an OS error becomes a recoverable failure, not success and not a crash", async () => {
    const h = makeSession(fakeFs({ statfsThrows: true }));
    await h.session.handleTranscript("s1", "storage of D drive");
    expect(last(h.events)).toMatchObject({ type: "task.failed", recoverable: true });
  });

  it("unrelated speech: no action, back to idle", async () => {
    const h = makeSession();
    await h.session.handleTranscript("s1", "and then he said we should go to lunch");
    expect(h.events).toEqual([{ type: "task.state", taskId: "t1", state: "idle" }]);
    expect(h.fs.counts.statfs + h.fs.counts.readDirs + h.win.state.calls).toBe(0);
  });

  it("ambiguous request: asks a question", async () => {
    const h = makeSession();
    await h.session.handleTranscript("s1", "what can you do");
    expect(last(h.events).type).toBe("task.clarification_required");
  });

  it("tasks it can't do yet are declined honestly", async () => {
    const h = makeSession();
    await h.session.handleTranscript("s1", "open WhatsApp and send hello to Sumeet");
    expect(last(h.events)).toMatchObject({ type: "task.failed" });
    expect((last(h.events) as { summary: string }).summary).toContain("one thing at a time");
  });

  it("every success event is verified:true", async () => {
    const h = makeSession(fakeFs({ tree: { "D:\\": ["Notes"] } }), fakeWin({ activePid: 5, windows: [W(1, 5, "Code", "x")] }));
    for (const t of ["storage of D drive", "which window is active", "what windows are open", "find the notes folder"]) {
      await h.session.handleTranscript("s", t);
    }
    const successes = h.events.filter((e) => e.type === "task.completed");
    expect(successes).toHaveLength(4);
    expect(successes.every((e) => e.verified === true)).toBe(true);
  });
});

describe("desktop questions", () => {
  const win = () => fakeWin({ activePid: 20, windows: [W(1, 10, "chrome", "Inbox - Chrome"), W(2, 20, "Code", "momo - VS Code"), W(3, 999, "electron", "Momo")] });
  it("names the active window", async () => {
    const h = makeSession(fakeFs(), win());
    await h.session.handleTranscript("s", "which window is active");
    expect((last(h.events) as { summary: string }).summary).toBe('The active window is "momo - VS Code" (Code).');
    expect(h.session.fsAgent.calls).toBe(0);
  });
  it("lists other windows and leaves Momo itself out", async () => {
    const h = makeSession(fakeFs(), win());
    await h.session.handleTranscript("s", "what windows are open");
    const s = (last(h.events) as { summary: string }).summary;
    expect(s).toContain("2 open windows");
    expect(s).not.toContain("Momo");
  });
  it("says so when Momo itself is in front", async () => {
    const h = makeSession(fakeFs(), fakeWin({ activePid: 999, windows: [W(3, 999, "electron", "Momo")] }));
    await h.session.handleTranscript("s", "which app is active");
    expect((last(h.events) as { summary: string }).summary).toContain("Momo itself is in front");
  });
});

describe("folder lookup: report ambiguity instead of guessing", () => {
  const tree = {
    "C:\\Users\\me": ["Context Companion"],
    "D:\\": ["Project 2", "Single Folder"],
    "D:\\Project 2": ["Context Companion Ai"],
  };
  it("a unique match is reported after an on-disk re-check", async () => {
    const h = makeSession(fakeFs({ tree }));
    await h.session.handleTranscript("s", "find the single folder");
    expect(last(h.events)).toMatchObject({ type: "task.completed", verified: true });
    expect((last(h.events) as { summary: string }).summary).toContain("D:\\Single Folder");
  });

  it("several matches -> clarification listing them; an answer resolves it", async () => {
    const h = makeSession(fakeFs({ tree }));
    await h.session.handleTranscript("s", "find my context companion project folder");
    const q = last(h.events) as { type: string; question: string };
    expect(q.type).toBe("task.clarification_required");
    expect(q.question).toContain("1) C:\\Users\\me\\Context Companion");
    expect(q.question).toContain("2) D:\\Project 2\\Context Companion Ai");
    expect(h.events.some((e) => e.type === "task.completed")).toBe(false);

    await h.session.handleTranscript("s", "the second one");
    expect(last(h.events)).toMatchObject({ type: "task.completed", verified: true });
    expect((last(h.events) as { summary: string }).summary).toContain("D:\\Project 2\\Context Companion Ai");
  });

  it("cancel drops the question", async () => {
    const h = makeSession(fakeFs({ tree }));
    await h.session.handleTranscript("s", "find context companion folder");
    await h.session.handleTranscript("s", "never mind");
    expect(last(h.events)).toMatchObject({ type: "task.state", state: "idle" });
  });

  it("gives up politely after two unclear answers", async () => {
    const h = makeSession(fakeFs({ tree }));
    await h.session.handleTranscript("s", "find context companion folder");
    await h.session.handleTranscript("s", "hmm");
    expect(last(h.events).type).toBe("task.clarification_required");
    await h.session.handleTranscript("s", "uh");
    expect(last(h.events)).toMatchObject({ type: "task.failed" });
  });

  it("a brand-new request while a question is open is handled normally", async () => {
    const h = makeSession(fakeFs({ tree }));
    await h.session.handleTranscript("s", "find context companion folder");
    await h.session.handleTranscript("s", "storage of D drive");
    expect(last(h.events)).toMatchObject({ type: "task.completed" });
  });

  it("nothing found: failure, not a guess", async () => {
    const h = makeSession(fakeFs({ tree }));
    await h.session.handleTranscript("s", "find the zebra folder");
    expect(last(h.events)).toMatchObject({ type: "task.failed", recoverable: true });
  });

  it("a folder that disappears before reporting is not reported", async () => {
    const f = fakeFs({ tree });
    const orig = f.port.readDirs;
    f.port.readDirs = async (p) => { const r = await orig(p); f.remove("D:\\Single Folder"); return r; };
    const h = makeSession(f);
    await h.session.handleTranscript("s", "find the single folder");
    expect(last(h.events).type).toBe("task.failed");
  });
});

describe("stale observations", () => {
  it("a focus change invalidates the earlier window picture; the next question re-observes", async () => {
    let t = 0;
    const win = fakeWin({ activePid: 1, windows: [W(1, 1, "a", "First")] });
    const h = makeSession(fakeFs(), win, () => t);
    await h.session.handleTranscript("s", "which window is active");
    expect(h.session.world.getFresh("window:1")).toBeDefined();
    h.session.notify("focus_changed");
    expect(h.session.world.getFresh("window:1")).toBeUndefined();
    win.state.snap = { activePid: 2, windows: [W(2, 2, "b", "Second")] };
    await h.session.handleTranscript("s", "which window is active");
    expect((last(h.events) as { summary: string }).summary).toContain("Second");
    expect(win.state.calls).toBe(2);
  });
});

describe("session cleanup on exit", () => {
  it("dispose discards the world model and ignores later requests", async () => {
    const h = makeSession();
    await h.session.handleTranscript("s", "storage of D drive");
    expect(h.session.world.size).toBeGreaterThan(0);
    h.session.dispose();
    expect(h.session.world.size).toBe(0);
    const before = h.events.length;
    await h.session.handleTranscript("s", "storage of C drive");
    expect(h.events.length).toBe(before);
    expect(h.session.world.size).toBe(0);
  });

  it("a result that arrives after cancel is discarded, not shown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const win = fakeWin({ activePid: 1, windows: [W(1, 1, "a", "A")] }, gate);
    const h = makeSession(fakeFs(), win);
    const p = h.session.handleTranscript("s", "which window is active");
    await Promise.resolve();
    h.session.cancelTask();
    release();
    await p;
    expect(h.events.some((e) => e.type === "task.completed")).toBe(false);
  });

  it("dispose during a task emits nothing afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = makeSession(fakeFs(), fakeWin({ activePid: 1, windows: [W(1, 1, "a", "A")] }, gate));
    const p = h.session.handleTranscript("s", "which window is active");
    await Promise.resolve();
    const before = h.events.length;
    h.session.dispose();
    release();
    await p;
    expect(h.events.length).toBe(before);
  });
});
