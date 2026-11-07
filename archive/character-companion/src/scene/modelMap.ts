import type { CompanionUiState } from "../types/runtime-events";
import { UI_STATES } from "../types/runtime-events";

/**
 * Connects the 13 semantic states to what a .glb model actually contains: animation clips and face morph
 * targets (blend shapes). Models differ, so each state lists clip names in order of preference, and anything
 * the model lacks falls back (finally to the procedural pose), mirroring the sprite fallback rule.
 */
export const STATE_TO_CLIPS: Record<CompanionUiState, string[]> = {
  idle: ["idle"],
  listening: ["listening", "attentive", "idle"],
  transcribing: ["transcribing", "focused", "thinking", "idle"],
  thinking: ["thinking", "ponder", "idle"],
  asking: ["asking", "curious", "confused", "thinking", "idle"],
  working: ["working", "focused", "thinking", "idle"],
  success: ["success", "celebrate", "happy", "excited", "idle"],
  partial_success: ["partial_success", "happy", "idle"],
  sorry: ["sorry", "apologize", "sad", "idle"],
  blocked: ["blocked", "alert", "focused", "idle"],
  error: ["error", "worried", "sad", "sorry", "idle"],
  sleeping: ["sleeping", "sleep", "sleepy", "idle"],
  disabled: ["disabled", "idle"],
};

/** Face morph targets, by the same expression names the sprite manifest uses. */
export const STATE_TO_MORPHS: Record<CompanionUiState, string[]> = {
  idle: ["happy"],
  listening: ["listening", "excited", "happy"],
  transcribing: ["focused", "thinking"],
  thinking: ["thinking"],
  asking: ["confused", "surprised", "thinking"],
  working: ["focused", "thinking"],
  success: ["excited", "happy"],
  partial_success: ["happy"],
  sorry: ["sorry"],
  blocked: ["focused", "annoyed", "thinking"],
  error: ["sad", "angry", "annoyed", "sorry"],
  sleeping: ["sleepy"],
  disabled: ["happy"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** First preferred clip the model has (case/punctuation-insensitive), else null = use the procedural pose. */
export function resolveClip(state: CompanionUiState, available: readonly string[]): string | null {
  const byNorm = new Map(available.map((n) => [norm(n), n]));
  for (const want of STATE_TO_CLIPS[state]) {
    const hit = byNorm.get(norm(want));
    if (hit) return hit;
  }
  return null;
}

/** First preferred morph target the model has, else null (the model keeps its neutral face). */
export function resolveMorph(state: CompanionUiState, available: readonly string[]): string | null {
  const byNorm = new Map(available.map((n) => [norm(n), n]));
  for (const want of STATE_TO_MORPHS[state]) {
    const hit = byNorm.get(norm(want));
    if (hit) return hit;
  }
  return null;
}

/** Clips that play once and hold or return to idle (flourishes), versus loops. */
export const ONE_SHOT: ReadonlySet<CompanionUiState> = new Set(["success", "error", "partial_success"]);

/** Uniform scale that makes a model `targetHeight` tall, whatever units it was authored in. */
export function fitScale(modelHeight: number, targetHeight = 1): number {
  if (!Number.isFinite(modelHeight) || modelHeight <= 1e-6) return 1;
  return targetHeight / modelHeight;
}

/** Where the model's feet should sit so every character shares the same seated anchor on the table. */
export function seatedOffset(minY: number, scale: number): number {
  return -minY * scale;
}

/** Every state has some answer (a clip, a morph, or the procedural pose): nothing is ever left undefined. */
export function coverage(available: { clips: string[]; morphs: string[] }): Record<CompanionUiState, "clip" | "morph" | "procedural"> {
  const out = {} as Record<CompanionUiState, "clip" | "morph" | "procedural">;
  for (const s of UI_STATES) {
    out[s] = resolveClip(s, available.clips) ? "clip" : resolveMorph(s, available.morphs) ? "morph" : "procedural";
  }
  return out;
}
