// Live check of the goal-driven agent with YOUR free AI keys (from .env) on the real PC, in "ask first" mode:
//   node scripts/build-runtime.mjs && node scripts/check-agent-live.cjs
// Read-only goals run for real. Anything that would act on the PC stops at its confirmation card and is NEVER approved
// here. Emails are hidden in the printout. Prints events, never keys.
require("node:dns").setDefaultResultOrder("ipv4first");
const { load } = require("../electron/env.cjs");
const { buildAiConfig, createRuntime } = require("../electron/runtime.cjs");

const values = { ...load({ files: [".env"], processEnv: {} }).values, MOMO_AI_ENABLED: "true" };
if (process.argv.includes("--groq")) values.MOMO_AI_PROVIDER = "groq";
const usage = { u: { date: "", count: 0 }, load() { return this.u; }, save(x) { this.u = x; } };
const hide = (t) => String(t || "").replace(/[\w.+-]+@[\w.-]+/g, "<email>");

const GOALS = [
  "how much free space is on my D drive",
  "what is the capital of France",
  "open chrome and go to panda face icon email and open youtube",
  "how many emails do I have in chrome",
  "open youtube",
  "tell me which windows I have open",
  "delete everything in my downloads folder",
  "open calculator and then tell me what 12 times 12 is",
];

(async () => {
  for (const goal of GOALS) {
    const events = [];
    const rt = createRuntime({ emit: (e) => events.push(e), selfPids: () => [], ai: { config: () => buildAiConfig(values), usage } });
    const t0 = Date.now();
    await rt.handleTranscript("s", goal);
    const shown = events.filter((e) => e.type !== "task.state" || e.state !== "working" || /Working out|Deciding/.test("")).map((e) => e.type + (e.state ? "(" + e.state + ")" : ""));
    const working = events.filter((e) => e.type === "task.state" && e.state === "working").map((e) => e.message).filter((m) => !/^(Working out|Deciding)/.test(m));
    const last = events[events.length - 1] || {};
    console.log(`\n"${goal}"  (${((Date.now() - t0) / 1000).toFixed(1)} s, ${events.filter((e) => e.type === "task.state" && /Working out|Deciding/.test(e.message || "")).length} planner calls)`);
    if (working.length) console.log("   steps:", working.join(" | "));
    console.log("   ->", last.type, "::", hide(last.summary || last.question || last.message || last.text).slice(0, 260));
    void shown;
    rt.cancelTask();
    rt.dispose();
  }
  process.exit(0);
})();
