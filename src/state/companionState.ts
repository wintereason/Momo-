import type { CompanionUiState, RuntimeEvent } from "../types/runtime-events";

export interface CompanionState {
  ui: CompanionUiState;
  message?: string;
  transcript?: string;
  sessionId?: string;
  taskId?: string;
  confirmation?: { taskId: string; summary: string };
  clarification?: { taskId: string; question: string; options?: { label: string; detail?: string }[] };
  result?: { summary: string; verified: boolean; kind: "success" | "failed" };
  /** text written by an AI model: shown as an answer that may be wrong, never as a verified result */
  answer?: { text: string; source: string };
}

export const initialCompanionState: CompanionState = { ui: "idle" };

/** Local (UI-originated) actions, not runtime events. */
export type LocalAction =
  | { type: "local.dismiss" } // result acknowledged / timeout / user cancel
  | { type: "local.sleep" } // inactivity timeout
  | { type: "local.wake" } // shortcut / button while sleeping
  | { type: "local.reset" }; // session cleanup

export type CompanionAction = RuntimeEvent | LocalAction;

/** States in which a new voice session may begin. */
export const CAN_START_VOICE: ReadonlySet<CompanionUiState> = new Set([
  "idle", "asking", "blocked", "success", "partial_success", "sorry", "error",
]);

export function companionReducer(s: CompanionState, a: CompanionAction): CompanionState {
  const next = reduceInner(s, a);
  // an AI answer stays only until something else happens
  if (next !== s && next.answer && a.type !== "task.answer") {
    const { answer: _gone, ...rest } = next;
    void _gone;
    return rest;
  }
  return next;
}

function reduceInner(s: CompanionState, a: CompanionAction): CompanionState {
  switch (a.type) {
    case "local.reset":
      return initialCompanionState;
    case "local.wake":
      // also used as "retry" after the microphone was disabled
      return s.ui === "sleeping" || s.ui === "disabled" ? initialCompanionState : s;
    case "local.sleep":
      return s.ui === "idle" ? { ui: "sleeping" } : s;
    case "local.dismiss":
      if (s.ui === "sleeping" || s.ui === "disabled") return s;
      return { ui: "idle" };
  }

  // Sleeping only exits through an explicit wake, not stray runtime events.
  if (s.ui === "sleeping") return s;

  switch (a.type) {
    case "voice.started":
      // One mic session at a time.
      if (s.ui === "listening" || !CAN_START_VOICE.has(s.ui)) return s;
      return {
        ui: "listening",
        sessionId: a.sessionId,
        transcript: undefined,
        clarification: s.ui === "asking" ? s.clarification : undefined,
      };
    case "voice.stopped":
      if (s.ui !== "listening" || s.sessionId !== a.sessionId) return s;
      return { ...s, ui: "transcribing", message: undefined };
    case "transcript.ready":
      if (s.ui !== "transcribing" || s.sessionId !== a.sessionId) return s;
      return { ...s, ui: "thinking", transcript: a.text };
    case "task.state":
      // Success may only come from a verified task.completed event.
      if (a.state === "success" || a.state === "sleeping") return s;
      if (s.ui === "disabled" && a.state !== "idle") return s;
      return { ...s, ui: a.state, taskId: a.taskId, message: a.message };
    case "task.confirmation_required":
      return { ...s, ui: "blocked", taskId: a.taskId, confirmation: { taskId: a.taskId, summary: a.summary } };
    case "task.clarification_required":
      return { ...s, ui: "asking", taskId: a.taskId, clarification: { taskId: a.taskId, question: a.question, options: a.options } };
    case "task.answer":
      // neutral on purpose: an AI answer is not a success
      return { ui: "idle", taskId: a.taskId, transcript: s.transcript, answer: { text: a.text, source: a.source } };
    case "task.completed":
      return {
        ...s,
        ui: "success",
        taskId: a.taskId,
        confirmation: undefined,
        clarification: undefined,
        message: undefined,
        result: { summary: a.summary, verified: a.verified, kind: "success" },
      };
    case "task.failed":
      return {
        ...s,
        ui: a.recoverable ? "sorry" : "error",
        taskId: a.taskId,
        confirmation: undefined,
        clarification: undefined,
        message: undefined,
        result: { summary: a.summary, verified: false, kind: "failed" },
      };
    case "cursor.move":
    case "cursor.window":
    case "cursor.aim":
    case "cursor.result":
      return s; // only the shadow cursor cares where Momo is acting
    case "runtime.error":
      if (a.code === "mic_denied" || a.code === "mic_unavailable") {
        return { ui: "disabled", message: a.message };
      }
      return { ...s, ui: "error", message: a.message, confirmation: undefined, clarification: undefined };
  }
}
