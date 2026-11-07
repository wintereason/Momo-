import { cleanScreenText, usable } from "../shared/screenText";
import type { UiNode } from "../shared/ports";

/**
 * Browser agent: tells browser WINDOWS, TABS and PAGES apart.
 *   window = a top-level browser window (found by the desktop agent)
 *   tab    = a tab-strip item inside it (UI Automation TabItem)
 *   page   = what the selected tab is showing (its title and address)
 * Tab titles and addresses are private browsing data: private windows are never read, and everything is
 * untrusted text from other programs.
 */

export const BROWSER_PROCESSES = /^(chrome|msedge|firefox|brave|opera|vivaldi|iexplore)$/i;
const BROWSER_NAMES: Record<string, string> = { chrome: "Chrome", msedge: "Edge", firefox: "Firefox", brave: "Brave", opera: "Opera", vivaldi: "Vivaldi", iexplore: "Internet Explorer" };
export const browserName = (process: string): string => BROWSER_NAMES[process.toLowerCase()] ?? process;

/** "chrome", "google chrome", "edge", "microsoft edge" ... -> process name */
export function browserFromWords(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/\b(chrome|google chrome)\b/.test(t)) return "chrome";
  if (/\b(edge|microsoft edge)\b/.test(t)) return "msedge";
  if (/\bfirefox\b/.test(t)) return "firefox";
  if (/\bbrave\b/.test(t)) return "brave";
  if (/\bopera\b/.test(t)) return "opera";
  if (/\bvivaldi\b/.test(t)) return "vivaldi";
  return undefined;
}

/** Incognito / InPrivate / Private Browsing windows are never read or listed. */
export const isPrivateWindow = (title: string): boolean =>
  /\b(incognito|inprivate|private browsing|private window|private mode|private tab)\b|\(private\)|^private\b|[-–—]\s*private\b/i.test(title);

export interface TabInfo { name: string; selected: boolean; rid?: string; enabled: boolean }
export interface PageInfo {
  tabs: TabInfo[];
  /** the address bar text, if the browser exposes it */
  address?: string;
}

// only the browser's own address bar names: "url" or "location" would also match an Edit box inside a web page
const ADDRESS_NAME = /address|search or enter|search with|omnibox/i;

export function extractPage(items: UiNode[], max = 40): PageInfo {
  const list = usable(items);
  const tabs: TabInfo[] = [];
  const seen = new Set<string>();
  for (const n of list) {
    if (n.type !== "TabItem") continue;
    const name = cleanScreenText(n.name);
    const key = n.rid ?? name;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    tabs.push({ name, selected: n.state === "selected", rid: n.rid, enabled: n.enabled });
  }
  const addr = list.find((n) => n.type === "Edit" && ADDRESS_NAME.test(n.name) && n.value);
  return { tabs: tabs.slice(0, max), address: addr?.value ? cleanScreenText(addr.value) : undefined };
}

/** Just the site (host) of an address bar value: full URLs can carry tokens and are not read out. */
export function hostOf(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const a = address.trim();
  // spaces are fine inside a query string (secrets there were already masked), but not in the part that names the site
  if (!a || /\s/.test(a.split(/[/?#]/)[0]) || /^(javascript|data|file|blob|about|chrome|edge):/i.test(a)) return undefined; // a search phrase or a non-web page
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(a) ? a : "https://" + a;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const h = u.hostname.replace(/^www\./, "");
    return /^[a-z0-9.-]+$/i.test(h) && (h.includes(".") || h === "localhost") ? h : undefined;
  } catch {
    return undefined;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Tabs whose title matches what the user said (exact title first). */
export function matchTabs(tabs: TabInfo[], query: string): TabInfo[] {
  const q = norm(query);
  if (q.length < 2) return []; // one character matches nearly every tab: ask for more instead of guessing
  const exact = tabs.filter((t) => norm(t.name) === q);
  if (exact.length > 0) return exact;
  const tokens = q.split(" ");
  return tabs.filter((t) => tokens.every((w) => norm(t.name).includes(w)));
}
