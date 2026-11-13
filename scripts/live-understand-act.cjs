// LIVE: identify -> understand what it is for -> use it with the REAL pointer -> check the specific effect. Hands off the mouse while it runs.
//   npm run build:runtime && node scripts/live-understand-act.cjs
const koffi = require("koffi");
const rt = require("../electron/runtime.cjs");
const { createPointer } = require("../electron/humanInput.cjs");

const pointer = createPointer(koffi);
const plan = [
  { type: "tool", tool: "select_field", args: { label: "the search bar", window: "File Explorer" } },
  { type: "tool", tool: "click_control", args: { label: "Sort", window: "File Explorer" } },
  { type: "done", answer: "finished" },
];
(async () => {
  let i = 0;
  const ai = {
    ready: () => true, label: () => "local stand-in", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 999 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_g, steps) {
      const l = steps[steps.length - 1];
      if (l) console.log(`\n[${l.tool} -> ${l.outcome}]\n  ${String(l.text).slice(0, 700)}`);
      return { ok: true, decision: plan[Math.min(i++, plan.length - 1)], source: "local" };
    },
  };
  const session = new rt.Session({
    fs: rt.nodeFs, win: rt.nodeWindows, screen: rt.nodeScreen, input: rt.nodeInput, apps: rt.nodeApps, launch: rt.nodeLaunch,
    act: { openPath: async () => "no" }, emit: (e) => { if (/^cursor\./.test(e.type)) console.log("  ghost <-", e.type, e.say || e.state || e.action || "", e.text || e.label || ""); if (/^task\.(failed|clarification|confirmation|completed)/.test(e.type)) console.log("EVENT", e.type, (e.summary || e.question || "").slice(0, 300)); },
    selfPids: () => [], ai, cursorLeadMs: () => 800, pointer: () => pointer, verifyAttempts: 3,
  });
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  await session.handleTranscript("live", "select the search bar, then open the Sort menu");
  // tidy up: close the menu that was opened, and leave the search box as it was
  await new Promise((r) => setTimeout(r, 600));
  await pointer.press("esc");
  await new Promise((r) => setTimeout(r, 300));
  await pointer.press("esc");
  process.exit(0);
})();
