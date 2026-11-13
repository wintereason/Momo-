import { describe, expect, it } from "vitest";
import type { UiNode } from "../shared/ports";
import { describeUnderstanding, needsUserSayso, neighbourLabel, searchRemainder, understand, withPicture, type UnderstandCtx } from "./understand";

const n = (o: Partial<UiNode>): UiNode => ({ type: "Button", name: "", enabled: true, offscreen: false, rect: { l: 100, t: 100, w: 100, h: 30 }, ...o });
const win = (items: UiNode[], process = "explorer", title = "Project 2 - File Explorer"): UnderstandCtx => ({ process, title, items });
const pane = n({ type: "Pane", name: "", rect: { l: 0, t: 0, w: 1920, h: 1000 } });

describe("search boxes: what each one searches", () => {
  it("File Explorer's 'Search Project 2' searches inside that folder, and says where the answer came from", () => {
    const box = n({ type: "Edit", name: "Search Project 2", autoId: "TextBox", patterns: ["value"] });
    const u = understand(box, win([pane, box]));
    expect(u.kind).toBe("search_box");
    expect(u.scope).toBe("files and folders inside “Project 2”");
    expect(u.uncertain).toBe(false);
    expect(u.confidence).toBeGreaterThan(0.85);
    expect(u.evidence.join(" ")).toMatch(/names where it searches/);
  });
  it("a browser's address-and-search box is both: addresses and the web", () => {
    const box = n({ type: "Edit", name: "Address and search bar", className: "OmniboxViewViews", patterns: ["value"] });
    const u = understand(box, win([pane, box], "chrome", "Docs - Google Chrome"));
    expect(["address_box", "search_box"]).toContain(u.kind);
    expect(u.scope).toMatch(/web/);
    expect(u.purpose).toMatch(/address/i);
  });
  it("two boxes that both say 'Search' are told apart by what each one searches", () => {
    const side = n({ type: "Edit", name: "Search", panel: "Settings sections", rect: { l: 10, t: 80, w: 300, h: 30 } });
    const top = n({ type: "Edit", name: "Search the web", rect: { l: 600, t: 10, w: 500, h: 30 } });
    const items = [pane, side, top];
    const a = understand(side, win(items, "SystemSettings", "Settings"));
    const b = understand(top, win(items, "SystemSettings", "Settings"));
    expect(a.scope).toMatch(/Settings sections/);
    expect(b.scope).toMatch(/web/i);
    expect(a.scope).not.toBe(b.scope);
  });
  it("a search box whose scope nothing states is NOT guessed: it is uncertain and wants a closer look", () => {
    const box = n({ type: "Edit", name: "Search", rect: { l: 10, t: 10, w: 300, h: 30 } });
    const u = understand(box, win([pane, box], "someapp", "SomeApp"));
    expect(u.kind).toBe("search_box");
    expect(u.scope).toBeNull();
    expect(u.uncertain).toBe(true);
    expect(u.needs).toBe("ocr");
    expect(describeUnderstanding(box, u)).toMatch(/NOT STATED/);
  });
  it("'Search for apps, settings' names its scope; 'Filter' only narrows what is shown", () => {
    expect(searchRemainder("Search for apps, settings and documents")).toBe("apps, settings and documents");
    expect(searchRemainder("Search")).toBeNull();
    const f = n({ type: "Edit", name: "Filter" });
    expect(understand(f, win([pane, f], "app", "App")).purpose).toMatch(/filters/);
  });
  it("uses the developer's AutomationId when the label does not say", () => {
    const box = n({ type: "Edit", name: "", autoId: "SearchBox" });
    const u = understand(box, win([pane, box], "app", "App"));
    expect(u.kind).toBe("search_box");
    expect(u.basis).toContain("metadata");
  });
});

describe("buttons, toggles, menus: what using them does", () => {
  it("a button that expands is a menu opener (from its pattern), not just 'a button'", () => {
    const b = n({ name: "Sort", patterns: ["invoke", "expandcollapse"], expanded: "collapsed" });
    const u = understand(b, win([pane, b]));
    expect(u.effect).toBe("opens_menu");
    expect(u.kind).toBe("menu_button");
  });
  it("a radio button CHOOSES an option; a split button (breadcrumb) does its main action, not 'open a menu'", () => {
    const r = n({ type: "RadioButton", name: "Details", state: "selected", patterns: ["selectionitem"] });
    const ur = understand(r, win([pane, r]));
    expect(ur.effect).toBe("selects");
    expect(ur.purpose).toMatch(/chooses “Details”/);
    const crumb = n({ type: "SplitButton", name: "Local Disk (D:)", patterns: ["invoke", "expandcollapse"], expanded: "collapsed" });
    const uc = understand(crumb, win([pane, crumb]));
    expect(uc.effect).not.toBe("opens_menu");
    expect(uc.purpose).toMatch(/drop-down arrow/);
    const filter = n({ name: "Filter dropdown" });
    expect(understand(filter, win([pane, filter])).effect).toBe("opens_menu");
  });
  it("a checkbox toggles, and says its current state", () => {
    const c = n({ type: "CheckBox", name: "Dark mode", state: "off", patterns: ["toggle"] });
    const u = understand(c, win([pane, c], "app", "App"));
    expect(u.effect).toBe("toggles");
    expect(u.purpose).toMatch(/on or off.*off/);
  });
  it("well-known words give the purpose; destructive ones say it may not be undoable", () => {
    const back = understand(n({ name: "Back", help: "Back" }), win([pane]));
    expect(back.effect).toBe("navigates");
    expect(back.confidence).toBeGreaterThan(0.85);
    expect(understand(n({ name: "Delete" }), win([pane])).purpose).toMatch(/not be undoable/);
  });
  it("a verb counts only when it LEADS the label: 'View site information' is not a 'change the view' button", () => {
    const site = understand(n({ name: "View site information" }), win([pane]));
    expect(site.purpose).not.toMatch(/displayed/);
    expect(site.purpose).toMatch(/what its label says/); // taken at its word, and said to be label-only
    expect(understand(n({ name: "View" }), win([pane])).purpose).toMatch(/displayed/); // the bare "View" menu is the real thing
    expect(understand(n({ name: "Sort" }), win([pane])).purpose).toMatch(/ordered/);
    expect(understand(n({ name: "Sort by name" }), win([pane])).purpose).not.toMatch(/ordered or grouped/);
    expect(understand(n({ name: "Add New Tab" }), win([pane])).purpose).toMatch(/creates/);
    expect(understand(n({ name: "Backup settings" }), win([pane])).purpose).not.toMatch(/previous place/); // 'back' inside 'backup' is nothing
  });
  it("an unfamiliar label is taken at its word and marked label-only (not invented)", () => {
    const u = understand(n({ name: "Frobnicate" }), win([pane]));
    expect(u.purpose).toMatch(/what its label says.*does not say more/);
    expect(u.confidence).toBeLessThan(0.75); // so acting on it still asks
    expect(needsUserSayso(u)).toBe(true);
  });
  it("a text field takes the caption the app tied to it, else the text beside it", () => {
    const tied = n({ type: "Edit", name: "", labelledBy: "Email address" });
    expect(understand(tied, win([pane, tied], "app", "App")).purpose).toMatch(/Email address/);
    const field = n({ type: "Edit", name: "", rect: { l: 300, t: 200, w: 200, h: 30 } });
    const caption = n({ type: "Text", name: "Username:", rect: { l: 200, t: 200, w: 90, h: 30 } });
    expect(neighbourLabel(field, [field, caption])).toBe("Username:");
    const u = understand(field, win([pane, field, caption], "app", "App"));
    expect(u.purpose).toMatch(/Username/);
    expect(u.basis).toEqual(["context"]);
  });
  it("a password field is recognised and never treated as ordinary input", () => {
    const u = understand(n({ type: "Edit", name: "Password", password: true }), win([pane]));
    expect(u.kind).toBe("password_input");
    expect(u.purpose).toMatch(/never/);
  });
});

describe("not everything that is an Edit is a text box", () => {
  it("Explorer's row cells (class UIProperty, grid/table patterns) are table cells, not text fields", () => {
    const cell = n({ type: "Edit", name: "Date modified", className: "UIProperty", autoId: "System.DateModified", patterns: ["value", "griditem", "tableitem"], readOnly: true });
    const u = understand(cell, win([pane, cell]));
    expect(u.kind).toBe("table_cell");
    expect(u.purpose).toMatch(/read-only cell of a table or list: the “Date modified” of one row/);
    expect(u.basis).toEqual(["metadata"]);
  });
});

describe("never guess: unlabeled controls", () => {
  it("an icon-only button with no label, id or help has NO purpose, and asks to be looked at", () => {
    const u = understand(n({ name: "", rect: { l: 1800, t: 10, w: 32, h: 32 } }), win([pane], "app", "App"));
    expect(u.purpose).toBeNull();
    expect(u.uncertain).toBe(true);
    expect(u.needs).toBe("ocr");
    expect(needsUserSayso(u)).toBe(true);
  });
  it("text read from its picture can name it, but a picture alone is never enough to act without asking", () => {
    const b = n({ name: "", rect: { l: 1800, t: 10, w: 32, h: 32 } });
    const u0 = understand(b, win([pane, b], "app", "App"));
    const u1 = withPicture(u0, b, { ocr: ["Settings"] });
    expect(u1.purpose).toMatch(/settings/i);
    expect(u1.basis).toContain("ocr");
    expect(u1.confidence).toBeLessThan(0.75);
    expect(needsUserSayso(u1)).toBe(true);
  });
  it("a picture with no readable text moves on to the visual AI step, still without a purpose", () => {
    const b = n({ name: "" });
    const u1 = withPicture(understand(b, win([pane, b], "app", "App")), b, { ocr: [] });
    expect(u1.purpose).toBeNull();
    expect(u1.needs).toBe("vision");
  });
  it("a visual AI's answer is recorded as such and capped below 'sure'", () => {
    const b = n({ name: "" });
    const u1 = withPicture(understand(b, win([pane, b], "app", "App")), b, { vision: { purpose: "a gear icon that opens settings" } });
    expect(u1.basis).toContain("vision");
    expect(u1.confidence).toBeLessThan(0.75);
    expect(needsUserSayso(u1)).toBe(true);
  });
  it("the placeholder text inside an unscoped search box (read by OCR) settles what it searches", () => {
    const box = n({ type: "Edit", name: "Search", rect: { l: 10, t: 10, w: 300, h: 30 } });
    const u0 = understand(box, win([pane, box], "app", "App"));
    const u1 = withPicture(u0, box, { ocr: ["Search your library"] });
    expect(u1.scope).toMatch(/your library/);
    expect(u1.uncertain).toBe(false);
  });
});
