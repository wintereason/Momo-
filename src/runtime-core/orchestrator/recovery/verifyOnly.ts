import type { DesktopSnapshot } from "../../desktop";
import type { UiReadResult, WindowState } from "../../shared/ports";
import type { Verifier } from "../../verifier";
import type { EvidenceItem } from "./journal";
import type { Evidence } from "./taxonomy";

/**
 * Verify-only recovery (phase 4b). When an action MAY have run, or ran and could not be confirmed, Momo LOOKS: it asks Windows what is true
 * now, read-only, and says what it saw. It never repeats the action, never clicks, types or presses anything, and never calls the tool's
 * own `run` again: the only things it is given are the four reading calls below (a type that has no way to act), so repeating is not
 * merely forbidden, it is impossible from here.
 */

/** The only things recovery may do: look. */
export interface ReadOnlyView {
  /** false once the task was cancelled (Esc, Cancel, the user taking the mouse): no further looking happens */
  live(): boolean;
  /** the user took over the mouse or keyboard */
  interrupted(): boolean;
  sleep(ms: number): Promise<void>;
  windowState(hwnd: number): Promise<WindowState>;
  windows(): Promise<DesktopSnapshot>;
  readWindow(hwnd: number): Promise<UiReadResult>;
  /** the visible menus, dialogs and popups right now (handles and kinds only); null when it cannot be asked */
  popups?(): Promise<import("../../shared/ports").TransientWindow[] | null>;
  verifier: Verifier;
}

/** Non-sensitive handles of what the step acted on (window numbers, a control's runtime id): enough to look at it again. Never names or text. */
export interface StepTarget { hwnd: number; pid: number; rid?: string }

/** What a tool's own `confirm` says after looking: true = the effect is really there, false = it is really absent, null = cannot tell. */
export interface Confirmation { verified: boolean | null; evidence: EvidenceItem[] }

export interface VerifyResult {
  /** at least one read-only look was made */
  observed: boolean;
  /** stopped because the task was cancelled or the user took over (nothing more was done) */
  cancelled: boolean;
  /** "verified" only with positive evidence from a real check; "absent" when a real check found the effect missing; otherwise "unconfirmed" */
  verdict: "verified" | "absent" | "unconfirmed";
  evidence: EvidenceItem[];
  /** facts for classifying the failure (hung, still there, ...): only what was actually observed */
  facts: Evidence;
}

type ConfirmFn = (target: StepTarget | undefined, view: ReadOnlyView) => Promise<Confirmation>;

const stopped = (v: ReadOnlyView): boolean => { try { return !v.live() || v.interrupted(); } catch { return true; } };

export async function verifyOnly(input: { target?: StepTarget; /** the window to watch (hung / gone / blocked) when the step names none of its own; never handed to the tool's check */ watch?: StepTarget; confirm?: ConfirmFn; view: ReadOnlyView; /** the windows that existed before the step: anything else is a window that appeared during it */ baseline?: ReadonlySet<number> }): Promise<VerifyResult> {
  const { view, target } = input;
  const result: VerifyResult = { observed: false, cancelled: false, verdict: "unconfirmed", evidence: [], facts: {} };
  const halt = (): VerifyResult => { result.cancelled = true; result.verdict = "unconfirmed"; return result; };

  if (stopped(view)) return { ...halt(), evidence: [{ kind: "observation_skipped", ok: null }] };

  // 1) what Windows says about the window the step acted on
  const seen = target ?? input.watch;
  if (seen && Number.isSafeInteger(seen.hwnd) && seen.hwnd > 0) {
    try {
      const s = await view.windowState(seen.hwnd);
      result.observed = true;
      result.facts.windowExists = s.exists;
      result.evidence.push({ kind: "window_exists", ok: s.exists });
      if (typeof s.hung === "boolean") { result.facts.windowHung = s.hung; result.evidence.push({ kind: "window_hung", ok: s.hung }); }
      if (typeof s.modal === "boolean") { result.facts.windowBlockedByDialog = s.modal; result.evidence.push({ kind: "window_modal", ok: s.modal }); }
      if (s.exists) result.facts.windowMinimized = s.minimized;
    } catch { result.evidence.push({ kind: "observation_failed", ok: null }); }
    if (stopped(view)) return { ...halt(), evidence: result.evidence };
  }

  // 1b) did a window appear while the step ran (a dialog, a popup, a new app)? Names are never kept: only how many.
  let listed = false;
  if (input.baseline) {
    try {
      const snap = await view.windows();
      listed = true; result.observed = true;
      const fresh = snap.windows.filter((w) => !w.isMomo && !input.baseline!.has(w.hwnd) && !!String(w.title ?? "").trim()).length;
      result.facts.newWindowAppeared = fresh > 0;
      result.evidence.push({ kind: "new_windows", ok: fresh > 0, n: fresh });
    } catch { result.evidence.push({ kind: "observation_failed", ok: null }); }
    if (stopped(view)) return { ...halt(), observed: result.observed, evidence: result.evidence };
  }

  // 2) the tool's own way of telling whether its effect is there, if it has one
  if (input.confirm) {
    // a frozen window cannot answer a question about its content: do not ask it (and do not wait on it)
    if (result.facts.windowHung === true) {
      result.evidence.push({ kind: "observation_skipped", ok: null });
      return result;
    }
    try {
      const c = await input.confirm(target, view);
      result.observed = true;
      for (const e of c.evidence ?? []) result.evidence.push(e);
      if (stopped(view)) return { ...halt(), observed: true, evidence: result.evidence };
      // "verified" needs a check that said so AND positive evidence behind it: a bare claim is not enough
      if (c.verified === true && (c.evidence ?? []).some((e) => e.ok === true)) result.verdict = "verified";
      else if (c.verified === false && (c.evidence ?? []).some((e) => e.ok === false)) result.verdict = "absent";
    } catch { result.evidence.push({ kind: "observation_failed", ok: null }); }
    return result;
  }

  // 3) no probe for this kind of step: all that can be said is what the desktop looks like; that is not evidence of the effect
  if (!listed) {
    try {
      const snap = await view.windows();
      result.observed = true;
      result.evidence.push({ kind: "windows_listed", ok: null, n: snap.windows.length });
    } catch { result.evidence.push({ kind: "observation_failed", ok: null }); }
  }
  result.evidence.push({ kind: "no_probe", ok: null });
  if (stopped(view)) return { ...halt(), observed: result.observed, evidence: result.evidence };
  return result;
}
