import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { KEYS, PROVIDERS, parse, load, problems, status } = createRequire(import.meta.url)("./env.cjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_GEMINI = "AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345";
const FAKE_GROQ = "gsk_FAKEFAKEFAKEFAKEFAKEFAKE1234";
const FAKE_OR = "sk-or-v1-FAKEFAKEFAKEFAKEFAKEFAKE1234";
const FAKE_HF = "hf_FAKEFAKEFAKEFAKEFAKEFAKE12345";

describe(".env parsing", () => {
  it("reads KEY=VALUE lines, ignoring comments, blanks and junk", () => {
    const p = parse(`# comment\n\nFOO=bar\nMOMO_AI_ENABLED = true \nbad line\n=novalue\nlower=case\nQUOTED="hello"\nSINGLE='x y'\nEMPTY=\n`);
    expect(p).toEqual({ FOO: "bar", MOMO_AI_ENABLED: "true", QUOTED: "hello", SINGLE: "x y", EMPTY: "" });
  });
  it("handles Windows line endings and does no variable expansion", () => {
    expect(parse("A=1\r\nB=$HOME\r\n")).toEqual({ A: "1", B: "$HOME" });
  });
});

describe("loading", () => {
  it("keeps only known, non-empty keys, and real environment variables win over the file", () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP || "."), "momo-env-"));
    const f = path.join(dir, ".env");
    fs.writeFileSync(f, `GEMINI_API_KEY=${FAKE_GEMINI}\nMOMO_AI_PROVIDER=groq\nHF_TOKEN=\nUNKNOWN_THING=whatever\nANTHROPIC_API_KEY=sk-ant-ignored\n`);
    const r = load({ files: [f, path.join(dir, "missing.env")], processEnv: { MOMO_AI_PROVIDER: "openrouter" } });
    expect(r.values).toEqual({ GEMINI_API_KEY: FAKE_GEMINI, MOMO_AI_PROVIDER: "openrouter" }); // paid/unknown keys are ignored
    expect(r.files).toEqual([f]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("a missing file is normal, not an error", () => {
    expect(load({ files: ["D:/nope/.env"], processEnv: {} })).toEqual({ values: {}, files: [] });
  });
});

describe("validation tells you what is wrong without ever repeating a value", () => {
  it("flags keys with the wrong shape", () => {
    const p = problems({ GEMINI_API_KEY: "not-a-real-key-123456789012345", GROQ_API_KEY: FAKE_GROQ, MOMO_AI_PROVIDER: "skynet", MOMO_AI_MAX_REQUESTS_PER_DAY: "lots", OLLAMA_HOST: "http://evil.example:11434" });
    const all = p.join(" ");
    expect(all).toContain("GEMINI_API_KEY should start with AIza");
    expect(all).toContain("MOMO_AI_PROVIDER must be");
    expect(all).toContain("MOMO_AI_MAX_REQUESTS_PER_DAY must be");
    expect(all).toContain("OLLAMA_HOST must be a local address"); // the AI can't be pointed at some remote host
    expect(all).not.toContain("GROQ_API_KEY");
    for (const line of p) for (const secret of ["not-a-real-key", FAKE_GROQ, "evil.example"]) expect(line).not.toContain(secret);
  });
  it("warns when the AI is on but the chosen provider has no key (Ollama needs none)", () => {
    expect(problems({ MOMO_AI_ENABLED: "true", MOMO_AI_PROVIDER: "gemini" }).join(" ")).toContain("GEMINI_API_KEY is empty");
    expect(problems({ MOMO_AI_ENABLED: "true" }).join(" ")).toContain("GEMINI_API_KEY is empty"); // gemini is the default
    expect(problems({ MOMO_AI_ENABLED: "true", MOMO_AI_PROVIDER: "ollama" })).toEqual([]);
    expect(problems({ MOMO_AI_ENABLED: "false" })).toEqual([]);
  });
});

describe("what the UI is told", () => {
  const values = { MOMO_AI_ENABLED: "true", MOMO_AI_PROVIDER: "gemini", GEMINI_API_KEY: FAKE_GEMINI, GROQ_API_KEY: FAKE_GROQ, OPENROUTER_API_KEY: FAKE_OR, HF_TOKEN: FAKE_HF };
  const s = status(values, ["D:/Project 2/momo-project/momo-project/.env"]);

  it("contains no key, token or any piece of one", () => {
    const json = JSON.stringify(s);
    for (const secret of [FAKE_GEMINI, FAKE_GROQ, FAKE_OR, FAKE_HF, "FAKEFAKE", "AIza", "gsk_", "sk-or", "hf_FAKE"]) expect(json).not.toContain(secret);
  });
  it("is only booleans, short names and plain sentences", () => {
    const leaves = [];
    (function walk(o) { for (const v of Object.values(o)) (v && typeof v === "object" ? walk(v) : leaves.push(v)); })(s);
    for (const v of leaves) expect(["boolean", "string"]).toContain(typeof v);
    expect(s.ai.keys).toEqual({ gemini: true, groq: true, openrouter: true, ollama: false });
    expect(s.speech.hfToken).toBe(true);
  });
  it("says whether the AI is ready: enabled, a valid key for the chosen provider, no problems", () => {
    expect(s.ai.ready).toBe(true);
    expect(status({ ...values, MOMO_AI_ENABLED: "false" }).ai.ready).toBe(false);
    expect(status({ ...values, MOMO_AI_PROVIDER: "groq", GROQ_API_KEY: undefined }).ai.ready).toBe(false);
    expect(status({ ...values, GEMINI_API_KEY: "bad" }).ai.ready).toBe(false);
    expect(status({ MOMO_AI_ENABLED: "true", MOMO_AI_PROVIDER: "ollama" }).ai.ready).toBe(true); // local: no key
    expect(status({}).ai).toMatchObject({ enabled: false, ready: false, provider: "gemini", screenContext: false });
  });
  it("an unknown provider falls back to the default instead of failing", () => {
    expect(status({ MOMO_AI_PROVIDER: "skynet" }).ai.provider).toBe("gemini");
  });
  it("screen text is never offered to a cloud provider unless explicitly switched on", () => {
    expect(status({}).ai.screenContext).toBe(false);
    expect(status({ MOMO_AI_ALLOW_SCREEN_CONTEXT: "false" }).ai.screenContext).toBe(false);
    expect(status({ MOMO_AI_ALLOW_SCREEN_CONTEXT: "true" }).ai.screenContext).toBe(true);
  });
  it("only shows the file's location, never its contents", () => {
    expect(s.files).toEqual(["momo-project/.env"]);
  });
});

describe("only FREE services", () => {
  it("no paid provider or paid art/speech service can be configured", () => {
    expect(PROVIDERS.sort()).toEqual(["gemini", "groq", "ollama", "openrouter"]);
    const names = Object.keys(KEYS).join(" ");
    for (const paid of ["ANTHROPIC", "OPENAI", "DEEPGRAM", "AZURE", "STABILITY", "REPLICATE", "MESHY", "TRIPO"]) {
      expect(names, paid).not.toContain(paid);
    }
    const text = fs.readFileSync(path.join(root, ".env.example"), "utf8");
    for (const paid of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPGRAM", "STABILITY_API_KEY", "REPLICATE_API_TOKEN"]) {
      expect(text, paid).not.toContain(paid);
    }
  });
});

describe("the .env.example template and the loader agree", () => {
  const text = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  const tpl = parse(text);

  it("lists exactly the keys the loader understands", () => {
    expect(Object.keys(tpl).sort()).toEqual(Object.keys(KEYS).sort());
  });
  it("ships with no secrets: every key empty except harmless defaults", () => {
    const defaults = { MOMO_AI_ENABLED: "false", MOMO_AI_PROVIDER: "gemini", OLLAMA_HOST: "http://localhost:11434", MOMO_AI_MAX_OUTPUT_TOKENS: "800", MOMO_AI_MAX_REQUESTS_PER_DAY: "200", MOMO_AI_ALLOW_SCREEN_CONTEXT: "false", MOMO_VOICE_MAX_CHARS_PER_DAY: "3000" };
    for (const [k, v] of Object.entries(tpl)) expect(v, k).toBe(defaults[k] ?? "");
    expect(load({ files: [path.join(root, ".env.example")], processEnv: {} }).values).toEqual(defaults);
    expect(problems(defaults)).toEqual([]);
  });
  it("the AI is OFF by default, and screen text is never sent by default", () => {
    expect(tpl.MOMO_AI_ENABLED).toBe("false");
    expect(tpl.MOMO_AI_ALLOW_SCREEN_CONTEXT).toBe("false");
  });
  it("never uses the VITE_ prefix, which would expose a value to the web page", () => {
    expect(text).not.toMatch(/^\s*VITE_/m);
    expect(Object.keys(KEYS).some((k) => k.startsWith("VITE_"))).toBe(false);
  });
  it("every key says where to get it, and the privacy warning is there", () => {
    expect(text).toMatch(/aistudio\.google\.com\/apikey/);
    expect(text).toMatch(/console\.groq\.com\/keys/);
    expect(text).toMatch(/openrouter\.ai\/keys/);
    expect(text).toMatch(/ollama\.com/);
    expect(text).toMatch(/huggingface\.co\/settings\/tokens/);
    expect(text).toMatch(/NEVER share this file/);
    expect(text).toMatch(/free cloud tiers usually have the right to log/i);
  });
  it(".env (your copy) is git-ignored and the template is not", () => {
    const g = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/);
    expect(g).toContain(".env");
    expect(g).toContain(".env.*");
    expect(g).toContain("!.env.example");
  });
});

describe("the optional online avatar voice key", () => {
  it("is a secret that the page can only save, and the status shows only yes/no", () => {
    expect(KEYS.ELEVENLABS_API_KEY.kind).toBe("secret");
    const values = { ELEVENLABS_API_KEY: "sk_0123456789abcdef0123456789abcdef" };
    const s = status(values, []);
    expect(s.speech.onlineVoiceKey).toBe(true);
    expect(JSON.stringify(s)).not.toContain("sk_0123");
    expect(status({}, []).speech.onlineVoiceKey).toBe(false);
    expect(problems({ ELEVENLABS_API_KEY: "bad key!" }).join(" ")).toContain("ELEVENLABS_API_KEY looks wrong");
    expect(problems(values)).toEqual([]);
  });
  it("is the only paid-looking service allowed, and stays empty in the template", () => {
    expect(PROVIDERS.sort()).toEqual(["gemini", "groq", "ollama", "openrouter"]); // the AI brain is still free-only
    expect(parse(fs.readFileSync(path.join(root, ".env.example"), "utf8")).ELEVENLABS_API_KEY).toBe("");
  });
});
