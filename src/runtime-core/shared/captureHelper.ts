/**
 * The capture half of the long-lived helper (Phase 6a): one window's pixels, taken with PrintWindow(PW_RENDERFULLCONTENT) into a bitmap that lives
 * ONLY in the helper process' memory. Nothing here ever returns pixels: a reply is numbers and a verdict (is this frame real content?).
 *
 *  - It is compiled lazily, on the first capture request, so a task that never looks at pixels pays nothing for it.
 *  - One session at a time (one window). Starting another, stopping, an idle period (IDLE_MS) or the helper's exit frees the bitmap.
 *  - Memory is bounded: a window larger than MAX_PIXELS is refused (that is 64 MB), never grown into.
 *  - A frame is evidence of CONTENT only when it is not blank/black AND the frame before it agrees with it (two successive frames). A blank,
 *    black, still-changing or half-painted frame is reported as exactly that, never as "the window has nothing in it".
 *  - A minimized, hidden (other virtual desktop), hung or capture-excluded window is refused before a single pixel is requested.
 *  - Coordinates are PHYSICAL screen pixels (the helper is per-monitor DPI aware); a moved or resized window resets readiness.
 *
 * Phase 6b adds DETECTION on a frame that is already in memory: coloured button-like rectangles (found here, in C#) and OCR words with boxes
 * (Windows OCR on the in-memory bitmap: no PNG, no file). The pixels are copied to a temporary array only for that one operation and dropped
 * at once; the reply carries rectangles and recognised words, never pixels. What the words and shapes MEAN is decided in vision/detect.ts.
 */
export const CAPTURE_SOURCE = String.raw`
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MomoCapture {
  const int MaxPixels = 4096 * 4096;      // 64 MB of BGRA: the most one session may hold
  const int MinSide = 40;
  const int IdleMs = 20000;               // no request for this long: the bitmap is released
  const int Grid = 24;                    // the settled-ness signature: mean colour of 24 x 24 tiles
  const int SamplePerSide = 512;          // at most ~262k sampled pixels per frame
  const int TileDelta = 6;                // a tile counts as changed when a channel moved by more than this
  const double AgreePct = 2.0;            // two frames agree when at most this percent of tiles changed
  const double NonBlackMinPct = 0.5;      // below this share of non-black pixels the frame is "black"
  const int MinColors = 4;                // fewer distinct (quantized) colours than this: "blank"

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct BMIH { public int Size, Width, Height; public short Planes, BitCount; public int Compression, SizeImage, XPels, YPels, ClrUsed, ClrImportant; }
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint x, out uint y);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BMIH bi, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("kernel32.dll")] static extern void RtlMoveMemory(IntPtr dest, IntPtr src, UIntPtr n);

  static readonly object Gate = new object();
  static IntPtr Hwnd, Dc, Bmp, OldBmp, Bits;
  static int W, H, RL, RT;                // the BITMAP size, and the window position the LAST frame was taken at
  static int PW, PH;                      // the window's real (physical) size: the bitmap is smaller for a DPI-virtualized window
  static double Scl = 1;                  // real pixels per bitmap pixel (2 for a DPI-unaware window on a 200% screen)
  static int SessionNo, FrameNo, Stable;
  static byte[] Sig;                      // tile signature of the last good (non-blank) frame
  static int LastTick;                    // when the last frame was taken (ms)
  static int LastUse;
  static Timer IdleTimer;

  static string N(double d) { return Math.Round(d, 1).ToString(CultureInfo.InvariantCulture); }
  static string Fail(string state) { return "{\"ok\":false,\"state\":\"" + state + "\"}"; }
  static bool Free() { return Bmp == IntPtr.Zero; }

  [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);

  /** How many real pixels one pixel of what PrintWindow returns covers. A DPI-UNAWARE window is drawn by Windows at its logical size and scaled up on
      screen: PrintWindow hands back that logical picture in the top-left corner, so a point (x, y) in it is at (left + x * scale, top + y * scale). */
  static double VirtScale(IntPtr h) {
    try {
      int aw = GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(h));   // 0 unaware, 1 system, 2 per-monitor
      uint wd = GetDpiForWindow(h), md = 0, dy;
      GetDpiForMonitor(MonitorFromWindow(h, 2), 0, out md, out dy);
      if (wd == 0 || md == 0) return 1.0;
      if (aw == 0) return md > 96 ? md / 96.0 : 1.0;
      if (aw == 1 && md > wd) return md / (double)wd;
    } catch { }
    return 1.0;
  }

  static void Release() {
    if (Dc != IntPtr.Zero && OldBmp != IntPtr.Zero) SelectObject(Dc, OldBmp);
    if (Bmp != IntPtr.Zero) DeleteObject(Bmp);
    if (Dc != IntPtr.Zero) DeleteDC(Dc);
    Dc = IntPtr.Zero; Bmp = IntPtr.Zero; OldBmp = IntPtr.Zero; Bits = IntPtr.Zero; Hwnd = IntPtr.Zero;
    Sig = null; Stable = 0; W = 0; H = 0; PW = 0; PH = 0; Scl = 1;
    if (IdleTimer != null) { IdleTimer.Dispose(); IdleTimer = null; }
  }

  static void OnIdle(object o) {
    lock (Gate) { if (!Free() && Environment.TickCount - LastUse >= IdleMs) Release(); }
  }

  /** why this window may not be captured right now, or null when it may */
  static string Refusal(IntPtr h) {
    if (!IsWindow(h)) return "gone";
    if (IsIconic(h)) return "minimized";
    if (!IsWindowVisible(h)) return "hidden";
    int cloaked = 0; try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
    if (cloaked != 0) return "hidden";
    uint aff = 0; try { GetWindowDisplayAffinity(h, out aff); } catch { }
    if (aff != 0) return "excluded";
    if (IsHungAppWindow(h)) return "hung";
    return null;
  }

  // ---- a bounded PrintWindow. PrintWindow waits for the TARGET to answer: a busy application (its UI thread blocked, not yet "not responding") would hold
  // this single-threaded helper for as long as it stays busy, and past the request timeout the helper itself would be killed. So it runs on a worker thread
  // with its OWN scratch bitmap; if the target has not answered in PrintTimeoutMs the wait is abandoned ("busy": an honest refusal, never a stale frame) and the
  // worker discards its result and frees the scratch bitmap whenever it finally returns. At most 3 abandoned workers exist, and none for a window that already has one.
  const int PrintTimeoutMs = 1500;
  class PrintJob {
    public IntPtr Hwnd, Dc, Bmp, Old, Bits; public int W, H; public bool Ok, Finished, Abandoned; public ManualResetEvent Done = new ManualResetEvent(false);
    public void Free() {
      if (Dc != IntPtr.Zero && Old != IntPtr.Zero) SelectObject(Dc, Old);
      if (Bmp != IntPtr.Zero) DeleteObject(Bmp);
      if (Dc != IntPtr.Zero) DeleteDC(Dc);
      Dc = IntPtr.Zero; Bmp = IntPtr.Zero; Old = IntPtr.Zero; Bits = IntPtr.Zero;
    }
  }
  static readonly System.Collections.Generic.List<PrintJob> Stuck = new System.Collections.Generic.List<PrintJob>();

  /** PrintWindow into the session bitmap, within PrintTimeoutMs. busy = "busy" when the window did not answer in time (nothing was copied). */
  static bool PrintBounded(IntPtr h, out string busy) {
    busy = null;
    lock (Stuck) {
      Stuck.RemoveAll(delegate (PrintJob x) { lock (x) { return x.Finished; } });
      foreach (var s in Stuck) if (s.Hwnd == h) { busy = "busy"; return false; }     // it already has a worker that has not come back: do not pile on
      if (Stuck.Count >= 3) { busy = "busy"; return false; }
    }
    var j = new PrintJob(); j.Hwnd = h; j.W = W; j.H = H;
    BMIH bi = new BMIH(); bi.Size = Marshal.SizeOf(typeof(BMIH)); bi.Width = W; bi.Height = -H; bi.Planes = 1; bi.BitCount = 32;
    j.Dc = CreateCompatibleDC(IntPtr.Zero);
    if (j.Dc == IntPtr.Zero) return false;
    j.Bmp = CreateDIBSection(IntPtr.Zero, ref bi, 0, out j.Bits, IntPtr.Zero, 0);
    if (j.Bmp == IntPtr.Zero || j.Bits == IntPtr.Zero) { j.Free(); return false; }
    j.Old = SelectObject(j.Dc, j.Bmp);
    var th = new Thread(delegate () {
      try { j.Ok = PrintWindow(j.Hwnd, j.Dc, 2); } catch { j.Ok = false; }
      finally { bool drop; lock (j) { j.Finished = true; drop = j.Abandoned; if (drop) j.Free(); } j.Done.Set(); if (drop) j.Done.Close(); }   // an abandoned job is nobody's any more: it releases its own bitmap and event
    });
    th.IsBackground = true; th.Start();
    if (!j.Done.WaitOne(PrintTimeoutMs)) {
      lock (j) {
        if (!j.Finished) { j.Abandoned = true; lock (Stuck) { Stuck.Add(j); } busy = "busy"; return false; }
      }
    }
    bool ok;
    lock (j) {
      ok = j.Ok;
      j.Done.Close();   // answered in time: the worker has already signalled, so nothing else touches the event
      if (ok && Bits != IntPtr.Zero && j.Bits != IntPtr.Zero) RtlMoveMemory(Bits, j.Bits, (UIntPtr)((long)W * H * 4));
      j.Free();
    }
    return ok;
  }

  static bool Alloc(int w, int h) {
    if (Bmp != IntPtr.Zero) {
      if (Dc != IntPtr.Zero && OldBmp != IntPtr.Zero) SelectObject(Dc, OldBmp);
      DeleteObject(Bmp); Bmp = IntPtr.Zero; Bits = IntPtr.Zero;
    }
    BMIH bi = new BMIH(); bi.Size = Marshal.SizeOf(typeof(BMIH)); bi.Width = w; bi.Height = -h; bi.Planes = 1; bi.BitCount = 32;
    IntPtr bits;
    IntPtr bmp = CreateDIBSection(IntPtr.Zero, ref bi, 0, out bits, IntPtr.Zero, 0);
    if (bmp == IntPtr.Zero || bits == IntPtr.Zero) return false;
    IntPtr old = SelectObject(Dc, bmp);
    if (OldBmp == IntPtr.Zero) OldBmp = old;
    Bmp = bmp; Bits = bits; W = w; H = h;
    return true;
  }

  public static string Start(long hwnd) {
    lock (Gate) {
      Release();
      IntPtr h = new IntPtr(hwnd);
      string why = Refusal(h);
      if (why != null) return Fail(why);
      RECT r; if (!GetWindowRect(h, out r)) return Fail("gone");
      int w = r.R - r.L, hh = r.B - r.T;
      if (w < MinSide || hh < MinSide) return Fail("too_small");
      double scl = VirtScale(h);
      int bw = Math.Max(1, (int)Math.Round(w / scl)), bh = Math.Max(1, (int)Math.Round(hh / scl));
      if ((long)bw * bh > MaxPixels) return Fail("too_big");
      Dc = CreateCompatibleDC(IntPtr.Zero);
      if (Dc == IntPtr.Zero) return Fail("failed");
      if (!Alloc(bw, bh)) { Release(); return Fail("failed"); }
      PW = w; PH = hh; Scl = scl;
      Hwnd = h; RL = r.L; RT = r.T; SessionNo++; FrameNo = 0; Stable = 0; Sig = null;
      LastUse = Environment.TickCount; LastTick = 0;
      IdleTimer = new Timer(OnIdle, null, 5000, 5000);   // checked every 5 s: released as soon as it has been idle for IdleMs
      return "{\"ok\":true,\"session\":" + SessionNo + ",\"bytes\":" + ((long)bw * bh * 4) + "}";
    }
  }

  public static string Stop() {
    bool was;
    lock (Gate) { was = !Free(); Release(); }
    GC.Collect(); GC.WaitForPendingFinalizers();   // give back the per-frame worker threads' handles now, not whenever the collector next runs
    return "{\"ok\":true,\"was\":" + (was ? "true" : "false") + "}";
  }

  /** the session's state without taking a frame: is it still the same window, in the same place, and how old is the last frame? */
  public static string Info() {
    lock (Gate) {
      if (Free()) return "{\"ok\":true,\"active\":false}";
      LastUse = Environment.TickCount;
      string why = Refusal(Hwnd);
      RECT r; bool got = GetWindowRect(Hwnd, out r);
      bool same = got && r.L == RL && r.T == RT && (r.R - r.L) == PW && (r.B - r.T) == PH;
      return "{\"ok\":true,\"active\":true,\"session\":" + SessionNo + ",\"frame\":" + FrameNo + ",\"ageMs\":" + (LastTick == 0 ? -1 : Environment.TickCount - LastTick) + ",\"sameRect\":" + (same ? "true" : "false") + ",\"refusal\":" + (why == null ? "null" : "\"" + why + "\"") + ",\"bytes\":" + ((long)W * H * 4) + "}";
    }
  }

  public static string Grab() {
    lock (Gate) {
      if (Free()) return Fail("no_session");
      LastUse = Environment.TickCount;
      string why = Refusal(Hwnd);
      if (why != null) { Sig = null; Stable = 0; return Fail(why); }
      RECT r0; if (!GetWindowRect(Hwnd, out r0)) return Fail("gone");
      int w = r0.R - r0.L, h = r0.B - r0.T;
      double scl = VirtScale(Hwnd);
      bool resized = (w != PW || h != PH || Math.Abs(scl - Scl) > 0.01), moved = (r0.L != RL || r0.T != RT);
      if (resized) {
        if (w < MinSide || h < MinSide) return Fail("too_small");
        int bw = Math.Max(1, (int)Math.Round(w / scl)), bh = Math.Max(1, (int)Math.Round(h / scl));
        if ((long)bw * bh > MaxPixels) return Fail("too_big");
        if (!Alloc(bw, bh)) { Release(); return Fail("failed"); }
        PW = w; PH = h; Scl = scl;
      }
      if (resized || moved) { Sig = null; Stable = 0; }   // what was seen before is about another place: start the readiness count again
      RL = r0.L; RT = r0.T;
      int t0 = Environment.TickCount;
      string busy; bool pw = PrintBounded(Hwnd, out busy);
      int ms = Environment.TickCount - t0;
      if (busy != null) { Sig = null; Stable = 0; return Fail(busy); }   // the window did not answer in time: no frame, and nothing is claimed about it
      RECT r1; bool got1 = GetWindowRect(Hwnd, out r1);
      FrameNo++; LastTick = Environment.TickCount;
      if (!got1 || r1.L != r0.L || r1.T != r0.T || r1.R != r0.R || r1.B != r0.B) { Sig = null; Stable = 0; return Reply("changing", false, ms, 0, 0, 100, r0, resized || moved); }   // the window moved DURING the capture
      if (!pw) { Sig = null; Stable = 0; return Reply("incomplete", false, ms, 0, 0, 100, r0, resized || moved); }

      // sample the frame: non-black share, distinct colours, and a coarse tile signature
      int sx = Math.Max(1, W / SamplePerSide), sy = Math.Max(1, H / SamplePerSide);
      bool[] seen = new bool[4096]; int colors = 0; long samples = 0, nonBlack = 0;
      long[] acc = new long[Grid * Grid * 3]; int[] cnt = new int[Grid * Grid];
      for (int y = 0; y < H; y += sy) {
        int ty = y * Grid / H; long rowOff = (long)y * W * 4;
        for (int x = 0; x < W; x += sx) {
          int px = Marshal.ReadInt32(Bits, (int)(rowOff + (long)x * 4));
          int b = px & 255, g = (px >> 8) & 255, rr = (px >> 16) & 255;
          samples++;
          if (rr + g + b > 24) nonBlack++;
          int key = ((rr >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          if (!seen[key]) { seen[key] = true; colors++; }
          int t = ty * Grid + (x * Grid / W);
          acc[t * 3] += rr; acc[t * 3 + 1] += g; acc[t * 3 + 2] += b; cnt[t]++;
        }
      }
      double nonBlackPct = samples == 0 ? 0 : 100.0 * nonBlack / samples;
      if (nonBlackPct < NonBlackMinPct) { Sig = null; Stable = 0; return Reply("black", false, ms, nonBlackPct, colors, 100, r0, resized || moved); }
      if (colors < MinColors) { Sig = null; Stable = 0; return Reply("blank", false, ms, nonBlackPct, colors, 100, r0, resized || moved); }
      byte[] sig = new byte[Grid * Grid * 3];
      for (int t = 0; t < Grid * Grid; t++) if (cnt[t] > 0) for (int c = 0; c < 3; c++) sig[t * 3 + c] = (byte)(acc[t * 3 + c] / cnt[t]);
      double changedPct = 100;
      if (Sig != null) {
        int ch = 0;
        for (int t = 0; t < Grid * Grid; t++) if (Math.Abs(sig[t * 3] - Sig[t * 3]) > TileDelta || Math.Abs(sig[t * 3 + 1] - Sig[t * 3 + 1]) > TileDelta || Math.Abs(sig[t * 3 + 2] - Sig[t * 3 + 2]) > TileDelta) ch++;
        changedPct = 100.0 * ch / (Grid * Grid);
      }
      if (Sig == null) Stable = 1;
      else if (changedPct <= AgreePct) Stable++;
      else Stable = 1;                                    // it is still changing: this frame is the new first one
      Sig = sig;
      string state = Stable >= 2 ? "ready" : (changedPct > AgreePct && changedPct < 100 ? "changing" : "not_ready");
      return Reply(state, Stable >= 2, ms, nonBlackPct, colors, changedPct, r0, resized || moved);
    }
  }

  /** JSON string content (no quotes) for recognised text */
  public static string Esc(string s) {
    if (s == null) return "";
    var sb = new StringBuilder();
    foreach (char c in s) {
      if (c < 32) sb.Append(' ');
      else if (c == '\\') sb.Append("\\\\");
      else if (c == '"') sb.Append("\\\"");
      else sb.Append(c);
    }
    return sb.ToString();
  }

  /** a temporary copy of the frame the caller was told is ready (null when it is no longer the current one). The caller drops it at once. */
  public static byte[] Frame(int session, int frame, out int w, out int h) {
    lock (Gate) {
      w = 0; h = 0;
      if (Free() || session != SessionNo || frame != FrameNo) return null;
      byte[] buf = new byte[W * H * 4];
      Marshal.Copy(Bits, buf, 0, buf.Length);
      w = W; h = H; LastUse = Environment.TickCount;
      return buf;
    }
  }

  const int NeighbourTol = 6;         // two neighbouring pixels belong together when no channel differs by more than this: follows a smooth gradient, stops at an edge
  const int DriftTol = 64;            // ...but a region never drifts further than this from its first pixel
  const int MinRegionArea = 480;      // real pixels
  const double MinFill = 0.70;        // share of its bounding box a button-like region must fill (text holes and rounded corners are allowed for)
  const double MinFillEdged = 0.40;   // ...or, when the region's four edges are all covered (a button that is mostly text), this much
  const double MinEdgeCover = 0.85;
  const int MinContrast = 14;         // colour distance from the ring around it: a region that looks like its surroundings is not an object

  public static int[][] ShapeList = new int[0][];

  /** how much of the four edges of a box (leaving out the corners) belongs to one region: a rectangle, even a mostly-text one, has its edges covered */
  static double EdgeCover(int[] lab, int id, int sw, int minx, int miny, int maxx, int maxy) {
    int bw = maxx - minx + 1, bh = maxy - miny + 1;
    int cx = Math.Max(1, bw * 15 / 100), cy = Math.Max(1, bh * 15 / 100);
    int hit = 0, tot = 0; double lowest = 1.0, sum = 0;
    for (int side = 0; side < 4; side++) {
      hit = 0; tot = 0;
      if (side < 2) { int y = side == 0 ? miny : maxy; for (int x = minx + cx; x <= maxx - cx; x++) { tot++; if (lab[y * sw + x] == id) hit++; } }
      else { int x = side == 2 ? minx : maxx; for (int y = miny + cy; y <= maxy - cy; y++) { tot++; if (lab[y * sw + x] == id) hit++; } }
      double c = tot == 0 ? 0 : (double)hit / tot; if (c < lowest) lowest = c; sum += c;
    }
    return (sum / 4 >= MinEdgeCover && lowest >= 0.6) ? 1.0 : 0.0;
  }

  /** button-like rectangles: connected regions that follow a smooth colour (a flat fill or a gradient), fill their box (or have all four edges covered), are not the background and stand out from what surrounds them. JSON: [[l,t,w,h,fillPct,contrast],...] in picture pixels. */
  public static string Shapes(byte[] px, int w, int h) {
    int ds = ((long)w * h <= 1300000L) ? 1 : 2;      // a small picture is looked at in full: a thin border must not fall between samples
    int sw = w / ds, sh = h / ds;
    if (px == null || sw < 20 || sh < 20) return "[]";
    int n = sw * sh;
    byte[] R = new byte[n], G = new byte[n], B = new byte[n];
    for (int y = 0; y < sh; y++) for (int x = 0; x < sw; x++) { int i = ((y * ds) * w + x * ds) * 4; B[y * sw + x] = px[i]; G[y * sw + x] = px[i + 1]; R[y * sw + x] = px[i + 2]; }
    int[] lab = new int[n]; int[] stack = new int[n]; int nextId = 0;
    var found = new System.Collections.Generic.List<int[]>();
    int minArea = MinRegionArea / (ds * ds);
    for (int s = 0; s < n; s++) {
      if (lab[s] != 0) continue;
      int id = ++nextId;
      int sr = R[s], sg = G[s], sb = B[s];
      int sp = 0; stack[sp++] = s; lab[s] = id;
      int cnt = 0, minx = sw, miny = sh, maxx = 0, maxy = 0; long ar = 0, ag = 0, ab = 0;
      while (sp > 0) {
        int p = stack[--sp]; int x = p % sw, y = p / sw; cnt++;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        int pr = R[p], pg = G[p], pb = B[p]; ar += pr; ag += pg; ab += pb;
        for (int k = 0; k < 4; k++) {
          int q;
          if (k == 0) { if (x == 0) continue; q = p - 1; } else if (k == 1) { if (x == sw - 1) continue; q = p + 1; } else if (k == 2) { if (y == 0) continue; q = p - sw; } else { if (y == sh - 1) continue; q = p + sw; }
          if (lab[q] != 0) continue;
          int qr = R[q], qg = G[q], qb = B[q];
          if (Math.Abs(qr - pr) > NeighbourTol || Math.Abs(qg - pg) > NeighbourTol || Math.Abs(qb - pb) > NeighbourTol) continue;
          if (Math.Abs(qr - sr) > DriftTol || Math.Abs(qg - sg) > DriftTol || Math.Abs(qb - sb) > DriftTol) continue;
          lab[q] = id; stack[sp++] = q;
        }
      }
      if (cnt < minArea) continue;
      int bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (bw * ds < 28 || bh * ds < 16) continue;
      if ((long)bw * bh > (long)n / 2) continue;                                          // far too big to be a control: a page or panel
      int edges = (minx == 0 ? 1 : 0) + (miny == 0 ? 1 : 0) + (maxx == sw - 1 ? 1 : 0) + (maxy == sh - 1 ? 1 : 0);
      if (edges >= 2) continue;                                                           // the background
      if (bw > 30 * bh || bh > 6 * bw) continue;                                          // a line, not a button
      double fill = (double)cnt / ((double)bw * bh);
      bool rectangular = fill >= MinFill || (fill >= MinFillEdged && EdgeCover(lab, id, sw, minx, miny, maxx, maxy) > 0);
      if (!rectangular) continue;
      double mr = (double)ar / cnt, mg = (double)ag / cnt, mb = (double)ab / cnt;
      int contrast = 0;
      foreach (int d in new int[] { 2, 4 }) {                                              // the ring just outside the box (two distances: an outlined button has its border right there)
        long rr = 0, rg = 0, rb = 0; int rn = 0;
        for (int x = minx; x <= maxx; x += 2) {
          int y1 = miny - d, y2 = maxy + d;
          if (y1 >= 0) { int q = y1 * sw + x; rr += R[q]; rg += G[q]; rb += B[q]; rn++; }
          if (y2 < sh) { int q = y2 * sw + x; rr += R[q]; rg += G[q]; rb += B[q]; rn++; }
        }
        for (int y = miny; y <= maxy; y += 2) {
          int x1 = minx - d, x2 = maxx + d;
          if (x1 >= 0) { int q = y * sw + x1; rr += R[q]; rg += G[q]; rb += B[q]; rn++; }
          if (x2 < sw) { int q = y * sw + x2; rr += R[q]; rg += G[q]; rb += B[q]; rn++; }
        }
        if (rn == 0) continue;
        double dr = mr - (double)rr / rn, dg = mg - (double)rg / rn, db = mb - (double)rb / rn;
        int c = (int)Math.Sqrt(dr * dr + dg * dg + db * db);
        if (c > contrast) contrast = c;
      }
      if (contrast < MinContrast) continue;
      found.Add(new int[] { minx * ds, miny * ds, bw * ds, bh * ds, (int)(fill * 100), contrast });
    }
    found.Sort(delegate (int[] a2, int[] b2) { return (b2[2] * b2[3]).CompareTo(a2[2] * a2[3]); });
    int keep = Math.Min(found.Count, 80); ShapeList = new int[keep][];
    for (int i = 0; i < keep; i++) ShapeList[i] = found[i];
    var sbld = new StringBuilder("[");
    for (int i = 0; i < keep; i++) { if (i > 0) sbld.Append(','); var f = found[i]; sbld.Append('[').Append(f[0]).Append(',').Append(f[1]).Append(',').Append(f[2]).Append(',').Append(f[3]).Append(',').Append(f[4]).Append(',').Append(f[5]).Append(']'); }
    return sbld.Append(']').ToString();
  }

  /** a padded copy of one rectangle of the frame at any scale (bilinear): small text is enlarged to a size the recogniser reads well, large text is REDUCED to one */
  public static byte[] Crop(byte[] px, int w, int h, int l, int t, int cw, int ch, int pad, double up, out int ow, out int oh) {
    int x0 = Math.Max(0, l - pad), y0 = Math.Max(0, t - pad), x1 = Math.Min(w, l + cw + pad), y1 = Math.Min(h, t + ch + pad);
    int sw = x1 - x0, sh = y1 - y0; ow = Math.Max(1, (int)Math.Round(sw * up)); oh = Math.Max(1, (int)Math.Round(sh * up));
    byte[] o = new byte[ow * oh * 4];
    for (int y = 0; y < oh; y++) {
      double fy = (y + 0.5) / up - 0.5; int iy = (int)Math.Floor(fy); double wy = fy - iy;
      int ya = Math.Min(sh - 1, Math.Max(0, iy)) + y0, yb = Math.Min(sh - 1, Math.Max(0, iy + 1)) + y0;
      for (int x = 0; x < ow; x++) {
        double fx = (x + 0.5) / up - 0.5; int ix = (int)Math.Floor(fx); double wx = fx - ix;
        int xa = Math.Min(sw - 1, Math.Max(0, ix)) + x0, xb = Math.Min(sw - 1, Math.Max(0, ix + 1)) + x0;
        int o4 = (y * ow + x) * 4;
        for (int c = 0; c < 3; c++) {
          double v = (px[(ya * w + xa) * 4 + c] * (1 - wx) + px[(ya * w + xb) * 4 + c] * wx) * (1 - wy) + (px[(yb * w + xa) * 4 + c] * (1 - wx) + px[(yb * w + xb) * 4 + c] * wx) * wy;
          o[o4 + c] = (byte)(v + 0.5);
        }
        o[o4 + 3] = 255;
      }
    }
    return o;
  }

  /** like Crop, but as a plain grey picture with the contrast stretched and the text DARK on a light ground whatever the button's colours were: an independent second opinion for a label the first readings could not agree on */
  public static byte[] CropNorm(byte[] px, int w, int h, int l, int t, int cw, int ch, int pad, double up, out int ow, out int oh) {
    byte[] c = Crop(px, w, h, l, t, cw, ch, pad, up, out ow, out oh);
    int n = ow * oh; int[] lum = new int[n]; int mn = 255, mx = 0; int[] hist = new int[32];
    for (int i = 0; i < n; i++) { int v = (c[i * 4] * 29 + c[i * 4 + 1] * 150 + c[i * 4 + 2] * 77) >> 8; lum[i] = v; if (v < mn) mn = v; if (v > mx) mx = v; hist[v >> 3]++; }
    int mode = 0; for (int i = 1; i < 32; i++) if (hist[i] > hist[mode]) mode = i;      // the ground is what most of the picture is made of
    bool darkGround = (mode * 8 + 4) < (mn + mx) / 2;
    int range = Math.Max(1, mx - mn);
    for (int i = 0; i < n; i++) { int v = (lum[i] - mn) * 255 / range; if (darkGround) v = 255 - v; c[i * 4] = (byte)v; c[i * 4 + 1] = (byte)v; c[i * 4 + 2] = (byte)v; }
    return c;
  }

  /** a made-up picture with known rectangles (no window, no screen): lets the shape finder be tested anywhere */
  public static string SelfTest() {
    int w = 400, h = 300; byte[] px = new byte[w * h * 4];
    Action<int, int, int, int, int, int, int> rect = delegate (int l, int t, int rw, int rh, int r, int g, int b) {
      for (int y = t; y < t + rh; y++) for (int x = l; x < l + rw; x++) { int i = (y * w + x) * 4; px[i] = (byte)b; px[i + 1] = (byte)g; px[i + 2] = (byte)r; px[i + 3] = 255; }
    };
    rect(0, 0, w, h, 32, 32, 32);                    // background
    rect(40, 60, 130, 50, 59, 130, 246);             // a blue button
    rect(60, 75, 40, 12, 255, 255, 255);             // its "label" (holes in the region)
    rect(200, 60, 60, 50, 22, 163, 74);              // a green icon-only button
    rect(40, 160, 130, 50, 36, 36, 36);              // almost the background colour: not an object
    rect(220, 190, 150, 100, 70, 70, 90);            // a big panel (not the background: it is a shape, kind decided later)
    for (int y = 0; y < 50; y++) { int g = 200 - y * 36 / 50; rect(40, 220 + y, 130, 1, g, g / 2 + 40, 60); }   // a button filled with a vertical GRADIENT
    rect(200, 125, 140, 44, 230, 140, 30);           // an OUTLINED button: a 2 px border...
    rect(202, 127, 136, 40, 32, 32, 32);             // ...around the page's own colour
    rect(240, 140, 40, 10, 255, 255, 255);           // with a label drawn in it
    return Shapes(px, w, h);
  }

  static string Reply(string state, bool ready, int ms, double nonBlackPct, int colors, double changedPct, RECT r, bool moved) {
    uint dpi = 0, mdpi = 0; try { dpi = GetDpiForWindow(Hwnd); } catch { }
    try { uint dy; GetDpiForMonitor(MonitorFromWindow(Hwnd, 2), 0, out mdpi, out dy); } catch { }
    return "{\"ok\":" + (state == "ready" || state == "not_ready" || state == "changing" ? "true" : "false") + ",\"state\":\"" + state + "\",\"ready\":" + (ready ? "true" : "false") +
      ",\"session\":" + SessionNo + ",\"frame\":" + FrameNo + ",\"w\":" + W + ",\"h\":" + H + ",\"l\":" + r.L + ",\"t\":" + r.T + ",\"pw\":" + PW + ",\"ph\":" + PH + ",\"scale\":" + Scl.ToString("0.###", CultureInfo.InvariantCulture) + ",\"vl\":" + GetSystemMetrics(76) + ",\"vt\":" + GetSystemMetrics(77) + ",\"vw\":" + GetSystemMetrics(78) + ",\"vh\":" + GetSystemMetrics(79) + ",\"dpi\":" + dpi + ",\"mdpi\":" + mdpi + ",\"ms\":" + ms +
      ",\"nonBlackPct\":" + N(nonBlackPct) + ",\"colors\":" + colors + ",\"changedPct\":" + N(changedPct) + ",\"stable\":" + Stable + ",\"moved\":" + (moved ? "true" : "false") + "}";
  }
}
`;

/** The PowerShell side: compile the class once, on first use, then answer the four capture commands. */
export const CAPTURE_PS = String.raw`
$script:capLoaded = $false
function Load-Capture {
  if ($script:capLoaded) { return }
  Add-Type -ReferencedAssemblies 'System.dll' -TypeDefinition @'
@@SOURCE@@
'@
  $script:capLoaded = $true
}

function Invoke-Ocr([byte[]]$bytes, [int]$w, [int]$h) {
  $buf = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
  $bmp = [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buf, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $w, $h, [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)
  try {
    $op = $script:engine.RecognizeAsync($bmp)
    $task = $script:asTask.MakeGenericMethod([Windows.Media.Ocr.OcrResult]).Invoke($null, @($op))
    if (-not $task.Wait(15000)) { return $null }
    return $task.Result
  } finally { $bmp.Dispose() }
}
function Load-Ocr {
  if ($script:ocrLoaded) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${"`"}1' })[0]
  $script:engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  $script:ocrLoaded = $true
}
$script:ocrLoaded = $false

# Detection on the frame that is ALREADY in this process (session + frame must still be the current ones): shapes in C#, words from Windows OCR.
# Nothing is written anywhere; the temporary pixel copy is dropped before the reply.
function Run-Detect([int]$session, [int]$frame) {
  Load-Capture
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $w = 0; $h = 0
  $px = [MomoCapture]::Frame($session, $frame, [ref]$w, [ref]$h)
  if ($null -eq $px) { return '{"ok":false,"state":"stale"}' }
  $msCopy = $sw.ElapsedMilliseconds; $sw.Restart()
  $shapes = [MomoCapture]::Shapes($px, $w, $h)
  $msShapes = $sw.ElapsedMilliseconds; $sw.Restart()
  Load-Ocr
  if ($null -eq $script:engine) { $px = $null; return '{"ok":false,"state":"no_ocr"}' }
  # each plausible button-like rectangle is read ON ITS OWN, enlarged: small and coloured labels are read far better that way than inside a whole frame
  $crops = New-Object System.Text.StringBuilder
  $ci = 0; $cn = 0
  foreach ($sh in [MomoCapture]::ShapeList) {
    if ($cn -ge 14) { break }
    if ($sh[2] -lt 28 -or $sh[2] -gt 700 -or $sh[3] -lt 16 -or $sh[3] -gt 160) { $ci++; continue }
    # the recogniser reads text best at a middling size: enlarge small buttons a lot, big ones not at all, and read at TWO sizes so that two independent readings can be compared
    $up = [Math]::Max(0.6, [Math]::Min(4.0, 110.0 / $sh[3]))
    $up2 = [Math]::Max(0.4, $up * 0.7)
    $txts = @()
    foreach ($u in @($up, $up2)) {
      $ow = 0; $oh = 0
      $cb = [MomoCapture]::Crop($px, $w, $h, $sh[0], $sh[1], $sh[2], $sh[3], 6, $u, [ref]$ow, [ref]$oh)
      $cr = Invoke-Ocr $cb $ow $oh
      $t = ''
      if ($null -ne $cr) { $t = (($cr.Lines | ForEach-Object { $_.Text }) -join ' ') }
      $txts += $t
    }
    # a third, independent reading (grey, contrast stretched, text dark on light) when the first two do not agree, and always for a small button (small text is where two readings can agree on the same wrong text)
    $k0 = ($txts[0].ToLower() -replace '[^a-z0-9]', ''); $k1 = ($txts[1].ToLower() -replace '[^a-z0-9]', '')
    $third = ''
    if ($k0 -eq '' -or $k0 -ne $k1 -or $sh[3] -le 50) {
      $ow = 0; $oh = 0
      $cb = [MomoCapture]::CropNorm($px, $w, $h, $sh[0], $sh[1], $sh[2], $sh[3], 6, $up, [ref]$ow, [ref]$oh)
      $cr = Invoke-Ocr $cb $ow $oh
      if ($null -ne $cr) { $third = (($cr.Lines | ForEach-Object { $_.Text }) -join ' ') }
    }
    if ($cn -gt 0) { [void]$crops.Append(',') }
    [void]$crops.Append('[').Append($ci).Append(',"').Append([MomoCapture]::Esc($txts[0])).Append('","').Append([MomoCapture]::Esc($txts[1])).Append('","').Append([MomoCapture]::Esc($third)).Append('"]')
    $cn++; $ci++
  }
  $msCrops = $sw.ElapsedMilliseconds; $sw.Restart()
  $res = Invoke-Ocr $px $w $h
  if ($null -eq $res) { $px = $null; return '{"ok":false,"state":"ocr_timeout"}' }
  $words = New-Object System.Text.StringBuilder
  $n = 0
  foreach ($l in $res.Lines) { foreach ($wd in $l.Words) {
    if ($n -ge 400) { break }
    $r = $wd.BoundingRect
    if ($n -gt 0) { [void]$words.Append(',') }
    [void]$words.Append('["').Append([MomoCapture]::Esc($wd.Text)).Append('",').Append([int]$r.X).Append(',').Append([int]$r.Y).Append(',').Append([int]$r.Width).Append(',').Append([int]$r.Height).Append(']')
    $n++
  } }
  $px = $null
  $msOcr = $sw.ElapsedMilliseconds
  [GC]::Collect()
  return '{"ok":true,"session":' + $session + ',"frame":' + $frame + ',"w":' + $w + ',"h":' + $h + ',"shapes":' + $shapes + ',"crops":[' + $crops.ToString() + '],"words":[' + $words.ToString() + '],"msCopy":' + $msCopy + ',"msShapes":' + $msShapes + ',"msCrops":' + $msCrops + ',"msOcr":' + $msOcr + '}'
}
`.replace("@@SOURCE@@", () => CAPTURE_SOURCE.trim());
