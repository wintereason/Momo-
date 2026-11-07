import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runPowerShell } from "../shared/nodePorts";
import type { ActResult, AppEntry, AppsPort, BrowserKey, BrowserProfile, LaunchPort } from "../shared/ports";
import { isProfileDir, parseProfiles } from "./profiles";

/** Start-menu application ids look like "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" or "Chrome". */
const APP_ID = /^[A-Za-z0-9._!{}\-;+ ]{1,200}$/;

const APPS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function J($s) { ([string]$s) -replace '[\x00-\x1f]', ' ' -replace '\\', '\\' -replace '"', '\"' }
try {
  $apps = @(Get-StartApps | Sort-Object Name)
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($a in $apps) { $parts.Add('{"n":"' + (J $a.Name) + '","i":"' + (J $a.AppID) + '"}') }
  '{"ok":true,"apps":[' + ($parts -join ',') + ']}'
} catch {
  '{"ok":false}'
}
`;

/** The installed apps, exactly as the Start menu lists them (classic and Store apps). */
export const nodeApps: AppsPort = {
  async list(): Promise<AppEntry[]> {
    const raw = await runPowerShell<{ ok: boolean; apps?: { n: string; i: string }[] }>(APPS_SCRIPT, 45_000);
    if (!raw.ok) throw new Error("app list unavailable");
    const list = Array.isArray(raw.apps) ? raw.apps : [];
    return list
      .filter((a) => a && typeof a.n === "string" && typeof a.i === "string" && a.n.trim() && APP_ID.test(a.i))
      .map((a) => ({ name: a.n.trim(), id: a.i }));
  },
};

/** Start a program detached from Momo. Arguments are passed as data: no shell is ever involved. */
function spawnDetached(command: string, args: string[]): Promise<ActResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false, shell: false });
      child.once("error", () => resolve({ ok: false, reason: "Windows couldn't start it." }));
      child.once("spawn", () => { child.unref(); resolve({ ok: true }); });
    } catch {
      resolve({ ok: false, reason: "Windows couldn't start it." });
    }
  });
}

function findVsCode(): string | null {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => path.basename(p) === "Code.exe" && fs.existsSync(p)) ?? null;
}

/** Where each browser keeps its settings, and where its program usually is. Fixed lists: nothing here comes from speech. */
function browserPaths(b: BrowserKey): { localState: string | null; exes: string[] } {
  const local = process.env.LOCALAPPDATA ?? "";
  const pf = process.env.ProgramFiles ?? "";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "";
  const join = (base: string, ...p: string[]) => (base ? path.join(base, ...p) : "");
  const table = {
    chrome: { data: join(local, "Google", "Chrome", "User Data", "Local State"), exes: [join(pf, "Google", "Chrome", "Application", "chrome.exe"), join(pf86, "Google", "Chrome", "Application", "chrome.exe"), join(local, "Google", "Chrome", "Application", "chrome.exe")] },
    msedge: { data: join(local, "Microsoft", "Edge", "User Data", "Local State"), exes: [join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), join(pf, "Microsoft", "Edge", "Application", "msedge.exe")] },
    brave: { data: join(local, "BraveSoftware", "Brave-Browser", "User Data", "Local State"), exes: [join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), join(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")] },
  } as const;
  const t = table[b];
  return { localState: t.data || null, exes: t.exes.filter(Boolean) };
}

export const nodeLaunch: LaunchPort = {
  async browserProfiles(browser: BrowserKey): Promise<BrowserProfile[]> {
    const { localState } = browserPaths(browser);
    if (!localState) return [];
    try {
      const st = fs.statSync(localState);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) return [];
      return parseProfiles(JSON.parse(fs.readFileSync(localState, "utf8")));
    } catch {
      return []; // no such browser, or an unreadable file: Momo then just opens the browser normally
    }
  },

  async openBrowserProfile(browser: BrowserKey, profileDir: string | null, url?: string): Promise<ActResult> {
    if (profileDir !== null && !isProfileDir(profileDir)) return { ok: false, reason: "That isn't a profile I can open." };
    let address: string | null = null;
    if (url !== undefined) {
      try {
        const u = new URL(url);
        if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) throw new Error("not web");
        address = u.toString(); // starts with http(s)://, so the browser can never read it as an option
      } catch { return { ok: false, reason: "I only open plain http and https addresses." }; }
    }
    const exe = browserPaths(browser).exes.find((p) => fs.existsSync(p));
    if (!exe) return { ok: false, reason: "I couldn't find that browser on this PC." };
    const args = [...(profileDir !== null ? ["--profile-directory=" + profileDir] : []), ...(address ? [address] : [])]; // the profile name is checked above: it can only be Default or Profile N
    return spawnDetached(exe, args);
  },

  async launchApp(id: string): Promise<ActResult> {
    if (!APP_ID.test(id)) return { ok: false, reason: "That isn't a valid app id." };
    // explorer.exe starts the app through the Start-menu id; its exit code is meaningless, so success = it started
    return spawnDetached("explorer.exe", ["shell:AppsFolder\\" + id]);
  },

  async openFolderInVsCode(folder: string): Promise<ActResult> {
    const code = findVsCode();
    if (!code) return { ok: false, reason: "I couldn't find Visual Studio Code on this PC." };
    return spawnDetached(code, [folder]); // the folder starts with a drive letter, so it can never be read as an option
  },

  async openUrl(url: string): Promise<ActResult> {
    let u: URL;
    try { u = new URL(url); } catch { return { ok: false, reason: "That isn't a valid web address." }; }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) {
      return { ok: false, reason: "I only open plain http and https addresses." };
    }
    return spawnDetached("rundll32.exe", ["url.dll,FileProtocolHandler", u.toString()]);
  },
};
