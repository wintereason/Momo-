import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { CaptureResult, FsPort, OcrResult, RawWindow, ScreenPort, UiNode, UiReadResult, WindowsPort, WindowsSnapshot } from "./ports";

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** Real filesystem access through Node APIs. Never opens File Explorer. */
export const nodeFs: FsPort = {
  async listDriveRoots() {
    const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    // an unavailable network drive must not stall the whole answer
    const checks = await Promise.all(letters.map((L) =>
      withTimeout(fs.promises.access(`${L}:\\`).then(() => true, () => false), 1500, false)));
    return letters.filter((_, i) => checks[i]).map((L) => `${L}:\\`);
  },
  async statfs(root) {
    const s = await fs.promises.statfs(root);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  },
  async readDirs(p) {
    try {
      const entries = await fs.promises.readdir(p, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name); // symlinks/junctions are not followed
    } catch {
      return null;
    }
  },
  async readEntries(p) {
    try {
      const entries = await fs.promises.readdir(p, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return null;
    }
  },
  async stat(p) {
    try {
      return { isDir: (await fs.promises.stat(p)).isDirectory() };
    } catch {
      return null;
    }
  },
  homeDir: () => os.homedir(),
};

/**
 * Runs a FIXED PowerShell script and returns the last JSON object it printed.
 * Nothing from the user, from window titles or from screen text is ever interpolated into a script;
 * the only substituted value is an integer window handle validated by the caller.
 */
export function runPowerShell<T>(script: string, timeoutMs: number, stdin?: string): Promise<T> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise<T>((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
        if (!line) return reject(new Error("no output"));
        try { resolve(JSON.parse(line) as T); } catch (e) { reject(e); }
      },
    );
    // Data (like text to type) travels as JSON on stdin, never inside the script text.
    child.stdin?.end(stdin ?? "", "utf8");
  });
}

// ------------------------------------------------------------------ windows

const WINDOWS_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class MomoWinInfo { public long hwnd; public uint pid; public string title; public bool minimized; public bool maximized; public int z; }
public static class MomoWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int sz);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // every real top-level window, front to back: visible or minimized, titled, not a tool tip, not a hidden UWP shell
  public static List<MomoWinInfo> All() {
    var list = new List<MomoWinInfo>();
    int z = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      z++;
      bool min = IsIconic(h);
      if (!min && !IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return true;
      if (!min) { int c = 0; DwmGetWindowAttribute(h, 14, out c, 4); if (c != 0) return true; }
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (t.Length == 0) return true;
      var k = new StringBuilder(128); GetClassName(h, k, 128);
      string cls = k.ToString();
      if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new MomoWinInfo { hwnd = h.ToInt64(), pid = pid, title = t.ToString(), minimized = min, maximized = IsZoomed(h), z = z - 1 });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$fg = [MomoWin]::GetForegroundWindow()
$fgPid = [uint32]0
[void][MomoWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$names = @{}
Get-Process | ForEach-Object { $names[[int]$_.Id] = [string]$_.ProcessName }
$wins = @([MomoWin]::All() | Where-Object { $names[[int]$_.pid] -ne "dwm" } | ForEach-Object {
  [pscustomobject]@{ hwnd = [int64]$_.hwnd; pid = [int]$_.pid; process = [string]$names[[int]$_.pid]; title = [string]$_.title; minimized = [bool]$_.minimized; maximized = [bool]$_.maximized; z = [int]$_.z }
})
$procs = @($names.Values | ForEach-Object { ([string]$_).ToLower() } | Sort-Object -Unique)
[pscustomobject]@{ activePid = [int]$fgPid; activeHwnd = [int64]$fg; windows = $wins; procs = $procs } | ConvertTo-Json -Compress -Depth 4
`;

/** Real window listing through the Win32 API (via a short-lived PowerShell process). */
export const nodeWindows: WindowsPort = {
  async query(): Promise<WindowsSnapshot> {
    const raw = await runPowerShell<{ activePid?: number; activeHwnd?: number; windows?: RawWindow | RawWindow[]; procs?: string | string[] }>(WINDOWS_SCRIPT, 10_000);
    const list = Array.isArray(raw.windows) ? raw.windows : raw.windows ? [raw.windows] : [];
    return {
      activePid: raw.activePid && raw.activePid > 0 ? raw.activePid : null,
      activeHwnd: raw.activeHwnd && raw.activeHwnd > 0 ? raw.activeHwnd : null,
      windows: list,
      processes: Array.isArray(raw.procs) ? raw.procs.map(String) : raw.procs ? [String(raw.procs)] : undefined,
    };
  },
};

// ------------------------------------------------------------------ looking at a window

const UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  # Older toolkits (WinForms, classic Win32) don't mark password boxes for accessibility and even report the
  # secret text as the control's name. Windows itself still knows: the ES_PASSWORD style or a password character.
  # The helper is compiled lazily, only if such a control is actually met (most apps never need it).
  $script:pwdReady = $false
  function Test-LegacyPassword([int]$nh) {
    if (-not $script:pwdReady) {
      Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MomoPwd {
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] public static extern IntPtr SendMessageTimeout(IntPtr h, int msg, IntPtr w, IntPtr l, int flags, int timeout, out IntPtr result);
}
"@
      $script:pwdReady = $true
    }
    $hh = [IntPtr]$nh
    if (([MomoPwd]::GetWindowLong($hh, -16) -band 0x20) -ne 0) { return $true }
    $res = [IntPtr]::Zero
    [void][MomoPwd]::SendMessageTimeout($hh, 0x00D2, [IntPtr]::Zero, [IntPtr]::Zero, 2, 100, [ref]$res)
    return ($res -ne [IntPtr]::Zero)
  }
  $hwnd = __HWND__
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $actionable = @('Button', 'CheckBox', 'RadioButton', 'MenuItem', 'TabItem', 'Hyperlink', 'ListItem', 'TreeItem', 'DataItem', 'Edit', 'ComboBox', 'SplitButton')
  function Read-Tree {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $items = New-Object System.Collections.Generic.List[object]
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($root, 0, ''))
    $visited = 0; $edits = 0; $unnamed = 0; $patternBudget = 110
    while ($stack.Count -gt 0 -and $visited -lt 700 -and $sw.ElapsedMilliseconds -lt 8000) {
      $pair = $stack.Pop(); $el = $pair[0]; $depth = $pair[1]; $panel = [string]$pair[2]; $visited++
      try { $c = $el.Current } catch { continue }
      $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      $name = [string]$c.Name
      # the nearest named panel this control sits in (a toolbar, a sidebar, the page...): tells two look-alike boxes apart
      $childPanel = $panel
      if ($name -and $name.Length -lt 60 -and (@('Pane', 'Group', 'ToolBar', 'Tab', 'List', 'Document', 'Window', 'Custom', 'Menu') -contains $type)) { $childPanel = $name }
      $isPwd = $false
      try { $isPwd = [bool]$c.IsPassword } catch {}
      if (-not $isPwd) {
        try {
          $nh = [int]$c.NativeWindowHandle
          if ($nh -ne 0 -and ([string]$c.ClassName) -match 'EDIT|TextBox') {
            if (Test-LegacyPassword $nh) { $isPwd = $true }
          }
        } catch {}
      }
      $value = $null
      $readOnly = $false
      if ($type -eq 'Edit' -and -not $isPwd -and $edits -lt 15) {
        $edits++
        try { $pat = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) { $value = [string]$pat.Current.Value; $readOnly = [bool]$pat.Current.IsReadOnly } } catch {}
      }
      # actionable controls carry their runtime id (to find exactly this control again) and their on/off state
      $rid = ''
      $state = ''
      if ($actionable -contains $type) {
        try { $rid = ($el.GetRuntimeId() -join '.') } catch {}
        try {
          $pat = $null
          if (($type -eq 'CheckBox' -or $type -eq 'RadioButton') -and $el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
            $state = $(if ([string]$pat.Current.ToggleState -eq 'On') { 'on' } else { 'off' })
          } elseif (($type -eq 'TabItem' -or $type -eq 'RadioButton') -and $el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
            $state = $(if ($pat.Current.IsSelected) { 'selected' } else { 'unselected' })
          }
        } catch {}
      }
      # icon-only controls have no name: they are still listed (a bounded number), because WHAT they are is what Momo must work out
      $showUnnamed = $false
      if (-not $name -and -not $value -and ($actionable -contains $type) -and $unnamed -lt 60) {
        try { if (-not $c.IsOffscreen) { $ur = $c.BoundingRectangle; if (-not $ur.IsEmpty -and $ur.Width -ge 8 -and $ur.Height -ge 8) { $showUnnamed = $true; $unnamed++ } } } catch {}
      }
      if ($name -or $value -or $isPwd -or $showUnnamed) {
        # what the application says about this control, beyond its name
        $aid = ''; $cls = ''; $help = ''; $lab = ''; $pts = ''; $exp = ''
        $isAct = ($actionable -contains $type)
        if ($isAct) {
          try { $aid = [string]$c.AutomationId } catch {}
          try { $cls = [string]$c.ClassName } catch {}
        }
        if ($isAct -and -not $isPwd) {
          try { $help = [string]$c.HelpText } catch {}
          if ($type -eq 'Edit' -or $type -eq 'ComboBox') { try { $lbe = $c.LabeledBy; if ($lbe) { $lab = [string]$lbe.Current.Name } } catch {} }
        }
        if ($cls -eq 'UIProperty') { $pts = 'value,griditem,tableitem' }
        elseif ($isAct -and $type -ne 'ListItem' -and $type -ne 'TreeItem' -and $type -ne 'DataItem' -and $patternBudget -gt 0) {
          $patternBudget--
          try { $pts = (@($el.GetSupportedPatterns() | ForEach-Object { ($_.ProgrammaticName -replace 'PatternIdentifiers.Pattern', '').ToLower() }) -join ',') } catch {}
          try { $pe = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pe)) { $exp = ([string]$pe.Current.ExpandCollapseState).ToLower() } } catch {}
        }
        $bl = 0; $bt = 0; $bw = 0; $bh = 0
        try { $br = $c.BoundingRectangle; if (-not $br.IsEmpty -and -not [double]::IsInfinity($br.Width)) { $bl = [int]$br.Left; $bt = [int]$br.Top; $bw = [int]$br.Width; $bh = [int]$br.Height } } catch {}
        $items.Add(@{ t = "$type"; n = "$name"; e = [bool]$c.IsEnabled; o = [bool]$c.IsOffscreen; v = $(if ($value) { "$value" } else { '' }); p = [bool]$isPwd; r = "$rid"; s = "$state"; ro = [bool]$readOnly; f = [bool]$c.HasKeyboardFocus; b = "$bl,$bt,$bw,$bh"; pa = "$panel"; id = "$aid"; cl = "$cls"; hp = "$help"; lb = "$lab"; pt = "$pts"; x = "$exp" })
      }
      if ($depth -lt 14) {
        $kids = New-Object System.Collections.Generic.List[object]
        try { $ch = $walker.GetFirstChild($el); while ($ch -ne $null -and $kids.Count -lt 60) { $kids.Add($ch); $ch = $walker.GetNextSibling($ch) } } catch {}
        for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], ($depth + 1), $childPanel)) }
      }
    }
    @{ items = $items; truncated = ($stack.Count -gt 0) }
  }
  $r = Read-Tree
  # Chromium-based apps build their accessibility tree only after a client asks: look again once
  if ($r.items.Count -lt 15) { Start-Sleep -Milliseconds 600; $r2 = Read-Tree; if ($r2.items.Count -gt $r.items.Count) { $r = $r2 } }
  # The built-in JSON serializers choke on these COM-derived values in Windows PowerShell 5.1: write the JSON by hand
  function J($s) { ([string]$s) -replace '[\x00-\x1f]', ' ' -replace '\\', '\\' -replace '"', '\"' }
  function B($b) { if ($b) { 'true' } else { 'false' } }
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($it in $r.items) {
    $parts.Add('{"t":"' + (J $it.t) + '","n":"' + (J $it.n) + '","e":' + (B $it.e) + ',"o":' + (B $it.o) + ',"v":"' + (J $it.v) + '","p":' + (B $it.p) + ',"r":"' + (J $it.r) + '","s":"' + (J $it.s) + '","ro":' + (B $it.ro) + ',"f":' + (B $it.f) + ',"b":"' + (J $it.b) + '","pa":"' + (J $it.pa) + '","id":"' + (J $it.id) + '","cl":"' + (J $it.cl) + '","hp":"' + (J $it.hp) + '","lb":"' + (J $it.lb) + '","pt":"' + (J $it.pt) + '","x":"' + (J $it.x) + '"}')
  }
  '{"ok":true,"truncated":' + (B $r.truncated) + ',"items":[' + ($parts -join ',') + ']}'
} catch {
  [pscustomobject]@{ ok = $false; error = 'uia_failed' } | ConvertTo-Json -Compress
}
`;

const TASKBAR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MomoTb { [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); }'
  $h = [MomoTb]::FindWindow('Shell_TrayWnd', $null)
  if ($h -eq [IntPtr]::Zero) { '{"ok":false}' } else { '{"ok":true,"hwnd":' + [long]$h + '}' }
} catch { '{"ok":false}' }
`;

const OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($code) { [pscustomobject]@{ ok = $false; error = $code } | ConvertTo-Json -Compress; exit 0 }
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MomoCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
}
"@
  [void][MomoCap]::SetProcessDPIAware()
  $h = [IntPtr]__HWND__
  if (-not [MomoCap]::IsWindow($h)) { Fail 'gone' }
  if ([MomoCap]::IsIconic($h)) { Fail 'minimized' }
  $r = New-Object MomoCap+RECT
  [void][MomoCap]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -lt 20 -or $ht -lt 20) { Fail 'empty' }

  # the pixels exist only in this process's memory: they are never written to disk or sent anywhere
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [MomoCap]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  if (-not $ok) { Fail 'capture_failed' }

  [void][Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  if ($w -gt $max -or $ht -gt $max) {
    $s = [Math]::Min($max / $w, $max / $ht)
    $small = New-Object System.Drawing.Bitmap ([int]($w * $s)), ([int]($ht * $s))
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.DrawImage($bmp, 0, 0, $small.Width, $small.Height); $g2.Dispose()
    $bmp.Dispose(); $bmp = $small
  }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $out = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForWrite($stream)
  $out.Write($png, 0, $png.Length); $out.Flush(); $stream.Seek(0) | Out-Null
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { Fail 'no_ocr' }
  $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($res.Lines | ForEach-Object { [string]$_.Text })
  [pscustomobject]@{ ok = $true; lines = $lines } | ConvertTo-Json -Compress -Depth 3
} catch {
  [pscustomobject]@{ ok = $false; error = 'ocr_failed' } | ConvertTo-Json -Compress
}
`;

// The same capture as the OCR script, cropped to one box (small pictures are scaled up so the letters are big enough), as text OR as a PNG.
const REGION_SCRIPT = OCR_SCRIPT
  .replace("  if (-not $ok) { Fail 'capture_failed' }", `  if (-not $ok) { Fail 'capture_failed' }
  $rg = '__RECT__'.Split(',')
  $rx = [Math]::Max(0, [int]$rg[0] - $r.Left); $ry = [Math]::Max(0, [int]$rg[1] - $r.Top); $rw = [int]$rg[2]; $rh = [int]$rg[3]
  if ($rx + $rw -gt $bmp.Width) { $rw = $bmp.Width - $rx }
  if ($ry + $rh -gt $bmp.Height) { $rh = $bmp.Height - $ry }
  if ($rw -lt 4 -or $rh -lt 4) { Fail 'empty' }
  $crop = $bmp.Clone((New-Object System.Drawing.Rectangle $rx, $ry, $rw, $rh), $bmp.PixelFormat)
  $k = 1
  if ($rh -lt 80) { $k = [Math]::Min(6, [Math]::Ceiling(80 / $rh)) }
  $big = New-Object System.Drawing.Bitmap ([int]($rw * $k)), ([int]($rh * $k))
  $gb = [System.Drawing.Graphics]::FromImage($big); $gb.InterpolationMode = 'HighQualityBicubic'; $gb.DrawImage($crop, 0, 0, $big.Width, $big.Height); $gb.Dispose()
  $bmp.Dispose(); $crop.Dispose(); $bmp = $big; $w = $bmp.Width; $ht = $bmp.Height`)
  .replace("  $png = $ms.ToArray()", `  $png = $ms.ToArray()
  if ('__MODE__' -eq 'png') { '{"ok":true,"w":' + $bmp.Width + ',"h":' + $bmp.Height + ',"png":"' + [Convert]::ToBase64String($png) + '"}'; exit 0 }`);

const validHwnd = (h: number) => Number.isSafeInteger(h) && h > 0;
/** "l,t,w,h" -> a rectangle, or nothing when the control has no on-screen box */
function parseRect(b: string | undefined): UiNode["rect"] {
  const p = String(b ?? "").split(",").map(Number);
  return p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0 ? { l: p[0], t: p[1], w: p[2], h: p[3] } : undefined;
}

interface RawUi { ok: boolean; error?: string; truncated?: boolean; items?: { t: string; n: string; e: boolean; o: boolean; v?: string | null; p?: boolean; r?: string; s?: string; ro?: boolean; f?: boolean; b?: string; pa?: string; id?: string; cl?: string; hp?: string; lb?: string; pt?: string; x?: string }[] }
interface RawOcr { ok: boolean; error?: string; lines?: string[] | string; png?: string; w?: number; h?: number }
const regionArg = (r: { l: number; t: number; w: number; h: number }): string | null =>
  [r.l, r.t, r.w, r.h].every((n) => Number.isFinite(n) && Math.abs(n) < 100_000) && r.w >= 4 && r.h >= 4 && r.w <= 1600 && r.h <= 1200 ? [r.l, r.t, r.w, r.h].map(Math.round).join(",") : null;

const OCR_REASONS: Record<string, string> = {
  gone: "the window has closed",
  minimized: "the window is minimized",
  empty: "the window has no visible area",
  capture_failed: "Windows wouldn't let me capture that window",
  no_ocr: "this PC has no text-recognition language installed",
  ocr_failed: "the screenshot couldn't be read",
};

let taskbarCache: { at: number; items: UiNode[] } | null = null;

/** Real window inspection: UI Automation for structure and text, capture + Windows OCR as the fallback. */
export const nodeScreen: ScreenPort = {
  async readUi(hwnd: number): Promise<UiReadResult> {
    if (!validHwnd(hwnd)) return { ok: false, reason: "invalid window" };
    try {
      const raw = await runPowerShell<RawUi>(UIA_SCRIPT.replace("__HWND__", String(hwnd)), 20_000);
      if (!raw.ok) return { ok: false, reason: "Windows UI Automation couldn't read that window" };
      const items: UiNode[] = (Array.isArray(raw.items) ? raw.items : raw.items ? [raw.items] : []).map((i) => ({
        type: String(i.t), name: String(i.n ?? ""), enabled: !!i.e, offscreen: !!i.o,
        value: i.v ? String(i.v) : undefined, password: !!i.p,
        rid: i.r ? String(i.r) : undefined, state: i.s ? String(i.s) : undefined, readOnly: !!i.ro,
        focused: !!i.f, rect: parseRect(i.b), panel: i.pa ? String(i.pa) : undefined,
        autoId: i.id ? String(i.id) : undefined, className: i.cl ? String(i.cl) : undefined, help: i.hp ? String(i.hp) : undefined,
        labelledBy: i.lb ? String(i.lb) : undefined, patterns: i.pt ? String(i.pt).split(",").filter(Boolean) : undefined, expanded: i.x ? String(i.x) : undefined,
      }));
      return { ok: true, items, truncated: !!raw.truncated };
    } catch {
      return { ok: false, reason: "Windows UI Automation didn't answer in time" };
    }
  },

  /** The taskbar's buttons and where they are. Cached for a short while: it changes rarely. */
  async taskbar(): Promise<UiNode[] | null> {
    if (taskbarCache && Date.now() - taskbarCache.at < 20_000) return taskbarCache.items;
    try {
      const r = await runPowerShell<{ ok: boolean; hwnd?: number }>(TASKBAR_SCRIPT, 8_000);
      if (!r.ok || !r.hwnd) return null;
      const ui = await nodeScreen.readUi(r.hwnd);
      if (!ui.ok) return null;
      const items = ui.items.filter((n) => n.rect && !n.offscreen);
      taskbarCache = { at: Date.now(), items };
      return items;
    } catch {
      return null;
    }
  },

  async ocr(hwnd: number): Promise<OcrResult> {
    if (!validHwnd(hwnd)) return { ok: false, reason: "invalid window" };
    try {
      const raw = await runPowerShell<RawOcr>(OCR_SCRIPT.replace("__HWND__", String(hwnd)), 30_000);
      if (!raw.ok) return { ok: false, reason: OCR_REASONS[raw.error ?? ""] ?? "the screenshot couldn't be read" };
      const lines = Array.isArray(raw.lines) ? raw.lines : raw.lines ? [raw.lines] : [];
      return { ok: true, lines: lines.map(String) };
    } catch {
      return { ok: false, reason: "reading the screenshot took too long" };
    }
  },

  async ocrRegion(hwnd, rect): Promise<OcrResult> {
    const rg = regionArg(rect);
    if (!validHwnd(hwnd) || !rg) return { ok: false, reason: "invalid area" };
    try {
      const raw = await runPowerShell<RawOcr>(REGION_SCRIPT.replace("__HWND__", String(hwnd)).replace("__RECT__", rg).replace("__MODE__", "ocr"), 30_000);
      if (!raw.ok) return { ok: false, reason: OCR_REASONS[raw.error ?? ""] ?? "the picture couldn't be read" };
      const lines = Array.isArray(raw.lines) ? raw.lines : raw.lines ? [raw.lines] : [];
      return { ok: true, lines: lines.map(String) };
    } catch {
      return { ok: false, reason: "reading the picture took too long" };
    }
  },

  async capture(hwnd, rect): Promise<CaptureResult> {
    const rg = regionArg(rect);
    if (!validHwnd(hwnd) || !rg) return { ok: false, reason: "invalid area" };
    try {
      const raw = await runPowerShell<RawOcr>(REGION_SCRIPT.replace("__HWND__", String(hwnd)).replace("__RECT__", rg).replace("__MODE__", "png"), 30_000);
      if (!raw.ok || !raw.png) return { ok: false, reason: OCR_REASONS[raw.error ?? ""] ?? "the picture couldn't be taken" };
      return { ok: true, png: raw.png, width: raw.w ?? 0, height: raw.h ?? 0 };
    } catch {
      return { ok: false, reason: "taking the picture took too long" };
    }
  },
};
