import { describe, expect, it } from "vitest";
import { FileSystemAgent, normalizeName, type SearchLimits } from "./filesystemAgent";
import { WorldModel } from "../verifier";
import type { FsPort } from "../shared/ports";

const limits: SearchLimits = { homeDepth: 3, driveDepth: 2, maxDirs: 1000, maxMs: 5000, maxResults: 25, readMs: 30 };
const fakeFs = (tree: Record<string, string[] | "hang">): FsPort => ({
  homeDir: () => "C:\\Users\\me",
  listDriveRoots: async () => ["C:\\", "D:\\"],
  statfs: async () => ({ total: 100, free: 40 }),
  readDirs: (dir: string) => (tree[dir] === "hang" ? new Promise(() => {}) : Promise.resolve((tree[dir] as string[] | undefined) ?? null)),
  stat: async () => ({ isDir: true }),
} as unknown as FsPort);

describe("FileSystemAgent", () => {
  it("finds folders whose names are in another language", async () => {
    const a = new FileSystemAgent(new WorldModel(), fakeFs({ "C:\\Users\\me": ["प्रोजेक्ट", "Music"] }), Date.now, limits);
    const r = await a.findFolders("प्रोजेक्ट");
    expect(r.matches.map((m) => m.name)).toEqual(["प्रोजेक्ट"]);
    expect(normalizeName("प्रोजेक्ट")).not.toBe("");
  });
  it("a hung drive does not use up the whole search", async () => {
    const a = new FileSystemAgent(new WorldModel(), fakeFs({ "C:\\Users\\me": ["Music"], "C:\\": "hang", "D:\\": ["my-app"] }), Date.now, limits);
    const t0 = Date.now();
    const r = await a.findFolders("my-app");
    expect(r.matches.map((m) => m.path)).toEqual(["D:\\my-app"]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it("several matches are all returned, never one guessed", async () => {
    const a = new FileSystemAgent(new WorldModel(), fakeFs({ "C:\\Users\\me": ["notes"], "D:\\": ["notes"] }), Date.now, limits);
    expect((await a.findFolders("notes")).matches).toHaveLength(2);
  });
  it("a bad drive letter is 'not found', not a crash", async () => {
    const a = new FileSystemAgent(new WorldModel(), fakeFs({}), Date.now, limits);
    for (const l of ["", "DD", "1", "D:"]) expect(await a.drive(l), l).toMatchObject({ kind: "not_found" });
    expect(await a.drive("d")).toMatchObject({ kind: "ok" });
  });
});
