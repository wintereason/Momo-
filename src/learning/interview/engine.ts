import { allLessons, LANGUAGES, type LangId } from "../content";
import { interviewAvailable, levelStatus } from "../progress";
import type { InterviewRecord, LearningState } from "../state";
import { foldLatin, normalizeAnswer } from "../text";
import { INTERVIEW_CONTRACT, INTERVIEW_CONTRACT_VERSION, type InterviewSessionV1, type Turn } from "./contract";
import { customScenario, oppositeRole, scenarioById, type CustomScenarioInput, type Scenario } from "./scenarios";

/**
 * The interview EXECUTION engine: it starts a session, records every turn, survives interruptions and restarts, and marks completion.
 * It produces the contract data (contract.ts) and nothing else: no scores, no mistake analysis, no report. Pure functions over the
 * learner's saved state, so every rule is testable and a half-finished interview is simply a saved session.
 */
const MAX_SESSIONS = 20;

export interface AiReply {
  reply: string;
  translation?: string;
  romanization?: string;
  objective?: string;
  kind?: "question" | "follow-up" | "reaction" | "closing";
  /** the AI says the conversation has reached a natural end */
  end?: boolean;
}

export interface StartInput { scenarioId: string; userRoleId: string; custom?: CustomScenarioInput }
export type StartResult = { ok: true; state: LearningState; session: InterviewSessionV1 } | { ok: false; reason: string };

const letters = (s: string) => [...s].filter((c) => /\p{L}/u.test(c));
const SCRIPT: Partial<Record<LangId, RegExp>> = {
  ko: /\p{Script=Hangul}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  zh: /\p{Script=Han}/u,
};

/** Language-specific FACTS about one learner turn (never a judgement). */
export function evidenceFor(text: string, lang: LangId): NonNullable<Turn["evidence"]> {
  const t = text.trim();
  const ls = letters(t);
  const re = SCRIPT[lang];
  const scriptRatio = re && ls.length ? ls.filter((c) => re.test(c)).length / ls.length : re ? 0 : null;
  const spaced = lang === "fr";
  const units = spaced ? t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length : ls.length;
  const norm = normalizeAnswer(t);
  // apostrophes (straight or curly) separate words: "s’il" is "s" + "il"
  const toWords = (x: string) => foldLatin(x.toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = spaced ? toWords(t) : [];
  const used = allLessons().filter((l) => l.lang === lang && l.kind === "vocab").flatMap((l) => l.vocab ?? []).filter((v) => {
    const vn = normalizeAnswer(v.text);
    if (!vn) return false;
    if (!spaced) return norm.includes(vn);
    const vw = toWords(v.text);
    return vw.length === 1 ? words.includes(vw[0]) : ` ${words.join(" ")} `.includes(` ${vw.join(" ")} `);
  }).map((v) => v.id);
  return { scriptRatio, units, usedVocabIds: [...new Set(used)], empty: units === 0 };
}

function record(session: InterviewSessionV1, level: InterviewRecord["level"]): InterviewRecord {
  return {
    sessionId: session.sessionId, lang: session.language.code, level, scenarioId: session.scenario.id, userRole: session.scenario.userRole, aiRole: session.scenario.aiRole,
    startedAt: session.createdAt, endedAt: session.endedAt, status: session.status, userTurns: session.completion.userTurns, countsAsCompleted: session.completion.countsAsCompleted,
  };
}

/** write a session (and its summary record) into the learner's state, keeping only the most recent sessions */
export function saveSession(s: LearningState, session: InterviewSessionV1): LearningState {
  const sessions = { ...s.sessions, [session.sessionId]: session };
  const ids = Object.keys(sessions).sort((a, b) => sessions[a].createdAt - sessions[b].createdAt);
  while (ids.length > MAX_SESSIONS) { const old = ids.shift()!; if (sessions[old].status !== "in_progress") delete sessions[old]; else break; }
  const rec = record(session, session.course.level);
  const interviews = [...s.interviews.filter((i) => i.sessionId !== session.sessionId), rec];
  return { ...s, sessions, interviews };
}

export function startInterview(s: LearningState, input: StartInput, now: number, profileId: string | null, sessionId: string): StartResult {
  const { lang, level } = s.settings;
  const avail = interviewAvailable(s, lang, level);
  if (!avail.ok) return avail;
  let scenario: Scenario | undefined, userRole: string, aiRole: string, custom = false;
  if (input.scenarioId === "custom") {
    const c = customScenario(input.custom ?? { setting: "", userRole: "", aiRole: "" });
    if (!c.ok) return c;
    scenario = c.scenario; userRole = c.userRole.label; aiRole = c.aiRole.label; custom = true;
  } else {
    scenario = scenarioById(input.scenarioId);
    if (!scenario) return { ok: false, reason: "That scenario does not exist." };
    const mine = scenario.roles.find((r) => r.id === input.userRoleId);
    const other = oppositeRole(scenario, input.userRoleId);
    if (!mine || !other) return { ok: false, reason: "Choose which role you will play." };
    userRole = mine.label; aiRole = other.label;
  }
  const info = LANGUAGES[lang];
  const st = levelStatus(s, lang, level);
  const session: InterviewSessionV1 = {
    contract: INTERVIEW_CONTRACT, version: INTERVIEW_CONTRACT_VERSION, sessionId, profileId, status: "in_progress", createdAt: now,
    language: { code: lang, name: info.name, script: info.script, tonal: info.tonal },
    course: { level, lessonsPassed: st.lessonsPassed, lessonsTotal: st.lessonsTotal, passScore: s.settings.passScore, difficulty: level },
    scenario: { id: scenario.id, title: scenario.title, setting: scenario.setting, userRole, aiRole, custom },
    objectives: scenario.objectives, questions: [], turns: [], events: [{ at: now, type: "started" }],
    completion: { countsAsCompleted: false, userTurns: 0, minTurns: s.settings.interviewMinTurns, reason: "The interview is in progress." },
    speech: { spokenTurns: 0, pronunciationAssessed: false },
  };
  return { ok: true, session, state: saveSession(s, session) };
}

const nextIndex = (x: InterviewSessionV1) => x.turns.length;
const userTurnCount = (x: InterviewSessionV1) => x.turns.filter((t) => t.speaker === "user" && !t.evidence?.empty).length;

function withCompletion(x: InterviewSessionV1): InterviewSessionV1 {
  const n = userTurnCount(x);
  const spoken = x.turns.filter((t) => t.speaker === "user" && t.input?.mode === "spoken").length;
  const ok = n >= x.completion.minTurns;
  return { ...x, completion: { ...x.completion, userTurns: n, countsAsCompleted: x.status === "completed" ? ok : false }, speech: { ...x.speech, spokenTurns: spoken } };
}

export interface UserInput { mode: "typed" | "spoken"; transcript?: string; engine?: string; durationMs?: number }

/** The learner says or writes something. Empty answers are refused (they would not be a turn). */
export function addUserTurn(x: InterviewSessionV1, text: string, input: UserInput, now: number): { ok: true; session: InterviewSessionV1 } | { ok: false; reason: string } {
  if (x.status !== "in_progress") return { ok: false, reason: "This interview is over." };
  const t = text.replace(/\s+/g, " ").trim().slice(0, 1200);
  if (!t) return { ok: false, reason: "Say or write something first." };
  const turn: Turn = {
    index: nextIndex(x), speaker: "user", role: x.scenario.userRole, text: t, at: now,
    input: { mode: input.mode, transcript: input.mode === "spoken" ? input.transcript ?? t : undefined, engine: input.engine, durationMs: input.durationMs, audioRef: null },
    evidence: evidenceFor(t, x.language.code),
  };
  return { ok: true, session: withCompletion({ ...x, turns: [...x.turns, turn] }) };
}

export function addAiTurn(x: InterviewSessionV1, r: AiReply, now: number): InterviewSessionV1 {
  const text = r.reply.replace(/\s+/g, " ").trim().slice(0, 1200);
  const idx = nextIndex(x);
  const turn: Turn = { index: idx, speaker: "ai", role: x.scenario.aiRole, text, at: now, translation: r.translation, romanization: r.romanization, objective: r.objective, kind: r.kind };
  const questions = r.kind === "question" || r.kind === "follow-up" || /[?？]\s*$/.test(text) ? [...x.questions, { turn: idx, text, objective: r.objective }] : x.questions;
  return withCompletion({ ...x, turns: [...x.turns, turn], questions });
}

export function addEvent(x: InterviewSessionV1, type: InterviewSessionV1["events"][number]["type"], now: number, detail?: string): InterviewSessionV1 {
  return { ...x, events: [...x.events, { at: now, type, ...(detail ? { detail } : {}) }] };
}

/** End the interview. It counts toward the level only if the learner said enough (a configurable number of real answers). */
export function completeSession(s: LearningState, sessionId: string, now: number): { ok: true; state: LearningState; session: InterviewSessionV1 } | { ok: false; reason: string } {
  const x = s.sessions[sessionId];
  if (!x) return { ok: false, reason: "That interview was not found." };
  if (x.status !== "in_progress") return { ok: false, reason: "That interview is already over." };
  const n = userTurnCount(x);
  const enough = n >= x.completion.minTurns;
  const done = withCompletion(addEvent({ ...x, status: "completed", endedAt: now }, "completed", now));
  const session: InterviewSessionV1 = { ...done, completion: { ...done.completion, countsAsCompleted: enough, userTurns: n, reason: enough ? `The learner answered ${n} times, enough to count as completed.` : `The learner answered ${n} time${n === 1 ? "" : "s"}; ${x.completion.minTurns} are needed for it to count as completed.` } };
  return { ok: true, session, state: saveSession(s, session) };
}

export function abandonSession(s: LearningState, sessionId: string, now: number): LearningState {
  const x = s.sessions[sessionId];
  if (!x || x.status !== "in_progress") return s;
  return saveSession(s, withCompletion(addEvent({ ...x, status: "abandoned", endedAt: now }, "abandoned", now)));
}

/** the unfinished interview of this learner and language, if there is one (session recovery) */
export function openSession(s: LearningState): InterviewSessionV1 | null {
  const open = Object.values(s.sessions).filter((x) => x.status === "in_progress" && x.language.code === s.settings.lang).sort((a, b) => b.createdAt - a.createdAt);
  return open[0] ?? null;
}

/** the conversation as the AI sees it: the learner's words are data inside <learner> tags, the AI's own lines are its previous replies */
export function historyFor(x: InterviewSessionV1): { role: "user" | "assistant"; text: string }[] {
  const out: { role: "user" | "assistant"; text: string }[] = [{ role: "user", text: "(The conversation begins now. Say your opening line in your role.)" }];
  for (const t of x.turns) out.push(t.speaker === "ai" ? { role: "assistant", text: t.text } : { role: "user", text: `<learner>${t.text}</learner>` });
  return out;
}
