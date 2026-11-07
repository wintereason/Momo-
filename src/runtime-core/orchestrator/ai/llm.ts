import type { AiConfig, Provider, ProviderEntry } from "./config";
import { assertAllowedUrl, buildRequest, classifyStatus, parseResponse, type BuiltRequest, type LlmRequest } from "./providers";

export type LlmFailure =
  | "disabled" | "no_provider" | "daily_limit" | "rate_limited" | "auth" | "network" | "server" | "bad_response" | "blocked";

export type LlmResult =
  | { ok: true; text: string; provider: Provider; model: string }
  | { ok: false; reason: LlmFailure };

export interface Usage { date: string; count: number }
/** Where the daily request count is kept (a tiny file in the shell). It holds a date and a number, nothing else. */
export interface UsageStore { load(): Usage; save(u: Usage): void }

export interface LlmOptions {
  config: () => AiConfig;
  usage: UsageStore;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const COOLDOWN_MS = 60_000;
// when several providers fail, report the most useful reason
const PRIORITY: LlmFailure[] = ["rate_limited", "auth", "blocked", "bad_response", "server", "network"];

type Outcome = { kind: "ok"; text: string } | { kind: "dropped" } | { kind: "failed"; failure: LlmFailure };

const today = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * One call to a free AI service, with: a daily request cap that keeps you inside the free tier, a pinned set of
 * hosts, timeouts, one retry for a dropped connection, and automatic fallback to your other providers when one is
 * busy or down. It never logs, and its failures are plain categories (never a response body, key or URL).
 */
export class LlmClient {
  private cooling = new Map<Provider, number>();

  constructor(private o: LlmOptions) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  usageToday(): { count: number; limit: number } {
    const u = this.o.usage.load();
    return { count: u.date === today(this.now()) ? u.count : 0, limit: this.o.config().maxRequestsPerDay };
  }

  async complete(req: Omit<LlmRequest, "maxTokens"> & { tier: "fast" | "smart"; maxTokens?: number; timeoutMs?: number }): Promise<LlmResult> {
    const cfg = this.o.config();
    if (!cfg.enabled) return { ok: false, reason: "disabled" };
    if (cfg.order.length === 0) return { ok: false, reason: "no_provider" };

    const failures: LlmFailure[] = [];
    for (const entry of cfg.order) {
      if ((this.cooling.get(entry.provider) ?? 0) > this.now()) { failures.push("rate_limited"); continue; }

      const model = req.tier === "fast" ? entry.modelFast : entry.modelSmart;
      const built = buildRequest(entry, model, { ...req, maxTokens: req.maxTokens ?? cfg.maxOutputTokens });

      for (let attempt = 0; attempt < 2; attempt++) { // a dropped connection is retried once on the same provider
        // the daily cap counts every request that is actually sent, including retries and fallbacks
        const t = today(this.now());
        const u = this.o.usage.load();
        const count = u.date === t ? u.count : 0;
        if (count >= cfg.maxRequestsPerDay) return { ok: false, reason: "daily_limit" };
        this.o.usage.save({ date: t, count: count + 1 });

        const outcome = await this.send(entry, built, req.timeoutMs);
        if (outcome.kind === "ok") return { ok: true, text: outcome.text, provider: entry.provider, model };
        if (outcome.kind === "dropped") {
          if (attempt === 0) continue;
          failures.push("network");
        } else {
          failures.push(outcome.failure);
        }
        break;
      }
    }
    return { ok: false, reason: PRIORITY.find((p) => failures.includes(p)) ?? "network" };
  }

  /** One HTTP request to one provider, reduced to a small outcome. */
  private async send(entry: ProviderEntry, built: BuiltRequest, timeoutMs?: number): Promise<Outcome> {
    try {
      assertAllowedUrl(built.url); // never talk to anything but the pinned hosts (or this PC for Ollama)
      const res = await (this.o.fetchFn ?? fetch)(built.url, {
        method: "POST", headers: built.headers, body: built.body, signal: AbortSignal.timeout(timeoutMs ?? this.o.timeoutMs ?? 25_000),
      });
      if (!res.ok) {
        const kind = classifyStatus(res.status);
        if (kind === "rate_limited") {
          const ra = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
          this.cooling.set(entry.provider, this.now() + (Number.isFinite(ra) ? Math.min(ra, 120) * 1000 : COOLDOWN_MS));
        }
        return { kind: "failed", failure: kind === "rate_limited" ? "rate_limited" : kind === "auth" ? "auth" : "server" };
      }
      let body: unknown;
      try { body = await res.json(); } catch { return { kind: "failed", failure: "bad_response" }; }
      const parsed = parseResponse(entry.provider, body);
      if (!parsed.ok) return { kind: "failed", failure: parsed.error === "blocked" ? "blocked" : "bad_response" };
      return { kind: "ok", text: parsed.text };
    } catch (e) {
      // a blocked destination is a bug, not a flaky network: never retry it
      if (e instanceof Error && e.message === "blocked destination") return { kind: "failed", failure: "network" };
      return { kind: "dropped" }; // timeout, DNS failure, connection reset
    }
  }
}
