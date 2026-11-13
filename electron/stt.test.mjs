import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { createStt, MAX_SAMPLES } = createRequire(import.meta.url)("./stt.cjs");

/** A stand-in for the worker thread: answers load and transcribe the way the real one does. */
function fakeWorkerClass(behaviour = {}) {
  const made = [];
  class FakeWorker extends EventEmitter {
    constructor(file, opts) { super(); this.file = file; this.opts = opts; this.terminated = false; made.push(this); }
    postMessage(m) {
      queueMicrotask(() => {
        if (m.type === "load") {
          if (behaviour.failFirst && made.indexOf(this) < behaviour.failFirst) return this.emit("message", { type: "load-error", message: "fetch failed" });
          if (behaviour.loadError) return this.emit("message", { type: "load-error", message: behaviour.loadError });
          this.emit("message", { type: "progress", p: { status: "progress", file: "a.onnx", loaded: 50, total: 100 } });
          this.emit("message", { type: "progress", p: { status: "progress", file: "a.onnx", loaded: 100, total: 100 } });
          this.emit("message", { type: "ready" });
        } else if (m.type === "transcribe") {
          if (behaviour.hang) return;
          this.emit("message", behaviour.fail ? { type: "result-error", id: m.id, message: "boom" } : { type: "result", id: m.id, text: `heard ${m.audio.length} samples in ${m.language}` });
        }
      });
    }
    terminate() { this.terminated = true; }
  }
  return { FakeWorker, made };
}
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "momo-stt-test-"));
const make = (b, extra = {}) => { const w = fakeWorkerClass(b); return { ...w, stt: createStt({ cacheDir: dir(), workerPath: "w.cjs", WorkerClass: w.FakeWorker, cores: 8, ...extra }) }; };

describe("native speech recognizer (manager)", () => {
  it("loads once, reports progress, and recognises audio", async () => {
    const { stt, made } = make();
    const seen = [];
    await stt.load((p) => seen.push(p.percent));
    await stt.load(); // already loaded: no second worker
    expect(made).toHaveLength(1);
    expect(seen).toEqual([50, 100]);
    expect(await stt.transcribe(new Float32Array(16000), "hi")).toBe("heard 16000 samples in hi");
    expect(stt.status().state).toBe("ready");
  });
  it("loads by itself on the first transcription", async () => {
    const { stt, made } = make();
    expect(await stt.transcribe(new Float32Array(100), "en")).toBe("heard 100 samples in en");
    expect(made).toHaveLength(1);
  });
  it("passes the folder for the model and the number of cores to the worker, nothing else", async () => {
    const { stt, made } = make();
    await stt.load();
    expect(Object.keys(made[0].opts.workerData).sort()).toEqual(["cacheDir", "cores", "model"]);
  });
  it("refuses bad audio and bad languages before anything is sent", async () => {
    const { stt, made } = make();
    for (const bad of [null, [], new Float32Array(0), new Float32Array(MAX_SAMPLES + 1), new Int16Array(10)]) await expect(stt.transcribe(bad, "en")).rejects.toThrow("bad audio");
    for (const lang of ["", "english", "E", "en; rm", "../x"]) await expect(stt.transcribe(new Float32Array(10), lang)).rejects.toThrow("bad language");
    expect(made).toHaveLength(0);
  });
  it("a load error is reported and the next attempt starts fresh", async () => {
    const { stt, made } = make({ loadError: "no network" }, { loadTries: 1 });
    await expect(stt.load()).rejects.toThrow("no network");
    expect(stt.status()).toMatchObject({ state: "error", lastError: "no network" });
    await expect(stt.load()).rejects.toThrow("no network");
    expect(made).toHaveLength(2);
    expect(made[0].terminated).toBe(true);
  });
  it("a dropped connection is retried, and the load succeeds once the network is back", async () => {
    const { stt, made } = make({ failFirst: 2 }, { sleep: async () => {} });
    await stt.load();
    expect(made).toHaveLength(3);
    expect(stt.status().state).toBe("ready");
  });
  it("gives up after the retries and says so; other errors are not retried", async () => {
    const a = make({ loadError: "fetch failed" }, { sleep: async () => {}, loadTries: 3 });
    await expect(a.stt.load()).rejects.toThrow("fetch failed");
    expect(a.made).toHaveLength(3);
    const b = make({ loadError: "out of memory" }, { sleep: async () => {} });
    await expect(b.stt.load()).rejects.toThrow("out of memory");
    expect(b.made).toHaveLength(1);
  });
  it("a failed recognition is an error for that call only", async () => {
    const { stt } = make({ fail: true });
    await expect(stt.transcribe(new Float32Array(100), "en")).rejects.toThrow("boom");
    expect(stt.status().state).toBe("ready");
  });
  it("releases the model after idle time and loads it again when needed", async () => {
    const { stt, made } = make({}, { idleMs: 20 });
    await stt.transcribe(new Float32Array(100), "en");
    await new Promise((r) => setTimeout(r, 80));
    expect(stt.status().state).toBe("idle");
    expect(made[0].terminated).toBe(true);
    await stt.transcribe(new Float32Array(100), "en");
    expect(made).toHaveLength(2);
  });
  it("knows whether the model is already on this PC, and can delete it", () => {
    const cacheDir = dir();
    const stt = createStt({ cacheDir, workerPath: "w.cjs", WorkerClass: fakeWorkerClass().FakeWorker });
    expect(stt.isCached()).toBe(false);
    for (const f of [["config.json"], ["onnx", "encoder_model_quantized.onnx"], ["onnx", "decoder_model_merged_quantized.onnx"]]) {
      const p = path.join(cacheDir, "Xenova", "whisper-small", ...f);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "x");
    }
    expect(stt.isCached()).toBe(true);
    expect(stt.deleteModel()).toBe(true);
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(stt.isCached()).toBe(false);
  });
});
