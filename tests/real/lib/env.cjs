"use strict";
// Environment facts for the report and for the baseline comparison. Read-only; creates no windows.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { psq } = require("./ps.cjs");
const P = require("./paths.cjs");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : "",
].filter(Boolean);

// MOMO_REAL_PRETEND_NO_CHROME=1 is a hook for validating the runner's skip policy without starting anything: Chrome is reported as not found.
function findChrome() { if (process.env.MOMO_REAL_PRETEND_NO_CHROME === "1") return null; return CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null; }

/** newest modification time (ms) among the files the bundled runtime is built from */
function newestSource() {
  const roots = [path.join(P.ROOT, "src", "runtime-core"), path.join(P.ROOT, "electron", "humanInput.cjs"), path.join(P.ROOT, "scripts", "build-runtime.mjs")];
  let newest = 0;
  const walk = (p) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); return; }
    if (/\.test\.ts$/.test(p)) return;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  roots.forEach(walk);
  return newest;
}

function runtimeState() {
  let st = null; try { st = fs.statSync(P.RUNTIME); } catch { /* missing */ }
  if (!st) return { present: false, fresh: false };
  return { present: true, fresh: st.mtimeMs >= newestSource() - 1000 };
}

/** display facts (a DPI-aware PowerShell, so sizes are physical pixels) */
function displays() {
  try {
    const j = psq(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class D8 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'; [void][D8]::SetProcessDPIAware(); $s = [System.Windows.Forms.Screen]::PrimaryScreen; $d = [pscustomobject]@{ monitors = [System.Windows.Forms.Screen]::AllScreens.Count; w = $s.Bounds.Width; h = $s.Bounds.Height; wx = $s.WorkingArea.X; wy = $s.WorkingArea.Y; ww = $s.WorkingArea.Width; wh = $s.WorkingArea.Height }; $d | ConvertTo-Json -Compress`);
    const d = JSON.parse(j);
    // logical size, as an unaware process sees it, gives the scale
    const l = JSON.parse(psq(`Add-Type -AssemblyName System.Windows.Forms; $s = [System.Windows.Forms.Screen]::PrimaryScreen; [pscustomobject]@{ w = $s.Bounds.Width } | ConvertTo-Json -Compress`));
    return { monitors: d.monitors, physicalWidth: d.w, physicalHeight: d.h, workArea: { x: d.wx, y: d.wy, w: d.ww, h: d.wh }, scale: l.w ? Math.round((d.w / l.w) * 100) / 100 : 1 };
  } catch { return { monitors: null, physicalWidth: null, physicalHeight: null, scale: null }; }
}

function chromeVersion(exe) {
  if (!exe) return null;
  try { return psq(`(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`); } catch { return null; }
}

function gather() {
  const exe = findChrome();
  return {
    os: `${os.type()} ${os.release()}`, node: process.version, arch: process.arch,
    powershell: (() => { try { return psq("$PSVersionTable.PSVersion.ToString()"); } catch { return null; } })(),
    ...displays(),
    chrome: exe ? chromeVersion(exe) : null, chromePath: exe, // the path is used by the launcher and never written to the report
  };
}

/** the same, without the local path, for the report */
const forReport = (env) => { const { chromePath, ...rest } = env; return { ...rest, chromeFound: !!chromePath }; };

module.exports = { gather, forReport, findChrome, runtimeState, newestSource };
