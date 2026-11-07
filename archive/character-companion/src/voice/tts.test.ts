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
