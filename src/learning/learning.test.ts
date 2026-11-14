import { describe, expect, it } from "vitest";
import { buildActivities, evaluate, itemsOf, rng } from "./activities";
import { allLessons, courseFor, LANGUAGES, lessonById, levelsAvailable, type LangId } from "./content";
import { addGoal, goalProgress, recommendNext, updateGoals, vocabLearned } from "./goals";
import { abandonAttempt, advance, answerQuestion, difficultyFor, ensureCourse, interviewAvailable, isLevelUnlocked, levelStatus, resumeInfo, selectCourse, startAttempt } from "./progress";
import { freshState, type ActiveAttempt, type LearningState, type Question } from "./state";
import { LEARNING_KEY, LearningStore } from "./store";
import { estimateSpeech, matchesAny, normalizeAnswer, similarity } from "./text";
import type { KV } from "../state/settings";

const mem = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
let clock = 1_000;
const tick = () => (clock += 1000);

/** answer a question correctly (or deliberately wrongly) the way a user would */
function respond(q: Question, right: boolean): { given: string; mode: "typed" | "chosen" | "spoken" } {
  if (q.kind === "match") {
    const m: Record<string, string> = {};
    (q.pairs ?? []).forEach((p, i, a) => { m[p.id] = right ? p.right : a[(i + 1) % a.length].right; });
    return { given: JSON.stringify(m), mode: "chosen" };
  }
  if (q.kind === "choice" || q.kind === "audio-id") return { given: right ? q.answer : (q.options ?? []).find((o) => normalizeAnswer(o) !== normalizeAnswer(q.answer)) ?? "zzz", mode: "chosen" };
  if (q.kind === "translate" || q.kind === "fill-blank") return { given: right ? q.answer : "qqqq", mode: "typed" };
  return { given: right ? q.target ?? q.answer : "zzzz", mode: "spoken" };
}

/** play a whole attempt; `rightShare` = the fraction of checkable questions answered correctly */
function play(s: LearningState, lessonId: string, rightShare: number, seed = 7): { state: LearningState; passed?: boolean; score?: number } {
  const st = startAttempt(s, lessonId, tick(), seed);
  if (!st.ok) throw new Error(st.reason);
  let state = st.state, n = 0;
  for (;;) {
    const a: ActiveAttempt = state.lessons[lessonId].active!;
    for (const q of a.activities[a.index].questions) {
      const right = q.kind === "repeat" || q.kind === "speak" ? true : (n++ % 10) < Math.round(rightShare * 10);
      const r = respond(q, right);
      const res = answerQuestion(state, lessonId, q.id, r.given, r.mode, tick());
      if (!res.ok) throw new Error(res.reason);
      state = res.state;
    }
    const adv = advance(state, lessonId, tick());
    if (!adv.ok) throw new Error(adv.reason);
    state = adv.state;
    if (adv.finished) return { state, passed: adv.finished.passed, score: adv.finished.attempt.score };
  }
}
const start = (lang: LangId = "fr") => ensureCourse(freshState(lang, tick()), tick());
/** pass every lesson before `lessonId` (a lesson opens only after the one before it is passed) */
function through(s: LearningState, lessonId: string): LearningState {
  for (const l of courseFor(s.settings.lang, s.settings.level).lessons) { if (l.id === lessonId) break; s = play(s, l.id, 1).state; }
  return s;
}

describe("content is complete and honest", () => {
  it("every language has a writing system and vocabulary, with every field a learner needs", () => {
    for (const lang of Object.keys(LANGUAGES) as LangId[]) {
      const ls = courseFor(lang, "beginner").lessons;
      expect(ls.some((l) => l.kind === "writing"), lang).toBe(true);
      expect(ls.some((l) => l.kind === "vocab"), lang).toBe(true);
      for (const l of ls) {
        expect(l.objective.length, l.id).toBeGreaterThan(10);
        for (const s of l.symbols ?? []) { expect(s.char && s.roman && s.guide, s.id).toBeTruthy(); }
        for (const v of l.vocab ?? []) {
          expect(v.text && v.meaning && v.guide && v.context && v.example.text && v.example.meaning, v.id).toBeTruthy();
        }
      }
    }
  });
  it("ids are unique, so progress for one item never touches another", () => {
    const ids = allLessons().flatMap((l) => [l.id, ...(l.symbols ?? []).map((s) => s.id), ...(l.vocab ?? []).map((v) => v.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("scripts are real: Hangul, kana and Han characters are used, never romanization alone", () => {
    expect(courseFor("ko", "beginner").lessons[0].symbols![0].char).toBe("ㅏ");
    expect(lessonById("ja-w1")!.symbols![0].char).toBe("あ");
    expect(lessonById("zh-v1")!.vocab![0].text).toBe("你好");
    expect(lessonById("zh-v1")!.vocab![0].roman).toBe("nǐ hǎo");
    expect(lessonById("fr-w3")!.symbols!.map((s) => s.char)).toContain("ç");
    expect(LANGUAGES.zh.tonal).toBe(true);
  });
  it("the full set of hiragana is present (46 basic characters) and Hangul has its 10 vowels and 14 consonants", () => {
    const hira = ["ja-w1", "ja-w2", "ja-w3", "ja-w4", "ja-w5"].flatMap((id) => lessonById(id)!.symbols!.map((s) => s.char));
    expect(new Set(hira).size).toBe(46);
    const kor = ["ko-w1", "ko-w2", "ko-w3"].flatMap((id) => lessonById(id)!.symbols!.map((s) => s.char));
    expect(kor.length).toBe(31 - 7); // 10 vowels + 14 consonants
    expect(lessonById("fr-w1")!.symbols!.length + lessonById("fr-w2")!.symbols!.length).toBe(26);
  });
  it("only authored levels are offered; the rest say so instead of pretending", () => {
    expect(levelsAvailable("fr")).toEqual(["beginner"]);
    expect(courseFor("fr", "advanced").lessons).toHaveLength(0);
  });
});

describe("answers are judged by the language, not by English habits", () => {
  it("accents and punctuation do not matter for Latin scripts; Hangul, kana and characters are compared as they are", () => {
    expect(matchesAny("Cafe", ["café"])).toBe(true);
    expect(matchesAny("s'il vous plait", ["s’il vous plaît"])).toBe(true);
    expect(matchesAny("nihao", ["nǐ hǎo"])).toBe(true);
    expect(matchesAny("你好!", ["你好"])).toBe(true);
    expect(matchesAny("안녕하세요", ["안녕하세요"])).toBe(true);
    expect(normalizeAnswer("か")).not.toBe(normalizeAnswer("が")); // a dakuten changes the kana: it is NOT folded away
    expect(matchesAny("が", ["か"])).toBe(false);
    expect(matchesAny("", ["a"])).toBe(false);
  });
  it("a spoken answer is only ever an ESTIMATE and never claims to be verified", () => {
    const e = estimateSpeech(["你好", "nǐ hǎo"], "你好", true);
    expect(e.verdict).toBe("match");
    expect(e.verified).toBe(false);
    expect(e.note).toMatch(/Tones cannot be checked/);
    expect(estimateSpeech(["bonjour"], "au revoir", false).verdict).toBe("different");
    expect(estimateSpeech(["bonjour"], "bonjou", false).verdict).toBe("match"); // an accent or a clipped end is not an error
    expect(similarity("abc", "")).toBe(0);
  });
});

describe("activities are generated from the lesson, deterministically", () => {
  it("a vocabulary lesson has recognition, listening, translation, fill-in, repeat and speaking activities", () => {
    const acts = buildActivities(lessonById("fr-v1")!, { difficulty: 2, seed: 1, speaking: true });
    expect(acts.map((a) => a.kind)).toEqual(["match", "choice", "audio-id", "translate", "fill-blank", "repeat", "speak"]);
    expect(acts.filter((a) => a.speaking).map((a) => a.kind)).toEqual(["repeat", "speak"]);
  });
  it("a writing lesson teaches recognition, sound and repetition, and never fills blanks in sentences", () => {
    const acts = buildActivities(lessonById("ko-w1")!, { difficulty: 2, seed: 1, speaking: true });
    expect(acts.map((a) => a.kind)).toEqual(["match", "choice", "audio-id", "translate", "repeat"]);
  });
  it("the same seed gives the same lesson; a different seed reorders it; difficulty changes how many choices there are", () => {
    const a = buildActivities(lessonById("fr-v1")!, { difficulty: 2, seed: 5 });
    const b = buildActivities(lessonById("fr-v1")!, { difficulty: 2, seed: 5 });
    const c = buildActivities(lessonById("fr-v1")!, { difficulty: 2, seed: 6 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    const easy = buildActivities(lessonById("fr-v1")!, { difficulty: 1, seed: 5 }).find((x) => x.kind === "choice")!.questions[0].options!.length;
    const hard = buildActivities(lessonById("fr-v1")!, { difficulty: 3, seed: 5 }).find((x) => x.kind === "choice")!.questions[0].options!.length;
    expect(easy).toBe(3);
    expect(hard).toBe(5);
  });
  it("every choice question contains its correct answer exactly once, and fill-in blanks really remove the word", () => {
    for (const lesson of allLessons()) {
      for (const act of buildActivities(lesson, { difficulty: 3, seed: 9 })) for (const q of act.questions) {
        if (q.options) expect(q.options.filter((o) => normalizeAnswer(o) === normalizeAnswer(q.answer)).length, `${lesson.id} ${q.id}`).toBe(1);
        if (q.kind === "fill-blank") { expect(q.prompt).toContain("____"); expect(q.prompt).not.toContain(q.answer); }
      }
    }
  });
  it("a revision builds only from the missed items (padded to three)", () => {
    const lesson = lessonById("fr-v2")!;
    const acts = buildActivities(lesson, { difficulty: 2, seed: 3, focus: ["fr-un"], speaking: false });
    const ids = new Set(acts.flatMap((a) => a.questions.map((q) => q.itemId)).filter((x) => x !== undefined));
    expect(ids.has("fr-un")).toBe(true);
    expect(ids.size).toBeLessThanOrEqual(3);
    expect(itemsOf(lesson)).toHaveLength(10);
  });
  it("evaluation: typed and chosen answers are exact; a match board counts its pairs", () => {
    const q = buildActivities(lessonById("fr-v1")!, { difficulty: 2, seed: 2 })[0].questions[0];
    expect(evaluate(q, JSON.stringify(Object.fromEntries(q.pairs!.map((p) => [p.id, p.right]))), "fr", "chosen")).toMatchObject({ correct: true });
    const bad = evaluate(q, JSON.stringify({}), "fr", "chosen");
    expect(bad.correct).toBe(false);
    expect(bad.part).toEqual({ right: 0, total: q.pairs!.length });
  });
  it("rng is deterministic", () => { expect(rng(1)()).toBe(rng(1)()); expect(rng(1)()).not.toBe(rng(2)()); });
});

describe("a complete learning journey", () => {
  it("activities unlock one after another and nothing counts just because it was opened", () => {
    let s = start();
    const st = startAttempt(s, "fr-w1", tick(), 1);
    if (!st.ok) throw new Error(st.reason);
    s = st.state;
    const a = s.lessons["fr-w1"].active!;
    // a question of a LATER activity is refused
    const later = a.activities[2].questions[0];
    expect(answerQuestion(s, "fr-w1", later.id, later.answer, "chosen", tick())).toMatchObject({ ok: false });
    // moving on without answering is refused
    expect(advance(s, "fr-w1", tick())).toMatchObject({ ok: false });
    // opening a lesson does not make it passed
    expect(s.lessons["fr-w1"].status).toBe("in_progress");
    expect(s.lessons["fr-w1"].attempts).toHaveLength(0);
    // an answer cannot be given twice
    const q0 = a.activities[0].questions[0];
    const r = respond(q0, true);
    const once = answerQuestion(s, "fr-w1", q0.id, r.given, r.mode, tick());
    if (!once.ok) throw new Error(once.reason);
    expect(answerQuestion(once.state, "fr-w1", q0.id, r.given, r.mode, tick())).toMatchObject({ ok: false });
    const typed = once.state.lessons["fr-w1"].active!.activities[0].questions;
    expect(typed.length).toBe(1); // the match board is one question
  });

  it("select a language, learn the alphabet and vocabulary, fail a test, revise, pass, and unlock the next lesson", () => {
    const sel = selectCourse(freshState("ko", tick()), "ko", "beginner", tick());
    if (!sel.ok) throw new Error(sel.reason);
    let s = sel.state;
    expect(s.settings.lang).toBe("ko");
    expect(s.lessons["ko-w1"].status).toBe("available");
    expect(s.lessons["ko-w2"].status).toBe("locked");
    expect(startAttempt(s, "ko-w2", tick(), 1)).toMatchObject({ ok: false }); // locked until ko-w1 is passed

    // FAIL: 30% right on the Hangul vowels
    const failed = play(s, "ko-w1", 0.3);
    expect(failed.passed).toBe(false);
    s = failed.state;
    expect(s.lessons["ko-w1"].status).toBe("revision_required");
    expect(s.lessons["ko-w1"].revisionItems.length).toBeGreaterThan(0);
    expect(s.lessons["ko-w2"].status).toBe("locked"); // failing does not unlock anything
    expect(recommendNext(s)).toMatchObject({ kind: "revision", lessonId: "ko-w1" });

    // the next attempt is a REVISION of the missed items, and it must be passed
    const rev = startAttempt(s, "ko-w1", tick(), 2);
    if (!rev.ok) throw new Error(rev.reason);
    expect(rev.attempt.kind).toBe("revision");
    s = abandonAttempt(rev.state, "ko-w1");
    const revFail = play(s, "ko-w1", 0.2, 3);
    expect(revFail.passed).toBe(false);
    expect(revFail.state.lessons["ko-w1"].status).toBe("revision_required");
    const revPass = play(revFail.state, "ko-w1", 1, 4);
    expect(revPass.passed).toBe(true);
    s = revPass.state;
    expect(s.lessons["ko-w1"].status).toBe("available"); // revision done: the lesson can be retaken
    expect(s.lessons["ko-w1"].revisionPassed).toBe(true);
    expect(s.lessons["ko-w2"].status).toBe("locked"); // still not passed

    // PASS the lesson itself: the next lesson opens
    const pass = play(s, "ko-w1", 1, 5);
    expect(pass.passed).toBe(true);
    s = pass.state;
    expect(s.lessons["ko-w1"].status).toBe("passed");
    expect(s.lessons["ko-w1"].attempts.map((a) => a.kind)).toEqual(["lesson", "revision", "revision", "lesson"]);
    expect(s.lessons["ko-w2"].status).toBe("available");
    expect(s.lessons["ko-w1"].bestScore).toBe(1);
  });

  it("revision can be switched off, and the pass mark is configurable", () => {
    let s = start();
    s = { ...s, settings: { ...s.settings, requireRevision: false } };
    const f = play(s, "fr-w1", 0.2);
    expect(f.state.lessons["fr-w1"].status).toBe("available");
    let strict = start();
    strict = { ...strict, settings: { ...strict.settings, passScore: 1 } };
    expect(play(strict, "fr-w1", 0.9).passed).toBe(false);
    expect(play(strict, "fr-w1", 1).passed).toBe(true);
  });

  it("speaking activities must be completed and are recorded as unverified estimates, but never decide the pass mark", () => {
    const s = through(start(), "fr-v1");
    const r = play(s, "fr-v1", 1);
    expect(r.passed).toBe(true);
    const rec = r.state.pronunciation;
    expect(rec.length).toBeGreaterThan(0);
    expect(rec.every((p) => p.verified === false)).toBe(true);
    // answering every speaking item badly does not fail a lesson whose checkable answers are all right
    const st = startAttempt(s, "fr-v1", tick(), 11);
    if (!st.ok) throw new Error(st.reason);
    let state = st.state;
    for (;;) {
      const a = state.lessons["fr-v1"].active!;
      for (const q of a.activities[a.index].questions) {
        const bad = q.kind === "repeat" || q.kind === "speak";
        const r2 = bad ? { given: "xxxxxxxx", mode: "spoken" as const } : respond(q, true);
        const res = answerQuestion(state, "fr-v1", q.id, r2.given, r2.mode, tick());
        if (!res.ok) throw new Error(res.reason);
        state = res.state;
      }
      const adv = advance(state, "fr-v1", tick());
      if (!adv.ok) throw new Error(adv.reason);
      state = adv.state;
      if (adv.finished) { expect(adv.finished.passed).toBe(true); break; }
    }
  });

  it("a learner can resume an unfinished lesson (session recovery), or start it over", () => {
    let s = start();
    const st = startAttempt(s, "fr-w1", tick(), 4);
    if (!st.ok) throw new Error(st.reason);
    s = st.state;
    const q = s.lessons["fr-w1"].active!.activities[0].questions[0];
    const r = respond(q, true);
    const a = answerQuestion(s, "fr-w1", q.id, r.given, r.mode, tick());
    if (!a.ok) throw new Error(a.reason);
    s = a.state;
    expect(resumeInfo(s)).toMatchObject({ lessonId: "fr-w1", activity: 1 });
    expect(recommendNext(s)).toMatchObject({ kind: "resume" });
    const again = startAttempt(s, "fr-w1", tick(), 99);
    if (!again.ok) throw new Error(again.reason);
    expect(again.resumed).toBe(true);
    expect(again.attempt.answers[q.id]).toBeTruthy(); // the earlier answer is still there
    expect(abandonAttempt(s, "fr-w1").lessons["fr-w1"].active).toBeUndefined();
  });

  it("difficulty follows real performance", () => {
    let s = start();
    expect(difficultyFor(s)).toBe(2);
    s = play(s, "fr-w1", 1).state;
    expect(difficultyFor(s)).toBe(3);
    const weak = play(start(), "fr-w1", 0.1).state;
    expect(difficultyFor(weak)).toBe(1);
  });
});

describe("levels, vocabulary and goals", () => {
  it("the next level opens only when every lesson of this one is passed and the interview (if required) is completed", () => {
    let s = start();
    expect(isLevelUnlocked(s, "fr", "intermediate")).toMatchObject({ unlocked: false });
    expect(selectCourse(s, "fr", "intermediate", tick())).toMatchObject({ ok: false });
    for (const l of courseFor("fr", "beginner").lessons) s = play(s, l.id, 1).state;
    expect(levelStatus(s, "fr", "beginner")).toMatchObject({ lessonsPassed: 5, lessonsTotal: 5, interviewDone: false, complete: false });
    expect(isLevelUnlocked(s, "fr", "intermediate")).toMatchObject({ unlocked: false });
    expect(interviewAvailable(s, "fr", "beginner")).toEqual({ ok: true });
    expect(recommendNext(s)).toMatchObject({ kind: "interview" });
    s = { ...s, interviews: [{ sessionId: "i1", lang: "fr", level: "beginner", scenarioId: "restaurant", userRole: "customer", aiRole: "waiter", startedAt: 1, status: "completed", userTurns: 6, countsAsCompleted: true }] };
    expect(levelStatus(s, "fr", "beginner").complete).toBe(true);
    expect(isLevelUnlocked(s, "fr", "intermediate")).toEqual({ unlocked: true });
    // content for the next level has not been written: the app says so rather than opening an empty course
    expect(selectCourse(s, "fr", "intermediate", tick())).toMatchObject({ ok: false });
    expect(interviewAvailable(start(), "fr", "beginner")).toMatchObject({ ok: false });
    // the requirement is configurable
    let relaxed = start();
    relaxed = { ...relaxed, settings: { ...relaxed.settings, interviewRequired: false } };
    for (const l of courseFor("fr", "beginner").lessons) relaxed = play(relaxed, l.id, 1).state;
    expect(levelStatus(relaxed, "fr", "beginner").complete).toBe(true);
  });

  it("vocabulary is 'learned' only after repeated correct answers, and a mistake sets it back", () => {
    let s = through(start(), "fr-v1");
    expect(vocabLearned(s)).toBe(0);
    s = play(s, "fr-v1", 1, 1).state;
    expect(vocabLearned(s)).toBe(0); // one pass is not mastery
    s = play(s, "fr-v1", 1, 2).state;
    s = play(s, "fr-v1", 1, 3).state;
    expect(vocabLearned(s)).toBeGreaterThanOrEqual(6);
    const before = s.vocab["fr-merci"].strength;
    s = play(s, "fr-v1", 0, 4).state;
    expect(s.vocab["fr-merci"].strength).toBeLessThan(before);
  });

  it("measurable goals show actual progress and are completed only when reached", () => {
    let s = start();
    s = addGoal(s, { kind: "lessons_count", lang: "fr", target: 2, label: "Complete 2 lessons" }, tick());
    s = addGoal(s, { kind: "pronunciation_practice", lang: "fr", target: 5, label: "Practise speaking 5 times" }, tick());
    s = addGoal(s, { kind: "writing_system", lang: "fr", target: 3, label: "Master the French writing system" }, tick());
    expect(s.goals.map((g) => goalProgress(g, s).current)).toEqual([0, 0, 0]);
    s = play(s, "fr-w1", 1).state;
    s = updateGoals(s, tick());
    expect(goalProgress(s.goals[0], s)).toEqual({ current: 1, target: 2, done: false });
    expect(s.goals[0].completedAt).toBeUndefined();
    s = play(s, "fr-w2", 1).state;
    s = updateGoals(s, tick());
    expect(goalProgress(s.goals[0], s).done).toBe(true);
    expect(s.goals[0].completedAt).toBeDefined();
    expect(goalProgress(s.goals[1], s).current).toBe(5); // capped at the target
    expect(goalProgress(s.goals[2], s)).toEqual({ current: 2, target: 3, done: false });
  });
});

describe("persistence and privacy", () => {
  it("progress survives a restart, and a new store reads exactly what was saved", () => {
    const kv = mem();
    let store = new LearningStore(kv, tick);
    const id = store.createProfile("Ana", "ko");
    store.update((s) => play(s, "ko-w1", 1).state);
    store.update((s) => addGoal(s, { kind: "lessons_count", lang: "ko", target: 3, label: "3 lessons" }, tick()));
    const saved = store.state()!;
    // "restart Momo": a brand-new store over the same storage
    store = new LearningStore(kv, tick);
    expect(store.activeId()).toBe(id);
    expect(store.state()).toEqual(saved);
    expect(store.state()!.lessons["ko-w1"].status).toBe("passed");
    expect(store.state()!.lessons["ko-w2"].status).toBe("available");
    expect(store.state()!.settings.lang).toBe("ko");
  });
  it("an unfinished lesson is still open after a restart", () => {
    const kv = mem();
    let store = new LearningStore(kv, tick);
    store.createProfile("Ana", "fr");
    store.update((s) => { const r = startAttempt(s, "fr-w1", tick(), 3); if (!r.ok) throw new Error(r.reason); return r.state; });
    store = new LearningStore(kv, tick);
    expect(resumeInfo(store.state()!)).toMatchObject({ lessonId: "fr-w1" });
  });
  it("learners are isolated: one profile never sees or changes another's progress", () => {
    const kv = mem();
    const store = new LearningStore(kv, tick);
    const a = store.createProfile("Ana", "fr");
    store.update((s) => play(s, "fr-w1", 1).state);
    const b = store.createProfile("Ben", "ko");
    expect(store.state()!.lessons["fr-w1"]).toBeUndefined();
    expect(store.state()!.settings.lang).toBe("ko");
    store.update((s) => play(s, "ko-w1", 1).state);
    store.switchProfile(a);
    expect(store.state()!.lessons["fr-w1"].status).toBe("passed");
    expect(store.state()!.lessons["ko-w1"]).toBeUndefined();
    expect(store.profiles().map((p) => p.name).sort()).toEqual(["Ana", "Ben"]);
    store.deleteProfile(a);
    expect(store.activeId()).toBe(b);
    expect(store.state()!.lessons["ko-w1"].status).toBe("passed");
  });
  it("damaged data is survived: a bad profile is dropped, the others are kept, and nothing throws", () => {
    const kv = mem();
    const store = new LearningStore(kv, tick);
    const a = store.createProfile("Ana", "fr");
    const raw = JSON.parse(kv.getItem(LEARNING_KEY)!);
    raw.profiles.broken = { name: "x", created: 1, state: { version: 7 } };
    kv.setItem(LEARNING_KEY, JSON.stringify(raw));
    const again = new LearningStore(kv, tick);
    expect(again.profiles().map((p) => p.id)).toEqual([a]);
    kv.setItem(LEARNING_KEY, "{not json");
    expect(new LearningStore(kv, tick).state()).toBeNull();
  });
  it("stores no audio and no recordings: pronunciation history holds only short text and an unverified estimate", () => {
    const kv = mem();
    const store = new LearningStore(kv, tick);
    store.createProfile("Ana", "fr");
    store.update((s) => play(through(s, "fr-v1"), "fr-v1", 1).state);
    const text = kv.getItem(LEARNING_KEY)!;
    expect(text).not.toMatch(/audio|samples|wav|blob/i);
    for (const p of store.state()!.pronunciation) { expect(p.verified).toBe(false); expect(p.heard.length).toBeLessThan(120); }
  });
});
