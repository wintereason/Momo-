// Real end-to-end check of Momo's actions against a harmless test window it creates itself.
//   node scripts/smoke-actions.cjs
// Nothing here touches any other window. The test window closes itself after ~150 s.
const { spawn } = require("child_process");
const path = require("path");
const { createRuntime, nodeWindows } = require("../electron/runtime.cjs");

const TITLE = "Momo Test Window";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { (ok ? pass++ : fail++); console.log(`   ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };

async function findWindow() {
  for (let i = 0; i < 30; i++) {
    const snap = await nodeWindows.query();
    const w = snap.windows.find((x) => x.title === TITLE);
    if (w) return w;
    await sleep(500);
  }
  return null;
}

(async () => {
  child = spawn("powershell.exe", ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "test-window.ps1"), "-Seconds", "400"], { stdio: "ignore", windowsHide: false });
  const w = await findWindow();
  if (!w) { console.log("could not start the test window"); return; }
  console.log(`test window: hwnd=${w.hwnd} pid=${w.pid}\n`);

  const events = [];
  const session = createRuntime({
    selfPids: () => [process.pid],
    foreground: { lastExternal: () => ({ hwnd: w.hwnd, pid: w.pid, title: TITLE }) },
    emit: (e) => events.push(e),
  });
  session.setPolicy({ confirmScreenRead: false });
  const last = () => events[events.length - 1];
  const summaryOf = (e) => e && (e.summary || e.question || e.message || "");

  /** say something; optionally answer the confirmation. Returns the final event. */
  async function ask(text, approve) {
    // never carry on if the test window is gone: the runtime could otherwise fall back to whatever window is in front
    if (!(await session.actionAgent.state(w.hwnd)).exists && !/close/.test(text)) throw new Error("the test window disappeared: aborting before touching any other window");
    console.log(`"${text}"`);
    events.length = 0;
    await session.handleTranscript("smoke", text);
    const conf = events.find((e) => e.type === "task.confirmation_required");
    if (conf) {
      console.log(`   ? ${conf.summary}`);
      if (approve === undefined) return last();
      await session.respondConfirmation(conf.taskId, approve);
    }
    const e = last();
    console.log(`   → ${e.type}${e.state ? "/" + e.state : ""}: ${summaryOf(e)}`);
    return { final: e, asked: !!conf, events: [...events] };
  }
  const read = async () => (await session.uiAgent.read(w.hwnd)).items || [];
  const textOf = (items, type, name) => items.find((i) => i.type === type && (name ? i.name === name : true));

  // 1. click a harmless button
  let r = await ask("click the click me button", true);
  check("asked before clicking", r.asked);
  check("click reported as verified", r.final.type === "task.completed" && r.final.verified === true);
  let items = await read();
  check("the window really changed", items.some((i) => i.type === "Text" && /Clicked 1 times/.test(i.name)));

  // 2. type text
  r = await ask("type hello world in the search box", true);
  check("typing reported as verified", r.final.type === "task.completed");
  items = await read();
  check("the field really contains the text", items.some((i) => i.type === "Edit" && i.value === "hello world"));

  // 3. a risky label ALWAYS asks, even when the general policy is relaxed
  session.setPolicy({ confirmReversible: false });
  r = await ask("click the delete everything button", false);
  check("risky button asked even with reversible-asking off", r.asked);
  items = await read();
  check("declining did nothing", !items.some((i) => /DELETE CLICKED/.test(i.name)));
  r = await ask("click the delete everything button", true);
  items = await read();
  check("after approval it happened", items.some((i) => /DELETE CLICKED/.test(i.name)));
  session.setPolicy({ confirmReversible: true });

  // 4. things that must be refused
  r = await ask("click the locked button", true);
  check("disabled button refused", r.final.type === "task.failed" && /disabled/i.test(summaryOf(r.final)));
  r = await ask("type secret in the password box", true);
  check("password field refused", r.final.type === "task.failed" && /password/i.test(summaryOf(r.final)));
  items = await read();
  check("password box untouched", !items.some((i) => i.value === "secret"));
  r = await ask("click the nonexistent thing button", true);
  check("unknown control reported honestly", r.final.type === "task.failed");

  // 5. a checkbox (toggle pattern, verified by its state change)
  r = await ask("click the enable thing checkbox", true);
  check("checkbox toggled and verified", r.final.type === "task.completed");
  items = await read();
  check("checkbox is now on", items.some((i) => i.type === "CheckBox" && i.state === "on"));

  // 6. window actions, verified with Windows itself
  r = await ask("minimize momo test window", true);
  check("minimize verified", r.final.type === "task.completed");
  check("window really minimized", (await nodeWindows.query(), (await session.actionAgent.state(w.hwnd)).minimized === true));
  r = await ask("switch to momo test window", true);
  console.log(`   (focus result: ${r.final.type}${r.final.state ? "/" + r.final.state : ""})`);
  check("focus either verified or honestly reported", r.final.type === "task.completed" || (r.final.type === "task.state" && r.final.state === "partial_success"));
  const st = await session.actionAgent.state(w.hwnd);
  check("window is no longer minimized", st.minimized === false);

  // 7. closing always asks, then closes
  r = await ask("close momo test window", true);
  check("close asked first", r.asked);
  check("close verified", r.final.type === "task.completed");
  check("window really gone", (await session.actionAgent.state(w.hwnd)).exists === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log("actions performed by the runtime:", session.actionAgent.calls);
  session.dispose();
})().catch((e) => console.log("ERROR", e)).finally(() => { try { child && child.kill(); } catch {} process.exit(0); });
