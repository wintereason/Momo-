// Real end-to-end check of "look at a window": the real runtime, real UI Automation / OCR.
//   node scripts/smoke-screen.cjs "read this window" "what buttons are on this window"
// It reads the window that is in front RIGHT NOW (run it from a terminal you are happy to have read).
// Output is cut short on purpose.
const koffi = require("koffi");
const { createRuntime } = require("../electron/runtime.cjs");

const user32 = koffi.load("user32.dll");
const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void*, _Out_ uint32*)");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(void*, _Out_ uint16*, int)");

function foreground() {
  const h = GetForegroundWindow();
  const pid = [0];
  GetWindowThreadProcessId(h, pid);
  const buf = new Uint16Array(256);
  const n = GetWindowTextW(h, buf, 256);
  return { hwnd: Number(koffi.address(h)), pid: pid[0], title: Buffer.from(buf.buffer, 0, n * 2).toString("utf16le") };
}

const asks = process.argv.slice(2);
const queue = asks.length ? asks : ["read this window", "what buttons are on this window"];

const session = createRuntime({
  selfPids: () => [],
  foreground: { lastExternal: foreground },
  emit: (e) => {
    const cut = (s) => (s && s.length > 420 ? s.slice(0, 420) + " …[cut]" : s);
    if (e.type === "task.state") console.log(`   · ${e.state}${e.message ? ": " + e.message : ""}`);
    else console.log(`   → ${e.type}: ${cut(e.summary || e.question || "")}${e.verified ? "  [verified]" : ""}`);
  },
});
session.setPolicy({ confirmScreenRead: false }); // this script is the approval

(async () => {
  console.log("foreground:", JSON.stringify(foreground()));
  for (const q of queue) {
    console.log(`\n"${q}"`);
    const t = Date.now();
    await session.handleTranscript("smoke", q);
    console.log(`   (${Date.now() - t} ms)`);
  }
  console.log("\nuia calls:", session.uiAgent.calls, " ocr calls:", session.visualAgent.calls);
  session.dispose();
  console.log("world model after dispose:", session.world.size);
})();
