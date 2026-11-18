"use strict";
// One user-run scenario (UAC, lock, sleep): baseline probes, the event, probes during it, probes after it, and an honest summary.
// NO input is sent by any of it. Only counts, states and timings are kept.
const mk = require("./manualkit.cjs");
const K = require("./kit.cjs");

/**
 * @param {{ name: string, instructions: string, intervalMs?: number, maxMs: number, detectGapMs?: number,
 *           trigger: (c: { runId: string, ledger: any }) => Promise<{ isOver: (resumedAt: number|null) => boolean, describe: () => string }> }} o
 */
async function scenario(o) {
  const { rt, ctx, ledger, runId, cleanup } = mk.bootstrap();
  let code = 0;
  try {
    await rt.uiaHost.request("ping", 30000).catch(() => undefined);
    const startsBefore = rt.uiaHost.stats().starts;
    const app = await K.launchBasic(ctx, { tag: o.name });
    if (!app.win) { console.error("The test window did not appear. Nothing was done."); return 1; }
    for (let i = 0; i < 50 && !(app.state() || {}).ready; i++) await mk.sleep(200);
    const cap = new rt.VisualCapture(rt.nodeCapture);
    const hwnd = app.win.hwnd;

    const baseline = [];
    for (let i = 0; i < 3; i++) { baseline.push(await mk.probeOnce(rt, cap, hwnd)); await mk.sleep(400); }
    const b = mk.summarize(baseline);
    if (b.allOk < 3) { console.error("The probes already failed BEFORE the event, so the test is not meaningful. Failures:", b.failures, "\nNothing was triggered."); return 1; }
    console.log(`Baseline: 3 of 3 probes fine (slowest ${b.slowestMs} ms).`);

    console.log("\n" + o.instructions + "\n");
    const eventAt = Date.now();
    const ev = await o.trigger({ runId, ledger });

    const during = [];
    let lastTick = Date.now(), resumedAt = null;
    for (;;) {
      const now = Date.now(); const gap = now - lastTick; lastTick = now;
      if (o.detectGapMs && gap > o.detectGapMs && resumedAt == null) { resumedAt = now; console.log(`Resume detected (the clock jumped ${(gap / 1000).toFixed(0)} s). Probing for a little while longer...`); }
      if (ev.isOver(resumedAt)) break;
      if (now - eventAt > o.maxMs) { console.log("Stopped waiting (time limit)."); break; }
      during.push(await mk.probeOnce(rt, cap, hwnd));
      await mk.sleep(o.intervalMs || 700);
    }

    console.log("Event over. Checking that Momo's machinery is back to normal ...");
    const after = [];
    for (let i = 0; i < 6; i++) { after.push(await mk.probeOnce(rt, cap, hwnd)); await mk.sleep(700); }
    const d = mk.summarize(during, { eventAt }), a = mk.summarize(after);
    const restarts = rt.uiaHost.stats().starts - startsBefore;
    const timeouts = Object.entries(d.failures).filter(([k]) => /:timeout$/.test(k)).reduce((s, [, n]) => s + n, 0);

    const recovered = a.allOk >= 5;
    const verdict = recovered && restarts <= 1 ? "PASS" : "FAIL";
    console.log("\n================ RESULT: " + o.name.toUpperCase() + " ================");
    console.log(`${o.describe ? o.describe(ev) : ev.describe()}`);
    console.log(`During the event : ${d.probes} probe(s), ${d.allOk} fully fine; call failures: ${JSON.stringify(d.failures)}; slowest probe ${d.slowestMs} ms; calls that timed out (hung): ${timeouts}`);
    if (d.secureSeen) console.log(`Momo's pop-up scan listed a SECURE window in ${d.secureSeen} probe(s) (it is only counted, never read or answered).`);
    console.log(`After the event  : ${a.allOk} of ${a.probes} probes fine${a.firstOkAfterLastFailureMs != null ? "" : ""}`);
    if (d.firstOkAfterLastFailureMs != null) console.log(`Recovery         : the first fully fine probe came ${d.firstOkAfterLastFailureMs} ms after the last failing one`);
    console.log(`Helper restarts  : ${restarts}`);
    console.log("Input sent       : none (this script only reads)");
    console.log(`Verdict          : ${verdict}${verdict === "FAIL" ? (recovered ? " (the helper restarted more than once)" : " (Momo's reads did not come back after the event)") : ""}`);
    if (o.notes) for (const n of o.notes(d, a)) console.log("NOTE: " + n);
    const file = mk.writeResult(o.name, runId, { verdict, baseline: b, during: d, after: a, helperRestarts: restarts, timeouts, secureSeen: d.secureSeen, extra: ev.extra ? ev.extra() : null });
    console.log(`\nResult saved to tests/real/results/${require("path").basename(file)} (git-ignored; counts and timings only).`);
    await app.close();
    code = verdict === "PASS" ? 0 : 1;
  } finally { cleanup(); }
  return code;
}

module.exports = { scenario };
