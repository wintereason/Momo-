import { describe, expect, it } from "vitest";
import { HELPER_SCRIPT } from "../shared/uiaHelper";
import { placementFromRaw } from "./placement";

/**
 * Windows records a window's normal rectangle in WORKSPACE coordinates (relative to the primary work area's top-left, i.e. the screen without the taskbar). The helper returns it RAW
 * plus the work-area origin; placementFromRaw adds them. These cases use the real numbers from the A07 run (2880x1800, taskbar docked on the left so the work area starts at x = 96).
 */
describe("placementFromRaw: workspace coordinates to screen pixels", () => {
  const rect = (l: number, t: number, w: number, h: number) => ({ l, t, w, h });

  it("adds the work-area origin: a recorded normal left of 932 with the work area at x = 96 is screen x = 1028 (the window's real starting position)", () => {
    const r = placementFromRaw({ ok: true, showCmd: 1, workspaceNormal: rect(932, 340, 920, 1120), current: rect(1477, 900, 1414, 911), origin: { x: 96, y: 0 } });
    expect(r).toEqual({ ok: true, showCmd: 1, normal: rect(1028, 340, 920, 1120), current: rect(1477, 900, 1414, 911) });
  });

  it("is confirmed by a real window in its normal state: workspace 2720 + origin 96 = the window's own screen left 2816", () => {
    const r = placementFromRaw({ ok: true, showCmd: 1, workspaceNormal: rect(2720, 100, 70, 1612), current: rect(2816, 100, 70, 1612), origin: { x: 96, y: 0 } });
    expect(r.ok && r.normal).toEqual(r.ok && r.current);
  });

  it("width and height are never converted (only the corner moves)", () => {
    const r = placementFromRaw({ ok: true, showCmd: 1, workspaceNormal: rect(10, 20, 640, 480), current: rect(0, 0, 1, 1), origin: { x: 100, y: 50 } });
    expect(r.ok && r.normal).toEqual(rect(110, 70, 640, 480));
  });

  it("handles a taskbar on top (origin y), no taskbar offset (origin 0,0) and negative workspace coordinates", () => {
    expect(placementFromRaw({ ok: true, showCmd: 1, workspaceNormal: rect(100, 100, 500, 400), current: rect(100, 148, 500, 400), origin: { x: 0, y: 48 } })).toMatchObject({ ok: true, normal: rect(100, 148, 500, 400) });
    expect(placementFromRaw({ ok: true, showCmd: 1, workspaceNormal: rect(100, 100, 500, 400), current: rect(100, 100, 500, 400), origin: { x: 0, y: 0 } })).toMatchObject({ ok: true, normal: rect(100, 100, 500, 400) });
    expect(placementFromRaw({ ok: true, showCmd: 3, workspaceNormal: rect(-1500, 40, 800, 600), current: rect(0, 0, 2880, 1800), origin: { x: 96, y: 0 } })).toMatchObject({ ok: true, showCmd: 3, normal: rect(-1404, 40, 800, 600) });
  });

  it("keeps the current rectangle exactly as GetWindowRect gave it (screen pixels, no conversion)", () => {
    const r = placementFromRaw({ ok: true, showCmd: 1, workspaceNormal: rect(0, 0, 100, 100), current: rect(1477, 0, 1414, 1811), origin: { x: 96, y: 0 } });
    expect(r.ok && r.current).toEqual(rect(1477, 0, 1414, 1811));
  });

  it("refuses an answer with any missing or non-numeric part, instead of guessing", () => {
    const good = { ok: true, showCmd: 1, workspaceNormal: rect(1, 2, 300, 400), current: rect(1, 2, 300, 400), origin: { x: 0, y: 0 } };
    expect(placementFromRaw(good).ok).toBe(true);
    const cases: Array<Record<string, unknown>> = [
      { ...good, showCmd: undefined }, { ...good, showCmd: 1.5 }, { ...good, showCmd: "1" },
      { ...good, workspaceNormal: undefined }, { ...good, workspaceNormal: { l: 1, t: 2, w: 3 } }, { ...good, workspaceNormal: { l: NaN, t: 2, w: 3, h: 4 } },
      { ...good, current: undefined }, { ...good, current: { l: 1, t: 2, w: "3", h: 4 } },
      { ...good, origin: undefined }, { ...good, origin: { x: 1 } }, { ...good, origin: { x: Infinity, y: 0 } },
      { ...good, coordinateSystem: "unknown" }, { ...good, coordinateSystem: 1 },
    ];
    for (const c of cases) {
      const r = placementFromRaw(c as never);
      expect(r.ok, JSON.stringify(c)).toBe(false);
      expect(!r.ok && r.reason).toMatch(/could not read/);
    }
    expect(placementFromRaw(null as never).ok).toBe(false);
  });
});

/**
 * A tool window (WS_EX_TOOLWINDOW) reports rcNormalPosition in SCREEN coordinates. The helper still returns the primary work-area origin, but it must NOT be
 * added to that rectangle: doing so moves the expected normal rectangle by the width of the taskbar.
 */
describe("placementFromRaw: screen coordinates for WS_EX_TOOLWINDOW", () => {
  const rect = (l: number, t: number, w: number, h: number) => ({ l, t, w, h });

  it("uses the raw normal rectangle unchanged, even with a non-zero work-area origin", () => {
    const normal = rect(1028, 340, 920, 1120);
    const r = placementFromRaw({ ok: true, showCmd: 1, coordinateSystem: "screen", workspaceNormal: normal, current: normal, origin: { x: 96, y: 0 } });
    expect(r).toEqual({ ok: true, showCmd: 1, normal, current: normal });
  });

  it("the same raw rectangle means a different screen position for a tool window than for an ordinary window", () => {
    const raw = { ok: true, showCmd: 1, workspaceNormal: rect(932, 340, 920, 1120), current: rect(1028, 340, 920, 1120), origin: { x: 96, y: 0 } };
    const ordinary = placementFromRaw(raw);
    const tool = placementFromRaw({ ...raw, coordinateSystem: "screen" });
    expect(ordinary.ok && ordinary.normal).toEqual(rect(1028, 340, 920, 1120)); // workspace + origin
    expect(tool.ok && tool.normal).toEqual(rect(932, 340, 920, 1120));          // no shift
  });

  it("a window with both WS_EX_TOOLWINDOW and WS_EX_APPWINDOW follows the raw tool-window bit", () => {
    // The helper decides only from WS_EX_TOOLWINDOW (GWL_EXSTYLE & 0x80); WS_EX_APPWINDOW (0x40000) must not change the coordinate system.
    const placement = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf("public static string Placement"), HELPER_SCRIPT.indexOf("public static string RestorePlacement"));
    expect(placement).toMatch(/GetWindowLong\(h, -20\) & 0x80/);
    expect(placement).not.toMatch(/0x40000/);
    expect(placement).toMatch(/coordinateSystem/);
    const r = placementFromRaw({ ok: true, showCmd: 1, coordinateSystem: "screen", workspaceNormal: rect(12, 34, 500, 400), current: rect(12, 34, 500, 400), origin: { x: 96, y: 48 } });
    expect(r.ok && r.normal).toEqual(rect(12, 34, 500, 400));
  });

  it("keeps the screen rectangle exactly as Windows gave it, in either system", () => {
    const current = rect(1477, 0, 1414, 1811);
    const ordinary = { ok: true as const, showCmd: 1, coordinateSystem: "workspace" as const, workspaceNormal: rect(1381, 0, 1414, 1811), current, origin: { x: 96, y: 0 } };
    const tool = { ok: true as const, showCmd: 1, coordinateSystem: "screen" as const, workspaceNormal: current, current, origin: { x: 96, y: 0 } };
    const a = placementFromRaw(ordinary), b = placementFromRaw(tool);
    expect(a.ok && a.current).toEqual(current);
    expect(b.ok && b.current).toEqual(current);
  });
});
