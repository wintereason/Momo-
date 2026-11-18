"use strict";
// The real Momo runtime, driven for the tests: the real Session, the real UI Automation helper, the real capture, the real pointer.
// Only the PLANNER is scripted (no AI is contacted, nothing leaves this PC), so every run is deterministic. This is the same arrangement the
// Phase 4 to 6 real-Windows evidence used.
const P = require("./paths.cjs");
const { summarizeRun } = require("./diag.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createHarness({ runId = "" } = {}) {
  const rt = require(P.RUNTIME);
  const koffi = require(P.ROOT + "/node_modules/koffi");
  const { createPointer } = require(P.ROOT + "/electron/humanInput.cjs");

  const tracks = [];
  const interrupts = [];
  const pointer = createPointer(koffi, { onTrack: (t) => tracks.push({ ...t, at: Date.now() }), onInterrupt: (r) => interrupts.push(r) });
  const state = { events: [], script: [], seen: [], selfPids: [] };
  const ai = {
    ready: () => true, label: () => "Script", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 9999 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_goal, steps) { state.seen = steps; const d = state.script.shift(); return { ok: true, decision: d || { type: "done", answer: "end" }, source: "Script" }; },
  };
  const session = new rt.Session({
    fs: rt.nodeFs, win: rt.nodeWindows, screen: rt.nodeScreen, input: rt.nodeInput, apps: rt.nodeApps, launch: rt.nodeLaunch, capture: rt.nodeCapture,
    emit: (e) => state.events.push(e), selfPids: () => state.selfPids, ai, cursorLeadMs: () => 0, pointer: () => pointer, changes: rt.uiaHost, act: { openPath: async () => "" },
  });
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });

  /** one diagnostic record per run() call, drained by the runner after each case (see lib/diag.cjs for what is and is not kept) */
  const history = [];
  const lastToolStep = () => [...state.seen].reverse().find((s) => s.kind === "tool") || null;

  /**
   * Run ONE tool call through the real session, as a goal. Consequential calls ask first: `approve` answers (default yes).
   * o.hook(api) runs concurrently once the task has started (cancel, takeover, ...). o.goal is what the user "said".
   */
  async function run(tool, args = {}, o = {}) {
    state.events = []; tracks.length = 0; interrupts.length = 0;
    state.script = [{ type: "tool", tool, args }, { type: "done", answer: "end" }];
    pointer.arm();
    const t0 = Date.now();
    const api = { pointer, tracks, session, sleep };
    const hook = o.hook ? o.hook(api).catch((e) => ({ hookError: String(e && e.message || e) })) : null;
    let asked = null;
    try {
      await session.handleTranscript("real-suite", o.goal || `run ${tool}`);
      for (let g = 0; g < 2; g++) {
        const c = [...state.events].reverse().find((e) => e.type === "task.confirmation_required");
        if (!c || c.__done) break;
        c.__done = true; asked = c;
        await session.respondConfirmation(c.taskId, o.approve !== false);
      }
    } finally {
      const ms = Date.now() - t0;
      if (hook) await hook;
      pointer.disarm();
      run.lastMs = ms;
    }
    await sleep(o.settleMs ?? 250);
    const step = lastToolStep();
    const ev = state.events;
    const out = {
      ms: run.lastMs, step, outcome: step ? step.outcome : "(none)", text: step ? String(step.text || "") : "",
      events: ev, asked, tracks: tracks.slice(), interrupted: pointer.interrupted(), held: pointer.heldCount(),
      clarification: [...ev].reverse().find((e) => e.type === "task.clarification_required") || null,
      completed: ev.some((e) => e.type === "task.completed"), failed: ev.some((e) => e.type === "task.failed"),
      states: ev.filter((e) => e.type === "task.state").map((e) => String(e.message || "")),
      journal: session.orchestrator.journal(),
    };
    try { history.push(summarizeRun({ tool, args, result: out, approve: o.approve, runId })); if (history.length > 200) history.shift(); } catch { /* diagnostics never change a result */ }
    return out;
  }

  return { rt, koffi, pointer, session, state, tracks, interrupts, run, history, drainHistory: () => history.splice(0), sleep, setSelfPids: (p) => { state.selfPids = p; }, cancel: () => session.orchestrator.cancel(), dispose: () => { try { pointer.dispose(); } catch { /* nothing */ } try { session.dispose && session.dispose(); } catch { /* nothing */ } } };
}

module.exports = { createHarness, sleep };
