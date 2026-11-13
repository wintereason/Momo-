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
  blocked?: "password" | "keys_held" | "empty" | "target_lost" | "not_confirmed" | "no_field" | "expired";
  /** the text was pasted into a verified field; did we see it arrive? */
  verified?: "confirmed" | "unconfirmed" | "overwritten" | "unreadable";
  /** the name of the field it went into */
  field?: string;
  /** a selection was in the way: the text was added after it instead of replacing it */
  collapsedSelection?: boolean;
  /** Momo needs the user: pick one of the listed fields, or click inside one */
  needs?: "choose" | "click";
  options?: { id: number; label: string; detail?: string }[];
  cancelled?: boolean;
}

/** What the shadow-cursor window is told (positions are in the overlay's own pixels). */
export type CursorMessage =
  | { kind: "show"; x: number; y: number }
  | { kind: "say"; text: string }
  | { kind: "move"; x: number; y: number; w: number; h: number; action: "look" | "select" | "click" | "type" | "submit"; label?: string; text?: string; say?: string }
  /** Momo identified its target: highlight that exact element, say what it is for, before anything moves */
  | { kind: "aim"; x: number; y: number; w: number; h: number; label?: string; say?: string; tone?: "button" | "search" | "input" | "menu" | "list" | "window" | "other" }
  /** the REAL pointer's own position / what it is doing right now (physical -> overlay pixels already converted) */
  | { kind: "track"; phase: "move" | "hover" | "press" | "release" | "key"; x?: number; y?: number; ch?: string }
  /** the step's outcome, only after Momo checked it */
  | { kind: "result"; state: "verifying" | "verified" | "unconfirmed" | "failed"; text?: string }
  /** the user took over */
  | { kind: "stop"; reason: "mouse" | "esc" }
  | { kind: "done"; ok: boolean; result?: "ok" | "unconfirmed" | "failed" }
  | { kind: "hide" };

/** Bridge exposed by the Electron preload. Absent when running in a plain browser. */
export interface MomoDesktop {
  setShortcut(role: ShortcutRole, chord: string, mode: "hold" | "toggle"): Promise<ShortcutStatus>;
  shortcutStatus(role: ShortcutRole): Promise<ShortcutStatus | null>;
  onShortcut(cb: (m: { role: ShortcutRole; kind: "press" | "release" }) => void): () => void;
  /** the bar is click-through, except while it shows a question or a yes/no card */
  barInteractive(on: boolean): void;
  /** resize the bar window for the compact face or the expanded character (it stays transparent and click-through) */
  setBarLayout(view: "compact" | "expanded"): void;
  openSettings(): void;
  quit(): void;
  /** the user started speaking: check in the background whether the focused field is a password box */
  dictationBegin(): void;
  dictate(text: string, style: "off" | "light" | "polish", mode: "type" | "copy", restoreClipboard: boolean): Promise<DictateAnswer>;
  /** dictation asked which field to use / for a click: the answers */
  dictationPick(id: number): Promise<DictateAnswer>;
  dictationWaitClick(): Promise<DictateAnswer>;
  dictationCancel(): void;
  submitTranscript(sessionId: string, text: string): void;
  cancelTask(): void;
  wipeData(): Promise<{ ok: boolean }>;
  envStatus(): Promise<EnvStatus | null>;
  /** write-only: save keys/settings typed by the user into Momo's .env; values are never returned */
  envSave(updates: Record<string, string>): Promise<{ ok: boolean; problems: string[]; status: EnvStatus | null }>;
  respondConfirmation(taskId: string, approved: boolean): void;
  setPolicy(policy: { confirmReversible: boolean; confirmScreenRead: boolean }): void;
  /** Speech recognition on this PC (native Whisper in the shell). */
  sttStatus(): Promise<{ cached: boolean; state: "idle" | "loading" | "ready" | "error"; lastError: string } | null>;
  sttLoad(onProgress?: (p: { percent: number; loadedMB: number; totalMB: number }) => void): Promise<{ ok: boolean; error?: string }>;
  sttTranscribe(audio: Float32Array, language: string, engine?: "local" | "cloud"): Promise<{ ok: boolean; text?: string; reason?: string; engine?: "local" | "cloud"; note?: string }>;
  /** the shadow cursor window: what to draw (it only exists while a task runs) */
  onCursor(cb: (m: CursorMessage) => void): () => void;
  /** show the shadow cursor while Momo works on a task? */
  setShadowCursor(on: boolean): void;
  /** let Momo use the real mouse and keyboard to act like a person (it stops the moment you touch the mouse or press Esc) */
  setHumanInput(on: boolean): void;
  /** start with Windows (stays in the tray) */
  getAutostart(): Promise<boolean>;
  setAutostart(on: boolean): Promise<boolean>;
  /** Raw runtime events: validate with parseRuntimeEvent before use. */
  onRuntimeEvent(cb: (event: unknown) => void): () => void;
}
declare global {
  interface Window { momoDesktop?: MomoDesktop }
}
export const desktop: MomoDesktop | null = typeof window !== "undefined" ? window.momoDesktop ?? null : null;
