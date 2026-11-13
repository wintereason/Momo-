import { VISEMES } from "./face";

/**
 * Mouth movement that follows what Momo is really saying. The browser's speech engine reports start, end and (for most
 * voices) the position of each word; from the text being spoken we pick the vowel under that position and open the mouth
 * to match, with a syllable-rate pulse so it never looks frozen. If a voice reports no word positions, the position is
 * estimated from elapsed time. When nothing is being spoken the mouth is left to the expression.
 */
export type Viseme = keyof typeof VISEMES;
export interface MouthLevel { open: number; round: number; wide: number }

const VOWEL: Record<string, Viseme> = { a: "a", e: "e", i: "i", y: "i", o: "o", u: "u" };
const CPS = 13; // characters per second at rate 1 (fallback when the voice gives no word positions)

/** The mouth shape for the character at `idx` of `text`: the next vowel within a few letters, a closed mouth on a pause. */
export function visemeAt(text: string, idx: number): Viseme {
  const lower = text.toLowerCase();
  for (let i = Math.max(0, idx); i < Math.min(lower.length, idx + 4); i++) {
    const ch = lower[i];
    if (VOWEL[ch]) return VOWEL[ch];
    if (/[,.;:!?]/.test(ch)) return "m";
  }
  return "m";
}

export class MouthSync {
  private text = "";
  private startedAt = 0;
  private boundaryAt = 0;
  private boundaryIdx = 0;
  private rate = 1;
  private _speaking = false;
  private listeners = new Set<() => void>();

  get speaking(): boolean { return this._speaking; }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  private emit() { for (const l of this.listeners) l(); }

  /** Speaker events: `{type:"start", text}`, `{type:"boundary", index}`, `{type:"end"}` */
  handle = (e: { type: "start"; text: string; rate?: number } | { type: "boundary"; index: number } | { type: "end" }, now = performance.now()): void => {
    if (e.type === "start") {
      this.text = e.text; this.startedAt = now; this.boundaryAt = 0; this.boundaryIdx = 0; this.rate = e.rate ?? 1;
      if (!this._speaking) { this._speaking = true; this.emit(); }
    } else if (e.type === "boundary") {
      this.boundaryAt = now; this.boundaryIdx = e.index;
    } else if (this._speaking) {
      this._speaking = false; this.emit();
    }
  };

  /** Where in the text we are right now. */
  position(now: number): number {
    if (this.boundaryAt) return this.boundaryIdx + ((now - this.boundaryAt) / 1000) * CPS * this.rate;
    return ((now - this.startedAt) / 1000) * CPS * this.rate;
  }

  /** The mouth right now, or null when Momo is not speaking. */
  level(now = performance.now()): MouthLevel | null {
    if (!this._speaking) return null;
    const pos = this.position(now);
    if (pos > this.text.length + CPS) return { open: 0.15, round: 0, wide: 1 }; // the voice outlasted the estimate
    const v = VISEMES[visemeAt(this.text, Math.floor(pos))];
    // a pulse at about the rate syllables are said, so repeated vowels still move
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin((now / 1000) * Math.PI * 2 * 2.6 * this.rate));
    return { open: v.open * pulse, round: v.round, wide: v.wide };
  }
}
