import { z } from "zod";
import type { RuntimeEvent } from "../../types/runtime-events";
import { classifyControlRisk, isProgramFile, type ActionAgent, type Policy, type Risk } from "../action";
import { browserKeyFor, hintWords, matchProfileHint, profileLabels, siteUrl, type AppAgent } from "../apps";
import { BROWSER_PROCESSES, browserName, extractPage, isPrivateWindow, matchTabs } from "../browser";
import type { DesktopAgent, DesktopSnapshot } from "../desktop";
import type { DriveInfo, FileSystemAgent } from "../filesystem";
import type { BrowserKey, BrowserProfile, ForegroundPort, FsPort, UiNode } from "../shared/ports";
import {
  MAX_LINES, SPARSE_TEXT_CHARS, cleanScreenText, collectControls, collectText, errorLines, matchControls, signature, totalChars, visibleNames,
} from "../shared/screenText";
import type { UiPanelAgent } from "../uipanel";
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
  | { ok: true; brief: string; report: string; verified: boolean }
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
const ok = (brief: string, verified: boolean, report = brief): ToolOutcome => ({ ok: true, brief, report, verified });

interface Win { hwnd: number; pid: number; title: string; process?: string }

function pickTarget(d: AgentDeps, snap: DesktopSnapshot): Win | null {
  const fg = d.foreground?.lastExternal() ?? null;
  if (fg) {
    const w = snap.windows.find((x) => x.pid === fg.pid && !x.isMomo);
    if (w) return { hwnd: fg.hwnd, pid: fg.pid, title: fg.title || w.title };
  }
  const a = snap.active;
  return a && !a.isMomo ? { hwnd: a.hwnd, pid: a.pid, title: a.title } : null;
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
    return { win: x ? { hwnd: x.hwnd, pid: x.pid, title: x.title } : null };
  }
  return resolveWindow(ctx, a.window, "window");
}

const typedOutcome = (readBack: string, text: string, name: string, ctx: ToolCtx): ToolOutcome =>
  ctx.d.verifier.typed(readBack, text).verified
    ? ok(`Typed it into "${short(name, 50)}"; the field was read back and matches.`, true)
    : ok(`Entered it, but "${short(name, 50)}" now shows something different (${short(readBack, 40)}).`, false);

const typeWord = (t: string): string =>
  ({ Button: "button", SplitButton: "button", CheckBox: "checkbox", RadioButton: "option", TabItem: "tab", Hyperlink: "link", MenuItem: "menu item", ListItem: "item", Edit: "field", ComboBox: "field" } as Record<string, string>)[t] ?? "control";

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

/** Click one identified control and check that something visibly changed. */
async function clickNode(ctx: ToolCtx, win: Win, node: UiNode, before: UiNode[]): Promise<ToolOutcome> {
  const name = short(node.name, 50);
  const t = { hwnd: win.hwnd, pid: win.pid, rid: node.rid!, name: node.name };
  const sig0 = signature(before);
  const r = await ctx.d.actionAgent.clickControl(t);
  if (!ctx.live()) return fail("cancelled");
  if (!r.ok) return fail(r.reason);
  await sleeper(ctx)(700);
  if (!ctx.live()) return fail("cancelled");
  const after = await ctx.d.uiAgent.read(win.hwnd);
  if (!ctx.live()) return fail("cancelled");
  let gone = false;
  if (!after.ok) gone = !(await ctx.d.actionAgent.state(win.hwnd)).exists;
  const verdict = ctx.d.verifier.clickEffect(sig0, after.ok ? signature(after.items) : null, gone);
  if (verdict.verified && node.type === "TabItem") await ctx.d.actionAgent.focusWindow({ hwnd: win.hwnd, pid: win.pid }); // a tab: also bring its window forward (best effort)
  return verdict.verified
    ? ok(`Clicked "${name}" in "${short(win.title)}"; ${gone ? "the window closed" : "the window changed"} afterwards.`, true)
    : ok(`Clicked "${name}" but nothing visibly changed, so the effect could not be confirmed.`, false);
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
      // 3) open it
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

  // ---------------------------------------------------------------- Desktop Agent
  add({
    name: "list_windows", signature: "list_windows({})", description: "The open windows (titles and programs) and which one is active.",
    sensitive: true, risk: "read", schema: z.object({}).strict(),
    describe: () => "List the open windows.", working: () => "Looking at the open windows…",
    async run(_a, ctx) {
      const snap = await ctx.d.desktopAgent.snapshot();
      const ws = snap.windows.filter((w) => !w.isMomo);
      if (ws.length === 0) return ok("No other windows are open.", ctx.d.verifier.desktop(snap).verified);
      const lines = ws.slice(0, 25).map((w) => `${w.active ? "[active] " : ""}${short(w.title, 70)} (${w.process})`);
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
    name: "click_control", signature: "click_control({label, window?})",
    description: "Click a named button, link, tab or checkbox in a window (the window the user was just in, unless named). Clicks on labels like Send, Delete, Save, Pay, OK always need the user's approval.",
    sensitive: false, risk: (a) => classifyControlRisk(String(a.label ?? "")),
    schema: z.object({ label: z.string().trim().min(1).max(100), window: winArg, _hwnd: z.number().int().optional() }).strict(),
    describe: (a) => `Click “${short(a.label, 50)}”${a.window ? ` in “${short(a.window, 40)}”` : ""}?${classifyControlRisk(a.label) === "consequential" ? " This might not be undoable." : ""}`,
    working: (a) => `Looking for “${short(a.label, 40)}”…`,
    async run(a, ctx) {
      const found = await windowFor(ctx, a as { window?: string; _hwnd?: number });
      if ("out" in found) return found.out;
      if (!found.win) return fail("That window is gone.");
      const win = found.win;
      const ui = await ctx.d.uiAgent.read(win.hwnd);
      if (!ctx.live()) return fail("cancelled");
      if (!ui.ok) return fail(`Could not look inside "${short(win.title)}" (${ui.reason}).`);
      const matches = matchControls(ui.items, a.label, "click");
      if (matches.length === 0) {
        const names = visibleNames(ui.items, "click");
        return fail(`No "${short(a.label, 40)}" control in "${short(win.title)}".${names.length ? ` Visible: ${names.join(", ")}.` : ""}`);
      }
      if (matches.length > 1) {
        const opts = matches.slice(0, 6);
        return { ok: false, ambiguous: { noun: "controls", labels: opts.map((n) => `${short(n.name, 40)} (${typeWord(n.type)})`), patches: opts.map((n) => ({ label: n.name, _hwnd: win.hwnd })) } };
      }
      const node = matches[0];
      if (!node.enabled) return fail(`"${short(node.name, 50)}" is disabled right now.`);
      // what the control is REALLY called decides how risky the click is, not what was asked for
      if (!ctx.confirmed && classifyControlRisk(node.name) === "consequential") {
        return { ok: false, needsConfirmation: { summary: `Click the “${short(node.name, 50)}” ${typeWord(node.type)} in “${short(win.title)}”? This might not be undoable.`, lock: node.name } };
      }
      if (ctx.lock !== undefined && node.name !== ctx.lock) return fail(`"${short(ctx.lock, 50)}" has changed, so nothing was clicked.`);
      return clickNode(ctx, win, node, ui.items);
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
      const r = await ctx.d.actionAgent.typeText({ hwnd: win.hwnd, pid: win.pid, rid: node.rid!, name: node.name }, a.text);
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      return typedOutcome(r.readBack, a.text, node.name, ctx);
    },
  });
  // ---------------------------------------------------------------- Application Agent
  add({
    name: "open_app",
    signature: "open_app({app, account?, url?})",
    description: "Start an installed app by name (\"Calculator\", \"Google Chrome\"). For Chrome, Edge or Brave: whenever the user mentions an account, email, icon, avatar or profile you MUST pass their words in `account` (e.g. \"work\", \"panda face icon\"); Momo matches it and asks the user if unsure. `url` (a website name like \"youtube\" or an address) opens that site in it, in the same account. Do this in ONE call.",
    sensitive: false, risk: "reversible",
    schema: z.object({ app: z.string().trim().min(1).max(80), account: z.string().trim().min(1).max(120).optional(), url: z.string().trim().min(1).max(300).optional(), profileDir: z.string().regex(/^(Default|Profile \d{1,3})$/).optional() }).strict(),
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

      const before = new Set((await ctx.d.desktopAgent.snapshot()).windows.map((w) => w.hwnd));
      if (!ctx.live()) return fail("cancelled");
      const r = profile || site ? await ctx.d.appAgent.openProfile(app, profile?.dir ?? null, site?.url) : await ctx.d.appAgent.launchApp(app);
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      // what the planner is told never includes the account's email: only its display name
      const who = profile ? ` with the "${short(profile.name, 40)}" account` : "";
      if (site) {
        const shown = await confirmPage(ctx, site.host);
        if (shown === undefined) return fail("cancelled");
        return shown ? ok(`Opened ${site.host} in ${shown}${who}; the browser is showing it.`, true) : ok(`Opened ${app.name}${who} for ${site.host}, but the page could not be confirmed.`, false);
      }
      const sleep = sleeper(ctx);
      for (let i = 0; i < attempts(ctx, 5); i++) { // Store apps can take 10+ seconds to show their first window
        await sleep(1000);
        if (!ctx.live()) return fail("cancelled");
        const snap = await ctx.d.desktopAgent.snapshot();
        if (!ctx.live()) return fail("cancelled");
        if (ctx.d.verifier.appWindow(snap, before, app.name).verified) return ok(`Opened ${app.name}${who}; its window is showing.`, true);
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
      const r = await ctx.d.appAgent.openUrl(site.url);
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
      const shown = await confirmPage(ctx, site.host);
      if (shown === undefined) return fail("cancelled");
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
