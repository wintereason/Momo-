import { z } from "zod";
import { InterviewSessionSchema } from "./interview/contract";
import { LangIdSchema, LevelSchema } from "./schemas";

export { LangIdSchema, LevelSchema };

/**
 * Everything the Language Teacher remembers about one learner. One learner = one profile; profiles never see each other's data.
 * Nothing in here is a recording: no audio, no raw transcripts of the user's microphone beyond the short text the speech engine
 * produced for a practice item.
 */

export const QuestionSchema = z.object({
  id: z.string(),
  kind: z.enum(["choice", "audio-id", "match", "translate", "fill-blank", "repeat", "speak"]),
  /** the vocabulary item or symbol the question tests */
  itemId: z.string(),
  prompt: z.string(),
  /** a second line under the prompt (romanization, a translation hint) */
  sub: z.string().optional(),
  /** text to be spoken aloud in the target language (audio questions, listen-and-repeat) */
  say: z.string().optional(),
  options: z.array(z.string()).optional(),
  /** the answer shown to the user after they answer */
  answer: z.string(),
  /** every typed answer that counts as right (already normalised by the evaluator) */
  accept: z.array(z.string()),
  /** match questions: the pairs to connect */
  pairs: z.array(z.object({ id: z.string(), left: z.string(), right: z.string() })).optional(),
  /** the text to say, for speaking questions (compared with what the speech engine heard) */
  target: z.string().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const ActivitySchema = z.object({
  id: z.string(),
  kind: z.enum(["choice", "audio-id", "match", "translate", "fill-blank", "repeat", "speak"]),
  title: z.string(),
  instructions: z.string(),
  questions: z.array(QuestionSchema),
  /** needs a microphone (or the typed fallback that is recorded as such) */
  speaking: z.boolean().default(false),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const AnswerSchema = z.object({
  questionId: z.string(),
  itemId: z.string(),
  /** what the user answered (typed, chosen, or what the speech engine heard) */
  given: z.string(),
  correct: z.boolean(),
  /** speaking answers: an AUTOMATED ESTIMATE, never a verified result */
  estimate: z.object({ score: z.number(), verdict: z.enum(["match", "close", "different"]), verified: z.literal(false), note: z.string() }).optional(),
  /** how the answer was given */
  mode: z.enum(["typed", "chosen", "spoken", "typed-instead-of-speaking"]),
  /** match boards: how many pairs were right */
  part: z.object({ right: z.number(), total: z.number() }).optional(),
  /** match boards: the pairs that were wrong */
  wrongPairs: z.array(z.string()).optional(),
  at: z.number(),
});
export type AnswerRecord = z.infer<typeof AnswerSchema>;

export const AttemptSchema = z.object({
  id: z.string(),
  kind: z.enum(["lesson", "revision"]),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  /** share of the checkable questions answered correctly (speaking is estimated separately) */
  score: z.number().optional(),
  correct: z.number().default(0),
  total: z.number().default(0),
  /** how the speaking activities of this attempt were answered: recognised speech, typed instead, or nothing could be recognised */
  speaking: z.object({ spoken: z.number(), typed: z.number() }).optional(),
  missed: z.array(z.string()).default([]),
  passed: z.boolean().optional(),
  difficulty: z.number().default(2),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const ActiveAttemptSchema = z.object({
  id: z.string(),
  kind: z.enum(["lesson", "revision"]),
  startedAt: z.number(),
  difficulty: z.number(),
  seed: z.number(),
  activities: z.array(ActivitySchema),
  /** the activity the user is on: the ones after it are locked */
  index: z.number(),
  answers: z.record(AnswerSchema),
  focus: z.array(z.string()).optional(),
});
export type ActiveAttempt = z.infer<typeof ActiveAttemptSchema>;

export const LessonProgressSchema = z.object({
  status: z.enum(["locked", "available", "in_progress", "revision_required", "passed"]).default("locked"),
  attempts: z.array(AttemptSchema).default([]),
  active: ActiveAttemptSchema.optional(),
  bestScore: z.number().default(0),
  /** after a failed attempt: the items to revise, and whether the required revision has been passed */
  revisionItems: z.array(z.string()).default([]),
  revisionPassed: z.boolean().default(false),
  passedAt: z.number().optional(),
});
export type LessonProgress = z.infer<typeof LessonProgressSchema>;

export const VocabStrengthSchema = z.object({
  seen: z.number().default(0), correct: z.number().default(0), wrong: z.number().default(0), strength: z.number().default(0), lastSeen: z.number().default(0),
  /** the evidence mastery is judged from: one entry per FINISHED attempt that tested this item (true = every question about it was right), newest last */
  recent: z.array(z.boolean()).default([]),
});
export type VocabStrength = z.infer<typeof VocabStrengthSchema>;

export const PronunciationRecordSchema = z.object({
  at: z.number(), lang: LangIdSchema, itemId: z.string(), expected: z.string(), heard: z.string(),
  score: z.number(), verdict: z.enum(["match", "close", "different"]),
  /** always false: a speech-to-text comparison is an estimate (it cannot hear tones or accent quality) */
  verified: z.literal(false),
});
export type PronunciationRecord = z.infer<typeof PronunciationRecordSchema>;

export const GoalSchema = z.object({
  id: z.string(),
  kind: z.enum(["vocab_count", "writing_system", "lessons_count", "level_pass", "interview_complete", "pronunciation_practice"]),
  lang: LangIdSchema,
  level: LevelSchema.optional(),
  target: z.number().min(1),
  label: z.string(),
  createdAt: z.number(),
  completedAt: z.number().optional(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const SettingsSchema = z.object({
  lang: LangIdSchema,
  native: z.literal("en").default("en"),
  level: LevelSchema.default("beginner"),
  /** share of checkable questions that must be right to pass a lesson */
  passScore: z.number().min(0.5).max(1).default(0.8),
  /** a failed lesson must be followed by a passed revision before it can be retaken */
  requireRevision: z.boolean().default(true),
  /** the final interview of a level must be completed before the next level opens */
  interviewRequired: z.boolean().default(true),
  /** mastery: a word is "learned" only when it was right in at least `masteryNeeded` of the last `masteryWindow` FINISHED attempts that tested it, and in the most recent one. One lucky pass can never do it. */
  masteryNeeded: z.number().int().min(2).max(8).default(3),
  masteryWindow: z.number().int().min(3).max(12).default(5),
  /** how many things the learner must say in the interview for it to count as completed */
  interviewMinTurns: z.number().int().min(2).max(30).default(6),
});
export type LearningSettings = z.infer<typeof SettingsSchema>;

/** the interview results kept in learning history: only the completion facts, never a report */
export const InterviewRecordSchema = z.object({
  sessionId: z.string(), lang: LangIdSchema, level: LevelSchema, scenarioId: z.string(), userRole: z.string(), aiRole: z.string(),
  startedAt: z.number(), endedAt: z.number().optional(),
  status: z.enum(["in_progress", "completed", "abandoned"]),
  userTurns: z.number().default(0),
  /** did the learner say enough in the target language to count as completing the stage? (not a score) */
  countsAsCompleted: z.boolean().default(false),
});
export type InterviewRecord = z.infer<typeof InterviewRecordSchema>;

export const LearningStateSchema = z.object({
  version: z.literal(1),
  createdAt: z.number(),
  settings: SettingsSchema,
  lessons: z.record(LessonProgressSchema).default({}),
  vocab: z.record(VocabStrengthSchema).default({}),
  pronunciation: z.array(PronunciationRecordSchema).default([]),
  goals: z.array(GoalSchema).default([]),
  interviews: z.array(InterviewRecordSchema).default([]),
  /** the full interview sessions (the contract data), so an unfinished one can be resumed and a finished one revisited */
  sessions: z.record(InterviewSessionSchema).default({}),
  last: z.object({ lessonId: z.string(), at: z.number() }).optional(),
  /** a course (language + level) the learner has started */
  courses: z.record(z.object({ startedAt: z.number(), completedAt: z.number().optional() })).default({}),
});
export type LearningState = z.infer<typeof LearningStateSchema>;

export function freshState(lang: z.infer<typeof LangIdSchema>, now: number): LearningState {
  return LearningStateSchema.parse({ version: 1, createdAt: now, settings: { lang }, lessons: {}, vocab: {}, pronunciation: [], goals: [], interviews: [], sessions: {}, courses: {} });
}
