import { createHash, randomBytes } from "node:crypto";
import { KIND_PHRASE, type Acted, type FailureKind } from "./taxonomy";

/**
 * The Action Journal (phase 4b): a short, bounded, in-memory record of what Momo did in ONE task and how far each step got, so that
 * recovery decides from facts ("this click may have gone through, and nothing confirms it") instead of from sentences.
 *
 * PRIVACY. It is memory only (dropped with the task, never written anywhere, never logged, never sent to an AI) and it holds NO content:
 *  - arguments are reduced to a salted fingerprint (the salt is random per task and never kept elsewhere, so a fingerprint means nothing
 *    outside the task and cannot be guessed back into a typed value) plus the NAMES of the arguments, never their values;
 *  - the failure "reason" is a fixed plain-words phrase for the failure KIND (never the tool's own sentence, which can carry a title, a label or a path);
 *  - evidence is a fixed vocabulary of yes/no/count facts, never text from the screen, a field or a file.
 */

export const JOURNAL_MAX_ENTRIES = 50;
const MAX_TRAIL = 8;
const MAX_EVIDENCE = 8;

export type JournalPhase =
  | "started"        // about to run
  | "ran"            // it ran and reported success
  | "failed"         // it reported a failure
  | "acted"          // input reached (or may have reached) the app
  | "observing"      // looking, read-only, at what really happened
  | "verified"       // the look found real evidence of the effect
  | "not_effective"  // the look found real evidence that the effect is absent
  | "unconfirmed"    // the look could not tell either way
  | "waiting"        // waiting (bounded, read-only) for a frozen window to answer
  | "retrying"       // a fresh attempt was decided on
  | "declined"       // the user said no
  | "cancelled";     // the task was cancelled or the user took over

/** Facts only: a fixed vocabulary, a yes/no (null = could not tell) and at most a count. Never text. */
export type EvidenceKind =
  | "tool_verified" | "tool_unverified" | "window_exists" | "window_hung" | "window_modal" | "window_state" | "field_matches" | "windows_listed" | "new_windows"
  | "popup_open" | "popup_closed" | "responsive_again" | "still_hung" | "retry_decided" | "retry_declined" | "no_probe" | "observation_failed" | "observation_skipped";
export interface EvidenceItem { kind: EvidenceKind; ok: boolean | null; n?: number }

export interface JournalEntry {
  seq: number;
  /** milliseconds since the first entry of the task */
  tMs: number;
  tool: string;
  /** 1 for the first try; 2 for the one bounded retry */
  attempt: number;
  /** salted fingerprint of the arguments: equal arguments in this task give equal fingerprints, and mean nothing anywhere else */
  argFp: string;
  /** the NAMES of the arguments (the tool's own schema words), never their values */
  argKeys: string[];
  phase: JournalPhase;
  trail: JournalPhase[];
  acted: Acted;
  failure?: FailureKind;
  /** a fixed phrase for the failure kind: nothing from the screen */
  reason?: string;
  evidence: EvidenceItem[];
}

/** Stable text for the arguments, with the values reduced to type and length: only used to feed the salted hash. */
function shape(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return "n";
  if (typeof v === "string") return `s${v.length}:${v}`; // the value feeds the HASH only (never kept)
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "boolean") return `b:${v}`;
  if (depth > 3) return "deep";
  if (Array.isArray(v)) return `[${v.slice(0, 20).map((x) => shape(x, depth + 1)).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${k}=${shape((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  return "x";
}

const sameEvidence = (a: EvidenceItem, b: EvidenceItem) => a.kind === b.kind && a.ok === b.ok && a.n === b.n;
const clean = (e: EvidenceItem): EvidenceItem => ({ kind: e.kind, ok: e.ok === true ? true : e.ok === false ? false : null, ...(typeof e.n === "number" && Number.isFinite(e.n) ? { n: Math.max(0, Math.min(9999, Math.round(e.n))) } : {}) });

export class ActionJournal {
  private rows: JournalEntry[] = [];
  private next = 1;
  private first = 0;
  private droppedCount = 0;
  private readonly salt: string;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { max?: number; now?: () => number; salt?: string } = {}) {
    this.max = Math.max(1, Math.min(JOURNAL_MAX_ENTRIES, opts.max ?? JOURNAL_MAX_ENTRIES));
    this.now = opts.now ?? Date.now;
    this.salt = opts.salt ?? randomBytes(8).toString("hex");
  }

  /** the fingerprint of a call: equal calls in this task give equal fingerprints */
  fingerprint(tool: string, args: Record<string, unknown>): string {
    return createHash("sha256").update(`${this.salt}|${tool}|${shape(args)}`).digest("hex").slice(0, 12);
  }

  /** a step is about to run: returns its sequence number */
  begin(tool: string, args: Record<string, unknown>, opts: { attempt?: number } = {}): number {
    const t = this.now();
    if (this.rows.length === 0) this.first = t;
    const seq = this.next++;
    this.rows.push({ seq, tMs: Math.max(0, t - this.first), tool: String(tool).slice(0, 60), attempt: Math.max(1, Math.min(9, Math.round(opts.attempt ?? 1))), argFp: this.fingerprint(tool, args), argKeys: Object.keys(args ?? {}).filter((k) => !k.startsWith("_")).sort().slice(0, 12), phase: "started", trail: ["started"], acted: "no", evidence: [] });
    while (this.rows.length > this.max) { this.rows.shift(); this.droppedCount++; } // bounded: the oldest go first
    return seq;
  }

  /** change a recorded step: everything is re-checked on the way in, so nothing but the fixed vocabulary can enter */
  update(seq: number, patch: { phase?: JournalPhase; acted?: Acted; failure?: FailureKind; evidence?: EvidenceItem[] }): void {
    const e = this.rows.find((r) => r.seq === seq);
    if (!e) return; // it was dropped (older than the limit): nothing to update
    if (patch.phase && patch.phase !== e.phase) { e.phase = patch.phase; e.trail.push(patch.phase); if (e.trail.length > MAX_TRAIL) e.trail.splice(1, e.trail.length - MAX_TRAIL); }
    if (patch.acted) { const order = { no: 0, maybe: 1, yes: 2 } as const; if (order[patch.acted] >= order[e.acted]) e.acted = patch.acted; } // it never goes back down
    if (patch.failure) { e.failure = patch.failure; e.reason = KIND_PHRASE[patch.failure]; } // the reason is the kind's fixed phrase, never free text
    for (const ev of patch.evidence ?? []) {
      const c = clean(ev);
      if (!e.evidence.some((x) => sameEvidence(x, c)) && e.evidence.length < MAX_EVIDENCE) e.evidence.push(c);
    }
  }

  get size(): number { return this.rows.length; }
  /** how many older entries were dropped to stay within the limit */
  get dropped(): number { return this.droppedCount; }

  /** copies: nothing outside can change the journal */
  entries(): JournalEntry[] { return this.rows.map((r) => ({ ...r, argKeys: [...r.argKeys], trail: [...r.trail], evidence: r.evidence.map((x) => ({ ...x })) })); }
  last(): JournalEntry | undefined { const r = this.rows[this.rows.length - 1]; return r && this.entries().slice(-1)[0]; }

  /** has a step with these exact arguments been recorded as maybe/yes acted in this task? (for "never repeat what may have happened") */
  mayHaveRun(tool: string, args: Record<string, unknown>, exceptSeq?: number): boolean {
    const fp = this.fingerprint(tool, args);
    return this.rows.some((r) => r.seq !== exceptSeq && r.argFp === fp && r.tool === tool && r.acted !== "no" && r.phase !== "not_effective");
  }

  clear(): void { this.rows = []; this.droppedCount = 0; }
}
