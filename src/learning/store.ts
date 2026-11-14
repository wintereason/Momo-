import { z } from "zod";
import type { KV } from "../state/settings";
import { freshState, LangIdSchema, LearningStateSchema, type LearningState } from "./state";
import { ensureCourse } from "./progress";

/**
 * Where learning progress lives: this PC only (the app's own storage), one entry per learner profile. Profiles are isolated:
 * one learner's lessons, scores and interviews are never visible to another. Removed by "Delete my data".
 */
export const LEARNING_KEY = "momo.learning.v1";

const ProfileSchema = z.object({ name: z.string().max(40), created: z.number(), state: LearningStateSchema });
const StoredSchema = z.object({ version: z.literal(1), active: z.string().nullable(), profiles: z.record(ProfileSchema) });
type Stored = z.infer<typeof StoredSchema>;

export class LearningStore {
  private data: Stored;
  constructor(private kv: KV, private now: () => number = Date.now) { this.data = this.read(); }

  /** Read what is saved. A damaged profile is dropped on its own; the others survive. */
  private read(): Stored {
    try {
      const raw = this.kv.getItem(LEARNING_KEY);
      if (!raw) return { version: 1, active: null, profiles: {} };
      const j = JSON.parse(raw) as { active?: unknown; profiles?: Record<string, unknown> };
      const profiles: Stored["profiles"] = {};
      for (const [id, p] of Object.entries(j.profiles ?? {})) { const r = ProfileSchema.safeParse(p); if (r.success) profiles[id] = r.data; }
      const active = typeof j.active === "string" && profiles[j.active] ? j.active : Object.keys(profiles)[0] ?? null;
      return { version: 1, active, profiles };
    } catch { return { version: 1, active: null, profiles: {} }; }
  }
  private write() { try { this.kv.setItem(LEARNING_KEY, JSON.stringify(StoredSchema.parse(this.data))); } catch { /* storage unavailable: keep working in memory */ } }

  /** pick up changes another window made */
  reload(): void { this.data = this.read(); }

  profiles(): { id: string; name: string; lang: string }[] { return Object.entries(this.data.profiles).map(([id, p]) => ({ id, name: p.name, lang: p.state.settings.lang })); }
  activeId(): string | null { return this.data.active; }
  state(): LearningState | null { return this.data.active ? this.data.profiles[this.data.active]?.state ?? null : null; }

  createProfile(name: string, lang: z.infer<typeof LangIdSchema>): string {
    const id = `p${this.now().toString(36)}${Object.keys(this.data.profiles).length}`;
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 40) || "Learner";
    this.data.profiles[id] = { name: clean, created: this.now(), state: ensureCourse(freshState(lang, this.now()), this.now()) };
    this.data.active = id;
    this.write();
    return id;
  }
  switchProfile(id: string): boolean { if (!this.data.profiles[id]) return false; this.data.active = id; this.write(); return true; }
  deleteProfile(id: string): void {
    delete this.data.profiles[id];
    if (this.data.active === id) this.data.active = Object.keys(this.data.profiles)[0] ?? null;
    this.write();
  }
  /** change the ACTIVE learner's state; the result is validated before it is saved */
  update(fn: (s: LearningState) => LearningState): LearningState | null {
    const id = this.data.active;
    if (!id) return null;
    const next = LearningStateSchema.parse(fn(this.data.profiles[id].state));
    this.data.profiles[id] = { ...this.data.profiles[id], state: next };
    this.write();
    return next;
  }
}
