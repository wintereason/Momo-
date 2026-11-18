"use strict";
// The context a test case receives. A case records checks; the runner turns them into PASS or FAIL. A case that records NO checks is a FAIL
// ("made no assertions"), so a case can never pass by doing nothing.
const { compareLatency } = require("./judge.cjs");
const { storable } = require("./diag.cjs");

class SkipSignal extends Error { constructor(reason) { super(reason); this.skipReason = reason; } }

function makeCaseCtx(base, def) {
  const checks = [], warnings = [], metrics = {}, expected = [], diagnostics = [];
  let latency = null;
  const ctx = {
    ...base, def,
    /** quick runs use fewer trials: ctx.n(full, quick) */
    n: (full, quick) => (base.quick ? quick : full),
    expects(text) { expected.push(String(text)); },
    check(name, ok, detail = "") { checks.push({ name, ok: !!ok, detail: String(detail) }); return !!ok; },
    warn(msg) { warnings.push(String(msg)); },
    /**
     * Record a diagnostic (what a tool answered, a rectangle, a wheel point, one trial's outcome). Stored with the result whether the test passes or fails.
     * Strings are scrubbed (see lib/diag.cjs): only this run's id, our fixtures' names and the allowed values survive; nothing arbitrary is ever kept.
     */
    diag(name, data, { allowed = [] } = {}) { if (diagnostics.length < 60) diagnostics.push({ name: String(name).slice(0, 80), data: storable(data, { runId: base.runId, allowed }) }); },
    metric(name, value, unit = "ms") { metrics[name] = { value, unit }; },
    setLatency(v) { latency = v; },
    /** record a measured latency next to its Phase 6 baseline (only a warning when much slower, and only on a comparable machine) */
    vsBaseline(key, value) {
      const b = base.baselines[key]; if (!b || value == null) return;
      const r = compareLatency(value, b.value, base.comparable);
      metrics[key] = { value, unit: b.unit || "ms", baseline: b.value, state: r.state };
      if (r.state === "warn") warnings.push(`${key}: ${r.note}`);
    },
    skip(reason) { throw new SkipSignal(reason); },
    result() { return { checks, warnings, metrics, latency, diagnostics, expected: expected.join("; ") }; },
  };
  return ctx;
}

module.exports = { makeCaseCtx, SkipSignal };
