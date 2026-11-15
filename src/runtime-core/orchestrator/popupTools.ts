import { z } from "zod";
import type { ToolCtx, ToolDef, ToolOutcome } from "./tools";
import type { MenuEntry, TransientWindow, UiNode } from "../shared/ports";
import { childrenOf, classifyDialog, describeMenu, dialogRisk, focusedIndex, isDialogKind, isMenuKind, isRefusedDialog, looksLikeMenu, navigable, normLabel, resolveButton, resolveStep, type DialogInfo } from "../uipanel";
import { classifyControlRisk } from "../action";
import { waitFor } from "../shared/changeWatch";
import { cleanScreenText } from "../shared/screenText";

/**
 * Menus, dropdowns, dialogs and other transient windows (phase 5). New tools only; the existing ones are untouched.
 *
 *  - look_popups  (5a)  what menus / dialogs / dropdowns / popups are open right now (read-only)
 *  - read_menu / choose_menu_item / close_popup (5b, 5d)
 *  - read_dialog / answer_dialog / choose_file (5c)
 *
 * SAFETY, for every tool here: nothing is ever dismissed or answered on its own; an unknown kind of popup is only ever listed; a secure-desktop,
 * credential or password prompt is never read or answered; nothing here keeps a title, a menu item, a path or any popup text (the planner is told
 * what it needs for this step and the journal only ever sees fixed facts).
 */

const short = (s: string, n = 60): string => { const c = cleanScreenText(s); return c.length > n ? c.slice(0, n - 1) + "…" : c; };
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const fail = (reason: string): ToolOutcome => ({ ok: false, reason });
/** a refusal made before anything was sent: it says so, which is what makes a retry safe */
export const failBefore = (reason: string, kind: "uia_failed" | "target_not_found" | "target_gone" | "target_disabled" | "blocked_by_policy" | "unavailable" | "target_moved" | "wrong_window" | "ambiguous" | "invalid_request" = "uia_failed"): ToolOutcome => ({ ok: false, reason, failure: { kind, acted: "no" } });
export const ok = (brief: string, verified: boolean, extra: Partial<Extract<ToolOutcome, { ok: true }>> = {}): ToolOutcome => ({ ok: true, brief, report: brief, verified, ...extra });
const winArg = z.string().trim().min(1).max(120).optional();

/** the window the user means, by name: exactly one, or "which one?" (never a guess) */
export async function ownerWindow(ctx: ToolCtx, name: string | undefined, hwnd: number | undefined): Promise<{ hwnd: number } | { out: ToolOutcome } | { hwnd: 0 }> {
  if (hwnd) return { hwnd };
  if (!name) return { hwnd: 0 };
  const snap = await ctx.d.desktopAgent.snapshot();
  const q = norm(name);
  const hits = snap.windows.filter((w) => !w.isMomo && (norm(w.title) === q || norm(w.process) === q || (q.length >= 3 && norm(`${w.title} ${w.process}`).includes(q))));
  if (hits.length === 0) return { out: failBefore(`No open window matches "${short(name, 40)}".`, "target_not_found") };
  if (hits.length > 1) {
    const opts = hits.slice(0, 6);
    return { out: { ok: false, ambiguous: { noun: "windows", labels: opts.map((w) => `${short(w.title, 40)} (${w.process})`), patches: opts.map((w) => ({ window: w.title, _hwnd: w.hwnd })) } } };
  }
  return { hwnd: hits[0].hwnd };
}

/** every visible popup (optionally only the ones that belong to one window), as the helper sees them; null when it cannot be asked */
export async function listPopups(ctx: ToolCtx, owner = 0): Promise<TransientWindow[] | null> {
  const r = await ctx.d.uiAgent.transients(); // the whole list, so the registry sees it; the owner filter is applied here
  if (!r.ok) return null;
  if (!owner) return r.windows;
  const ownerPid = (await ctx.d.desktopAgent.snapshot()).windows.find((w) => w.hwnd === owner)?.pid;
  return r.windows.filter((w) => w.rootOwner === owner || w.owner === owner || (w.owner === 0 && ownerPid !== undefined && w.pid === ownerPid));
}

/** one popup's contents, read on its own (a few dozen controls, not the whole window it belongs to) */
export async function readPopupUi(ctx: ToolCtx, hwnd: number): Promise<{ items: UiNode[]; hadPasswordField: boolean } | null> {
  const r = await ctx.d.uiAgent.read(hwnd);
  return r.ok ? { items: r.items, hadPasswordField: !!r.hadPasswordField } : null;
}

type Mk = (def: Omit<ToolDef, "risk"> & { risk: ToolDef["risk"] | "read" | "reversible" | "consequential" }) => ToolDef;
const mk: Mk = (d) => ({ ...d, risk: typeof d.risk === "function" ? d.risk : () => d.risk as "read" | "reversible" | "consequential" } as ToolDef);

const KIND_WORD: Record<TransientWindow["kind"], string> = { menu: "menu", dialog: "dialog", dropdown: "drop-down list", popup: "popup", window: "small window", secure: "secure prompt", other: "unknown popup" };

/** what the planner is told about one popup */
async function describePopup(ctx: ToolCtx, w: TransientWindow): Promise<{ line: string; dialog?: DialogInfo }> {
  const word = KIND_WORD[w.kind];
  if (w.kind === "secure") return { line: `a ${word} (${w.proc || "system"}): I never read or answer these` };
  if (isDialogKind(w.kind) || w.kind === "window") {
    const ui = await readPopupUi(ctx, w.hwnd);
    if (!ui) return { line: `a ${word} that could not be read` };
    const info = classifyDialog(w, ui.items, { hadPasswordField: ui.hadPasswordField });
    if (isRefusedDialog(info.category)) return { line: `a ${info.category} prompt: I never read or answer these` };
    const names = info.buttons.slice(0, 6).map((b) => `“${short(b.name, 24)}”`).join(", ");
    return { line: `a ${info.category === "other" ? "dialog" : info.category + " dialog"}${names ? ` with buttons ${names}` : ""}${info.textLines ? ` and ${info.textLines} line${info.textLines === 1 ? "" : "s"} of text` : ""}`, dialog: info };
  }
  if (isMenuKind(w.kind)) {
    const m = await ctx.d.uiAgent.menu(w.hwnd);
    if (m.ok && looksLikeMenu(m.items)) {
      const top = m.items.filter((i) => !i.separator && i.parent === -1);
      return { line: `a ${word} with ${top.length} item${top.length === 1 ? "" : "s"}: ${top.slice(0, 8).map((i) => short(i.name, 22)).join(", ")}${top.length > 8 ? ", …" : ""}` };
    }
    const ui = await readPopupUi(ctx, w.hwnd);
    const list = ui?.items.filter((n) => n.type === "ListItem" && n.name.trim()) ?? [];
    if (list.length) return { line: `a ${word} with ${list.length} choice${list.length === 1 ? "" : "s"}: ${list.slice(0, 8).map((i) => short(i.name, 22)).join(", ")}${list.length > 8 ? ", …" : ""}` };
    return { line: `a ${word} that Momo cannot read (it may be drawn by the application itself): it will not be used` };
  }
  return { line: `an unknown popup: listed only, never used` };
}

export function buildPopupTools(): ToolDef[] {
  const tools: ToolDef[] = [];

  // ---------------------------------------------------------------- 5a: look_popups
  tools.push(mk({
    name: "look_popups", signature: "look_popups({window?})",
    description: "See what menus, drop-down lists, dialogs and other pop-up windows are open right now (they do not show up in list_windows): context menus, submenus, file open/save dialogs, confirmation or permission dialogs, temporary windows. Says what each one is and what it offers. Read-only: nothing is clicked, closed or answered. Secure prompts (admin approval, sign-in, passwords) are reported but never read.",
    schema: z.object({ window: winArg, _hwnd: z.number().int().optional() }).strict() as never,
    sensitive: true, risk: () => "sensitive_read",
    describe: (a) => `Look at the pop-ups open${a.window ? ` in “${short(String(a.window), 40)}”` : ""}?`,
    working: () => "Looking at the pop-ups…",
    async run(a, ctx) {
      const own = await ownerWindow(ctx, a.window as string | undefined, a._hwnd as number | undefined);
      if ("out" in own) return own.out;
      const all = await listPopups(ctx, own.hwnd);
      if (!all) return failBefore("I could not list the pop-ups here (the observation helper is not available).", "unavailable");
      if (!ctx.live()) return fail("cancelled");
      const shown = all.slice(0, 8);
      if (shown.length === 0) return ok("No menu, dialog or other pop-up is open right now.", true);
      const lines: string[] = [];
      for (const [i, w] of shown.entries()) {
        const d = await describePopup(ctx, w);
        if (!ctx.live()) return fail("cancelled");
        lines.push(`${i + 1}. ${d.line}${w.fg ? " (in front)" : ""}`);
      }
      return ok(`${all.length} pop-up${all.length === 1 ? "" : "s"} open:\n${lines.join("\n")}`, true);
    },
  }));

  // ---------------------------------------------------------------- 5b: menus
  tools.push(mk({
    name: "read_menu", signature: "read_menu({window?})",
    description: "Read the menu that is open right now (a context menu, a drop-down menu, a submenu): its items, which are disabled or checked, which open a submenu, and their shortcut keys. Open it first with right_click or click_control. Read-only. An application that draws its own menus cannot be read, and is reported as such.",
    schema: z.object({ window: winArg, _hwnd: z.number().int().optional() }).strict() as never,
    sensitive: true, risk: () => "sensitive_read",
    describe: () => "Read the open menu?",
    working: () => "Reading the menu…",
    async run(a, ctx) {
      const own = await ownerWindow(ctx, a.window as string | undefined, a._hwnd as number | undefined);
      if ("out" in own) return own.out;
      const menus = await findMenus(ctx, own.hwnd);
      if (!menus) return failBefore("I could not list the pop-ups here (the observation helper is not available).", "unavailable");
      if (!ctx.live()) return fail("cancelled");
      if (menus.length === 0) {
        const any = await listPopups(ctx, own.hwnd);
        return any && any.some((w) => isMenuKind(w.kind))
          ? failBefore("A menu seems to be open, but Momo cannot read it (the application probably draws its own menus). I will not guess at it.", "unavailable")
          : failBefore("No menu is open right now.", "target_not_found");
      }
      const text = menus.map((m, i) => `${menus.length > 1 ? `Menu ${i + 1}${m.win.fg ? " (in front)" : ""}:\n` : ""}${describeMenu(m.items).join("\n")}`).join("\n\n");
      return ok(`${menus.length === 1 ? "The open menu" : `${menus.length} open menus`}:\n${text}`, true);
    },
  }));

  tools.push(mk({
    name: "choose_menu_item", signature: "choose_menu_item({path: [\"Item\", \"Sub item\"], window?})",
    description: "Choose an item of the menu that is open right now, by its exact name, following submenus: path [\"Sort by\", \"Name\"] opens “Sort by” and then chooses “Name”. Open the menu first (right_click, or click_control on a menu button). Every level is read again just before it is used, and the exact item is checked under the pointer; a name that does not match exactly, or matches twice, is not guessed. Items like Delete, Replace or Save need the user's approval.",
    schema: z.object({ path: z.array(z.string().trim().min(1).max(80)).min(1).max(5), window: winArg, via: z.enum(["auto", "mouse", "keys"]).optional(), _hwnd: z.number().int().optional() }).strict() as never,
    sensitive: false,
    risk: (a) => classifyControlRisk(String((a.path as string[] | undefined)?.slice(-1)[0] ?? "")),
    describe: (a) => `Choose “${((a.path as string[]) ?? []).map((s) => short(s, 30)).join(" ▸ ")}” from the open menu?`,
    working: (a) => `Choosing “${short(String(((a.path as string[]) ?? []).slice(-1)[0] ?? ""), 30)}”…`,
    async run(a, ctx) { return chooseMenuItem(a as { path: string[]; window?: string; via?: "auto" | "mouse" | "keys"; _hwnd?: number }, ctx); },
    async confirm(_a, target, view) {
      // read-only: is the popup the last level was chosen in gone now? (the menu closing is Windows' own evidence that the item was taken)
      if (!target || !view.popups) return { verified: null, evidence: [] };
      const list = await view.popups();
      if (!list) return { verified: null, evidence: [{ kind: "observation_failed", ok: null }] };
      const gone = !list.some((w) => w.hwnd === target.hwnd);
      return { verified: gone ? true : null, evidence: [{ kind: gone ? "popup_closed" : "popup_open", ok: true }] };
    },
  }));

  tools.push(mk({
    name: "close_popup", signature: "close_popup({window?})",
    description: "Close the open menu (and any submenus) with the Esc key, one level at a time, checking after each press. Only menus are closed: a dialog is never dismissed this way. Needs Human-like control.",
    schema: z.object({ window: winArg, _hwnd: z.number().int().optional() }).strict() as never,
    sensitive: false, risk: () => "reversible",
    describe: () => "Close the open menu?",
    working: () => "Closing the menu…",
    async run(a, ctx) {
      const p = ctx.d.pointer?.();
      if (!p) return failBefore("This needs Human-like control (Settings → General): it uses the real keyboard, and that is off. Nothing was done.", "unavailable");
      const own = await ownerWindow(ctx, a.window as string | undefined, a._hwnd as number | undefined);
      if ("out" in own) return own.out;
      const before = await findMenus(ctx, own.hwnd);
      if (!before) return failBefore("I could not list the pop-ups here (the observation helper is not available).", "unavailable");
      if (before.length === 0) return ok("No menu is open.", true);
      const closed = await escLadder(ctx, p, own.hwnd, before.length + 1);
      if (closed === "cancelled" || !ctx.live()) return fail("cancelled");
      if (closed === "stopped") return fail("You took over, so I stopped. The menu may still be open.");
      return closed === "closed" ? ok("The menu is closed.", true) : ok("I pressed Esc, but a menu is still open.", false);
    },
  }));

  // ---------------------------------------------------------------- 5c: dialogs
  tools.push(mk({
    name: "read_dialog", signature: "read_dialog({window?})",
    description: "Read the dialog that is open right now (a message or confirmation box, a permission request, a file Open/Save dialog): what it says, what its buttons are and which of them need the user's approval. Read-only. Secure prompts (administrator approval, sign-in, passwords, credentials) are never read or answered.",
    schema: z.object({ window: winArg, _hwnd: z.number().int().optional() }).strict() as never,
    sensitive: true, risk: () => "sensitive_read",
    describe: () => "Read the open dialog?",
    working: () => "Reading the dialog…",
    async run(a, ctx) {
      const own = await ownerWindow(ctx, a.window as string | undefined, a._hwnd as number | undefined);
      if ("out" in own) return own.out;
      const found = await findDialogs(ctx, own.hwnd);
      if (!found) return failBefore("I could not list the pop-ups here (the observation helper is not available).", "unavailable");
      if (!ctx.live()) return fail("cancelled");
      if (found.dialogs.length === 0) {
        return found.refused > 0
          ? failBefore("A secure prompt (administrator approval, sign-in or credentials) is open. I never read or answer those: please deal with it yourself.", "blocked_by_policy")
          : failBefore("No dialog is open right now.", "target_not_found");
      }
      const parts = found.dialogs.map((d, i) => {
        const texts = d.items.filter((n) => n.type === "Text" && n.name.trim()).slice(0, 6).map((n) => `  “${short(n.name, 200)}”`);
        const btns = d.info.buttons.map((b) => `${short(b.name, 30)}${b.risk === "consequential" ? " (asks you first)" : ""}${b.enabled ? "" : " (disabled)"}`).join(", ");
        return `${found.dialogs.length > 1 ? `Dialog ${i + 1}: ` : ""}${d.info.category === "other" ? "dialog" : d.info.category + " dialog"}${d.win.fg ? " (in front)" : ""}\n${texts.join("\n")}${texts.length ? "\n" : ""}  Buttons: ${btns || "none found"}${d.info.fileNameField ? "\n  It has a “File name” field (its value is never read)." : ""}`;
      });
      return ok(`${found.refused ? "(A secure prompt is also open: I do not read it.)\n" : ""}${parts.join("\n\n")}`, true);
    },
  }));

  tools.push(mk({
    name: "answer_dialog", signature: "answer_dialog({button, window?})",
    description: "Answer the open dialog by clicking one of its buttons, by its exact name (OK, Yes, Cancel, Open, Save...). Backing out (Cancel, No, Close) needs no approval; EVERYTHING else (OK, Yes, Open, Save, Replace, Delete, Allow...) asks the user first. The button is read again and checked just before the click; a name that does not match exactly, or matches twice, is not guessed. Secure prompts (administrator approval, sign-in, passwords) are refused.",
    schema: z.object({ button: z.string().trim().min(1).max(60), window: winArg, _hwnd: z.number().int().optional() }).strict() as never,
    sensitive: false,
    risk: (a) => (dialogRisk(String(a.button ?? "")) === "consequential" || classifyControlRisk(String(a.button ?? "")) === "consequential" ? "consequential" : "reversible"),
    describe: (a) => `Answer the dialog with “${short(String(a.button), 40)}”?`,
    working: (a) => `Answering with “${short(String(a.button), 30)}”…`,
    async run(a, ctx) { return answerDialog(a as { button: string; window?: string; _hwnd?: number }, ctx); },
    async confirm(_a, target, view) {
      if (!target || !view.popups) return { verified: null, evidence: [] };
      const list = await view.popups();
      if (!list) return { verified: null, evidence: [{ kind: "observation_failed", ok: null }] };
      const gone = !list.some((w) => w.hwnd === target.hwnd);
      return { verified: gone ? true : null, evidence: [{ kind: gone ? "popup_closed" : "popup_open", ok: true }] };
    },
  }));

  tools.push(mk({
    name: "choose_file", signature: "choose_file({path, window?})",
    description: "In an open file Open/Save dialog, type a file name or path into its “File name” field and check it was entered. It does NOT press Open or Save: do that with answer_dialog, which asks the user first (and a “replace this file?” question that may follow is a second dialog that also asks). The path is never logged or kept.",
    schema: z.object({ path: z.string().min(1).max(400), window: winArg, _hwnd: z.number().int().optional() }).strict() as never,
    sensitive: false, risk: () => "reversible",
    describe: () => "Enter a file name in the open dialog?",
    working: () => "Entering the file name…",
    async run(a, ctx) {
      const path = String(a.path);
      // a file NAME or path only: no control characters, and none of the characters Windows forbids in a name (the drive colon and slashes are fine)
      if (/[\u0000-\u001f]/.test(path) || /[<>"|?*]/.test(path.replace(/^[A-Za-z]:/, ""))) return failBefore("That is not a valid file name or path.", "invalid_request");
      const own = await ownerWindow(ctx, a.window as string | undefined, a._hwnd as number | undefined);
      if ("out" in own) return own.out;
      const found = await findDialogs(ctx, own.hwnd);
      if (!found) return failBefore("I could not list the pop-ups here (the observation helper is not available).", "unavailable");
      const files = found.dialogs.filter((d) => d.info.category === "file" && d.info.fileNameField);
      if (files.length === 0) return failBefore(found.dialogs.length ? "The open dialog is not a file Open/Save dialog, so I entered nothing." : found.refused ? "A secure prompt is open. I never read or answer those." : "No file dialog is open right now.", found.refused && !found.dialogs.length ? "blocked_by_policy" : "target_not_found");
      if (files.length > 1) return failBefore("More than one file dialog is open, so I will not guess which one.", "ambiguous");
      const d = files[0];
      // read again right before typing: the dialog must still be there, still a file dialog, and the field must still be the same one
      const again = await readPopupUi(ctx, d.win.hwnd);
      if (!ctx.live()) return fail("cancelled");
      if (!again) return failBefore("The dialog closed before I could use it.", "target_gone");
      const now = await listPopups(ctx, 0);
      if (now && now.some((w) => w.kind === "secure")) return failBefore("A secure prompt has appeared. I never answer those, so I entered nothing.", "blocked_by_policy");
      if (!now || !now.some((w) => w.hwnd === d.win.hwnd && isDialogKind(w.kind))) return failBefore("The dialog closed before I could use it.", "target_gone");
      const info = classifyDialog(d.win, again.items, { hadPasswordField: again.hadPasswordField });
      if (info.category !== "file" || !info.fileNameField || info.fileNameField.rid !== d.info.fileNameField!.rid) return failBefore("The dialog changed, so I entered nothing.", "target_moved");
      const field = info.fileNameField;
      const node = again.items.find((n) => n.rid === field.rid && !!n.rect);
      let readBack = "";
      const p = ctx.d.pointer?.();
      if (p && node?.rect) {
        // like a person: click INTO that field (checked under the pointer first), select what is there, type, and look at what the field now holds
        const fam = [...new Set([d.win.hwnd, d.win.owner, d.win.rootOwner, ...ctx.d.uiAgent.popups.family(d.win.hwnd)].filter((h) => h > 0))];
        const pt = centerOf(node.rect);
        const c = await p.click(pt.x, pt.y, { ms: 500, expectRoot: fam, verifyTarget: async (q) => { const e = await ctx.d.uiAgent.elementAt(q.x, q.y); if (!e.ok) return { ok: false, reason: "changed" }; if (e.chain.some((x) => x.password)) return { ok: false, reason: "password" }; return e.chain.some((x) => x.rid === field.rid || (x.type === "Edit" && /^file name/i.test(x.name.trim()))) ? { ok: true } : { ok: false, reason: "changed" }; } });
        if (!ctx.live()) return fail("cancelled");
        if (!c.ok) return c.reason === "user_moved" || c.reason === "stopped" ? fail(c.reason === "stopped" ? "You pressed Esc, so I stopped." : "You moved the mouse, so I stopped and left it to you.") : c.reason === "cancelled" ? fail("cancelled") : failBefore("The File name field was not under the pointer, so I typed nothing.", "target_moved");
        const k1 = await p.press("ctrl+a", { expectForeground: fam });
        const k2 = k1.ok ? await p.type(path, 25, { expectForeground: fam, expectWindow: d.win.hwnd }) : k1;
        if (!ctx.live()) return fail("cancelled");
        if (!k2.ok) return k2.reason === "user_moved" || k2.reason === "stopped" ? fail(k2.reason === "stopped" ? "You pressed Esc, so I stopped." : "You moved the mouse, so I stopped and left it to you.") : k2.reason === "cancelled" ? fail("cancelled") : fail(k2.reason === "focus_changed" ? "Another window took the keyboard, so I stopped. Part of the name may have been typed." : "The keyboard action did not go through.");
        const v = await ctx.d.uiAgent.fieldValue(d.win.hwnd, field.rid);
        readBack = v.ok ? v.value : "";
      } else {
        // Show Only: UI Automation's own way of setting the field
        const r = await ctx.d.actionAgent.typeText({ hwnd: d.win.hwnd, pid: d.win.pid, rid: field.rid, name: field.name }, path);
        if (!ctx.live()) return fail("cancelled");
        if (!r.ok) return fail(r.reason);
        readBack = r.readBack;
      }
      const same = ctx.d.verifier.typed(readBack, path).verified;
      return same
        ? ok("Entered the file name in the dialog, and read it back: it matches. Press Open or Save with answer_dialog (that asks the user first).", true)
        : ok("I entered the file name, but the field now shows something different, so I cannot confirm it.", false);
    },
  }));

  return tools;
}

// ------------------------------------------------------------------------------------------------ menu machinery

const POPUP_EVENTS = new Set(["show", "hide", "create", "destroy", "menu", "dialog", "fg"]);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sleepOf = (ctx: ToolCtx) => ctx.d.sleep ?? realSleep;
/** wait (bounded) for the popups to change: events end the wait early, a timer covers a missed event, the check always decides */
function waitPopups<T>(ctx: ToolCtx, check: () => Promise<T | false | null | undefined>, timeoutMs: number) {
  return waitFor(check, { timeoutMs, pollMs: 60, fallbackMs: 200, source: ctx.d.changes, relevant: (e) => POPUP_EVENTS.has(e.kind), sleep: sleepOf(ctx), live: () => ctx.live() });
}

interface OpenMenu { win: TransientWindow; items: MenuEntry[] }

/** every readable menu among the visible popups (optionally of one window): a popup with no readable menu items is not a menu */
export async function findMenus(ctx: ToolCtx, owner = 0): Promise<OpenMenu[] | null> {
  const list = await listPopups(ctx, owner);
  if (!list) return null;
  const out: OpenMenu[] = [];
  for (const w of list) {
    if (!isMenuKind(w.kind) || w.kind === "dropdown") continue;
    const m = await ctx.d.uiAgent.menu(w.hwnd);
    if (m.ok && looksLikeMenu(m.items)) out.push({ win: w, items: m.items });
  }
  // Some toolkits (WinUI/XAML) show ONE menu through more than one window, each exposing the same items: those are the same menu, not several (the biggest is kept)
  const sig = (m: OpenMenu) => `${m.win.rootOwner}|${m.items.map((i) => `${normLabel(i.name)}:${i.depth}`).join(",")}`;
  const area = (m: OpenMenu) => m.win.rect.w * m.win.rect.h;
  const best = new Map<string, OpenMenu>();
  for (const m of out) { const k = sig(m); const old = best.get(k); if (!old || area(m) > area(old)) best.set(k, m); }
  return out.filter((m) => best.get(sig(m)) === m);
}

/** the windows a click in this menu may legitimately land in: the popup, its owner, and the other popups of that owner (a submenu is its own window) */
async function familyOf(ctx: ToolCtx, hwnd: number): Promise<number[]> {
  const fam = new Set(ctx.d.uiAgent.popups.family(hwnd));
  const list = await listPopups(ctx, 0);
  for (const w of list ?? []) if (isMenuKind(w.kind) && (fam.has(w.owner) || fam.has(w.rootOwner) || fam.has(w.hwnd))) { fam.add(w.hwnd); if (w.owner) fam.add(w.owner); if (w.rootOwner) fam.add(w.rootOwner); }
  return [...fam].filter((h) => h > 0);
}

/** the last look before a click in a menu: what is at that exact point must still be that item (by id, or by name), and never a password field */
function menuItemCheck(ctx: ToolCtx, popup: number, item: MenuEntry) {
  return async (pt: { x: number; y: number }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const r = await ctx.d.uiAgent.elementAt(pt.x, pt.y);
    if (r.ok) {
      if (r.chain.some((c) => c.password)) return { ok: false, reason: "password" };
      const same = r.chain.some((c) => (!!item.rid && c.rid === item.rid) || (c.type === "MenuItem" && normLabel(c.name) === normLabel(item.name)));
      if (same) return { ok: true };
      // Some toolkits (WinForms) answer "the menu" for any point inside it, not the item: then the menu itself is read again and must show the SAME item at that point
      const innermost = r.chain[0]?.type ?? "";
      if (!/^(Menu|Pane|Window|Custom|Group)$/.test(innermost)) return { ok: false, reason: "changed" };
    }
    // the fast check is not available: read the menu again and see that the same item is still under that point
    const m = await ctx.d.uiAgent.menu(popup);
    if (!m.ok) return { ok: false, reason: "changed" };
    const again = m.items.find((i) => i.rid === item.rid || normLabel(i.name) === normLabel(item.name));
    const q = again?.rect;
    return again && again.enabled && q && pt.x >= q.l && pt.x <= q.l + q.w && pt.y >= q.t && pt.y <= q.t + q.h ? { ok: true } : { ok: false, reason: "changed" };
  };
}

const centerOf = (r: { l: number; t: number; w: number; h: number }) => ({ x: Math.round(r.l + r.w / 2), y: Math.round(r.t + r.h / 2) });

/** Press Esc, one level at a time, only while a menu is really open; stops at once if the user takes over. Never touches a dialog. */
export async function escLadder(ctx: ToolCtx, p: NonNullable<ReturnType<NonNullable<ToolCtx["d"]["pointer"]>>>, owner: number, maxPresses: number): Promise<"closed" | "open" | "stopped" | "cancelled"> {
  for (let i = 0; i < maxPresses; i++) {
    if (!ctx.live()) return "cancelled";
    const menus = await findMenus(ctx, owner);
    if (!menus || menus.length === 0) return "closed";
    const fam = menus.flatMap((m) => [m.win.hwnd, m.win.owner, m.win.rootOwner]).filter((h) => h > 0);
    const r = await p.press("esc", { expectForeground: [...new Set(fam)] });
    if (!r.ok) return r.reason === "user_moved" || r.reason === "stopped" ? "stopped" : r.reason === "cancelled" ? "cancelled" : "open";
    await waitPopups(ctx, async () => { const l = await findMenus(ctx, owner); return !!l && l.length < menus.length ? true : false; }, 500);
  }
  const left = await findMenus(ctx, owner);
  return !left || left.length === 0 ? "closed" : "open";
}

async function chooseMenuItem(a: { path: string[]; window?: string; via?: "auto" | "mouse" | "keys"; _hwnd?: number }, ctx: ToolCtx): Promise<ToolOutcome> {
  const p = ctx.d.pointer?.();
  const via = a.via ?? "auto";
  if (via === "keys" && !p) return failBefore("Choosing with the keyboard needs Human-like control (Settings → General): it uses the real keyboard, and that is off. Nothing was done.", "unavailable");
  let sent = false; // has any input been sent? (before that, a refusal is "nothing was sent": which is what makes it safe to try again)
  const refuse = (reason: string, kind: "target_not_found" | "target_gone" | "target_disabled" | "target_moved" | "ambiguous" | "unavailable" | "uia_failed" = "target_not_found"): ToolOutcome => (sent ? ({ ok: false, reason, failure: { kind } } as ToolOutcome) : failBefore(reason, kind));
  const own = await ownerWindow(ctx, a.window, a._hwnd && !(await listPopups(ctx, 0))?.some((w) => w.hwnd === a._hwnd) ? a._hwnd : undefined);
  if ("out" in own) return own.out;
  const menus = await findMenus(ctx, own.hwnd);
  if (!menus) return failBefore("I could not list the pop-ups here (the observation helper is not available).", "unavailable");
  if (!ctx.live()) return fail("cancelled");
  if (menus.length === 0) return failBefore("No menu is open right now. Open it first (right_click, or click_control on a menu button).", "target_not_found");

  // which open menu is meant: the one that has the first name of the path at its top level; if several do, it is not guessed
  const starts = menus.filter((m) => (a._hwnd ? m.win.hwnd === a._hwnd : true) && resolveStep(m.items, childrenOf(m.items, -1), a.path[0]).kind !== "none");
  if (starts.length === 0) return failBefore(`No open menu has an item called “${short(a.path[0], 40)}”.`, "target_not_found");
  if (starts.length > 1) return failBefore(`${starts.length} open menus have an item called “${short(a.path[0], 40)}”, so I will not guess which one.`, "ambiguous");

  if (via === "keys" && p) return chooseByKeys(a, ctx, p, own.hwnd, starts[0]);
  let cur = starts[0];
  let parent = -1;
  const known = new Set((await listPopups(ctx, 0))?.map((w) => w.hwnd) ?? []);
  for (let level = 0; level < a.path.length; level++) {
    if (!ctx.live()) return fail("cancelled");
    // READ AGAIN before every level: the menu may have changed, reordered, disabled something or gone
    const m = await ctx.d.uiAgent.menu(cur.win.hwnd);
    if (!m.ok || !looksLikeMenu(m.items)) {
      const gone = await listPopups(ctx, 0);
      return refuse(gone && !gone.some((w) => w.hwnd === cur.win.hwnd) ? "The menu closed before I could use it." : "I could not read the menu any more.", gone && !gone.some((w) => w.hwnd === cur.win.hwnd) ? "target_gone" : "uia_failed");
    }
    cur = { win: cur.win, items: m.items };
    const res = resolveStep(cur.items, childrenOf(cur.items, parent), a.path[level]);
    if (res.kind === "none") return refuse(`The menu has no item called “${short(a.path[level], 40)}” at this level (it may have changed).`, "target_not_found");
    if (res.kind === "ambiguous") return refuse(`Two items are called “${short(a.path[level], 40)}”, so I will not guess which one.`, "ambiguous");
    const item = res.item;
    if (!item.enabled) return refuse(`“${short(item.name, 40)}” is disabled in this menu.`, "target_disabled");
    if (!item.rect || item.offscreen) return refuse(`“${short(item.name, 40)}” is not visible on screen, so I cannot use it.`, "target_moved");
    const last = level === a.path.length - 1;
    const fam = await familyOf(ctx, cur.win.hwnd);
    const pt = centerOf(item.rect);
    // ---- act on exactly this item
    if (p) {
      const res2 = await p.click(pt.x, pt.y, { ms: 500, expectRoot: fam, verifyTarget: menuItemCheck(ctx, cur.win.hwnd, item) });
      sent = sent || (p.actedSince?.() ?? "no") !== "no" || res2.ok;
      if (!ctx.live()) return fail("cancelled");
      if (!res2.ok) {
        const why = res2.reason;
        if (why === "user_moved" || why === "stopped") return fail(why === "stopped" ? "You pressed Esc, so I stopped." : "You moved the mouse, so I stopped and left it to you.");
        if (why === "cancelled") return fail("cancelled");
        if (why === "changed" || why === "moved") return refuse(`“${short(item.name, 40)}” was not under the pointer any more, so I did not click. The menu may have changed.`, "target_moved");
        if (why === "gone") return refuse("The menu closed, so I stopped.", "target_gone");
        if (why === "covered") return refuse("Something else is in front of the menu, so I did not click.", "target_moved");
        if (why === "password") return fail("That is a password field, and I never touch those. Nothing was clicked.");
        return fail("The mouse action did not go through.");
      }
    } else {
      // Show Only: ask the menu item itself (UI Automation), by its runtime id, never by position
      const r = await ctx.d.actionAgent.clickControl({ hwnd: cur.win.hwnd, pid: cur.win.pid, rid: item.rid, name: item.name, unnamedOk: false });
      sent = true;
      if (!ctx.live()) return fail("cancelled");
      if (!r.ok) return fail(r.reason);
    }
    // ---- afterwards
    if (last) {
      const closed = await waitPopups(ctx, async () => { const l = await findMenus(ctx, own.hwnd); return !l || l.every((x) => x.win.hwnd !== cur.win.hwnd) ? true : false; }, 1200);
      if (closed.cancelled || !ctx.live()) return fail("cancelled");
      const out = closed.value
        ? ok(`Chose “${a.path.map((s) => short(s, 30)).join(" ▸ ")}”; the menu closed.${item.expandable ? " (It opens a submenu: nothing further was chosen.)" : ""}`, !item.expandable, { target: { hwnd: cur.win.hwnd, pid: cur.win.pid } })
        : ok(`Clicked “${short(item.name, 40)}”, but the menu is still open, so I cannot confirm it was chosen.`, false, { target: { hwnd: cur.win.hwnd, pid: cur.win.pid } });
      return out;
    }
    // not the last level: a submenu must have opened. It is either nested in the same popup, or a new popup of the same owner.
    const popupWas = cur.win.hwnd;
    const sub = await waitPopups(ctx, async () => {
      const again = await ctx.d.uiAgent.menu(popupWas);
      if (again.ok) {
        const kids = childrenOf(again.items, again.items.findIndex((i) => i.rid === item.rid)).filter((k) => !again.items[k].offscreen && again.items[k].rect);
        const idx = again.items.findIndex((i) => i.rid === item.rid);
        if (idx >= 0 && kids.length > 0) return { win: cur.win, items: again.items, parent: idx } as const;
      }
      const l = await findMenus(ctx, own.hwnd);
      const fresh = (l ?? []).filter((x) => !known.has(x.win.hwnd) && x.win.hwnd !== popupWas && fam.includes(x.win.owner || x.win.rootOwner || x.win.hwnd));
      if (fresh.length === 1) return { win: fresh[0].win, items: fresh[0].items, parent: -1 } as const;
      if (fresh.length > 1) return "ambiguous" as const;
      return false;
    }, 1200);
    if (sub.cancelled || !ctx.live()) return fail("cancelled");
    if (!sub.value) return fail(`“${short(item.name, 40)}” did not open a submenu, so I stopped.`);
    if (sub.value === "ambiguous") return fail("Two new menus opened, so I do not know which is the submenu. I stopped.");
    known.add(sub.value.win.hwnd);
    cur = { win: sub.value.win, items: sub.value.items };
    parent = sub.value.parent;
  }
  return fail("Nothing was chosen.");
}

// ------------------------------------------------------------------------------------------------ dialog machinery

interface OpenDialog { win: TransientWindow; info: DialogInfo; items: UiNode[] }

/** the readable dialogs among the visible popups; secure-desktop and credential prompts are only COUNTED, never read */
export async function findDialogs(ctx: ToolCtx, owner = 0): Promise<{ dialogs: OpenDialog[]; refused: number } | null> {
  const list = await listPopups(ctx, owner);
  if (!list) return null;
  const dialogs: OpenDialog[] = [];
  let refused = 0;
  for (const w of list) {
    if (!isDialogKind(w.kind)) continue;
    if (w.kind === "secure") { refused++; continue; } // not even read
    const ui = await readPopupUi(ctx, w.hwnd);
    if (!ui) continue;
    const info = classifyDialog(w, ui.items, { hadPasswordField: ui.hadPasswordField });
    if (isRefusedDialog(info.category)) { refused++; continue; }
    dialogs.push({ win: w, info, items: ui.items });
  }
  return { dialogs, refused };
}

const dialogMenuStyle = (ctx: ToolCtx, dlg: number, btn: { rid?: string; name: string }) => async (pt: { x: number; y: number }): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const r = await ctx.d.uiAgent.elementAt(pt.x, pt.y);
  if (r.ok) {
    if (r.chain.some((c) => c.password)) return { ok: false, reason: "password" };
    if (r.chain.some((c) => (!!btn.rid && c.rid === btn.rid) || (c.type === "Button" && normLabel(c.name) === normLabel(btn.name)))) return { ok: true };
    return { ok: false, reason: "changed" };
  }
  const ui = await readPopupUi(ctx, dlg);
  const again = ui?.items.find((n) => n.type === "Button" && (n.rid === btn.rid || normLabel(n.name) === normLabel(btn.name)));
  const q = again?.rect;
  return again && again.enabled && q && pt.x >= q.l && pt.x <= q.l + q.w && pt.y >= q.t && pt.y <= q.t + q.h ? { ok: true } : { ok: false, reason: "changed" };
};

async function answerDialog(a: { button: string; window?: string; _hwnd?: number }, ctx: ToolCtx): Promise<ToolOutcome> {
  const p = ctx.d.pointer?.();
  let sent = false;
  const refuse = (reason: string, kind: "target_not_found" | "target_gone" | "target_disabled" | "target_moved" | "ambiguous" | "blocked_by_policy" | "unavailable" = "target_not_found"): ToolOutcome => (sent ? ({ ok: false, reason, failure: { kind } } as ToolOutcome) : failBefore(reason, kind));
  const own = await ownerWindow(ctx, a.window, undefined);
  if ("out" in own) return own.out;
  const found = await findDialogs(ctx, own.hwnd);
  if (!found) return failBefore("I could not list the pop-ups here (the observation helper is not available).", "unavailable");
  if (!ctx.live()) return fail("cancelled");
  if (found.dialogs.length === 0) {
    return found.refused > 0
      ? failBefore("A secure prompt (administrator approval, sign-in or credentials) is open. I never answer those: please deal with it yourself.", "blocked_by_policy")
      : failBefore("No dialog is open right now.", "target_not_found");
  }
  let pick = a._hwnd ? found.dialogs.filter((d) => d.win.hwnd === a._hwnd) : found.dialogs.filter((d) => resolveButton(d.info.buttons, a.button).kind !== "none");
  if (pick.length === 0) return failBefore(`No open dialog has a button called “${short(a.button, 40)}”.`, "target_not_found");
  if (pick.length > 1) {
    return { ok: false, ambiguous: { noun: "dialogs", labels: pick.map((d, i) => `Dialog ${i + 1} (${d.info.category}, ${d.info.buttons.length} buttons)`), patches: pick.map((d) => ({ _hwnd: d.win.hwnd })) } };
  }
  const dlg = pick[0];
  const res = resolveButton(dlg.info.buttons, a.button);
  if (res.kind === "none") return refuse(`The dialog has no button called “${short(a.button, 40)}”.`, "target_not_found");
  if (res.kind === "ambiguous") return refuse(`Two buttons are called “${short(a.button, 40)}”, so I will not guess which one.`, "ambiguous");
  if (ctx.lock !== undefined && normLabel(ctx.lock) !== normLabel(res.button.name)) return refuse("The button changed since you approved, so I did not click.", "target_moved");
  if (!res.button.enabled) return refuse(`“${short(res.button.name, 40)}” is disabled.`, "target_disabled");

  // READ AGAIN right before acting: the dialog must still be there, still not secure, and the button must still be that button
  const ui = await readPopupUi(ctx, dlg.win.hwnd);
  if (!ctx.live()) return fail("cancelled");
  if (!ui) return refuse("The dialog closed before I could use it.", "target_gone");
  const info = classifyDialog(dlg.win, ui.items, { hadPasswordField: ui.hadPasswordField });
  if (isRefusedDialog(info.category)) return refuse("That dialog is now a secure prompt. I never answer those.", "blocked_by_policy");
  const again = resolveButton(info.buttons, a.button);
  if (again.kind !== "found" || !again.button.enabled) return refuse("The dialog changed, so I did not click anything.", "target_moved");
  // ... and the pop-ups once more: a secure prompt may have appeared on top, or the dialog may be gone, since that read
  const now = await listPopups(ctx, 0);
  if (!ctx.live()) return fail("cancelled");
  if (now && now.some((w) => w.kind === "secure")) return refuse("A secure prompt has appeared. I never answer those, so I did not click anything.", "blocked_by_policy");
  if (!now || !now.some((w) => w.hwnd === dlg.win.hwnd && isDialogKind(w.kind))) return refuse("The dialog closed before I could use it.", "target_gone");
  const node = ui.items.find((n) => n.type === "Button" && (n.rid === again.button.rid || normLabel(n.name) === normLabel(again.button.name)) && !!n.rect);
  if (!node?.rect || node.offscreen) return refuse("I cannot see that button on screen, so I did not click it.", "target_moved");
  const fam = [...new Set([dlg.win.hwnd, dlg.win.owner, dlg.win.rootOwner, ...ctx.d.uiAgent.popups.family(dlg.win.hwnd)].filter((h) => h > 0))];
  const pt = centerOf(node.rect);
  if (p) {
    const clickIt = () => p.click(pt.x, pt.y, { ms: 500, expectRoot: fam, verifyTarget: dialogMenuStyle(ctx, dlg.win.hwnd, again.button) });
    let r = await clickIt();
    if (!r.ok && r.reason === "covered" && ctx.live()) {
      // another window is over the dialog (the dialog was opened in the background): bring the DIALOG forward once (nothing has been sent to anything), then look again and try once
      await ctx.d.actionAgent.focusWindow({ hwnd: dlg.win.hwnd, pid: dlg.win.pid });
      const up = await waitPopups(ctx, async () => { const l = await listPopups(ctx, 0); return !!l && l.some((w) => w.hwnd === dlg.win.hwnd && w.fg) ? true : false; }, 1000);
      if (up.cancelled || !ctx.live()) return fail("cancelled");
      const ui3 = await readPopupUi(ctx, dlg.win.hwnd);
      const node3 = ui3?.items.find((n) => n.type === "Button" && (n.rid === again.button.rid || normLabel(n.name) === normLabel(again.button.name)) && !!n.rect);
      if (!node3?.rect) return refuse("The dialog changed, so I did not click anything.", "target_moved");
      const pt3 = centerOf(node3.rect);
      r = await p.click(pt3.x, pt3.y, { ms: 500, expectRoot: fam, verifyTarget: dialogMenuStyle(ctx, dlg.win.hwnd, again.button) });
    }
    sent = (p.actedSince?.() ?? "no") !== "no" || r.ok;
    if (!ctx.live()) return fail("cancelled");
    if (!r.ok) {
      const why = r.reason;
      if (why === "user_moved" || why === "stopped") return fail(why === "stopped" ? "You pressed Esc, so I stopped." : "You moved the mouse, so I stopped and left it to you.");
      if (why === "cancelled") return fail("cancelled");
      if (why === "changed" || why === "moved") return refuse(`“${short(again.button.name, 40)}” was not under the pointer any more, so I did not click.`, "target_moved");
      if (why === "gone") return refuse("The dialog closed, so I stopped.", "target_gone");
      if (why === "covered") return refuse("Something else is in front of the dialog, so I did not click.", "target_moved");
      if (why === "password") return fail("That is a password field, and I never touch those. Nothing was clicked.");
      return fail("The mouse action did not go through.");
    }
  } else {
    const r = await ctx.d.actionAgent.clickControl({ hwnd: dlg.win.hwnd, pid: dlg.win.pid, rid: again.button.rid ?? "", name: again.button.name, unnamedOk: false });
    sent = true;
    if (!ctx.live()) return fail("cancelled");
    if (!r.ok) return fail(r.reason);
  }
  const closed = await waitPopups(ctx, async () => { const l = await listPopups(ctx, 0); return !l || l.every((w) => w.hwnd !== dlg.win.hwnd) ? true : false; }, 1500);
  if (closed.cancelled || !ctx.live()) return fail("cancelled");
  const target = { hwnd: dlg.win.hwnd, pid: dlg.win.pid };
  return closed.value
    ? ok(`Answered the dialog with “${short(again.button.name, 40)}”; the dialog closed.`, true, { target })
    : ok(`Clicked “${short(again.button.name, 40)}”, but the dialog is still open (it may have asked something else), so I cannot confirm it was answered.`, false, { target });
}

// ------------------------------------------------------------------------------------------------ 5d: keyboard navigation

type Pointer = NonNullable<ReturnType<NonNullable<ToolCtx["d"]["pointer"]>>>;

/**
 * Choose a menu item with the KEYBOARD, the way a person does: Down/Up to the item, Right to open a submenu, Enter to take it.
 * Every single key is followed by a fresh read of the menu and a check that the focus is exactly where that key should have put it; any surprise
 * (focus somewhere else, more than one focused item, no focus visible, the menu gone, the keyboard not in the menu's window) stops everything, the
 * menu is closed with Esc, and Enter is never pressed unless the focus is on the very item that was asked for. Menus whose focus cannot be read
 * are refused, not guessed at.
 */
async function chooseByKeys(a: { path: string[] }, ctx: ToolCtx, p: Pointer, own: number, start: OpenMenu): Promise<ToolOutcome> {
  let sent = false;
  const stopMsg = (why: string) => (why === "stopped" ? "You pressed Esc, so I stopped." : "You moved the mouse, so I stopped and left it to you.");
  const refuse = (reason: string, kind: "target_not_found" | "target_gone" | "target_disabled" | "target_moved" | "ambiguous" | "unavailable" | "wrong_window" = "target_not_found"): ToolOutcome => (sent ? ({ ok: false, reason, failure: { kind } } as ToolOutcome) : failBefore(reason, kind));
  /** something unexpected after keys were sent: close the menu (unless the user took over) and say so */
  const abort = async (reason: string, kind: "target_moved" | "unavailable" | "target_gone" = "target_moved"): Promise<ToolOutcome> => {
    let interrupted = false; try { interrupted = !!p.interrupted?.(); } catch { interrupted = false; }
    if (ctx.live() && !interrupted) await escLadder(ctx, p, own, 4);
    return refuse(reason, kind);
  };
  const press = async (key: string, fam: number[]): Promise<"ok" | ToolOutcome> => {
    const r = await p.press(key, { expectForeground: fam });
    if (r.ok) { sent = true; return "ok"; }
    if (r.reason === "user_moved" || r.reason === "stopped") return fail(stopMsg(r.reason));
    if (r.reason === "cancelled") return fail("cancelled");
    if (r.reason === "focus_changed") return refuse("The menu's window does not have the keyboard, so I pressed no key.", "wrong_window");
    return fail("The keyboard action did not go through.");
  };
  let cur = start;
  let parent = -1;
  const known = new Set((await listPopups(ctx, 0))?.map((w) => w.hwnd) ?? []);
  for (let level = 0; level < a.path.length; level++) {
    if (!ctx.live()) return fail("cancelled");
    let m = await ctx.d.uiAgent.menu(cur.win.hwnd);
    if (!m.ok || !looksLikeMenu(m.items)) return refuse("The menu closed before I could use it.", "target_gone");
    let items = m.items;
    const res = resolveStep(items, childrenOf(items, parent), a.path[level]);
    if (res.kind === "none") return refuse(`The menu has no item called “${short(a.path[level], 40)}” at this level (it may have changed).`, "target_not_found");
    if (res.kind === "ambiguous") return refuse(`Two items are called “${short(a.path[level], 40)}”, so I will not guess which one.`, "ambiguous");
    if (!res.item.enabled) return refuse(`“${short(res.item.name, 40)}” is disabled in this menu.`, "target_disabled");
    const targetRid = res.item.rid;
    const fam = await familyOf(ctx, cur.win.hwnd);
    // ---- move the focus onto the item, one verified key at a time
    for (let guard = 0; guard <= 2 * items.length + 2; guard++) {
      if (!ctx.live()) return fail("cancelled");
      const nav = navigable(items, parent);
      const tIdx = items.findIndex((i) => i.rid === targetRid);
      const tPos = nav.indexOf(tIdx);
      if (tPos < 0) return abort("The item I was heading for is not available any more, so I stopped.");
      const f = focusedIndex(items);
      if (f === -2) return abort("More than one item looks focused, so I cannot trust where I am. I stopped.", "unavailable");
      if (f === tIdx) break; // the focus is on the item
      let key: "down" | "up"; let expect: number;
      if (f < 0 || nav.indexOf(f) < 0) { key = "down"; expect = nav[0]; }
      else { const pos = nav.indexOf(f); const down = (tPos - pos + nav.length) % nav.length; if (down <= nav.length - down) { key = "down"; expect = nav[(pos + 1) % nav.length]; } else { key = "up"; expect = nav[(pos - 1 + nav.length) % nav.length]; } }
      const pr = await press(key, fam);
      if (pr !== "ok") return pr;
      // the focus takes a moment to move: look until it HAS moved (or the menu is gone), for at most half a second, then judge what is there
      const before = f;
      let latest = await ctx.d.uiAgent.menu(cur.win.hwnd);
      await waitPopups(ctx, async () => {
        latest = await ctx.d.uiAgent.menu(cur.win.hwnd);
        return !latest.ok || !looksLikeMenu(latest.items) || focusedIndex(latest.items) !== before ? true : false;
      }, 500);
      m = latest;
      if (!ctx.live()) return fail("cancelled");
      if (!m.ok || !looksLikeMenu(m.items)) return abort("The menu closed unexpectedly, so I stopped.", "target_gone");
      items = m.items;
      const nf = focusedIndex(items);
      if (nf === -1) return abort("I cannot see which item has the focus in this menu, so I will not navigate it with the keyboard.", "unavailable");
      if (nf === -2) return abort("More than one item looks focused, so I cannot trust where I am. I stopped.", "unavailable");
      // after the key, the focus must be exactly where it should be (compared by identity, because the items may have been re-read)
      if (nf !== expect && !(items[nf] && items[expect] && items[nf].rid === items[expect].rid)) return abort("The focus moved somewhere I did not expect, so I stopped (nothing was chosen).");
      if (guard === 2 * items.length + 2) return abort("I could not reach the item with the keyboard, so I stopped.");
    }
    // the last check before the key that matters: the focus must be on EXACTLY the item that was asked for
    const mm = await ctx.d.uiAgent.menu(cur.win.hwnd);
    if (!ctx.live()) return fail("cancelled");
    if (!mm.ok || !looksLikeMenu(mm.items)) return abort("The menu closed unexpectedly, so I stopped.", "target_gone");
    const fi = focusedIndex(mm.items);
    if (fi < 0 || mm.items[fi].rid !== targetRid) return abort("The focus is not on the item I wanted, so I did not press Enter.");
    const last = level === a.path.length - 1;
    const pr2 = await press(last ? "enter" : "right", fam);
    if (pr2 !== "ok") return pr2;
    if (last) {
      const closed = await waitPopups(ctx, async () => { const l = await findMenus(ctx, own); return !l || l.every((x) => x.win.hwnd !== cur.win.hwnd) ? true : false; }, 1200);
      if (closed.cancelled || !ctx.live()) return fail("cancelled");
      const expandable = mm.items[fi].expandable;
      return closed.value
        ? ok(`Chose “${a.path.map((s) => short(s, 30)).join(" ▸ ")}” with the keyboard; the menu closed.${expandable ? " (It opens a submenu: nothing further was chosen.)" : ""}`, !expandable, { target: { hwnd: cur.win.hwnd, pid: cur.win.pid } })
        : ok(`Pressed Enter on “${short(a.path[level], 40)}”, but the menu is still open, so I cannot confirm it was chosen.`, false, { target: { hwnd: cur.win.hwnd, pid: cur.win.pid } });
    }
    const popupWas = cur.win.hwnd;
    const itemRid = targetRid;
    const sub = await waitPopups(ctx, async () => {
      const again = await ctx.d.uiAgent.menu(popupWas);
      if (again.ok) {
        const idx = again.items.findIndex((i) => i.rid === itemRid);
        const kids = idx >= 0 ? childrenOf(again.items, idx).filter((k) => !again.items[k].offscreen && again.items[k].rect) : [];
        if (kids.length > 0) return { win: cur.win, items: again.items, parent: idx } as const;
      }
      const l = await findMenus(ctx, own);
      const fresh = (l ?? []).filter((x) => !known.has(x.win.hwnd) && x.win.hwnd !== popupWas && fam.includes(x.win.owner || x.win.rootOwner || x.win.hwnd));
      if (fresh.length === 1) return { win: fresh[0].win, items: fresh[0].items, parent: -1 } as const;
      if (fresh.length > 1) return "ambiguous" as const;
      return false;
    }, 1200);
    if (sub.cancelled || !ctx.live()) return fail("cancelled");
    if (!sub.value) return abort(`“${short(a.path[level], 40)}” did not open a submenu, so I stopped.`);
    if (sub.value === "ambiguous") return abort("Two new menus opened, so I do not know which is the submenu. I stopped.");
    known.add(sub.value.win.hwnd);
    cur = { win: sub.value.win, items: sub.value.items };
    parent = sub.value.parent;
  }
  return fail("Nothing was chosen.");
}

export type { MenuEntry };
export { describeMenu };
