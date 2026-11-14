import type { ExpressionId } from "./face";
import type { AvatarCell, SpriteArt } from "./avatars";

/**
 * How a flat avatar sheet is brought to life WITHOUT redrawing it. The artwork is never altered: its own drawn faces are
 * cross-faded, the artist's closed-eye face is laid over the eyes for a blink, the artist's open-mouth face is laid over
 * the mouth in time with the speech, and the whole figure is moved (breathing, tilt, bounce, shake, droop). Small symbols
 * (like the "?" and "!" of the reference sheet) tell apart states that share one drawn face.
 */
/** feathered ellipses (fractions of the picture); the eyes have one per lens so the glasses frames are never doubled */
export interface Region { cx: number | number[]; cy: number; rx: number; ry: number }
export interface Rig {
  /** the eye and mouth areas, as fractions of the picture (feathered ellipses): the head crop (compact) and the full figure (expanded) */
  areas: Record<"compact" | "expanded", { eyes: Region; mouth: Region }>;
  /** drawn face whose eyes are shut (used for blinking) and the open-mouth faces (used for lip-sync) */
  blink: AvatarCell;
  mouthWide: AvatarCell;
  mouthRound: AvatarCell;
  /** faces whose own eyes are already shut or arched: no blink over them */
  eyesShut: AvatarCell[];
}
export const RIGS: Record<SpriteArt, Rig> = {
  bob: { areas: { compact: { eyes: { cx: [0.326, 0.602], cy: 0.46, rx: 0.075, ry: 0.07 }, mouth: { cx: 0.445, cy: 0.585, rx: 0.07, ry: 0.04 } }, expanded: { eyes: { cx: [0.334, 0.592], cy: 0.28, rx: 0.065, ry: 0.04 }, mouth: { cx: 0.447, cy: 0.375, rx: 0.06, ry: 0.03 } } }, blink: "r1c2", mouthWide: "r1c2", mouthRound: "r2c1", eyesShut: ["r1c2"] },
  dark: { areas: { compact: { eyes: { cx: [0.293, 0.586], cy: 0.748, rx: 0.09, ry: 0.105 }, mouth: { cx: 0.45, cy: 0.875, rx: 0.08, ry: 0.06 } }, expanded: { eyes: { cx: [0.305, 0.588], cy: 0.445, rx: 0.085, ry: 0.055 }, mouth: { cx: 0.427, cy: 0.533, rx: 0.06, ry: 0.035 } } }, blink: "r1c2", mouthWide: "r1c2", mouthRound: "r1c3", eyesShut: ["r1c2"] },
};

export type GlyphTone = "accent" | "warn" | "bad" | "soft";
export interface Pose {
  /** head/body tilt in degrees, drop in px, and size */
  roll: number; dy: number; scale: number;
  /** a small tremble (px), a bounce (px) and the breathing depth (fraction) */
  shake: number; bounce: number; breath: number;
  /** 0..1 how shut the eyes are held (the artist's closed-eye face over the eyes) */
  eyesHeld: number;
  glyph: string; tone: GlyphTone;
}
const P = (p: Partial<Pose>): Pose => ({ roll: 0, dy: 0, scale: 1, shake: 0, bounce: 0, breath: 0.012, eyesHeld: 0, glyph: "", tone: "accent", ...p });

export const POSES: Record<ExpressionId, Pose> = {
  idle: P({}),
  calm: P({ breath: 0.009 }),
  friendly: P({ roll: 2.5, bounce: 0.6 }),
  listening: P({ roll: -3.5, dy: -2, scale: 1.02 }),
  speaking: P({ roll: 1, bounce: 0.8 }),
  thinking: P({ roll: 5, dy: 1, glyph: "…" }),
  happy: P({ roll: 2, bounce: 1.8, scale: 1.02 }),
  excited: P({ roll: -2, bounce: 5, scale: 1.04, glyph: "♪" }),
  wink: P({ roll: 4, bounce: 1 }),
  confused: P({ roll: -6, glyph: "?" }),
  surprised: P({ dy: -5, scale: 1.05, glyph: "!" }),
  serious: P({ dy: 1, scale: 1.01, breath: 0.007 }),
  sad: P({ roll: 4, dy: 7, scale: 0.98, breath: 0.006, glyph: "💧", tone: "soft" }),
  apologetic: P({ roll: -4, dy: 6, scale: 0.98, breath: 0.007, glyph: "💦", tone: "soft" }),
  warning: P({ scale: 1.02, shake: 0.5, glyph: "!", tone: "warn" }),
  error: P({ dy: 2, shake: 1.6, glyph: "!", tone: "bad" }),
  angry: P({ roll: 1, scale: 1.03, shake: 1.2, glyph: "💢", tone: "bad", breath: 0.02 }),
  worried: P({ roll: -3, dy: 3, shake: 0.4, glyph: "💧", tone: "soft" }),
  sleepy: P({ roll: 7, dy: 8, scale: 0.98, breath: 0.02, eyesHeld: 1, glyph: "Zz", tone: "soft" }),
};

/**
 * The GIF's technique: eyelids and a small mouth DRAWN in place on the avatar's resting face, in the artwork's own skin tones
 * (measured on the sprites), instead of swapping faces. Positions are in the picture's own pixels (the resting face of each view).
 * Only the dark avatar is set up; an avatar without an entry here keeps the artist's closed-eye face for blinking and no mouth.
 */
/** one lens: where the eye is, and the skin tones just around it (shaded at the top, lit at the bottom) so a drawn eyelid blends in */
export interface Lens { cx: number; cy: number; rx: number; ry: number; top: string; bottom: string }
/** how this character's open mouth is drawn (a smile-shaped opening with a row of teeth and a tongue), measured on the speaking frames of the video */
export interface MouthStyle {
  /** how far the middle of the top lip sags below the mouth corners, as a fraction of the mouth width (a smile) */
  sag: number;
  /** how far the corners rise as the mouth opens (fraction of width) */
  lift: number;
  /** tallest opening, as a fraction of the mouth width */
  tall: number;
  /** teeth band height as a fraction of the opening */
  teeth: number;
  inner: string; shadow: string; teethColor: string; tongue: string; lip: string;
  /** width of the resting smile line as a fraction of the mouth width (the open mouth grows to the full width); default 1 */
  restW?: number;
  /** a pale lower-lip highlight drawn under the closed smile line (opacity), as on the girl's own resting smile */
  lipLight?: number;
  /** stroke width of the resting line as a fraction of the resting width; default 0.028 */
  lineW?: number;
}
export interface FaceDraw {
  /** the skin patch that hides the pose's own mouth (default: 0.85 x 0.36 of the mouth width) */
  /** the pose's own mouth was removed from the sprite itself (scripts/inpaint-bob-mouths.mjs), so no skin patch is drawn */
  noPatch?: boolean;
  patch?: { rx: number; ry: number; /** how much of the radius is solid skin before it fades (default 0.6) */ solid?: number };
  /** the drawn mouth (and its patch) are kept inside this polygon, so they never touch the glasses frames next to the mouth */
  clip?: [number, number][];
  /** this pose's own eyes are already shut (a laugh, a wink): only the mouth is drawn */
  noEyes?: boolean;
  /** the pose has its own small round mouth (a surprised "o"): drawn over only once the surprise has passed or the avatar speaks */
  native?: { w: number; h: number };
  mouthStyle?: MouthStyle;
  /** the picture size these numbers belong to */
  w: number; h: number;
  eyes: [Lens, Lens];
  mouth: { cx: number; cy: number; w: number };
  skinTop: string; skinBottom: string;
  /** the drawn face is shown only over this drawn face (the others have their own eyes and mouth) */
  restCell: AvatarCell;
}
/** measured on the speaking frames of the reference video (video 3, 4.7 - 7.5 s): a smile-shaped crescent, about 0.48 of the distance between the eyes wide and at most ~0.25 of its width tall when speaking (the laugh at 4.0 s is rounder), never a flat oval */
const BOB_MOUTH: MouthStyle = { restW: 0.8, sag: 0.07, lift: 0.045, tall: 0.34, teeth: 0.42, inner: "#a23f4d", shadow: "#6a2331", teethColor: "#f7f1ef", tongue: "#dd7b86", lip: "#a2635f", lineW: 0.042, lipLight: 0.5 };
/** measured on the wide-open mouths of video 5 (4.6 - 6.5 s): about 0.75 of the distance between the eyes wide and 0.3 tall at most, a rounded opening with a thin row of upper teeth and a big pink tongue */
const BOY_MOUTH: MouthStyle = { sag: 0.03, lift: 0.02, tall: 0.55, teeth: 0.2, inner: "#b04652", shadow: "#6b232d", teethColor: "#f6efee", tongue: "#e08a93", lip: "#6e464a", restW: 0.52, lineW: 0.07 };
export const DRAW: Partial<Record<SpriteArt, Record<"compact" | "expanded", FaceDraw>>> = {
  bob: {
    compact: { w: 512, h: 459, eyes: [{ cx: 167, cy: 208, rx: 36, ry: 27, top: "rgb(190,170,172)", bottom: "rgb(220,190,185)" }, { cx: 308, cy: 216, rx: 37, ry: 27, top: "rgb(150,125,135)", bottom: "rgb(190,160,160)" }], mouth: { cx: 228, cy: 268, w: 66 }, noPatch: true, skinTop: "rgb(203,172,168)", skinBottom: "rgb(208,184,180)", restCell: "r1c1", mouthStyle: BOB_MOUTH },
    expanded: { w: 380, h: 512, eyes: [{ cx: 127, cy: 144, rx: 24, ry: 20, top: "rgb(190,170,172)", bottom: "rgb(220,190,185)" }, { cx: 225, cy: 156, rx: 25, ry: 20, top: "rgb(150,125,135)", bottom: "rgb(190,160,160)" }], mouth: { cx: 170, cy: 194, w: 46 }, noPatch: true, skinTop: "rgb(203,172,168)", skinBottom: "rgb(208,184,180)", restCell: "r1c1", mouthStyle: BOB_MOUTH },
  },
  dark: {
    compact: { w: 512, h: 441, eyes: [{ cx: 169, cy: 322, rx: 38, ry: 25, top: "rgb(183,165,165)", bottom: "rgb(216,195,190)" }, { cx: 310, cy: 320, rx: 40, ry: 25, top: "rgb(154,133,136)", bottom: "rgb(189,164,163)" }], mouth: { cx: 224.5, cy: 382, w: 80 }, patch: { rx: 36, ry: 15 }, mouthStyle: BOY_MOUTH, skinTop: "#d4bcb7", skinBottom: "#c4aaa5", restCell: "r1c1" },
    expanded: { w: 354, h: 512, eyes: [{ cx: 116, cy: 231, rx: 25, ry: 16, top: "rgb(172,151,153)", bottom: "rgb(212,190,186)" }, { cx: 208, cy: 231, rx: 26, ry: 16, top: "rgb(154,132,137)", bottom: "rgb(188,164,163)" }], mouth: { cx: 157.5, cy: 271, w: 52 }, patch: { rx: 23, ry: 10 }, mouthStyle: BOY_MOUTH, skinTop: "#d7beb9", skinBottom: "#cdb4af", restCell: "r1c1" },
  },
};

/**
 * Other drawn poses of an avatar (their own eye and mouth positions, measured on their sprites). The first entry of DRAW is the
 * resting face; a pose listed here gets the same blink and lip-sync while it is shown. The boy's surprised face (cut from video 5)
 * has its own small "o" mouth, so the drawn mouth only takes over when he speaks or the surprise passes.
 */
export const DRAW_CELLS: Partial<Record<SpriteArt, Partial<Record<AvatarCell, Record<"compact" | "expanded", FaceDraw>>>>> = {
  dark: {
    s1: {
      compact: { w: 512, h: 441, eyes: [{ cx: 170, cy: 321, rx: 37, ry: 28, top: "rgb(190,172,168)", bottom: "rgb(214,190,184)" }, { cx: 312, cy: 321, rx: 44, ry: 30, top: "rgb(190,172,168)", bottom: "rgb(214,190,184)" }], mouth: { cx: 235, cy: 392, w: 90 }, patch: { rx: 24, ry: 17 }, mouthStyle: BOY_MOUTH, native: { w: 28, h: 19 }, skinTop: "rgb(208,190,180)", skinBottom: "rgb(190,168,160)", restCell: "s1" },
      expanded: { w: 354, h: 512, eyes: [{ cx: 116, cy: 230, rx: 24, ry: 20, top: "rgb(190,172,168)", bottom: "rgb(214,190,184)" }, { cx: 208, cy: 229, rx: 26, ry: 20, top: "rgb(190,172,168)", bottom: "rgb(214,190,184)" }], mouth: { cx: 159, cy: 276, w: 58 }, patch: { rx: 15, ry: 11 }, mouthStyle: BOY_MOUTH, native: { w: 17, h: 12 }, skinTop: "rgb(206,189,179)", skinBottom: "rgb(184,160,152)", restCell: "s1" },
    },
  },
};

/**
 * The girl's poses are registered onto her resting sprite by her glasses (scripts/cut-video-register.mjs), so her measured eyes and mouth
 * lie on every pose and the same blink and lip-sync can be drawn over each one. Where a pose's own eyes are shut or winking, or its head is
 * tilted so one lens does not line up, only the mouth is drawn.
 */
/**
 * Each pose's own mouth was erased from its sprite, so the one drawn mouth sits where that pose's mouth was: `dy` from the resting mouth
 * (compact pixels; the expanded view scales them).
 */
const bobLike = (cell: AvatarCell, noEyes = false, dy = 0): Record<"compact" | "expanded", FaceDraw> => {
  const out = {} as Record<"compact" | "expanded", FaceDraw>;
  for (const v of ["compact", "expanded"] as const) {
    const d = DRAW.bob![v];
    out[v] = { ...d, restCell: cell, noEyes, mouth: { ...d.mouth, cy: d.mouth.cy + dy * (v === "compact" ? 1 : 0.7) } };
  }
  return out;
};
DRAW_CELLS.bob = { r1c2: bobLike("r1c2", true, 12), r1c3: bobLike("r1c3", true), r2c1: bobLike("r2c1", false, 3), r2c2: bobLike("r2c2", true, -6), r2c3: bobLike("r2c3"), g1: bobLike("g1", false, -5) };

/**
 * The boy's eyes-closed smile with glasses (cut from video 4): only the mouth is drawn. The drawn mouth and its skin patch are kept below
 * the glasses frame, which runs close to the mouth corners, so the frame is never painted over.
 */
const laugh = (view: "compact" | "expanded"): FaceDraw => view === "compact"
  ? { w: 512, h: 441, noEyes: true, eyes: DRAW.dark!.compact.eyes, mouth: { cx: 212, cy: 375, w: 70 }, patch: { rx: 33, ry: 11 }, mouthStyle: BOY_MOUTH, clip: [[150, 358], [230, 358], [236, 374], [330, 374], [330, 430], [150, 430]], skinTop: "rgb(206,186,180)", skinBottom: "rgb(204,182,176)", restCell: "h1" }
  : { w: 354, h: 512, noEyes: true, eyes: DRAW.dark!.expanded.eyes, mouth: { cx: 158, cy: 264, w: 48 }, patch: { rx: 22, ry: 8 }, mouthStyle: BOY_MOUTH, clip: [[100, 255], [168, 255], [172, 265], [230, 265], [230, 300], [100, 300]], skinTop: "rgb(206,186,180)", skinBottom: "rgb(204,182,176)", restCell: "h1" };
DRAW_CELLS.dark!.h1 = { compact: laugh("compact"), expanded: laugh("expanded") };
