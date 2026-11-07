import type { ActResult, ActionPort, FsPort, InputPort, SetTextResult, WindowState } from "../shared/ports";

export type ActionResult = ActResult;

export const MAX_TYPED_CHARS = 500;

export interface WindowTarget { hwnd: number; pid: number }
export interface ControlTarget extends WindowTarget { rid: string; name: string }

/**
 * Executes approved operations on an identified target. It is deliberately narrow, and it re-checks
 * the target right before acting (never a stale guess): the window must still exist and still belong
 * to the same process, and a control must still carry the name the user was shown.
 */
export class ActionAgent {
  calls = 0;

  constructor(private fs: FsPort, private port: ActionPort | undefined, private input?: InputPort) {}

  // ------------------------------------------------------------------ files

  /** Open one existing file with the program Windows associates with it (a document, a picture, a video...). */
  async openFile(path: string): Promise<ActionResult> {
    if (!this.port) return { ok: false, reason: "Opening files isn't available in this build." };
    if (!/^[A-Za-z]:\\/.test(path) || /(^|\\)\.\.(\\|$)/.test(path) || path.includes("\0")) {
      return { ok: false, reason: "That path isn't a normal local file, so I won't open it." };
    }
    const st = await this.fs.stat(path); // pre-action check on the current state of the disk
    if (!st) return { ok: false, reason: "That file doesn't exist any more." };
    if (st.isDir) return { ok: false, reason: "That is a folder, not a file." };
    this.calls++;
    try {
      const err = await this.port.openPath(path);
      return err ? { ok: false, reason: "Windows couldn't open it (no program may be set up for that kind of file)." } : { ok: true };
    } catch {
      return { ok: false, reason: "Windows couldn't open it." };
    }
  }

  // ------------------------------------------------------------------ folders

  async openFolder(path: string): Promise<ActionResult> {
    if (!this.port) return { ok: false, reason: "Opening folders isn't available in this build." };
    // only plain local drive paths: no UNC shares, device paths, relative paths or traversal
    if (!/^[A-Za-z]:\\/.test(path) || /(^|\\)\.\.(\\|$)/.test(path) || path.includes("\0")) {
      return { ok: false, reason: "That path isn't a normal local folder, so I won't open it." };
    }
    const st = await this.fs.stat(path); // pre-action check on the current state of the disk
    if (!st?.isDir) return { ok: false, reason: "That folder doesn't exist any more." };
    this.calls++;
    try {
      const err = await this.port.openPath(path);
      return err ? { ok: false, reason: "Windows couldn't open it." } : { ok: true };
    } catch {
      return { ok: false, reason: "Windows couldn't open it." };
    }
  }

  // ------------------------------------------------------------------ windows

  /** Current state of a window as Windows reports it (used to verify the result of an action). */
  async state(hwnd: number): Promise<WindowState> {
    if (!this.input) return { exists: false, minimized: false, pid: 0, foregroundPid: null };
    return this.input.windowState(hwnd);
  }

  /** Pre-action check: the window must still exist and still be the same program. */
  private async checkWindow(t: WindowTarget): Promise<ActResult> {
    if (!this.input) return { ok: false, reason: "Controlling windows isn't available in this build." };
    const s = await this.input.windowState(t.hwnd);
    if (!s.exists) return { ok: false, reason: "That window isn't open any more." };
    if (s.pid !== t.pid) return { ok: false, reason: "That window now belongs to a different program, so I won't touch it." };
    return { ok: true };
  }

  async focusWindow(t: WindowTarget): Promise<ActResult> {
    const c = await this.checkWindow(t);
    if (!c.ok) return c;
    this.calls++;
    return this.input!.focusWindow(t.hwnd);
  }

  async minimizeWindow(t: WindowTarget): Promise<ActResult> {
    const c = await this.checkWindow(t);
    if (!c.ok) return c;
    this.calls++;
    return this.input!.minimizeWindow(t.hwnd);
  }

  async closeWindow(t: WindowTarget): Promise<ActResult> {
    const c = await this.checkWindow(t);
    if (!c.ok) return c;
    this.calls++;
    return this.input!.closeWindow(t.hwnd);
  }

  // ------------------------------------------------------------------ controls

  async clickControl(t: ControlTarget): Promise<ActResult> {
    const c = await this.checkWindow(t);
    if (!c.ok) return c;
    if (!t.rid || !t.name) return { ok: false, reason: "I can't identify that control exactly, so I won't click it." };
    this.calls++;
    return this.input!.invokeControl(t.hwnd, t.rid, t.name);
  }

  async typeText(t: ControlTarget, text: string): Promise<SetTextResult> {
    const c = await this.checkWindow(t);
    if (!c.ok) return c;
    if (!t.rid || !t.name) return { ok: false, reason: "I can't identify that field exactly, so I won't type into it." };
    if (text.length === 0 || text.length > MAX_TYPED_CHARS) return { ok: false, reason: `I can only type between 1 and ${MAX_TYPED_CHARS} characters.` };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return { ok: false, reason: "That text contains characters I won't type." };
    this.calls++;
    return this.input!.setControlText(t.hwnd, t.rid, t.name, text);
  }
}
