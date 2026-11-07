import { describe, expect, it } from "vitest";
import { concatChunks, resampleTo16k, rms } from "./audio";
import { ProgressAggregator } from "./progress";

describe("audio helpers", () => {
  it("concatenates chunks in order and caps the length", () => {
    const a = new Float32Array([1, 2]), b = new Float32Array([3, 4, 5]);
    expect([...concatChunks([a, b])]).toEqual([1, 2, 3, 4, 5]);
    expect([...concatChunks([a, b], 3)]).toEqual([1, 2, 3]);
    expect(concatChunks([]).length).toBe(0);
  });
  it("leaves 16 kHz audio untouched and resamples others", () => {
    const x = new Float32Array(1600).fill(0.5);
    expect(resampleTo16k(x, 16000)).toBe(x);
    const y = resampleTo16k(new Float32Array(48000).fill(0.25), 48000);
    expect(y.length).toBe(16000);
    expect(y[100]).toBeCloseTo(0.25);
  });
  it("downsampling keeps a ramp monotonic", () => {
    const ramp = Float32Array.from({ length: 4800 }, (_, i) => i / 4800);
    const out = resampleTo16k(ramp, 48000);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
  });
  it("rms", () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBe(1);
  });
});

describe("ProgressAggregator", () => {
  it("combines files into one percentage", () => {
    const p = new ProgressAggregator();
    expect(p.update({ status: "initiate", file: "a" }).percent).toBe(0);
    p.update({ status: "progress", file: "a", loaded: 50e6, total: 100e6 });
    const r = p.update({ status: "progress", file: "b", loaded: 0, total: 100e6 });
    expect(r.percent).toBe(25);
    expect(r.totalMB).toBe(200);
    expect(p.update({ status: "done", file: "a", total: 100e6 }).percent).toBe(50);
  });
  it("never exceeds 100 or goes backwards on odd data", () => {
    const p = new ProgressAggregator();
    expect(p.update({ file: "a", loaded: 999, total: 100 }).percent).toBe(100);
    expect(p.update({}).percent).toBe(100);
  });
});
