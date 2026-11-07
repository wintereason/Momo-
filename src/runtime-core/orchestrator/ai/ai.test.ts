import { describe, expect, it } from "vitest";
import { buildAiConfig, DEFAULT_MODELS } from "./config";
import { HOSTS, assertAllowedUrl, buildRequest, classifyStatus, parseResponse } from "./providers";

const KEY_G = "AQ.FAKEgeminiKEY_FAKEFAKEFAKE_1234567890";
const KEY_Q = "gsk_FAKEgroqKEYFAKEFAKEFAKE12345678";
const KEY_O = "sk-or-v1-FAKEopenrouterKEYFAKEFAKE1234";
const ALL = { MOMO_AI_ENABLED: "true", GEMINI_API_KEY: KEY_G, GROQ_API_KEY: KEY_Q, OPENROUTER_API_KEY: KEY_O };
const SECRETS = [KEY_G, KEY_Q, KEY_O, "FAKEgemini", "FAKEgroq", "FAKEopenrouter"];

const gemini = (text: string) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });
const openai = (text: string) => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] });

describe("configuration", () => {
  it("tries the chosen provider first, then the other cloud providers that have a key", () => {
    const c = buildAiConfig({ ...ALL, MOMO_AI_PROVIDER: "groq" });
    expect(c.order.map((o) => o.provider)).toEqual(["groq", "gemini", "openrouter"]);
    expect(buildAiConfig({ ...ALL }).order.map((o) => o.provider)).toEqual(["gemini", "groq", "openrouter"]); // gemini is the default
    expect(buildAiConfig({ MOMO_AI_ENABLED: "true", GEMINI_API_KEY: KEY_G, OPENROUTER_API_KEY: KEY_O, MOMO_AI_PROVIDER: "openrouter" }).order.map((o) => o.provider)).toEqual(["openrouter", "gemini"]);
  });
  it("choosing Ollama keeps everything on the PC: no cloud fallback, ever", () => {
    const c = buildAiConfig({ ...ALL, MOMO_AI_PROVIDER: "ollama", OLLAMA_HOST: "http://localhost:11434/" });
    expect(c.order.map((o) => o.provider)).toEqual(["ollama"]);
    expect(c.order[0].host).toBe("http://localhost:11434");
  });
  it("a provider without a key is skipped, and no keys at all means nothing to call", () => {
    expect(buildAiConfig({ MOMO_AI_ENABLED: "true" }).order).toEqual([]);
    expect(buildAiConfig({ ...ALL, MOMO_AI_PROVIDER: "ollama" }).order).toEqual([]); // no OLLAMA_HOST given
  });
  it("model overrides apply to the chosen provider only (names differ per service)", () => {
    const c = buildAiConfig({ ...ALL, MOMO_AI_PROVIDER: "groq", MOMO_AI_MODEL_FAST: "my-fast", MOMO_AI_MODEL_SMART: "my-smart" });
    expect(c.order[0]).toMatchObject({ provider: "groq", modelFast: "my-fast", modelSmart: "my-smart" });
    expect(c.order[1].modelFast).toBe(DEFAULT_MODELS.gemini.fast);
  });
  it("defaults are safe: off, 800 tokens, 200 requests a day, screen text never offered", () => {
    const c = buildAiConfig({});
    expect(c).toMatchObject({ enabled: false, maxOutputTokens: 800, maxRequestsPerDay: 200, allowScreenContext: false });
    expect(buildAiConfig({ MOMO_AI_ALLOW_SCREEN_CONTEXT: "true" }).allowScreenContext).toBe(true);
  });
  it("limits are clamped to sensible bounds", () => {
    expect(buildAiConfig({ MOMO_AI_MAX_REQUESTS_PER_DAY: "999999" }).maxRequestsPerDay).toBe(5000);
    expect(buildAiConfig({ MOMO_AI_MAX_REQUESTS_PER_DAY: "0" }).maxRequestsPerDay).toBe(1);
    expect(buildAiConfig({ MOMO_AI_MAX_OUTPUT_TOKENS: "5" }).maxOutputTokens).toBe(64);
    expect(buildAiConfig({ MOMO_AI_MAX_OUTPUT_TOKENS: "lots" }).maxOutputTokens).toBe(800);
  });
  it("the default Gemini models are rolling aliases, not numbered versions Google will retire", () => {
    expect(DEFAULT_MODELS.gemini.fast).toMatch(/latest$/);
    expect(DEFAULT_MODELS.gemini.smart).toMatch(/latest$/);
  });
});

describe("requests", () => {
  const cfg = buildAiConfig({ ...ALL, MOMO_AI_PROVIDER: "gemini", OLLAMA_HOST: "http://localhost:11434" });
  const entry = (p: string) => cfg.order.find((o) => o.provider === p) ?? { provider: "ollama" as const, host: "http://localhost:11434", modelFast: "llama3.2", modelSmart: "llama3.2" };
  const req = { system: "SYS", messages: [{ role: "user" as const, text: "hello" }], json: true, maxTokens: 300 };

  it("Gemini: pinned host, key in a header only, JSON mode, no thinking settings", () => {
    const r = buildRequest(entry("gemini"), "gemini-flash-lite-latest", req);
    expect(r.url).toBe(`https://${HOSTS.gemini}/v1beta/models/gemini-flash-lite-latest:generateContent`);
    expect(r.headers["x-goog-api-key"]).toBe(KEY_G);
    expect(r.url).not.toContain("key");
    const b = JSON.parse(r.body);
    expect(b.generationConfig).toEqual({ maxOutputTokens: 300, temperature: 0.2, responseMimeType: "application/json" });
    expect(b.systemInstruction.parts[0].text).toBe("SYS");
    expect(b.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
  });
  it("Gemini maps the assistant role to 'model'", () => {
    const r = buildRequest(entry("gemini"), "m", { ...req, messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" }] });
    expect(JSON.parse(r.body).contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
  });
  it("Groq: OpenAI-style, bearer header, JSON mode, small reasoning budget for gpt-oss", () => {
    const r = buildRequest(entry("groq"), "openai/gpt-oss-20b", req);
    expect(r.url).toBe(`https://${HOSTS.groq}/openai/v1/chat/completions`);
    expect(r.headers.authorization).toBe(`Bearer ${KEY_Q}`);
    const b = JSON.parse(r.body);
    expect(b).toMatchObject({ model: "openai/gpt-oss-20b", max_completion_tokens: 300, response_format: { type: "json_object" }, reasoning_effort: "low" });
    expect(b.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(buildRequest(entry("groq"), "other-model", req).body).not.toContain("reasoning_effort");
  });
  it("OpenRouter: its own host and headers, no JSON-mode assumption", () => {
    const r = buildRequest(entry("openrouter"), "openrouter/free", req);
    expect(r.url).toBe(`https://${HOSTS.openrouter}/api/v1/chat/completions`);
    expect(r.headers.authorization).toBe(`Bearer ${KEY_O}`);
    expect(r.headers["x-title"]).toBe("Momo");
    const b = JSON.parse(r.body);
    expect(b.max_tokens).toBe(300);
    expect(b.response_format).toBeUndefined();
  });
  it("Ollama: the local address, no key", () => {
    const r = buildRequest(entry("ollama"), "llama3.2", req);
    expect(r.url).toBe("http://localhost:11434/api/chat");
    expect(JSON.stringify(r)).not.toContain("authorization");
    expect(JSON.parse(r.body)).toMatchObject({ stream: false, format: "json", options: { num_predict: 300 } });
  });
  it("a key never appears in any URL, for any provider", () => {
    for (const p of ["gemini", "groq", "openrouter"]) for (const k of SECRETS) expect(buildRequest(entry(p), "m", req).url).not.toContain(k);
  });
});

describe("destinations are pinned", () => {
  it("allows the three cloud hosts over https and this PC for Ollama", () => {
    for (const u of [`https://${HOSTS.gemini}/v1beta/x`, `https://${HOSTS.groq}/openai/v1/chat/completions`, `https://${HOSTS.openrouter}/api/v1/chat/completions`, "http://localhost:11434/api/chat", "http://127.0.0.1:11434/api/chat"]) {
      expect(() => assertAllowedUrl(u), u).not.toThrow();
    }
  });
  it("refuses everything else, including look-alikes, plain http to the internet and embedded credentials", () => {
    for (const u of ["https://evil.example/", "http://api.groq.com/x", "https://api.groq.com.evil.io/x", "https://evilopenrouter.ai/x", "https://openrouter.ai@evil.com/",
      "https://user:pw@api.groq.com/x", "http://evil.example:11434/api/chat", "http://localhost.evil.com/", "ftp://localhost/x", "https://localhost/x", "file:///C:/x"]) {
      expect(() => assertAllowedUrl(u), u).toThrow();
    }
  });
});

describe("responses", () => {
  it("reads each provider's reply shape", () => {
    expect(parseResponse("gemini", gemini(" hi "))).toEqual({ ok: true, text: "hi" });
    expect(parseResponse("groq", openai("hello"))).toEqual({ ok: true, text: "hello" });
    expect(parseResponse("openrouter", openai("hey"))).toEqual({ ok: true, text: "hey" });
    expect(parseResponse("ollama", { message: { content: "yo" } })).toEqual({ ok: true, text: "yo" });
  });
  it("recognises blocked and empty replies, and survives garbage", () => {
    expect(parseResponse("gemini", { promptFeedback: { blockReason: "SAFETY" } })).toEqual({ ok: false, error: "blocked" });
    expect(parseResponse("gemini", { candidates: [{ finishReason: "SAFETY" }] })).toEqual({ ok: false, error: "blocked" });
    expect(parseResponse("groq", { choices: [{ finish_reason: "content_filter", message: { content: "x" } }] })).toEqual({ ok: false, error: "blocked" });
    for (const p of ["gemini", "groq", "openrouter", "ollama"] as const) {
      for (const junk of [null, 5, "x", [], {}, { choices: [] }, { candidates: [] }, { message: {} }]) expect(parseResponse(p, junk).ok, `${p} ${JSON.stringify(junk)}`).toBe(false);
    }
  });
  it("classifies HTTP statuses", () => {
    expect([429, 401, 403, 404, 500, 503, 408, 400].map(classifyStatus)).toEqual(["rate_limited", "auth", "auth", "bad_model", "server", "server", "server", "bad_request"]);
  });
});
