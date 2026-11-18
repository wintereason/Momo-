#!/usr/bin/env node
"use strict";
// USER-RUN test: what does Momo do while the Windows session is LOCKED, and does it come back after you sign in?
// Run it yourself:   node tests/real/manual/lock.cjs --i-agree-to-lock
//
// PASS needs POSITIVE evidence of BOTH transitions, from Windows itself: a SessionLock notification after the lock command, then a SessionUnlock notification
// after that. A small read-only watcher (PowerShell + Microsoft.Win32.SystemEvents.SessionSwitch, which is fed by WTS session notifications) writes them to a file.
// A successful launch of the lock command is NOT evidence of a lock, and the Enter key is not used at all (it can neither start nor end anything).
// The watcher only reports READY after a harmless SystemEvents timer fired, which shows its event loop is running. That is NOT proof that lock/unlock
// notifications are delivered: only a real SessionLock followed by a real SessionUnlock is.
const fs = require("fs");
const mk = require("../lib/manualkit.cjs");

const USAGE = `Usage: node tests/real/manual/lock.cjs --i-agree-to-lock

THIS LOCKS YOUR WINDOWS SESSION. You will have to sign in again. Save your work first.
After a typed confirmation and a 10 second countdown it locks the session (Win+L equivalent). While locked, and after you sign back in, it only READS:
window list, UI Automation read, pop-up/secure-window scan, a capture of its own test window, the helper's heartbeat. It sends no input at all.
It watches Windows' own session notifications and only reports PASS when it SAW the lock and then SAW the unlock. After you sign in there is nothing to press:
the script notices the unlock itself and finishes (Enter is not used). If either transition is not seen, the result is FAIL or INCONCLUSIVE, never PASS.`;

const COUNTDOWN_S = 10;                     // hands-off countdown before the lock command
const READY_WAIT_MS = 20_000;               // the detector must report READY before anything is locked
const LOCK_WAIT_MS = 30_000;                // after the lock command, a lock notification must arrive within this time
const CAP_S = 15 * 60;                      // overall cap, counted from the start of the countdown
const CAP_MS = CAP_S * 1000;
const SETTLE_MS = 3000;                     // after the unlock notification, let the desktop come back before the after-probes
const AFTER_PROBES = 6;
const MARGIN_S = 300;                       // cleanup margin: the fixture and the watcher outlive the cap by this much (the fixture is launched before the cap clock starts)
const FIXTURE_SECONDS = CAP_S + MARGIN_S;   // the test window's own self-destruct
const WATCHER_SECONDS = CAP_S + MARGIN_S;   // the watcher's own self-destruct
const PUMP_WAIT_MS = 5000;                  // how long the watcher waits for its event-loop timer

// ---------------------------------------------------------------- the detector (read-only: it subscribes to session notifications and appends lines to a file)
const CS_SOURCE = `using System;
using System.IO;
using System.Threading;
using Microsoft.Win32;
public static class MomoLockWatch {
  static string path;
  static readonly object gate = new object();
  static volatile bool pumpAlive;
  static int failures;
  public static int Failures { get { return failures; } }
  static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
  // Appends "<kind> <unix ms>". Bounded retries; never throws. A line that could not be written is counted in Failures and the run can never PASS.
  public static bool Note(string kind) {
    string line = kind + " " + Now() + Environment.NewLine;
    for (int attempt = 0; attempt < 6; attempt++) {
      try { lock (gate) { File.AppendAllText(path, line); } return true; }
      catch (Exception) { if (attempt < 5) Thread.Sleep(40 * (attempt + 1)); }
    }
    lock (gate) { failures++; }
    return false;
  }
  public static void UsePath(string p) { path = p; }
  static void OnSwitch(object sender, SessionSwitchEventArgs e) { try { Note(e.Reason.ToString()); } catch (Exception) { } }
  static void OnTimer(object sender, TimerElapsedEventArgs e) { pumpAlive = true; }
  public static bool Start(string p, int pumpWaitMs) {
    path = p;
    SystemEvents.SessionSwitch += OnSwitch;
    try {
      SystemEvents.TimerElapsed += OnTimer;
      IntPtr id = SystemEvents.CreateTimer(100);
      DateTime end = DateTime.UtcNow.AddMilliseconds(pumpWaitMs);
      while (!pumpAlive && DateTime.UtcNow < end) Thread.Sleep(20);
      try { SystemEvents.KillTimer(id); } catch (Exception) { }
    } catch (Exception) { }
    if (!pumpAlive) { Note("PumpNotAlive"); return false; }
    if (!Note("PumpAlive")) return false;
    return Note("READY");
  }
}
`;

const WATCH_SCRIPT = `param([string]$Out, [string]$RunId = 'momo-real-x', [int]$MaxSeconds = 1000)
# Read-only session watcher for the user-run lock test. Appends "<SessionSwitchReason> <unix ms>" lines to $Out. Sends no input, touches no window.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.dll -TypeDefinition @'
${CS_SOURCE}'@
if (-not [MomoLockWatch]::Start($Out, ${PUMP_WAIT_MS})) { exit 4 }
# self-destruct: a crashed runner can never leave this watcher behind for long
$until = (Get-Date).AddSeconds([Math]::Max(1, $MaxSeconds))
while ((Get-Date) -lt $until) {
  if ([MomoLockWatch]::Failures -gt 0) { try { Set-Content -LiteralPath ($Out + '.fail') -Value 'write_failed' } catch { }; exit 3 }
  Start-Sleep -Milliseconds 250
}
`;

// ---------------------------------------------------------------- pure logic (unit-tested without Windows)
/** "<Reason> <unix ms>" lines from the watcher. Anything else (partial line, junk) is ignored and counted. */
function parseWatchDetailed(text) {
  const events = []; let malformed = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([A-Za-z]{3,40}) (\d{12,14})$/.exec(t);
    if (m) events.push({ kind: m[1], at: Number(m[2]) }); else malformed++;
  }
  return { events, malformed };
}
const parseWatch = (text) => parseWatchDetailed(text).events;

/**
 * A reader for the watcher's log. A file that does not exist yet is normal (nothing written); any other failure, or a file that vanishes after events were seen,
 * is an unreadable log: the last good events are kept for the wait loop, but the verdict can never be PASS when the latest read failed.
 */
function makeLogReader(file, fsImpl = fs) {
  const st = { reads: 0, readErrors: 0, lastOk: true, malformedLines: 0, events: [] };
  return {
    read() {
      st.reads++;
      let text;
      try { text = fsImpl.readFileSync(file, "utf8"); }
      catch (e) {
        if (e && e.code === "ENOENT" && st.events.length === 0) { st.lastOk = true; return st.events; }
        st.readErrors++; st.lastOk = false; return st.events;
      }
      const p = parseWatchDetailed(text);
      st.lastOk = true; st.malformedLines = p.malformed; st.events = p.events;
      return st.events;
    },
    stats() { return { reads: st.reads, readErrors: st.readErrors, lastOk: st.lastOk, malformedLines: st.malformedLines }; },
  };
}

/** The first lock notification at or after the trigger, and the first unlock notification AFTER that lock. Earlier or out-of-order events never count. */
function transitions(events, triggerAt) {
  const ev = (events || []).filter((e) => e && e.at >= triggerAt).sort((a, b) => a.at - b.at);
  const lock = ev.find((e) => e.kind === "SessionLock") || null;
  const unlock = lock ? ev.find((e) => e.kind === "SessionUnlock" && e.at > lock.at) || null : null;
  return { lock, unlock };
}

/**
 * The verdict. PASS only with: detector ready, lock command started cleanly, no detector write failure, a readable log, a lock notification,
 * a LATER unlock notification, reads recovered afterwards, and at most one helper restart. Successful probes alone never give PASS.
 */
function judge(i) {
  const t = transitions(i.events, i.trigger && i.trigger.at || 0);
  const base = { lock: t.lock, unlock: t.unlock, lockedMs: t.lock && t.unlock ? t.unlock.at - t.lock.at : null };
  if (!i.ready) return { ...base, verdict: "INCONCLUSIVE", reason: "detector_not_ready" };
  if (!i.trigger || !i.trigger.launched) return { ...base, verdict: "FAIL", reason: "lock_command_failed" };   // a lock seen after a failed trigger does not count
  if (i.detectorFailed !== false) return { ...base, verdict: "INCONCLUSIVE", reason: "detector_write_failed" };  // anything but a clear "no failure" is not good enough
  if (i.logReadable !== true) return { ...base, verdict: "INCONCLUSIVE", reason: "log_unreadable" };
  if (!t.lock) return { ...base, verdict: "INCONCLUSIVE", reason: "lock_not_observed" };
  if (!t.unlock) return { ...base, verdict: "INCONCLUSIVE", reason: i.timedOut ? "unlock_not_observed_time_limit" : "unlock_not_observed" };
  if (i.recovered !== true) return { ...base, verdict: "FAIL", reason: "reads_did_not_recover" };
  if (!(i.restarts <= 1)) return { ...base, verdict: "FAIL", reason: "helper_restarted_more_than_once" };
  return { ...base, verdict: "PASS", reason: "lock_and_unlock_observed_and_reads_recovered" };
}

/** Wait for the watcher's PumpAlive + READY lines. Never ready when the watcher reports a dead event loop, exits, or the time runs out. */
async function waitReady({ readLog, isAlive, sleep, now, timeoutMs, stepMs = 200 }) {
  const t0 = now();
  for (;;) {
    const kinds = readLog().map((e) => e.kind);
    if (kinds.includes("PumpNotAlive")) return { ready: false, why: "event_loop_not_alive" };
    if (kinds.includes("PumpAlive") && kinds.includes("READY")) return { ready: true, why: null };
    if (!isAlive()) return { ready: false, why: "watcher_exited" };
    if (now() - t0 >= timeoutMs) return { ready: false, why: "timeout" };
    await sleep(stepMs);
  }
}

/** Probe while waiting for the unlock. Returns why it stopped; the caller reads the log once more to decide what was seen. */
async function waitForTransitions({ readLog, isAlive, probe, sleep, now, triggerAt, startedAt, capMs, lockWaitMs, launched, intervalMs = 1000 }) {
  for (;;) {
    if (!launched) return "lock_command_failed";
    const tr = transitions(readLog(), triggerAt);
    if (tr.unlock) return "unlock_observed";
    const t = now();
    if (!tr.lock && t - triggerAt > lockWaitMs) return "lock_wait_expired";
    if (!isAlive()) return "watcher_exited";
    if (t - startedAt > capMs) return "time_limit";
    await probe();
    await sleep(intervalMs);
  }
}

/** Start the lock command and report what actually happened to it. Starting cleanly is NOT proof of a lock. */
function fireLock(spawnImpl, waitMs = 3000) {
  return new Promise((resolve) => {
    const at = Date.now();
    let done = false, child = null, exitCode = null, error = null;
    const finish = () => {
      if (done) return; done = true;
      resolve({ at, pid: child && child.pid || null, exitCode, error, launched: !error && !!(child && child.pid) && (exitCode === null || exitCode === 0) });
    };
    try { child = spawnImpl("rundll32.exe", ["user32.dll,LockWorkStation"], { stdio: "ignore", windowsHide: true }); } catch (e) { error = (e && e.code) || "spawn_threw"; return finish(); }
    child.on("error", (e) => { error = (e && e.code) || "error"; finish(); });
    child.on("exit", (c) => { exitCode = c; finish(); });
    setTimeout(finish, waitMs);
  });
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

// ---------------------------------------------------------------- the run
async function main() {
  mk.guard({ usage: USAGE, flag: "--i-agree-to-lock", what: "LOCKS your Windows session" });
  const ok = await mk.confirmTyped("LOCK", "Your Windows session will be LOCKED about 10 seconds after the detector is ready.\nSave your work. You will need to sign in again. Do not press anything in this console: the script notices the unlock by itself.");
  if (!ok) { console.log("Cancelled. Nothing was started and nothing was locked."); return 0; }
  const { spawn } = require("child_process");
  const K = require("../lib/kit.cjs");
  const { isAlive } = require("../lib/ps.cjs");
  const { rt, ctx, ledger, runId, cleanup } = mk.bootstrap();
  let code = 0;
  try {
    await rt.uiaHost.request("ping", 30000).catch(() => undefined);
    const startsBefore = rt.uiaHost.stats().starts;
    const app = await K.launchBasic(ctx, { tag: "lock", maxSeconds: FIXTURE_SECONDS });   // outlives the 15 minute cap plus a cleanup margin
    if (!app.win) { console.error("The test window did not appear. Nothing was done."); return 1; }
    for (let i = 0; i < 50 && !(app.state() || {}).ready; i++) await mk.sleep(200);
    const cap = new rt.VisualCapture(rt.nodeCapture);
    const hwnd = app.win.hwnd;

    const baseline = [];
    for (let i = 0; i < 3; i++) { baseline.push(await mk.probeOnce(rt, cap, hwnd)); await mk.sleep(400); }
    const b = mk.summarize(baseline);
    if (b.allOk < 3) { console.error("The probes already failed BEFORE the event, so the test is not meaningful. Failures:", b.failures, "\nNothing was triggered."); return 1; }
    console.log(`Baseline: 3 of 3 probes fine (slowest ${b.slowestMs} ms).`);

    // the detector must be running BEFORE anything is locked
    const script = ledger.file("lockwatch.ps1"), logFile = ledger.file("lockwatch.log"), failFile = logFile + ".fail";
    fs.writeFileSync(script, WATCH_SCRIPT);
    // PowerShell 5.1 defaults to STA, where SystemEvents piggybacks on the calling thread and never gets a message pump.
    // -MTA makes it create its own pumping thread, so TimerElapsed (readiness) and SessionSwitch (lock/unlock) are delivered.
    const watcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-MTA", "-File", script, "-Out", logFile, "-RunId", runId, "-MaxSeconds", String(WATCHER_SECONDS)], { stdio: "ignore", windowsHide: true });
    ledger.track(watcher.pid);
    const reader = makeLogReader(logFile);
    const readLog = () => reader.read();
    const watcherAlive = () => isAlive(watcher.pid);
    const rdy = await waitReady({ readLog, isAlive: watcherAlive, sleep: mk.sleep, now: Date.now, timeoutMs: READY_WAIT_MS });
    const ready = rdy.ready;

    let trig = { at: 0, pid: null, exitCode: null, error: null, launched: false };
    const during = []; const after = []; let timedOut = false; let waitReason = null; const eventAt = Date.now();
    if (!ready) {
      console.error(`The session-lock detector did not become ready (${rdy.why}), so a lock could not be verified. NOTHING WAS LOCKED.`);
    } else {
      console.log("Session-lock detector is running and its event loop answered a test timer. Nothing has been locked yet.");
      console.log(`\nThe session locks in ${COUNTDOWN_S} seconds (Ctrl+C now to abort). Then sign in again and wait: the script notices the unlock itself. Do not press Enter.\n`);
      for (let i = COUNTDOWN_S; i >= 1; i--) { process.stdout.write(`  locking in ${i} ...\r`); await mk.sleep(1000); }
      process.stdout.write("\n");
      trig = await fireLock(spawn);
      console.log(`Lock command: ${trig.launched ? "started" : "DID NOT START CLEANLY"} (exit ${trig.exitCode === null ? "not reported" : trig.exitCode}${trig.error ? ", error " + trig.error : ""}). Waiting for Windows to report the lock ...`);
      waitReason = await waitForTransitions({
        readLog, isAlive: watcherAlive, probe: async () => { during.push(await mk.probeOnce(rt, cap, hwnd)); }, sleep: mk.sleep, now: Date.now,
        triggerAt: trig.at, startedAt: eventAt, capMs: CAP_MS, lockWaitMs: LOCK_WAIT_MS, launched: trig.launched,
      });
      timedOut = waitReason === "time_limit";
      const why = { lock_command_failed: "the lock command did not start cleanly", lock_wait_expired: "Windows did not report a lock within 30 s", watcher_exited: "the session-lock detector stopped", time_limit: "time limit" }[waitReason];
      if (why) console.log(`Not waiting longer: ${why}.`);
      const seen = transitions(readLog(), trig.at);
      if (seen.lock && seen.unlock) {
        console.log("Windows reported the unlock. Letting the desktop settle, then checking that Momo's machinery is back to normal ...");
        await mk.sleep(SETTLE_MS);
        for (let i = 0; i < AFTER_PROBES; i++) { after.push(await mk.probeOnce(rt, cap, hwnd)); await mk.sleep(700); }
      }
    }

    const events = readLog();                                  // one last read: it decides readability for the verdict
    const logStats = reader.stats();
    const detectorFailed = fs.existsSync(failFile);
    const d = mk.summarize(during, { eventAt: trig.at || eventAt }), a = mk.summarize(after);
    const restarts = rt.uiaHost.stats().starts - startsBefore;
    const timeouts = Object.entries(d.failures).filter(([k]) => /:timeout$/.test(k)).reduce((s, [, n]) => s + n, 0);
    const j = judge({ ready, trigger: trig, events, timedOut, detectorFailed, logReadable: logStats.lastOk, recovered: after.length === AFTER_PROBES ? a.allOk >= 5 : null, restarts });
    const rel = (e) => (e && trig.at ? e.at - trig.at : null);

    console.log("\n================ RESULT: LOCK ================");
    console.log(`Lock evidence    : ${j.lock ? "Windows reported SessionLock at " + iso(j.lock.at) + " (" + rel(j.lock) + " ms after the lock command)" : "NOT observed"}`);
    console.log(`Unlock evidence  : ${j.unlock ? "Windows reported SessionUnlock at " + iso(j.unlock.at) + " (locked for " + Math.round(j.lockedMs / 1000) + " s)" : "NOT observed"}`);
    console.log(`During the lock  : ${d.probes} probe(s), ${d.allOk} fully fine; call failures: ${JSON.stringify(d.failures)}; slowest probe ${d.slowestMs} ms; calls that timed out (hung): ${timeouts}`);
    if (d.secureSeen) console.log(`Momo's pop-up scan listed a SECURE window in ${d.secureSeen} probe(s) (it is only counted, never read or answered).`);
    console.log(`After the unlock : ${after.length ? a.allOk + " of " + a.probes + " probes fine" : "not checked (no confirmed lock and unlock)"}`);
    console.log(`Helper restarts  : ${restarts}`);
    console.log(`Detector         : ${ready ? "ready" : "NOT ready (" + rdy.why + ")"}; write failure: ${detectorFailed ? "YES" : "no"}; log read errors: ${logStats.readErrors}; malformed lines: ${logStats.malformedLines}`);
    console.log("Input sent       : none (this script only reads; Enter is not used)");
    console.log(`Verdict          : ${j.verdict} (${j.reason})`);
    console.log("NOTE: " + (d.slowestMs > 20000 ? "a probe took a long time while the session was locked (a call waited for the locked desktop)" : "no probe waited long while the session was locked"));
    const file = mk.writeResult("lock", runId, {
      verdict: j.verdict, reason: j.reason, baseline: b, during: d, after: a, helperRestarts: restarts, timeouts, secureSeen: d.secureSeen,
      lock: {
        detector: { ready, notReadyBecause: rdy.why, eventLoopVerifiedByTimer: ready, aliveAtEnd: watcherAlive(), writeFailed: detectorFailed, logReadErrors: logStats.readErrors, malformedLines: logStats.malformedLines, mechanism: "Microsoft.Win32.SystemEvents.SessionSwitch (Windows session notifications)" },
        trigger: { atIso: iso(trig.at), launched: trig.launched, exitCode: trig.exitCode, error: trig.error },
        waitEndedBecause: waitReason,
        lockObservedAtIso: iso(j.lock && j.lock.at), unlockObservedAtIso: iso(j.unlock && j.unlock.at),
        lockObservedAfterTriggerMs: rel(j.lock), unlockObservedAfterTriggerMs: rel(j.unlock), lockedForMs: j.lockedMs, timedOut,
        events: events.map((e) => ({ kind: e.kind, atIso: iso(e.at) })),
      },
      extra: null,
    });
    console.log(`\nResult saved to tests/real/results/${require("path").basename(file)} (git-ignored; counts and timings only).`);
    await Promise.race([app.close().catch(() => undefined), mk.sleep(10_000)]);   // a still-locked session must not hang the cleanup; the ledger sweep below ends it
    code = j.verdict === "PASS" ? 0 : j.verdict === "FAIL" ? 1 : 3;
  } finally { cleanup(); }
  return code;
}

module.exports = {
  parseWatch, parseWatchDetailed, makeLogReader, transitions, judge, waitReady, waitForTransitions, fireLock, CS_SOURCE, WATCH_SCRIPT,
  constants: { COUNTDOWN_S, LOCK_WAIT_MS, CAP_S, CAP_MS, READY_WAIT_MS, MARGIN_S, FIXTURE_SECONDS, WATCHER_SECONDS, PUMP_WAIT_MS },
};

if (require.main === module) main().then((c) => process.exit(c || 0)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
