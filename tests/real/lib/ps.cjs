"use strict";
// Windows process helpers (PowerShell 5.1 + taskkill). Everything here is read-only except killTree, which the cleanup ledger calls
// ONLY for process ids it created itself or found by this run's unique id on the command line.
const { execFileSync, spawnSync } = require("child_process");

function psq(script, opts = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 60_000, ...opts }).trim();
}

/** Processes whose COMMAND LINE contains `needle` (never our own pid or the PowerShell asking). Returns [{ pid, name }]. */
function pidsByCommandLine(needle) {
  if (!needle || String(needle).length < 8) throw new Error("refusing to search processes by a short needle");
  const safe = String(needle).replace(/'/g, "''");
  let out = "";
  try {
    out = psq(`$me = $PID; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${safe}') -and $_.ProcessId -ne $me } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name } } | ConvertTo-Json -Compress`);
  } catch { return []; }
  if (!out) return [];
  const j = JSON.parse(out);
  return (Array.isArray(j) ? j : [j]).filter((p) => p.pid !== process.pid);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

/** Kill a process and its children. Synchronous on purpose: it must also work inside an 'exit' handler. */
function killTree(pid) {
  if (!pid || pid === process.pid) return false;
  const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  return r.status === 0;
}

module.exports = { psq, pidsByCommandLine, isAlive, killTree };
