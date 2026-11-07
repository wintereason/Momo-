import type { ActivationMode } from "../types/runtime-events";

/**
 * Pure activation logic. Exactly ONE mode is active; there are never two listeners.
 * The widget mic button is an alternate input to the same mode
 * (hold: press/release; toggle: click).
 */
export type ActivationInput =
  | { kind: "press"; repeat?: boolean }
  | { kind: "release" }
  | { kind: "cancel" };

export interface ActivationState {
  recording: boolean;
  /** true while transcribing/thinking/working: new sessions are refused */
  busy: boolean;
}
export type ActivationAction = "start" | "stop" | "cancel" | null;

export function activationStep(
  mode: ActivationMode,
  s: ActivationState,
  input: ActivationInput,
): { next: ActivationState; action: ActivationAction } {
  if (input.kind === "cancel") {
    return s.recording ? { next: { ...s, recording: false }, action: "cancel" } : { next: s, action: null };
  }
  if (input.kind === "press") {
    if (input.repeat) return { next: s, action: null }; // ignore key-repeat
    if (mode === "hold") {
      if (s.recording || s.busy) return { next: s, action: null };
      return { next: { ...s, recording: true }, action: "start" };
    }
    // toggle
    if (s.recording) return { next: { ...s, recording: false }, action: "stop" };
    if (s.busy) return { next: s, action: null }; // no overlapping sessions
    return { next: { ...s, recording: true }, action: "start" };
  }
  // release: only meaningful in hold mode; toggle ignores release
  if (mode === "hold" && s.recording) return { next: { ...s, recording: false }, action: "stop" };
  return { next: s, action: null };
}
