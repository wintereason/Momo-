import type { UiNode } from "./ports";
import { redactSecrets } from "./redact";

/**
 * Perception of one window: UI Automation (what the app itself says its controls and text are)
 * and, as a fallback, a screenshot read by the local OCR engine.
 *
 * SAFETY: everything returned here is UNTRUSTED DATA from another program. It is only ever shown
 * to the user. It is never parsed as a command, never classified as a request, never used to decide
 * what Momo does next. Password fields are dropped at every layer.
 */

export const MAX_LINES = 14;
export const MAX_LINE_CHARS = 160;
/** below this much text, UI Automation is considered "the app doesn't expose it" and OCR is tried */
export const SPARSE_TEXT_CHARS = 200;

/** Strip control and bidi-override characters and cap the length. */
export function cleanScreenText(s: unknown): string {
  const cleaned = String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // secrets are hidden BEFORE the length cap, so a key can never be cut in half and half-shown
  return redactSecrets(cleaned).slice(0, MAX_LINE_CHARS);
}

const TEXTUAL = new Set(["Text", "Hyperlink", "ListItem", "DataItem", "TreeItem", "Header", "HeaderItem", "Document", "TitleBar", "StatusBar"]);
const CONTROLS = new Set(["Button", "CheckBox", "RadioButton", "ComboBox", "MenuItem", "TabItem", "Hyperlink", "Edit", "Slider", "SplitButton"]);

/** Drop anything that is hidden or private before it goes any further. */
export function usable(items: UiNode[]): UiNode[] {
  return items.filter((n) => !n.password && !n.offscreen && typeof n.name === "string");
}

/** The readable text of a window, de-duplicated, in on-screen order. */
export function collectText(items: UiNode[], max = MAX_LINES): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = cleanScreenText(raw);
    if (t.length < 2 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  for (const n of usable(items)) {
    if (TEXTUAL.has(n.type)) add(n.name);
    if (n.type === "Edit" && n.value) add(n.value); // what is typed in an edit box (never for passwords)
  }
  return out.slice(0, max);
}

export interface ControlInfo { type: string; name: string; enabled: boolean }

export function collectControls(items: UiNode[], max = 20): ControlInfo[] {
  const out: ControlInfo[] = [];
  const seen = new Set<string>();
  for (const n of usable(items)) {
    if (!CONTROLS.has(n.type)) continue;
    const name = cleanScreenText(n.name);
    if (!name) continue;
    const key = `${n.type}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: n.type, name, enabled: n.enabled });
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------- finding a control the user named

const CLICKABLE = new Set(["Button", "MenuItem", "TabItem", "CheckBox", "RadioButton", "Hyperlink", "ListItem", "TreeItem", "DataItem", "SplitButton"]);
const TYPEABLE = new Set(["Edit", "ComboBox"]);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export type ControlKind = "click" | "type";

/**
 * Controls whose name matches what the user said. An exact (whole-name) match wins over partial ones.
 * Only controls Momo could actually address (they have a runtime id) and that are visible are returned.
 */
export function matchControls(items: UiNode[], wanted: string, kind: ControlKind): UiNode[] {
  const types = kind === "click" ? CLICKABLE : TYPEABLE;
  const w = norm(wanted);
  if (!w) return [];
  const tokens = w.split(" ");
  const pool = usable(items).filter((n) => types.has(n.type) && !!n.rid && norm(n.name).length > 0);
  const exact = pool.filter((n) => norm(n.name) === w);
  const hits = exact.length > 0 ? exact : pool.filter((n) => tokens.every((t) => norm(n.name).includes(t)));
  const seen = new Set<string>();
  return hits.filter((n) => (seen.has(n.rid!) ? false : (seen.add(n.rid!), true)));
}

/** Names of the controls Momo can see (to help the user when nothing matched). */
export function visibleNames(items: UiNode[], kind: ControlKind, max = 6): string[] {
  const types = kind === "click" ? CLICKABLE : TYPEABLE;
  const out: string[] = [];
  for (const n of usable(items)) {
    const name = cleanScreenText(n.name);
    if (types.has(n.type) && n.rid && name && !out.includes(name)) out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/** A comparable fingerprint of a window's visible controls, to detect that something changed. */
export function signature(items: UiNode[]): string {
  return usable(items)
    .map((n) => `${n.type}|${cleanScreenText(n.name)}|${n.enabled ? 1 : 0}|${n.state ?? ""}|${n.type === "Edit" && n.value ? n.value.slice(0, 80) : ""}`)
    .sort()
    .join("\n");
}

const ERROR_WORDS = /\b(error|exception|failed|failure|denied|cannot|can't|unable|invalid|not found|warning|fatal|crash|timed out|unauthori[sz]ed|forbidden)\b|0x[0-9a-f]{4,}/i;
export function errorLines(lines: string[]): string[] {
  return lines.filter((l) => ERROR_WORDS.test(l));
}

export function totalChars(lines: string[]): number {
  return lines.reduce((n, l) => n + l.length, 0);
}

// ---------------------------------------------------------------- which one is on screen, and where

/** The on-screen box of the window these controls belong to (the biggest box among them). */
function windowBox(items: UiNode[]): { l: number; t: number; w: number; h: number } | null {
  let best: { l: number; t: number; w: number; h: number } | null = null;
  for (const n of items) if (n.rect && (!best || n.rect.w * n.rect.h > best.w * best.h)) best = n.rect;
  return best;
}

/**
 * Only the controls that are really SHOWN: not hidden, not scrolled out of the window, and not a sliver. A control with no known
 * box is kept (some apps do not report one). Two entries for the very same box and name count once.
 */
export function onScreen(items: UiNode[], nodes: UiNode[]): UiNode[] {
  const win = windowBox(items);
  const seen = new Set<string>();
  return nodes.filter((n) => {
    if (n.offscreen) return false;
    const r = n.rect;
    if (r) {
      if (r.w < 6 || r.h < 6) return false;
      const cx = r.l + r.w / 2, cy = r.t + r.h / 2;
      if (win && (cx < win.l || cx > win.l + win.w || cy < win.t || cy > win.t + win.h)) return false;
      const key = `${norm(n.name)}|${r.l},${r.t},${r.w},${r.h}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });
}

/** "top left", "middle", "bottom right"... where a control is inside its window, in words. */
export function placeOf(node: UiNode, items: UiNode[]): string {
  const win = windowBox(items);
  const r = node.rect;
  if (!win || !r || win.w <= 0 || win.h <= 0) return "";
  const fx = (r.l + r.w / 2 - win.l) / win.w, fy = (r.t + r.h / 2 - win.t) / win.h;
  const v = fy < 0.28 ? "top" : fy > 0.72 ? "bottom" : "middle";
  const h = fx < 0.33 ? "left" : fx > 0.67 ? "right" : "centre";
  return v === "middle" && h === "centre" ? "middle of the window" : v === "middle" ? `${h} side` : `${v} ${h}`;
}

/** The text that tells look-alike controls apart: where it is, and which panel it sits in. */
export function describePlace(node: UiNode, items: UiNode[]): string {
  const place = placeOf(node, items);
  const panel = node.panel && norm(node.panel) !== norm(node.name) ? `in “${cleanScreenText(node.panel).slice(0, 40)}”` : "";
  return [place, panel].filter(Boolean).join(" · ");
}

/** The exact box of a control as a key, so a choice made by the user can be found again. */
export const boxKey = (n: UiNode): string => (n.rect ? `${n.rect.l},${n.rect.t},${n.rect.w},${n.rect.h}` : "");
