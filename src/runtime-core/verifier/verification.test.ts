import { describe, expect, it } from "vitest";
import { Verifier } from "./verification";
import { classifyControlRisk } from "../action";
import type { DesktopSnapshot } from "../desktop";

const win = (process: string, title: string, hwnd = 1) => ({ hwnd, pid: hwnd + 100, process, title, active: false, isMomo: false });
const snap = (...windows: ReturnType<typeof win>[]): DesktopSnapshot => ({ windows, active: null } as unknown as DesktopSnapshot);
const v = new Verifier();

describe("folder checks never 'verify' on an empty name", () => {
  it("a non-English folder name is compared by its letters, not erased to nothing", () => {
    expect(v.folderWindow(snap(win("explorer", "प्रोजेक्ट - File Explorer")), "D:\\प्रोजेक्ट").verified).toBe(true);
    expect(v.folderWindow(snap(win("explorer", "Downloads - File Explorer")), "D:\\प्रोजेक्ट").verified).toBe(false);
  });
  it("a name with no letters or digits is refused instead of matching every window", () => {
    expect(v.folderWindow(snap(win("explorer", "Anything - File Explorer")), "D:\\...").verified).toBe(false);
    expect(v.vscodeFolder(snap(win("Code", "main.ts - Visual Studio Code")), "D:\\---").verified).toBe(false);
  });
  it("VS Code folder: forward and back slashes both work", () => {
    const s = snap(win("Code", "index.ts - my-app - Visual Studio Code"));
    expect(v.vscodeFolder(s, "D:\\work\\my-app").verified).toBe(true);
    expect(v.vscodeFolder(s, "D:/work/my-app/").verified).toBe(true);
    expect(v.vscodeFolder(s, "D:\\work\\other").verified).toBe(false);
  });
});

describe("web address check", () => {
  it("the address bar is the strong evidence", () => {
    expect(v.urlShown({ address: "https://github.com/x" }, "github.com")).toMatchObject({ verified: true, confidence: 0.95 });
  });
  it("a tab title only counts for a distinctive site name, not a short one", () => {
    expect(v.urlShown({ selectedTitle: "Mozilla Developer Network" }, "mozilla.org").verified).toBe(true);
    expect(v.urlShown({ selectedTitle: "Cookbook for Everyone" }, "co.uk").verified).toBe(false);
    expect(v.urlShown({ selectedTitle: "X marks the spot" }, "x.com").verified).toBe(false);
  });
});

describe("buttons that can't be taken back are recognised", () => {
  it("asks about leaving, finishing and renaming, not just deleting and sending", () => {
    for (const l of ["Exit", "Quit", "Finish", "Done", "Continue", "Rename", "Disable", "Turn off", "Terminate", "Kill process", "Stop", "Move"]) {
      expect(classifyControlRisk(l), l).toBe("consequential");
    }
  });
  it("still treats harmless navigation as reversible", () => {
    for (const l of ["Close menu", "Back", "Next", "Search", "Open", "Help"]) expect(classifyControlRisk(l), l).toBe("reversible");
  });
});
