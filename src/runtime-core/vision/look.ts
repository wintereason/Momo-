import type { CaptureTransport } from "../shared/ports";
import type { CaptureFrame, VisualCapture } from "./capture";
import { buildCandidates, parseRaw, type VisualCandidate } from "./detect";

/**
 * One visual look at one window (Phase 6b, read-only): a settled frame from the capture, then words and rectangles detected on that very frame
 * inside the helper, then scored candidates. Nothing here clicks, types or moves anything.
 *
 * Memory and privacy: the candidates (which carry recognised text) are held only while their look is still FRESH. They are wiped when that time
 * is up, when the capture is released (task end, cancel, idle, another window) and on request. Pixels never get here at all.
 */

export interface LookStages { captureMs: number; copyMs: number; shapesMs: number; cropsMs: number; ocrMs: number; totalMs: number }

export type LookOutcome =
  | { ok: true; frame: CaptureFrame; candidates: VisualCandidate[]; stages: LookStages }
  | { ok: false; state: string; reason: string };

export interface LookOptions {
  maxAgeMs?: number;
  now?: () => number;
  /** the first detection loads the text recogniser: it may take a few seconds */
  detectTimeoutMs?: number;
}

const FAIL = {
  stale: "The window changed while I was reading it, so I did not trust the result.",
  no_ocr: "This PC has no text-recognition language installed, so I cannot read words from pictures.",
  unavailable: "Reading pictures of windows is not available right now.",
  odd: "I could not make sense of what the picture reader returned.",
} as const;

export class VisualLook {
  private held: { frame: CaptureFrame; candidates: VisualCandidate[]; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly maxAgeMs: number;
  private counters = { looks: 0, refused: 0, candidates: 0 };

  constructor(private capture: VisualCapture, private transport: CaptureTransport | undefined, private opts: LookOptions = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? 1500;
    capture.onRelease(() => this.clear());
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }
  /** counters only: never text, never a window name */
  stats(): { looks: number; refused: number; candidates: number; holding: boolean } { return { ...this.counters, holding: this.held !== null }; }

  /** Look at a window. `live` is asked between steps: a cancelled task stops the look and frees the capture. */
  async look(hwnd: number, live: () => boolean = () => true): Promise<LookOutcome> {
    const t0 = this.now();
    this.clear();
    // twice at most: the first detection loads the recogniser, which can outlast the freshness of the frame it started on
    for (let attempt = 0; attempt < 2; attempt++) {
      const obs = await this.capture.observe(hwnd, live);
      if (!obs.ok) { this.counters.refused++; return { ok: false, state: obs.state, reason: obs.reason }; }
      if (!this.transport) { this.counters.refused++; return { ok: false, state: "unavailable", reason: FAIL.unavailable }; }
      if (!live()) { await this.capture.release(); return { ok: false, state: "cancelled", reason: "Stopped." }; }
      let reply: unknown;
      try { reply = await this.transport.send("capdetect", [obs.frame.session, obs.frame.frame], this.opts.detectTimeoutMs ?? 30_000); } catch { this.counters.refused++; return { ok: false, state: "unavailable", reason: FAIL.unavailable }; }
      const state = (reply as { state?: string } | null)?.state;
      if (state === "no_ocr") { this.counters.refused++; return { ok: false, state, reason: FAIL.no_ocr }; }
      if (state === "stale") continue; // another frame replaced it: take a fresh look
      const raw = parseRaw(reply, obs.frame);
      if (!raw) { this.counters.refused++; return { ok: false, state: "unreadable", reason: FAIL.odd }; }
      if (!this.capture.isFresh(obs.frame)) continue; // the detection took too long for the frame to still count: look again
      if (!live()) { await this.capture.release(); return { ok: false, state: "cancelled", reason: "Stopped." }; }
      const candidates = buildCandidates(raw, obs.frame);
      this.hold(obs.frame, candidates);
      this.counters.looks++; this.counters.candidates += candidates.length;
      return { ok: true, frame: obs.frame, candidates, stages: { captureMs: obs.frame.ms, copyMs: raw.msCopy, shapesMs: raw.msShapes, cropsMs: raw.msCrops, ocrMs: raw.msOcr, totalMs: this.now() - t0 } };
    }
    this.counters.refused++;
    return { ok: false, state: "stale", reason: FAIL.stale };
  }

  private hold(frame: CaptureFrame, candidates: VisualCandidate[]): void {
    const timer = setTimeout(() => this.clear(), Math.max(0, this.maxAgeMs - (this.now() - frame.at)));
    (timer as { unref?: () => void }).unref?.();
    this.held = { frame, candidates, timer };
  }

  /** Forget everything the last look found (the recognised text included). */
  clear(): void {
    if (this.held) clearTimeout(this.held.timer);
    this.held = null;
  }

  /**
   * The thorough version, for use right before anything is done with a candidate: everything `candidate()` checks, plus the helper confirms that
   * the very same frame is still the current one and the window is still capturable, in the same place and at the same size. A window that was
   * moved, resized, minimized or hidden since the look makes every candidate of it stale at once.
   */
  async confirmCandidate(id: string): Promise<{ ok: true; candidate: VisualCandidate } | { ok: false; reason: string }> {
    const c = this.candidate(id);
    if (!c.ok || !this.held) return c;
    const sure = await this.capture.confirmFresh(this.held.frame);
    if (!sure.ok) { this.clear(); return sure; }
    return c;
  }

  /**
   * One candidate of the latest look, but only while that look is still fresh. After that the candidate is gone: a new look has to be taken.
   * (Phase 6c will go further and re-capture before acting; this is the cheap half.)
   */
  candidate(id: string): { ok: true; candidate: VisualCandidate } | { ok: false; reason: string } {
    const h = this.held;
    if (!h || !this.capture.isFresh(h.frame)) { this.clear(); return { ok: false, reason: "That look at the window is out of date. Look again first." }; }
    const c = h.candidates.find((x) => x.id === id);
    return c ? { ok: true, candidate: c } : { ok: false, reason: "There is no such candidate in the latest look." };
  }
}
