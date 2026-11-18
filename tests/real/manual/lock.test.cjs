"use strict";
// Focused tests for the D04 lock script's detection, wait loops and verdict logic. Nothing here locks anything, subscribes to session events, opens a window,
// sends input or reads the real session: the logic is fed fake events, a fake clock and a fake lock command. Run:  node --test tests/real/manual/lock.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { spawnSync } = require("child_process");
const L = require("./lock.cjs");

const T = 1_700_000_000_000;                       // an arbitrary "trigger time" in unix ms
const ev = (kind, dt) => ({ kind, at: T + dt });
const good = {
  ready: true, trigger: { at: T, launched: true, exitCode: 0, error: null },
  events: [ev("PumpAlive", -5100), ev("READY", -5000), ev("SessionLock", 800), ev("SessionUnlock", 40_000)],
  detectorFailed: false, logReadable: true, recovered: true, restarts: 0, timedOut: false,
};
const judge = (over) => L.judge({ ...good, ...over });

// ---------------------------------------------------------------- parsing and the log reader
test("parseWatch reads Reason/time lines and ignores junk, partial lines and CRLF", () => {
  const text = `READY ${T}\r\nSessionLock ${T + 5}\r\nnot a line\r\nSessionUnlock 12\r\nSessionUnl\r\nSessionUnlock ${T + 9}`;
  assert.deepEqual(L.parseWatch(text), [{ kind: "READY", at: T }, { kind: "SessionLock", at: T + 5 }, { kind: "SessionUnlock", at: T + 9 }]);
  assert.deepEqual(L.parseWatch(""), []);
  assert.deepEqual(L.parseWatch(null), []);
  assert.equal(L.parseWatchDetailed(text).malformed, 3);     // junk is counted, never turned into events
});

test("malformed or truncated records can never create a lock/unlock", () => {
  const junk = ["SessionLock", "SessionLock abc", "SessionLock 17000", `SessionLock ${T}x`, `sessionlock!! ${T}`, `${T} SessionLock`, "\u0000\u0000", `SessionLock  ${T}`].join("\n");
  const events = L.parseWatch(junk);
  assert.ok(!events.some((e) => e.kind === "SessionUnlock"));
  assert.equal(judge({ events: L.parseWatch("garbage\n\u0000\u0000\nSessionLock") }).verdict, "INCONCLUSIVE");
  // a record cut short (13 digits -> 12) is a smaller time, so the trigger filter drops it
  assert.equal(L.transitions(L.parseWatch(`SessionLock ${String(T).slice(0, 12)}`), T).lock, null);
});

function fakeFs(script) {
  let i = 0;
  return { readFileSync() { const s = script[Math.min(i++, script.length - 1)]; if (s instanceof Error) throw s; return s; } };
}
const err = (code) => Object.assign(new Error(code), { code });

test("log reader: a log that does not exist yet is normal, not an error", () => {
  const r = L.makeLogReader("x", fakeFs([err("ENOENT")]));
  assert.deepEqual(r.read(), []); assert.equal(r.stats().lastOk, true); assert.equal(r.stats().readErrors, 0);
});

test("log reader: an unreadable log keeps the last good events but reports the failure, and recovers when readable again", () => {
  const r = L.makeLogReader("x", fakeFs([`PumpAlive ${T}\nREADY ${T + 1}\n`, err("EACCES"), err("EBUSY"), `PumpAlive ${T}\nREADY ${T + 1}\nSessionLock ${T + 9}\n`]));
  assert.equal(r.read().length, 2); assert.equal(r.stats().lastOk, true);
  assert.equal(r.read().length, 2); assert.equal(r.stats().lastOk, false);          // EACCES: cached events, failure noted
  assert.equal(r.read().length, 2); assert.equal(r.stats().readErrors, 2);
  assert.equal(r.read().length, 3); assert.equal(r.stats().lastOk, true);
});

test("log reader: a log that vanishes after events were seen is an error, not an empty log", () => {
  const r = L.makeLogReader("x", fakeFs([`READY ${T}\n`, err("ENOENT")]));
  r.read(); const again = r.read();
  assert.equal(again.length, 1); assert.equal(r.stats().lastOk, false);
});

test("log reader: malformed lines are counted for the report", () => {
  const r = L.makeLogReader("x", fakeFs([`READY ${T}\njunk\n???\n`]));
  assert.equal(r.read().length, 1); assert.equal(r.stats().malformedLines, 2);
});

// ---------------------------------------------------------------- transitions
test("transitions: a lock needs to come at or after the trigger, and the unlock must come AFTER that lock", () => {
  assert.equal(L.transitions([ev("SessionLock", -1)], T).lock, null);                                    // a lock before the trigger is not ours
  assert.equal(L.transitions([ev("SessionUnlock", 100), ev("SessionLock", 200)], T).unlock, null);        // unlock before lock does not count
  const t = L.transitions([ev("SessionUnlock", -50), ev("SessionLock", 100), ev("SessionUnlock", 900)], T);
  assert.equal(t.lock.at, T + 100); assert.equal(t.unlock.at, T + 900);
  assert.equal(L.transitions([], T).lock, null);
  assert.equal(L.transitions(undefined, T).lock, null);
  const unsorted = L.transitions([ev("SessionUnlock", 900), ev("SessionLock", 100)], T);                  // out-of-order input is ordered by time first
  assert.ok(unsorted.lock && unsorted.unlock);
});

// ---------------------------------------------------------------- the verdict
test("PASS only with every condition: the baseline case passes, and the locked time is recorded", () => {
  const r = judge({});
  assert.equal(r.verdict, "PASS"); assert.equal(r.lockedMs, 39_200);
  assert.equal(judge({ restarts: 1 }).verdict, "PASS");
});

test("strict PASS matrix: removing ANY single condition makes the verdict something other than PASS", () => {
  const breakers = {
    "detector not ready": { ready: false },
    "no trigger": { trigger: null },
    "trigger failed (error)": { trigger: { at: T, launched: false, exitCode: null, error: "ENOENT" } },
    "trigger failed (exit 1)": { trigger: { at: T, launched: false, exitCode: 1, error: null } },
    "detector write failed": { detectorFailed: true },
    "detector failure unknown": { detectorFailed: undefined },
    "log unreadable": { logReadable: false },
    "log readability unknown": { logReadable: undefined },
    "no events at all": { events: [] },
    "only READY": { events: [ev("PumpAlive", -1), ev("READY", 0)] },
    "no lock": { events: [ev("READY", 0), ev("SessionUnlock", 5000)] },
    "no unlock": { events: [ev("READY", 0), ev("SessionLock", 800)] },
    "unlock before lock": { events: [ev("SessionUnlock", 100), ev("SessionLock", 200)] },
    "lock and unlock both before the trigger": { events: [ev("SessionLock", -3000), ev("SessionUnlock", -2000)] },
    "reads not recovered": { recovered: false },
    "recovery not checked": { recovered: null },
    "two helper restarts": { restarts: 2 },
    "restart count unknown": { restarts: undefined },
    "timed out waiting": { events: [ev("SessionLock", 800)], timedOut: true },
  };
  for (const [name, over] of Object.entries(breakers)) {
    const r = judge(over);
    assert.notEqual(r.verdict, "PASS", name);
    assert.ok(["FAIL", "INCONCLUSIVE"].includes(r.verdict), name);
  }
});

test("successful probes with NO lock/unlock notifications can never PASS (the old false PASS)", () => {
  const r = judge({ events: [ev("PumpAlive", -5100), ev("READY", -5000)] });
  assert.equal(r.verdict, "INCONCLUSIVE"); assert.equal(r.reason, "lock_not_observed");
});

test("a lock without an observed unlock is INCONCLUSIVE, whatever the probes or the Enter key say", () => {
  const r = judge({ events: [ev("READY", -5000), ev("SessionLock", 800)], recovered: true });
  assert.equal(r.verdict, "INCONCLUSIVE"); assert.equal(r.reason, "unlock_not_observed");
  assert.equal(judge({ events: [ev("SessionLock", 800)], timedOut: true }).reason, "unlock_not_observed_time_limit");
});

test("a persistence failure or an unreadable log is INCONCLUSIVE even when the events that were read look perfect", () => {
  assert.equal(judge({ detectorFailed: true }).reason, "detector_write_failed");
  assert.equal(judge({ logReadable: false }).reason, "log_unreadable");
});

test("a failed lock command is FAIL even if a lock notification shows up (for example a manual Win+L)", () => {
  for (const trigger of [{ at: T, launched: false, exitCode: null, error: "ENOENT" }, { at: T, launched: false, exitCode: 1, error: null }]) {
    const r = judge({ trigger });
    assert.equal(r.verdict, "FAIL"); assert.equal(r.reason, "lock_command_failed");
  }
});

test("reads that did not come back, or more than one helper restart, are FAIL", () => {
  assert.equal(judge({ recovered: false }).reason, "reads_did_not_recover");
  assert.equal(judge({ recovered: null }).verdict, "FAIL");
  assert.equal(judge({ restarts: 2 }).reason, "helper_restarted_more_than_once");
});

test("a detector that never became ready is INCONCLUSIVE", () => {
  const r = judge({ ready: false });
  assert.equal(r.verdict, "INCONCLUSIVE"); assert.equal(r.reason, "detector_not_ready");
});

// ---------------------------------------------------------------- readiness and the wait loop, with a fake clock
function clock() { let t = T; return { now: () => t, sleep: async (ms) => { t += ms; } }; }

test("readiness: PumpAlive + READY makes it ready", async () => {
  const c = clock();
  const r = await L.waitReady({ readLog: () => [ev("PumpAlive", 0), ev("READY", 1)], isAlive: () => true, timeoutMs: 20_000, ...c });
  assert.deepEqual(r, { ready: true, why: null });
});

test("readiness timeout: no READY within the time is not ready, and it does not wait longer than the limit", async () => {
  const c = clock(); const t0 = c.now();
  const r = await L.waitReady({ readLog: () => [], isAlive: () => true, timeoutMs: 20_000, ...c });
  assert.deepEqual(r, { ready: false, why: "timeout" });
  assert.ok(c.now() - t0 >= 20_000 && c.now() - t0 < 21_000);
});

test("readiness: READY without the event-loop proof (PumpAlive) is not accepted", async () => {
  const c = clock();
  const r = await L.waitReady({ readLog: () => [ev("READY", 0)], isAlive: () => true, timeoutMs: 1000, ...c });
  assert.equal(r.ready, false);
});

test("readiness: a watcher that reports a dead event loop, or exits, is not ready and is reported immediately", async () => {
  const c = clock(); const t0 = c.now();
  assert.deepEqual(await L.waitReady({ readLog: () => [ev("PumpNotAlive", 0)], isAlive: () => true, timeoutMs: 20_000, ...c }), { ready: false, why: "event_loop_not_alive" });
  assert.deepEqual(await L.waitReady({ readLog: () => [], isAlive: () => false, timeoutMs: 20_000, ...c }), { ready: false, why: "watcher_exited" });
  assert.equal(c.now(), t0);
});

test("readiness: becomes ready when the lines appear after a delay", async () => {
  const c = clock(); let calls = 0;
  const r = await L.waitReady({ readLog: () => (++calls > 3 ? [ev("PumpAlive", 0), ev("READY", 1)] : []), isAlive: () => true, timeoutMs: 20_000, ...c });
  assert.equal(r.ready, true);
});

const loop = (over) => { const c = clock(); let probes = 0; return { c, get probes() { return probes; }, run: () => L.waitForTransitions({ readLog: () => [], isAlive: () => true, probe: async () => { probes++; }, triggerAt: T, startedAt: T, capMs: 900_000, lockWaitMs: 30_000, launched: true, ...c, ...over }) }; };

test("wait loop: ends when the unlock is observed after the lock, probing while it waits", async () => {
  const c = clock(); let probes = 0;
  const logAt = () => (c.now() - T < 5000 ? [] : c.now() - T < 12_000 ? [ev("SessionLock", 3000)] : [ev("SessionLock", 3000), ev("SessionUnlock", 11_000)]);
  const why = await L.waitForTransitions({ readLog: logAt, isAlive: () => true, probe: async () => { probes++; }, triggerAt: T, startedAt: T, capMs: 900_000, lockWaitMs: 30_000, launched: true, ...c });
  assert.equal(why, "unlock_observed"); assert.ok(probes >= 5);
});

test("wait loop: no lock within 30 s stops waiting", async () => {
  const l = loop({}); const why = await l.run();
  assert.equal(why, "lock_wait_expired"); assert.ok(l.c.now() - T > 30_000 && l.c.now() - T < 33_000);
});

test("wait loop: a lock that is never followed by an unlock stops at the overall cap, not before", async () => {
  const l = loop({ readLog: () => [ev("SessionLock", 1000)] }); const why = await l.run();
  assert.equal(why, "time_limit"); assert.ok(l.c.now() - T > 900_000);
});

test("wait loop: watcher termination after the lock stops the wait", async () => {
  const c = clock(); let alive = true;
  const why = await L.waitForTransitions({ readLog: () => [ev("SessionLock", 1000)], isAlive: () => alive, probe: async () => { if (c.now() - T > 6000) alive = false; }, triggerAt: T, startedAt: T, capMs: 900_000, lockWaitMs: 30_000, launched: true, ...c });
  assert.equal(why, "watcher_exited"); assert.ok(c.now() - T < 20_000);
});

test("wait loop: a failed trigger is not waited on; stale pre-trigger events do not end the wait", async () => {
  assert.equal(await loop({ launched: false }).run(), "lock_command_failed");
  const stale = loop({ readLog: () => [ev("SessionLock", -5000), ev("SessionUnlock", -4000)] });
  assert.equal(await stale.run(), "lock_wait_expired");
});

test("wait loop: an unreadable log (cached events unchanged) cannot invent an unlock", async () => {
  const r = L.makeLogReader("x", fakeFs([`SessionLock ${T + 500}\n`, err("EACCES")]));
  const l = loop({ readLog: () => r.read(), capMs: 60_000 }); const why = await l.run();
  assert.equal(why, "time_limit"); assert.equal(r.stats().lastOk, false);
});

// ---------------------------------------------------------------- the lock command
function fakeSpawn(behaviour) {
  return () => {
    if (behaviour.throws) { const e = new Error("x"); e.code = behaviour.throws; throw e; }
    const c = new EventEmitter(); c.pid = behaviour.noPid ? undefined : 4321;
    setImmediate(() => { if (behaviour.error) c.emit("error", Object.assign(new Error("x"), { code: behaviour.error })); else if ("exit" in behaviour) c.emit("exit", behaviour.exit); });
    return c;
  };
}

test("fireLock records the real launch result: clean exit 0 is launched; an error, a non-zero exit or no pid is not", async () => {
  const pick = (r) => ({ launched: r.launched, exitCode: r.exitCode, error: r.error });
  assert.deepEqual(pick(await L.fireLock(fakeSpawn({ exit: 0 }))), { launched: true, exitCode: 0, error: null });
  assert.deepEqual(pick(await L.fireLock(fakeSpawn({ exit: 1 }))), { launched: false, exitCode: 1, error: null });
  assert.deepEqual(pick(await L.fireLock(fakeSpawn({ error: "ENOENT" }))), { launched: false, exitCode: null, error: "ENOENT" });
  assert.deepEqual(pick(await L.fireLock(fakeSpawn({ throws: "EACCES" }))), { launched: false, exitCode: null, error: "EACCES" });
  assert.equal((await L.fireLock(fakeSpawn({ noPid: true, exit: 0 }))).launched, false);
  assert.deepEqual(pick(await L.fireLock(fakeSpawn({}), 20)), { launched: true, exitCode: null, error: null });
});

// ---------------------------------------------------------------- source guards for the orchestration (main() itself starts real things and is never run here)
const SRC = fs.readFileSync(path.join(__dirname, "lock.cjs"), "utf8");
const RUN = SRC.slice(SRC.indexOf("async function main()"));

test("the script cannot be fooled by Enter: the run reads no console input after the typed confirmation", () => {
  assert.equal((RUN.match(/mk\.ask\(|\bask\(|readline|process\.stdin/g) || []).length, 0);
  assert.match(RUN, /mk\.confirmTyped\("LOCK"/);
  assert.ok(RUN.indexOf("confirmTyped") < RUN.indexOf("mk.bootstrap()"));
});

test("the detector is awaited BEFORE the lock command, nothing is locked when it is not ready, and there is a single lock call", () => {
  assert.ok(RUN.indexOf("await waitReady(") < RUN.indexOf("await fireLock(spawn)"));
  assert.match(RUN, /if \(!ready\)[\s\S]{0,200}NOTHING WAS LOCKED[\s\S]*else \{[\s\S]*fireLock\(spawn\)/);
  assert.equal((RUN.match(/fireLock\(/g) || []).length, 1);
  assert.equal((SRC.match(/LockWorkStation/g) || []).length, 1);         // named exactly once in the whole file: inside fireLock
  assert.equal((RUN.match(/LockWorkStation/g) || []).length, 0);         // main() itself never names it
});

test("the verdict is built from the failure marker and the last log read, and PASS cannot be reached without them", () => {
  assert.match(RUN, /detectorFailed = fs\.existsSync\(failFile\)/);
  assert.match(RUN, /logReadable: logStats\.lastOk/);
  assert.match(RUN, /judge\(\{ ready, trigger: trig, events, timedOut, detectorFailed, logReadable/);
});

test("the fixture and the watcher outlive the 15 minute cap with a cleanup margin, and the fixture is actually started with that lifetime", () => {
  const c = L.constants;
  assert.equal(c.CAP_S, 900);
  assert.ok(c.FIXTURE_SECONDS >= c.CAP_S + 300, "fixture lifetime must exceed the cap by at least 5 minutes");
  assert.ok(c.WATCHER_SECONDS >= c.CAP_S + 300, "watcher lifetime must exceed the cap by at least 5 minutes");
  assert.match(RUN, /launchBasic\(ctx, \{ tag: "lock", maxSeconds: FIXTURE_SECONDS \}\)/);
  assert.match(RUN, /"-MaxSeconds", String\(WATCHER_SECONDS\)/);
  const kit = fs.readFileSync(path.join(__dirname, "..", "lib", "kit.cjs"), "utf8");        // the override is plumbed through, with the old default kept
  assert.match(kit, /function spawnPs\(ctx, script, args = \[\], \{ maxSeconds = MAX_SECONDS \} = \{\}\)/);
  assert.match(kit, /"-MaxSeconds", String\(maxSeconds\)/);
  assert.match(kit, /launchBasic\(ctx, \{ tag, dup = false, layout = "standard", maxSeconds = MAX_SECONDS \} = \{\}\)/);
  assert.match(kit, /const MAX_SECONDS = 900;/);
});

test("the watcher runs PowerShell in MTA (before -File) so SystemEvents gets a message pump", () => {
  const m = /spawn\("powershell\.exe",\s*\[([^\]]*)\]/.exec(RUN);
  assert.ok(m, "the watcher must be spawned as powershell.exe with an argument array");
  const args = m[1];
  assert.match(args, /"-MTA"/, "PowerShell 5.1 defaults to STA: without -MTA SystemEvents has no message pump");
  assert.ok(args.indexOf('"-MTA"') < args.indexOf('"-File"'), "-MTA must precede -File (PowerShell requires -File last before script args)");
});

test("the detector script is ASCII, read-only (no input APIs), checks its event loop, writes a failure marker and has a self-destruct", () => {
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(L.WATCH_SCRIPT), "non-ASCII character in the watcher script");
  for (const re of [/SessionSwitch/, /TimerElapsed/, /CreateTimer/, /PumpAlive/, /PumpNotAlive/, /MaxSeconds/, /\.fail/, /Failures/, /exit 4/]) assert.match(L.WATCH_SCRIPT, re);
  assert.doesNotMatch(L.WATCH_SCRIPT, /SendKeys|SendInput|keybd_event|mouse_event|SetCursorPos|LockWorkStation|Stop-Process|taskkill/i);
  assert.ok(L.WATCH_SCRIPT.indexOf("Start($Out") < L.WATCH_SCRIPT.indexOf("exit 3"));
  assert.ok(L.CS_SOURCE.indexOf('Note("READY")') > L.CS_SOURCE.indexOf("pumpAlive"), "READY must come after the event-loop check");
});

// ---------------------------------------------------------------- C#/PowerShell: parse and compile, and the write-retry behaviour (Windows only).
// None of these calls Start(), so nothing subscribes to session events, creates a timer or touches the session.
const ps = (args, env) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", ...args], { encoding: "utf8", windowsHide: true, timeout: 90_000, env: { ...process.env, ...env } });
const winOnly = { skip: process.platform !== "win32" && "Windows only" };
const tmpFile = (name, text) => { const f = path.join(os.tmpdir(), `lockwatch-${process.pid}-${name}`); fs.writeFileSync(f, text); return f; };

test("the watcher PowerShell script parses without errors (parse only: it is not run)", winOnly, () => {
  const f = tmpFile("parse.ps1", L.WATCH_SCRIPT);
  try {
    const r = ps(["-Command", "$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:LW_FILE, [ref]$t, [ref]$e); 'ERRORS=' + @($e).Count"], { LW_FILE: f });
    assert.match(r.stdout, /ERRORS=0/, r.stdout + r.stderr);
  } finally { fs.rmSync(f, { force: true }); }
});

test("the watcher's C# compiles, and Note retries a briefly locked file, reports a permanent failure within a bounded time, and counts it", winOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockwatch-note-"));
  const cs = tmpFile("watch.cs", L.CS_SOURCE);
  const hold = tmpFile("hold.cs", `using System; using System.IO; using System.Threading;
public static class LwHold { public static void Hold(string p, int ms) { FileStream fs = new FileStream(p, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); Thread t = new Thread(delegate() { Thread.Sleep(ms); fs.Dispose(); }); t.Start(); } }
`);
  const script = tmpFile("note.ps1", `$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.dll -TypeDefinition (Get-Content -Raw -LiteralPath $env:LW_CS)
Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $env:LW_HOLD)
$names = [MomoLockWatch].GetMethods() | ForEach-Object { $_.Name }
$a = Join-Path $env:LW_DIR 'a.log'; [MomoLockWatch]::UsePath($a); $ra = [MomoLockWatch]::Note('SessionLock')
$b = Join-Path $env:LW_DIR 'b.log'; [LwHold]::Hold($b, 250); [MomoLockWatch]::UsePath($b); $rb = [MomoLockWatch]::Note('SessionUnlock')
$f0 = [MomoLockWatch]::Failures
[MomoLockWatch]::UsePath((Join-Path $env:LW_DIR 'nodir\\c.log')); $sw = [Diagnostics.Stopwatch]::StartNew(); $rc = [MomoLockWatch]::Note('SessionLock'); $ms = $sw.ElapsedMilliseconds
'RESULT has=' + (($names -contains 'Start') -and ($names -contains 'Note') -and ($names -contains 'UsePath')) + ' a=' + $ra + ' b=' + $rb + ' f0=' + $f0 + ' c=' + $rc + ' f1=' + [MomoLockWatch]::Failures + ' cms=' + $ms
'ALOG=' + (Get-Content -Raw -LiteralPath $a).Trim()
'BLOG=' + (Get-Content -Raw -LiteralPath $b).Trim()
`);
  try {
    const r = ps(["-File", script], { LW_CS: cs, LW_HOLD: hold, LW_DIR: dir });
    const out = r.stdout + r.stderr;
    const m = /RESULT has=(\w+) a=(\w+) b=(\w+) f0=(\d+) c=(\w+) f1=(\d+) cms=(\d+)/.exec(out);
    assert.ok(m, out);
    assert.equal(m[1], "True", "Start/Note/UsePath exist");
    assert.equal(m[2], "True", "a plain write succeeds");
    assert.equal(m[3], "True", "a write to a file held open for 250 ms succeeds on a retry");
    assert.equal(m[4], "0", "no failure counted so far");
    assert.equal(m[5], "False", "an impossible write returns false");
    assert.equal(m[6], "1", "and is counted as a failure");
    assert.ok(Number(m[7]) >= 400 && Number(m[7]) < 5000, "the retries are bounded: " + m[7] + " ms");
    assert.match(out, /ALOG=SessionLock \d{13}/); assert.match(out, /BLOG=SessionUnlock \d{13}/);
  } finally { for (const f of [cs, hold, script]) fs.rmSync(f, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});
