import type { ActResult, AppEntry, AppsPort, BrowserKey, BrowserProfile, FsPort, LaunchPort } from "../shared/ports";
import { browserKeyFor, isProfileDir } from "./profiles";

/**
 * Application agent: knows which applications are installed and can start them.
 * It launches ONLY entries from the operating system's own app index, a folder it has just verified,
 * or an http(s) address: nothing runnable ever comes straight from what the user said or from the screen.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const INDEX_TTL_MS = 10 * 60_000;

/** Words that say "the program", not which program. */
const APP_FILLER = new Set(["the", "my", "app", "application", "program", "software", "please", "a", "an", "up", "for", "me"]);
export const cleanAppQuery = (q: string): string => norm(q).split(" ").filter((w) => w && !APP_FILLER.has(w)).join(" ");

/** Entries matching what the user said; an exact name beats partial matches, and shorter names beat longer ones. */
export function matchApps(apps: AppEntry[], query: string): AppEntry[] {
  const q = cleanAppQuery(query);
  if (!q) return [];
  const tokens = q.split(" ");
  const exact = apps.filter((a) => norm(a.name) === q);
  if (exact.length > 0) return dedupe(exact);
  const starts = apps.filter((a) => norm(a.name).startsWith(q + " ") || norm(a.name) === q);
  if (starts.length > 0) return dedupe(starts);
  return dedupe(apps.filter((a) => tokens.every((t) => norm(a.name).split(" ").some((w) => w.startsWith(t)))));
}
function dedupe(list: AppEntry[]): AppEntry[] {
  const seen = new Set<string>();
  return list.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

/** A plain http(s) address, or null. Spoken "github dot com" works too. */
export function normalizeUrl(raw: string): { url: string; host: string } | null {
  let t = raw.trim().replace(/\s+dot\s+/gi, ".").replace(/\s+slash\s+/gi, "/").replace(/[?!.,]+$/, "");
  if (!t || /\s/.test(t) || t.length > 2000) return null;
  if (!/^https?:\/\//i.test(t)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^localhost(:\d+)?(\/|$)/i.test(t)) return null; // javascript:, file:, data: ...
    if (!/^(localhost(:\d+)?|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?([/?#].*)?$/i.test(t)) return null;
    t = "https://" + t;
  }
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null; // no embedded credentials
    return { url: u.toString(), host: u.hostname.replace(/^www\./, "") };
  } catch {
    return null;
  }
}

/** Well-known websites people ask for by name ("open youtube"). Only plain https front pages. */
const KNOWN_SITES: Record<string, string> = {
  youtube: "https://www.youtube.com/", gmail: "https://mail.google.com/", google: "https://www.google.com/",
  "google drive": "https://drive.google.com/", "google maps": "https://maps.google.com/", "google docs": "https://docs.google.com/",
  "google meet": "https://meet.google.com/", github: "https://github.com/", reddit: "https://www.reddit.com/",
  wikipedia: "https://www.wikipedia.org/", stackoverflow: "https://stackoverflow.com/", "stack overflow": "https://stackoverflow.com/",
  linkedin: "https://www.linkedin.com/", twitter: "https://twitter.com/", facebook: "https://www.facebook.com/", instagram: "https://www.instagram.com/",
};

/** A website by its everyday name ("youtube"), or by its address; null when it is neither. */
export function siteUrl(spoken: string): { url: string; host: string } | null {
  const name = spoken.toLowerCase().replace(/^(the|my)\s+/, "").replace(/\s+(website|site|page|dot com)$/, "").replace(/\.com$/, "").trim();
  const known = KNOWN_SITES[name];
  return known ? normalizeUrl(known) : normalizeUrl(spoken.trim());
}

export class AppAgent {
  calls = 0;
  private cache: { at: number; apps: AppEntry[] } | null = null;

  constructor(
    private apps: AppsPort | undefined,
    private launch: LaunchPort | undefined,
    private fs: FsPort,
    private now: () => number = Date.now,
  ) {}

  /** Installed apps matching a spoken name. The index is cached for a few minutes. */
  async search(query: string): Promise<{ ok: true; matches: AppEntry[] } | { ok: false; reason: string }> {
    if (!this.apps) return { ok: false, reason: "I can't see the list of installed apps in this build." };
    this.calls++;
    try {
      if (!this.cache || this.now() - this.cache.at > INDEX_TTL_MS) this.cache = { at: this.now(), apps: await this.apps.list() };
    } catch {
      return { ok: false, reason: "I couldn't read the list of installed apps." };
    }
    return { ok: true, matches: matchApps(this.cache.apps, query) };
  }

  async launchApp(app: AppEntry): Promise<ActResult> {
    if (!this.launch) return { ok: false, reason: "Starting apps isn't available in this build." };
    // only an id that came from the OS index may be launched
    if (!this.cache || !this.cache.apps.some((a) => a.id === app.id)) return { ok: false, reason: "That isn't an installed app I know about." };
    this.calls++;
    return this.launch.launchApp(app.id);
  }

  /** The profiles of a browser app (Chrome, Edge, Brave), or an empty list for any other app. */
  async profilesFor(app: AppEntry): Promise<BrowserProfile[]> {
    const key = browserKeyFor(app.name);
    return key ? this.profilesOfBrowser(key) : [];
  }

  /** The profiles (signed-in accounts) of one browser, read from the browser's own settings file. */
  async profilesOfBrowser(key: BrowserKey): Promise<BrowserProfile[]> {
    if (!this.launch?.browserProfiles) return [];
    try { return await this.launch.browserProfiles(key); } catch { return []; }
  }

  /** Open a browser with one of its profiles. Only a profile that was just listed for that browser may be used. */
  async openProfile(app: AppEntry, profileDir: string | null, url?: string): Promise<ActResult> {
    const key = browserKeyFor(app.name);
    if (!this.launch?.openBrowserProfile || !key) return { ok: false, reason: "Opening a browser profile isn't available in this build." };
    if (!this.cache || !this.cache.apps.some((x) => x.id === app.id)) return { ok: false, reason: "That isn't an installed app I know about." };
    if (profileDir !== null) {
      if (!isProfileDir(profileDir)) return { ok: false, reason: "That isn't a profile I can open." };
      const known = await this.profilesFor(app);
      if (!known.some((p) => p.dir === profileDir)) return { ok: false, reason: "That profile no longer exists." };
    }
    let address: string | undefined;
    if (url !== undefined) {
      const n = normalizeUrl(url);
      if (!n) return { ok: false, reason: "That doesn't look like a normal web address, so I won't open it." };
      address = n.url;
    }
    this.calls++;
    return this.launch.openBrowserProfile(key, profileDir, address);
  }

  async openFolderInVsCode(folder: string): Promise<ActResult> {
    if (!this.launch) return { ok: false, reason: "Starting apps isn't available in this build." };
    if (!/^[A-Za-z]:\\/.test(folder) || /(^|\\)\.\.(\\|$)/.test(folder) || folder.includes("\0")) {
      return { ok: false, reason: "That path isn't a normal local folder, so I won't pass it to another program." };
    }
    const st = await this.fs.stat(folder); // pre-action check on the current state of the disk
    if (!st?.isDir) return { ok: false, reason: "That folder doesn't exist any more." };
    this.calls++;
    return this.launch.openFolderInVsCode(folder);
  }

  async openUrl(url: string): Promise<ActResult> {
    if (!this.launch) return { ok: false, reason: "Opening websites isn't available in this build." };
    const n = normalizeUrl(url);
    if (!n) return { ok: false, reason: "That doesn't look like a normal web address, so I won't open it." };
    this.calls++;
    return this.launch.openUrl(n.url);
  }
}
