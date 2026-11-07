import { describe, expect, it } from "vitest";
import { Session } from "./session";
import type { PlanDecision, PlanStep } from "./ai/prompts";
import type { AiService } from "./ai/service";
import type { RuntimeEvent } from "../../types/runtime-events";
import { isProgramFile } from "../action";
import type { FsPort, RawWindow } from "../shared/ports";

/** Opening files and folders: a clear target is opened at once, several matches are asked about (names + full paths), a program is a decision. */

type Entry = { name: string; isDir: boolean };

function makePc(tree: Record<string, Entry[]>, o: { appears?: boolean } = {}) {
  const windows: RawWindow[] = [{ hwnd: 999, pid: 999, process: "electron", title: "Momo" }];
  const opened: string[] = [];
  let next = 100;
  const known = new Map<string, boolean>();
  for (const [dir, entries] of Object.entries(tree)) {
    known.set(dir.toLowerCase(), true);
    for (const e of entries) known.set((dir.endsWith("\\") ? dir : dir + "\\").toLowerCase() + e.name.toLowerCase(), e.isDir);
  }
  const fs: FsPort = {
    homeDir: () => "C:\\Users\\me",
    listDriveRoots: async () => ["C:\\", "D:\\"],
    statfs: async () => ({ total: 100, free: 50 }),
    readDirs: async (d) => (tree[d] ? tree[d].filter((e) => e.isDir).map((e) => e.name) : null),
    readEntries: async (d) => tree[d] ?? null,
    stat: async (p) => (known.has(p.toLowerCase()) ? { isDir: known.get(p.toLowerCase())! } : null),
  } as FsPort;
  const act = {
    openPath: async (p: string) => {
      opened.push(p);
      if (o.appears !== false) {
        const base = p.split("\\").pop()!;
        const isDir = known.get(p.toLowerCase());
        windows.push(isDir ? { hwnd: next, pid: next, process: "explorer", title: `${base} - File Explorer` } : { hwnd: next, pid: next, process: "viewer", title: `${base} - Viewer` });
        next++;
      }
      return "";
    },
  };
  return { fs, act, windows, opened };
}

function setup(pc: ReturnType<typeof makePc>, script: (PlanDecision | ((steps: PlanStep[]) => PlanDecision))[], opts: { strict?: boolean } = {}) {
  const events: RuntimeEvent[] = [];
  const calls: PlanStep[][] = [];
  let i = 0;
  const ai: AiService = {
    ready: () => true, label: () => "TestAI", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    plan: async (_g, steps) => {
      calls.push(JSON.parse(JSON.stringify(steps)));
      const n = script[Math.min(i++, script.length - 1)];
      return { ok: true, decision: typeof n === "function" ? n(steps) : n, source: "TestAI" };
    },
  };
  const session = new Session({
    fs: pc.fs, win: { query: async () => ({ activePid: null, windows: [...pc.windows] }) }, act: pc.act, emit: (e: RuntimeEvent) => events.push(e),
    selfPids: () => [999], ai, sleep: async () => {}, verifyAttempts: 2,
  } as never);
  session.setPolicy(opts.strict ? { confirmReversible: true, confirmScreenRead: true } : { confirmReversible: false, confirmScreenRead: false });
  return { session, events, calls, last: () => events[events.length - 1], types: () => events.map((e) => e.type) };
}

const open = (query: string, kind?: string): PlanDecision => ({ type: "tool", tool: "open_path", args: { query, ...(kind ? { kind } : {}) } });
const done = (answer: string): PlanDecision => ({ type: "done", answer });

const TREE: Record<string, Entry[]> = {
  "C:\\Users\\me": [{ name: "Documents", isDir: true }, { name: "Projects", isDir: true }, { name: "Downloads", isDir: true }],
  "C:\\Users\\me\\Documents": [{ name: "Resume.pdf", isDir: false }, { name: "Notes.txt", isDir: false }, { name: "Budget 2025.xlsx", isDir: false }, { name: "Budget 2026.xlsx", isDir: false }],
  "C:\\Users\\me\\Downloads": [{ name: "setup.exe", isDir: false }, { name: "Resume.pdf", isDir: false }, { name: "photo.png", isDir: false }],
  "C:\\Users\\me\\Projects": [],
  "C:\\": [],
  "D:\\": [{ name: "Projects", isDir: true }, { name: "Projects archive", isDir: true }, { name: "Music", isDir: true }],
  "D:\\Projects": [], "D:\\Projects archive": [], "D:\\Music": [{ name: "song.mp3", isDir: false }],
};

describe("a clear target is opened at once, with no routine confirmation", () => {
  it("one matching file: opened immediately, then verified, then announced as done", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [open("notes"), done("I opened your notes.")]);
    await t.session.handleTranscript("s", "open my notes");
    expect(t.types()).not.toContain("task.confirmation_required");
    expect(t.types()).not.toContain("task.clarification_required");
    expect(pc.opened).toEqual(["C:\\Users\\me\\Documents\\Notes.txt"]);
    expect(t.last()).toMatchObject({ type: "task.completed", verified: true });
    expect(t.calls[1][0]).toMatchObject({ tool: "open_path", outcome: "ok" });
  });

  it("one matching folder: the same, and Explorer's window is what verifies it", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [open("music", "folder"), done("Opened Music.")]);
    await t.session.handleTranscript("s", "open the music folder");
    expect(pc.opened).toEqual(["D:\\Music"]);
    expect(t.last()).toMatchObject({ type: "task.completed", verified: true });
  });

  it("a unique exact name wins over longer partial matches", async () => {
    const pc = makePc({ ...TREE, "C:\\Users\\me": [], "D:\\": [{ name: "Projects", isDir: true }, { name: "Projects archive", isDir: true }] });
    const t = setup(pc, [open("projects", "folder"), done("Opened.")]);
    await t.session.handleTranscript("s", "open projects");
    expect(pc.opened).toEqual(["D:\\Projects"]);
    expect(t.types()).not.toContain("task.clarification_required");
  });

  it("the announcement line is marked to be spoken, and only for steps that do something", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [{ type: "tool", tool: "find_paths", args: { query: "notes" } }, open("notes"), done("ok")]);
    await t.session.handleTranscript("s", "find and open notes");
    const working = t.events.filter((e) => e.type === "task.state" && e.state === "working") as { message: string; speak?: boolean }[];
    expect(working.find((e) => e.message.startsWith("Looking for"))?.speak).toBe(false);
    expect(working.find((e) => e.message.startsWith("Opening"))?.speak).toBe(true);
  });
});

describe("several matches: all options with names and full paths, then open at once", () => {
  it("shows every match with its full path, as text and as options, and opens nothing yet", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [open("resume"), done("Opened your resume.")]);
    await t.session.handleTranscript("s", "open my resume");
    const q = t.last() as Extract<RuntimeEvent, { type: "task.clarification_required" }>;
    expect(q.type).toBe("task.clarification_required");
    expect(q.question).toContain("I found 2 matches");
    expect(q.question).toContain("C:\\Users\\me\\Documents\\Resume.pdf");
    expect(q.question).toContain("C:\\Users\\me\\Downloads\\Resume.pdf");
    expect(q.options).toEqual([
      { label: "File: Resume.pdf", detail: "C:\\Users\\me\\Documents\\Resume.pdf" },
      { label: "File: Resume.pdf", detail: "C:\\Users\\me\\Downloads\\Resume.pdf" },
    ]);
    expect(pc.opened).toEqual([]);
  });

  it("choosing one by voice ('the second one') opens it immediately, with no further confirmation", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [open("resume"), done("Opened.")]);
    await t.session.handleTranscript("s", "open my resume");
    await t.session.handleTranscript("s", "the second one");
    expect(pc.opened).toEqual(["C:\\Users\\me\\Downloads\\Resume.pdf"]);
    expect(t.types().filter((x) => x === "task.confirmation_required")).toEqual([]);
    expect(t.last()).toMatchObject({ type: "task.completed", verified: true });
  });

  it("choosing by where it is ('the one in documents') works too, and a click answers with its number", async () => {
    const byWords = makePc(TREE);
    const a = setup(byWords, [open("resume"), done("Opened.")]);
    await a.session.handleTranscript("s", "open my resume");
    await a.session.handleTranscript("s", "the one in documents");
    expect(byWords.opened).toEqual(["C:\\Users\\me\\Documents\\Resume.pdf"]);
    const byClick = makePc(TREE);
    const b = setup(byClick, [open("resume"), done("Opened.")]);
    await b.session.handleTranscript("s", "open my resume");
    await b.session.handleTranscript("s", "1"); // what the card's button sends
    expect(byClick.opened).toEqual(["C:\\Users\\me\\Documents\\Resume.pdf"]);
  });

  it("similar names are all listed (budget 2025 and 2026), never guessed between", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [open("budget"), done("Opened.")]);
    await t.session.handleTranscript("s", "open my budget");
    expect((t.last() as { options?: unknown[] }).options).toHaveLength(2);
    expect(pc.opened).toEqual([]);
  });

  it("the same folder name in two places asks which, with both paths", async () => {
    const pc = makePc({ ...TREE, "C:\\Users\\me": [{ name: "Projects", isDir: true }] });
    const t = setup(pc, [open("projects", "folder"), done("Opened.")]);
    await t.session.handleTranscript("s", "open projects");
    const q = t.last() as { question: string };
    expect(q.question).toContain("C:\\Users\\me\\Projects");
    expect(q.question).toContain("D:\\Projects");
  });

  it("'cancel' leaves everything as it was", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [open("resume"), done("x")]);
    await t.session.handleTranscript("s", "open my resume");
    await t.session.handleTranscript("s", "cancel");
    expect(pc.opened).toEqual([]);
  });
});

describe("verification and honest failures", () => {
  it("a file that opened but whose window cannot be seen is reported as not confirmed", async () => {
    const pc = makePc(TREE, { appears: false });
    const t = setup(pc, [open("notes"), done("I opened your notes.")]);
    await t.session.handleTranscript("s", "open my notes");
    expect(t.types()).not.toContain("task.completed");
    expect(t.last()).toMatchObject({ type: "task.state", state: "partial_success" });
    expect(t.calls[1][0]).toMatchObject({ tool: "open_path", outcome: "unverified" });
  });

  it("nothing found: the planner is told why and can say so", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [open("tax return"), { type: "fail", reason: "I couldn't find a file called tax return." }]);
    await t.session.handleTranscript("s", "open my tax return");
    expect(pc.opened).toEqual([]);
    expect(t.calls[1][0]).toMatchObject({ outcome: "failed" });
    expect((t.calls[1][0] as { text: string }).text).toMatch(/Nothing named like "tax return"/);
    expect(t.last()).toMatchObject({ type: "task.failed", summary: "I couldn't find a file called tax return." });
  });

  it("Windows refusing to open it is explained", async () => {
    const pc = makePc(TREE);
    pc.act.openPath = async () => "No application is associated";
    const t = setup(pc, [open("notes"), { type: "fail", reason: "Windows has no program for that file." }]);
    await t.session.handleTranscript("s", "open my notes");
    expect((t.calls[1][0] as { text: string }).text).toMatch(/couldn't open it/);
  });

  it("an exact path that does not exist is refused, not guessed", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [{ type: "tool", tool: "open_path", args: { path: "C:\\Users\\me\\Nothing.docx" } }, { type: "fail", reason: "That file doesn't exist." }]);
    await t.session.handleTranscript("s", "open that");
    expect(pc.opened).toEqual([]);
    expect((t.calls[1][0] as { text: string }).text).toMatch(/does not exist/);
  });
});

describe("only decisions are confirmed", () => {
  it("a program is RUN when opened, so it is confirmed even though opening a document is not", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [open("setup"), done("Started the installer.")]);
    await t.session.handleTranscript("s", "open setup");
    expect(t.last()).toMatchObject({ type: "task.confirmation_required", summary: expect.stringContaining("Opening it will RUN it") });
    expect(pc.opened).toEqual([]);
    await t.session.respondConfirmation((t.last() as { taskId: string }).taskId, true);
    expect(pc.opened).toEqual(["C:\\Users\\me\\Downloads\\setup.exe"]);
  });

  it("declining a program run does nothing", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [open("setup"), done("x")]);
    await t.session.handleTranscript("s", "open setup");
    await t.session.respondConfirmation((t.last() as { taskId: string }).taskId, false);
    expect(pc.opened).toEqual([]);
  });

  it("which file types count as programs", () => {
    for (const p of ["C:\\a\\setup.exe", "C:\\a\\run.BAT", "C:\\a\\x.ps1", "C:\\a\\x.msi", "C:\\a\\link.lnk", "C:\\a\\script.js", "C:\\a\\x.vbs"]) expect(isProgramFile(p), p).toBe(true);
    for (const p of ["C:\\a\\Resume.pdf", "C:\\a\\notes.txt", "C:\\a\\photo.png", "C:\\a\\song.mp3", "C:\\a\\folder", "C:\\a\\exe", "C:\\a.exe\\readme.md"]) expect(isProgramFile(p), p).toBe(false);
  });
});

describe("finding without opening", () => {
  it("find_paths lists files and folders with their full paths and opens nothing", async () => {
    const pc = makePc(TREE);
    const t = setup(pc, [{ type: "tool", tool: "find_paths", args: { query: "resume", kind: "file" } }, done("Found two copies.")]);
    await t.session.handleTranscript("s", "where is my resume");
    expect(pc.opened).toEqual([]);
    const text = (t.calls[1][0] as { text: string }).text;
    expect(text).toContain("C:\\Users\\me\\Documents\\Resume.pdf");
    expect(text).toContain("C:\\Users\\me\\Downloads\\Resume.pdf");
  });
});
