import { z } from "zod";
import { LangIdSchema, LevelSchema } from "../schemas";

/**
 * THE INTERVIEW SESSION CONTRACT (version 1). The interview engine produces one `InterviewSessionV1` per interview and hands the
 * completed ones to any registered consumer (for example a reporting module owned by another team). The contract carries FACTS about
 * what happened, never scores, mistakes or recommendations: those belong to the consumer. A consumer needs no access to the
 * learning engine: it receives a read-only copy and cannot change the learner's progress.
 *
 * Compatibility rule: version 1 only ever GAINS optional fields. Anything else becomes version 2, published alongside this one.
 */
export const INTERVIEW_CONTRACT = "momo.interview-session" as const;
export const INTERVIEW_CONTRACT_VERSION = 1 as const;

export const TurnInputSchema = z.object({
  mode: z.enum(["typed", "spoken"]),
  /** spoken: the text the speech recognizer produced (what the learner's own `text` came from) */
  transcript: z.string().optional(),
  /** which recognizer produced it ("local" or "cloud") when known */
  engine: z.string().optional(),
  /** how long the learner spoke, when measured */
  durationMs: z.number().optional(),
  /** audio is NEVER stored: always null. The field exists so a consumer sees that no recording is available */
  audioRef: z.null().default(null),
  /** speech estimate against nothing in particular: the recognizer's confidence is not available, so none is given */
  note: z.string().optional(),
});

export const EvidenceSchema = z.object({
  /** the share of letters that are in the language's own script (0..1). Only meaningful for non-Latin scripts; null for Latin */
  scriptRatio: z.number().nullable(),
  /** how many words (or characters, for scripts without spaces) the learner produced */
  units: z.number(),
  /** ids of lesson vocabulary the learner actually used in this turn (exact matches in the course content) */
  usedVocabIds: z.array(z.string()),
  /** the learner wrote or said nothing recognisable */
  empty: z.boolean(),
});

export const TurnSchema = z.object({
  index: z.number().int(),
  speaker: z.enum(["user", "ai"]),
  /** the role being played at this turn */
  role: z.string(),
  /** exactly what was said or written, in the target language, untouched */
  text: z.string(),
  at: z.number(),
  /** AI turns: an English translation, when the AI supplied one. AI-generated, may contain mistakes. */
  translation: z.string().optional(),
  /** AI turns: a romanization, when the AI supplied one. AI-generated and unverified. */
  romanization: z.string().optional(),
  /** AI turns: the communication objective this turn aimed at, and its kind */
  objective: z.string().optional(),
  kind: z.enum(["question", "follow-up", "reaction", "closing"]).optional(),
  /** learner turns: how the answer was given */
  input: TurnInputSchema.optional(),
  /** learner turns: language-specific evidence available for this turn */
  evidence: EvidenceSchema.optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const SessionEventSchema = z.object({ at: z.number(), type: z.enum(["started", "resumed", "interrupted", "retry", "ai-error", "completed", "abandoned"]), detail: z.string().optional() });

export const InterviewSessionSchema = z.object({
  contract: z.literal(INTERVIEW_CONTRACT),
  version: z.literal(INTERVIEW_CONTRACT_VERSION),
  sessionId: z.string(),
  /** an opaque id of the learner profile (never their name) */
  profileId: z.string().nullable(),
  status: z.enum(["in_progress", "completed", "abandoned"]),
  createdAt: z.number(),
  endedAt: z.number().optional(),
  language: z.object({ code: LangIdSchema, name: z.string(), script: z.string(), tonal: z.boolean() }),
  /** the course context: level and what had been passed */
  course: z.object({ level: LevelSchema, lessonsPassed: z.number(), lessonsTotal: z.number(), passScore: z.number(), difficulty: z.enum(["beginner", "intermediate", "advanced"]) }),
  scenario: z.object({ id: z.string(), title: z.string(), setting: z.string(), userRole: z.string(), aiRole: z.string(), custom: z.boolean() }),
  /** the communication objectives the scene was steering toward ("expected communication objectives") */
  objectives: z.array(z.string()),
  /** the questions the AI asked (a copy of its question turns, for convenience) */
  questions: z.array(z.object({ turn: z.number(), text: z.string(), objective: z.string().optional() })),
  turns: z.array(TurnSchema),
  events: z.array(SessionEventSchema),
  /** a basic completion status only: no score, no report */
  completion: z.object({ countsAsCompleted: z.boolean(), userTurns: z.number(), minTurns: z.number(), reason: z.string() }),
  /** what the pronunciation facts mean: transcription exists for spoken turns; accuracy is NOT assessed here */
  speech: z.object({ spokenTurns: z.number(), pronunciationAssessed: z.literal(false) }),
});
export type InterviewSessionV1 = z.infer<typeof InterviewSessionSchema>;

/** Whoever consumes completed interviews. The engine only calls `onSessionCompleted`; it never reads anything back. */
export interface InterviewConsumer {
  /** a short name for logs */
  id: string;
  /** the contract version this consumer understands */
  contractVersion: typeof INTERVIEW_CONTRACT_VERSION;
  onSessionCompleted(session: Readonly<InterviewSessionV1>): void | Promise<void>;
}

/** deep-freeze a copy, so a consumer cannot change what the engine (or another consumer) sees */
function freeze<T>(o: T): T {
  if (o && typeof o === "object") { for (const v of Object.values(o as object)) freeze(v); Object.freeze(o); }
  return o;
}

export class InterviewBus {
  private consumers: InterviewConsumer[] = [];
  /** the sessions already published, so a session is never delivered twice to the same consumer */
  private sent = new Set<string>();

  register(c: InterviewConsumer): () => void {
    if (c.contractVersion !== INTERVIEW_CONTRACT_VERSION) throw new Error(`Unsupported interview contract version ${String(c.contractVersion)}`);
    this.consumers.push(c);
    return () => { this.consumers = this.consumers.filter((x) => x !== c); };
  }
  get size(): number { return this.consumers.length; }

  /** Deliver a COMPLETED session. A failing consumer never breaks the others or the learner's flow. */
  async publish(session: InterviewSessionV1): Promise<{ delivered: string[]; failed: { id: string; message: string }[] }> {
    const parsed = InterviewSessionSchema.parse(session);
    if (parsed.status !== "completed") throw new Error("Only completed sessions are published.");
    const delivered: string[] = [], failed: { id: string; message: string }[] = [];
    for (const c of this.consumers) {
      const key = `${c.id}:${parsed.sessionId}`;
      if (this.sent.has(key)) continue;
      try {
        await c.onSessionCompleted(freeze(structuredClone(parsed)));
        this.sent.add(key);
        delivered.push(c.id);
      } catch (e) { failed.push({ id: c.id, message: e instanceof Error ? e.message : "failed" }); }
    }
    return { delivered, failed };
  }
}

/** the process-wide bus a reporting module registers on */
export const interviewBus = new InterviewBus();
