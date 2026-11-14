import { ConverseRequestSchema, INTERVIEW_SYSTEM, parseConverse, type ConverseReply } from "./prompts";

/** The one thing this role needs from the AI: a chat turn. (The orchestrator's AI service provides it; this role never imports it.) */
export interface ChatPort {
  ready(): boolean;
  label(): string;
  isCloud(): boolean;
  converse(input: { system: string; messages: { role: "user" | "assistant"; text: string }[]; maxTokens: number }): Promise<{ ok: true; text: string; source: string } | { ok: false; message: string; reason: string }>;
}

export type ConverseOutcome =
  | { ok: true; reply: ConverseReply; source: string; /** true when the AI runs in the cloud: the conversation text left this PC */ cloud: boolean }
  | { ok: false; message: string; /** a retry may work (busy, network); a bad request will not */ retryable: boolean };

/**
 * The Language Teacher specialist. It plays the other side of a roleplay interview: given the scene, the learner's level and the
 * conversation so far, it produces the next line. It knows nothing about the learner's progress, permissions or the desktop; it can
 * only write one line of dialogue, and everything it returns is validated.
 */
export class LanguageTeacherAgent {
  private summary: string | null = null;
  constructor(private chat: ChatPort | undefined) {}

  /** the learner's progress, as a short text the UI keeps current, so the orchestrator can answer "what should I study next?" */
  setSummary(text: string): void { this.summary = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 600) || null; }
  getSummary(): string | null { return this.summary; }

  async converse(raw: unknown): Promise<ConverseOutcome> {
    const parsed = ConverseRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, message: "That conversation request was not valid.", retryable: false };
    const chat = this.chat;
    if (!chat || !chat.ready()) return { ok: false, message: "The AI is not set up, so I can't play the other role. Add a free key in Settings → AI & keys.", retryable: false };
    const r = parsed.data;
    // only the conversation itself is sent: the scene, the level and the lines. No name, no history of other lessons, nothing from the screen.
    const out = await chat.converse({ system: INTERVIEW_SYSTEM(r), messages: r.history, maxTokens: 400 });
    if (!out.ok) return { ok: false, message: out.message, retryable: /busy|reach|network|moment|limit/i.test(out.message) || ["rate_limited", "network", "server", "bad_response", "unusable_answer"].includes(out.reason) };
    const reply = parseConverse(out.text);
    if (!reply) return { ok: false, message: "The AI replied, but not with a usable line. Try again.", retryable: true };
    return { ok: true, reply, source: out.source, cloud: chat.isCloud() };
  }
}
