import type { BrowserKey, BrowserProfile } from "../shared/ports";

/**
 * Browser profiles (Chrome, Edge and Brave keep one per signed-in account or persona). "Open Chrome" is ambiguous when
 * there are several, so Momo asks which one. Only the profile's folder name, its display name and its account email are
 * read from the browser's own "Local State" file, and they are used for this question only (never stored or sent).
 */

const DIR = /^(Default|Profile \d{1,3})$/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,120}$/;
const clean = (s: unknown, max: number): string => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function isProfileDir(dir: unknown): dir is string {
  return typeof dir === "string" && DIR.test(dir);
}

/**
 * Chrome's built-in picture set, by the number in `chrome://theme/IDR_PROFILE_AVATAR_<n>`. The animals are numbered in
 * alphabetical order from 27. This table is BEST EFFORT: it comes from Chrome's resource list, not from anything the
 * browser documents, so a match found this way is always confirmed with the user (with the account's email) before use.
 */
const AVATAR_BY_ID: Record<number, string> = { 27: "cat", 28: "corgi", 29: "dragon", 30: "elephant", 31: "fox", 32: "monkey", 33: "panda", 34: "penguin", 35: "pizza", 36: "rabbit" };

/** The built-in picture the user deliberately chose (not the automatic one and not their Google photo). */
function chosenAvatar(info: Record<string, unknown>): string | undefined {
  if (info.is_using_default_avatar !== false) return undefined;
  const m = String(info.avatar_icon ?? "").match(/^chrome:\/\/theme\/IDR_PROFILE_AVATAR_(\d{1,3})$/);
  return m ? AVATAR_BY_ID[Number(m[1])] : undefined;
}

const HINT_STOP = new Set([
  "and", "then", "go", "to", "the", "with", "using", "use", "in", "on", "my", "a", "an", "of", "one", "that", "which", "has", "have",
  "icon", "avatar", "profile", "account", "email", "emails", "id", "face", "picture", "photo", "image", "logo", "named", "called", "please",
  "open", "select", "pick", "choose", "switch", "chrome", "google", "edge", "microsoft", "brave", "browser",
]);

/** The words in a description like "the panda face icon email" that actually say something: ["panda"]. */
export function hintWords(hint: string): string[] {
  return hint.toLowerCase().replace(/[^\p{L}\p{N}@.\s-]+/gu, " ").split(/\s+/).filter((w) => w && !HINT_STOP.has(w));
}

export interface HintMatch {
  matches: BrowserProfile[];
  /** "text" = the words are in the account's name or email; "avatar" = they name its picture (needs confirming) */
  by: "text" | "avatar" | "none";
}

/** Which accounts does a description point to? Words in the name or email first, then the built-in picture. */
export function matchProfileHint(profiles: BrowserProfile[], hint: string): HintMatch {
  const words = hintWords(hint);
  if (words.length === 0) return { matches: [], by: "none" };
  const text = profiles.filter((p) => words.every((w) => `${p.name} ${p.email ?? ""}`.toLowerCase().includes(w)));
  if (text.length > 0) return { matches: text, by: "text" };
  const avatar = profiles.filter((p) => p.avatar && words.every((w) => p.avatar === w));
  return avatar.length > 0 ? { matches: avatar, by: "avatar" } : { matches: [], by: "none" };
}

/** Read the profiles out of a parsed "Local State" file. Unknown shapes give an empty list. */
export function parseProfiles(localState: unknown): BrowserProfile[] {
  const cache = (localState as { profile?: { info_cache?: unknown } } | null)?.profile?.info_cache;
  if (!cache || typeof cache !== "object") return [];
  const out: BrowserProfile[] = [];
  for (const [dir, info] of Object.entries(cache as Record<string, unknown>)) {
    if (!isProfileDir(dir) || !info || typeof info !== "object") continue;
    const i = info as Record<string, unknown>;
    const name = clean(i.name, 40) || clean(i.gaia_name, 40) || dir;
    const email = clean(i.user_name, 120);
    const avatar = chosenAvatar(i);
    out.push({ dir, name, ...(EMAIL.test(email) ? { email } : {}), ...(avatar ? { avatar } : {}) });
  }
  const order = (d: string) => (d === "Default" ? 0 : Number(d.replace("Profile ", "")) || 999);
  return out.sort((a, b) => order(a.dir) - order(b.dir));
}

/** "me@example.com (Work)" or "Work". Two profiles with the same name and no email are told apart by their folder. */
export function profileLabels(list: BrowserProfile[]): string[] {
  const dupes = new Map<string, number>();
  for (const p of list) dupes.set(p.name.toLowerCase(), (dupes.get(p.name.toLowerCase()) ?? 0) + 1);
  // the account's email comes first: that is how people tell their accounts apart
  return list.map((p) => (p.email ? `${p.email} (${p.name})` : (dupes.get(p.name.toLowerCase()) ?? 0) > 1 ? `${p.name} (${p.dir})` : p.name));
}

/** Which browser an installed app's name stands for, if any. */
export function browserKeyFor(appName: string): BrowserKey | null {
  const n = appName.trim().toLowerCase();
  if (n === "google chrome" || n === "chrome") return "chrome";
  if (n === "microsoft edge" || n === "edge") return "msedge";
  if (n === "brave" || n === "brave browser") return "brave";
  return null;
}
