import { MAX_SECONDS, TARGET_RATE, concatChunks, resampleTo16k } from "./audio";

/**
 * Microphone session: one capture at a time, nothing recorded to disk.
 * Audio is only metered in memory (to detect silence); the stream is released on stop/cancel.
 */
export type MicErrorCode = "mic_denied" | "mic_unavailable" | "mic_failed";

export class MicError extends Error {
  constructor(public code: MicErrorCode, message: string) {
    super(message);
  }
}

export const MIC_MESSAGES: Record<MicErrorCode | "empty_audio" | "stt_failed", string> = {
  mic_denied: "Microphone access is blocked. Allow it in your browser/Windows privacy settings, then retry.",
  mic_unavailable: "No working microphone was found. Check that it is plugged in, then retry.",
  mic_failed: "The microphone could not be started.",
  empty_audio: "I didn't hear anything. Try again a little closer to the microphone.",
  stt_failed: "I couldn't turn that into text. You can retry.",
};

export function mapMicError(e: unknown): MicError {
  if (e instanceof MicError) return e;
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return new MicError("mic_denied", MIC_MESSAGES.mic_denied);
  if (["NotFoundError", "DevicesNotFoundError", "OverconstrainedError", "NotReadableError", "AbortError", "TrackStartError"].includes(name)) {
    return new MicError("mic_unavailable", MIC_MESSAGES.mic_unavailable);
  }
  return new MicError("mic_failed", MIC_MESSAGES.mic_failed);
}

export interface CapturedAudio { samples: Float32Array; sampleRate: number }

export interface MicDeps {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  /**
   * Start metering (and capturing, in memory only) a stream. The returned function stops it and
   * returns what was captured. Optional: without it silence isn't detected.
   */
  createMeter?(stream: MediaStream, onLevel: (level: number) => void): () => CapturedAudio | null;
  now(): number;
}

export interface MicResult {
  durationMs: number;
  peak: number;
  /** too short or silent */
  empty: boolean;
  /** 16 kHz mono samples, in memory only; null when capture is unavailable */
  audio: Float32Array | null;
}

export const MIN_DURATION_MS = 300;
export const SILENCE_PEAK = 0.02;

export class MicSession {
  private stream: MediaStream | null = null;
  private stopMeter: (() => CapturedAudio | null) | null = null;
  private startedAt = 0;
  private peak = 0;
  private starting = false;

  constructor(
    private deps: MicDeps,
    private onLevel: (level: number) => void = () => {},
    private onEnded: () => void = () => {},
  ) {}

  get active(): boolean {
    return this.stream !== null || this.starting;
  }

  async start(deviceId?: string | null): Promise<void> {
    if (this.active) throw new MicError("mic_failed", "A microphone session is already running.");
    this.starting = true;
    try {
      const stream = await this.deps.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      this.stream = stream;
      this.peak = 0;
      this.startedAt = this.deps.now();
      // Device unplugged mid-recording
      stream.getTracks().forEach((t) => t.addEventListener("ended", () => { if (this.stream === stream) this.onEnded(); }));
      this.stopMeter = this.deps.createMeter?.(stream, (l) => {
        this.peak = Math.max(this.peak, l);
        this.onLevel(l);
      }) ?? null;
    } catch (e) {
      throw mapMicError(e);
    } finally {
      this.starting = false;
    }
  }

  /** Release the device and report what was captured (metadata only; no audio is kept). */
  stop(): MicResult {
    const durationMs = this.deps.now() - this.startedAt;
    const peak = this.peak;
    const cap = this.release();
    const audio = cap ? resampleTo16k(cap.samples, cap.sampleRate) : null;
    const canDetectSilence = this.deps.createMeter !== undefined;
    return { durationMs, peak, audio, empty: durationMs < MIN_DURATION_MS || (canDetectSilence && peak < SILENCE_PEAK) };
  }

  cancel(): void {
    this.release();
  }

  private release(): CapturedAudio | null {
    const cap = this.stopMeter?.() ?? null;
    this.stopMeter = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.onLevel(0);
    return cap;
  }
}

/** Browser implementation of the dependencies. */
export function browserMicDeps(): MicDeps | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    now: () => performance.now(),
    createMeter(stream, onLevel) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return () => null;
      let ctx: AudioContext;
      try { ctx = new Ctx({ sampleRate: TARGET_RATE }); } catch { ctx = new Ctx(); }
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0; // the processor must be connected to run, but nothing is played back
      const chunks: Float32Array[] = [];
      let total = 0;
      proc.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        let max = 0;
        for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > max) max = v; }
        onLevel(max);
        if (total < ctx.sampleRate * MAX_SECONDS) { chunks.push(new Float32Array(d)); total += d.length; }
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      return () => {
        proc.onaudioprocess = null;
        src.disconnect(); proc.disconnect(); mute.disconnect();
        const rate = ctx.sampleRate;
        void ctx.close();
        return { samples: concatChunks(chunks, rate * MAX_SECONDS), sampleRate: rate };
      };
    },
  };
}

export async function listMicrophones(): Promise<{ id: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput" && d.deviceId)
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

/** Settings "Test microphone": capture ~2 s, report whether sound was detected, keep nothing. */
export async function testMicrophone(deviceId: string | null, ms = 2000): Promise<{ ok: true; heardSound: boolean } | { ok: false; code: MicErrorCode }> {
  const deps = browserMicDeps();
  if (!deps) return { ok: false, code: "mic_unavailable" };
  const s = new MicSession(deps);
  try {
    await s.start(deviceId);
    await new Promise((r) => setTimeout(r, ms));
    const r = s.stop();
    return { ok: true, heardSound: r.peak >= SILENCE_PEAK };
  } catch (e) {
    s.cancel();
    return { ok: false, code: mapMicError(e).code };
  }
}
