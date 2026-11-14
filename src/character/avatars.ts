import type { AvatarArt, CharacterPrefs } from "./config";
import type { ExpressionId } from "./face";

/**
 * The avatar sheets: two 3D chibi figures, six drawn faces each. Dark is cut from the supplied sheet by
 * scripts/cut-avatar-sheets.mjs; "bob" (black bob, round glasses, cream dress) exists only in the supplied reference videos, so
 * scripts/cut-video-avatar.mjs cuts its six poses out of six video frames. The files go into `assets/avatars/<art>/{head,full}/<cell>.png`.
 *
 * A sheet cannot blink or move its mouth, so each of Momo's semantic expressions maps to the drawn face that reads
 * closest. That keeps the avatar honest: it only ever shows a face the artist actually drew.
 */
export const AVATAR_ARTS = ["dark", "bob"] as const;
export type SpriteArt = (typeof AVATAR_ARTS)[number];

export const AVATAR_CELLS = ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"] as const;
/** extra poses cut from the reference videos (see scripts/cut-video-register.mjs): s1 = the boy's surprised face WITH his glasses; g1 = the girl waving; h1 = the boy's eyes-closed smile WITH his glasses (the sheet's laughing face has none) */
export const EXTRA_CELLS = ["s1", "g1", "h1"] as const;
export type AvatarCell = (typeof AVATAR_CELLS)[number] | (typeof EXTRA_CELLS)[number];

export interface AvatarDef {
  art: SpriteArt;
  label: string;
  blurb: string;
  /** semantic expression -> the drawn cell that best matches it */
  faces: Record<ExpressionId, AvatarCell>;
  /** symbols that replace the default one for an expression (the drawn pose may already carry it, e.g. sweat drops) */
  glyphs?: Partial<Record<ExpressionId, string>>;
}

export const AVATARS: Record<SpriteArt, AvatarDef> = {
  // black hair, black hoodie, rectangular glasses
  dark: {
    art: "dark",
    label: "Dark",
    blurb: "Chibi figurine: messy black hair, rectangular glasses, black hoodie.",
    glyphs: { surprised: "" },
    faces: {
      idle: "r1c1",
      calm: "r1c1",
      friendly: "r1c1",
      listening: "r1c1",
      speaking: "r1c1",
      thinking: "r1c1",
      happy: "h1",
      excited: "h1",
      wink: "h1",
      confused: "r2c3",
      surprised: "s1",
      serious: "r1c1",
      sad: "r2c3",
      apologetic: "r2c2",
      warning: "r2c3",
      error: "r2c1",
      angry: "r2c1",
      worried: "r2c3",
      sleepy: "r1c1",
    },
  },
  // black bob, round glasses, cream dress: six poses cut from the reference video (no sheet exists for her)
  bob: {
    art: "bob",
    label: "Black bob",
    blurb: "Chibi figurine: black bob, round glasses, cream puff-sleeve dress.",
    faces: {
      idle: "r1c1",
      calm: "r2c2",
      friendly: "g1",
      listening: "r2c3",
      speaking: "r1c1",
      thinking: "r1c1",
      happy: "r1c2",
      excited: "r2c1",
      wink: "r1c3",
      confused: "r1c1",
      surprised: "r1c1",
      serious: "r1c1",
      sad: "r1c1",
      apologetic: "r1c1",
      warning: "r1c1",
      error: "r1c1",
      angry: "r1c1",
      worried: "r1c1",
      sleepy: "r1c1",
    },
  },
};

/** the same files, imported at build time so Vite serves them in dev and in the packaged app */
const files = import.meta.glob("../../assets/avatars/*/*/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const byArt = new Map<string, Map<string, string>>();
for (const [file, url] of Object.entries(files)) {
  const m = file.match(/avatars\/([^/]+)\/(head|full)\/([^/]+)\.png$/);
  if (!m) continue;
  const key = `${m[2]}/${m[3]}`;
  if (!byArt.has(m[1])) byArt.set(m[1], new Map());
  byArt.get(m[1])!.set(key, url);
}

export type AvatarView = "compact" | "expanded";

/** The picture to draw for an expression. `compact` uses the head-and-shoulders crop, `expanded` the whole figure. */
export function avatarSprite(art: SpriteArt, expression: ExpressionId, view: AvatarView): string | undefined {
  const cell = AVATARS[art].faces[expression];
  return byArt.get(art)?.get(`${view === "compact" ? "head" : "full"}/${cell}`);
}

/** Every image an avatar sheet needs, for the loader and the tests. */
export function avatarFiles(art: SpriteArt): string[] {
  const m = byArt.get(art);
  return m ? [...m.keys()].sort() : [];
}

export function isSpriteArt(art: AvatarArt): art is SpriteArt {
  return art !== "drawn";
}

/** What the bar and the Settings preview should draw: the hand-drawn face, or a cut-out sheet. */
export function characterSprite(character: CharacterPrefs, expression: ExpressionId, view: AvatarView): string | undefined {
  return isSpriteArt(character.art) ? avatarSprite(character.art, expression, view) : undefined;
}
