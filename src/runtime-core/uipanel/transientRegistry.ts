import type { TransientKind, TransientWindow } from "../shared/ports";

/**
 * What Momo has recently seen of menus, dialogs, dropdowns and popups: the windows the normal window list skips.
 *
 * PRIVACY: memory only, at most 32 windows, each forgotten after 30 seconds without being seen again. It holds handles, classes, the kind,
 * geometry and times: NEVER a window title, a menu item or any text from a popup. It is dropped with the session.
 */
export const REGISTRY_MAX = 32;
export const REGISTRY_TTL_MS = 30_000;

export interface Seen extends TransientWindow { firstSeen: number; lastSeen: number }

export class TransientRegistry {
  private rows = new Map<number, Seen>();
  private latest = new Set<number>();
  private observed = false;
  private readonly max: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(opts: { max?: number; ttlMs?: number; now?: () => number } = {}) {
    this.max = Math.max(1, Math.min(REGISTRY_MAX, opts.max ?? REGISTRY_MAX));
    this.ttl = Math.max(1000, opts.ttlMs ?? REGISTRY_TTL_MS);
    this.now = opts.now ?? Date.now;
  }

  /** a full list of what is visible right now: remembers it, and says what appeared and what went away since the last list */
  observe(list: readonly TransientWindow[]): { appeared: number[]; disappeared: number[] } {
    const t = this.now();
    const appeared: number[] = [];
    const current = new Set<number>();
    for (const w of list) {
      if (!Number.isSafeInteger(w.hwnd) || w.hwnd <= 0) continue;
      current.add(w.hwnd);
      const old = this.rows.get(w.hwnd);
      if (!old) appeared.push(w.hwnd);
      // only the facts are kept (a copy: nothing the caller does later changes it, and nothing else is ever stored)
      this.rows.set(w.hwnd, { hwnd: w.hwnd, pid: w.pid, proc: w.proc, cls: w.cls, kind: w.kind, owner: w.owner, rootOwner: w.rootOwner, top: w.top, tool: w.tool, fg: w.fg, rect: { ...w.rect }, firstSeen: old?.firstSeen ?? t, lastSeen: t });
    }
    const disappeared = this.observed ? [...this.latest].filter((h) => !current.has(h)) : [];
    this.latest = current;
    this.observed = true;
    this.prune(t);
    return { appeared, disappeared };
  }

  private prune(t: number): void {
    for (const [h, r] of this.rows) if (t - r.lastSeen > this.ttl) this.rows.delete(h);
    while (this.rows.size > this.max) { // the oldest-seen go first
      let oldest: number | null = null, at = Infinity;
      for (const [h, r] of this.rows) if (r.lastSeen < at) { at = r.lastSeen; oldest = h; }
      if (oldest === null) break;
      this.rows.delete(oldest);
    }
  }

  get size(): number { return this.rows.size; }
  get(hwnd: number): Seen | undefined { const r = this.rows.get(hwnd); return r ? { ...r, rect: { ...r.rect } } : undefined; }
  /** what was visible in the latest list */
  current(kind?: TransientKind): Seen[] {
    return [...this.latest].map((h) => this.rows.get(h)).filter((r): r is Seen => !!r && (!kind || r.kind === kind)).map((r) => ({ ...r, rect: { ...r.rect } }));
  }
  /** was it seen before, and is it missing from the latest list? (a popup that closed: reported as gone, never an error) */
  isGone(hwnd: number): boolean { return this.rows.has(hwnd) && !this.latest.has(hwnd) && this.observed; }

  /**
   * The windows that belong together: the popup, the window that owns it, and the other popups of that same owner (a menu and its submenu).
   * This is what a click inside a popup is checked against (the pointer's "which window is under me" answer is the popup, not its owner).
   */
  family(hwnd: number): number[] {
    const r = this.rows.get(hwnd);
    const out = new Set<number>([hwnd]);
    if (!r) return [...out];
    const roots = new Set<number>([r.owner, r.rootOwner].filter((h) => h > 0));
    for (const h of roots) out.add(h);
    for (const s of this.rows.values()) if (this.latest.has(s.hwnd) && (roots.has(s.owner) || roots.has(s.rootOwner) || (r.owner === 0 && r.rootOwner === 0 && s.pid === r.pid && s.kind === r.kind))) out.add(s.hwnd);
    return [...out];
  }

  clear(): void { this.rows.clear(); this.latest = new Set(); this.observed = false; }
}
