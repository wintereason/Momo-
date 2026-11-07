import type { CompanionUiState } from "../types/runtime-events";

/**
 * Small floating icons beside the character, as in the reference sheet (mic waves while listening, thought
 * dots, sweat drop when sorry, stars and a check on success, Zzz asleep...). Presentation only: an icon
 * never implies a result. In particular the success icons exist ONLY for the "success" state, which the
 * state machine only reaches after a verified completion.
 */
export type EffectKind =
  | "mic" | "dots" | "question" | "gear" | "stars" | "check" | "sweat" | "exclaim" | "warning" | "zzz" | "slash" | "half";

export interface EffectSpec {
  kind: EffectKind;
  /** where it floats, relative to the character (scene units) */
  anchor: { x: number; y: number };
  /** size in scene units */
  size: number;
}

const RIGHT = { x: 0.52, y: 0.62 };
const LEFT = { x: -0.52, y: 0.58 };
const TOP = { x: 0.3, y: 0.82 };

export function effectsFor(state: CompanionUiState): EffectSpec[] {
  switch (state) {
    case "listening": return [{ kind: "mic", anchor: RIGHT, size: 0.42 }];
    case "transcribing": return [{ kind: "dots", anchor: TOP, size: 0.36 }];
    case "thinking": return [{ kind: "dots", anchor: TOP, size: 0.42 }];
    case "asking": return [{ kind: "question", anchor: TOP, size: 0.4 }];
    case "working": return [{ kind: "gear", anchor: RIGHT, size: 0.34 }];
    case "success": return [{ kind: "stars", anchor: LEFT, size: 0.5 }, { kind: "check", anchor: RIGHT, size: 0.3 }];
    case "partial_success": return [{ kind: "half", anchor: RIGHT, size: 0.3 }];
    case "sorry": return [{ kind: "sweat", anchor: { x: 0.34, y: 0.5 }, size: 0.24 }];
    case "blocked": return [{ kind: "exclaim", anchor: RIGHT, size: 0.36 }];
    case "error": return [{ kind: "warning", anchor: RIGHT, size: 0.34 }];
    case "sleeping": return [{ kind: "zzz", anchor: TOP, size: 0.46 }];
    case "disabled": return [{ kind: "slash", anchor: RIGHT, size: 0.34 }];
    case "idle": return [];
  }
}

export interface EffectMotion { x: number; y: number; scale: number; alpha: number; rotZ: number }

/** Motion of one floating icon: gentle bob, plus kind-specific flourishes. `since` = seconds in this state. */
export function effectMotion(kind: EffectKind, t: number, since: number, reduceMotion = false): EffectMotion {
  const k = reduceMotion ? 0.2 : 1;
  const appear = Math.min(1, since / 0.25); // quick pop-in
  const m: EffectMotion = { x: 0, y: Math.sin(t * 2 + 1) * 0.015 * k, scale: 0.6 + 0.4 * appear, alpha: appear, rotZ: 0 };
  switch (kind) {
    case "mic": m.scale *= 1 + Math.sin(t * 6) * 0.06 * k; break;
    case "gear": m.rotZ = t * 1.4 * k; break;
    case "stars": m.rotZ = Math.sin(t * 3) * 0.2 * k; m.scale *= 1 + Math.sin(t * 5) * 0.07 * k; break;
    case "zzz": m.y += ((t * 0.18) % 0.25) * k; m.alpha *= 1 - ((t * 0.18) % 0.25) * 2.2; break; // drifts up and fades, looping
    case "sweat": m.y -= Math.min(since, 1) * 0.06 * k; break;
    case "dots": m.scale *= 1 + Math.sin(t * 4) * 0.04 * k; break;
    case "exclaim": m.scale *= 1 + Math.abs(Math.sin(t * 3)) * 0.08 * k; break;
    default: break;
  }
  m.alpha = Math.max(0, Math.min(1, m.alpha));
  return m;
}

/** The success tick exists only for a verified success (the UI state machine guarantees this). */
export const SUCCESS_KINDS: readonly EffectKind[] = ["stars", "check"];
