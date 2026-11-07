import type { AiConfig, Provider } from "./config";
import { isCloud } from "./config";
import type { LlmClient, LlmFailure } from "./llm";
import { DICTATION_SYSTEM, PLANNER_SYSTEM, buildPlanInput, parsePlan, wrapDictation, type PlanDecision, type PlanStep, type ToolInfo } from "./prompts";
import { acceptPolish } from "../dictation";

export type AiOutcome<T> = ({ ok: true } & T) | { ok: false; reason: LlmFailure | "unusable_answer"; message: string };

export interface AiService {
  /** enabled and at least one provider is configured */
  ready(): boolean;
  /** the provider that will be tried first, for display ("Gemini") */
  label(): string;
  /** true if the request leaves this PC */
  isCloud(): boolean;
  /** may text read from the screen be sent to the AI? (never to a cloud provider unless switched on in .env) */
  canSeeScreen(): boolean;
  /**
   * The planner: given the goal and what has happened so far, the next single move. Nothing but the goal's words and
   * Momo's own (fenced) observations are sent.
   */
  plan(goal: string, steps: PlanStep[], tools: ToolInfo[]): Promise<AiOutcome<{ decision: PlanDecision; source: string }>>;
  /** Fix grammar and wording of dictated text. Uses only the dictated words; no screen content, no history. */
  polish(text: string, style: "light" | "polish"): Promise<AiOutcome<{ text: string; source: string }>>;
  usage(): { count: number; limit: number };
}

const NAMES: Record<Provider, string> = { gemini: "Gemini", groq: "Groq", openrouter: "OpenRouter", ollama: "Ollama (this PC)" };

/** Sentences for people, not codes. Nothing in them can contain a key, a URL or a response body. */
export const FAILURE_MESSAGES: Record<LlmFailure | "unusable_answer", string> = {
  disabled: "The AI is switched off. Set MOMO_AI_ENABLED=true in your .env file to turn it on.",
  no_provider: "The AI is on, but no provider key is set in your .env file.",
  daily_limit: "I've used today's free AI requests, to stay inside the free tier. They reset tomorrow.",
  rate_limited: "The free AI is busy right now. Try again in a minute.",
  auth: "The AI service rejected my key. Check it in your .env file.",
  network: "I couldn't reach the AI. Check your internet connection and try again.",
  server: "The AI service returned an error. It may be down, or the model name in your .env may be wrong. Try again in a moment.",
  bad_response: "The AI replied, but not in a way I could use.",
  blocked: "The AI declined to answer that.",
  unusable_answer: "The AI replied, but not in a way I could use.",
};

export function createAiService(llm: LlmClient, config: () => AiConfig): AiService {
  const first = (): Provider | null => config().order[0]?.provider ?? null;
  const fail = (reason: LlmFailure | "unusable_answer") => ({ ok: false as const, reason, message: FAILURE_MESSAGES[reason] });

  return {
    ready: () => { const c = config(); return c.enabled && c.order.length > 0; },
    label: () => { const p = first(); return p ? NAMES[p] : "the AI"; },
    isCloud: () => { const p = first(); return p ? isCloud(p) : false; },
    canSeeScreen: () => { const p = first(); return !!p && (!isCloud(p) || config().allowScreenContext); },
    usage: () => llm.usageToday(),

    async plan(goal, steps, tools) {
      const system = PLANNER_SYSTEM(tools);
      const user = buildPlanInput(goal, steps);
      // one retry when the reply is not in the required shape: planners sometimes add words around the JSON
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await llm.complete({
          system, tier: "fast", json: true, maxTokens: 500, timeoutMs: 20_000,
          messages: [{ role: "user", text: attempt === 0 ? user : `${user}\n\n(Your last reply was not a single valid JSON object of the required shape. Reply with ONLY that JSON.)` }],
        });
        if (!r.ok) return fail(r.reason);
        const decision = parsePlan(r.text);
        if (decision) return { ok: true, decision, source: NAMES[r.provider] };
      }
      return fail("unusable_answer");
    },

    async polish(text, style) {
      const input = text.slice(0, 3000);
      const r = await llm.complete({
        system: DICTATION_SYSTEM(style), tier: "fast", json: false, timeoutMs: 8000,
        maxTokens: Math.min(1500, Math.ceil(input.length / 2) + 120),
        messages: [{ role: "user", text: wrapDictation(input) }],
      });
      if (!r.ok) return fail(r.reason);
      const out = acceptPolish(input, r.text);
      if (!out) return fail("unusable_answer");
      return { ok: true, text: out, source: NAMES[r.provider] };
    },
  };
}
