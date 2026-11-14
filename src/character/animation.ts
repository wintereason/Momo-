/** Timing helpers for the character's natural motion. Pure, so they are tested. */

/** Milliseconds until the next blink: irregular, a few seconds apart. `scale` > 1 blinks less often. `rand` is 0..1. */
export const nextBlinkDelay = (rand: number, scale = 1): number => (2300 + rand * 3700) * scale;

/** Eye openness (1 open .. 0 shut .. 1 open) `elapsedMs` after a blink started; a blink lasts `durMs`. */
export function blinkFactor(elapsedMs: number, durMs = 150): number {
  if (elapsedMs <= 0 || elapsedMs >= durMs) return 1;
  return 1 - Math.sin((Math.PI * elapsedMs) / durMs);
}

/** How much of the idle motion plays for an animation setting (and whether the OS asks for reduced motion). */
export function motionAmount(level: "full" | "reduced" | "off", osReduced: boolean): { sway: number; blink: boolean; ease: boolean } {
  if (level === "off") return { sway: 0, blink: false, ease: false };
  if (level === "reduced" || osReduced) return { sway: 0, blink: true, ease: true };
  return { sway: 1, blink: true, ease: true };
}

/**
 * How shut the eyelids are, 0 (open) .. 1 (closed), `elapsedMs` after a blink began. Timed like the reference animation:
 * about 100 ms closing, a short hold, about 100 ms opening (300 ms in all), eased so it never snaps.
 */
export const BLINK_MS = 300;
export function lidClosure(elapsedMs: number, total = BLINK_MS): number {
  if (elapsedMs <= 0 || elapsedMs >= total) return 0;
  const third = total / 3;
  const sm = (x: number) => x * x * (3 - 2 * x);
  if (elapsedMs < third) return sm(elapsedMs / third);
  if (elapsedMs < 2 * third) return 1;
  return sm(1 - (elapsedMs - 2 * third) / third);
}
