/**
 * The face as numbers. Every expression is a set of continuous parameters (how open the eyes are, where the brows sit,
 * how the mouth curves...). The renderer eases from one set to the next, so changes are smooth and never a swapped picture.
 * Pure functions only: no DOM, no React, no runtime imports.
 */
export const EXPRESSIONS = [
  "idle", "calm", "friendly", "listening", "speaking", "thinking", "happy", "excited", "wink",
  "confused", "surprised", "serious", "sad", "apologetic", "warning", "error",
] as const;
export type ExpressionId = (typeof EXPRESSIONS)[number];

export type Glyph = "none" | "?" | "!" | "…" | "♪";

/** the numeric part of a face (eased every frame) */
export interface FaceParams {
  /** 0 closed .. 1 open (can exceed 1 when startled), per eye */
  openL: number; openR: number;
  /** 0..1 turns the eye into a happy arc (^ ^) */
  arcL: number; arcR: number;
  /** where the eyes look, -1..1 */
  gazeX: number; gazeY: number;
  /** pupil size (1 normal, <1 startled) and eye sparkle 0..1 */
  pupil: number; sparkle: number;
  /** brow height (+ up), per brow, and tilt (+ inner end raised = worried, - inner end lowered = stern) */
  browL: number; browR: number; tilt: number;
  /** mouth: smile (+) / frown (-), jaw open 0..1, roundness 0..1, width 0.5..1.2 */
  smile: number; open: number; round: number; wide: number;
  blush: number; sweat: number; tear: number;
  /** head pose */
  headRoll: number; headDY: number;
  /** how strongly the idle motion plays (0 still .. 1 lively) */
  energy: number;
}
export type FaceKey = keyof FaceParams;

const BASE: FaceParams = {
  openL: 0.92, openR: 0.92, arcL: 0, arcR: 0, gazeX: 0, gazeY: 0, pupil: 1, sparkle: 0.15,
  browL: 0, browR: 0, tilt: 0, smile: 0.25, open: 0, round: 0, wide: 1,
  blush: 0.15, sweat: 0, tear: 0, headRoll: 0, headDY: 0, energy: 0.6,
};
const f = (p: Partial<FaceParams>): FaceParams => ({ ...BASE, ...p });

export interface ExpressionDef { face: FaceParams; glyph: Glyph; glyphTone: "accent" | "warn" | "bad" }
const d = (face: Partial<FaceParams>, glyph: Glyph = "none", glyphTone: ExpressionDef["glyphTone"] = "accent"): ExpressionDef => ({ face: f(face), glyph, glyphTone });

export const EXPRESSION_DEFS: Record<ExpressionId, ExpressionDef> = {
  idle: d({}),
  calm: d({ openL: 0.8, openR: 0.8, smile: 0.12, blush: 0.05, energy: 0.35 }),
  friendly: d({ smile: 0.6, open: 0.05, blush: 0.32, browL: 0.12, browR: 0.12, headRoll: 2.5, sparkle: 0.3 }),
  listening: d({ openL: 1, openR: 1, browL: 0.3, browR: 0.3, smile: 0.2, headRoll: -3, headDY: -2, sparkle: 0.3, energy: 0.5 }),
  speaking: d({ openL: 0.95, openR: 0.95, smile: 0.35, browL: 0.1, browR: 0.1, blush: 0.2, energy: 0.8 }),
  thinking: d({ openL: 0.78, openR: 0.78, gazeX: 0.65, gazeY: -0.6, browL: 0.35, browR: -0.1, tilt: -0.1, smile: -0.02, wide: 0.6, blush: 0.05, headRoll: 4, energy: 0.4 }, "…"),
  happy: d({ openL: 0.1, openR: 0.1, arcL: 0.9, arcR: 0.9, browL: 0.25, browR: 0.25, smile: 0.85, open: 0.5, blush: 0.5, headRoll: 2, energy: 0.8 }),
  excited: d({ openL: 1.05, openR: 1.05, sparkle: 1, browL: 0.55, browR: 0.55, smile: 0.95, open: 0.85, blush: 0.55, headDY: -3, energy: 1 }, "♪"),
  wink: d({ openL: 0.95, openR: 0.05, arcR: 0.9, smile: 0.7, open: 0.15, blush: 0.35, headRoll: 4, browR: 0.2, energy: 0.8 }),
  confused: d({ openL: 0.95, openR: 0.85, gazeX: -0.3, gazeY: -0.2, browL: 0.55, browR: -0.15, tilt: 0.15, smile: -0.2, wide: 0.6, open: 0.08, blush: 0.05, headRoll: -5, energy: 0.5 }, "?"),
  surprised: d({ openL: 1.15, openR: 1.15, pupil: 0.62, browL: 0.75, browR: 0.75, smile: 0, open: 0.75, round: 0.85, wide: 0.7, blush: 0, headDY: -3, energy: 0.6 }, "!"),
  serious: d({ openL: 0.74, openR: 0.74, browL: -0.12, browR: -0.12, tilt: -0.55, smile: -0.04, wide: 0.85, blush: 0, energy: 0.3 }),
  sad: d({ openL: 0.78, openR: 0.78, gazeY: 0.45, browL: 0.1, browR: 0.1, tilt: 0.65, smile: -0.6, wide: 0.7, blush: 0, tear: 0.7, headRoll: 3, headDY: 3, energy: 0.25 }),
  apologetic: d({ openL: 0.82, openR: 0.82, gazeY: 0.3, browL: 0.2, browR: 0.2, tilt: 0.7, smile: -0.12, wide: 0.7, blush: 0.3, sweat: 0.7, headRoll: -3, headDY: 2, energy: 0.3 }),
  warning: d({ openL: 1.02, openR: 1.02, browL: 0.3, browR: 0.3, tilt: -0.25, smile: -0.3, open: 0.15, wide: 0.8, blush: 0, sweat: 0.8, energy: 0.5 }, "!", "warn"),
  error: d({ openL: 0.9, openR: 0.9, browL: 0.15, browR: 0.15, tilt: 0.4, smile: -0.5, open: 0.28, wide: 0.85, blush: 0, sweat: 1, headRoll: -2, energy: 0.4 }, "!", "bad"),
};

/** expressions whose eyes are shut or arched on purpose: the blink would look wrong */
export const NO_BLINK: ReadonlySet<ExpressionId> = new Set(["happy", "wink"]);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Move `cur` toward `target` with exponential easing; frame-rate independent (`k` ~ stiffness per second). */
export function ease(cur: number, target: number, dtSec: number, k = 9): number {
  return cur + (target - cur) * (1 - Math.exp(-k * Math.max(0, dtSec)));
}
export function easeFace(cur: FaceParams, target: FaceParams, dtSec: number, k = 9): FaceParams {
  const out = { ...cur };
  for (const key of Object.keys(target) as FaceKey[]) out[key] = ease(cur[key], target[key], dtSec, k);
  return out;
}
export function faceDistance(a: FaceParams, b: FaceParams): number {
  let m = 0;
  for (const key of Object.keys(a) as FaceKey[]) m = Math.max(m, Math.abs(a[key] - b[key]));
  return m;
}

/** What a person's proportions add to the base face. These only change how the face is DRAWN. */
export interface Build {
  /** 0 soft .. 1 angular jaw */
  jaw: number;
  /** shoulder half-width scale */
  shoulders: number;
  /** eyelash flick 0..1 and brow thickness */
  lash: number; browW: number;
  /** eye size scale */
  eye: number;
}
export const BUILDS: Record<string, Build> = {
  neutral: { jaw: 0.45, shoulders: 1, lash: 0.3, browW: 4.2, eye: 1 },
  masculine: { jaw: 0.85, shoulders: 1.12, lash: 0, browW: 5.2, eye: 0.94 },
  feminine: { jaw: 0.1, shoulders: 0.9, lash: 1, browW: 3.4, eye: 1.05 },
  androgynous: { jaw: 0.4, shoulders: 0.98, lash: 0.55, browW: 3.8, eye: 1.02 },
};

/** The face outline (head centred on x=150). */
export function facePath(jaw: number): string {
  const hw = 70;
  const chin = lerp(24, 42, jaw); // half-width of the chin flat
  const cy = lerp(226, 222, jaw);
  const cheekY = 158;
  return [
    `M150 62`,
    `C${150 + hw * 0.62} 62 ${150 + hw} 98 ${150 + hw} 146`,
    `C${150 + hw} ${cheekY + 16} ${150 + chin + 20} ${cy - 6} ${150 + chin} ${cy - 1}`,
    `Q150 ${cy + 7} ${150 - chin} ${cy - 1}`,
    `C${150 - chin - 20} ${cy - 6} ${150 - hw} ${cheekY + 16} ${150 - hw} 146`,
    `C${150 - hw} 98 ${150 - hw * 0.62} 62 150 62Z`,
  ].join(" ");
}

export interface EyeGeom { cx: number; cy: number; w: number; h: number }
export const EYES = { L: { cx: 116, cy: 156, w: 36, h: 40 }, R: { cx: 184, cy: 156, w: 36, h: 40 } } as const;

/** The opening of an eye as a closed path, plus the upper-lid line on top of it. `side` flips the outer corner. */
export function eyePaths(g: EyeGeom, open: number, arc: number, scale = 1): { opening: string; lid: string; lower: string } {
  const w = g.w * scale, h = g.h * scale;
  const x1 = g.cx - w / 2, x2 = g.cx + w / 2;
  const base = g.cy + h * 0.12;
  const top = clamp(open, 0, 1.2) * h * 0.62 + arc * 11;
  const bot = clamp(open, 0, 1.2) * h * 0.3 - arc * 11;
  const y1 = base - arc * 2, y2 = base - arc * 2;
  const up = `C${x1 + w * 0.12} ${base - top * 1.25} ${x2 - w * 0.12} ${base - top * 1.25} ${x2} ${y2}`;
  const lo = `C${x2 - w * 0.14} ${base + bot * 1.3} ${x1 + w * 0.14} ${base + bot * 1.3} ${x1} ${y1}`;
  return { opening: `M${x1} ${y1} ${up} ${lo}Z`, lid: `M${x1 - 1.5} ${y1 + 0.5} ${up}`, lower: `M${x2} ${y2} ${lo}` };
}

/** A brow as a short curved stroke. `lift` raises it, `tilt` raises the inner end (+) or lowers it (-). */
export function browPath(cx: number, inner: 1 | -1, lift: number, tilt: number): string {
  const y = 131 - lift * 12;
  const xi = cx + inner * 7, xo = cx - inner * 20;
  const yi = y - tilt * 9, yo = y + tilt * 5;
  return `M${xo} ${yo} Q${(xi + xo) / 2} ${Math.min(yi, yo) - 4} ${xi} ${yi}`;
}

export interface MouthShape { path: string; filled: boolean; opening: number }
/** The mouth. `open` 0..1 drops the jaw, `round` makes an "o", `smile` curves the corners. */
export function mouthPath(smile: number, open: number, round: number, wide: number): MouthShape {
  const cy = 197;
  const half = lerp(13 * wide, 6.5, clamp(round, 0, 1));
  const x1 = 150 - half, x2 = 150 + half;
  const cornerY = cy - smile * 5;
  const ctrl = cy + smile * 7;
  if (open < 0.04) return { path: `M${x1} ${cornerY} Q150 ${ctrl} ${x2} ${cornerY}`, filled: false, opening: 0 };
  const drop = open * (14 + round * 4);
  const lowerCtrl = cy + smile * 4 + drop * 1.7;
  return { path: `M${x1} ${cornerY} Q150 ${ctrl - 2} ${x2} ${cornerY} Q150 ${lowerCtrl} ${x1} ${cornerY}Z`, filled: true, opening: drop };
}

/** Mouth shapes for speech, by the vowel being said. */
export const VISEMES: Record<"a" | "e" | "i" | "o" | "u" | "m", { open: number; round: number; wide: number }> = {
  a: { open: 0.85, round: 0.05, wide: 1.05 },
  e: { open: 0.55, round: 0, wide: 1.12 },
  i: { open: 0.32, round: 0, wide: 1.15 },
  o: { open: 0.65, round: 0.8, wide: 0.8 },
  u: { open: 0.42, round: 0.95, wide: 0.7 },
  m: { open: 0.04, round: 0, wide: 0.9 },
};
