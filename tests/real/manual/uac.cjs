#!/usr/bin/env node
"use strict";
// USER-RUN test: what does Momo do while a Windows UAC (administrator approval) prompt is open?
// Run it yourself:   node tests/real/manual/uac.cjs --i-understand
const { guard, confirmTyped } = require("../lib/manualkit.cjs");

const USAGE = `Usage: node tests/real/manual/uac.cjs --i-understand

Opens one of the suite's own test windows, then asks Windows to start a HARMLESS elevated command (cmd /c title ... & exit). Windows shows the UAC prompt.
YOU click "No" (or close it). While the prompt is open, and afterwards, the script only READS: window list, UI Automation read, pop-up/secure-window scan,
a capture of its own test window, the helper's heartbeat. It sends no mouse or keyboard input, never approves anything, never types credentials.
Reports: whether Momo's machinery hung, whether the secure prompt was recognised, and whether everything came back afterwards.
If you approve the prompt by mistake, only the harmless command above runs.`;

guard({ usage: USAGE, flag: "--i-understand", what: "shows a real Windows UAC prompt on your screen" });

(async () => {
  const ok = await confirmTyped("UAC", "A Windows administrator-approval (UAC) prompt will appear on your screen in a few seconds.\nDO NOT approve it: click No (or close it). The test is about how Momo behaves while the prompt is open.");
  if (!ok) { console.log("Cancelled. Nothing was started."); return 0; }
  const { spawn } = require("child_process");
  const { scenario } = require("../lib/scenario.cjs");
  return scenario({
    name: "uac", maxMs: 300_000, intervalMs: 700,
    instructions: "The UAC prompt appears now. Click NO (or close it). Do not approve it. Waiting for your answer ...",
    async trigger({ runId, ledger }) {
      let exitCode = null;
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '/c title ${runId}& exit' -Verb RunAs -WindowStyle Hidden`], { stdio: "ignore", windowsHide: true });
      ledger.track(child.pid);
      child.on("exit", (c) => { exitCode = c; });
      return {
        isOver: () => exitCode !== null,
        describe: () => exitCode === 0 ? "You APPROVED the prompt (the harmless command ran). Next time please click No: the test is about refusal." : "The prompt was declined or closed, as intended.",
        extra: () => ({ answered: exitCode === 0 ? "approved" : "declined" }),
      };
    },
    notes: (during) => [during.secureSeen ? "the secure prompt was visible to Momo's scan and counted, never read" : "the prompt was NOT visible to Momo's scan (a UAC prompt lives on the separate secure desktop, so this is expected); what matters is that nothing hung and nothing was clicked"],
  });
})().then((c) => process.exit(c || 0)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
