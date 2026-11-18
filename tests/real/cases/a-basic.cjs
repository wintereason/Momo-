"use strict";
// Group A: basic desktop interaction on a controlled WPF window (apps/basic.ps1) that records, in its own state file, what it REALLY received.
// Every verdict compares Momo's claim with that record. These tests use your real mouse and keyboard (only on the suite's own window).
const fs = require("fs");
const K = require("../lib/kit.cjs");
const D = require("../lib/diag.cjs");
const { isAlive } = require("../lib/ps.cjs");
const { heldInputs, setCursor, windowPlacement, desktopWindow } = require("../lib/input.cjs");

const waitFor = async (fn, ms = 8000, step = 100) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await K.sleep(step); } };
const ready = (app) => waitFor(() => { const s = app.state(); return s && s.ready ? s : null; }, 15_000);
const moveSeen = (api) => waitFor(() => api.tracks.some((t) => t.phase === "move") || null, 8000, 5);

async function withBasic(ctx, tag, opts, fn) {
  const app = await K.launchBasic(ctx, { tag, ...opts });
  try {
    if (!app.win) { ctx.check("the test window appeared", false); return; }
    if (!(await ready(app))) { ctx.check("the test window reported ready", false); return; }
    await fn(app, ctx.harness());
  } finally { await app.close(); }
}

module.exports = [
  {
    id: "A01", group: "A", mode: "real", est: 8,
    title: "UI Automation lists the controlled window's controls (names, enabled state)",
    expect: "read_ui returns the buttons, the search box, the check box and the list, with the disabled button reported disabled",
    async run(ctx) {
      await withBasic(ctx, "a01", {}, async (app, h) => {
        const r = await h.rt.nodeScreen.readUi(app.win.hwnd);
        ctx.check("the read succeeded", r.ok);
        const items = r.ok ? r.items : [];
        const by = (n) => items.find((i) => i.name === n);
        ctx.check("'Click me' is listed", !!by("Click me"));
        ctx.check("'Delete everything' is listed", !!by("Delete everything"));
        ctx.check("'Search box' is listed", !!by("Search box"));
        ctx.check("'Enable thing' is listed", !!by("Enable thing"));
        ctx.check("the list is listed", !!by("Files"));
        ctx.check("'Locked' is reported disabled", by("Locked") && by("Locked").enabled === false);
        ctx.check("'Click me' is reported enabled", by("Click me") && by("Click me").enabled === true);
        ctx.vsBaseline("uia.read.p50", await (async () => { const t = Date.now(); await h.rt.nodeScreen.readUi(app.win.hwnd); return Date.now() - t; })());
      });
    },
  },
  {
    id: "A02", group: "A", mode: "real", usesInput: true, interactive: true, quick: true, est: 12,
    title: "click_control clicks the named button once, and the app confirms it",
    expect: "exactly one click on 'Click me' (by the app's own counter), none on 'Delete everything', the step is verified, nothing is left held",
    async run(ctx) {
      await withBasic(ctx, "a02", {}, async (app, h) => {
        const r = await h.run("click_control", { label: "Click me", _hwnd: app.win.hwnd }, { goal: "click Click me" });
        const s = await waitFor(() => { const x = app.state(); return x && x.clicks >= 1 ? x : null; }, 4000) || app.state();
        ctx.check("the app received exactly one click on 'Click me'", s.clicks === 1, `clicks=${s.clicks}`);
        ctx.check("nothing else was clicked", s.deleteClicks === 0 && s.dupClicks === 0);
        ctx.check("Momo reports the step as verified", r.outcome === "ok", `${r.outcome}: ${r.text.slice(0, 100)}`);
        ctx.check("the app's own status shows the click", /Clicked 1 times/.test(s.status || ""));
        ctx.check("no key or button is left held", r.held === 0 && heldInputs().length === 0);
      });
    },
  },
  {
    id: "A03", group: "A", mode: "real", usesInput: true, interactive: true, est: 14,
    title: "select_field then type_text puts exactly the text into the search box",
    expect: "the app's own text box content equals the typed text; the step is verified",
    async run(ctx) {
      await withBasic(ctx, "a03", {}, async (app, h) => {
        const a = await h.run("select_field", { label: "Search box", _hwnd: app.win.hwnd }, { goal: "select the search box" });
        ctx.check("the field was selected", a.outcome === "ok" || a.outcome === "unverified", `${a.outcome}: ${a.text.slice(0, 100)}`);
        const b = await h.run("type_text", { label: "Search box", text: "hello momo", _hwnd: app.win.hwnd }, { goal: "type hello momo" });
        const s = await waitFor(() => { const x = app.state(); return x && x.text === "hello momo" ? x : null; }, 4000) || app.state();
        ctx.check("the app's text box holds exactly the typed text", s.text === "hello momo", `text="${s.text}"`);
        ctx.check("the step is verified", b.outcome === "ok", `${b.outcome}: ${b.text.slice(0, 100)}`);
        ctx.check("no button was clicked by accident", s.clicks === 0 && s.deleteClicks === 0);
        ctx.check("nothing is left held", b.held === 0 && heldInputs().length === 0);
      });
    },
  },
  {
    id: "A04", group: "A", mode: "real", usesInput: true, interactive: true, est: 14,
    title: "scroll_window scrolls the list (the app reports its scroll position)",
    expect: "the app's own scroll offset increases after a scroll down",
    async run(ctx) {
      await withBasic(ctx, "a04", { layout: "scroll" }, async (app, h) => {   // layout "scroll": a tall list, so the point scroll_window aims at is well inside it
        const before = app.state().scroll || 0;
        // diagnostics: the list's rectangle as Windows reports it (UI Automation, physical px) and the window's rectangle, read BEFORE the wheel turns
        const ui0 = await h.rt.nodeScreen.readUi(app.win.hwnd);
        const listItem = ui0.ok ? ui0.items.find((i) => i.name === "Files") : null;
        const listRect = listItem && listItem.rect ? listItem.rect : null;
        const winRect = h.pointer.windowRect(app.win.hwnd);
        const r = await h.run("scroll_window", { direction: "down", amount: 3, _hwnd: app.win.hwnd }, { goal: "scroll down" });
        const s = await waitFor(() => { const x = app.state(); return x && x.scroll > before ? x : null; }, 4000) || app.state();
        const wv = D.wheelVsList(D.trackSummary(r.tracks).lastScroll, listRect);
        ctx.diag("A04 wheel point against the list (physical px)", { ...wv, scrollBefore: before, scrollAfter: s.scroll, windowAtStart: D.rectsOf(app.state(), winRect) });
        if (wv.known) { const edge = Math.min(...Object.values(wv.marginsPx)); if (!wv.inside || edge < 100) ctx.warn(`the wheel point is ${wv.inside ? "only " + edge + " px inside" : "OUTSIDE"} the list: the fixture geometry, not the tool, may explain a missing scroll`); }
        else ctx.warn("the wheel point or the list rectangle could not be read, so the geometry could not be checked");
        ctx.check("the list scrolled (offset grew)", s.scroll > before, `${before} -> ${s.scroll}`);
        ctx.check("nothing was clicked", s.clicks === 0 && s.deleteClicks === 0);
        ctx.check("nothing is left held", r.held === 0 && heldInputs().length === 0);
      });
    },
  },
  {
    id: "A05", group: "A", mode: "real", usesInput: true, interactive: true, est: 20,
    title: "press_keys sends the key to the window; Alt+F4 asks first and, declined, sends nothing",
    expect: "the app logs F5; for Alt+F4 Momo asks for approval (the card names Alt+F4), the approval is declined before any pointer movement or key, no key (ordinary or system) reaches the window, and the window and its process stay alive and keep updating 0.5 s and 2 s later",
    async run(ctx) {
      await withBasic(ctx, "a05", {}, async (app, h) => {
        const r = await h.run("press_keys", { keys: "f5", _hwnd: app.win.hwnd }, { goal: "press F5" });
        const s = await waitFor(() => { const x = app.state(); return x && (x.keyLog || []).includes("F5") ? x : null; }, 4000) || app.state();
        ctx.check("the app received the F5 key", (s.keyLog || []).includes("F5"), `keys=${JSON.stringify(s.keyLog)}`);
        ctx.check("the call is not reported as failed", r.outcome === "ok" || r.outcome === "unverified", r.outcome);
        const n0 = (s.keyLog || []).length;
        // Alt+F4 is NOT on Momo's refused list: it is a consequential shortcut, so Momo ASKS first. This test declines the question; nothing may reach the window.
        const f4 = await h.run("press_keys", { keys: "alt+f4", _hwnd: app.win.hwnd }, { goal: "close it with alt f4", approve: false });
        const deniedAt = Date.now();                                    // the denial has been delivered and the run has ended
        const pause = (sinceMs) => K.sleep(Math.max(0, sinceMs - (Date.now() - deniedAt)));
        const listed = async () => (await h.rt.nodeWindows.query()).windows.some((w) => w.hwnd === app.win.hwnd);
        const card = f4.asked && f4.asked.summary ? String(f4.asked.summary) : "";
        const journal = f4.journal || [];
        const pointer = D.trackSummary(f4.tracks);
        // what the declined step looked like, recorded whether the checks below pass or fail
        ctx.diag("A05 the declined Alt+F4 step", { asked: !!f4.asked, card, outcome: f4.outcome, text: f4.text, pointerTracks: f4.tracks.length, pointerPhases: pointer.counts, held: f4.held, interrupted: f4.interrupted || null, journal: journal.map((e) => ({ tool: e.tool, phase: e.phase, acted: e.acted })), keyLogBefore: n0 }, { allowed: ["alt+f4"] });

        // ---- the question
        ctx.check("Momo asks for approval before pressing Alt+F4", !!f4.asked, `asked=${!!f4.asked}`);
        ctx.check("the confirmation card names Alt+F4", /alt\+f4/i.test(card), `card="${card.slice(0, 120)}"`);

        // ---- the declined step: it never ran, and the denial came BEFORE any pointer movement or key
        ctx.check("the approval was declined, so the step did not run", f4.outcome === "declined", `${f4.outcome}: ${f4.text.slice(0, 80)}`);
        ctx.check("denial came before any pointer movement or key: the declined run has zero pointer tracks", f4.tracks.length === 0, `${f4.tracks.length} pointer event(s): ${JSON.stringify(pointer.counts)}`);
        ctx.check("no input is held after the declined step", f4.held === 0 && heldInputs().length === 0, `ledger=${f4.held}, Windows=${JSON.stringify(heldInputs())}`);
        ctx.check("the declined step was not interrupted", !f4.interrupted, `interrupted=${f4.interrupted}`);
        ctx.check("the action journal records exactly one step, press_keys, as declined and nothing sent", journal.length === 1 && journal[0].tool === "press_keys" && journal[0].phase === "declined" && journal[0].acted === "no", JSON.stringify(journal.map((e) => ({ tool: e.tool, phase: e.phase, acted: e.acted }))));

        // ---- nothing reached the window (ordinary or system keys): checked right after the denial and again at the end
        await pause(500);                                               // about 0.5 s after the denial
        const s2 = app.state();
        const sent = (s2.keyLog || []).slice(n0);
        ctx.check("no key reached the window: neither an ordinary key nor a system key (the fixture logs Alt+F4 as Sys:F4)", sent.length === 0, JSON.stringify(sent));
        const alive = await listed();
        const proc1 = isAlive(app.child.pid);
        ctx.diag("A05 liveness about 0.5 s after the denial", { sinceDenialMs: Date.now() - deniedAt, windowListed: alive, processAlive: proc1, stateReady: !!(s2 && s2.ready), stateFile: fs.existsSync(app.stP) });
        ctx.check("the window is still open", alive);
        ctx.check("about 0.5 s after the denial the fixture process is still running", proc1, `pid ${app.child.pid}`);

        // ---- and still alive 2 s later (a delayed close would show here)
        await pause(2000);
        const alive2 = await listed();
        const proc2 = isAlive(app.child.pid);
        ctx.diag("A05 liveness about 2 s after the denial", { sinceDenialMs: Date.now() - deniedAt, windowListed: alive2, processAlive: proc2 });
        ctx.check("about 2 s after the denial the window is still open", alive2);
        ctx.check("about 2 s after the denial the fixture process is still running", proc2, `pid ${app.child.pid}`);

        // ---- the state file is present and the fixture is still updating it. A move through SetWindowPos (no mouse, no keyboard) is a harmless trigger the fixture records.
        const rect = h.pointer.windowRect(app.win.hwnd);
        const leftBefore = (app.state() || {}).left;
        if (rect) K.moveWindow(app.win.hwnd, rect.l + 20, rect.t);
        const moved = rect ? await waitFor(() => { const x = app.state(); return x && x.left !== leftBefore ? x : null; }, 3000) : null;
        ctx.diag("A05 state-file heartbeat", { windowRectKnown: !!rect, leftBefore, leftAfter: moved ? moved.left : null, stateFile: fs.existsSync(app.stP) });
        ctx.check("the fixture's state file is still present and readable", fs.existsSync(app.stP) && !!app.state(), fs.existsSync(app.stP) ? "file present but unreadable" : "state file is missing");
        ctx.check("the fixture is still updating its state file (a harmless move with no input is recorded)", !!moved, `left ${leftBefore} -> ${moved ? moved.left : "unchanged"}`);
        const sentFinal = ((app.state() || {}).keyLog || []).slice(n0);
        ctx.check("still no key, ordinary or system (Sys:*), has reached the window at the end of the test", sentFinal.length === 0, JSON.stringify(sentFinal));
        ctx.check("nothing is left held", heldInputs().length === 0);
      });
    },
  },
  {
    id: "A06", group: "A", mode: "real", usesInput: true, interactive: true, est: 18,
    title: "foreground changes: focus_window brings the window back in front of another",
    expect: "after another window covers it, focus_window makes the app report a new activation",
    async run(ctx) {
      await withBasic(ctx, "a06", {}, async (app, h) => {
        const other = await K.launchBlocks(ctx, { mode: "normal", aware: true, tag: "a06o" });
        try {
          ctx.check("a second window appeared in front", !!other.win);
          await K.sleep(900);
          const before = app.state().activated || 0;
          const r = await h.run("focus_window", { _hwnd: app.win.hwnd }, { goal: "bring the test window forward" });
          const s = await waitFor(() => { const x = app.state(); return x && x.activated > before ? x : null; }, 4000) || app.state();
          ctx.check("the app was activated again", s.activated > before, `${before} -> ${s.activated}`);
          ctx.check("the step is not reported as failed", r.outcome === "ok" || r.outcome === "unverified", `${r.outcome}: ${r.text.slice(0, 90)}`);
        } finally { await other.close(); }
      });
    },
  },
  {
    id: "A07", group: "A", mode: "real", usesInput: true, interactive: true, est: 20,
    title: "window movement: arrange_window snaps the window and restore brings it back",
    expect: "the app's own position changes after 'right' and returns to roughly its first position after 'restore'",
    async run(ctx) {
      await withBasic(ctx, "a07", {}, async (app, h) => {
        const s0 = app.state(); const x0 = s0.left;
        // the fixture's own rectangle (DIPs), Momo's view of it (physical px) and the WINDOWPLACEMENT Windows keeps (showCmd + the NORMAL rectangle a snapped window returns to).
        // The placement call is read-only; the desktop window's width in the same call tells which units it used (physical px or logical).
        const place = () => { const p = windowPlacement(app.win.hwnd); const ref = windowPlacement(desktopWindow()); return p ? { ...p, unitsReference: { desktopWidth: ref ? ref.normalPx.w : null } } : null; };
        const rect = () => D.rectsOf(app.state(), h.pointer.windowRect(app.win.hwnd), place());
        ctx.diag("A07 screen work area (physical px; the taskbar shifts it)", ctx.env.workArea || null);
        ctx.diag("A07 rectangles: before", rect());
        const r1 = await h.run("arrange_window", { to: "right", _hwnd: app.win.hwnd }, { goal: "snap right" });
        await K.sleep(800);
        const s1 = app.state();
        ctx.diag("A07 rectangles: after snap right", rect());
        ctx.diag("A07 snap answer", { outcome: r1.outcome, acted: r1.step && r1.step.acted, text: r1.text });
        ctx.check("the window moved (the app reports a new position)", Math.abs(s1.left - x0) > 50, `${x0} -> ${s1.left}`);
        ctx.check("the snap was not reported as failed", r1.outcome !== "failed", `${r1.outcome}: ${r1.text.slice(0, 90)}`);
        const r2 = await h.run("arrange_window", { to: "restore", _hwnd: app.win.hwnd }, { goal: "restore" });
        await K.sleep(800);
        const s2 = app.state();
        ctx.diag("A07 rectangles: after restore", rect());
        ctx.diag("A07 restore answer", { outcome: r2.outcome, acted: r2.step && r2.step.acted, text: r2.text });
        await K.sleep(1500);   // a late animation or a second move would show here
        ctx.diag("A07 rectangles: after restore, +1.5 s", rect());
        ctx.check("restore brought it back near its first position", Math.abs(s2.left - x0) < 80, `${x0} -> ${s2.left}`);
        ctx.check("nothing is left held", r2.held === 0 && heldInputs().length === 0);
      });
    },
  },
  {
    id: "A08", group: "A", mode: "real", usesInput: true, interactive: true, est: 12,
    title: "a disabled control is refused: nothing is clicked and the refusal says so",
    expect: "click_control on the disabled 'Locked' button fails without delivering input",
    async run(ctx) {
      await withBasic(ctx, "a08", {}, async (app, h) => {
        const r = await h.run("click_control", { label: "Locked", _hwnd: app.win.hwnd }, { goal: "click Locked" });
        const s = app.state();
        ctx.check("the step failed", r.outcome === "failed", `${r.outcome}: ${r.text.slice(0, 100)}`);
        ctx.check("no input was delivered to the app", s.clicks === 0 && s.deleteClicks === 0 && s.dupClicks === 0);
        ctx.check("the step says it did not act", !r.step || r.step.acted !== "yes", `acted=${r.step && r.step.acted}`);
      });
    },
  },
  {
    id: "A09", group: "A", mode: "real", usesInput: true, interactive: true, est: 14,
    title: "ambiguous target: two buttons named 'Click me' => Momo asks, and clicks neither",
    expect: "a clarification question with at least two options; the app received no click on either button",
    async run(ctx) {
      await withBasic(ctx, "a09", { dup: true }, async (app, h) => {
        const r = await h.run("click_control", { label: "Click me", _hwnd: app.win.hwnd }, { goal: "click Click me" });
        const s = app.state();
        ctx.check("a question was asked instead of guessing", !!r.clarification, "no clarification event");
        ctx.check("the question offers the candidates", r.clarification && Array.isArray(r.clarification.options) && r.clarification.options.length >= 2, `options=${r.clarification && r.clarification.options && r.clarification.options.length}`);
        ctx.check("neither button was clicked", s.clicks === 0 && s.dupClicks === 0, `clicks=${s.clicks} dup=${s.dupClicks}`);
        h.cancel();
      });
    },
  },
  {
    id: "A10", group: "A", mode: "real", usesInput: true, interactive: true, quick: true, est: 14,
    title: "cancellation: cancelling while the pointer glides delivers no click and holds nothing",
    expect: "after Cancel during the glide the app received no click, the pointer ledger and the OS input state are empty",
    async run(ctx) {
      await withBasic(ctx, "a10", {}, async (app, h) => {
        const r = await h.run("click_control", { label: "Click me", _hwnd: app.win.hwnd }, {
          goal: "click Click me",
          hook: async (api) => { await moveSeen(api); await K.sleep(60); h.cancel(); },
        });
        const s = app.state();
        ctx.check("the glide had started before the cancel", r.tracks.some((t) => t.phase === "move"));
        ctx.check("the app received no click", s.clicks === 0, `clicks=${s.clicks}`);
        ctx.check("the task did not complete", !r.completed);
        ctx.check("the pointer ledger is empty", r.held === 0);
        ctx.check("no key or button is held in Windows", heldInputs().length === 0);
      });
    },
  },
  {
    id: "A11", group: "A", mode: "real", usesInput: true, interactive: true, quick: true, est: 14,
    title: "user takeover: moving the real mouse during the glide stops Momo with no click",
    expect: "the pointer reports the mouse was taken, the app received no click, nothing is left held",
    async run(ctx) {
      await withBasic(ctx, "a11", {}, async (app, h) => {
        const r = await h.run("click_control", { label: "Click me", _hwnd: app.win.hwnd }, {
          goal: "click Click me",
          hook: async (api) => { await moveSeen(api); await K.sleep(120); setCursor(30, 30); },
        });
        const s = app.state();
        ctx.check("the takeover was noticed", r.interrupted === "mouse", `interrupted=${r.interrupted}`);
        ctx.check("the app received no click", s.clicks === 0, `clicks=${s.clicks}`);
        ctx.check("nothing is left held", r.held === 0 && heldInputs().length === 0);
      });
    },
  },
  {
    id: "A12", group: "A", mode: "real", usesInput: true, interactive: true, est: 18,
    title: "held-input release: cancelling in the middle of a drag releases the mouse button",
    expect: "after Cancel while the button is down, Windows reports no button held and Momo's ledger is empty",
    async run(ctx) {
      await withBasic(ctx, "a12", {}, async (app, h) => {
        let sawPress = false;
        const r = await h.run("drag_drop", { from: "Item 001", to: "Item 004", _hwnd: app.win.hwnd }, {
          goal: "drag item 1 onto item 4",
          hook: async (api) => { sawPress = !!(await waitFor(() => api.tracks.some((t) => t.phase === "press") || null, 12_000, 5)); if (sawPress) { await K.sleep(40); h.cancel(); } },
        });
        ctx.check("the drag reached the button-down phase before the cancel", sawPress);
        ctx.check("Momo's ledger holds nothing", r.held === 0);
        ctx.check("Windows reports no button or key held", heldInputs().length === 0, JSON.stringify(heldInputs()));
        ctx.check("the task did not complete", !r.completed);
      });
    },
  },
];
