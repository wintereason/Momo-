import type { CaptureTransport } from "../shared/ports";

/**
 * Persistent window capture and readiness (Phase 6a).
 *
 * The pixels never leave the helper process: this class only ever sees numbers (size, place, timing, how many distinct colours, whether two
 * successive frames agree) and a verdict. It decides ONE thing: is there a real, settled picture of this window that later steps may look at?
 *
 * The rule that matters most: a frame that is blank, black, still changing, half-painted or simply unavailable is NEVER "the window contains
 * nothing". It is reported as exactly what it is, so nothing downstream can mistake "I could not see" for "there is nothing to see".
 */

export type CaptureState =
  | "ready" | "not_ready" | "changing" | "blank" | "black" | "incomplete"
  | "minimized" | "hidden" | "excluded" | "hung" | "busy" | "gone" | "too_small" | "too_big"
  | "no_session" | "failed" | "unavailable" | "cancelled";

type Refused = Exclude<CaptureState, "ready">;

/**
 * One settled frame. `l`, `t`, `pw`, `ph` are the window's rectangle on the screen in PHYSICAL pixels at that moment. `w` x `h` is the size of
 * the picture. They are the same except for a DPI-virtualized window (an old DPI-unaware program scaled up by Windows): there the picture is the
 * window's logical size and a point (x, y) in it is at (l + x * scale, t + y * scale) on the screen.
 */
export interface CaptureFrame {
  session: number;
  frame: number;
  hwnd: number;
  /** the picture's size in its own pixels */
  w: number;
  h: number;
  /** the window on the screen, physical pixels */
  l: number;
  t: number;
  pw: number;
  ph: number;
  /** real pixels per picture pixel (1 normally; 2 for a DPI-unaware window on a 200% screen) */
  scale: number;
  /** the desktop's bounds (all monitors together), physical pixels */
  visible: { l: number; t: number; w: number; h: number };
  /**
   * Part of the window is outside the desktop. A window only draws what is on the screen when it paints, so what lies outside may be MISSING from
   * the picture (black or blank): nothing found there, or not found there, means nothing.
   */
  clipped: boolean;
  /** the window's own DPI (96 = 100%; a DPI-unaware window always says 96) */
  dpi: number;
  /** the DPI of the monitor it is on (192 = 200%): what the screen is really scaled by */
  monitorDpi: number;
  ms: number;
  /** when this frame was confirmed ready (the caller's clock) */
  at: number;
}

export type Observation =
  | { ok: true; frame: CaptureFrame }
  | { ok: false; state: Refused; reason: string };

/** Fixed sentences: nothing about the window's content can ever end up in one. */
const REASONS: Record<Refused, string> = {
  not_ready: "The window had not settled yet, so I could not trust what I saw.",
  changing: "The window kept changing while I looked, so I could not trust what I saw.",
  blank: "The window looks blank right now, so I cannot tell what is in it.",
  black: "The window picture came back black, so I cannot tell what is in it.",
  incomplete: "The window could not be captured completely, so I cannot tell what is in it.",
  minimized: "The window is minimized, so I cannot look at it. It has to be shown first.",
  hidden: "The window is not visible (it may be on another desktop), so I cannot look at it.",
  excluded: "That window does not allow its picture to be taken, so I will not look at it.",
  hung: "The window is not responding, so I did not try to capture it.",
  busy: "The window is busy and did not answer in time, so I did not wait for it. Try again in a moment.",
  gone: "That window is gone.",
  too_small: "That window is too small to look at.",
  too_big: "That window is larger than I am allowed to capture.",
  no_session: "There is no capture in progress.",
  failed: "I could not capture that window.",
  unavailable: "Looking at window pixels is not available right now.",
  cancelled: "Stopped.",
};
const STALE = "That look at the window is out of date.";
/** states in which the window itself will not give a picture however long we wait: no point trying again within this look */
const HARD: ReadonlySet<string> = new Set(["minimized", "hidden", "excluded", "hung", "busy", "gone", "too_small", "too_big", "failed", "unavailable", "no_session"]);
export const BORDER_TOLERANCE_PX = 24;

/** the desktop's bounds from the helper's answer, and whether the window sticks out of them */
function visibleOf(g: { l?: number; t?: number; pw?: number; ph?: number; w?: number; h?: number; vl?: number; vt?: number; vw?: number; vh?: number }): { visible: { l: number; t: number; w: number; h: number }; clipped: boolean } {
  const known = [g.vl, g.vt, g.vw, g.vh].every((x) => Number.isFinite(x)) && g.vw! > 0 && g.vh! > 0;
  const visible = known ? { l: g.vl!, t: g.vt!, w: g.vw!, h: g.vh! } : { l: -1e9, t: -1e9, w: 2e9, h: 2e9 }; // unknown: nothing is claimed to be outside
  const pw = Number.isFinite(g.pw) && g.pw! > 0 ? g.pw! : g.w!, ph = Number.isFinite(g.ph) && g.ph! > 0 ? g.ph! : g.h!;
  // a normal window has an invisible resize border of about 8-15 px (more at high DPI) that lies outside the screen when it is maximized: that is not clipping
  const tol = BORDER_TOLERANCE_PX;
  const clipped = known && (g.l! < visible.l - tol || g.t! < visible.t - tol || g.l! + pw > visible.l + visible.w + tol || g.t! + ph > visible.t + visible.h + tol);
  return { visible, clipped };
}
const isRefused = (s: unknown): s is Refused => typeof s === "string" && Object.prototype.hasOwnProperty.call(REASONS, s);

interface RawGrab { ok?: boolean; state?: string; ready?: boolean; session?: number; frame?: number; w?: number; h?: number; l?: number; t?: number; pw?: number; ph?: number; scale?: number; vl?: number; vt?: number; vw?: number; vh?: number; dpi?: number; mdpi?: number; ms?: number }
interface RawInfo { ok?: boolean; active?: boolean; session?: number; frame?: number; ageMs?: number; sameRect?: boolean; refusal?: string | null }

export interface CaptureOptions {
  /** a frame older than this is stale (default 1500 ms) */
  maxAgeMs?: number;
  /** the pause between the frames that must agree (default 90 ms) */
  gapMs?: number;
  /** frames tried before giving up on a window that will not settle (default 6) */
  maxFrames?: number;
  /** the whole look may take at most this long (default 3000 ms) */
  deadlineMs?: number;
  /** the capture is released after this long without use, even if nobody asked (default 20 s) */
  idleMs?: number;
  /** the first request compiles the capture code in the helper: it may take a few seconds */
  startTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CaptureStats {
  /** counters only: never a window name, never content */
  starts: number; grabs: number; ready: number; refused: Partial<Record<Refused, number>>; releases: number; active: boolean;
}

export class VisualCapture {
  private current: { hwnd: number; session: number } | null = null;
  private lastFrame: CaptureFrame | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private gen = 0;
  private releasing: Array<() => void> = [];
  private st: CaptureStats = { starts: 0, grabs: 0, ready: 0, refused: {}, releases: 0, active: false };
  private readonly maxAgeMs: number;
  private readonly gapMs: number;
  private readonly maxFrames: number;
  private readonly deadlineMs: number;
  private readonly idleMs: number;
  private readonly startTimeoutMs: number;

  constructor(private transport: CaptureTransport | undefined, private opts: CaptureOptions = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? 1500;
    this.gapMs = opts.gapMs ?? 90;
    this.maxFrames = opts.maxFrames ?? 6;
    this.deadlineMs = opts.deadlineMs ?? 3000;
    this.idleMs = opts.idleMs ?? 20_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 20_000;
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.opts.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms); }

  /** called whenever the capture is released (task end, cancel, idle, another window): whatever was derived from its pictures must go with it */
  onRelease(fn: () => void): void { this.releasing.push(fn); }

  /** is a capture in progress right now? (False means no pixels are held anywhere.) */
  active(): boolean { return this.current !== null; }
  stats(): CaptureStats { return { ...this.st, refused: { ...this.st.refused }, active: this.active() }; }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { void this.release(); }, this.idleMs);
    (this.idle as { unref?: () => void }).unref?.();
  }

  private refuse(state: Refused): Observation {
    this.st.refused[state] = (this.st.refused[state] ?? 0) + 1;
    return { ok: false, state, reason: REASONS[state] };
  }

  /**
   * Look at one window and return a settled frame, or the reason there is none. Only one look runs at a time (they queue). It starts the
   * capture when needed, takes successive frames until two agree, and stops trying at the frame limit or the deadline.
   * `live` is asked between frames: when it says false (the task was cancelled) the look stops at once and the capture is released.
   */
  observe(hwnd: number, live: () => boolean = () => true): Promise<Observation> {
    const run = this.chain.then(() => this.look(hwnd, live), () => this.look(hwnd, live));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async look(hwnd: number, live: () => boolean): Promise<Observation> {
    if (!this.transport) return this.refuse("unavailable");
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0) return this.refuse("gone");
    const started = this.now();
    let myGen = this.gen;
    try {
      if (!this.current || this.current.hwnd !== hwnd) {
        if (this.current) await this.release();
        if (!live()) return this.refuse("cancelled");
        const s = (await this.transport.send("capstart", hwnd, this.startTimeoutMs)) as { ok?: boolean; state?: string; session?: number } | null;
        if (!s || s.ok !== true || typeof s.session !== "number") return this.refuse(isRefused(s?.state) ? s!.state as Refused : "failed");
        this.current = { hwnd, session: s.session };
        this.lastFrame = null;
        this.st.starts++;
      }
      this.armIdle();
      myGen = ++this.gen; // from here on, a release() (cancel, idle, another window) ends THIS look
      let last: Refused = "not_ready";
      for (let i = 0; i < this.maxFrames; i++) {
        if (!live() || myGen !== this.gen) { await this.release(); return this.refuse("cancelled"); }
        if (i > 0) await this.sleep(this.gapMs);
        if (!live() || myGen !== this.gen) { await this.release(); return this.refuse("cancelled"); }
        const g = (await this.transport.send("capgrab", undefined, 8000)) as RawGrab | null;
        this.st.grabs++;
        if (g && g.state === "ready") {
          // "ready" must come with every fact that proves it; anything less is not ready
          if (g.ready === true && g.session === this.current?.session && typeof g.frame === "number" && Number.isFinite(g.w) && Number.isFinite(g.h) && Number.isFinite(g.l) && Number.isFinite(g.t)) {
            const frame: CaptureFrame = { session: g.session, frame: g.frame, hwnd, w: g.w!, h: g.h!, l: g.l!, t: g.t!, pw: Number.isFinite(g.pw) && g.pw! > 0 ? g.pw! : g.w!, ph: Number.isFinite(g.ph) && g.ph! > 0 ? g.ph! : g.h!, scale: Number.isFinite(g.scale) && g.scale! >= 1 && g.scale! <= 8 ? g.scale! : 1, ...visibleOf(g), dpi: Number.isFinite(g.dpi) && g.dpi! > 0 ? g.dpi! : 96, monitorDpi: Number.isFinite(g.mdpi) && g.mdpi! > 0 ? g.mdpi! : 96, ms: Number.isFinite(g.ms) ? g.ms! : 0, at: this.now() };
            this.lastFrame = frame;
            this.st.ready++;
            this.armIdle();
            return { ok: true, frame };
          }
          last = "failed";
          break;
        }
        last = isRefused(g?.state) ? g!.state as Refused : "failed";
        if (HARD.has(last)) { await this.release(); return this.refuse(last); }
        if (this.now() - started > this.deadlineMs) break;
      }
      // never settled: say so. It is NOT evidence that the window is empty.
      return this.refuse(last);
    } catch {
      await this.release();
      return this.refuse("unavailable");
    }
  }

  /** the capture is only ever released through here or through the transport: the lookup below needs the live session */
  session(): { hwnd: number; session: number } | null { return this.current ? { ...this.current } : null; }

  /** is this the latest frame and still young enough? (No call to the helper: the cheap half of the check.) */
  isFresh(f: CaptureFrame): boolean {
    return !!this.current && !!this.lastFrame && f.session === this.current.session && f.frame === this.lastFrame.frame && f.hwnd === this.current.hwnd && this.now() - f.at <= this.maxAgeMs;
  }

  /**
   * The thorough check, made right before a frame is acted on: the same session and frame, young enough, and the window is still there, in the
   * SAME place and size. Anything else is stale, with the reason in one fixed phrase.
   */
  async confirmFresh(f: CaptureFrame): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.isFresh(f)) return { ok: false, reason: STALE };
    if (!this.transport) return { ok: false, reason: REASONS.unavailable };
    try {
      const i = (await this.transport.send("capinfo", undefined, 3000)) as RawInfo | null;
      if (!i || i.ok !== true || i.active !== true || i.session !== f.session || i.frame !== f.frame) return { ok: false, reason: STALE };
      if (typeof i.refusal === "string") return { ok: false, reason: isRefused(i.refusal) ? REASONS[i.refusal] : REASONS.failed };
      if (i.sameRect !== true) return { ok: false, reason: "The window moved or changed size, so what I saw is out of date." };
      if (typeof i.ageMs !== "number" || i.ageMs < 0 || i.ageMs > this.maxAgeMs + 500) return { ok: false, reason: STALE };
      return { ok: true };
    } catch {
      return { ok: false, reason: REASONS.unavailable };
    }
  }

  /** Stop looking and free the bitmap. Safe to call any time and any number of times; asks the helper only when a capture exists. */
  async release(): Promise<void> {
    this.gen++;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    this.lastFrame = null;
    for (const fn of this.releasing) { try { fn(); } catch { /* wiping must never stop the release */ } }
    if (!this.current) return; // nothing was started here: do not wake the helper just to tell it so
    this.current = null;
    this.st.releases++;
    if (!this.transport) return;
    try { await this.transport.send("capstop", undefined, 3000); } catch { /* the helper being gone also frees the bitmap (it lives in its memory) */ }
  }
}
