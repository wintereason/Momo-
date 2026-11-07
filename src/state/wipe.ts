import { PREFS_KEY, type KV } from "./settings";

export const SPEECH_MODEL_CACHE = "transformers-cache";

export interface WipeDeps {
  kv: KV;
  /** the browser Cache API (holds the downloaded speech model) */
  caches?: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> };
  /** the desktop shell: also removes all Chromium storage and the AI request counter */
  desktopWipe?: () => Promise<{ ok: boolean }>;
}

export interface WipeResult {
  /** every step that was attempted succeeded */
  ok: boolean;
  /** what was removed, in plain words, for the confirmation message */
  removed: string[];
  failed: string[];
}

/**
 * "Forget everything": removes every piece of data Momo has stored on this PC. Each step is independent, so one
 * failure never stops the others, and the result says exactly what was and wasn't removed.
 */
export async function wipeAllData(d: WipeDeps): Promise<WipeResult> {
  const removed: string[] = [];
  const failed: string[] = [];

  try { d.kv.removeItem(PREFS_KEY); removed.push("your settings"); } catch { failed.push("your settings"); }

  if (d.caches) {
    try {
      for (const name of await d.caches.keys()) if (name.includes(SPEECH_MODEL_CACHE)) await d.caches.delete(name);
      removed.push("the downloaded speech model");
    } catch { failed.push("the speech model"); }
  }

  if (d.desktopWipe) {
    try {
      const r = await d.desktopWipe();
      if (r.ok) removed.push("all app storage and the AI request counter");
      else failed.push("app storage");
    } catch { failed.push("app storage"); }
  }
  return { ok: failed.length === 0, removed, failed };
}
