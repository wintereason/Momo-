import { FRENCH_LESSONS } from "./french";
import { JAPANESE_LESSONS } from "./japanese";
import { KOREAN_LESSONS } from "./korean";
import { MANDARIN_LESSONS } from "./mandarin";
import type { Course, LangId, LangInfo, Lesson, Level } from "./types";
import { LEVELS } from "./types";

export * from "./types";

export const LANGUAGES: Record<LangId, LangInfo> = {
  fr: { id: "fr", name: "French", nativeName: "Français", script: "Latin", tts: "fr-FR", stt: "fr", romanLabel: "Pronunciation", tonal: false, typingNote: "Accents are optional when typing: “cafe” is accepted for “café”." },
  ko: { id: "ko", name: "Korean", nativeName: "한국어", script: "Hangul", tts: "ko-KR", stt: "ko", romanLabel: "Romanization", tonal: false, typingNote: "You can type Hangul, or the romanization shown under each word." },
  zh: { id: "zh", name: "Mandarin Chinese", nativeName: "中文（普通话）", script: "Han (Chinese characters) with Pinyin", tts: "zh-CN", stt: "zh", romanLabel: "Pinyin", tonal: true, typingNote: "You can type characters, or Pinyin (tone marks are optional when typing)." },
  ja: { id: "ja", name: "Japanese", nativeName: "日本語", script: "Hiragana", tts: "ja-JP", stt: "ja", romanLabel: "Romaji", tonal: false, typingNote: "You can type kana, or the romaji shown under each word." },
};

const ALL: Lesson[] = [...FRENCH_LESSONS, ...KOREAN_LESSONS, ...MANDARIN_LESSONS, ...JAPANESE_LESSONS];

/** The native languages the course explanations are written in. Only English is authored so far; the app says so. */
export const NATIVE_LANGUAGES = [{ id: "en", name: "English" }] as const;

export function courseFor(lang: LangId, level: Level): Course {
  return { lang, level, lessons: ALL.filter((l) => l.lang === lang && l.level === level) };
}
/** Levels that have authored lessons for a language. Intermediate and advanced are not written yet: the app shows that honestly. */
export function levelsAvailable(lang: LangId): Level[] {
  return LEVELS.filter((lv) => ALL.some((l) => l.lang === lang && l.level === lv));
}
export function lessonById(id: string): Lesson | undefined {
  return ALL.find((l) => l.id === id);
}
export const allLessons = (): readonly Lesson[] => ALL;
