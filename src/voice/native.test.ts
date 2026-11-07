import { describe, expect, it, vi } from "vitest";
import { NativeWhisperClient } from "./nativeWhisper";
import { cleanTranscript } from "./whisperClient";
import { LiveVoice } from "./liveVoice";
import type { MicSession } from "./micSession";
import type { SttAdapter } from "./stt";

const shell = (over: Record<string, unknown> = {}) => ({
  sttStatus: vi.fn(async () => ({ cached: true, state: "idle" as const, lastError: "" })),
  sttLoad: vi.fn(async () => ({ ok: true })),
  sttTranscribe: vi.fn(async (a: Float32Array, l: string) => ({ ok: true, text: `${a.length}:${l}` })),
  ...over,
});

describe("NativeWhisperClient", () => {
  it("loads through the shell once, then recognises", async () => {
    const s = shell();
    const c = new NativeWhisperClient(s as never);
    expect(await c.isCached()).toBe(true);
    await Promise.all([c.load(), c.load()]);
    expect(s.sttLoad).toHaveBeenCalledTimes(1);
    expect(c.state).toBe("ready");
    expect(await c.transcribe(new Float32Array(10), "hi")).toBe("10:hi");
  });
  it("a failed load shows its reason and can be tried again", async () => {
    const s = shell({ sttLoad: vi.fn(async () => ({ ok: false, error: "offline" })) });
    const c = new NativeWhisperClient(s as never);
    await expect(c.load()).rejects.toThrow("offline");
    expect(c.state).toBe("error");
    expect(c.lastError).toBe("offline");
  });
  it("a failed recognition is an error, and the page re-checks the model next time", async () => {
    const c = new NativeWhisperClient(shell({ sttTranscribe: vi.fn(async () => ({ ok: false, reason: "nope" })) }) as never);
    await expect(c.transcribe(new Float32Array(10))).rejects.toThrow("nope");
    expect(c.state).toBe("idle");
  });
  it("tells listeners about state changes", async () => {
    const c = new NativeWhisperClient(shell() as never);
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.state));
    await c.load();
    expect(seen).toEqual(["loading", "ready"]);
  });
});

describe("cleanTranscript drops what Whisper imagines in silence", () => {
  it("removes sound descriptions and stock phrases on short clips", () => {
    for (const t of ["(soft music)", "[BLANK_AUDIO]", " (door closes) ", "Thank you.", "thanks for watching!", "you", "Bye."]) expect(cleanTranscript(t, 1.5), t).toBe("");
  });
  it("keeps real speech, including the same words in a longer sentence or a longer clip", () => {
    expect(cleanTranscript(" I went to the market. ", 4)).toBe("I went to the market.");
    expect(cleanTranscript("Thank you for your help with the report", 2)).toBe("Thank you for your help with the report");
    expect(cleanTranscript("Thank you.", 6)).toBe("Thank you."); // a long recording that really ends with thanks
    expect(cleanTranscript("मुझे कल जाना है", 2)).toBe("मुझे कल जाना है");
    expect(cleanTranscript("", 2)).toBe("");
  });
});

describe("LiveVoice keeps listening a moment after release", () => {
  const setup = (tailMs: number) => {
    const order: string[] = [];
    const mic = {
      start: vi.fn(async () => {}),
      stop: vi.fn(() => { order.push("mic.stop"); return { durationMs: 2000, peak: 0.5, empty: false, audio: new Float32Array(32000) }; }),
      cancel: vi.fn(),
    } as unknown as MicSession;
    const adapter: SttAdapter = {
      id: "t", label: "t", disclosure: "", available: () => true,
      begin: () => ({ stop: async () => "hello", cancel: () => {} }),
    };
    const events: string[] = [];
    const live = new LiveVoice((e) => events.push((e as { type: string }).type), mic, () => adapter, () => { order.push("transcript"); }, () => null, tailMs);
    return { live, order, events, mic };
  };
  it("waits the tail before closing the microphone", async () => {
    vi.useFakeTimers();
    const { live, mic } = setup(250);
    await live.start();
    const p = live.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(mic.stop).not.toHaveBeenCalled(); // still recording the last word
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(mic.stop).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it("a cancel during the tail stops everything and nothing is recognised", async () => {
    vi.useFakeTimers();
    const { live, mic, order } = setup(250);
    await live.start();
    const p = live.stop();
    await vi.advanceTimersByTimeAsync(100);
    live.cancel();
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(mic.stop).not.toHaveBeenCalled();
    expect(order).not.toContain("transcript");
    vi.useRealTimers();
  });
  it("no tail by default (existing behaviour)", async () => {
    const { live, mic } = setup(0);
    await live.start();
    await live.stop();
    expect(mic.stop).toHaveBeenCalledTimes(1);
  });
});
