import { buildActivities, evaluate, isCheckable, type Evaluation } from "./activities";
import { courseFor, LEVELS, levelsAvailable, type LangId, type Lesson, type Level } from "./content";
import type { ActiveAttempt, AnswerRecord, Attempt, LearningState, LessonProgress, Question } from "./state";
import { LessonProgressSchema } from "./state";

/**
 * How a learner moves through a course. Pure functions: each takes the state and returns a new one, so every rule is testable
 * and nothing happens just because a screen was opened. A lesson passes only through answered, evaluated activities; a failed
 * lesson requires a passed revision before it can be retaken; the next lesson (and the next level) open only when the
 * configured requirements are met.
 */
export const lessonsOf = (lang: LangId, level: Level): Lesson[] => courseFor(lang, level).lessons;
const key = (lang: LangId, level: Level) => `${lang}:${level}`;
const prog = (s: LearningState, id: string): LessonProgress => s.lessons[id] ?? LessonProgressSchema.parse({});

export function currentLessons(s: LearningState): Lesson[] {
  return lessonsOf(s.settings.lang, s.settings.level);
}

/** Make sure the course's lessons have a status: the first is open, later ones open when the one before is passed. */
export function ensureCourse(s: LearningState, now: number): LearningState {
  const lessons = currentLessons(s);
  const out: LearningState = { ...s, lessons: { ...s.lessons }, courses: { ...s.courses } };
  const k = key(s.settings.lang, s.settings.level);
  if (!out.courses[k] && lessons.length) out.courses[k] = { startedAt: now };
  lessons.forEach((l, i) => {
    const p = prog(out, l.id);
    const prevPassed = i === 0 || prog(out, lessons[i - 1].id).status === "passed";
    out.lessons[l.id] = p.status === "locked" && prevPassed ? { ...p, status: "available" } : p;
  });
  return out;
}

export function selectCourse(s: LearningState, lang: LangId, level: Level, now: number): { ok: true; state: LearningState } | { ok: false; reason: string } {
  if (!levelsAvailable(lang).includes(level)) return { ok: false, reason: `The ${level} course for this language has not been written yet.` };
  const u = isLevelUnlocked(s, lang, level);
  if (!u.unlocked) return { ok: false, reason: u.reason };
  return { ok: true, state: ensureCourse({ ...s, settings: { ...s.settings, lang, level } }, now) };
}

/** 1 easy .. 3 hard, from how the learner has actually been doing (their last three finished attempts) */
export function difficultyFor(s: LearningState): 1 | 2 | 3 {
  const done: Attempt[] = Object.values(s.lessons).flatMap((p) => p.attempts).filter((a) => a.score !== undefined).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, 3);
  if (!done.length) return 2;
  const avg = done.reduce((n, a) => n + (a.score ?? 0), 0) / done.length;
  return avg >= 0.9 ? 3 : avg < 0.6 ? 1 : 2;
}

export type StartResult = { ok: true; state: LearningState; attempt: ActiveAttempt; resumed: boolean } | { ok: false; reason: string };

export function startAttempt(s: LearningState, lessonId: string, now: number, seed: number): StartResult {
  const lesson = currentLessons(s).find((l) => l.id === lessonId);
  if (!lesson) return { ok: false, reason: "That lesson is not in the current course." };
  const p = prog(s, lessonId);
  if (p.status === "locked") return { ok: false, reason: "This lesson is locked. Pass the lesson before it first." };
  if (p.active) return { ok: true, state: s, attempt: p.active, resumed: true }; // session recovery: pick up where you were
  const revision = p.status === "revision_required" && s.settings.requireRevision && !p.revisionPassed;
  const difficulty = difficultyFor(s);
  const activities = buildActivities(lesson, { difficulty, seed, focus: revision ? p.revisionItems : undefined, speaking: true });
  const attempt: ActiveAttempt = { id: `${lessonId}#${p.attempts.length + 1}-${seed}`, kind: revision ? "revision" : "lesson", startedAt: now, difficulty, seed, activities, index: 0, answers: {}, focus: revision ? p.revisionItems : undefined };
  const status = p.status === "passed" || revision ? p.status : "in_progress";
  return { ok: true, resumed: false, attempt, state: { ...s, last: { lessonId, at: now }, lessons: { ...s.lessons, [lessonId]: { ...p, status, active: attempt } } } };
}

export type AnswerResult = { ok: true; state: LearningState; evaluation: Evaluation; activityComplete: boolean } | { ok: false; reason: string };

const WRONG = -0.3, RIGHT = 0.25;
function bump(s: LearningState, itemId: string, correct: boolean, now: number): LearningState {
  const v = s.vocab[itemId] ?? { seen: 0, correct: 0, wrong: 0, strength: 0, lastSeen: 0, recent: [] };
  const strength = Math.min(1, Math.max(0, v.strength + (correct ? RIGHT : WRONG)));
  return { ...s, vocab: { ...s.vocab, [itemId]: { seen: v.seen + 1, correct: v.correct + (correct ? 1 : 0), wrong: v.wrong + (correct ? 0 : 1), strength, lastSeen: now, recent: [...(v.recent ?? []), correct].slice(-12) } } };
}

export function answerQuestion(s: LearningState, lessonId: string, questionId: string, given: string, mode: AnswerRecord["mode"], now: number): AnswerResult {
  const p = prog(s, lessonId);
  const a = p.active;
  if (!a) return { ok: false, reason: "No attempt is open for this lesson." };
  const act = a.activities[a.index];
  const qn: Question | undefined = act?.questions.find((q) => q.id === questionId);
  // later activities are locked: only a question of the CURRENT activity can be answered
  if (!qn) return { ok: false, reason: "That question is not available yet: finish the current activity first." };
  if (a.answers[questionId]) return { ok: false, reason: "That question was already answered." };
  if (!given.trim() && qn.kind !== "match") return { ok: false, reason: "Give an answer first." };
  const lang = s.settings.lang;
  const ev = evaluate(qn, given, lang, mode);
  const rec: AnswerRecord = { questionId, itemId: qn.itemId, given, correct: ev.correct, mode, at: now, ...(ev.estimate ? { estimate: ev.estimate } : {}), ...(ev.part ? { part: ev.part } : {}), ...(ev.wrongPairs ? { wrongPairs: ev.wrongPairs } : {}) };
  // mastery is updated once per finished attempt (see finish), not per answer: one lucky pass must not make a word "learned"
  let next: LearningState = { ...s, last: { lessonId, at: now } };
  if (ev.estimate) {
    next = { ...next, pronunciation: [...next.pronunciation, { at: now, lang, itemId: qn.itemId, expected: qn.target ?? qn.answer, heard: given.slice(0, 200), score: ev.estimate.score, verdict: ev.estimate.verdict, verified: false as const }].slice(-500) };
  }
  const active: ActiveAttempt = { ...a, answers: { ...a.answers, [questionId]: rec } };
  next = { ...next, lessons: { ...next.lessons, [lessonId]: { ...prog(next, lessonId), active } } };
  const activityComplete = act.questions.every((q) => active.answers[q.id]);
  return { ok: true, state: next, evaluation: ev, activityComplete };
}

export type AdvanceResult = { ok: true; state: LearningState; finished?: { attempt: Attempt; passed: boolean } } | { ok: false; reason: string };

/** Move to the next activity once the current one is completely answered; after the last one the attempt is scored. */
export function advance(s: LearningState, lessonId: string, now: number): AdvanceResult {
  const p = prog(s, lessonId);
  const a = p.active;
  if (!a) return { ok: false, reason: "No attempt is open for this lesson." };
  const act = a.activities[a.index];
  if (!act.questions.every((q) => a.answers[q.id])) return { ok: false, reason: "Finish every question of this activity first." };
  if (a.index + 1 < a.activities.length) {
    return { ok: true, state: { ...s, lessons: { ...s.lessons, [lessonId]: { ...p, active: { ...a, index: a.index + 1 } } } } };
  }
  return finish(s, lessonId, now);
}

function finish(s: LearningState, lessonId: string, now: number): AdvanceResult {
  const p = prog(s, lessonId);
  const a = p.active!;
  let right = 0, total = 0, spokenN = 0, typedN = 0;
  const missed = new Set<string>();
  const perItem = new Map<string, boolean>(); // an item counts as right for this attempt only if EVERY question about it was right
  const mark = (id: string, ok: boolean) => perItem.set(id, (perItem.get(id) ?? true) && ok);
  for (const act of a.activities) for (const q of act.questions) {
    if (!isCheckable(q.kind)) {
      const sp = a.answers[q.id];
      if (sp?.mode === "spoken") spokenN++; else if (sp?.mode === "typed-instead-of-speaking") typedN++;
      continue;
    }
    const r = a.answers[q.id];
    if (q.kind === "match") {
      const t = r?.part?.total ?? q.pairs?.length ?? 0;
      total += t; right += r?.part?.right ?? 0;
      for (const pr of q.pairs ?? []) mark(pr.id, !(r?.wrongPairs ?? []).includes(pr.id) && !!r);
      for (const id of r?.wrongPairs ?? []) missed.add(id);
    } else {
      total += 1;
      mark(q.itemId, !!r?.correct);
      if (r?.correct) right += 1; else missed.add(q.itemId);
    }
  }
  const score = total ? right / total : 0;
  const passed = score >= s.settings.passScore;
  const attempt: Attempt = { id: a.id, kind: a.kind, startedAt: a.startedAt, finishedAt: now, score, correct: right, total, missed: [...missed], passed, difficulty: a.difficulty, speaking: { spoken: spokenN, typed: typedN } };
  let np: LessonProgress = { ...p, active: undefined, attempts: [...p.attempts, attempt], bestScore: a.kind === "lesson" ? Math.max(p.bestScore, score) : p.bestScore };
  if (a.kind === "lesson") {
    if (passed) np = { ...np, status: "passed", passedAt: now, revisionItems: [], revisionPassed: false };
    else np = p.status === "passed" ? np : { ...np, status: s.settings.requireRevision ? "revision_required" : "available", revisionItems: [...missed], revisionPassed: false };
  } else if (passed) np = { ...np, status: "available", revisionPassed: true, revisionItems: [] };
  else np = { ...np, revisionItems: [...missed] };
  let out: LearningState = { ...s, lessons: { ...s.lessons, [lessonId]: np } };
  for (const [id, ok] of perItem) out = bump(out, id, ok, now);
  if (np.status === "passed") out = ensureCourse(out, now); // opens the next lesson
  return { ok: true, state: out, finished: { attempt, passed } };
}

/** Throw away an open attempt (the learner chose to start over). Nothing from it counts. */
export function abandonAttempt(s: LearningState, lessonId: string): LearningState {
  const p = prog(s, lessonId);
  if (!p.active) return s;
  const status = p.status === "in_progress" ? (p.attempts.length ? "available" : "available") : p.status;
  return { ...s, lessons: { ...s.lessons, [lessonId]: { ...p, active: undefined, status } } };
}

/** Where the learner is within an open attempt, for "resume". */
export function resumeInfo(s: LearningState): { lessonId: string; title: string; activity: number; of: number; kind: "lesson" | "revision" } | null {
  for (const l of currentLessons(s)) {
    const a = prog(s, l.id).active;
    if (a) return { lessonId: l.id, title: l.title, activity: a.index + 1, of: a.activities.length, kind: a.kind };
  }
  return null;
}

export interface LevelStatus {
  lessonsPassed: number; lessonsTotal: number;
  /** the interview stage: required by the settings, and whether it was completed for this level */
  interviewRequired: boolean; interviewDone: boolean;
  /** all lessons passed and (if required) the interview completed */
  complete: boolean;
  hasContent: boolean;
}
export function levelStatus(s: LearningState, lang: LangId, level: Level): LevelStatus {
  const lessons = lessonsOf(lang, level);
  const passed = lessons.filter((l) => prog(s, l.id).status === "passed").length;
  const interviewDone = s.interviews.some((i) => i.lang === lang && i.level === level && i.countsAsCompleted);
  const lessonsDone = lessons.length > 0 && passed === lessons.length;
  return { lessonsPassed: passed, lessonsTotal: lessons.length, interviewRequired: s.settings.interviewRequired, interviewDone, complete: lessonsDone && (!s.settings.interviewRequired || interviewDone), hasContent: lessons.length > 0 };
}

export function isLevelUnlocked(s: LearningState, lang: LangId, level: Level): { unlocked: true } | { unlocked: false; reason: string } {
  const i = LEVELS.indexOf(level);
  if (i <= 0) return { unlocked: true };
  const prev = LEVELS[i - 1];
  const st = levelStatus(s, lang, prev);
  if (st.complete) return { unlocked: true };
  const need = st.lessonsPassed < st.lessonsTotal ? `pass all ${st.lessonsTotal} ${prev} lessons (${st.lessonsPassed} done)` : "complete the final interview of the " + prev + " level";
  return { unlocked: false, reason: `To open the ${level} level, ${need}.` };
}

/** a final-assessment interview becomes available once every lesson of the level is passed */
export function interviewAvailable(s: LearningState, lang: LangId, level: Level): { ok: true } | { ok: false; reason: string } {
  const st = levelStatus(s, lang, level);
  if (!st.hasContent) return { ok: false, reason: `There is no ${level} course for this language yet.` };
  if (st.lessonsPassed < st.lessonsTotal) return { ok: false, reason: `Pass all ${st.lessonsTotal} lessons of the ${level} level first (${st.lessonsPassed} passed).` };
  return { ok: true };
}
