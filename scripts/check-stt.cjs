// Live check of Momo's native speech recognizer, with a sentence spoken by Windows' own voice:
//   node scripts/check-stt.cjs            (uses D:/dev-cache/hf if the model is there, else downloads it once)
// Prints the model load time, and the time and text of three transcriptions. Nothing is saved except the model cache.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createStt } = require("../electron/stt.cjs");

const cacheDir = process.env.MOMO_STT_CACHE || (fs.existsSync("D:/dev-cache/hf") ? "D:/dev-cache/hf" : path.join(require("node:os").tmpdir(), "momo-stt-cache"));
const wav = path.join(__dirname, "bench", "sample.wav");
if (!fs.existsSync(wav)) {
  spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "bench", "make-sample.ps1"), "-Out", wav, "-Text", "I went to the market yesterday and bought some vegetables, but the price was too high."], { stdio: "inherit" });
}
const pcm = fs.readFileSync(wav);
const samples = new Int16Array(pcm.buffer, pcm.byteOffset + 44, Math.floor((pcm.length - 44) / 2));
const audio = Float32Array.from(samples, (v) => v / 32768);

(async () => {
  console.log(`model cached: ${createStt({ cacheDir, workerPath: path.join(__dirname, "../electron/stt.worker.cjs") }).isCached()}, sample: ${(audio.length / 16000).toFixed(1)} s`);
  const stt = createStt({ cacheDir, workerPath: path.join(__dirname, "../electron/stt.worker.cjs") });
  let t = Date.now();
  await stt.load((p) => { if (p.percent % 25 === 0) console.log(`  download ${p.percent}% (${p.loadedMB}/${p.totalMB} MB)`); });
  console.log(`model load ${((Date.now() - t) / 1000).toFixed(1)} s`);
  for (let run = 1; run <= 3; run++) {
    t = Date.now();
    const text = await stt.transcribe(audio.slice(), "en");
    console.log(`run ${run}: ${((Date.now() - t) / 1000).toFixed(2)} s -> ${JSON.stringify(text)}`);
  }
  stt.unload();
  process.exit(0);
})().catch((e) => { console.log("FAIL", e && e.message); process.exit(1); });
