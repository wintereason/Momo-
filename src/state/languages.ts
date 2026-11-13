/** Spoken languages Momo offers (Whisper language codes), with the script each is normally written in. */
export type Script = "latin" | "devanagari" | "bengali" | "gujarati" | "gurmukhi" | "tamil" | "telugu" | "kannada" | "malayalam" | "arabic" | "cyrillic" | "han" | "kana" | "hangul" | "thai" | "hebrew" | "greek";

export interface Language { code: string; name: string; native: string; script: Script; group: "India" | "World" }

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", native: "English", script: "latin", group: "India" },
  { code: "hi", name: "Hindi", native: "हिन्दी", script: "devanagari", group: "India" },
  { code: "mr", name: "Marathi", native: "मराठी", script: "devanagari", group: "India" },
  { code: "ne", name: "Nepali", native: "नेपाली", script: "devanagari", group: "India" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી", script: "gujarati", group: "India" },
  { code: "bn", name: "Bengali", native: "বাংলা", script: "bengali", group: "India" },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", script: "gurmukhi", group: "India" },
  { code: "ta", name: "Tamil", native: "தமிழ்", script: "tamil", group: "India" },
  { code: "te", name: "Telugu", native: "తెలుగు", script: "telugu", group: "India" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", script: "kannada", group: "India" },
  { code: "ml", name: "Malayalam", native: "മലയാളം", script: "malayalam", group: "India" },
  { code: "ur", name: "Urdu", native: "اردو", script: "arabic", group: "India" },
  { code: "es", name: "Spanish", native: "Español", script: "latin", group: "World" },
  { code: "fr", name: "French", native: "Français", script: "latin", group: "World" },
  { code: "de", name: "German", native: "Deutsch", script: "latin", group: "World" },
  { code: "it", name: "Italian", native: "Italiano", script: "latin", group: "World" },
  { code: "pt", name: "Portuguese", native: "Português", script: "latin", group: "World" },
  { code: "nl", name: "Dutch", native: "Nederlands", script: "latin", group: "World" },
  { code: "tr", name: "Turkish", native: "Türkçe", script: "latin", group: "World" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia", script: "latin", group: "World" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", script: "latin", group: "World" },
  { code: "pl", name: "Polish", native: "Polski", script: "latin", group: "World" },
  { code: "sv", name: "Swedish", native: "Svenska", script: "latin", group: "World" },
  { code: "ru", name: "Russian", native: "Русский", script: "cyrillic", group: "World" },
  { code: "uk", name: "Ukrainian", native: "Українська", script: "cyrillic", group: "World" },
  { code: "ar", name: "Arabic", native: "العربية", script: "arabic", group: "World" },
  { code: "fa", name: "Persian", native: "فارسی", script: "arabic", group: "World" },
  { code: "he", name: "Hebrew", native: "עברית", script: "hebrew", group: "World" },
  { code: "el", name: "Greek", native: "Ελληνικά", script: "greek", group: "World" },
  { code: "th", name: "Thai", native: "ไทย", script: "thai", group: "World" },
  { code: "zh", name: "Chinese", native: "中文", script: "han", group: "World" },
  { code: "ja", name: "Japanese", native: "日本語", script: "kana", group: "World" },
  { code: "ko", name: "Korean", native: "한국어", script: "hangul", group: "World" },
];

export const languageName = (code: string): string =>
  code === "auto" ? "Detect automatically" : LANGUAGES.find((l) => l.code === code)?.name ?? code;

const RANGES: Record<Exclude<Script, "latin">, RegExp> = {
  devanagari: /[ऀ-ॿ]/g, bengali: /[ঀ-৿]/g, gurmukhi: /[਀-੿]/g, gujarati: /[઀-૿]/g,
  tamil: /[஀-௿]/g, telugu: /[ఀ-౿]/g, kannada: /[ಀ-೿]/g, malayalam: /[ഀ-ൿ]/g,
  arabic: /[؀-ۿݐ-ݿ]/g, cyrillic: /[Ѐ-ӿ]/g, han: /[一-鿿]/g, kana: /[぀-ヿ一-鿿]/g,
  hangul: /[가-힯]/g, thai: /[฀-๿]/g, hebrew: /[֐-׿]/g, greek: /[Ͱ-Ͽ]/g,
};
const count = (s: string, r: RegExp) => (s.match(r) ?? []).length;

/**
 * Did speech recognition write the words in a different script than the chosen language uses? The classic case: Hindi
 * heard and written in Urdu (Arabic) letters. Latin text is never flagged (Hinglish is fine).
 */
export function wrongScript(code: string, text: string): boolean {
  const lang = LANGUAGES.find((l) => l.code === code);
  if (!lang || lang.script === "latin" || !text) return false;
  const mine = count(text, RANGES[lang.script as Exclude<Script, "latin">]);
  let other = 0;
  for (const [k, r] of Object.entries(RANGES)) if (k !== lang.script) other += count(text, r);
  return other > 0 && other > mine * 2;
}

/** "Hindi · हिन्दी" (just "English" when the native name is the same). */
export const languageLabel = (l: Language): string => (l.native === l.name ? l.name : `${l.name} · ${l.native}`);
