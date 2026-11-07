import { z } from "zod";

export const PrefsSchema = z.object({
  version: z.literal(1),
  /** hold the shortcut to speak, or press once to start and again to stop */
  activationMode: z.enum(["hold", "toggle"]),
  /** the shortcut to DICTATE (speak, and Momo writes it) */
  shortcut: z.string().max(64),
  /** the shortcut to give Momo a GOAL (speak, and Momo plans, acts and checks it) */
  agentShortcut: z.string().max(64).default("Ctrl+Shift+Space"),
  /** spoken language for local Whisper (it cannot auto-detect) */
  speechLanguage: z.string().regex(/^[a-z]{2,3}$/).default("en"),
  /** the user agreed to download the local speech model */
  localModelConsent: z.boolean().default(false),
  microphoneId: z.string().nullable().default(null),
  /** Momo speaks what it is doing, what it verified and what failed (with the voices already on this PC) */
  voiceOutput: z.object({
    enabled: z.boolean().default(true),
    voiceURI: z.string().nullable().default(null),
    rate: z.number().min(0.6).max(1.6).default(1),
  }).default({ enabled: true, voiceURI: null, rate: 1 }),
  /** what happens to the words after they are recognised */
  dictation: z.object({
    /** off = exactly what was heard; light = fix mistakes only; polish = fix mistakes and improve the wording */
    style: z.enum(["off", "light", "polish"]).default("polish"),
    /** type = write it into the app you are in; copy = only put it on the clipboard */
    mode: z.enum(["type", "copy"]).default("type"),
    /** put the previous clipboard text back after typing (otherwise the dictated text stays on the clipboard) */
    restoreClipboard: z.boolean().default(false),
  }).default({ style: "polish", mode: "type", restoreClipboard: false }),
  /** what Momo may do without asking, for typed commands ("Ask Momo") */
  permissions: z.object({
    /** ask before reversible actions such as opening a folder (consequential ones always ask) */
    confirmReversible: z.boolean(),
    /** ask before looking at what is on a window (screen contents are private) */
    confirmScreenRead: z.boolean().default(false),
    /** 2 = "ask only for real decisions" (delete, send, sign in/out, pay...). Older saved settings are reset once. */
    rev: z.literal(2).default(2),
  }).default({ confirmReversible: false, confirmScreenRead: false, rev: 2 }),
  privacy: z.object({
    saveTranscriptHistory: z.boolean(),
    saveRawAudio: z.boolean(),
  }),
});
export type Prefs = z.infer<typeof PrefsSchema>;

export const defaultPrefs: Prefs = {
  version: 1,
  activationMode: "hold",
  shortcut: "Ctrl+Alt+Space",
  agentShortcut: "Ctrl+Shift+Space",
  speechLanguage: "en",
  localModelConsent: false,
  microphoneId: null,
  voiceOutput: { enabled: true, voiceURI: null, rate: 1 },
  dictation: { style: "polish", mode: "type", restoreClipboard: false },
  permissions: { confirmReversible: false, confirmScreenRead: false, rev: 2 },
  privacy: { saveTranscriptHistory: false, saveRawAudio: false },
};

export const PREFS_KEY = "momo.prefs.v1";

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** Only allowed preferences are persisted. Corrupt data falls back to defaults. */
export function loadPrefs(store: KV): Prefs {
  try {
    const raw = store.getItem(PREFS_KEY);
    if (!raw) return defaultPrefs;
    const parsed = JSON.parse(raw);
    // Momo used to ask before every small action. It now asks only for real decisions, so settings saved under the old
    // rule are reset to the new default once (the user can switch the extra questions back on in Privacy & data).
    if (parsed && typeof parsed === "object" && parsed.permissions?.rev !== 2) delete parsed.permissions;
    const r = PrefsSchema.safeParse(parsed);
    return r.success ? r.data : defaultPrefs;
  } catch {
    return defaultPrefs;
  }
}

export function savePrefs(store: KV, p: Prefs): void {
  try {
    store.setItem(PREFS_KEY, JSON.stringify(PrefsSchema.parse(p)));
  } catch {
    /* storage unavailable: keep running with in-memory prefs */
  }
}
