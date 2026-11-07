import type { CompanionAction } from "../state/companionState";
import type { CompanionUiState } from "../types/runtime-events";

/**
 * Action sequence that drives the UI state machine into any of the 13 states.
 * Used by the debug panel (and tested) so every expression can be checked by hand.
 * Runtime events go through the same reducer as real ones; nothing here bypasses it.
 */
export function actionsToReach(state: CompanionUiState): CompanionAction[] {
  const s = "dbg";
  const t = "dbg-task";
  const reset: CompanionAction = { type: "local.reset" };
  switch (state) {
    case "idle": return [reset];
    case "listening": return [reset, { type: "voice.started", sessionId: s }];
    case "transcribing": return [reset, { type: "voice.started", sessionId: s }, { type: "voice.stopped", sessionId: s }];
    case "thinking":
      return [reset, { type: "voice.started", sessionId: s }, { type: "voice.stopped", sessionId: s },
        { type: "transcript.ready", sessionId: s, text: "Example request" }];
    case "asking": return [reset, { type: "task.clarification_required", taskId: t, question: "Which file did you mean?" }];
    case "working": return [reset, { type: "task.state", taskId: t, state: "working", message: "Working on it…" }];
    case "success": return [reset, { type: "task.completed", taskId: t, summary: "Done — I verified it.", verified: true }];
    case "partial_success": return [reset, { type: "task.state", taskId: t, state: "partial_success", message: "I finished part of it; one step remains." }];
    case "sorry": return [reset, { type: "task.failed", taskId: t, summary: "Sorry, I couldn't complete that.", recoverable: true }];
    case "blocked": return [reset, { type: "task.confirmation_required", taskId: t, summary: "I need your confirmation before continuing." }];
    case "error": return [reset, { type: "task.failed", taskId: t, summary: "Something went wrong. You can retry.", recoverable: false }];
    case "sleeping": return [reset, { type: "local.sleep" }];
    case "disabled": return [reset, { type: "runtime.error", code: "mic_denied", message: "Microphone access is disabled." }];
  }
}
