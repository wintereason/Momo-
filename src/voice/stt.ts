/** Speech-to-text adapter boundary. The UI never depends on a particular provider. */
export class SttError extends Error {
  constructor(public code: "empty_audio" | "stt_failed" | "mic_denied", message: string) {
    super(message);
  }
}

export interface SttSession {
  /** Stop listening and resolve with the final transcript ("" if nothing was recognised). */
  stop(audio?: Float32Array | null): Promise<string>;
  cancel(): void;
}

export interface SttAdapter {
  readonly id: string;
  readonly label: string;
  /** Shown to the user before this adapter is used: where the audio goes. */
  readonly disclosure: string;
  available(): boolean;
  begin(): SttSession;
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Browser Web Speech API. NOT private: Chrome and Edge stream the audio to the vendor's
 * cloud speech service. Used only until the local (on-device) engine exists in the desktop shell.
 */
export const webSpeechAdapter: SttAdapter = {
  id: "web-speech",
  label: "Browser speech service",
  disclosure:
    "Your voice is sent to the browser vendor's cloud speech service (Google for Chrome, Microsoft for Edge) to be transcribed. Their retention policy applies, and Momo cannot delete it.",
  available: () => recognitionCtor() !== null,
  begin(): SttSession {
    const Ctor = recognitionCtor();
    if (!Ctor) throw new SttError("stt_failed", "Speech recognition is not available in this browser.");
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    let text = "";
    let error: SttError | null = null;
    let ended = false;
    let onEnd: (() => void) | null = null;

    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0].transcript + " ";
      }
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech") error = new SttError("empty_audio", "No speech detected.");
      else if (e.error === "not-allowed" || e.error === "service-not-allowed") error = new SttError("mic_denied", "Microphone blocked.");
      else if (e.error !== "aborted") error = new SttError("stt_failed", `Speech service error: ${e.error}`);
    };
    rec.onend = () => { ended = true; onEnd?.(); };
    rec.start();

    return {
      stop: () => new Promise<string>((resolve, reject) => {
        const finish = () => (error ? reject(error) : resolve(text.trim()));
        if (ended) return finish();
        onEnd = finish;
        setTimeout(() => { if (!ended) { rec.abort(); finish(); } }, 5000); // never hang
        rec.stop();
      }),
      cancel: () => { onEnd = null; try { rec.abort(); } catch { /* already stopped */ } },
    };
  },
};
