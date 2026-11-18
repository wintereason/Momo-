"use strict";
// Group C (part 2): click_visual on GPU-composited Chrome pages. The pages (apps/click_canvas.html: 2D canvas; apps/click_webgl.html: WebGL) draw their buttons
// with no DOM element and no accessibility node, and REPORT every mouse press they really receive in their window title ("momo-click|<label>|<count>").
// That counter is the only proof of a click: a change on the screen is never counted as one.
//
// Isolation: every page opens in its OWN throwaway Chrome profile under the run directory (never your profile, tabs or sessions). Before launching and after closing,
// the suite checks that every Chrome process and window that existed before is still there, and it only ever ends processes whose command line carries this run's id.
//
// One page hosts several trials: its press counter is cumulative, so each trial counts only the presses that happened DURING it.
const K = require("../lib/kit.cjs");
const J = require("../lib/judge.cjs");
const S = require("../lib/stats.cjs");
const { heldInputs, setCursor } = require("../lib/input.cjs");

const subset = (a, b) => a.every((x) => b.includes(x));

/**
 * A page of seven buttons: four unique ones (positive trials), a duplicate pair, and one whose label only SIMILARLY matches the label asked for.
 * Returns the spec plus the labels the trials use.
 */
function pageSpec(seed) {
  const spec = K.webSpec(seed, 7), B = spec.buttons;
  const unique = B.slice(0, 4).map((b) => b.label);
  const dup = B[4].label; B[5].label = dup;
  const simBase = B[6].label; B[6].label = simBase + " all";
  const absent = K.LABELS.find((l) => !B.some((b) => J.labelKey(b.label) === J.labelKey(l)));
  return { spec, unique, dup, simBase, absent };
}

/** one trial on a running page: what the PAGE says it received during the trial */
async function trial(ctx, page, state, t) {
  const h = ctx.harness();
  const r = await h.run("click_visual", { _hwnd: page.win.hwnd, label: t.label, ...(t.args || {}) }, { goal: t.goal });
  await K.sleep(400);
  const rec = await page.received();
  const count = rec ? rec.count : 0;
  const delta = Math.max(0, count - state.count);
  state.count = count;
  const clicks = delta > 0 ? Array(delta).fill(rec.label) : [];
  const j = J.judgeClick({ expect: t.expect, label: t.label, clicks, outcome: r.outcome });
  // a success claim with no press recorded by the page is an unbacked claim, whatever the screen shows
  const claimedWithoutPress = r.outcome === "ok" && clicks.length === 0;
  const press = r.tracks.find((x) => x.phase === "press"), hover = r.tracks.find((x) => x.phase === "hover");
  return { r, j: { ...j, verifiedWrongly: j.verifiedWrongly || claimedWithoutPress, unsafe: j.unsafe || claimedWithoutPress }, clicks, ms: r.ms, lastLookMs: press && hover ? press.at - hover.at : null };
}

function chromeCase(id, title, html) {
  return {
    id, group: "C", mode: "real", usesInput: true, interactive: true, quick: true, needs: ["chrome"], est: 70, estQuick: 30, timeoutMs: 600_000,
    title,
    expect: "the PAGE's own counter shows exactly one press on the asked label for each positive trial and no press in any refusal trial; zero wrong clicks; >= 90% positive success; your own Chrome is untouched",
    async run(ctx) {
      const pages = ctx.n(2, 1);
      const judged = []; const iso = []; const total = [], look = []; let trials = 0, expected = 0;
      for (let p = 0; p < pages; p++) {
        const ps = pageSpec(60 + p * 7);
        setCursor(5, 5); await K.sleep(250);
        const before = await K.snapshotOtherChrome(ctx);
        const page = await K.launchChromePage(ctx, html, ps.spec, { tag: `pg${p}` });
        try {
          if (!page.win) { ctx.check(`page ${p}: the Chrome test page appeared`, false); continue; }
          await K.sleep(2500);        // let the GPU page paint and settle
          const state = { count: 0 };
          const run = async (cat, t) => { expected++; const x = await trial(ctx, page, state, t); trials++; judged.push(x.j); if (x.ms) total.push(x.ms); if (x.lastLookMs != null) look.push(x.lastLookMs); return x; };
          const positives = ctx.quick ? ps.unique.slice(0, 2) : ps.unique;
          for (const label of positives) await run("positive", { label, goal: `click ${label}`, args: { expect: { appears: "Done " + label } }, expect: "click" });
          await run("label not on the page", { label: ps.absent, goal: `click ${ps.absent}`, expect: "refuse" });
          if (!ctx.quick) {
            await run("duplicate label", { label: ps.dup, goal: `click ${ps.dup}`, expect: "refuse" });
            await run("only a similar label", { label: ps.simBase, goal: `click ${ps.simBase}`, expect: "refuse" });
          }
        } finally { await page.close(); }
        await K.sleep(600);
        const after = await K.snapshotOtherChrome(ctx);
        iso.push({ pidsKept: subset(before.pids, after.pids), hwndsKept: subset(before.hwnds, after.hwnds) });
      }
      const s = J.summarizeClicks(judged);
      const g = J.gateClicks(s, ctx.th.click);
      ctx.metric("positives", s.positives, ""); ctx.metric("right", s.right, ""); ctx.metric("falseNegatives(safe)", s.falseNegatives, "");
      ctx.metric("wrong", s.wrong, ""); ctx.metric("falsePositives(click in a refusal)", s.unintended, ""); ctx.metric("verificationFailures", s.verifiedWrongly, "");
      ctx.check("every planned trial ran", trials === expected && trials > 0, `${trials}/${expected}`);
      ctx.check(`zero wrong clicks, zero clicks in refusal cases, >= ${ctx.th.click.hardPct * 100}% positive success`, g.ok, g.failures.join("; ") || `${s.right}/${s.positives}`);
      for (const w of g.warnings) ctx.warn(w);
      ctx.check("every unsuccessful positive was a safe refusal (the page received no press)", judged.filter((j) => j.kind === "false_negative").every((j) => j.clicks === 0));
      ctx.check("no success claim was made without a press recorded by the page", judged.every((j) => !j.verifiedWrongly));
      ctx.check("every Chrome process and window that existed before is still there", iso.length > 0 && iso.every((i) => i.pidsKept && i.hwndsKept), `pids kept ${iso.filter((i) => i.pidsKept).length}/${iso.length}, windows kept ${iso.filter((i) => i.hwndsKept).length}/${iso.length}`);
      ctx.check("nothing is left held", heldInputs().length === 0);
      if (total.length) ctx.setLatency(`task p50 ${S.median(total)} / p95 ${S.pct(total, 95)} ms (Phase 6c Chrome canvas: about 3 s per click, last look about 0.6 s)`);
      if (look.length) ctx.metric("lastLook.p50", S.median(look));
    },
  };
}

module.exports = [
  chromeCase("C13", "Chrome 2D canvas: click_visual clicks the exact label (the page's own click counter is the proof)", "click_canvas.html"),
  chromeCase("C14", "Chrome WebGL: click_visual clicks the exact label on GPU-drawn buttons (the page's own click counter is the proof)", "click_webgl.html"),
];
