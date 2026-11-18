import type { PlacementResult, PxRect } from "../shared/ports";

/** How Windows reported rcNormalPosition: workspace (ordinary windows) or screen (WS_EX_TOOLWINDOW). */
export type NormalCoordinateSystem = "workspace" | "screen";

/** the helper's raw answer to `wplace`: the normal rectangle still in the coordinate system it reports, plus the origin they are relative to */
export interface RawPlacement { ok: boolean; error?: string; showCmd?: number; workspaceNormal?: PxRect; current?: PxRect; origin?: { x: number; y: number }; coordinateSystem?: NormalCoordinateSystem }
const isRect = (r: unknown): r is PxRect => !!r && typeof r === "object" && ["l", "t", "w", "h"].every((k) => Number.isFinite((r as Record<string, unknown>)[k]));

/**
 * Windows records a window's normal rectangle (rcNormalPosition) in WORKSPACE coordinates for ordinary top-level windows: relative to the top-left corner of the
 * primary monitor's work area, that is the screen without the taskbar. With the taskbar docked on the left (work area starting at x = 96) a window whose outer
 * rectangle starts at screen x = 1028 has a recorded normal left of 932. The screen position is then workspace + origin (origin = the primary work area's top-left).
 * A window with WS_EX_TOOLWINDOW instead reports rcNormalPosition directly in SCREEN coordinates: that rectangle is used unchanged. The helper tells us which
 * one it read; a response without the field is the old workspace-only helper, which stays compatible with ordinary windows.
 * `current` (GetWindowRect) is already in screen pixels. Both rectangles are OUTER rectangles (invisible resize borders included), so they compare directly.
 * An answer that is missing a part, or has a part that is not a finite number, is refused: nothing is guessed.
 *
 * Pure (no I/O, no imports beyond types): it is unit-tested on its own.
 */
export function placementFromRaw(raw: RawPlacement): PlacementResult {
  const bad: PlacementResult = { ok: false, reason: "Windows gave me an answer about where that window belongs that I could not read" };
  if (!raw || !Number.isInteger(raw.showCmd) || !isRect(raw.workspaceNormal) || !isRect(raw.current)) return bad;
  const o = raw.origin;
  if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return bad;
  const system: unknown = raw.coordinateSystem ?? "workspace";
  if (system !== "workspace" && system !== "screen") return bad;
  const n = raw.workspaceNormal;
  const dx = system === "workspace" ? o.x : 0;
  const dy = system === "workspace" ? o.y : 0;
  return { ok: true, showCmd: raw.showCmd as number, normal: { l: n.l + dx, t: n.t + dy, w: n.w, h: n.h }, current: { l: raw.current.l, t: raw.current.t, w: raw.current.w, h: raw.current.h } };
}
