// LIVE check on the real desktop: the agent loop with the REAL pointer, real windows, real File Explorer. Hands off the mouse while it runs.
//   npm run build:runtime && node scripts/live-desktop-control.cjs [explorer|reuse|click]
// The "planner" here is a small local stand-in that reads each observation and picks the next tool (no online AI is contacted),
// so every decision below is made from what the screen really showed.
const koffi = require("koffi");
const rt = require("../electron/runtime.cjs");
const { createPointer } = require("../electron/humanInput.cjs");

const scenario = process.argv[2] || "explorer";
const events = [];
const pointer = createPointer(koffi);
const stepsLog = [];

function planner(decide) {
  return {
    ready: () => true, label: () => "local stand-in", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 999 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_goal, steps) {
      const lt = last(steps); if (lt) console.log("  saw [" + lt.tool + " " + lt.outcome + "]:", String(lt.text).slice(0, 700));
      const d = decide(steps);
      stepsLog.push(d);
      return { ok: true, decision: d, source: "local" };
    },
  };
}
const last = (steps) => { const s = steps[steps.length - 1]; return s && s.kind === "tool" ? s : null; };
const tool = (name, args) => ({ type: "tool", tool: name, args });

const planners = {
  // open File Explorer (running + minimized => must be reused), then navigate: This PC -> the D drive -> the "Project 2" folder
  explorer: (steps) => {
    const l = last(steps);
    if (!l) return tool("open_app", { app: "File Explorer" });
    const text = l.text || "";
    if (l.outcome === "failed") return { type: "fail", reason: l.text };
    if (l.tool !== "look_screen") return tool("look_screen", {});
    const items = ((text.match(/Items: (.*?)\. \d+ windows/) || [])[1] || "").split(" | ").map((x) => x.replace(/ \(selected\)$/, "").trim());
    const controls = ((text.match(/Controls: (.*?)\. (?:Items:|\d+ windows)/) || [])[1] || "").split(", ");
    const address = ((text.match(/address: (.*?)\. (?:Controls|Items|\d+ windows)/) || [])[1] || "").trim();
    const title = (text.match(/^In "(.*?)"/) || [])[1] || "";
    const where = (address || title).replace(/ - File Explorer$/, "");
    const clicks = steps.filter((s) => s.kind === "tool" && s.tool === "click_control").length;
    if (/^Project 2$/i.test(where) || /Project 2$/i.test(address)) return { type: "done", answer: "The Project 2 folder is open (window: " + title + ")." };
    if (/^(Local Disk \(D:\)|D:\\?)$/i.test(where) && items.includes("Project 2")) return tool("click_control", { label: "Project 2", open: true });
    if (controls.includes("Local Disk (D:)") && clicks === 0) return tool("click_control", { label: "Local Disk (D:)" }); // the address bar's breadcrumb
    const drive = items.find((x) => /\(D:\)$/.test(x));
    if (drive && clicks < 3) return tool("click_control", { label: drive, open: true });
    return { type: "fail", reason: "could not find the D drive from what is on screen: " + text.slice(0, 400) };
  },
  // already running (minimized or behind): must not be launched again
  reuse: (steps) => {
    const l = last(steps);
    if (!l) return tool("open_app", { app: process.argv[3] || "Notepad" });
    return { type: "done", answer: l.text };
  },
};

(async () => {
  const win0 = await rt.nodeWindows.query();
  console.log("BEFORE:", win0.windows.map((w) => `${w.process}${w.minimized ? "(min)" : w.maximized ? "(max)" : ""}`).join(", "));
  const session = new rt.Session({
    fs: rt.nodeFs, win: rt.nodeWindows, screen: rt.nodeScreen, input: rt.nodeInput, apps: rt.nodeApps, launch: rt.nodeLaunch,
    act: { openPath: async () => "no" }, // direct opening is disabled on purpose: everything must go through the screen
    emit: (e) => {
      events.push(e);
      if (e.type === "cursor.move") console.log(`  ghost -> ${e.action} (${e.x},${e.y}) ${e.label || ""}`);
      if (e.type === "cursor.window") console.log(`  ghost -> window ${e.action}`);
      if (/^task./.test(e.type)) console.log("EVENT:", e.type, JSON.stringify(e).slice(0, 400));
    },
    selfPids: () => [], ai: planner(planners[scenario] || planners.explorer), cursorLeadMs: () => 800,
    pointer: () => pointer, verifyAttempts: 4, maxSteps: 16,
  });
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  const before = Date.now();
  await session.handleTranscript("live", scenario === "explorer" ? "open the D drive and open the Project 2 folder" : "open the app");
  // a question from Momo (which of two look-alikes?): answer it like a user would, with the first option
  for (let n = 0; n < 3; n++) {
    const q = events.filter((e) => e.type === "task.clarification_required").pop();
    const fin = events.some((e, i) => i > events.lastIndexOf(q) && /^task.(completed|failed|partial_success)$/.test(e.type));
    if (!q || fin) break;
    console.log("  Momo asked:", q.question, "| options:", JSON.stringify((q.options || []).map((o) => o.label + (o.detail ? " - " + o.detail : ""))));
    await session.handleTranscript("live", "the first one");
  }
  console.log("took", Math.round((Date.now() - before) / 1000), "s");
  for (const s of stepsLog) console.log(" step:", JSON.stringify(s).slice(0, 160));
  for (const s of session.__texts || []) console.log(" saw:", s.slice(0, 600));
  const win1 = await rt.nodeWindows.query();
  console.log("AFTER:", win1.windows.map((w) => `${w.process}${w.minimized ? "(min)" : w.maximized ? "(max)" : ""}${w.hwnd === win1.activeHwnd ? "*" : ""}`).join(", "));
  const ex = win1.windows.find((w) => w.process === "explorer");
  console.log("explorer title:", ex && ex.title);
  process.exit(0);
})();
