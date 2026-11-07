import type { CompanionUiState } from "../types/runtime-events";

/**
 * Performance policy for an integrated-graphics laptop. Pure and testable: the renderer only asks
 * "should I draw now?" and "is it too slow?".
 *   low      = no WebGL at all (the lightweight 2D CSS view)
 *   standard = the 3D scene with petals and effects
 */
export type Quality = "low" | "standard";
export type QualitySetting = "auto" | "low" | "standard";

export function chooseQuality(o: { setting: QualitySetting; reduceMotion: boolean; webgl: boolean; deviceMemoryGB?: number }): Quality {
  if (!o.webgl) return "low";
  if (o.setting === "low") return "low";
  if (o.setting === "standard") return "standard";
  // auto: step down on constrained machines or when the user asked for less motion
  if (o.reduceMotion) return "low";
  if (o.deviceMemoryGB !== undefined && o.deviceMemoryGB <= 2) return "low";
  return "standard";
}

/** How often the scene should be redrawn: lively when something is happening, near-still when idle, off when unseen. */
export function targetFps(o: { state: CompanionUiState; hidden: boolean; reduceMotion: boolean; pointerNear: boolean }): number {
  if (o.hidden) return 0;
  if (o.state === "sleeping" || o.state === "disabled") return o.reduceMotion ? 1 : 8;
  const busy = o.state !== "idle";
  if (o.reduceMotion) return busy ? 12 : 4;
  if (busy || o.pointerNear) return 30;
  return 15;
}

/** Decides whether a new frame is due, so the page doesn't redraw faster than needed. */
export class FrameBudget {
  private last = -Infinity;
  /** @returns true if a frame should be drawn now, and records it */
  due(nowMs: number, fps: number): boolean {
    if (fps <= 0) return false;
    if (nowMs - this.last >= 1000 / fps - 1) {
      this.last = nowMs;
      return true;
    }
    return false;
  }
  reset(): void { this.last = -Infinity; }
}

/** Watches real frame times and recommends stepping down to "low" if the machine can't keep up. */
export class AdaptiveQuality {
  private samples: number[] = [];
  private tripped = false;

  constructor(private windowSize = 90, private slowMs = 42, private minSlowShare = 0.6) {}

  /** @returns "downgrade" once, when most recent frames were slow */
  push(frameMs: number): "ok" | "downgrade" {
    if (this.tripped) return "ok";
    this.samples.push(frameMs);
    if (this.samples.length > this.windowSize) this.samples.shift();
    if (this.samples.length < this.windowSize) return "ok";
    const slow = this.samples.filter((s) => s > this.slowMs).length / this.samples.length;
    if (slow >= this.minSlowShare) {
      this.tripped = true;
      return "downgrade";
    }
    return "ok";
  }

  /** forget history (e.g. after a pause) so a stutter on resume doesn't count against the machine */
  reset(): void { this.samples = []; }
}
