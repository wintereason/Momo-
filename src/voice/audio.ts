/** Pure audio helpers. Audio exists only in memory and is discarded after transcription. */
export const TARGET_RATE = 16000;
export const MAX_SECONDS = 60; // bounds memory for a runaway recording

export function concatChunks(chunks: Float32Array[], maxSamples = TARGET_RATE * MAX_SECONDS): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const n = Math.min(total, maxSamples);
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    if (o >= n) break;
    const take = Math.min(c.length, n - o);
    out.set(take === c.length ? c : c.subarray(0, take), o);
    o += take;
  }
  return out;
}

/** Linear-interpolation resample to 16 kHz mono (what Whisper expects). */
export function resampleTo16k(data: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE || data.length === 0) return data;
  const ratio = fromRate / TARGET_RATE;
  const n = Math.floor(data.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, data.length - 1);
    const f = pos - i0;
    out[i] = data[i0] * (1 - f) + data[i1] * f;
  }
  return out;
}

export function rms(data: Float32Array): number {
  if (data.length === 0) return 0;
  let s = 0;
  for (const v of data) s += v * v;
  return Math.sqrt(s / data.length);
}
