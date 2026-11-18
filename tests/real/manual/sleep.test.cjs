"use strict";
// Focused tests for the D05 sleep/resume script. Nothing here suspends the PC, changes a power setting, opens a window or sends input: the logic is fed fake System log events,
// a fake clock, a fake suspend command and a fake desktop. The only real calls are two READ-ONLY ones, marked Windows-only: reading the System log and asking whether the
// input desktop is open. Run:  node --test tests/real/manual/sleep.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const S = require("./sleep.cjs");

const T = 1_700_000_000_000;                        // an arbitrary "suspend command time" in unix ms
const C = S.constants;
const MIN = C.MIN_STANDBY_MS, WINDOW = C.ENTRY_WINDOW_MS, STABLE = C.FINAL_STABLE_MS, HANDOFF = C.HANDOFF_MAX_MS;
const BOOT = "1014";

// ---------------------------------------------------------------- realistic event builders (the shapes seen in this laptop's Kernel-Power log)
let rec = 1000, idSeq = 10;
const nextRec = () => rec++;
const clean = (d) => { const o = { ...d }; for (const k of Object.keys(o)) if (o[k] === null) delete o[k]; return o; };   // null removes a field (models a missing field); undefined / "" keep an empty one
const ev506 = (dt, data, r) => ({ id: 506, at: T + dt, rec: r === undefined ? nextRec() : r, data: data === undefined ? {} : data, msg: "The_system_is_entering_Modern_Standby_" });
const ev507 = (dt, data, r) => ({ id: 507, at: T + dt, rec: r === undefined ? nextRec() : r, data: data === undefined ? {} : data, msg: "The_system_is_exiting_Modern_Standby_" });
/** Kernel-Power 187 is diagnostic-only: the caller that requested the state change and the state it asked for. */
const ev187 = (dt, data, r) => ({ id: 187, at: T + dt, rec: r === undefined ? nextRec() : r, data: data === undefined ? {} : data, msg: "User_mode_process_attempted_to_change_the_system_state_" });
/** One complete cycle: 506 (ScenarioInstanceId = id) and 507 (ScenarioInstanceIdV2 = id, own ScenarioInstanceId = id + 2), same BootId. Overrides: d506 / d507 / boot / boot507 / id / own / v2. */
function cyc(startDt, endDt, o = {}) {
  const id = String(o.id !== undefined ? o.id : (idSeq += 3)), boot = o.boot !== undefined ? o.boot : BOOT;
  const own = o.own !== undefined ? o.own : String(Number(id) + 2);
  const d506 = clean({ BootId: boot, ScenarioInstanceId: id, Reason: "15", ...(o.d506 || {}) });
  const d507 = clean({ BootId: o.boot507 !== undefined ? o.boot507 : boot, ScenarioInstanceIdV2: o.v2 !== undefined ? o.v2 : id, ScenarioInstanceId: own, Reason: "55", SleepEntered: "true", SleepDurationInUs: String((endDt - startDt) * 1000), DurationInUs: String((endDt - startDt) * 1000), ...(o.d507 || {}) });
  return [ev506(startDt, d506), ev507(endDt, d507)];
}
/** A chain of cycles handed off exactly as Windows does: each next 506 carries the previous 507's own ScenarioInstanceId. spans = [[start, end], ...] (relative ms). */
function chain(spans, o = {}) {
  const out = []; let id = Number(o.id !== undefined ? o.id : (idSeq += 6));
  spans.forEach(([s, x], i) => { out.push(...cyc(s, x, { id: String(id), boot: o.boot, ...((o.per && o.per[i]) || {}) })); id += 2; });
  return out;
}
const analysis = (events, nowDt, trigDt = 0) => S.analyzePower(events, T + trigDt, T + nowDt);
const stable = (final) => final + STABLE;                                              // the first moment a final 507 is established

// every trigger used below is explicit about its state: a COMPLETED one (finished, exit code 0) and an unreported (still running, exit not reported) one
const completed = { at: T, pid: 4321, exitCode: 0, signal: null, exited: true, exitedAt: T + 100_000, error: null };
const running = { at: T, pid: 4321, exitCode: null, signal: null, exited: false, exitedAt: null, error: null };
const verified = analysis(cyc(2000, 62_000), stable(62_000));
const good = { preflight: null, trigger: completed, analysis: verified, waitReason: "verified", signedIn: true, recovered: true, restarts: 0 };
const judge = (over) => S.judge({ ...good, ...over });
const clock = () => { let t = T; return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } }; };

// ---------------------------------------------------------------- reading the log
test("parseEvents reads '<id> <unix ms> <record> data=... msg=...' lines, ignores junk, and needs the OK line", () => {
  const out = `506 ${T} 11 data=Reason=55|LidOpenState=false msg=The_system_is_entering_Modern_Standby_\r\n507 ${T + 20_000} 12 data=Reason=15|SleepEntered=true|DurationInUs=20000000 msg=The_system_is_exiting_Modern_Standby_\r\nrubbish\r\n508 ${T} 1 data= msg=\r\n506 123 1 data= msg=\r\nOK\r\n`;
  const p = S.parseEvents(out);
  assert.equal(p.ok, true);
  assert.equal(p.events.length, 2);
  assert.deepEqual(p.events[0], { id: 506, at: T, rec: 11, data: { Reason: "55", LidOpenState: "false" }, msg: "The_system_is_entering_Modern_Standby_" });
  assert.deepEqual(p.events[1].data, { Reason: "15", SleepEntered: "true", DurationInUs: "20000000" });
  assert.equal(S.parseEvents(`506 ${T} 11 data= msg=\n`).ok, false);        // cut off before OK: not a complete read
  assert.equal(S.parseEvents("").ok, false);
  assert.equal(S.parseEvents(null).ok, false);
  assert.deepEqual(S.parseEvents("OK").events, []);                           // no events is a valid, complete answer
});

test("parseEvents carries the identifiers: BootId, ScenarioInstanceId and ScenarioInstanceIdV2 arrive as strings, and lines without them give empty data", () => {
  const p = S.parseEvents(`506 ${T} 11 data=BootId=1014|ScenarioInstanceId=20|Reason=55 msg=x\n507 ${T + 1} 12 data=BootId=1014|ScenarioInstanceIdV2=20|ScenarioInstanceId=22|SleepEntered=true|SleepDurationInUs=2777770362 msg=y\n507 ${T + 2} 13\nOK`);
  assert.deepEqual(p.events[0].data, { BootId: "1014", ScenarioInstanceId: "20", Reason: "55" });
  assert.deepEqual(p.events[1].data, { BootId: "1014", ScenarioInstanceIdV2: "20", ScenarioInstanceId: "22", SleepEntered: "true", SleepDurationInUs: "2777770362" });
  assert.deepEqual(p.events[2].data, {});
  assert.deepEqual(S.parseData("A=1|B=x|junk|=bad|C="), { A: "1", B: "x", C: "" });
});

test("parseEvents records Kernel-Power 187 caller/state diagnostics, and 187 with exit code 0 never proves standby", () => {
  const caller = "\\Device\\HarddiskVolume3\\Windows\\System32\\winlogon.exe";
  const p = S.parseEvents(`187 ${T + 500} 9 data=ApiCallerName=${caller}|SystemAction=3|LightestSystemState=2 msg=User_mode_process_attempted_to_change_the_system_state_\nOK`);
  assert.equal(p.ok, true);
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0].id, 187);
  assert.deepEqual(p.events[0].data, { ApiCallerName: caller, SystemAction: "3", LightestSystemState: "2" });
  assert.deepEqual(S.event187Diagnostics(p.events), [{
    id: 187, at: T + 500, record: 9, caller, systemAction: "3", lightestSystemState: "2",
    data: p.events[0].data, message: "User_mode_process_attempted_to_change_the_system_state_",
  }]);

  // The shorter Caller alias is accepted too, and absent fields stay null rather than being invented.
  const alias = S.event187Diagnostics(S.parseEvents(`187 ${T + 600} 10 data=Caller=svchost.exe|SystemAction=3\nOK`).events);
  assert.deepEqual(alias, [{
    id: 187, at: T + 600, record: 10, caller: "svchost.exe", systemAction: "3", lightestSystemState: null,
    data: { Caller: "svchost.exe", SystemAction: "3" }, message: "",
  }]);

  // 187 is diagnostic only: even a completed suspend command (exit code 0) cannot make the verdict PASS.
  const only187 = analysis(p.events, stable(62_000));
  assert.equal(only187.state, "entry_not_observed");
  assert.equal(judge({ analysis: only187, trigger: completed, waitReason: only187.state }).verdict, "INCONCLUSIVE");

  // Adding 187 to a real 506/507 session changes no verification field, and the verdict stays PASS.
  const session = cyc(2000, 62_000, { id: 20 });
  const base = analysis(session, stable(62_000));
  const with187 = analysis([ev187(500, p.events[0].data, 9), ...session], stable(62_000));
  assert.equal(base.state, "verified");
  assert.equal(with187.state, base.state);
  assert.equal(with187.cycleCount, base.cycleCount);
  assert.equal(with187.standbyMs, base.standbyMs);
  assert.equal(with187.enter.rec, base.enter.rec);
  assert.equal(with187.exit.rec, base.exit.rec);
  assert.equal(judge({ analysis: with187 }).verdict, "PASS");
});

test("readPowerEvents reports a failed or incomplete read as not ok (never as 'no events'), and never throws", () => {
  const spawnReturning = (r) => () => r;
  const okRead = S.readPowerEvents(T, spawnReturning({ status: 0, stdout: `506 ${T} 1 data=Reason=55 msg=x\nOK\n` }));
  assert.equal(okRead.ok, true); assert.deepEqual(okRead.events[0].data, { Reason: "55" });
  assert.equal(S.readPowerEvents(T, spawnReturning({ status: 0, stdout: "OK\n" })).ok, true);
  assert.equal(S.readPowerEvents(T, spawnReturning({ status: 1, stdout: "OK\n" })).ok, false);
  assert.equal(S.readPowerEvents(T, spawnReturning({ status: 0, stdout: `506 ${T} 1\n` })).ok, false);
  assert.equal(S.readPowerEvents(T, spawnReturning({ error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }), status: null })).ok, false);
  assert.equal(S.readPowerEvents(T, spawnReturning(null)).ok, false);
  assert.equal(S.readPowerEvents(T, () => { throw Object.assign(new Error("x"), { code: "EACCES" }); }).ok, false);
});

test("readPowerEvents asks for the events since the given time through the environment, with a read-only script that keeps only a whitelist of safe fields", () => {
  let seen;
  S.readPowerEvents(T + 0.9, (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0, stdout: "OK" }; });
  assert.equal(seen.cmd, "powershell.exe");
  assert.equal(seen.opts.env.SL_SINCE, String(T));
  assert.ok(seen.opts.timeout > 0 && seen.opts.timeout <= 60_000);
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(S.READ_SCRIPT), "non-ASCII in the read script");
  assert.match(S.READ_SCRIPT, /Id = 187, 506, 507/); assert.match(S.READ_SCRIPT, /Microsoft-Windows-Kernel-Power/);
  assert.match(S.READ_SCRIPT, /\$keep = 'Caller', 'ApiCallerName', 'SystemAction', 'LightestSystemState', 'Reason', 'ScenarioInstanceId', 'ScenarioInstanceIdV2'/);
  for (const f of ["Caller", "ApiCallerName", "SystemAction", "LightestSystemState", "BootId", "SleepEntered", "SleepDurationInUs"]) assert.ok(S.READ_SCRIPT.includes(`'${f}'`), f + " must be read");
  assert.match(S.READ_SCRIPT, /-replace '\[\^A-Za-z0-9_\.=\|:,\\\\-]', '_'/);                   // output is sanitised, but caller backslashes survive
  assert.doesNotMatch(S.READ_SCRIPT, /Set-|Remove-|Clear-|New-|Start-Process|Stop-|wevtutil|powercfg|Restart|Suspend|SetSuspendState|Battery|Energy/i);
});

const winOnly = { skip: process.platform !== "win32" && "Windows only" };

test("the real System log can be read, and its events carry the diagnostic fields (READ-ONLY; whatever it holds, the read itself works)", winOnly, () => {
  const r = S.readPowerEvents(Date.now() - 3 * 24 * 3600 * 1000);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.events.every((x) => (x.id === 187 || x.id === 506 || x.id === 507) && x.at > 1e12 && Number.isInteger(x.rec) && typeof x.msg === "string" && x.data && typeof x.data === "object"));
  assert.ok(r.events.every((x) => Object.values(x.data).every((v) => /^[A-Za-z0-9_.:,\\-]*$/.test(v))), "diagnostic values must be sanitised");
  assert.equal(S.readPowerEvents(Date.now()).ok, true);          // "no matching events" is a successful, empty read
});

// ---------------------------------------------------------------- the desktop
test("inputDesktopAvailable: true when the desktop opens (and the probe handle is closed), false when it does not, and it throws when the check is unavailable", () => {
  let closed = 0;
  assert.equal(S.inputDesktopAvailable({ open: () => 77, close: () => { closed++; } }), true); assert.equal(closed, 1);
  assert.equal(S.inputDesktopAvailable({ open: () => 0, close: () => { closed++; } }), false); assert.equal(closed, 1);
  assert.equal(S.inputDesktopAvailable({ open: () => 5, close: () => { throw new Error("x"); } }), true);
  assert.throws(() => S.inputDesktopAvailable({ open: () => { throw new Error("no api"); }, close() {} }));
});

test("the real input-desktop check works (READ-ONLY)", winOnly, () => {
  assert.equal(typeof S.inputDesktopAvailable(), "boolean");
});

// ---------------------------------------------------------------- cycles: matched by identifiers, never by time
test("a cycle is usable only when BootId matches and ScenarioInstanceId (506) equals ScenarioInstanceIdV2 (507), all present and non-empty", () => {
  const [e, x] = cyc(1000, 31_000, { id: 20 });
  assert.equal(S.makeCycle(e, x).status, "ok");
  assert.equal(S.makeCycle(e, x).ms, 30_000);
  const [e2, x2] = cyc(1000, 31_000, { id: 20, v2: 21 });
  assert.equal(S.makeCycle(e2, x2).status, "ids_mismatch");
  const [e3, x3] = cyc(1000, 31_000, { id: 20, boot507: "1015" });
  assert.equal(S.makeCycle(e3, x3).status, "ids_mismatch");
  for (const o of [{ d506: { ScenarioInstanceId: undefined } }, { d506: { ScenarioInstanceId: "" } }, { d506: { ScenarioInstanceId: "  " } }, { d506: { ScenarioInstanceId: null } },
    { v2: "" }, { v2: null }, { d506: { BootId: null } }, { d507: { BootId: "" } }, { boot: null }, { boot507: null }]) {
    const [a, b] = cyc(1000, 31_000, { id: 20, ...o });
    assert.equal(S.makeCycle(a, b).status, "ids_unavailable", JSON.stringify(o));
  }
  assert.equal(S.makeCycle({ id: 506, at: T, rec: 1 }, { id: 507, at: T + 1, rec: 2 }).status, "ids_unavailable");   // events without any data
});

test("linking: the next 506 continues the session only with the same boot, ScenarioInstanceId == the previous 507's own id, and a gap of 0..1000 ms", () => {
  const prev = S.makeCycle(...cyc(0, 10_000, { id: 20 }));                    // own id of its 507 = 22
  const next = (gap, d) => ev506(10_000 + gap, clean({ BootId: BOOT, ScenarioInstanceId: "22", ...(d || {}) }));
  for (const gap of [0, 1, 2, 5, 6, 13, 500, HANDOFF]) assert.equal(S.linkOf(prev, next(gap)), "linked", String(gap));
  assert.equal(S.linkOf(prev, next(HANDOFF + 1)), "none");
  assert.equal(S.linkOf(prev, next(3783)), "none");                              // the smallest non-linked gap seen on this laptop
  assert.equal(S.linkOf(prev, next(-1)), "none");
  assert.equal(S.linkOf(prev, next(1, { ScenarioInstanceId: "23" })), "ids_mismatch");
  assert.equal(S.linkOf(prev, next(1, { BootId: "1015" })), "ids_mismatch");
  assert.equal(S.linkOf(prev, next(1, { ScenarioInstanceId: "" })), "ids_unavailable");
  assert.equal(S.linkOf(prev, next(1, { BootId: null })), "ids_unavailable");
  const noOwn = S.makeCycle(...cyc(0, 10_000, { id: 20, d507: { ScenarioInstanceId: "" } }));
  assert.equal(S.linkOf(noOwn, next(1)), "ids_unavailable");
});

// ---------------------------------------------------------------- sessions: the analysis
test("a single matched cycle: first 506 within 30 s of the command, final 507 at least 10 s later and established, is verified", () => {
  const a = analysis(cyc(2000, 62_000), stable(62_000));
  assert.equal(a.state, "verified"); assert.equal(a.standbyMs, 60_000); assert.equal(a.cycles, 1); assert.equal(a.cycleCount, 1); assert.equal(a.lateEntries, 0); assert.deepEqual(a.linkGapsMs, []);
  assert.equal(analysis(cyc(0, MIN), stable(MIN)).state, "verified");              // exactly 10 s is enough
});

test("realistic two-cycle chain: the first cycle lasts 78 s, the handoff takes 1 ms; the session ends at the FINAL 507, not the intermediate one", () => {
  const ev = chain([[2000, 80_000], [80_001, 2_863_000]]);
  const a = analysis(ev, stable(2_863_000));
  assert.equal(a.state, "verified");
  assert.equal(a.cycleCount, 2); assert.deepEqual(a.linkGapsMs, [1]);
  assert.equal(a.enter.at, T + 2000); assert.equal(a.exit.at, T + 2_863_000); assert.notEqual(a.exit.at, T + 80_000);
  assert.equal(a.standbyMs, 2_861_000);
  assert.equal(a.sessions, 1);
});

test("realistic three-cycle chain with handoff gaps of 0 and 13 ms", () => {
  const ev = chain([[2000, 20_000], [20_000, 400_000], [400_013, 520_000]]);
  const a = analysis(ev, stable(520_000));
  assert.equal(a.state, "verified"); assert.equal(a.cycleCount, 3); assert.deepEqual(a.linkGapsMs, [0, 13]);
  assert.equal(a.exit.at, T + 520_000); assert.equal(a.standbyMs, 518_000);
});

test("handoff gaps of 0 to 1000 ms link the cycles; 1001 ms does not (two sessions, the first one stands alone)", () => {
  for (const gap of [0, 1, 2, 5, 6, 13, 500, HANDOFF]) {
    const a = analysis(chain([[2000, 30_000], [30_000 + gap, 90_000]]), stable(90_000));
    assert.equal(a.state, "verified", String(gap)); assert.equal(a.cycleCount, 2, String(gap)); assert.equal(a.exit.at, T + 90_000);
  }
  const apart = analysis(chain([[2000, 30_000], [30_000 + HANDOFF + 1, 90_000]]), stable(90_000));
  assert.equal(apart.sessions, 2); assert.equal(apart.state, "verified"); assert.equal(apart.cycleCount, 1); assert.equal(apart.exit.at, T + 30_000);   // not linked: the first cycle is its own session
});

test("an intermediate 507 is never the wake-up: a first cycle over 10 s whose chain is still open is not verified, however late it is read", () => {
  const open = [...cyc(2000, 80_000, { id: 20 }), ev506(80_001, { BootId: BOOT, ScenarioInstanceId: "22", Reason: "55" })];     // linked 506, its 507 not logged yet
  for (const nowDt of [82_000, 90_000, 200_000, 3_600_000]) {
    const a = analysis(open, nowDt);
    assert.equal(a.state, "in_standby", String(nowDt)); assert.notEqual(a.state, "verified");
  }
  assert.equal(analysis(open, 3_600_000).enter.at, T + 2000);
});

test("handoff where the next 506 has not appeared yet: pending until the final 507 is stable; a linked 506 logged in the meantime extends the chain", () => {
  const first = cyc(1000, 13_000, { id: 20 });
  assert.equal(analysis(first, 13_000 + 1000).state, "pending");                // a linked 506 may still arrive
  assert.equal(analysis(first, 13_000 + STABLE - 1).state, "pending");
  assert.equal(analysis(first, 13_000 + STABLE).state, "verified");
  const extended = [...first, ev506(13_001, { BootId: BOOT, ScenarioInstanceId: "22" })];
  assert.equal(analysis(extended, 13_000 + STABLE).state, "in_standby");        // the chain continued: the first 507 was not the end
  const finished = chain([[1000, 13_000], [13_001, 25_000]], { id: 20 });
  assert.equal(analysis(finished, 25_000 + STABLE - 1).state, "pending");
  const f = analysis(finished, 25_000 + STABLE);
  assert.equal(f.state, "verified"); assert.equal(f.exit.at, T + 25_000); assert.equal(f.cycleCount, 2);
});

test("final 507 stability period: established exactly at 5 s without a linked next 506, never before", () => {
  const ev = cyc(2000, 62_000);
  for (const age of [0, 1, 2500, 4999]) assert.equal(analysis(ev, 62_000 + age).state, "pending", String(age));
  for (const age of [5000, 5001, 60_000, 3_600_000]) assert.equal(analysis(ev, 62_000 + age).state, "verified", String(age));
  assert.equal(C.FINAL_STABLE_MS, 5000);
});

test("trigger window: the session's first 506 must be within 30 s of the command (30 000 ms accepted, 30 001 ms not); later cycles of the chain may be anywhere", () => {
  assert.equal(analysis(cyc(WINDOW, WINDOW + 60_000), stable(WINDOW + 60_000)).state, "verified");
  const late = analysis(cyc(WINDOW + 1, WINDOW + 1 + 60_000), stable(WINDOW + 61_001));
  assert.equal(late.state, "entry_outside_window"); assert.equal(late.lateEntries, 1); assert.notEqual(late.state, "verified");
  assert.equal(analysis(cyc(WINDOW + 1, WINDOW + 1 + 60_000), 40_000).state, "pending");                 // not decided yet: log lag is allowed until the wait ends
  assert.equal(analysis(cyc(20 * 60_000, 25 * 60_000), 40 * 60_000).state, "entry_outside_window");     // a natural standby minutes later
  const longChain = analysis(chain([[WINDOW, WINDOW + 20_000], [WINDOW + 20_001, WINDOW + 400_000]]), stable(WINDOW + 400_000));
  assert.equal(longChain.state, "verified");
  assert.equal(analysis(chain([[WINDOW + 1, WINDOW + 20_000], [WINDOW + 20_001, WINDOW + 400_000]]), stable(WINDOW + 400_000)).state, "entry_outside_window");   // the window is judged on the FIRST 506
  assert.equal(analysis([...cyc(45_000, 90_000), ...cyc(5000, 5000 + MIN)], 200_000).state, "verified");   // an in-window session still verifies next to a late one
});

test("minimum duration applies to the COMPLETE session: 6 s + 6 s chained is 12 s and verifies; 4 s + 4 s is 8 s and does not; the boundary is exactly 10 s", () => {
  const twelve = analysis(chain([[1000, 7000], [7001, 13_001]]), stable(13_001));
  assert.equal(twelve.state, "verified"); assert.equal(twelve.standbyMs, 12_001);
  const eight = analysis(chain([[1000, 5000], [5001, 9001]]), stable(9001) + 1);
  assert.notEqual(eight.state, "verified"); assert.equal(eight.state, "pending");                           // inside the grace time a real session may still follow
  assert.equal(analysis(chain([[1000, 5000], [5001, 9001]]), 9001 + C.SHORT_GRACE_MS + 1).state, "standby_too_short");
  assert.equal(analysis(cyc(1000, 1000 + MIN), stable(1000 + MIN)).state, "verified");                      // 10 000 ms
  assert.notEqual(analysis(cyc(1000, 1000 + MIN - 1), stable(1000 + MIN)).state, "verified");               // 9 999 ms
  assert.equal(analysis(chain([[1000, 5000], [5001, 12_001]]), stable(12_001)).state, "verified");           // 4 s + 7 s = 11 s: no single cycle needs to reach 10 s
  assert.equal(analysis([...cyc(1000, 4000), ...cyc(6000, 6000 + MIN + 1)], 100_000).state, "verified");    // a short session first, then a real one
});

test("missing, empty or null identifiers: ids_unavailable, never verified, and never worked around with timestamps", () => {
  const variants = {
    "506 without ScenarioInstanceId": { d506: { ScenarioInstanceId: null } },
    "506 with an empty ScenarioInstanceId": { d506: { ScenarioInstanceId: "" } },
    "506 with a blank ScenarioInstanceId": { d506: { ScenarioInstanceId: "   " } },
    "507 without ScenarioInstanceIdV2": { v2: null },
    "507 with an empty ScenarioInstanceIdV2": { v2: "" },
    "506 without BootId": { d506: { BootId: null } },
    "507 without BootId": { d507: { BootId: null } },
    "506 with an empty BootId": { d506: { BootId: "" } },
  };
  for (const [name, o] of Object.entries(variants)) {
    const a = analysis(cyc(2000, 62_000, { id: 20, ...o }), 3_600_000);
    assert.equal(a.state, "ids_unavailable", name); assert.notEqual(a.state, "verified", name); assert.equal(a.badCycles, 1, name);
  }
  const noData = [{ id: 506, at: T + 2000, rec: 1 }, { id: 507, at: T + 62_000, rec: 2 }];                // a perfect 60 s pair by time alone
  assert.equal(analysis(noData, 3_600_000).state, "ids_unavailable");
  assert.equal(analysis([ev506(2000, {}), ev507(62_000, {})], 3_600_000).state, "ids_unavailable");
  assert.equal(analysis(cyc(2000, 62_000, { id: 20, v2: null }).map((e) => ({ ...e, data: {} })), 3_600_000).state, "ids_unavailable");
});

test("mismatched identifiers or BootId: ids_mismatch, never verified", () => {
  assert.equal(analysis(cyc(2000, 62_000, { id: 20, v2: 24 }), 3_600_000).state, "ids_mismatch");
  assert.equal(analysis(cyc(2000, 62_000, { id: 20, boot507: "1015" }), 3_600_000).state, "ids_mismatch");
  assert.equal(analysis(cyc(2000, 62_000, { id: 20, boot: "1013", boot507: "1014" }), 3_600_000).state, "ids_mismatch");
});

test("repeated identifiers across boots are never mixed: the same id in another boot does not match, and only the boot-and-id pair links", () => {
  assert.equal(analysis([ev506(2000, { BootId: "1013", ScenarioInstanceId: "5" }), ev507(62_000, { BootId: "1014", ScenarioInstanceIdV2: "5", ScenarioInstanceId: "7" })], 3_600_000).state, "ids_mismatch");
  const prev = cyc(2000, 30_000, { id: 5, boot: "1013" });                                                // 507 own id = 7, boot 1013
  const sameIdOtherBoot = [...prev, ev506(30_001, { BootId: "1014", ScenarioInstanceId: "7" }), ev507(90_000, { BootId: "1014", ScenarioInstanceIdV2: "7", ScenarioInstanceId: "9" })];
  const a = analysis(sameIdOtherBoot, 3_600_000);
  assert.equal(a.state, "ids_mismatch"); assert.notEqual(a.state, "verified");                              // ids equal, boots differ, 1 ms apart: ambiguous, not linked
  const farApart = [...prev, ...cyc(600_000, 700_000, { id: 5, boot: "1014" })];                          // the same id 5 again in a later boot, far outside the window
  const b = analysis(farApart, stable(700_000));
  assert.equal(b.state, "verified"); assert.equal(b.cycleCount, 1); assert.equal(b.exit.at, T + 30_000); assert.equal(b.lateEntries, 1);
});

test("a handoff-close 506 whose identifiers cannot show the link makes the end of the session uncertain: ids_mismatch / ids_unavailable, never verified", () => {
  const first = cyc(2000, 40_000, { id: 20 });                                                            // own id 22
  const mism = [...first, ev506(40_002, { BootId: BOOT, ScenarioInstanceId: "30" }), ev507(90_000, { BootId: BOOT, ScenarioInstanceIdV2: "30", ScenarioInstanceId: "32" })];
  assert.equal(analysis(mism, 3_600_000).state, "ids_mismatch");
  const noSid = [...first, ev506(40_002, { BootId: BOOT }), ev507(90_000, { BootId: BOOT, ScenarioInstanceIdV2: "22", ScenarioInstanceId: "24" })];
  assert.equal(analysis(noSid, 3_600_000).state, "ids_unavailable");
  const noOwn = [...cyc(2000, 40_000, { id: 20, d507: { ScenarioInstanceId: null } }), ...cyc(40_002, 90_000, { id: 22 })];
  assert.equal(analysis(noOwn, 3_600_000).state, "ids_unavailable");
  const farEnough = [...first, ...cyc(40_000 + HANDOFF + 1, 90_000, { id: 30 })];                         // 1001 ms later with an unrelated id: simply a separate session
  assert.equal(analysis(farEnough, 3_600_000).state, "verified");
});

test("no false PASS from time-only evidence: perfect timing without identifiers, reversed order, an exit alone, or an entry alone never verify", () => {
  const timingOnly = [{ id: 506, at: T + 1000, rec: 1 }, { id: 507, at: T + 120_000, rec: 2 }];
  assert.notEqual(analysis(timingOnly, 3_600_000).state, "verified");
  assert.notEqual(analysis(timingOnly, 3_600_000).state, "pending");
  assert.equal(judge({ analysis: analysis(timingOnly, 3_600_000), waitReason: "ids_unavailable" }).verdict, "INCONCLUSIVE");
  assert.equal(judge({ analysis: analysis(timingOnly, 3_600_000), waitReason: "ids_unavailable" }).reason, "standby_ids_unavailable");
  const [e, x] = cyc(20_000, 80_000);
  const reversed = analysis([ev507(10_000, x.data), e], 3_600_000);                                        // an exit BEFORE the entry
  assert.equal(reversed.state, "in_standby"); assert.equal(reversed.orphanExits, 1); assert.notEqual(reversed.state, "verified");
  assert.equal(analysis([x], 3_600_000).state, "entry_not_observed");                                       // an exit alone
  assert.equal(analysis([e], 3_600_000).state, "in_standby");                                               // an entry alone
});

test("ordering: events are sorted by time and then record number, so a same-millisecond handoff is read in record order", () => {
  const first = cyc(2000, 40_000, { id: 20 });
  const [n506, n507] = cyc(40_000, 100_000, { id: 22 });                                                    // same millisecond as the previous 507
  const a = analysis([n507, n506, ...first], stable(100_000));                                              // shuffled input
  assert.equal(a.state, "verified"); assert.equal(a.cycleCount, 2); assert.deepEqual(a.linkGapsMs, [0]);
  const flicker = analysis([ev507(500, { BootId: BOOT, ScenarioInstanceIdV2: "1", ScenarioInstanceId: "3" }, 5), ev506(500, { BootId: BOOT, ScenarioInstanceId: "3" }, 6)], 300_000);
  assert.equal(flicker.state, "in_standby"); assert.equal(flicker.orphanExits, 1);                          // exit recorded first: an orphan, then an open entry
});

test("events from before the suspend command never count; a standby that was already running is not ours", () => {
  const a = analysis(cyc(-5000, 60_000), 3_600_000);
  assert.notEqual(a.state, "verified"); assert.equal(a.orphanExits, 1);
  assert.equal(analysis([...cyc(-60_000, -5000), ...cyc(2000, 62_000)], stable(62_000)).state, "verified");
  assert.equal(analysis(undefined, 5000).state, "pending");
  assert.equal(analysis([{ id: 508, at: T + 2000, rec: 1 }, null, { id: 506 }], 100_000).state, "entry_not_observed");     // junk entries are ignored
});

test("missing events: nothing logged is pending, then entry_not_observed after the wait; an entry without an exit stays in_standby (never verified)", () => {
  assert.equal(analysis([], 30_000).state, "pending");
  assert.equal(analysis([], C.ENTRY_WAIT_MS + 1).state, "entry_not_observed");
  const a = analysis([cyc(2000, 3000)[0]], 500_000);
  assert.equal(a.state, "in_standby"); assert.notEqual(a.state, "verified");
});

test("diagnostics: SleepEntered, SleepDurationInUs and the reasons are recorded per cycle and are NOT conditions: PASS does not depend on them", () => {
  const a = analysis(chain([[2000, 80_000], [80_001, 2_863_000]]), stable(2_863_000));
  assert.equal(a.cycleDiagnostics.length, 2);
  assert.deepEqual(Object.keys(a.cycleDiagnostics[0]).sort(), ["durationUs", "enterRecord", "exitRecord", "ms", "reasonEnter", "reasonExit", "sleepDurationUs", "sleepEntered"]);
  assert.equal(a.cycleDiagnostics[0].sleepEntered, "true"); assert.equal(a.cycleDiagnostics[0].sleepDurationUs, "78000000"); assert.equal(a.cycleDiagnostics[1].reasonEnter, "15");
  const noSleep = analysis(cyc(2000, 62_000, { d507: { SleepEntered: "false", SleepDurationInUs: "0" } }), stable(62_000));
  assert.equal(noSleep.state, "verified"); assert.equal(noSleep.cycleDiagnostics[0].sleepEntered, "false");           // recorded, not judged
  const absent = analysis(cyc(2000, 62_000, { d507: { SleepEntered: null, SleepDurationInUs: null, DurationInUs: null, Reason: null } }), stable(62_000));
  assert.equal(absent.state, "verified"); assert.equal(absent.cycleDiagnostics[0].sleepEntered, null);
  assert.equal(judge({ analysis: noSleep }).verdict, "PASS"); assert.equal(judge({ analysis: absent }).verdict, "PASS");
  assert.doesNotMatch(S.judge.toString(), /SleepEntered|SleepDuration/);
  const decisionCode = S.analyzePower.toString().split("\n").filter((l) => !/cycleDiagnostics/.test(l)).join("\n");     // everything except the diagnostics mapping
  assert.doesNotMatch(decisionCode, /SleepEntered|SleepDuration/);                                                      // read for diagnostics only, never in a decision
});

test("the pairing code never decides anything by time alone: cycles come from identifiers, sessions from identifier links", () => {
  assert.match(S.makeCycle.toString(), /ScenarioInstanceIdV2/); assert.match(S.makeCycle.toString(), /BootId/);
  assert.doesNotMatch(S.makeCycle.toString(), /MIN_STANDBY_MS|HANDOFF_MAX_MS|ENTRY_WINDOW_MS/);
  assert.match(S.linkOf.toString(), /own !== next/); assert.match(S.linkOf.toString(), /HANDOFF_MAX_MS/);
  assert.match(S.analyzePower.toString(), /makeCycle\(/); assert.match(S.analyzePower.toString(), /linkOf\(/); assert.match(S.analyzePower.toString(), /FINAL_STABLE_MS/);
  assert.equal(C.HANDOFF_MAX_MS, 1000);
});

// ---------------------------------------------------------------- the trigger: launched is not completed
test("triggerLaunched and triggerCompleted: only an exit code of exactly 0 is completion; an unreported exit is launched but never completed", () => {
  assert.equal(S.triggerLaunched(running), true);   assert.equal(S.triggerCompleted(running), false);          // exit code null
  assert.equal(S.triggerLaunched(completed), true); assert.equal(S.triggerCompleted(completed), true);          // exit code 0
  assert.equal(S.triggerLaunched({ ...running, exitCode: 5 }), false);                                          // non-zero exit
  assert.equal(S.triggerLaunched({ ...running, exitCode: 1, exited: true }), false);
  assert.equal(S.triggerLaunched({ ...running, exited: true, exitCode: null, signal: "SIGTERM" }), false);      // killed: no exit code, but it did exit
  assert.equal(S.triggerLaunched({ ...running, error: "ENOENT" }), false);
  assert.equal(S.triggerLaunched({ ...running, pid: null }), false);
  for (const t of [null, undefined]) { assert.equal(S.triggerLaunched(t), false); assert.equal(S.triggerCompleted(t), false); }
  for (const bad of [null, undefined, NaN, "0", false, 0.5, -1, 1, 5, 255]) assert.equal(S.triggerCompleted({ ...running, exitCode: bad }), false, String(bad));
});

// ---------------------------------------------------------------- the verdict
test("PASS only when everything holds, including a completed suspend command and a verified session", () => {
  const r = judge({});
  assert.equal(r.verdict, "PASS"); assert.equal(r.reason, "standby_verified_and_reads_recovered");
  assert.equal(judge({ restarts: 1 }).verdict, "PASS");
  assert.equal(good.trigger.exitCode, 0);                                    // the baseline trigger in this file is a completed one
  const chained = analysis(chain([[2000, 80_000], [80_001, 2_863_000]]), stable(2_863_000));
  assert.equal(judge({ analysis: chained }).verdict, "PASS");
});

test("identifier problems are INCONCLUSIVE with their own reasons, and they beat everything but preflight, a failed trigger and an unreadable log", () => {
  const unavailable = analysis(cyc(2000, 62_000, { v2: null }), 3_600_000), mismatch = analysis(cyc(2000, 62_000, { v2: "99" }), 3_600_000);
  assert.equal(judge({ analysis: unavailable, waitReason: "ids_unavailable" }).reason, "standby_ids_unavailable");
  assert.equal(judge({ analysis: mismatch, waitReason: "ids_mismatch" }).reason, "standby_ids_mismatch");
  for (const w of ["ids_unavailable", "ids_mismatch", "time_limit"]) { assert.equal(judge({ analysis: unavailable, waitReason: w }).verdict, "INCONCLUSIVE"); assert.equal(judge({ analysis: mismatch, waitReason: w }).verdict, "INCONCLUSIVE"); }
  assert.equal(judge({ analysis: unavailable, waitReason: "log_unreadable" }).reason, "system_log_unreadable");
  assert.equal(judge({ analysis: mismatch, trigger: { ...completed, exitCode: 5 } }).reason, "suspend_command_failed");
});

test("null exit code: a verified, signed-in, recovered run with an unreported exit is INCONCLUSIVE suspend_command_not_completed, never PASS", () => {
  const r = judge({ trigger: running });
  assert.equal(r.verdict, "INCONCLUSIVE"); assert.equal(r.reason, "suspend_command_not_completed");
  for (const exitCode of [null, undefined]) assert.notEqual(judge({ trigger: { ...running, exitCode } }).verdict, "PASS");
});

test("exit code 0 passes; a non-zero exit is FAIL suspend_command_failed even when everything else looks perfect", () => {
  assert.equal(judge({ trigger: { ...completed, exitCode: 0 } }).verdict, "PASS");
  for (const exitCode of [1, 5, 255, -1]) {
    const r = judge({ trigger: { ...completed, exitCode } });
    assert.equal(r.verdict, "FAIL", String(exitCode)); assert.equal(r.reason, "suspend_command_failed");
  }
  assert.equal(judge({ trigger: { ...completed, exitCode: null, signal: "SIGKILL" } }).verdict, "FAIL");     // killed
});

test("only exactly 0 can PASS: a table of every other exit code value and trigger state never gives PASS", () => {
  for (const exitCode of [null, undefined, NaN, "0", false, 0.5, -1, 1, 5, 255]) for (const exited of [true, false, undefined]) {
    const r = judge({ trigger: { at: T, pid: 4321, exitCode, signal: null, exited, exitedAt: null, error: null } });
    assert.notEqual(r.verdict, "PASS", `exitCode=${String(exitCode)} exited=${exited}`);
  }
});

test("false-PASS matrix: removing ANY single condition never gives PASS", () => {
  const states = {
    "not verified: pending": analysis([], 10_000),
    "not verified: no entry": analysis([], 100_000),
    "not verified: in standby": analysis([cyc(2000, 3000)[0]], 100_000),
    "not verified: too short": analysis(cyc(1000, 4000), 100_000),
    "not verified: reversed": analysis([ev507(10_000), cyc(20_000, 30_000)[0]], 200_000),
    "not verified: entry outside the window": analysis(cyc(WINDOW + 1, WINDOW + 61_000), 200_000),
    "not verified: chain still open after a long first cycle": analysis([...cyc(2000, 80_000, { id: 20 }), ev506(80_001, { BootId: BOOT, ScenarioInstanceId: "22" })], 3_600_000),
    "not verified: final exit not yet established": analysis(cyc(2000, 62_000), 62_000 + STABLE - 1),
    "not verified: identifiers missing": analysis(cyc(2000, 62_000, { v2: null }), 3_600_000),
    "not verified: identifiers mismatched": analysis(cyc(2000, 62_000, { v2: "99" }), 3_600_000),
    "not verified: time only (no data)": analysis([ev506(2000), ev507(62_000)], 3_600_000),
  };
  const breakers = {
    "preflight failed": { preflight: "system_log_unreadable_before_sleep" },
    "no trigger": { trigger: null },
    "trigger error": { trigger: { ...completed, error: "ENOENT" } },
    "trigger exit 5": { trigger: { ...completed, exitCode: 5 } },
    "trigger without a pid": { trigger: { ...completed, pid: null } },
    "trigger exit not reported": { trigger: running },
    "no analysis": { analysis: null },
    "not signed in": { signedIn: false },
    "sign-in unknown": { signedIn: null },
    "sign-in undefined": { signedIn: undefined },
    "reads not recovered": { recovered: false },
    "recovery not checked": { recovered: null },
    "two helper restarts": { restarts: 2 },
    "restart count unknown": { restarts: undefined },
    ...Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { analysis: v, waitReason: "time_limit" }])),
    ...Object.fromEntries(Object.entries(states).map(([k, v]) => [k + " (even if the wait said verified)", { analysis: v, waitReason: "verified" }])),
  };
  for (const [name, over] of Object.entries(breakers)) {
    const r = judge(over);
    assert.notEqual(r.verdict, "PASS", name);
    assert.ok(["FAIL", "INCONCLUSIVE"].includes(r.verdict), name);
  }
});

test("a failed suspend command is FAIL even when a natural standby shows up in the log", () => {
  for (const trigger of [{ ...completed, error: "ENOENT", pid: null }, { ...completed, exitCode: 5 }, { ...completed, exitCode: 1 }]) {
    const r = judge({ trigger });
    assert.equal(r.verdict, "FAIL"); assert.equal(r.reason, "suspend_command_failed");
  }
});

test("timeout, missing events and an unreadable log are INCONCLUSIVE with an honest reason", () => {
  assert.equal(judge({ analysis: analysis([], 10_000_000), waitReason: "time_limit" }).reason, "standby_entry_not_observed_time_limit");
  assert.equal(judge({ analysis: analysis([cyc(2000, 3000)[0]], 10_000_000), waitReason: "time_limit" }).reason, "standby_exit_not_observed_time_limit");
  assert.equal(judge({ analysis: analysis(cyc(2000, 62_000), 62_000 + 1000), waitReason: "time_limit" }).reason, "standby_exit_not_established_time_limit");
  assert.equal(judge({ analysis: analysis([], 100_000), waitReason: "entry_not_observed" }).reason, "standby_entry_not_observed");
  assert.equal(judge({ analysis: analysis(cyc(WINDOW + 1, WINDOW + 61_000), 200_000), waitReason: "entry_outside_window" }).reason, "standby_entry_outside_window");
  assert.equal(judge({ analysis: analysis(cyc(1000, 4000), 100_000), waitReason: "standby_too_short" }).reason, "standby_too_short");
  assert.equal(judge({ analysis: analysis([], 10_000), waitReason: "log_unreadable" }).reason, "system_log_unreadable");
  for (const w of ["time_limit", "entry_not_observed", "entry_outside_window", "standby_too_short", "log_unreadable"]) assert.equal(judge({ analysis: analysis([], 100_000), waitReason: w }).verdict, "INCONCLUSIVE");
});

test("not signed in after a verified sleep is INCONCLUSIVE (not a product failure), and a recovery failure after sign-in with a completed command is FAIL", () => {
  const r = judge({ signedIn: false, recovered: null, trigger: running });
  assert.equal(r.verdict, "INCONCLUSIVE"); assert.equal(r.reason, "not_signed_in");               // not signed in: the exit wait never happened, so sign-in is the honest reason
  assert.equal(judge({ signedIn: null }).reason, "sign_in_state_unknown");
  assert.equal(judge({ recovered: false }).verdict, "FAIL");
  assert.equal(judge({ restarts: 2 }).reason, "helper_restarted_more_than_once");
  const unsure = judge({ trigger: running, recovered: false });                                    // an uncompleted trigger makes the attribution unproven: no product failure is claimed
  assert.equal(unsure.verdict, "INCONCLUSIVE"); assert.equal(unsure.reason, "suspend_command_not_completed");
});

test("a wall-clock gap and the Enter key are not evidence: the verdict logic does not even read them", () => {
  assert.doesNotMatch(S.judge.toString(), /gap|Gap|enter\b|entered|stdin/i);
  const r = S.judge({ ...good, analysis: analysis([], 100_000), waitReason: "time_limit", maxGapMs: 3_600_000, entered: true, resumedAt: T + 1000 });
  assert.equal(r.verdict, "INCONCLUSIVE");
});

test("preflight failures (log unreadable or desktop check unavailable before the sleep) are INCONCLUSIVE and win over everything", () => {
  for (const p of ["system_log_unreadable_before_sleep", "desktop_not_available_before_sleep", "desktop_check_unavailable"]) {
    const r = judge({ preflight: p, trigger: { at: 0, pid: null, exitCode: null, error: null } });
    assert.equal(r.verdict, "INCONCLUSIVE"); assert.equal(r.reason, p);
  }
});

// ---------------------------------------------------------------- the wait for the standby, with a fake clock
const waitFor = (c, over) => S.waitForStandby({ now: c.now, sleep: c.sleep, trigger: { ...running }, triggerAt: T, startedAt: T, readEvents: () => ({ ok: true, events: [] }), ...over });
/** a log that only shows the events already written by the fake clock's "now" (so a chain appears over several polls) */
const liveLog = (c, all, seen) => () => { const visible = all.filter((e) => e.at <= c.now()); if (seen) seen.push(S.analyzePower(visible, T, c.now()).state); return { ok: true, events: visible }; };

test("wait: a chain is followed across polls: pending after the first 507, in_standby once the linked 506 appears, verified only when the FINAL 507 is established", async () => {
  const c = clock(); const seen = [];
  const all = chain([[1000, 13_000], [13_001, 25_000]], { id: 20 });
  const r = await waitFor(c, { readEvents: liveLog(c, all, seen), capMs: 10_000_000 });
  assert.equal(r.reason, "verified"); assert.equal(r.analysis.cycleCount, 2); assert.equal(r.analysis.exit.at, T + 25_000);
  assert.ok(c.now() - T >= 25_000 + STABLE);
  assert.ok(seen.includes("pending") && seen.includes("in_standby") && seen.at(-1) === "verified", JSON.stringify(seen));
  assert.ok(seen.indexOf("in_standby") > seen.indexOf("pending"));
  assert.ok(!seen.slice(0, -1).includes("verified"), "never verified before the final exit is established");
});

test("wait: an intermediate 507 older than 5 s is NOT enough when its linked 506 is already logged (the open chain runs to the cap)", async () => {
  const c = clock();
  const all = [...cyc(1000, 13_000, { id: 20 }), ev506(13_001, { BootId: BOOT, ScenarioInstanceId: "22" })];
  const r = await waitFor(c, { readEvents: liveLog(c, all), capMs: 120_000 });
  assert.equal(r.reason, "time_limit"); assert.equal(r.analysis.state, "in_standby"); assert.notEqual(r.analysis.state, "verified");
});

test("wait: verified once the log shows the standby, even when the clock jumped far in between (a sleep), and the events are returned as diagnostics", async () => {
  const c = clock(); let polls = 0;
  const evs = cyc(2000, 1_700_000);
  const readEvents = () => {
    polls++;
    if (polls === 3) c.advance(1_800_000 - 20_000);                              // the PC slept: wall clock jumps by about 30 minutes
    return { ok: true, events: polls < 3 ? [] : evs };
  };
  const r = await waitFor(c, { readEvents, capMs: 10_000_000 });
  assert.equal(r.reason, "verified"); assert.equal(r.analysis.state, "verified"); assert.ok(r.maxGapMs > 1_000_000);
  assert.deepEqual(r.events, evs);
});

test("wait: a clock jump with NO log events is not a resume (this is the old false PASS)", async () => {
  const c = clock(); let polls = 0;
  const readEvents = () => { if (++polls === 2) c.advance(600_000); return { ok: true, events: [] }; };
  const r = await waitFor(c, { readEvents, capMs: 10_000_000 });
  assert.notEqual(r.reason, "verified"); assert.equal(r.reason, "entry_not_observed"); assert.ok(r.maxGapMs >= 600_000);
});

test("wait: perfect timestamps without identifiers end at once as ids_unavailable (no waiting for the cap, no timestamp-only pairing); mismatches end as ids_mismatch", async () => {
  const c = clock();
  const r = await waitFor(c, { readEvents: () => ({ ok: true, events: [ev506(2000), ev507(62_000)] }), capMs: 10_000_000 });
  assert.equal(r.reason, "ids_unavailable"); assert.ok(c.now() - T < 10_000);
  const c2 = clock();
  const r2 = await waitFor(c2, { readEvents: () => ({ ok: true, events: cyc(2000, 62_000, { v2: "99" }) }), capMs: 10_000_000 });
  assert.equal(r2.reason, "ids_mismatch"); assert.ok(c2.now() - T < 10_000);
});

test("wait: no entry within 60 s means it did not sleep, and it does not wait for the 30 minute cap", async () => {
  const c = clock(); const r = await waitFor(c, {});
  assert.equal(r.reason, "entry_not_observed"); assert.ok(c.now() - T > 60_000 && c.now() - T < 70_000);
});

test("wait: an entry logged outside the 30 s window ends as entry_outside_window, not verified", async () => {
  const c = clock(); const r = await waitFor(c, { readEvents: () => ({ ok: true, events: cyc(WINDOW + 5000, WINDOW + 65_000) }) });
  assert.equal(r.reason, "entry_outside_window"); assert.notEqual(r.analysis.state, "verified"); assert.ok(c.now() - T < 100_000);
});

test("wait: an entry that never gets an exit runs to the cap and ends as time_limit, not verified", async () => {
  const c = clock(); const r = await waitFor(c, { readEvents: () => ({ ok: true, events: [cyc(2000, 3000)[0]] }), capMs: 120_000 });
  assert.equal(r.reason, "time_limit"); assert.equal(r.analysis.state, "in_standby"); assert.ok(c.now() - T > 120_000);
});

test("wait: a too-short session ends after the grace time", async () => {
  const c = clock(); const r = await waitFor(c, { readEvents: () => ({ ok: true, events: cyc(1000, 4000) }) });
  assert.equal(r.reason, "standby_too_short"); assert.ok(c.now() - T < 60_000);
});

test("wait: a failed suspend command ends it immediately, before any log read", async () => {
  const c = clock(); let reads = 0;
  const r = await waitFor(c, { trigger: { ...running, exitCode: 5 }, readEvents: () => { reads++; return { ok: true, events: [] }; } });
  assert.equal(r.reason, "trigger_failed"); assert.equal(reads, 0); assert.equal(c.now(), T);
});

test("wait: a trigger that fails WHILE waiting (non-zero exit) ends the wait", async () => {
  const c = clock(); const trigger = { ...running };
  const r = await waitFor(c, { trigger, readEvents: () => { if (c.now() - T > 6000) { trigger.exitCode = 5; trigger.exited = true; } return { ok: true, events: [] }; } });
  assert.equal(r.reason, "trigger_failed");
});

test("wait: an unreadable System log gives up after 5 failures in a row, while a transient failure recovers", async () => {
  const c = clock();
  assert.equal((await waitFor(c, { readEvents: () => ({ ok: false }) })).reason, "log_unreadable");
  const c2 = clock(); let n = 0;
  const r = await waitFor(c2, { readEvents: () => (++n <= 4 ? { ok: false } : { ok: true, events: cyc(2000, 62_000) }) });
  assert.equal(r.reason, "verified");
});

// ---------------------------------------------------------------- the sign-in wait
const signIn = (c, over) => S.waitForSignIn({ now: c.now, sleep: c.sleep, since: T, available: () => true, ...over });

test("sign-in wait: signed in at once still lets the desktop settle for 20 s after the standby exit", async () => {
  const c = clock(); const r = await signIn(c, { since: T });
  assert.equal(r.signedIn, true); assert.equal(c.now() - T, C.SETTLE_MS);
});

test("sign-in wait: the settle is counted from the FINAL 507 of a chain, not from an intermediate one", async () => {
  const a = analysis(chain([[2000, 80_000], [80_001, 2_863_000]]), stable(2_863_000));
  const c = clock(); c.advance(a.exit.at - T);                                          // the wake is being processed right at the final 507
  const r = await signIn(c, { since: a.exit.at });
  assert.equal(r.signedIn, true); assert.equal(c.now() - a.exit.at, C.SETTLE_MS);
  const wrong = clock(); wrong.advance(a.exit.at - T);
  await signIn(wrong, { since: T + 80_000 });                                           // what an intermediate 507 would have given
  assert.equal(wrong.now() - a.exit.at, C.SETTLE_MS);                                   // later of (exit, sign-in) still applies, so the settle is never shorter than 20 s
});

test("sign-in wait: settle counts from the later of the exit event and the sign-in; a long-ago exit does not skip it", async () => {
  const c = clock(); let calls = 0;
  const r = await signIn(c, { since: T - 600_000, available: () => ++calls > 5 });         // exit was 10 minutes ago, you sign in after ~10 s
  assert.equal(r.signedIn, true);
  assert.equal(c.now() - r.availableAt, C.SETTLE_MS);
});

test("sign-in wait: never signed in gives signedIn=false after the wait, and a broken check gives unknown", async () => {
  const c = clock(); const r = await signIn(c, { available: () => false });
  assert.equal(r.signedIn, false); assert.ok(c.now() - T >= C.SIGNIN_WAIT_MS && c.now() - T < C.SIGNIN_WAIT_MS + 5000);
  assert.deepEqual(await signIn(clock(), { available: () => { throw new Error("x"); } }), { signedIn: null, availableAt: null });
});

// ---------------------------------------------------------------- the exit wait (after sign-in and the settle)
const exitWait = (c, trigger, over) => S.waitForExit({ trigger, now: c.now, sleep: c.sleep, ...over });

test("exit wait: an exit that is already reported returns at once", async () => {
  const c = clock(); const r = await exitWait(c, { ...completed });
  assert.deepEqual(r, { done: true, waitedMs: 0 }); assert.equal(c.now(), T);
});

test("exit wait: a delayed exit (reported after 12 s) is picked up, and the trigger then counts as completed", async () => {
  const c = clock(); const trigger = { ...running };
  const r = await exitWait(c, trigger, { sleep: async (ms) => { c.advance(ms); if (c.now() - T >= 12_000) { trigger.exited = true; trigger.exitCode = 0; trigger.exitedAt = c.now(); } } });
  assert.equal(r.done, true); assert.ok(r.waitedMs >= 12_000 && r.waitedMs < 13_000);
  assert.equal(S.triggerCompleted(trigger), true);
  assert.equal(judge({ trigger }).verdict, "PASS");
});

test("exit wait: a missing exit gives up after 30 s with done=false, and the verdict is INCONCLUSIVE suspend_command_not_completed", async () => {
  const c = clock(); const trigger = { ...running };
  const r = await exitWait(c, trigger);
  assert.equal(r.done, false); assert.ok(r.waitedMs >= C.EXIT_WAIT_MS && r.waitedMs < C.EXIT_WAIT_MS + 1000);
  const j = judge({ trigger });
  assert.equal(j.verdict, "INCONCLUSIVE"); assert.equal(j.reason, "suspend_command_not_completed");
});

test("exit wait: a non-zero exit during the wait ends it, and the verdict is FAIL", async () => {
  const c = clock(); const trigger = { ...running };
  const r = await exitWait(c, trigger, { sleep: async (ms) => { c.advance(ms); if (c.now() - T >= 3000) { trigger.exited = true; trigger.exitCode = 5; } } });
  assert.equal(r.done, true);
  assert.equal(judge({ trigger }).verdict, "FAIL");
});

test("exit wait: an exit code of null with a signal still ends the wait, and it is never a completion", async () => {
  const c = clock(); const trigger = { ...running, exited: true, exitCode: null, signal: "SIGTERM" };
  assert.equal((await exitWait(c, trigger)).done, true);
  assert.equal(S.triggerCompleted(trigger), false); assert.equal(judge({ trigger }).verdict, "FAIL");
});

// ---------------------------------------------------------------- the suspend command
function fakeSpawn(b) {
  return (cmd, args) => {
    if (b.throws) throw Object.assign(new Error("x"), { code: b.throws });
    const c = new EventEmitter(); c.pid = b.noPid ? undefined : 4321; c.cmd = cmd; c.args = args; fakeSpawn.last = c;
    return c;
  };
}

test("fireSleep records the live launch status and the exit: pid, errors, exit code, signal and when it exited", () => {
  const t = S.fireSleep(fakeSpawn({}));
  assert.equal(t.pid, 4321); assert.equal(t.exitCode, null); assert.equal(t.exited, false); assert.equal(t.exitedAt, null);
  assert.equal(S.triggerLaunched(t), true); assert.equal(S.triggerCompleted(t), false);
  const before = Date.now(); fakeSpawn.last.emit("exit", 0, null);
  assert.equal(t.exitCode, 0); assert.equal(t.exited, true); assert.ok(t.exitedAt >= before);
  assert.equal(S.triggerCompleted(t), true);
  const bad = S.fireSleep(fakeSpawn({})); fakeSpawn.last.emit("exit", 5, null);
  assert.equal(bad.exitCode, 5); assert.equal(S.triggerLaunched(bad), false); assert.equal(S.triggerCompleted(bad), false);
  const killed = S.fireSleep(fakeSpawn({})); fakeSpawn.last.emit("exit", null, "SIGTERM");
  assert.equal(killed.signal, "SIGTERM"); assert.equal(killed.exited, true); assert.equal(S.triggerLaunched(killed), false);
  const err = S.fireSleep(fakeSpawn({})); fakeSpawn.last.emit("error", Object.assign(new Error("x"), { code: "ENOENT" }));
  assert.equal(err.error, "ENOENT"); assert.equal(S.triggerLaunched(err), false);
  assert.equal(S.triggerLaunched(S.fireSleep(fakeSpawn({ throws: "EACCES" }))), false);
  assert.equal(S.triggerLaunched(S.fireSleep(fakeSpawn({ noPid: true }))), false);
});

test("the suspend command is SetSuspendState(Suspend, force=true, disableWake=false) and exits 5 when Windows reports that it did not suspend", () => {
  S.fireSleep(fakeSpawn({}));
  const cmd = fakeSpawn.last.args[fakeSpawn.last.args.length - 1];
  assert.match(cmd, /SetSuspendState\(\[System\.Windows\.Forms\.PowerState\]::Suspend, \$true, \$false\)/);
  assert.doesNotMatch(cmd, /Suspend, \$false/);                                                  // force=false is no longer used
  assert.match(cmd, /if \(-not \$ok\) \{ exit 5 \}/);
  assert.doesNotMatch(cmd, /Hibernate|powercfg|Set-|-Force/i);
});

// ---------------------------------------------------------------- source guards for main(), which starts real things and is never run here
const SRC = fs.readFileSync(path.join(__dirname, "sleep.cjs"), "utf8");
const RUN = SRC.slice(SRC.indexOf("async function main()"));

test("Enter is ignored completely: the run reads no console input after the typed confirmation, and no scenario/gap helper is used", () => {
  assert.equal((RUN.match(/mk\.ask\(|\bask\(|readline|process\.stdin|entered/g) || []).length, 0);
  assert.match(RUN, /mk\.confirmTyped\("SLEEP"/);
  assert.ok(RUN.indexOf("confirmTyped") < RUN.indexOf("mk.bootstrap()"));
  assert.doesNotMatch(SRC, /scenario\.cjs|detectGapMs|resumedAt/);
});

test("nothing is suspended unless the log and the desktop check work first, and there is exactly one suspend call", () => {
  assert.ok(RUN.indexOf("readPowerEvents(Date.now() - EVENT_LOOKBACK_MS)") < RUN.indexOf("fireSleep(spawn)"));
  assert.ok(RUN.indexOf("inputDesktopAvailable()") < RUN.indexOf("fireSleep(spawn)"));
  assert.match(RUN, /if \(preflight\) \{[\s\S]{0,200}NOTHING WAS SUSPENDED[\s\S]*\} else \{[\s\S]*fireSleep\(spawn\)/);
  assert.equal((RUN.match(/fireSleep\(/g) || []).length, 1);
  assert.equal((SRC.match(/::SetSuspendState[(]/g) || []).length, 1);          // the call itself exists exactly once in the whole file: inside fireSleep
  assert.equal((RUN.match(/SetSuspendState/g) || []).length, 0);                // main() never names it
});

test("the sign-in and settle use the FINAL 507, the exit wait comes BEFORE the probes, and the exit and the event diagnostics are recorded", () => {
  assert.match(RUN, /since: w\.analysis\.exit\.at/);                              // analysis.exit is the final 507 of the session
  assert.ok(RUN.indexOf("await waitForSignIn(") < RUN.indexOf("await waitForExit("));
  assert.ok(RUN.indexOf("await waitForExit(") < RUN.indexOf("after.push(await mk.probeOnce"));
  assert.match(RUN, /if \(sign\.signedIn\) \{\s*exitWait = await waitForExit\(\{ trigger: trig,/);
  for (const field of ["exitedAtIso", "exitCode: trig.exitCode", "signal: trig.signal", "exitedAfterCommandMs", "exitMinusStandbyExitMs", "exitReportedWithinWait", "eventDiagnostics", "event187Diagnostics", "reason: e.data && e.data.Reason", "sessionCycles", "linkGapsMs", "cycleDiagnostics", "badCycles", "enterAfterCommandMs", "lateEntries"]) assert.ok(RUN.includes(field), field);
  assert.match(RUN, /judge\(\{ preflight, trigger: trig, analysis: w\.analysis, waitReason: w\.reason, signedIn: sign\.signedIn, recovered:/);
});

test("the constants match the requirements: 30 s entry window, 10 s minimum standby, 5 s final-exit stability, 1000 ms handoff, 20 s settle, 30 s exit wait", () => {
  assert.equal(C.ENTRY_WINDOW_MS, 30_000); assert.equal(C.MIN_STANDBY_MS, 10_000); assert.equal(C.FINAL_STABLE_MS, 5000); assert.equal(C.HANDOFF_MAX_MS, 1000);
  assert.equal(C.SETTLE_MS, 20_000); assert.equal(C.EXIT_WAIT_MS, 30_000);
});

test("the fixture outlives the 30 minute cap with a cleanup margin, via the existing maxSeconds option", () => {
  assert.equal(C.CAP_S, 1800); assert.ok(C.FIXTURE_SECONDS >= C.CAP_S + 300);
  assert.match(RUN, /launchBasic\(ctx, \{ tag: "sleep", maxSeconds: FIXTURE_SECONDS \}\)/);
  const kit = fs.readFileSync(path.join(__dirname, "..", "lib", "kit.cjs"), "utf8");
  assert.match(kit, /launchBasic\(ctx, \{ tag, dup = false, layout = "standard", maxSeconds = MAX_SECONDS \} = \{\}\)/);
});

test("no PASS is possible with an uncompleted trigger: the baseline trigger is completed, the judge asks for completion, and removing the exit code from the baseline stops the PASS", () => {
  assert.equal(good.trigger, completed); assert.equal(good.trigger.exitCode, 0); assert.equal(judge({}).verdict, "PASS");
  assert.match(S.judge.toString(), /triggerCompleted[(]i[.]trigger[)]/);
  assert.equal(S.judge({ ...good, trigger: { ...completed, exitCode: null, exited: false, exitedAt: null } }).verdict, "INCONCLUSIVE");
  assert.notEqual(S.judge({ ...good, trigger: { ...completed, exitCode: undefined, exited: false } }).verdict, "PASS");   // an exit code that is not even null is an unknown state: refused (FAIL), never PASS
  assert.notEqual(S.judge({ ...good, trigger: running }).verdict, "PASS");
});
