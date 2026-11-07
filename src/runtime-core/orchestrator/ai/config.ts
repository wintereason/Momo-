/**
 * AI configuration, built from the .env values inside the desktop shell. Keys live here and in providers.ts only:
 * they are put into request headers and nowhere else (never URLs, logs, errors, events or the UI).
 * Only FREE services are supported.
 */
export type Provider = "gemini" | "groq" | "openrouter" | "ollama";

export interface ProviderEntry {
  provider: Provider;
  /** API key (cloud providers) */
  key?: string;
  /** local address (Ollama) */
  host?: string;
  modelFast: string;
  modelSmart: string;
}

export interface AiConfig {
  enabled: boolean;
  /** providers to try, in order: the chosen one first, then the other cloud providers that have a key */
  order: ProviderEntry[];
  maxOutputTokens: number;
  maxRequestsPerDay: number;
  /** may text read from the screen be sent to a CLOUD provider? (off by default) */
  allowScreenContext: boolean;
}

/** Free-tier models that exist on each service (checked against the live model lists). */
export const DEFAULT_MODELS: Record<Provider, { fast: string; smart: string }> = {
  // Rolling aliases, not version numbers: Google retires versions for new accounts (2.5 already is), the alias keeps working.
  // The larger "gemini-flash-latest" stalls on the free tier (verified live), so both tiers use the lite model.
  gemini: { fast: "gemini-flash-lite-latest", smart: "gemini-flash-lite-latest" },
  groq: { fast: "openai/gpt-oss-20b", smart: "openai/gpt-oss-120b" },
  openrouter: { fast: "openrouter/free", smart: "openrouter/free" },
  ollama: { fast: "llama3.2", smart: "llama3.2" },
};

export const isCloud = (p: Provider): boolean => p !== "ollama";

const clampInt = (v: string | undefined, def: number, lo: number, hi: number): number => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

export function buildAiConfig(values: Record<string, string | undefined>): AiConfig {
  const chosen = ((values.MOMO_AI_PROVIDER || "gemini").toLowerCase() as Provider);
  const primary: Provider = (["gemini", "groq", "openrouter", "ollama"] as const).includes(chosen) ? chosen : "gemini";
  const keys: Record<string, string | undefined> = { gemini: values.GEMINI_API_KEY, groq: values.GROQ_API_KEY, openrouter: values.OPENROUTER_API_KEY };

  const entry = (p: Provider, overrides: boolean): ProviderEntry | null => {
    const d = DEFAULT_MODELS[p];
    const base = {
      provider: p,
      modelFast: (overrides && values.MOMO_AI_MODEL_FAST) || d.fast,
      modelSmart: (overrides && values.MOMO_AI_MODEL_SMART) || d.smart,
    };
    if (p === "ollama") return values.OLLAMA_HOST ? { ...base, host: values.OLLAMA_HOST.replace(/\/$/, "") } : null;
    return keys[p] ? { ...base, key: keys[p] } : null;
  };

  const order: ProviderEntry[] = [];
  const first = entry(primary, true); // model overrides in .env apply to the chosen provider only (names differ per service)
  if (first) order.push(first);
  // Choosing Ollama means "keep it on my PC": never fall back to a cloud service. Otherwise other cloud keys are backups.
  if (primary !== "ollama") {
    for (const p of ["gemini", "groq", "openrouter"] as const) {
      if (p === primary) continue;
      const e = entry(p, false);
      if (e) order.push(e);
    }
  }

  return {
    enabled: /^true$/i.test(values.MOMO_AI_ENABLED || ""),
    order,
    maxOutputTokens: clampInt(values.MOMO_AI_MAX_OUTPUT_TOKENS, 800, 64, 4000),
    maxRequestsPerDay: clampInt(values.MOMO_AI_MAX_REQUESTS_PER_DAY, 200, 1, 5000),
    allowScreenContext: /^true$/i.test(values.MOMO_AI_ALLOW_SCREEN_CONTEXT || ""),
  };
}
