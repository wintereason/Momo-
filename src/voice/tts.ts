/**
 * Spoken replies. Uses the voices installed on this PC through the browser's speech synthesis
 * (Windows voices): nothing is sent over the network.
 */

/** Make a written result sound natural when read aloud. */
export function speechText(raw: string, maxChars = 260): string {
  let t = raw
    .replace(/[“”"]/g, "")
    .replace(/✓|✔|·/g, ",")
    .replace(/\((verified|checked on disk)\)\.?/gi, "")
    .replace(/\b([A-Za-z]):\\/g, "$1 drive, ") // C:\Users\me -> "C drive, Users, me"
    .replace(/\\+/g, ", ")
    .replace(/\b(\d+(?:\.\d+)?)\s*TB\b/g, "$1 terabytes")
    .replace(/\b(\d+(?:\.\d+)?)\s*GB\b/g, "$1 gigabytes")
    .replace(/\b(\d+(?:\.\d+)?)\s*MB\b/g, "$1 megabytes")
    .replace(/\b([A-Z]):(?=\s)/g, "$1 drive") // "D: has" -> "D drive has"
    .replace(/\b(\d)\)\s+/g, "option $1, ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;?])/g, "$1")
    .trim();
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(", "));
    t = (end > maxChars * 0.5 ? cut.slice(0, end) : cut).trim() + ".";
  }
  return t;
}

export interface VoiceLike {
  voiceURI: string;
  name: string;
  lang: string;
  localService?: boolean;
}

/** The chosen voice, else the best installed voice for the language (local ones first), else the system default. */
export function pickVoice<V extends VoiceLike>(voices: V[], voiceURI: string | null, lang: string): V | undefined {
  if (voiceURI) {
    const chosen = voices.find((v) => v.voiceURI === voiceURI);
    if (chosen) return chosen;
  }
  const want = lang.toLowerCase().slice(0, 2);
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(want));
  return matching.find((v) => v.localService) ?? matching[0];
}

export interface SynthLike {
  speak(u: unknown): void;
  cancel(): void;
  getVoices(): VoiceLike[];
}
export type UtteranceCtor = new (text: string) => { rate: number; lang: string; voice: unknown; volume: number };

export interface SpeakOptions {
  voiceURI: string | null;
  /** 0.6 .. 1.6 */
  rate: number;
  /** spoken language code, e.g. "en", "hi" */
  lang: string;
}

export class Speaker {
  constructor(
    private synth: SynthLike | null = typeof window !== "undefined" ? (window.speechSynthesis as unknown as SynthLike) ?? null : null,
    private Utterance: UtteranceCtor | null = typeof window !== "undefined"
      ? ((window as unknown as { SpeechSynthesisUtterance?: UtteranceCtor }).SpeechSynthesisUtterance ?? null)
      : null,
  ) {}

  get available(): boolean {
    return !!this.synth && !!this.Utterance;
  }

  voices(): VoiceLike[] {
    return this.synth?.getVoices() ?? [];
  }

  /** Speak `text`, replacing anything still being said (or, with replace=false, after it). Returns false if nothing was spoken. */
  speak(text: string, o: SpeakOptions, replace = true): boolean {
    const spoken = speechText(text);
    if (!this.synth || !this.Utterance || !spoken) return false;
    if (replace) this.synth.cancel();
    const u = new this.Utterance(spoken);
    u.rate = Math.min(1.6, Math.max(0.6, Number.isFinite(o.rate) ? o.rate : 1));
    u.volume = 1;
    const voice = pickVoice(this.synth.getVoices(), o.voiceURI, o.lang);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = o.lang;
    this.synth.speak(u);
    return true;
  }

  /** Stop talking (e.g. as soon as the user starts speaking). */
  stop(): void {
    this.synth?.cancel();
  }
}
