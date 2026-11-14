import { describe, expect, it } from "vitest";
import { buildActivities, evaluate, itemsOf } from "./activities";
import { courseFor, LANGUAGES, lessonById, type LangId } from "./content";
import { isLearned, vocabLearned } from "./goals";
import { advance, answerQuestion, ensureCourse, interviewAvailable, levelStatus, startAttempt } from "./progress";
import { freshState, LearningStateSchema, type LearningState, type Question } from "./state";
import { LearningStore } from "./store";
import { matchesAny, normalizeAnswer } from "./text";
import type { KV } from "../state/settings";

let clock = 9_000;
const tick = () => (clock += 1000);
const mem = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
function respond(q: Question, right: boolean, mode?: "spoken" | "typed-instead-of-speaking"): { given: string; mode: "typed" | "chosen" | "spoken" | "typed-instead-of-speaking" } {
  if (q.kind === "match") { const m: Record<string, string> = {}; (q.pairs ?? []).forEach((p, i, a) => { m[p.id] = right ? p.right : a[(i + 1) % a.length].right; }); return { given: JSON.stringify(m), mode: "chosen" }; }
  if (q.kind === "choice" || q.kind === "audio-id") return { given: right ? q.answer : (q.options ?? []).find((o) => normalizeAnswer(o) !== normalizeAnswer(q.answer)) ?? "zzz", mode: "chosen" };
  if (q.kind === "translate" || q.kind === "fill-blank") return { given: right ? q.answer : "qqqq", mode: "typed" };
  return { given: right ? q.target ?? q.answer : "zzzz", mode: mode ?? "typed-instead-of-speaking" };
}
function play(s: LearningState, lessonId: string, rightShare: number, seed = 3, speakMode?: "spoken" | "typed-instead-of-speaking"): { state: LearningState; passed: boolean } {
  const st = startAttempt(s, lessonId, tick(), seed);
  if (!st.ok) throw new Error(st.reason);
  let state = st.state, n = 0;
  for (;;) {
    const a = state.lessons[lessonId].active!;
    for (const q of a.activities[a.index].questions) {
      const speaking = q.kind === "repeat" || q.kind === "speak";
      const r = respond(q, speaking ? true : (n++ % 10) < Math.round(rightShare * 10), speakMode);
      const res = answerQuestion(state, lessonId, q.id, r.given, r.mode, tick());
      if (!res.ok) throw new Error(res.reason);
      state = res.state;
    }
    const adv = advance(state, lessonId, tick());
    if (!adv.ok) throw new Error(adv.reason);
    state = adv.state;
    if (adv.finished) return { state, passed: adv.finished.passed };
  }
}
const start = (lang: LangId) => ensureCourse(freshState(lang, tick()), tick());
/** pass every lesson before `lessonId` */
function through(s: LearningState, lessonId: string): LearningState {
  for (const l of courseFor(s.settings.lang, s.settings.level).lessons) { if (l.id === lessonId) break; s = play(s, l.id, 1).state; }
  return s;
}

describe("mastery needs evidence from several finished attempts", () => {
  it("one lucky pass, even a perfect one, never makes a word learned", () => {
    let s = through(start("fr"), "fr-v1");
    s = play(s, "fr-v1", 1, 1).state;
    expect(vocabLearned(s)).toBe(0);
    // every vocabulary item was tested many times in that one attempt (match, choice, audio, translate, fill, repeat) and still counts once
    expect(s.vocab["fr-merci"].recent).toEqual([true]);
    s = play(s, "fr-v1", 1, 2).state;
    expect(vocabLearned(s)).toBe(0);
    s = play(s, "fr-v1", 1, 3).state;
    expect(vocabLearned(s)).toBe(8); // the third distinct attempt establishes it
  });
  it("the evidence needed is configurable", () => {
    let s = through(start("fr"), "fr-v1");
    s = { ...s, settings: { ...s.settings, masteryNeeded: 2 } };
    s = play(s, "fr-v1", 1, 1).state;
    expect(vocabLearned(s)).toBe(0);
    s = play(s, "fr-v1", 1, 2).state;
    expect(vocabLearned(s)).toBe(8);
    let strict = through(start("fr"), "fr-v1");
    strict = { ...strict, settings: { ...strict.settings, masteryNeeded: 5, masteryWindow: 6 } };
    for (let k = 1; k <= 4; k++) strict = play(strict, "fr-v1", 1, k).state;
    expect(vocabLearned(strict)).toBe(0);
    strict = play(strict, "fr-v1", 1, 5).state;
    expect(vocabLearned(strict)).toBe(8);
  });
  it("a later mistake takes mastery back until the word is right again; old successes leave the window", () => {
    const set = { masteryNeeded: 3, masteryWindow: 5 };
    expect(isLearned({ recent: [true, true, true] }, set)).toBe(true);
    expect(isLearned({ recent: [true, true, true, false] }, set)).toBe(false); // the latest attempt got it wrong
    expect(isLearned({ recent: [true, true, true, false, true] }, set)).toBe(true); // 4 of the last 5, and the latest is right
    expect(isLearned({ recent: [true, true, false, false, false, true] }, set)).toBe(false); // the early successes fell out of the window
    expect(isLearned({ recent: [] }, set)).toBe(false);
    expect(isLearned(undefined, set)).toBe(false);
    expect(isLearned({ recent: [true, true] }, { masteryNeeded: 4, masteryWindow: 3 })).toBe(false); // the window is never smaller than what is needed
  });
  it("in a real course, failing a word after three good attempts un-learns it", () => {
    let s = through(start("fr"), "fr-v1");
    for (let k = 1; k <= 3; k++) s = play(s, "fr-v1", 1, k).state;
    expect(vocabLearned(s)).toBe(8);
    s = play(s, "fr-v1", 0, 4).state; // all checkable answers wrong
    expect(vocabLearned(s)).toBe(0);
  });
  it("does not change the mandatory progression: revision and unlocks still work the same", () => {
    let s = start("fr");
    const failed = play(s, "fr-w1", 0.2);
    expect(failed.state.lessons["fr-w1"].status).toBe("revision_required");
    expect(failed.state.lessons["fr-w2"].status).toBe("locked");
    s = failed.state;
    s = play(s, "fr-w1", 1, 8).state; // the revision
    expect(s.lessons["fr-w1"].revisionPassed).toBe(true);
    expect(s.lessons["fr-w2"].status).toBe("locked");
    s = play(s, "fr-w1", 1, 9).state;
    expect(s.lessons["fr-w1"].status).toBe("passed");
    expect(s.lessons["fr-w2"].status).toBe("available");
  });
  it("saved data from before this change still loads (no evidence yet means not learned)", () => {
    const s = start("fr");
    const raw = JSON.parse(JSON.stringify(s));
    raw.vocab = { "fr-merci": { seen: 9, correct: 9, wrong: 0, strength: 1, lastSeen: 1 } };
    const loaded = LearningStateSchema.parse(raw);
    expect(loaded.vocab["fr-merci"].recent).toEqual([]);
    expect(vocabLearned(loaded)).toBe(0);
    expect(loaded.settings.masteryNeeded).toBe(3);
  });
});

describe("speaking: recognised speech and typed answers are never confused", () => {
  it("records how each speaking activity was answered, and only recognised speech makes a pronunciation estimate", () => {
    const base = through(start("fr"), "fr-v1");
    const spoken = play(base, "fr-v1", 1, 1, "spoken");
    const typed = play(base, "fr-v1", 1, 1, "typed-instead-of-speaking");
    const a = spoken.state.lessons["fr-v1"].attempts.at(-1)!, b = typed.state.lessons["fr-v1"].attempts.at(-1)!;
    expect(a.speaking!.spoken).toBeGreaterThan(0);
    expect(a.speaking!.typed).toBe(0);
    expect(b.speaking!.typed).toBeGreaterThan(0);
    expect(b.speaking!.spoken).toBe(0);
    expect(spoken.state.pronunciation.length).toBeGreaterThan(0);
    expect(spoken.state.pronunciation.every((p) => p.verified === false)).toBe(true);
    expect(typed.state.pronunciation.length).toBe(base.pronunciation.length); // typing is not speaking practice
  });
  it("typed text in place of speech is judged as a typed answer, with no estimate", () => {
    const q = buildActivities(lessonById("fr-v1")!, { difficulty: 2, seed: 1 }).find((x) => x.kind === "repeat")!.questions[0];
    expect(evaluate(q, q.target!, "fr", "typed-instead-of-speaking").estimate).toBeUndefined();
    expect(evaluate(q, q.target!, "fr", "spoken").estimate).toMatchObject({ verified: false });
  });
  it("a recognizer that returned nothing or something unrelated is reported as such, never as a pass of speaking", () => {
    const q = buildActivities(lessonById("zh-v1")!, { difficulty: 2, seed: 1 }).find((x) => x.kind === "repeat")!.questions[0];
    const none = evaluate(q, "completely unrelated words", "zh", "spoken");
    expect(none.estimate!.verdict).toBe("different");
    expect(none.estimate!.note).toMatch(/Tones cannot be checked/);
  });
});

// ---------------------------------------------------------------- the four beginner courses
const SCRIPT: Record<LangId, RegExp> = {
  fr: /^[\p{Script=Latin}'’\s.,?!-]+$/u, ko: /\p{Script=Hangul}/u, ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, zh: /\p{Script=Han}/u,
};
const TONE_MARK = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/;
const LANGS: LangId[] = ["fr", "ko", "zh", "ja"];

describe.each(LANGS)("%s: content is in the right script and complete", (lang) => {
  const lessons = courseFor(lang, "beginner").lessons;
  const writing = lessons.filter((l) => l.kind === "writing"), vocab = lessons.filter((l) => l.kind === "vocab");

  it("uses the language's own script, with every field a learner needs", () => {
    expect(writing.length).toBeGreaterThan(0);
    expect(vocab.map((l) => l.category)).toEqual(["Greetings and introductions", "Numbers and dates"]);
    for (const l of writing) for (const s of l.symbols!) {
      expect(SCRIPT[lang].test(s.char), `${s.id} ${s.char}`).toBe(true);
      expect(s.roman.length).toBeGreaterThan(0);
      expect(s.guide.length, s.id).toBeGreaterThan(3);
    }
    for (const l of vocab) for (const v of l.vocab!) {
      expect(SCRIPT[lang].test(v.text), `${v.id} ${v.text}`).toBe(true);
      expect(SCRIPT[lang].test(v.example.text), `${v.id} example`).toBe(true);
      expect(/^[\x20-\x7E’‘–—]+$/.test(v.meaning), `${v.id} meaning is English`).toBe(true);
      expect(/^[\x20-\x7E’‘–—]+$/.test(v.example.meaning), `${v.id} example meaning is English`).toBe(true);
      expect(v.guide.length, v.id).toBeGreaterThan(1);
      expect(v.context.length, v.id).toBeGreaterThan(3);
      if (lang !== "fr") { expect(v.roman, v.id).toBeTruthy(); expect(v.example.roman, v.id).toBeTruthy(); }
    }
    expect(LANGUAGES[lang].tts).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    expect(LANGUAGES[lang].stt).toBe(lang);
  });
  it("teaches greetings, yes/no, thanks and sorry, and the numbers one to ten in order", () => {
    const meanings = vocab[0].vocab!.map((v) => v.meaning.toLowerCase()).join(" | ");
    for (const w of ["hello", "goodbye", "thank you", "please", "yes", "no", "sorry|excuse me"]) expect(new RegExp(w).test(meanings), `${lang} ${w}`).toBe(true);
    expect(vocab[1].vocab!.map((v) => v.meaning)).toEqual(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);
  });
  it("every fill-in-the-blank hides the word it asks for, and typed variants are accepted", () => {
    for (const l of vocab) for (const act of buildActivities(l, { difficulty: 2, seed: 5, speaking: false })) for (const q of act.questions) {
      if (q.kind === "fill-blank") { expect(q.prompt).toContain("____"); expect(normalizeAnswer(q.prompt)).not.toContain(normalizeAnswer(q.answer)); }
    }
    for (const l of vocab) for (const i of itemsOf(l)) {
      expect(matchesAny(i.text, i.accept), `${i.id}: the word itself`).toBe(true);
      if (i.roman) expect(matchesAny(i.roman, i.accept), `${i.id}: its romanization`).toBe(true);
      expect(matchesAny("zzzz", i.accept)).toBe(false);
    }
  });
});

describe("language-specific details", () => {
  it("French: apostrophes (straight or curly), missing accents and capitals are all accepted", () => {
    const it = itemsOf(lessonById("fr-v1")!).find((i) => i.id === "fr-sil-vous-plait")!;
    for (const v of ["s’il vous plaît", "s'il vous plaît", "s'il vous plait", "S'IL VOUS PLAÎT", "sil vous plait", "  s’il   vous  plaît! "]) expect(matchesAny(v, it.accept), v).toBe(true);
    expect(matchesAny("s'il vous plaire", it.accept)).toBe(false);
    expect(matchesAny("Cafe", ["café"])).toBe(true);
    const frAccents = lessonById("fr-w3")!.symbols!.map((s) => s.char);
    expect(frAccents).toEqual(expect.arrayContaining(["é", "è", "ê", "à", "ç", "ô", "ï"]));
  });
  it("Mandarin: the four tones are taught in order with the right marks, and answers work with characters, Pinyin with tones, or toneless Pinyin", () => {
    const tones = lessonById("zh-w1")!.symbols!;
    expect(tones.map((s) => s.roman)).toEqual(["mā", "má", "mǎ", "mà", "ma"]);
    expect(tones.slice(0, 4).every((s) => TONE_MARK.test(s.roman))).toBe(true);
    expect(TONE_MARK.test(tones[4].roman)).toBe(false); // the neutral tone carries no mark
    expect(tones.map((s) => s.guide.split(":")[0])).toEqual(["tone 1", "tone 2", "tone 3", "tone 4", "neutral tone"]);
    // every Pinyin word of the course carries tone marks (or is neutral on purpose)
    for (const l of courseFor("zh", "beginner").lessons.filter((x) => x.kind === "vocab")) for (const v of l.vocab!) expect(TONE_MARK.test(v.roman!), `${v.id} ${v.roman}`).toBe(true);
    const nihao = itemsOf(lessonById("zh-v1")!).find((i) => i.id === "zh-nihao")!;
    for (const v of ["你好", "nǐ hǎo", "ni hao", "nihao", "Ni Hao"]) expect(matchesAny(v, nihao.accept), v).toBe(true);
    expect(matchesAny("你们好", nihao.accept)).toBe(false);
    expect(LANGUAGES.zh.tonal).toBe(true);
    expect(LANGUAGES.fr.tonal || LANGUAGES.ko.tonal || LANGUAGES.ja.tonal).toBe(false);
  });
  it("Korean: Hangul or romanization are accepted; syllable blocks and batchim are taught", () => {
    const hello = itemsOf(lessonById("ko-v1")!).find((i) => i.id === "ko-annyeong")!;
    for (const v of ["안녕하세요", "annyeonghaseyo", "Annyeonghaseyo"]) expect(matchesAny(v, hello.accept), v).toBe(true);
    expect(matchesAny("안녕", hello.accept)).toBe(false);
    const blocks = lessonById("ko-w4")!.symbols!;
    expect(blocks.find((s) => s.char === "한")!.guide).toMatch(/final consonant \(batchim\)/);
    expect(blocks.every((s) => /^[가-힣]$/u.test(s.char))).toBe(true); // each one is a real syllable block
  });
  it("Japanese: kana or romaji are accepted, with or without long-vowel marks; dakuten are not confused", () => {
    const it = itemsOf(lessonById("ja-v1")!).find((i) => i.id === "ja-ohayo")!;
    for (const v of ["おはよう", "ohayō", "ohayo", "ohayou"]) expect(matchesAny(v, it.accept), v).toBe(true);
    expect(matchesAny("おはよ", it.accept)).toBe(false);
    expect(matchesAny("が", ["か"])).toBe(false);
    const four = itemsOf(lessonById("ja-v2")!).find((i) => i.id === "ja-n4")!;
    expect(matchesAny("yon", four.accept) && matchesAny("し", four.accept) && matchesAny("shi", four.accept)).toBe(true); // 4 is yon or shi
  });
});

describe.each(LANGS)("%s: the whole beginner course, from fail to interview", (lang) => {
  it("fail -> revision -> pass -> unlock, every lesson in order, then the interview opens", () => {
    const lessons = courseFor(lang, "beginner").lessons;
    let s = start(lang);
    expect(lessons.slice(1).every((l) => s.lessons[l.id].status === "locked")).toBe(true);
    // the first lesson: fail, revise, retake
    const failed = play(s, lessons[0].id, 0.2);
    expect(failed.passed).toBe(false);
    expect(failed.state.lessons[lessons[0].id].status).toBe("revision_required");
    expect(failed.state.lessons[lessons[1].id].status).toBe("locked");
    s = play(failed.state, lessons[0].id, 1, 8).state; // revision
    expect(s.lessons[lessons[1].id].status).toBe("locked");
    s = play(s, lessons[0].id, 1, 9).state;
    expect(s.lessons[lessons[1].id].status).toBe("available");
    // the rest, strictly in order
    for (let i = 1; i < lessons.length; i++) {
      expect(startAttempt(s, lessons[i].id, tick(), 1)).toMatchObject({ ok: true });
      if (i + 1 < lessons.length) expect(startAttempt(s, lessons[i + 1].id, tick(), 1)).toMatchObject({ ok: false });
      s = play(s, lessons[i].id, 1, 20 + i).state;
    }
    expect(levelStatus(s, lang, "beginner")).toMatchObject({ lessonsPassed: lessons.length, lessonsTotal: lessons.length, complete: false });
    expect(interviewAvailable(s, lang, "beginner")).toEqual({ ok: true });
    // everything survives a restart
    const kv = mem();
    const store = new LearningStore(kv, tick);
    store.createProfile("Ana", lang);
    store.update(() => s);
    const again = new LearningStore(kv, tick);
    expect(again.state()).toEqual(s);
    expect(levelStatus(again.state()!, lang, "beginner").lessonsPassed).toBe(lessons.length);
  });
});

import { cleanHeard, MAX_HEARD_CHARS } from "./text";
describe("what the recognizer heard is cleaned before it can be an answer (found with a real microphone)", () => {
  it("silence hallucinations are nothing, not an answer", () => {
    for (const t of ["...", " … ", "- ...", "?", "-", "", "  ", "。", "!!!"]) expect(cleanHeard(t), JSON.stringify(t)).toBe("");
    expect(cleanHeard("Bonjour")).toBe("Bonjour");
    expect(cleanHeard("- Bonjour, madame.")).toBe("Bonjour, madame.");
    expect(cleanHeard("你好")).toBe("你好");
    expect(cleanHeard("안녕하세요")).toBe("안녕하세요");
  });
  it("a looping phrase is kept once, and runaway text is capped", () => {
    const loop = "- " + "Je vais vous dire que ".repeat(40).trim();
    expect(cleanHeard(loop)).toBe("Je vais vous dire que");
    expect(cleanHeard("merci merci merci merci")).toBe("merci");
    expect(cleanHeard("oui oui")).toBe("oui oui"); // two repeats are ordinary speech
    expect(cleanHeard("a b c d e f g h i j k l m n o p q r s t u v w x y z ".repeat(30)).length).toBeLessThanOrEqual(MAX_HEARD_CHARS + 1);
    expect(cleanHeard(undefined as unknown as string)).toBe("");
  });
});
