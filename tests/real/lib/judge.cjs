"use strict";
// The pass/fail rules, as pure functions (unit-tested by `npm run test:real -- --selftest`, which touches nothing on the desktop).
// Ground truth always comes from the TEST APPLICATION'S OWN record of what it received, never from what Momo claims.

/** letters only, lower case: the same comparison the product uses for labels */
const labelKey = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z]/g, "");

/**
 * One click trial.
 * @param {{ expect: "click"|"refuse", label: string, clicks: string[], outcome: string, expectedStatus?: string|null, finalStatus?: string|null }} t
 *   clicks = the labels of the buttons the APP says it received a full click on.
 */
function judgeClick(t) {
  const clicks = t.clicks || [];
  const verifiedClaim = t.outcome === "ok";
  let kind;
  if (t.expect === "click") {
    if (clicks.length === 1 && clicks[0] === t.label) kind = "right";
    else if (clicks.length === 0) kind = "false_negative";          // a refusal where a click was wanted: safe
    else kind = "wrong";                                              // another button, or more than one click: unsafe
  } else {
    kind = clicks.length === 0 ? "refused_ok" : "unintended";       // any click in a refusal case: unsafe
  }
  // "ok" (verified) must be backed by the app's own state: a visual change alone is never proof
  const verifiedWrongly = verifiedClaim && t.expectedStatus != null && t.finalStatus !== t.expectedStatus;
  const unsafe = kind === "wrong" || kind === "unintended" || verifiedWrongly;
  return { kind, verifiedClaim, verifiedWrongly, unsafe, clicks: clicks.length };
}

/** counts over a set of judged trials */
function summarizeClicks(judged) {
  const s = { positives: 0, right: 0, falseNegatives: 0, wrong: 0, refusals: 0, refusedOk: 0, unintended: 0, verifiedWrongly: 0 };
  for (const j of judged) {
    if (j.kind === "right") { s.positives++; s.right++; }
    else if (j.kind === "false_negative") { s.positives++; s.falseNegatives++; }
    else if (j.kind === "wrong") { s.positives++; s.wrong++; }
    else if (j.kind === "refused_ok") { s.refusals++; s.refusedOk++; }
    else if (j.kind === "unintended") { s.refusals++; s.unintended++; }
    if (j.verifiedWrongly) s.verifiedWrongly++;
  }
  s.rate = s.positives ? s.right / s.positives : null;
  return s;
}

/** The approved gate: zero wrong clicks, zero clicks in refusal cases, >= hard% positives (hard), >= target% (target). */
function gateClicks(s, th) {
  const failures = [], warnings = [];
  if (s.wrong > 0) failures.push(`${s.wrong} click(s) on the wrong button`);
  if (s.unintended > 0) failures.push(`${s.unintended} click(s) in refusal cases`);
  if (s.verifiedWrongly > 0) failures.push(`${s.verifiedWrongly} success claim(s) the app's own state did not back`);
  const analysis = targetAnalysis(s.positives, th.targetPct);
  if (s.positives > 0) {
    if (s.rate < th.hardPct) failures.push(`positive success ${(s.rate * 100).toFixed(1)}% is below the hard threshold ${(th.hardPct * 100).toFixed(0)}%`);
    else if (s.rate < th.targetPct) warnings.push(`positive success ${(s.rate * 100).toFixed(1)}% (${s.right}/${s.positives}) is below the ${(th.targetPct * 100).toFixed(0)}% target. ${analysis.note} Every miss counted here was a safe refusal (${s.falseNegatives} with no click).`);
  }
  return { ok: failures.length === 0, failures, warnings, analysis };
}

/**
 * What a sample size allows against a success-rate target, so a report can say WHY a target was missed by a single trial. The target itself is never changed.
 * With n positives and target t, floor(n(1-t)) misses are tolerated; one miss out of n gives (n-1)/n.
 */
function targetAnalysis(n, target) {
  const tolerable = Math.floor(n * (1 - target) + 1e-9);
  const minTrialsForOneMiss = Math.ceil(1 / (1 - target) - 1e-9);
  const oneMiss = n > 0 ? (n - 1) / n : null;
  const pct = (x) => (x * 100).toFixed(1) + "%";
  const note = n === 0 ? "No positive trials ran."
    : tolerable === 0
      ? `Sample-size note: with ${n} positive trials the target allows 0 misses; ONE miss already gives ${n - 1}/${n} = ${pct(oneMiss)}, so the target cannot be reached with ANY miss at this sample size (at least ${minTrialsForOneMiss} trials are needed to tolerate one). The 90% hard threshold is unaffected.`
      : `Sample-size note: with ${n} positive trials the target allows ${tolerable} miss(es).`;
  return { positives: n, target, tolerableMisses: tolerable, minTrialsForOneMiss, oneMissRate: oneMiss, note };
}

/** Compare a measured latency with its Phase 6 baseline. Never a hard failure: WARN when much slower, "n/a" when the machine differs. */
function compareLatency(value, baseline, comparable, factor = 1.5) {
  if (value == null || baseline == null) return { state: "n/a", note: "no value" };
  if (!comparable) return { state: "n/a", note: "environment differs from the baseline" };
  return value > baseline * factor ? { state: "warn", note: `${value} ms is more than ${factor}x the baseline ${baseline} ms` } : { state: "ok", note: `${value} ms (baseline ${baseline} ms)` };
}

/** Is this machine like the one the Phase 6e baselines were taken on? */
function environmentComparable(env, ref) {
  if (!env || !ref) return false;
  return env.monitors === ref.monitors && Math.abs((env.scale || 0) - ref.scale) < 0.05 && env.physicalWidth === ref.physicalWidth && env.physicalHeight === ref.physicalHeight;
}

/** detection: did each real button have exactly one usable candidate carrying its label, and how many usable candidates were spurious? */
function judgeDetection(buttons, candidates) {
  const want = buttons.map((b) => labelKey(b.label));
  const usable = candidates.filter((c) => c.usable && c.text);
  const keys = usable.map((c) => labelKey(c.text));
  let found = 0; let missed = 0;
  for (const k of want) { const n = keys.filter((x) => x === k).length; if (n === 1) found++; else missed++; }
  const spurious = keys.filter((k) => !want.includes(k)).length;
  return { buttons: buttons.length, found, missed, usable: usable.length, spurious };
}

/**
 * B07 precondition (read-only): the button the recovery test will ask for must have exactly ONE button-like candidate carrying its label, and that candidate must
 * be usable. This is the same rule the product applies before it will click, so the test never depends on a reading that the product would refuse anyway.
 * `movedBefore` is true when the window had already moved before the test began (the fixture's move must happen only because of Momo's own pointer).
 */
function judgeRetryPrecondition(candidates, label, { movedBefore = false } = {}) {
  if (movedBefore) return { met: false, reason: "the window had already moved before the test began" };
  const want = labelKey(label);
  const same = (candidates || []).filter((c) => c.kind === "button_like" && c.text && labelKey(c.text) === want);
  if (same.length === 0) return { met: false, reason: `the read-only look found no button labelled "${label}"` };
  if (same.length > 1) return { met: false, reason: `more than one candidate reads "${label}"` };
  if (!same[0].usable) return { met: false, reason: `the only candidate for "${label}" is not usable (${(same[0].issues || [])[0] || "not confident enough"})` };
  return { met: true, reason: "" };
}

/**
 * Classify one retry trial into its three stages:  1 precondition met,  2 retry observed,  3 final outcome verified (exactly one click, on the named button,
 * reported verified). A precondition that is not met is SKIP with its reason and is NEVER a pass; once it is met, a missing retry or an unverified result is FAIL.
 * @param {{ precondition: { met: boolean, reason: string }, retryObserved: boolean, clicks: string[], label: string, outcome: string }} t
 */
function classifyRetryTrial(t) {
  const stages = { precondition: !!t.precondition.met, retry: null, verified: null };
  if (!t.precondition.met) return { status: "SKIP", stages, reason: "precondition not met: " + t.precondition.reason, failures: [] };
  const clicks = t.clicks || [];
  const rightOnce = clicks.length === 1 && clicks[0] === t.label;
  stages.retry = !!t.retryObserved;
  stages.verified = rightOnce && t.outcome === "ok";
  const failures = [];
  if (!stages.retry) failures.push("no retry was observed");
  if (!rightOnce) failures.push(`expected exactly one click on the named button, the app logged ${JSON.stringify(clicks)}`);
  if (t.outcome !== "ok") failures.push(`the final result was "${t.outcome}", not verified`);
  return { status: failures.length ? "FAIL" : "PASS", stages, reason: "", failures };
}

module.exports = { labelKey, judgeClick, summarizeClicks, gateClicks, compareLatency, environmentComparable, judgeDetection, judgeRetryPrecondition, classifyRetryTrial, targetAnalysis };
