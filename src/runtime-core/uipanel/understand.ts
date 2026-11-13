import type { UiNode } from "../shared/ports";
import { cleanScreenText, describePlace, placeOf } from "../shared/screenText";

/**
 * Understanding a control: not "there is a box called X" but "what is it FOR, and what happens if I use it".
 *
 * Evidence is used in this order, and every conclusion says where it came from and how sure it is:
 *   1. metadata the application itself gives (UI Automation: patterns, AutomationId, class, help text, the label it tied to a field),
 *   2. its label,
 *   3. its surroundings (the text next to it, the panel it sits in, the program and window it belongs to),
 *   4. what a picture of it shows (OCR of its box, or a visual AI that the user allowed): never enough ON ITS OWN to act without asking.
 * If none of that settles it, the answer is "I don't know" (uncertain), never a guess: the caller gathers more evidence or asks the user.
 *
 * Everything read from the screen is untrusted DATA: it is only ever matched against fixed vocabularies here, never obeyed.
 */

export type Kind =
  | "table_cell" | "search_box" | "address_box" | "text_input" | "password_input" | "dropdown" | "menu_button" | "menu_item" | "toggle" | "tab" | "link"
  | "list_item" | "slider" | "button" | "unknown";
export type Effect = "runs_search" | "navigates" | "opens_menu" | "toggles" | "selects" | "opens_item" | "types_text" | "activates" | "closes" | "unknown";
export type Basis = "metadata" | "label" | "context" | "ocr" | "vision" | "none";

export interface Understanding {
  kind: Kind;
  /** what it is for, in one plain phrase; null = not established */
  purpose: string | null;
  /** search / address boxes: WHAT it searches or addresses; null = not stated by anything */
  scope: string | null;
  /** what using it does */
  effect: Effect;
  /** 0..1 */
  confidence: number;
  /** where the evidence came from, strongest first */
  basis: Basis[];
  evidence: string[];
  /** Momo does not know what this is for: gather more evidence or ask */
  uncertain: boolean;
  /** the next way to learn more: look at its picture (ocr / vision) or ask the user */
  needs: "ocr" | "vision" | "ask" | null;
  /** where it is in the window, in words */
  place: string;
}

export interface UnderstandCtx {
  /** the program the window belongs to (explorer, chrome, notepad...) */
  process: string;
  /** the window's title */
  title: string;
  /** every control read from the window (context for the one being understood) */
  items: UiNode[];
}

/** Below this, Momo does not act on what it believes without asking. */
export const SURE = 0.75;
/** Below this, it is "I don't know". */
export const KNOWN = 0.55;

const lc = (s: string) => s.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
const words = (s: string): string => cleanScreenText(s).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const has = (hay: string, re: RegExp) => re.test(hay);

// ---------------------------------------------------------------- vocabularies (fixed; screen text is only ever compared with these)
const SEARCH = /\b(search|find|filter|query|look ?up|buscar|rechercher|suchen|suche|ricerca|खोज|खोजें|搜索|検索)\b/;
const ADDRESS = /\b(address|url|location|omnibox|web address|adresse|dirección|direccion)\b/;
const SEARCH_OR_TYPE = /\b(search or (type|enter)|type a web address|search google or type)\b/;
const GENERIC_NAME = /^(button|item|icon|image|text|edit|field|control|pane|group|custom|list|toolbar|none|untitled)$/;

interface Verb { re: RegExp; purpose: string; effect: Effect; /** only when this is the whole label ("View", "More"), because inside a longer label it means something else */ whole?: boolean }
/** What a button's own wording says it does. Only well-established UI words: anything else is NOT given a made-up meaning. */
const VERBS: Verb[] = [
  { re: /\b(back|previous|go back)\b/, purpose: "goes back to the previous place", effect: "navigates" },
  { re: /\b(forward|next)\b/, purpose: "goes forward / to the next one", effect: "navigates" },
  { re: /\b(up to|go up|parent folder)\b/, purpose: "goes up one level", effect: "navigates" },
  { re: /\b(refresh|reload)\b/, purpose: "reloads what is shown", effect: "activates" },
  { re: /\b(home)\b/, purpose: "goes to the home page", effect: "navigates", whole: true },
  { re: /\b(close|exit|dismiss)\b/, purpose: "closes this", effect: "closes" },
  { re: /\b(cancel)\b/, purpose: "cancels and closes without applying", effect: "closes" },
  { re: /\b(ok|okay|apply|confirm|done|accept)\b/, purpose: "confirms and applies the choices made here", effect: "activates" },
  { re: /\b(save)\b/, purpose: "saves your work", effect: "activates" },
  { re: /\b(delete|remove|erase|trash|discard)\b/, purpose: "removes something (may not be undoable)", effect: "activates" },
  { re: /\b(send|post|publish|submit|pay|buy|purchase|order)\b/, purpose: "sends or submits something (may not be undoable)", effect: "activates" },
  { re: /\b(new|add|create|plus)\b/, purpose: "creates or adds something new", effect: "activates" },
  { re: /\b(open|browse)\b/, purpose: "opens something", effect: "activates" },
  { re: /\b(copy)\b/, purpose: "copies the selection", effect: "activates" },
  { re: /\b(cut)\b/, purpose: "cuts the selection", effect: "activates" },
  { re: /\b(paste)\b/, purpose: "pastes what was copied", effect: "activates" },
  { re: /\b(rename)\b/, purpose: "renames the selected item", effect: "activates" },
  { re: /\b(share)\b/, purpose: "shares the selected item", effect: "activates" },
  { re: /\b(undo)\b/, purpose: "undoes the last change", effect: "activates" },
  { re: /\b(redo)\b/, purpose: "redoes the change that was undone", effect: "activates" },
  { re: /\b(print)\b/, purpose: "prints", effect: "activates" },
  { re: /\b(download)\b/, purpose: "downloads", effect: "activates" },
  { re: /\b(upload)\b/, purpose: "uploads", effect: "activates" },
  { re: /\b(sort|group)\b/, purpose: "changes how the items are ordered or grouped", effect: "opens_menu", whole: true },
  { re: /\b(view|layout)\b/, purpose: "changes how the items are displayed", effect: "opens_menu", whole: true },
  { re: /\b(settings|options|preferences)\b/, purpose: "opens settings or options", effect: "activates" },
  { re: /\b(more|menu|overflow)\b/, purpose: "opens a menu with more actions", effect: "opens_menu", whole: true },
  { re: /\b(help|support)\b/, purpose: "opens help", effect: "activates" },
  { re: /\b(minimi[sz]e)\b/, purpose: "minimizes the window", effect: "activates" },
  { re: /\b(maximi[sz]e|restore)\b/, purpose: "maximizes or restores the window", effect: "activates" },
  { re: /\b(play|pause|stop|record)\b/, purpose: "controls playback or recording", effect: "activates" },
  { re: /\b(go|enter|run|start)\b/, purpose: "starts or runs the action next to it", effect: "activates", whole: true },
];

/** AutomationId / class words that say what a control is, when its label does not. */
const ID_HINTS: { re: RegExp; kind: Kind; purpose: string; effect: Effect }[] = [
  { re: /\b(search ?box|search ?bar|search ?edit|search ?field|query)\b/, kind: "search_box", purpose: "a search box", effect: "runs_search" },
  { re: /\b(address ?bar|omnibox|url ?bar|location ?bar)\b/, kind: "address_box", purpose: "the address box", effect: "navigates" },
  { re: /\b(close ?button|btn ?close)\b/, kind: "button", purpose: "closes this", effect: "closes" },
  { re: /\b(back ?button|btn ?back)\b/, kind: "button", purpose: "goes back to the previous place", effect: "navigates" },
  { re: /\b(settings ?button|options ?button)\b/, kind: "button", purpose: "opens settings or options", effect: "activates" },
  { re: /\b(menu ?button|hamburger)\b/, kind: "menu_button", purpose: "opens a menu", effect: "opens_menu" },
];

interface Cand { kind: Kind; purpose: string; scope?: string | null; effect: Effect; conf: number; basis: Basis; evidence: string }

/** The verb a label starts with ("Back", "Add new tab", "Up to ..."), never a verb that merely appears somewhere inside it. */
function leadVerb(labelWords: string, helpWords: string): Verb | undefined {
  const test = (w: string, v: Verb): boolean => {
    if (!w) return false;
    if (v.whole) return new RegExp("^(?:" + v.re.source.replace(/^\\b\(/, "(").replace(/\)\\b$/, ")") + ")(?: (?:button|menu|options|actions))?$").test(w);
    const head = w.split(" ").slice(0, 2).join(" ");
    return v.re.test(head);
  };
  return VERBS.find((v) => test(labelWords, v)) ?? VERBS.find((v) => test(helpWords, v) && (!labelWords || test(labelWords, v)));
}

const kindFromType = (n: UiNode): Kind => {
  const pt = new Set(n.patterns ?? []);
  switch (n.type) {
    case "Edit": return "text_input";
    case "ComboBox": return "dropdown";
    case "CheckBox": case "RadioButton": return "toggle";
    case "TabItem": return "tab";
    case "Hyperlink": return "link";
    case "MenuItem": return "menu_item";
    case "ListItem": case "TreeItem": case "DataItem": return "list_item";
    case "Slider": return "slider";
    case "Button": case "SplitButton": return pt.has("expandcollapse") ? "menu_button" : "button";
    default: return "unknown";
  }
};

/** The text just left of / above a field: the label a person would read as its caption. */
export function neighbourLabel(node: UiNode, items: UiNode[]): string | null {
  const r = node.rect;
  if (!r) return null;
  const cy = r.t + r.h / 2;
  let best: { n: UiNode; d: number } | null = null;
  for (const n of items) {
    if (n === node || n.type !== "Text" || !n.rect || !cleanScreenText(n.name) || n.offscreen) continue;
    const t = n.rect;
    const tcy = t.t + t.h / 2;
    const sameRow = Math.abs(tcy - cy) <= Math.max(r.h, t.h) * 0.6 && t.l + t.w <= r.l + 6 && r.l - (t.l + t.w) <= 260;
    const above = t.t + t.h <= r.t + 4 && r.t - (t.t + t.h) <= 44 && t.l < r.l + r.w && t.l + t.w > r.l - 20;
    if (!sameRow && !above) continue;
    const d = sameRow ? r.l - (t.l + t.w) : (r.t - (t.t + t.h)) * 2 + 100;
    if (!best || d < best.d) best = { n, d };
  }
  return best ? cleanScreenText(best.n.name) : null;
}

/** "Search Project 2" -> "Project 2"; "Search for apps, settings" -> "apps, settings"; "Search in Documents" -> "Documents". */
export function searchRemainder(label: string): string | null {
  const t = cleanScreenText(label).trim();
  const m = t.match(/^(?:search|find|filter|look ?up|buscar|rechercher|suchen)\b\s*(?:for|in|within|inside|on|through)?\s*(.*)$/i);
  const rest = (m?.[1] ?? "").replace(/[….:]+$/, "").trim();
  return rest && !/^(search|find|filter|box|bar|field|text)$/i.test(rest) ? rest : null;
}

const isExplorer = (p: string) => /^explorer$/i.test(p);
const isBrowser = (p: string) => /^(chrome|msedge|firefox|brave|opera|vivaldi|iexplore)$/i.test(p);
const folderOf = (title: string): string | null => {
  const t = cleanScreenText(title).replace(/\s+-\s+File Explorer$/i, "").trim();
  return t && !/file explorer/i.test(t) ? t : null;
};

/** What a search box searches, from the strongest evidence available. Never invented: null when nothing states it. */
function searchScope(node: UiNode, ctx: UnderstandCtx, ids: string): { scope: string | null; basis: Basis; evidence: string } | null {
  const label = node.name || node.labelledBy || node.help || "";
  const rest = searchRemainder(label);
  const exp = isExplorer(ctx.process);
  if (rest) {
    // "Search Project 2" in File Explorer is the box that searches INSIDE that folder (the app names the place it searches)
    if (exp) return { scope: `files and folders inside “${rest}”`, basis: "label", evidence: `its label names where it searches: “${cleanScreenText(label)}”` };
    return { scope: `“${rest}”`, basis: "label", evidence: `its label says what it searches: “${cleanScreenText(label)}”` };
  }
  if (SEARCH_OR_TYPE.test(words(label)) || /omnibox/.test(ids) || (ADDRESS.test(words(label)) && SEARCH.test(words(label)))) {
    return { scope: "the web (a search engine), and it also accepts a web address", basis: "metadata", evidence: "an address-and-search box (it takes both a search and an address)" };
  }
  const panel = node.panel && cleanScreenText(node.panel);
  if (panel && !/^(window|pane|toolbar|document|custom)$/i.test(panel) && panel.length > 2 && words(panel) !== words(ctx.title)) {
    return { scope: `what is inside “${panel}”`, basis: "context", evidence: `it sits inside the “${panel}” section` };
  }
  if (exp) {
    const f = folderOf(ctx.title);
    if (f && SEARCH.test(words(label) || ids)) return { scope: `files and folders in the current folder “${f}”`, basis: "context", evidence: `it is File Explorer's search box, and the window is “${cleanScreenText(ctx.title)}”` };
  }
  if (/^notepad$/i.test(ctx.process) && /\b(find|search)\b/.test(words(label))) return { scope: "text inside this document", basis: "context", evidence: "it is the Find box of a text editor" };
  return null;
}

/**
 * Work out what one control is for. Pure: the same inputs always give the same answer, and it never touches the screen.
 */
export function understand(node: UiNode, ctx: UnderstandCtx): Understanding {
  const place = describePlace(node, ctx.items) || placeOf(node, ctx.items);
  const base = (over: Partial<Understanding>): Understanding => ({
    kind: kindFromType(node), purpose: null, scope: null, effect: "unknown", confidence: 0, basis: ["none"], evidence: [], uncertain: true, needs: "ask", place, ...over,
  });

  if (node.password) {
    return base({ kind: "password_input", purpose: "a password field (Momo never reads, types into or presses Enter in it)", effect: "types_text", confidence: 1, basis: ["metadata"], evidence: ["the application marks it as a password field"], uncertain: false, needs: null });
  }

  const label = cleanScreenText(node.name);
  const labelWords = words(label);
  const hasLabel = labelWords.length > 0 && !GENERIC_NAME.test(labelWords) && lc(label) !== lc(node.className ?? "§");
  const idWords = words(`${node.autoId ?? ""} ${node.className ?? ""}`);
  const helpWords = words(node.help ?? "");
  const lbWords = words(node.labelledBy ?? "");
  const pts = new Set(node.patterns ?? []);
  const kind0 = kindFromType(node);
  const cands: Cand[] = [];
  const add = (c: Cand) => cands.push(c);

  // ---- 1. metadata the application gives (strongest)
  if (node.type === "Edit" && (pts.has("griditem") || pts.has("tableitem") || /\buiproperty\b/.test(idWords))) {
    const col = label || cleanScreenText(node.autoId ?? "").replace(/^System\./, "");
    add({ kind: "table_cell", purpose: `a ${node.readOnly ? "read-only " : ""}cell of a table or list: the “${col || "value"}” of one row`, effect: "unknown", conf: 0.93, basis: "metadata", evidence: "it is a grid/table cell (Grid/Table Item pattern), not a free text box" });
  }
  if (node.type === "RadioButton") {
    add({ kind: "toggle", purpose: `chooses “${label || "this option"}” (one option of a group${node.state ? `; now ${node.state}` : ""})`, effect: "selects", conf: label ? 0.92 : 0.7, basis: "metadata", evidence: "it is a radio button (pick one of a group)" });
  } else if (pts.has("toggle") || node.type === "CheckBox") {
    const st = node.state ? ` (now ${node.state})` : "";
    add({ kind: "toggle", purpose: `switches “${label || "this option"}” on or off${st}`, effect: "toggles", conf: label ? 0.92 : 0.7, basis: "metadata", evidence: "it supports the Toggle pattern (an on/off control)" });
  }
  const splitPlusMenu = node.type === "SplitButton" && pts.has("expandcollapse");
  if (pts.has("expandcollapse") && !splitPlusMenu && (node.type === "Button" || node.type === "MenuItem" || node.type === "TreeItem")) {
    const what = node.type === "TreeItem" ? "expands or collapses this branch" : "opens a menu or a list of options";
    add({ kind: node.type === "TreeItem" ? "list_item" : "menu_button", purpose: label ? `${what} (“${label}”)` : what, effect: node.type === "TreeItem" ? "selects" : "opens_menu", conf: 0.9, basis: "metadata", evidence: `it supports the Expand/Collapse pattern${node.expanded ? ` (now ${node.expanded})` : ""}` });
  }
  if (node.type === "ComboBox") add({ kind: "dropdown", purpose: label ? `a drop-down to choose “${label}”` : "a drop-down list to choose from", effect: "selects", conf: label ? 0.9 : 0.7, basis: "metadata", evidence: "it is a combo box (a choice list)" });
  for (const h of ID_HINTS) {
    if (has(idWords, h.re)) add({ kind: h.kind, purpose: h.purpose, effect: h.effect, conf: 0.85, basis: "metadata", evidence: `its developer-given id/class says so (“${cleanScreenText(`${node.autoId ?? ""} ${node.className ?? ""}`).trim()}”)` });
  }
  if (/omnibox/.test(idWords)) add({ kind: "address_box", purpose: "the address box", effect: "navigates", conf: 0.9, basis: "metadata", evidence: "its class is the browser's address box (omnibox)" });

  // ---- search / address boxes (an Edit or a combo that is about searching or addressing)
  const textual = node.type === "Edit" || node.type === "ComboBox";
  const sources = [labelWords, helpWords, lbWords, idWords];
  const saysSearch = sources.some((w) => has(w, SEARCH));
  // "address" is only an address BAR in a browser / File Explorer, or when the app's own id/class or wording says so. Elsewhere it is a form field
  // ("Email address", "Street address"), which is just a text field.
  const formAddress = sources.some((w) => /\b(e ?mail|mailing|street|postal|billing|shipping|ip|home|delivery|contact)\s+address\b/.test(w));
  const barLike = isBrowser(ctx.process) || isExplorer(ctx.process) || /omnibox|address ?bar|url ?bar|location ?bar/.test(idWords) || sources.some((w) => /\b(web address|url)\b/.test(w) || SEARCH_OR_TYPE.test(w));
  const saysAddress = !formAddress && barLike && (sources.some((w) => has(w, ADDRESS)) || sources.some((w) => SEARCH_OR_TYPE.test(w)));
  if (textual && (saysSearch || saysAddress)) {
    const ids = idWords;
    const both = saysSearch && saysAddress;
    const sc = searchScope(node, ctx, ids);
    if (saysSearch && !saysAddress) {
      const filterOnly = /\bfilter\b/.test(labelWords) && !/\b(search|find)\b/.test(labelWords);
      const purpose = filterOnly ? "filters the items already shown" : "a search box: type what to look for, then press Enter";
      add({ kind: "search_box", purpose, scope: sc?.scope ?? null, effect: "runs_search", conf: 0.93, basis: node.help || node.labelledBy || ids ? "metadata" : "label", evidence: `it is called “${cleanScreenText(label || node.help || node.labelledBy || "")}” and accepts typed text` });
    } else if (saysAddress) {
      add({ kind: "address_box", purpose: both || SEARCH_OR_TYPE.test(labelWords) ? "the address box: a web address goes there, and plain words are searched" : "the address box: type a place to go to, then press Enter", scope: sc?.scope ?? (isBrowser(ctx.process) ? "web addresses (and web searches)" : isExplorer(ctx.process) ? "a folder path on this PC" : null), effect: "navigates", conf: 0.92, basis: "label", evidence: `it is called “${cleanScreenText(label || node.help || node.labelledBy || "")}” and accepts typed text` });
    }
  }

  // ---- 2. its label (a plain edit box with a caption)
  if (node.type === "Edit" && !cands.some((c) => c.kind === "search_box" || c.kind === "address_box")) {
    const cap = hasLabel ? label : node.labelledBy ? cleanScreenText(node.labelledBy) : node.help ? cleanScreenText(node.help) : null;
    if (cap) add({ kind: "text_input", purpose: `a text field for “${cap.slice(0, 60)}”`, effect: "types_text", conf: node.labelledBy || node.help ? 0.9 : 0.82, basis: node.labelledBy || node.help ? "metadata" : "label", evidence: node.labelledBy ? `the app tied the label “${cleanScreenText(node.labelledBy)}” to it` : node.help ? `its help text says “${cleanScreenText(node.help)}”` : `it is called “${cleanScreenText(label)}”` });
  }
  if (hasLabel && (node.type === "Button" || node.type === "SplitButton" || node.type === "MenuItem" || node.type === "Hyperlink" || node.type === "TabItem")) {
    const all = `${labelWords} ${helpWords}`.trim();
    const v = leadVerb(labelWords, helpWords);
    if (node.type === "TabItem") add({ kind: "tab", purpose: `switches to the “${label}” tab`, effect: "selects", conf: 0.9, basis: "label", evidence: "it is a tab" });
    else if (node.type === "Hyperlink") add({ kind: "link", purpose: `a link “${label}”: opens where it points`, effect: "navigates", conf: 0.8, basis: "label", evidence: "it is a link, and links open their target" });
    else if (/\b(drop ?down)\b/.test(all) && !v) add({ kind: "menu_button", purpose: `opens a drop-down list (“${label}”)`, effect: "opens_menu", conf: 0.85, basis: "label", evidence: `its label “${label}” says it is a drop-down` });
    else if (v) add({ kind: kind0, purpose: `${v.purpose} (“${label}”)${splitPlusMenu ? "; it also has a drop-down arrow" : ""}`, effect: pts.has("expandcollapse") && !splitPlusMenu && v.effect === "activates" ? "opens_menu" : v.effect, conf: node.help ? 0.93 : 0.88, basis: "label", evidence: `its label “${label}”${node.help ? " and help text agree" : " says it"}` });
    else add({ kind: kind0, purpose: `does what its label says: “${label}” (the application does not say more)${splitPlusMenu ? "; it also has a drop-down arrow" : ""}`, effect: pts.has("expandcollapse") && !splitPlusMenu ? "opens_menu" : "activates", conf: 0.62, basis: "label", evidence: `it is called “${label}”; nothing else says what it does` });
  }
  if (node.type === "ListItem" || node.type === "DataItem" || node.type === "TreeItem") {
    if (hasLabel) add({ kind: "list_item", purpose: `the item “${label.slice(0, 60)}” in a list (select it; double-click opens it)`, effect: "opens_item", conf: 0.85, basis: "label", evidence: "it is an entry in a list" });
  }
  if (node.type === "Slider" && hasLabel) add({ kind: "slider", purpose: `a slider for “${label}”`, effect: "selects", conf: 0.85, basis: "label", evidence: "it is a slider" });

  // ---- 3. surroundings: the caption next to it, when it has no label of its own
  if (!hasLabel && !cands.length) {
    const near = neighbourLabel(node, ctx.items);
    if (near && node.type === "Edit") add({ kind: "text_input", purpose: `a text field for “${near.slice(0, 60)}”`, effect: "types_text", conf: 0.68, basis: "context", evidence: `the text next to it reads “${near}”` });
    else if (near && (node.type === "Button" || node.type === "SplitButton")) add({ kind: kind0, purpose: `an unlabeled button next to the text “${near.slice(0, 60)}” (what it does is not stated)`, effect: "activates", conf: 0.4, basis: "context", evidence: `the text next to it reads “${near}”` });
  }

  if (cands.length === 0) {
    const what = kind0 === "unknown" ? "a control" : kind0.replace("_", " ");
    return base({ kind: kind0, purpose: null, confidence: 0, evidence: [`it is ${what} with no label, no help text and no developer id that says what it is for`], needs: "ocr" });
  }

  // strongest wins; agreement of independent sources raises confidence, never above 0.97
  cands.sort((a, b) => b.conf - a.conf);
  const top = cands[0];
  const agree = cands.slice(1).filter((c) => c.kind === top.kind || c.effect === top.effect);
  const confidence = Math.min(0.97, top.conf + agree.length * 0.04);
  const basis = [...new Set([top.basis, ...agree.map((a) => a.basis)])];
  // search boxes: the scope may come from context, and a missing scope is stated, not made up
  let scope = top.scope ?? null;
  const evidence = [top.evidence, ...agree.map((a) => a.evidence)];
  if (top.kind === "search_box" || top.kind === "address_box") {
    const sc = searchScope(node, ctx, idWords);
    if (sc) { if (!scope) scope = sc.scope; if (!evidence.includes(sc.evidence)) evidence.push(sc.evidence); if (!basis.includes(sc.basis)) basis.push(sc.basis); }
  }
  const uncertain = confidence < KNOWN || (top.kind === "search_box" && !scope);
  return {
    kind: top.kind, purpose: top.purpose, scope, effect: top.effect, confidence, basis, evidence, place,
    uncertain,
    // a search box with no stated scope: look at what is written around it before asking
    needs: uncertain ? (top.kind === "search_box" && !scope ? "ocr" : "ask") : null,
  };
}

/** Add what a picture of the control showed (OCR text of its box and of the text around it). Picture evidence is weaker than metadata. */
export function withPicture(u: Understanding, _node: UiNode, pic: { ocr?: string[]; vision?: { kind?: Kind; purpose: string; scope?: string | null } }): Understanding {
  const texts = (pic.ocr ?? []).map((t) => cleanScreenText(t)).filter((t) => t.length >= 2 && t.length <= 60);
  const out: Understanding = { ...u, evidence: [...u.evidence], basis: [...u.basis] };
  if (pic.vision && pic.vision.purpose.trim()) {
    const v = pic.vision;
    // only a visual AI's own words: never enough alone to act without asking (capped below SURE)
    out.kind = v.kind && out.kind === "unknown" ? v.kind : out.kind;
    out.purpose = u.purpose ?? cleanScreenText(v.purpose).slice(0, 120);
    out.scope = u.scope ?? (v.scope ? cleanScreenText(v.scope).slice(0, 80) : null);
    out.confidence = Math.max(u.confidence, 0.6);
    out.evidence.push(`a visual AI that looked at its picture says: “${cleanScreenText(v.purpose).slice(0, 120)}”`);
    if (!out.basis.includes("vision")) out.basis = [...out.basis.filter((b) => b !== "none"), "vision"];
    out.uncertain = out.confidence < KNOWN || (out.kind === "search_box" && !out.scope);
    out.needs = out.uncertain ? "ask" : null;
    return out;
  }
  if (texts.length === 0) {
    out.evidence.push("its picture shows no readable text");
    out.needs = u.needs === "ocr" ? "vision" : u.needs;
    return out;
  }
  const joined = words(texts.join(" "));
  out.evidence.push(`its picture reads “${texts.join(" / ").slice(0, 100)}”`);
  if (!out.basis.includes("ocr")) out.basis = [...out.basis.filter((b) => b !== "none"), "ocr"];
  if (u.purpose === null) {
    // the text on it is its label, by sight: treat it as a label, but capped (OCR can misread)
    const lab = texts.join(" ").slice(0, 60);
    const v = VERBS.find((x) => x.re.test(joined));
    out.purpose = v ? `${v.purpose} (reads “${lab}”)` : `does what the text on it says: “${lab}”`;
    out.effect = v?.effect ?? "activates";
    out.confidence = v ? 0.68 : 0.58;
    out.uncertain = out.confidence < KNOWN;
    out.needs = out.uncertain ? "ask" : null;
  } else if (u.kind === "search_box" && !u.scope && SEARCH.test(joined)) {
    const rest = searchRemainder(texts.join(" "));
    if (rest) { out.scope = `“${rest}”`; out.confidence = Math.max(u.confidence, 0.78); out.uncertain = false; out.needs = null; out.evidence.push("the placeholder text in the box names what it searches"); }
  }
  return out;
}

/** Would acting on this need the user's say-so first? (Not sure enough, or based only on a picture.) */
export function needsUserSayso(u: Understanding): boolean {
  if (u.uncertain || u.confidence < SURE) return true;
  const onlyPicture = u.basis.length > 0 && u.basis.every((b) => b === "ocr" || b === "vision");
  return onlyPicture;
}

/** One line for the planner / the user: what it is, what it does, how sure, and why. */
export function describeUnderstanding(node: UiNode, u: Understanding): string {
  const name = cleanScreenText(node.name) || "(no label)";
  const kind = u.kind.replace("_", " ");
  if (u.purpose === null) return `[${kind}] ${name} @ ${u.place || "?"}: purpose UNKNOWN (${u.evidence[0] ?? "no evidence"})${u.needs ? `; next: ${u.needs === "ocr" ? "read its picture" : u.needs === "vision" ? "look at it with a visual AI (needs your OK)" : "ask the user"}` : ""}`;
  const sure = u.uncertain ? "NOT SURE" : u.confidence >= SURE ? "sure" : "fairly sure";
  return `[${kind}] ${name} @ ${u.place || "?"}: ${u.purpose}${u.scope ? `; ${u.kind === "address_box" ? "addresses" : "searches"}: ${u.scope}` : u.kind === "search_box" ? "; what it searches: NOT STATED" : ""} (${sure}, ${u.basis.join("+")})`;
}
