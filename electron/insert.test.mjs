import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { createInserter } = createRequire(import.meta.url)("./insert.cjs");

const make = (down = []) => {
  let clip = "old";
  const calls = [];
  const timers = [];
  const state = { down: new Set(down) };
  const ins = createInserter({
    clipboard: { readText: () => clip, writeText: (t) => { clip = t; calls.push("write:" + t); } },
    keys: { isDown: (n) => state.down.has(n), paste: () => calls.push("paste") },
    sleep: async () => { state.down.clear(); }, // the user lets go while we wait
    setTimer: (fn) => timers.push(fn),
  });
  return { ins, calls, timers, clip: () => clip, state };
};

describe("inserting dictated text", () => {
  it("puts the text on the clipboard, then pastes", async () => {
    const m = make();
    expect(await m.ins.insert("Hello there.")).toEqual({ ok: true });
    expect(m.calls).toEqual(["write:Hello there.", "paste"]);
  });
  it("waits for the shortcut's modifier keys to be released before pasting", async () => {
    const m = make(["ctrl", "alt"]);
    await m.ins.insert("Hi.");
    expect(m.calls).toEqual(["write:Hi.", "paste"]); // pasted only after the keys were up
  });
  it("if the keys stay held it does not paste, but the text is on the clipboard for the user", async () => {
    let clip = "";
    const ins = createInserter({
      clipboard: { readText: () => clip, writeText: (t) => { clip = t; } },
      keys: { isDown: () => true, paste: () => { throw new Error("must not paste"); } },
      sleep: async () => {},
    });
    expect(await ins.insert("Hi.", { waitMs: 0 })).toEqual({ ok: false, reason: "keys_held", copied: true });
    expect(clip).toBe("Hi.");
  });
  it("refuses empty, non-text and very long input", async () => {
    const m = make();
    for (const bad of ["", null, undefined, 5, "x".repeat(4001)]) expect(await m.ins.insert(bad)).toMatchObject({ ok: false, copied: false });
    expect(m.calls).toEqual([]);
  });
  it("can give the old clipboard back, but only if nothing else was copied meanwhile", async () => {
    const m = make();
    await m.ins.insert("Hi.", { restoreClipboard: true });
    m.timers[0]();
    expect(m.clip()).toBe("old");
    // the user copied something else before the timer fired: leave their new clipboard alone
    let clip = "old"; const timers = [];
    const ins = createInserter({
      clipboard: { readText: () => clip, writeText: (t) => { clip = t; } },
      keys: { isDown: () => false, paste: () => {} }, setTimer: (fn) => timers.push(fn),
    });
    await ins.insert("Hi.", { restoreClipboard: true });
    clip = "something the user copied";
    timers[0]();
    expect(clip).toBe("something the user copied");
  });
});
