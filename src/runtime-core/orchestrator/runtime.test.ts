import { describe, expect, it } from "vitest";
import { WorldModel, FRESHNESS_MS } from "../verifier";
import { FileSystemAgent } from "../filesystem";
import { DesktopAgent, sanitizeTitle } from "../desktop";
import { Verifier } from "../verifier";
import type { FsPort, RawWindow, WindowsPort, WindowsSnapshot } from "../shared/ports";

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
