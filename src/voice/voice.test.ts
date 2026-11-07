import { describe, expect, it } from "vitest";
import { MicError, MicSession, mapMicError, type MicDeps } from "./micSession";
import { LiveVoice } from "./liveVoice";
import { SttError, type SttAdapter, type SttSession } from "./stt";
import { companionReducer, initialCompanionState } from "../state/companionState";
import { parseRuntimeEvent, type RuntimeEvent } from "../types/runtime-events";

function fakeStream() {
  const listeners: Record<string, () => void> = {};
  let stopped = 0;
  const track = { stop: () => { stopped++; }, addEventListener: (n: string, fn: () => void) => { listeners[n] = fn; } };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, unplug: () => listeners.ended?.(), get stopped() { return stopped; } };
}

function deps(opts: { err?: string; peak?: number; clock?: { t: number }; noMeter?: boolean } = {}) {
  const clock = opts.clock ?? { t: 0 };
  const fs = fakeStream();
  const d: MicDeps = {
    getUserMedia: async () => {
      if (opts.err) throw Object.assign(new Error("x"), { name: opts.err });
      return fs.stream;
    },
    now: () => clock.t,
    createMeter: opts.noMeter ? undefined : (_s, onLevel) => { onLevel(opts.peak ?? 0.5); return () => null; },
  };
  return { d, fs, clock };
}

describe("mic error mapping", () => {
  it("maps DOM errors to stable codes", () => {
    expect(mapMicError({ name: "NotAllowedError" }).code).toBe("mic_denied");
    expect(mapMicError({ name: "NotFoundError" }).code).toBe("mic_unavailable");
    expect(mapMicError({ name: "NotReadableError" }).code).toBe("mic_unavailable");
    expect(mapMicError(new Error("boom")).code).toBe("mic_failed");
    expect(mapMicError(null).code).toBe("mic_failed");
  });
});

describe("MicSession", () => {
  it("surfaces permission denial and releases nothing", async () => {
    const { d } = deps({ err: "NotAllowedError" });
    const m = new MicSession(d);
    await expect(m.start()).rejects.toMatchObject({ code: "mic_denied" });
    expect(m.active).toBe(false);
  });

  it("only one session at a time", async () => {
    const { d } = deps();
    const m = new MicSession(d);
    await m.start();
    await expect(m.start()).rejects.toBeInstanceOf(MicError);
  });

  it("stop releases the device and reports a normal capture", async () => {
    const { d, fs, clock } = deps({ peak: 0.4 });
    const m = new MicSession(d);
    await m.start();
    clock.t = 1500;
    const r = m.stop();
    expect(r).toMatchObject({ durationMs: 1500, empty: false });
    expect(fs.stopped).toBe(1);
    expect(m.active).toBe(false);
  });

  it("flags silence and too-short captures as empty", async () => {
    let { d, clock } = deps({ peak: 0.001 });
    let m = new MicSession(d);
    await m.start(); clock.t = 2000;
    expect(m.stop().empty).toBe(true);
    ({ d, clock } = deps({ peak: 0.5 }));
    m = new MicSession(d);
    await m.start(); clock.t = 100;
    expect(m.stop().empty).toBe(true);
  });

  it("reports an unplugged device while recording", async () => {
    const { d, fs } = deps();
    let ended = 0;
    const m = new MicSession(d, () => {}, () => { ended++; });
    await m.start();
    fs.unplug();
    expect(ended).toBe(1);
  });
});

// ---- LiveVoice ----
function fakeStt(result: string | Error): SttAdapter & { began: number; cancelled: number } {
  const a = {
    id: "fake", label: "fake", disclosure: "", began: 0, cancelled: 0,
    available: () => true,
    begin(): SttSession {
      a.began++;
      return { stop: async () => { if (result instanceof Error) throw result; return result; }, cancel: () => { a.cancelled++; } };
    },
  };
  return a;
}

function harness(o: { micErr?: string; peak?: number; stt?: string | Error } = {}) {
  const clock = { t: 0 };
  const { d, fs } = deps({ err: o.micErr, peak: o.peak, clock });
  const events: RuntimeEvent[] = [];
  const texts: string[] = [];
  const stt = fakeStt(o.stt ?? "open my project");
  const live = new LiveVoice(
    (e) => { const p = parseRuntimeEvent(e); if (p) events.push(p); },
    new MicSession(d), () => stt, (_s, t) => texts.push(t),
  );
  const ui = () => events.reduce(companionReducer, initialCompanionState);
  return { live, events, texts, clock, fs, stt, ui };
}

describe("LiveVoice", () => {
  it("success: started -> stopped -> transcript, and hands the text on", async () => {
    const h = harness();
    await h.live.start();
    expect(h.ui().ui).toBe("listening");
    h.clock.t = 2000;
    await h.live.stop();
    expect(h.events.map((e) => e.type)).toEqual(["voice.started", "voice.stopped", "transcript.ready"]);
    expect(h.ui()).toMatchObject({ ui: "thinking", transcript: "open my project" });
    expect(h.texts).toEqual(["open my project"]);
    expect(h.fs.stopped).toBe(1);
  });

  it("permission denied -> disabled state, never listening", async () => {
    const h = harness({ micErr: "NotAllowedError" });
    await h.live.start();
    expect(h.events.map((e) => e.type)).toEqual(["runtime.error"]);
    expect(h.ui().ui).toBe("disabled");
  });

  it("no microphone -> disabled state", async () => {
    const h = harness({ micErr: "NotFoundError" });
    await h.live.start();
    expect(h.ui().ui).toBe("disabled");
  });

  it("silent audio -> empty_audio error, speech service never asked", async () => {
    const h = harness({ peak: 0.001 });
    await h.live.start(); h.clock.t = 2000;
    await h.live.stop();
    expect(h.events.at(-1)).toMatchObject({ type: "runtime.error", code: "empty_audio" });
    expect(h.ui().ui).toBe("error");
    expect(h.texts).toEqual([]);
    expect(h.stt.cancelled).toBe(1);
  });

  it("blank transcript -> empty_audio error", async () => {
    const h = harness({ stt: "   " });
    await h.live.start(); h.clock.t = 2000;
    await h.live.stop();
    expect(h.events.at(-1)).toMatchObject({ code: "empty_audio" });
  });

  it("transcription failure -> error with a retryable state", async () => {
    const h = harness({ stt: new SttError("stt_failed", "net") });
    await h.live.start(); h.clock.t = 2000;
    await h.live.stop();
    expect(h.events.at(-1)).toMatchObject({ code: "stt_failed" });
    expect(h.ui().ui).toBe("error");
  });

  it("ignores a second start while a session is active", async () => {
    const h = harness();
    await h.live.start();
    await h.live.start();
    expect(h.events.filter((e) => e.type === "voice.started")).toHaveLength(1);
    expect(h.stt.began).toBe(1);
  });

  it("stop requested while the mic is still starting is honoured", async () => {
    const h = harness();
    h.clock.t = 0;
    const p = h.live.start();
    void h.live.stop(); // hold released before getUserMedia resolved
    h.clock.t = 2000;
    await p;
    await Promise.resolve();
    expect(h.events.map((e) => e.type)).toContain("voice.stopped");
  });

  it("cancel releases the microphone and emits nothing further", async () => {
    const h = harness();
    await h.live.start();
    h.live.cancel();
    await h.live.stop();
    expect(h.fs.stopped).toBe(1);
    expect(h.events.map((e) => e.type)).toEqual(["voice.started"]);
    expect(h.live.busy).toBe(false);
  });

  it("device unplugged -> mic_unavailable and cleanup", async () => {
    const h = harness();
    await h.live.start();
    h.live.deviceLost();
    expect(h.events.at(-1)).toMatchObject({ code: "mic_unavailable" });
    expect(h.fs.stopped).toBe(1);
  });
});
