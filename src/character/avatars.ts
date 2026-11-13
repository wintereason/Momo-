import type { AvatarArt, CharacterPrefs } from "./config";
import type { ExpressionId } from "./face";

/**
 * The avatar sheets: two 3D chibi figures, six drawn faces each. The files are cut from the sheets by
 * scripts/cut-avatar-sheets.mjs into `assets/avatars/<art>/{head,full}/<cell>.png`.
 *
 * A sheet cannot blink or move its mouth, so each of Momo's semantic expressions maps to the drawn face that reads
 * closest. That keeps the avatar honest: it only ever shows a face the artist actually drew.
 */
export const AVATAR_ARTS = ["pink", "dark"] as const;
export type SpriteArt = (typeof AVATAR_ARTS)[number];

export const AVATAR_CELLS = ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"] as const;
export type AvatarCell = (typeof AVATAR_CELLS)[number];

export interface AvatarDef {
  art: SpriteArt;
  label: string;
  blurb: string;
  /** semantic expression -> the drawn cell that best matches it */
  faces: Record<ExpressionId, AvatarCell>;
}

export const AVATARS: Record<SpriteArt, AvatarDef> = {
  // pink hair, gradient dress, round glasses
  pink: {
    art: "pink",
    label: "Pink",
    blurb: "Chibi figurine: pink-to-blue hair, round glasses, gradient dress.",
    faces: {
      idle: "r2c3",
      calm: "r2c3",
      friendly: "r1c2",
      listening: "r2c3",
      speaking: "r1c1",
      thinking: "r2c3",
      happy: "r1c2",
      excited: "r1c2",
      wink: "r1c3",
      confused: "r1c1",
      surprised: "r1c1",
      serious: "r2c1",
      sad: "r2c1",
      apologetic: "r2c2",
      warning: "r2c2",
      error: "r2c2",
    },
  },
  // black hair, black hoodie, rectangular glasses
  dark: {
    art: "dark",
    label: "Dark",
    blurb: "Chibi figurine: messy black hair, rectangular glasses, black hoodie.",
    faces: {
      idle: "r1c1",
      calm: "r1c1",
      friendly: "r1c2",
      listening: "r1c1",
      speaking: "r1c3",
      thinking: "r1c1",
      happy: "r1c2",
      excited: "r1c2",
      wink: "r1c2",
      confused: "r2c3",
      surprised: "r1c3",
      serious: "r1c1",
      sad: "r2c3",
      apologetic: "r2c3",
      warning: "r2c3",
      error: "r2c1",
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
