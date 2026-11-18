import { cleanScreenText } from "../shared/screenText";
import type { CaptureFrame } from "./capture";

/**
 * From what the helper found in one settled frame (words with boxes, button-like rectangles) to scored CANDIDATES (Phase 6b). Pure functions:
 * no windows, no capture, no clock of their own, so every rule here is tested without a PC.
 *
 * What a candidate is NOT: proof that something can be clicked. It is a place where the picture looks like it, with an honest reason:
 *   - "button_like": a rectangle that stands out from its surroundings and carries a short label. It LOOKS like a labelled button.
 *   - "shape":       a rectangle that stands out but has no readable label (an icon-only control, or just a coloured box). Never offered as a
 *                    target: what an icon means is not guessed.
 *   - "region":      a large or multi-line area (a panel, a card). Not a button.
 *   - "text":        words that are not inside any rectangle. Text alone does not show that anything is there to click.
 * Only a "button_like" candidate that is confident enough and has a label no other candidate shares is `usable`.
 *
 * `confidence` is a heuristic score from 0 to 1 built from the evidence below, not a probability: Windows OCR does not report per-word
 * confidence, so none is claimed. It is calibrated against the measured results in docs/08 and must be re-measured when the rules change.
 */

export type CandidateKind = "button_like" | "shape" | "region" | "text";

export interface VisualCandidate {
  id: string;
  kind: CandidateKind;
  /** physical screen pixels */
  rect: { l: number; t: number; w: number; h: number };
  /** the label (button_like, text) as read; absent for a shape without one. Held in memory only, for the life of the look. */
  text?: string;
  confidence: number;
  /** what the score rests on */
  evidence: "shape+text" | "shape" | "text";
  /** when the frame these came from was confirmed ready (the caller's clock) */
  capturedAt: number;
  frame: number;
  session: number;
  hwnd: number;
  /** may this be offered as a target at all? (button_like, confident, unambiguous) */
  usable: boolean;
  /** why it is not usable, or what is uncertain: fixed sentences only */
  issues: string[];
  /** other candidates with the same label (so none of them may be picked) */
  ambiguousWith?: string[];
}

export interface RawDetect {
  w: number;
  h: number;
  words: Array<[string, number, number, number, number]>;
  /** [l, t, w, h, fillPct, contrast] in picture pixels */
  shapes: Array<[number, number, number, number, number, number]>;
  /** what OCR read when each rectangle was read ON ITS OWN at two different enlargements (`i` indexes `shapes`) */
  crops: Array<{ i: number; texts: string[] }>;
  msCopy: number;
  msShapes: number;
  msCrops: number;
  msOcr: number;
}

/** below this a candidate is never offered as a target */
export const MIN_USABLE = 0.6;
/** a look yields at most this many candidates */
export const MAX_CANDIDATES = 60;

const clip01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** The helper's answer, checked to the last field. Anything odd and the whole answer is refused (null): nothing half-trusted. */
export function parseRaw(v: unknown, frame: { w: number; h: number }): RawDetect | null {
  const o = v as { ok?: boolean; w?: number; h?: number; words?: unknown; shapes?: unknown; crops?: unknown; msCopy?: number; msShapes?: number; msCrops?: number; msOcr?: number } | null;
  if (!o || o.ok !== true || o.w !== frame.w || o.h !== frame.h || !Array.isArray(o.words) || !Array.isArray(o.shapes)) return null;
  if (o.words.length > 400 || o.shapes.length > 80) return null;
  const num = (x: unknown, lo = 0, hi = 20000): x is number => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
  const words: RawDetect["words"] = [];
  for (const w of o.words) {
    if (!Array.isArray(w) || w.length !== 5 || typeof w[0] !== "string" || !num(w[1], -50, 20000) || !num(w[2], -50, 20000) || !num(w[3], 0, 20000) || !num(w[4], 0, 20000)) return null;
    const t = cleanScreenText(w[0]).slice(0, 80);
    if (t) words.push([t, w[1], w[2], w[3], w[4]]);
  }
  const shapes: RawDetect["shapes"] = [];
  for (const s of o.shapes) {
    if (!Array.isArray(s) || s.length !== 6 || !s.every((x) => num(x, 0, 20000))) return null;
    shapes.push(s as RawDetect["shapes"][number]);
  }
  const crops: RawDetect["crops"] = [];
  if (o.crops !== undefined) {
    if (!Array.isArray(o.crops) || o.crops.length > 40) return null;
    for (const c of o.crops) {
      if (!Array.isArray(c) || c.length < 2 || c.length > 4 || !Number.isInteger(c[0]) || c[0] < 0 || c[0] >= shapes.length || !c.slice(1).every((t) => typeof t === "string")) return null;
      crops.push({ i: c[0], texts: (c.slice(1) as string[]).map((t) => cleanScreenText(t).slice(0, 80)) });
    }
  }
  const ms = (x: unknown): number => (num(x, 0, 600_000) ? x : 0);
  return { w: o.w, h: o.h, words, shapes, crops, msCopy: ms(o.msCopy), msShapes: ms(o.msShapes), msCrops: ms(o.msCrops), msOcr: ms(o.msOcr) };
}

interface Phrase { text: string; x: number; y: number; w: number; h: number; words: number; line: number }

/** Words on one line that sit close together are one phrase ("Open file"); a bigger gap starts a new one (two separate labels). */
export function groupPhrases(words: RawDetect["words"]): Phrase[] {
  const ws = words.map(([text, x, y, w, h]) => ({ text, x, y, w, h })).sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const lines: Array<{ cy: number; h: number; items: typeof ws }> = [];
  for (const w of ws) {
    const cy = w.y + w.h / 2;
    const line = lines.find((l) => Math.abs(l.cy - cy) <= 0.6 * Math.max(w.h, l.h));
    if (line) { line.items.push(w); line.cy = (line.cy * (line.items.length - 1) + cy) / line.items.length; line.h = Math.max(line.h, w.h); } else lines.push({ cy, h: w.h, items: [w] });
  }
  const out: Phrase[] = [];
  lines.forEach((line, li) => {
    const items = line.items.sort((a, b) => a.x - b.x);
    let cur: typeof items = [];
    const flush = () => {
      if (cur.length === 0) return;
      const x = Math.min(...cur.map((c) => c.x)), y = Math.min(...cur.map((c) => c.y));
      const x2 = Math.max(...cur.map((c) => c.x + c.w)), y2 = Math.max(...cur.map((c) => c.y + c.h));
      out.push({ text: cur.map((c) => c.text).join(" "), x, y, w: x2 - x, h: y2 - y, words: cur.length, line: li });
      cur = [];
    };
    for (const it of items) {
      const prev = cur[cur.length - 1];
      if (prev && it.x - (prev.x + prev.w) > 1.0 * Math.max(prev.h, it.h)) flush();
      cur.push(it);
    }
    flush();
  });
  return out;
}

/** how much of a phrase reads like real text: letters and digits, not noise */
export function textSanity(text: string, heightPx: number): number {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0) return 0;
  const good = (compact.match(/[\p{L}\p{N}]/gu) ?? []).length / compact.length;
  if (good < 0.5 || /�/.test(text)) return 0;
  let s = good >= 0.85 ? 1 : 0.7;
  if (compact.length < 2) s = Math.min(s, 0.4);
  if (heightPx < 8) s *= 0.5;
  return s;
}

/** the label as compared between candidates: case, spacing and punctuation do not make two labels different */
export const labelKey = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const inside = (p: Phrase, s: { l: number; t: number; w: number; h: number }): boolean => {
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  if (cx < s.l || cx > s.l + s.w || cy < s.t || cy > s.t + s.h) return false;
  const ix = Math.max(0, Math.min(p.x + p.w, s.l + s.w) - Math.max(p.x, s.l));
  const iy = Math.max(0, Math.min(p.y + p.h, s.t + s.h) - Math.max(p.y, s.t));
  return ix * iy >= 0.7 * p.w * p.h;
};
const iou = (a: { l: number; t: number; w: number; h: number }, b: { l: number; t: number; w: number; h: number }): number => {
  const ix = Math.max(0, Math.min(a.l + a.w, b.l + b.w) - Math.max(a.l, b.l)), iy = Math.max(0, Math.min(a.t + a.h, b.t + b.h) - Math.max(a.t, b.t));
  const i = ix * iy; return i / (a.w * a.h + b.w * b.h - i || 1);
};

export const ISSUE = {
  noLabel: "No readable label, so I cannot tell what this does.",
  region: "A large or multi-line area, not a single button.",
  textOnly: "Text alone does not show that anything here can be clicked.",
  lowConfidence: "Not confident enough that this is a labelled button.",
  shortLabel: "The label is too short to be sure what it says.",
  ambiguous: "Another candidate has the same label, so I would not know which one is meant.",
  disagree: "Two readings of the label disagree, so I am not sure what it says.",
  weakReading: "Only one reading of the label, so I am not sure what it says.",
  garbled: "The label has symbols among the letters, which usually means it was misread.",
  offscreen: "Part of it is outside the screen, so it cannot be used.",
} as const;

/**
 * Readings that are really a PICTURE read as letters (a ring read as "O", a bar as "I" or "l", a star as "*"): a run of the look-alike characters
 * o, 0, i, l, 1 and nothing else, up to three of them. Never a label.
 */
export const symbolLike = (r: string): boolean => /^[o0il1]{1,3}$/.test(labelKey(r));

/** the marks of a misread label: symbols that no button caption uses, or punctuation sitting between two letters of one word */
export const misreadLike = (t: string): boolean => /[\\|{}\[\]_~^`<>@*=;]/.test(t) || /\p{L}[.,;:]\p{L}/u.test(t);

/**
 * Turn one detection into candidates, most useful first. `frame` says where the window was when the pictures were taken (physical pixels) and when
 * it was confirmed ready; nothing here looks at the clock.
 */
export function buildCandidates(raw: RawDetect, frame: CaptureFrame): VisualCandidate[] {
  // sizes are judged in the picture's own pixels, so the window's own DPI sets what a normal button looks like
  const scale = Math.max(1, (frame.dpi || 96) / 96);
  const sc = frame.scale > 0 ? frame.scale : 1;
  const crops = new Map<number, string[]>(raw.crops.map((c) => [c.i, c.texts]));
  const phrases = groupPhrases(raw.words);
  // drop a rectangle that is (nearly) the same as a bigger-contrast one
  const rects = raw.shapes.map(([l, t, w, h, fill, contrast], i) => ({ l, t, w, h, fill, contrast, i })).sort((a, b) => b.contrast - a.contrast);
  const shapes: typeof rects = [];
  for (const s of rects) if (!shapes.some((k) => iou(k, s) > 0.6)) shapes.push(s);
  // a phrase belongs to the SMALLEST rectangle that holds it
  const owner = new Map<Phrase, (typeof shapes)[number]>();
  for (const p of phrases) {
    const mine = shapes.filter((s) => inside(p, s)).sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (mine) owner.set(p, mine);
  }
  // picture pixels -> physical screen pixels, kept inside the window
  const at = (x: number, y: number, w: number, h: number) => {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    return { l: Math.round(frame.l + x0 * sc), t: Math.round(frame.t + y0 * sc), w: Math.round(Math.min(w, frame.w - x0) * sc), h: Math.round(Math.min(h, frame.h - y0) * sc) };
  };
  const base = { capturedAt: frame.at, frame: frame.frame, session: frame.session, hwnd: frame.hwnd };
  const out: Omit<VisualCandidate, "id">[] = [];
  const vis = frame.visible;
  const onScreen = (r: { l: number; t: number; w: number; h: number }): boolean => !vis || (r.l >= vis.l && r.t >= vis.t && r.l + r.w <= vis.l + vis.w && r.t + r.h <= vis.t + vis.h); // a candidate is a real thing on the screen: no tolerance here

  for (const s of shapes) {
    const mine = phrases.filter((p) => owner.get(p) === s);
    const shapeScore = 0.5 * clip01((s.fill - 70) / 30) + 0.5 * clip01((s.contrast - 14) / 100);
    const rect = at(s.l, s.t, s.w, s.h);
    // every reading of this rectangle's label: the rectangle read on its own at two enlargements, and the words found inside it in the whole frame
    const frameText = mine.sort((a, b) => a.line - b.line || a.x - b.x).map((p) => p.text).join(" ").slice(0, 80);
    const clean = (r: string) => r.replace(/\s+/g, " ").trim();
    const usableReading = (r: string) => labelKey(r).length >= 2 && textSanity(r, 20) > 0 && !symbolLike(r);
    const cropReadings = (crops.get(s.i) ?? []).map(clean).filter(usableReading);
    const readings = [...cropReadings, ...[clean(frameText)].filter(usableReading)];
    if (readings.length === 0) {
      out.push({ ...base, kind: "shape", rect, confidence: r2(0.2 + 0.5 * shapeScore), evidence: "shape", usable: false, issues: [ISSUE.noLabel] });
      continue;
    }
    const lines = Math.max(1, new Set(mine.map((p) => p.line)).size);
    // the label is what at least TWO readings say identically (the most complete form of it); a reading that stands alone is a single reading
    const votes = new Map<string, string[]>();
    for (const r of readings) { const k = labelKey(r); votes.set(k, [...(votes.get(k) ?? []), r]); }
    const top = [...votes.values()].sort((a, b) => b.length - a.length)[0];
    // the rectangle's OWN readings must not disagree with one another: a dissent among them vetoes the label (the whole-frame reading only ever supports)
    const cropDissent = new Set(cropReadings.map(labelKey)).size > 1;
    const confirmed = top.length >= 2 && !cropDissent;
    const longest = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length)[0];
    // the label as written comes from the rectangle's OWN readings when it has any (the whole-frame pass often splits words: "Pa use"), then the longest form
    const own = (confirmed ? top : readings).filter((r) => cropReadings.includes(r));
    const text = (own.length > 0 ? longest(own) : longest(confirmed ? top : readings)).slice(0, 80);
    const wordCount = mine.length > 0 && !confirmed ? mine.reduce((n, p) => n + p.words, 0) : text.split(" ").length;
    const fitsAButton = lines <= 2 && wordCount <= 6 && s.h >= 20 && s.h <= 100 * scale && s.w >= 28 && s.w <= 480 * scale;
    if (!fitsAButton) {
      out.push({ ...base, kind: "region", rect, text, confidence: r2(0.3 + 0.3 * shapeScore), evidence: "shape+text", usable: false, issues: [ISSUE.region] });
      continue;
    }
    const sanity = textSanity(text, 20);
    let centred = true;
    if (mine.length > 0) {
      const px = mine.reduce((a, p) => a + p.x + p.w / 2, 0) / mine.length, py = mine.reduce((a, p) => a + p.y + p.h / 2, 0) / mine.length;
      centred = Math.abs(px - (s.l + s.w / 2)) <= 0.3 * s.w && Math.abs(py - (s.t + s.h / 2)) <= 0.3 * s.h;
    }
    const textScore = sanity * (centred ? 1 : 0.7);
    // one reading alone is weaker evidence than two that agree, and three agreeing are stronger than two
    const cap = confirmed ? (top.length >= 3 ? 1 : 0.92) : 0.85;
    const confidence = r2(Math.min(cap, clip01(0.25 + 0.35 * shapeScore + 0.4 * textScore)));
    const issues: string[] = [];
    // several readings and no two the same: nobody knows what it says. One reading: trusted only when it reads cleanly (a stray symbol among the letters is how a misread looks)
    if (!confirmed && readings.length >= 2) issues.push(ISSUE.disagree);
    // a label read only once is never usable: a single reading cannot be checked against anything
    if (readings.length === 1) issues.push(ISSUE.weakReading);
    // even two readings that AGREE can agree on the same garble: a label with stray symbols is refused regardless
    if (sanity < 1 || misreadLike(text)) issues.push(ISSUE.garbled);
    if (text.replace(/\s+/g, "").length < 2) issues.push(ISSUE.shortLabel);
    if (confidence < MIN_USABLE) issues.push(ISSUE.lowConfidence);
    if (!onScreen(rect)) issues.push(ISSUE.offscreen);
    out.push({ ...base, kind: "button_like", rect, text, confidence, evidence: "shape+text", usable: issues.length === 0, issues });
  }

  // words that are in no rectangle: listed so the planner can see them, never offered as targets
  for (const p of phrases) {
    if (owner.has(p)) continue;
    const sanity = textSanity(p.text, p.h);
    if (sanity === 0) continue;
    out.push({ ...base, kind: "text", rect: at(p.x, p.y, p.w, p.h), text: p.text.slice(0, 80), confidence: r2(0.2 + 0.5 * sanity), evidence: "text", usable: false, issues: [ISSUE.textOnly] });
  }

  // the same label on more than one candidate: none of them may be picked
  const groups = new Map<string, number[]>();
  out.forEach((c, i) => { if (c.usable && c.text) { const k = labelKey(c.text); if (k) groups.set(k, [...(groups.get(k) ?? []), i]); } });
  const ids = out.map((_, i) => `v${frame.frame}.${i + 1}`);
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    for (const i of idx) { out[i] = { ...out[i], usable: false, issues: [...out[i].issues, ISSUE.ambiguous], ambiguousWith: idx.filter((j) => j !== i).map((j) => ids[j]) }; }
  }

  return out
    .map((c, i) => ({ ...c, id: ids[i] }))
    .sort((a, b) => Number(b.usable) - Number(a.usable) || b.confidence - a.confidence || a.rect.t - b.rect.t || a.rect.l - b.rect.l)
    .slice(0, MAX_CANDIDATES);
}
