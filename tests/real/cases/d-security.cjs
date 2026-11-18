"use strict";
// Group D: security and environment scenarios.
//   D01, D02 are automated: password-box refusal and Momo's-own-window exclusion, on real windows.
//   D03, D04, D05 are MANUAL: UAC, session lock and sleep/resume would interrupt your session, so they are separate scripts that only YOU run
//   (each needs an explicit opt-in flag and a typed confirmation). The suite lists them as MANUAL = not run; it never runs them and never counts them as passed.
const K = require("../lib/kit.cjs");
const { heldInputs } = require("../lib/input.cjs");

const captureInactive = async (h) => { const i = await h.rt.nodeCapture.send("capinfo", undefined, 5000); return !!i && i.active === false; };

module.exports = [
  {
    id: "D01", group: "D", mode: "real", usesInput: true, interactive: true, quick: true, est: 14, timeoutMs: 90_000,
    title: "a window with a password box: look_visual and click_visual refuse, and no capture is started",
    expect: "both tools fail with the password-box refusal; the capture session is not active afterwards; nothing is clicked",
    async run(ctx) {
      const h = ctx.harness();
      const w = await K.launchTitled(ctx, "pwform.ps1", [], "pw1");
      try {
        ctx.check("the password window appeared", !!w.win);
        await K.sleep(900);
        const look = await h.run("look_visual", { _hwnd: w.win.hwnd }, { goal: "look at the window" });
        ctx.check("look_visual refused", look.outcome === "failed", `${look.outcome}: ${look.text.slice(0, 90)}`);
        ctx.check("and said it was because of the password box", /password box/i.test(look.text), look.text.slice(0, 90));
        ctx.check("no capture session is active after the look", await captureInactive(h));
        const click = await h.run("click_visual", { _hwnd: w.win.hwnd, label: "Filter" }, { goal: "click Filter" });
        ctx.check("click_visual refused", click.outcome === "failed", `${click.outcome}: ${click.text.slice(0, 90)}`);
        ctx.check("and said it was because of the password box", /password box/i.test(click.text), click.text.slice(0, 90));
        ctx.check("the pointer never moved", click.tracks.length === 0, `${click.tracks.length} track events`);
        ctx.check("no capture session is active after the click attempt", await captureInactive(h));
        ctx.check("nothing is held", heldInputs().length === 0);
      } finally { await w.close(); }
    },
  },
  {
    id: "D02", group: "D", mode: "real", usesInput: true, interactive: true, est: 12, timeoutMs: 90_000,
    title: "Momo's own windows are excluded: a window of the declared own process is never captured",
    expect: "when the window's process is declared one of Momo's own, look_visual and click_visual refuse and start no capture",
    async run(ctx) {
      const h = ctx.harness();
      const w = await K.launchBlocks(ctx, { mode: "normal", aware: true, tag: "d02" });
      try {
        ctx.check("the test window appeared", !!w.win);
        h.setSelfPids([w.win.pid]);
        const look = await h.run("look_visual", { _hwnd: w.win.hwnd }, { goal: "look at the window" });
        ctx.check("look_visual refused", look.outcome === "failed", `${look.outcome}: ${look.text.slice(0, 90)}`);
        ctx.check("and said it was one of Momo's own windows", /one of my own windows/i.test(look.text), look.text.slice(0, 90));
        const click = await h.run("click_visual", { _hwnd: w.win.hwnd, label: "Block 1" }, { goal: "click Block 1" });
        ctx.check("click_visual refused too", click.outcome === "failed" && /my own windows/i.test(click.text), `${click.outcome}: ${click.text.slice(0, 90)}`);
        ctx.check("the pointer never moved", click.tracks.length === 0);
        ctx.check("no capture session is active afterwards", await captureInactive(h));
        h.setSelfPids([]);
        const ok = await h.run("look_visual", { _hwnd: w.win.hwnd }, { goal: "look at the window" });
        ctx.check("with the declaration removed, the same window can be looked at again", ok.outcome === "ok", `${ok.outcome}: ${ok.text.slice(0, 90)}`);
      } finally { h.setSelfPids([]); await w.close(); }
    },
  },
  {
    id: "D03", group: "D", mode: "manual", manual: true, est: 60,
    title: "UAC prompt: safe detection and refusal while an administrator-approval prompt is open",
    command: "node tests/real/manual/uac.cjs --i-understand",
    reason: "shows a real UAC prompt that YOU must decline. The script only reads (no input), never approves, never enters credentials.",
  },
  {
    id: "D04", group: "D", mode: "manual", manual: true, est: 120,
    title: "Session lock and unlock: Momo's reads do not hang and come back after you sign in",
    command: "node tests/real/manual/lock.cjs --i-agree-to-lock",
    reason: "LOCKS your Windows session (sign in again afterwards). Needs --i-agree-to-lock and a typed LOCK. The suite and I never run it.",
  },
  {
    id: "D05", group: "D", mode: "manual", manual: true, est: 120,
    title: "Sleep and resume: Momo's machinery survives the PC sleeping and waking",
    command: "node tests/real/manual/sleep.cjs --i-agree-to-sleep",
    reason: "PUTS YOUR PC TO SLEEP (you wake it). Needs --i-agree-to-sleep and a typed SLEEP. The suite and I never run it.",
  },
];
