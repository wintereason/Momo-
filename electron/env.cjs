// Reads Momo's .env file in the desktop shell (main process) ONLY.
//  - Secret values never leave this process: the UI is only ever given booleans and plain-English problems.
//  - Only the keys listed in KEYS are read; anything else in the file is ignored.
//  - Nothing here logs a value, and error messages never contain one.
//  - Only FREE services are supported (Gemini free tier, Groq free tier, OpenRouter ":free" models, local Ollama).
const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = ["gemini", "groq", "openrouter", "ollama"];
/** The setting that must be present for each provider to be usable (Ollama needs only its local address). */
const PROVIDER_KEY = { gemini: "GEMINI_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", ollama: "OLLAMA_HOST" };

/** Every setting Momo understands. kind: "secret" (a key/token), "setting" (a plain option). */
const KEYS = {
  MOMO_AI_ENABLED: { group: "ai", kind: "setting", check: /^(true|false)$/i, hint: "must be true or false" },
  MOMO_AI_PROVIDER: { group: "ai", kind: "setting", check: /^(gemini|groq|openrouter|ollama)$/i, hint: "must be gemini, groq, openrouter or ollama" },
  // Google issues two key styles: the classic "AIza..." and the newer "AQ...."
  GEMINI_API_KEY: { group: "ai", kind: "secret", check: /^(AIza[A-Za-z0-9_-]{30,}|AQ\.[A-Za-z0-9_.-]{20,})$/, hint: "should start with AIza or AQ." },
  GROQ_API_KEY: { group: "ai", kind: "secret", check: /^gsk_[A-Za-z0-9]{20,}$/, hint: "should start with gsk_" },
  OPENROUTER_API_KEY: { group: "ai", kind: "secret", check: /^sk-or-[A-Za-z0-9_-]{20,}$/, hint: "should start with sk-or-" },
  OLLAMA_HOST: { group: "ai", kind: "setting", check: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/?$/i, hint: "must be a local address like http://localhost:11434" },
  MOMO_AI_MODEL_FAST: { group: "ai", kind: "setting", check: /^[A-Za-z0-9._:/-]{1,100}$/, hint: "is not a valid model name" },
  MOMO_AI_MODEL_SMART: { group: "ai", kind: "setting", check: /^[A-Za-z0-9._:/-]{1,100}$/, hint: "is not a valid model name" },
  MOMO_AI_MAX_OUTPUT_TOKENS: { group: "ai", kind: "setting", check: /^\d{2,5}$/, hint: "must be a whole number" },
  MOMO_AI_MAX_REQUESTS_PER_DAY: { group: "ai", kind: "setting", check: /^\d{1,5}$/, hint: "must be a whole number" },
  MOMO_AI_ALLOW_SCREEN_CONTEXT: { group: "ai", kind: "setting", check: /^(true|false)$/i, hint: "must be true or false" },

  HF_TOKEN: { group: "speech", kind: "secret", check: /^hf_[A-Za-z0-9]{20,}$/, hint: "should start with hf_" },
};

/** KEY=value lines. No quotes needed (matching quotes are stripped), no variable expansion, # starts a comment line. */
function parse(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(val)) val = val.slice(1, -1).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) out[key] = val;
  }
  return out;
}

/**
 * @param {{ files?: string[], processEnv?: Record<string,string|undefined> }} o
 * Real environment variables win over the file. Only known keys with a non-empty value are kept.
 */
function load(o = {}) {
  const fromFile = {};
  const found = [];
  for (const f of o.files ?? []) {
    try {
      Object.assign(fromFile, parse(fs.readFileSync(f, "utf8")));
      found.push(f);
    } catch { /* a missing file is normal */ }
  }
  const values = {};
  const penv = o.processEnv ?? {};
  for (const k of Object.keys(KEYS)) {
    const v = (penv[k] ?? fromFile[k] ?? "").toString().trim();
    if (v) values[k] = v;
  }
  return { values, files: found };
}

const providerOf = (values) => {
  const p = (values.MOMO_AI_PROVIDER || "gemini").toLowerCase();
  return PROVIDERS.includes(p) ? p : "gemini";
};

/** Plain-English problems with what was entered. Never includes a value. */
function problems(values) {
  const out = [];
  for (const [k, v] of Object.entries(values)) {
    const spec = KEYS[k];
    if (spec && !spec.check.test(v)) out.push(`${k} ${spec.hint}.`);
  }
  const prov = providerOf(values);
  const needs = PROVIDER_KEY[prov];
  if (/^true$/i.test(values.MOMO_AI_ENABLED || "") && prov !== "ollama" && !values[needs]) out.push(`The AI is switched on, but ${needs} is empty.`);
  return out;
}

/** What the UI may know: booleans and plain strings only. Never a key, token or any part of one. */
function status(values, files = []) {
  const has = (k) => !!values[k];
  const prov = providerOf(values);
  const enabled = /^true$/i.test(values.MOMO_AI_ENABLED || "");
  const probs = problems(values);
  const providerUsable = prov === "ollama" ? true : has(PROVIDER_KEY[prov]);
  return {
    fileFound: files.length > 0,
    files: files.map((f) => path.basename(path.dirname(f)) + "/" + path.basename(f)),
    ai: {
      enabled,
      provider: prov,
      ready: enabled && providerUsable && probs.length === 0,
      // false unless the user turned it on: a free cloud provider never receives text from the screen by default
      screenContext: /^true$/i.test(values.MOMO_AI_ALLOW_SCREEN_CONTEXT || ""),
      keys: { gemini: has("GEMINI_API_KEY"), groq: has("GROQ_API_KEY"), openrouter: has("OPENROUTER_API_KEY"), ollama: has("OLLAMA_HOST") },
    },
    speech: { hfToken: has("HF_TOKEN") },
    problems: probs,
  };
}

module.exports = { KEYS, PROVIDERS, parse, load, problems, status };
