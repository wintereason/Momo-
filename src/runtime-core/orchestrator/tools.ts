import { z } from "zod";
import { parseRuntimeEvent, type RuntimeEvent } from "../../types/runtime-events";
import { classifyControlRisk, isProgramFile, type ActionAgent, type Policy, type Risk } from "../action";
import { browserKeyFor, hintWords, matchProfileHint, profileLabels, siteUrl, type AppAgent } from "../apps";
import { BROWSER_PROCESSES, browserName, extractPage, isPrivateWindow, matchTabs } from "../browser";
import type { DesktopAgent, DesktopSnapshot } from "../desktop";
import type { DriveInfo, FileSystemAgent } from "../filesystem";
import type { BrowserKey, BrowserProfile, ForegroundPort, FsPort, PointerPort, UiNode } from "../shared/ports";
import {
  MAX_LINES, SPARSE_TEXT_CHARS, boxKey, cleanScreenText, describePlace, onScreen, collectControls, collectText, errorLines, matchControls, signature, totalChars, visibleNames,
} from "../shared/screenText";
import type { UiPanelAgent } from "../uipanel";
import { describeUnderstanding, needsUserSayso, understand, withPicture, type Kind, type Understanding } from "../uipanel";
import type { Verifier, WorldModel } from "../verifier";
import type { VisualAgent } from "../vision";
import type { AiService } from "./ai/service";

/**
 * The tools: what Momo's specialist roles can do, as typed capabilities the planner may choose from. A tool NEVER trusts
 * its caller: its arguments are validated here, risky ones go through the permission gate before they run, every action
 * checks its own result afterwards (the Verification Agent), and anything ambiguous is handed back to be asked, not guessed.
 */

export interface AgentDeps {
  world: WorldModel;
  fsAgent: FileSystemAgent;
  desktopAgent: DesktopAgent;
  actionAgent: ActionAgent;
  uiAgent: UiPanelAgent;
  visualAgent: VisualAgent;
  appAgent: AppAgent;
  /** the planner (a free AI service). Absent = Momo cannot plan, and says so */
  ai?: AiService;
  /** which window the user was in before turning to Momo (absent in tests / non-Windows) */
  foreground?: ForegroundPort;
  verifier: Verifier;
  fs: FsPort;
  /** current permission policy (changes while Momo runs) */
  policy(): Policy;
  /** delivers events to the UI; every event is validated before it leaves */
  emit(e: RuntimeEvent): void;
  sleep?(ms: number): Promise<void>;
  /** how long a confirmation stays open before it lapses (default 60 s) */
  confirmTimeoutMs?: number;
  /** how long one stretch of work may run before Momo gives up on it (default 120 s) */
  taskTimeoutMs?: number;
  /** how many times to look for the result of an action before giving up on verifying it */
  verifyAttempts?: number;
  /** the most moves one goal may take (default 10) */
  maxSteps?: number;
  /** how long to let the shadow cursor glide to a control before acting on it (0 = shadow cursor off) */
  cursorLeadMs?(): number;
  /** the real mouse and keyboard, for acting like a person; returns undefined while human-like control is off (or unavailable) */
  pointer?(): PointerPort | undefined;
}

export interface ToolCtx {
  d: AgentDeps;
  live(): boolean;
  /** the user already approved exactly this call */
  confirmed: boolean;
  /** what the approval was for (e.g. the exact control's name), so a changed target is refused */
  lock?: string;
}

export type ToolOutcome =
  | { ok: true; brief: string; report: string; verified: boolean; /** the evidence in a few words, shown by the shadow cursor once verified */ shown?: string }
  | { ok: false; reason: string }
  /** several things match: the orchestrator asks the user (the planner never guesses), then re-runs with the patch */
  | { ok: false; ambiguous: { noun: string; labels: string[]; /** full paths (or other detail) shown under each label */ details?: string[]; patches: Record<string, unknown>[] } }
  /** the call turned out to need a decision: ask, then re-run with `confirmed` (and the lock) */
  | { ok: false; needsConfirmation: { summary: string; lock?: string } };

export interface ToolDef {
  name: string;
  signature: string;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  /** what the result may reveal about the user's screen or accounts: kept from an online AI unless the user allowed it */
  sensitive: boolean;
  risk(args: Record<string, unknown>): Risk;
  /** what will happen, as one plain sentence for the confirmation card */
  describe(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> | string;
  working(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutcome>;
}

// ----------------------------------------------------------------------------------------------------- helpers

const GB = 1024 ** 3;
const TB = 1024 ** 4;
export function formatBytes(n: number): string {
  return n >= TB ? `${(n / TB).toFixed(2)} TB` : `${(n / GB).toFixed(1)} GB`;
}
const driveLine = (d: DriveInfo) => `${d.letter}: ${formatBytes(d.total)} total, ${formatBytes(d.free)} free (${formatBytes(d.used)} used)`;
const short = (s: string, n = 60): string => { const c = cleanScreenText(s); return c.length > n ? c.slice(0, n - 1) + "…" : c; };
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const sleeper = (ctx: ToolCtx) => ctx.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
const attempts = (ctx: ToolCtx, mult = 1) => (ctx.d.verifyAttempts ?? 4) * mult;
const fail = (reason: string): ToolOutcome => ({ ok: false, reason });
const ok = (brief: string, verified: boolean, report = brief, shown?: string): ToolOutcome => ({ ok: true, brief, report, verified, ...(shown ? { shown } : {}) });

interface Win { hwnd: number; pid: number; title: string; process?: string }

function pickTarget(d: AgentDeps, snap: DesktopSnapshot): Win | null {
  const fg = d.foreground?.lastExternal() ?? null;
  if (fg) {
    const w = snap.windows.find((x) => x.pid === fg.pid && !x.isMomo);
    if (w) return { hwnd: fg.hwnd, pid: fg.pid, title: fg.title || w.title, process: w.process };
  }
  const a = snap.active;
  return a && !a.isMomo ? { hwnd: a.hwnd, pid: a.pid, title: a.title, process: a.process } : null;
}

function matchWindows(snap: DesktopSnapshot, query: string): Win[] {
  const q = norm(query);
  const tokens = q.split(" ").filter(Boolean);
  const cands = snap.windows.filter((w) => !w.isMomo);
  const exact = cands.filter((w) => norm(w.process) === q || norm(w.title) === q);
  const hits = exact.length > 0 ? exact : cands.filter((w) => { const hay = norm(`${w.title} ${w.process}`); return tokens.length > 0 && tokens.every((t) => hay.includes(t)); });
  return hits.map((w) => ({ hwnd: w.hwnd, pid: w.pid, title: w.title, process: w.process }));
}

/** The window the user means: the one they named, else the one they were just in. Several matches are handed back to be asked. */
async function resolveWindow(ctx: ToolCtx, query: string | undefined, patchKey: string): Promise<{ win: Win } | { out: ToolOutcome }> {
  const snap = await ctx.d.desktopAgent.snapshot();
  if (!ctx.live()) return { out: fail("cancelled") };
  if (!query) {
    const t = pickTarget(ctx.d, snap);
    return t ? { win: t } : { out: fail("I can't tell which window is meant. Ask the user to click it, or name it.") };
  }
  const cands = matchWindows(snap, query);
  if (cands.length === 0) return { out: fail(`No open window matches "${short(query, 40)}".`) };
  if (cands.length > 1) {
    const opts = cands.slice(0, 6);
    return { out: { ok: false, ambiguous: { noun: "windows", labels: opts.map((w) => `${short(w.title, 40)} (${w.process ?? "app"})`), patches: opts.map((w) => ({ [patchKey]: `${w.title}` , _hwnd: w.hwnd })) } } };
  }
  return { win: cands[0] };
}

/** The window the planner named, or the exact one the user picked when asked "which one?". */
async function windowFor(ctx: ToolCtx, a: { window?: string; _hwnd?: number }): Promise<{ win: Win | null } | { out: ToolOutcome }> {
  if (a._hwnd) {
    const snap = await ctx.d.desktopAgent.snapshot();
    const x = snap.windows.find((q) => q.hwnd === a._hwnd && !q.isMomo);
    return { win: x ? { hwnd: x.hwnd, pid: x.pid, title: x.title, process: x.process } : null };
  }
  return resolveWindow(ctx, a.window, "window");
}

const typedOutcome = (readBack: string, text: string, name: string, ctx: ToolCtx): ToolOutcome =>
  ctx.d.verifier.typed(readBack, text).verified
    ? ok(`Typed it into "${short(name, 50)}"; the field was read back and matches.`, true, undefined, "Typed, and read back")
    : ok(`Entered it, but "${short(name, 50)}" now shows something different (${short(readBack, 40)}).`, false);

const typeWord = (t: string): string =>
  ({ Button: "button", SplitButton: "button", CheckBox: "checkbox", RadioButton: "option", TabItem: "tab", Hyperlink: "link", MenuItem: "menu item", ListItem: "item", TreeItem: "item", DataItem: "item", Edit: "field", ComboBox: "field" } as Record<string, string>)[t] ?? "control";

/** Wait until a browser (never a private window, never Momo) is really showing a site. Returns its name, or null when it could not be confirmed. */
async function confirmPage(ctx: ToolCtx, host: string): Promise<string | null | undefined> {
  const sleep = sleeper(ctx);
  for (let i = 0; i < attempts(ctx, 4); i++) { // a browser can take a while to start and load
    await sleep(800);
    if (!ctx.live()) return undefined;
    const snap = await ctx.d.desktopAgent.snapshot();
    if (!ctx.live()) return undefined;
    const w = snap.active && !snap.active.isMomo && BROWSER_PROCESSES.test(snap.active.process) && !isPrivateWindow(snap.active.title) ? snap.active : null;
    if (!w) continue;
    const ui = await ctx.d.uiAgent.read(w.hwnd);
    if (!ctx.live()) return undefined;
    if (!ui.ok) continue;
    const page = extractPage(ui.items);
    const selected = page.tabs.find((t) => t.selected);
    if (ctx.d.verifier.urlShown({ address: page.address, selectedTitle: selected?.name }, host).verified) return browserName(w.process);
  }
  return null;
}

/** Tell the shadow cursor where Momo is about to act (it clicks nothing itself: it only shows the user what Momo is doing). */
async function pointAt(ctx: ToolCtx, node: UiNode, action: "look" | "select" | "click" | "type" | "submit", wait = true): Promise<void> {
  const r = node.rect;
  if (!r) return;
  const ev = parseRuntimeEvent({ type: "cursor.move", x: Math.round(r.l + r.w / 2), y: Math.round(r.t + r.h / 2), w: Math.round(r.w), h: Math.round(r.h), action, label: short(node.name, 40) });
  if (!ev) return;
  ctx.d.emit(ev);
  // let the ghost arrive BEFORE the real action, so the user sees what is about to happen
  const lead = ctx.d.cursorLeadMs?.() ?? 0;
  if (wait && lead > 0) await sleeper(ctx)(lead);
}

// ---- Showing the steps a person would take. This is a SHOW for the user: the ghost walks through the taskbar icon / Start menu /
// address bar the way someone would, one step at a time, and Momo's real action (a direct, verified call) happens right after.
// Nothing here moves the real mouse or presses a key; it only draws. It does nothing at all when the shadow cursor is off.
interface DemoStep { rect: NonNullable<UiNode["rect"]>; action: "look" | "select" | "click" | "type" | "submit"; label: string; text?: string; say: string }

async function walkSteps(ctx: ToolCtx, steps: DemoStep[]): Promise<void> {
  const lead = ctx.d.cursorLeadMs?.() ?? 0;
  if (lead <= 0) return;
  for (const st of steps) {
    if (!ctx.live()) return;
    const r = st.rect;
    const ev = parseRuntimeEvent({ type: "cursor.move", x: Math.round(r.l + r.w / 2), y: Math.round(r.t + r.h / 2), w: Math.round(r.w), h: Math.round(r.h), action: st.action, label: short(st.label, 40), text: st.text ? short(st.text, 60) : undefined, say: short(st.say, 90) });
    if (ev) ctx.d.emit(ev);
    await sleeper(ctx)(lead + (st.action === "type" ? 1300 : 700)); // the glide, then the action itself
  }
}

const GENERIC_APP_WORDS = new Set(["google", "microsoft", "windows", "app", "the", "inc", "corporation"]);

/** The taskbar button for an app ("Google Chrome - 2 running windows"), if it is pinned or running. */
function taskbarButton(items: UiNode[], appName: string): UiNode | undefined {
  // the taskbar names a button after its window ("My site - Chrome"), so match on the part that identifies the app ("chrome"),
  // not on the publisher ("Google") or generic words
  const all = norm(appName).split(" ").filter((w) => w.length > 1);
  const specific = all.filter((w) => !GENERIC_APP_WORDS.has(w));
  const words = (specific.length > 0 ? specific : all).slice(0, 2);
  if (words.length === 0) return undefined;
  return items
    .filter((n) => n.type === "Button" && !!n.rect && words.every((w) => norm(n.name).includes(w)))
    .sort((a, b) => a.name.length - b.name.length)[0];
}

/** How a person opens an app: click its taskbar icon, or click Start, type its name and press Enter. */
async function demoOpenApp(ctx: ToolCtx, appName: string, opts: { typed?: string; viaStart?: boolean } = {}): Promise<void> {
  if ((ctx.d.cursorLeadMs?.() ?? 0) <= 0) return;
  const items = await ctx.d.uiAgent.taskbar();
  if (!items || !ctx.live()) return;
  const pinned = opts.viaStart ? undefined : taskbarButton(items, appName);
  if (pinned) { await walkSteps(ctx, [{ rect: pinned.rect!, action: "click", label: `Taskbar: ${short(appName, 30)}`, say: `Clicking ${short(appName, 30)} on the taskbar` }]); return; }
  const start = items.find((n) => n.type === "Button" && /^start$/i.test(n.name.trim()) && !!n.rect);
  if (!start) return;
  const search = items.find((n) => /^search\b/i.test(n.name.trim()) && !!n.rect) ?? start;
  await walkSteps(ctx, [
    { rect: start.rect!, action: "click", label: "Start", say: "Opening the Start menu" },
    { rect: search.rect!, action: "type", label: "Search", text: opts.typed ?? appName, say: "Searching for it" },
    { rect: search.rect!, action: "submit", label: `Open ${short(appName, 30)}`, say: `Pressing Enter to open ${short(appName, 30)}` },
  ]);
}

/** A website: click the browser's taskbar icon (if one is there). */
async function demoOpenBrowser(ctx: ToolCtx): Promise<void> {
  if ((ctx.d.cursorLeadMs?.() ?? 0) <= 0) return;
  const items = await ctx.d.uiAgent.taskbar();
  if (!items || !ctx.live()) return;
  const b = items.find((n) => n.type === "Button" && !!n.rect && /\b(chrome|edge|firefox|brave|opera)\b/i.test(n.name));
  if (b) await walkSteps(ctx, [{ rect: b.rect!, action: "click", label: `Taskbar: ${short(b.name.split(" - ")[0], 30)}`, say: "Clicking the browser on the taskbar" }]);
}

/** Then the address bar: type the site and press Enter, as a person would. */
async function demoAddressBar(ctx: ToolCtx, host: string): Promise<void> {
  if ((ctx.d.cursorLeadMs?.() ?? 0) <= 0) return;
  const fg = ctx.d.foreground?.lastExternal();
  if (!fg || !ctx.live()) return;
  const ui = await ctx.d.uiAgent.read(fg.hwnd);
  if (!ui.ok || !ctx.live()) return;
  const bar = ui.items.find((n) => n.type === "Edit" && !!n.rect && /address|search or type|url/i.test(n.name));
  if (!bar) return;
  await walkSteps(ctx, [
    { rect: bar.rect!, action: "type", label: "Address bar", text: host, say: "Typing the address" },
    { rect: bar.rect!, action: "submit", label: "Go", say: "Pressing Enter to go" },
  ]);
}

/** The same for a whole window (open, switch, minimize, close): the desktop shell works out where that window is. */
async function pointAtWindow(ctx: ToolCtx, hwnd: number, action: "focus" | "minimize" | "close" | "open", label?: string): Promise<void> {
  const ev = parseRuntimeEvent({ type: "cursor.window", hwnd, action, label: label ? short(label, 40) : undefined });
  if (!ev) return;
  ctx.d.emit(ev);
  const lead = ctx.d.cursorLeadMs?.() ?? 0;
  if (lead > 0) await sleeper(ctx)(lead);
}

// ---- Acting like a person: the REAL pointer and keyboard (only while "Human-like control" is on). The ghost and the real pointer travel
// together, so what you see is what Momo does. Every real click is guarded: the target is identified first, its window is in front, the
// pointer is checked to be over THAT window when it arrives, and the user can take over at any moment (move the mouse, or press Esc).
const GLIDE_MS = 800;
const humanPointer = (ctx: ToolCtx): PointerPort | undefined => ctx.d.pointer?.();
const glideMs = (ctx: ToolCtx): number => ((ctx.d.cursorLeadMs?.() ?? 0) > 0 ? GLIDE_MS : 600);
const stoppedWhy = (reason: string): string => (reason === "stopped" ? "You pressed Esc, so I stopped." : "You moved the mouse, so I stopped and left it to you.");
const sameNode = (a: UiNode, b: UiNode): boolean => (!!a.rid && a.rid === b.rid) || (a.type === b.type && norm(a.name) === norm(b.name) && boxKey(a) === boxKey(b));

/** Is this window in front and not minimized, according to Windows? */
async function isFront(ctx: ToolCtx, win: Win): Promise<boolean> {
  const s = await ctx.d.actionAgent.state(win.hwnd);
  return s.exists && s.foregroundPid === win.pid && !s.minimized;
}

/** Bring a window to the front (restoring it if it was minimized) and wait until Windows confirms it. */
async function bringToFront(ctx: ToolCtx, win: Win): Promise<{ front: boolean; moved: boolean }> {
  if (await isFront(ctx, win)) return { front: true, moved: false };
  for (let i = 0; i < 2; i++) {
    if (!ctx.live()) return { front: false, moved: true };
    await ctx.d.actionAgent.focusWindow({ hwnd: win.hwnd, pid: win.pid });
    await sleeper(ctx)(500); // let the restore animation finish before anything is measured
    if (!ctx.live()) return { front: false, moved: true };
    if (await isFront(ctx, win)) return { front: true, moved: true };
  }
  return { front: false, moved: true };
}

type Human = { done: true; node: UiNode; items?: UiNode[] } | { done: false; stop?: string };

/** "Clicking “Sort”: opens a menu": the label that goes with the highlight, using what the control was understood to be FOR. */
const aimSay = (verb: string, node: UiNode, u?: Understanding): string => {
  const name = short(node.name, 36) || (u?.place ? `the control (${u.place})` : "the control");
  const purpose = u?.purpose ? short(u.purpose.replace(/\s*\(“[^”]*”\)\s*$/, "").replace(/\s*\([^)]*\)\s*$/, ""), 56) : "";
  return `${verb} ${node.name ? `“${name}”` : name}${purpose ? `: ${purpose}` : ""}`;
};
const aimTone = (k?: Kind): "button" | "search" | "input" | "menu" | "list" | "other" =>
  k === "search_box" || k === "address_box" ? "search" : k === "text_input" || k === "dropdown" ? "input" : k === "menu_button" || k === "menu_item" ? "menu" : k === "list_item" ? "list" : k === "button" || k === "toggle" || k === "tab" || k === "link" ? "button" : "other";
const AIM_MS = 450;
const aimMs = (ctx: ToolCtx): number => ((ctx.d.cursorLeadMs?.() ?? 0) > 0 ? AIM_MS : 0);

/** Momo has identified its target: highlight that exact element (with what it is for) and let it show BEFORE anything moves. */
async function aimAt(ctx: ToolCtx, rect: NonNullable<UiNode["rect"]>, label: string, say: string, kind?: Kind): Promise<void> {
  const ev = parseRuntimeEvent({ type: "cursor.aim", x: Math.round(rect.l + rect.w / 2), y: Math.round(rect.t + rect.h / 2), w: Math.round(rect.w), h: Math.round(rect.h), label: short(label, 40), say: short(say, 98), kind: aimTone(kind) });
  if (ev) ctx.d.emit(ev);
  const ms = aimMs(ctx);
  if (ms > 0) await sleeper(ctx)(ms);
}

/**
 * Move the real pointer to a control and click it. The target is highlighted first (with what it is for), the ghost then follows the
 * REAL pointer, and the click only happens if the window is still where it was when the control was read: if it was dragged, the control
 * is found again once and the click is aimed again. Not done = the caller falls back to UI Automation, unless it says stop.
 */
async function humanClick(ctx: ToolCtx, win: Win, node: UiNode, action: "click" | "select" | "type", opts: { double?: boolean; u?: Understanding; wrect?: NonNullable<UiNode["rect"]> } = {}): Promise<Human> {
  const p = humanPointer(ctx);
  if (!p || !node.rect || node.password) return { done: false };
  const fr = await bringToFront(ctx, win);
  if (!ctx.live()) return { done: false, stop: "cancelled" };
  if (!fr.front) return { done: false };
  let cur = node;
  let items: UiNode[] | undefined;
  let wrect = fr.moved ? undefined : opts.wrect; // a window that was just restored has moved since it was read
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 || fr.moved || !wrect) { // the window was restored or dragged: where things are now must be read again
      const before = p.windowRect?.(win.hwnd) ?? undefined;
      const ui = await ctx.d.uiAgent.read(win.hwnd);
      if (!ctx.live()) return { done: false, stop: "cancelled" };
      const again = ui.ok ? ui.items.find((n) => sameNode(n, node) && !!n.rect) ?? ui.items.find((n) => !!n.rid && n.rid === node.rid && !!n.rect) : undefined;
      if (!ui.ok || !again) return { done: false };
      cur = again; items = ui.items; wrect = before;
    }
    const r = cur.rect!;
    if (r.w < 4 || r.h < 4 || cur.offscreen) return { done: false };
    const u = opts.u && attempt === 0 ? opts.u : undefined;
    await aimAt(ctx, r, cur.name, aimSay(action === "click" ? (opts.double ? "Opening" : "Clicking") : action === "select" ? "Selecting" : "Typing in", cur, u), u?.kind);
    if (!ctx.live()) return { done: false, stop: "cancelled" };
    const res = await p.click(Math.round(r.l + r.w / 2), Math.round(r.t + r.h / 2), { ms: glideMs(ctx), expectRoot: win.hwnd, expectWindow: wrect ? { hwnd: win.hwnd, rect: wrect } : undefined, double: opts.double });
    if (!ctx.live()) return { done: false, stop: "cancelled" };
    if (res.ok) return { done: true, node: cur, items };
    if (res.reason === "user_moved" || res.reason === "stopped") return { done: false, stop: stoppedWhy(res.reason) };
    if (res.reason !== "moved") return { done: false }; // covered by another window, or the click was refused: UI Automation will do it instead
    wrect = undefined; // it moved: read it again and aim again (once)
  }
  return { done: false };
}

// ---- Understanding what a control is FOR (uipanel/understand.ts): used before touching it, and in what Momo tells the user.
const know = (win: Win, node: UiNode, items: UiNode[]): Understanding => understand(node, { process: win.process ?? "", title: win.title, items });
const VISION_KINDS: Record<string, Kind> = { button: "button", icon_button: "button", search_box: "search_box", text_input: "text_input", dropdown: "dropdown", menu: "menu_button", toggle: "toggle", tab: "tab", link: "link" };
/** "searches: files inside “Project 2”" / "what it searches: NOT STATED" / "" : the part that tells look-alike boxes apart. */
const scopeNote = (u: Understanding): string =>
  u.kind === "search_box" || u.kind === "address_box" ? (u.scope ? `${u.kind === "search_box" ? "searches" : "addresses"}: ${u.scope}` : "what it searches: not stated") : "";
/** One sentence: what Momo understood the control to be, and how it knows. */
const understoodAs = (u: Understanding): string =>
  u.purpose ? ` Momo understood it as: ${u.purpose}${u.scope ? `; ${scopeNote(u)}` : ""} (${u.basis.filter((b) => b !== "none").join(" + ")}).` : "";

/** Click one identified control and check that something visibly changed. `open` double-clicks (a folder, a drive, a file in a list). */
async function clickNode(ctx: ToolCtx, win: Win, node: UiNode, before: UiNode[], open = false, u?: Understanding, wrect?: NonNullable<UiNode["rect"]>): Promise<ToolOutcome> {
  const name = short(node.name, 50) || "the control";
  const t = { hwnd: win.hwnd, pid: win.pid, rid: node.rid!, name: node.name, unnamedOk: !node.name };
  let sig0 = signature(before);
  const h = await humanClick(ctx, win, node, "click", { double: open, u, wrect });
  if (!h.done && h.stop) return fail(h.stop);
  if (h.done) {
    if (h.items) sig0 = signature(h.items); // compare with how it looked right before the click, not before the window was restored
  } else {
    if (u) await aimAt(ctx, node.rect ?? { l: 0, t: 0, w: 0, h: 0 }, node.name, aimSay(open ? "Opening" : "Clicking", node, u), u.kind);
    await pointAt(ctx, node, "click");
    const r = await ctx.d.actionAgent.clickControl(t);
    if (!ctx.live()) return fail("cancelled");
    if (!r.ok) return fail(r.reason);
  }
  ctx.d.emit({ type: "cursor.result", state: "verifying", text: "Checking…" }); // the screen is being read again: show that, not a result yet
  await sleeper(ctx)(700);
  if (!ctx.live()) return fail("cancelled");
  const after = await ctx.d.uiAgent.read(win.hwnd);
  if (!ctx.live()) return fail("cancelled");
  let gone = false;
  if (!after.ok) gone = !(await ctx.d.actionAgent.state(win.hwnd)).exists;
  let verdict = ctx.d.verifier.clickEffect(sig0, after.ok ? signature(after.items) : null, gone);
  let how = gone ? "the window closed" : "the window changed";
  // what it was UNDERSTOOD to do is what gets checked: a switch must have flipped, a menu button must have opened something
  if (u && after.ok && !gone && u.purpose) {
    const sp = ctx.d.verifier.componentEffect(u.effect, node, after.items.find((n) => sameNode(n, node)), before.length, after.items.length);
    if (sp) { verdict = sp; how = sp.evidence[0]; }
  }
  if (verdict.verified && node.type === "TabItem") await ctx.d.actionAgent.focusWindow({ hwnd: win.hwnd, pid: win.pid }); // a tab: also bring its window forward (best effort)
  return verdict.verified
    ? ok(`Clicked "${name}" in "${short(win.title)}"; ${how}.${u ? understoodAs(u) : ""}`, true, undefined, how)
    : ok(`Clicked "${name}" but ${u && u.purpose && verdict.evidence[0] ? `what it should do did not happen (${verdict.evidence[0]})` : "nothing visibly changed"}, so the effect could not be confirmed.${u ? understoodAs(u) : ""}`, false);
}

/** Click an app's taskbar button with the real pointer, like a person (only while human-like control is on). */
async function humanTaskbar(ctx: ToolCtx, appName: string): Promise<{ done: boolean; stop?: string }> {
  const p = humanPointer(ctx);
  if (!p) return { done: false };
  const items = await ctx.d.uiAgent.taskbar();
  if (!items || !ctx.live()) return { done: false };
  const b = taskbarButton(items, appName);
  if (!b?.rect) return { done: false };
  const r = b.rect;
  await aimAt(ctx, r, `Taskbar: ${short(appName, 30)}`, `Clicking ${short(appName, 30)} on the taskbar`, "button");
  if (!ctx.live()) return { done: false, stop: "cancelled" };
  // the taskbar must really be what is under the pointer: a full-screen app can cover it, and then this click would hit that app
  const res = await p.click(Math.round(r.l + r.w / 2), Math.round(r.t + r.h / 2), { ms: glideMs(ctx), expectClass: ["Shell_TrayWnd", "Shell_SecondaryTrayWnd"] });
  if (!ctx.live()) return { done: false, stop: "cancelled" };
  if (res.ok) return { done: true };
  return res.reason === "user_moved" || res.reason === "stopped" ? { done: false, stop: stoppedWhy(res.reason) } : { done: false };
}

/**
 * The app is already running: bring ITS window forward instead of starting another copy. A minimized window is restored. When the app has
 * just one window and the taskbar is readable, a person would click its taskbar button, so that is what happens (with the real pointer);
 * otherwise Windows is asked to bring the front-most window forward. Either way the result is checked with Windows.
 */
async function activateRunning(ctx: ToolCtx, appName: string, w: { hwnd: number; pid: number; title: string; active?: boolean; state?: string }, others: number): Promise<ToolOutcome> {
  const win: Win = { hwnd: w.hwnd, pid: w.pid, title: w.title };
  const title = short(w.title);
  const more = others > 0 ? ` (${others} other window${others === 1 ? "" : "s"} of it ${others === 1 ? "is" : "are"} open too)` : "";
  if (await isFront(ctx, win)) return ok(`${appName} is already open and in front ("${title}")${more}, so I did not start another.`, true);
  const was = w.state === "minimized" ? "minimized" : w.state === "maximized" ? "maximized, behind other windows" : "open behind other windows";
  if (others === 0 && humanPointer(ctx)) {
    const h = await humanTaskbar(ctx, appName);
    if (h.stop) return fail(h.stop);
    if (h.done) {
      await sleeper(ctx)(600);
      if (!ctx.live()) return fail("cancelled");
      if (await isFront(ctx, win)) return ok(`${appName} was already running (${was}); I clicked its taskbar button and its window "${title}" is in front. I did not start another copy.`, true);
    }
  }
  await pointAtWindow(ctx, win.hwnd, "focus", title);
  const fr = await bringToFront(ctx, win);
  if (!ctx.live()) return fail("cancelled");
  return fr.front
    ? ok(`${appName} was already running (${was}); I brought its window "${title}" to the front${more}. I did not start another copy.`, true)
    : ok(`${appName} is already running (${was}), but its window "${title}" would not come forward (Windows sometimes blocks that).`, false);
}

// ----------------------------------------------------------------------------------------------------- the tools

const winArg = z.string().trim().min(1).max(120).optional();

/** What one tool is made of. The arguments' type comes from its schema, so a tool can never read an argument it did not declare. */
interface ToolSpec<S extends z.ZodTypeAny> {
  name: string;
  signature: string;
  description: string;
  sensitive: boolean;
  risk?: Risk | ((a: z.infer<S>) => Risk);
  schema: S;
  describe(a: z.infer<S>, ctx: ToolCtx): Promise<string> | string;
  working(a: z.infer<S>): string;
  run(a: z.infer<S>, ctx: ToolCtx): Promise<ToolOutcome>;
}

export function buildTools(): ToolDef[] {
  const tools: ToolDef[] = [];
  const add = <S extends z.ZodTypeAny>(t: ToolSpec<S>): void => {
    const r = t.risk;
    tools.push({ ...t, risk: (a: Record<string, unknown>) => (typeof r === "function" ? r(a as z.infer<S>) : r ?? "read") } as unknown as ToolDef);
  };

  // ---------------------------------------------------------------- File System Agent
  add({
    name: "drive_info", signature: "drive_info({drive?: \"D\"})", description: "Free and used space of one drive, or of all drives when no drive is given. Read-only, no window is opened.",
    sensitive: false, schema: z.object({ drive: z.string().regex(/^[A-Za-z]$/).optional() }).strict(),
    describe: () => "Check disk space.", working: () => "Checking disk space…",
    async run(a, ctx) {
      const fsA = ctx.d.fsAgent;
      if (a.drive) {
        const r = await fsA.drive(a.drive);
        if (r.kind === "not_found") return fail(`There is no drive ${r.letter}: on this PC. Available: ${r.available.join(", ")}.`);
        return ok(driveLine(r.info), ctx.d.verifier.drive(r.info).verified);
      }
      const all = await fsA.allDrives();
      if (all.length === 0) return fail("I couldn't read any drive.");
      return ok(all.map(driveLine).join("; "), all.every((d) => ctx.d.verifier.drive(d).verified));
    },
  });

  add({
    name: "find_paths", signature: "find_paths({query, kind?: \"file\"|\"folder\"|\"any\"})",
    description: "Look for files and/or folders by (part of) a name and list them with their full paths. Read-only: use it to answer \"where is…\". To OPEN something, use open_path instead.",
    sensitive: false, schema: z.object({ query: z.string().trim().min(1).max(120), kind: z.enum(["file", "folder", "any"]).optional() }).strict(),
    describe: (a) => `Look for “${a.query}”.`, working: (a) => `Looking for “${short(a.query, 40)}”…`,
    async run(a, ctx) {
      const res = await ctx.d.fsAgent.findPaths(a.query, a.kind ?? "any");
      if (!ctx.live()) return fail("cancelled");
      if (res.matches.length === 0) return ok(`Nothing named like "${short(a.query, 40)}" was found${res.truncated ? " (the search was cut short)" : ""}.`, true);
      const live: typeof res.matches = [];
      for (const m of res.matches.slice(0, 12)) if (await ctx.d.fs.stat(m.path)) live.push(m); // re-check on disk before reporting
      if (live.length === 0) return fail("What was found no longer exists.");
      const list = live.map((m, i) => `${i + 1}) ${m.isDir ? "folder" : "file"} ${m.path}`).join("  ");
      return ok(`${live.length} match${live.length === 1 ? "" : "es"}: ${list}${res.matches.length > live.length ? " …" : ""}${res.truncated ? " (search cut short)" : ""}`, true);
    },
  });

  // ---------------------------------------------------------------- Action Agent (files and folders)
  add({
    name: "open_path", signature: "open_path({query?, path?, kind?: \"file\"|\"folder\"|\"any\"})",
    description: "Open a file or a folder. Pass the user's own words in `query` (\"my resume\", \"projects folder\"); Momo searches, opens it straight away when there is ONE clear match, and itself asks the user which one when several match (showing names and full paths). Do NOT ask the user which one yourself and do NOT ask for confirmation. Use `path` only for an exact path you already know.",
    sensitive: false, risk: "reversible",
    schema: z.object({ query: z.string().trim().min(1).max(120).optional(), path: z.string().trim().min(3).max(300).optional(), kind: z.enum(["file", "folder", "any"]).optional() }).strict()
      .refine((a) => a.query !== undefined || a.path !== undefined, { message: "give `query` or `path`" }),
    describe: (a) => `Open ${short(a.path ?? a.query ?? "it", 80)}?`,
    working: (a) => `Opening ${short(a.path ?? a.query ?? "it", 60)}…`,
    async run(a, ctx) {
      // 1) which one? A unique exact name wins; one match is clear; several are the user's to choose from.
      let target = a.path;
      if (!target) {
        const res = await ctx.d.fsAgent.findPaths(a.query!, a.kind ?? "any");
        if (!ctx.live()) return fail("cancelled");
        const matches = res.matches;
        if (matches.length === 0) return fail(`Nothing named like "${short(a.query!, 40)}" was found on this PC${res.truncated ? " (the search was cut short)" : ""}.`);
        const words = norm(a.query!).replace(/ /g, "");
        const exact = matches.filter((m) => norm(m.isDir ? m.name : m.name.replace(/\.[^.]*$/, "")).replace(/ /g, "") === words);
        const pool = exact.length === 1 ? exact : exact.length > 1 ? exact : matches;
        if (pool.length > 1) {
          const opts = pool.slice(0, 9);
          return { ok: false, ambiguous: { noun: "matches", labels: opts.map((m) => `${m.isDir ? "Folder" : "File"}: ${m.name}`), details: opts.map((m) => m.path), patches: opts.map((m) => ({ path: m.path, query: undefined })) } };
        }
        target = pool[0].path;
      }
      // 2) it must still exist, and what it is decides how it is opened
      const st = await ctx.d.fs.stat(target);
      if (!st) return fail(`"${short(target, 80)}" does not exist.`);
      const isDir = st.isDir;
      // a program is RUN when opened: that is a decision, not routine
      if (!isDir && isProgramFile(target) && !ctx.confirmed) {
        return { ok: false, needsConfirmation: { summary: `“${short(target, 90)}” is a program. Opening it will RUN it. Run it?`, lock: target } };
      }
      if (ctx.lock !== undefined && target !== ctx.lock) return fail("The target changed, so nothing was opened.");
      // 3) open it (the ghost first shows how a person would: File Explorer from the taskbar, or Start and the name)
      const baseName = target.split("\\").pop() ?? "file";
      await (isDir ? demoOpenApp(ctx, "File Explorer") : demoOpenApp(ctx, baseName, { viaStart: true }));
      if (!ctx.live()) return fail("cancelled");
      const before = new Set((await ctx.d.desktopAgent.snapshot()).windows.map((w) => w.hwnd));
      if (!ctx.live()) return fail("cancelled");
      const r = isDir ? await ctx.d.actionAgent.openFolder(target) : await ctx.d.actionAgent.openFile(target);
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      // 4) verify: a window for it must really appear
      const sleep = sleeper(ctx);
      for (let i = 0; i < attempts(ctx, isDir ? 1 : 3); i++) {
        await sleep(isDir ? 600 : 900);
        if (!ctx.live()) return fail("cancelled");
        const snap = await ctx.d.desktopAgent.snapshot();
        if (!ctx.live()) return fail("cancelled");
        const v = isDir ? ctx.d.verifier.folderWindow(snap, target) : ctx.d.verifier.fileWindow(snap, before, target);
        if (v.verified) return ok(`Opened the ${isDir ? "folder" : "file"} ${target}; its window is showing.`, true);
      }
      return ok(`Asked Windows to open ${target}, but no window for it appeared.`, false);
    },
  });

  // ---------------------------------------------------------------- Screen awareness (Desktop + UI & Panel)
  const WINDOW_STATE: Record<string, string> = { minimized: "minimized", maximized: "maximized", normal: "open" };
  add({
    name: "look_screen", signature: "look_screen({window?})",
    description: "Observe the live desktop: every open window with its state (in front / maximized / open / minimized, front to back), and what the front window (or `window`) shows right now: its address or folder, its buttons and fields, and the items listed in it (folders, files, drives). Call it BEFORE choosing the next click and AFTER every action that changes the screen, so each move is decided from what is really there.",
    sensitive: true, risk: "sensitive_read",
    schema: z.object({ window: winArg, _hwnd: z.number().int().optional() }).strict(),
    describe: (a) => `Look at the screen${a.window ? ` (the “${short(a.window, 40)}” window)` : ""} and read what is on it?`, working: () => "Looking at the screen…",
    async run(a, ctx) {
      const snap = await ctx.d.desktopAgent.snapshot();
      if (!ctx.live()) return fail("cancelled");
      const ws = snap.windows.filter((w) => !w.isMomo).sort((x, y) => (x.z ?? 999) - (y.z ?? 999));
      const verdict = ctx.d.verifier.desktop(snap);
      const list = ws.slice(0, 10).map((w) => `${w.active ? "[in front] " : ""}${short(w.title, 34)} (${w.process}, ${WINDOW_STATE[w.state ?? "normal"]})`);
      let target: Win | null = null;
      if (a.window || a._hwnd) {
        const f = await windowFor(ctx, a as { window?: string; _hwnd?: number });
        if ("out" in f) return f.out;
        target = f.win;
      } else {
        const act = snap.active && !snap.active.isMomo ? snap.active : ws[0];
        target = act ? { hwnd: act.hwnd, pid: act.pid, title: act.title } : null;
      }
      let detail = "";
      if (target) {
        const ui = await ctx.d.uiAgent.read(target.hwnd);
        if (!ctx.live()) return fail("cancelled");
        if (ui.ok) {
          const shown = onScreen(ui.items, ui.items.filter((n) => !n.password));
          const addr = shown.find((n) => n.type === "Edit" && /address|location|search or type|url/i.test(n.name) && n.value);
          const seenName = new Set<string>();
          const controls = collectControls(shown, 60).filter((c) => !seenName.has(c.name.toLowerCase()) && !/^filter dropdown$/i.test(c.name) && (seenName.add(c.name.toLowerCase()), true)).slice(0, 28)
            .map((c) => (c.enabled ? c.name : `${c.name} (disabled)`));
          const items = shown.filter((n) => (n.type === "ListItem" || n.type === "DataItem" || n.type === "TreeItem") && cleanScreenText(n.name)).slice(0, 30)
            .map((n) => `${short(n.name, 40)}${n.state === "selected" ? " (selected)" : ""}`);
          detail = ` In "${short(target.title, 50)}"${addr ? ` address: ${short(addr.value!, 80)}.` : "."}${controls.length ? ` Controls: ${controls.join(", ")}.` : ""}${items.length ? ` Items: ${items.join(" | ")}.` : ""}`;
        } else detail = ` "${short(target.title, 50)}" does not describe its contents (${ui.reason}).`;
      }
      // what the front window shows comes FIRST (it decides the next move); the other windows follow, briefly
      return ok(`${detail.trim()} ${ws.length} windows, front to back: ${list.join("; ")}${ws.length > 10 ? "; …" : ""}.`.trim(), verdict.verified);
    },
  });

  // ---------------------------------------------------------------- Understanding what controls are FOR (UI & Panel + Visual Perception)
  const REF_RE = /^-?\d{1,5},-?\d{1,5}$/;
  const order = (u: Understanding): number => (u.kind === "search_box" || u.kind === "address_box" ? 0 : u.uncertain || u.purpose === null ? 1 : u.kind === "text_input" || u.kind === "dropdown" ? 2 : u.kind === "menu_button" || u.kind === "toggle" ? 3 : 4);
  add({
    name: "understand_screen", signature: "understand_screen({window?, only?: \"search\"|\"unclear\"})",
    description: "Understand what the controls of a window are FOR, not just what they are called: which boxes are search or address boxes and WHAT EACH ONE SEARCHES, which buttons open menus, which switches are on, and which controls Momo cannot explain (icon-only ones). Every line says how sure Momo is and where the evidence came from (the app's own metadata, the label, the surroundings, a picture of it). Use it before interacting when the purpose matters, for example when there may be several search bars. A control marked UNKNOWN or NOT SURE must be inspected (inspect_component) or the user asked; never guess it.",
    sensitive: true, risk: "sensitive_read",
    schema: z.object({ window: winArg, only: z.enum(["search", "unclear"]).optional(), _hwnd: z.number().int().optional() }).strict(),
    describe: (a) => `Look at ${a.window ? `the “${short(a.window, 40)}” window` : "the window you were just in"} and work out what its controls are for?`, working: () => "Working out what the controls do…",
    async run(a, ctx) {
      const found = await windowFor(ctx, a as { window?: string; _hwnd?: number });
      if ("out" in found) return found.out;
      if (!found.win) return fail("That window is gone.");
      const win = found.win;
      const ui = await ctx.d.uiAgent.read(win.hwnd);
      if (!ctx.live()) return fail("cancelled");
      if (!ui.ok) return fail(`Could not look inside "${short(win.title)}" (${ui.reason}).`);
      const comps = ctx.d.uiAgent.understandAll(win.hwnd, { process: win.process ?? "", title: win.title }, ui.items);
      if (comps.length === 0 && (await ctx.d.actionAgent.state(win.hwnd)).minimized) return fail(`"${short(win.title)}" is minimized, so none of its controls are on screen. Bring it to the front first (focus_window), then look again.`);
      // metadata was not enough for these: read their own pictures with the local OCR (nothing leaves this PC)
      let looked = 0;
      for (const c of comps) {
        if (looked >= 4) break;
        if (c.u.uncertain && c.u.needs === "ocr") {
          const r = await ctx.d.uiAgent.lookCloser(win.hwnd, c.node, c.u);
          if (!ctx.live()) return fail("cancelled");
          if (r.tried) { c.u = r.u; looked++; }
        }
      }
      const cells = comps.filter((c) => c.u.kind === "table_cell").length; // a table's cells are listed as a count, not one by one
      let shown = comps.filter((c) => c.u.kind !== "table_cell" && (c.u.kind !== "unknown" || c.u.purpose === null));
      if (a.only === "search") shown = shown.filter((c) => c.u.kind === "search_box" || c.u.kind === "address_box");
      if (a.only === "unclear") shown = shown.filter((c) => c.u.uncertain || c.u.purpose === null);
      shown = shown.sort((x, y) => order(x.u) - order(y.u));
      // identical controls (the same toolbar button repeated) are listed once, with how many there are
      const seenLine = new Map<string, number>();
      shown = shown.filter((c) => { const k = `${c.u.kind}|${c.node.name}|${c.u.purpose}`; const n = (seenLine.get(k) ?? 0) + 1; seenLine.set(k, n); return n === 1; });
      const times = (c: { node: UiNode; u: Understanding }) => seenLine.get(`${c.u.kind}|${c.node.name}|${c.u.purpose}`) ?? 1;
      shown = shown.slice(0, 26);
      if (shown.length === 0) return ok(`No ${a.only === "search" ? "search or address boxes" : a.only === "unclear" ? "unclear controls" : "controls"} in "${short(win.title)}".`, true);
      const lines = shown.map((c) => `${describeUnderstanding(c.node, c.u)}${times(c) > 1 ? ` (x${times(c)})` : ""}${c.u.uncertain || c.u.purpose === null ? ` [ref ${c.node.rect!.l},${c.node.rect!.t}]` : ""}`);
      const unclear = comps.filter((c) => c.u.uncertain || c.u.purpose === null).length;
      const boxes = comps.filter((c) => c.u.kind === "search_box" || c.u.kind === "address_box").length;
      const v = ctx.d.verifier.screenText(lines.map((l) => short(l, 150)), "uia");
      return ok(`In "${short(win.title)}": ${comps.length} controls understood (${boxes} search/address boxes, ${unclear} unclear${cells ? `, ${cells} table cells` : ""}${looked ? `; read ${looked} of their pictures on this PC` : ""}). ${lines.join(" || ")}`, v.verified);
    },
  });

  add({
    name: "inspect_component", signature: "inspect_component({label?, ref?, window?, visual?: true})",
    description: "Look closer at ONE control that Momo cannot explain yet (an icon-only button, a search box whose target is not stated). It reads the control's own picture with OCR on this PC. With visual:true it can also show that one small picture (nothing else on the screen) to a visual AI, but only if the user allows it for that picture. `ref` is the \"l,t\" shown next to an unclear control by understand_screen. Reports what was learned, how sure Momo is, and where it came from. Nothing is clicked.",
    sensitive: true, risk: "sensitive_read",
    schema: z.object({ label: z.string().trim().min(1).max(100).optional(), ref: z.string().regex(REF_RE).optional(), window: winArg, visual: z.boolean().optional(), _hwnd: z.number().int().optional() }).strict(),
    describe: (a) => `Look closely at ${a.label ? `“${short(a.label, 50)}”` : "that control"}${a.visual ? " and ask a visual AI about its picture" : ""}?`, working: () => "Looking closely…",
    async run(a, ctx) {
      if (!a.label && !a.ref) return fail("Say which control: its label, or the ref that understand_screen showed.");
      const found = await windowFor(ctx, a as { window?: string; _hwnd?: number });
      if ("out" in found) return found.out;
      if (!found.win) return fail("That window is gone.");
      const win = found.win;
      const ui = await ctx.d.uiAgent.read(win.hwnd);
      if (!ctx.live()) return fail("cancelled");
      if (!ui.ok) return fail(`Could not look inside "${short(win.title)}" (${ui.reason}).`);
      let matches: UiNode[];
      if (a.ref) {
        const [rl, rt] = a.ref.split(",").map(Number);
        matches = ui.items.filter((n) => !!n.rect && !n.offscreen && !n.password && Math.abs(n.rect.l - rl) <= 3 && Math.abs(n.rect.t - rt) <= 3 && n.type !== "Pane" && n.type !== "Group" && n.type !== "Text");
      } else {
        matches = [...matchControls(ui.items, a.label!, "click"), ...matchControls(ui.items, a.label!, "type")].filter((n, i, arr) => arr.findIndex((m) => m.rid === n.rid) === i);
      }
      if (matches.length === 0) return fail(a.ref ? `Nothing is at ${a.ref} any more: the screen changed. Look again.` : `No "${short(a.label!, 40)}" control in "${short(win.title)}".`);
      if (matches.length > 1) {
        const opts = matches.slice(0, 6);
        return { ok: false, ambiguous: { noun: "controls", labels: opts.map((n) => `${short(n.name, 40) || "(no label)"} (${typeWord(n.type)})`), details: opts.map((n) => describePlace(n, ui.items) || "in this window"), patches: opts.map((n) => ({ label: n.name || undefined, ref: n.name ? undefined : `${n.rect!.l},${n.rect!.t}`, _hwnd: win.hwnd })) } };
      }
      const node = matches[0];
      let u = know(win, node, ui.items);
      const steps: string[] = [];
      if (u.uncertain || u.purpose === null || u.needs) {
        const r = await ctx.d.uiAgent.lookCloser(win.hwnd, node, u);
        if (!ctx.live()) return fail("cancelled");
        if (r.tried) { u = r.u; steps.push(r.text.length ? `read its picture on this PC: “${short(r.text.join(" / "), 80)}”` : "read its picture on this PC: no text"); }
      }
      // still not clear: a visual AI may look at that ONE picture, only if the user allows it (the picture leaves this PC)
      if (a.visual && (u.uncertain || u.purpose === null)) {
        const ai = ctx.d.ai;
        if (!ai?.canSeeImages?.() || !ai.describeImage) {
          steps.push("no visual AI is available (it needs a vision model, and for an online one MOMO_AI_ALLOW_SCREEN_CONTEXT=true)");
        } else {
          if (!ctx.confirmed) {
            return { ok: false, needsConfirmation: { summary: `Show a small picture of just this one control (${u.place || "no other part of the screen"}) to ${ai.visionLabel?.() ?? "the AI"} to ask what it is for? The picture leaves this PC.`, lock: boxKey(node) || node.name } };
          }
          if (ctx.lock !== undefined && (boxKey(node) || node.name) !== ctx.lock) return fail("The screen changed, so the picture was not sent.");
          const pic = await ctx.d.uiAgent.picture(win.hwnd, node);
          if (!ctx.live()) return fail("cancelled");
          if ("reason" in pic) steps.push(`could not take its picture (${pic.reason})`);
          else {
            const r = await ai.describeImage(pic.png, node.type);
            if (!ctx.live()) return fail("cancelled");
            if (!r.ok) steps.push(`the visual AI did not help (${r.message})`);
            else if (!r.answer.confident || !r.answer.purpose) steps.push(`the visual AI could not tell either${r.answer.seen ? ` (it saw: ${short(r.answer.seen, 60)})` : ""}`);
            else { u = withPicture(u, node, { vision: { kind: VISION_KINDS[r.answer.kind], purpose: r.answer.purpose, scope: r.answer.scope ?? null } }); steps.push(`${r.source} looked at its picture: “${short(r.answer.purpose, 100)}”`); }
          }
        }
      }
      const verdict = u.purpose ? `${describeUnderstanding(node, u)}` : `${describeUnderstanding(node, u)}. Momo does not know what this is for: ask the user, and do not click it on a guess.`;
      return ok(`${verdict}${steps.length ? ` Looked closer: ${steps.join("; ")}.` : ""}${u.evidence.length ? ` Evidence: ${u.evidence.slice(0, 4).map((e) => short(e, 100)).join("; ")}.` : ""}`, true);
    },
  });

  // ---------------------------------------------------------------- Desktop Agent
  add({
    name: "list_windows", signature: "list_windows({})", description: "The open windows (titles and programs) and which one is active.",
    sensitive: true, risk: "read", schema: z.object({}).strict(),
    describe: () => "List the open windows.", working: () => "Looking at the open windows…",
    async run(_a, ctx) {
      const snap = await ctx.d.desktopAgent.snapshot();
      const ws = snap.windows.filter((w) => !w.isMomo);
      if (ws.length === 0) return ok("No other windows are open.", ctx.d.verifier.desktop(snap).verified);
      const lines = ws.slice(0, 25).map((w) => `${w.active ? "[active] " : ""}${short(w.title, 70)} (${w.process}${w.state && w.state !== "normal" ? `, ${w.state}` : ""})`);
      return ok(`${ws.length} windows: ${lines.join("; ")}${ws.length > 25 ? "; …" : ""}`, ctx.d.verifier.desktop(snap).verified);
    },
  });

  // ---------------------------------------------------------------- UI & Panel + Visual Perception Agents
  add({
    name: "read_window", signature: "read_window({window?, mode?: \"text\"|\"controls\", focus?: \"error\"})",
    description: "Read what a window shows: its text (focus \"error\" keeps only error lines), or its buttons and fields (mode \"controls\"). Without `window`, the window the user was just in.",
    sensitive: true, risk: "sensitive_read",
    schema: z.object({ window: winArg, mode: z.enum(["text", "controls"]).optional(), focus: z.enum(["error"]).optional(), _hwnd: z.number().int().optional() }).strict(),
    describe: (a) => `Look at ${a.window ? `the “${short(a.window, 40)}” window` : "the window you were just in"} and read it?`, working: () => "Reading the window…",
    async run(a, ctx) {
      const w = await windowFor(ctx, a as { window?: string; _hwnd?: number });
      if ("out" in w) return w.out;
      if (!w.win) return fail("That window is gone.");
      const { hwnd, title } = w.win;
      const ui = await ctx.d.uiAgent.read(hwnd);
      if (!ctx.live()) return fail("cancelled");
      if (a.mode === "controls") {
        if (!ui.ok) return fail(`Could not read the controls of "${short(title)}" (${ui.reason}).`);
        const controls = collectControls(ui.items);
        if (controls.length === 0) return fail(`"${short(title)}" does not tell Windows about its controls; try mode "text".`);
        const shown = controls.slice(0, 15).map((c) => (c.enabled ? c.name : `${c.name} (disabled)`));
        return ok(`${controls.length} controls in "${short(title)}": ${shown.join(", ")}${controls.length > 15 ? ", …" : ""}`, ctx.d.verifier.screenText(controls.map((c) => c.name), "uia").verified);
      }
      let lines = ui.ok ? collectText(ui.items, MAX_LINES) : [];
      let source: "uia" | "ocr" = "uia";
      const hasPassword = ui.ok && ui.hadPasswordField === true; // a screenshot would show whatever a password box shows
      if (totalChars(lines) < SPARSE_TEXT_CHARS && !hasPassword) {
        const o = await ctx.d.visualAgent.read(hwnd);
        if (!ctx.live()) return fail("cancelled");
        if (o.ok && o.lines.length > 0) { lines = o.lines.slice(0, MAX_LINES * 2); source = "ocr"; }
        else if (lines.length === 0) return fail(`Could not read "${short(title)}": ${o.ok ? "no text found" : o.reason}.`);
      }
      const v = ctx.d.verifier.screenText(lines, source);
      if (!v.verified) return fail("What was read did not check out, so it is not reported.");
      if (a.focus === "error") {
        const hits = errorLines(lines);
        if (hits.length === 0) return ok(`No error message in "${short(title)}".`, true);
        lines = hits;
      }
      const note = source === "ocr" ? " (read from a screenshot, so it may contain mistakes)" : "";
      return ok(`Text in "${short(title)}": ${lines.slice(0, 10).join(" · ").slice(0, 900)}${note}`, true);
    },
  });

  // ---------------------------------------------------------------- Action Agent (windows)
  const windowTool = (name: "focus_window" | "minimize_window" | "close_window") => add({
    name,
    signature: `${name}({window?})`,
    description: name === "focus_window" ? "Bring a window to the front. Without `window`, the window the user was just in."
      : name === "minimize_window" ? "Minimize a window. Without `window`, the window the user was just in."
      : "Close a window. Anything unsaved in it could be lost, so the user is always asked first.",
    sensitive: false, risk: name === "close_window" ? "consequential" : "reversible",
    schema: z.object({ window: winArg, _hwnd: z.number().int().optional() }).strict(),
    describe: (a) => {
      const t = a.window ? `“${short(a.window, 50)}”` : "the window you were just in";
      return name === "focus_window" ? `Switch to ${t}?` : name === "minimize_window" ? `Minimize ${t}?` : `Close ${t}? Anything unsaved in it could be lost.`;
    },
    working: () => (name === "close_window" ? "Closing it…" : name === "minimize_window" ? "Minimizing it…" : "Switching…"),
    async run(a, ctx) {
      const found = await windowFor(ctx, a as { window?: string; _hwnd?: number });
      if ("out" in found) return found.out;
      if (!found.win) return fail("That window is gone.");
      const t = { hwnd: found.win.hwnd, pid: found.win.pid };
      const title = short(found.win.title);
      await pointAtWindow(ctx, t.hwnd, name === "focus_window" ? "focus" : name === "minimize_window" ? "minimize" : "close", title);
      const r = name === "focus_window" ? await ctx.d.actionAgent.focusWindow(t) : name === "minimize_window" ? await ctx.d.actionAgent.minimizeWindow(t) : await ctx.d.actionAgent.closeWindow(t);
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      const sleep = sleeper(ctx);
      for (let i = 0; i < (name === "close_window" ? 4 : 2); i++) {
        await sleep(name === "close_window" ? 700 : 400);
        if (!ctx.live()) return fail("cancelled");
        const s = await ctx.d.actionAgent.state(t.hwnd);
        if (!ctx.live()) return fail("cancelled");
        const v = name === "focus_window" ? ctx.d.verifier.windowFocused(s, t.pid) : name === "minimize_window" ? ctx.d.verifier.windowMinimized(s) : ctx.d.verifier.windowClosed(s);
        if (v.verified) return ok(`${name === "focus_window" ? "Switched to" : name === "minimize_window" ? "Minimized" : "Closed"} "${title}"; Windows confirms it.`, true);
      }
      return ok(name === "focus_window" ? `Asked for "${title}" to come forward, but it did not (Windows sometimes blocks that).`
        : name === "minimize_window" ? `Asked for "${title}" to be minimized, but it still is not.`
        : `Asked "${title}" to close, but it is still open (it may be asking to save).`, false);
    },
  });
  windowTool("focus_window"); windowTool("minimize_window"); windowTool("close_window");

  // ---------------------------------------------------------------- Action Agent (controls)
  add({
    name: "click_control", signature: "click_control({label, window?, open?: true})",
    description: "Click a named button, link, tab, checkbox or list item in a window (the window the user was just in, unless named). Use open:true to double-click an item so it OPENS (a drive or folder in File Explorer, a file in a list). Clicks on labels like Send, Delete, Save, Pay, OK always need the user's approval.",
    sensitive: false, risk: (a) => classifyControlRisk(String(a.label ?? "")),
    schema: z.object({ label: z.string().trim().min(1).max(100).optional(), ref: z.string().regex(/^-?\d{1,5},-?\d{1,5}$/).optional(), window: winArg, open: z.boolean().optional(), _hwnd: z.number().int().optional(), _rid: z.string().max(200).optional(), _box: z.string().max(60).optional() }).strict(),
    describe: (a) => `${a.open ? "Open" : "Click"} ${a.label ? `“${short(a.label, 50)}”` : "the control you pointed to"}${a.window ? ` in “${short(a.window, 40)}”` : ""}?${a.label && classifyControlRisk(a.label) === "consequential" ? " This might not be undoable." : ""}`,
    working: (a) => (a.label ? `Looking for “${short(a.label, 40)}”…` : "Finding that control…"),
    async run(a, ctx) {
      if (!a.label && !a.ref) return fail("Say which control: its label, or the ref that understand_screen showed.");
      const found = await windowFor(ctx, a as { window?: string; _hwnd?: number });
      if ("out" in found) return found.out;
      if (!found.win) return fail("That window is gone.");
      const win = found.win;
      const wrect = humanPointer(ctx)?.windowRect?.(win.hwnd) ?? undefined; // where the window is NOW: it must still be there when the click lands
      const ui = await ctx.d.uiAgent.read(win.hwnd);
      if (!ctx.live()) return fail("cancelled");
      if (!ui.ok) return fail(`Could not look inside "${short(win.title)}" (${ui.reason}).`);
      let matches: UiNode[];
      if (a.ref) { // a control picked by where it is (one that has no label): the "l,t" that understand_screen showed
        const [rl, rt] = a.ref.split(",").map(Number);
        matches = ui.items.filter((n) => !!n.rect && !!n.rid && !n.offscreen && !n.password && Math.abs(n.rect.l - rl) <= 3 && Math.abs(n.rect.t - rt) <= 3);
      } else {
        matches = matchControls(ui.items, a.label!, "click");
        if (a._rid || a._box) { // the user already chose between look-alikes: that exact one
          const exact = matches.find((n) => !!n.rid && n.rid === a._rid) ?? matches.find((n) => !!a._box && boxKey(n) === a._box);
          if (exact) matches = [exact];
        }
      }
      if (matches.length === 0) {
        const names = visibleNames(ui.items, "click");
        return fail(a.ref ? `Nothing is at ${a.ref} any more: the screen changed. Look again.` : `No "${short(a.label!, 40)}" control in "${short(win.title)}".${names.length ? ` Visible: ${names.join(", ")}.` : ""}`);
      }
      if (matches.length > 1) {
        const opts = matches.slice(0, 6);
        // same-looking controls (two "This PC"): say where each one is and what it does, and keep the exact one that gets picked
        return { ok: false, ambiguous: { noun: "controls", labels: opts.map((n) => `${short(n.name, 40) || "(no label)"} (${typeWord(n.type)})`), details: opts.map((n) => [describePlace(n, ui.items) || "in this window", know(win, n, ui.items).purpose].filter(Boolean).join(" · ")), patches: opts.map((n) => ({ label: n.name || undefined, ref: n.name ? undefined : `${n.rect!.l},${n.rect!.t}`, _hwnd: win.hwnd, _rid: n.rid, _box: boxKey(n) })) } };
      }
      const node = matches[0];
      if (!node.enabled) return fail(`"${short(node.name, 50)}" is disabled right now.`);
      const lockOf = a.ref ? boxKey(node) : node.name;
      // what the control is REALLY called decides how risky the click is, not what was asked for
      if (!ctx.confirmed && classifyControlRisk(node.name) === "consequential") {
        return { ok: false, needsConfirmation: { summary: `Click the “${short(node.name, 50)}” ${typeWord(node.type)} in “${short(win.title)}”? This might not be undoable.`, lock: lockOf } };
      }
      // Identify BEFORE touching it: what is it for? A control picked by position, or one nothing explains, is looked at more closely (OCR on this PC)
      // first; if it is still not clear, the user is asked. Momo never clicks a control whose purpose it does not know.
      let u = know(win, node, ui.items);
      if ((a.ref || u.purpose === null) && !ctx.confirmed) {
        if (u.needs === "ocr") { u = (await ctx.d.uiAgent.lookCloser(win.hwnd, node, u)).u; if (!ctx.live()) return fail("cancelled"); }
        if (needsUserSayso(u)) {
          return { ok: false, needsConfirmation: { summary: `Click the ${typeWord(node.type)}${node.name ? ` “${short(node.name, 50)}”` : ""}${u.place ? ` (${u.place})` : ""} in “${short(win.title)}”? Momo isn't sure what it does: ${short(u.evidence.slice(-2).join("; "), 200)}.`, lock: lockOf } };
        }
      }
      if (ctx.lock !== undefined && lockOf !== ctx.lock) return fail(`"${short(ctx.lock, 50)}" has changed, so nothing was clicked.`);
      return clickNode(ctx, win, node, ui.items, a.open === true, u, wrect);
    },
  });

  add({
    name: "type_text", signature: "type_text({label, text, window?})",
    description: "Type text into a named field of a window (the window the user was just in, unless named). Never into password fields. Replaces what is in the field.",
    sensitive: false, risk: "reversible",
    schema: z.object({ label: z.string().trim().min(1).max(100), text: z.string().min(1).max(500), window: winArg, _hwnd: z.number().int().optional() }).strict(),
    describe: (a) => `Type “${a.text}” into the “${short(a.label, 50)}” field${a.window ? ` of “${short(a.window, 40)}”` : ""}?`,
    working: () => "Typing…",
    async run(a, ctx) {
      if (/\b(password|passcode|passphrase|pin|cvv|otp|secret)\b/i.test(a.label)) return fail("I never type into password fields.");
      const found = await windowFor(ctx, a as { window?: string; _hwnd?: number });
      if ("out" in found) return found.out;
      if (!found.win) return fail("That window is gone.");
      const win = found.win;
      const ui = await ctx.d.uiAgent.read(win.hwnd);
      if (!ctx.live()) return fail("cancelled");
      if (!ui.ok) return fail(`Could not look inside "${short(win.title)}" (${ui.reason}).`);
      const matches = matchControls(ui.items, a.label, "type");
      if (matches.length === 0) { const names = visibleNames(ui.items, "type"); return fail(`No "${short(a.label, 40)}" field in "${short(win.title)}".${names.length ? ` Visible fields: ${names.join(", ")}.` : ""}`); }
      if (matches.length > 1) {
        const opts = matches.slice(0, 6);
        return { ok: false, ambiguous: { noun: "fields", labels: opts.map((n) => `${short(n.name, 40)} (${typeWord(n.type)})`), patches: opts.map((n) => ({ label: n.name, _hwnd: win.hwnd })) } };
      }
      const node = matches[0];
      if (!node.enabled) return fail(`"${short(node.name, 50)}" is disabled right now.`);
      if (node.readOnly) return fail(`"${short(node.name, 50)}" is read-only.`);
      if (ctx.lock !== undefined && node.name !== ctx.lock) return fail(`"${short(ctx.lock, 50)}" has changed, so nothing was typed.`);
      // like a person: click into the field, select what is there, type. Checked by reading the field back; if that does not match, the
      // text is set through UI Automation instead.
      if (humanPointer(ctx) && a.text.length <= 200 && !/[\r\n]/.test(a.text)) {
        const h = await humanClick(ctx, win, node, "type");
        if (!h.done && h.stop) return fail(h.stop);
        if (h.done) {
          const sel = await ctx.d.uiAgent.read(win.hwnd);
          if (!ctx.live()) return fail("cancelled");
          const here = sel.ok ? sel.items.find((n) => sameNode(n, h.node)) : undefined;
          if (here?.focused && !here.password) {
            const pr = humanPointer(ctx)!;
            const k1 = await pr.press("ctrl+a");
            const k2 = k1.ok ? await pr.type(a.text, 35) : k1;
            if (!ctx.live()) return fail("cancelled");
            if (!k2.ok && (k2.reason === "stopped" || k2.reason === "user_moved")) return fail(stoppedWhy(k2.reason));
            await sleeper(ctx)(300);
            const back = await ctx.d.uiAgent.read(win.hwnd);
            if (!ctx.live()) return fail("cancelled");
            const field = back.ok ? back.items.find((n) => sameNode(n, h.node) || (!!n.rid && n.rid === node.rid)) : undefined;
            if (field && !field.password && typeof field.value === "string" && ctx.d.verifier.typed(field.value, a.text).verified) return typedOutcome(field.value, a.text, node.name, ctx);
          }
        }
      }
      await pointAt(ctx, node, "type");
      const r = await ctx.d.actionAgent.typeText({ hwnd: win.hwnd, pid: win.pid, rid: node.rid!, name: node.name }, a.text);
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      return typedOutcome(r.readBack, a.text, node.name, ctx);
    },
  });
  // ---- Select a field by voice ("select the search bar"), then the user dictates into it, then says "search" / "okay".
  const GENERIC_WORDS = /\b(the|a|an|that|this|bar|box|field|input|text|area|please)\b/gi;
  /** The field the user means: the exact one they already picked, else the ones SHOWN on screen that match what they said. */
  const resolveField = (items: UiNode[], a: { label: string; _rid?: string; _box?: string }): UiNode[] => {
    if (a._rid || a._box) {
      const exact = items.find((n) => !!n.rid && n.rid === a._rid) ?? items.find((n) => !!n.rid && !!a._box && boxKey(n) === a._box && norm(n.name) === norm(a.label));
      if (exact) return [exact];
    }
    let m = matchControls(items, a.label, "type");
    if (m.length === 0) {
      const core = a.label.replace(GENERIC_WORDS, " ").replace(/\s+/g, " ").trim();
      if (core) m = matchControls(items, core, "type");
    }
    return onScreen(items, m);
  };
  add({
    name: "select_field", signature: "select_field({label, window?})",
    description: "Put the cursor in a named text field (for example the search bar) so the user can dictate into it next. Use it for “select the search bar”, “click the address bar”, “go to the message box”. It types nothing.",
    sensitive: false, risk: "reversible",
    schema: z.object({ label: z.string().trim().min(1).max(100), window: winArg, _hwnd: z.number().int().optional(), _rid: z.string().max(200).optional(), _box: z.string().max(60).optional() }).strict(),
    describe: (a) => `Put the cursor in the “${short(a.label, 50)}” field${a.window ? ` of “${short(a.window, 40)}”` : ""}?`,
    working: (a) => `Selecting “${short(a.label, 40)}”…`,
    async run(a, ctx) {
      if (/\b(password|passcode|passphrase|pin|cvv|otp|secret)\b/i.test(a.label)) return fail("I never select password fields.");
      const found = await windowFor(ctx, a as { window?: string; _hwnd?: number });
      if ("out" in found) return found.out;
      if (!found.win) return fail("That window is gone.");
      const win = found.win;
      const ui = await ctx.d.uiAgent.read(win.hwnd);
      if (!ctx.live()) return fail("cancelled");
      if (!ui.ok) return fail(`Could not look inside "${short(win.title)}" (${ui.reason}).`);
      // only the boxes that are SHOWN: "the search bar" -> the words as said, then just the meaningful ones ("search")
      let matches = resolveField(ui.items, a as { label: string; _rid?: string; _box?: string });
      // "the search bar" names no particular box: EVERY box understood to be a search box counts, whatever it is called ("Search" would
      // otherwise beat "Search Project 2" by name alone), and the user is asked which one when they search different things
      if (!a._rid && !a._box && /^(search|find)?$/.test(a.label.replace(GENERIC_WORDS, " ").replace(/\s+/g, " ").trim().toLowerCase()) && /\b(search|find)\b/i.test(a.label)) {
        const boxes = onScreen(ui.items, ui.items.filter((n) => (n.type === "Edit" || n.type === "ComboBox") && !n.password && !!n.rid && know(win, n, ui.items).kind === "search_box"));
        if (boxes.length > matches.length) matches = boxes;
      }
      if (matches.length === 0) {
        const names = visibleNames(ui.items, "type");
        return fail(`No "${short(a.label, 40)}" field in "${short(win.title)}".${names.length ? ` Visible fields: ${names.join(", ")}.` : ""}`);
      }
      if (matches.length > 1) {
        const opts = matches.slice(0, 6);
        // look-alikes (two search bars): say WHERE each one is, and keep the exact one that gets picked
        return { ok: false, ambiguous: { noun: "matching boxes on screen", labels: opts.map((n) => `${short(n.name, 40)} (${typeWord(n.type)})`), details: opts.map((n) => [describePlace(n, ui.items) || "in this window", scopeNote(know(win, n, ui.items))].filter(Boolean).join(" · ")), patches: opts.map((n) => ({ label: n.name, _hwnd: win.hwnd, _rid: n.rid, _box: boxKey(n) })) } };
      }
      const node = matches[0];
      if (!node.enabled) return fail(`"${short(node.name, 50)}" is disabled right now.`);
      if (node.password) return fail("I never select password fields.");
      const understood = know(win, node, ui.items);
      if (ctx.lock !== undefined && node.name !== ctx.lock) return fail(`"${short(ctx.lock, 50)}" has changed, so nothing was selected.`);
      const h = await humanClick(ctx, win, node, "select", { u: understood }); // click into it like a person; checked below by asking Windows who has the cursor
      if (!h.done && h.stop) return fail(h.stop);
      if (h.done) {
        const after = await ctx.d.uiAgent.read(win.hwnd);
        if (!ctx.live()) return fail("cancelled");
        const here = after.ok ? after.items.find((n) => sameNode(n, h.node)) : undefined;
        if (here?.focused) return ok(`I clicked into "${short(node.name, 50)}" and Windows confirms it has the cursor. The user can dictate into it now.${understoodAs(understood)}`, true, undefined, "Windows confirms the cursor is in it");
      }
      if (!h.done) await pointAt(ctx, node, "select");
      const r = await ctx.d.actionAgent.focusField({ hwnd: win.hwnd, pid: win.pid, rid: node.rid!, name: node.name });
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      // the Windows call only returns once it has seen THIS field take the keyboard focus
      return ok(`The cursor is now in "${short(node.name, 50)}". The user can dictate into it now.${understoodAs(understood)}`, true, undefined, "Windows confirms the cursor is in it");
    },
  });

  // A box that was UNDERSTOOD to be a search or address box just runs; anywhere else Enter might send a message or submit a form, so that asks first.
  add({
    name: "press_enter", signature: "press_enter({window?})",
    description: "Press Enter in the text field that has the cursor, to run a search or confirm what was just dictated. Use it for “search”, “okay”, “go”, “enter”, “submit it”, after select_field and dictation. In a search or address box it just runs; in any other field the user is asked first (it could send a message).",
    sensitive: false, risk: "reversible",
    schema: z.object({ window: winArg, _hwnd: z.number().int().optional() }).strict(),
    describe: () => "Press Enter in the field that has the cursor? This may send or submit what is in it.",
    working: () => "Pressing Enter…",
    async run(a, ctx) {
      const found = await windowFor(ctx, a as { window?: string; _hwnd?: number });
      if ("out" in found) return found.out;
      if (!found.win) return fail("That window is gone.");
      const win = found.win;
      const ui = await ctx.d.uiAgent.read(win.hwnd);
      if (!ctx.live()) return fail("cancelled");
      if (!ui.ok) return fail(`Could not look inside "${short(win.title)}" (${ui.reason}).`);
      const node = ui.items.find((n) => n.focused && (n.type === "Edit" || n.type === "ComboBox") && !!n.rid);
      if (!node) return fail("No text field has the cursor. Ask the user to say “select the search bar” first, or to click into the field.");
      if (node.password) return fail("I never press Enter in password fields.");
      if (!node.enabled) return fail(`"${short(node.name, 50)}" is disabled right now.`);
      const understood = know(win, node, ui.items);
      const harmless = (understood.kind === "search_box" || understood.kind === "address_box") && !understood.uncertain;
      if (!ctx.confirmed && !harmless) {
        return { ok: false, needsConfirmation: { summary: `Press Enter in the “${short(node.name || "text", 50)}” field? That may send or submit what is in it.`, lock: node.name } };
      }
      if (ctx.lock !== undefined && node.name !== ctx.lock) return fail(`"${short(ctx.lock, 50)}" has changed, so Enter was not pressed.`);
      await pointAt(ctx, node, "submit");
      const r = await ctx.d.actionAgent.submitField({ hwnd: win.hwnd, pid: win.pid, rid: node.rid!, name: node.name });
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      return r.changed
        ? ok(`Pressed Enter in "${short(node.name, 50)}" and the page or box changed afterwards.${understood.kind === "search_box" || understood.kind === "address_box" ? ` It ${scopeNote(understood) || "is a search box"}.` : ""}`, true, undefined, "Enter pressed: the page changed")
        : ok(`Pressed Enter in "${short(node.name, 50)}", but nothing visibly changed, so I couldn't confirm it worked.`, false);
    },
  });

  // ---------------------------------------------------------------- Application Agent
  add({
    name: "open_app",
    signature: "open_app({app, account?, url?, window?, newWindow?: true})",
    description: "Start an installed app by name (\"Calculator\", \"Google Chrome\"). For Chrome, Edge or Brave: whenever the user mentions an account, email, icon, avatar or profile you MUST pass their words in `account` (e.g. \"work\", \"panda face icon\"); Momo matches it and asks the user if unsure. `url` (a website name like \"youtube\" or an address) opens that site in it, in the same account. Do this in ONE call. If the app is ALREADY running, Momo brings its existing window to the front (restoring it if minimized) instead of starting another; pass newWindow:true only when the user really wants a second, separate copy. If the app has SEVERAL windows and it is not clear which one is meant, Momo asks the user; pass `window` (part of that window's title) when the user said which.",
    sensitive: false, risk: "reversible",
    schema: z.object({ newWindow: z.boolean().optional(), window: z.string().trim().min(1).max(120).optional(), _hwnd: z.number().int().optional(), app: z.string().trim().min(1).max(80), account: z.string().trim().min(1).max(120).optional(), url: z.string().trim().min(1).max(300).optional(), profileDir: z.string().regex(/^(Default|Profile \d{1,3})$/).optional() }).strict(),
    async describe(a, ctx) {
      const site = a.url ? siteUrl(a.url) : null;
      let who = "";
      if (a.profileDir) {
        const key = browserKeyFor(a.app) ?? browserKeyFor(a.app.replace(/^google\s+/i, ""));
        const list = key ? await ctx.d.appAgent.profilesOfBrowser(key) : [];
        const p = list.find((x) => x.dir === a.profileDir);
        who = p ? ` with the “${short(profileLabels([p])[0], 70)}” account` : "";
      }
      if (!who && a.account) who = ` with the account you described (“${short(a.account, 40)}”)`;
      return `Open ${short(a.app, 40)}${who}${site ? ` and go to ${short(site.host, 40)}` : ""}?`;
    },
    working: (a) => `Starting ${short(a.app, 40)}…`,
    async run(a, ctx) {
      const found = await ctx.d.appAgent.search(a.app);
      if (!ctx.live()) return fail("cancelled");
      if (!found.ok) return fail(found.reason);
      if (found.matches.length === 0) return fail(`No installed app is called "${short(a.app, 40)}". (If it is a website, use open_url.)`);
      if (found.matches.length > 1) {
        const opts = found.matches.slice(0, 6);
        return { ok: false, ambiguous: { noun: "apps", labels: opts.map((x) => x.name), patches: opts.map((x) => ({ app: x.name })) } };
      }
      const app = found.matches[0];
      const site = a.url ? siteUrl(a.url) : null;
      if (a.url && !site) return fail(`"${short(a.url, 60)}" is not a website name or address I can open.`);

      // a browser with several accounts is ambiguous: use the user's description, or ask which
      let profile: BrowserProfile | undefined;
      const key = browserKeyFor(app.name);
      if (key && !a.profileDir) {
        const profiles = await ctx.d.appAgent.profilesOfBrowser(key);
        if (!ctx.live()) return fail("cancelled");
        if (profiles.length > 1) {
          const m = a.account ? matchProfileHint(profiles, a.account) : { matches: [] as BrowserProfile[], by: "none" as const };
          if (m.matches.length === 1) {
            profile = m.matches[0];
            // a match made from the account's picture is a guess: always confirmed, with the email
            if (m.by === "avatar" && !ctx.confirmed) {
              return { ok: false, needsConfirmation: { summary: `Open ${short(app.name, 40)} with what looks like the “${short(profileLabels([profile])[0], 70)}” account${site ? ` and go to ${short(site.host, 40)}` : ""}?`, lock: profile.dir } };
            }
          } else {
            const pool = m.matches.length > 1 ? m.matches : profiles;
            const opts = pool.slice(0, 9);
            const labels = profileLabels(opts);
            return { ok: false, ambiguous: { noun: `${short(app.name, 30)} accounts`, labels, patches: opts.map((p) => ({ profileDir: p.dir })) } };
          }
        } else if (profiles.length === 1) profile = profiles[0];
      } else if (key && a.profileDir) {
        profile = (await ctx.d.appAgent.profilesOfBrowser(key)).find((p) => p.dir === a.profileDir);
        if (!profile) return fail("That account no longer exists.");
      }
      if (ctx.lock !== undefined && profile && profile.dir !== ctx.lock) return fail("The account changed, so nothing was opened.");

      // already running? Then use that window: bring it forward (restore it if minimized) rather than starting a second copy
      const snap0 = await ctx.d.desktopAgent.snapshot();
      if (!ctx.live()) return fail("cancelled");
      const before = new Set(snap0.windows.map((w) => w.hwnd));
      let backgroundOf: string | null = null;
      if (!site && !profile && a.newWindow !== true) {
        let running = ctx.d.verifier.runningWindows(snap0, app.name);
        if (a._hwnd) running = running.filter((w) => w.hwnd === a._hwnd); // the user picked this one
        else if (a.window) { const q = norm(a.window); const hits = running.filter((w) => norm(w.title).includes(q)); if (hits.length > 0) running = hits; }
        if (running.length === 1) return activateRunning(ctx, app.name, running[0], 0);
        if (running.length > 1) {
          // several windows: if one is already in front, that is the one in use; otherwise it is NOT clear which is meant, so ask
          const front = running.find((w) => w.active);
          if (front && !a.window && !a._hwnd) return activateRunning(ctx, app.name, front, running.length - 1);
          const opts = running.slice(0, 8);
          const where = (w: (typeof running)[number]) => (w.state === "minimized" ? "minimized" : w.state === "maximized" ? "maximized" : w.active ? "in front" : "open behind other windows");
          return { ok: false, ambiguous: { noun: `${short(app.name, 30)} windows`, labels: opts.map((w) => short(w.title, 60)), details: opts.map(where), patches: opts.map((w) => ({ _hwnd: w.hwnd })) } };
        }
        // no window at all: is the app still RUNNING (in the tray, or with every window closed)?
        backgroundOf = ctx.d.verifier.backgroundProcess(snap0.processes, app.name);
      }
      // a person who sees the app's icon on the taskbar just clicks it: do that with the real pointer when allowed
      let clickedTaskbar = false;
      if (!site && !profile && humanPointer(ctx)) {
        const h = await humanTaskbar(ctx, app.name);
        if (h.stop) return fail(h.stop);
        clickedTaskbar = h.done;
      }
      if (!clickedTaskbar) await demoOpenApp(ctx, app.name); // otherwise the ghost shows how a person would start it
      if (!ctx.live()) return fail("cancelled");
      if (clickedTaskbar) { // did the click start it? (a window of that app that was not there before)
        const sleep0 = sleeper(ctx);
        for (let i = 0; i < attempts(ctx, 3); i++) {
          await sleep0(1000);
          if (!ctx.live()) return fail("cancelled");
          const snap = await ctx.d.desktopAgent.snapshot();
          if (!ctx.live()) return fail("cancelled");
          if (ctx.d.verifier.appWindow(snap, before, app.name).verified) return ok(`Opened ${app.name} by clicking its icon on the taskbar; its window is showing.`, true);
        }
        // the click did nothing: start it the normal way instead
      }
      const r = profile || site ? await ctx.d.appAgent.openProfile(app, profile?.dir ?? null, site?.url) : await ctx.d.appAgent.launchApp(app);
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      // what the planner is told never includes the account's email: only its display name
      const who = profile ? ` with the "${short(profile.name, 40)}" account` : "";
      if (site) {
        const shown = await confirmPage(ctx, site.host);
        if (shown === undefined) return fail("cancelled");
        if (shown) await demoAddressBar(ctx, site.host); // then the address bar, as a person would
        return shown ? ok(`Opened ${site.host} in ${shown}${who}; the browser is showing it.`, true) : ok(`Opened ${app.name}${who} for ${site.host}, but the page could not be confirmed.`, false);
      }
      const sleep = sleeper(ctx);
      for (let i = 0; i < attempts(ctx, 5); i++) { // Store apps can take 10+ seconds to show their first window
        await sleep(1000);
        if (!ctx.live()) return fail("cancelled");
        const snap = await ctx.d.desktopAgent.snapshot();
        if (!ctx.live()) return fail("cancelled");
        if (ctx.d.verifier.appWindow(snap, before, app.name).verified) return ok(`${backgroundOf ? `${app.name} was already running in the background (no window), so I asked Windows to bring it up. ` : ""}Opened ${app.name}${who}; its window is showing.`, true);
      }
      return ok(`Asked Windows to start ${app.name}${who}, but no window appeared yet.`, false);
    },
  });

  add({
    name: "open_url", signature: "open_url({url})", description: "Open a website (a name like \"youtube\" or an address) in the user's default browser. To open it in a particular browser or account, use open_app with `url`.",
    sensitive: false, risk: "reversible", schema: z.object({ url: z.string().trim().min(1).max(300) }).strict(),
    describe: (a) => `Open ${short(siteUrl(a.url)?.host ?? a.url, 70)} in your browser?`, working: () => "Opening it…",
    async run(a, ctx) {
      const site = siteUrl(a.url);
      if (!site) return fail(`"${short(a.url, 60)}" does not look like a normal web address.`);
      await demoOpenBrowser(ctx); // the ghost clicks the browser's taskbar icon first
      if (!ctx.live()) return fail("cancelled");
      const r = await ctx.d.appAgent.openUrl(site.url);
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      const shown = await confirmPage(ctx, site.host);
      if (shown === undefined) return fail("cancelled");
      if (shown) await demoAddressBar(ctx, site.host);
      return shown ? ok(`Opened ${site.host} in ${shown}; the browser is showing it.`, true) : ok(`Asked the browser to open ${site.host}, but the page could not be confirmed.`, false);
    },
  });

  // ---------------------------------------------------------------- Browser Agent
  add({
    name: "browser_accounts", signature: "browser_accounts({browser?: \"chrome\"|\"edge\"|\"brave\"})",
    description: "The accounts (profiles, with their emails) signed in to a browser. Default Chrome. The list is private: it is shown to the user.",
    sensitive: true, risk: "read", schema: z.object({ browser: z.enum(["chrome", "edge", "brave"]).optional() }).strict(),
    describe: () => "List the browser's accounts.", working: () => "Reading the browser's accounts…",
    async run(a, ctx) {
      const key: BrowserKey = a.browser === "edge" ? "msedge" : a.browser === "brave" ? "brave" : "chrome";
      const name = key === "msedge" ? "Edge" : key === "brave" ? "Brave" : "Chrome";
      const profiles = await ctx.d.appAgent.profilesOfBrowser(key);
      if (profiles.length === 0) return fail(`No ${name} accounts were found. Is ${name} installed and signed in?`);
      const v = ctx.d.verifier.profiles(profiles);
      if (!v.verified) return fail("What was read did not check out.");
      const labels = profileLabels(profiles).slice(0, 20).map((l, i) => `${i + 1}) ${short(l, 90)}`).join("  ");
      return ok(`${profiles.length} ${name} account${profiles.length === 1 ? "" : "s"}: ${labels}${profiles.length > 20 ? ", …" : ""}`, true);
    },
  });

  const browserWindows = (snap: DesktopSnapshot, browser?: string) =>
    snap.windows.filter((w) => !w.isMomo && BROWSER_PROCESSES.test(w.process) && (!browser || w.process.toLowerCase() === browser) && !isPrivateWindow(w.title)); // private windows are never read

  add({
    name: "list_tabs", signature: "list_tabs({browser?: \"chrome\"|\"edge\"|\"brave\"|\"firefox\"})",
    description: "The tabs open in the browser windows (private windows are never read) and which tab is selected. The list is private: it is shown to the user.",
    sensitive: true, risk: "sensitive_read", schema: z.object({ browser: z.enum(["chrome", "edge", "brave", "firefox"]).optional() }).strict(),
    describe: () => "Look at the browser tabs?", working: () => "Looking at the browser tabs…",
    async run(a, ctx) {
      const proc = a.browser === "edge" ? "msedge" : a.browser;
      const snap = await ctx.d.desktopAgent.snapshot();
      const wins = browserWindows(snap, proc);
      if (wins.length === 0) return ok("No browser window is open (private windows are never read).", true);
      const parts: string[] = [];
      for (const w of wins.slice(0, 6)) {
        const ui = await ctx.d.uiAgent.read(w.hwnd);
        if (!ctx.live()) return fail("cancelled");
        if (!ui.ok) continue;
        const page = extractPage(ui.items);
        if (page.tabs.length === 0) continue;
        parts.push(`${browserName(w.process)}: ${page.tabs.slice(0, 15).map((t) => (t.selected ? `[selected] ${short(t.name, 50)}` : short(t.name, 50))).join(" | ")}`);
      }
      return parts.length ? ok(parts.join(" — "), true) : fail("The browser did not expose its tabs.");
    },
  });

  add({
    name: "switch_tab", signature: "switch_tab({query, browser?})", description: "Bring a browser tab to the front by (part of) its title. If several tabs match, Momo asks the user.",
    sensitive: false, risk: "reversible", schema: z.object({ query: z.string().trim().min(1).max(100), browser: z.enum(["chrome", "edge", "brave", "firefox"]).optional(), _hwnd: z.number().int().optional(), _tab: z.string().optional() }).strict(),
    describe: (a) => `Switch to the “${short(a.query, 50)}” tab?`, working: () => "Switching tabs…",
    async run(a, ctx) {
      const proc = a.browser === "edge" ? "msedge" : a.browser;
      const snap = await ctx.d.desktopAgent.snapshot();
      const wins = browserWindows(snap, proc);
      const found: { win: (typeof wins)[number]; tab: { name: string }; items: UiNode[] }[] = [];
      for (const w of wins.slice(0, 6)) {
        if (a._hwnd && w.hwnd !== a._hwnd) continue;
        const ui = await ctx.d.uiAgent.read(w.hwnd);
        if (!ctx.live()) return fail("cancelled");
        if (!ui.ok) continue;
        const tabs = extractPage(ui.items).tabs;
        for (const t of matchTabs(tabs, a._tab ?? a.query)) found.push({ win: w, tab: t, items: ui.items });
      }
      if (found.length === 0) return fail(`No open tab matches "${short(a.query, 40)}".`);
      if (found.length > 1) {
        const opts = found.slice(0, 6);
        return { ok: false, ambiguous: { noun: "tabs", labels: opts.map((f) => `${short(f.tab.name, 40)} (${browserName(f.win.process)})`), patches: opts.map((f) => ({ _hwnd: f.win.hwnd, _tab: f.tab.name })) } };
      }
      const f = found[0];
      const node = f.items.find((n) => n.type === "TabItem" && cleanScreenText(n.name) === f.tab.name);
      if (!node || !node.rid) return fail("That tab changed, so nothing was clicked.");
      return clickNode(ctx, { hwnd: f.win.hwnd, pid: f.win.pid, title: f.win.title }, node, f.items);
    },
  });

  void hintWords;
  return tools;
}

export const TOOL_CATALOG = (tools: ToolDef[]) => tools.map((t) => ({ name: t.name, signature: t.signature, description: t.description }));
