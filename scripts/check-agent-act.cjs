// Live check that the agent really ACTS and VERIFIES on this PC, with your free AI key (from .env):
//   node scripts/build-runtime.mjs && node scripts/check-agent-act.cjs
// It opens Windows Calculator, minimizes it, and (always asking first, and approving) closes it, each time reporting only
// what Windows confirms. Nothing else on your PC is touched. Prints events, never keys.
require("node:dns").setDefaultResultOrder("ipv4first");
const { load } = require("../electron/env.cjs");
const { buildAiConfig, createRuntime } = require("../electron/runtime.cjs");

const values = { ...load({ files: [".env"], processEnv: {} }).values, MOMO_AI_ENABLED: "true" };
const usage = { u: { date: "", count: 0 }, load() { return this.u; }, save(x) { this.u = x; } };
const { shell } = (() => { try { return { shell: require("electron").shell }; } catch { return { shell: null }; } })();

const events = [];
const rt = createRuntime({ emit: (e) => events.push(e), selfPids: () => [], ai: { config: () => buildAiConfig(values), usage }, act: { openPath: async () => "" } });
rt.setPolicy({ confirmReversible: false, confirmScreenRead: false }); // small things do not ask (the app's default)

async function goal(text, approve) {
  events.length = 0;
  const t0 = Date.now();
  await rt.handleTranscript("s", text);
  const steps = events.filter((e) => e.type === "task.state" && e.state === "working").map((e) => e.message).filter((m) => !/^(Working out|Deciding)/.test(m));
  let last = events[events.length - 1] || {};
  console.log(`\n"${text}" (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (steps.length) console.log("   steps:", steps.join(" | "));
  if (last.type === "task.confirmation_required" && approve) {
    console.log("   asked:", last.summary, "-> approving");
    await rt.respondConfirmation(last.taskId, true);
    last = events[events.length - 1] || {};
  }
  console.log("   ->", last.type, last.verified ? "(verified)" : "", "::", String(last.summary || last.question || last.message || last.text || "").slice(0, 240));
  return last;
}

(async () => {
  const a = await goal("open the calculator", false);
  await new Promise((r) => setTimeout(r, 1500));
  const b = await goal("minimize the calculator window", false);
  const c = await goal("close the calculator window", true);
  const ok = a.type === "task.completed" && a.verified && b.type === "task.completed" && c.type === "task.completed";
  console.log(ok ? "\nALL VERIFIED" : "\nNOT everything was verified (see above)");
  rt.dispose();
  process.exit(ok ? 0 : 1);
})();
