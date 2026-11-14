import { allLessons, LANGUAGES, LEVELS, levelsAvailable, type LangId, type Level } from "./content";
import { interviewAvailable, isLevelUnlocked, levelStatus, resumeInfo, currentLessons } from "./progress";
import type { Goal, LearningState } from "./state";

/**
 * MASTERY. A word is learned only on evidence from several FINISHED attempts: right in at least `masteryNeeded` of the last
 * `masteryWindow` attempts that tested it, AND right in the most recent one. Several questions about the same word inside one attempt
 * count once, so one lucky (or perfect) pass never establishes mastery, and a later mistake takes it back until it is right again.
 */
export function isLearned(v: { recent?: boolean[] } | undefined, settings: { masteryNeeded: number; masteryWindow: number }): boolean {
  const w = Math.max(settings.masteryWindow, settings.masteryNeeded);
  const last = (v?.recent ?? []).slice(-w);
  return last.length > 0 && last[last.length - 1] === true && last.filter(Boolean).length >= settings.masteryNeeded;
}

export function vocabItemIds(lang: LangId): string[] {
  return allLessons().filter((l) => l.lang === lang && l.kind === "vocab").flatMap((l) => (l.vocab ?? []).map((v) => v.id));
}
export function vocabLearned(s: LearningState, lang: LangId = s.settings.lang): number {
  return vocabItemIds(lang).filter((id) => isLearned(s.vocab[id], s.settings)).length;
}
const writingLessons = (lang: LangId) => allLessons().filter((l) => l.lang === lang && l.kind === "writing");

export interface GoalProgress { current: number; target: number; done: boolean }

export function goalProgress(g: Goal, s: LearningState): GoalProgress {
  let current = 0;
  switch (g.kind) {
    case "vocab_count": current = vocabLearned(s, g.lang); break;
    case "writing_system": current = writingLessons(g.lang).filter((l) => s.lessons[l.id]?.status === "passed").length; break;
    case "lessons_count": current = allLessons().filter((l) => l.lang === g.lang && s.lessons[l.id]?.status === "passed").length; break;
    case "level_pass": current = g.level && levelStatus(s, g.lang, g.level).complete ? 1 : 0; break;
    case "interview_complete": current = s.interviews.filter((i) => i.lang === g.lang && i.countsAsCompleted).length; break;
    case "pronunciation_practice": current = s.pronunciation.filter((p) => p.lang === g.lang).length; break;
  }
  return { current: Math.min(current, g.target), target: g.target, done: current >= g.target };
}

/** What a measurable goal's target defaults to, so the learner does not have to know the numbers */
export function defaultTarget(kind: Goal["kind"], lang: LangId): number {
  switch (kind) {
    case "vocab_count": return Math.max(1, vocabItemIds(lang).length);
    case "writing_system": return Math.max(1, writingLessons(lang).length);
    case "lessons_count": return Math.max(1, allLessons().filter((l) => l.lang === lang).length);
    case "level_pass": case "interview_complete": return 1;
    case "pronunciation_practice": return 20;
  }
}

export function addGoal(s: LearningState, g: Omit<Goal, "id" | "createdAt">, now: number): LearningState {
  const goal: Goal = { ...g, id: `g${now.toString(36)}${s.goals.length}`, createdAt: now };
  return { ...s, goals: [...s.goals, goal] };
}
export function removeGoal(s: LearningState, id: string): LearningState { return { ...s, goals: s.goals.filter((g) => g.id !== id) }; }
/** stamp goals that have been reached (once) */
export function updateGoals(s: LearningState, now: number): LearningState {
  let changed = false;
  const goals = s.goals.map((g) => { if (!g.completedAt && goalProgress(g, s).done) { changed = true; return { ...g, completedAt: now }; } return g; });
  return changed ? { ...s, goals } : s;
}

/** the learner's progress in a sentence or two, for the orchestrator's read-only tool. No name, no answers, no recordings. */
export function summaryText(s: LearningState): string {
  const { lang, level } = s.settings;
  const st = levelStatus(s, lang, level);
  const next = recommendNext(s);
  const goals = s.goals.filter((g) => !g.completedAt).length;
  const interview = st.interviewRequired ? `; final interview ${st.interviewDone ? "completed" : "not yet completed"}` : "";
  return `Learning ${LANGUAGES[lang].name} (${level} level): ${st.lessonsPassed} of ${st.lessonsTotal} lessons passed${interview}; ${vocabLearned(s)} vocabulary words learned${goals ? `; ${goals} open goal${goals === 1 ? "" : "s"}` : ""}. Next: ${next.text}`;
}

export type Next =
  | { kind: "resume"; lessonId: string; text: string }
  | { kind: "revision"; lessonId: string; text: string }
  | { kind: "lesson"; lessonId: string; text: string }
  | { kind: "interview"; text: string }
  | { kind: "next-level"; level: Level; text: string }
  | { kind: "done"; text: string };

/** The next appropriate activity, from where the learner actually is. */
export function recommendNext(s: LearningState): Next {
  const r = resumeInfo(s);
  if (r) return { kind: "resume", lessonId: r.lessonId, text: `Resume “${r.title}” at activity ${r.activity} of ${r.of}${r.kind === "revision" ? " (revision)" : ""}.` };
  const lessons = currentLessons(s);
  const rev = lessons.find((l) => s.lessons[l.id]?.status === "revision_required");
  if (rev) return { kind: "revision", lessonId: rev.id, text: `Revise the items you missed in “${rev.title}”, then retake it.` };
  const open = lessons.find((l) => { const st = s.lessons[l.id]?.status; return st === "available" || st === "in_progress"; });
  if (open) return { kind: "lesson", lessonId: open.id, text: `Start “${open.title}”: ${open.objective}` };
  const { lang, level } = s.settings;
  const st = levelStatus(s, lang, level);
  if (!st.hasContent) return { kind: "done", text: "This level has no lessons yet." };
  if (st.interviewRequired && !st.interviewDone && interviewAvailable(s, lang, level).ok) return { kind: "interview", text: `Take the final interview of the ${level} level.` };
  const nextLevel = LEVELS[LEVELS.indexOf(level) + 1];
  if (nextLevel && st.complete && isLevelUnlocked(s, lang, nextLevel).unlocked) {
    return levelsAvailable(lang).includes(nextLevel) ? { kind: "next-level", level: nextLevel, text: `The ${nextLevel} level is open.` } : { kind: "done", text: `You finished the ${level} level. The ${nextLevel} lessons have not been written yet.` };
  }
  return { kind: "done", text: st.complete ? `You finished the ${level} level.` : "Nothing is waiting right now." };
}
