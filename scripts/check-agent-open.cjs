// Live check of "open a file or folder" with your free AI key (from .env) on the real PC:
//   node scripts/build-runtime.mjs && node scripts/check-agent-open.cjs
// Rule being checked: a clear target is opened at once (no confirmation); several matches are listed with full paths and
// you choose; every opening is verified by Windows. Opens real Explorer windows (harmless). Prints events, never keys.
require("node:dns").setDefaultResultOrder("ipv4first");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { load } = require("../electron/env.cjs");
const { buildAiConfig, createRuntime } = require("../electron/runtime.cjs");

const values = { ...load({ files: [".env"], processEnv: {} }).values, MOMO_AI_ENABLED: "true" };
if (process.argv.includes("--groq")) values.MOMO_AI_PROVIDER = "groq";
const usage = { u: { date: "", count: 0 }, load() { return this.u; }, save(x) { this.u = x; } };

// a throw-away folder with two same-named files, so the "several matches" case is real but harmless
const base = path.join(os.homedir(), "momo-open-test");
const a = path.join(base, "alpha"), b = path.join(base, "beta");
fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
fs.writeFileSync(path.join(a, "momo-test-report.txt"), "test file A"); fs.writeFileSync(path.join(b, "momo-test-report.txt"), "test file B");
fs.writeFileSync(path.join(base, "momo-unique-note.txt"), "a unique note");

const events = [];
const rt = createRuntime({
  emit: (e) => events.push(e), selfPids: () => [], ai: { config: () => buildAiConfig(values), usage },
  act: { openPath: async (p) => { const { shell } = (() => { try { return require("electron"); } catch { return {}; } })(); if (shell) return shell.openPath(p); const { spawn } = require("node:child_process"); spawn("explorer.exe", [p], { detached: true, stdio: "ignore" }).unref(); return ""; } },
});
rt.setPolicy({ confirmReversible: false, confirmScreenRead: false });

const show = (label) => {
  const kinds = events.map((e) => e.type.replace("task.", "") + (e.type === "task.state" ? "(" + e.state + (e.speak ? ",spoken" : "") + ")" : ""));
  const last = events[events.length - 1] || {};
  console.log(`\n${label}\n   events: ${kinds.filter((k) => !/^state\(working\)$/.test(k)).join(" → ")}`);
  console.log("   ->", last.type, last.verified ? "(verified)" : "", "::", String(last.summary || last.question || last.message || "").slice(0, 330));
  if (last.options) console.log("   options:", last.options.map((o, i) => `${i + 1}) ${o.label} — ${o.detail}`).join("  |  "));
  return last;
};

(async () => {
  let ok = true;
  events.length = 0; await rt.handleTranscript("s", "open the momo unique note file");
  let last = show("1) one clear match: should open at once, no question");
  ok = ok && last.type === "task.completed" && last.verified === true && !events.some((e) => /confirmation|clarification/.test(e.type));

  events.length = 0; await rt.handleTranscript("s", "open the momo test report");
  last = show("2) two files with the same name: should list both with full paths and ask");
  const asked = last.type === "task.clarification_required" && last.options && last.options.length === 2 && last.options.every((o) => o.detail && o.detail.includes("momo-test-report.txt"));
  ok = ok && asked;
  if (asked) {
    events.length = 0; await rt.handleTranscript("s", "the second one");
    last = show("   answered 'the second one': should open it at once");
    ok = ok && last.type === "task.completed" && last.verified === true && !events.some((e) => /confirmation/.test(e.type));
  }

  events.length = 0; await rt.handleTranscript("s", "open my tax return from 1850");
  last = show("3) nothing like it: should say so, not guess");
  ok = ok && last.type === "task.failed";

  fs.rmSync(base, { recursive: true, force: true });
  // close the windows we opened (they are named after our test files/folders)
  console.log(ok ? "\nRULE HOLDS: clear = open, several = ask, every opening verified" : "\nSOMETHING DID NOT FOLLOW THE RULE (see above)");
  rt.dispose();
  process.exit(ok ? 0 : 1);
})();
