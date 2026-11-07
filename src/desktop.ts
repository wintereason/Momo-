/** What the .env file contains, as booleans only. Secret values never reach the UI. */
export interface EnvStatus {
  fileFound: boolean;
  files: string[];
  ai: {
    enabled: boolean;
    provider: "gemini" | "groq" | "openrouter" | "ollama";
    ready: boolean;
    /** may screen text be sent to a cloud provider? (off unless the user turned it on) */
    screenContext: boolean;
    /** AI requests sent today, and the daily limit that keeps Momo inside the free tier */
    requestsToday: number;
    limitPerDay: number;
    keys: { gemini: boolean; groq: boolean; openrouter: boolean; ollama: boolean };
  };
  speech: { hfToken: boolean };
  problems: string[];
}

/** "dictate" = speak and Momo writes it; "agent" = speak a goal and Momo does it */
export type ShortcutRole = "dictate" | "agent";
export interface ShortcutStatus { ok: boolean; reason?: string; note?: string }

/** The answer to one dictation (see the `momo:dictate` handler in electron/main.cjs). */
export interface DictateAnswer {
  ok: boolean;
  reason?: string;
  text?: string;
  polished?: boolean;
  source?: string;
  note?: string;
  inserted?: boolean;
  copied?: boolean;
  blocked?: "password" | "keys_held" | "empty";
}

/** Bridge exposed by the Electron preload. Absent when running in a plain browser. */
export interface MomoDesktop {
  setShortcut(role: ShortcutRole, chord: string, mode: "hold" | "toggle"): Promise<ShortcutStatus>;
  shortcutStatus(role: ShortcutRole): Promise<ShortcutStatus | null>;
  onShortcut(cb: (m: { role: ShortcutRole; kind: "press" | "release" }) => void): () => void;
  /** the bar is click-through, except while it shows a question or a yes/no card */
  barInteractive(on: boolean): void;
  openSettings(): void;
  quit(): void;
  /** the user started speaking: check in the background whether the focused field is a password box */
  dictationBegin(): void;
  dictate(text: string, style: "off" | "light" | "polish", mode: "type" | "copy", restoreClipboard: boolean): Promise<DictateAnswer>;
  submitTranscript(sessionId: string, text: string): void;
  cancelTask(): void;
  wipeData(): Promise<{ ok: boolean }>;
  envStatus(): Promise<EnvStatus | null>;
  respondConfirmation(taskId: string, approved: boolean): void;
  setPolicy(policy: { confirmReversible: boolean; confirmScreenRead: boolean }): void;
  /** Speech recognition on this PC (native Whisper in the shell). */
  sttStatus(): Promise<{ cached: boolean; state: "idle" | "loading" | "ready" | "error"; lastError: string } | null>;
  sttLoad(onProgress?: (p: { percent: number; loadedMB: number; totalMB: number }) => void): Promise<{ ok: boolean; error?: string }>;
  sttTranscribe(audio: Float32Array, language: string): Promise<{ ok: boolean; text?: string; reason?: string }>;
  /** Raw runtime events: validate with parseRuntimeEvent before use. */
  onRuntimeEvent(cb: (event: unknown) => void): () => void;
}
declare global {
  interface Window { momoDesktop?: MomoDesktop }
}
export const desktop: MomoDesktop | null = typeof window !== "undefined" ? window.momoDesktop ?? null : null;
