"use strict";
// Diagnostics for the real-Windows suite: what a tool answered, where the pointer went, the rectangles of the suite's OWN fixture windows.
//
// PRIVACY. Only the suite's own fixtures are ever involved, and still nothing arbitrary is kept:
//  - the text of a tool is kept only for tools that ACT on one of our windows; tools that READ windows (dialogs, menus, window lists, screen looks) keep their outcome
//    and the length of their text, never the text;
//  - every quoted name in a kept text is redacted unless it is this run's id, one of our fixtures' control names, or a value the test itself passed to the tool;
//  - every string is clipped, and the run id is shortened to <run>;
//  - nothing but numbers, booleans and short labels is stored; no screenshot, OCR text, credential or personal data can pass through.
const { labelKey } = require("./judge.cjs");

/** tools that read windows: their text may describe whatever is on screen, so it is never stored */
const NO_TEXT_TOOLS = new Set(["read_dialog", "read_window", "list_windows", "look_popups", "read_menu", "look_screen", "understand_screen", "inspect_component", "look_visual", "list_tabs", "browser_accounts", "find_paths", "drive_info", "language_progress"]);

/** control names and answers of the suite's own fixtures */
const FIXTURE_NAMES = ["Click me", "Delete everything", "Locked", "Search box", "Enable thing", "Files", "Yes", "No", "OK", "Cancel", "Open", "Save", "Filter", "Delete", "Properties", "Refresh", "Rename", "More", "Sort by", "Name", "Date", "Sub one", "Sub two"];
const FIXTURE_ITEM = /^(Item \d{3}|Block \d+)$/;
const CLIP = 220;

/** one string, made safe to store */
function scrubText(text, { runId = "", allowed = [] } = {}) {
  let s = String(text == null ? "" : text);
  if (runId) s = s.split(runId).join("<run>");
  const keep = new Set([...FIXTURE_NAMES, ...allowed.filter((a) => typeof a === "string" && a && a.length <= 80)].map(labelKey).filter(Boolean));
  const ok = (q) => q.includes("<run>") || FIXTURE_ITEM.test(q.trim()) || keep.has(labelKey(q)) || labelKey(q) === "";
  s = s.replace(/“([^”]*)”/g, (m, q) => (ok(q) ? m : "“[redacted]”"));
  s = s.replace(/"([^"]*)"/g, (m, q) => (ok(q) ? m : "\"[redacted]\""));
  return s.length > CLIP ? s.slice(0, CLIP - 1) + "…" : s;
}

/** a data object made storable: depth and size limited, strings scrubbed, only primitives and arrays/objects of them */
function storable(v, opts, depth = 0) {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return scrubText(v, opts);
  if (depth >= 3) return "[deep]";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => storable(x, opts, depth + 1));
  if (typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v).slice(0, 30)) o[String(k).slice(0, 40)] = storable(x, opts, depth + 1); return o; }
  return String(typeof v);
}

/** what the pointer did, as counts and the last wheel point (physical pixels of OUR window) */
function trackSummary(tracks) {
  const counts = {};
  let lastScroll = null;
  for (const t of tracks || []) { counts[t.phase] = (counts[t.phase] || 0) + 1; if (t.phase === "scroll" && t.x != null) lastScroll = { x: t.x, y: t.y }; }
  return { counts, lastScroll };
}

/**
 * One tool call as a diagnostic record.
 * @param {{ tool: string, args: object, result: any, approve?: boolean, runId?: string }} o
 */
function summarizeRun({ tool, args = {}, result: r, approve, runId = "" }) {
  // values the test itself passed are trusted as names, except anything path-like: a path is never allowed through (it is kept only as <run>-relative text)
  const allowed = Object.values(args).filter((v) => typeof v === "string" && !/[\\/]/.test(v));
  const rec = {
    tool,
    argNames: Object.keys(args).filter((k) => !k.startsWith("_")),
    outcome: r.outcome, acted: (r.step && r.step.acted) || null, failureKind: (r.step && r.step.failure && r.step.failure.kind) || null,
    asked: !!r.asked, approvalAnswer: r.asked ? (approve === false ? "declined" : "approved") : null,
    ms: r.ms, interrupted: r.interrupted || null, held: r.held, states: (r.states || []).length, retryNoted: (r.states || []).some((s) => /trying once more/i.test(s)),
    pointer: trackSummary(r.tracks),
  };
  if (NO_TEXT_TOOLS.has(tool)) { rec.textKept = false; rec.textLength = String(r.text || "").length; }
  else { rec.textKept = true; rec.text = scrubText(r.text, { runId, allowed }); }
  return rec;
}

/** the rectangle of one of OUR fixture windows, in the fixture's own units and in physical pixels as Momo sees it */
function rectsOf(fixtureState, physical, placement) {
  const f = fixtureState || {};
  return {
    fixtureDip: { left: f.left ?? null, top: f.top ?? null, width: f.width ?? null, height: f.height ?? null, state: f.winState ?? null },
    physicalPx: physical ? { l: physical.l, t: physical.t, w: physical.w, h: physical.h } : null,
    // WINDOWPLACEMENT: showCmd (1 normal, 2 minimized, 3 maximized) and the NORMAL rectangle Windows keeps (workspace coordinates, i.e. relative to the work area)
    placement: placement ? { showCmd: placement.showCmd, normalPx: placement.normalPx, unitsReference: placement.unitsReference || null } : null,
  };
}

/** where the wheel went relative to a list's rectangle (both physical pixels) */
function wheelVsList(point, list) {
  if (!point || !list) return { known: false, point: point || null, list: list || null };
  const inside = point.x >= list.l && point.x <= list.l + list.w && point.y >= list.t && point.y <= list.t + list.h;
  return {
    known: true, point, list: { l: list.l, t: list.t, w: list.w, h: list.h }, inside,
    marginsPx: { left: point.x - list.l, right: list.l + list.w - point.x, top: point.y - list.t, bottom: list.t + list.h - point.y },
  };
}

module.exports = { scrubText, storable, trackSummary, summarizeRun, rectsOf, wheelVsList, NO_TEXT_TOOLS, CLIP };
