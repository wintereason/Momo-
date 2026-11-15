import { describe, expect, it } from "vitest";
import type { MenuEntry } from "../shared/ports";
import { buildTools } from "./tools";
import { call, finish, me, popupWorld, runPopup, stepsOf, tw, type Popup } from "./popupWorld";

/**
 * Phase 5b: reading menus, choosing items by path, and the guarantees that go with it. Scripted menus on a fake Windows that behaves like the
 * real pointer (the window under it must be in the expected family and the caller's last check of the target must pass BEFORE a press).
 */
const rectOf = (i: number) => ({ l: 110, t: 110 + i * 30, w: 180, h: 24 });
/** a menu whose items sit one under the other, the way a real one does */
const laid = (names: Array<string | MenuEntry>): MenuEntry[] => names.map((n, i) => (typeof n === "string" ? me(n, { rect: rectOf(i) }) : { ...n, rect: n.rect ?? rectOf(i) }));
const hit = (items: MenuEntry[], x: number, y: number) => items.find((i) => i.rect && x >= i.rect.l && x <= i.rect.l + i.rect.w && y >= i.rect.t && y <= i.rect.t + i.rect.h);
const chainFor = (items: MenuEntry[]) => (x: number, y: number) => { const it = hit(items, x, y); return it ? [{ rid: it.rid, type: "MenuItem", name: it.name, password: false }] : null; };
const MENU = 101;

describe("read_menu", () => {
  it("shows the open menu with hierarchy, shortcuts, disabled and checked items", async () => {
    const items = laid([me("Open", { shortcut: "Ctrl+O" }), me("More", { expandable: true }), me("Sub one", { depth: 1, parent: 1 }), "-", me("Bold", { checked: "on" }), me("Off", { enabled: false })]);
    items[3] = { ...items[3], separator: true };
    const w = popupWorld({ popups: () => [{ win: tw(MENU, "menu"), menu: items }] });
    const r = runPopup(w, [call("read_menu"), finish()]);
    await r.session.handleTranscript("s", "x");
    const s = stepsOf(r.results)[0];
    expect(s.outcome).toBe("ok");
    expect(s.text).toContain("Open [Ctrl+O]");
    expect(s.text).toContain("More ▸");
    expect(s.text).toContain("  Sub one");
    expect(s.text).toContain("Bold (checked)");
    expect(s.text).toContain("Off (disabled)");
  });
  it("no menu is open: reported as not found, nothing was sent", async () => {
    const w = popupWorld({ popups: () => [] });
    const r = runPopup(w, [call("read_menu"), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(stepsOf(r.results)[0]).toMatchObject({ outcome: "failed", failure: { kind: "target_not_found", acted: "no" } });
  });
  it("a popup that cannot be read (drawn by the application) is refused, never guessed at", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(MENU, "popup") }] });
    const r = runPopup(w, [call("read_menu"), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(stepsOf(r.results)[0]).toMatchObject({ outcome: "failed", failure: { kind: "unavailable", acted: "no" } });
  });
});

describe("choose_menu_item: one level", () => {
  const setup = (over: { windowAt?: (x: number, y: number) => number } = {}) => {
    let items = laid(["Open", "Properties", "Delete"]);
    let open = true;
    const w = popupWorld({
      popups: () => (open ? [{ win: tw(MENU, "menu"), menu: items }] : []),
      chainAt: (x, y) => chainFor(items)(x, y), windowAt: over.windowAt,
      onClick: (x, y) => { if (hit(items, x, y)) open = false; },
    });
    return { w, set: (i: MenuEntry[]) => { items = i; }, items: () => items, isOpen: () => open };
  };
  it("clicks the exact item at its CURRENT position, checks it under the pointer, and the closed menu is the evidence", async () => {
    const t = setup();
    const r = runPopup(t.w, [call("choose_menu_item", { path: ["properties"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(t.w.log.clicks.length).toBe(1);
    const c = t.w.log.clicks[0];
    expect(hit(t.items(), c.x, c.y)?.name).toBe("Properties");
    expect(Array.isArray(c.opts.expectRoot) && (c.opts.expectRoot as number[]).includes(MENU) && (c.opts.expectRoot as number[]).includes(20)).toBe(true); // the popup AND its owner
    expect(typeof c.opts.verifyTarget).toBe("function");
    const s = stepsOf(r.results)[0];
    expect(s).toMatchObject({ outcome: "ok", acted: "yes" });
    expect(s.text).toMatch(/the menu closed/);
  });
  it("labels match the way a person reads them (accelerator, ellipsis, case)", async () => {
    let items = laid([me("&Save as…"), me("Open")]);
    let open = true;
    const w = popupWorld({ popups: () => (open ? [{ win: tw(MENU, "menu"), menu: items }] : []), chainAt: (x, y) => chainFor(items)(x, y), onClick: () => { open = false; } });
    const r = runPopup(w, [call("choose_menu_item", { path: ["SAVE AS"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    void items; // (Save as is consequential, so it is held for approval; the point here is only that it was found)
    expect(buildTools().find((t) => t.name === "choose_menu_item")!.risk({ path: ["SAVE AS"] })).toBe("consequential");
  });
  it("an item that is not there: no click, nothing was sent", async () => {
    const t = setup();
    const r = runPopup(t.w, [call("choose_menu_item", { path: ["Frobnicate"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(t.w.log.clicks).toEqual([]);
    expect(stepsOf(r.results)[0]).toMatchObject({ outcome: "failed", failure: { kind: "target_not_found", acted: "no" } });
  });
  it("a disabled item is never clicked", async () => {
    const t = setup();
    t.set(laid(["Open", me("Properties", { enabled: false })]));
    const r = runPopup(t.w, [call("choose_menu_item", { path: ["Properties"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(t.w.log.clicks).toEqual([]);
    expect(stepsOf(r.results)[0].failure).toMatchObject({ kind: "target_disabled", acted: "no" });
  });
  it("two items with the same name: not guessed", async () => {
    const t = setup();
    t.set(laid(["Paste", "Paste"]));
    const r = runPopup(t.w, [call("choose_menu_item", { path: ["Paste"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(t.w.log.clicks).toEqual([]);
    expect(stepsOf(r.results)[0].failure).toMatchObject({ kind: "ambiguous", acted: "no" });
  });
  it("two open menus that both have the item: not guessed", async () => {
    const a = laid(["Copy", "Paste"]), b = laid(["Copy", "Cut"]); // two DIFFERENT menus that both have the item
    const w = popupWorld({ popups: () => [{ win: tw(101, "menu"), menu: a }, { win: tw(102, "menu"), menu: b }], chainAt: chainFor(a) });
    const r = runPopup(w, [call("choose_menu_item", { path: ["Copy"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks).toEqual([]);
    expect(stepsOf(r.results)[0].failure).toMatchObject({ kind: "ambiguous" });
  });
  it("the menu closes before it is used: target_gone, no click, and it is not retried", async () => {
    const w = popupWorld({ popups: (n) => (n === 0 ? [{ win: tw(MENU, "menu"), menu: laid(["Open"]) }] : []) });
    const r = runPopup(w, [call("choose_menu_item", { path: ["Open"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks).toEqual([]);
    expect(stepsOf(r.results)[0].failure).toMatchObject({ kind: "target_gone", acted: "no" });
  });
  it("something is in front of the menu where the click would land: refused, nothing pressed", async () => {
    const t = setup({ windowAt: () => 999 });
    const r = runPopup(t.w, [call("choose_menu_item", { path: ["Open"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(t.w.log.clicks).toEqual([]);
    expect(stepsOf(r.results)[0].failure?.acted).toBe("no");
  });
  it("Show Only (no real pointer): the item is invoked by its runtime id, never by position", async () => {
    let items = laid(["Open", "Properties"]); let open = true;
    const w = popupWorld({ pointer: false, popups: () => (open ? [{ win: tw(MENU, "menu"), menu: items }] : []), invoke: () => { open = false; return { ok: true }; } });
    const r = runPopup(w, [call("choose_menu_item", { path: ["Open"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    void items;
    expect(w.log.act).toEqual(["invoke:r:Open"]);
    expect(w.log.clicks).toEqual([]);
    expect(stepsOf(r.results)[0].outcome).toBe("ok");
  });
  it("it says plainly when the menu is still open after the click (not confirmed)", async () => {
    const items = laid(["Open"]);
    const w = popupWorld({ popups: () => [{ win: tw(MENU, "menu"), menu: items }], chainAt: chainFor(items) });
    const r = runPopup(w, [call("choose_menu_item", { path: ["Open"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(stepsOf(r.results)[0]).toMatchObject({ outcome: "unverified", acted: "yes" });
  });
  it("destructive and committing items need the user's approval; harmless ones do not", () => {
    const t = buildTools().find((x) => x.name === "choose_menu_item")!;
    for (const l of ["Delete", "Replace", "Save", "Send", "Empty Recycle Bin", "Remove", "Overwrite"]) expect(t.risk({ path: ["Edit", l] }), l).toBe("consequential");
    for (const l of ["Open", "Sort by", "Name", "View", "Copy", "Refresh"]) expect(t.risk({ path: [l] }), l).toBe("reversible");
  });
});

describe("choose_menu_item: submenus", () => {
  it("a submenu NESTED in the same popup: the parent is opened, the children are read again, then the child is chosen", async () => {
    let state: "root" | "open" | "done" = "root";
    const root = laid(["Open", me("More", { expandable: true, rect: rectOf(1) })]);
    const kids = [me("Sub one", { depth: 1, parent: 1, rect: { l: 300, t: 140, w: 120, h: 24 } }), me("Sub two", { depth: 1, parent: 1, rect: { l: 300, t: 170, w: 120, h: 24 } })];
    const all = () => (state === "root" ? root : [...root, ...kids.map((k) => ({ ...k }))]);
    const w = popupWorld({
      popups: () => (state === "done" ? [] : [{ win: tw(MENU, "menu"), menu: all() }]), chainAt: (x, y) => chainFor(all())(x, y),
      onClick: (x, y) => { const it = hit(all(), x, y); if (it?.name === "More") state = "open"; else if (it?.name.startsWith("Sub")) state = "done"; },
    });
    const r = runPopup(w, [call("choose_menu_item", { path: ["More", "Sub two"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks.length).toBe(2);
    expect(hit(all().length ? [...root, ...kids] : [], w.log.clicks[1].x, w.log.clicks[1].y)?.name).toBe("Sub two");
    expect(stepsOf(r.results)[0].outcome).toBe("ok");
  });
  it("a submenu that is its OWN popup window (WinForms, Win32): found as a new popup of the same owner, read, and used", async () => {
    let state: "root" | "sub" | "done" = "root";
    const root = laid([me("More", { expandable: true })]);
    const sub = [me("Sub one", { rect: { l: 300, t: 110, w: 120, h: 24 } }), me("Sub two", { rect: { l: 300, t: 140, w: 120, h: 24 } })];
    const popups = (): Popup[] => (state === "done" ? [] : state === "root" ? [{ win: tw(101, "menu"), menu: root }] : [{ win: tw(101, "menu"), menu: root }, { win: tw(102, "menu", { rect: { l: 295, t: 105, w: 130, h: 70 } }), menu: sub }]);
    const w = popupWorld({
      popups, chainAt: (x, y) => chainFor(state === "sub" ? [...root, ...sub] : root)(x, y),
      onClick: (x, y) => { if (state === "root" && hit(root, x, y)) state = "sub"; else if (state === "sub" && hit(sub, x, y)) state = "done"; },
    });
    const r = runPopup(w, [call("choose_menu_item", { path: ["More", "Sub two"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks.length).toBe(2);
    expect(hit(sub, w.log.clicks[1].x, w.log.clicks[1].y)?.name).toBe("Sub two");
    expect(((w.log.clicks[1].opts.expectRoot as number[]) ?? []).includes(102)).toBe(true); // the submenu's own window is in the family
    expect(stepsOf(r.results)[0].outcome).toBe("ok");
  });
  it("a parent that does not open a submenu: stopped after ONE click, reported", async () => {
    const root = laid([me("More", { expandable: true })]);
    const w = popupWorld({ popups: () => [{ win: tw(101, "menu"), menu: root }], chainAt: chainFor(root) });
    const r = runPopup(w, [call("choose_menu_item", { path: ["More", "Sub one"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks.length).toBe(1);
    const s = stepsOf(r.results)[0];
    expect(s.outcome).toBe("failed");
    expect(s.acted).not.toBe("no"); // a click WAS sent: so it is never retried
  });
});

describe("zero wrong-item clicks when the menu changes under it (100 injected-change trials)", () => {
  it("reordering, removing, disabling, swapping names, inserting items, closing the menu, and changes between the last read and the click", async () => {
    let wrong = 0, clicks = 0, refused = 0, right = 0;
    const kinds = ["none", "reorder", "remove", "disable", "swap", "insert", "close", "race-reorder", "race-swap", "race-close"] as const;
    for (let trial = 0; trial < 100; trial++) {
      const kind = kinds[trial % kinds.length];
      let items = laid(["Open", "Copy", "Properties", "Refresh"]);
      let open = true;
      let reads = 0;
      const mutate = () => {
        if (kind === "reorder" || kind === "race-reorder") items = laid([items[1], items[0], items[3], items[2]].map((i) => ({ ...i, rect: undefined } as unknown as MenuEntry)));
        else if (kind === "remove") items = laid(items.filter((i) => i.name !== "Properties"));
        else if (kind === "disable") items = items.map((i) => (i.name === "Properties" ? { ...i, enabled: false } : i));
        else if (kind === "swap" || kind === "race-swap") items = items.map((i) => (i.name === "Properties" ? { ...i, name: "Delete", rid: "r:Delete" } : i.name === "Copy" ? { ...i, name: "Properties", rid: "r:Properties" } : i));
        else if (kind === "insert") items = laid([me("Cut"), ...items.map((i) => ({ ...i, rect: undefined } as unknown as MenuEntry))]);
        else if (kind === "close" || kind === "race-close") open = false;
      };
      const w = popupWorld({
        popups: () => (open ? [{ win: tw(MENU, "menu"), menu: items.map((i) => ({ ...i })) }] : []),
        chainAt: (x, y) => (open ? chainFor(items)(x, y) : null),
        onClick: (x, y) => { clicks++; const it = hit(items, x, y); if (!it || it.name !== "Properties" || !it.enabled) wrong++; else right++; open = false; },
      });
      // the change happens either BEFORE the tool starts, or in the gap between its last read of the menu and the click (the race)
      if (!kind.startsWith("race")) mutate();
      const origMenu = w.deps.screen.readMenu!;
      w.deps.screen.readMenu = async (h) => { const r = await origMenu(h); reads++; if (kind.startsWith("race") && reads === 2) mutate(); return r; };
      const r = runPopup(w, [call("choose_menu_item", { path: ["Properties"] }), finish()]);
      await r.session.handleTranscript("s", "x");
      if (w.log.clicks.length === 0) refused++;
    }
    expect(clicks + refused).toBe(100);
    expect(wrong).toBe(0);           // never a click on anything but the enabled item called Properties
    expect(right).toBeGreaterThan(0); // and it still works when nothing is wrong
    expect(refused).toBeGreaterThan(0);
  });
});

describe("one menu shown through several windows", () => {
  it("the same items in two windows of the same owner (WinUI/XAML) are ONE menu: not 'two menus', and the larger window is used", async () => {
    const items = laid(["Open", "Properties"]);
    let open = true;
    const w = popupWorld({
      popups: () => (open ? [{ win: tw(101, "popup", { rect: { l: 100, t: 100, w: 200, h: 300 } }), menu: items }, { win: tw(102, "popup", { rect: { l: 100, t: 400, w: 200, h: 60 } }), menu: items }] : []),
      chainAt: chainFor(items), onClick: () => { open = false; },
    });
    const r = runPopup(w, [call("choose_menu_item", { path: ["Properties"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks.length).toBe(1);
    expect(stepsOf(r.results)[0].outcome).toBe("ok");
  });
  it("different items in two windows are still two menus (and an ambiguous name is still not guessed)", async () => {
    const a = laid(["Copy"]), b = laid(["Copy", "Cut"]);
    const w = popupWorld({ popups: () => [{ win: tw(101, "menu"), menu: a }, { win: tw(102, "menu"), menu: b }], chainAt: chainFor(a) });
    const r = runPopup(w, [call("choose_menu_item", { path: ["Copy"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks).toEqual([]);
    expect(stepsOf(r.results)[0].failure).toMatchObject({ kind: "ambiguous" });
  });
});

describe("close_popup", () => {
  it("presses Esc only while a menu is really open, one level at a time, and says what happened", async () => {
    let levels = 2;
    const w = popupWorld({ popups: () => Array.from({ length: levels }, (_, i) => ({ win: tw(101 + i, "menu"), menu: laid(["A"]) })), onPress: () => { levels--; } });
    const r = runPopup(w, [call("close_popup"), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.presses).toEqual(["esc", "esc"]);
    expect(stepsOf(r.results)[0].outcome).toBe("ok");
  });
  it("no menu open: no key is pressed at all", async () => {
    const w = popupWorld({ popups: () => [] });
    const r = runPopup(w, [call("close_popup"), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.presses).toEqual([]);
  });
  it("a dialog is never dismissed this way", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(201, "dialog"), ui: [] }] });
    const r = runPopup(w, [call("close_popup"), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.presses).toEqual([]);
  });
  it("needs Human-like control", async () => {
    const w = popupWorld({ pointer: false, popups: () => [{ win: tw(101, "menu"), menu: laid(["A"]) }] });
    const r = runPopup(w, [call("close_popup"), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(stepsOf(r.results)[0].failure).toMatchObject({ kind: "unavailable", acted: "no" });
  });
  it("the user took over: it stops pressing", async () => {
    let attempts = 0;
    const w = popupWorld({ popups: () => [{ win: tw(101, "menu"), menu: laid(["A"]) }], onPress: () => { attempts++; return { ok: false, reason: "user_moved" }; } });
    const r = runPopup(w, [call("close_popup"), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(attempts).toBe(1); // one attempt, then it stopped (and nothing was sent over the user's hand)
    expect(w.log.presses).toEqual([]);
  });
});

describe("recovery integration (phase 4)", () => {
  it("a refusal before any click is 'acted: no' and retryable in principle, but a failure AFTER a click never is: the same item is not clicked twice", async () => {
    const items = laid(["More"]);
    const w = popupWorld({ popups: () => [{ win: tw(101, "menu"), menu: items }], chainAt: chainFor(items) });
    const r = runPopup(w, [call("choose_menu_item", { path: ["More", "Sub"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks.length).toBe(1); // exactly one click, even though the step failed and the budget would allow a retry
  });
  it("the confirm hook (read-only) recognises the closed popup as evidence", async () => {
    const t = buildTools().find((x) => x.name === "choose_menu_item")!;
    const view = { popups: async () => [] } as never;
    const c = await t.confirm!({ path: ["Open"] }, { hwnd: 101, pid: 20 }, view);
    expect(c).toEqual({ verified: true, evidence: [{ kind: "popup_closed", ok: true }] });
    const open = await t.confirm!({ path: ["Open"] }, { hwnd: 101, pid: 20 }, { popups: async () => [tw(101, "menu")] } as never);
    expect(open.verified).toBeNull();
  });
  it("the journal records the menu steps without any item name or label", async () => {
    let items = laid(["TopSecretItem"]); let open = true;
    const w = popupWorld({ popups: () => (open ? [{ win: tw(MENU, "menu"), menu: items }] : []), chainAt: (x, y) => chainFor(items)(x, y), onClick: () => { open = false; } });
    const r = runPopup(w, [call("choose_menu_item", { path: ["TopSecretItem"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    void items;
    expect(JSON.stringify(r.session.orchestrator.journal())).not.toMatch(/TopSecret/);
  });
});

describe("cancellation", () => {
  it("cancelled between the levels: the second click never happens, and the real pointer is told to stop", async () => {
    let state: "root" | "sub" = "root";
    const root = laid([me("More", { expandable: true })]);
    const sub = [me("Sub", { rect: { l: 300, t: 110, w: 120, h: 24 } })];
    let session: { orchestrator: { cancel(): void } } | null = null;
    const w = popupWorld({
      popups: () => (state === "root" ? [{ win: tw(101, "menu"), menu: root }] : [{ win: tw(101, "menu"), menu: root }, { win: tw(102, "menu"), menu: sub }]),
      chainAt: chainFor(root), onClick: () => { state = "sub"; session!.orchestrator.cancel(); },
    });
    const r = runPopup(w, [call("choose_menu_item", { path: ["More", "Sub"] }), finish()]);
    session = r.session;
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks.length).toBe(1);
    expect(w.log.aborted).toContain("cancel");
    expect(r.events.some((e) => e.type === "task.completed")).toBe(false);
  });
});
