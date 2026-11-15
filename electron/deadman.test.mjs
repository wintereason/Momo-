import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const req = createRequire(import.meta.url);
const { releaseHeld } = req("./deadman.cjs");
const { createPointerFrom } = req("./humanInput.cjs");

/**
 * The dead-man switch: Momo mirrors what it is holding to a tiny companion process, so that even a killed app cannot leave a mouse
 * button or key down. These tests prove (a) it releases exactly what it was told and nothing else, and (b) the companion exits
 * quietly when its parent goes away.
 */

const fakeNative = (log = []) => ({
  sendMouse: (right) => { log.push(right ? "up:right" : "up:left"); return true; },
  sendKey: (vk) => { log.push("ku:" + vk.toString(16)); return true; },
});

describe("releaseHeld", () => {
  it("lets go of exactly the buttons and keys it was told about", () => {
    const log = [];
    expect(releaseHeld(fakeNative(log), { buttons: ["left"], keys: [0x11, 0x41] })).toBe(3);
    expect(log).toEqual(["up:left", "ku:41", "ku:11"]); // keys in reverse: the modifier last, like a person letting go
  });
  it("does nothing at all when nothing is held", () => {
    const log = [];
    expect(releaseHeld(fakeNative(log), { buttons: [], keys: [] })).toBe(0);
    expect(releaseHeld(fakeNative(log), null)).toBe(0);
    expect(log).toEqual([]);
  });
  it("a failure on one item never stops the rest", () => {
    const log = [];
    const native = { sendMouse: () => { throw new Error("no"); }, sendKey: (vk) => { log.push(vk); return true; } };
    expect(releaseHeld(native, { buttons: ["left", "right"], keys: [0x10] })).toBe(1);
    expect(log).toEqual([0x10]);
  });
});

describe("the companion process", () => {
  const file = fileURLToPath(new URL("./deadman.cjs", import.meta.url));
  it("starts, ignores an empty ledger, and exits cleanly when the parent disconnects", async () => {
    const kid = spawn(process.execPath, [file, "--child"], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    await once(kid, "spawn");
    kid.send({ held: { buttons: [], keys: [] } });
    kid.disconnect();
    const [code] = await once(kid, "exit");
    expect(code).toBe(0);
  }, 15_000);
});

describe("the ledger mirror", () => {
  const native = (() => {
    let pos = { x: 0, y: 0 };
    return {
      pos: () => ({ ...pos }), setPos: (x, y) => { pos = { x, y }; }, escDown: () => false, buttonDown: () => false, keyIsDown: () => false,
      windowAt: () => 7, classAt: () => "App", windowRect: () => null, foregroundRoot: () => 7, cursorClipped: () => false,
      lastInputAgeMs: () => 0, mouseDown: () => true, mouseUp: () => {}, nudge: () => {}, keyDown: () => {}, keyUp: () => {},
      unit: () => true, wheel: () => true,
    };
  })();
  const pointer = (mirror) => createPointerFrom(native, { wait: async () => {}, onHeld: (h) => mirror.push(JSON.parse(JSON.stringify(h))) });

  it("reports every press and every release: a key first, then nothing held", async () => {
    const mirror = [];
    const p = pointer(mirror);
    p.arm();
    expect(await p.press("ctrl+a")).toEqual({ ok: true });
    expect(mirror[0]).toEqual({ buttons: [], keys: [0x11] }); // Ctrl is down, and the mirror knows it
    expect(mirror.at(-1)).toEqual({ buttons: [], keys: [] });
    expect(p.heldCount()).toBe(0);
  });
  it("reports the mouse button while it is down too", async () => {
    const mirror = [];
    const p = pointer(mirror);
    p.arm();
    expect(await p.click(300, 300, { ms: 1 })).toEqual({ ok: true });
    expect(mirror).toContainEqual({ buttons: ["left"], keys: [] });
    expect(mirror.at(-1)).toEqual({ buttons: [], keys: [] });
  });
});
