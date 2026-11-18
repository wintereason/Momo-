"use strict";
// Group B: menus, dialogs, file dialogs (temporary test folder only), frozen and recovering windows, retry when no input was sent.
// Ground truth is each fixture's own record (its window title or state file). These tests use your real mouse and keyboard on the suite's own windows.
const fs = require("fs");
const K = require("../lib/kit.cjs");
const { heldInputs, setCursor } = require("../lib/input.cjs");
const J = require("../lib/judge.cjs");

const waitFor = async (fn, ms = 8000, step = 100) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await K.sleep(step); } };

/** Tools such as answer_dialog and choose_menu_item act on "the one that is open right now". The suite only runs them when EVERY open pop-up belongs to its own fixture. */
async function popupsAreOurs(h, pid, kinds) {
  const t = await h.rt.nodeScreen.transients();
  if (!t.ok) return { ok: false, reason: "could not list pop-up windows" };
  const open = t.windows.filter((w) => kinds.includes(w.kind));
  const foreign = open.filter((w) => w.pid !== pid);
  return { ok: foreign.length === 0, ours: open.length - foreign.length, foreign: foreign.length, reason: foreign.length ? `${foreign.length} pop-up(s) of another application are open; the suite will not act on windows it did not create` : "" };
}
const menuOpen = async (h) => { const t = await h.rt.nodeScreen.transients(); const m = t.ok ? t.windows.filter((w) => w.kind === "popup" || w.kind === "menu") : []; for (const w of m) { const r = await h.rt.nodeScreen.readMenu(w.hwnd); if (r.ok && r.items.some((i) => i.name === "Open")) return true; } return false; };
const dialogOpen = async (h) => { const t = await h.rt.nodeScreen.transients(); return t.ok && t.windows.some((w) => w.kind === "dialog"); };

function addTool(session, name, run, confirm) {
  const tool = { name, signature: name + "({})", description: "test tool", schema: { safeParse: (a) => ({ success: true, data: a }) }, sensitive: false, risk: () => "reversible", describe: () => name, working: () => "...", run, ...(confirm ? { confirm } : {}) };
  session.orchestrator.tools.push(tool);
  return () => { const i = session.orchestrator.tools.indexOf(tool); if (i >= 0) session.orchestrator.tools.splice(i, 1); };
}

const MENU_PATHS = [["Open"], ["Properties"], ["Refresh"], ["More", "Sub one"], ["More", "Sub two"], ["Sort by", "Name"], ["Sort by", "Date"]];

module.exports = [
  {
    id: "B01", group: "B", mode: "real", usesInput: true, interactive: true, est: 40, timeoutMs: 240_000,
    title: "context menu and submenus: choose_menu_item picks exactly the named item",
    expect: "every chosen item is the one asked for (the app's own title records it); zero wrong items; at least 90% chosen",
    async run(ctx) {
      const h = ctx.harness();
      const app = await K.launchTitled(ctx, "menu.ps1", [], "menu1");
      try {
        ctx.check("the menu window appeared", !!app.win);
        const N = ctx.n(7, 3);
        let right = 0, wrong = 0, miss = 0; const ms = [];
        for (let k = 0; k < N; k++) {
          const ok = await waitFor(async () => (await app.title()) === "" && (await menuOpen(h)), 25_000, 250);
          if (!ok) { miss++; ctx.warn(`trial ${k}: the menu never reappeared`); continue; }
          const own = await popupsAreOurs(h, app.win.pid, ["menu", "popup", "dropdown"]);
          if (!own.ok) ctx.skip(own.reason);
          const path = MENU_PATHS[k % MENU_PATHS.length], want = path[path.length - 1];
          const r = await h.run("choose_menu_item", { path }, { goal: "choose " + path.join(" > ") });
          await K.sleep(500);
          const t = await app.title();
          if (t === "-clicked-" + want) { right++; ms.push(r.ms); }
          else if (t.startsWith("-clicked-")) wrong++;
          else miss++;
          await waitFor(async () => (await app.title()) === "", 6000, 300);
        }
        const g = J.gateClicks({ wrong, unintended: 0, verifiedWrongly: 0, positives: N, rate: right / N }, { hardPct: ctx.th.menu.hardPct, targetPct: 0.95 });
        ctx.metric("menu.right", right, "of " + N); ctx.metric("menu.wrong", wrong, ""); ctx.metric("menu.missed", miss, "");
        ctx.check("no wrong item was clicked", wrong === 0, `${wrong} wrong`);
        ctx.check("the success rate meets the hard threshold", g.ok, g.failures.join("; "));
        for (const w of g.warnings) ctx.warn(w);
        if (ms.length) ctx.setLatency(`p50 ${require("../lib/stats.cjs").median(ms)} ms per selection`);
        ctx.check("nothing is left held", heldInputs().length === 0);
      } finally { await app.close(); }
    },
  },
  {
    id: "B02", group: "B", mode: "real", usesInput: true, interactive: true, est: 24, timeoutMs: 180_000,
    title: "message box: answering 'No' (a backing-out answer) needs no approval and the app receives No",
    expect: "the app's own record shows the dialog was answered No, each time",
    async run(ctx) {
      const h = ctx.harness();
      const N = ctx.n(3, 2);
      let right = 0;
      for (let i = 0; i < N; i++) {
        const app = await K.launchTitled(ctx, "dialogs.ps1", ["-Mode", "msg"], "msg" + i);
        try {
          const open = await waitFor(() => dialogOpen(h), 15_000, 250);
          if (!open) { ctx.check(`trial ${i}: the message box opened`, false); continue; }
          await K.sleep(600);
          const own = await popupsAreOurs(h, app.win.pid, ["dialog", "secure"]);
          if (!own.ok) ctx.skip(own.reason);
          await h.run("answer_dialog", { button: "No" }, { goal: "answer No" });
          await K.sleep(600);
          if ((await app.title()) === "-answered-No") right++;
        } finally { await app.close(); }
      }
      ctx.check(`the app received 'No' in every trial`, right === N, `${right}/${N}`);
      ctx.check("nothing is left held", heldInputs().length === 0);
    },
  },
  {
    id: "B03", group: "B", mode: "real", usesInput: true, interactive: true, est: 26, timeoutMs: 120_000,
    title: "message box: answering 'Yes' asks first; declined => nothing answered; approved => Yes",
    expect: "a confirmation card appears; after Decline the dialog is still open and unanswered; after Approve the app records Yes",
    async run(ctx) {
      const h = ctx.harness();
      const app = await K.launchTitled(ctx, "dialogs.ps1", ["-Mode", "msg"], "msgyes");
      try {
        ctx.check("the message box opened", !!(await waitFor(() => dialogOpen(h), 15_000, 250)));
        await K.sleep(600);
        const own = await popupsAreOurs(h, app.win.pid, ["dialog", "secure"]);
        if (!own.ok) ctx.skip(own.reason);
        const declined = await h.run("answer_dialog", { button: "Yes" }, { goal: "answer Yes", approve: false });
        ctx.check("Momo asked for approval first", !!declined.asked);
        await K.sleep(400);
        ctx.check("after Decline the app received no answer", (await app.title()) === "");
        ctx.check("after Decline the dialog is still open", await dialogOpen(h));
        const approved = await h.run("answer_dialog", { button: "Yes" }, { goal: "answer Yes", approve: true });
        ctx.check("Momo asked again", !!approved.asked);
        await K.sleep(800);
        ctx.check("after Approve the app recorded Yes", (await app.title()) === "-answered-Yes", `title suffix "${await app.title()}"`);
        ctx.check("nothing is left held", heldInputs().length === 0);
      } finally { await app.close(); }
    },
  },
  {
    id: "B04", group: "B", mode: "real", usesInput: true, interactive: true, est: 30, timeoutMs: 150_000,
    title: "file dialog in a temporary test folder: choose_file types a name and commits nothing; Cancel is recorded",
    expect: "the dialog shows only the suite's temp folder; choose_file leaves it open and unanswered, the path is not kept in the journal, Cancel is recorded by the app",
    async run(ctx) {
      const h = ctx.harness();
      const dir = ctx.ledger.file("files"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ctx.ledger.file("files", "momo-real-sample.txt"), "test content\n");
      const wanted = ctx.ledger.file("files", "momo-real-not-created.txt");
      const app = await K.launchTitled(ctx, "dialogs.ps1", ["-Mode", "file", "-Dir", dir], "file1");
      try {
        ctx.check("the file dialog opened", !!(await waitFor(() => dialogOpen(h), 20_000, 250)));
        await K.sleep(1500);
        const own = await popupsAreOurs(h, app.win.pid, ["dialog", "secure"]);
        if (!own.ok) ctx.skip(own.reason);
        const rd = await h.run("read_dialog", {}, { goal: "read the dialog" });
        ctx.check("the dialog was read", rd.outcome === "ok", `${rd.outcome}: ${rd.text.slice(0, 80)}`);
        const cf = await h.run("choose_file", { path: wanted }, { goal: "enter the file name" });
        ctx.check("the file name was entered", cf.outcome === "ok" || cf.outcome === "unverified", `${cf.outcome}: ${cf.text.slice(0, 80)}`);
        ctx.check("the dialog is still open (nothing was committed)", await dialogOpen(h));
        ctx.check("the app has not recorded an answer", (await app.title()) === "");
        ctx.check("the file was not created", !fs.existsSync(wanted));
        ctx.check("the path is not kept in the action journal", !/momo-real-not-created/.test(JSON.stringify(h.session.orchestrator.journal())));
        await h.run("answer_dialog", { button: "Cancel" }, { goal: "cancel" });
        await K.sleep(900);
        ctx.check("Cancel was recorded by the app", /^-answered-Cancel-/.test(await app.title()), `title suffix "${await app.title()}"`);
        ctx.check("nothing is left held", heldInputs().length === 0);
      } finally { await app.close(); }
    },
  },
  {
    id: "B05", group: "B", mode: "real", usesInput: false, est: 40, timeoutMs: 150_000,
    title: "a window that stays frozen: recovery waits a bounded time, never reports it verified, never runs the content check on it",
    expect: "the step ends not-verified within the bound; the verify-only content check is never called; the task is not 'completed'",
    async run(ctx) {
      const h = ctx.harness();
      const u = h.koffi.load("user32.dll");
      const IsHung = u.func("bool __stdcall IsHungAppWindow(uintptr_t h)");
      const Post = u.func("bool __stdcall PostMessageW(uintptr_t h, uint32 m, uintptr_t w, intptr_t l)");
      const app = await K.launchTitled(ctx, "frozen.ps1", ["-Secs", "14"], "fz1");
      let remove = () => {};
      try {
        ctx.check("the frozen window exists", !!app.win);
        Post(app.win.hwnd, 0x0201, 1, 0x00500050); Post(app.win.hwnd, 0x0202, 0, 0x00500050);   // input waiting for the frozen window (our own)
        const hung = await waitFor(() => IsHung(app.win.hwnd) || null, 9000, 200);
        ctx.check("Windows reports the window as not responding", !!hung);
        let confirmCalls = 0;
        remove = addTool(h.session, "do_thing", async () => ({ ok: true, brief: "Did it, but could not confirm.", report: "x", verified: false, target: { hwnd: app.win.hwnd, pid: app.win.pid } }), async () => { confirmCalls++; return { verified: true, evidence: [{ kind: "window_state", ok: true }] }; });
        const r = await h.run("do_thing", {}, { goal: "do it" });
        ctx.check("the step is not reported as verified", r.outcome !== "ok", r.outcome);
        ctx.check("the content check was never run on the frozen window", confirmCalls === 0, `calls=${confirmCalls}`);
        ctx.check("the task was not called complete", !r.completed);
        ctx.check("the wait was bounded (under 45 s)", r.ms < 45_000, `${r.ms} ms`);
        ctx.setLatency(r.ms);
      } finally { remove(); await app.close(); }
    },
  },
  {
    id: "B06", group: "B", mode: "real", usesInput: false, est: 25, timeoutMs: 120_000,
    title: "a window that recovers: verify-only recovery runs the content check once and then verifies",
    expect: "the window is seen frozen, then recovers; the content check runs exactly once and the step ends verified",
    async run(ctx) {
      const h = ctx.harness();
      const u = h.koffi.load("user32.dll");
      const IsHung = u.func("bool __stdcall IsHungAppWindow(uintptr_t h)");
      const Post = u.func("bool __stdcall PostMessageW(uintptr_t h, uint32 m, uintptr_t w, intptr_t l)");
      const app = await K.launchTitled(ctx, "frozen.ps1", ["-Secs", "7"], "fz2");
      let remove = () => {};
      try {
        ctx.check("the window exists", !!app.win);
        Post(app.win.hwnd, 0x0201, 1, 0x00500050); Post(app.win.hwnd, 0x0202, 0, 0x00500050);
        const hung = await waitFor(() => IsHung(app.win.hwnd) || null, 9000, 200);
        ctx.check("Windows reports the window as not responding first", !!hung);
        let confirmCalls = 0;
        remove = addTool(h.session, "do_thing", async () => ({ ok: true, brief: "Did it, but could not confirm.", report: "x", verified: false, target: { hwnd: app.win.hwnd, pid: app.win.pid } }), async () => { confirmCalls++; return { verified: true, evidence: [{ kind: "window_state", ok: true }] }; });
        const r = await h.run("do_thing", {}, { goal: "do it" });
        ctx.check("the content check ran exactly once", confirmCalls === 1, `calls=${confirmCalls}`);
        ctx.check("the step ended verified", r.outcome === "ok", r.outcome);
        ctx.setLatency(r.ms);
      } finally { remove(); await app.close(); }
    },
  },
  {
    id: "B07", group: "B", mode: "real", usesInput: true, interactive: true, quick: true, est: 24, timeoutMs: 120_000,
    title: "retry only when no input was sent: the window moves after the look => one refusal, then one correct click (stages: precondition, retry, outcome)",
    expect: "stage 1: a read-only look finds exactly one usable candidate for the label (otherwise SKIP, never PASS); stage 2: Momo says it is looking again; stage 3: exactly one click on the named button, reported verified by the app",
    async run(ctx) {
      const h = ctx.harness();
      // the layout and button of the Phase 6e retry runs (seed 1002, "Bookmark": a long label), drawn a little larger. The test is about RECOVERY, not about reading short words.
      const spec = K.layout(1002, { mode: "movewin" });
      const tb = spec.buttons[2];
      tb.font = 18;
      setCursor(5, 5); await K.sleep(300);   // parked: nothing can hover a button before Momo's own pointer does
      const app = await K.launchDrawn(ctx, spec, { aware: true, tag: "b07" });
      try {
        ctx.check("the test window appeared", !!app.win);
        if (!app.win) return;
        await K.sleep(900);

        // ---- stage 1: the read-only precondition. A look moves no pointer, so the fixture's hover-triggered move cannot happen here.
        const before = app.state() || {};
        const cap = new h.rt.VisualCapture(h.rt.nodeCapture);
        const look = new h.rt.VisualLook(cap, h.rt.nodeCapture);
        const o = await look.look(app.win.hwnd);
        await cap.release();
        const after = app.state() || {};
        const movedBefore = before.left !== after.left || before.top !== after.top;
        const pre = o.ok ? J.judgeRetryPrecondition(o.candidates, tb.label, { movedBefore }) : { met: false, reason: `the read-only look itself was refused (${o.state})` };
        ctx.metric("stage1.preconditionMet", pre.met ? "yes" : "no", "");
        if (!pre.met) ctx.skip(J.classifyRetryTrial({ precondition: pre, retryObserved: false, clicks: [], label: tb.label, outcome: "" }).reason);

        // ---- stages 2 and 3: the real click. Only the clicks recorded DURING this trial count: the log is append-only, so the length before is the baseline.
        const seen = app.clicks().length;
        const r = await h.run("click_visual", { _hwnd: app.win.hwnd, label: tb.label, expect: { appears: "Done " + tb.label } }, { goal: `click ${tb.label}` });
        const clicks = app.clicks().slice(seen);
        const c = J.classifyRetryTrial({ precondition: pre, retryObserved: r.states.some((x) => /trying once more/i.test(x)), clicks, label: tb.label, outcome: r.outcome });
        ctx.metric("stage2.retryObserved", c.stages.retry ? "yes" : "no", "");
        ctx.metric("stage3.outcomeVerified", c.stages.verified ? "yes" : "no", "");
        ctx.check("[stage 2] Momo said it was looking again (the retry happened)", c.stages.retry, `states: ${JSON.stringify(r.states.slice(0, 6))}; final text: ${r.text.slice(0, 90)}`);
        ctx.check("[stage 3] the app received exactly one click, on the named button", clicks.length === 1 && clicks[0] === tb.label, JSON.stringify(clicks));
        ctx.check("[stage 3] the final result is verified", r.outcome === "ok", `${r.outcome}: ${r.text.slice(0, 90)}`);
        ctx.check("nothing is left held", r.held === 0 && heldInputs().length === 0);
      } finally { await app.close(); }
    },
  },
  {
    id: "B08", group: "B", mode: "real", usesInput: false, quick: false, est: 15, timeoutMs: 90_000,
    title: "a transient UI Automation failure before any input: Momo retries, and nothing is typed",
    expect: "the first read is made to fail; at least one further real read happens; the missing field is reported not found; the app's text box stays empty",
    async run(ctx) {
      const h = ctx.harness();
      const app = await K.launchBasic(ctx, { tag: "b08" });
      const real = h.rt.nodeScreen.readUi.bind(h.rt.nodeScreen);
      let n = 0;
      try {
        ctx.check("the test window appeared", !!app.win && !!(await waitFor(() => { const s = app.state(); return s && s.ready; }, 15_000)));
        h.rt.nodeScreen.readUi = async (hw) => (n++ === 0 ? { ok: false, reason: "injected UI Automation failure" } : real(hw));
        const r = await h.run("type_text", { label: "zzz-no-such-field-zzz", text: "x", _hwnd: app.win.hwnd }, { goal: "type x" });
        ctx.check("Momo read the window again after the failure", n >= 2, `reads=${n}`);
        ctx.check("the step failed (no such field), it did not pretend", r.outcome === "failed", `${r.outcome}: ${r.text.slice(0, 90)}`);
        ctx.check("the step says it did not act", !r.step || r.step.acted !== "yes", `acted=${r.step && r.step.acted}`);
        ctx.check("nothing was typed into the app", (app.state().text || "") === "");
      } finally { h.rt.nodeScreen.readUi = real; await app.close(); }
    },
  },
  {
    id: "B09", group: "B", mode: "real", usesInput: false, est: 20, timeoutMs: 90_000,
    title: "cancelling while waiting on a frozen window stops promptly and completes nothing",
    expect: "Cancel ends the wait within 4 s; the task never completes",
    async run(ctx) {
      const h = ctx.harness();
      const u = h.koffi.load("user32.dll");
      const IsHung = u.func("bool __stdcall IsHungAppWindow(uintptr_t h)");
      const Post = u.func("bool __stdcall PostMessageW(uintptr_t h, uint32 m, uintptr_t w, intptr_t l)");
      const app = await K.launchTitled(ctx, "frozen.ps1", ["-Secs", "20"], "fz3");
      let remove = () => {};
      try {
        ctx.check("the frozen window exists", !!app.win);
        Post(app.win.hwnd, 0x0201, 1, 0x00500050); Post(app.win.hwnd, 0x0202, 0, 0x00500050);
        await waitFor(() => IsHung(app.win.hwnd) || null, 9000, 200);
        remove = addTool(h.session, "do_thing", async () => ({ ok: true, brief: "x", report: "x", verified: false, target: { hwnd: app.win.hwnd, pid: app.win.pid } }), async () => ({ verified: true, evidence: [{ kind: "window_state", ok: true }] }));
        const t0 = Date.now(); let cancelledAt = 0;
        const r = await h.run("do_thing", {}, { goal: "do it", hook: async () => { await K.sleep(900); cancelledAt = Date.now(); h.cancel(); } });
        const stopMs = Date.now() - (cancelledAt || t0);
        ctx.check("the run ended soon after Cancel", cancelledAt > 0 && stopMs < 4000, `${stopMs} ms after Cancel`);
        ctx.check("the task never completed", !r.completed);
        ctx.setLatency(stopMs);
      } finally { remove(); await app.close(); }
    },
  },
];
