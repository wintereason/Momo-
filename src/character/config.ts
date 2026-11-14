import { z } from "zod";

/**
 * Momo's look and personality: the choices a user can make. Everything here is a UI preference (saved with the other
 * preferences on this PC). Nothing in it reaches the agent runtime: personality changes how Momo SOUNDS, never what it
 * knows, what it may do, or which permissions it has.
 */
/** drawn = the hand-drawn SVG face; the others are cut-out 3D avatar sheets (see avatars.ts) */
export const AVATAR_ARTS = ["drawn", "dark", "bob"] as const;
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

/** One avatar's voice: a Windows voice already installed on this PC (null = automatic), speed and pitch. Nothing is sent anywhere. */
export const VoiceProfileSchema = z.object({
  voiceURI: z.string().max(300).nullable().default(null),
  rate: z.number().min(0.6).max(1.6).default(1),
  pitch: z.number().min(0.5).max(1.8).default(1),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;
export const DEFAULT_VOICES: Record<AvatarArt, VoiceProfile> = {
  drawn: { voiceURI: null, rate: 1, pitch: 1 },
  dark: { voiceURI: null, rate: 0.95, pitch: 0.82 },
  bob: { voiceURI: null, rate: 1, pitch: 1.1 },
};

/**
 * With no voice chosen, each avatar still gets a voice of its own from the Windows voices installed on this PC: the first installed voice
 * whose name contains one of these fragments (a deeper male voice for the boy, a female voice for the girl), else its own slot among the
 * installed voices. Choosing a voice in Settings overrides this.
 */
export const VOICE_HINTS: Record<AvatarArt, { prefer: readonly string[]; slot: number }> = {
  drawn: { prefer: [], slot: 0 },
  dark: { prefer: ["David", "Mark", "George", "Guy", "Ryan", "James", "Daniel", "Alex", "Male"], slot: 0 },
  bob: { prefer: ["Zira", "Hazel", "Aria", "Jenny", "Susan", "Sonia", "Libby", "Samantha", "Female"], slot: 1 },
};

/**
 * Online voice ids (ElevenLabs), one per avatar: dark = the male voice, bob = the female voice. They are used ONLY while an ElevenLabs key is
 * set in Momo's .env and the avatar's "online voice" switch is on (it is, by default): then what Momo says is sent to ElevenLabs to be spoken.
 * With no key, offline, over the daily limit, or when a Windows voice was chosen by hand, the Windows voices above speak instead.
 */
export const CLOUD_VOICE_IDS: Partial<Record<AvatarArt, string>> = {
  dark: "DODLEQrClDo8wCz460ld",
  bob: "4e32WqNVWRquDa1OcRYZ",
};

export const CharacterPrefsSchema = z.object({
  /** show the character at all (off = the plain pill bar) */
  enabled: z.boolean().default(true),
  /** compact: a small face above the pill. expanded: the upper body, larger */
  view: z.enum(VIEWS).default("compact"),
  /** which art to draw: the hand-drawn face, or one of the bundled avatar sheets */
  // saved preferences from when the (now removed) pink avatar existed still load: they get the new default
  art: z.preprocess((v) => (v === "pink" ? "dark" : v), z.enum(AVATAR_ARTS)).default("dark"),
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
  /** use the avatar's online voice (see CLOUD_VOICE_IDS) when a key is set; off = always the Windows voice */
  onlineVoice: z.boolean().default(true),
  /** each avatar has its own voice; choosing an avatar never changes another avatar's voice, and the voice never changes the look */
  voices: z.object({ drawn: VoiceProfileSchema.default(DEFAULT_VOICES.drawn), dark: VoiceProfileSchema.default(DEFAULT_VOICES.dark), bob: VoiceProfileSchema.default(DEFAULT_VOICES.bob) }).default(DEFAULT_VOICES),
});
export type CharacterPrefs = z.infer<typeof CharacterPrefsSchema>;

export const defaultCharacter: CharacterPrefs = {
  enabled: true,
  view: "compact",
  art: "dark",
  presentation: "neutral",
  hairstyle: "messy",
  hairColor: "theme",
  outfit: "hoodie",
  headphones: true,
  theme: "classic",
  personality: "friendly",
  animation: "full",
  onlineVoice: true,
  voices: DEFAULT_VOICES,
};

/** the online voice id to ask for with this character's speech (undefined = use the Windows voice) */
export const onlineVoiceIdFor = (c: Pick<CharacterPrefs, "art" | "onlineVoice">): string | undefined => (c.onlineVoice ? CLOUD_VOICE_IDS[c.art] : undefined);

/** Words for the Settings screen. */
export const LABELS = {
  art: { drawn: "Drawn", dark: "Dark hair", bob: "Black bob" },
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
