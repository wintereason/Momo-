import { describe, expect, it } from "vitest";
import { INTENT_RETRY_BUDGET, TASK_RETRY_BUDGET, decideRetry, refreshArgs, type RetryInput } from "./policy";
import { FAILURE_KINDS, type Acted, type FailureKind } from "./taxonomy";

const base: RetryInput = { kind: "uia_failed", acted: "no", risk: "read", intentRetries: 0, taskRetries: 0, mayHaveRun: false, live: true, interrupted: false };
const d = (o: Partial<RetryInput>) => decideRetry({ ...base, ...o });

describe("when a retry is allowed", () => {
  it("nothing was sent, a read, a failure a fresh look can fix, budgets free: yes", () => {
    expect(d({})).toMatchObject({ retry: true });
  });
  it("these kinds are retryable (when nothing was sent): target_moved, wrong_window, uia_failed, timeout, input_failed", () => {
    for (const kind of ["target_moved", "wrong_window", "uia_failed", "timeout", "input_failed"] as FailureKind[]) expect(d({ kind, risk: "reversible" }).retry, kind).toBe(true);
  });
  it("a moved target is found again without its old position; anything else keeps its arguments as they were", () => {
    expect(d({ kind: "target_moved" })).toMatchObject({ retry: true, refresh: "drop_position" });
    expect(d({ kind: "uia_failed" })).toMatchObject({ retry: true, refresh: "none" });
  });
});

describe("when a retry is NEVER allowed", () => {
  it("anything that may have reached the application", () => {
    for (const acted of ["maybe", "yes"] as Acted[]) for (const kind of FAILURE_KINDS) expect(d({ acted, kind }).retry, `${acted}/${kind}`).toBe(false);
  });
  it("a consequential action, whatever the failure", () => {
    for (const kind of FAILURE_KINDS) expect(d({ risk: "consequential", kind }).retry, kind).toBe(false);
  });
  it("a failure a fresh look cannot fix", () => {
    for (const kind of ["target_not_found", "target_gone", "target_disabled", "covered", "popup_interrupted", "app_unresponsive", "partial", "unverified", "ambiguous", "needs_confirmation", "blocked_by_policy", "unavailable", "invalid_request", "user_interrupted", "cancelled", "unknown"] as FailureKind[]) {
      expect(d({ kind, risk: "reversible" }).retry, kind).toBe(false);
    }
  });
  it("the user's takeover or a cancel, in any form", () => {
    expect(d({ live: false }).retry).toBe(false);
    expect(d({ interrupted: true }).retry).toBe(false);
    expect(d({ kind: "user_interrupted" }).retry).toBe(false);
    expect(d({ kind: "cancelled" }).retry).toBe(false);
  });
  it("a confirmed effect, a frozen window, a dialog waiting, or the same call having already run", () => {
    expect(d({ verdict: "verified" }).retry).toBe(false);
    expect(d({ windowHung: true }).retry).toBe(false);
    expect(d({ windowBlocked: true }).retry).toBe(false);
    expect(d({ mayHaveRun: true }).retry).toBe(false);
  });
  it("past the budgets: one retry per call, two per task, shared", () => {
    expect(INTENT_RETRY_BUDGET).toBe(1);
    expect(TASK_RETRY_BUDGET).toBe(2);
    expect(d({ intentRetries: 1 }).retry).toBe(false);
    expect(d({ taskRetries: 2 }).retry).toBe(false);
    expect(d({ taskRetries: 1 }).retry).toBe(true);
  });
});

describe("exhaustive: every combination obeys the invariants", () => {
  it("whenever it says retry, ALL the conditions hold", () => {
    let retries = 0, total = 0;
    for (const kind of FAILURE_KINDS) for (const acted of ["no", "maybe", "yes"] as Acted[]) for (const risk of ["read", "sensitive_read", "reversible", "consequential"])
      for (const verdict of [undefined, "verified", "absent", "unconfirmed"] as const) for (const intentRetries of [0, 1]) for (const taskRetries of [0, 1, 2])
        for (const mayHaveRun of [false, true]) for (const live of [true, false]) for (const interrupted of [false, true]) for (const windowHung of [false, true]) for (const windowBlocked of [false, true]) {
          total++;
          const r = decideRetry({ kind, acted, risk, verdict, intentRetries, taskRetries, mayHaveRun, live, interrupted, windowHung, windowBlocked });
          if (!r.retry) continue;
          retries++;
          expect(acted).toBe("no");
          expect(risk).not.toBe("consequential");
          expect(["target_moved", "wrong_window", "uia_failed", "timeout", "input_failed"]).toContain(kind);
          expect(verdict).not.toBe("verified");
          expect(intentRetries).toBeLessThan(INTENT_RETRY_BUDGET);
          expect(taskRetries).toBeLessThan(TASK_RETRY_BUDGET);
          expect(mayHaveRun || !live || interrupted || windowHung || windowBlocked).toBe(false);
        }
    expect(total).toBeGreaterThan(10000);
    expect(retries).toBeGreaterThan(0);
  });
});

describe("fresh target resolution", () => {
  it("drops positions only; the user's choices and the request stay", () => {
    const a = { label: "Save", window: "Notes", _hwnd: 5, _rid: "1.2", _box: "10,20,30,40", _fb: "x", _tb: "y", open: true };
    expect(refreshArgs(a, "drop_position")).toEqual({ label: "Save", window: "Notes", _hwnd: 5, _rid: "1.2", open: true });
    expect(refreshArgs(a, "none")).toEqual(a);
  });
  it("never mutates what it was given", () => {
    const a = { _box: "1,2,3,4", label: "x" };
    refreshArgs(a, "drop_position");
    expect(a).toEqual({ _box: "1,2,3,4", label: "x" });
  });
});
