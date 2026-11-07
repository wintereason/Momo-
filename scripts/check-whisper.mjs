// Dev check: downloads the Whisper model (cached on D:) and times a transcription in Node.
// Run with:  node --dns-result-order=ipv4first scripts/check-whisper.mjs [model] [dtype]
// (ipv4first because some networks reset IPv6 connections to huggingface.co)
import { pipeline, env } from "@huggingface/transformers";

const model = process.argv[2] || "Xenova/whisper-base";
const dtype = process.argv[3] || "q8";
env.cacheDir = "D:/dev-cache/hf";
env.allowLocalModels = false;

const t0 = Date.now();
let last = 0;
const asr = await pipeline("automatic-speech-recognition", model, {
  dtype,
  progress_callback: (p) => {
    if (p.status === "progress" && Date.now() - last > 5000) {
      last = Date.now();
      console.log(`  ${p.file} ${Math.round(p.progress)}%`);
    }
  },
});
console.log(`${model} (${dtype}) loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);

// noise-like 5 s clip, just to time the decoder; two runs so the second is warm
const audio = Float32Array.from({ length: 16000 * 5 }, (_, i) => Math.sin(i / 20) * 0.05 * Math.sin(i / 4000));
for (const run of [1, 2]) {
  const t = Date.now();
  const out = await asr(audio, { task: "transcribe", language: "en" });
  console.log(`run ${run}: 5 s of audio in ${((Date.now() - t) / 1000).toFixed(1)}s ->`, JSON.stringify(out.text));
}
console.log("peak rss MB", Math.round(process.memoryUsage().rss / 1e6));
