"use strict";
// Group S: the runner's own logic. Simulated: no window is opened, no input is sent, no desktop state is touched.
// (The cleanup test starts a few HIDDEN console processes of its own and checks that the ledger finds and ends exactly those.)
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const P = require("../lib/paths.cjs");
const J = require("../lib/judge.cjs");
const { Report } = require("../lib/report.cjs");
const { Ledger } = require("../lib/ledger.cjs");
const { psq, pidsByCommandLine, isAlive, killTree } = require("../lib/ps.cjs");
const { makeCaseCtx } = require("../lib/ctx.cjs");
const stats = require("../lib/stats.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The probe behind S11 (and S10's in-process proof): a case's artifacts must start empty and hold only this invocation's own writes. */
function probeRun(ctx) {
  const log = ctx.ledger.file("probe.log"), marker = ctx.ledger.file("probe.marker"), state = ctx.ledger.file("probe.state.json");
  const leftover = [log, marker, state].filter((f) => fs.existsSync(f));
  ctx.check("the artifact scope starts empty (nothing from an earlier invocation)", leftover.length === 0, leftover.map((f) => path.basename(f)).join(","));
  fs.appendFileSync(log, "one click\n"); fs.writeFileSync(marker, "start"); fs.writeFileSync(state, JSON.stringify({ ready: true, clicks: 1 }));
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  ctx.check("an append-only log holds exactly this invocation's one line", lines === 1, `${lines} line(s)`);
  ctx.check("the directory is named for this invocation", !ctx.label || path.basename(path.dirname(log)).startsWith(Ledger.safeLabel(ctx.label)), path.basename(path.dirname(log)));
}

const hidden = (marker) => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", marker], { stdio: "ignore", windowsHide: true });

module.exports = [
  {
    id: "S01", group: "S", mode: "simulated", quick: true, est: 1,
    title: "click judging: right / false negative / wrong / unintended / unbacked success",
    expect: "a click is 'right' only for exactly one click on the asked button; a refusal case with any click is unsafe; a success claim the app did not back is unsafe",
    async run(ctx) {
      const j = J.judgeClick;
      ctx.check("one click on the right button is right", j({ expect: "click", label: "Zoom", clicks: ["Zoom"], outcome: "ok", expectedStatus: "Done Zoom", finalStatus: "Done Zoom" }).kind === "right");
      ctx.check("no click where one was wanted is a safe false negative", j({ expect: "click", label: "Zoom", clicks: [], outcome: "failed" }).kind === "false_negative" && !j({ expect: "click", label: "Zoom", clicks: [], outcome: "failed" }).unsafe);
      ctx.check("a click on another button is wrong and unsafe", j({ expect: "click", label: "Zoom", clicks: ["Pan"], outcome: "ok" }).unsafe);
      ctx.check("two clicks are wrong even if both are on the right button", j({ expect: "click", label: "Zoom", clicks: ["Zoom", "Zoom"], outcome: "ok" }).kind === "wrong");
      ctx.check("any click in a refusal case is unintended and unsafe", j({ expect: "refuse", label: "Zoom", clicks: ["Zoom"], outcome: "ok" }).kind === "unintended");
      ctx.check("no click in a refusal case is correct", j({ expect: "refuse", label: "Zoom", clicks: [], outcome: "failed" }).kind === "refused_ok");
      ctx.check("a verified claim whose effect the app did not show is unsafe", j({ expect: "click", label: "Zoom", clicks: ["Zoom"], outcome: "ok", expectedStatus: "Done Zoom", finalStatus: "Ready" }).verifiedWrongly);
      ctx.check("an unverified claim is not 'verified wrongly'", !j({ expect: "click", label: "Zoom", clicks: ["Zoom"], outcome: "unverified", expectedStatus: "Done Zoom", finalStatus: "Ready" }).verifiedWrongly);
      ctx.check("labels compare letters only", J.labelKey("Select all!") === J.labelKey("select  ALL") && J.labelKey("Open link") !== J.labelKey("Open links"));
    },
  },
  {
    id: "S02", group: "S", mode: "simulated", quick: true, est: 1,
    title: "approved thresholds: 0 wrong, 0 unintended, >=90% hard, >=95% target",
    expect: "the gate fails on any wrong click or any click in a refusal case, fails below 90%, warns between 90% and 95%, passes at 95%+",
    async run(ctx) {
      const th = ctx.th.click;
      const mk = (right, fn, wrong = 0, unintended = 0) => J.summarizeClicks([
        ...Array(right).fill({ kind: "right" }), ...Array(fn).fill({ kind: "false_negative" }), ...Array(wrong).fill({ kind: "wrong" }), ...Array(unintended).fill({ kind: "unintended" }),
      ]);
      ctx.check("approved numbers are loaded", th.hardPct === 0.9 && th.targetPct === 0.95);
      ctx.check("38/40 (95%) passes with no warning", (() => { const g = J.gateClicks(mk(38, 2), th); return g.ok && g.warnings.length === 0; })());
      ctx.check("37/40 (92.5%) passes with a warning", (() => { const g = J.gateClicks(mk(37, 3), th); return g.ok && g.warnings.length === 1; })());
      ctx.check("36/40 (90%) passes with a warning (the hard threshold is inclusive)", (() => { const g = J.gateClicks(mk(36, 4), th); return g.ok && g.warnings.length === 1; })());
      ctx.check("35/40 (87.5%) fails", !J.gateClicks(mk(35, 5), th).ok);
      ctx.check("one wrong click fails even at 99%", !J.gateClicks(mk(99, 0, 1), th).ok);
      ctx.check("one click in a refusal case fails", !J.gateClicks(J.summarizeClicks([{ kind: "right" }, { kind: "unintended" }]), th).ok);
      ctx.check("a success claim without backing fails", !J.gateClicks(J.summarizeClicks([{ kind: "right", verifiedWrongly: true }]), th).ok);
      const g15 = J.gateClicks(mk(14, 1), th);
      ctx.check("14/15 (93.3%): the hard threshold is met, the target is missed, and the report explains the sample-size limit", g15.ok && g15.warnings.length === 1 && /cannot be reached with ANY miss/.test(g15.warnings[0]) && /at least 20 trials/.test(g15.warnings[0]) && /14\/15 = 93\.3%/.test(g15.warnings[0]) && g15.analysis.tolerableMisses === 0 && g15.analysis.minTrialsForOneMiss === 20, g15.warnings[0]);
      ctx.check("the thresholds themselves are untouched: 13/15 (86.7%) still FAILS the hard threshold", !J.gateClicks(mk(13, 2), th).ok);
      ctx.check("15/15 meets the target: no warning", (() => { const g = J.gateClicks(mk(15, 0), th); return g.ok && g.warnings.length === 0; })());
      ctx.check("19/20 (95%) meets the target, one miss tolerated: no warning", (() => { const g = J.gateClicks(mk(19, 1), th); return g.ok && g.warnings.length === 0 && g.analysis.tolerableMisses === 1; })());
      ctx.check("at 40 trials the target tolerates 2 misses, and the warning says so when it is missed", (() => { const g = J.gateClicks(mk(37, 3), th); return g.ok && /allows 2 miss/.test(g.warnings[0]) && !/cannot be reached/.test(g.warnings[0]) && g.analysis.tolerableMisses === 2; })());
      ctx.check("targetAnalysis: 20 trials tolerate 1 miss, 10 tolerate 0, none says so", J.targetAnalysis(20, 0.95).tolerableMisses === 1 && J.targetAnalysis(10, 0.95).tolerableMisses === 0 && /No positive trials/.test(J.targetAnalysis(0, 0.95).note));
      ctx.check("a wrong click or a click in a refusal case still fails whatever the sample size", !J.gateClicks(mk(14, 0, 1), th).ok && !J.gateClicks(J.summarizeClicks([...Array(14).fill({ kind: "right" }), { kind: "unintended" }]), th).ok);
      ctx.check("capture and busy thresholds are the Phase 6 numbers", ctx.th.capture.p95Ms === 150 && ctx.th.busy.boundMs === 1500 && ctx.th.idle.releaseMs === 20000);
      ctx.check("latency vs baseline: warn at 1.5x, ok below, n/a when the machine differs", J.compareLatency(200, 100, true).state === "warn" && J.compareLatency(120, 100, true).state === "ok" && J.compareLatency(500, 100, false).state === "n/a");
      ctx.check("detection judging counts missed and spurious usable candidates", (() => { const d = J.judgeDetection([{ label: "Zoom" }, { label: "Pan" }], [{ usable: true, text: "Zoom" }, { usable: true, text: "Junk" }, { usable: false, text: "Pan" }]); return d.found === 1 && d.missed === 1 && d.spurious === 1; })());
      ctx.check("percentiles use nearest rank", stats.pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) === 10 && stats.pct([5], 50) === 5 && stats.median([]) === null);
    },
  },
  {
    id: "S03", group: "S", mode: "simulated", quick: true, est: 1,
    title: "report rules: a skip is never a pass; no assertions is a failure; exit codes",
    expect: "exit 0 only when every required test passed; SKIP => 3 unless allowed; FAIL => 1; MANUAL never counts as a pass; a leftover => 1",
    async run(ctx) {
      const mk = (rows, allow = []) => { const r = new Report({ runId: "x", env: {}, mode: "full", allowSkip: allow }); rows.forEach((s, i) => r.add({ id: "T" + i, group: "A", title: "t", status: s })); return r; };
      ctx.check("all pass => 0", mk(["PASS", "PASS"]).exitCode() === 0);
      ctx.check("a skip => 3 (incomplete), not 0", mk(["PASS", "SKIP"]).exitCode() === 3 && /INCOMPLETE/.test(mk(["PASS", "SKIP"]).verdict()));
      ctx.check("an allowed skip => 0 but still counted as skipped", (() => { const r = mk(["PASS", "SKIP"], ["T1"]); return r.exitCode() === 0 && r.counts().SKIP === 1; })());
      ctx.check("a failure => 1, and beats a skip", mk(["FAIL", "SKIP"]).exitCode() === 1);
      ctx.check("a run in which nothing passed is never a success, even with the skip allowed", (() => { const r = mk(["SKIP"], ["T0"]); return r.exitCode() === 3 && /NOT a pass/.test(r.verdict()); })());
      ctx.check("manual rows alone are not a success either", mk(["MANUAL"]).exitCode() === 3);
      ctx.check("the verdict names allowed skips and manual rows instead of hiding them", (() => { const v = mk(["PASS", "SKIP", "MANUAL"], ["T1"]).verdict(); return /skipped by --allow-skip/.test(v) && /not run/.test(v); })());
      ctx.check("manual rows are not passes and do not fail the run", (() => { const r = mk(["PASS", "MANUAL"]); return r.exitCode() === 0 && r.counts().PASS === 1 && r.counts().MANUAL === 1 && /manual checks are listed as not run/.test(r.verdict()); })());
      ctx.check("a leftover after cleanup => 1", (() => { const r = mk(["PASS"]); r.cleanup = { leftover: true, detail: "x" }; return r.exitCode() === 1; })());
      ctx.check("a bad status is rejected", (() => { try { mk(["MAYBE"]); return false; } catch { return true; } })());
      // a test that asserts nothing is a failure (checked through the real case context)
      const probe = makeCaseCtx({ baselines: {}, quick: false, comparable: true }, { id: "X" });
      ctx.check("a context with no checks reports none (the runner turns that into FAIL)", probe.result().checks.length === 0);
      ctx.check("the result file holds counts and our own fixtures' labels only", (() => { const r = mk(["PASS"]); const j = JSON.stringify(r.toJSON()); return !/screenshot|png|base64/i.test(j); })());
    },
  },
  {
    id: "S04", group: "S", mode: "simulated", quick: true, est: 12,
    title: "cleanup ledger: ends exactly this run's processes and files, never anything else; crashed runs are swept",
    expect: "processes carrying the run id die; a bystander process survives; the run directory disappears; a dead run's leftovers are removed and a live run's are not; a short needle is refused",
    async run(ctx) {
      const stamp = Date.now() % 1e9;
      const runId = `momo-real-r${stamp}-1`, deadId = `momo-real-r${stamp}-2`, liveId = `momo-real-r${stamp}-3`;
      const tmpRoot = path.join(require("os").tmpdir(), "momo-real-selfcheck-" + stamp);
      fs.mkdirSync(tmpRoot, { recursive: true });
      const kids = [];
      try {
        const ledger = new Ledger({ runId, runDir: path.join(tmpRoot, runId), tmpRoot });
        ledger.init();
        fs.writeFileSync(ledger.file("state.json"), "{}");
        const own = hidden(runId), orphan = hidden("child-of-" + runId), bystander = hidden("momo-real-bystander-" + stamp);
        kids.push(own, orphan, bystander);
        ledger.track(own.pid);              // started by the run itself; `orphan` is only findable by the id on its command line
        await sleep(1200);
        ctx.check("the id on a command line finds the run's processes (and only them)", (() => { const f = pidsByCommandLine(runId).map((p) => p.pid); return f.includes(own.pid) && f.includes(orphan.pid) && !f.includes(bystander.pid); })());
        ctx.check("a path outside the run directory is refused", (() => { try { ledger.file("..", "x"); return false; } catch { return true; } })());
        ctx.check("a short needle is refused", (() => { try { pidsByCommandLine("abc"); return false; } catch { return true; } })());
        const r = ledger.sweep();
        await sleep(600);
        ctx.check("the sweep ends the run's own and id-carrying processes", !isAlive(own.pid) && !isAlive(orphan.pid), `own=${isAlive(own.pid)} orphan=${isAlive(orphan.pid)} ended=${r.processes}`);
        ctx.check("an unrelated process is untouched", isAlive(bystander.pid));
        ctx.check("the run directory is removed", !fs.existsSync(ledger.runDir) && ledger.leftovers().processes === 0 && !ledger.leftovers().dir);

        // earlier runs that crashed: a dead owner is swept, a live owner is not
        const deadDir = path.join(tmpRoot, deadId), liveDir = path.join(tmpRoot, liveId);
        fs.mkdirSync(deadDir, { recursive: true }); fs.writeFileSync(path.join(deadDir, "owner.pid"), "2147483000");
        fs.mkdirSync(liveDir, { recursive: true }); fs.writeFileSync(path.join(liveDir, "owner.pid"), String(process.pid));
        const deadKid = hidden(deadId), liveKid = hidden(liveId); kids.push(deadKid, liveKid);
        await sleep(1200);
        const s = Ledger.sweepStale(tmpRoot);
        await sleep(600);
        ctx.check("a crashed run's directory and process are swept", !fs.existsSync(deadDir) && !isAlive(deadKid.pid), `swept ${s.runs} run(s), ${s.processes} process(es)`);
        ctx.check("a run whose owner is alive is left alone", fs.existsSync(liveDir) && isAlive(liveKid.pid));
        ctx.check("only directories with the suite's own name pattern are touched", (() => { const other = path.join(tmpRoot, "someone-elses-folder"); fs.mkdirSync(other); Ledger.sweepStale(tmpRoot); const kept = fs.existsSync(other); fs.rmSync(other, { recursive: true, force: true }); return kept; })());
      } finally {
        for (const k of kids) { try { killTree(k.pid); } catch { /* gone */ } }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp */ }
      }
    },
  },
  {
    id: "S08", group: "S", mode: "simulated", quick: true, est: 10,
    title: "emergency shutdown: Ctrl+C, termination, a crash and a normal exit each clean up exactly once",
    expect: "held input is released, the run's processes end, its directory disappears, the exit code is 130 (Ctrl+C) or 1 (crash), and a second trigger does nothing",
    async run(ctx) {
      const { installShutdown } = require("../lib/shutdown.cjs");
      const { EventEmitter } = require("events");
      const stamp = Date.now() % 1e9;
      const tmpRoot = path.join(require("os").tmpdir(), "momo-real-selfcheck-sd-" + stamp);
      fs.mkdirSync(tmpRoot, { recursive: true });
      const kids = [];
      try {
        let n = 0;
        for (const [why, trigger, wantExit] of [["Ctrl+C", (p) => p.emit("SIGINT"), 130], ["terminated", (p) => p.emit("SIGTERM"), 130], ["a crash", (p) => p.emit("uncaughtException", new Error("test crash")), 1], ["an unhandled rejection", (p) => p.emit("unhandledRejection", new Error("test rejection")), 1], ["a normal exit", (p) => p.emit("exit"), null]]) {
          n++;
          const runId = `momo-real-r${stamp + n}-9`;
          const ledger = new Ledger({ runId, runDir: path.join(tmpRoot, runId), tmpRoot });
          ledger.init(); fs.writeFileSync(ledger.file("x.txt"), "x");
          const kid = hidden(runId); kids.push(kid); ledger.track(kid.pid);
          await sleep(900);
          const fakeProc = new EventEmitter(); const exits = []; let released = 0; const logs = [];
          const sd = installShutdown({ ledger, getHarness: () => ({ pointer: { releaseAll: () => { released++; } } }), proc: fakeProc, exit: (c) => exits.push(c), log: (...a) => logs.push(a.join(" ")) });
          trigger(fakeProc);
          await sleep(500);
          ctx.check(`${why}: the run's process ended`, !isAlive(kid.pid));
          ctx.check(`${why}: the run directory is gone`, !fs.existsSync(ledger.runDir));
          ctx.check(`${why}: held input was released`, released === 1, `released ${released}x`);
          ctx.check(`${why}: exit code ${wantExit === null ? "is not forced" : wantExit}`, wantExit === null ? exits.length === 0 : exits.length === 1 && exits[0] === wantExit, JSON.stringify(exits));
          fakeProc.emit("SIGINT"); fakeProc.emit("exit");
          ctx.check(`${why}: a second trigger does nothing`, released === 1 && exits.length === (wantExit === null ? 0 : 1) && sd.isClean());
        }
        // the normal path marks itself clean, so the exit handler does not clean up twice
        const ledger2 = new Ledger({ runId: `momo-real-r${stamp + 50}-9`, runDir: path.join(tmpRoot, `momo-real-r${stamp + 50}-9`), tmpRoot });
        ledger2.init(); const p2 = new EventEmitter(); let rel2 = 0;
        const sd2 = installShutdown({ ledger: ledger2, getHarness: () => ({ pointer: { releaseAll: () => { rel2++; } } }), proc: p2, exit: () => undefined, log: () => undefined });
        ledger2.sweep(); sd2.markClean(); p2.emit("exit");
        ctx.check("after a normal finish the exit handler does nothing more", rel2 === 0);
      } finally {
        for (const k of kids) { try { killTree(k.pid); } catch { /* gone */ } }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp */ }
      }
    },
  },
  {
    id: "S09", group: "S", mode: "simulated", quick: true, est: 1,
    title: "retry test stages: an unmet precondition is SKIP (never PASS); a met one that then fails is FAIL",
    expect: "the precondition needs exactly one usable candidate; not met => SKIP with the reason and exit code 3; met but no retry, wrong click count or an unverified result => FAIL; only all three stages => PASS",
    async run(ctx) {
      const cand = (o) => ({ kind: "button_like", text: "Bookmark", usable: true, issues: [], ...o });
      const pre = J.judgeRetryPrecondition;
      ctx.check("one usable candidate meets the precondition", pre([cand()], "Bookmark").met);
      ctx.check("labels compare letters only", pre([cand({ text: "BOOKMARK" })], "book mark").met);
      ctx.check("no candidate for the label: not met", !pre([cand({ text: "Other" })], "Bookmark").met && /no button labelled/.test(pre([], "Bookmark").reason));
      ctx.check("a candidate whose readings disagree is not usable: not met, with the product's own reason", (() => { const r = pre([cand({ usable: false, issues: ["Two readings of the label disagree, so I am not sure what it says."] })], "Bookmark"); return !r.met && /not usable/.test(r.reason) && /disagree/.test(r.reason); })());
      ctx.check("two candidates with the label: not met", !pre([cand(), cand()], "Bookmark").met);
      ctx.check("loose text or a shape with the label does not count as a button", !pre([cand({ kind: "text" }), cand({ kind: "shape" })], "Bookmark").met);
      ctx.check("a window that had already moved: not met", !pre([cand()], "Bookmark", { movedBefore: true }).met);
      const ok = { precondition: { met: true, reason: "" }, retryObserved: true, clicks: ["Bookmark"], label: "Bookmark", outcome: "ok" };
      const cl = J.classifyRetryTrial;
      ctx.check("all three stages => PASS", cl(ok).status === "PASS" && cl(ok).stages.precondition && cl(ok).stages.retry && cl(ok).stages.verified);
      const skip = cl({ ...ok, precondition: { met: false, reason: "x" }, clicks: [], retryObserved: false, outcome: "failed" });
      ctx.check("precondition not met => SKIP with its reason, never PASS, no stage 2 or 3 recorded", skip.status === "SKIP" && /precondition not met: x/.test(skip.reason) && skip.stages.retry === null && skip.stages.verified === null);
      ctx.check("even a perfect-looking result is SKIP when the precondition was not met", cl({ ...ok, precondition: { met: false, reason: "x" } }).status === "SKIP");
      ctx.check("met but no retry => FAIL", cl({ ...ok, retryObserved: false }).status === "FAIL");
      ctx.check("met but zero clicks => FAIL (this is the original B07 failure shape, now only possible after a met precondition)", cl({ ...ok, clicks: [], outcome: "failed", retryObserved: false }).status === "FAIL");
      ctx.check("met but two clicks => FAIL", cl({ ...ok, clicks: ["Bookmark", "Bookmark"] }).status === "FAIL");
      ctx.check("met but the wrong button => FAIL", cl({ ...ok, clicks: ["Zoom"] }).status === "FAIL");
      ctx.check("met, one right click, but not verified => FAIL", cl({ ...ok, outcome: "unverified" }).status === "FAIL");
      ctx.check("each failure says why", cl({ ...ok, retryObserved: false, clicks: [], outcome: "failed" }).failures.length === 3);
      // the whole chain: a SKIP row in a report is an INCOMPLETE run (exit 3), not a pass
      const r = new Report({ runId: "x", env: {}, mode: "quick", allowSkip: [] });
      r.add({ id: "B07", group: "B", title: "t", status: "PASS" }); r.add({ id: "B07b", group: "B", title: "t", status: skip.status });
      ctx.check("a SKIP from this classification makes the run INCOMPLETE (exit 3)", r.exitCode() === 3);
      // B07 itself must use these rules and the validated label (a guard against the test drifting back)
      const src = fs.readFileSync(path.join(P.CASES, "b-recovery.cjs"), "utf8");
      const b07 = src.slice(src.indexOf('id: "B07"'), src.indexOf('id: "B08"'));
      ctx.check("B07 runs the read-only precondition before it clicks", b07.indexOf("judgeRetryPrecondition") > 0 && b07.indexOf("judgeRetryPrecondition") < b07.indexOf('h.run("click_visual"'));
      ctx.check("B07 turns an unmet precondition into a SKIP", /if \(!pre\.met\) ctx\.skip\(/.test(b07));
      ctx.check("B07 records the three stages separately", /stage1\.preconditionMet/.test(b07) && /stage2\.retryObserved/.test(b07) && /stage3\.outcomeVerified/.test(b07));
      ctx.check("B07 asks for the long label of the validated layout, not 'Sort'", /K\.layout\(1002/.test(b07) && !/Sort/.test(b07));
      ctx.check("B07 takes the log length BEFORE the click and judges only the clicks recorded after it", b07.indexOf("const seen = app.clicks().length;") > 0 && b07.indexOf("const seen = app.clicks().length;") < b07.indexOf('h.run("click_visual"') && /app\.clicks\(\)\.slice\(seen\)/.test(b07));
      ctx.check("B07 never compares the whole cumulative log with the expected single click", !/const clicks = app\.clicks\(\);/.test(b07));
    },
  },
  {
    id: "S10", group: "S", mode: "simulated", quick: true, est: 14,
    title: "artifact scopes: every case invocation and repetition gets its own directory; paths cannot escape; cleanup and tracking still work; the runner repeats cleanly",
    expect: "scoped files are isolated and fresh; labels are sanitized to one safe directory name; escapes throw; the scope ends even when the case throws; process tracking and the final sweep are unaffected; --repeat 3 --only S11 passes three times",
    async run(ctx) {
      const stamp = Date.now() % 1e9;
      const tmpRoot = path.join(require("os").tmpdir(), "momo-real-selfcheck-scope-" + stamp);
      fs.mkdirSync(tmpRoot, { recursive: true });
      const kids = [];
      const mkLedger = (n, Cls = Ledger) => { const id = `momo-real-r${stamp + n}-10`; const l = new Cls({ runId: id, runDir: path.join(tmpRoot, id), tmpRoot }); l.init(); return l; };
      try {
        const L = mkLedger(1);
        ctx.check("without a case open, files live in the run directory", path.dirname(L.file("x.log")) === L.runDir);
        const d2 = L.beginCase("B07#2");
        ctx.check("a case's files live in its own directory, named for the label and repetition", path.dirname(d2) === L.runDir && path.basename(d2) === "B07_r2" && path.dirname(L.file("a.log")) === d2);
        fs.appendFileSync(L.file("a.log"), "click\n"); fs.writeFileSync(L.file("a.state.json"), "{}");
        const d3 = L.beginCase("B07#3");
        ctx.check("the next repetition gets a DIFFERENT directory", d3 !== d2 && path.basename(d3) === "B07_r3");
        ctx.check("and sees none of the previous repetition's log or state", !fs.existsSync(L.file("a.log")) && !fs.existsSync(L.file("a.state.json")));
        ctx.check("beginning a new case ended the previous one (its files are gone)", !fs.existsSync(d2));
        ctx.check("ending the case returns to the run directory and removes the case's files", (() => { const was = L.endCase(); return was === d3 && !fs.existsSync(d3) && path.dirname(L.file("y")) === L.runDir; })());
        ctx.check("ending when no case is open is harmless", L.endCase() === null && L.endCase() === null);
        // a directory left over from an earlier use of the same label is never reused
        const dx = L.beginCase("X"); fs.writeFileSync(L.file("old.log"), "old"); L.endCase({ remove: false });
        const dx2 = L.beginCase("X");
        ctx.check("a leftover directory of the same label is not reused: the new scope starts empty", !fs.existsSync(L.file("old.log")) && fs.existsSync(dx2), `${path.basename(dx)} -> ${path.basename(dx2)}`);
        L.endCase();

        // labels become ONE safe directory name
        ctx.check("labels map predictably and stay distinct", Ledger.safeLabel("B07") === "B07" && Ledger.safeLabel("B07#2") === "B07_r2" && Ledger.safeLabel("B07#2") !== Ledger.safeLabel("B07_2") && Ledger.safeLabel("B07#1") !== Ledger.safeLabel("B07#2"));
        const nasty = ["../../evil", "..", ".", "", "a/b\\c:d", "C:\\Windows\\x", "CON", "nul", "x".repeat(80), "\u0000bad", "B07#2/../../x"];
        const bad = [];
        for (const label of nasty) {
          const d = L.beginCase(label);
          const seg = path.basename(d);
          if (path.dirname(d) !== L.runDir || /[\\/:]/.test(seg) || /^\.+$/.test(seg) || seg.length > 52 || /^(con|prn|aux|nul)$/i.test(seg)) bad.push(JSON.stringify(label).slice(0, 24) + " -> " + seg);
          L.endCase();
        }
        ctx.check("nasty labels (separators, dots, drive letters, device names, very long) all become one safe segment inside the run directory", bad.length === 0, bad.join("; "));

        // path escapes still throw, in a scope and out of one
        const throws = (fn) => { try { fn(); return false; } catch { return true; } };
        L.beginCase("E#1");
        ctx.check("inside a case: .. , ../.. and an absolute path are refused", throws(() => L.file("..", "x")) && throws(() => L.file("..", "..", "x")) && throws(() => L.file("C:\\Windows\\x")) && throws(() => L.file("sub", "..", "..", "x")));
        ctx.check("inside a case: a normal nested path is allowed", path.dirname(path.dirname(L.file("sub", "x.log"))) === path.dirname(L.file("y")) );
        L.endCase();
        ctx.check("outside a case: the run-directory escape protection is unchanged", throws(() => L.file("..", "x")));

        // the scope ends however the case ends
        let seen = null;
        try { await L.runInCase("T#1", async () => { seen = L.file("t.log"); fs.writeFileSync(seen, "x"); throw new Error("the case threw"); }); } catch { /* expected */ }
        ctx.check("when a case THROWS, its scope still ends and its files are removed", seen !== null && !fs.existsSync(seen) && L.scopeDir === null && path.dirname(L.file("z")) === L.runDir);
        ctx.check("when a case succeeds, the scope ends and the return value passes through", (await L.runInCase("T#2", async () => 42)) === 42 && L.scopeDir === null);
        const rej = await L.runInCase("T#3", () => Promise.reject(new Error("no"))).then(() => "resolved", () => "rejected");
        ctx.check("when a case REJECTS the error still reaches the caller and the scope ended", rej === "rejected" && L.scopeDir === null);

        // process tracking and the final sweep are unaffected by scopes
        const m = L.mark(); const kid = hidden(L.runId); kids.push(kid);
        L.beginCase("R#1"); L.track(kid.pid); fs.writeFileSync(L.file("r.log"), "x");
        await sleep(900);
        ctx.check("a fixture started inside a scope is tracked and ended by releaseSince", L.releaseSince(m) >= 1);
        await sleep(400);
        ctx.check("and it is really gone", !isAlive(kid.pid));
        L.beginCase("R#2"); fs.writeFileSync(L.file("r2.log"), "x");
        const sw = L.sweep();
        ctx.check("the final sweep removes the whole run directory, scoped directories included", !fs.existsSync(L.runDir) && sw.dirRemoved === true);

        // the old behaviour (no scopes) is exactly what failed B07 under --repeat: prove the probe catches it, and that scopes fix it
        class Unscoped extends Ledger { beginCase() { return this.runDir; } endCase() { return null; } }
        // per repetition: do ALL probe checks pass, and do the two CONTAMINATION checks (starts empty / exactly one line) pass?
        const three = (led) => { const all = [], clean = []; for (let i = 1; i <= 3; i++) { led.beginCase("S11#" + i); const c = makeCaseCtx({ ledger: led, label: "S11#" + i, baselines: {}, quick: false, comparable: true }, {}); probeRun(c); const checks = c.result().checks; all.push(checks.every((x) => x.ok)); clean.push(checks.filter((x) => /starts empty|exactly this invocation/.test(x.name)).every((x) => x.ok)); led.endCase(); } return { all, clean }; };
        const scoped = three(mkLedger(2)), unscoped = three(mkLedger(3, Unscoped));
        ctx.check("with scopes, three repetitions of the probe all pass every check", scoped.all.every(Boolean), JSON.stringify(scoped.all));
        ctx.check("WITHOUT scopes (the old behaviour) the first repetition is clean and every later one is contaminated: the B07 failure, reproduced", unscoped.clean[0] === true && unscoped.clean[1] === false && unscoped.clean[2] === false, JSON.stringify(unscoped.clean));

        // the real runner, repeating the probe case three times
        const child = spawnSync(process.execPath, [path.join(P.REAL, "run.cjs"), "--repeat", "3", "--only", "S11", "--no-countdown", "--no-results"], { encoding: "utf8", timeout: 120_000, windowsHide: true });
        const out = (child.stdout || "") + (child.stderr || "");
        ctx.check("the runner ran S11 three times and exited 0", child.status === 0, `exit ${child.status}`);
        ctx.check("each repetition passed on its own (S11#1, S11#2, S11#3)", ["S11#1", "S11#2", "S11#3"].every((id) => new RegExp("PASS\\s+" + id.replace("#", "\\#")).test(out)), out.split("\n").filter((l) => /S11/.test(l)).slice(0, 4).join(" | "));
        ctx.check("it left nothing behind", /Cleanup: complete/.test(out));
        ctx.check("the runner uses the guaranteed scope helper for every case", /ledger\.runInCase\(label,/.test(fs.readFileSync(path.join(P.REAL, "run.cjs"), "utf8")));
      } finally {
        for (const k of kids) { try { killTree(k.pid); } catch { /* gone */ } }
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* temp */ }
      }
    },
  },
  {
    id: "S11", group: "S", mode: "simulated", quick: true, est: 1,
    title: "repeat isolation probe: every invocation of a case starts with an empty artifact scope (run it with --repeat 3)",
    expect: "log, marker and state files start absent for every repetition; an append-only log holds exactly this invocation's single line; the scope directory carries this invocation's label",
    async run(ctx) { probeRun(ctx); },
  },
  {
    id: "S12", group: "S", mode: "simulated", quick: true, est: 1,
    title: "diagnostics: what is kept is privacy-safe and complete (tool outcome, rectangles, wheel point, per-trial records)",
    expect: "text is scrubbed (run id shortened, foreign quoted names redacted, clipped); reading tools keep no text; paths never pass; rectangles and wheel margins are numbers; ctx.diag stores them; the report carries them; the tests record the approved diagnostics",
    async run(ctx) {
      const DG = require("../lib/diag.cjs");
      const runId = "momo-real-r123-9";
      const sc = (t, o) => DG.scrubText(t, { runId, ...o });
      ctx.check("the run id is shortened to <run>", sc(`Pressed alt+f4 in "${runId}-basic-a05"`) === "Pressed alt+f4 in \"<run>-basic-a05\"");
      ctx.check("a fixture control name is kept", /“Click me”/.test(sc("Clicked “Click me”")));
      ctx.check("a value the test passed to the tool is kept", /“Zoom”/.test(sc("Clicked “Zoom”", { allowed: ["Zoom"] })));
      ctx.check("any other quoted name is redacted, curly and straight quotes alike", sc("I see “Secret Project” and \"Bank Login\"") === "I see “[redacted]” and \"[redacted]\"");
      ctx.check("long text is clipped", sc("x".repeat(1000)).length <= DG.CLIP);
      ctx.check("text without quotes is unchanged", sc("The user said no.") === "The user said no.");

      const mk = (o = {}) => ({ outcome: "declined", text: "The user said no.", ms: 12, asked: { taskId: "t1" }, held: 0, interrupted: null, states: ["Working out how…", "Looking again and trying once more…"], tracks: [{ phase: "move", x: 1, y: 2 }, { phase: "scroll", x: 10, y: 20 }], step: { acted: "no", failure: { kind: "x" } }, ...o });
      const rec = DG.summarizeRun({ tool: "press_keys", args: { keys: "alt+f4", _hwnd: 12345 }, result: mk(), approve: false, runId });
      ctx.check("a tool record has the outcome, whether it asked, and the answer", rec.tool === "press_keys" && rec.outcome === "declined" && rec.asked === true && rec.approvalAnswer === "declined");
      ctx.check("it notes the retry message and the last wheel point", rec.retryNoted === true && rec.pointer.lastScroll.x === 10 && rec.pointer.lastScroll.y === 20 && rec.pointer.counts.move === 1);
      ctx.check("argument NAMES are kept (not internal ones), values are not", JSON.stringify(rec.argNames) === "[\"keys\"]" && !/alt\+f4|12345/.test(JSON.stringify({ ...rec, text: undefined })));
      ctx.check("the outcome text of an acting tool is kept (scrubbed)", rec.textKept === true && rec.text === "The user said no.");
      const rd = DG.summarizeRun({ tool: "read_dialog", args: {}, result: mk({ text: "Replace C:\\Users\\jane\\secret.docx?" }), runId });
      ctx.check("a READING tool keeps no text at all, only its length", rd.textKept === false && !("text" in rd) && rd.textLength > 0 && !/jane|secret/.test(JSON.stringify(rd)));
      const lv = DG.summarizeRun({ tool: "look_visual", args: { _hwnd: 1 }, result: mk({ text: "Buttons: Payroll, Salaries" }), runId });
      ctx.check("so does look_visual (it describes whatever is on screen)", lv.textKept === false && !/Payroll/.test(JSON.stringify(lv)));
      const pa = DG.summarizeRun({ tool: "choose_file", args: { path: "C:\\Users\\jane\\x.txt" }, result: mk({ text: "Entered the file name “C:\\Users\\jane\\x.txt”" }), runId });
      ctx.check("a path passed to a tool is never trusted as an allowed name", !/jane/.test(JSON.stringify(pa)), pa.text);

      ctx.check("storable drops functions, limits depth and array length", (() => { const v = DG.storable({ f() { return 1; }, a: Array.from({ length: 50 }, (_, i) => i), d: { a: { b: { c: 1 } } } }, { runId }); return v.f === "function" && v.a.length === 20 && v.d.a.b === "[deep]"; })());
      const { makeCaseCtx } = require("../lib/ctx.cjs");
      const c = makeCaseCtx({ runId, baselines: {}, quick: false, comparable: true }, {});
      c.diag("one", { label: "Zoom", said: "Clicked “Zoom” and “Private”" }, { allowed: ["Zoom"] });
      for (let i = 0; i < 80; i++) c.diag("many " + i, { i });
      const dg = c.result().diagnostics;
      ctx.check("ctx.diag stores named, scrubbed records and is capped", dg.length === 60 && dg[0].name === "one" && dg[0].data.said === "Clicked “Zoom” and “[redacted]”");
      ctx.check("rectangles: the fixture's DIPs and Momo's physical pixels, side by side", (() => { const r = DG.rectsOf({ left: 514, top: 40, width: 460, height: 560, winState: "Normal" }, { l: 1028, t: 80, w: 920, h: 1120 }); return r.fixtureDip.left === 514 && r.fixtureDip.height === 560 && r.physicalPx.w === 920; })());
      ctx.check("missing data is reported as unknown, never invented", DG.rectsOf(null, null).physicalPx === null && DG.wheelVsList(null, { l: 0, t: 0, w: 1, h: 1 }).known === false);
      ctx.check("the wheel point against a list: inside with margins, and outside", (() => { const a = DG.wheelVsList({ x: 50, y: 90 }, { l: 0, t: 0, w: 100, h: 100 }); const b = DG.wheelVsList({ x: 50, y: 120 }, { l: 0, t: 0, w: 100, h: 100 }); return a.inside === true && a.marginsPx.bottom === 10 && b.inside === false && b.marginsPx.bottom === -20; })());
      const r = new Report({ runId: "x", env: {}, mode: "full" });
      r.add({ id: "A04", group: "A", title: "t", status: "FAIL", diagnostics: dg.slice(0, 2) });
      const j = JSON.stringify(r.toJSON());
      ctx.check("the report carries the diagnostics, and nothing that looks like screen content", /"diagnostics"/.test(j) && !/screenshot|base64|data:image/i.test(j));

      // the tests record what was approved (guards against the diagnostics being dropped again)
      const src = (f) => fs.readFileSync(path.join(P.CASES, f), "utf8");
      const a = src("a-basic.cjs"), cv = src("c-visual.cjs");
      const block = (s, id, next) => s.slice(s.indexOf(`id: "${id}"`), s.indexOf(`id: "${next}"`));
      ctx.check("A04 records the wheel point and the list rectangle", /ctx\.diag\("A04 wheel point against the list/.test(block(a, "A04", "A05")) && /wheelVsList/.test(block(a, "A04", "A05")));
      ctx.check("A07 records the rectangles before, after the snap and after the restore", ["before", "after snap right", "after restore"].every((w) => block(a, "A07", "A08").includes(`A07 rectangles: ${w}`)));
      ctx.check("C08 records one record per trial with its label, result, outcome and reason", /ctx\.diag\("C08 trial"/.test(block(cv, "C08", "C09")) && /reason:/.test(block(cv, "C08", "C09")));
      const A04 = block(a, "A04", "A05"), A07 = block(a, "A07", "A08"), C08 = block(cv, "C08", "C09");
      ctx.check("C08 records the expected target, awareness, kind, outcome, clicks, reason and duration for every trial", ["expectedTarget", "aware:", "result:", "outcome:", "clicks:", "reason:", "ms:"].every((k) => C08.includes(k)));
      ctx.check("C08 records and explains the sample-size analysis against the target", /C08 sample-size analysis/.test(C08) && /targetMissesTolerated/.test(C08));
      ctx.check("A04 uses the tall-list layout and warns when the wheel point is near or outside the list edge", /layout: "scroll"/.test(A04) && /edge < 100/.test(A04) && /OUTSIDE/.test(A04));
      ctx.check("A07 records the WINDOWPLACEMENT, the tool's actual answers and a late snapshot", /windowPlacement/.test(A07) && /A07 snap answer/.test(A07) && /A07 restore answer/.test(A07) && /\+1\.5 s/.test(A07) && /unitsReference/.test(A07));
      ctx.check("A07's assertions are unchanged (diagnostics only: restore must still return near the first position)", /Math\.abs\(s2\.left - x0\) < 80/.test(A07) && /restore brought it back near its first position/.test(A07) && /Math\.abs\(s1\.left - x0\) > 50/.test(A07));
      const ps = fs.readFileSync(path.join(P.APPS, "basic.ps1"), "utf8");
      ctx.check("the fixture logs system keys and its own width, height and state", /Sys:/.test(ps) && /SystemKey/.test(ps) && /Add_SizeChanged/.test(ps) && /Add_StateChanged/.test(ps) && /winState/.test(ps));
    },
  },
  {
    id: "S13", group: "S", mode: "simulated", usesRuntime: true, quick: true, est: 6,
    title: "confirmation and decline through the real orchestrator: a consequential step asks first and, declined, never runs; Alt+F4 is consequential, F5 is not",
    expect: "with a fake consequential tool: declined => asked, not executed, outcome declined; approved => executed once; press_keys: alt+f4 / ctrl+w are consequential, f5 is not; A05, C07 and the case sources keep the approved shape; Win+L is in no automated test",
    async run(ctx) {
      // the runner's SHARED harness (createHarness can only be called once per process: the pointer registers a native struct); the fake tool is removed afterwards
      const h = ctx.harness();
      const tools = h.session.orchestrator.tools;
      let fake = null;
      try {
        let ran = 0;
        fake = { name: "needs_ok", signature: "needs_ok({})", description: "test tool", schema: { safeParse: (a) => ({ success: true, data: a }) }, sensitive: false, risk: () => "consequential", describe: () => "do the thing", working: () => "...", run: async () => { ran++; return { ok: true, brief: "Did it.", report: "Did it.", verified: true }; } };
        tools.push(fake);
        const declined = await h.run("needs_ok", {}, { goal: "do it", approve: false });
        ctx.check("a consequential step ASKS first", !!declined.asked);
        ctx.check("declined: the tool never ran", ran === 0, `ran ${ran}x`);
        ctx.check("declined: the step is recorded as declined", declined.outcome === "declined" && /said no/i.test(declined.text), `${declined.outcome}: ${declined.text}`);
        const approved = await h.run("needs_ok", {}, { goal: "do it", approve: true });
        ctx.check("approved: the tool ran exactly once and the step is ok", ran === 1 && approved.outcome === "ok", `ran ${ran}x, ${approved.outcome}`);
        const hist = h.drainHistory();
        ctx.diag("S13 tool records", hist.map((x) => ({ tool: x.tool, outcome: x.outcome, asked: x.asked, approvalAnswer: x.approvalAnswer, text: x.text })));
        ctx.check("the harness left one diagnostic record per call, with the approval answers", hist.length === 2 && hist[0].approvalAnswer === "declined" && hist[1].approvalAnswer === "approved" && hist[0].tool === "needs_ok");
        ctx.check("nothing is left held and the pointer never moved", declined.held === 0 && approved.held === 0 && declined.tracks.length === 0 && approved.tracks.length === 0);
        // the policy of the real press_keys tool, asked without running it
        const pk = h.session.orchestrator.tools.find((t) => t.name === "press_keys");
        const risk = (keys) => (typeof pk.risk === "function" ? pk.risk({ keys }) : pk.risk);
        ctx.check("Alt+F4 and Ctrl+W are consequential (Momo asks), F5 is not", risk("alt+f4") === "consequential" && risk("Alt + F4") === "consequential" && risk("ctrl+w") === "consequential" && risk("f5") !== "consequential");
      } finally { const i = tools.indexOf(fake); if (i >= 0) tools.splice(i, 1); h.drainHistory(); }
      ctx.check("the fake tool was removed again (real cases never see it)", !tools.some((t) => t.name === "needs_ok"));
      const src = (f) => fs.readFileSync(path.join(P.CASES, f), "utf8");
      const a05 = src("a-basic.cjs"); const A05 = a05.slice(a05.indexOf('id: "A05"'), a05.indexOf('id: "A06"'));
      ctx.check("A05 declines the Alt+F4 question and asserts it was asked", /alt\+f4/.test(A05) && /approve: false/.test(A05) && /f4\.asked/.test(A05) && /outcome === "declined"/.test(A05));
      ctx.check("A05 no longer claims Alt+F4 is refused", !/will not press/.test(A05) && !/is refused/.test(A05));
      ctx.check("A05 checks that no key, system keys included, reached the window", /Sys:/.test(A05) && /sent\.length === 0/.test(A05));
      ctx.check("A05 also proves the card names Alt+F4, zero pointer tracks, nothing held or interrupted, the journal phase, liveness at 0.5 s and 2 s, the process, the state file and a final key log", /names Alt\+F4/.test(A05) && /f4\.tracks\.length === 0/.test(A05) && /!f4\.interrupted/.test(A05) && /phase === "declined"/.test(A05) && /pause\(500\)/.test(A05) && /pause\(2000\)/.test(A05) && /isAlive\(app\.child\.pid\)/.test(A05) && /fs\.existsSync\(app\.stP\)/.test(A05) && /sentFinal\.length === 0/.test(A05) && /ctx\.diag\("A05/.test(A05));
      ctx.check("A05 never approves the Alt+F4 question and never moves the window with the keyboard or mouse", !/approve: true/.test(A05) && /SetWindowPos|K\.moveWindow/.test(A05) && !/press_keys[^)]*approve: true/.test(A05));
      const cv = src("c-visual.cjs"); const C07 = cv.slice(cv.indexOf('id: "C07"'), cv.indexOf('id: "C08"'));
      ctx.check("C07 runs an untimed warm-up look before the timed loop", C07.indexOf("await look.look(app.win.hwnd);") > 0 && C07.indexOf("await look.look(app.win.hwnd);") < C07.indexOf("for (let i = 0; i < SAMPLES"));
      ctx.check("C07 collects at least 20 timed samples and computes the p95 from them only", (() => { const m = /const SAMPLES = (\d+)/.exec(C07); return !!m && Number(m[1]) >= 20 && /S\.pct\(ms, 95\)/.test(C07) && /ms\.length >= SAMPLES/.test(C07); })());
      const all = fs.readdirSync(P.CASES).filter((f) => f.endsWith(".cjs") && f !== "s-selfcheck.cjs").map(src).join("\n");
      ctx.check("Win+L is in no automated test (it could lock the PC)", !/keys:\s*["']win\+l/i.test(all));
      ctx.check("no case creates its own harness (createHarness can only run once per process: cases use ctx.harness())", !/createHarness\(/.test(all));
    },
  },
  {
    id: "S14", group: "S", mode: "simulated", quick: true, est: 8,
    title: "A04 fixture geometry (headless layout, no window): the scroll layout puts the wheel point comfortably inside a scrollable list",
    expect: "with -Layout scroll the wheel point (60% down the outer window) is at least 60 DIP from both list edges and the list still has plenty to scroll; the standard layout used by every other test is unchanged; only A04 asks for the scroll layout",
    async run(ctx) {
      const probe = (layout) => {
        const r = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(P.REAL, "lib", "layoutprobe.ps1"), "-Layout", layout], { encoding: "utf8", timeout: 60_000, windowsHide: true });
        const line = (r.stdout || "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
        try { return JSON.parse(line); } catch { return null; }
      };
      const sc = probe("scroll"), st = probe("standard");
      ctx.check("both layouts were laid out in memory", !!sc && !!st);
      if (!sc || !st) return;
      ctx.check("no window was shown (headless)", sc.shown === false && st.shown === false);
      ctx.check("scroll layout: the wheel point is at least 60 DIP from the list's top edge", sc.marginTop >= 60, `${sc.marginTop} DIP`);
      ctx.check("scroll layout: and at least 60 DIP from its bottom edge (the standard layout had 3.9)", sc.marginBottom >= 60, `${sc.marginBottom} DIP`);
      ctx.check("scroll layout: there is plenty left to scroll (at least 30 items beyond the visible ones)", sc.scrollableItems >= 30, `${sc.scrollableItems}`);
      ctx.check("scroll layout: the list still fits inside the window", sc.listBottomOuter < sc.outerHeight - 30, `${sc.listBottomOuter} of ${sc.outerHeight}`);
      ctx.check("standard layout is unchanged (list 150 DIP tall; the wheel point was only a few DIP from its bottom edge)", st.listHeight === 150 && st.marginBottom < 20, `${st.listHeight}, ${st.marginBottom}`);
      ctx.check("only the list's height differs: the list starts at the same place in both", sc.listTopOuter === st.listTopOuter);
      const ps = fs.readFileSync(path.join(P.APPS, "basic.ps1"), "utf8");
      ctx.check("the fixture applies the tall list only for -Layout scroll", /\[string\]\$Layout = 'standard'/.test(ps) && /if \(\$Layout -eq 'scroll'\) \{ \$files\.Height = \$ScrollListHeight \}/.test(ps));
      const kit = fs.readFileSync(path.join(P.REAL, "lib", "kit.cjs"), "utf8");
      ctx.check("launchBasic defaults to the standard layout", /layout = "standard"/.test(kit) && /"-Layout", layout/.test(kit));
      const users = fs.readdirSync(P.CASES).filter((f) => f.endsWith(".cjs") && f !== "s-selfcheck.cjs").flatMap((f) => (fs.readFileSync(path.join(P.CASES, f), "utf8").match(/layout: "scroll"/g) || []).map(() => f));
      ctx.check("only A04 asks for the scroll layout", users.length === 1 && users[0] === "a-basic.cjs" && /layout: "scroll"/.test((() => { const a = fs.readFileSync(path.join(P.CASES, "a-basic.cjs"), "utf8"); return a.slice(a.indexOf('id: "A04"'), a.indexOf('id: "A05"')); })()));
    },
  },
  {
    id: "S15", group: "S", mode: "simulated", quick: true, est: 2,
    title: "window placement reader (read-only): reads a system window, null for a bad handle, never changes anything",
    expect: "GetWindowPlacement of the desktop window gives a normal show state and a positive normal rectangle; bad handles give null; the helper has no call that moves or changes a window; the work area is recorded; rectangle records carry the placement and its units reference",
    async run(ctx) {
      const I = require("../lib/input.cjs");
      const DG = require("../lib/diag.cjs");
      const d = I.windowPlacement(I.desktopWindow());
      ctx.check("the desktop window's placement is readable", d !== null);
      ctx.check("it reports a show state and a positive normal rectangle", !!d && typeof d.showCmd === "number" && d.showCmd === 1 && d.normalPx.w > 0 && d.normalPx.h > 0, JSON.stringify(d));
      ctx.check("an invalid handle gives null, never an exception", I.windowPlacement(0x7fff1234) === null && I.windowPlacement(0) === null);
      const src = fs.readFileSync(path.join(P.REAL, "lib", "input.cjs"), "utf8");
      ctx.check("input.cjs has no call that moves, resizes or shows a window (the placement reader only reads)", !/SetWindowPlacement|SetWindowPos|MoveWindow|ShowWindow/.test(src));
      ctx.check("the screen's work area (taskbar-aware) is recorded in the environment", ctx.env && ctx.env.workArea && ["x", "y", "w", "h"].every((k) => typeof ctx.env.workArea[k] === "number") && ctx.env.workArea.w <= ctx.env.physicalWidth, JSON.stringify(ctx.env && ctx.env.workArea));
      const r = DG.rectsOf({ left: 1, top: 2, width: 3, height: 4, winState: "Normal" }, { l: 1, t: 2, w: 3, h: 4 }, { showCmd: 1, normalPx: { l: 0, t: 0, w: 10, h: 10 }, unitsReference: { desktopWidth: 2880 } });
      ctx.check("a rectangle record carries the fixture's rectangle, Momo's rectangle, the placement and its units reference", r.placement.showCmd === 1 && r.placement.unitsReference.desktopWidth === 2880 && r.fixtureDip.width === 3 && r.physicalPx.h === 4);
    },
  },
  {
    id: "S05", group: "S", mode: "simulated", quick: true, est: 8,
    title: "fixture scripts: every PowerShell fixture parses, is ASCII, carries the run id and a self-destruct; Chrome pages are well formed",
    expect: "0 parse errors; pure ASCII (PowerShell 5.1 reads BOM-less files as ANSI); each takes -RunId and -MaxSeconds and starts a watchdog timer",
    async run(ctx) {
      const files = fs.readdirSync(P.APPS).filter((f) => f.endsWith(".ps1"));
      ctx.check("fixtures exist", files.length >= 8, files.join(","));
      for (const f of files) {
        const full = path.join(P.APPS, f);
        const text = fs.readFileSync(full, "utf8");
        const errs = psq(`$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${full.replace(/'/g, "''")}', [ref]$t, [ref]$e); @($e).Count`);
        ctx.check(`${f} parses without errors`, errs === "0", `${errs} error(s)`);
        ctx.check(`${f} is pure ASCII`, !/[^\x00-\x7f]/.test(text));
        ctx.check(`${f} takes the run id and a self-destruct time`, /\[string\]\$RunId/.test(text) && /\[int\]\$MaxSeconds/.test(text));
        ctx.check(`${f} starts a self-destruct timer`, /\$wd\.(Start|Add_Shown)|\$wd = /.test(text) && /\$MaxSeconds/.test(text));
        ctx.check(`${f} puts the run id in its window title`, /\$RunId-/.test(text));
      }
      for (const h of ["click_canvas.html", "click_webgl.html"]) {
        const html = fs.readFileSync(path.join(P.APPS, h), "utf8");
        const script = (/<script>([\s\S]*)<\/script>/.exec(html) || [])[1] || "";
        ctx.check(`${h} has a script that parses`, (() => { try { new Function(script); return true; } catch (e) { return false; } })());
        ctx.check(`${h} reports clicks in the window title`, /momo-click\|/.test(html));
      }
    },
  },
  {
    id: "S06", group: "S", mode: "simulated", quick: true, est: 6,
    title: "manual scripts refuse to run without explicit opt-in, and start nothing when refused",
    expect: "UAC, lock and sleep scripts exit with code 2 and a refusal message when their opt-in flag is missing; none opens a window or touches the session",
    async run(ctx) {
      for (const [name, flag] of [["uac.cjs", "--i-understand"], ["lock.cjs", "--i-agree-to-lock"], ["sleep.cjs", "--i-agree-to-sleep"]]) {
        const file = path.join(P.MANUAL, name);
        ctx.check(`${name} exists`, fs.existsSync(file));
        const r = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 20_000, windowsHide: true });
        ctx.check(`${name} without ${flag} exits with 2`, r.status === 2, `status ${r.status}`);
        ctx.check(`${name} says what it refused and what to pass`, new RegExp(flag.replace(/-/g, "\\-")).test((r.stdout || "") + (r.stderr || "")));
        const help = spawnSync(process.execPath, [file, "--help"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
        ctx.check(`${name} --help prints usage and starts nothing`, help.status === 0 && /Usage/i.test(help.stdout || ""));
      }
    },
  },
  {
    id: "S07", group: "S", mode: "simulated", quick: true, est: 2,
    title: "catalog: unique ids, documented expectations, real tests declare what they touch",
    expect: "every test has an id, group, title, expectation text and kind; interactive tests are marked; manual tests carry their command",
    async run(ctx) {
      const defs = [];
      for (const f of fs.readdirSync(P.CASES).filter((n) => n.endsWith(".cjs"))) for (const d of require(path.join(P.CASES, f))) defs.push(d);
      const ids = defs.map((d) => d.id);
      ctx.check("ids are unique", new Set(ids).size === ids.length);
      ctx.check("groups are S, A, B, C or D", defs.every((d) => ["S", "A", "B", "C", "D"].includes(d.group)));
      ctx.check("every automated test documents what it expects", defs.filter((d) => !d.manual).every((d) => typeof d.expect === "string" && d.expect.length > 10), defs.filter((d) => !d.manual && !(d.expect && d.expect.length > 10)).map((d) => d.id).join(","));
      ctx.check("every manual test has a command and a reason", defs.filter((d) => d.manual).every((d) => d.command && d.reason));
      ctx.check("tests using the real mouse or keyboard are marked interactive", defs.filter((d) => d.mode === "real" && d.usesInput).every((d) => d.interactive));
      ctx.check("there are tests in every required area", ["A", "B", "C", "D"].every((g) => defs.some((d) => d.group === g)));
      ctx.check("Chrome canvas and WebGL tests exist", defs.some((d) => /canvas/i.test(d.title) && d.needs.includes("chrome")) && defs.some((d) => /webgl/i.test(d.title) && d.needs.includes("chrome")));
      ctx.check("UAC, lock and sleep are manual tests", ["uac", "lock", "sleep"].every((k) => defs.some((d) => d.manual && new RegExp(k, "i").test(d.title))));
    },
  },
];
