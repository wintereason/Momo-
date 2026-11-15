/**
 * Waiting for the screen to change, instead of sleeping a fixed time and hoping.
 *
 *  - A ChangeSource (the helper's WinEvent hook) says WHICH kind of thing changed in WHICH window: window opened/closed/shown/hidden,
 *    foreground or focus moved, a menu or dialog started or ended, a name/value/state/selection changed. Handles only: never titles, text,
 *    pixels or UI trees. Events are in memory for a moment and then dropped.
 *  - Events are a hint to look NOW, never the answer: the caller's own `check` (a real read of the screen) always decides.
 *  - Events can be missing (hook off, helper restarting, dropped, delayed), so they are never the only thing waited on: while the source is
 *    unhealthy the wait polls, and even while healthy a slower poll still runs. Every wait has a hard timeout and reports it as such.
 */

export interface ChangeEvent { kind: string; root: number }

export interface ChangeSource {
  /** events are flowing right now (hook installed AND its message loop answered recently) */
  healthy(): boolean;
  /** the number of the latest batch of events */
  seq(): number;
  /** events after batch `since`: at once when there are some, else when some arrive, else (nothing) after `ms`. Never rejects. */
  next(since: number, ms: number): Promise<{ seq: number; events: ChangeEvent[] }>;
  /** ask for events to be delivered until the returned function is called (the hook is only on while someone waits) */
  acquire(): () => void;
}

export interface WaitOptions {
  timeoutMs: number;
  /** how often to look when events are not available (default 200 ms) */
  pollMs?: number;
  /** how often to look anyway while events ARE flowing, in case one was lost (default 600 ms) */
  fallbackMs?: number;
  /** after an event, let a burst finish before looking (default 40 ms) */
  settleMs?: number;
  source?: ChangeSource;
  /** which events matter for this wait (default: all) */
  relevant?: (e: ChangeEvent) => boolean;
  sleep?: (ms: number) => Promise<void>;
  live?: () => boolean;
}

export interface WaitResult<T> {
  value?: T;
  timedOut: boolean;
  cancelled: boolean;
  /** what ended the wait: the first look, an event, or the poll/timer */
  via: "immediate" | "event" | "poll";
  ms: number;
  looks: number;
}

/** Windows-wide kinds that matter whatever window is being watched; the rest only count from the watched window. */
const GLOBAL_KINDS = new Set(["fg", "menu", "dialog", "show", "hide", "min", "move"]);
export const relevantTo = (hwnd: number | undefined) => (e: ChangeEvent): boolean => GLOBAL_KINDS.has(e.kind) || hwnd === undefined || e.root === hwnd;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Look (`check`) until it returns something truthy, a change is not coming, or `timeoutMs` has passed.
 * The time budget counts the time asked for as well as the clock, so a test with an instant `sleep` runs the same number of looks.
 */
export async function waitFor<T>(check: () => Promise<T | false | null | undefined>, o: WaitOptions): Promise<WaitResult<T>> {
  const sleep = o.sleep ?? realSleep;
  const pollMs = o.pollMs ?? 200, fallbackMs = o.fallbackMs ?? 600, settleMs = o.settleMs ?? 40;
  const relevant = o.relevant ?? (() => true);
  const t0 = Date.now();
  let spent = 0, looks = 0, via: WaitResult<T>["via"] = "immediate";
  const elapsed = () => Math.max(Date.now() - t0, spent);
  const done = (r: Partial<WaitResult<T>>): WaitResult<T> => ({ timedOut: false, cancelled: false, via, ms: elapsed(), looks, ...r });
  // a source that throws is just a source that is not there: the wait polls
  const safe = <R,>(fn: () => R, fallback: R): R => { try { return fn(); } catch { return fallback; } };
  const src0 = o.source;
  const release = src0 ? safe(() => src0.acquire(), undefined) : undefined;
  try {
    for (;;) {
      if (o.live && !o.live()) return done({ cancelled: true });
      const s0 = src0 ? safe(() => src0.seq(), 0) : 0;
      looks++;
      const v = await check();
      if (v) return done({ value: v });
      if (o.live && !o.live()) return done({ cancelled: true });
      const left = o.timeoutMs - elapsed();
      if (left <= 0) return done({ timedOut: true });
      const src = src0;
      if (src && safe(() => src.healthy(), false)) {
        // anything that happened while that look was running is looked at straight away
        let cur = s0, woke = false;
        const late = await src.next(cur, 0).catch(() => ({ seq: cur, events: [] as ChangeEvent[] }));
        if (late.events.some(relevant)) woke = true;
        cur = late.seq;
        const until = Math.min(left, fallbackMs);
        const t1 = Date.now();
        while (!woke && Date.now() - t1 < until) {
          const got = await src.next(cur, until - (Date.now() - t1)).catch(() => ({ seq: cur, events: [] as ChangeEvent[] }));
          cur = got.seq;
          if (got.events.some(relevant)) woke = true;
          else if (got.events.length === 0) break; // quiet until the slower fallback look
        }
        spent += Math.min(until, Date.now() - t1);
        via = woke ? "event" : "poll";
        if (woke) { await sleep(settleMs); spent += settleMs; }
      } else {
        const ms = Math.min(pollMs, left);
        await sleep(ms); spent += ms;
        via = "poll";
      }
    }
  } finally {
    release?.();
  }
}
