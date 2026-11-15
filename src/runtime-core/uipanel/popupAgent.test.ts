import { describe, expect, it } from "vitest";
import { childrenOf, classifyDialog, describeMenu, dialogButtonRisk, focusedIndex, isRefusedDialog, looksLikeMenu, navigable, normLabel, resolveButton, resolveStep } from "./popupAgent";
import type { MenuEntry, UiNode } from "../shared/ports";

const m = (name: string, over: Partial<MenuEntry> = {}): MenuEntry => ({ name, enabled: true, offscreen: false, focused: false, separator: false, expandable: false, checked: "", shortcut: "", rid: name, depth: 0, parent: -1, ...over });
const n = (type: string, name: string, over: Partial<UiNode> = {}): UiNode => ({ type, name, enabled: true, offscreen: false, rid: `${type}:${name}`, rect: { l: 0, t: 0, w: 10, h: 10 }, ...over });

describe("labels are compared the way a person reads them", () => {
  it("accelerator markers, ellipses, shortcut text, case and spacing do not matter", () => {
    for (const s of ["&Open", "Open…", "Open...", "Open\tCtrl+O", "  OPEN  ", "O&pen"]) expect(normLabel(s), s).toBe("open");
    expect(normLabel("Save &As…")).toBe("save as");
    expect(normLabel("Tom & Jerry")).toBe("tom & jerry"); // a real ampersand stays
  });
  it("different words stay different", () => {
    expect(normLabel("Open")).not.toBe(normLabel("Open with"));
    expect(normLabel("Save")).not.toBe(normLabel("Save as"));
  });
});

describe("menu hierarchy and step resolution", () => {
  const items = [m("Open"), m("More", { expandable: true }), m("Sub one", { depth: 1, parent: 1 }), m("Sub two", { depth: 1, parent: 1 }), m("-", { separator: true }), m("Delete"), m("Disabled", { enabled: false })];
  it("children of an item and of the top", () => {
    expect(childrenOf(items, -1)).toEqual([0, 1, 5, 6]);
    expect(childrenOf(items, 1)).toEqual([2, 3]);
  });
  it("finds exactly one item by exact label", () => {
    expect(resolveStep(items, childrenOf(items, -1), "&open…")).toMatchObject({ kind: "found", index: 0 });
    expect(resolveStep(items, childrenOf(items, 1), "Sub two")).toMatchObject({ kind: "found", index: 3 });
  });
  it("no match is 'none' (never the closest guess), and a label from another level is not found at this one", () => {
    expect(resolveStep(items, childrenOf(items, -1), "Opne")).toMatchObject({ kind: "none" });
    expect(resolveStep(items, childrenOf(items, -1), "Sub one")).toMatchObject({ kind: "none" });
    expect(resolveStep(items, childrenOf(items, -1), "")).toMatchObject({ kind: "none" });
  });
  it("identical duplicates are ambiguous, unless only one is a usable choice", () => {
    const dup = [m("Paste"), m("Paste")];
    expect(resolveStep(dup, [0, 1], "paste")).toMatchObject({ kind: "ambiguous", indexes: [0, 1] });
    const oneLive = [m("Paste", { enabled: false }), m("Paste")];
    expect(resolveStep(oneLive, [0, 1], "paste")).toMatchObject({ kind: "found", index: 1 });
  });
  it("describeMenu shows hierarchy, state and shortcuts, and skips separators", () => {
    const lines = describeMenu([m("Open", { shortcut: "Ctrl+O" }), m("More", { expandable: true }), m("Sub", { depth: 1, parent: 1 }), m("-", { separator: true }), m("Bold", { checked: "on" }), m("Off", { enabled: false })]);
    expect(lines).toEqual(["Open [Ctrl+O]", "More ▸", "  Sub", "Bold (checked)", "Off (disabled)"]);
  });
  it("looksLikeMenu needs a real, named item", () => {
    expect(looksLikeMenu([])).toBe(false);
    expect(looksLikeMenu([m("-", { separator: true })])).toBe(false);
    expect(looksLikeMenu([m("")])).toBe(false);
    expect(looksLikeMenu([m("Open")])).toBe(true);
  });
  it("arrow keys move between enabled, visible, non-separator items of one level; focus is trusted only when exactly one item has it", () => {
    expect(navigable(items, -1)).toEqual([0, 1, 5]);
    expect(focusedIndex([m("a"), m("b", { focused: true })])).toBe(1);
    expect(focusedIndex([m("a"), m("b")])).toBe(-1);
    expect(focusedIndex([m("a", { focused: true }), m("b", { focused: true })])).toBe(-2);
  });
});

describe("dialogs: what kind, what buttons, how risky", () => {
  const win = { kind: "dialog" as const, proc: "app", cls: "#32770" };
  it("a message box: buttons, and the title bar's own buttons are not answers", () => {
    const d = classifyDialog(win, [n("Button", "Yes"), n("Button", "No"), n("Text", "Replace the file?"), n("Button", "Close"), n("Button", "Minimize")]);
    expect(d.category).toBe("message");
    expect(d.buttons.map((b) => b.name)).toEqual(["Yes", "No"]);
    expect(d.textLines).toBe(1);
  });
  it("a file dialog is recognised by its File name field and Open/Save button, and the field's VALUE is never part of the result", () => {
    const d = classifyDialog(win, [n("ComboBox", "File name:", { value: "C:\\Users\\me\\private.docx" }), n("Button", "Open"), n("Button", "Cancel")]);
    expect(d.category).toBe("file");
    expect(d.fileNameField?.name).toBe("File name:");
    expect(JSON.stringify(d)).not.toContain("private");
  });
  it("a file dialog: the edit box (not its drop-down) is the field, and only the command buttons are answers", () => {
    const d = classifyDialog(win, [n("ComboBox", "File name:"), n("Edit", "File name:"), n("Button", "&Open"), n("Button", "Cancel"), n("Button", "New folder"), n("Button", "View Slider")]);
    expect(d.category).toBe("file");
    expect(d.fileNameField?.rid).toBe("Edit:File name:");
    expect(d.buttons.map((b) => b.name)).toEqual(["&Open", "Cancel"]);
  });
  it("a password field or a sign-in prompt is a credential prompt; a secure-desktop process is secure: both are refused", () => {
    expect(classifyDialog(win, [n("Edit", "PIN", { password: true }), n("Button", "OK")]).category).toBe("credential");
    expect(classifyDialog(win, [n("Text", "Enter your password"), n("Edit", "x"), n("Button", "OK")]).category).toBe("credential");
    expect(classifyDialog({ kind: "secure", proc: "consent", cls: "Credential Dialog Xaml Host" }, [n("Button", "Yes")]).category).toBe("secure");
    expect(classifyDialog({ kind: "dialog", proc: "consent", cls: "#32770" }, []).category).toBe("secure");
    for (const c of ["secure", "credential"] as const) expect(isRefusedDialog(c)).toBe(true);
    for (const c of ["file", "message", "permission", "other"] as const) expect(isRefusedDialog(c)).toBe(false);
  });
  it("a permission request is recognised from its words", () => {
    expect(classifyDialog(win, [n("Text", "Allow this app to access your location?"), n("Button", "Allow"), n("Button", "Deny")]).category).toBe("permission");
  });
  it("only backing-out buttons are safe; everything else, including unknown words, needs approval", () => {
    for (const b of ["Cancel", "&No", "Close", "Not now", "Help"]) expect(dialogButtonRisk(b), b).toBe("reversible");
    for (const b of ["OK", "Yes", "Open", "Save", "Replace", "Delete", "Allow", "Don't Save", "Continue", "Frobnicate"]) expect(dialogButtonRisk(b), b).toBe("consequential");
  });
  it("a button is found by exact label; duplicates are ambiguous", () => {
    const b = classifyDialog(win, [n("Button", "Save"), n("Button", "Cancel")]).buttons;
    expect(resolveButton(b, "&save")).toMatchObject({ kind: "found" });
    expect(resolveButton(b, "Discard")).toEqual({ kind: "none" });
    const twin = [{ name: "OK", risk: "consequential" as const, enabled: true }, { name: "OK", risk: "consequential" as const, enabled: true }];
    expect(resolveButton(twin, "ok")).toMatchObject({ kind: "ambiguous" });
  });
});
