import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { transcribeCloud, encodeWav } = createRequire(import.meta.url)("./cloudStt.cjs");

const audio = new Float32Array(16000).fill(0.1);
const ok = (text) => async () => ({ ok: true, status: 200, json: async () => ({ text }) });

describe("cloud speech", () => {
  it("encodes a valid 16 kHz mono WAV", () => {
    const w = encodeWav(new Float32Array([0, 1, -1]));
    expect(w.toString("ascii", 0, 4)).toBe("RIFF");
    expect(w.toString("ascii", 8, 12)).toBe("WAVE");
    expect(w.readUInt32LE(24)).toBe(16000);
    expect(w.length).toBe(44 + 6);
    expect(w.readInt16LE(46)).toBe(32767);
    expect(w.readInt16LE(48)).toBe(-32768);
  });
  it("sends the language and a script hint for Hindi, with the key only in the header", async () => {
    let seen;
    const fetchFn = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ text: " नमस्ते " }) }; };
    expect(await transcribeCloud({ key: "gsk_x", audio, language: "hi", fetchFn })).toBe("नमस्ते");
    expect(seen.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(seen.init.headers.Authorization).toBe("Bearer gsk_x");
    expect(seen.init.body.get("language")).toBe("hi");
    expect(seen.init.body.get("prompt")).toMatch(/हिंदी/);
    expect(seen.init.body.get("model")).toBe("whisper-large-v3");
  });
  it("auto-detect sends no language", async () => {
    let body;
    await transcribeCloud({ key: "k", audio, language: "auto", fetchFn: async (u, i) => { body = i.body; return ok("x")(); } });
    expect(body.has("language")).toBe(false);
  });
  it("explains failures in plain words", async () => {
    await expect(transcribeCloud({ key: "", audio, language: "en" })).rejects.toThrow(/No Groq key/);
    await expect(transcribeCloud({ key: "k", audio, language: "en", fetchFn: async () => ({ ok: false, status: 401 }) })).rejects.toThrow(/rejected the key/);
    await expect(transcribeCloud({ key: "k", audio, language: "en", fetchFn: async () => ({ ok: false, status: 429 }) })).rejects.toThrow(/limit/);
    await expect(transcribeCloud({ key: "k", audio, language: "en", fetchFn: async () => { throw new Error("net"); } })).rejects.toThrow(/internet/);
  });
});
