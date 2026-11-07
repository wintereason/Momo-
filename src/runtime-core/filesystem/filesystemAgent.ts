import { win32 as path } from "node:path";
import type { FsPort } from "../shared/ports";
import type { WorldModel } from "../verifier";

export interface DriveInfo {
  letter: string; // "D"
  root: string; // "D:\"
  total: number; // bytes
  free: number;
  used: number;
}
export type DriveResult =
  | { kind: "ok"; info: DriveInfo }
  | { kind: "not_found"; letter: string; available: string[] };

export interface FolderMatch {
  path: string;
  name: string;
  parent: string;
}
/** A file or a folder found by name. */
export interface PathMatch extends FolderMatch { isDir: boolean }
export interface PathSearch { matches: PathMatch[]; truncated: boolean }
export interface FolderSearch {
  matches: FolderMatch[];
  /** the search stopped early (time or size budget), so there may be more */
  truncated: boolean;
}

const SKIP = new Set([
  "node_modules", ".git", "$recycle.bin", "system volume information", "windows", "program files",
  "program files (x86)", "programdata", "appdata", "venv", ".venv", "__pycache__", "site-packages",
  ".cache", "recovery", "$windows.~bt",
]);

/** Built-in Windows profiles that are not the user's own. */
const SKIP_FILES = new Set(["desktop.ini", "thumbs.db", "ntuser.dat", "pagefile.sys", "hiberfil.sys", "swapfile.sys"]);

const SKIP_PROFILE = /\\users\\(default|default user|all users|public)$/i;

// letters and digits in any language, so non-English folder names can be found too
export const normalizeName = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export interface SearchLimits {
  homeDepth: number;
  driveDepth: number;
  maxDirs: number;
  maxMs: number;
  maxResults: number;
  /** longest wait for one folder listing (a slow or disconnected drive) */
  readMs?: number;
}

/** Wait for a promise, but never longer than `ms`; the timer is always cleared. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}
export const DEFAULT_LIMITS: SearchLimits = { homeDepth: 4, driveDepth: 3, maxDirs: 30_000, maxMs: 5_000, maxResults: 25 };

/** Understands drives, folders and files through filesystem APIs only. It never opens File Explorer. */
export class FileSystemAgent {
  calls = 0;

  constructor(
    private world: WorldModel,
    private fs: FsPort,
    private now: () => number = Date.now,
    private limits: SearchLimits = DEFAULT_LIMITS,
  ) {}

  async drive(letter: string): Promise<DriveResult> {
    this.calls++;
    if (!/^[A-Za-z]$/.test(letter)) return { kind: "not_found", letter: String(letter).slice(0, 1).toUpperCase(), available: (await this.fs.listDriveRoots()).map((r) => r[0].toUpperCase()) };
    const L = letter.toUpperCase();
    const roots = await this.fs.listDriveRoots();
    const root = roots.find((r) => r.toUpperCase().startsWith(L + ":"));
    if (!root) return { kind: "not_found", letter: L, available: roots.map((r) => r[0].toUpperCase()) };
    return { kind: "ok", info: await this.read(L, root) };
  }

  async allDrives(): Promise<DriveInfo[]> {
    this.calls++;
    const roots = await this.fs.listDriveRoots();
    const out: DriveInfo[] = [];
    for (const r of roots) {
      try { out.push(await this.read(r[0].toUpperCase(), r)); } catch { /* unreadable drive (e.g. empty card reader): skip */ }
    }
    return out;
  }

  private async read(letter: string, root: string): Promise<DriveInfo> {
    const { total, free } = await this.fs.statfs(root);
    const info: DriveInfo = { letter, root, total, free, used: total - free };
    this.world.upsert({ id: `drive:${letter}`, type: "drive", props: { ...info }, source: "fs.statfs", confidence: 1 });
    return info;
  }

  /** Find folders by (partial) name. Several matches are returned as-is: the caller must ask, never guess. */
  async findFolders(query: string): Promise<FolderSearch> {
    const r = await this.findPaths(query, "folder");
    return { matches: r.matches.map(({ path: p, name, parent }) => ({ path: p, name, parent })), truncated: r.truncated };
  }

  /**
   * Find files and/or folders by (part of) a name. Every word must be in the name (the extension counts, so "report pdf"
   * works). Several matches are returned as they are: the caller must ask, never guess.
   */
  async findPaths(query: string, kind: "file" | "folder" | "any" = "any"): Promise<PathSearch> {
    this.calls++;
    const tokens = query.split(/\s+/).map(normalizeName).filter(Boolean);
    if (tokens.length === 0) return { matches: [], truncated: false };

    const started = this.now();
    const queue: { dir: string; depth: number; max: number }[] = [{ dir: this.fs.homeDir(), depth: 0, max: this.limits.homeDepth }];
    for (const r of await this.fs.listDriveRoots()) queue.push({ dir: r, depth: 0, max: this.limits.driveDepth });

    const seen = new Set<string>();
    const matches: PathMatch[] = [];
    let visited = 0;
    let truncated = false;

    let head = 0; // an index instead of queue.shift(), which is slow on a long queue
    while (head < queue.length) {
      if (visited >= this.limits.maxDirs || this.now() - started > this.limits.maxMs || matches.length >= this.limits.maxResults) {
        truncated = true;
        break;
      }
      const { dir, depth, max } = queue[head++];
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      visited++;
      // one slow or disconnected drive must not use up the whole search: give each folder a short time
      // files are looked at only when asked for; a port that cannot list files (a simple fake) lists folders only
      const entries = await within(
        kind !== "folder" && this.fs.readEntries ? this.fs.readEntries(dir) : this.fs.readDirs(dir).then((n) => (n ? n.map((name) => ({ name, isDir: true })) : null)),
        this.limits.readMs ?? 3000,
      );
      if (!entries) continue;
      for (const { name, isDir } of entries) {
        const lower = name.toLowerCase();
        // hidden/config entries (".claude", ".vscode"), build noise and other users' profiles are never what is meant
        if (SKIP.has(lower) || lower.startsWith(".") || (!isDir && SKIP_FILES.has(lower))) continue;
        const full = path.join(dir, name);
        if (SKIP_PROFILE.test(full)) continue;
        const norm = normalizeName(name);
        if ((kind === "any" || (kind === "folder") === isDir) && tokens.every((t) => norm.includes(t))) {
          if (!matches.some((m) => m.path.toLowerCase() === full.toLowerCase())) matches.push({ path: full, name, parent: dir, isDir });
        }
        if (isDir && depth + 1 < max) queue.push({ dir: full, depth: depth + 1, max });
      }
    }

    // the user's own profile first, then exact name, then shallower paths, then alphabetical
    const q = tokens.join("");
    const home = this.fs.homeDir().toLowerCase();
    const inHome = (m: FolderMatch) => Number(m.path.toLowerCase().startsWith(home + "\\"));
    const stem = (m: PathMatch) => normalizeName(m.isDir ? m.name : m.name.replace(/\.[^.]*$/, ""));
    matches.sort((a, b) =>
      inHome(b) - inHome(a) ||
      Number(stem(b) === q) - Number(stem(a) === q) ||
      a.path.split("\\").length - b.path.split("\\").length ||
      a.path.localeCompare(b.path));

    for (const m of matches) {
      if (m.isDir) this.world.upsert({ id: `folder:${m.path.toLowerCase()}`, type: "folder", props: { ...m }, source: "fs.readdir", confidence: 0.9 });
    }
    return { matches, truncated };
  }
}
