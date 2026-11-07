import { describe, expect, it } from "vitest";
import { classifyControlRisk, decide, DEFAULT_POLICY } from "./safety";
import { matchControls, signature, visibleNames } from "../shared/screenText";
import { ActionAgent } from "./actionAgent";
import { Verifier } from "../verifier";
import type {   FsPort, InputPort,    UiNode, WindowState } from "../shared/ports";

// ---------- a fake app window ----------
const N = (type: string, name: string, extra: Partial<UiNode> = {}): UiNode => ({ type, name, enabled: true, offscreen: false, rid: `r${type}${name}`.replace(/\s+/g, "_"), ...extra });

const fs: FsPort = {
  listDriveRoots: async () => ["C:\\"], statfs: async () => ({ total: 100, free: 40 }),
  readDirs: async () => null, stat: async () => ({ isDir: true }), homeDir: () => "C:\\Users\\me",
};



// ---------- risk classification ----------
describe("which clicks always need confirmation", () => {
  it.each(["Delete", "Send", "Send message", "Save", "Save as", "Pay now", "Buy", "Place order", "Sign out", "Log out", "Submit", "OK", "Yes", "Install", "Empty trash", "Remove from cart", "Overwrite", "Confirm", "Allow", "Accept all", "Post", "Publish", "Share"])(
    "%s is consequential", (label) => expect(classifyControlRisk(label)).toBe("consequential"));
  it.each(["Compose", "Back", "Next page", "Expand", "Settings", "Search", "Inbox", "Close menu", "Bold"])(
    "%s is reversible", (label) => expect(classifyControlRisk(label)).toBe("reversible"));
  it("consequential clicks ignore a relaxed policy", () => {
    expect(decide({ risk: "consequential" }, { confirmReversible: false, confirmScreenRead: false })).toBe("confirm");
    expect(decide({ risk: "reversible" }, { confirmReversible: false, confirmScreenRead: true })).toBe("allow");
    expect(DEFAULT_POLICY.confirmReversible).toBe(false); // opening and switching are routine
  });
});

describe("matching what the user named", () => {
  const items = [N("Button", "Send"), N("Button", "Send later"), N("Button", "Cancel"), N("Edit", "Search box"), N("Button", "Hidden", { offscreen: true }), N("Edit", "Pass", { password: true })];
  it("prefers an exact name over partial ones", () => {
    expect(matchControls(items, "send", "click").map((n) => n.name)).toEqual(["Send"]);
    expect(matchControls(items, "later", "click").map((n) => n.name)).toEqual(["Send later"]);
  });
  it("only offers controls of the right kind, visible, and not passwords", () => {
    expect(matchControls(items, "search", "click")).toEqual([]);
    expect(matchControls(items, "search", "type").map((n) => n.name)).toEqual(["Search box"]);
    expect(matchControls(items, "hidden", "click")).toEqual([]);
    expect(matchControls(items, "pass", "type")).toEqual([]);
  });
  it("never returns a control it cannot address exactly", () => {
    expect(matchControls([{ ...N("Button", "Go"), rid: undefined }], "go", "click")).toEqual([]);
  });
  it("lists what it can see for helpful errors, and fingerprints the window", () => {
    expect(visibleNames(items, "click")).toEqual(["Send", "Send later", "Cancel"]);
    expect(signature(items)).toBe(signature([...items].reverse()));
    expect(signature(items)).not.toBe(signature([...items, N("Text", "new")]));
  });
});

// ---------- the action agent's pre-checks ----------
describe("ActionAgent pre-action checks", () => {
  const stateOf = (over: Partial<WindowState>): InputPort => ({
    focusWindow: async () => ({ ok: true }), minimizeWindow: async () => ({ ok: true }), closeWindow: async () => ({ ok: true }),
    windowState: async () => ({ exists: true, minimized: false, pid: 7, foregroundPid: 7, ...over }),
    invokeControl: async () => ({ ok: true }), setControlText: async (_h, _r, _n, t) => ({ ok: true, readBack: t }),
  });
  it("refuses a window that has closed or now belongs to another program", async () => {
    expect((await new ActionAgent(fs, undefined, stateOf({ exists: false })).focusWindow({ hwnd: 1, pid: 7 })).ok).toBe(false);
    const other = await new ActionAgent(fs, undefined, stateOf({ pid: 99 })).closeWindow({ hwnd: 1, pid: 7 });
    expect(other).toMatchObject({ ok: false });
  });
  it("cannot act at all without an input capability", async () => {
    expect((await new ActionAgent(fs, undefined).clickControl({ hwnd: 1, pid: 7, rid: "1", name: "x" })).ok).toBe(false);
  });
  it("won't act on a control it can't identify exactly", async () => {
    const a = new ActionAgent(fs, undefined, stateOf({}));
    expect((await a.clickControl({ hwnd: 1, pid: 7, rid: "", name: "x" })).ok).toBe(false);
    expect((await a.typeText({ hwnd: 1, pid: 7, rid: "1", name: "" }, "hi")).ok).toBe(false);
    expect(a.calls).toBe(0);
  });
  it("limits what can be typed", async () => {
    const a = new ActionAgent(fs, undefined, stateOf({}));
    const t = { hwnd: 1, pid: 7, rid: "1", name: "f" };
    expect((await a.typeText(t, "")).ok).toBe(false);
    expect((await a.typeText(t, "x".repeat(501))).ok).toBe(false);
    expect((await a.typeText(t, "bad\u0007text")).ok).toBe(false);
    expect((await a.typeText(t, "fine")).ok).toBe(true);
  });
});

describe("Verifier for actions", () => {
  const v = new Verifier();
  const s = (o: Partial<WindowState> = {}): WindowState => ({ exists: true, minimized: false, pid: 7, foregroundPid: 7, ...o });
  it("window states", () => {
    expect(v.windowFocused(s(), 7).verified).toBe(true);
    expect(v.windowFocused(s({ foregroundPid: 1 }), 7).verified).toBe(false);
    expect(v.windowFocused(s({ minimized: true }), 7).verified).toBe(false);
    expect(v.windowMinimized(s({ minimized: true })).verified).toBe(true);
    expect(v.windowMinimized(s()).verified).toBe(false);
    expect(v.windowClosed(s({ exists: false })).verified).toBe(true);
    expect(v.windowClosed(s()).verified).toBe(false);
  });
  it("typed text and click effects", () => {
    expect(v.typed("a\r\nb", "a\nb").verified).toBe(true);
    expect(v.typed("abc", "abd").verified).toBe(false);
    expect(v.clickEffect("x", "y", false).verified).toBe(true);
    expect(v.clickEffect("x", "x", false).verified).toBe(false);
    expect(v.clickEffect("x", null, false).verified).toBe(false);
    expect(v.clickEffect("x", null, true).verified).toBe(true);
  });
});
