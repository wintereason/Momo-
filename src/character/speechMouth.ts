import { VISEMES } from "./face";

/**
 * Mouth movement driven by the REAL speech playback. Windows speech gives no audio samples to the page, only events from the
 * engine itself: when an utterance starts, the start of every word (with its position and length in the text), pause, resume
 * and end. This turns exactly those into mouth shapes:
 *   - nothing moves before the first word, and everything stops at once on end / pause / error / cancel;
 *   - the engine reports events a little BEFORE the sound is audible (measured about 0.2 s on this PC), so each event is applied
 *     that much later (AUDIO_LAG_MS), which is what lines the mouth up with the sound;
 *   - inside a word the mouth follows its letters (vowels open, lip sounds close) at the speed the voice is really speaking,
 *     learned from the gaps between the engine's own word events, so slow and fast voices both stay in time;
 *   - once a word has had its time and no new word has started, the mouth closes (pauses and the end of sentences).
 * There is no repeating animation: with no events there is no movement.
 */
export type Viseme = keyof typeof VISEMES;
export interface MouthLevel { open: number; round: number; wide: number }
export type MouthEvent =
  | { type: "start"; text: string; rate?: number }
  | { type: "boundary"; index: number; length?: number }
  | { type: "pause" } | { type: "resume" }
  | { type: "interrupt" }
  | { type: "end" };

/** how long the engine's events run ahead of audible sound (measured against the system audio output) */
export const AUDIO_LAG_MS = 175;
const MIN_MS_PER_CHAR = 45, MAX_MS_PER_CHAR = 220, FIRST_MS_PER_CHAR = 90;
/** a word's mouth keeps moving a little after its estimated end (the sound trails off) */
const TAIL_CHARS = 0.7;

const VOWEL: Record<string, Viseme> = { a: "a", e: "e", i: "i", y: "i", o: "o", u: "u" };
const LIPS = new Set(["m", "b", "p"]);

/** The mouth shape for one character: how open, and which shape. */
export function charShape(ch: string): { open: number; round: number; wide: number } {
  const c = ch.toLowerCase();
  const v = VOWEL[c];
  if (v) return VISEMES[v];
  if (LIPS.has(c)) return { open: 0, round: 0, wide: 1 };
  if (c === "f" || c === "v") return { open: 0.1, round: 0, wide: 1 };
  if (c === "w" || c === "q") return { open: 0.3, round: 0.8, wide: 0.8 };
  if (/[0-9]/.test(c)) return { open: 0.45, round: 0.1, wide: 1 };
  if (/[a-z]/.test(c)) return { open: 0.2, round: 0, wide: 1 };
  return { open: 0, round: 0, wide: 1 }; // space, punctuation
}

/** The viseme (vowel shape) at/after `idx`, a closed mouth on a pause. Kept for tests and tools. */
export function visemeAt(text: string, idx: number): Viseme {
  const lower = text.toLowerCase();
  for (let i = Math.max(0, idx); i < Math.min(lower.length, idx + 4); i++) {
    const ch = lower[i];
    if (VOWEL[ch]) return VOWEL[ch];
    if (/[,.;:!?]/.test(ch)) return "m";
  }
  return "m";
}

interface Word { idx: number; len: number; at: number }

export class MouthSync {
  private text = "";
  private rate = 1;
  /** when the sound of this utterance can first be heard (start event time + lag) */
  private audibleAt = 0;
  private words: Word[] = [];
  private msPerChar = FIRST_MS_PER_CHAR;
  private paused = false;
  private _speaking = false;
  private listeners = new Set<() => void>();
  constructor(private lagMs = AUDIO_LAG_MS) {}

  get speaking(): boolean { return this._speaking; }
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  private emit() { for (const l of this.listeners) l(); }
  private setSpeaking(v: boolean) { if (this._speaking !== v) { this._speaking = v; this.emit(); } }

  /** Speaker events. `now` is injectable for tests. */
  handle = (e: MouthEvent, now = performance.now()): void => {
    switch (e.type) {
      case "start":
        // a new utterance (or the next chunk of a long one): its words start from scratch, the learned speed is kept
        this.text = e.text; this.rate = e.rate ?? 1; this.words = []; this.paused = false;
        this.audibleAt = now + this.lagMs;
        if (!this._speaking) this.msPerChar = FIRST_MS_PER_CHAR / Math.max(0.6, this.rate);
        this.setSpeaking(true);
        break;
      case "boundary": {
        if (!this._speaking || this.paused) break;
        const len = Math.max(1, e.length ?? this.wordLength(e.index));
        const prev = this.words[this.words.length - 1];
        // the voice's real speed: time between two different word starts / characters between them
        if (prev && e.index > prev.idx && now - prev.at > 30) {
          const per = (now - prev.at) / (e.index - prev.idx);
          this.msPerChar = Math.min(MAX_MS_PER_CHAR, Math.max(MIN_MS_PER_CHAR, this.msPerChar * 0.6 + per * 0.4));
        }
        this.words.push({ idx: e.index, len, at: now + this.lagMs });
        if (this.words.length > 64) this.words.shift();
        break;
      }
      case "interrupt": this.words = []; this.paused = false; this.audibleAt = now + 1e9; break; // closed until the next utterance starts
      case "pause": this.paused = true; break;
      case "resume": this.paused = false; break;
      case "end": // also used for errors and cancellation
        this.words = []; this.paused = false;
        this.setSpeaking(false);
        break;
    }
  };

  private wordLength(idx: number): number {
    const m = this.text.slice(idx).match(/^\S+/);
    return m ? m[0].length : 1;
  }

  /** The mouth right now, or null when Momo is not speaking (the mouth is then left to the expression). */
  level(now = performance.now()): MouthLevel | null {
    if (!this._speaking) return null;
    if (this.paused || now < this.audibleAt) return { open: 0, round: 0, wide: 1 };
    // the latest word whose sound has begun
    let w: Word | undefined;
    for (let i = this.words.length - 1; i >= 0; i--) if (this.words[i].at <= now) { w = this.words[i]; break; }
    if (!w) return { open: 0, round: 0, wide: 1 };
    const progress = (now - w.at) / this.msPerChar; // characters of this word already said
    if (progress > w.len + TAIL_CHARS) return { open: 0, round: 0, wide: 1 }; // the word is over: closed until the next one
    const pos = w.idx + Math.min(progress, w.len - 0.001);
    const i0 = Math.floor(pos), f = pos - i0;
    const a = charShape(this.text[i0] ?? " "), b = charShape(this.text[i0 + 1] ?? " ");
    const s = f * f * (3 - 2 * f); // smoothstep between neighbouring letters: no snapping
    const out = { open: a.open + (b.open - a.open) * s, round: a.round + (b.round - a.round) * s, wide: a.wide + (b.wide - a.wide) * s };
    // the word's last letter relaxes into the pause
    if (progress > w.len - 0.5) out.open *= Math.max(0, 1 - (progress - (w.len - 0.5)) / (0.5 + TAIL_CHARS));
    return out;
  }
}
