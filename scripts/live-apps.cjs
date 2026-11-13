// LIVE check of smart application management on REAL Windows apps (Calculator, File Explorer, Notepad). It opens a few windows of its own,
// moves them around (behind, minimized, maximized, several windows) and asks Momo's open_app to deal with each case. After every case
// it asks Windows itself what happened (how many windows, which is in front, minimized or not). Everything it opened is closed at the end.
//   npm run build:runtime && node scripts/live-apps.cjs        (hands off the keyboard and mouse while it runs)
const { spawn, spawnSync } = require("child_process");
const rt = require("../electron/runtime.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };

const snap = () => rt.nodeWindows.query();
const ofApp = (s, re) => s.windows.filter((w) => re.test(w.process) || re.test(w.title));
const state = (w, s) => (w.minimized ? "minimized" : w.maximized ? "maximized" : "normal") + (w.hwnd === s.activeHwnd ? "+front" : "");

// win32 helpers through PowerShell (maximize / minimize any window by handle)
function showWindow(hwnd, cmd) {
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class W { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }'; [void][W]::ShowWindow([IntPtr]${hwnd}, ${cmd})`], { windowsHide: true });
}
const SW_MAXIMIZE = 3, SW_MINIMIZE = 6;

/** run open_app (and answer a "which window?" question with `pick`) through the real Session */
async function openApp(args, pick) {
  const events = [];
  const texts = [];
  let step = 0;
  const ai = {
    ready: () => true, label: () => "local stand-in", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 999 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_g, steps) {
      const l = steps[steps.length - 1];
      if (l) texts.push(`${l.outcome}: ${l.text}`);
      return { ok: true, decision: step++ === 0 ? { type: "tool", tool: "open_app", args } : { type: "done", answer: "ok" }, source: "local" };
    },
  };
  const session = new rt.Session({
    fs: rt.nodeFs, win: rt.nodeWindows, screen: rt.nodeScreen, input: rt.nodeInput, apps: rt.nodeApps, launch: rt.nodeLaunch,
    act: { openPath: async () => "no" }, emit: (e) => events.push(e), selfPids: () => [], ai, verifyAttempts: 3, // no pointer: window handling only
  });
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  await session.handleTranscript("live", "open " + args.app);
  let asked = events.filter((e) => e.type === "task.clarification_required").pop();
  if (asked && pick) {
    const opt = (asked.options || []).findIndex((o) => pick(o));
    if (opt >= 0) await session.handleTranscript("live", String(opt + 1));
  }
  return { events, texts, asked, session };
}

async function waitFor(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(300); } return null; }
const opened = [];

(async () => {
  console.log("=== Smart application management, on real Windows apps ===\n");
  const before = await snap();
  const calcBefore = ofApp(before, /^calculator/i).length;
  const explorerBefore = new Set(ofApp(before, /^explorer$/i).map((w) => w.hwnd));

  // ---- set the stage: a Calculator and two File Explorer windows of ours, plus Notepad
  spawn("calc.exe", [], { detached: true, stdio: "ignore" }).unref();
  const calc = await waitFor(async () => (await snap()).windows.find((w) => /^calculator$/i.test(w.title) && !before.windows.some((b) => b.hwnd === w.hwnd)));
  if (!calc) { console.log("could not start Calculator; aborting"); process.exit(1); }
  opened.push(calc.hwnd);
  spawn("explorer.exe", ["C:\\Windows"], { detached: true, stdio: "ignore" }).unref();
  const exA = await waitFor(async () => (await snap()).windows.find((w) => /^explorer$/i.test(w.process) && /Windows/.test(w.title) && !explorerBefore.has(w.hwnd)));
  spawn("explorer.exe", ["C:\\Windows\\System32"], { detached: true, stdio: "ignore" }).unref();
  const exB = await waitFor(async () => (await snap()).windows.find((w) => /^explorer$/i.test(w.process) && /System32/.test(w.title) && !explorerBefore.has(w.hwnd)));
  if (exA) opened.push(exA.hwnd);
  if (exB) opened.push(exB.hwnd);
  spawn("notepad.exe", [], { detached: true, stdio: "ignore" }).unref();
  const note = await waitFor(async () => (await snap()).windows.find((w) => /notepad/i.test(w.process) && !before.windows.some((b) => b.hwnd === w.hwnd)));
  if (note) opened.push(note.hwnd);
  await sleep(800);
  console.log(`stage: Calculator ${calc.hwnd}, Explorer A ${exA && exA.hwnd} (${exA && exA.title}), Explorer B ${exB && exB.hwnd} (${exB && exB.title}), Notepad ${note && note.hwnd}\n`);

  // ---- 1. BEHIND other windows: Notepad is in front, Calculator is behind
  await rt.nodeInput.focusWindow(note.hwnd); await sleep(700);
  let s = await snap();
  console.log("1. Calculator is behind Notepad:", state(s.windows.find((w) => w.hwnd === calc.hwnd), s));
  let r = await openApp({ app: "Calculator" });
  s = await snap();
  const calcs1 = ofApp(s, /^calculator$/i).filter((w) => !before.windows.some((b) => b.hwnd === w.hwnd));
  check("behind -> brought to the front, no duplicate", s.activeHwnd === calc.hwnd && calcs1.length === 1, `front=${s.activeHwnd === calc.hwnd}, my calculator windows=${calcs1.length}; ${r.texts[0]}`);

  // ---- 2. MINIMIZED
  showWindow(calc.hwnd, SW_MINIMIZE); await sleep(900);
  s = await snap();
  console.log("2. Calculator minimized:", state(s.windows.find((w) => w.hwnd === calc.hwnd), s));
  await rt.nodeInput.focusWindow(note.hwnd); await sleep(600);
  r = await openApp({ app: "Calculator" });
  s = await snap();
  const c2 = s.windows.find((w) => w.hwnd === calc.hwnd);
  check("minimized -> restored and in front, no duplicate", c2 && !c2.minimized && s.activeHwnd === calc.hwnd && ofApp(s, /^calculator$/i).filter((w) => !before.windows.some((b) => b.hwnd === w.hwnd)).length === 1, `${c2 && state(c2, s)}; ${r.texts[0]}`);

  // ---- 3. MAXIMIZED, then another window on top
  showWindow(note.hwnd, SW_MAXIMIZE); await sleep(900);
  await rt.nodeInput.focusWindow(calc.hwnd); await sleep(700);
  s = await snap();
  console.log("3. Notepad maximized, Calculator in front:", state(s.windows.find((w) => w.hwnd === note.hwnd), s), "/", state(s.windows.find((w) => w.hwnd === calc.hwnd), s));
  r = await openApp({ app: "Notepad" });
  s = await snap();
  const n3 = s.windows.find((w) => w.hwnd === note.hwnd);
  check("maximized + behind -> in front and STILL maximized", n3 && n3.maximized && s.activeHwnd === note.hwnd, `${n3 && state(n3, s)}; ${r.texts[0]}`);

  // ---- 4. ALREADY in front: nothing to do
  r = await openApp({ app: "Notepad" });
  s = await snap();
  check("already in front -> nothing touched", /already open and in front/.test(r.texts[0] || "") && s.activeHwnd === note.hwnd, r.texts[0]);

  // ---- 5. SEVERAL windows (two File Explorers of ours + the user's own), none in front: it must ASK
  await rt.nodeInput.focusWindow(calc.hwnd); await sleep(600);
  const exBefore5 = ofApp(await snap(), /^explorer$/i).length;
  r = await openApp({ app: "File Explorer" }, (o) => /System32/.test(o.label));
  s = await snap();
  const asked = r.asked;
  check("several windows, none in front -> asks which", !!asked && (asked.options || []).length >= 2, asked ? (asked.options || []).map((o) => `${o.label.slice(0, 30)} [${o.detail}]`).join(" | ") : "no question was asked");
  const b5 = s.windows.find((w) => w.hwnd === exB.hwnd);
  check("...and the window it was told to use is now in front", !!b5 && s.activeHwnd === exB.hwnd, b5 && state(b5, s));
  check("...and no extra Explorer window was started", ofApp(s, /^explorer$/i).length === exBefore5, `${exBefore5} -> ${ofApp(s, /^explorer$/i).length}`);

  // ---- 6. a minimized one among several, picked by a hint in the request (no question)
  showWindow(exA.hwnd, SW_MINIMIZE); await sleep(800);
  await rt.nodeInput.focusWindow(calc.hwnd); await sleep(600);
  r = await openApp({ app: "File Explorer", window: "C:\\Windows".replace("C:\\", "") === "Windows" ? "Windows" : "Windows" });
  s = await snap();
  // "Windows" matches both of ours ("Windows" and "System32" is not): only the C:\Windows one has that exact word in its title
  const a6 = s.windows.find((w) => w.hwnd === exA.hwnd);
  check("hint in the request picks the window without asking, and restores it", !r.asked ? (a6 && !a6.minimized && s.activeHwnd === exA.hwnd) : false, a6 ? `${state(a6, s)}${r.asked ? " (asked instead)" : ""}` : "window gone");

  // ---- 7. NOT RUNNING: close Calculator, then open it: a launch is right
  await rt.nodeInput.closeWindow(calc.hwnd); await sleep(1500);
  s = await snap();
  const calcGone = !s.windows.some((w) => w.hwnd === calc.hwnd);
  r = await openApp({ app: "Calculator" });
  await sleep(1500);
  s = await snap();
  const newCalc = ofApp(s, /^calculator$/i).filter((w) => !before.windows.some((b) => b.hwnd === w.hwnd));
  check("not running -> launched (exactly one new window)", calcGone && newCalc.length === 1, `closed=${calcGone}; windows now=${newCalc.length}; ${r.texts[0]}`);
  for (const w of newCalc) opened.push(w.hwnd);

  // ---- 8. newWindow:true makes a second copy only when asked
  const exN = ofApp(await snap(), /^explorer$/i).length;
  r = await openApp({ app: "File Explorer", newWindow: true });
  await sleep(2500);
  s = await snap();
  const exN2 = ofApp(s, /^explorer$/i);
  check("explicit new window -> one more File Explorer window", exN2.length === exN + 1, `${exN} -> ${exN2.length}`);
  for (const w of exN2) if (!explorerBefore.has(w.hwnd) && !opened.includes(w.hwnd)) opened.push(w.hwnd);

  // ---- clean up everything this script opened
  for (const h of opened) { try { await rt.nodeInput.closeWindow(h); } catch { /* gone */ } }
  await sleep(1200);
  console.log("\n=== " + results.filter((x) => x.pass).length + " of " + results.length + " checks passed ===");
  process.exit(results.every((x) => x.pass) ? 0 : 1);
})().catch((e) => { console.log("ERROR", e); process.exit(2); });
