import { z } from "zod";

/**
 * Momo's look and personality: the choices a user can make. Everything here is a UI preference (saved with the other
 * preferences on this PC). Nothing in it reaches the agent runtime: personality changes how Momo SOUNDS, never what it
 * knows, what it may do, or which permissions it has.
 */
/** drawn = the hand-drawn SVG face; the others are cut-out 3D avatar sheets (see avatars.ts) */
export const AVATAR_ARTS = ["drawn", "pink", "dark"] as const;
export const PRESENTATIONS = ["neutral", "masculine", "feminine", "androgynous"] as const;
export const HAIRSTYLES = ["messy", "short", "long", "bob", "ponytail"] as const;
export const HAIR_COLORS = ["theme", "midnight", "silver", "rose", "chestnut"] as const;
export const OUTFITS = ["hoodie", "techwear", "casual", "formal"] as const;
export const THEMES = ["classic", "cyber", "pastel", "neon"] as const;
export const PERSONALITIES = ["friendly", "professional", "playful", "strict", "calm"] as const;
export const VIEWS = ["compact", "expanded"] as const;
export const ANIMATION_LEVELS = ["full", "reduced", "off"] as const;

export type AvatarArt = (typeof AVATAR_ARTS)[number];
export type Presentation = (typeof PRESENTATIONS)[number];
export type Hairstyle = (typeof HAIRSTYLES)[number];
export type HairColor = (typeof HAIR_COLORS)[number];
export type Outfit = (typeof OUTFITS)[number];
export type Theme = (typeof THEMES)[number];
export type Personality = (typeof PERSONALITIES)[number];
export type View = (typeof VIEWS)[number];
export type AnimationLevel = (typeof ANIMATION_LEVELS)[number];

export const CharacterPrefsSchema = z.object({
  /** show the character at all (off = the plain pill bar) */
  enabled: z.boolean().default(true),
  /** compact: a small face above the pill. expanded: the upper body, larger */
  view: z.enum(VIEWS).default("compact"),
  /** which art to draw: the hand-drawn face, or one of the bundled avatar sheets */
  art: z.enum(AVATAR_ARTS).default("pink"),
  /** gender presentation. Neutral is the default; this only changes proportions and styling, never behaviour. */
  presentation: z.enum(PRESENTATIONS).default("neutral"),
  hairstyle: z.enum(HAIRSTYLES).default("messy"),
  hairColor: z.enum(HAIR_COLORS).default("theme"),
  outfit: z.enum(OUTFITS).default("hoodie"),
  headphones: z.boolean().default(true),
  theme: z.enum(THEMES).default("classic"),
  personality: z.enum(PERSONALITIES).default("friendly"),
  /** full = blinking, sway, breathing, reactions. reduced = blinking and expression changes only. off = still poses. */
  animation: z.enum(ANIMATION_LEVELS).default("full"),
});
export type CharacterPrefs = z.infer<typeof CharacterPrefsSchema>;

export const defaultCharacter: CharacterPrefs = {
  enabled: true,
  view: "compact",
  art: "pink",
  presentation: "neutral",
  hairstyle: "messy",
  hairColor: "theme",
  outfit: "hoodie",
  headphones: true,
  theme: "classic",
  personality: "friendly",
  animation: "full",
};

/** Words for the Settings screen. */
export const LABELS = {
  art: { drawn: "Drawn", pink: "Pink hair", dark: "Dark hair" },
  presentation: { neutral: "Neutral", masculine: "Masculine", feminine: "Feminine", androgynous: "Androgynous" },
  hairstyle: { messy: "Messy", short: "Short", long: "Long", bob: "Bob", ponytail: "Ponytail" },
  hairColor: { theme: "Theme", midnight: "Midnight", silver: "Silver", rose: "Rose", chestnut: "Chestnut" },
  outfit: { hoodie: "Hoodie", techwear: "Tech jacket", casual: "Sweater", formal: "Blazer" },
  theme: { classic: "Classic", cyber: "Cyber", pastel: "Pastel", neon: "Neon" },
  personality: { friendly: "Friendly", professional: "Professional", playful: "Playful", strict: "Strict", calm: "Calm" },
  view: { compact: "Compact", expanded: "Expanded" },
  animation: { full: "Full", reduced: "Reduced", off: "Off" },
} as const;

export const PERSONALITY_BLURB: Record<Personality, string> = {
  friendly: "Warm and encouraging.",
  professional: "Clear, polite and to the point.",
  playful: "Light-hearted, with a little humour.",
  strict: "Short, direct and no small talk.",
  calm: "Gentle, steady and unhurried.",
};
