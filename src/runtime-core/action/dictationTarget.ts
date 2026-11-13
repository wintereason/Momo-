import { runPowerShell } from "../shared/nodePorts";

/**
 * Dictation targeting (Windows UI Automation): find the editable field in the app the user is in, focus it, and check that
 * the text really arrived. Rule: Detect -> Identify -> Focus -> Dictate -> Verify. Never type into an unidentified field.
 *
 * Every PowerShell script here is FIXED text. The window handle, control id and limits arrive as JSON on stdin and are only
 * ever used as data. No screen coordinates are used anywhere: controls are found by their UI Automation runtime id.
 */

export interface FieldInfo {
  /** UI Automation runtime id ("42.1234.5"): how the control is found again */
  rid: string;
  /** a short label for the picker (the control's own name, never its contents) */
  name: string;
  type: string;
  editable: boolean;
  password: boolean;
  /** position inside its window, only used to describe it ("near the top"), never to click */
  rect: { l: number; t: number; w: number; h: number };
}

export interface TargetScan {
  ok: boolean;
  hwnd: number;
  win: { l: number; t: number; w: number; h: number };
  /** the field that has the keyboard focus inside that window, if Windows can say */
  focused: FieldInfo | null;
  /** every visible, enabled, editable, non-password field in the window */
  candidates: FieldInfo[];
  truncated: boolean;
}

export type TargetPlan =
  | { kind: "ready"; hwnd: number; field: FieldInfo; via: "focused" | "only-field" }
  | { kind: "choose"; hwnd: number; fields: FieldInfo[] }
  | { kind: "click" }
  | { kind: "password" };

/** Pure decision. One suitable field: use it. Several: ask. None: ask the user to click into one. */
export function planTarget(scan: TargetScan | null): TargetPlan {
  if (!scan || !scan.ok || !scan.hwnd) return { kind: "click" };
  if (scan.focused && scan.focused.password) return { kind: "password" };
  if (scan.focused && scan.focused.editable) return { kind: "ready", hwnd: scan.hwnd, field: scan.focused, via: "focused" };
  const fields = scan.candidates.filter((f) => f.editable && !f.password);
  if (fields.length === 1) return { kind: "ready", hwnd: scan.hwnd, field: fields[0], via: "only-field" };
  if (fields.length > 1) return { kind: "choose", hwnd: scan.hwnd, fields };
  return { kind: "click" };
}

export type Verification = "confirmed" | "unconfirmed" | "overwritten" | "failed" | "unreadable";

const norm = (s: string) => s.replace(/\r\n?/g, "\n");

/**
 * Did `inserted` land in the field without disturbing what was there? `before` and `after` are the field's text.
 * confirmed   = after is exactly before with `inserted` added at one place.
 * unconfirmed = the text is there but something else changed too (auto-correct, auto-format).
 * overwritten = the text is there but most of what was in the field is gone (a selection or the whole content was replaced).
 * failed      = the text did not appear.
 * unreadable  = the field's text could not be read, so nothing can be said.
 */
export function verifyInsertion(before: string | null, after: string | null, inserted: string): Verification {
  if (before === null || after === null) return "unreadable";
  const b = norm(before), a = norm(after), t = norm(inserted);
  if (a === b) return "failed";
  if (a.length === b.length + t.length) {
    let p = 0;
    while (p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s + p < b.length && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    // the insertion point can be anywhere from (b.length - s) to p
    for (let i = Math.max(0, b.length - s); i <= p; i++) if (a.startsWith(t, i)) return "confirmed";
  }
  if (!a.includes(t)) return "failed";
  return b.length > 0 && a.length - t.length < b.length / 2 ? "overwritten" : "unconfirmed";
}

/** A short plain description of where a field is, for the picker. */
export function describeField(f: FieldInfo, win: TargetScan["win"]): string {
  if (!win.h) return f.type;
  const mid = (f.rect.t + f.rect.h / 2 - win.t) / win.h;
  const where = mid < 0.33 ? "near the top" : mid > 0.66 ? "near the bottom" : "in the middle";
  return where;
}

// ------------------------------------------------------------------ the UI Automation scripts

const COMMON = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MomoTgt {
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeout(IntPtr h, int msg, IntPtr w, IntPtr l, int flags, int timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function J($s) { ([string]$s) -replace '[\x00-\x1f]', ' ' -replace '\\', '\\' -replace '"', '\"' }
function B($b) { if ($b) { 'true' } else { 'false' } }
function Fail($code) { '{"ok":false,"error":"' + $code + '"}'; exit 0 }
# Older toolkits (WinForms, classic Win32) do not mark password boxes for accessibility: Windows itself still knows.
function Test-LegacyPassword([int]$nh) {
  $hh = [IntPtr]$nh
  if (([MomoTgt]::GetWindowLong($hh, -16) -band 0x20) -ne 0) { return $true }
  $res = [IntPtr]::Zero
  [void][MomoTgt]::SendMessageTimeout($hh, 0x00D2, [IntPtr]::Zero, [IntPtr]::Zero, 2, 100, [ref]$res)
  return ($res -ne [IntPtr]::Zero)
}
function Describe($el) {
  try { $c = $el.Current } catch { return $null }
  $type = ([string]$c.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
  $pw = $false
  try { $pw = [bool]$c.IsPassword } catch {}
  if (-not $pw) { try { $nh = [int]$c.NativeWindowHandle; if ($nh -ne 0 -and ([string]$c.ClassName) -match 'EDIT|TextBox') { if (Test-LegacyPassword $nh) { $pw = $true } } } catch {} }
  $hasVal = $false; $ro = $false; $pat = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) { $hasVal = $true; $ro = [bool]$pat.Current.IsReadOnly } } catch {}
  $hasText = $false; $tp = $null
  try { $hasText = [bool]$el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp) } catch {}
  $editable = $false
  if ($c.IsEnabled -and -not $pw) {
    if ($type -eq 'Edit') { $editable = ($hasVal -and -not $ro) -or ($hasText -and -not $hasVal) }
    elseif ($type -eq 'Document') { $editable = ($hasVal -and -not $ro) -or ($hasText -and -not $hasVal -and ([string]$c.ClassName) -match 'Edit|Scintilla|Text') }
  }
  $rid = ''
  try { $rid = ($el.GetRuntimeId() -join '.') } catch {}
  $r = $c.BoundingRectangle
  $l = 0; $t = 0; $w = 0; $h = 0
  if (-not $r.IsEmpty -and -not [double]::IsInfinity($r.Width)) { $l = [int]$r.Left; $t = [int]$r.Top; $w = [int]$r.Width; $h = [int]$r.Height }
  return @{ rid = $rid; name = ([string]$c.Name); type = $type; editable = [bool]$editable; password = [bool]$pw; offscreen = [bool]$c.IsOffscreen; l = $l; t = $t; w = $w; h = $h }
}
function FieldJson($d) {
  '{"rid":"' + (J $d.rid) + '","name":"' + (J ([string]$d.name).Substring(0, [Math]::Min(60, ([string]$d.name).Length))) + '","type":"' + (J $d.type) + '","editable":' + (B $d.editable) + ',"password":' + (B $d.password) + ',"rect":{"l":' + $d.l + ',"t":' + $d.t + ',"w":' + $d.w + ',"h":' + $d.h + '}}'
}
function IsInside($el, $root) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $cur = $el; $n = 0
  while ($cur -ne $null -and $n -lt 60) {
    if ([System.Windows.Automation.Automation]::Compare($cur, $root)) { return $true }
    try { $cur = $walker.GetParent($cur) } catch { return $false }
    $n++
  }
  return $false
}
function Find-ByRid($root, [string]$rid) {
  $ids = [int[]]($rid -split '\.')
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::RuntimeIdProperty, $ids)
  return $root.FindFirst($TS::Descendants, $cond)
}
function Read-Text($el, [int]$max) {
  # returns $null when the text cannot be read (or is longer than we are willing to compare).
  # The value comes first: an EMPTY Chromium text box reports its label as its text through TextPattern.
  $tp = $null; $vp = $null
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $s = [string]$vp.Current.Value
      if ($s.Length -gt $max) { return $null }
      return $s
    }
  } catch {}
  try {
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      $s = [string]$tp.DocumentRange.GetText($max + 1)
      if ($s.Length -gt $max) { return $null }
      return $s
    }
  } catch {}
  return $null
}
`;

const SCAN_SCRIPT = COMMON + String.raw`
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $h = [IntPtr][long]$req.hwnd
  if (-not [MomoTgt]::IsWindow($h)) { Fail 'gone' }
  $root = $AE::FromHandle($h)
  $wr = $root.Current.BoundingRectangle
  $wl = 0; $wt = 0; $ww = 0; $wh = 0
  if (-not $wr.IsEmpty -and -not [double]::IsInfinity($wr.Width)) { $wl = [int]$wr.Left; $wt = [int]$wr.Top; $ww = [int]$wr.Width; $wh = [int]$wr.Height }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $focusedJson = 'null'
  try {
    $fe = $AE::FocusedElement
    if ($fe -ne $null -and (IsInside $fe $root)) { $d = Describe $fe; if ($d) { $focusedJson = FieldJson $d } }
  } catch {}
  function Get-Candidates {
    $cond = New-Object System.Windows.Automation.OrCondition(
      (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
      (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)))
    $found = $root.FindAll($TS::Descendants, $cond)
    $out = New-Object System.Collections.Generic.List[string]
    $n = 0; $trunc = $false
    foreach ($el in $found) {
      if ($sw.ElapsedMilliseconds -gt 9000 -or $n -ge 40) { $trunc = $true; break }
      $n++
      $d = Describe $el
      if ($d -and $d.editable -and -not $d.password -and -not $d.offscreen -and $d.w -ge 20 -and $d.h -ge 10) { $out.Add((FieldJson $d)) }
    }
    return @{ items = $out; truncated = $trunc }
  }
  $r = Get-Candidates
  # Chromium-based apps (browsers, VS Code, Slack, Discord) build their accessibility tree only after a client asks: look again once
  if ($r.items.Count -eq 0) { Start-Sleep -Milliseconds 700; $r = Get-Candidates }
  '{"ok":true,"hwnd":' + [long]$req.hwnd + ',"win":{"l":' + $wl + ',"t":' + $wt + ',"w":' + $ww + ',"h":' + $wh + '},"focused":' + $focusedJson + ',"truncated":' + (B $r.truncated) + ',"candidates":[' + ($r.items -join ',') + ']}'
} catch {
  '{"ok":false,"error":"failed"}'
}
`;

const FOCUSED_SCRIPT = COMMON + String.raw`
try {
  $fg = [MomoTgt]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { Fail 'none' }
  $root = $AE::FromHandle($fg)
  $fe = $AE::FocusedElement
  if ($fe -eq $null -or -not (IsInside $fe $root)) { '{"ok":true,"hwnd":' + [long]$fg + ',"field":null}'; exit 0 }
  $d = Describe $fe
  if (-not $d) { '{"ok":true,"hwnd":' + [long]$fg + ',"field":null}'; exit 0 }
  '{"ok":true,"hwnd":' + [long]$fg + ',"field":' + (FieldJson $d) + '}'
} catch {
  '{"ok":false,"error":"failed"}'
}
`;

const FOCUS_SCRIPT = COMMON + String.raw`
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $h = [IntPtr][long]$req.hwnd
  if (-not [MomoTgt]::IsWindow($h)) { Fail 'gone' }
  $root = $AE::FromHandle($h)
  $el = Find-ByRid $root ([string]$req.rid)
  if (-not $el) { Fail 'not_found' }
  $d = Describe $el
  if (-not $d) { Fail 'not_found' }
  # the field must still be what was identified: editable, enabled, not a password box
  if ($d.password) { Fail 'password' }
  if (-not $d.editable) { Fail 'not_editable' }
  if ([MomoTgt]::IsIconic($h)) { [void][MomoTgt]::ShowWindow($h, 9) }
  if ([MomoTgt]::GetForegroundWindow() -ne $h) {
    # Windows only lets the foreground process change the foreground: a quick Alt tap makes the request legitimate
    [MomoTgt]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [MomoTgt]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][MomoTgt]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 150
  }
  $el.SetFocus()
  # confirm that this very field now has the keyboard focus
  $ok = $false
  for ($i = 0; $i -lt 12; $i++) {
    try { $fe = $AE::FocusedElement; if ($fe -ne $null -and (($fe.GetRuntimeId() -join '.') -eq [string]$req.rid)) { $ok = $true; break } } catch {}
    Start-Sleep -Milliseconds 100
  }
  if (-not $ok) { Fail 'focus_failed' }
  $before = Read-Text $el ([int]$req.max)
  # An existing selection would be replaced by the paste: collapse it to its end so the text goes in at the cursor
  $collapsed = $false
  try {
    $tp = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      $sel = $tp.GetSelection()
      if ($sel.Length -gt 0 -and ([string]$sel[0].GetText(1)).Length -gt 0) {
        $rg = $sel[0]
        [void]$rg.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, $rg, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End)
        $rg.Select()
        $collapsed = $true
      }
    }
  } catch {}
  if ($before -eq $null) { '{"ok":true,"readable":false,"collapsed":' + (B $collapsed) + '}' }
  else { '{"ok":true,"readable":true,"collapsed":' + (B $collapsed) + ',"text":"' + (J $before) + '"}' }
} catch {
  '{"ok":false,"error":"failed"}'
}
`;

const READBACK_SCRIPT = COMMON + String.raw`
try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $h = [IntPtr][long]$req.hwnd
  if (-not [MomoTgt]::IsWindow($h)) { Fail 'gone' }
  $root = $AE::FromHandle($h)
  $el = Find-ByRid $root ([string]$req.rid)
  if (-not $el) { Fail 'not_found' }
  # apps apply a paste a moment later: look until the text has changed (or give up)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $now = $null
  do {
    $now = Read-Text $el ([int]$req.max)
    if ($now -eq $null) { break }
    if ($now.Length -ne [int]$req.beforeLen) { break }
    Start-Sleep -Milliseconds 120
  } while ($sw.ElapsedMilliseconds -lt 1500)
  if ($now -eq $null) { '{"ok":true,"readable":false}' } else { '{"ok":true,"readable":true,"text":"' + (J $now) + '"}' }
} catch {
  '{"ok":false,"error":"failed"}'
}
`;

// ------------------------------------------------------------------ typed wrappers

const MAX_TEXT = 100_000;
const validHwnd = (h: number) => Number.isSafeInteger(h) && h > 0;
const validRid = (r: string) => /^-?\d+(\.-?\d+)*$/.test(r) && r.length <= 200;

interface RawField { rid: string; name: string; type: string; editable: boolean; password: boolean; rect: FieldInfo["rect"] }
const toField = (r: RawField | null | undefined): FieldInfo | null =>
  r ? { rid: String(r.rid), name: String(r.name ?? ""), type: String(r.type ?? ""), editable: !!r.editable, password: !!r.password, rect: r.rect ?? { l: 0, t: 0, w: 0, h: 0 } } : null;
const asList = <T,>(x: T | T[] | undefined | null): T[] => (Array.isArray(x) ? x : x ? [x] : []);

/** Detect + identify: what is focused in this window, and which fields could take text. */
export async function scanTargets(hwnd: number): Promise<TargetScan | null> {
  if (!validHwnd(hwnd)) return null;
  try {
    const r = await runPowerShell<{ ok: boolean; hwnd?: number; win?: TargetScan["win"]; focused?: RawField | null; candidates?: RawField | RawField[]; truncated?: boolean }>(
      SCAN_SCRIPT, 25_000, JSON.stringify({ hwnd }));
    if (!r.ok) return null;
    return {
      ok: true, hwnd, win: r.win ?? { l: 0, t: 0, w: 0, h: 0 }, focused: toField(r.focused),
      candidates: asList(r.candidates).map((c) => toField(c)!).filter(Boolean), truncated: !!r.truncated,
    };
  } catch {
    return null;
  }
}

/** Whatever field has the keyboard focus right now (used while waiting for the user to click into one). */
export async function focusedField(): Promise<{ hwnd: number; field: FieldInfo | null } | null> {
  try {
    const r = await runPowerShell<{ ok: boolean; hwnd?: number; field?: RawField | null }>(FOCUSED_SCRIPT, 10_000);
    return r.ok && r.hwnd ? { hwnd: r.hwnd, field: toField(r.field) } : null;
  } catch {
    return null;
  }
}

export type FocusFailure = "gone" | "not_found" | "password" | "not_editable" | "focus_failed" | "failed";
export interface FocusResult { ok: boolean; reason?: FocusFailure; /** the field's text before the paste (null: not readable) */ before?: string | null; collapsedSelection?: boolean }

/** Focus: put the keyboard focus in exactly this field, prove it, and note what it held (and collapse a selection). */
export async function focusField(hwnd: number, rid: string): Promise<FocusResult> {
  if (!validHwnd(hwnd) || !validRid(rid)) return { ok: false, reason: "not_found" };
  try {
    const r = await runPowerShell<{ ok: boolean; error?: FocusFailure; readable?: boolean; text?: string; collapsed?: boolean }>(
      FOCUS_SCRIPT, 20_000, JSON.stringify({ hwnd, rid, max: MAX_TEXT }));
    if (!r.ok) return { ok: false, reason: r.error ?? "failed" };
    return { ok: true, before: r.readable ? String(r.text ?? "") : null, collapsedSelection: !!r.collapsed };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Verify: read the field again after the paste. null = could not be read. */
export async function readBack(hwnd: number, rid: string, beforeLen: number): Promise<string | null> {
  if (!validHwnd(hwnd) || !validRid(rid)) return null;
  try {
    const r = await runPowerShell<{ ok: boolean; readable?: boolean; text?: string }>(
      READBACK_SCRIPT, 15_000, JSON.stringify({ hwnd, rid, max: MAX_TEXT, beforeLen }));
    return r.ok && r.readable ? String(r.text ?? "") : null;
  } catch {
    return null;
  }
}
