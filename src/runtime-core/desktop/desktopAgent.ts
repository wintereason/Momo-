import type { WindowsPort } from "../shared/ports";
import { redactSecrets } from "../shared/redact";
import type { WorldModel } from "../verifier";

export interface WindowInfo {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  active: boolean;
  /** this window belongs to Momo itself */
  isMomo: boolean;
  /** how it is shown: "minimized" (only a taskbar button), "maximized" or "normal" */
  state?: "minimized" | "maximized" | "normal";
  /** 0 = in front of everything; larger = further back (unknown windows sort last) */
  z?: number;
}
export interface DesktopSnapshot {
  /** every running program (lower case), windows or not */
  processes?: string[];
  windows: WindowInfo[];
  active: WindowInfo | null;
}

/** Window titles come from other programs: they are untrusted data. Strip control characters and cap the length. */
export function sanitizeTitle(s: unknown): string {
  const cleaned = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  return redactSecrets(cleaned).slice(0, 200);
}

/** Understands the desktop layer: top-level windows, which one is active, which belong to Momo. */
export class DesktopAgent {
  calls = 0;

  constructor(
    private world: WorldModel,
    private win: WindowsPort,
    /** pids of Momo's own processes, so Momo can tell its own window apart */
    private selfPids: () => number[] = () => [],
  ) {}

  async snapshot(): Promise<DesktopSnapshot> {
    this.calls++;
    const raw = await this.win.query();
    const mine = new Set(this.selfPids());
    const valid = raw.windows.filter((w) => Number.isFinite(w.hwnd) && Number.isFinite(w.pid));
    // Prefer the exact foreground window. Only when Windows' foreground window is not one we listed
    // (a dialog, say) fall back to "a window of the foreground program", which is less certain.
    const exact = raw.activeHwnd != null && valid.some((w) => w.hwnd === raw.activeHwnd);
    const windows: WindowInfo[] = valid.map((w) => ({
      hwnd: w.hwnd,
      pid: w.pid,
      process: sanitizeTitle(w.process),
      title: sanitizeTitle(w.title),
      active: exact ? w.hwnd === raw.activeHwnd : raw.activePid !== null && w.pid === raw.activePid,
      isMomo: mine.has(w.pid),
      state: w.minimized ? "minimized" : w.maximized ? "maximized" : "normal",
      z: typeof w.z === "number" ? w.z : 999,
    }));
    const activeCount = windows.filter((w) => w.active).length;
    // the window set was just re-observed: replace the old picture instead of mixing it with it
    this.world.removeType("window");
    const active = windows.find((w) => w.active) ?? null;
    this.world.upsert({
      id: "desktop:main", type: "desktop",
      props: { activeWindowId: active ? `window:${active.hwnd}` : null, windowCount: windows.length },
      source: "win32.foreground", confidence: 0.95,
    });
    for (const w of windows) {
      this.world.upsert({
        id: `window:${w.hwnd}`, type: "window", parentId: "desktop:main",
        props: { ...w }, source: "win32.windows",
        // matched by process (not by exact window) when several windows share it, so that guess is less certain
        confidence: w.active && !exact && activeCount > 1 ? 0.6 : w.active && !exact ? 0.85 : 0.95,
      });
    }
    return { windows, active, processes: raw.processes?.map((p) => sanitizeTitle(p).toLowerCase()) };
  }
}
