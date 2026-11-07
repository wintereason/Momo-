import type { DriveInfo, FolderMatch } from "../filesystem";
import type { DesktopSnapshot } from "../desktop";
import type { FsPort, WindowState } from "../shared/ports";

export interface Verdict {
  verified: boolean;
  /** human-readable evidence, e.g. "free <= total" */
  evidence: string[];
  confidence: number;
}

const fail = (why: string): Verdict => ({ verified: false, evidence: [why], confidence: 0 });
const isByteCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Independent checks on what an agent returned. Proportionate: read-only answers get a
 * lightweight sanity check; nothing is reported as verified without supporting evidence.
 */
export class Verifier {
  drive(d: DriveInfo): Verdict {
    if (!/^[A-Z]$/.test(d.letter)) return fail("invalid drive letter");
    if (!isByteCount(d.total) || !isByteCount(d.free) || !isByteCount(d.used)) return fail("sizes are not valid numbers");
    if (d.total <= 0) return fail("total capacity is zero");
    if (d.free > d.total) return fail("free space exceeds capacity");
    if (d.used + d.free !== d.total) return fail("used + free does not equal total");
    return { verified: true, evidence: ["sizes are valid numbers", "0 <= free <= total", "used + free = total"], confidence: 1 };
  }

  desktop(s: DesktopSnapshot): Verdict {
    if (s.windows.some((w) => !Number.isFinite(w.pid) || !w.title)) return fail("a window record is incomplete");
    if (s.active && !s.windows.includes(s.active)) return fail("active window is not in the window list");
    return {
      verified: true,
      evidence: [`${s.windows.length} window(s) observed`, s.active ? "active window is in the list" : "no foreground window identified"],
      confidence: s.active ? 0.85 : 0.7,
    };
  }

  /**
   * After starting an app: is there a window for it that was not there before (or is it now in front)?
   * Matching is by the app's name in the window title or process name, so an app whose window uses a
   * different name is reported as unconfirmed rather than guessed.
   */
  appWindow(snap: DesktopSnapshot, before: ReadonlySet<number>, appName: string): Verdict {
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const tokens = norm(appName).split(" ").filter(Boolean);
    const matches = (w: { title: string; process: string }) => {
      const hay = norm(`${w.title} ${w.process}`);
      return tokens.length > 0 && tokens.every((t) => hay.includes(t));
    };
    const fresh = snap.windows.find((w) => !w.isMomo && !before.has(w.hwnd) && matches(w));
    if (fresh) return { verified: true, evidence: [`a new window "${fresh.title}" appeared`], confidence: 0.9 };
    if (snap.active && !snap.active.isMomo && matches(snap.active)) {
      return { verified: true, evidence: ["the app's window is in front"], confidence: 0.7 };
    }
    return fail("no window for that app appeared");
  }

  /** After opening a folder in VS Code: a Code window showing that folder. */
  vscodeFolder(snap: DesktopSnapshot, folderPath: string): Verdict {
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const base = norm(folderPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folderPath);
    // an empty name would match every window, which would "verify" something nobody checked
    if (base === "") return fail("the folder's name could not be compared safely");
    const hit = snap.windows.find((w) => /^code$/i.test(w.process) && norm(w.title).includes(base));
    return hit
      ? { verified: true, evidence: [`a Visual Studio Code window "${hit.title}" is open`], confidence: 0.95 }
      : fail("no Visual Studio Code window showing that folder was found");
  }

  /** After opening an address: the front browser tab must show that site. */
  urlShown(page: { address?: string; selectedTitle?: string }, host: string): Verdict {
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const h = host.toLowerCase().replace(/^www\./, "");
    const addrHost = (() => {
      try { return new URL(/^[a-z]+:\/\//i.test(page.address ?? "") ? page.address! : "https://" + (page.address ?? "")).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
    })();
    if (addrHost && (addrHost === h || addrHost.endsWith("." + h))) return { verified: true, evidence: ["the address bar shows that site"], confidence: 0.95 };
    const name = norm(h.split(".")[0]);
    // a very short name ("x", "co") appears in too many titles to count as evidence
    if (name.length >= 4 && page.selectedTitle && norm(page.selectedTitle).includes(name)) return { verified: true, evidence: ["the tab title matches that site"], confidence: 0.7 };
    return fail("the browser doesn't show that site yet");
  }

  /** After a window action: ask Windows what actually happened. */
  windowFocused(s: WindowState, pid: number): Verdict {
    return s.exists && s.foregroundPid === pid && !s.minimized
      ? { verified: true, evidence: ["Windows reports this window is in front"], confidence: 0.95 }
      : fail("the window is not in front");
  }
  windowMinimized(s: WindowState): Verdict {
    return s.exists && s.minimized
      ? { verified: true, evidence: ["Windows reports this window is minimized"], confidence: 0.95 }
      : fail("the window is not minimized");
  }
  windowClosed(s: WindowState): Verdict {
    return !s.exists
      ? { verified: true, evidence: ["Windows reports this window no longer exists"], confidence: 0.95 }
      : fail("the window is still open");
  }

  /** After typing: the field must now contain exactly what was typed. */
  typed(readBack: string, expected: string): Verdict {
    const norm = (s: string) => s.replace(/\r\n/g, "\n");
    return norm(readBack) === norm(expected)
      ? { verified: true, evidence: ["the field's value was read back and matches"], confidence: 0.95 }
      : fail("the field does not contain what was typed");
  }

  /** After a click: something must visibly have changed, otherwise the click is not confirmed. */
  clickEffect(before: string, after: string | null, windowGone: boolean): Verdict {
    if (windowGone) return { verified: true, evidence: ["the window closed after the click"], confidence: 0.8 };
    if (after === null) return fail("the window could not be inspected afterwards");
    return after !== before
      ? { verified: true, evidence: ["the window's controls or state changed after the click"], confidence: 0.8 }
      : fail("nothing visibly changed after the click");
  }

  /** Sanity-check what was read from a window before it is reported. */
  screenText(lines: string[], source: "uia" | "ocr"): Verdict {
    if (lines.length === 0) return fail("nothing readable was found");
    if (lines.some((l) => typeof l !== "string" || l.length === 0)) return fail("a text line is empty or invalid");
    return {
      verified: true,
      evidence: [`${lines.length} line(s) read`, source === "uia" ? "reported by the application (UI Automation)" : "recognised from a screenshot (OCR)"],
      confidence: source === "uia" ? 0.9 : 0.7,
    };
  }

  /** Sanity-check a list of browser profiles read from the browser's settings before it is reported. */
  profiles(list: { dir: string; name: string; email?: string }[]): Verdict {
    if (list.length === 0) return fail("no profiles were found");
    if (list.some((p) => !/^(Default|Profile \d{1,3})$/.test(p.dir) || !p.name)) return fail("a profile record is incomplete");
    if (new Set(list.map((p) => p.dir)).size !== list.length) return fail("a profile appears twice");
    return { verified: true, evidence: [`${list.length} profile(s) read from the browser's own settings`], confidence: 0.95 };
  }

  /**
   * After opening a file: did a window for it appear (or come forward)? Programs show the file's name in their title, so
   * a window that is new, or is in front now, and mentions the name counts. A program that does not show the name is
   * reported as unconfirmed rather than guessed.
   */
  fileWindow(s: DesktopSnapshot, before: ReadonlySet<number>, filePath: string): Verdict {
    const base = filePath.split(/[\\/]/).pop() || filePath;
    const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
    const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (norm(stem) === "") return fail("the file's name could not be compared safely");
    const named = (w: { title: string; isMomo: boolean }) => !w.isMomo && norm(w.title).includes(norm(stem));
    const fresh = s.windows.find((w) => !before.has(w.hwnd) && named(w));
    if (fresh) return { verified: true, evidence: [`a new window "${fresh.title}" shows the file`], confidence: 0.9 };
    if (s.active && named(s.active)) return { verified: true, evidence: ["the window in front shows the file"], confidence: 0.8 };
    return fail("no window showing that file was found");
  }

  /** After opening a folder: is there now a File Explorer window showing it? */
  folderWindow(s: DesktopSnapshot, folderPath: string): Verdict {
    const base = folderPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folderPath;
    // letters and digits in ANY language: an ASCII-only filter turned non-English names into "" (which matches everything)
    const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (norm(base) === "") return fail("the folder's name could not be compared safely");
    const hit = s.windows.find((w) => /^explorer$/i.test(w.process) && norm(w.title).includes(norm(base)));
    return hit
      ? { verified: true, evidence: [`an Explorer window titled "${hit.title}" is open`], confidence: hit.active ? 0.95 : 0.85 }
      : fail("no Explorer window for that folder was found");
  }

  /** Re-check on disk that each reported folder still exists and is a directory. */
  async folders(matches: FolderMatch[], fs: FsPort): Promise<{ verdict: Verdict; confirmed: FolderMatch[] }> {
    const confirmed: FolderMatch[] = [];
    for (const m of matches) {
      const st = await fs.stat(m.path);
      if (st?.isDir) confirmed.push(m);
    }
    if (confirmed.length === 0) return { verdict: fail("none of the folders exist any more"), confirmed };
    return {
      verdict: { verified: true, evidence: [`${confirmed.length} of ${matches.length} path(s) re-checked on disk`], confidence: 0.95 },
      confirmed,
    };
  }
}
