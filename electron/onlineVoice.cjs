// Optional online avatar voices (ElevenLabs), main process ONLY. The key comes in as an argument and is only ever put in the request header:
// it is never returned, logged or put in an error message. ONE pinned HTTPS destination. Only text and a voice id are sent.
const URL_BASE = "https://api.elevenlabs.io/v1/text-to-speech/";

/**
 * Make speech for `text` in voice `voiceId`.
 * budget: { limit, used, spend(n) }, a daily character allowance that keeps the free tier safe.
 * Resolves { ok: true, audio: Uint8Array (mp3) } or { ok: false, reason } (plain English, never containing the key).
 */
async function synthOnline(o) {
  const { key, voiceId, budget, fetchFn = globalThis.fetch, timeoutMs = 15000 } = o;
  if (!key) return { ok: false, reason: "No online voice key is set." };
  if (typeof voiceId !== "string" || !/^[A-Za-z0-9]{10,40}$/.test(voiceId)) return { ok: false, reason: "Bad request." };
  const text = String(o.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return { ok: false, reason: "Nothing to say." };
  if (budget && budget.used + text.length > budget.limit) return { ok: false, reason: "Today's online-voice limit is used up (it resets tomorrow)." };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(URL_BASE + voiceId + "?output_format=mp3_44100_64", {
      method: "POST", signal: ctl.signal,
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
    });
    if (!res.ok) {
      const why = res.status === 401 ? "The online voice key was rejected."
        : res.status === 402 || res.status === 429 ? "The online voice service says the free allowance is used up or it is too busy."
        : res.status === 404 || res.status === 422 ? "That voice id isn't available to this account."
        : "The online voice service returned an error (" + res.status + ").";
      return { ok: false, reason: why };
    }
    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.byteLength < 200) return { ok: false, reason: "The online voice returned no audio." };
    if (budget) budget.spend(text.length);
    return { ok: true, audio };
  } catch {
    return { ok: false, reason: ctl.signal.aborted ? "The online voice took too long." : "The online voice service could not be reached." };
  } finally { clearTimeout(timer); }
}

module.exports = { synthOnline, URL_BASE };
