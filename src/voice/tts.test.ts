import { describe, expect, it } from "vitest";
import { Speaker, pickVoice, speechText, type SynthLike, type UtteranceCtor, type VoiceLike } from "./tts";

describe("speechText", () => {
  it("reads drive sizes naturally", () => {
    expect(speechText("D: 293.0 GB total, 198.9 GB free (94.1 GB used).")).toBe(
      "D drive 293.0 gigabytes total, 198.9 gigabytes free (94.1 gigabytes used).",
    );
  });
  it("drops the written-only 'verified' tags and ticks", () => {
    expect(speechText("Found it: D:\\Single Folder (checked on disk).")).toBe("Found it: D drive, Single Folder");
    expect(speechText("Done ✓ (verified)")).not.toMatch(/verified|✓/);
  });
  it("turns paths and option lists into speakable text", () => {
    const t = speechText("I found 2 folders: 1) C:\\Users\\me\\Downloads  2) D:\\Share\\downloads. Which one?");
    expect(t).toContain("option 1, C drive, Users, me, Downloads");
    expect(t).toContain("option 2, D drive, Share, downloads");
    expect(t).not.toContain("\\");
  });
  it("keeps long text short, ending at a clean break", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Window number ${i} is open`).join("; ");
    const t = speechText(long, 120);
    expect(t.length).toBeLessThanOrEqual(121);
    expect(t.endsWith(".")).toBe(true);
  });
  it("returns an empty string for nothing", () => {
    expect(speechText("   ")).toBe("");
    expect(speechText("✓")).not.toMatch(/\S{2,}/);
  });
});

const V = (voiceURI: string, lang: string, localService = true): VoiceLike => ({ voiceURI, name: voiceURI, lang, localService });

describe("pickVoice", () => {
  const voices = [V("online-en", "en-US", false), V("local-en", "en-GB"), V("local-hi", "hi-IN")];
  it("uses the chosen voice when it is installed", () => expect(pickVoice(voices, "local-hi", "en")?.voiceURI).toBe("local-hi"));
  it("falls back to a local voice for the language", () => expect(pickVoice(voices, null, "en")?.voiceURI).toBe("local-en"));
  it("ignores a voice that is no longer installed", () => expect(pickVoice(voices, "gone", "hi")?.voiceURI).toBe("local-hi"));
  it("returns undefined (system default) when nothing matches", () => expect(pickVoice(voices, null, "fr")).toBeUndefined());
  it("gives each avatar its own voice when none is chosen", () => {
    const win = [V("Microsoft David Desktop", "en-US"), V("Microsoft Zira Desktop", "en-US")];
    expect(pickVoice(win, null, "en", ["David"], 0)?.voiceURI).toBe("Microsoft David Desktop");
    expect(pickVoice(win, null, "en", ["Zira"], 1)?.voiceURI).toBe("Microsoft Zira Desktop");
    // no preferred name installed: the slots still keep the two avatars apart
    const other = [V("Voice A", "en-US"), V("Voice B", "en-US")];
    expect(pickVoice(other, null, "en", ["David"], 0)?.voiceURI).not.toBe(pickVoice(other, null, "en", ["Zira"], 1)?.voiceURI);
    // a single installed voice is shared (nothing else to give); a chosen voice always wins over the hints
    expect(pickVoice([V("Only", "en-US")], null, "en", ["Zira"], 1)?.voiceURI).toBe("Only");
    expect(pickVoice(win, "Microsoft Zira Desktop", "en", ["David"], 0)?.voiceURI).toBe("Microsoft Zira Desktop");
  });
});

describe("Speaker", () => {
  function fake(voices: VoiceLike[] = [V("local-en", "en-US")]) {
    const log: string[] = [];
    const utterances: { text: string; rate: number; voice: unknown; lang: string }[] = [];
    const synth: SynthLike = {
      speak: (u) => { log.push("speak"); utterances.push(u as never); },
      cancel: () => { log.push("cancel"); },
      getVoices: () => voices,
    };
    class U { rate = 1; lang = ""; voice: unknown = null; volume = 1; constructor(public text: string) {} }
    return { speaker: new Speaker(synth, U as unknown as UtteranceCtor), log, utterances };
  }
  const opts = { voiceURI: null, rate: 1, lang: "en" };

  it("cancels what is being said before speaking the new reply", () => {
    const f = fake();
    expect(f.speaker.speak("D: 5 GB free", opts)).toBe(true);
    expect(f.log).toEqual(["cancel", "speak"]);
    expect(f.utterances[0].text).toBe("D drive 5 gigabytes free");
  });
  it("clamps the speed and uses the matching voice", () => {
    const f = fake();
    f.speaker.speak("hello", { ...opts, rate: 9 });
    f.speaker.speak("hello", { ...opts, rate: NaN });
    expect(f.utterances[0].rate).toBe(1.6);
    expect(f.utterances[1].rate).toBe(1);
    expect((f.utterances[0].voice as VoiceLike).voiceURI).toBe("local-en");
  });
  it("does nothing without a speech engine or without text", () => {
    expect(new Speaker(null, null).speak("hi", opts)).toBe(false);
    expect(new Speaker(null, null).available).toBe(false);
    expect(fake().speaker.speak("   ", opts)).toBe(false);
  });
  it("stop() cancels", () => {
    const f = fake();
    f.speaker.stop();
    expect(f.log).toEqual(["cancel"]);
  });
});

import { vi } from "vitest";
import { onlineVoiceIdFor, CLOUD_VOICE_IDS, defaultCharacter } from "../character/config";
describe("Speaker with an online voice", () => {
  /** a fake clip: 4 s long, its position is set by the test */
  class FakeClip {
    static last: FakeClip | null = null;
    duration = 4; pos = 0; stopped = false; paused = false; ended: (() => void) | null = null;
    constructor() { FakeClip.last = this; }
    position() { return this.pos; }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    stop() { this.stopped = true; }
    onEnded(cb: () => void) { this.ended = cb; }
  }
  const player = async () => new FakeClip();
  function setup(online: { synth: (t: string, id: string) => Promise<{ ok: true; audio: Uint8Array } | { ok: false; reason: string }> }, pl: typeof player | null = player) {
    const spoken: string[] = [];
    const synth: SynthLike = { speak: (u) => { spoken.push((u as { text: string }).text); }, cancel: () => {}, getVoices: () => [V("local-en", "en-US")] };
    class U { rate = 1; lang = ""; voice: unknown = null; volume = 1; constructor(public text: string) {} }
    const sp = new Speaker(synth, U as unknown as UtteranceCtor, () => Date.now(), pl as never);
    sp.setOnline(online);
    const events: string[] = [];
    sp.listen((e) => events.push(e.type + (e.type === "boundary" ? ":" + e.index : "")));
    return { sp, spoken, events };
  }
  const ok = { ok: true as const, audio: new Uint8Array(500) };
  const o = { voiceURI: null, rate: 1, lang: "en", onlineVoiceId: "DODLEQrClDo8wCz460ld" };

  it("plays the online audio, moves the mouth word by word over its real duration, and ends once", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const { sp, spoken, events } = setup({ synth: async (t, id) => { calls.push(id + "|" + t); return ok; } });
      expect(sp.speak("Hello there my friend", o)).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual(["DODLEQrClDo8wCz460ld|Hello there my friend"]);
      expect(spoken).toEqual([]); // the Windows voice stays silent
      expect(events[0]).toBe("start");
      const c = FakeClip.last!;
      c.pos = 2.2; // a little over halfway
      await vi.advanceTimersByTimeAsync(100);
      expect(events.filter((e) => e.startsWith("boundary"))).toEqual(["boundary:0", "boundary:6", "boundary:12"]); // "Hello", "there", "my" begun; "friend" (15/21 of 4 s = 2.86 s) not yet
      c.ended?.();
      expect(events.at(-1)).toBe("end");
      expect(events.filter((e) => e === "end")).toHaveLength(1);
      expect(sp.busy).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("pauses, resumes and stops the clip, and tells the mouth", async () => {
    vi.useFakeTimers();
    try {
      const { sp, events } = setup({ synth: async () => ok });
      sp.speak("Hello there", o);
      await vi.advanceTimersByTimeAsync(10);
      const c = FakeClip.last!;
      sp.pause(); expect(c.paused).toBe(true);
      sp.resume(); expect(c.paused).toBe(false);
      sp.stop(); expect(c.stopped).toBe(true);
      expect(events).toEqual(expect.arrayContaining(["start", "pause", "resume", "end"]));
      expect(sp.busy).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("falls back to the Windows voice, with the reason, when the online voice fails", async () => {
    const { sp, spoken } = setup({ synth: async () => ({ ok: false, reason: "No online voice key is set." }) });
    sp.speak("Hello there", o);
    await new Promise((r) => setTimeout(r, 5));
    expect(spoken).toEqual(["Hello there"]);
    expect(sp.lastOnlineError).toBe("No online voice key is set.");
  });
  it("falls back when the audio cannot be decoded or played", async () => {
    const { sp, spoken } = setup({ synth: async () => ok }, (async () => { throw new Error("bad audio"); }) as never);
    sp.speak("Hello there", o);
    await new Promise((r) => setTimeout(r, 5));
    expect(spoken).toEqual(["Hello there"]);
    expect(sp.lastOnlineError).toMatch(/could not be played/);
  });
  it("speaks locally when there is no audio player at all", async () => {
    let called = 0;
    const { sp, spoken } = setup({ synth: async () => { called++; return ok; } }, null);
    sp.speak("Hello", o);
    expect(called).toBe(0);
    expect(spoken).toEqual(["Hello"]);
  });
  it("never uses the online voice when a Windows voice was chosen, or no id is given", async () => {
    let called = 0;
    const { sp, spoken } = setup({ synth: async () => { called++; return ok; } });
    sp.speak("one", { ...o, voiceURI: "local-en" });
    sp.speak("two", { ...o, onlineVoiceId: undefined });
    await new Promise((r) => setTimeout(r, 5));
    expect(called).toBe(0);
    expect(spoken).toEqual(["one", "two"]);
  });
  it("a stop or newer speech while the audio is still being made drops the old audio", async () => {
    let release: (v: typeof ok) => void = () => {};
    const { sp, spoken, events } = setup({ synth: () => new Promise((r) => { release = r as never; }) });
    sp.speak("Old reply", o);
    sp.stop();
    release(ok);
    await new Promise((r) => setTimeout(r, 5));
    expect(events).not.toContain("start");
    expect(spoken).toEqual([]);
    expect(sp.busy).toBe(false);
  });
});

describe("which avatars ask for an online voice", () => {
  it("each sprite avatar has its own id; the drawn character and a switched-off avatar have none", () => {
    expect(onlineVoiceIdFor({ art: "dark", onlineVoice: true })).toBe(CLOUD_VOICE_IDS.dark);
    expect(onlineVoiceIdFor({ art: "bob", onlineVoice: true })).toBe(CLOUD_VOICE_IDS.bob);
    expect(onlineVoiceIdFor({ art: "bob", onlineVoice: false })).toBeUndefined();
    expect(onlineVoiceIdFor({ art: "drawn", onlineVoice: true })).toBeUndefined();
    expect(defaultCharacter.onlineVoice).toBe(true);
  });
});
