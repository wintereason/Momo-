import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { synthOnline, URL_BASE } = createRequire(import.meta.url)("./onlineVoice.cjs");

const KEY = "sk_secretsecretsecretsecret1234";
const VOICE = "DODLEQrClDo8wCz460ld";
const mp3 = new Uint8Array(400).fill(7);
const res = (status, body = mp3) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => body.buffer });
const budget = (used = 0, limit = 1000) => { const b = { limit, used, spent: 0, spend(n) { b.spent += n; } }; return b; };

describe("online voice request", () => {
  it("sends only text and a voice id to ONE pinned host, with the key only in a header", async () => {
    let seen;
    const r = await synthOnline({ key: KEY, voiceId: VOICE, text: "Hello   there", budget: budget(), fetchFn: async (url, init) => { seen = { url, init }; return res(200); } });
    expect(r.ok).toBe(true);
    expect(seen.url).toBe(URL_BASE + VOICE + "?output_format=mp3_44100_64");
    expect(seen.url.startsWith("https://api.elevenlabs.io/")).toBe(true);
    expect(seen.init.headers["xi-api-key"]).toBe(KEY);
    expect(JSON.parse(seen.init.body)).toEqual({ text: "Hello there", model_id: "eleven_flash_v2_5" });
    expect(seen.url + seen.init.body).not.toContain(KEY);
  });
  it("counts the characters it spent, and refuses once the day's allowance is gone", async () => {
    const b = budget(0, 20);
    await synthOnline({ key: KEY, voiceId: VOICE, text: "twelve chars", budget: b, fetchFn: async () => res(200) });
    expect(b.spent).toBe(12);
    const b2 = budget(15, 20);
    const r = await synthOnline({ key: KEY, voiceId: VOICE, text: "twelve chars", budget: b2, fetchFn: async () => { throw new Error("must not be called"); } });
    expect(r).toEqual({ ok: false, reason: "Today's online-voice limit is used up (it resets tomorrow)." });
    expect(b2.spent).toBe(0);
  });
  it("explains failures in plain English, never with the key", async () => {
    const cases = [[401, /key was rejected/], [429, /allowance is used up/], [402, /allowance is used up/], [404, /voice id/], [500, /error \(500\)/]];
    for (const [status, re] of cases) {
      const r = await synthOnline({ key: KEY, voiceId: VOICE, text: "hi", fetchFn: async () => res(status) });
      expect(r.ok).toBe(false); expect(r.reason).toMatch(re); expect(r.reason).not.toContain(KEY);
    }
    const net = await synthOnline({ key: KEY, voiceId: VOICE, text: "hi", fetchFn: async () => { throw new Error("getaddrinfo " + KEY); } });
    expect(net).toEqual({ ok: false, reason: "The online voice service could not be reached." });
    const empty = await synthOnline({ key: KEY, voiceId: VOICE, text: "hi", fetchFn: async () => res(200, new Uint8Array(10)) });
    expect(empty.ok).toBe(false);
  });
  it("gives up after the time limit", async () => {
    const r = await synthOnline({ key: KEY, voiceId: VOICE, text: "hi", timeoutMs: 20, fetchFn: (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
    expect(r).toEqual({ ok: false, reason: "The online voice took too long." });
  });
  it("refuses with no key, a bad voice id or nothing to say, without any request", async () => {
    const never = async () => { throw new Error("must not be called"); };
    expect((await synthOnline({ key: "", voiceId: VOICE, text: "hi", fetchFn: never })).reason).toBe("No online voice key is set.");
    expect((await synthOnline({ key: KEY, voiceId: "../x", text: "hi", fetchFn: never })).reason).toBe("Bad request.");
    expect((await synthOnline({ key: KEY, voiceId: VOICE, text: "   ", fetchFn: never })).reason).toBe("Nothing to say.");
  });
});
