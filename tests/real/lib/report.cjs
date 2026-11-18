"use strict";
// Result rows, the console table, the JSON file and the exit code.
//
// A skipped required test is NEVER reported as passed: it is listed with its reason, counted, and it makes the whole run "incomplete"
// (exit code 3) unless the person running the suite named it in --allow-skip. MANUAL rows are tests that only the user can run; they are listed
// as "not run" and never counted as passed.
const fs = require("fs");
const path = require("path");

const STATUS = ["PASS", "FAIL", "SKIP", "MANUAL"];
const EXIT = { OK: 0, FAIL: 1, USAGE: 2, INCOMPLETE: 3 };

class Report {
  constructor({ runId, env, mode, allowSkip = [] }) {
    this.runId = runId; this.env = env; this.mode = mode; this.allowSkip = new Set(allowSkip);
    this.rows = []; this.startedAt = new Date(); this.cleanup = null; this.notes = [];
  }

  add(row) {
    if (!STATUS.includes(row.status)) throw new Error("bad status " + row.status);
    this.rows.push({ expected: "", actual: "", latency: null, reason: "", warnings: [], metrics: null, cleanup: "ok", mode: "real", ...row });
  }

  counts() {
    const c = { PASS: 0, FAIL: 0, SKIP: 0, MANUAL: 0, WARN: 0, skippedAllowed: 0 };
    for (const r of this.rows) {
      c[r.status]++;
      if (r.warnings && r.warnings.length) c.WARN++;
      if (r.status === "SKIP" && this.allowSkip.has(r.id)) c.skippedAllowed++;
    }
    return c;
  }

  /** 0 = everything required passed; 1 = a failure (or a leftover); 3 = nothing failed but a required test did not run */
  exitCode() {
    const c = this.counts();
    if (c.FAIL > 0) return EXIT.FAIL;
    if (this.cleanup && this.cleanup.leftover) return EXIT.FAIL;
    if (c.SKIP - c.skippedAllowed > 0) return EXIT.INCOMPLETE;
    if (c.PASS === 0) return EXIT.INCOMPLETE;           // nothing was verified: that is never a success
    return EXIT.OK;
  }

  verdict() {
    const code = this.exitCode(); const c = this.counts();
    if (code === EXIT.FAIL) return "FAILED";
    if (code === EXIT.INCOMPLETE) return c.PASS === 0 && c.SKIP - c.skippedAllowed === 0 ? "INCOMPLETE (no test passed: nothing was verified, this is NOT a pass)" : "INCOMPLETE (required tests were skipped: this is NOT a pass)";
    const notes = [];
    if (c.skippedAllowed > 0) notes.push(`${c.skippedAllowed} skipped by --allow-skip, not counted as passed`);
    if (c.MANUAL > 0) notes.push("manual checks are listed as not run");
    return notes.length ? `PASSED (${notes.join("; ")})` : "PASSED";
  }

  line(r) {
    const tag = r.status === "MANUAL" ? "MANUAL" : r.status;
    const lat = r.latency != null ? `  ${typeof r.latency === "number" ? r.latency + " ms" : r.latency}` : "";
    const head = `${tag.padEnd(6)} ${r.id.padEnd(8)} [${r.mode}] ${r.title}${lat}`;
    const extra = [];
    if (r.status === "FAIL") extra.push("  expected: " + r.expected, "  actual:   " + r.actual);
    if (r.status === "SKIP" || r.status === "MANUAL") extra.push("  " + (r.reason || ""));
    for (const w of r.warnings || []) extra.push("  WARN: " + w);
    if (r.cleanup && r.cleanup !== "ok") extra.push("  cleanup: " + r.cleanup);
    return [head, ...extra].join("\n");
  }

  print(out = console.log) {
    out("");
    for (const r of this.rows) out(this.line(r));
    const c = this.counts();
    out("");
    out(`Summary: ${c.PASS} passed, ${c.FAIL} failed, ${c.SKIP} skipped (${c.skippedAllowed} allowed), ${c.MANUAL} manual (not run), ${c.WARN} with warnings`);
    if (this.cleanup) out(`Cleanup: ${this.cleanup.leftover ? "LEFTOVERS FOUND: " + this.cleanup.detail : "complete (" + this.cleanup.detail + ")"}`);
    out(`Result: ${this.verdict()}`);
  }

  toJSON() {
    return {
      runId: this.runId, startedAt: this.startedAt.toISOString(), finishedAt: new Date().toISOString(), mode: this.mode,
      environment: this.env, counts: this.counts(), cleanup: this.cleanup, verdict: this.verdict(), exitCode: this.exitCode(), notes: this.notes, rows: this.rows,
    };
  }

  /** The report holds counts, timings and OUR fixtures' own labels only: never a window title of anything else, never screen text, never a picture. */
  write(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.runId}.json`);
    fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2));
    return file;
  }
}

module.exports = { Report, EXIT, STATUS };
