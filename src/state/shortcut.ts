const MODS: readonly string[] = ["Ctrl", "Alt", "Shift", "Win"];
const RESERVED = new Set([
  "Ctrl+Alt+Delete", "Alt+Tab", "Alt+F4", "Win+L", "Win+D", "Win+E", "Win+R",
  "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+A", "Ctrl+S", "Ctrl+W",
]);

export function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "Control") return "Ctrl";
  if (key === "Meta") return "Win";
  return key.length === 1 ? key.toUpperCase() : key;
}

interface KeyLike {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  key: string;
}

export function chordFromEvent(e: KeyLike): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Win");
  const k = normalizeKey(e.key);
  if (!MODS.includes(k)) parts.push(k);
  return parts.join("+");
}

export function validateShortcut(chord: string): { ok: true } | { ok: false; reason: string } {
  const parts = chord.split("+").filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: "Press a key combination." };
  const mods = parts.filter((p) => MODS.includes(p));
  const keys = parts.filter((p) => !MODS.includes(p));
  if (keys.length > 1) return { ok: false, reason: "Use at most one non-modifier key." };
  if (keys.length === 0 && mods.length < 2) return { ok: false, reason: "Use at least two modifier keys." };
  if (keys.length === 1 && mods.length === 0) return { ok: false, reason: "Add a modifier (Ctrl, Alt, Shift or Win)." };
  if (RESERVED.has(chord)) return { ok: false, reason: `${chord} is reserved by Windows or common apps.` };
  return { ok: true };
}

/** The non-modifier key of a chord, or null for modifier-only chords. */
export function chordKey(chord: string): string | null {
  return chord.split("+").filter((p) => p && !MODS.includes(p))[0] ?? null;
}

/** Modifiers required by a chord. */
export function chordMods(chord: string): string[] {
  return chord.split("+").filter((p) => MODS.includes(p));
}

/**
 * Two shortcuts must not overlap: if one is made of keys that are all part of the other (for example "Ctrl+Alt" and
 * "Ctrl+Alt+M"), pressing the longer one would also trigger the shorter, so they cannot live side by side.
 */
export function shortcutsConflict(a: string, b: string): boolean {
  const parts = (c: string) => new Set(c.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean));
  const x = parts(a), y = parts(b);
  if (x.size === 0 || y.size === 0) return false;
  const subset = (p: Set<string>, q: Set<string>) => [...p].every((k) => q.has(k));
  return subset(x, y) || subset(y, x);
}
