import type { RuntimeEvent } from "../types/runtime-events";

/**
 * What the pill bar shows. A small pure state machine (tested), driven by the voice pipeline, the answer from the desktop
 * shell after a dictation, and the events of the agent while it works on a goal. Messages are plain sentences. Nothing here
 * keeps what was dictated: the only text held is what Momo itself says about the task, until it is dismissed.
 */
export type BarPhase = "idle" | "listening" | "transcribing" | "polishing" | "thinking" | "confirming" | "asking" | "done" | "problem";
export type BarMode = "dictate" | "agent";

/** The panel above the pill: a decision to make, a question, or a result to read. */
export interface BarCard {
  kind: "confirm" | "ask" | "result" | "answer";
  text: string;
  /** the task the card belongs to (Yes/No go back to exactly this one) */
  taskId?: string;
  /** for a question with several matches: each with its name and full path, to pick by click */
  options?: { label: string; detail?: string }[];
}

export interface BarState {
  phase: BarPhase;
  mode: BarMode;
  /** one short line inside the pill */
  message: string;
  /** a second, quieter line (e.g. "AI is off, so I only fixed the basics") */
  detail?: string;
  card?: BarCard;
}

export const initialBar: BarState = { phase: "idle", mode: "dictate", message: "" };

/** What the desktop shell answers after a dictation (see the `momo:dictate` IPC handler). */
export interface DictateResult {
  ok: boolean;
  reason?: string;
  text?: string;
  polished?: boolean;
  source?: string;
  note?: string;
  inserted?: boolean;
  copied?: boolean;
  blocked?: "password" | "keys_held" | "empty";
}

export type BarEvent =
  | { type: "listening"; mode: BarMode }
  | { type: "heard" } //                 recording stopped; speech recognition is running
  | { type: "recognised"; polishing: boolean }
  | { type: "goal" } //                  the words were handed to the agent as a goal
  | { type: "agent"; event: RuntimeEvent }
  | { type: "result"; result: DictateResult; mode: "type" | "copy" }
  | { type: "problem"; message: string; detail?: string }
  | { type: "reset" };

export function barReducer(s: BarState, e: BarEvent): BarState {
  switch (e.type) {
    case "listening": return { phase: "listening", mode: e.mode, message: e.mode === "agent" ? "Tell me what to do…" : "Listening…" };
    case "heard": return { ...s, phase: "transcribing", message: "Writing it down…", card: s.card };
    case "recognised": return { phase: "polishing", mode: "dictate", message: e.polishing ? "Polishing…" : "Almost there…" };
    case "goal": return { phase: "thinking", mode: "agent", message: "Working it out…" };
    case "problem": return { phase: "problem", mode: s.mode, message: e.message, detail: e.detail };
    case "reset": return initialBar;
    case "result": return fromResult(e.result, e.mode);
    case "agent": return fromAgent(s, e.event);
  }
}

function fromResult(r: DictateResult, mode: "type" | "copy"): BarState {
  const base = { mode: "dictate" as const };
  if (!r.ok) return { ...base, phase: "problem", message: r.reason || "Something went wrong." };
  const how = r.polished ? (r.source ? `Polished by ${r.source}` : "Polished") : r.note ? "Basic fixes only" : undefined;
  if (r.blocked === "password") return { ...base, phase: "problem", message: "Not typed: that looks like a password box.", detail: "Momo skips password boxes it can recognise." };
  if (r.blocked === "keys_held") return { ...base, phase: "problem", message: "Copied. Press Ctrl+V to paste.", detail: "I couldn't paste for you because a key was still held down." };
  if (r.blocked) return { ...base, phase: "problem", message: "I couldn't write that." };
  if (mode === "copy" || !r.inserted) return { ...base, phase: "done", message: "Copied. Press Ctrl+V to paste.", detail: r.note ?? how };
  return { ...base, phase: "done", message: "Inserted", detail: r.note ?? how };
}

/** Show what the agent is doing, and hold every question and decision until the user answers it. */
function fromAgent(s: BarState, e: RuntimeEvent): BarState {
  const base = { mode: "agent" as const };
  switch (e.type) {
    case "task.state":
      if (e.state === "working") return { ...base, phase: "thinking", message: (e.message || "Working…").slice(0, 80) };
      if (e.state === "partial_success") return { ...base, phase: "problem", message: "Not fully confirmed", detail: e.message, card: e.message ? { kind: "result", text: e.message } : undefined };
      if (e.state === "idle") return e.message ? { ...base, phase: "done", message: e.message.slice(0, 80) } : initialBar;
      return s;
    case "task.confirmation_required":
      return { ...base, phase: "confirming", message: "Please confirm", card: { kind: "confirm", text: e.summary, taskId: e.taskId } };
    case "task.clarification_required":
      return { ...base, phase: "asking", message: "I have a question", card: { kind: "ask", text: e.question, taskId: e.taskId, options: e.options } };
    case "task.completed":
      return { ...base, phase: "done", message: "Done", card: { kind: "result", text: e.summary, taskId: e.taskId } };
    case "task.answer":
      return { ...base, phase: "done", message: e.source ? `Answer · ${e.source}` : "Answer", card: { kind: "answer", text: e.text, taskId: e.taskId } };
    case "task.failed":
      return { ...base, phase: "problem", message: "I couldn't do that", card: { kind: "result", text: e.summary, taskId: e.taskId } };
    case "runtime.error":
      return { ...base, phase: "problem", message: e.message.slice(0, 80) };
    default:
      return s; // voice.* and transcript events belong to the voice pipeline, not to the agent
  }
}

/** How long a finished or failed bar stays before it returns to idle. Questions and decisions never time out here. */
export const holdMs = (s: BarState): number => {
  if (s.card) return Math.min(15_000, 4_000 + s.card.text.length * 45); // long enough to read what Momo said
  return s.phase === "problem" ? 4500 : s.detail ? 3200 : 1800;
};

/** Phases in which the bar must accept clicks (a button to press). */
export const needsClicks = (s: BarState): boolean => !!s.card || s.phase === "thinking";
