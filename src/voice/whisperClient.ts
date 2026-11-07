import { ProgressAggregator, type DownloadProgress } from "./progress";
import { SttError, type SttAdapter } from "./stt";
import { desktop } from "../desktop";
import { NativeWhisperClient } from "./nativeWhisper";

export type ModelState = "idle" | "loading" | "ready" | "error";

const IDLE_UNLOAD_MS = 10 * 60_000; // free the model's RAM when Momo hasn't listened for a while
const CACHE_NAME = "transformers-cache";
const MODEL_MARK = "Xenova/whisper-base";

/** What the rest of the app needs from a speech recognizer (the native one in the desktop app, or the in-page one). */
export interface SpeechClient {
  state: ModelState;
  lastError: string;
  subscribe(fn: () => void): () => void;
  isCached(): Promise<boolean>;
  load(onProgress?: (p: DownloadProgress) => void): Promise<void>;
  transcribe(audio: Float32Array, language?: string): Promise<string>;
  unload(): void;
}

/** Main-thread handle to the Whisper worker. Loads lazily; unloads itself when idle. */
export class WhisperClient implements SpeechClient {
  state: ModelState = "idle";
  lastError = "";
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private pending = new Map<number, { resolve(t: string): void; reject(e: Error): void }>();
  private seq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private set(state: ModelState): void { this.state = state; this.listeners.forEach((l) => l()); }

  /** Is the model already stored locally (no download needed)? */
  async isCached(): Promise<boolean> {
    try {
      if (typeof caches === "undefined") return false;
      const c = await caches.open(CACHE_NAME);
      return (await c.keys()).some((r) => r.url.includes(MODEL_MARK));
    } catch { return false; }
  }

  load(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.loading) return this.loading;
    this.set("loading");
    this.lastError = "";
    const agg = new ProgressAggregator();
    this.loading = new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
      this.worker = w;
      w.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === "progress") onProgress?.(agg.update(m.p ?? {}));
        else if (m.type === "ready") { this.set("ready"); this.armIdle(); resolve(); }
        else if (m.type === "load-error") { this.fail(m.message); reject(new Error(m.message)); }
        else if (m.type === "result" || m.type === "result-error") {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.type === "result") p?.resolve(m.text); else p?.reject(new Error(m.message));
          this.armIdle();
        }
      };
      w.onerror = (e) => { this.fail(e.message || "worker error"); reject(new Error(e.message || "worker error")); };
      w.postMessage({ type: "load", wasmPaths: new URL("ort/", document.baseURI).href });
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  async transcribe(audio: Float32Array, language = "en"): Promise<string> {
    await this.load();
    this.clearIdle();
    const id = ++this.seq;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ type: "transcribe", id, audio, language }, [audio.buffer]);
    });
  }

  /** Terminate the worker and release the model from memory. */
  unload(): void {
    this.clearIdle();
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach((p) => p.reject(new Error("unloaded")));
    this.pending.clear();
    this.loading = null;
    this.set("idle");
  }

  private fail(message: string): void {
    this.lastError = message;
    this.worker?.terminate();
    this.worker = null;
    this.set("error");
  }
  private armIdle(): void { this.clearIdle(); this.idleTimer = setTimeout(() => this.unload(), IDLE_UNLOAD_MS); }
  private clearIdle(): void { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = null; }
}

/** In the desktop app speech is recognised natively by the shell (fast); in a plain browser the in-page engine is used. */
export const whisper: SpeechClient = desktop?.sttTranscribe ? new NativeWhisperClient(desktop) : new WhisperClient();

export const MIN_SPEECH_SAMPLES = 16000 * 0.3;

/**
 * Whisper sometimes "hears" words in silence or noise: "(soft music)", "[BLANK_AUDIO]", "Thank you.", "Thanks for
 * watching!". Those are not what the user said, so they are dropped (an empty result means "I didn't catch that").
 */
export function cleanTranscript(text: string, seconds: number): string {
  const t = text.trim();
  if (!t) return "";
  if (/^[\(\[\{].*[\)\]\}]$/s.test(t)) return ""; // a sound description: "(soft music)", "[BLANK_AUDIO]"
  if (seconds < 3 && /^(thank you|thanks|thanks for watching|thank you for watching|bye|you|okay|ok)[.!\s]*$/i.test(t)) return "";
  return t;
}

/** Local speech-to-text: audio never leaves this computer. */
export function createWhisperAdapter(client: SpeechClient = whisper, getLanguage: () => string = () => "en"): SttAdapter {
  return {
    id: "whisper-local",
    label: "Local Whisper (private)",
    disclosure:
      "Speech is transcribed on this computer. Your audio never leaves it. The recognition model (about 75 MB) is downloaded once from huggingface.co and then works offline.",
    available: () => typeof Worker !== "undefined",
    begin() {
      return {
        async stop(audio) {
          if (!audio || audio.length < MIN_SPEECH_SAMPLES) return "";
          try {
            return cleanTranscript(await client.transcribe(audio, getLanguage()), audio.length / 16000);
          } catch {
            throw new SttError("stt_failed", "Local transcription failed.");
          }
        },
        cancel() { /* nothing is streamed; the captured audio is simply dropped */ },
      };
    },
  };
}
