// The shadow cursor's brain. It decides WHEN the ghost pointer is visible and WHERE it goes; the window and the screen are
// passed in, so this is tested without a PC.
//   - It appears when a task starts working (at your real mouse position) and fades out shortly after the task ends. With no
//     task running it does not exist at all: the window is hidden.
//   - It SHOWS what Momo does. Aim (the exact element, with what it is for) comes first, then the ghost either glides on its own
//     (UI Automation actions) or FOLLOWS THE REAL POINTER position by position (human-like control: track()), then the result:
//     "checking", and only after Momo has verified it: confirmed, not confirmed, or failed. It never claims success on its own.
//   - If the user takes over (moves the physical mouse or presses Esc) it stops at once: stop().

const LINGER_MS = 1600;
const STOP_LINGER_MS = 1400;

/**
 * @param {{
 *   enabled: () => boolean,
 *   win: { show(bounds: object): void, send(msg: object): void, hide(): void, raise?(): void },
 *   screen: { mouse(): { bounds: object, x: number, y: number },
 *             windowRect(hwnd: number): { l: number, t: number, w: number, h: number } | null,
 *             locate(x: number, y: number, w: number, h: number): { bounds: object, x: number, y: number, w: number, h: number } },
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void,
 * }} deps
 */
function createShadowCursor(deps) {
  const setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; });
  const clearTimer = deps.clearTimer || clearTimeout;
  let visible = false;
  let bounds = null;
  let hideTimer = null;
  let stoppedByUser = false;

  const sameBounds = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  function ensureShown() {
    if (hideTimer) { clearTimer(hideTimer); hideTimer = null; }
    if (visible) return;
    const m = deps.screen.mouse();
    bounds = m.bounds;
    deps.win.show(bounds);
    deps.win.send({ kind: "show", x: m.x, y: m.y });
    visible = true;
    stoppedByUser = false;
  }

  /** a point/box given in physical pixels, converted for the display it is on (this is what keeps it right on scaled and multiple screens) */
  function place(px, py, pw, ph) {
    const p = deps.screen.locate(px, py, pw, ph);
    if (!sameBounds(bounds, p.bounds)) { bounds = p.bounds; deps.win.show(bounds); } // the target is on another screen
    return p;
  }

  /** glide to a point/box given in physical pixels */
  function moveTo(px, py, pw, ph, action, label, text, say) {
    ensureShown();
    const p = place(px, py, pw, ph);
    deps.win.send({ kind: "move", x: p.x, y: p.y, w: p.w, h: p.h, action, label, ...(text ? { text } : {}), ...(say ? { say } : {}) });
  }

  /** Momo has identified its target: highlight that exact element (and say what it is for) BEFORE anything moves */
  function aim(px, py, pw, ph, label, say, kind) {
    ensureShown();
    const p = place(px, py, pw, ph);
    if (deps.win.raise) deps.win.raise(); // a window that was just clicked may be "always on top" too
    deps.win.send({ kind: "aim", x: p.x, y: p.y, w: p.w, h: p.h, ...(label ? { label } : {}), ...(say ? { say } : {}), ...(kind ? { tone: kind } : {}) });
  }

  function hideNow() {
    if (hideTimer) { clearTimer(hideTimer); hideTimer = null; }
    if (!visible) return;
    visible = false;
    bounds = null;
    deps.win.send({ kind: "hide" });
    deps.win.hide();
  }

  /** @param {"ok"|"unconfirmed"|"failed"} result */
  function finish(result) {
    if (!visible || stoppedByUser) return;
    deps.win.send({ kind: "done", ok: result === "ok", result });
    if (hideTimer) clearTimer(hideTimer);
    hideTimer = setTimer(hideNow, LINGER_MS);
  }

  function stop(reason) {
    if (!visible) return;
    stoppedByUser = true;
    deps.win.send({ kind: "stop", reason: reason === "esc" ? "esc" : "mouse" });
    if (hideTimer) clearTimer(hideTimer);
    hideTimer = setTimer(hideNow, STOP_LINGER_MS);
  }

  return {
    /** every runtime event passes through here */
    handle(e) {
      if (!e || typeof e !== "object") return;
      if (!deps.enabled()) { hideNow(); return; }
      switch (e.type) {
        case "task.state":
          if (e.state === "working") {
            ensureShown();
            if (typeof e.message === "string" && e.message) deps.win.send({ kind: "say", text: e.message.slice(0, 80) }); // what Momo is doing right now
          }
          // "partial_success" means some step could NOT be confirmed: it is shown as such, never as done
          else if (e.state === "partial_success") finish("unconfirmed");
          else if (e.state === "idle") finish("ok");
          break;
        case "cursor.move":
          moveTo(e.x, e.y, e.w, e.h, e.action, e.label, e.text, e.say);
          break;
        case "cursor.aim":
          aim(e.x, e.y, e.w, e.h, e.label, e.say, e.kind);
          break;
        case "cursor.result":
          // only ever sent by a tool AFTER it checked (or failed to check) what happened
          if (visible && !stoppedByUser) { if (deps.win.raise) deps.win.raise(); deps.win.send({ kind: "result", state: e.state, ...(e.text ? { text: e.text } : {}) }); }
          break;
        case "cursor.window": {
          // a whole window: aim at the part of it that matters for what Momo is doing
          const r = deps.screen.windowRect(e.hwnd);
          if (!r || r.w < 40 || r.h < 40) break;
          const title = (cx, w) => moveTo(cx, r.t + 20, w, 40, "look", e.label);
          if (e.action === "close") moveTo(r.l + r.w - 24, r.t + 18, 44, 34, "click", "Close");
          else if (e.action === "minimize") moveTo(r.l + r.w - 116, r.t + 18, 44, 34, "click", "Minimize");
          else if (e.action === "focus") moveTo(r.l + r.w / 2, r.t + 20, Math.min(r.w, 520), 40, "select", e.label);
          else title(r.l + r.w / 2, Math.min(r.w, 520));
          break;
        }
        case "task.completed": case "task.answer": finish("ok"); break;
        case "task.failed": finish("failed"); break;
        default: break; // confirmations and questions keep the ghost where it is: the task is still open
      }
    },
    /**
     * The REAL pointer's own positions, streamed by humanInput while it glides, hovers, presses and types. The ghost sits exactly where
     * the pointer is, so what you see is what is happening. Physical pixels, like everything from Windows.
     * @param {{ x?: number, y?: number, phase: string, ch?: string, reason?: string }} t
     */
    track(t) {
      if (!t || typeof t !== "object" || !deps.enabled()) return;
      if (t.phase === "stop") { stop(t.reason); return; }
      if (!visible || stoppedByUser) return;
      // the click ACTIVATES the target window, which may be an always-on-top one: come back above it
      if ((t.phase === "press" || t.phase === "release") && deps.win.raise) deps.win.raise();
      if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
        const p = place(t.x, t.y, 0, 0);
        deps.win.send({ kind: "track", phase: t.phase, x: p.x, y: p.y });
      } else {
        deps.win.send({ kind: "track", phase: t.phase, ...(typeof t.ch === "string" ? { ch: t.ch.slice(0, 4) } : {}) });
      }
    },
    /** the user took over (moved the physical mouse, or pressed Esc) */
    stop,
    /** the user cancelled, or switched the shadow cursor off */
    cancel: hideNow,
    isVisible: () => visible,
  };
}

module.exports = { createShadowCursor, LINGER_MS, STOP_LINGER_MS };
