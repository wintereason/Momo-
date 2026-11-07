import { describe, expect, it } from "vitest";
import { AppAgent, cleanAppQuery, matchApps, normalizeUrl } from "./appAgent";
import { browserFromWords, extractPage, hostOf, isPrivateWindow, matchTabs } from "../browser";
import { classify } from "../orchestrator/intent";
import { Session } from "../orchestrator/session";
import { Verifier } from "../verifier";
import type { ActResult, AppEntry, AppsPort, ForegroundPort, FsPort, InputPort, LaunchPort, RawWindow, ScreenPort, UiNode, WindowState, WindowsPort } from "../shared/ports";
import type { DesktopSnapshot, WindowInfo } from "../desktop";
import type { RuntimeEvent } from "../../types/runtime-events";

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

describe("commands", () => {
  it.each([
    ["open notepad", { kind: "open_app", query: "notepad" }],
    ["launch the calculator app", { kind: "open_app", query: "calculator" }],
    ["start google chrome", { kind: "open_app", query: "google chrome" }],
    ["open github.com", { kind: "open_url", url: "https://github.com/" }],
    ["go to youtube dot com", { kind: "open_url", url: "https://youtube.com/" }],
    ["open https://example.org/docs", { kind: "open_url" }],
    ["open my context companion project in vs code", { kind: "open_in_vscode", query: "context companion" }],
    ["open the momo folder in visual studio code", { kind: "open_in_vscode", query: "momo" }],
    ["what tabs are open", { kind: "list_tabs" }],
    ["how many tabs do I have in chrome", { kind: "list_tabs", browser: "chrome" }],
    ["what page am i on", { kind: "current_page" }],
    ["what website is this", { kind: "current_page" }],
    ["switch to the gmail tab", { kind: "switch_tab", query: "gmail" }],
    ["go to the docs tab in edge", { kind: "switch_tab", query: "docs", browser: "msedge" }],
  ])("%s", (t, e) => expect(classify(t)).toMatchObject(e as object));

  it("keeps folders, windows and tasks it can't do apart", () => {
    expect(classify("open the downloads folder").kind).toBe("open_folder");
    expect(classify("go to the downloads folder").kind).toBe("open_folder");
    expect(classify("switch to chrome").kind).toBe("focus_window");
    expect(classify("open notepad and then type hello")).toEqual({ kind: "unsupported", verb: "more than one step" });
    expect(classify("open notepad in vs code").kind).toBe("open_in_vscode");
    expect(classify("open the file in notepad").kind).toBe("unsupported");
    expect(classify("open").kind).toBe("ambiguous");
    expect(classify("what is on this page").kind).toBe("read_screen");
    expect(classify("read this window").kind).toBe("read_screen");
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

// ---------- end to end with fakes ----------
const raw = (hwnd: number, pid: number, process: string, title: string): RawWindow => ({ hwnd, pid, process, title });
const tree: Record<string, string[]> = {
  "C:\\Users\\me": ["Projects"], "C:\\Users\\me\\Projects": ["Alpha App", "Beta App"],
  "D:\\": ["Alpha App Copy", "Single Thing"],
};
const fakeFs = (): FsPort => ({
  listDriveRoots: async () => ["C:\\", "D:\\"], statfs: async () => ({ total: 100, free: 40 }),
  readDirs: async (p) => tree[p] ?? null, stat: async () => ({ isDir: true }), homeDir: () => "C:\\Users\\me",
});

function harness(o: { appears?: boolean; vscodeAppears?: boolean; browser?: boolean; urlShown?: boolean; policy?: "relaxed" } = {}) {
  const windows: RawWindow[] = [raw(1, 10, "explorer", "File Explorer"), raw(999, 999, "electron", "Momo")];
  const state = { active: 999 };
  const log: string[] = [];
  const nextHwnd = { n: 500 };
  const browserWins = o.browser === false ? [] : [raw(200, 20, "chrome", "Inbox - Mail - Google Chrome"), raw(201, 21, "chrome", "Secret - Google Chrome (Incognito)"), raw(300, 30, "msedge", "Docs - Microsoft Edge")];
  windows.push(...browserWins);
  // UI trees of the browser windows
  const trees: Record<number, UiNode[]> = {
    200: [
      { type: "TabItem", name: "Inbox - Mail", enabled: true, offscreen: false, rid: "t1", state: "selected" },
      { type: "TabItem", name: "Project Docs", enabled: true, offscreen: false, rid: "t2", state: "unselected" },
      { type: "Edit", name: "Address and search bar", enabled: true, offscreen: false, value: "https://mail.example.com/u/0/?token=SECRET" },
    ],
    201: [{ type: "TabItem", name: "VERY PRIVATE", enabled: true, offscreen: false, rid: "p1", state: "selected" }],
    300: [
      { type: "TabItem", name: "Docs", enabled: true, offscreen: false, rid: "e1", state: "unselected" },
      { type: "TabItem", name: "Project Docs", enabled: true, offscreen: false, rid: "e2", state: "selected" },
    ],
  };
  const reads: number[] = [];
  const screen: ScreenPort = {
    readUi: async (h) => { reads.push(h); return { ok: true, items: (trees[h] ?? []).map((i) => ({ ...i })), truncated: false }; },
    ocr: async () => ({ ok: false, reason: "no" }),
  };
  const win: WindowsPort = { query: async () => ({ activePid: windows.find((w) => w.hwnd === state.active)?.pid ?? null, windows: [...windows] }) };
  const launch: LaunchPort = {
    launchApp: async (id): Promise<ActResult> => {
      log.push("app:" + id);
      if (o.appears !== false) { const h = nextHwnd.n++; windows.push(raw(h, h, "Notepad", "Untitled - Notepad")); state.active = h; }
      return { ok: true };
    },
    openFolderInVsCode: async (f): Promise<ActResult> => {
      log.push("code:" + f);
      if (o.vscodeAppears !== false) { const h = nextHwnd.n++; windows.push(raw(h, h, "Code", `Welcome - ${f.split("\\").pop()} - Visual Studio Code`)); }
      return { ok: true };
    },
    openUrl: async (u): Promise<ActResult> => {
      log.push("url:" + u);
      if (o.urlShown !== false) { trees[200] = [{ type: "TabItem", name: "Example Domain", enabled: true, offscreen: false, rid: "t9", state: "selected" }, { type: "Edit", name: "Address and search bar", enabled: true, offscreen: false, value: u }]; state.active = 200; }
      return { ok: true };
    },
  };
  const input: InputPort = {
    focusWindow: async () => { log.push("focus"); return { ok: true }; }, minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async (h): Promise<WindowState> => ({ exists: windows.some((w) => w.hwnd === h), minimized: false, pid: windows.find((w) => w.hwnd === h)?.pid ?? 0, foregroundPid: null }),
    invokeControl: async (h, rid) => { log.push(`select:${h}:${rid}`); trees[h] = trees[h].map((n) => (n.type === "TabItem" ? { ...n, state: n.rid === rid ? "selected" : "unselected" } : n)); return { ok: true }; },
    setControlText: async (_h, _r, _n, t) => ({ ok: true, readBack: t }),
  };
  const fg: ForegroundPort = { lastExternal: () => ({ hwnd: 200, pid: 20, title: "Inbox - Mail - Google Chrome" }) };
  const events: RuntimeEvent[] = [];
  const session = new Session({
    fs: fakeFs(), win, screen, input, apps: { list: async () => APPS }, launch, foreground: fg,
    emit: (e) => events.push(e), selfPids: () => [999], sleep: async () => {},
  });
  if (o.policy === "relaxed") session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  return { session, events, log, reads, windows, last: () => events[events.length - 1], types: () => events.map((e) => e.type) };
}
const confirmId = (e: RuntimeEvent[]) => (e.find((x) => x.type === "task.confirmation_required") as { taskId: string }).taskId;
const text = (e: RuntimeEvent) => (e as { summary?: string; question?: string; message?: string }).summary ?? (e as { question?: string }).question ?? (e as { message?: string }).message ?? "";

describe("opening an app", () => {
  it("asks first, starts exactly that app from the OS list, and verifies the window", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open notepad");
    expect(h.last()).toMatchObject({ type: "task.confirmation_required" });
    expect(text(h.last())).toBe("Open Notepad?");
    expect(h.log).toEqual([]);
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.log).toEqual(["app:" + APPS[0].id]);
    expect(h.last()).toMatchObject({ type: "task.completed", verified: true });
  });
  it("decline starts nothing", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open notepad");
    await h.session.respondConfirmation(confirmId(h.events), false);
    expect(h.log).toEqual([]);
  });
  it("started but no window seen -> partial, never success", async () => {
    const h = harness({ appears: false });
    await h.session.handleTranscript("s", "open notepad");
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.log).toHaveLength(1);
    expect(h.last()).toMatchObject({ type: "task.state", state: "partial_success" });
    expect(h.types()).not.toContain("task.completed");
  });
  it("unknown app: says so and suggests the folder wording", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open zzqxapp");
    expect(h.last()).toMatchObject({ type: "task.failed" });
    expect(text(h.last())).toContain("folder");
    expect(h.log).toEqual([]);
  });
  it("several matches: asks which, then confirms the chosen one", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open microsoft");
    expect(h.last()).toMatchObject({ type: "task.clarification_required" });
    expect(h.log).toEqual([]);
    await h.session.handleTranscript("s", "the second one");
    expect(text(h.last())).toBe("Open Microsoft Word?");
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.log).toEqual(["app:Word.1"]);
  });
  it("relaxed policy: a harmless app opens straight away and is still verified", async () => {
    const h = harness({ policy: "relaxed" });
    await h.session.handleTranscript("s", "open calculator");
    expect(h.types()).not.toContain("task.confirmation_required");
    expect(h.log).toHaveLength(1);
  });
  it("cancel/dispose drop a pending app launch", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open notepad");
    h.session.cancelTask();
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.log).toEqual([]);
  });
});

describe("multi-agent: open a folder in VS Code", () => {
  it("finds the folder, asks, opens it in VS Code, and verifies the window", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single thing folder in vs code");
    expect(h.last()).toMatchObject({ type: "task.confirmation_required" });
    expect(text(h.last())).toContain("D:\\Single Thing");
    expect(text(h.last())).toContain("Visual Studio Code");
    expect(h.log).toEqual([]);
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.log).toEqual(["code:D:\\Single Thing"]);
    expect(h.last()).toMatchObject({ type: "task.completed", verified: true });
  });
  it("several matching folders: asks which one first, never guesses", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the alpha app project in vs code");
    expect(h.last()).toMatchObject({ type: "task.clarification_required" });
    expect(h.log).toEqual([]);
    await h.session.handleTranscript("s", "the first one");
    expect(h.last().type).toBe("task.confirmation_required");
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.log).toHaveLength(1);
  });
  it("no window showing the folder -> partial", async () => {
    const h = harness({ vscodeAppears: false });
    await h.session.handleTranscript("s", "open the single thing folder in vs code");
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.last()).toMatchObject({ type: "task.state", state: "partial_success" });
  });
  it("a folder that doesn't exist is reported, not opened", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the unicorn folder in vs code");
    expect(h.last()).toMatchObject({ type: "task.failed" });
    expect(h.log).toEqual([]);
  });
});

describe("opening a website", () => {
  it("asks first (showing the address), opens it in the default browser, verifies the page", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open example.com");
    expect(text(h.last())).toContain("example.com");
    expect(h.log).toEqual([]);
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.log).toEqual(["url:https://example.com/"]);
    expect(h.last()).toMatchObject({ type: "task.completed", verified: true });
  });
  it("browser never shows it -> partial", async () => {
    const h = harness({ urlShown: false });
    await h.session.handleTranscript("s", "open example.com");
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.last()).toMatchObject({ type: "task.state", state: "partial_success" });
  });
  it("never opens non-web or credentialed addresses", async () => {
    for (const phrase of ["open javascript:alert(1)", "open file:///C:/Windows", "open http://user:pw@evil.com"]) {
      const h = harness();
      await h.session.handleTranscript("s", phrase);
      expect(h.log, phrase).toEqual([]);
      expect(h.types(), phrase).not.toContain("task.completed");
    }
  });
});

describe("browser windows, tabs and pages", () => {
  it("lists windows and tabs separately, with the current tab, never reading private windows", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "what tabs are open");
    expect(h.last()).toMatchObject({ type: "task.confirmation_required" }); // browsing data is private
    expect(h.reads).toEqual([]);
    await h.session.respondConfirmation(confirmId(h.events), true);
    const s = text(h.last());
    expect(s).toContain("2 browser windows");
    expect(s).toContain("Chrome: 2 tabs");
    expect(s).toContain("“Inbox - Mail” (current)");
    expect(s).toContain("Edge: 2 tabs");
    expect(JSON.stringify(h.events)).not.toContain("VERY PRIVATE");
    expect(h.reads).not.toContain(201); // the Incognito window was never even opened
  });
  it("can be limited to one browser", async () => {
    const h = harness({ policy: "relaxed" });
    await h.session.handleTranscript("s", "what tabs are open in edge");
    expect(text(h.last())).toContain("Edge");
    expect(text(h.last())).not.toContain("Chrome");
  });
  it("says what the current page is by site only, never reading out the full address", async () => {
    const h = harness({ policy: "relaxed" });
    await h.session.handleTranscript("s", "what page am i on");
    const s = text(h.last());
    expect(s).toContain("Inbox - Mail");
    expect(s).toContain("mail.example.com");
    expect(JSON.stringify(h.events)).not.toContain("SECRET");
  });
  it("reports honestly when there is no browser, or only private ones", async () => {
    const none = harness({ browser: false, policy: "relaxed" });
    await none.session.handleTranscript("s", "what tabs are open");
    expect(none.last()).toMatchObject({ type: "task.failed" });
  });
  it("tab titles on screen are data: a title that sounds like an order does nothing", async () => {
    const h = harness({ policy: "relaxed" });
    h.windows.push(raw(400, 40, "firefox", "ok - Firefox"));
    await h.session.handleTranscript("s", "what tabs are open in chrome");
    expect(h.log).toEqual([]);
  });
});

describe("switching tabs", () => {
  it("asks, selects exactly that tab, verifies by the selection change, and brings the window forward", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "switch to the docs tab in edge");
    expect(h.last()).toMatchObject({ type: "task.confirmation_required" });
    expect(text(h.last())).toContain("Edge");
    expect(h.log).toEqual([]);
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.log).toContain("select:300:e1");
    expect(h.log).toContain("focus");
    expect(h.last()).toMatchObject({ type: "task.completed", verified: true });
  });
  it("a tab that is already showing is reported, not clicked", async () => {
    const h = harness({ policy: "relaxed" });
    await h.session.handleTranscript("s", "switch to the inbox tab");
    expect(h.last()).toMatchObject({ type: "task.completed", verified: true });
    expect(text(h.last())).toContain("already the one showing");
    expect(h.log).toEqual([]);
  });
  it("the same title in two browsers: asks which", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "switch to the project docs tab");
    expect(h.last()).toMatchObject({ type: "task.clarification_required" });
    expect(h.log).toEqual([]);
    await h.session.handleTranscript("s", "the first one");
    expect(h.last().type).toBe("task.confirmation_required");
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.log.some((l) => l.startsWith("select:"))).toBe(true);
  });
  it("a tab that doesn't exist, or exists only in a private window, is not found (and not revealed)", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "switch to the very private tab");
    expect(h.last()).toMatchObject({ type: "task.failed" });
    expect(text(h.last())).not.toContain("VERY PRIVATE");
    expect(h.log).toEqual([]);
  });
});
