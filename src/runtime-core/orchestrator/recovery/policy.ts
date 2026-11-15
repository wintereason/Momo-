import { isTerminal, type Acted, type FailureKind } from "./taxonomy";

/**
 * The retry policy (phase 4c): ONE place that decides whether a failed step may be tried again, and how. Pure: no I/O.
 *
 * A retry is the exception. It needs ALL of these:
 *  - nothing was sent to the application (`acted === "no"`): a retry can then not double anything;
 *  - the step only reads or is reversible (never a consequential or submitting action);
 *  - the failure is of a kind that a fresh look can fix (the target moved, the keyboard was elsewhere, UI Automation hiccupped, a read timed out);
 *  - the journal does not say the same call may already have run;
 *  - the user did not take over and the task is not cancelled;
 *  - the budgets allow it: ONE retry per call, TWO per task (shared by every tool).
 * And it is never a repeat of the old call: the target is re-resolved (see `refreshArgs`) and the result is verified like any other.
 */

/** one retry per call, two per task */
export const INTENT_RETRY_BUDGET = 1;
export const TASK_RETRY_BUDGET = 2;

/** kinds that a fresh look can fix when nothing was sent. (A window in the way is handled where the window can be raised, inside the tool.) */
const RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>(["target_moved", "wrong_window", "uia_failed", "timeout", "input_failed"]);

export interface RetryInput {
  kind: FailureKind;
  acted: Acted;
  risk: string;
  /** what the read-only look (phase 4b) found */
  verdict?: "verified" | "absent" | "unconfirmed";
  /** retries already made for this exact call / in this task */
  intentRetries: number;
  taskRetries: number;
  /** the journal says an identical call may already have run (and no look showed it did not) */
  mayHaveRun: boolean;
  live: boolean;
  interrupted: boolean;
  /** a window is frozen or blocked by a dialog right now */
  windowHung?: boolean;
  windowBlocked?: boolean;
}

export type RetryDecision = { retry: true; why: string; refresh: "none" | "drop_position" } | { retry: false; why: string };

const no = (why: string): RetryDecision => ({ retry: false, why });

export function decideRetry(i: RetryInput): RetryDecision {
  if (!i.live || i.interrupted) return no("cancelled or taken over");
  if (isTerminal(i.kind)) return no("the user, a cancel or a safety rule ended it");
  if (i.verdict === "verified") return no("it is confirmed");
  if (i.risk === "consequential") return no("a consequential action is never repeated automatically");
  if (i.acted !== "no") return no("input may already have reached the application");
  if (i.mayHaveRun) return no("the same call may already have run");
  if (i.windowHung) return no("the window is not responding");
  if (i.windowBlocked) return no("a dialog is waiting for an answer");
  if (!RETRYABLE.has(i.kind)) return no("this kind of failure is not fixed by trying again");
  if (i.intentRetries >= INTENT_RETRY_BUDGET) return no("this call was already retried once");
  if (i.taskRetries >= TASK_RETRY_BUDGET) return no("this task has used its retries");
  return { retry: true, why: "nothing was sent and a fresh look may fix it", refresh: i.kind === "target_moved" ? "drop_position" : "none" };
}

/**
 * The arguments for the retry. Positions (`_box`) go stale when a target moves, so they are dropped and the target is found again from what
 * was asked for (its label, and its runtime id if that still exists). Everything the user chose stays. Nothing is added.
 */
export function refreshArgs(args: Record<string, unknown>, refresh: "none" | "drop_position"): Record<string, unknown> {
  if (refresh === "none") return { ...args };
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!/^_(box|fb|tb)$/.test(k)) next[k] = v;
  return next;
}
