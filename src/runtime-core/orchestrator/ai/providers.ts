import type { Provider, ProviderEntry } from "./config";

/**
 * Request builders and response parsers for the free AI services. Pure functions: no network here.
 * Every request goes to a fixed, pinned host; the key travels in a header only.
 */
export const HOSTS = {
  gemini: "generativelanguage.googleapis.com",
  groq: "api.groq.com",
  openrouter: "openrouter.ai",
} as const;

export interface ChatMessage { role: "user" | "assistant"; text: string }
export interface LlmRequest {
  system: string;
  messages: ChatMessage[];
  /** ask the model for a JSON object */
  json: boolean;
  maxTokens: number;
}
export interface BuiltRequest { url: string; headers: Record<string, string>; body: string }

/** Throws unless the URL is one of the pinned AI hosts (https) or the user's own machine (Ollama). */
export function assertAllowedUrl(rawUrl: string): void {
  const u = new URL(rawUrl);
  const cloud = u.protocol === "https:" && (Object.values(HOSTS) as string[]).includes(u.hostname) && !u.username && !u.password;
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && !u.username && !u.password;
  if (!cloud && !local) throw new Error("blocked destination");
}

export function buildRequest(p: ProviderEntry, model: string, req: LlmRequest): BuiltRequest {
  const json = (o: unknown) => JSON.stringify(o);
  switch (p.provider) {
    case "gemini": {
      const gen: Record<string, unknown> = { maxOutputTokens: req.maxTokens, temperature: 0.2 };
      if (req.json) gen.responseMimeType = "application/json";
      // (no thinkingConfig: the current models reject thinkingBudget/thinkingLevel values that older ones accepted)
      return {
        url: `https://${HOSTS.gemini}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "content-type": "application/json", "x-goog-api-key": p.key ?? "" },
        body: json({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
          generationConfig: gen,
        }),
      };
    }
    case "groq":
    case "openrouter": {
      const groq = p.provider === "groq";
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: "system", content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.text }))],
        temperature: 0.2,
      };
      body[groq ? "max_completion_tokens" : "max_tokens"] = req.maxTokens;
      if (groq && req.json) body.response_format = { type: "json_object" };
      if (groq && model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low"; // keep the answer budget for the answer
      return {
        url: groq ? `https://${HOSTS.groq}/openai/v1/chat/completions` : `https://${HOSTS.openrouter}/api/v1/chat/completions`,
        headers: { "content-type": "application/json", authorization: `Bearer ${p.key ?? ""}`, ...(groq ? {} : { "x-title": "Momo" }) },
        body: json(body),
      };
    }
    case "ollama": {
      return {
        url: `${p.host}/api/chat`,
        headers: { "content-type": "application/json" },
        body: json({
          model, stream: false, ...(req.json ? { format: "json" } : {}),
          messages: [{ role: "system", content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.text }))],
          options: { num_predict: req.maxTokens, temperature: 0.2 },
        }),
      };
    }
  }
}

export type ParsedResponse = { ok: true; text: string } | { ok: false; error: "empty" | "blocked" };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function parseResponse(provider: Provider, raw: unknown): ParsedResponse {
  const j = obj(raw);
  if (provider === "gemini") {
    if (obj(j.promptFeedback).blockReason) return { ok: false, error: "blocked" };
    const cand = (Array.isArray(j.candidates) ? j.candidates[0] : undefined) as Record<string, unknown> | undefined;
    if (!cand) return { ok: false, error: "empty" };
    if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") return { ok: false, error: "blocked" };
    const parts = obj(cand.content).parts;
    const text = Array.isArray(parts) ? parts.map((p) => String(obj(p).text ?? "")).join("") : "";
    return text.trim() ? { ok: true, text: text.trim() } : { ok: false, error: "empty" };
  }
  if (provider === "ollama") {
    const text = String(obj(j.message).content ?? "");
    return text.trim() ? { ok: true, text: text.trim() } : { ok: false, error: "empty" };
  }
  const choice = (Array.isArray(j.choices) ? j.choices[0] : undefined) as Record<string, unknown> | undefined;
  if (choice?.finish_reason === "content_filter") return { ok: false, error: "blocked" };
  const text = String(obj(choice?.message).content ?? "");
  return text.trim() ? { ok: true, text: text.trim() } : { ok: false, error: "empty" };
}

export type HttpFailure = "rate_limited" | "auth" | "bad_model" | "server" | "bad_request";

export function classifyStatus(status: number): HttpFailure {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "bad_model";
  if (status >= 500 || status === 408) return "server";
  return "bad_request";
}
