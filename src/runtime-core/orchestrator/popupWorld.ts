import type { PlanDecision, PlanStep } from "./ai/prompts";
import type { AiService } from "./ai/service";
import type { RuntimeEvent } from "../../types/runtime-events";
import type { ActResult, FsPort, InputPort, LaunchPort, MenuEntry, PointerPort, PointerResult, RawWindow, ScreenPort, TransientWindow, UiNode, WindowState } from "../shared/ports";
import { Session } from "./session";

/** A fake Windows with pop-ups, shared by the phase 5 tests: scripted transient windows, menus, dialog contents, and every action recorded. */
export interface Popup { win: TransientWindow; menu?: MenuEntry[]; ui?: UiNode[] }
export const explorerWin: RawWindow = { hwnd: 20, pid: 20, process: "explorer", title: "Documents - File Explorer", z: 0 };

export const tw = (hwnd: number, kind: TransientWindow["kind"], over: Partial<TransientWindow> = {}): TransientWindow => ({
  hwnd, pid: 20, proc: "explorer", cls: kind === "menu" ? "#32768" : kind === "dialog" ? "#32770" : "Popup", kind, owner: 20, rootOwner: 20, top: true, tool: false, fg: false, rect: { l: 100, t: 100, w: 200, h: 300 }, ...over,
});
export const me = (name: string, over: Partial<MenuEntry> = {}): MenuEntry => ({ name, enabled: true, offscreen: false, focused: false, separator: false, expandable: false, checked: "", shortcut: "", rid: `r:${name}`, rect: { l: 110, t: 110, w: 180, h: 24 }, depth: 0, parent: -1, ...over });
export const un = (type: string, name: string, over: Partial<UiNode> = {}): UiNode => ({ type, name, enabled: true, offscreen: false, rid: `${type}:${name}`, rect: { l: 120, t: 120, w: 80, h: 24 }, ...over });

export interface PopupWorldOpts {
  /** the popups visible right now, as a function of how many looks have been made (so they can appear, change and disappear) */
  popups: (look: number) => Popup[];
  pointer?: boolean;
  /** what is under the pointer at a point */
  windowAt?: (x: number, y: number) => number;
  /** the element chain at a point */
  chainAt?: (x: number, y: number) => Array<{ rid: string; type: string; name: string; password: boolean }> | null;
  /** called whenever the real pointer clicks */
  onClick?: (x: number, y: number, o: Record<string, unknown>) => PointerResult | void;
  onPress?: (keys: string) => PointerResult | void;
  windowState?: () => WindowState;
  invoke?: (rid: string) => ActResult;
  setText?: (rid: string, text: string) => { ok: boolean; readBack?: string };
  /** what a field reads back after typing (default: exactly what was typed) */
  fieldValue?: (typed: string) => { ok: true; value: string } | { ok: false; reason: string };
  interrupted?: () => boolean;
}

export function popupWorld(o: PopupWorldOpts) {
  const log = { looks: 0, act: [] as string[], menuReads: 0, uiReads: 0, clicks: [] as Array<{ x: number; y: number; opts: Record<string, unknown> }>, presses: [] as string[], aborted: [] as string[], texts: [] as string[] };
  const cur = (): Popup[] => o.popups(Math.max(0, log.looks - 1));
  const input: InputPort = {
    focusWindow: async (): Promise<ActResult> => { log.act.push("focus"); return { ok: true }; }, minimizeWindow: async () => { log.act.push("minimize"); return { ok: true }; }, closeWindow: async () => { log.act.push("close"); return { ok: true }; },
    windowState: async (): Promise<WindowState> => (o.windowState ? o.windowState() : { exists: true, minimized: false, pid: 20, foregroundPid: 20, hung: false, modal: false }),
    invokeControl: async (_h, rid): Promise<ActResult> => { log.act.push("invoke:" + rid); return o.invoke ? o.invoke(rid) : { ok: true }; },
    setControlText: async (_h, rid, _n, text) => { log.act.push("settext:" + rid); log.texts.push(text); const r = o.setText ? o.setText(rid, text) : { ok: true, readBack: text }; return r.ok ? { ok: true, readBack: r.readBack ?? text } : { ok: false, reason: "failed" }; },
  };
  const screen: ScreenPort = {
    readUi: async (h) => { log.uiReads++; const p = cur().find((x) => x.win.hwnd === h); return { ok: true, items: (p?.ui ?? []).map((n) => ({ ...n })), truncated: false }; },
    ocr: async () => ({ ok: true, lines: [] }),
    transients: async (owner) => { log.looks++; const list = cur().map((p) => p.win).filter((w) => !owner || w.rootOwner === owner || w.owner === owner); return { ok: true, windows: list.map((w) => ({ ...w, rect: { ...w.rect } })) }; },
    fieldValue: async () => (o.fieldValue ? o.fieldValue(typed) : { ok: true, value: typed }),
    readMenu: async (h) => { log.menuReads++; const p = cur().find((x) => x.win.hwnd === h); return p?.menu ? { ok: true, items: p.menu.map((i) => ({ ...i })) } : { ok: false, reason: "not a menu" }; },
    elementAt: async (x, y) => { const c = o.chainAt?.(x, y); return c ? { ok: true, root: o.windowAt?.(x, y) ?? 0, chain: c } : { ok: false, reason: "nothing there" }; },
  };
  const fs = { homeDir: () => "C:\\Users\\me", listDriveRoots: async () => [], statfs: async () => ({ total: 1, free: 1 }), readDirs: async () => [], readEntries: async () => [], stat: async () => ({ isDir: true }) } as unknown as FsPort;
  const launch = { launchApp: async () => ({ ok: true }), openFolderInVsCode: async () => ({ ok: true }), openUrl: async () => ({ ok: true }), browserProfiles: async () => [], openBrowserProfile: async () => ({ ok: true }) } as unknown as LaunchPort;
  let acted: "no" | "maybe" | "yes" = "no";
  let typed = "";
  const pointer: PointerPort = {
    // behaves like the real pointer: the window under the pointer must be in the expected family, and the caller's last check of the target must pass, BEFORE any press
    click: async (x, y, opts) => {
      const under = o.windowAt ? o.windowAt(x, y) : 20;
      const exp = opts.expectRoot;
      if (exp !== undefined && !(Array.isArray(exp) ? exp.includes(under) : exp === under)) return { ok: false, reason: "covered" } as PointerResult;
      if (opts.verifyTarget) { let v; try { v = await opts.verifyTarget({ x, y }); } catch { v = { ok: false, reason: "changed" }; } if (v && v.ok === false) return { ok: false, reason: (v.reason || "changed") as never } as PointerResult; }
      acted = "yes"; log.clicks.push({ x, y, opts: opts as unknown as Record<string, unknown> });
      const r = o.onClick?.(x, y, opts as unknown as Record<string, unknown>); return r ?? { ok: true };
    },
    // (like the real pointer: a key that was refused before it was sent is not counted as sent)
    press: async (k) => { const r = o.onPress?.(k); if (!r || r.ok) { acted = "yes"; log.presses.push(k); } return r ?? { ok: true }; },
    type: async (text) => { acted = "yes"; log.texts.push(text); typed = text; return { ok: true } as PointerResult; }, windowAt: (x, y) => (o.windowAt ? o.windowAt(x, y) : 20), windowRect: () => ({ l: 0, t: 0, w: 1000, h: 800 }),
    resetActed: () => { acted = "no"; }, actedSince: () => acted, interrupted: () => (o.interrupted?.() ? "mouse" : null), abort: (why) => { log.aborted.push(String(why)); },
  };
  return {
    log,
    deps: {
      fs, input, screen, launch, act: { openPath: async () => "" }, apps: { list: async () => [] },
      win: { query: async () => ({ processes: undefined, activePid: 20, activeHwnd: 20, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 } as RawWindow, explorerWin] }) },
      ...(o.pointer === false ? {} : { pointer: () => pointer }),
    },
  };
}

export function runPopup(w: ReturnType<typeof popupWorld>, script: PlanDecision[], extra: Record<string, unknown> = {}) {
  const events: RuntimeEvent[] = [];
  const results: PlanStep[][] = [];
  let i = 0;
  const ai: AiService = {
    ready: () => true, label: () => "T", isCloud: () => false, canSeeScreen: () => true, usage: () => ({ count: 0, limit: 200 }),
    polish: async () => ({ ok: false, reason: "disabled", message: "off" }),
    async plan(_g, steps) { results.push(JSON.parse(JSON.stringify(steps))); return { ok: true, decision: script[Math.min(i++, script.length - 1)], source: "T" }; },
  };
  const session = new Session({ ...(w.deps as Record<string, unknown>), emit: (e: RuntimeEvent) => events.push(e), selfPids: () => [999], ai, sleep: async () => {}, cursorLeadMs: () => 0, ...extra } as never);
  session.setPolicy({ confirmReversible: false, confirmScreenRead: false });
  return { session, events, results };
}
export const call = (name: string, args: Record<string, unknown> = {}): PlanDecision => ({ type: "tool", tool: name, args });
export const finish = (a = "ok"): PlanDecision => ({ type: "done", answer: a });
export const stepsOf = (results: PlanStep[][]) => results[results.length - 1].filter((s) => s.kind === "tool") as Extract<PlanStep, { kind: "tool" }>[];
