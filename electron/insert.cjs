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
     * opts.beforePaste(): async, {ok:false} cancels the paste. opts.afterPaste(): async, returns a verification string.
     * @returns {Promise<{ok: true, verification?: string} | {ok: false, reason: "empty" | "keys_held" | "target_lost", copied: boolean, detail?: string}>}
     * `copied` says whether the text is on the clipboard, so the user can still paste it themselves.
     */
    async insert(text, opts = {}) {
      if (typeof text !== "string" || text.length === 0 || text.length > 4000) return { ok: false, reason: "empty", copied: false };
      let previous;
      try { previous = deps.clipboard.readText(); } catch { previous = undefined; }
      deps.clipboard.writeText(text);
      // The hold shortcut's modifiers (Ctrl/Alt) may still be down: Ctrl+Alt+V would not paste. Wait for them.
      if (!(await modifiersReleased(opts.waitMs ?? 1500))) return { ok: false, reason: "keys_held", copied: true };
      // Focus the identified field only now, right before the paste, and refuse to paste if that did not work: the paste
      // key is never sent into a field that was not identified and focused.
      if (opts.beforePaste) {
        let g;
        try { g = await opts.beforePaste(); } catch { g = { ok: false }; }
        if (!g || g.ok === false) return { ok: false, reason: "target_lost", copied: true, detail: g && g.reason };
      }
      deps.keys.paste();
      let verification;
      if (opts.afterPaste) { try { verification = await opts.afterPaste(); } catch { verification = "unreadable"; } }
      // Give the old clipboard back only once the paste is confirmed to have arrived (it could still be needed otherwise).
      if (opts.restoreClipboard && typeof previous === "string" && verification !== "failed") {
        setTimer(() => { try { if (deps.clipboard.readText() === text) deps.clipboard.writeText(previous); } catch { /* ignore */ } }, 700);
      }
      return { ok: true, verification };
    },
  };
}

module.exports = { createInserter, createWinKeys, MODIFIERS };
