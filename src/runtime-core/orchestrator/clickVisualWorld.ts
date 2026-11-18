import type { CaptureTransport, PointerPort, PointerResult } from "../shared/ports";
import type { UiNode } from "../shared/ports";
import { popupWorld, runPopup, un } from "./popupWorld";

/**
 * A made-up desktop for click_visual tests: one window (hwnd 20) whose picture has buttons and texts the test controls, a fake helper that
 * "captures" and "detects" them, and a fake pointer that enforces the same rules as the real one (window family under it, window exactly where it was
 * seen, the last-look hook BEFORE the press, takeover, abort) and records everything that is actually sent.
 */
export interface Btn { label: string; l: number; t: number; w: number; h: number; /** what the three readings of the rectangle say (default: the label three times) */ readings?: [string, string, string]; /** the whole-frame text pass does not find this label (so only the rectangle's own readings exist) */ noFrameWords?: boolean }
export interface Txt { text: string; l: number; t: number; w?: number; h?: number }
export interface WorldState {
  win: { l: number; t: number; w: number; h: number };
  buttons: Btn[];
  texts: Txt[];
  /** names Windows' own tree lists as buttons (UI Automation) */
  uia: string[];
  clipped: boolean;
  /** capture refusal state ("minimized" ...) or null */
  refuse: string | null;
  /** a window that covers the target spot (hwnd), else none */
  coverBy: number | null;
  extraWindows: Array<{ hwnd: number; title: string }>;
  password: boolean;
}

export interface WorldOpts {
  buttons: Btn[];
  texts?: Txt[];
  uia?: string[];
  /** the app reacts to the pointer ARRIVING (before the last look): move, remove, relabel, add a decoy... */
  onArrive?: (s: WorldState) => void;
  /** the app reacts to a press: (state, label hit or null) */
  onPress?: (s: WorldState, hit: string | null) => void;
  /** the pointer fails after the press was sent (an error after input went through) */
  failAfterPress?: boolean;
  /** the user takes the mouse during the last look */
  takeoverDuringCheck?: boolean;
  /** cancel (like the Cancel button) during the last look */
  cancelDuringCheck?: (cancel: () => void) => void;
  noPointer?: boolean;
  clipped?: boolean;
}

const SESSION = 1;

export function clickWorld(o: WorldOpts) {
  const state: WorldState = { win: { l: 200, t: 100, w: 1000, h: 700 }, buttons: o.buttons.map((b) => ({ ...b })), texts: (o.texts ?? []).map((t) => ({ ...t })), uia: o.uia ?? [], clipped: !!o.clipped, refuse: null, coverBy: null, extraWindows: [], password: false };
  const log = { grabs: 0, detects: 0, clicks: [] as Array<{ x: number; y: number; hit: string | null }>, stops: 0, aborted: 0, checks: 0 };
  let frame = 0;

  const transport: CaptureTransport = {
    async send(cmd) {
      if (cmd === "capstart") return state.refuse ? { ok: false, state: state.refuse } : { ok: true, session: SESSION, bytes: 1 };
      if (cmd === "capgrab") {
        log.grabs++;
        if (state.refuse) return { ok: false, state: state.refuse };
        frame++;
        const w = state.win;
        return { ok: true, state: "ready", ready: true, session: SESSION, frame, w: w.w, h: w.h, l: w.l, t: w.t, pw: w.w, ph: w.h, scale: 1, dpi: 96, mdpi: 96, ms: 20, vl: 0, vt: 0, vw: state.clipped ? 1000 : 3000, vh: state.clipped ? 600 : 2000 };
      }
      if (cmd === "capdetect") {
        log.detects++;
        const w = state.win;
        const shapes = state.buttons.map((b) => [b.l, b.t, b.w, b.h, 92, 200]);
        const crops = state.buttons.map((b, i) => [i, ...(b.readings ?? [b.label, b.label, b.label])]);
        const words: Array<[string, number, number, number, number]> = [];
        for (const b of state.buttons) { if (b.noFrameWords) continue; const label = b.readings ? b.readings[0] : b.label; label.split(" ").forEach((x, k) => words.push([x, b.l + 8 + k * 60, b.t + b.h / 2 - 8, 50, 16])); }
        for (const t of state.texts) t.text.split(" ").forEach((x, k) => words.push([x, t.l + k * 60, t.t, t.w ?? 50, t.h ?? 16]));
        return { ok: true, session: SESSION, frame, w: w.w, h: w.h, shapes, crops, words, msCopy: 1, msShapes: 1, msCrops: 1, msOcr: 1 };
      }
      return { ok: true, was: true, active: true };
    },
  };

  let sess: { orchestrator: { cancel(): void } } | null = null;
  let aborted = false, interrupted: "mouse" | null = null, acted: "no" | "yes" = "no";
  const hit = (x: number, y: number): string | null => {
    const lx = x - state.win.l, ly = y - state.win.t;
    return state.buttons.find((b) => lx >= b.l && lx <= b.l + b.w && ly >= b.t && ly <= b.t + b.h)?.label ?? null;
  };
  const pointer: PointerPort = {
    async click(x, y, opts): Promise<PointerResult> {
      if (aborted) return { ok: false, reason: "cancelled" } as PointerResult;
      if (interrupted) return { ok: false, reason: "user_moved" } as PointerResult;
      const under = state.coverBy ?? 20;
      if (opts.expectRoot !== undefined && !(Array.isArray(opts.expectRoot) ? opts.expectRoot.includes(under) : opts.expectRoot === under)) return { ok: false, reason: "covered" } as PointerResult;
      if (opts.expectWindow) { const r = opts.expectWindow.rect, c = state.win; if (r.l !== c.l || r.t !== c.t || r.w !== c.w || r.h !== c.h) return { ok: false, reason: "moved" } as PointerResult; }
      o.onArrive?.(state);                                           // the pointer has arrived: the app may react
      if (opts.verifyTarget) {
        log.checks++;
        let v;
        try { v = await opts.verifyTarget({ x, y }); } catch { v = { ok: false, reason: "changed" }; }
        if (v && v.ok === false) return { ok: false, reason: v.reason || "changed" } as PointerResult;
        if (o.takeoverDuringCheck) interrupted = "mouse";
        o.cancelDuringCheck?.(() => { aborted = true; });
        if (aborted) return { ok: false, reason: "cancelled" } as PointerResult;      // the pointer looks again after the check (a person took over, Esc, cancel)
        if (interrupted) return { ok: false, reason: "user_moved" } as PointerResult;
      }
      acted = "yes";
      const h = hit(x, y);
      log.clicks.push({ x, y, hit: h });
      o.onPress?.(state, h);
      return o.failAfterPress ? ({ ok: false, reason: "failed" } as PointerResult) : ({ ok: true } as PointerResult);
    },
    press: async () => ({ ok: true } as PointerResult),
    type: async () => ({ ok: true } as PointerResult),
    windowAt: () => state.coverBy ?? 20,
    windowRect: () => ({ ...state.win }),
    interrupted: () => interrupted,
    abort: () => { aborted = true; log.aborted++; },
    releaseAll: () => 0,
    heldCount: () => 0,
    resetActed: () => { acted = "no"; },
    actedSince: () => acted,
  };

  const w = popupWorld({ popups: () => [], pointer: false });
  const deps = w.deps as unknown as Record<string, unknown> & { screen: Record<string, unknown>; win: unknown };
  deps.screen = {
    ...deps.screen,
    readUi: async () => ({
      ok: true,
      items: state.uia.map((name, i): UiNode => un("Button", name, { rect: { l: 10 + i * 100, t: 10, w: 80, h: 30 } })).concat(state.password ? [un("Edit", "Password", { password: true })] : []),
      truncated: false,
      hadPasswordField: state.password,
    }),
  };
  deps.win = { query: async () => ({ activePid: 20, activeHwnd: 20, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 }, { hwnd: 20, pid: 20, process: "app", title: "Test app", z: 0 }, ...state.extraWindows.map((x, i) => ({ hwnd: x.hwnd, pid: 30 + i, process: "app", title: x.title, z: 1 }))] }) };
  if (!o.noPointer) deps.pointer = () => pointer;

  /** run one task whose planner says exactly `script`; `goal` is what the user said */
  async function run(goal: string, script: Parameters<typeof runPopup>[1], extra: Record<string, unknown> = {}) {
    const r = runPopup(w, script, { capture: transport, ...extra });
    sess = r.session;
    await r.session.handleTranscript("s", goal);
    await new Promise((res) => setTimeout(res, 20)); // the release at the end of the task
    return { ...r, steps: (r.results[r.results.length - 1] ?? []).filter((s) => s.kind === "tool") as Array<{ outcome: string; text: string; tool?: string }> };
  }
  /** answer the open confirmation of the running task (for tests that use a real AI service and so have no scripted results to read back) */
  const respond = (taskId: string, yes: boolean) => (sess as unknown as { respondConfirmation(id: string, ok: boolean): Promise<void> }).respondConfirmation(taskId, yes);
  return { state, log, pointer, run, respond, cancel: () => { aborted = true; }, cancelTask: () => sess?.orchestrator.cancel(), deps };
}

export { un };
