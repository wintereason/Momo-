import { describe, expect, it } from "vitest";
import { REGISTRY_MAX, REGISTRY_TTL_MS, TransientRegistry } from "./transientRegistry";
import type { TransientWindow } from "../shared/ports";

const w = (hwnd: number, over: Partial<TransientWindow> = {}): TransientWindow => ({ hwnd, pid: 10, proc: "app", cls: "#32768", kind: "menu", owner: 0, rootOwner: 0, top: true, tool: false, fg: false, rect: { l: 1, t: 2, w: 3, h: 4 }, ...over });

describe("the transient registry (memory only, bounded, short-lived)", () => {
  it("says what appeared and what disappeared between two looks", () => {
    const r = new TransientRegistry();
    expect(r.observe([w(1), w(2)])).toEqual({ appeared: [1, 2], disappeared: [] });
    expect(r.observe([w(2), w(3)])).toEqual({ appeared: [3], disappeared: [1] });
    expect(r.isGone(1)).toBe(true);   // seen before, not there now: gone, not an error
    expect(r.isGone(2)).toBe(false);
    expect(r.isGone(999)).toBe(false); // never seen: not "gone"
  });
  it("holds at most 32 windows: the longest-unseen go first", () => {
    let t = 1000;
    const r = new TransientRegistry({ now: () => t });
    for (let i = 1; i <= 50; i++) { t += 10; r.observe([w(i)]); }
    expect(REGISTRY_MAX).toBe(32);
    expect(r.size).toBeLessThanOrEqual(32);
  });
  it("forgets a window after 30 seconds without seeing it", () => {
    let t = 0;
    const r = new TransientRegistry({ now: () => t });
    r.observe([w(1)]);
    t += REGISTRY_TTL_MS + 1;
    r.observe([w(2)]);
    expect(r.get(1)).toBeUndefined();
    expect(r.get(2)).toBeDefined();
  });
  it("keeps facts only: no title, no text of any kind can be stored", () => {
    const r = new TransientRegistry();
    const sneaky = { ...w(1), title: "Quarterly Report", text: "secret", items: ["a"] } as unknown as TransientWindow;
    r.observe([sneaky]);
    const dump = JSON.stringify([r.get(1), r.current()]);
    for (const bad of ["Quarterly", "secret", "title", "items"]) expect(dump).not.toContain(bad);
  });
  it("hands out copies", () => {
    const r = new TransientRegistry();
    r.observe([w(1)]);
    const a = r.get(1)!; a.rect.l = 999; a.kind = "dialog";
    expect(r.get(1)!.rect.l).toBe(1);
    expect(r.get(1)!.kind).toBe("menu");
  });
  it("ignores impossible handles", () => {
    const r = new TransientRegistry();
    r.observe([w(0), w(-5), w(Number.NaN), w(1.5)]);
    expect(r.size).toBe(0);
  });
  it("the family of a popup: itself, its owner, and the other popups of that owner (a menu and its submenu)", () => {
    const r = new TransientRegistry();
    r.observe([w(11, { owner: 5, rootOwner: 5 }), w(12, { owner: 5, rootOwner: 5 }), w(13, { owner: 6, rootOwner: 6 })]);
    expect(r.family(11).sort((a, b) => a - b)).toEqual([5, 11, 12]);
    expect(r.family(13).sort((a, b) => a - b)).toEqual([6, 13]);
    expect(r.family(404)).toEqual([404]);
  });
  it("an unowned popup (a drop-down list) is grouped with same-kind popups of the same process only", () => {
    const r = new TransientRegistry();
    r.observe([w(21, { kind: "dropdown", pid: 7 }), w(22, { kind: "dropdown", pid: 7 }), w(23, { kind: "dropdown", pid: 8 })]);
    expect(r.family(21).sort((a, b) => a - b)).toEqual([21, 22]);
  });
  it("clear() forgets everything", () => {
    const r = new TransientRegistry(); r.observe([w(1)]); r.clear();
    expect(r.size).toBe(0);
    expect(r.isGone(1)).toBe(false);
  });
});
