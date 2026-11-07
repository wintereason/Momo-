import { describe, expect, it } from "vitest";
import { AppAgent, cleanAppQuery, matchApps, normalizeUrl } from "./appAgent";
import { browserFromWords, extractPage, hostOf, isPrivateWindow, matchTabs } from "../browser";
import { Verifier } from "../verifier";
import type {  AppEntry, AppsPort,  FsPort,  LaunchPort,   UiNode } from "../shared/ports";
import type { DesktopSnapshot, WindowInfo } from "../desktop";

const APPS: AppEntry[] = [
  { name: "Notepad", id: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
  { name: "Calculator", id: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
  { name: "Google Chrome", id: "Chrome" },
  { name: "Microsoft Edge", id: "MSEdge" },
  { name: "Microsoft Word", id: "Word.1" },
  { name: "Microsoft Excel", id: "Excel.1" },
  { name: "Visual Studio Code", id: "Microsoft.VisualStudioCode" },
  { name: "Firefox", id: "FF1" },
  { name: "Firefox Private Browsing", id: "FF1;Private" },
];

// ---------- pure helpers ----------
describe("app matching", () => {
  it("prefers an exact name, then names that start with it", () => {
    expect(matchApps(APPS, "notepad").map((a) => a.name)).toEqual(["Notepad"]);
    expect(matchApps(APPS, "chrome").map((a) => a.name)).toEqual(["Google Chrome"]);
    expect(matchApps(APPS, "visual studio code").map((a) => a.name)).toEqual(["Visual Studio Code"]);
  });
  it("finds several when it is genuinely ambiguous", () => {
    expect(matchApps(APPS, "microsoft").map((a) => a.name)).toEqual(["Microsoft Edge", "Microsoft Word", "Microsoft Excel"]);
    expect(matchApps(APPS, "firefox")).toHaveLength(1); // exact beats the private-browsing entry
  });
  it("returns nothing for gibberish or empty input", () => {
    expect(matchApps(APPS, "zzqx")).toEqual([]);
    expect(matchApps(APPS, "   ")).toEqual([]);
    expect(cleanAppQuery("the Notepad app please")).toBe("notepad");
  });
});

describe("web addresses", () => {
  it("accepts plain http(s) addresses and spoken 'dot'", () => {
    expect(normalizeUrl("github.com")).toMatchObject({ url: "https://github.com/", host: "github.com" });
    expect(normalizeUrl("https://www.example.com/a/b?x=1")).toMatchObject({ host: "example.com" });
    expect(normalizeUrl("github dot com")).toMatchObject({ host: "github.com" });
    expect(normalizeUrl("localhost:3000")).toMatchObject({ host: "localhost" });
  });
  it("refuses everything else", () => {
    for (const bad of ["javascript:alert(1)", "file:///C:/Windows/system32", "data:text/html,hi", "ftp://x.com", "http://user:pass@evil.com", "notepad", "my folder", "", "a.b", "calc.exe /c format"]) {
      expect(normalizeUrl(bad), bad).toBeNull();
    }
  });
});

describe("browser helpers", () => {
  const items: UiNode[] = [
    { type: "TabItem", name: "Inbox - Mail", enabled: true, offscreen: false, rid: "1", state: "selected" },
    { type: "TabItem", name: "Docs", enabled: true, offscreen: false, rid: "2", state: "unselected" },
    { type: "TabItem", name: "Hidden", enabled: true, offscreen: true, rid: "3" },
    { type: "Edit", name: "Address and search bar", enabled: true, offscreen: false, value: "https://mail.example.com/u/0/?token=SECRET" },
  ];
  it("tells tabs apart from the page and the address", () => {
    const p = extractPage(items);
    expect(p.tabs.map((t) => t.name)).toEqual(["Inbox - Mail", "Docs"]);
    expect(p.tabs.find((t) => t.selected)?.name).toBe("Inbox - Mail");
    expect(p.address).toContain("mail.example.com");
  });
  it("reduces an address to its site so tokens in the URL are never read out", () => {
    expect(hostOf("https://www.mail.example.com/u/0/?token=SECRET")).toBe("mail.example.com");
    expect(hostOf("mail.example.com/x")).toBe("mail.example.com");
    expect(hostOf(undefined)).toBeUndefined();
  });
  it("recognises private windows and browser names, and matches tab titles", () => {
    expect(isPrivateWindow("New tab - Google Chrome (Incognito)")).toBe(true);
    expect(isPrivateWindow("Docs - Microsoft Edge [InPrivate]")).toBe(true);
    expect(isPrivateWindow("Docs - Google Chrome")).toBe(false);
    expect(browserFromWords("what tabs are open in google chrome")).toBe("chrome");
    expect(browserFromWords("in edge")).toBe("msedge");
    expect(matchTabs(extractPage(items).tabs, "docs").map((t) => t.name)).toEqual(["Docs"]);
  });
});

describe("verification", () => {
  const v = new Verifier();
  const W = (hwnd: number, title: string, process: string, active = false): WindowInfo => ({ hwnd, pid: hwnd, title, process, active, isMomo: false });
  const snap = (windows: WindowInfo[]): DesktopSnapshot => ({ windows, active: windows.find((w) => w.active) ?? null });
  it("an app counts as opened only when its window is new or in front", () => {
    expect(v.appWindow(snap([W(2, "Untitled - Notepad", "Notepad")]), new Set([1]), "Notepad").verified).toBe(true);
    expect(v.appWindow(snap([W(1, "Untitled - Notepad", "Notepad")]), new Set([1]), "Notepad").verified).toBe(false); // was already there
    expect(v.appWindow(snap([W(1, "Untitled - Notepad", "Notepad", true)]), new Set([1]), "Notepad").verified).toBe(true); // brought to front
    expect(v.appWindow(snap([W(3, "Something else", "other")]), new Set(), "Notepad").verified).toBe(false);
  });
  it("VS Code must show that very folder", () => {
    expect(v.vscodeFolder(snap([W(1, "Welcome - My Project - Visual Studio Code", "Code")]), "D:\\x\\My Project").verified).toBe(true);
    expect(v.vscodeFolder(snap([W(1, "Other - Visual Studio Code", "Code")]), "D:\\x\\My Project").verified).toBe(false);
    expect(v.vscodeFolder(snap([W(1, "My Project - Notepad", "Notepad")]), "D:\\x\\My Project").verified).toBe(false);
  });
  it("a website counts as opened only when the browser shows that site", () => {
    expect(v.urlShown({ address: "https://github.com/foo" }, "github.com").verified).toBe(true);
    expect(v.urlShown({ address: "https://evil-github.com.attacker.io/" }, "github.com").verified).toBe(false);
    expect(v.urlShown({ selectedTitle: "GitHub: Let's build" }, "github.com").verified).toBe(true);
    expect(v.urlShown({ address: "https://other.com" }, "github.com").verified).toBe(false);
  });
});

describe("AppAgent safety", () => {
  const fs: FsPort = { listDriveRoots: async () => ["C:\\"], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => null, stat: async (p) => (p.startsWith("D:\\ok") ? { isDir: true } : null), homeDir: () => "C:\\Users\\me" };
  const launch = (log: string[]): LaunchPort => ({
    launchApp: async (id) => { log.push("app:" + id); return { ok: true }; },
    openFolderInVsCode: async (f) => { log.push("code:" + f); return { ok: true }; },
    openUrl: async (u) => { log.push("url:" + u); return { ok: true }; },
  });
  const apps: AppsPort = { list: async () => APPS };

  it("only launches ids that came from the OS app list", async () => {
    const log: string[] = [];
    const a = new AppAgent(apps, launch(log), fs);
    expect((await a.launchApp({ name: "x", id: "calc.exe /c format C:" })).ok).toBe(false); // before the index was read
    await a.search("notepad");
    expect((await a.launchApp({ name: "x", id: "calc.exe /c format C:" })).ok).toBe(false);
    expect((await a.launchApp(APPS[0])).ok).toBe(true);
    expect(log).toEqual(["app:" + APPS[0].id]);
  });
  it("only passes real local folders to another program", async () => {
    const log: string[] = [];
    const a = new AppAgent(apps, launch(log), fs);
    for (const bad of ["\\\\server\\share", "-g C:\\x", "relative", "D:\\ok\\..\\x", "D:\\missing"]) expect((await a.openFolderInVsCode(bad)).ok, bad).toBe(false);
    expect((await a.openFolderInVsCode("D:\\ok\\proj")).ok).toBe(true);
    expect(log).toEqual(["code:D:\\ok\\proj"]);
  });
  it("only opens plain web addresses", async () => {
    const log: string[] = [];
    const a = new AppAgent(apps, launch(log), fs);
    expect((await a.openUrl("javascript:alert(1)")).ok).toBe(false);
    expect((await a.openUrl("https://example.com")).ok).toBe(true);
    expect(log).toEqual(["url:https://example.com/"]);
  });
  it("caches the app list, and cannot act without ports", async () => {
    let n = 0;
    const a = new AppAgent({ list: async () => { n++; return APPS; } }, launch([]), fs);
    await a.search("notepad"); await a.search("chrome");
    expect(n).toBe(1);
    expect((await new AppAgent(undefined, undefined, fs).search("x")).ok).toBe(false);
    expect((await new AppAgent(apps, undefined, fs).openUrl("https://a.com")).ok).toBe(false);
  });
});
