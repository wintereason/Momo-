"use strict";
// Shared by the three USER-RUN scripts (tests/real/manual): UAC, session lock, sleep/resume.
// They are never run by `npm run test:real`. Each needs an explicit opt-in flag AND a typed confirmation, because it interrupts your session.
//
// What they do: start one of the suite's own test windows, then PROBE Momo's read-only machinery (window list, UI Automation read, pop-up/secure-window
// list, a window capture, the helper's heartbeat) once a second while the event happens, and report how those calls behaved. They send NO mouse or
// keyboard input at all, they never approve a prompt and never enter credentials. Only counts, states and timings are recorded: no titles, no text, no pixels.
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const P = require("./paths.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** exit 0 with usage for --help; exit 2 with a refusal when the opt-in flag is missing. Nothing is started before this passes. */
function guard({ usage, flag, what }) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(usage); process.exit(0); }
  if (process.platform !== "win32") { console.error("Windows only."); process.exit(2); }
  if (!argv.includes(flag)) {
    console.error(`Refusing to run: this script ${what}.\nIt only runs when you pass ${flag} yourself, and then asks you to type a confirmation.\n\n${usage}`);
    process.exit(2);
  }
  return argv;
}

function ask(question) {
  return new Promise((resolve) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(question, (a) => { rl.close(); resolve(a.trim()); }); });
}

async function confirmTyped(token, warning) {
  console.log("\n" + warning + "\n");
  const a = await ask(`Type ${token} (capital letters) and press Enter to continue, or anything else to cancel: `);
  return a === token;
}

/** the suite's own run id, ledger and runtime for a manual script (no pointer, no planner: probes only) */
function bootstrap() {
  const { Ledger } = require("./ledger.cjs");
  const runId = `momo-real-r${Date.now()}-${process.pid}`;
  const ledger = new Ledger({ runId, runDir: path.join(P.TMP_ROOT, runId), tmpRoot: P.TMP_ROOT });
  Ledger.sweepStale(P.TMP_ROOT);
  ledger.init();
  const rt = require(P.RUNTIME);
  const ctx = { runId, ledger, env: {}, harness: () => ({ rt }) };
  let done = false;
  const cleanup = () => { if (done) return; done = true; try { ledger.sweep(); } catch { /* next run sweeps stale runs */ } };
  process.on("exit", cleanup); process.on("SIGINT", () => { cleanup(); process.exit(130); }); process.on("SIGTERM", () => { cleanup(); process.exit(130); });
  process.on("uncaughtException", (e) => { console.error(e && e.stack || e); cleanup(); process.exit(1); });
  return { rt, ctx, ledger, runId, cleanup };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ ok: false, state: "timeout" }), ms))]);

/** One probe of the read-only machinery. Returns counts, states and timings only. */
async function probeOnce(rt, cap, hwnd) {
  const t0 = Date.now();
  const timed = async (fn) => { const s = Date.now(); let r; try { r = await withTimeout(fn(), 8000); } catch (e) { r = { ok: false, state: "error" }; } return { r, ms: Date.now() - s }; };
  const win = await timed(async () => { const q = await rt.nodeWindows.query(); return { ok: !!q && Array.isArray(q.windows), n: q && q.windows ? q.windows.length : 0 }; });
  const ui = await timed(async () => { const u = await rt.nodeScreen.readUi(hwnd); return { ok: !!u.ok, n: u.ok ? u.items.length : 0 }; });
  const tr = await timed(async () => { const t = await rt.nodeScreen.transients(); const secure = t.ok ? t.windows.filter((w) => w.kind === "secure").length : 0; return { ok: !!t.ok, n: t.ok ? t.windows.length : 0, secure }; });
  const cp = await timed(async () => { const o = await cap.observe(hwnd); return { ok: !!o.ok, state: o.ok ? "ready" : o.state }; });
  const hb = await timed(async () => { const r = await rt.uiaHost.request("ping", 5000); return { ok: !!r }; });
  const rec = {
    at: t0, ms: Date.now() - t0,
    windows: { ok: win.r.ok, ms: win.ms, state: win.r.state || (win.r.ok ? "ok" : "failed") },
    uia: { ok: ui.r.ok, ms: ui.ms, state: ui.r.state || (ui.r.ok ? "ok" : "failed") },
    transients: { ok: tr.r.ok, ms: tr.ms, secure: tr.r.secure || 0, state: tr.r.state || (tr.r.ok ? "ok" : "failed") },
    capture: { ok: cp.r.ok, ms: cp.ms, state: cp.r.state },
    heartbeat: { ok: hb.r.ok, ms: hb.ms },
  };
  rec.allOk = rec.windows.ok && rec.uia.ok && rec.transients.ok && rec.capture.ok && rec.heartbeat.ok;
  return rec;
}

/** facts about a probe series: what failed and how, how long calls took, when things came back */
function summarize(records, { eventAt = null } = {}) {
  const s = { probes: records.length, allOk: records.filter((r) => r.allOk).length, slowestMs: 0, secureSeen: 0, failures: {}, firstOkAfterLastFailureMs: null, lastFailureAt: null };
  for (const r of records) {
    s.slowestMs = Math.max(s.slowestMs, r.ms);
    s.secureSeen += r.transients.secure > 0 ? 1 : 0;
    for (const k of ["windows", "uia", "transients", "capture", "heartbeat"]) if (!r[k].ok) { const key = `${k}:${r[k].state || "failed"}`; s.failures[key] = (s.failures[key] || 0) + 1; }
    if (!r.allOk) s.lastFailureAt = r.at;
  }
  if (s.lastFailureAt) { const ok = records.find((r) => r.allOk && r.at > s.lastFailureAt); if (ok) s.firstOkAfterLastFailureMs = ok.at - s.lastFailureAt; }
  if (eventAt != null && s.lastFailureAt) s.lastFailureSinceEventMs = s.lastFailureAt - eventAt;
  return s;
}

function writeResult(name, runId, data) {
  fs.mkdirSync(P.RESULTS, { recursive: true });
  const file = path.join(P.RESULTS, `manual-${name}-${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ test: name, runId, finishedAt: new Date().toISOString(), note: "counts, states and timings only: no titles, text or pixels", ...data }, null, 2));
  return file;
}

module.exports = { guard, ask, confirmTyped, bootstrap, probeOnce, summarize, writeResult, sleep };
