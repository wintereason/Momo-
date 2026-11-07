// Real check: does Momo's UIA read recognise legacy password boxes?
const { spawn } = require("child_process");
const path = require("path");
const { nodeWindows, nodeScreen } = require("../electron/runtime.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const child = spawn("powershell.exe", ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "test-window-legacy.ps1"), "-Seconds", "45"], { stdio: "ignore" });
  let w = null;
  for (let i = 0; i < 30 && !w; i++) { w = (await nodeWindows.query()).windows.find((x) => x.title === "Momo Legacy Window"); if (!w) await sleep(500); }
  const t = Date.now();
  const r = await nodeScreen.readUi(w.hwnd);
  console.log("read ok:", r.ok, "ms:", Date.now() - t);
  for (const i of r.items || []) {
    const leaked = /secret/.test(i.name) || /secret/.test(i.value || "");
    console.log(JSON.stringify({ type: i.type, password: i.password, nameHasSecret: /secret/.test(i.name), valueHasSecret: /secret/.test(i.value || "") }), leaked && !i.password ? "  <-- LEAK (not flagged)" : "");
  }
  const flagged = (r.items || []).filter((i) => /secret/.test(i.name) || /secret/.test(i.value || ""));
  console.log("items containing a secret:", flagged.length, "| all flagged as password:", flagged.every((i) => i.password));
  child.kill();
  process.exit(0);
})();
