import type { MenuEntry, TransientWindow, UiNode } from "../shared/ports";

/**
 * Understanding menus and dialogs (phase 5). Pure functions: no I/O, no state, no text kept. The tools in orchestrator/popupTools.ts do the
 * looking and the acting; every decision about WHICH item or button is made here, by exact label, and an unclear case is returned as
 * "ambiguous" or "none", never guessed.
 */

/** the label as a person would compare it: no accelerator marker (&), no shortcut text after a tab, no ellipsis, case and spacing ignored */
export function normLabel(s: string): string {
  return String(s ?? "")
    .replace(/\t.*$/s, "")
    .replace(/&(?=[^\s&])/g, "")
    .replace(/…|\.{3}/g, "")
    .replace(/[‎‏‪-‮]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------- menus

/** the indexes of the items directly under item `parent` (-1 = the top of this popup), separators left out */
export function childrenOf(items: readonly MenuEntry[], parent: number): number[] {
  const out: number[] = [];
  items.forEach((it, i) => { if (it.parent === parent && !it.separator) out.push(i); });
  return out;
}

export type StepResolution =
  | { kind: "found"; index: number; item: MenuEntry }
  | { kind: "none"; available: number }
  | { kind: "ambiguous"; indexes: number[] };

/** Find the item called `label` among the given candidates (indexes into `items`). Exact match on the normalised label only. */
export function resolveStep(items: readonly MenuEntry[], candidates: readonly number[], label: string): StepResolution {
  const want = normLabel(label);
  if (!want) return { kind: "none", available: candidates.length };
  const hits = candidates.filter((i) => normLabel(items[i].name) === want);
  if (hits.length === 1) return { kind: "found", index: hits[0], item: items[hits[0]] };
  if (hits.length > 1) {
    // identical duplicates that cannot be told apart are ambiguous; if exactly one of them is enabled and on screen it is not (a disabled twin is not a choice)
    const live = hits.filter((i) => items[i].enabled && !items[i].offscreen);
    if (live.length === 1) return { kind: "found", index: live[0], item: items[live[0]] };
    return { kind: "ambiguous", indexes: hits };
  }
  return { kind: "none", available: candidates.length };
}

/** a menu has at least one real item; an empty read is not a menu */
export const looksLikeMenu = (items: readonly MenuEntry[]): boolean => items.some((i) => !i.separator && i.name.trim().length > 0);

/** The menu as indented lines for the planner: "Open", "More ▸", "  Sub one", with state. (Screen text: only shown where reads are allowed.) */
export function describeMenu(items: readonly MenuEntry[], max = 40): string[] {
  const lines: string[] = [];
  for (const it of items) {
    if (lines.length >= max) { lines.push("…"); break; }
    if (it.separator) continue;
    const flags = [it.expandable ? "▸" : "", !it.enabled ? "(disabled)" : "", it.checked === "on" ? "(checked)" : "", it.shortcut ? `[${it.shortcut}]` : ""].filter(Boolean).join(" ");
    lines.push(`${"  ".repeat(Math.min(it.depth, 3))}${it.name.trim()}${flags ? " " + flags : ""}`);
  }
  return lines;
}

/** the enabled, visible, non-separator items of one level, in order (the ones the arrow keys move between) */
export function navigable(items: readonly MenuEntry[], parent: number): number[] {
  return childrenOf(items, parent).filter((i) => items[i].enabled && !items[i].offscreen);
}

/** which item has the keyboard focus right now (-1 = none, -2 = more than one: the focus cannot be trusted) */
export function focusedIndex(items: readonly MenuEntry[]): number {
  const f = items.map((it, i) => (it.focused ? i : -1)).filter((i) => i >= 0);
  return f.length === 0 ? -1 : f.length === 1 ? f[0] : -2;
}

// ---------------------------------------------------------------- dialogs

export type DialogCategory = "file" | "message" | "permission" | "credential" | "secure" | "other";

/** words that mean the dialog asks for a permission, or for access */
const PERMISSION = /\b(allow|permission|access to|grant|let this app|make changes to your device|run as administrator|administrator)\b/i;
const CREDENTIAL = /\b(password|passcode|credentials?|sign in|sign-in|log ?in|pin|security key|username)\b/i;

export interface DialogButton { name: string; risk: "reversible" | "consequential"; rid?: string; enabled: boolean }
export interface DialogInfo {
  category: DialogCategory;
  buttons: DialogButton[];
  /** how many text lines the dialog shows (the text itself is read only when the user allows it) */
  textLines: number;
  hasPassword: boolean;
  /** the "File name" field of a file dialog (never its value) */
  fileNameField?: { rid: string; name: string };
}

/** buttons that only back out: they never change anything, so they do not need approval. EVERYTHING else (OK, Yes, Open, Save, Replace, Allow, Delete, unknown...) does. */
const BENIGN_BUTTON = /^(cancel|close|no|back|help|not now|later|dismiss|skip|no thanks)$/;
export function dialogButtonRisk(label: string): "reversible" | "consequential" {
  const n = normLabel(label);
  if (BENIGN_BUTTON.test(n)) return "reversible";
  return "consequential"; // unknown buttons are asked about; classifyControlRisk can only make it stricter, never weaker
}
export const dialogRisk = dialogButtonRisk; // (the orchestrator may make it stricter with the general label rules, never weaker)

/**
 * What kind of dialog this is, from facts: the window's kind and process, and what UI Automation shows in it.
 * Secure-desktop prompts (UAC, credential, sign-in) are recognised so that they can be REFUSED: Momo never reads or answers them.
 */
export function classifyDialog(win: Pick<TransientWindow, "kind" | "proc" | "cls">, items: readonly UiNode[], seen: { hadPasswordField?: boolean } = {}): DialogInfo {
  const proc = win.proc.toLowerCase();
  // (the reader drops password fields from what it returns, but says that there was one: that fact counts)
  const hasPassword = items.some((n) => n.password) || !!seen.hadPasswordField;
  const buttons: DialogButton[] = items
    // the title bar's own Minimize / Maximize / Restore / Close buttons are the window's, not the dialog's answers
    .filter((n) => n.type === "Button" && n.name.trim() && !/^(minimi[sz]e|maximi[sz]e|restore|close)$/i.test(n.name.trim()))
    .map((n) => ({ name: n.name.trim(), risk: dialogRisk(n.name), rid: n.rid, enabled: n.enabled }));
  const texts = items.filter((n) => n.type === "Text" && n.name.trim());
  // a file dialog has a drop-down AND the edit box inside it, both called "File name:": the edit box is the one to type into
  const fileField = items.find((n) => n.type === "Edit" && /^file name/i.test(n.name.trim()) && !n.password) ?? items.find((n) => n.type === "ComboBox" && /^file name/i.test(n.name.trim()) && !n.password);
  const joined = texts.map((t) => t.name).join(" ");
  let category: DialogCategory = "other";
  if (win.kind === "secure" || ["consent", "credentialuibroker", "logonui", "winlogon"].includes(proc) || /credential/i.test(win.cls)) category = "secure";
  else if (hasPassword || (CREDENTIAL.test(joined) && items.some((n) => n.type === "Edit"))) category = "credential";
  else if (fileField && buttons.some((b) => /^(open|save|select|choose|ok)$/i.test(normLabel(b.name)))) category = "file";
  else if (PERMISSION.test(joined)) category = "permission";
  else if (buttons.length > 0) category = "message";
  // a file dialog has dozens of toolbar buttons (views, sliders, new folder...): only its COMMAND buttons are answers
  const FILE_COMMANDS = /^(open|save|save as|cancel|help|ok|select folder|choose|select)$/;
  const answers = category === "file" ? buttons.filter((b) => FILE_COMMANDS.test(normLabel(b.name))) : buttons;
  return { category, buttons: answers, textLines: texts.length, hasPassword, ...(fileField && fileField.rid ? { fileNameField: { rid: fileField.rid, name: fileField.name } } : {}) };
}

/** categories Momo never reads or answers */
export const isRefusedDialog = (c: DialogCategory): boolean => c === "secure" || c === "credential";

/** pick a dialog button by exact label: found / none / ambiguous, like menu items */
export function resolveButton(buttons: readonly DialogButton[], label: string): { kind: "found"; button: DialogButton } | { kind: "none" } | { kind: "ambiguous"; buttons: DialogButton[] } {
  const want = normLabel(label);
  const hits = buttons.filter((b) => normLabel(b.name) === want && want.length > 0);
  if (hits.length === 1) return { kind: "found", button: hits[0] };
  if (hits.length > 1) { const live = hits.filter((b) => b.enabled); return live.length === 1 ? { kind: "found", button: live[0] } : { kind: "ambiguous", buttons: hits }; }
  return { kind: "none" };
}

// ---------------------------------------------------------------- which popup is the menu / the dialog

export const isMenuKind = (k: TransientWindow["kind"]): boolean => k === "menu" || k === "popup" || k === "dropdown";
export const isDialogKind = (k: TransientWindow["kind"]): boolean => k === "dialog" || k === "secure";
