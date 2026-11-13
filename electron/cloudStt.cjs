// Optional cloud speech recognition (Groq, Whisper large-v3): much more accurate than the model that runs on this PC,
// especially for Hindi and other Indian languages. It is OFF unless the user turns it on and has a Groq key in .env.
// The audio is sent over HTTPS to api.groq.com for this one request, is not stored by Momo, and the key never leaves this process.
// Pure functions with fetch passed in, so it is tested without a network.

const URL_GROQ = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3";

// A short sentence in the right script nudges Whisper to write that script (Hindi in Devanagari, not Urdu).
const SCRIPT_PROMPTS = {
  hi: "यह हिंदी में लिखा गया एक वाक्य है।", mr: "हे मराठीत लिहिलेले वाक्य आहे.", ne: "यो नेपालीमा लेखिएको वाक्य हो।",
  gu: "આ ગુજરાતીમાં લખેલું વાક્ય છે.", bn: "এটি বাংলায় লেখা একটি বাক্য।", ta: "இது தமிழில் எழுதப்பட்ட வாக்கியம்.",
  te: "ఇది తెలుగులో వ్రాసిన వాక్యం.", kn: "ಇದು ಕನ್ನಡದಲ್ಲಿ ಬರೆದ ವಾಕ್ಯ.", ml: "ഇത് മലയാളത്തിൽ എഴുതിയ വാക്യമാണ്.",
  pa: "ਇਹ ਪੰਜਾਬੀ ਵਿੱਚ ਲਿਖਿਆ ਵਾਕ ਹੈ।", ur: "یہ اردو میں لکھا گیا جملہ ہے۔",
};

/** 16 kHz mono Float32 -> a WAV file (16-bit PCM). */
function encodeWav(samples, rate = 16000) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/**
 * @returns {Promise<string>} the text. Throws Error with a plain-language message on failure (offline, bad key, limit).
 */
async function transcribeCloud({ key, audio, language, fetchFn = globalThis.fetch, timeoutMs = 30_000 }) {
  if (!key) throw new Error("No Groq key is set.");
  const form = new FormData();
  form.append("file", new Blob([encodeWav(audio)], { type: "audio/wav" }), "speech.wav");
  form.append("model", MODEL);
  form.append("temperature", "0");
  form.append("response_format", "json");
  if (language && language !== "auto") {
    form.append("language", language);
    if (SCRIPT_PROMPTS[language]) form.append("prompt", SCRIPT_PROMPTS[language]);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(URL_GROQ, { method: "POST", headers: { Authorization: "Bearer " + key }, body: form, signal: ctl.signal });
  } catch {
    throw new Error("Couldn't reach the cloud speech service. Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new Error("Groq rejected the key. Check GROQ_API_KEY in .env.");
  if (res.status === 429) throw new Error("The free cloud speech limit was reached for now.");
  if (!res.ok) throw new Error("The cloud speech service answered with an error (" + res.status + ").");
  const j = await res.json();
  return String((j && j.text) || "").trim();
}

module.exports = { transcribeCloud, encodeWav, SCRIPT_PROMPTS, MODEL };
