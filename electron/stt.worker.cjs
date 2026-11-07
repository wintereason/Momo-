// Speech recognition worker (runs in its own thread inside Momo's main process, so the app stays responsive).
// Whisper runs NATIVELY here (ONNX Runtime for Node): about five times faster than the in-page WebAssembly version.
// The audio arrives in memory, is recognised, and is discarded. The only network use is the one-time model download,
// and it is restricted to the model hub by the same allowlist the pages use (netpolicy.cjs).
const { parentPort, workerData } = require("node:worker_threads");
const { makeAllowedRequest } = require("./netpolicy.cjs");

const MODEL_ID = "Xenova/whisper-base";
const allowed = makeAllowedRequest(null);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
  if (!allowed(url)) return Promise.reject(new TypeError("blocked destination"));
  return realFetch(input, init);
};

let asr = null;
const post = (m) => parentPort.postMessage(m);

parentPort.on("message", async (m) => {
  if (m.type === "load") {
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = workerData.cacheDir; // the downloaded model lives here, inside Momo's own data folder
      env.allowLocalModels = false;
      asr = await pipeline("automatic-speech-recognition", MODEL_ID, {
        dtype: "q8", // quantized: about half the download and RAM of full precision
        session_options: { intraOpNumThreads: Math.max(2, Math.min(4, workerData.cores - 2)) },
        progress_callback: (p) => post({ type: "progress", p }),
      });
      // the first run compiles things; do it now, on silence, so the user's first sentence is quick
      try { await asr(new Float32Array(16000), { task: "transcribe", language: "en" }); } catch { /* harmless */ }
      post({ type: "ready" });
    } catch (err) {
      post({ type: "load-error", message: String((err && err.message) || err) });
    }
  } else if (m.type === "transcribe") {
    try {
      if (!asr) throw new Error("model not loaded");
      const out = await asr(m.audio, { task: "transcribe", language: m.language, chunk_length_s: 30 });
      post({ type: "result", id: m.id, text: String((out && out.text) || "").trim() });
    } catch (err) {
      post({ type: "result-error", id: m.id, message: String((err && err.message) || err) });
    }
  }
});
