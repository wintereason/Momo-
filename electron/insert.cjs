// Writes dictated text into whatever app has the keyboard focus: put it on the clipboard, then send Ctrl+V.
// (Typing it key by key is slower and breaks on many keyboard layouts and languages; this is what dictation tools do.)
// Pure logic, with the clipboard and the keyboard passed in, so it can be tested without a PC.

const MODIFIERS = ["ctrl", "alt", "shift", "win"];

/** The real keyboard (Windows, via koffi). Not used in tests. */
function createWinKeys(koffi) {
  const user32 = koffi.load("user32.dll");
  const keybd_event = user32.func("void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)");
  const GetAsyncKeyState = user32.func("int16 __stdcall GetAsyncKeyState(int vk)");
  const VK = { ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, v: 0x56 };
  const KEYUP = 0x0002;
  return {
    isDown: (name) => (GetAsyncKeyState(VK[name]) & 0x8000) !== 0,
    paste() {
      keybd_event(VK.ctrl, 0, 0, 0);
      keybd_event(VK.v, 0, 0, 0);
      keybd_event(VK.v, 0, KEYUP, 0);
      keybd_event(VK.ctrl, 0, KEYUP, 0);
    },
  };
}

/**
 * @param {{ clipboard: {readText(): string, writeText(t: string): void}, keys: {isDown(n: string): boolean, paste(): void},
 *           sleep?: (ms: number) => Promise<void>, setTimer?: (fn: () => void, ms: number) => void }} deps
 */
function createInserter(deps) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const setTimer = deps.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); });

  async function modifiersReleased(maxMs) {
    const t0 = Date.now();
    while (MODIFIERS.some((m) => deps.keys.isDown(m))) {
      if (Date.now() - t0 > maxMs) return false;
      await sleep(30);
    }
    return true;
  }

  return {
    /**
     * @returns {Promise<{ok: true} | {ok: false, reason: "empty" | "keys_held", copied: boolean}>}
     * `copied` says whether the text is on the clipboard, so the user can still paste it themselves.
     */
    async insert(text, opts = {}) {
      if (typeof text !== "string" || text.length === 0 || text.length > 4000) return { ok: false, reason: "empty", copied: false };
      let previous;
      try { previous = deps.clipboard.readText(); } catch { previous = undefined; }
      deps.clipboard.writeText(text);
      // The hold shortcut's modifiers (Ctrl/Alt) may still be down: Ctrl+Alt+V would not paste. Wait for them.
      if (!(await modifiersReleased(opts.waitMs ?? 1500))) return { ok: false, reason: "keys_held", copied: true };
      deps.keys.paste();
      if (opts.restoreClipboard && typeof previous === "string") {
        setTimer(() => { try { if (deps.clipboard.readText() === text) deps.clipboard.writeText(previous); } catch { /* ignore */ } }, 700);
      }
      return { ok: true };
    },
  };
}

module.exports = { createInserter, createWinKeys, MODIFIERS };
