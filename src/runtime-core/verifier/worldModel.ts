/**
 * Shared temporary world model: what Momo currently believes about this computer.
 * In memory only, never persisted; cleared on exit (see Session.dispose).
 */
export type EntityType = "desktop" | "window" | "drive" | "folder" | "control" | "screen";
export type EvidenceSource =
  | "fs.statfs" | "fs.readdir" | "fs.stat"
  | "win32.foreground" | "win32.windows"
  | "uia" | "ocr"
  | "user";

export interface Entity {
  id: string;
  type: EntityType;
  parentId?: string;
  props: Record<string, unknown>;
  /** where the observation came from */
  source: EvidenceSource;
  observedAt: number;
  /** 0..1: how sure we are that this matches reality */
  confidence: number;
  /** explicitly invalidated (the environment changed) */
  stale: boolean;
}

/** How long an observation may be treated as current, per entity type (ms). */
export const FRESHNESS_MS: Record<EntityType, number> = {
  desktop: 3_000,
  window: 3_000,
  drive: 30_000,
  folder: 60_000,
  // what is on screen changes constantly: treat it as current only for a moment
  control: 3_000,
  screen: 3_000,
};

export type EnvChange = "focus_changed" | "window_set_changed" | "fs_changed";

export class WorldModel {
  private entities = new Map<string, Entity>();
  private closed = false;

  constructor(private now: () => number = Date.now) {}

  upsert(e: Omit<Entity, "observedAt" | "stale">): Entity {
    const full: Entity = { ...e, observedAt: this.now(), stale: false };
    // after dispose() nothing is stored: an agent that was still waiting on Windows when Momo exited
    // must not be able to refill what was just wiped
    if (!this.closed) this.entities.set(e.id, full);
    return full;
  }

  /** Any stored entity, however old. Prefer getFresh for decisions. */
  get(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  isFresh(e: Entity): boolean {
    return !e.stale && this.now() - e.observedAt <= FRESHNESS_MS[e.type];
  }

  /** An observation that may still be treated as current; stale or expired ones are never returned. */
  getFresh(id: string): Entity | undefined {
    const e = this.entities.get(id);
    return e && this.isFresh(e) ? e : undefined;
  }

  list(type: EntityType, opts: { freshOnly?: boolean } = {}): Entity[] {
    return [...this.entities.values()].filter((e) => e.type === type && (!opts.freshOnly || this.isFresh(e)));
  }

  children(parentId: string): Entity[] {
    return [...this.entities.values()].filter((e) => e.parentId === parentId);
  }

  /** Mark matching entities stale; returns how many changed. */
  invalidate(match: (e: Entity) => boolean): number {
    let n = 0;
    for (const e of this.entities.values()) {
      if (!e.stale && match(e)) { e.stale = true; n++; }
    }
    return n;
  }

  /** Remove all entities of a type (e.g. windows that no longer exist). */
  removeType(type: EntityType): void {
    for (const [id, e] of this.entities) if (e.type === type) this.entities.delete(id);
  }

  /** The environment changed: everything that could now be wrong is invalidated. */
  notify(change: EnvChange): number {
    switch (change) {
      case "focus_changed":
      case "window_set_changed":
        return this.invalidate((e) => e.type === "window" || e.type === "desktop" || e.type === "control" || e.type === "screen");
      case "fs_changed": return this.invalidate((e) => e.type === "drive" || e.type === "folder");
    }
  }

  get size(): number {
    return this.entities.size;
  }

  clear(): void {
    this.entities.clear();
  }

  /** Final cleanup on exit: wipe everything and refuse anything that arrives later. */
  dispose(): void {
    this.entities.clear();
    this.closed = true;
  }
}
