"use strict";
// Group C (part 1): capture, detection, look_visual and click_visual on the suite's own controlled windows.
// Ground truth for clicks is the TEST APPLICATION'S OWN click log, never Momo's claim. Capture stays in memory; nothing is saved or reported but counts and timings.
const K = require("../lib/kit.cjs");
const DG = require("../lib/diag.cjs");
const J = require("../lib/judge.cjs");
const S = require("../lib/stats.cjs");
const { heldInputs, setCursor } = require("../lib/input.cjs");
const { psq, pidsByCommandLine } = require("../lib/ps.cjs");

const waitFor = async (fn, ms = 8000, step = 100) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await K.sleep(step); } };
const newLook = (h) => { const cap = new h.rt.VisualCapture(h.rt.nodeCapture); return { cap, look: new h.rt.VisualLook(cap, h.rt.nodeCapture) }; };

let seq = 0;
/**
 * One click_visual trial on an ALREADY RUNNING drawn-button window. Only the clicks the app logged DURING this trial count (one window can host several trials).
 * t: { label, goal, args, expect: "click"|"refuse", expectedStatus, hook(api), approve }
 */
async function trialOn(ctx, app, t) {
  const h = ctx.harness();
  const seen = app.clicks().length;
  const r = await h.run("click_visual", { _hwnd: app.win.hwnd, label: t.label, ...(t.args || {}) }, { goal: t.goal, approve: t.approve, hook: t.hook });
  await K.sleep(250);
  const clicks = app.clicks().slice(seen), st = app.state();
  const j = J.judgeClick({ expect: t.expect, label: t.label, clicks, outcome: r.outcome, expectedStatus: t.expectedStatus ?? null, finalStatus: st && st.status });
  const press = r.tracks.find((x) => x.phase === "press"), hover = r.tracks.find((x) => x.phase === "hover");
  return { r, j, clicks, st, ms: r.ms, lastLookMs: press && hover ? press.at - hover.at : null };
}
/** a fresh window for one trial (used where the window itself is part of the test: a hover reaction) */
async function drawnTrial(ctx, t) {
  setCursor(5, 5); await K.sleep(250);            // parked: nothing can hover a button before Momo's own pointer does
  const app = await K.launchDrawn(ctx, t.spec, { aware: !!t.aware, tag: `${t.cat}${++seq}`.replace(/[^a-z0-9]/gi, "") });
  try {
    if (!app.win) return { error: "the test window did not appear" };
    await K.sleep(500);
    return await trialOn(ctx, app, t);
  } finally { await app.close(); }
}
/** launch one window that will host several trials */
async function hostWindow(ctx, spec, aware, tag) {
  setCursor(5, 5); await K.sleep(250);
  const app = await K.launchDrawn(ctx, spec, { aware, tag });
  if (app.win) await K.sleep(500);
  return app;
}
const gate = (ctx, judged, label) => {
  const s = J.summarizeClicks(judged);
  const g = J.gateClicks(s, ctx.th.click);
  ctx.metric(`${label}.positives`, s.positives, ""); ctx.metric(`${label}.right`, s.right, ""); ctx.metric(`${label}.falseNegatives(safe)`, s.falseNegatives, "");
  ctx.metric(`${label}.wrong`, s.wrong, ""); ctx.metric(`${label}.unintended`, s.unintended, ""); ctx.metric(`${label}.verifiedWrongly`, s.verifiedWrongly, "");
  return { s, g };
};

module.exports = [
  {
    id: "C01", group: "C", mode: "real", quick: true, est: 14, estQuick: 10, timeoutMs: 120_000,
    title: "PrintWindow capture: ready frame, no non-ready frame, p95 under 150 ms at 1640x1280",
    expect: "the window is captured ready; every grab is ready; grab p95 < 150 ms (Phase 6a); latency compared with the 6e baseline",
    async run(ctx) {
      const h = ctx.harness();
      const w = await K.launchBlocks(ctx, { mode: "normal", aware: true, tag: "c01" });
      try {
        ctx.check("the test window appeared", !!w.win);
        const cap = new h.rt.VisualCapture(h.rt.nodeCapture);
        const t0 = Date.now(); const o = await cap.observe(w.win.hwnd); const first = Date.now() - t0;
        ctx.check("the first look is ready", o.ok, o.ok ? "" : o.state);
        if (o.ok) ctx.check("the frame is the expected size (1640 x 1280)", o.frame.w === 1640 && o.frame.h === 1280, `${o.frame.w}x${o.frame.h}`);
        ctx.vsBaseline("capture.firstFrame", first);
        const lat = []; let notReady = 0;
        const N = ctx.n(100, 30);
        for (let i = 0; i < N; i++) { const t = Date.now(); const g = await h.rt.nodeCapture.send("capgrab", undefined, 8000); lat.push(Date.now() - t); if (!g || g.state !== "ready") notReady++; await K.sleep(20); }
        const st = S.summarize(lat);
        ctx.metric("grab.p50", st.p50); ctx.metric("grab.p95", st.p95); ctx.metric("grab.max", st.max);
        ctx.check("every grab is a ready frame", notReady === 0, `${notReady}/${N} not ready`);
        ctx.check(`grab p95 is under ${ctx.th.capture.p95Ms} ms`, st.p95 < ctx.th.capture.p95Ms, `${st.p95} ms`);
        ctx.vsBaseline("capture.frame.p50", st.p50); ctx.vsBaseline("capture.frame.p95", st.p95);
        ctx.setLatency(`p50 ${st.p50} / p95 ${st.p95} ms`);
        await cap.release();
      } finally { await w.close(); }
    },
  },
  {
    id: "C02", group: "C", mode: "real", quick: true, est: 30, estQuick: 12, timeoutMs: 240_000,
    title: "blank, black and not-yet-painted windows are refused (0 accepted)",
    expect: "a solid white window is 'blank', a solid black one is 'black', an unpainted one is refused; no such frame is ever accepted",
    async run(ctx) {
      const h = ctx.harness();
      const N = ctx.n(100, 10);
      let accepted = 0, wrongState = 0;
      for (const [mode, want] of [["white", "blank"], ["black", "black"]]) {
        const w = await K.launchForms(ctx, { mode, tag: "c02" + mode });
        try {
          ctx.check(`the ${mode} window appeared`, !!w.win);
          const cap = new h.rt.VisualCapture(h.rt.nodeCapture);
          for (let i = 0; i < N / 2; i++) {
            const o = await cap.observe(w.win.hwnd);
            if (o.ok) accepted++; else if (o.state !== want) wrongState++;
          }
          await cap.release();
        } finally { await w.close(); }
      }
      ctx.metric("blankOrBlackTrials", N, ""); ctx.metric("accepted", accepted, "");
      ctx.check(`no blank or black frame was accepted in ${N} trials`, accepted === ctx.th.capture.blankAccepted, `${accepted} accepted`);
      ctx.check("each refusal named the right reason", wrongState === 0, `${wrongState} with another reason`);
      // not yet painted: solid white for 1.5 s, content only after
      const late = await K.launchForms(ctx, { mode: "late", tag: "c02late" });
      try {
        ctx.check("the late-painting window appeared", !!late.win);
        const cap = new h.rt.VisualCapture(h.rt.nodeCapture);
        const wins = await h.rt.nodeWindows.query();
        const painted = wins.windows.some((x) => x.hwnd === late.win.hwnd && / PAINTED$/.test(x.title));
        const o = await cap.observe(late.win.hwnd);
        if (!painted) ctx.check("a window that has not painted yet is refused", !o.ok, o.ok ? "accepted an unpainted window" : "");
        else ctx.warn("the late window had already painted when it was first looked at; the unpainted refusal could not be exercised in this run");
        await cap.release();
        await waitFor(async () => (await h.rt.nodeWindows.query()).windows.some((x) => x.hwnd === late.win.hwnd && / PAINTED$/.test(x.title)), 8000, 200);
        const cap2 = new h.rt.VisualCapture(h.rt.nodeCapture);
        const o2 = await cap2.observe(late.win.hwnd);
        ctx.check("once painted, the window is captured ready", o2.ok, o2.ok ? "" : o2.state);
        await cap2.release();
      } finally { await late.close(); }
    },
  },
  {
    id: "C03", group: "C", mode: "real", est: 12, timeoutMs: 90_000,
    title: "a window that never settles (changing every 30 ms) is refused, never read",
    expect: "capture is refused as changing / not ready, and no frame is accepted",
    async run(ctx) {
      const h = ctx.harness();
      const w = await K.launchBlocks(ctx, { mode: "animate", aware: true, tag: "c03" });
      try {
        ctx.check("the animated window appeared", !!w.win);
        let accepted = 0; const states = new Set();
        for (let i = 0; i < ctx.n(5, 3); i++) { const cap = new h.rt.VisualCapture(h.rt.nodeCapture); const o = await cap.observe(w.win.hwnd); if (o.ok) accepted++; else states.add(o.state); await cap.release(); }
        ctx.check("no frame of a constantly changing window was accepted", accepted === 0, `${accepted} accepted`);
        ctx.check("it was refused as changing or not ready", [...states].every((s) => s === "changing" || s === "not_ready"), [...states].join(","));
      } finally { await w.close(); }
    },
  },
  {
    id: "C04", group: "C", mode: "real", quick: true, est: 40, estQuick: 22, timeoutMs: 240_000,
    title: "busy window: 'busy' within the 1.5 s bound, no helper restart, no stale frame, capture resumes",
    expect: "a stalled window is refused 'busy' within bound + slack; later requests are refused fast; the helper keeps running; capture works again once the window answers",
    async run(ctx) {
      const h = ctx.harness();
      const bound = ctx.th.busy.boundMs, slack = ctx.th.busy.slackMs;
      for (const stall of ctx.n([3000, 8000], [3000])) {
        const w = await K.launchBlocks(ctx, { mode: "busy", aware: true, tag: "c04s" + stall, blockMs: stall });
        try {
          ctx.check(`[${stall} ms stall] the test window appeared`, !!w.win);
          const cap = new h.rt.VisualCapture(h.rt.nodeCapture);
          const pre = await cap.observe(w.win.hwnd);
          ctx.check(`[${stall} ms stall] it was capturable before the stall`, pre.ok, pre.ok ? "" : pre.state);
          const startsBefore = h.rt.uiaHost.stats().starts;
          const began = await waitFor(() => w.mark() === "start" || null, 20_000, 10);
          ctx.check(`[${stall} ms stall] the window began to stall`, !!began);
          await K.sleep(150);
          const attempts = [];
          const t1 = Date.now();
          while (w.mark() !== "end" && Date.now() - t1 < stall + 6000) { const t = Date.now(); const o = await cap.observe(w.win.hwnd); attempts.push({ ms: Date.now() - t, state: o.ok ? "frame" : o.state }); }
          const first = attempts[0];
          ctx.check(`[${stall} ms stall] the first request was refused 'busy'`, first && first.state === "busy", first ? first.state : "none");
          ctx.check(`[${stall} ms stall] the first refusal came within ${bound} ms + ${slack} ms`, first && first.ms <= bound + slack, first ? `${first.ms} ms` : "");
          ctx.check(`[${stall} ms stall] no frame was accepted during the stall`, attempts.every((a) => a.state !== "frame"));
          ctx.check(`[${stall} ms stall] later requests were refused fast (no worker piled on)`, attempts.slice(1).every((a) => a.ms < 400), `max ${Math.max(0, ...attempts.slice(1).map((a) => a.ms))} ms`);
          ctx.check(`[${stall} ms stall] the helper was not restarted`, h.rt.uiaHost.stats().starts === startsBefore, `starts ${startsBefore} -> ${h.rt.uiaHost.stats().starts}`);
          await waitFor(() => w.mark() === "end" || null, stall + 6000, 50); await K.sleep(300);
          const t2 = Date.now(); const after = await cap.observe(w.win.hwnd);
          ctx.check(`[${stall} ms stall] capture resumed after the window answered`, after.ok, after.ok ? "" : after.state);
          ctx.check(`[${stall} ms stall] the helper still answers`, !!(await h.rt.uiaHost.request("ping", 5000).catch(() => null)));
          if (stall === 3000 && first) ctx.vsBaseline("busy.refusal", first.ms);
          ctx.metric(`resume.${stall}`, Date.now() - t2);
          await cap.release();
        } finally { await w.close(); }
      }
    },
  },
  {
    id: "C05", group: "C", mode: "real", est: 16, timeoutMs: 90_000,
    title: "minimized and closed windows are refused; a restored window is captured again",
    expect: "minimized => 'minimized'; after restore => ready; after the window closes => 'gone'",
    async run(ctx) {
      const h = ctx.harness();
      const w = await K.launchBlocks(ctx, { mode: "normal", aware: true, tag: "c05" });
      try {
        ctx.check("the test window appeared", !!w.win);
        const cap = new h.rt.VisualCapture(h.rt.nodeCapture);
        ctx.check("captured ready first", (await cap.observe(w.win.hwnd)).ok);
        await h.rt.nodeInput.minimizeWindow(w.win.hwnd); await K.sleep(900);
        const m = await cap.observe(w.win.hwnd);
        ctx.check("a minimized window is refused as minimized", !m.ok && m.state === "minimized", m.ok ? "accepted" : m.state);
        await h.rt.nodeInput.focusWindow(w.win.hwnd).catch(() => undefined); await K.sleep(1200);
        const back = await cap.observe(w.win.hwnd);
        ctx.check("the restored window is captured ready again", back.ok, back.ok ? "" : back.state);
        await h.rt.nodeInput.closeWindow(w.win.hwnd).catch(() => undefined); await K.sleep(1200);
        const gone = await cap.observe(w.win.hwnd);
        ctx.check("a closed window is refused as gone", !gone.ok && gone.state === "gone", gone.ok ? "accepted" : gone.state);
        await cap.release();
      } finally { await w.close(); }
    },
  },
  {
    id: "C06", group: "C", mode: "real", est: 35, timeoutMs: 300_000, quick: false,
    title: "visual detection on seeded layouts: end-to-end label accuracy at least 95%",
    expect: "for each seeded layout, each real button has exactly one usable candidate carrying its label; accuracy >= 95%; spurious usable candidates are counted",
    async run(ctx) {
      const h = ctx.harness();
      const seeds = Array.from({ length: ctx.n(5, 3) }, (_, i) => 9100 + i);
      let buttons = 0, found = 0, missed = 0, spurious = 0, usable = 0; const lat = [];
      for (const seed of seeds) {
        const spec = K.layout(seed, { n: 5 });
        const aware = seed % 2 === 1;
        const app = await K.launchDrawn(ctx, spec, { aware, tag: "c06s" + seed });
        try {
          if (!app.win) { ctx.check(`layout ${seed}: the window appeared`, false); continue; }
          await K.sleep(400);
          const { cap, look } = newLook(h);
          const t0 = Date.now(); const o = await look.look(app.win.hwnd); lat.push(Date.now() - t0);
          if (!o.ok) { ctx.check(`layout ${seed}: the look succeeded`, false, o.state); await cap.release(); continue; }
          const d = J.judgeDetection(spec.buttons, o.candidates);
          buttons += d.buttons; found += d.found; missed += d.missed; spurious += d.spurious; usable += d.usable;
          await cap.release();
        } finally { await app.close(); }
      }
      const e2e = buttons ? found / buttons : 0, precision = usable ? (usable - spurious) / usable : 1;
      ctx.metric("detection.e2e", Math.round(e2e * 1000) / 10, "%"); ctx.metric("detection.precision", Math.round(precision * 1000) / 10, "%"); ctx.metric("detection.missed", missed, ""); ctx.metric("detection.spurious", spurious, "");
      ctx.check(`end-to-end label accuracy is at least ${ctx.th.detection.e2ePct * 100}%`, e2e >= ctx.th.detection.e2ePct, `${found}/${buttons} (${(e2e * 100).toFixed(1)}%)`);
      if (spurious > 0) ctx.warn(`${spurious} usable candidate(s) carried a label that is not a real button`);
      ctx.setLatency(`look p50 ${S.median(lat)} ms`);
    },
  },
  {
    id: "C07", group: "C", mode: "real", usesInput: true, interactive: true, est: 14, timeoutMs: 90_000,
    title: "look_visual is read-only: it reports candidates, moves no pointer and the app receives no input",
    expect: "look_visual succeeds and lists labels; the pointer never moves; the app's own log has no press, release or click",
    async run(ctx) {
      const h = ctx.harness();
      const spec = K.layout(9200, { n: 5 });
      const app = await K.launchDrawn(ctx, spec, { aware: true, tag: "c07" });
      try {
        ctx.check("the test window appeared", !!app.win);
        await K.sleep(500);
        const r = await h.run("look_visual", { _hwnd: app.win.hwnd }, { goal: "what does this window look like" });
        ctx.check("the look succeeded", r.outcome === "ok", `${r.outcome}: ${r.text.slice(0, 90)}`);
        ctx.check("it lists at least one of the real labels", spec.buttons.some((b) => J.labelKey(r.text).includes(J.labelKey(b.label))));
        ctx.check("the pointer never moved", r.tracks.length === 0, `${r.tracks.length} track events`);
        ctx.check("the app received no press, release or click", app.events().filter((e) => ["down", "up", "click", "click-real", "miss"].includes(e.ev)).length === 0);
        ctx.check("nothing is held", r.held === 0 && heldInputs().length === 0);
        const ms = []; const { cap, look } = newLook(h);
        // an UNTIMED warm-up look first: the first look on a new capture session pays for starting the session, which is not what a steady-state look costs
        // (the Phase 6e baseline excluded it too). Only the looks after it are timed.
        await look.look(app.win.hwnd);
        const SAMPLES = 20;   // at least 20 timed looks: with fewer, the p95 of the sample IS its maximum
        for (let i = 0; i < SAMPLES; i++) { const t = Date.now(); const o = await look.look(app.win.hwnd); if (o.ok) ms.push(Date.now() - t); }
        ctx.check(`at least ${SAMPLES} timed samples were collected after the warm-up (the p95 is computed from these only)`, ms.length >= SAMPLES, `${ms.length}`);
        ctx.diag("C07 look timings (ms)", { warmUpExcluded: true, n: ms.length, samples: ms });
        ctx.vsBaseline("look.p50", S.median(ms)); ctx.vsBaseline("look.p95", S.pct(ms, 95));
        ctx.setLatency(`look p50 ${S.median(ms)} / p95 ${S.pct(ms, 95)} ms`);
        await cap.release();
      } finally { await app.close(); }
    },
  },
  {
    id: "C08", group: "C", mode: "real", usesInput: true, interactive: true, quick: true, est: 85, estQuick: 35, timeoutMs: 600_000,
    title: "click_visual positives: exact label, right button, effect verified by the app (>= 90% hard, 95% target)",
    expect: "zero wrong clicks; at least 90% of positive trials click exactly the asked button once; every miss is a safe refusal; verified claims are backed by the app's state",
    async run(ctx) {
      const windows = ctx.n(3, 1);          // each window hosts five trials: every one of its buttons is clicked once
      const judged = []; const total = [], look = [];
      for (let w = 0; w < windows; w++) {
        const spec = K.layout(100 + w, { n: 5 });
        const app = await hostWindow(ctx, spec, w % 2 === 1, "c08w" + w);
        try {
          if (!app.win) { ctx.check(`window ${w}: the test window appeared`, false); continue; }
          for (const tb of spec.buttons) {
            const t = await trialOn(ctx, app, { label: tb.label, goal: `click ${tb.label}`, args: { expect: { appears: "Done " + tb.label } }, expect: "click", expectedStatus: "Done " + tb.label });
            judged.push(t.j); total.push(t.ms); if (t.lastLookMs != null) look.push(t.lastLookMs);
            // one record per trial: our fixture's label, what happened, and (for a miss) the tool's fixed refusal sentence
            ctx.diag("C08 trial", { window: w, aware: w % 2 === 1, label: tb.label, expectedTarget: tb.label, expect: "click", labelLetters: tb.label.length, result: t.j.kind, outcome: t.r.outcome, clicks: t.clicks.length, reason: t.j.kind === "right" ? null : t.r.text, ms: t.ms }, { allowed: [tb.label] });
          }
        } finally { await app.close(); }
      }
      const { s, g } = gate(ctx, judged, "click");
      ctx.diag("C08 sample-size analysis against the 95% target", g.analysis);
      ctx.metric("click.targetMissesTolerated", g.analysis.tolerableMisses, "");
      ctx.check(`zero wrong clicks, zero unbacked success claims, >= ${ctx.th.click.hardPct * 100}% positive success`, g.ok, g.failures.join("; ") || `${s.right}/${s.positives}`);
      for (const w of g.warnings) ctx.warn(w);
      ctx.check("every unsuccessful positive was a safe refusal (no click)", judged.filter((j) => j.kind !== "right").every((j) => j.clicks === 0));
      ctx.check("nothing is left held", heldInputs().length === 0);
      ctx.vsBaseline("click.total.p50", S.median(total)); ctx.vsBaseline("click.total.p95", S.pct(total, 95));
      ctx.vsBaseline("click.lastLook.p50", S.median(look)); ctx.vsBaseline("click.lastLook.p95", S.pct(look, 95));
      ctx.setLatency(`task p50 ${S.median(total)} / p95 ${S.pct(total, 95)} ms; last look p50 ${S.median(look)} ms`);
    },
  },
  {
    id: "C09", group: "C", mode: "real", usesInput: true, interactive: true, quick: true, est: 85, estQuick: 22, timeoutMs: 600_000,
    title: "click_visual refusals: duplicate, absent, similar, UIA-listed, not named, clipped, declined, and last-look changes => no click (--quick: duplicate and absent)",
    expect: "in every refusal case the app received no click at all",
    async run(ctx) {
      const judged = []; const byCat = {};
      const record = (cat, t) => { if (t.error) { ctx.check(`${cat}: ${t.error}`, false); return t; } judged.push(t.j); (byCat[cat] = byCat[cat] || []).push(t.j.clicks); return t; };
      // one window hosts the refusal cases that need no special window: duplicate, absent, similar, UIA-listed, not named, declined, approved, then clipped
      const spec = K.layout(500, { n: 8 }); const B = spec.buttons;
      const dup = B[0].label; B[1].label = dup; B[1].effect = { status: "Done " + dup };
      const simBase = B[2].label; B[2].label = simBase + " now";
      const real = B[3]; real.real = true;
      const plain = B[4];
      B[5].label = "Delete"; B[5].effect = { status: "Done Delete" };
      const absent = K.LABELS.find((l) => !B.some((b) => J.labelKey(b.label) === J.labelKey(l)));
      const app = await hostWindow(ctx, spec, true, "c09w");
      try {
        if (!app.win) { ctx.check("the test window appeared", false); return; }
        const on = (t) => trialOn(ctx, app, t);
        record("duplicate label", await on({ label: dup, goal: `click ${dup}`, expect: "refuse" }));
        record("label not on screen", await on({ label: absent, goal: `click ${absent}`, expect: "refuse" }));
        if (!ctx.quick) {
          record("only a similar label", await on({ label: simBase, goal: `click ${simBase}`, expect: "refuse" }));
          record("listed by UI Automation", await on({ label: real.label, goal: `click ${real.label}`, expect: "refuse" }));
          record("label not named by the user", await on({ label: plain.label, goal: "please tidy things up", expect: "refuse" }));
          record("consequential, approval declined", await on({ label: "Delete", goal: "click Delete", approve: false, expect: "refuse" }));
          const ok = await on({ label: "Delete", goal: "click Delete", approve: true, args: { expect: { appears: "Done Delete" } }, expect: "click", expectedStatus: "Done Delete" });
          ctx.check("an approved consequential click lands on the right button once", ok.j.kind === "right", JSON.stringify(ok.clicks));
          ctx.check("and its success claim is backed by the app", !ok.j.verifiedWrongly);
          K.moveWindow(app.win.hwnd, 400, (ctx.env.physicalHeight || 1800) - 300); await K.sleep(700);
          record("window partly off the screen", await on({ label: plain.label, goal: `click ${plain.label}`, expect: "refuse" }));
        }
      } finally { await app.close(); }
      if (!ctx.quick) {
        // the button changes after the pointer hovers it: the last look must catch it
        for (const mode of ["evasive", "vanish", "relabel", "decoy"]) {
          const sp = K.layout(1000, { mode }), tb = sp.buttons[1];
          record("last look: " + mode, await drawnTrial(ctx, { cat: "inj" + mode, spec: sp, aware: true, label: tb.label, goal: `click ${tb.label}`, args: { expect: { appears: "Done " + tb.label } }, expect: "refuse" }));
        }
      }
      const s = J.summarizeClicks(judged);
      for (const [cat, arr] of Object.entries(byCat)) ctx.check(`${cat}: no click delivered`, arr.every((n) => n === 0), `${arr.reduce((a, b) => a + b, 0)} click(s) in ${arr.length} trial(s)`);
      ctx.metric("refusal.trials", s.refusals, ""); ctx.metric("refusal.unintended", s.unintended, "");
      ctx.check("zero clicks in all refusal cases", s.unintended === 0, `${s.unintended} unintended`);
      ctx.check("nothing is left held", heldInputs().length === 0);
    },
  },
  {
    id: "C10", group: "C", mode: "real", usesInput: true, interactive: true, est: 25, timeoutMs: 200_000, quick: false,
    title: "effect verification: no named effect or a wrong one => clicked but 'unverified'; the right effect => verified",
    expect: "without a named effect, or with one that does not happen, the click is reported unconfirmed (never 'ok'); a named disappearance that happens is verified; exactly one click each time",
    async run(ctx) {
      const spec = K.layout(200, { n: 6 }); const B = spec.buttons;
      B[2].effect = { hide: B[3].label };
      const app = await hostWindow(ctx, spec, true, "c10w");
      try {
        if (!app.win) { ctx.check("the test window appeared", false); return; }
        const a = await trialOn(ctx, app, { label: B[0].label, goal: `click ${B[0].label}`, expect: "click", expectedStatus: null });
        ctx.check("no effect named: the right button was clicked once", a.j.kind === "right", JSON.stringify(a.clicks));
        ctx.check("no effect named: it is NOT reported as verified", a.r.outcome === "unverified", a.r.outcome);
        const b = await trialOn(ctx, app, { label: B[1].label, goal: `click ${B[1].label}`, args: { expect: { appears: "Never happens" } }, expect: "click", expectedStatus: null });
        ctx.check("a wrong effect named: one click, on the right button", b.j.kind === "right", JSON.stringify(b.clicks));
        ctx.check("a wrong effect named: it is NOT reported as verified", b.r.outcome === "unverified", b.r.outcome);
        const c = await trialOn(ctx, app, { label: B[2].label, goal: `click ${B[2].label}`, args: { expect: { disappears: B[3].label } }, expect: "click", expectedStatus: null });
        const hidden = c.st && Array.isArray(c.st.buttons) && c.st.buttons.some((x) => x.label === B[3].label && x.hidden);
        ctx.check("a named disappearance: the app really hid it", !!hidden);
        ctx.check("a named disappearance: verified, one click on the right button", c.j.kind === "right" && c.r.outcome === "ok", `${c.r.outcome} ${JSON.stringify(c.clicks)}`);
        ctx.check("nothing is left held", heldInputs().length === 0);
      } finally { await app.close(); }
    },
  },
  {
    id: "C11", group: "C", mode: "real", quick: false, est: 45, timeoutMs: 240_000,
    title: "resources: the capture helper does not leak handles over many frames and many sessions",
    expect: "helper handle count grows by at most 20 over the frames and the start/release cycles; capture is inactive afterwards",
    async run(ctx) {
      const h = ctx.harness();
      // only the helper that is a CHILD of this runner: another running Momo (the installed app) has a helper with the same script path, and must never be measured or touched
      const helper = () => { const f = pidsByCommandLine("momo-helper").filter((p) => p.ppid === process.pid); return f.length ? f[0].pid : 0; };
      const handles = (pid) => Number(psq(`(Get-Process -Id ${pid}).HandleCount`));
      await h.rt.uiaHost.request("ping", 30000).catch(() => undefined);
      const pid = helper();
      ctx.check("the UI Automation helper process was found", pid > 0);
      if (!pid) return;
      const w = await K.launchBlocks(ctx, { mode: "normal", aware: true, tag: "c11" });
      try {
        const cap = new h.rt.VisualCapture(h.rt.nodeCapture);
        ctx.check("the window is captured ready", (await cap.observe(w.win.hwnd)).ok);
        const h0 = handles(pid);
        for (let i = 0; i < ctx.n(300, 100); i++) await h.rt.nodeCapture.send("capgrab", undefined, 8000);
        await cap.release();
        for (let i = 0; i < ctx.n(25, 8); i++) { const k = new h.rt.VisualCapture(h.rt.nodeCapture); await k.observe(w.win.hwnd); await k.release(); }
        await K.sleep(800);
        const h1 = handles(pid);
        ctx.metric("handles.before", h0, ""); ctx.metric("handles.after", h1, "");
        ctx.check(`handle growth is at most ${ctx.th.handles.growth}`, h1 - h0 <= ctx.th.handles.growth, `${h0} -> ${h1}`);
        const info = await h.rt.nodeCapture.send("capinfo", undefined, 5000);
        ctx.check("no capture session is left active", info && info.active === false);
      } finally { await w.close(); }
    },
  },
  {
    id: "C12", group: "C", mode: "real", est: 28, timeoutMs: 120_000, quick: false,
    title: "idle release: an unused capture is released after about 20 s",
    expect: "the capture session is released 20 s (+/- 2 s) after the last use; the look's candidates are wiped with it",
    async run(ctx) {
      const h = ctx.harness();
      const w = await K.launchBlocks(ctx, { mode: "normal", aware: true, tag: "c12" });
      try {
        const { cap, look } = newLook(h);
        const o = await look.look(w.win.hwnd);
        ctx.check("a look succeeded and holds candidates", o.ok && look.stats().holding);
        const active = async () => (await h.rt.nodeCapture.send("capinfo", undefined, 5000)).active;
        const t0 = Date.now();
        while ((await active()) && Date.now() - t0 < 40_000) await K.sleep(500);
        const ms = Date.now() - t0;
        ctx.metric("idle.releaseMs", ms);
        ctx.check(`released after ${ctx.th.idle.releaseMs} ms +/- ${ctx.th.idle.toleranceMs} ms`, Math.abs(ms - ctx.th.idle.releaseMs) <= ctx.th.idle.toleranceMs, `${ms} ms`);
        ctx.check("the look no longer holds candidates", !look.stats().holding);
        await cap.release();
      } finally { await w.close(); }
    },
  },
];
