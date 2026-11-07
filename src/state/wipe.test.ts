import { describe, expect, it } from "vitest";
import { wipeAllData } from "./wipe";
import { PREFS_KEY, defaultPrefs, loadPrefs, savePrefs, type KV } from "./settings";

const mem = (): KV & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};

describe("delete everything Momo stored", () => {
  it("removes preferences, the speech model and the shell's data", async () => {
    const kv = mem();
    savePrefs(kv, { ...defaultPrefs, microphoneId: "dev-1" });
    const cacheNames = new Set(["transformers-cache", "other-site-cache"]);
    let shell = 0;
    const r = await wipeAllData({
      kv,
      caches: { keys: async () => [...cacheNames], delete: async (n) => cacheNames.delete(n) },
      desktopWipe: async () => { shell++; return { ok: true }; },
    });
    expect(r.ok).toBe(true);
    expect(kv.data.has(PREFS_KEY)).toBe(false);
    expect(loadPrefs(kv)).toEqual(defaultPrefs); // back to a first launch
    expect([...cacheNames]).toEqual(["other-site-cache"]); // only Momo's own cache is touched
    expect(shell).toBe(1);
    expect(r.removed.join(" ")).toMatch(/settings.*speech model.*app storage/);
    expect(r.failed).toEqual([]);
  });

  it("each step is independent: one failure never stops the rest, and is reported", async () => {
    const kv = mem();
    savePrefs(kv, defaultPrefs);
    const r = await wipeAllData({
      kv,
      caches: { keys: async () => { throw new Error("denied"); }, delete: async () => true },
      desktopWipe: async () => ({ ok: true }),
    });
    expect(r.ok).toBe(false);
    expect(kv.data.has(PREFS_KEY)).toBe(false); // still removed
    expect(r.failed).toEqual(["the speech model"]);
    expect(r.removed.join(" ")).toContain("app storage");
  });

  it("a shell failure is reported honestly", async () => {
    const r = await wipeAllData({ kv: mem(), desktopWipe: async () => ({ ok: false }) });
    expect(r.ok).toBe(false);
    expect(r.failed[0]).toContain("app storage");
  });

  it("works in the browser (no shell) and with nothing stored", async () => {
    const r = await wipeAllData({ kv: mem() });
    expect(r.ok).toBe(true);
  });

  it("storage that throws is contained", async () => {
    const kv: KV = { getItem: () => null, setItem: () => {}, removeItem: () => { throw new Error("blocked"); } };
    const r = await wipeAllData({ kv });
    expect(r.ok).toBe(false);
    expect(r.failed).toContain("your settings");
  });
});
