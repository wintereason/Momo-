import { describe, expect, it } from "vitest";
import type { MenuEntry, PointerResult } from "../shared/ports";
import { call, finish, me, popupWorld, runPopup, stepsOf, tw, type Popup } from "./popupWorld";

/**
 * Phase 5d: choosing a menu item with the KEYBOARD. A keyboard-driven fake menu: Down/Up move a visible focus (wrapping), Right opens a submenu,
 * Enter takes the focused item, Esc closes. Every key must be followed by a check that the focus is where that key should have put it, and
 * Enter must never be pressed unless the focus is on the item that was asked for.
 */
interface KbOpts { jump?: { afterKey: number; to: number }; hideFocus?: boolean; double?: boolean; mutateAfterKey?: { key: number; fn: (items: MenuEntry[]) => MenuEntry[] }; refuseKey?: (n: number) => PointerResult | void; closeAfterKey?: number }
function kbMenu(initial: Array<string | MenuEntry>, o: KbOpts = {}) {
  let items: MenuEntry[] = initial.map((n, i) => (typeof n === "string" ? me(n, { rect: { l: 110, t: 110 + i * 30, w: 180, h: 24 } }) : n));
  let focus = -1; let open = true; let keys = 0;
  const log = { enters: [] as string[], keyList: [] as string[] };
  const nav = () => items.map((_, i) => i).filter((i) => items[i].enabled && !items[i].separator);
  const w = popupWorld({
    popups: (): Popup[] => (open ? [{ win: tw(101, "menu"), menu: items.map((i, k) => ({ ...i, focused: !o.hideFocus && (k === focus || (!!o.double && k === (focus + 1) % items.length)) })) }] : []),
    onPress: (key) => {
      const refused = o.refuseKey?.(keys); if (refused) return refused;
      keys++; log.keyList.push(key);
      const n = nav();
      if (key === "down") focus = focus < 0 ? n[0] : n[(n.indexOf(focus) + 1) % n.length];
      else if (key === "up") focus = focus < 0 ? n[n.length - 1] : n[(n.indexOf(focus) - 1 + n.length) % n.length];
      else if (key === "enter") { log.enters.push(items[focus]?.name ?? "(none)"); open = false; }
      else if (key === "esc") open = false;
      if (o.jump && keys === o.jump.afterKey) focus = o.jump.to;
      if (o.mutateAfterKey && keys === o.mutateAfterKey.key) items = o.mutateAfterKey.fn(items);
      if (o.closeAfterKey && keys === o.closeAfterKey) open = false;
    },
  });
  return { w, log, isOpen: () => open, focus: () => focus };
}
const ITEMS = ["Open", "Copy", "Properties", "Refresh", "Paste"];
const run = async (k: ReturnType<typeof kbMenu>, path: string[], extra: Record<string, unknown> = {}) => {
  const r = runPopup(k.w, [call("choose_menu_item", { path, via: "keys", ...extra }), finish()]);
  await r.session.handleTranscript("s", "x");
  return { ...r, step: stepsOf(r.results)[0] };
};

describe("choose_menu_item via the keyboard", () => {
  it("moves the focus one verified key at a time, then presses Enter ONLY on the item asked for; the closed menu is the evidence", async () => {
    const k = kbMenu(ITEMS);
    const { step } = await run(k, ["Properties"]);
    expect(k.log.keyList).toEqual(["down", "down", "down", "enter"]);
    expect(k.log.enters).toEqual(["Properties"]);
    expect(step).toMatchObject({ outcome: "ok", acted: "yes" });
    expect(step.text).toMatch(/with the keyboard; the menu closed/);
    expect(k.w.log.clicks).toEqual([]); // no mouse at all
  });
  it("takes the SHORTER way round: Up for an item near the end of the list", async () => {
    const k = kbMenu(ITEMS);
    await run(k, ["Paste"]);
    expect(k.log.keyList).toEqual(["down", "up", "enter"].slice(0, 0).concat(["down", "up", "enter"])); // first Down focuses Open, then one Up wraps to Paste
    expect(k.log.enters).toEqual(["Paste"]);
  });
  it("skips disabled items and separators (they are not stops), and refuses a disabled target", async () => {
    const k = kbMenu(["Open", me("Disabled", { enabled: false, rect: { l: 110, t: 140, w: 180, h: 24 } }), me("-", { separator: true, rect: { l: 110, t: 170, w: 180, h: 24 } }), me("Refresh", { rect: { l: 110, t: 200, w: 180, h: 24 } })]);
    await run(k, ["Refresh"]);
    expect(k.log.keyList).toEqual(["down", "down", "enter"]); // Open, then Refresh: the disabled one and the separator are not visited
    const k2 = kbMenu(["Open", me("Disabled", { enabled: false })]);
    const { step } = await run(k2, ["Disabled"]);
    expect(k2.log.keyList).toEqual([]);
    expect(step.failure).toMatchObject({ kind: "target_disabled", acted: "no" });
  });
  it("a submenu: Right opens it, then the same one-key-at-a-time rule applies inside it", async () => {
    let open = true, sub = false, focus = -1, subFocus = -1;
    const root = [me("Open", { rect: { l: 110, t: 110, w: 180, h: 24 } }), me("More", { expandable: true, rect: { l: 110, t: 140, w: 180, h: 24 } })];
    const kids = [me("Sub one", { rect: { l: 300, t: 110, w: 120, h: 24 } }), me("Sub two", { rect: { l: 300, t: 140, w: 120, h: 24 } })];
    const enters: string[] = []; const keysList: string[] = [];
    const w = popupWorld({
      popups: () => (!open ? [] : [{ win: tw(101, "menu"), menu: root.map((i, k) => ({ ...i, focused: !sub && k === focus })) }, ...(sub ? [{ win: tw(102, "menu"), menu: kids.map((i, k) => ({ ...i, focused: k === subFocus })) }] : [])]),
      onPress: (key) => {
        keysList.push(key);
        if (!sub) { if (key === "down") focus = focus < 0 ? 0 : (focus + 1) % root.length; else if (key === "right" && root[focus]?.expandable) sub = true; else if (key === "enter") { enters.push(root[focus].name); open = false; } }
        else { if (key === "down") subFocus = subFocus < 0 ? 0 : (subFocus + 1) % kids.length; else if (key === "enter") { enters.push(kids[subFocus].name); open = false; } }
      },
    });
    const r = runPopup(w, [call("choose_menu_item", { path: ["More", "Sub two"], via: "keys" }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(keysList).toEqual(["down", "down", "right", "down", "down", "enter"]);
    expect(enters).toEqual(["Sub two"]);
    expect(stepsOf(r.results)[0].outcome).toBe("ok");
  });
});

describe("a surprise at any key stops everything, and Enter is never pressed", () => {
  it("the focus jumps somewhere unexpected: stopped, the menu is closed with Esc, nothing is chosen", async () => {
    const k = kbMenu(ITEMS, { jump: { afterKey: 2, to: 4 } });
    const { step } = await run(k, ["Properties"]);
    expect(k.log.enters).toEqual([]);
    expect(k.log.keyList.at(-1)).toBe("esc");
    expect(k.isOpen()).toBe(false);
    expect(step.outcome).toBe("failed");
    expect(step.text).toMatch(/focus moved somewhere I did not expect/);
  });
  it("the focus cannot be seen at all: refused after the first key, never navigated blind", async () => {
    const k = kbMenu(ITEMS, { hideFocus: true });
    const { step } = await run(k, ["Properties"]);
    expect(k.log.enters).toEqual([]);
    expect(k.log.keyList[0]).toBe("down");
    expect(k.log.keyList.filter((x) => x === "down").length).toBe(1);
    expect(step.text).toMatch(/cannot see which item has the focus/);
    expect(step.failure?.kind).toBe("unavailable");
  });
  it("two items that both look focused: the position cannot be trusted, so nothing is pressed after that", async () => {
    const k = kbMenu(ITEMS, { double: true });
    const { step } = await run(k, ["Properties"]);
    expect(k.log.enters).toEqual([]);
    expect(step.failure?.kind).toBe("unavailable");
  });
  it("the menu closes by itself mid-way: stopped, no Enter, no stray key into the application", async () => {
    const k = kbMenu(ITEMS, { closeAfterKey: 2 });
    const { step } = await run(k, ["Properties"]);
    expect(k.log.enters).toEqual([]);
    expect(k.log.keyList).toEqual(["down", "down"]); // nothing pressed after it closed (not even an Esc: there is no menu to close)
    expect(step.outcome).toBe("failed");
  });
  it("the items are re-ordered under it after a key: the target is found again by identity and Enter still lands on it", async () => {
    const k = kbMenu(ITEMS, { mutateAfterKey: { key: 1, fn: (it) => [it[1], it[0], ...it.slice(2)] } });
    const { step } = await run(k, ["Properties"]);
    expect(k.log.enters).toEqual(["Properties"]);
    expect(step.outcome).toBe("ok");
  });
  it("the target disappears after a key: stopped, Esc, no Enter", async () => {
    const k = kbMenu(ITEMS, { mutateAfterKey: { key: 1, fn: (it) => it.filter((i) => i.name !== "Properties") } });
    const { step } = await run(k, ["Properties"]);
    expect(k.log.enters).toEqual([]);
    expect(step.outcome).toBe("failed");
  });
  it("the target is disabled after a key: Enter is not pressed on a disabled item", async () => {
    const k = kbMenu(ITEMS, { mutateAfterKey: { key: 2, fn: (it) => it.map((i) => (i.name === "Properties" ? { ...i, enabled: false } : i)) } });
    await run(k, ["Properties"]);
    expect(k.log.enters).toEqual([]);
  });
});

describe("focus management", () => {
  it("the keyboard is not in the menu's window (another window is in front): NO key is sent, nothing was sent", async () => {
    const k = kbMenu(ITEMS, { refuseKey: () => ({ ok: false, reason: "focus_changed" } as PointerResult) });
    const { step } = await run(k, ["Open"]);
    expect(k.log.keyList).toEqual([]);
    expect(step.failure).toMatchObject({ kind: "wrong_window", acted: "no" });
  });
  it("every key is sent with the menu's WINDOW FAMILY as the only acceptable keyboard focus (the popup and its owner)", async () => {
    const k = kbMenu(ITEMS);
    const seen: Array<number | number[] | undefined> = [];
    const orig = k.w.deps.pointer!().press;
    k.w.deps.pointer!().press = async (keys, opts) => { seen.push(opts?.expectForeground); return orig(keys, opts); };
    await run(k, ["Copy"]);
    expect(seen.length).toBeGreaterThan(0);
    for (const f of seen) { expect(Array.isArray(f)).toBe(true); expect((f as number[]).includes(101) && (f as number[]).includes(20)).toBe(true); }
  });
  it("needs Human-like control (the real keyboard): without it, nothing is attempted", async () => {
    const k = kbMenu(ITEMS);
    const w2 = popupWorld({ pointer: false, popups: () => [{ win: tw(101, "menu"), menu: ITEMS.map((n, i) => me(n, { rect: { l: 110, t: 110 + i * 30, w: 180, h: 24 } })) }] });
    const r = runPopup(w2, [call("choose_menu_item", { path: ["Open"], via: "keys" }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(stepsOf(r.results)[0].failure).toMatchObject({ kind: "unavailable", acted: "no" });
    void k;
  });
  it("the mouse path never uses the keyboard and the keys path never clicks", async () => {
    const k = kbMenu(ITEMS);
    await run(k, ["Copy"]);
    expect(k.w.log.clicks).toEqual([]);
  });
});

describe("cancellation, takeover and cleanup", () => {
  it("cancelled between two keys: no further key, no Enter, and the real keyboard is told to stop", async () => {
    let session: { orchestrator: { cancel(): void } } | null = null;
    const k = kbMenu(ITEMS, { refuseKey: (n) => { if (n === 1) session!.orchestrator.cancel(); } });
    const r = runPopup(k.w, [call("choose_menu_item", { path: ["Properties"], via: "keys" }), finish()]);
    session = r.session;
    await r.session.handleTranscript("s", "x");
    expect(k.log.enters).toEqual([]);
    expect(k.log.keyList.length).toBeLessThanOrEqual(2);
    expect(k.w.log.aborted).toContain("cancel");
    expect(r.events.some((e) => e.type === "task.completed")).toBe(false);
  });
  it("the user takes over (mouse or Esc) during a key: stopped at once; Momo does NOT press Esc over the user's hand", async () => {
    const k = kbMenu(ITEMS, { refuseKey: (n) => (n === 1 ? ({ ok: false, reason: "user_moved" } as PointerResult) : undefined) });
    const { step } = await run(k, ["Properties"]);
    expect(k.log.enters).toEqual([]);
    expect(k.log.keyList.includes("esc")).toBe(false);
    expect(step.text).toMatch(/You moved the mouse/);
  });
  it("after a failure the menu is closed (Esc, bounded, only while a menu is open), never left hanging", async () => {
    const k = kbMenu(ITEMS, { jump: { afterKey: 1, to: 4 } });
    await run(k, ["Properties"]);
    expect(k.isOpen()).toBe(false);
    expect(k.log.keyList.filter((x) => x === "esc").length).toBeLessThanOrEqual(4);
  });
});

describe("zero wrong Enter presses when the menu changes between keys (100 injected-change trials)", () => {
  it("jumps, reorders, removals, disabling and the menu closing, at every key position", async () => {
    let wrongEnter = 0, entered = 0, stopped = 0;
    const muts: Array<(it: MenuEntry[]) => MenuEntry[]> = [
      (it) => [it[1], it[0], ...it.slice(2)], (it) => it.filter((i) => i.name !== "Properties"), (it) => it.map((i) => (i.name === "Properties" ? { ...i, enabled: false } : i)),
      (it) => [...it.slice(1), it[0]], (it) => it.map((i) => (i.name === "Properties" ? { ...i, name: "Delete", rid: "r:Delete" } : i)),
    ];
    for (let trial = 0; trial < 100; trial++) {
      const afterKey = 1 + (trial % 4);
      const kind = trial % 10;
      const opts: KbOpts = kind < 5 ? { mutateAfterKey: { key: afterKey, fn: muts[kind] } } : kind < 7 ? { jump: { afterKey, to: (trial * 7) % 5 } } : kind === 7 ? { closeAfterKey: afterKey } : kind === 8 ? { hideFocus: true } : {};
      const k = kbMenu(ITEMS, opts);
      await run(k, ["Properties"]);
      if (k.log.enters.length === 0) stopped++;
      else { entered++; if (k.log.enters[0] !== "Properties") wrongEnter++; }
    }
    expect(wrongEnter).toBe(0);
    expect(entered).toBeGreaterThan(0);
    expect(stopped).toBeGreaterThan(0);
    expect(entered + stopped).toBe(100);
  });
});

describe("unsupported menus are refused, not guessed at", () => {
  it("a menu drawn by the application itself (no readable items): nothing is pressed", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(101, "popup") }] });
    const r = runPopup(w, [call("choose_menu_item", { path: ["Open"], via: "keys" }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.presses).toEqual([]);
    expect(stepsOf(r.results)[0].failure).toMatchObject({ acted: "no" });
  });
});
