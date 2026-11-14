/**
 * Learning content. Everything here is authored, checked content (alphabets, vocabulary, example sentences): nothing is generated
 * at run time, so a translation or a pronunciation note can never be invented by an AI. Where a thing is not covered, the course
 * says so instead of guessing.
 */
export type LangId = "fr" | "ko" | "zh" | "ja";
export type Level = "beginner" | "intermediate" | "advanced";
export const LEVELS: readonly Level[] = ["beginner", "intermediate", "advanced"] as const;

export interface LangInfo {
  id: LangId;
  /** English name and the name in the language itself */
  name: string;
  nativeName: string;
  /** the writing system, so no screen ever assumes the English alphabet */
  script: "Latin" | "Hangul" | "Han (Chinese characters) with Pinyin" | "Hiragana";
  /** speech synthesis language tag, and the speech-recognition code */
  tts: string;
  stt: string;
  /** what the second line under a word is called ("Pinyin", "Romanization"...) */
  romanLabel: string;
  tonal: boolean;
  /** an input method note for typing answers */
  typingNote: string;
}

export interface Example { text: string; roman?: string; meaning: string }

/** one letter or symbol of a writing system */
export interface Symbol {
  id: string;
  /** the symbol in its original script */
  char: string;
  /** its romanization / name */
  roman: string;
  /** a learner-friendly pronunciation guide, in English */
  guide: string;
  /** a word or sentence that uses it (optional) */
  example?: Example;
}

export interface VocabItem {
  id: string;
  /** the word in the original script */
  text: string;
  roman?: string;
  /** meaning in the native language (English) */
  meaning: string;
  guide: string;
  example: Example;
  /** where it is used */
  context: string;
  /** other spellings accepted when the user types it (e.g. without accents or in romanization) */
  accept?: string[];
}

export type LessonKind = "writing" | "vocab";
export interface Lesson {
  id: string;
  lang: LangId;
  level: Level;
  kind: LessonKind;
  title: string;
  /** what the learner will be able to do after this lesson */
  objective: string;
  category?: string;
  symbols?: Symbol[];
  vocab?: VocabItem[];
}

export interface Course {
  lang: LangId;
  level: Level;
  lessons: Lesson[];
}
