import { runPowerShell } from "../shared/nodePorts";
import type { ActResult, InputPort, SetTextResult, WindowState } from "../shared/ports";

/**
 * Real window and control actions (Windows). Every script is FIXED text; the target and any text to
 * type arrive as JSON on stdin and are only ever used as data. Controls are found by their UI
 * Automation runtime id and re-checked (name, enabled, not a password box) immediately before acting.
 */

const WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($code) { '{"ok":false,"error":"' + $code + '"}'; exit 0 }
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MomoInput {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
  $h = [IntPtr][long]$req.hwnd
  $exists = [MomoInput]::IsWindow($h)
  $mode = [string]$req.mode
  if ($mode -ne 'state' -and -not $exists) { Fail 'gone' }
  if ($mode -eq 'focus') {
    if ([MomoInput]::IsIconic($h)) { [void][MomoInput]::ShowWindow($h, 9) }
    # Windows only lets the foreground process change the foreground: a quick Alt tap makes the request legitimate
    [MomoInput]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [MomoInput]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][MomoInput]::BringWindowToTop($h)
    [void][MomoInput]::SetForegroundWindow($h)
    '{"ok":true}'
  } elseif ($mode -eq 'minimize') {
    [void][MomoInput]::ShowWindow($h, 6)
    '{"ok":true}'
  } elseif ($mode -eq 'close') {
    [void][MomoInput]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    '{"ok":true}'
  } elseif ($mode -eq 'state') {
    $pid1 = [uint32]0
    if ($exists) { [void][MomoInput]::GetWindowThreadProcessId($h, [ref]$pid1) }
    $fg = [MomoInput]::GetForegroundWindow()
    $pid2 = [uint32]0
    [void][MomoInput]::GetWindowThreadProcessId($fg, [ref]$pid2)
    '{"ok":true,"exists":' + $(if ($exists) { 'true' } else { 'false' }) + ',"minimized":' + $(if ($exists -and [MomoInput]::IsIconic($h)) { 'true' } else { 'false' }) + ',"pid":' + [int]$pid1 + ',"fgPid":' + [int]$pid2 + '}'
  } else { Fail 'bad_mode' }
} catch {
  '{"ok":false,"error":"failed"}'
}
`;

const CONTROL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($code) { '{"ok":false,"error":"' + $code + '"}'; exit 0 }
function J($s) { ([string]$s) -replace '[\x00-\x1f]', ' ' -replace '\\', '\\' -replace '"', '\"' }
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$req.hwnd)
  $rid = [int[]](([string]$req.rid) -split '\.')
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::RuntimeIdProperty, $rid)
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if (-not $el) { Fail 'not_found' }
  $c = $el.Current
  # the control must still be exactly what the user was shown and agreed to
  if ([string]$c.Name -ne [string]$req.name) { Fail 'changed' }
  if (-not $c.IsEnabled) { Fail 'disabled' }
  if ($c.IsOffscreen) { Fail 'offscreen' }
  $isPwd = $false
  try { $isPwd = [bool]$c.IsPassword } catch {}
  if ($isPwd) { Fail 'password' }
  $mode = [string]$req.mode
  $pat = $null
  if ($mode -eq 'invoke') {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke() }
    elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) { $pat.Toggle() }
    elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) { $pat.Select() }
    elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) { $pat.Expand() }
    else { Fail 'no_pattern' }
    '{"ok":true}'
  } elseif ($mode -eq 'settext') {
    if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) { Fail 'no_pattern' }
    if ($pat.Current.IsReadOnly) { Fail 'readonly' }
    $pat.SetValue([string]$req.text)
    $back = [string]$pat.Current.Value
    '{"ok":true,"value":"' + (J $back) + '"}'
  } else { Fail 'bad_mode' }
} catch {
  '{"ok":false,"error":"failed"}'
}
`;

const validHwnd = (h: number) => Number.isSafeInteger(h) && h > 0;
const validRid = (r: string) => /^-?\d+(\.-?\d+)*$/.test(r) && r.length <= 200;

const CONTROL_REASONS: Record<string, string> = {
  not_found: "that control isn't there any more",
  changed: "that control has changed since I found it",
  disabled: "that control is disabled",
  offscreen: "that control isn't visible",
  password: "that is a password field, which I never touch",
  no_pattern: "that control doesn't let other programs use it",
  readonly: "that field is read-only",
  failed: "Windows wouldn't let me do that",
};
const WINDOW_REASONS: Record<string, string> = {
  gone: "that window has closed",
  failed: "Windows wouldn't let me do that",
};

interface RawAct { ok: boolean; error?: string; value?: string; exists?: boolean; minimized?: boolean; pid?: number; fgPid?: number }

async function windowCall(mode: string, hwnd: number): Promise<RawAct> {
  return runPowerShell<RawAct>(WINDOW_SCRIPT, 15_000, JSON.stringify({ mode, hwnd }));
}
const windowAct = async (mode: "focus" | "minimize" | "close", hwnd: number): Promise<ActResult> => {
  if (!validHwnd(hwnd)) return { ok: false, reason: "that isn't a valid window" };
  try {
    const r = await windowCall(mode, hwnd);
    return r.ok ? { ok: true } : { ok: false, reason: WINDOW_REASONS[r.error ?? ""] ?? WINDOW_REASONS.failed };
  } catch {
    return { ok: false, reason: "Windows didn't answer in time" };
  }
};

/** Real window and control actions. */
export const nodeInput: InputPort = {
  focusWindow: (h) => windowAct("focus", h),
  minimizeWindow: (h) => windowAct("minimize", h),
  closeWindow: (h) => windowAct("close", h),

  async windowState(hwnd: number): Promise<WindowState> {
    if (!validHwnd(hwnd)) return { exists: false, minimized: false, pid: 0, foregroundPid: null };
    try {
      const r = await windowCall("state", hwnd);
      return { exists: !!r.exists, minimized: !!r.minimized, pid: r.pid ?? 0, foregroundPid: r.fgPid && r.fgPid > 0 ? r.fgPid : null };
    } catch {
      return { exists: false, minimized: false, pid: 0, foregroundPid: null };
    }
  },

  async invokeControl(hwnd: number, rid: string, expectName: string): Promise<ActResult> {
    if (!validHwnd(hwnd) || !validRid(rid)) return { ok: false, reason: "I can't identify that control" };
    try {
      const r = await runPowerShell<RawAct>(CONTROL_SCRIPT, 20_000, JSON.stringify({ mode: "invoke", hwnd, rid, name: expectName }));
      return r.ok ? { ok: true } : { ok: false, reason: CONTROL_REASONS[r.error ?? ""] ?? CONTROL_REASONS.failed };
    } catch {
      return { ok: false, reason: "Windows didn't answer in time" };
    }
  },

  async setControlText(hwnd: number, rid: string, expectName: string, text: string): Promise<SetTextResult> {
    if (!validHwnd(hwnd) || !validRid(rid)) return { ok: false, reason: "I can't identify that field" };
    try {
      const r = await runPowerShell<RawAct>(CONTROL_SCRIPT, 20_000, JSON.stringify({ mode: "settext", hwnd, rid, name: expectName, text }));
      return r.ok ? { ok: true, readBack: String(r.value ?? "") } : { ok: false, reason: CONTROL_REASONS[r.error ?? ""] ?? CONTROL_REASONS.failed };
    } catch {
      return { ok: false, reason: "Windows didn't answer in time" };
    }
  },
};

// ---------------------------------------------------------------- dictation: is the field being typed into a password box?

const FOCUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $el = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $el) { '{"ok":true,"password":false,"known":false}'; exit 0 }
  $pw = [bool]$el.Current.IsPassword
  '{"ok":true,"password":' + $pw.ToString().ToLower() + ',"known":true}'
} catch { '{"ok":false}' }
`;

/**
 * Is the field that has the keyboard focus a password box? Dictated text must never be typed into one.
 * "unknown" means Windows could not say; the caller decides (Momo then still types, because most apps do not
 * expose this, but it never types when the answer is "yes").
 */
export async function focusedFieldIsPassword(): Promise<"yes" | "no" | "unknown"> {
  try {
    const r = await runPowerShell<{ ok: boolean; password?: boolean; known?: boolean }>(FOCUS_SCRIPT, 8000);
    if (!r.ok || !r.known) return "unknown";
    return r.password ? "yes" : "no";
  } catch {
    return "unknown";
  }
}
