import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO_LAG_MS, MouthSync, charShape } from "./speechMouth";
import { CHUNK_CHARS, Speaker, chunkText, type SpeechEvent, type SynthLike, type UtteranceCtor } from "../voice/tts";

const open = (m: MouthSync, t: number) => m.level(t)?.open ?? -1;

describe("MouthSync follows the real playback", () => {
  it("does nothing until speech starts, and does nothing at all without word events (no repeating animation)", () => {
    const m = new MouthSync();
    expect(m.level(0)).toBeNull();
    m.handle({ type: "start", text: "Hello there, this is a long sentence" }, 1000);
    expect(m.speaking).toBe(true);
    for (let t = 1000; t < 6000; t += 50) expect(open(m, t), `t=${t}`).toBe(0); // started, but no word has begun: closed
  });
  it("applies each engine event after the measured audio lag, so the mouth meets the sound", () => {
    const m = new MouthSync();
    m.handle({ type: "start", text: "Open it" }, 1000);
    m.handle({ type: "boundary", index: 0, length: 4 }, 1000);
    expect(open(m, 1000 + AUDIO_LAG_MS - 20)).toBe(0); // the sound has not arrived yet
    expect(open(m, 1000 + AUDIO_LAG_MS + 40)).toBeGreaterThan(0.05);
  });
  it("opens for vowels, closes for lip sounds, and closes again when the word is over", () => {
    expect(charShape("a").open).toBeGreaterThan(0.6);
    expect(charShape("m").open).toBe(0);
    expect(charShape(" ").open).toBe(0);
    const m = new MouthSync(0);
    m.handle({ type: "start", text: "ah no" }, 0);
    m.handle({ type: "boundary", index: 0, length: 2 }, 0);
    expect(open(m, 10)).toBeGreaterThan(0.3);
    expect(open(m, 2000)).toBe(0); // the word had its time; no new word yet = a pause
  });
  it("closes during pauses between words and reopens on the next word", () => {
    const m = new MouthSync(0);
    m.handle({ type: "start", text: "go now" }, 0);
    m.handle({ type: "boundary", index: 0, length: 2 }, 0);
    expect(open(m, 1500)).toBe(0);
    m.handle({ type: "boundary", index: 3, length: 3 }, 1600);
    expect(open(m, 1620)).toBeGreaterThan(0);
  });
  it("stops at once on end, error or cancel, and while paused", () => {
    const m = new MouthSync(0);
    m.handle({ type: "start", text: "aaaa aaaa" }, 0);
    m.handle({ type: "boundary", index: 0, length: 4 }, 0);
    expect(open(m, 50)).toBeGreaterThan(0.1);
    m.handle({ type: "pause" }, 60);
    expect(open(m, 70)).toBe(0);
    m.handle({ type: "resume" }, 500);
    m.handle({ type: "boundary", index: 5, length: 4 }, 520);
    expect(open(m, 560)).toBeGreaterThan(0.1);
    m.handle({ type: "end" }, 600);
    expect(m.speaking).toBe(false);
    expect(m.level(601)).toBeNull();
  });
  it("an interrupted utterance closes the mouth immediately and the next one starts clean", () => {
    const m = new MouthSync(0);
    m.handle({ type: "start", text: "aaaa aaaa" }, 0);
    m.handle({ type: "boundary", index: 0, length: 4 }, 0);
    m.handle({ type: "interrupt" }, 40);
    expect(m.speaking).toBe(true); // no flicker through "silent"
    expect(open(m, 45)).toBe(0);
    m.handle({ type: "start", text: "oooo" }, 100);
    expect(open(m, 100)).toBe(0);
    m.handle({ type: "boundary", index: 0, length: 4 }, 120);
    expect(open(m, 140)).toBeGreaterThan(0.1);
  });
  it("learns the voice's real speed from its word events (fast and slow voices both stay in time)", () => {
    const run = (perChar: number) => {
      const m = new MouthSync(0);
      m.handle({ type: "start", text: "abcdefg abcdefg abcdefg abcdefg abcdefg" }, 0);
      let t = 0;
      for (let i = 0; i < 5; i++) { m.handle({ type: "boundary", index: i * 8, length: 7 }, t); t += perChar * 8; }
      return { m, lastStart: 4 * perChar * 8 };
    };
    const fast = run(40), slow = run(160);
    // 450 ms after the last word began: the fast voice finished that word long ago (closed), the slow one is still inside it
    expect(open(fast.m, fast.lastStart + 450)).toBe(0);
    expect(open(slow.m, slow.lastStart + 450)).toBeGreaterThan(0);
  });
  it("repeated events for the same word (numbers) restart that word, they do not run ahead", () => {
    const m = new MouthSync(0);
    m.handle({ type: "start", text: "about 194.2 gigabytes" }, 0);
    m.handle({ type: "boundary", index: 6, length: 5 }, 0);
    m.handle({ type: "boundary", index: 6, length: 5 }, 300);
    m.handle({ type: "boundary", index: 6, length: 5 }, 600);
    expect(open(m, 640)).toBeGreaterThan(0);
  });
  it("never produces NaN or values outside 0..1 whatever the events", () => {
    const m = new MouthSync(0);
    m.handle({ type: "start", text: "x" }, 0);
    m.handle({ type: "boundary", index: 99, length: 0 }, 5);
    m.handle({ type: "boundary", index: -3 }, 6);
    for (let t = 0; t < 3000; t += 17) {
      const l = m.level(t)!;
      for (const v of [l.open, l.round, l.wide]) expect(Number.isFinite(v)).toBe(true);
      expect(l.open).toBeGreaterThanOrEqual(0);
      expect(l.open).toBeLessThanOrEqual(1.01);
    }
  });
});

// ---- the Speaker: the lifecycle of real playback ----
type U = { text: string; onstart?: () => void; onend?: () => void; onerror?: () => void; onpause?: () => void; onresume?: () => void; onboundary?: (e: { charIndex: number; charLength?: number; name?: string }) => void };
function rig() {
  const spoken: U[] = [];
  const synth = { speak: (u: unknown) => void spoken.push(u as U), cancel: vi.fn(), getVoices: () => [], pause: vi.fn(), resume: vi.fn(), speaking: true, pending: false, paused: false } as unknown as SynthLike & { speaking: boolean; pending: boolean; paused: boolean };
  const Ctor = class { rate = 1; lang = ""; voice = null; volume = 1; pitch = 1; constructor(public text: string) {} } as unknown as UtteranceCtor;
  let clock = 0;
  const sp = new Speaker(synth, Ctor, () => clock);
  const events: SpeechEvent[] = [];
  sp.listen((e) => events.push(e));
  return { spoken, synth, sp, events, tick: (ms: number) => { clock += ms; } };
}
const O = { voiceURI: null, rate: 1, lang: "en" };
afterEach(() => vi.useRealTimers());

describe("Speaker reports the real lifecycle", () => {
  it("normal speech: start, words (with length), end; sentence events are ignored", () => {
    const { sp, spoken, events } = rig();
    sp.speak("Hello there", O);
    expect(events).toEqual([]); // accepted text is not speech: nothing until the engine starts
    spoken[0].onstart!();
    spoken[0].onboundary!({ charIndex: 0, charLength: 5, name: "word" });
    spoken[0].onboundary!({ charIndex: 0, charLength: 0, name: "sentence" });
    spoken[0].onboundary!({ charIndex: 6, charLength: 5, name: "word" });
    spoken[0].onend!();
    expect(events.map((e) => e.type)).toEqual(["start", "boundary", "boundary", "end"]);
    expect(events[1]).toMatchObject({ index: 0, length: 5 });
  });
  it("a newer response interrupts the old one cleanly; the old one's late events are ignored", () => {
    const { sp, spoken, events } = rig();
    sp.speak("First answer", O);
    spoken[0].onstart!();
    sp.speak("Second answer", O);
    spoken[0].onboundary!({ charIndex: 3, charLength: 2, name: "word" }); // late event of the cancelled speech
    spoken[0].onerror!(); // the cancel arrives as an error
    spoken[1].onstart!();
    spoken[1].onend!();
    expect(events.map((e) => e.type)).toEqual(["start", "interrupt", "start", "end"]);
  });
  it("rapid consecutive responses leave exactly one start and one end", () => {
    const { sp, spoken, events } = rig();
    for (let i = 0; i < 5; i++) sp.speak("answer " + i, O);
    spoken.forEach((u, i) => { if (i === 4) { u.onstart!(); u.onend!(); } else u.onerror!(); });
    expect(events.filter((e) => e.type === "end")).toHaveLength(1);
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
  });
  it("queued speech ends once, after the last piece", () => {
    const { sp, spoken, events } = rig();
    sp.speak("One.", O);
    sp.speak("Two.", O, false);
    spoken[0].onstart!(); spoken[0].onend!(); spoken[1].onstart!();
    expect(events.map((e) => e.type)).toEqual(["start", "start"]);
    spoken[1].onend!();
    expect(events.map((e) => e.type)).toEqual(["start", "start", "end"]);
  });
  it("long responses are spoken in sentence-sized pieces and end once", () => {
    const long = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i} of a very long answer.`).join(" ");
    const pieces = chunkText(long);
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.every((p) => p.length <= CHUNK_CHARS * 1.5)).toBe(true);
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(long);
    const { sp, spoken, events } = rig();
    sp.speak(long, { ...O, maxChars: 5000 });
    expect(spoken.length).toBe(pieces.length);
    spoken.forEach((u) => { u.onstart!(); u.onend!(); });
    expect(events.filter((e) => e.type === "end")).toHaveLength(1);
  });
  it("pause and resume are passed on, and stop() ends the mouth in the same call", () => {
    const { sp, spoken, events, synth } = rig();
    sp.speak("Hello there", O);
    spoken[0].onstart!();
    sp.pause(); spoken[0].onpause!(); sp.resume(); spoken[0].onresume!();
    expect(synth.pause).toHaveBeenCalled();
    expect(synth.resume).toHaveBeenCalled();
    sp.stop();
    expect(events.map((e) => e.type)).toEqual(["start", "pause", "resume", "end"]);
    spoken[0].onend!(); // a late event after stop: nothing more
    expect(events).toHaveLength(4);
  });
  it("audio errors end the speech (once)", () => {
    const { sp, spoken, events } = rig();
    sp.speak("Hello", O);
    spoken[0].onstart!(); spoken[0].onerror!(); spoken[0].onend!();
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
  });
  it("watchdog: if the engine goes silent without ever sending 'end', the mouth is released", () => {
    vi.useFakeTimers();
    const { sp, spoken, events, synth, tick } = rig();
    sp.speak("Hello there", O);
    spoken[0].onstart!();
    synth.speaking = false;
    tick(3000);
    vi.advanceTimersByTime(1200);
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
  });
  it("watchdog leaves a paused or still-speaking engine alone", () => {
    vi.useFakeTimers();
    const { sp, spoken, events, synth, tick } = rig();
    sp.speak("Hello there", O);
    spoken[0].onstart!();
    tick(5000); vi.advanceTimersByTime(2000); // the engine still says it is speaking
    synth.speaking = false; synth.paused = true; vi.advanceTimersByTime(2000);
    expect(events.map((e) => e.type)).toEqual(["start"]);
  });
});
