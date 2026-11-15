import type { ReadOnlyView } from "./verifyOnly";

/**
 * A frozen application (phase 4d). Input sent to a window that is not responding is QUEUED by Windows and fires later, which is how a click
 * or a typed word ends up happening twice. So while a window is hung Momo sends it nothing: it waits, read-only and bounded, for it to
 * answer again (or to go away), and then LOOKS again before anything else is decided.
 */
export type ResponsiveResult = "responsive" | "still_hung" | "gone" | "cancelled";

export const HUNG_WAIT_MS = 3000;
const POLL_MS = 250;

/** Wait (never longer than `timeoutMs`) until Windows stops calling the window hung. Reads only; ends at once on cancel or takeover. */
export async function waitResponsive(view: ReadOnlyView, hwnd: number, timeoutMs = HUNG_WAIT_MS, pollMs = POLL_MS): Promise<ResponsiveResult> {
  let spent = 0;
  const t0 = Date.now();
  const stopped = () => { try { return !view.live() || view.interrupted(); } catch { return true; } };
  for (;;) {
    if (stopped()) return "cancelled";
    try {
      const s = await view.windowState(hwnd);
      if (stopped()) return "cancelled";
      if (!s.exists) return "gone";
      if (s.hung !== true) return "responsive";
    } catch { /* cannot tell this time: keep waiting until the limit */ }
    const left = timeoutMs - Math.max(spent, Date.now() - t0);
    if (left <= 0) return "still_hung";
    await view.sleep(Math.min(pollMs, left));
    spent += Math.min(pollMs, left);
  }
}
