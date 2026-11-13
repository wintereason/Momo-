// LIVE check on the real desktop: what does Momo understand about the controls of a window? Nothing is clicked.
//   npm run build:runtime && node scripts/live-understand.cjs "File Explorer" [inspect]
// A tiny local stand-in plays the planner: understand_screen, then (with "inspect") inspect_component on the first control it could not explain.
const rt = require("../electron/runtime.cjs");

const windowQuery = process.argv[2] || "File Explorer";
const inspect = process.argv[3] === "inspect";
const tool = (name, args) => ({ type: "tool", tool: name, args });

(async () => {
  const seen = [];
  const ai = {
    ready: () => true, label: () => "local stand-in", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 999 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_goal, steps) {
      const d = decide(steps);
      return { ok: true, decision: d, source: "local" };
    },
  };
  function decide(steps) {
      const l = steps[steps.length - 1];
      if (l) { seen.push(l); console.log(`\n[${l.tool} ${l.outcome}]\n` + String(l.text).split(" || ").join("\n  ")); }
      if (!l) return tool(process.env.T || "understand_screen", { window: windowQuery });
      if (l.tool === "understand_screen" && inspect) {
        const m = /\[ref (-?\d+,-?\d+)\]/.exec(l.text);
        if (m) return tool("inspect_component", { ref: m[1], window: windowQuery });
      }
      return { type: "done", answer: "checked" };
  }
  const session = new rt.Session({
    fs: rt.nodeFs, win: rt.nodeWindows, screen: rt.nodeScreen, input: rt.nodeInput, apps: rt.nodeApps, launch: rt.nodeLaunch,
    act: { openPath: async () => "no" }, emit: (e) => { if (e.type !== "task.state") console.log("EVENT", e.type, (e.summary || e.question || "").slice(0, 200)); },
    selfPids: () => [], ai, verifyAttempts: 2,
  });
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  const t0 = Date.now();
  await session.handleTranscript("live", "what are the controls of " + windowQuery);
  console.log(`\n(took ${Math.round((Date.now() - t0) / 1000)} s)`);
  process.exit(0);
})();
