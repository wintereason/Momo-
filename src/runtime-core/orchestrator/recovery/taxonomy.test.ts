import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FAILURE_KINDS, classifyFailure, deriveActed, describeFailure, isActed, isTerminal, maxActed, nothingWasSent, type FailureKind } from "./taxonomy";

describe("the failure vocabulary", () => {
  it("is a fixed, duplicate-free list that ends in 'unknown' (what is not understood is never assumed safe)", () => {
    expect(new Set(FAILURE_KINDS).size).toBe(FAILURE_KINDS.length);
    expect(FAILURE_KINDS[FAILURE_KINDS.length - 1]).toBe("unknown");
    for (const k of ["target_moved", "target_gone", "target_disabled", "covered", "wrong_window", "popup_interrupted", "app_unresponsive", "uia_failed", "input_failed", "partial", "unverified", "user_interrupted", "cancelled", "ambiguous"] as const) expect(FAILURE_KINDS).toContain(k);
  });
});

describe("classifying what the real mouse and keyboard report (exact: they win over any sentence)", () => {
  const table: Array<[string, FailureKind]> = [
    ["user_moved", "user_interrupted"], ["stopped", "user_interrupted"], ["cancelled", "cancelled"], ["covered", "covered"], ["moved", "target_moved"],
    ["changed", "target_moved"], ["gone", "target_gone"], ["password", "blocked_by_policy"], ["offscreen", "target_moved"], ["cursor_refused", "input_failed"],
    ["focus_changed", "wrong_window"], ["failed", "input_failed"],
  ];
  for (const [pr, kind] of table) it(`${pr} -> ${kind}`, () => expect(classifyFailure({ pointerReason: pr })).toBe(kind));
  it("an unknown pointer reason falls back to the sentence, then to 'unknown'", () => {
    expect(classifyFailure({ pointerReason: "weird", reason: "The window closed, so I stopped." })).toBe("target_gone");
    expect(classifyFailure({ pointerReason: "weird", reason: "???" })).toBe("unknown");
  });
  it("the user's takeover or a cancel is never re-labelled by a sentence or by evidence", () => {
    expect(classifyFailure({ pointerReason: "user_moved", reason: "That window isn't open any more.", evidence: { windowExists: false } })).toBe("user_interrupted");
    expect(classifyFailure({ pointerReason: "cancelled", evidence: { windowHung: true } })).toBe("cancelled");
  });
  it("a generic 'failed' from the input layer is not guessed into something else by a sentence", () => {
    expect(classifyFailure({ pointerReason: "failed", reason: "That window isn't open any more." })).toBe("input_failed");
  });
});

describe("classifying what the tools say", () => {
  const cases: Array<[string, FailureKind]> = [
    ["cancelled", "cancelled"],
    ["You pressed Esc, so I stopped.", "user_interrupted"],
    ["You moved the mouse, so I stopped and left it to you.", "user_interrupted"],
    ["I never type into password fields.", "blocked_by_policy"],
    ["That is a password field, and I never touch those. Nothing was clicked.", "blocked_by_policy"],
    ["I will not press win+l: it could lock the PC.", "blocked_by_policy"],
    ["I can't identify that control exactly, so I won't click it.", "blocked_by_policy"],
    ["This needs Human-like control (Settings → General): it uses the real mouse and keyboard, and that is off. Nothing was done.", "unavailable"],
    ["Selecting a field isn't available in this build.", "unavailable"],
    ["Invalid arguments: label Required.", "invalid_request"],
    ['There is no tool called "x".', "invalid_request"],
    ["Another window is in front of that spot, so I did not click it. Look at the screen again.", "covered"],
    ["Another window took the keyboard, so I stopped.", "wrong_window"],
    ["That window now belongs to a different program, so I won't touch it.", "wrong_window"],
    ["That window isn't open any more.", "target_gone"],
    ["The window closed, so I stopped. Nothing further was done.", "target_gone"],
    ["That window is gone.", "target_gone"],
    ['"Search" is disabled right now.', "target_disabled"],
    ['"Name" is read-only.', "target_disabled"],
    ["The window moved while I was aiming, so I stopped. Look at the screen again.", "target_moved"],
    ["What was under the pointer was not the control I meant any more, so I did not click.", "target_moved"],
    ["That spot is not on any screen, so I did not go there.", "target_moved"],
    ["The mouse or keyboard action did not go through.", "input_failed"],
    ["Windows would not move the pointer there (another program may be holding it), so I did nothing.", "input_failed"],
    ["Windows didn't answer in time", "timeout"],
    ['Could not look inside "Settings" (invalid window).', "uia_failed"],
    ["Windows wouldn't let me do that", "uia_failed"],
    ["Clicked it but the effect could not be confirmed.", "unverified"],
    ['No open window matches "zzz".', "target_not_found"],
    ['No "Find" field in "Settings".', "target_not_found"],
    ["It may be asking something: a dialog appeared.", "popup_interrupted"],
  ];
  for (const [reason, kind] of cases) it(`"${reason.slice(0, 70)}" -> ${kind}`, () => expect(classifyFailure({ reason })).toBe(kind));
  it("something nobody recognises is 'unknown', never a guess", () => {
    expect(classifyFailure({ reason: "Flux capacitor misaligned" })).toBe("unknown");
    expect(classifyFailure({})).toBe("unknown");
    expect(classifyFailure({ reason: "" })).toBe("unknown");
  });
});

describe("facts beat words", () => {
  it("a window that is no longer there makes it target_gone, whatever the sentence said", () => {
    expect(classifyFailure({ reason: "Windows didn't answer in time", evidence: { windowExists: false } })).toBe("target_gone");
    expect(classifyFailure({ reason: "Flux", evidence: { windowExists: false } })).toBe("target_gone");
  });
  it("a hung window turns a timeout, a UI Automation failure, an input failure or an unknown into app_unresponsive", () => {
    for (const reason of ["Windows didn't answer in time", 'Could not look inside "x" (y).', "The mouse or keyboard action did not go through.", "Flux", "could not be confirmed"]) {
      expect(classifyFailure({ reason, evidence: { windowHung: true } }), reason).toBe("app_unresponsive");
    }
  });
  it("...but not a refusal decided up front", () => {
    expect(classifyFailure({ reason: "I never type into password fields.", evidence: { windowHung: true } })).toBe("blocked_by_policy");
    expect(classifyFailure({ reason: 'No open window matches "x".', evidence: { windowHung: true } })).toBe("target_not_found");
  });
  it("a new window after an unexplained failure points at a popup", () => {
    expect(classifyFailure({ reason: "Flux", evidence: { newWindowAppeared: true } })).toBe("popup_interrupted");
    expect(classifyFailure({ reason: "Another window is in front of that spot.", evidence: { newWindowAppeared: true } })).toBe("popup_interrupted");
  });
  it("the keyboard being elsewhere points at the wrong window", () => {
    expect(classifyFailure({ reason: "Flux", evidence: { foregroundIsTarget: false } })).toBe("wrong_window");
  });
  it("absent evidence changes nothing (not known is not 'false')", () => {
    expect(classifyFailure({ reason: "Windows didn't answer in time", evidence: {} })).toBe("timeout");
    expect(classifyFailure({ reason: "Windows didn't answer in time", evidence: { windowHung: false, windowExists: true } })).toBe("timeout");
  });
});

describe("a dialog blocking the window (4d)", () => {
  it("a window with a dialog of its own open turns an unexplained timeout / UIA / input failure into popup_interrupted", () => {
    for (const reason of ["Windows didn't answer in time", 'Could not look inside "x" (y).', "The mouse or keyboard action did not go through.", "Flux"]) {
      expect(classifyFailure({ reason, evidence: { windowBlockedByDialog: true } }), reason).toBe("popup_interrupted");
    }
  });
  it("a new window after a timeout or an input failure points at a popup too", () => {
    for (const reason of ["Windows didn't answer in time", "The mouse or keyboard action did not go through."]) expect(classifyFailure({ reason, evidence: { newWindowAppeared: true } }), reason).toBe("popup_interrupted");
  });
  it("...but never overrides what the user did or a safety refusal", () => {
    expect(classifyFailure({ pointerReason: "user_moved", evidence: { windowBlockedByDialog: true } })).toBe("user_interrupted");
    expect(classifyFailure({ reason: "I never type into password fields.", evidence: { windowBlockedByDialog: true } })).toBe("blocked_by_policy");
  });
  it("modal:false and absent change nothing", () => {
    expect(classifyFailure({ reason: "Windows didn't answer in time", evidence: { windowBlockedByDialog: false } })).toBe("timeout");
    expect(classifyFailure({ reason: "Windows didn't answer in time", evidence: {} })).toBe("timeout");
  });
});

describe("acted: did anything reach the app?", () => {
  it("maxActed keeps the strongest answer: once something was sent, it stays sent", () => {
    expect(maxActed("no", "maybe")).toBe("maybe");
    expect(maxActed("yes", "no")).toBe("yes");
    expect(maxActed("maybe", "yes")).toBe("yes");
    expect(maxActed(undefined, undefined)).toBe("no");
    expect(maxActed(undefined, "maybe")).toBe("maybe");
    expect(maxActed("yes", undefined)).toBe("yes");
  });
  it("isActed accepts exactly the three words", () => {
    for (const v of ["no", "maybe", "yes"]) expect(isActed(v)).toBe(true);
    for (const v of ["No", "true", "", undefined, null, 1]) expect(isActed(v)).toBe(false);
  });
  it("what the input layer reports wins: delivered input is 'yes' / 'maybe' whatever the tool said", () => {
    expect(deriveActed({ kind: "input_failed", risk: "reversible", delivered: "yes" })).toBe("yes");
    expect(deriveActed({ kind: "target_gone", risk: "reversible", delivered: "maybe" })).toBe("maybe");
    expect(deriveActed({ kind: "unknown", risk: "consequential", delivered: "maybe" })).toBe("maybe");
  });
  it("the input layer saying 'no' is exact for the real mouse and keyboard", () => {
    expect(deriveActed({ kind: "covered", risk: "reversible", delivered: "no" })).toBe("no");
    expect(deriveActed({ kind: "unknown", risk: "reversible", delivered: "no" })).toBe("no");
  });
  it("a step that only looks never changed anything", () => {
    expect(deriveActed({ kind: "unknown", risk: "read" })).toBe("no");
    expect(deriveActed({ kind: "uia_failed", risk: "sensitive_read" })).toBe("no");
  });
  it("a refusal decided up front sent nothing", () => {
    for (const kind of ["target_not_found", "target_gone", "target_disabled", "ambiguous", "needs_confirmation", "blocked_by_policy", "unavailable", "invalid_request", "cancelled"] as FailureKind[]) {
      expect(deriveActed({ kind, risk: "reversible" }), kind).toBe("no");
    }
  });
  it("any OTHER failure of a step that changes things, with no facts, is 'maybe': never assumed harmless", () => {
    for (const kind of ["unknown", "timeout", "uia_failed", "input_failed", "unverified", "partial", "app_unresponsive", "popup_interrupted", "wrong_window", "target_moved", "covered"] as FailureKind[]) {
      for (const risk of ["reversible", "consequential"]) expect(deriveActed({ kind, risk }), `${kind}/${risk}`).toBe("maybe");
    }
  });
  it("a tool that knows better can say so, but never LOWER than what the input layer saw", () => {
    expect(deriveActed({ kind: "unknown", risk: "reversible", explicit: "no" })).toBe("no");
    expect(deriveActed({ kind: "unknown", risk: "reversible", explicit: "no", delivered: "yes" })).toBe("yes");
    expect(deriveActed({ kind: "covered", risk: "reversible", explicit: "yes" })).toBe("yes");
  });
});

describe("describeFailure puts it together", () => {
  it("a covered click that sent nothing", () => {
    expect(describeFailure({ reason: "Another window is in front of that spot.", risk: "reversible", delivered: "no" })).toEqual({ kind: "covered", acted: "no" });
  });
  it("a timeout after input was sent is 'maybe', and a hung window makes it app_unresponsive", () => {
    expect(describeFailure({ reason: "Windows didn't answer in time", risk: "reversible", delivered: "maybe" })).toEqual({ kind: "timeout", acted: "maybe" });
    expect(describeFailure({ reason: "Windows didn't answer in time", risk: "reversible", delivered: "maybe", evidence: { windowHung: true } })).toEqual({ kind: "app_unresponsive", acted: "maybe" });
  });
  it("a tool's own naming is used as given", () => {
    expect(describeFailure({ reason: "x", risk: "reversible", explicitKind: "partial", explicitActed: "yes" })).toEqual({ kind: "partial", acted: "yes" });
  });
  it("nothingWasSent and isTerminal read the result", () => {
    expect(nothingWasSent({ kind: "covered", acted: "no" })).toBe(true);
    expect(nothingWasSent({ kind: "covered", acted: "maybe" })).toBe(false);
    expect(nothingWasSent({ kind: "covered", acted: "yes" })).toBe(false);
    for (const k of ["user_interrupted", "cancelled", "blocked_by_policy"] as FailureKind[]) expect(isTerminal(k)).toBe(true);
    for (const k of ["covered", "target_moved", "timeout", "unknown"] as FailureKind[]) expect(isTerminal(k)).toBe(false);
  });
});

describe("every sentence the tools can fail with is understood", () => {
  it("none of the literal failure messages in tools.ts classifies as 'unknown' (a new tool message needs a pattern, or an explicit kind)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../tools.ts"), "utf8");
    const re = /\bfail\((`[^`]*`|"[^"]*")\)/g;
    const reasons = new Set<string>();
    for (let m = re.exec(src); m; m = re.exec(src)) reasons.add(m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, "x"));
    expect(reasons.size).toBeGreaterThan(40); // the scan really found them
    const unknown = [...reasons].filter((r) => classifyFailure({ reason: r }) === "unknown");
    expect(unknown, `unclassified: ${unknown.join(" | ")}`).toEqual([]);
  });
  it("the pointer layer's reasons (ports.ts) are all mapped", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../shared/ports.ts"), "utf8");
    const line = src.split("\n").find((l) => l.startsWith("export type PointerResult"))!;
    const reasons = [...line.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((r) => r !== "ok");
    expect(reasons.length).toBeGreaterThanOrEqual(12);
    for (const r of reasons) expect(classifyFailure({ pointerReason: r }), r).not.toBe("unknown");
  });
});
