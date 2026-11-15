import type { Acted } from "../../shared/ports";
export type { Acted };

/**
 * Recovery foundation (phase 4a): ONE vocabulary for "what went wrong" and ONE answer to "did anything reach the app?".
 *
 * Nothing here retries anything. It only names failures and records how far an action got, so that the later phases (re-observation,
 * the retry policy, the action ledger) decide from facts instead of from sentences. Pure functions: no I/O, no state.
 */

/** Everything that can go wrong with a step, by what it means for what Momo may do next. */
export const FAILURE_KINDS = [
  "target_not_found",   // nothing matches what was asked for (no such window, field or control)
  "target_moved",       // it was there, but not where (or what) it was when it was read
  "target_gone",        // the window or control has closed or disappeared
  "target_disabled",    // it is there but cannot be used right now (disabled, read-only)
  "covered",            // another window is in front of the spot
  "wrong_window",       // the keyboard or the front window is somewhere other than expected
  "popup_interrupted",  // a dialog or popup got in the way
  "app_unresponsive",   // the application is frozen (or did not answer in time and looks frozen)
  "timeout",            // no answer in time, and nothing says the app is frozen
  "uia_failed",         // UI Automation could not read or act
  "input_failed",       // the real mouse or keyboard did not go through
  "partial",            // it happened in part
  "unverified",         // it ran, but the result could not be confirmed
  "ambiguous",          // several things match: only the user can pick
  "needs_confirmation", // the user must approve first
  "blocked_by_policy",  // Momo never does this (a password field, a refused shortcut)
  "unavailable",        // this kind of action is off or not available here (Human-like control off)
  "invalid_request",    // the request itself was malformed
  "user_interrupted",   // the user took over: Esc, mouse, keyboard
  "cancelled",          // the task was cancelled
  "unknown",            // not understood: always treated as unsafe to repeat
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * Did the action reach the application?
 *  - "no":    nothing was sent. The target was refused or never reached; repeating cannot double anything.
 *  - "maybe": input WAS being sent when it failed, or it is not known (a thrown error after a click may already have gone through). Never repeat blindly.
 *  - "yes":   input was delivered. Whether it had the effect wanted is a separate question (`unverified`).
 */
const ORDER: Record<Acted, number> = { no: 0, maybe: 1, yes: 2 };
/** the stronger of two answers: once something was sent, it stays sent */
export const maxActed = (a: Acted | undefined, b: Acted | undefined): Acted => (ORDER[a ?? "no"] >= ORDER[b ?? "no"] ? a ?? "no" : b ?? "no");
export const isActed = (v: unknown): v is Acted => v === "no" || v === "maybe" || v === "yes";

/** A failure as the rest of the system sees it. */
export interface Failure { kind: FailureKind; acted: Acted }

/** Facts gathered by re-observing (filled in by later phases; every field optional, absent = not known). */
export interface Evidence {
  windowExists?: boolean;
  windowHung?: boolean;
  windowMinimized?: boolean;
  /** the window that has the keyboard focus is the one expected */
  foregroundIsTarget?: boolean;
  /** a window that was not there before the action */
  newWindowAppeared?: boolean;
  /** the window has a dialog of its own open that blocks it (an enabled owned popup) */
  windowBlockedByDialog?: boolean;
}

/** What the pointer layer (the real mouse and keyboard) calls its refusals. */
const POINTER_KINDS: Record<string, FailureKind> = {
  user_moved: "user_interrupted",
  stopped: "user_interrupted",
  cancelled: "cancelled",
  covered: "covered",
  moved: "target_moved",
  changed: "target_moved",
  gone: "target_gone",
  password: "blocked_by_policy",
  offscreen: "target_moved",
  cursor_refused: "input_failed",
  focus_changed: "wrong_window",
  failed: "input_failed",
};

/**
 * What the tools say, in words. Ordered: the first match wins, so the specific ones come first.
 * (Tools still return a sentence for the person and the planner; the kind is derived from it until each tool names its own.)
 */
const SENTENCES: Array<[RegExp, FailureKind]> = [
  [/^cancelled$/i, "cancelled"],
  [/\b(you pressed esc|you moved the mouse|you used the (keyboard|mouse)|left it to you)\b/i, "user_interrupted"],
  [/took the keyboard|wrong window|different program|belongs to a different/i, "wrong_window"],
  [/\bpassword\b|\bnever (type|touch|select|press|click)\b|\bI will not press\b|\bI won'?t (touch|click|press)\b|can'?t identify .* exactly/i, "blocked_by_policy"],
  [/human-like control|isn'?t available in this build|not available here|needs human/i, "unavailable"],
  [/^invalid arguments|there is no tool called|that isn'?t a valid|say which control|same thing|is not a website name|does not look like a normal web address/i, "invalid_request"],
  [/another window is in front|in front of that spot|is covered|covers it/i, "covered"],
  [/took the keyboard|wrong window|different program|belongs to a different/i, "wrong_window"],
  [/\b(asking|may be asking|a dialog|popup|pop-up)\b/i, "popup_interrupted"],
  [/\b(isn'?t open any more|has closed|closed,? so|is gone|window is gone|no longer (open|there|exists?)|gone\.?$)/i, "target_gone"],
  [/\b(disabled|read-only|greyed)\b/i, "target_disabled"],
  [/\b(moved while|has changed|have changed|changed since|not the control i meant|no longer where|not on any screen|where it was)\b|\bchanged, so (nothing|the picture)|is minimized, so none/i, "target_moved"],
  [/could not bring .* to the front|couldn'?t bring .* to the front/i, "wrong_window"],
  [/did not check out/i, "unverified"],
  [/could not read|did not expose|does not tell windows|could not tell where that window/i, "uia_failed"],
  [/did not go through|wouldn'?t move the pointer|would not move the pointer|input .* failed/i, "input_failed"],
  [/didn'?t answer in time|took too long|timed? ?out|no answer in time/i, "timeout"],
  [/couldn'?t read|could not look inside|couldn'?t let me|windows wouldn'?t let me|ui automation/i, "uia_failed"],
  [/\bcould not be confirmed|could not confirm|not verified|can'?t confirm\b/i, "unverified"],
  [/\bwhich one\b|several match|more than one/i, "ambiguous"],
  [/\b(no (open )?(window|field|control|item|drive|folder|app|file|match|tab|text field|installed app)|[a-z]+ accounts were found|not found|no "[^"]*" (field|control|item|window|button|tab)|no such|nothing (matches|named)|isn'?t there|couldn'?t find|could not (find|see)|can'?t tell which window|does not exist|no open tab)\b/i, "target_not_found"],
];

/** Name a failure. `pointerReason` is what the real mouse/keyboard said, when it said something: it is exact, so it wins over the sentence. */
export function classifyFailure(input: { reason?: string; pointerReason?: string; evidence?: Evidence }): FailureKind {
  const ev = input.evidence;
  const pr = input.pointerReason ? POINTER_KINDS[input.pointerReason] : undefined;
  // what the person did, or what was cancelled, is never re-labelled by anything else
  if (pr === "user_interrupted" || pr === "cancelled") return pr;
  const text = (input.reason ?? "").trim();
  let kind: FailureKind = pr ?? "unknown";
  if (!pr) { for (const [re, k] of SENTENCES) { if (re.test(text)) { kind = k; break; } } } // the input layer's own word is exact; sentences are only for tools that speak in sentences
  // facts beat words
  if (ev) {
    if (ev.windowExists === false && kind !== "user_interrupted" && kind !== "cancelled" && kind !== "blocked_by_policy") return "target_gone";
    if (ev.windowHung === true && (kind === "timeout" || kind === "uia_failed" || kind === "input_failed" || kind === "unknown" || kind === "unverified")) return "app_unresponsive";
    if (ev.windowBlockedByDialog === true && (kind === "timeout" || kind === "uia_failed" || kind === "input_failed" || kind === "unknown" || kind === "unverified" || kind === "target_moved" || kind === "covered" || kind === "wrong_window")) return "popup_interrupted";
    if (ev.newWindowAppeared === true && (kind === "unknown" || kind === "unverified" || kind === "target_moved" || kind === "covered" || kind === "timeout" || kind === "input_failed" || kind === "uia_failed")) return "popup_interrupted";
    if (ev.foregroundIsTarget === false && (kind === "unknown" || kind === "input_failed" || kind === "unverified")) return "wrong_window";
  }
  return kind;
}

/** kinds that are decided before anything is sent: refusing, not trying */
const BEFORE_ANY_INPUT = new Set<FailureKind>([
  "target_not_found", "target_gone", "target_disabled", "ambiguous", "needs_confirmation", "blocked_by_policy", "unavailable", "invalid_request", "cancelled",
]);

/**
 * How far did the action get? Facts from the input layer win (`delivered`: the strongest answer seen while the step ran).
 * Without them the answer is conservative: a refusal decided up front is "no"; a step that changes things and failed in some other way is "maybe".
 * A step that only looks (risk "read" / "sensitive_read") never changes anything: "no".
 */
export function deriveActed(input: { kind: FailureKind; risk?: string; delivered?: Acted; explicit?: Acted }): Acted {
  if (input.explicit) return maxActed(input.explicit, input.delivered);
  if (input.delivered && input.delivered !== "no") return input.delivered;
  if (input.risk === "read" || input.risk === "sensitive_read") return "no";
  if (BEFORE_ANY_INPUT.has(input.kind)) return "no";
  if (input.delivered === "no") {
    // the input layer says nothing was sent; for the real mouse and keyboard that is exact
    return "no";
  }
  // a step that changes things, failed, and nobody can say whether it got through
  return "maybe";
}

/** Is it SAFE to say a repeat could not double anything? Only when nothing was sent. (Whether to repeat is a later phase's decision.) */
export const nothingWasSent = (f: Failure): boolean => f.acted === "no";

/** kinds that mean the user (or the app) called it off: nothing may ever be retried after these */
export const isTerminal = (k: FailureKind): boolean => k === "user_interrupted" || k === "cancelled" || k === "blocked_by_policy";

/** One normalised failure for a tool's refusal. */
export function describeFailure(input: { reason?: string; pointerReason?: string; evidence?: Evidence; risk?: string; delivered?: Acted; explicitActed?: Acted; explicitKind?: FailureKind }): Failure {
  const kind = input.explicitKind ?? classifyFailure({ reason: input.reason, pointerReason: input.pointerReason, evidence: input.evidence });
  return { kind, acted: deriveActed({ kind, risk: input.risk, delivered: input.delivered, explicit: input.explicitActed }) };
}

/**
 * A fixed plain-words description for each kind. This (and not the tool's own sentence, which can carry a window title, a label or a path) is what
 * the action journal keeps as the "reason": it cannot contain anything from the screen.
 */
export const KIND_PHRASE: Record<FailureKind, string> = {
  target_not_found: "nothing matched what was asked for",
  target_moved: "the target was not where or what it had been",
  target_gone: "the window or control had closed",
  target_disabled: "the target could not be used right now",
  covered: "another window was in front of the spot",
  wrong_window: "the keyboard or front window was somewhere else",
  popup_interrupted: "a dialog or popup got in the way",
  app_unresponsive: "the application was not responding",
  timeout: "no answer in time",
  uia_failed: "UI Automation could not read or act",
  input_failed: "the mouse or keyboard input did not go through",
  partial: "it happened only in part",
  unverified: "it ran but could not be confirmed",
  ambiguous: "several things matched",
  needs_confirmation: "the user had to approve first",
  blocked_by_policy: "Momo never does this",
  unavailable: "this kind of action was not available",
  invalid_request: "the request was malformed",
  user_interrupted: "the user took over",
  cancelled: "the task was cancelled",
  unknown: "the failure was not understood",
};
