import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChangeEvent, ChangeSource } from "./changeWatch";

/**
 * The helper's own source (not user data) as a file in the per-user temp folder, named by a hash of its content so a changed or tampered
 * copy is never run: it is rewritten when the content is not exactly ours. Returns the path to run.
 */
function scriptFile(script: string): string {
  const dir = path.join(os.tmpdir(), "momo-helper");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `uia-${createHash("sha256").update(script).digest("hex").slice(0, 16)}.ps1`);
  let same = false;
  try { same = fs.readFileSync(file, "utf8") === script; } catch { /* not there yet */ }
  if (!same) fs.writeFileSync(file, script, { encoding: "utf8", mode: 0o600 });
  return file;
}

/**
 * A long-lived Windows helper that keeps the UI Automation reader (and the window lister) compiled and loaded, so an observation costs
 * milliseconds instead of a whole new PowerShell start + compile + slow script loop every time (1.5-5 s before).
 *
 *  - It is plain Windows PowerShell 5.1 (on every Windows PC) hosting a small C# class: no new dependency, nothing to install.
 *  - Properties are fetched in batches with UI Automation's CacheRequest (one cross-process call per parent, not ~15 per control).
 *  - One request at a time, line protocol over stdin/stdout: "<id> uia <hwnd>" / "<id> windows" -> "@@<id> <json>". Nothing touches the network or the disk.
 *  - It is only an ACCELERATOR: any failure (compile error, timeout, crash) rejects that one request, the caller falls back to the old
 *    one-shot script, and the helper restarts later. It exits by itself when the app ends (its stdin closes) and after a quiet period.
 */

const IDLE_STOP_MS = 5 * 60_000;
const START_TIMEOUT_MS = 30_000;
const COOL_OFF_MS = 60_000;

export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$refs = @(
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location,
  [System.Windows.Rect].Assembly.Location,
  'System.dll'
)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class MomoHost {
  // ---------------------------------------------------------------- json
  static void Q(StringBuilder sb, string s) {
    sb.Append('"');
    if (s != null) foreach (char c in s) {
      if (c < 32) sb.Append(' ');
      else if (c == '\\') sb.Append("\\\\");
      else if (c == '"') sb.Append("\\\"");
      else sb.Append(c);
    }
    sb.Append('"');
  }
  static string B(bool b) { return b ? "true" : "false"; }

  // ---------------------------------------------------------------- window list
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int sz);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")] static extern IntPtr SendMessageTimeout(IntPtr h, int msg, IntPtr w, IntPtr l, int flags, int timeout, out IntPtr result);

  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);

  // read-only window facts (the same four the one-shot script reported): does it exist, is it minimized, whose is it, who is in front
  public static string State(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    bool ex = IsWindow(h);
    uint pid = 0, fgPid = 0;
    if (ex) GetWindowThreadProcessId(h, out pid);
    GetWindowThreadProcessId(GetForegroundWindow(), out fgPid);
    return "{\"ok\":true,\"exists\":" + B(ex) + ",\"minimized\":" + B(ex && IsIconic(h)) + ",\"pid\":" + pid + ",\"fgPid\":" + fgPid + "}";
  }

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  /** physical pixels on every monitor, whatever its scaling: the coordinates the pointer uses (a DPI-unaware host would be given scaled ones) */
  public static void Dpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  // the control under a point and its parents (up to 7): enough for the caller to tell that the thing it meant is still what is there,
  // and that nothing in the chain is a password field. Read-only; only names and ids, in memory.
  public static string At(int x, int y) {
    var sb = new StringBuilder();
    try {
      AutomationElement el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
      var walker = TreeWalker.ControlViewWalker;
      sb.Append("{\"ok\":true,\"chain\":[");
      int n = 0; bool first = true;
      while (el != null && n < 7) {
        string rid = ""; try { rid = string.Join(".", Array.ConvertAll(el.GetRuntimeId(), v => v.ToString())); } catch { }
        string t = ""; try { var ct = el.Current.ControlType; if (ct != null) t = ct.ProgrammaticName ?? ""; } catch { }
        if (t.StartsWith("ControlType.")) t = t.Substring(12);
        string nm = ""; try { nm = el.Current.Name ?? ""; } catch { }
        bool pw = false; try { pw = el.Current.IsPassword; } catch { }
        if (!pw) { try { int nh = el.Current.NativeWindowHandle; string cn = el.Current.ClassName ?? ""; if (nh != 0 && (cn.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0 || cn.IndexOf("TextBox", StringComparison.OrdinalIgnoreCase) >= 0) && LegacyPassword(nh)) pw = true; } catch { } }
        if (!first) sb.Append(','); first = false;
        sb.Append("{\"r\":"); Q(sb, rid); sb.Append(",\"t\":"); Q(sb, t); sb.Append(",\"n\":"); Q(sb, nm); sb.Append(",\"p\":").Append(B(pw)).Append('}');
        try { el = walker.GetParent(el); } catch { el = null; }
        n++;
      }
      sb.Append("]}");
    } catch { return "{\"ok\":false,\"error\":\"at_failed\"}"; }
    return sb.ToString();
  }

  public static string Windows() {
    var names = new Dictionary<int, string>();
    foreach (var p in Process.GetProcesses()) { try { names[p.Id] = p.ProcessName; } catch { } finally { p.Dispose(); } }
    IntPtr fg = GetForegroundWindow();
    uint fgPid; GetWindowThreadProcessId(fg, out fgPid);
    var sb = new StringBuilder();
    sb.Append("{\"activePid\":").Append(fgPid).Append(",\"activeHwnd\":").Append(fg.ToInt64()).Append(",\"windows\":[");
    int z = 0; bool first = true;
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
      string pn; names.TryGetValue((int)pid, out pn);
      if (pn == "dwm") return true;
      if (!first) sb.Append(',');
      first = false;
      sb.Append("{\"hwnd\":").Append(h.ToInt64()).Append(",\"pid\":").Append(pid).Append(",\"process\":"); Q(sb, pn ?? "");
      sb.Append(",\"title\":"); Q(sb, t.ToString());
      sb.Append(",\"minimized\":").Append(B(min)).Append(",\"maximized\":").Append(B(IsZoomed(h))).Append(",\"z\":").Append(z - 1).Append('}');
      return true;
    }, IntPtr.Zero);
    sb.Append("],\"procs\":[");
    var seen = new SortedSet<string>(StringComparer.Ordinal);
    foreach (var n in names.Values) seen.Add(n.ToLowerInvariant());
    first = true;
    foreach (var n in seen) { if (!first) sb.Append(','); first = false; Q(sb, n); }
    sb.Append("]}");
    return sb.ToString();
  }

  // ---------------------------------------------------------------- UI Automation
  class Item { public string t, n, v, r, s, b, pa, id, cl, hp, lb, pt, x; public bool e, o, p, ro, f; }
  static readonly HashSet<string> Actionable = new HashSet<string> { "Button", "CheckBox", "RadioButton", "MenuItem", "TabItem", "Hyperlink", "ListItem", "TreeItem", "DataItem", "Edit", "ComboBox", "SplitButton" };
  static readonly HashSet<string> PanelTypes = new HashSet<string> { "Pane", "Group", "ToolBar", "Tab", "List", "Document", "Window", "Custom", "Menu" };

  static CacheRequest NewCache() {
    var cr = new CacheRequest();
    cr.AutomationElementMode = AutomationElementMode.Full;
    cr.Add(AutomationElement.ControlTypeProperty); cr.Add(AutomationElement.NameProperty);
    cr.Add(AutomationElement.IsEnabledProperty); cr.Add(AutomationElement.IsOffscreenProperty);
    cr.Add(AutomationElement.IsPasswordProperty); cr.Add(AutomationElement.NativeWindowHandleProperty);
    cr.Add(AutomationElement.ClassNameProperty); cr.Add(AutomationElement.HasKeyboardFocusProperty);
    cr.Add(AutomationElement.BoundingRectangleProperty); cr.Add(AutomationElement.AutomationIdProperty);
    cr.Add(AutomationElement.HelpTextProperty); cr.Add(AutomationElement.RuntimeIdProperty);
    return cr;
  }

  // Older toolkits (WinForms, classic Win32) do not mark password boxes for accessibility, and may even report the secret text as the name:
  // Windows still knows (the ES_PASSWORD style, or a password character).
  static bool LegacyPassword(int nh) {
    var h = new IntPtr(nh);
    if ((GetWindowLong(h, -16) & 0x20) != 0) return true;
    IntPtr res;
    SendMessageTimeout(h, 0x00D2, IntPtr.Zero, IntPtr.Zero, 2, 100, out res);
    return res != IntPtr.Zero;
  }

  public static string LastErr = ""; public static long NErr, NFallback;
  public static bool Plain; // diagnostic: no UI Automation caching at all
  public static long KidErr; public static string LastKidErr = "";
  public static long TRoot, TTotal, TFind, TPat, TPwd, TLab, NFind, NPat, NNodes;
  public static string Prof() { return "{\"ok\":true,\"kidErrors\":" + KidErr + ",\"lastKidErr\":\"" + LastKidErr.Replace("\\", "/").Replace("\"", "'").Replace("\r", " ").Replace("\n", " ") + "\",\"errors\":" + NErr + ",\"lastErr\":\"" + LastErr.Replace("\\", "/").Replace("\"", "'").Replace("\r", " ").Replace("\n", " ") + "\",\"rootMs\":" + TRoot + ",\"totalMs\":" + TTotal + ",\"findMs\":" + TFind + ",\"findCalls\":" + NFind + ",\"patternMs\":" + TPat + ",\"patternCalls\":" + NPat + ",\"pwdMs\":" + TPwd + ",\"labelMs\":" + TLab + ",\"nodes\":" + NNodes + "}"; }
  static List<Item> ReadTree(long hwnd, Stopwatch sw, out bool truncated) {
    var items = new List<Item>();
    var cr = NewCache();
    AutomationElement root;
    long tRoot0 = sw.ElapsedTicks;
    using (cr.Activate()) { root = AutomationElement.FromHandle(new IntPtr(hwnd)); }
    TRoot += (sw.ElapsedTicks - tRoot0) * 1000 / Stopwatch.Frequency;
    var stack = new Stack<object[]>();
    stack.Push(new object[] { root, 0, "" });
    int visited = 0, edits = 0, unnamed = 0, patternBudget = 110;
    while (stack.Count > 0 && visited < 700 && sw.ElapsedMilliseconds < 8000) {
      var pair = stack.Pop();
      var el = (AutomationElement)pair[0]; int depth = (int)pair[1]; string panel = (string)pair[2]; visited++; NNodes++;
      try { // one odd element must never sink the whole read
      AutomationElement.AutomationElementInformation c;
      if (Plain) { try { c = el.Current; } catch { continue; } }
      else { try { c = el.Cached; string probe = c.Name; } catch { try { c = el.Current; } catch { continue; } } }
      // an element with no control type (Explorer's toolbars) has an EMPTY type, like in the one-shot reader: it is still walked into, never dropped
      string type = "";
      try { var ct = c.ControlType; if (ct != null) type = ct.ProgrammaticName ?? ""; } catch { }
      if (type.StartsWith("ControlType.")) type = type.Substring(12);
      string name = c.Name ?? "";
      string childPanel = panel;
      if (name.Length > 0 && name.Length < 60 && PanelTypes.Contains(type)) childPanel = name;
      bool isPwd = false;
      try { isPwd = c.IsPassword; } catch { }
      if (!isPwd) {
        try {
          int nh = c.NativeWindowHandle;
          string cn = c.ClassName ?? "";
          if (nh != 0 && (cn.IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0 || cn.IndexOf("TextBox", StringComparison.OrdinalIgnoreCase) >= 0)) { long t0 = sw.ElapsedTicks; if (LegacyPassword(nh)) isPwd = true; TPwd += (sw.ElapsedTicks - t0) * 1000 / Stopwatch.Frequency; }
        } catch { }
      }
      string value = null; bool readOnly = false;
      if (type == "Edit" && !isPwd && edits < 15) {
        edits++;
        long tv = sw.ElapsedTicks; try { object pat; if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) { var vp = (ValuePattern)pat; value = vp.Current.Value; readOnly = vp.Current.IsReadOnly; } } catch { } TPat += (sw.ElapsedTicks - tv) * 1000 / Stopwatch.Frequency; NPat++;
      }
      bool isAct = Actionable.Contains(type);
      string rid = "", state = "";
      if (isAct) {
        long tr = sw.ElapsedTicks; try { int[] ids = el.GetRuntimeId(); rid = string.Join(".", Array.ConvertAll(ids, x => x.ToString())); } catch { }
        try {
          object pat;
          if ((type == "CheckBox" || type == "RadioButton") && el.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) {
            state = ((TogglePattern)pat).Current.ToggleState == ToggleState.On ? "on" : "off";
          } else if ((type == "TabItem" || type == "RadioButton") && el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) {
            state = ((SelectionItemPattern)pat).Current.IsSelected ? "selected" : "unselected";
          }
        } catch { }
        TPat += (sw.ElapsedTicks - tr) * 1000 / Stopwatch.Frequency; NPat++;
      }
      bool hasValue = !string.IsNullOrEmpty(value);
      bool showUnnamed = false;
      if (name.Length == 0 && !hasValue && isAct && unnamed < 60) {
        try { if (!c.IsOffscreen) { var ur = c.BoundingRectangle; if (!ur.IsEmpty && ur.Width >= 8 && ur.Height >= 8) { showUnnamed = true; unnamed++; } } } catch { }
      }
      if (name.Length > 0 || hasValue || isPwd || showUnnamed) {
        string aid = "", cls = "", help = "", lab = "", pts = "", exp = "";
        if (isAct) {
          try { aid = c.AutomationId ?? ""; } catch { }
          try { cls = c.ClassName ?? ""; } catch { }
        }
        if (isAct && !isPwd) {
          try { help = c.HelpText ?? ""; } catch { }
          if (type == "Edit" || type == "ComboBox") { long tl = sw.ElapsedTicks; try { var lbe = el.Current.LabeledBy; if (lbe != null) lab = lbe.Current.Name ?? ""; } catch { } TLab += (sw.ElapsedTicks - tl) * 1000 / Stopwatch.Frequency; }
        }
        if (cls == "UIProperty") pts = "value,griditem,tableitem";
        else if (isAct && type != "ListItem" && type != "TreeItem" && type != "DataItem" && patternBudget > 0) {
          patternBudget--; long tg = sw.ElapsedTicks;
          try {
            var list = new List<string>();
            foreach (var pp in el.GetSupportedPatterns()) list.Add(pp.ProgrammaticName.Replace("PatternIdentifiers.Pattern", "").ToLowerInvariant());
            pts = string.Join(",", list);
          } catch { }
          try { object pe; if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pe)) exp = ((ExpandCollapsePattern)pe).Current.ExpandCollapseState.ToString().ToLowerInvariant(); } catch { }
          TPat += (sw.ElapsedTicks - tg) * 1000 / Stopwatch.Frequency; NPat++;
        }
        int bl = 0, bt = 0, bw = 0, bh = 0;
        try { var br = c.BoundingRectangle; if (!br.IsEmpty && !double.IsInfinity(br.Width)) { bl = (int)br.Left; bt = (int)br.Top; bw = (int)br.Width; bh = (int)br.Height; } } catch { }
        bool en = false, off = false, foc = false;
        try { en = c.IsEnabled; off = c.IsOffscreen; foc = c.HasKeyboardFocus; } catch { }
        items.Add(new Item { t = type, n = name, e = en, o = off, v = value ?? "", p = isPwd, r = rid, s = state, ro = readOnly, f = foc, b = bl + "," + bt + "," + bw + "," + bh, pa = panel, id = aid, cl = cls, hp = help, lb = lab, pt = pts, x = exp });
      }
      if (depth < 14) {
        // the SAME walker as the one-shot reader (FindAll with the control-view condition sees XAML-hosted parts differently), but each
        // step returns the element with its properties already fetched
        long tf = sw.ElapsedTicks;
        var kids = new List<AutomationElement>();
        try {
          // navigate exactly like the one-shot reader (plain walker: a cached walk reaches a different set of children in Explorer's
          // XAML-hosted parts), then fetch each element's properties in ONE call
          var ch = TreeWalker.ControlViewWalker.GetFirstChild(el);
          while (ch != null && kids.Count < 60) {
            AutomationElement withProps = ch;
            if (!Plain) { try { withProps = ch.GetUpdatedCache(cr); } catch { } }
            kids.Add(withProps);
            ch = TreeWalker.ControlViewWalker.GetNextSibling(ch);
          }
        } catch (Exception kx) { KidErr++; LastKidErr = kx.GetType().Name + " under '" + name + "' (" + type + ") after " + kids.Count + " kids: " + kx.Message; }
        TFind += (sw.ElapsedTicks - tf) * 1000 / Stopwatch.Frequency; NFind++;
        for (int i = kids.Count - 1; i >= 0; i--) stack.Push(new object[] { kids[i], depth + 1, childPanel });
      }
      } catch (Exception ex) { var st = ex.StackTrace ?? ""; int ni = st.IndexOf("ReadTree"); LastErr = ex.GetType().Name + ": " + ex.Message + " | " + st.Substring(0, Math.Min(st.Length, 160)); NErr++; }
    }
    truncated = stack.Count > 0;
    return items;
  }

  public static string Read(long hwnd) {
    var sw = Stopwatch.StartNew();
    bool trunc;
    var items = ReadTree(hwnd, sw, out trunc);
    TTotal += sw.ElapsedMilliseconds;
    // Chromium-based apps build their accessibility tree only after a client asks: look again once
    if (items.Count < 15) {
      Thread.Sleep(600);
      bool t2; var i2 = ReadTree(hwnd, sw, out t2);
      if (i2.Count > items.Count) { items = i2; trunc = t2; }
    }
    var sb = new StringBuilder();
    sb.Append("{\"ok\":true,\"truncated\":").Append(B(trunc)).Append(",\"items\":[");
    for (int i = 0; i < items.Count; i++) {
      var it = items[i];
      if (i > 0) sb.Append(',');
      sb.Append("{\"t\":"); Q(sb, it.t); sb.Append(",\"n\":"); Q(sb, it.n); sb.Append(",\"e\":").Append(B(it.e)).Append(",\"o\":").Append(B(it.o));
      sb.Append(",\"v\":"); Q(sb, it.v); sb.Append(",\"p\":").Append(B(it.p)); sb.Append(",\"r\":"); Q(sb, it.r); sb.Append(",\"s\":"); Q(sb, it.s);
      sb.Append(",\"ro\":").Append(B(it.ro)).Append(",\"f\":").Append(B(it.f)); sb.Append(",\"b\":"); Q(sb, it.b); sb.Append(",\"pa\":"); Q(sb, it.pa);
      sb.Append(",\"id\":"); Q(sb, it.id); sb.Append(",\"cl\":"); Q(sb, it.cl); sb.Append(",\"hp\":"); Q(sb, it.hp); sb.Append(",\"lb\":"); Q(sb, it.lb);
      sb.Append(",\"pt\":"); Q(sb, it.pt); sb.Append(",\"x\":"); Q(sb, it.x); sb.Append('}');
    }
    sb.Append("]}");
    return sb.ToString();
  }
}

// Change notifications: WHICH kind of thing changed and in WHICH window (handles only: never titles, text or pixels), pushed as "@@!E {json}".
// Switched on only while something is waiting for a change ("events on"), off again afterwards. A heartbeat ("@@!H") proves the hook thread's
// message loop is really turning; the Node side treats events as unreliable without it and polls instead.
public static class MomoEvents {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr h);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  const uint WM_APP1 = 0x8001, WM_QUIT = 0x0012;
  static readonly object Gate = new object();
  static readonly List<string> Pending = new List<string>();
  static WinEventProc Keep; // the delegate must stay alive as long as the hooks do
  static Thread Pump; static uint PumpId; static Timer Tick;
  static long Seq; static int LastPump; static bool Overflow; static bool On;
  static readonly List<IntPtr> Hooks = new List<IntPtr>();

  static string Kind(uint ev) {
    switch (ev) {
      case 0x0003: return "fg";
      case 0x0004: case 0x0005: case 0x0006: case 0x0007: return "menu";
      case 0x0010: case 0x0011: return "dialog";
      case 0x0013: return "scroll";
      case 0x000A: case 0x000B: return "move";
      case 0x0016: case 0x0017: return "min";
      case 0x8000: return "create";
      case 0x8001: return "destroy";
      case 0x8002: return "show";
      case 0x8003: return "hide";
      case 0x8004: return "reorder";
      case 0x8005: return "focus";
      case 0x8006: case 0x8007: case 0x8008: case 0x8009: return "select";
      case 0x800A: return "state";
      case 0x800C: return "name";
      case 0x800E: return "value";
    }
    return null;
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObj, int idChild, uint thread, uint time) {
    try {
      string k = Kind(ev);
      if (k == null) return;
      bool windowEvent = ev == 0x8000 || ev == 0x8001 || ev == 0x8002 || ev == 0x8003;
      if (windowEvent && (idObj != 0 || idChild != 0)) return;      // only whole windows, not their parts
      if (!windowEvent && idObj < 0 && idObj != -4) return;          // not the mouse cursor, the caret, sounds or alerts
      IntPtr root = hwnd == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hwnd, 2);
      if (windowEvent && root != hwnd) return;                       // a window of its own (not a part inside another one)
      string row = "[\"" + k + "\"," + root.ToInt64() + "]";
      lock (Gate) {
        if (Pending.Count >= 48) { Overflow = true; return; }
        if (!Pending.Contains(row)) Pending.Add(row);
      }
    } catch { }
  }

  static void Flush() {
    string[] rows = null; bool over;
    lock (Gate) { over = Overflow; Overflow = false; if (Pending.Count > 0) { rows = Pending.ToArray(); Pending.Clear(); } }
    if (rows != null || over) {
      long n = Interlocked.Increment(ref Seq);
      Console.Out.WriteLine("@@!E {\"n\":" + n + (over ? ",\"many\":true" : "") + ",\"e\":[" + (rows == null ? "" : string.Join(",", rows)) + "]}");
    }
  }

  static int Beat;
  static void OnTick(object state) {
    try {
      if (!On) return;
      Flush();
      if (++Beat % 25 == 0) { // about once a second: ask the message loop to answer; no answer = no heartbeat = the Node side polls
        PostThreadMessage(PumpId, WM_APP1, IntPtr.Zero, IntPtr.Zero);
      }
      if (Beat % 25 == 2 && Environment.TickCount - LastPump < 3000) Console.Out.WriteLine("@@!H " + Environment.TickCount);
    } catch { }
  }

  public static string Start() {
    lock (Gate) {
      if (On) return "{\"ok\":true,\"on\":true}";
      var ready = new ManualResetEvent(false);
      bool hooked = false;
      Keep = OnEvent;
      Pump = new Thread(delegate () {
        PumpId = GetCurrentThreadId();
        uint flags = 0; // out of context: the callback runs on THIS thread's message loop, inside no other process
        Hooks.Add(SetWinEventHook(0x0003, 0x0017, IntPtr.Zero, Keep, 0, 0, flags));
        Hooks.Add(SetWinEventHook(0x8000, 0x800A, IntPtr.Zero, Keep, 0, 0, flags));
        Hooks.Add(SetWinEventHook(0x800C, 0x800E, IntPtr.Zero, Keep, 0, 0, flags));
        hooked = Hooks.TrueForAll(delegate (IntPtr h) { return h != IntPtr.Zero; });
        LastPump = Environment.TickCount;
        ready.Set();
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
          if (m.message == WM_APP1) { LastPump = Environment.TickCount; continue; }
          TranslateMessage(ref m); DispatchMessage(ref m);
        }
        foreach (var h in Hooks) if (h != IntPtr.Zero) UnhookWinEvent(h);
        Hooks.Clear();
      });
      Pump.IsBackground = true; Pump.SetApartmentState(ApartmentState.STA); Pump.Start();
      ready.WaitOne(1500);
      if (!hooked) { Stop(); return "{\"ok\":false,\"on\":false}"; }
      On = true; Pending.Clear(); Beat = 0;
      Tick = new Timer(OnTick, null, 40, 40);
      return "{\"ok\":true,\"on\":true}";
    }
  }

  public static string Stop() {
    lock (Gate) {
      On = false;
      if (Tick != null) { Tick.Dispose(); Tick = null; }
      if (PumpId != 0) PostThreadMessage(PumpId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
      PumpId = 0; Pending.Clear();
      return "{\"ok\":true,\"on\":false}";
    }
  }
}
'@

[MomoHost]::Dpi()
[Console]::Out.WriteLine('@@READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split(' ')
  $id = $p[0]
  try {
    if ($p[1] -eq 'uia') { $out = [MomoHost]::Read([long]$p[2]) }
    elseif ($p[1] -eq 'at') { $out = [MomoHost]::At([int]$p[2], [int]$p[3]) }
    elseif ($p[1] -eq 'state') { $out = [MomoHost]::State([long]$p[2]) }
    elseif ($p[1] -eq 'windows') { $out = [MomoHost]::Windows() }
    elseif ($p[1] -eq 'uiaplain') { [MomoHost]::Plain = $true; try { $out = [MomoHost]::Read([long]$p[2]) } finally { [MomoHost]::Plain = $false } }
    elseif ($p[1] -eq 'prof') { $out = [MomoHost]::Prof() }
    elseif ($p[1] -eq 'events') { if ($p[2] -eq 'on') { $out = [MomoEvents]::Start() } else { $out = [MomoEvents]::Stop() } }
    elseif ($p[1] -eq 'ping') { $out = '{"ok":true}' }
    else { $out = '{"ok":false,"error":"unknown"}' }
  } catch { $out = '{"ok":false,"error":"uia_failed"}' }
  [Console]::Out.WriteLine('@@' + $id + ' ' + $out)
  [Console]::Out.Flush()
}
`;

interface Pending { id: number; resolve(v: string): void; reject(e: Error): void; timer: NodeJS.Timeout; line: string; started: number }

export interface HelperStats { lastError?: string; starts: number; requests: number; failures: number; lastMs: number | null; running: boolean; disabledUntil: number }

/** The host process and its request queue. One request runs at a time (the host is single-threaded). */
export class UiaHost implements ChangeSource {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buf = "";
  private nextId = 1;
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disabledUntil = 0;
  private lastError = "";
  // change events (handles only), kept in memory for a moment: the last few batches
  private evSeq = 0;
  private evLog: Array<{ seq: number; events: ChangeEvent[] }> = [];
  private evWaiters: Array<() => void> = [];
  private evUsers = 0;
  private evOn = false;
  private evBeat = 0;
  private evOff: NodeJS.Timeout | null = null;
  private stat: HelperStats = { starts: 0, requests: 0, failures: 0, lastMs: null, running: false, disabledUntil: 0 };

  constructor(private opts: { script?: string; enabled?: () => boolean; command?: string; args?: (script: string) => string[] } = {}) {}

  /** can a request be sent right now? false while switched off or cooling off after a failed start */
  usable(): boolean {
    if (process.platform !== "win32" && !this.opts.command) return false;
    if (this.opts.enabled && !this.opts.enabled()) return false;
    return Date.now() >= this.disabledUntil;
  }
  stats(): HelperStats { return { ...this.stat, running: !!this.child, disabledUntil: this.disabledUntil, lastError: this.lastError }; }

  /** start it ahead of the first request (the compile takes a couple of seconds, once) */
  warm(): void { if (this.usable()) void this.ensure().catch(() => {}); }

  private ensure(): Promise<void> {
    if (this.ready && this.child) return this.ready;
    this.stat.starts++;
    const script = this.opts.script ?? HELPER_SCRIPT;
    const cmd = this.opts.command ?? "powershell.exe";
    // The script is longer than the 32 KB Windows command-line limit, and an "Invoke-Expression of a base64 string" stub looks like malware to
    // Windows Defender (it refused to start it): so the script is a plain file in the user's own temp folder, named by its content, run with -File.
    let args: string[];
    try { args = this.opts.args ? this.opts.args(script) : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile(script)]; }
    catch (e) { this.disabledUntil = Date.now() + COOL_OFF_MS; this.lastError = String((e as Error).message).slice(0, 200); return Promise.reject(e as Error); }
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { this.disabledUntil = Date.now() + COOL_OFF_MS; this.lastError = String((e as Error).message).slice(0, 200); return Promise.reject(e as Error); } // e.g. EPERM: use the one-shot script for a while
    child.stdin.on("error", () => { /* the exit handler deals with a dead helper */ });
    // the helper must never keep its parent alive: when the parent ends, the pipe closes and the helper exits by itself
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr] as unknown as Array<{ unref?: () => void }>) s.unref?.();
    this.child = child; this.buf = "";
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (d: Buffer) => { this.lastError = String(d).slice(0, 400); });
    this.ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { this.kill(); reject(new Error("helper start timeout")); }, START_TIMEOUT_MS);
      const onData = (d: string) => {
        this.buf += d;
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).replace(/\r$/, "");
          this.buf = this.buf.slice(nl + 1);
          const at = line.indexOf("@@");
          if (at < 0) continue;
          const body = line.slice(at + 2);
          if (body.startsWith("!")) { this.onEventLine(body); continue; }
          if (body === "READY") { clearTimeout(t); resolve(); continue; }
          const sp = body.indexOf(" ");
          const id = Number(body.slice(0, sp));
          this.finish(id, body.slice(sp + 1));
        }
      };
      child.stdout.on("data", onData);
      child.on("exit", () => { clearTimeout(t); this.onExit(child); reject(new Error("helper exited")); });
      child.on("error", () => { clearTimeout(t); this.onExit(child); reject(new Error("helper could not start")); });
    });
    this.ready.catch(() => { this.disabledUntil = Date.now() + COOL_OFF_MS; });
    return this.ready;
  }

  private failAll(err: Error): void {
    if (this.current) { clearTimeout(this.current.timer); this.stat.failures++; this.current.reject(err); this.current = null; }
    for (const p of this.queue.splice(0)) { clearTimeout(p.timer); p.reject(err); }
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return; // already replaced or stopped on purpose
    this.child = null; this.ready = null; this.evOn = false; this.evBeat = 0;
    this.failAll(new Error("helper exited"));
  }

  private kill(): void {
    const c = this.child;
    this.child = null; this.ready = null; this.evOn = false; this.evBeat = 0;
    try { c?.kill(); } catch { /* already gone */ }
    this.failAll(new Error("helper stopped"));
  }

  private finish(id: number, json: string): void {
    const cur = this.current;
    if (!cur || cur.id !== id) return;
    clearTimeout(cur.timer);
    this.current = null;
    this.stat.lastMs = Date.now() - cur.started;
    cur.resolve(json);
    this.pump();
  }

  private pump(): void {
    if (this.current || !this.child) return;
    const next = this.queue.shift();
    if (!next) { this.armIdle(); return; }
    this.current = next;
    next.started = Date.now();
    try { this.child.stdin.write(next.line + "\n"); } catch { /* the exit handler rejects it */ }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.current && this.queue.length === 0) this.kill(); }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  /** Ask the helper. Rejects on timeout or when it dies: the caller falls back to the one-shot script. */
  async request<T>(command: string, timeoutMs: number): Promise<T> {
    if (!this.usable()) throw new Error("helper unavailable");
    await this.ensure();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.stat.requests++;
    const id = this.nextId++;
    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // a request that hangs takes the helper down with it: a stuck UI Automation call cannot be cancelled from outside
        // detach THIS request first, so the shutdown does not also reject it (with a less useful reason) or count it twice
        if (this.current?.id === id) this.current = null;
        else this.queue = this.queue.filter((q) => q.id !== id);
        this.stat.failures++;
        this.kill();
        reject(new Error("helper timeout"));
      }, timeoutMs);
      this.queue.push({ id, resolve, reject, timer, line: `${id} ${command}`, started: 0 });
      this.pump();
    });
    try { return JSON.parse(raw) as T; } catch { this.stat.failures++; throw new Error("helper answer unreadable"); }
  }

  // ---------------------------------------------------------------- change events (ChangeSource)
  private onEventLine(body: string): void {
    if (body.startsWith("!H")) { this.evBeat = Date.now(); return; }
    if (!body.startsWith("!E ")) return;
    try {
      const j = JSON.parse(body.slice(3)) as { n: number; many?: boolean; e: Array<[string, number]> };
      const events: ChangeEvent[] = j.e.map(([kind, root]) => ({ kind: String(kind), root: Number(root) }));
      if (j.many) events.push({ kind: "many", root: 0 }); // some were dropped: treat as "something changed somewhere"
      this.evSeq++;
      this.evLog.push({ seq: this.evSeq, events });
      if (this.evLog.length > 64) this.evLog.shift();
      for (const w of this.evWaiters.splice(0)) w();
    } catch { /* an unreadable event line is just a missing event: callers poll anyway */ }
  }

  /** events are flowing: the hook is installed AND its message loop has answered a heartbeat recently */
  healthy(): boolean { return !!this.child && this.evOn && Date.now() - this.evBeat < 3500; }
  seq(): number { return this.evSeq; }

  next(since: number, ms: number): Promise<{ seq: number; events: ChangeEvent[] }> {
    const grab = () => ({ seq: this.evSeq, events: this.evLog.filter((b) => b.seq > since).flatMap((b) => b.events) });
    if (this.evSeq > since || ms <= 0) return Promise.resolve(grab());
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const wake = () => { clearTimeout(timer); resolve(grab()); };
      timer = setTimeout(() => { this.evWaiters = this.evWaiters.filter((w) => w !== wake); resolve(grab()); }, ms);
      timer.unref?.();
      this.evWaiters.push(wake);
    });
  }

  /** the hook is only switched on while something waits (and for a short while after, so a run of waits does not flap it) */
  acquire(): () => void {
    this.evUsers++;
    if (this.evOff) { clearTimeout(this.evOff); this.evOff = null; }
    if (!this.evOn && this.usable()) {
      this.evOn = true; // optimistic: healthy() still needs a heartbeat before anyone relies on it
      this.evBeat = 0;
      this.request<{ ok: boolean }>("events on", 5000).then((r) => { if (!r.ok) this.evOn = false; }).catch(() => { this.evOn = false; });
    }
    let released = false;
    return () => {
      if (released) return; released = true;
      if (--this.evUsers > 0) return;
      this.evOff = setTimeout(() => {
        this.evOff = null;
        if (this.evUsers > 0 || !this.evOn) return;
        this.evOn = false;
        if (this.child) this.request("events off", 3000).catch(() => {});
      }, 10_000);
      this.evOff.unref?.();
    };
  }

  /** stop the helper (the app is quitting, or a test is done) */
  stop(): void { if (this.idleTimer) clearTimeout(this.idleTimer); this.kill(); }
}
