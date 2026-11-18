#!/usr/bin/env node
"use strict";
// USER-RUN test: does Momo's machinery survive the PC going to SLEEP and waking up?
// Run it yourself:   node tests/real/manual/sleep.cjs --i-agree-to-sleep
//
// PASS needs POSITIVE evidence from Windows itself, read AFTER the fact from the System event log: a Modern Standby SESSION whose first Kernel-Power event 506 (entering)
// is logged within 30 seconds after the suspend command and whose FINAL event 507 (exiting) is at least 10 seconds later. One real standby is often logged as a chain of
// cycles handed off within milliseconds, so cycles are matched by identifiers (506.ScenarioInstanceId == 507.ScenarioInstanceIdV2, same BootId) and linked into a session
// (the next 506's ScenarioInstanceId == the previous 507's ScenarioInstanceId, same BootId, gap 0..1000 ms); an intermediate 507 is never the wake-up. Missing, empty or
// mismatched identifiers give INCONCLUSIVE: timestamps alone are never used to pair events. Kernel-Power 187 is recorded only as diagnostic evidence (who requested
// the state change, what action was requested and the lightest state) and is never used to verify standby. The suspend command's PowerShell must also have FINISHED with exit code 0
// (SetSuspendState returned success): an exit code that is not reported never counts. The command launching cleanly, the console Enter key and a jump of the wall clock
// are NOT evidence and are never used as such. After the wake it waits for you to be signed in (otherwise the result is INCONCLUSIVE, not a product failure), lets the
// desktop settle for about 20 seconds, gives the suspend command up to 30 more seconds to report its exit, then probes Momo's read-only machinery. It sends no keyboard or mouse input at all.
const mk = require("../lib/manualkit.cjs");

const USAGE = `Usage: node tests/real/manual/sleep.cjs --i-agree-to-sleep

THIS PUTS YOUR PC TO SLEEP. Save your work first; you wake it yourself (power button or key). Network connections drop.
After a typed confirmation and a 10 second countdown it suspends the machine. After you wake it (and sign in if Windows asks), it reads the Windows System log for the
Modern Standby entry (Kernel-Power 506) and exit (507), together with any Kernel-Power 187 caller/state diagnostics, waits about 20 seconds for the desktop to settle,
checks that the suspend command itself finished with exit code 0, probes Momo's read-only machinery (window list, UI Automation read, pop-up scan, capture of its own
test window, helper heartbeat) and reports.
It sends no input at all and the Enter key is not used.
It only reports PASS when it VERIFIED a standby session (entry within 30 s of the command, final exit at least 10 seconds later, events matched by Windows' own
identifiers) AND the suspend command finished with exit code 0. Kernel-Power 187 and exit code 0 alone are never proof of standby.
Otherwise the result is FAIL or INCONCLUSIVE, never PASS.`;

const COUNTDOWN_S = 10;
const CAP_S = 30 * 60;                      // overall cap, counted from the start of the countdown
const CAP_MS = CAP_S * 1000;
const MARGIN_S = 600;                       // cleanup margin beyond the cap (sign-in wait, settle, exit wait, probes, close)
const FIXTURE_SECONDS = CAP_S + MARGIN_S;   // the test window's own self-destruct
const MIN_STANDBY_MS = 10_000;              // a standby shorter than this is not accepted as a sleep
const ENTRY_WINDOW_MS = 30_000;             // the qualifying standby entry (506) must be logged within this long after the suspend command
const HANDOFF_MAX_MS = 1000;                // a cycle is linked to the next one when the next 506 follows the 507 within 0..1000 ms (real handoffs on this laptop: 0-13 ms)
const FINAL_STABLE_MS = 5000;               // a final 507 is established once this long has passed without a linked next 506 (the real handoff gap is at most 13 ms)
const ENTRY_WAIT_MS = 60_000;               // no qualifying entry within this long after the command (log lag included): it did not sleep
const SHORT_GRACE_MS = 30_000;              // after a too-short standby, wait this long for a real one before giving up
const EXIT_WAIT_MS = 30_000;                // after sign-in and the settle, how long the suspend command may take to report its exit
const POLL_MS = 3000;
const MAX_READ_FAILURES = 5;                // consecutive unreadable System log reads before giving up
const SIGNIN_WAIT_MS = 3 * 60_000;          // after the wake, how long to wait for you to sign in
const SETTLE_MS = 20_000;                   // desktop settle time after the wake / sign-in
const AFTER_PROBES = 6;
const EVENT_LOOKBACK_MS = 60_000;           // the System log is read from a minute before the command (a safety margin); events before the command never count

// ---------------------------------------------------------------- reading the System log (read-only)
// Each line: "<id> <unix ms> <record> data=<k=v|k=v> msg=<first message line>". Only a short whitelist of fields is kept, sanitised to safe non-whitespace characters (backslashes in a caller path survive).
// Kernel-Power 187 is read only for diagnostics (caller, requested action and lightest state); it is never fed into the standby verification.
const READ_SCRIPT = `$ErrorActionPreference = 'Stop'
$since = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:SL_SINCE).LocalDateTime
$keep = 'Caller', 'ApiCallerName', 'SystemAction', 'LightestSystemState', 'Reason', 'ScenarioInstanceId', 'ScenarioInstanceIdV2', 'LidOpenState', 'SleepEntered', 'SleepDurationInUs', 'DurationInUs', 'ScreenOffDurationInUs', 'PowerStateAc', 'DisconnectedStandby', 'BootId', 'DripsTransitions'
$found = @()
try { $found = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 187, 506, 507; StartTime = $since } -ErrorAction Stop) }
catch { if ($_.FullyQualifiedErrorId -notlike '*NoMatchingEventsFound*') { throw } }
foreach ($e in $found) {
  $d = ''
  try { $x = [xml]$e.ToXml(); $d = (@($x.Event.EventData.Data) | Where-Object { $keep -contains $_.Name } | ForEach-Object { $_.Name + '=' + $_.'#text' }) -join '|' } catch { $d = '' }
  $d = $d -replace '[^A-Za-z0-9_.=|:,\\\\-]', '_'
  $m = ''
  try { $m = ([string]$e.Message).Split([char]10)[0] } catch { $m = '' }
  $m = $m -replace '[^A-Za-z0-9_.:,-]', '_'
  '{0} {1} {2} data={3} msg={4}' -f $e.Id, ([DateTimeOffset]$e.TimeCreated).ToUnixTimeMilliseconds(), $e.RecordId, $d, $m
}
'OK'
`;

/** the "k=v|k=v" part of an event line as an object (only safe characters ever reach it) */
function parseData(s) {
  const out = {};
  for (const kv of String(s || "").split("|")) { const i = kv.indexOf("="); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); }
  return out;
}

/** Event lines followed by an OK line. Kernel-Power 187 is accepted for diagnostics only; lines without the diagnostic fields still parse. Anything else is ignored (and a missing OK line means the read failed). */
function parseEvents(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((l) => l.trim());
  const events = [];
  for (const l of lines) {
    const m = /^(187|506|507) (\d{12,14}) (\d{1,12})(?: data=(\S*))?(?: msg=(\S*))?$/.exec(l);
    if (m) events.push({ id: Number(m[1]), at: Number(m[2]), rec: Number(m[3]), data: parseData(m[4]), msg: m[5] || "" });
  }
  return { ok: lines.includes("OK"), events };
}

/** One read of the System log. Never throws; a failed or incomplete read is { ok: false }. spawnSyncImpl is injectable for tests. */
function readPowerEvents(sinceMs, spawnSyncImpl = require("child_process").spawnSync) {
  let r;
  try {
    r = spawnSyncImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", READ_SCRIPT], { encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, SL_SINCE: String(Math.max(0, Math.floor(sinceMs))) } });
  } catch (e) { return { ok: false, events: [], error: (e && e.code) || "spawn_threw" }; }
  if (!r || r.error || r.status !== 0) return { ok: false, events: [], error: (r && r.error && r.error.code) || `exit_${r && r.status}` };
  const p = parseEvents(r.stdout);
  return p.ok ? { ok: true, events: p.events } : { ok: false, events: [], error: "incomplete_output" };
}

// ---------------------------------------------------------------- the desktop (are you signed in yet?)
/** true when the input desktop can be opened (a signed-in, unlocked desktop); false on the lock/sign-in screen. Throws when the check itself is unavailable. */
function inputDesktopAvailable(api) {
  const a = api || defaultDesktopApi();
  const h = a.open();
  if (!h) return false;
  try { a.close(h); } catch { /* the handle is only a probe */ }
  return true;
}
function defaultDesktopApi() {
  const P = require("../lib/paths.cjs");
  const koffi = require(P.ROOT + "/node_modules/koffi");
  const user32 = koffi.load("user32.dll");
  const Open = user32.func("uintptr_t __stdcall OpenInputDesktop(uint32_t flags, bool inherit, uint32_t access)");
  const Close = user32.func("bool __stdcall CloseDesktop(uintptr_t h)");
  return { open: () => { const h = Open(0, false, 0x0100); return Number(h) !== 0 ? h : 0; }, close: (h) => Close(h) };   // 0x0100 = DESKTOP_SWITCHDESKTOP
}

// ---------------------------------------------------------------- pure logic (unit-tested without Windows)
const idOf = (v) => (v === undefined || v === null ? "" : String(v).trim());
const dataOf = (e) => (e && e.data) || {};

/**
 * One cycle: a 506 and the next 507. It is only usable when BOTH events carry a BootId and the 506's ScenarioInstanceId and the 507's ScenarioInstanceIdV2 are present and
 * identical, in the same boot. status: ok | ids_unavailable (a field is missing or empty) | ids_mismatch (the boots or the identifiers differ). Never decided by time.
 */
function makeCycle(enter, exit) {
  const bootE = idOf(dataOf(enter).BootId), bootX = idOf(dataOf(exit).BootId);
  const sid = idOf(dataOf(enter).ScenarioInstanceId), v2 = idOf(dataOf(exit).ScenarioInstanceIdV2);
  const status = !bootE || !bootX || !sid || !v2 ? "ids_unavailable" : bootE !== bootX || sid !== v2 ? "ids_mismatch" : "ok";
  return { enter, exit, status, ms: exit.at - enter.at };
}

/**
 * How a following 506 relates to the previous cycle's 507: "linked" (same boot, the 506's ScenarioInstanceId equals the 507's own ScenarioInstanceId, gap 0..1000 ms),
 * "none" (not a handoff: the gap is outside 0..1000 ms), or, for a handoff-close 506 whose identifiers do not prove a link, "ids_unavailable" / "ids_mismatch".
 */
function linkOf(prev, nextEnter) {
  const gap = nextEnter.at - prev.exit.at;
  if (gap < 0 || gap > HANDOFF_MAX_MS) return "none";
  const own = idOf(dataOf(prev.exit).ScenarioInstanceId), next = idOf(dataOf(nextEnter).ScenarioInstanceId);
  const bootP = idOf(dataOf(prev.exit).BootId), bootN = idOf(dataOf(nextEnter).BootId);
  if (!own || !next || !bootP || !bootN) return "ids_unavailable";
  return bootP !== bootN || own !== next ? "ids_mismatch" : "linked";
}

/**
 * What the System log shows about the standby, counting only 506/507 events at or after the suspend command. Events are ordered by time, then by record number.
 * Kernel-Power 187 is deliberately excluded here: it stays in the returned events for diagnostics but never enters verification.
 * Cycles (506 then the next 507, matched by identifiers) are linked into SESSIONS; a session starts at its first 506 and ends at its FINAL 507, never at an intermediate one.
 * The 30 s entry window applies to a session's first 506 (sessions starting later are counted in lateEntries and ignored); the 10 s minimum applies to the complete session
 * (first 506 to final 507); a final 507 is established only when FINAL_STABLE_MS have passed with no linked next 506. An exit with no entry before it is an orphan (reversed
 * order) and never counts. Missing, empty or mismatched identifiers are never worked around with timestamps.
 * state: verified | in_standby (a chain is still open) | pending | standby_too_short | ids_unavailable | ids_mismatch | entry_outside_window | entry_not_observed
 */
function analyzePower(events, triggerAt, nowMs) {
  const ev = (events || []).filter((e) => e && (e.id === 506 || e.id === 507) && e.at >= triggerAt).sort((a, b) => a.at - b.at || (a.rec || 0) - (b.rec || 0));
  const items = []; let open = null; let orphanExits = 0;
  for (const e of ev) {
    if (e.id === 506) { if (!open) open = e; }
    else if (open) { items.push(makeCycle(open, e)); open = null; }
    else orphanExits++;
  }
  if (open) items.push({ enter: open, exit: null, status: "open", ms: null });             // a 506 whose 507 has not been logged yet

  const sessions = []; let cur = null;
  for (const it of items) {
    let linked = false;
    if (cur) {
      const prev = cur.cycles[cur.cycles.length - 1];
      const rel = prev.exit ? linkOf(prev, it.enter) : "none";
      if (rel === "linked") { linked = true; cur.linkGapsMs.push(it.enter.at - prev.exit.at); cur.cycles.push(it); }
      else if (rel !== "none") cur.ambiguous = cur.ambiguous || rel;                       // close to the exit, but the identifiers cannot show whether it continues: the end is uncertain
    }
    if (!linked) { cur = { cycles: [it], linkGapsMs: [], ambiguous: null }; sessions.push(cur); }
  }
  for (const s of sessions) {
    const bad = s.cycles.find((c) => c.status !== "ok" && c.status !== "open");
    s.badKind = bad ? bad.status : null;
  }

  const candidates = sessions.filter((s) => s.cycles[0].enter.at - triggerAt <= ENTRY_WINDOW_MS);
  const closedMs = (s) => { const l = s.cycles[s.cycles.length - 1]; return l.exit ? l.exit.at - s.cycles[0].enter.at : 0; };
  const base = {
    cycles: items.filter((c) => c.status === "ok").length, sessions: sessions.length, orphanExits, lateEntries: sessions.length - candidates.length,
    badCycles: items.filter((c) => c.status !== "ok" && c.status !== "open").length, longestMs: sessions.reduce((m, s) => Math.max(m, closedMs(s)), 0),
  };

  let bad = null, verified = null, openS = null, pendingS = null, short = null;
  for (const s of candidates) {
    const kind = s.badKind || s.ambiguous;
    if (kind) { bad = bad || kind; continue; }
    const last = s.cycles[s.cycles.length - 1];
    if (!last.exit) { openS = openS || s; continue; }                                      // the chain is still open: no final 507 yet
    if (nowMs - last.exit.at < FINAL_STABLE_MS) { pendingS = pendingS || s; continue; }    // the next linked 506 may still be about to be logged
    const ms = last.exit.at - s.cycles[0].enter.at;
    if (ms >= MIN_STANDBY_MS) verified = verified || { s, final: last.exit, ms };
    else short = short || { s, final: last.exit, ms };
  }
  if (bad) return { ...base, state: bad };
  if (verified) {
    const { s, final, ms } = verified;
    return {
      ...base, state: "verified", enter: s.cycles[0].enter, exit: final, standbyMs: ms, cycleCount: s.cycles.length, linkGapsMs: s.linkGapsMs,
      cycleDiagnostics: s.cycles.map((c) => ({ enterRecord: c.enter.rec, exitRecord: c.exit.rec, ms: c.ms, reasonEnter: dataOf(c.enter).Reason || null, reasonExit: dataOf(c.exit).Reason || null, sleepEntered: dataOf(c.exit).SleepEntered || null, sleepDurationUs: dataOf(c.exit).SleepDurationInUs || null, durationUs: dataOf(c.exit).DurationInUs || null })),
    };
  }
  if (openS) return { ...base, state: "in_standby", enter: openS.cycles[0].enter };
  if (pendingS) return { ...base, state: "pending" };
  if (short) return { ...base, state: nowMs - short.final.at > SHORT_GRACE_MS ? "standby_too_short" : "pending" };
  if (nowMs - triggerAt > ENTRY_WAIT_MS) return { ...base, state: base.lateEntries ? "entry_outside_window" : "entry_not_observed" };
  return { ...base, state: "pending" };
}

/**
 * the suspend command is not known to have failed: no spawn error, a process id, and either still running (exit not reported) or finished with exit code 0.
 * This is NOT completion: a command that has not reported its exit is "launched" but never "completed".
 */
const triggerLaunched = (t) => !!t && !t.error && !!t.pid && (t.exited ? t.exitCode === 0 : (t.exitCode === null || t.exitCode === 0));
/** the suspend command FINISHED and SetSuspendState returned success: exit code exactly 0. A null (unreported) exit code never qualifies. */
const triggerCompleted = (t) => triggerLaunched(t) && t.exitCode === 0;

/**
 * The verdict. PASS only with: preflight fine, a suspend command that finished with exit code 0, a VERIFIED standby session (first 506 within 30 s of the command,
 * identifier-matched cycles, final 507 established, complete session at least 10 s), you signed in, and reads recovered with at most one helper restart.
 * Wall-clock jumps, Enter, timestamps alone and successful probes alone never give PASS.
 */
function judge(i) {
  const base = { analysis: i.analysis || null };
  if (i.preflight) return { ...base, verdict: "INCONCLUSIVE", reason: i.preflight };
  if (!triggerLaunched(i.trigger)) return { ...base, verdict: "FAIL", reason: "suspend_command_failed" };   // events that show up anyway (a natural sleep) do not count
  const a = i.analysis;
  if (!a || a.state !== "verified") {
    const why = i.waitReason;
    const reason = why === "log_unreadable" ? "system_log_unreadable"
      : a && a.state === "ids_unavailable" ? "standby_ids_unavailable"                       // identifiers missing or empty: never worked around with timestamps
      : a && a.state === "ids_mismatch" ? "standby_ids_mismatch"                             // identifiers or BootId disagree
      : why === "time_limit" ? (a && a.state === "in_standby" ? "standby_exit_not_observed_time_limit" : a && a.state === "pending" && a.sessions > 0 ? "standby_exit_not_established_time_limit" : "standby_entry_not_observed_time_limit")
      : a && a.state === "standby_too_short" ? "standby_too_short"
      : a && a.state === "entry_outside_window" ? "standby_entry_outside_window"
      : a && a.state === "entry_not_observed" ? "standby_entry_not_observed"
      : "standby_not_verified";
    return { ...base, verdict: "INCONCLUSIVE", reason };
  }
  if (i.signedIn !== true) return { ...base, verdict: "INCONCLUSIVE", reason: i.signedIn === false ? "not_signed_in" : "sign_in_state_unknown" };   // a product failure cannot be claimed
  if (!triggerCompleted(i.trigger)) return { ...base, verdict: "INCONCLUSIVE", reason: "suspend_command_not_completed" };   // exit not reported: the trigger was never shown to have succeeded
  if (i.recovered !== true) return { ...base, verdict: "FAIL", reason: "reads_did_not_recover" };
  if (!(i.restarts <= 1)) return { ...base, verdict: "FAIL", reason: "helper_restarted_more_than_once" };
  return { ...base, verdict: "PASS", reason: "standby_verified_and_reads_recovered" };
}

/**
 * Poll the System log until the standby is verified, can no longer happen, or the cap is reached. Returns { reason, analysis, readOk, maxGapMs, events }.
 * maxGapMs is the largest wall-clock gap between polls: informational only, never used as proof. events are the last successfully read events (diagnostics).
 */
async function waitForStandby({ readEvents, now, sleep, trigger, triggerAt, startedAt, capMs = CAP_MS, pollMs = POLL_MS }) {
  let analysis = analyzePower([], triggerAt, now()), failures = 0, readOk = true, maxGapMs = 0, last = now(), events = [];
  const out = (reason) => ({ reason, analysis, readOk, maxGapMs, events });
  for (;;) {
    if (!triggerLaunched(trigger)) return out("trigger_failed");
    const r = readEvents();
    const afterRead = now(); maxGapMs = Math.max(maxGapMs, afterRead - last); last = afterRead;   // informational only: how far the wall clock moved between two reads
    readOk = !!r.ok;
    if (r.ok) { failures = 0; events = r.events; analysis = analyzePower(r.events, triggerAt, now()); }
    else if (++failures >= MAX_READ_FAILURES) return out("log_unreadable");
    if (analysis.state === "verified") return out("verified");
    if (["entry_not_observed", "entry_outside_window", "standby_too_short", "ids_unavailable", "ids_mismatch"].includes(analysis.state)) return out(analysis.state);
    if (now() - startedAt > capMs) return out("time_limit");
    await sleep(pollMs);
  }
}

/** After the wake: wait (bounded) for the input desktop, then let it settle. Returns { signedIn, availableAt }. */
async function waitForSignIn({ available, now, sleep, since, waitMs = SIGNIN_WAIT_MS, settleMs = SETTLE_MS, stepMs = 2000 }) {
  const t0 = now();
  for (;;) {
    let ok = null;
    try { ok = available(); } catch { ok = null; }
    if (ok === null) return { signedIn: null, availableAt: null };            // the check itself is broken: unknown, never a pass
    if (ok) {
      const availableAt = now();
      const until = Math.max(since, availableAt) + settleMs;                  // the desktop settles after the exit event or the sign-in, whichever is later
      if (until > now()) await sleep(until - now());
      return { signedIn: true, availableAt };
    }
    if (now() - t0 >= waitMs) return { signedIn: false, availableAt: null };
    await sleep(stepMs);
  }
}

/** Give the suspend command up to waitMs to report that it finished. done=false means no exit was reported in time (the verdict is then never PASS). */
async function waitForExit({ trigger, now, sleep, waitMs = EXIT_WAIT_MS, stepMs = 250 }) {
  const t0 = now();
  for (;;) {
    if (trigger.exited || trigger.exitCode !== null || trigger.error) return { done: true, waitedMs: now() - t0 };
    if (now() - t0 >= waitMs) return { done: false, waitedMs: now() - t0 };
    await sleep(stepMs);
  }
}

/** Start the suspend command and keep reporting what happens to it, including when it exited. Launching cleanly is NOT proof of a sleep or of success. */
function fireSleep(spawnImpl) {
  const t = { at: Date.now(), pid: null, exitCode: null, signal: null, exited: false, exitedAt: null, error: null };
  try {
    const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $ok = [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $true, $false); if (-not $ok) { exit 5 }"],
    { stdio: "ignore", windowsHide: true });
    t.pid = child && child.pid || null;
    child.on("error", (e) => { t.error = (e && e.code) || "error"; });
    child.on("exit", (c, sig) => { t.exited = true; t.exitCode = c === undefined ? null : c; t.signal = sig || null; t.exitedAt = Date.now(); });
  } catch (e) { t.error = (e && e.code) || "spawn_threw"; }
  return t;
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/**
 * Kernel-Power 187 is diagnostic-only evidence: which caller asked for the state change, what action it requested and the lightest state it asked for.
 * Both the Windows field name (ApiCallerName) and the shorter Caller alias are accepted, so "where available" means whichever schema the event uses.
 * This helper never feeds analyzePower() or judge(): 187 alone can never verify standby.
 */
function event187Diagnostics(events) {
  return (events || []).filter((e) => e && e.id === 187).map((e) => {
    const d = dataOf(e);
    return {
      id: e.id, at: e.at, record: e.rec,
      caller: idOf(d.ApiCallerName) || idOf(d.Caller) || null,
      systemAction: idOf(d.SystemAction) || null,
      lightestSystemState: idOf(d.LightestSystemState) || null,
      data: d,
      message: e.msg || "",
    };
  });
}

// ---------------------------------------------------------------- the run
async function main() {
  mk.guard({ usage: USAGE, flag: "--i-agree-to-sleep", what: "puts your PC to SLEEP" });
  const ok = await mk.confirmTyped("SLEEP", "Your PC will go to SLEEP about 10 seconds after you confirm.\nSave your work. Wake it yourself when you want and sign in if Windows asks; this console keeps running. Do not press anything in this console: the script reads the result from Windows by itself.");
  if (!ok) { console.log("Cancelled. Nothing was started and the PC was not suspended."); return 0; }
  const { spawn } = require("child_process");
  const K = require("../lib/kit.cjs");
  const { rt, ctx, runId, cleanup } = mk.bootstrap();
  let code = 0;
  try {
    await rt.uiaHost.request("ping", 30000).catch(() => undefined);
    const startsBefore = rt.uiaHost.stats().starts;
    const app = await K.launchBasic(ctx, { tag: "sleep", maxSeconds: FIXTURE_SECONDS });   // outlives the 30 minute cap plus a cleanup margin
    if (!app.win) { console.error("The test window did not appear. Nothing was done."); return 1; }
    for (let i = 0; i < 50 && !(app.state() || {}).ready; i++) await mk.sleep(200);
    const cap = new rt.VisualCapture(rt.nodeCapture);
    const hwnd = app.win.hwnd;

    const baseline = [];
    for (let i = 0; i < 3; i++) { baseline.push(await mk.probeOnce(rt, cap, hwnd)); await mk.sleep(400); }
    const b = mk.summarize(baseline);
    if (b.allOk < 3) { console.error("The probes already failed BEFORE the event, so the test is not meaningful. Failures:", b.failures, "\nNothing was triggered."); return 1; }
    console.log(`Baseline: 3 of 3 probes fine (slowest ${b.slowestMs} ms).`);

    // nothing is suspended unless the result can be verified afterwards
    let preflight = null;
    const pre = readPowerEvents(Date.now() - EVENT_LOOKBACK_MS);
    if (!pre.ok) preflight = "system_log_unreadable_before_sleep";
    else { try { if (!inputDesktopAvailable()) preflight = "desktop_not_available_before_sleep"; } catch { preflight = "desktop_check_unavailable"; } }

    let trig = { at: 0, pid: null, exitCode: null, signal: null, exited: false, exitedAt: null, error: null };
    let w = { reason: null, analysis: analyzePower([], 0, 0), readOk: true, maxGapMs: 0, events: [] };
    let sign = { signedIn: null, availableAt: null };
    let exitWait = { done: null, waitedMs: null };
    const after = []; const eventAt = Date.now();
    if (preflight) {
      console.error(`Cannot verify a sleep on this PC right now (${preflight}). NOTHING WAS SUSPENDED.`);
    } else {
      console.log("The System log is readable and the desktop check works. Nothing has been suspended yet.");
      console.log(`\nThe PC goes to sleep in ${COUNTDOWN_S} seconds (Ctrl+C now to abort). Wake it when you like and sign in if asked, then wait: the script checks Windows' log by itself. Do not press Enter.\n`);
      for (let i = COUNTDOWN_S; i >= 1; i--) { process.stdout.write(`  sleeping in ${i} ...\r`); await mk.sleep(1000); }
      process.stdout.write("\n");
      trig = fireSleep(spawn);
      ctx.ledger.track(trig.pid);
      console.log("Suspend command started. Waiting for Windows to log the standby entry and exit ...");
      w = await waitForStandby({ readEvents: () => readPowerEvents(trig.at - EVENT_LOOKBACK_MS), now: Date.now, sleep: mk.sleep, trigger: trig, triggerAt: trig.at, startedAt: eventAt });
      const why = { trigger_failed: "the suspend command failed", entry_not_observed: "Windows logged no standby entry within 60 s of the command", entry_outside_window: "the only standby entries were logged more than 30 s after the command", standby_too_short: "the logged standby session was shorter than 10 s", ids_unavailable: "the standby events lack the identifiers needed to match them (no timestamp-only pairing is done)", ids_mismatch: "the standby events' identifiers or boot ids do not match", time_limit: "time limit", log_unreadable: "the System log could not be read" }[w.reason];
      if (why) console.log(`Not waiting longer: ${why}.`);
      if (w.analysis.state === "verified") {
        console.log(`Windows logged the standby session (${w.analysis.cycleCount} cycle(s)): ${Math.round(w.analysis.standbyMs / 1000)} s from the first entry to the final exit. Waiting for you to be signed in, then letting the desktop settle ...`);
        sign = await waitForSignIn({ available: () => inputDesktopAvailable(), now: Date.now, sleep: mk.sleep, since: w.analysis.exit.at });
        if (sign.signedIn) {
          exitWait = await waitForExit({ trigger: trig, now: Date.now, sleep: mk.sleep });                // after sign-in and the settle: up to 30 s for the suspend command's exit
          if (!exitWait.done) console.log("The suspend command has not reported an exit 30 s after the settle: the result cannot be PASS.");
          for (let i = 0; i < AFTER_PROBES; i++) { after.push(await mk.probeOnce(rt, cap, hwnd)); await mk.sleep(700); }
        } else console.log(sign.signedIn === false ? "You were not signed in within 3 minutes of the wake, so Momo's reads were not checked." : "The sign-in check is unavailable, so Momo's reads were not checked.");
      }
    }

    const a = mk.summarize(after), d = mk.summarize([]);
    const restarts = rt.uiaHost.stats().starts - startsBefore;
    const j = judge({ preflight, trigger: trig, analysis: w.analysis, waitReason: w.reason, signedIn: sign.signedIn, recovered: after.length === AFTER_PROBES ? a.allOk >= 5 : null, restarts });

    console.log("\n================ RESULT: SLEEP ================");
    const an = w.analysis;
    console.log(`Standby evidence : ${an.state === "verified" ? "Windows logged a session of " + an.cycleCount + " cycle(s): first Kernel-Power 506 at " + iso(an.enter.at) + " (" + (an.enter.at - trig.at) + " ms after the command), FINAL 507 at " + iso(an.exit.at) + " (" + Math.round(an.standbyMs / 1000) + " s in all)" : "NOT verified (" + an.state + ")"}`);
    console.log(`Suspend command  : ${!triggerLaunched(trig) ? "FAILED" : triggerCompleted(trig) ? "finished with exit code 0" : "started, but NO exit reported"} (exit ${trig.exitCode === null ? "not reported" : trig.exitCode}${trig.signal ? ", signal " + trig.signal : ""}${trig.error ? ", error " + trig.error : ""})`);
    console.log(`Signed in        : ${sign.signedIn === true ? "yes" : sign.signedIn === false ? "NO (not within 3 minutes of the wake)" : "not checked"}`);
    console.log(`After the wake   : ${after.length ? a.allOk + " of " + a.probes + " probes fine" : "not checked (no verified sleep and sign-in)"}`);
    console.log(`Helper restarts  : ${restarts}`);
    console.log(`Clock gap seen   : ${Math.round(w.maxGapMs / 1000)} s between polls (informational only, never used as proof)`);
    console.log("Input sent       : none (this script only reads; Enter is not used)");
    console.log(`Verdict          : ${j.verdict} (${j.reason})`);
    const sinceTrig = (ms) => (ms && trig.at ? ms - trig.at : null);
    const file = mk.writeResult("sleep", runId, {
      verdict: j.verdict, reason: j.reason, baseline: b, during: d, after: a, helperRestarts: restarts, timeouts: 0, secureSeen: 0,
      sleep: {
        trigger: {
          atIso: iso(trig.at), launched: triggerLaunched(trig), completed: triggerCompleted(trig), exitCode: trig.exitCode, signal: trig.signal, error: trig.error,
          exitedAtIso: iso(trig.exitedAt), exitedAfterCommandMs: sinceTrig(trig.exitedAt), exitMinusStandbyExitMs: trig.exitedAt && an.exit ? trig.exitedAt - an.exit.at : null,
          exitWaitedMs: exitWait.waitedMs, exitReportedWithinWait: exitWait.done,
        },
        mechanism: "Windows System log, Microsoft-Windows-Kernel-Power events 506/507 matched by ScenarioInstanceId/ScenarioInstanceIdV2 and BootId, cycles linked into a session by handoff (0..1000 ms); first 506 within 30 s of the command, complete session at least 10 s; the suspend command must also exit 0. Kernel-Power 187 is recorded as caller/state diagnostics only and never proves standby.",
        standbyState: an.state, standbyEnterIso: iso(an.enter && an.enter.at), standbyExitIso: iso(an.exit && an.exit.at), standbyMs: an.standbyMs || null,
        enterAfterCommandMs: an.enter ? an.enter.at - trig.at : null, sessionCycles: an.cycleCount || null, linkGapsMs: an.linkGapsMs || null,
        cycles: an.cycles, sessions: an.sessions, badCycles: an.badCycles, orphanExits: an.orphanExits, lateEntries: an.lateEntries, longestSessionMs: an.longestMs,
        cycleDiagnostics: an.cycleDiagnostics || null,                    // SleepEntered / SleepDurationInUs and the reasons per cycle: diagnostics only, never a PASS condition
        waitEndedBecause: w.reason, systemLogReadable: w.readOk, preflight, signedIn: sign.signedIn, observedClockGapMs: w.maxGapMs,
        eventDiagnostics: (w.events || []).filter((e) => e.at >= trig.at - EVENT_LOOKBACK_MS).slice(-40).map((e) => ({ id: e.id, atIso: iso(e.at), record: e.rec, afterCommandMs: sinceTrig(e.at), reason: e.data && e.data.Reason || null, data: e.data || {}, message: e.msg || "" })),
        event187Diagnostics: event187Diagnostics(w.events).filter((e) => e.at >= trig.at - EVENT_LOOKBACK_MS).slice(-40).map(({ at, ...e }) => ({ ...e, atIso: iso(at), afterCommandMs: sinceTrig(at) })),  // diagnostic only, never a PASS condition
      },
      extra: null,
    });
    console.log(`\nResult saved to tests/real/results/${require("path").basename(file)} (git-ignored; counts and timings only).`);
    await Promise.race([app.close().catch(() => undefined), mk.sleep(10_000)]);   // a signed-out session must not hang the cleanup; the ledger sweep below ends it
    code = j.verdict === "PASS" ? 0 : j.verdict === "FAIL" ? 1 : 3;
  } finally { cleanup(); }
  return code;
}

module.exports = {
  parseData, parseEvents, readPowerEvents, makeCycle, linkOf, inputDesktopAvailable, analyzePower, event187Diagnostics, triggerLaunched, triggerCompleted, judge, waitForStandby, waitForSignIn, waitForExit, fireSleep, READ_SCRIPT,
  constants: { COUNTDOWN_S, CAP_S, CAP_MS, MARGIN_S, FIXTURE_SECONDS, MIN_STANDBY_MS, ENTRY_WINDOW_MS, HANDOFF_MAX_MS, FINAL_STABLE_MS, ENTRY_WAIT_MS, SHORT_GRACE_MS, EXIT_WAIT_MS, SIGNIN_WAIT_MS, SETTLE_MS, POLL_MS },
};

if (require.main === module) main().then((c) => process.exit(c || 0)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
