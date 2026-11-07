import type { DownloadProgress } from "./progress";
import type { MomoDesktop } from "../desktop";
import type { ModelState, SpeechClient } from "./whisperClient";

/**
 * Speech recognition done by the desktop shell: Whisper runs natively on this PC, about five times faster than the
 * in-page WebAssembly version. The page only hands over 16 kHz audio (in memory) and gets text back.
 */
export class NativeWhisperClient implements SpeechClient {
  state: ModelState = "idle";
  lastError = "";
  private loading: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(private shell: Pick<MomoDesktop, "sttStatus" | "sttLoad" | "sttTranscribe">) {}

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private set(state: ModelState): void { this.state = state; this.listeners.forEach((l) => l()); }

  async isCached(): Promise<boolean> {
    try { return (await this.shell.sttStatus())?.cached === true; } catch { return false; }
  }

  load(onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.loading) return this.loading;
    this.set("loading");
    this.lastError = "";
    this.loading = this.shell.sttLoad(onProgress).then((r) => {
      if (!r.ok) { this.lastError = r.error ?? "unknown error"; this.set("error"); throw new Error(this.lastError); }
      this.set("ready");
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  async transcribe(audio: Float32Array, language = "en"): Promise<string> {
    await this.load();
    const r = await this.shell.sttTranscribe(audio, language);
    if (!r.ok) {
      // the shell may have released the model after idle time: the next call loads it again
      this.set("idle");
      throw new Error(r.reason ?? "transcription failed");
    }
    return r.text ?? "";
  }

  /** The shell frees the model by itself after a few idle minutes; this only forgets what the page believes. */
  unload(): void { this.set("idle"); }
}
