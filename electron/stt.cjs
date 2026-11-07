// Manager for the native speech recognizer (see stt.worker.cjs). No Electron APIs here, so it can be tested and
// measured from plain Node. The model is loaded when needed and released after a few idle minutes to free memory.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const MODEL_DIR = ["Xenova", "whisper-base"];
const MODEL_FILES = [["config.json"], ["onnx", "encoder_model_quantized.onnx"], ["onnx", "decoder_model_merged_quantized.onnx"]];
const MAX_SAMPLES = 16000 * 60; // one minute of 16 kHz audio

/**
 * @param {{ cacheDir: string, workerPath: string, idleMs?: number, WorkerClass?: any, cores?: number }} o
 */
function createStt(o) {
  const idleMs = o.idleMs ?? 5 * 60_000;
  const WorkerClass = o.WorkerClass || require("node:worker_threads").Worker;
  let worker = null;
  let loading = null;
  let state = "idle"; // idle | loading | ready | error
  let lastError = "";
  let seq = 0;
  let idleTimer = null;
  let onProgress = null;
  const pending = new Map();
  const files = new Map(); // download progress per file

  const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };
  const armIdle = () => { clearIdle(); idleTimer = setTimeout(() => unload(), idleMs); if (idleTimer.unref) idleTimer.unref(); };

  function isCached() {
    return MODEL_FILES.every((f) => { try { return fs.statSync(path.join(o.cacheDir, ...MODEL_DIR, ...f)).size > 0; } catch { return false; } });
  }

  function progress(p) {
    if (!p || p.status !== "progress" || !p.file || !Number.isFinite(p.total) || !p.total) return;
    files.set(p.file, { loaded: p.loaded || 0, total: p.total });
    let loaded = 0, total = 0;
    for (const v of files.values()) { loaded += v.loaded; total += v.total; }
    onProgress?.({ percent: Math.min(100, Math.floor((loaded / total) * 100)), loadedMB: Math.round(loaded / 1e6), totalMB: Math.round(total / 1e6) });
  }

  function fail(message) {
    lastError = message;
    state = "error";
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    pending.forEach((p) => p.reject(new Error(message)));
    pending.clear();
  }

  function load(cb) {
    if (state === "ready") return Promise.resolve();
    if (cb) onProgress = cb;
    if (loading) return loading;
    state = "loading";
    lastError = "";
    files.clear();
    loading = new Promise((resolve, reject) => {
      const w = new WorkerClass(o.workerPath, { workerData: { cacheDir: o.cacheDir, cores: o.cores ?? os.cpus().length } });
      worker = w;
      w.on("message", (m) => {
        if (m.type === "progress") progress(m.p);
        else if (m.type === "ready") { state = "ready"; armIdle(); resolve(); }
        else if (m.type === "load-error") { fail(m.message); reject(new Error(m.message)); }
        else if (m.type === "result" || m.type === "result-error") {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (m.type === "result") p?.resolve(m.text); else p?.reject(new Error(m.message));
          armIdle();
        }
      });
      w.on("error", (e) => { fail(String((e && e.message) || e)); reject(new Error(lastError)); });
      w.on("exit", () => { if (state !== "idle") { fail("The speech engine stopped unexpectedly."); } });
      w.postMessage({ type: "load" });
    }).finally(() => { loading = null; onProgress = null; });
    return loading;
  }

  async function transcribe(audio, language = "en") {
    if (!(audio instanceof Float32Array) || audio.length === 0 || audio.length > MAX_SAMPLES) throw new Error("bad audio");
    if (!/^[a-z]{2,3}$/.test(language)) throw new Error("bad language");
    await load();
    clearIdle();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: "transcribe", id, audio, language }, [audio.buffer]);
    });
  }

  function unload() {
    clearIdle();
    const w = worker;
    state = "idle";
    worker = null;
    loading = null;
    pending.forEach((p) => p.reject(new Error("unloaded")));
    pending.clear();
    try { w?.terminate(); } catch { /* already gone */ }
  }

  return {
    isCached,
    load,
    transcribe,
    unload,
    status: () => ({ cached: isCached(), state, lastError }),
    /** delete the downloaded model (used by "delete my data") */
    deleteModel() { unload(); try { fs.rmSync(o.cacheDir, { recursive: true, force: true }); return true; } catch { return false; } },
  };
}

module.exports = { createStt, MAX_SAMPLES };
