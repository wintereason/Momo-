/// <reference lib="webworker" />
// Local Whisper (multilingual) in a Web Worker so transcription never blocks the UI.
import { pipeline, env } from "@huggingface/transformers";

export const MODEL_ID = "Xenova/whisper-base";

type In =
  | { type: "load"; wasmPaths: string }
  | { type: "transcribe"; id: number; audio: Float32Array; language: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asr: any = null;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === "load") {
    try {
      env.allowLocalModels = false; // the only network use: one-time model download from the model hub
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (env.backends.onnx as any).wasm.wasmPaths = m.wasmPaths; // bundled locally, no CDN
      asr = await pipeline("automatic-speech-recognition", MODEL_ID, {
        device: "wasm",
        dtype: "q8", // quantized: about half the download and RAM of full precision
        progress_callback: (p: unknown) => post({ type: "progress", p }),
      });
      // the first run is slow (the engine compiles its code); do it now, on silence, so the user's first sentence is quick
      try { await asr(new Float32Array(16000), { task: "transcribe", language: "en" }); } catch { /* a failed warm-up is harmless */ }
      post({ type: "ready" });
    } catch (err) {
      post({ type: "load-error", message: String((err as Error)?.message ?? err) });
    }
  } else if (m.type === "transcribe") {
    try {
      if (!asr) throw new Error("model not loaded");
      // This library does not auto-detect the language: it is chosen in Settings (default English).
      const out = await asr(m.audio, { task: "transcribe", language: m.language, chunk_length_s: 30 });
      post({ type: "result", id: m.id, text: String(out?.text ?? "").trim() });
    } catch (err) {
      post({ type: "result-error", id: m.id, message: String((err as Error)?.message ?? err) });
    }
  }
};
