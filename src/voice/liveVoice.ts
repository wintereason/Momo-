import { MIC_MESSAGES, MicError, type MicSession } from "./micSession";
import { SttError, type SttAdapter, type SttSession } from "./stt";

type Emit = (event: unknown) => void;

/**
 * Connects the microphone and speech-to-text to the typed runtime event contract:
 * voice.started -> voice.stopped -> transcript.ready (or runtime.error).
 * One session at a time; a stop that arrives while the mic permission prompt is still open
 * (hold mode released early) is honoured as soon as capture begins.
 */
export class LiveVoice {
  private seq = 0;
  private sid = "";
  private stt: SttSession | null = null;
  private starting = false;
  private pendingStop = false;
  private cancelled = false;

  constructor(
    private emit: Emit,
    private mic: MicSession,
    private adapter: () => SttAdapter,
    /** called with the real transcript once it is ready */
    private onTranscript: (sessionId: string, text: string) => void,
    private deviceId: () => string | null = () => null,
    /** keep recording this long after the user lets go, so the last word is not cut off */
    private tailMs = 0,
  ) {}

  get busy(): boolean {
    return this.starting || this.sid !== "";
  }

  async start(): Promise<void> {
    if (this.busy) return;
    this.starting = true;
    this.pendingStop = false;
    this.cancelled = false;
    const sid = `v${++this.seq}`;
    try {
      await this.mic.start(this.deviceId());
      this.stt = this.adapter().begin();
    } catch (e) {
      this.starting = false;
      this.mic.cancel();
      this.fail(e);
      return;
    }
    this.starting = false;
    if (this.cancelled) { this.cleanup(); return; }
    this.sid = sid;
    this.emit({ type: "voice.started", sessionId: sid });
    if (this.pendingStop) await this.stop();
  }

  async stop(): Promise<void> {
    if (this.starting) { this.pendingStop = true; return; }
    if (!this.sid) return;
    if (this.tailMs > 0) {
      await new Promise((r) => setTimeout(r, this.tailMs));
      if (!this.sid || this.cancelled) return; // cancelled (or stopped by someone else) while waiting
    }
    const sid = this.sid;
    const stt = this.stt;
    const result = this.mic.stop();
    this.stt = null;
    this.emit({ type: "voice.stopped", sessionId: sid });
    try {
      if (result.empty) {
        stt?.cancel();
        throw new SttError("empty_audio", MIC_MESSAGES.empty_audio);
      }
      const text = (await stt!.stop(result.audio)).trim();
      if (this.cancelled) return;
      if (!text) throw new SttError("empty_audio", MIC_MESSAGES.empty_audio);
      this.emit({ type: "transcript.ready", sessionId: sid, text });
      this.sid = "";
      this.onTranscript(sid, text);
    } catch (e) {
      this.sid = "";
      if (!this.cancelled) this.fail(e);
    }
    this.sid = "";
  }

  cancel(): void {
    this.cancelled = true;
    this.pendingStop = false;
    this.cleanup();
  }

  private cleanup(): void {
    this.stt?.cancel();
    this.stt = null;
    this.mic.cancel();
    this.sid = "";
  }

  /** Device unplugged mid-recording. */
  deviceLost(): void {
    this.cancelled = true;
    this.cleanup();
    this.emit({ type: "runtime.error", code: "mic_unavailable", message: MIC_MESSAGES.mic_unavailable });
  }

  private fail(e: unknown): void {
    if (e instanceof MicError || e instanceof SttError) {
      this.emit({ type: "runtime.error", code: e.code, message: MIC_MESSAGES[e.code] });
    } else {
      this.emit({ type: "runtime.error", code: "stt_failed", message: MIC_MESSAGES.stt_failed });
    }
  }
}
