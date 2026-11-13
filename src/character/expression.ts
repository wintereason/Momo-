import type { BarState } from "../state/dictationState";
import type { Personality } from "./config";
import type { ExpressionId } from "./face";
import { PERSONAS } from "./personality";

/**
 * Which face Momo wears, decided ONLY from what Momo is actually doing (the bar's state, which is built from the real
 * voice pipeline and the agent's events) and whether it is speaking right now. The character never decides anything about
 * the task: this is a one-way read of the state.
 */
export function expressionFor(bar: BarState, speaking: boolean, personality: Personality): ExpressionId {
  const persona = PERSONAS[personality];
  switch (bar.phase) {
    case "idle":
      return speaking ? "speaking" : persona.idle;
    case "listening":
      return "listening";
    case "transcribing":
    case "polishing":
      return "thinking";
    case "thinking":
      // "Working it out…" = planning; any other message is a step being carried out
      return bar.message === "Working it out…" ? "thinking" : "serious";
    case "confirming":
      return "warning"; // a consequential action: careful, and waiting for the user
    case "asking":
      return "confused";
    case "done": {
      if (bar.message.includes("not confirmed")) return "calm"; // pasted but unverified: no celebration
      if (bar.card?.kind === "answer") return speaking ? "speaking" : "friendly"; // an AI answer is not a success
      if (speaking) return "speaking";
      return bar.card?.kind === "result" ? persona.celebrate : "happy";
    }
    case "problem":
      if (bar.tone === "warning") return "warning";
      if (bar.tone === "failed") return persona.failure;
      return "error";
  }
}
