// Runs real requests through the real runtime (real drives, real windows) outside Electron.
//   node scripts/smoke-runtime.cjs "storage of D drive" "which window is active" ...
const { createRuntime } = require("../electron/runtime.cjs");

const asks = process.argv.slice(2);
const queue = asks.length ? asks : ["Tell me the storage of D drive", "list my drives", "which window is active", "what windows are open", "find the downloads folder"];

const session = createRuntime({
  selfPids: () => [],
  emit: (e) => {
    if (e.type === "task.state") console.log(`   · ${e.state}${e.message ? ": " + e.message : ""}`);
    else console.log(`   → ${e.type}: ${e.summary || e.question || ""}${e.verified ? "  [verified]" : ""}`);
  },
});

(async () => {
  for (const q of queue) {
    console.log(`\n"${q}"`);
    const t = Date.now();
    await session.handleTranscript("smoke", q);
    console.log(`   (${Date.now() - t} ms)`);
  }
  session.dispose();
  console.log(`\nworld model after dispose: ${session.world.size} entities`);
})();
