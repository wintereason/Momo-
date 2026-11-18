#!/usr/bin/env node
"use strict";
// Momo's real-Windows acceptance suite (Phase 8a).   npm run test:real [-- options]      (see tests/real/README.md)
//
// It drives the REAL runtime (Session, UI Automation helper, capture, pointer) against CONTROLLED test applications that this suite creates
// itself, and judges every result against what the test application itself recorded. It uses a scripted planner: no AI is contacted and no
// screen content is ever sent anywhere. It moves your real mouse and sends real keystrokes to its own test windows: keep your hands off.
const fs = require("fs");
const path = require("path");
const P = require("./lib/paths.cjs");
const { Report, EXIT } = require("./lib/report.cjs");
const { Ledger } = require("./lib/ledger.cjs");
const { makeCaseCtx, SkipSignal } = require("./lib/ctx.cjs");
const { environmentComparable } = require("./lib/judge.cjs");

const HELP = `Usage: npm run test:real -- [options]
  --quick               the short run (about 3-4 minutes): a representative subset
  --full                everything (about 10 minutes). This is the default
  --group A,B,C,D,S     only these groups  (A desktop, B recovery/transients, C visual + Chrome, D security, S runner self-checks)
  --only ID[,ID]        only these test ids (see --list)
  --list                list every test: group, kind, whether it uses your real mouse/keyboard, estimated time. Starts nothing
  --dry-run             preflight only: environment, runtime freshness, what would run. Starts nothing
  --selftest            run only the runner's own self-checks (simulated, no windows, no input)
  --repeat N            run each selected test N times (to study flakiness; failures are never retried away)
  --allow-skip ID[,ID]  accept these tests being skipped (otherwise a skipped required test makes the run INCOMPLETE)
  --no-countdown        skip the 5 second hands-off countdown
  --no-results          do not write the results file (used by the runner's own self-check)
  --no-build            do not rebuild electron/runtime.cjs when it is stale (a stale runtime then stops the run)
Exit code: 0 passed, 1 failed (or leftovers), 2 usage/preflight problem, 3 incomplete (a required test did not run).`;

function parseArgs(argv) {
  const a = { quick: false, group: null, only: null, list: false, dry: false, selftest: false, repeat: 1, allowSkip: [], countdown: true, build: true, help: false, results: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => { const v = argv[++i]; if (v == null) throw new Error(`${x} needs a value`); return v; };
    const list = (s) => s.split(",").map((t) => t.trim()).filter(Boolean);
    if (x === "--quick") a.quick = true; else if (x === "--full") a.quick = false;
    else if (x === "--group") a.group = list(val()).map((g) => g.toUpperCase());
    else if (x === "--only") a.only = list(val()).map((g) => g.toUpperCase());
    else if (x === "--list") a.list = true; else if (x === "--dry-run") a.dry = true; else if (x === "--selftest") a.selftest = true;
    else if (x === "--repeat") { a.repeat = Math.max(1, Math.min(20, Number(val()) || 1)); }
    else if (x === "--allow-skip") a.allowSkip = list(val()).map((g) => g.toUpperCase());
    else if (x.startsWith("--allow-skip=")) a.allowSkip = list(x.slice(13)).map((g) => g.toUpperCase());
    else if (x === "--no-countdown") a.countdown = false; else if (x === "--no-build") a.build = false; else if (x === "--no-results") a.results = false;
    else if (x === "--help" || x === "-h") a.help = true;
    else throw new Error(`unknown option ${x}`);
  }
  return a;
}

const GROUP_ORDER = ["S", "A", "B", "C", "D"];
function loadCatalog() {
  const defs = [];
  for (const f of fs.readdirSync(P.CASES).filter((n) => n.endsWith(".cjs")).sort()) {
    const mod = require(path.join(P.CASES, f));
    for (const d of mod) {
      for (const k of ["id", "group", "title", "mode"]) if (!d[k]) throw new Error(`${f}: a case has no ${k}`);
      if (!d.manual && typeof d.run !== "function") throw new Error(`${f}: ${d.id} has no run()`);
      defs.push({ interactive: false, quick: false, est: 10, needs: [], ...d, file: f });
    }
  }
  const ids = new Set(); for (const d of defs) { if (ids.has(d.id)) throw new Error("duplicate test id " + d.id); ids.add(d.id); }
  return defs.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

function select(defs, a) {
  let sel = defs;
  if (a.selftest) sel = sel.filter((d) => d.group === "S");
  if (a.group) sel = sel.filter((d) => a.group.includes(d.group));
  if (a.only) sel = sel.filter((d) => a.only.includes(d.id));
  const notSelected = [];
  if (a.quick) { const keep = []; for (const d of sel) (d.quick || d.manual ? keep : notSelected).push(d); sel = keep; }
  return { sel, notSelected };
}

const estOf = (d, quick) => (quick && d.estQuick != null ? d.estQuick : d.est);
const fmtMin = (s) => (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printList(defs, a) {
  const { sel, notSelected } = select(defs, a);
  console.log(`Momo real-Windows acceptance suite: ${defs.length} tests defined${a.quick ? " (showing the --quick selection)" : ""}\n`);
  for (const d of sel) {
    const kind = d.manual ? "MANUAL (you run it; never run by the suite)" : d.interactive ? "uses your real mouse/keyboard" : d.mode === "simulated" ? "simulated, touches nothing" : "opens test windows only";
    console.log(`${d.id.padEnd(6)} ${d.group}  [${d.mode}]  ${d.title}\n         ${kind}${d.needs.length ? "; needs " + d.needs.join(", ") : ""}; about ${estOf(d, a.quick)} s${d.manual ? "\n         run: " + d.command : ""}`);
  }
  const auto = sel.filter((d) => !d.manual);
  console.log(`\n${auto.length} automated test(s), ${sel.length - auto.length} manual; estimated ${fmtMin(auto.reduce((s, d) => s + estOf(d, a.quick), 0))}${notSelected.length ? `; ${notSelected.length} test(s) are not part of --quick (run without it for the full suite)` : ""}`);
}

/** Every case invocation (and every repetition of it) gets its OWN artifact directory, which always ends, even when the case throws, fails or times out. */
async function runCase(def, base, ledger, getHarness, report, label) {
  return ledger.runInCase(label, () => runCaseInner(def, { ...base, label }, ledger, getHarness, report, label));
}

async function runCaseInner(def, base, ledger, getHarness, report, label) {
  const row = { id: label, group: def.group, title: def.title, mode: def.mode, expected: def.expect || "", status: "PASS" };
  const t0 = Date.now();
  const mark = ledger.mark();
  const ctx = makeCaseCtx(base, def);
  if (base.harnessStarted()) getHarness().drainHistory();   // whatever an earlier case left
  let timer;
  try {
    await Promise.race([
      def.run(ctx),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${(def.timeoutMs || 180_000) / 1000} s`)), def.timeoutMs || 180_000); }),
    ]);
    const r = ctx.result();
    row.warnings = r.warnings; row.metrics = Object.keys(r.metrics).length ? r.metrics : null; row.latency = r.latency;
    if (r.expected) row.expected = r.expected;
    const failed = r.checks.filter((c) => !c.ok);
    if (r.checks.length === 0) { row.status = "FAIL"; row.actual = "the test made no assertions"; }
    else if (failed.length) { row.status = "FAIL"; row.actual = failed.slice(0, 4).map((c) => c.name + (c.detail ? ` (${c.detail})` : "")).join("; ") + (failed.length > 4 ? ` ... +${failed.length - 4} more` : ""); }
    else row.actual = `${r.checks.length} check(s) passed`;
    row.checks = r.checks.length;
  } catch (e) {
    if (e instanceof SkipSignal) { row.status = "SKIP"; row.reason = e.skipReason; }
    else { row.status = "FAIL"; row.actual = String(e && e.message || e).slice(0, 300); row.expected = row.expected || "the test completes"; }
  } finally { clearTimeout(timer); }
  row.durationMs = Date.now() - t0;

  // diagnostics: what the case recorded plus one record per tool call (best effort; never changes a verdict)
  try {
    const d = [...ctx.result().diagnostics, ...(base.harnessStarted() ? getHarness().drainHistory() : [])];
    if (d.length) row.diagnostics = d.slice(0, 80);
  } catch { /* diagnostics are optional */ }

  // the case is over: nothing of it may keep running or stay held
  let cleanup = "ok";
  try {
    if (base.harnessStarted()) { const h = getHarness(); try { h.cancel(); } catch { /* nothing to cancel */ } try { h.pointer.disarm(); } catch { /* already free */ } }
    if (def.interactive || def.mode === "real") {
      const held = require("./lib/input.cjs").heldInputs();
      if (held.length) { cleanup = "input still held after the test (virtual keys " + held.map((v) => "0x" + v.toString(16)).join(",") + ")"; if (row.status === "PASS") { row.status = "FAIL"; row.actual = cleanup; } }
    }
  } catch (e) { cleanup = "check failed: " + String(e && e.message || e).slice(0, 80); }
  const killed = ledger.releaseSince(mark);
  if (def.mode === "real") {
    const left = ledger.leftovers().processes;
    if (left > 0) { cleanup = `${left} process(es) of this run were still alive after the test (removed)`; ledger.sweepProcesses(); if (row.status === "PASS") { row.status = "FAIL"; row.actual = cleanup; } }
  }
  row.cleanup = cleanup;
  report.add(row);
  return row;
}

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e.message)); console.error(HELP); return EXIT.USAGE; }
  if (a.help) { console.log(HELP); return 0; }
  const defs = loadCatalog();
  if (a.list) { printList(defs, a); return 0; }
  const { sel, notSelected } = select(defs, a);
  if (sel.length === 0) { console.error("No test matches that selection. Use --list."); return EXIT.USAGE; }
  const automated = sel.filter((d) => !d.manual);
  const needsRuntime = automated.some((d) => d.mode === "real" || d.usesRuntime);
  const interactive = automated.some((d) => d.interactive);

  // ---------------------------------------------------------------- preflight (read-only)
  if (process.platform !== "win32") { console.error("This suite drives real Windows applications and only runs on Windows."); return EXIT.USAGE; }
  const envMod = require("./lib/env.cjs");
  const env = envMod.gather();
  const th = JSON.parse(fs.readFileSync(path.join(P.REAL, "baselines.json"), "utf8"));
  const comparable = environmentComparable(env, th.referenceEnvironment);
  let rts = { present: true, fresh: true };
  if (needsRuntime) rts = envMod.runtimeState();
  console.log(`Environment: ${env.os}, node ${env.node}, PowerShell ${env.powershell}, ${env.monitors} display(s) ${env.physicalWidth}x${env.physicalHeight} at ${Math.round((env.scale || 0) * 100)}%, Chrome ${env.chrome || "not found"}`);
  console.log(`Baseline comparison: ${comparable ? "this machine matches the Phase 6e reference (latency is compared)" : "this machine differs from the Phase 6e reference (latency is reported but NOT compared)"}`);
  if (needsRuntime) console.log(`Runtime (electron/runtime.cjs): ${!rts.present ? "missing" : rts.fresh ? "up to date" : "older than the source"}`);
  console.log(`Selected: ${automated.length} automated, ${sel.length - automated.length} manual${a.quick ? " (--quick subset: " + notSelected.length + " test(s) not selected)" : ""}; estimated ${fmtMin(automated.reduce((s, d) => s + estOf(d, a.quick), 0) * a.repeat)}`);
  if (a.dry) {
    console.log("\n--dry-run: nothing was started. Tests that would run:");
    for (const d of sel) console.log(`  ${d.id.padEnd(6)} [${d.mode}] ${d.manual ? "MANUAL" : d.interactive ? "real input" : "no input"}  ${d.title}${d.needs.some((n) => n === "chrome") && !env.chromePath ? "   (would SKIP: Chrome not found)" : ""}`);
    return needsRuntime && (!rts.present || (!rts.fresh && !a.build)) ? EXIT.USAGE : 0;
  }
  if (needsRuntime && (!rts.present || !rts.fresh)) {
    if (!a.build) { console.error("electron/runtime.cjs is " + (rts.present ? "older than the source" : "missing") + ". Run npm run build:runtime (or drop --no-build)."); return EXIT.USAGE; }
    console.log("Rebuilding electron/runtime.cjs (a build artifact; the product source is not touched) ...");
    const r = require("child_process").spawnSync(process.execPath, [path.join(P.ROOT, "scripts", "build-runtime.mjs")], { cwd: P.ROOT, stdio: "inherit" });
    if (r.status !== 0) { console.error("The runtime build failed."); return EXIT.USAGE; }
  }

  // ---------------------------------------------------------------- hands-off notice
  if (!interactive && automated.some((d) => d.mode === "real")) console.log("\nTest windows will open and close on your screen (the suite sends no mouse or keyboard input in this selection).");
  if (interactive) {
    console.log("\n=========================================================================");
    console.log(" HANDS OFF THE MOUSE AND KEYBOARD until this finishes.");
    console.log(" The suite moves your real mouse and sends real keys, only to its own test");
    console.log(" windows. Ctrl+C stops it safely and cleans everything up.");
    console.log("=========================================================================");
    if (a.countdown) for (let i = 5; i >= 1; i--) { process.stdout.write(`  starting in ${i} ...\r`); await sleep(1000); }
    console.log("");
  }

  // ---------------------------------------------------------------- the run
  const runId = `momo-real-r${Date.now()}-${process.pid}`;
  const ledger = new Ledger({ runId, runDir: path.join(P.TMP_ROOT, runId), tmpRoot: P.TMP_ROOT });
  const stale = Ledger.sweepStale(P.TMP_ROOT);
  if (stale.runs || stale.processes) console.log(`Cleaned up the leftovers of ${stale.runs} earlier run(s) that did not finish (${stale.processes} process(es)).`);
  ledger.init();
  let harness = null;
  const getHarness = () => harness || (harness = require("./lib/harness.cjs").createHarness({ runId }));
  const report = new Report({ runId, env: envMod.forReport(env), mode: a.quick ? "quick" : "full", allowSkip: a.allowSkip });
  if (a.quick) report.notes.push(`quick run: ${notSelected.length} test(s) were not selected and did not run`);
  if (stale.runs) report.notes.push(`removed ${stale.runs} stale run directory(ies) from earlier crashed runs`);

  const shutdown = require("./lib/shutdown.cjs").installShutdown({ ledger, getHarness: () => harness });

  const base = { runId, ledger, env, th: th.thresholds, baselines: th.baselines, comparable, quick: a.quick, harness: getHarness, harnessStarted: () => !!harness };
  const total = automated.length * a.repeat;
  let n = 0;
  console.log(`\nRun ${runId}\n`);
  for (let rep = 1; rep <= a.repeat; rep++) {
    for (const def of sel) {
      const label = a.repeat > 1 ? `${def.id}#${rep}` : def.id;
      if (def.manual) { if (rep === 1) report.add({ id: def.id, group: def.group, title: def.title, mode: "manual", status: "MANUAL", reason: `Not run by the suite. Run it yourself: ${def.command}` }); continue; }
      n++;
      process.stdout.write(`[${String(n).padStart(2)}/${total}] ${label.padEnd(8)} ${def.title} ... `);
      let row;
      const missing = def.needs.filter((k) => k === "chrome" && !env.chromePath);
      if (missing.length) { row = { id: label, group: def.group, title: def.title, mode: def.mode, status: "SKIP", reason: `requires ${missing.join(", ")}, which was not found on this PC`, cleanup: "ok" }; report.add(row); }
      else row = await runCase(def, base, ledger, getHarness, report, label);
      console.log(`${row.status}${row.status === "PASS" ? ` (${(row.durationMs / 1000).toFixed(1)} s)` : row.status === "SKIP" ? " - " + row.reason : ""}`);
    }
  }

  // ---------------------------------------------------------------- final cleanup and audit
  const { heldInputs } = require("./lib/input.cjs");
  let heldNow = []; try { if (needsRuntime) heldNow = heldInputs(); } catch { /* koffi unavailable: reported below */ }
  const sw = ledger.sweep();
  const left = ledger.leftovers();
  shutdown.markClean();
  const problems = [];
  if (left.processes) problems.push(`${left.processes} process(es) still running`);
  if (left.dir) problems.push("the run directory still exists");
  if (heldNow.length) problems.push("input still held: " + heldNow.map((v) => "0x" + v.toString(16)).join(","));
  report.cleanup = { leftover: problems.length > 0, detail: problems.length ? problems.join("; ") : `${ledger.removed.processes} process(es) ended, run directory removed, no input held` };
  report.print();
  if (a.results) try { const f = report.write(P.RESULTS); console.log(`\nResults written to tests/real/results/${path.basename(f)} (git-ignored; counts and timings only, no screen content).`); } catch (e) { console.log("(could not write the results file: " + e.message + ")"); }
  if (a.quick) console.log(`\nNote: this was the --quick subset. ${notSelected.length} test(s) did not run. Run without --quick for the full acceptance suite.`);
  return report.exitCode();
}

main().then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 50); }).catch((e) => { console.error("Runner error:", e && e.stack || e); process.exit(EXIT.USAGE); });
