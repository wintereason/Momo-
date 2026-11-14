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

/**
 * The chosen voice, else an installed voice for the language (local ones first), else the system default. When no voice is chosen,
 * `prefer` (name fragments, tried in order) and `slot` let each avatar get a different voice of its own: the first preferred name that is
 * installed wins; failing that, the avatar takes the voice at its slot number among the installed ones (so two avatars never share a
 * voice while at least two are installed).
 */
export function pickVoice<V extends VoiceLike>(voices: V[], voiceURI: string | null, lang: string, prefer: readonly string[] = [], slot = 0): V | undefined {
  if (voiceURI) {
    const chosen = voices.find((v) => v.voiceURI === voiceURI);
    if (chosen) return chosen;
  }
  const want = lang.toLowerCase().slice(0, 2);
  const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(want));
  const ordered = [...matching.filter((v) => v.localService), ...matching.filter((v) => !v.localService)];
  for (const name of prefer) {
    const hit = ordered.find((v) => v.name.toLowerCase().includes(name.toLowerCase()));
    if (hit) return hit;
  }
  if (!ordered.length) return undefined;
  return ordered[((slot % ordered.length) + ordered.length) % ordered.length];
}

export interface SynthLike {
  speak(u: unknown): void;
  cancel(): void;
  getVoices(): VoiceLike[];
  pause?(): void;
  resume?(): void;
  /** the engine's own view of itself (the truth when an event goes missing) */
  readonly speaking?: boolean;
  readonly pending?: boolean;
  readonly paused?: boolean;
}
export type UtteranceCtor = new (text: string) => { rate: number; lang: string; voice: unknown; volume: number; pitch?: number };

export interface SpeakOptions {
  voiceURI: string | null;
  /** 0.6 .. 1.6 */
  rate: number;
  /** spoken language code, e.g. "en", "hi" */
  lang: string;
  /** 0.5 .. 1.8 (1 = the voice's own pitch) */
  pitch?: number;
  /** how much of a long text is read aloud (default 260 characters: the full text stays on screen) */
  maxChars?: number;
  /** with no voice chosen: name fragments to prefer, and the voice slot to fall back to (see pickVoice) */
  prefer?: readonly string[];
  slot?: number;
  /** an online voice to use for this speech when an online engine is attached (see Speaker.setOnline); falls back to the local voice */
  onlineVoiceId?: string;
}

/** An online speech engine: text + voice id -> audio (mp3 bytes), or the reason it could not be used. It never sees a key: the desktop shell holds it. */
export interface OnlineTts {
  synth(text: string, voiceId: string): Promise<{ ok: true; audio: Uint8Array } | { ok: false; reason: string }>;
}
/** A clip that is playing: its length in real seconds, how far it has got, and the controls. `onEnded` fires once when it finishes by itself. */
export interface OnlineClip {
  duration: number;
  position(): number;
  pause(): void;
  resume(): void;
  stop(): void;
  onEnded(cb: () => void): void;
}
/** Decode and start playing mp3 bytes at `rate`. Rejects if the audio cannot be decoded or played. */
export type OnlinePlayer = (audio: Uint8Array, rate: number) => Promise<OnlineClip>;

/**
 * The real player: Web Audio. The bytes stay in memory (no file, no URL): they are decoded and played straight away. Pausing suspends the
 * audio clock, so position() simply stops moving.
 */
export function webAudioPlayer(): OnlinePlayer | null {
  const w = typeof window !== "undefined" ? (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }) : null;
  const AC = w?.AudioContext ?? w?.webkitAudioContext;
  if (!AC) return null;
  let ctx: AudioContext | null = null;
  return async (audio, rate) => {
    ctx ??= new AC();
    const c = ctx;
    if (c.state === "suspended") await c.resume();
    const buf = await c.decodeAudioData(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(c.destination);
    const startedAt = c.currentTime;
    let cb: (() => void) | null = null, done = false;
    src.onended = () => { if (!done) { done = true; cb?.(); } };
    src.start();
    return {
      duration: buf.duration / rate,
      position: () => c.currentTime - startedAt,
      pause: () => { void c.suspend(); },
      resume: () => { void c.resume(); },
      stop: () => { done = true; try { src.onended = null; src.stop(); } catch { /* already finished */ } if (c.state === "suspended") void c.resume(); },
      onEnded: (f) => { cb = f; },
    };
  };
}
/** the speech events come out this much earlier than the sound so that MouthSync's own lag lines the mouth up with what is heard */
const ONLINE_LEAD_S = 0.175;

/**
 * What the Speaker reports while it talks, straight from the speech engine's own events (used to move the character's mouth in
 * time with the real playback). `index` / `length` locate the word being started inside `text`.
 */
export type SpeechEvent =
  | { type: "start"; text: string; rate: number }
  | { type: "boundary"; index: number; length?: number }
  | { type: "pause" } | { type: "resume" }
  /** the speech being said was cut off by a newer one: the mouth closes now, the new speech starts it again */
  | { type: "interrupt" }
  | { type: "end" };

/** long replies are spoken in sentence-sized pieces: engines stall or drop events on very long utterances */
export const CHUNK_CHARS = 220;
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  if (text.length <= max * 1.4) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max * 1.4) {
    const cut = rest.slice(0, max * 1.2);
    let at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf("; "));
    if (at < max * 0.4) at = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf(" "));
    if (at < 1) at = max;
    out.push(rest.slice(0, at + 1).trim());
    rest = rest.slice(at + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

export class Speaker {
  private listener: ((e: SpeechEvent) => void) | null = null;
  /** every piece of speech still to be heard; "end" is reported only when this becomes empty */
  private pending = new Set<object>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;
  private online: OnlineTts | null = null;
  private onlineClip: OnlineClip | null = null;
  private onlineTimer: ReturnType<typeof setInterval> | null = null;
  private onlineBusy = false;
  /** why the last online speech fell back to the local voice (null when it worked or was never tried) */
  lastOnlineError: string | null = null;
  constructor(
    private synth: SynthLike | null = typeof window !== "undefined" ? (window.speechSynthesis as unknown as SynthLike) ?? null : null,
    private Utterance: UtteranceCtor | null = typeof window !== "undefined"
      ? ((window as unknown as { SpeechSynthesisUtterance?: UtteranceCtor }).SpeechSynthesisUtterance ?? null)
      : null,
    private now: () => number = () => Date.now(),
    private player: OnlinePlayer | null = webAudioPlayer(),
  ) {}

  /** Attach (or remove) an online voice engine. Speech that asks for an onlineVoiceId uses it; on any failure the local voice speaks instead. */
  setOnline(o: OnlineTts | null): void { this.online = o; }

  /** Hear when speech starts, passes each word, pauses, resumes and ends. One listener; pass null to remove it. */
  listen(cb: ((e: SpeechEvent) => void) | null): void {
    this.listener = cb;
  }
  private emit(e: SpeechEvent) { try { this.listener?.(e); } catch { /* a listener must never break speech */ } }

  get available(): boolean {
    return (!!this.synth && !!this.Utterance) || !!this.online;
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  voices(): VoiceLike[] {
    return this.synth?.getVoices() ?? [];
  }

  /** Everything is over (finished, failed or cancelled): tell the listener exactly once and stop watching. */
  private finishAll() {
    this.pending.clear();
    this.onlineBusy = false;
    this.stopWatchdog();
    this.emit({ type: "end" });
  }
  private startWatchdog() {
    if (this.watchdog || typeof setInterval === "undefined") return;
    // If the engine says it is silent while we still wait for an "end" that never came (it happens with long or interrupted
    // speech), finish ourselves so the mouth can never stay open on a silent character.
    this.watchdog = setInterval(() => {
      if (!this.pending.size) return this.stopWatchdog();
      if (this.onlineBusy) return; // an online voice is being fetched or played: the Windows engine is silent on purpose
      const s = this.synth;
      if (!s || s.paused) return;
      if (s.speaking === false && s.pending === false && this.now() - this.lastActivity > 1500) this.finishAll();
    }, 400);
  }
  private stopWatchdog() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  /** Speak `text`, replacing anything still being said (or, with replace=false, after it). Returns false if nothing was spoken. */
  speak(text: string, o: SpeakOptions, replace = true): boolean {
    const spoken = speechText(text, o.maxChars);
    if (!spoken) return false;
    if (o.onlineVoiceId && this.online && !o.voiceURI && this.player) return this.speakOnline(spoken, o, replace);
    return this.speakLocal(spoken, o, replace);
  }

  /** Speak with the online engine; if it fails (no key, offline, limit, audio that cannot be played) the same text is spoken with the local voice. */
  private speakOnline(spoken: string, o: SpeakOptions, replace: boolean): boolean {
    if (replace) { const was = this.pending.size > 0; this.pending.clear(); this.synth?.cancel(); this.stopOnlineClip(); if (was) this.emit({ type: "interrupt" }); }
    const token = {};
    this.pending.add(token);
    this.onlineBusy = true;
    this.lastActivity = this.now();
    this.startWatchdog();
    const fallBack = (why: string) => {
      this.lastOnlineError = why;
      this.onlineBusy = false;
      this.pending.delete(token);
      if (!this.speakLocal(spoken, { ...o, onlineVoiceId: undefined }, false) && this.pending.size === 0) this.finishAll();
    };
    void (async () => {
      let r: Awaited<ReturnType<OnlineTts["synth"]>>;
      try { r = await this.online!.synth(spoken, o.onlineVoiceId!); } catch { r = { ok: false, reason: "The online voice could not be used." }; }
      if (!this.pending.has(token)) return; // stopped or replaced while the audio was being made
      if (!r.ok) return fallBack(r.reason);
      let clip: OnlineClip;
      try { clip = await this.player!(r.audio, Math.min(1.5, Math.max(0.7, Number.isFinite(o.rate) ? o.rate : 1))); } catch { return fallBack("The online voice audio could not be played."); }
      if (!this.pending.has(token)) { try { clip.stop(); } catch { /* ignore */ } return; } // stopped while decoding
      this.onlineClip = clip;
      this.lastOnlineError = null;
      const words = [...spoken.matchAll(/\S+/g)].map((m) => ({ idx: m.index ?? 0, len: m[0].length }));
      let next = 0;
      clip.onEnded(() => { if (this.onlineClip !== clip) return; this.stopOnlineClip(); this.onlineBusy = false; if (this.pending.delete(token) && this.pending.size === 0) this.finishAll(); });
      this.emit({ type: "start", text: spoken, rate: 1 });
      // the engine gives no word timings: words are spread over the real duration of the audio by their position in the text
      this.onlineTimer = setInterval(() => {
        if (this.onlineClip !== clip) return;
        const t = clip.position() + ONLINE_LEAD_S;
        while (next < words.length && (words[next].idx / spoken.length) * clip.duration <= t) { this.emit({ type: "boundary", index: words[next].idx, length: words[next].len }); next++; }
      }, 40);
    })();
    return true;
  }
  private stopOnlineClip() {
    if (this.onlineTimer) { clearInterval(this.onlineTimer); this.onlineTimer = null; }
    const c = this.onlineClip; this.onlineClip = null;
    if (c) { try { c.stop(); } catch { /* already gone */ } }
  }

  private speakLocal(spoken: string, o: SpeakOptions, replace: boolean): boolean {
    if (!this.synth || !this.Utterance || !spoken) return false;
    // the previous speech is stopped FIRST and its late events are ignored, so two responses never share one animation
    if (replace) { const was = this.pending.size > 0; this.pending.clear(); this.synth.cancel(); if (was) this.emit({ type: "interrupt" }); }
    const voice = pickVoice(this.synth.getVoices(), o.voiceURI, o.lang, o.prefer, o.slot);
    for (const piece of chunkText(spoken)) {
      const u = new this.Utterance(piece);
      u.rate = Math.min(1.6, Math.max(0.6, Number.isFinite(o.rate) ? o.rate : 1));
      u.volume = 1;
      u.pitch = Math.min(1.8, Math.max(0.5, Number.isFinite(o.pitch) ? (o.pitch as number) : 1));
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = o.lang;
      const token = {};
      this.pending.add(token);
      const ev = u as unknown as {
        onstart: (() => void) | null; onend: (() => void) | null; onerror: (() => void) | null;
        onpause: (() => void) | null; onresume: (() => void) | null;
        onboundary: ((e: { charIndex?: number; charLength?: number; name?: string }) => void) | null;
      };
      const live = () => this.pending.has(token);
      ev.onstart = () => { if (live()) { this.lastActivity = this.now(); this.emit({ type: "start", text: piece, rate: u.rate }); } };
      ev.onboundary = (e) => {
        // only word starts move the mouth (engines also report sentence boundaries)
        if (live() && typeof e.charIndex === "number" && (e.name === undefined || e.name === "word")) {
          this.lastActivity = this.now();
          this.emit({ type: "boundary", index: e.charIndex, length: typeof e.charLength === "number" && e.charLength > 0 ? e.charLength : undefined });
        }
      };
      ev.onpause = () => { if (live()) this.emit({ type: "pause" }); };
      ev.onresume = () => { if (live()) { this.lastActivity = this.now(); this.emit({ type: "resume" }); } };
      const done = () => { if (!this.pending.delete(token)) return; this.lastActivity = this.now(); if (this.pending.size === 0) this.finishAll(); };
      ev.onend = done; ev.onerror = done;
      this.synth.speak(u);
    }
    this.lastActivity = this.now();
    this.startWatchdog();
    return true;
  }

  pause(): void { if (this.pending.size) { this.synth?.pause?.(); if (this.onlineClip) { this.onlineClip.pause(); this.emit({ type: "pause" }); } } }
  resume(): void { if (this.pending.size) { this.synth?.resume?.(); if (this.onlineClip) { this.onlineClip.resume(); this.emit({ type: "resume" }); } } }

  /** Stop talking (e.g. as soon as the user starts speaking). The mouth stops in the same instant. */
  stop(): void {
    const was = this.pending.size > 0;
    this.pending.clear();
    this.synth?.cancel();
    this.stopOnlineClip();
    this.onlineBusy = false;
    this.stopWatchdog();
    if (was) this.emit({ type: "end" });
  }
}
