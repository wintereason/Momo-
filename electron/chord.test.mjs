import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { ChordTracker, parseChord, toAccelerator } = createRequire(import.meta.url)("./chord.cjs");

const K = { Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640, Shift: 42, ShiftRight: 54, Meta: 3675, MetaRight: 3676, Space: 57, A: 30, B: 48 };

describe("ChordTracker", () => {
  it("presses once, flags key-repeat, releases when any required key goes up", () => {
    const t = new ChordTracker("Ctrl+Alt+Space", K);
    expect(t.down(K.Ctrl)).toBeNull();
    expect(t.down(K.Alt)).toBeNull();
    expect(t.down(K.Space)).toBe("press");
    expect(t.down(K.Space)).toBe("repeat");
    expect(t.down(K.Space)).toBe("repeat");
    expect(t.up(K.Alt)).toBe("release"); // a modifier going up releases too
    expect(t.up(K.Space)).toBeNull();    // no second release
    expect(t.up(K.Ctrl)).toBeNull();
  });

  it("accepts either left or right modifier", () => {
    const t = new ChordTracker("Ctrl+A", K);
    t.down(K.CtrlRight);
    expect(t.down(K.A)).toBe("press");
    expect(t.up(K.CtrlRight)).toBe("release");
  });

  it("works with modifier-only chords", () => {
    const t = new ChordTracker("Ctrl+Alt", K);
    t.down(K.Ctrl);
    expect(t.down(K.AltRight)).toBe("press");
    expect(t.up(K.Ctrl)).toBe("release");
  });

  it("can press again after a release", () => {
    const t = new ChordTracker("Ctrl+Space", K);
    t.down(K.Ctrl); t.down(K.Space); t.up(K.Space);
    expect(t.down(K.Space)).toBe("press");
  });

  it("ignores and never stores unrelated keys", () => {
    const t = new ChordTracker("Ctrl+Space", K);
    expect(t.down(K.B)).toBeNull();
    expect(t.down(K.A)).toBeNull();
    expect(t.pressed.size).toBe(0);
    expect(t.up(K.B)).toBeNull();
    t.down(K.Ctrl);
    expect(t.down(K.Space)).toBe("press");
    expect([...t.pressed].sort()).toEqual([K.Ctrl, K.Space].sort());
  });

  it("does not fire with only part of the chord", () => {
    const t = new ChordTracker("Ctrl+Alt+Space", K);
    t.down(K.Ctrl);
    expect(t.down(K.Space)).toBeNull();
  });

  it("reset clears state", () => {
    const t = new ChordTracker("Ctrl+Space", K);
    t.down(K.Ctrl); t.down(K.Space);
    t.reset();
    expect(t.active).toBe(false);
    expect(t.down(K.Space)).toBeNull();
  });
});

describe("parseChord / toAccelerator", () => {
  it("rejects invalid chords", () => {
    expect(parseChord("Space", K)).toBeNull();
    expect(parseChord("Ctrl", K)).toBeNull();
    expect(parseChord("Ctrl+Nope", K)).toBeNull();
    expect(parseChord("Ctrl+A+B", K)).toBeNull();
    expect(() => new ChordTracker("", K)).toThrow();
  });
  it("builds Electron accelerators", () => {
    expect(toAccelerator("Ctrl+Alt+Space")).toBe("Ctrl+Alt+Space");
    expect(toAccelerator("Win+Shift+A")).toBe("Super+Shift+A");
    expect(toAccelerator("Ctrl+Alt")).toBeNull();
  });
});
