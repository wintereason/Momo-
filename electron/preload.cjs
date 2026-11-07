// Narrow, explicit bridge between the UI and the desktop shell. No generic IPC, no Node APIs.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("momoDesktop", {
  /** Claim the global shortcut. Resolves { ok, reason?, note? } (e.g. conflict with another app). */
  setShortcut: (role, chord, mode) => ipcRenderer.invoke("momo:set-shortcut", { role: String(role), chord, mode }),
  /** Is the shortcut active right now? Resolves { ok, reason?, note? }. */
  shortcutStatus: (role) => ipcRenderer.invoke("momo:shortcut-status", String(role)),
  /** Chord press/release from the global hook (delivered to the bar). Returns an unsubscribe function. */
  onShortcut: (cb) => {
    const h = (_e, m) => { if (m && (m.role === "dictate" || m.role === "agent") && (m.kind === "press" || m.kind === "release")) cb({ role: m.role, kind: m.kind }); };
    ipcRenderer.on("momo:shortcut", h);
    return () => ipcRenderer.removeListener("momo:shortcut", h);
  },
  openSettings: () => ipcRenderer.send("momo:open-settings"),
  /** the bar is click-through, except while it shows a question or a yes/no card */
  barInteractive: (on) => ipcRenderer.send("momo:bar-interactive", on === true),
  quit: () => ipcRenderer.send("momo:quit"),

  /** The user started speaking: check in the background whether the field in front is a password box. */
  dictationBegin: () => ipcRenderer.send("momo:dictation-begin"),
  /**
   * Clean up what was said and write it. style: "off" | "light" | "polish". mode: "type" (into the app in front) | "copy".
   * Resolves { ok, text?, polished?, source?, note?, inserted?, copied?, blocked?, reason? }.
   */
  dictate: (text, style, mode, restoreClipboard) => ipcRenderer.invoke("momo:dictate", {
    text: String(text), style: String(style), mode: String(mode), restoreClipboard: restoreClipboard === true,
  }),

  /** Typed commands ("Ask Momo" in Settings). Results come back through onRuntimeEvent. */
  submitTranscript: (sessionId, text) => ipcRenderer.send("momo:submit-transcript", { sessionId: String(sessionId), text: String(text) }),
  cancelTask: () => ipcRenderer.send("momo:cancel-task"),
  /** Answer the open confirmation card. */
  respondConfirmation: (taskId, approved) => ipcRenderer.send("momo:respond-confirmation", { taskId: String(taskId), approved: approved === true }),
  /** Permission policy: ask before reversible actions (e.g. opening a folder)? */
  setPolicy: (policy) => ipcRenderer.send("momo:set-policy", {
    confirmReversible: policy && policy.confirmReversible === true,
    confirmScreenRead: policy && policy.confirmScreenRead === true,
  }),
  /** Runtime events (validated again by the UI before use). Returns an unsubscribe function. */
  onRuntimeEvent: (cb) => {
    const h = (_e, event) => cb(event);
    ipcRenderer.on("momo:runtime-event", h);
    return () => ipcRenderer.removeListener("momo:runtime-event", h);
  },

  /** Speech recognition on this PC (Whisper, native). status() -> { cached, state, lastError }. */
  sttStatus: () => ipcRenderer.invoke("momo:stt-status"),
  /** Load the speech model, downloading it the first time. Progress: { percent, loadedMB, totalMB }. Resolves { ok, error? }. */
  sttLoad: async (onProgress) => {
    const h = (_e, p) => { if (p && typeof p.percent === "number" && onProgress) onProgress({ percent: p.percent, loadedMB: p.loadedMB || 0, totalMB: p.totalMB || 0 }); };
    ipcRenderer.on("momo:stt-progress", h);
    try { return await ipcRenderer.invoke("momo:stt-load"); } finally { ipcRenderer.removeListener("momo:stt-progress", h); }
  },
  /** 16 kHz mono audio (Float32Array) -> text. The audio is only passed along in memory. Resolves { ok, text?, reason? }. */
  sttTranscribe: (audio, language) => ipcRenderer.invoke("momo:stt-transcribe", { audio, language: String(language) }),

  /** Which keys/settings from the .env file are set: booleans only, never a value. Re-reads the file each call. */
  envStatus: () => ipcRenderer.invoke("momo:env-status"),
  /** Delete everything Momo stored on this PC (settings storage, speech model, AI counter). */
  wipeData: () => ipcRenderer.invoke("momo:wipe-data"),
});
