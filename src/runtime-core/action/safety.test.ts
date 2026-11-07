import {  describe, expect, it } from "vitest";
import { decide, resolveYesNo, DEFAULT_POLICY } from "./safety";
import { ActionAgent } from "./actionAgent";
import { Verifier } from "../verifier";
import type { ActionPort, FsPort } from "../shared/ports";

// ---------- fakes ----------
const TREE: Record<string, string[]> = {
  "C:\\Users\\me": ["Documents"],
  "D:\\": ["Project 2", "Single Folder"],
  "D:\\Project 2": ["Context Companion Ai"],
  "C:\\Users\\me\\Documents": ["Context Companion"],
};
function fakeFs(): { port: FsPort; remove(p: string): void } {
  const exists = new Set<string>();
  for (const [dir, kids] of Object.entries(TREE)) { exists.add(dir.toLowerCase()); kids.forEach((k) => exists.add(`${dir.replace(/\\$/, "")}\\${k}`.toLowerCase())); }
  return {
    remove: (p) => void exists.delete(p.toLowerCase()),
    port: {
      listDriveRoots: async () => ["C:\\", "D:\\"],
      statfs: async () => ({ total: 100, free: 40 }),
      readDirs: async (p) => TREE[p] ?? null,
      stat: async (p) => (exists.has(p.toLowerCase()) ? { isDir: true } : null),
      homeDir: () => "C:\\Users\\me",
    },
  };
}


// ---------- the gate ----------
describe("safety gate", () => {
  it("consequential actions always need confirmation, whatever the policy", () => {
    expect(decide({ risk: "consequential" }, { confirmReversible: false, confirmScreenRead: true })).toBe("confirm");
    expect(decide({ risk: "consequential" }, { confirmReversible: true, confirmScreenRead: true })).toBe("confirm");
  });
  it("reversible actions follow the policy; reads never ask", () => {
    expect(decide({ risk: "reversible" }, { confirmReversible: true, confirmScreenRead: true })).toBe("confirm");
    expect(decide({ risk: "reversible" }, { confirmReversible: false, confirmScreenRead: true })).toBe("allow");
    expect(decide({ risk: "read" }, { confirmReversible: true, confirmScreenRead: true })).toBe("allow");
  });
  it("routine things do not ask by default; decisions always do", () => {
    expect(DEFAULT_POLICY).toEqual({ confirmReversible: false, confirmScreenRead: false });
    expect(decide({ risk: "reversible" }, DEFAULT_POLICY)).toBe("allow");
    expect(decide({ risk: "consequential" }, DEFAULT_POLICY)).toBe("confirm");
  });
  it("never reads consent into unclear or contradictory answers", () => {
    expect(resolveYesNo("yes please")).toBe("yes");
    expect(resolveYesNo("go ahead")).toBe("yes");
    expect(resolveYesNo("no, cancel that")).toBe("no");
    expect(resolveYesNo("yes no")).toBe("unclear");
    expect(resolveYesNo("hmm, maybe")).toBe("unclear");
    expect(resolveYesNo("")).toBe("unclear");
    expect(resolveYesNo("don't")).toBe("no");
  });
});

// ---------- the action agent ----------
describe("ActionAgent", () => {
  const ok: ActionPort = { openPath: async () => "" };
  const f = fakeFs();
  it("refuses UNC, device, relative and traversal paths without calling the OS", async () => {
    let called = 0;
    const a = new ActionAgent(f.port, { openPath: async () => { called++; return ""; } });
    for (const p of ["\\\\server\\share", "\\\\.\\C:\\", "relative\\path", "C:\\a\\..\\b", "file:///C:/x", "calc.exe"]) {
      expect((await a.openFolder(p)).ok).toBe(false);
    }
    expect(called).toBe(0);
  });
  it("re-checks the folder right before acting", async () => {
    const a = new ActionAgent(f.port, ok);
    expect(await a.openFolder("D:\\Gone")).toMatchObject({ ok: false });
    expect(await a.openFolder("D:\\Single Folder")).toEqual({ ok: true });
    expect(a.calls).toBe(1);
  });
  it("reports OS errors instead of pretending", async () => {
    const a = new ActionAgent(f.port, { openPath: async () => "Access denied" });
    expect(await a.openFolder("D:\\Single Folder")).toMatchObject({ ok: false });
  });
  it("without an action port it cannot act at all", async () => {
    expect(await new ActionAgent(f.port, undefined).openFolder("D:\\Single Folder")).toMatchObject({ ok: false });
  });
});

describe("Verifier.folderWindow", () => {
  const v = new Verifier();
  const snap = (title: string, process = "explorer") => ({ windows: [{ hwnd: 1, pid: 1, process, title, active: true, isMomo: false }], active: null });
  it("needs an Explorer window showing that folder", () => {
    expect(v.folderWindow(snap("Single Folder"), "D:\\Single Folder").verified).toBe(true);
    expect(v.folderWindow(snap("Other"), "D:\\Single Folder").verified).toBe(false);
    expect(v.folderWindow(snap("Single Folder", "chrome"), "D:\\Single Folder").verified).toBe(false); // wrong program
  });
});
