// Pure chord tracking for the global hold/toggle shortcut.
// PRIVACY: a low-level keyboard hook sees every key, so this tracker discards anything that is not
// part of the configured chord immediately. Nothing else is stored, logged or forwarded.
const MOD_GROUPS = { Ctrl: ["Ctrl", "CtrlRight"], Alt: ["Alt", "AltRight"], Shift: ["Shift", "ShiftRight"], Win: ["Meta", "MetaRight"] };

/** @param {string} chord e.g. "Ctrl+Alt+Space"; @param {Record<string, number>} keyCodes name -> code (UiohookKey) */
function parseChord(chord, keyCodes) {
  const parts = String(chord).split("+").filter(Boolean);
  const groups = [];
  let key = null;
  for (const p of parts) {
    if (MOD_GROUPS[p]) {
      const codes = MOD_GROUPS[p].map((n) => keyCodes[n]).filter((c) => typeof c === "number");
      if (codes.length === 0) return null;
      groups.push(codes);
    } else if (key === null && typeof keyCodes[p] === "number") {
      key = keyCodes[p];
    } else {
      return null; // unknown key or more than one non-modifier key
    }
  }
  if (groups.length === 0 || (key === null && groups.length < 2)) return null;
  return { groups, key };
}

class ChordTracker {
  constructor(chord, keyCodes) {
    const parsed = parseChord(chord, keyCodes);
    if (!parsed) throw new Error(`Invalid shortcut: ${chord}`);
    this.groups = parsed.groups;
    this.key = parsed.key;
    this.relevant = new Set([...parsed.groups.flat(), ...(parsed.key !== null ? [parsed.key] : [])]);
    this.pressed = new Set();
    this.active = false;
  }
  _isActive() {
    return this.groups.every((g) => g.some((c) => this.pressed.has(c))) && (this.key === null || this.pressed.has(this.key));
  }
  /** @returns {"press"|"repeat"|null} */
  down(code) {
    if (!this.relevant.has(code)) return null; // any other key is ignored and never stored
    this.pressed.add(code);
    if (!this._isActive()) return null;
    if (this.active) return "repeat";
    this.active = true;
    return "press";
  }
  /** @returns {"release"|null} released as soon as ANY required key goes up */
  up(code) {
    if (!this.relevant.has(code)) return null;
    this.pressed.delete(code);
    if (this.active && !this._isActive()) {
      this.active = false;
      return "release";
    }
    return null;
  }
  reset() { this.pressed.clear(); this.active = false; }
}

/** Electron accelerator for globalShortcut (used only to claim the chord and detect conflicts). */
function toAccelerator(chord) {
  const parts = String(chord).split("+").filter(Boolean);
  const hasKey = parts.some((p) => !MOD_GROUPS[p]);
  if (!hasKey) return null; // modifier-only chords cannot be registered; they are observed passively
  return parts.map((p) => (p === "Win" ? "Super" : p)).join("+");
}

module.exports = { ChordTracker, parseChord, toAccelerator };
