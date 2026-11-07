// Real end-to-end check of Phase G: launching an app, a folder adapter (VS Code), and browser tabs.
//   node scripts/smoke-apps.cjs
// It only starts Notepad (skipped if you already have one open) and a VS Code window on a scratch folder it creates,
// and closes them again. For your browsers it prints counts only, with page titles redacted.
const fs = require("fs");
const path = require("path");
const { createRuntime, nodeWindows } = require("../electron/runtime.cjs");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { (ok ? pass++ : fail++); console.log(`   ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };
const redact = (s) => String(s).replace(/“[^”]*”/g, "“…”");

(async () => {
  const events = [];
  const session = createRuntime({ selfPids: () => [process.pid], emit: (e) => events.push(e) });
  session.setPolicy({ confirmScreenRead: false });
  const last = () => events[events.length - 1];
  const text = (e) => (e && (e.summary || e.question || e.message)) || "";

  async function ask(sentence, approve, show = (s) => s) {
    console.log(`"${sentence}"`);
    events.length = 0;
    await session.handleTranscript("smoke", sentence);
    const conf = events.find((e) => e.type === "task.confirmation_required");
    if (conf) {
      console.log(`   ? ${show(conf.summary)}`);
      if (approve !== undefined) await session.respondConfirmation(conf.taskId, approve);
    }
    const e = last();
    console.log(`   → ${e.type}${e.state ? "/" + e.state : ""}: ${show(text(e))}`);
    return { final: e, asked: !!conf };
  }
  const windows = async () => (await nodeWindows.query()).windows;

  // ---- 1. an installed app: Notepad
  const before = await windows();
  if (process.env.SKIP_NOTEPAD || before.some((w) => /^notepad$/i.test(w.process))) {
    console.log("(Notepad is already open on this PC: skipping the launch test so nothing of yours is touched)\n");
  } else {
    let r = await ask("open notepad", true);
    check("asked before starting an app", r.asked);
    check("launch verified by seeing the window", r.final.type === "task.completed" && r.final.verified === true);
    check("a Notepad window really exists", (await windows()).some((w) => /^notepad$/i.test(w.process)));
    r = await ask("close notepad", true);
    check("close asked first", r.asked);
    check("Notepad closed and verified", r.final.type === "task.completed");
    check("no Notepad window left", !(await windows()).some((w) => /^notepad$/i.test(w.process)));
  }

  // ---- 2. unknown / ambiguous apps and refusals
  let r = await ask("open zzqxnonexistentapp", true);
  check("unknown app reported honestly", r.final.type === "task.failed");
  r = await ask("open notepad and then send a message", true);
  check("multi-step request declined", r.final.type === "task.failed" && /one thing at a time/.test(text(r.final)));

  // ---- 3. multi-agent: find a folder, then open it in VS Code
  const scratch = "D:\\dev-cache\\vsc-parent\\Zebra Quartz Folder";
  fs.mkdirSync(scratch, { recursive: true });
  r = await ask("open zebra quartz folder in vs code", true);
  check("asked before opening in VS Code", r.asked);
  check("VS Code window verified", r.final.type === "task.completed" && r.final.verified === true, text(r.final));
  const code = (await windows()).find((w) => /^code$/i.test(w.process) && /zebra quartz folder/i.test(w.title));
  check("a VS Code window shows that folder", !!code);
  if (code) {
    r = await ask("close zebra quartz folder", true);
    check("that window closed", r.final.type === "task.completed");
  }

  // ---- 4. browser windows, tabs, pages (counts only: titles redacted)
  r = await ask("what tabs are open in chrome", undefined, redact);
  if (r.final.type === "task.failed") {
    console.log("   (no readable Chrome window: that is fine)");
  } else {
    check("tabs listed, windows and tabs told apart", /\b\d+ browser windows?\b/.test(text(r.final)) && /\b\d+ tabs?\b/.test(text(r.final)));
  }
  r = await ask("what page am i on", undefined, redact);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log("agent calls:", { apps: session.appAgent.calls, ui: session.uiAgent.calls, actions: session.actionAgent.calls });
  session.dispose();
})().catch((e) => console.log("ERROR", e)).finally(() => process.exit(0));
