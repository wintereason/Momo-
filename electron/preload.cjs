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
  /** the bar window's size: "compact" (small face above the pill) or "expanded" (the character, larger) */
  setBarLayout: (view) => ipcRenderer.send("momo:bar-layout", view === "expanded" ? "expanded" : "compact"),
  /** where the bar's buttons and cards are (window pixels): the shell lets the mouse through everywhere else */
  setBarHitRects: (rects) => ipcRenderer.send("momo:bar-hit-rects", Array.isArray(rects) ? rects.slice(0, 12).map((r) => ({ x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) })) : []),
  /** the Language Teacher plays the other role of a roleplay interview (one line per call) */
  languageConverse: (req) => ipcRenderer.invoke("momo:language-converse", req),
  /** the learner's progress as short text, for the orchestrator's read-only learning tool */
  setLanguageSummary: (text) => ipcRenderer.send("momo:language-summary", String(text).slice(0, 600)),
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

  /** Dictation asked a question (which field? / click into one). Both resolve like dictate(). */
  dictationPick: (id) => ipcRenderer.invoke("momo:dictation-pick", { id: Number(id) }),
  dictationWaitClick: () => ipcRenderer.invoke("momo:dictation-wait-click"),
  dictationCancel: () => ipcRenderer.send("momo:dictation-cancel"),

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
  sttTranscribe: (audio, language, engine) => ipcRenderer.invoke("momo:stt-transcribe", { audio, language: String(language), engine: engine === "cloud" ? "cloud" : "local" }),
  /** Online voice (ElevenLabs, only while its key is set in .env): text + voice id -> { ok, audio (mp3 bytes) } or { ok:false, reason }. The key never reaches the page. */
  ttsOnline: (text, voiceId) => ipcRenderer.invoke("momo:tts-online", { text: String(text).slice(0, 600), voiceId: String(voiceId) }),
  /** The shadow-cursor window: what to draw. The shell sends only these shapes; they are checked again here. */
  onCursor: (cb) => {
    const num = (v) => (Number.isFinite(v) ? Math.max(-30000, Math.min(30000, v)) : 0);
    const h = (_e, m) => {
      if (!m || typeof m !== "object") return;
      if (m.kind === "show") cb({ kind: "show", x: num(m.x), y: num(m.y) });
      else if (m.kind === "say" && typeof m.text === "string") cb({ kind: "say", text: m.text.slice(0, 80) });
      else if (m.kind === "move" && ["look", "select", "click", "type", "submit"].includes(m.action)) cb({ kind: "move", x: num(m.x), y: num(m.y), w: Math.max(0, num(m.w)), h: Math.max(0, num(m.h)), action: m.action, label: typeof m.label === "string" ? m.label.slice(0, 80) : undefined, text: typeof m.text === "string" ? m.text.slice(0, 80) : undefined, say: typeof m.say === "string" ? m.say.slice(0, 100) : undefined });
      else if (m.kind === "aim") cb({ kind: "aim", x: num(m.x), y: num(m.y), w: Math.max(0, num(m.w)), h: Math.max(0, num(m.h)), label: typeof m.label === "string" ? m.label.slice(0, 80) : undefined, say: typeof m.say === "string" ? m.say.slice(0, 100) : undefined, tone: ["button", "search", "input", "menu", "list", "window", "other"].includes(m.tone) ? m.tone : undefined });
      else if (m.kind === "track" && ["move", "hover", "press", "release", "key"].includes(m.phase)) cb({ kind: "track", phase: m.phase, x: Number.isFinite(m.x) ? num(m.x) : undefined, y: Number.isFinite(m.y) ? num(m.y) : undefined, ch: typeof m.ch === "string" ? m.ch.slice(0, 4) : undefined });
      else if (m.kind === "result" && ["verifying", "verified", "unconfirmed", "failed"].includes(m.state)) cb({ kind: "result", state: m.state, text: typeof m.text === "string" ? m.text.slice(0, 100) : undefined });
      else if (m.kind === "stop") cb({ kind: "stop", reason: m.reason === "esc" ? "esc" : "mouse" });
      else if (m.kind === "done") cb({ kind: "done", ok: m.ok === true, result: ["ok", "unconfirmed", "failed"].includes(m.result) ? m.result : m.ok === true ? "ok" : "failed" });
      else if (m.kind === "hide") cb({ kind: "hide" });
    };
    ipcRenderer.on("momo:cursor", h);
    return () => ipcRenderer.removeListener("momo:cursor", h);
  },
  /** Show the shadow cursor while Momo works on a task? */
  setShadowCursor: (on) => ipcRenderer.send("momo:set-shadow-cursor", on === true),
  /** Let Momo act with the real mouse and keyboard, like a person? */
  setHumanInput: (on) => ipcRenderer.send("momo:set-human-input", on === true),
  /** Start Momo when Windows starts (it then waits quietly in the tray). */
  getAutostart: () => ipcRenderer.invoke("momo:autostart-get"),
  setAutostart: (on) => ipcRenderer.invoke("momo:autostart-set", on === true),

  /** Which keys/settings from the .env file are set: booleans only, never a value. Re-reads the file each call. */
  envStatus: () => ipcRenderer.invoke("momo:env-status"),
  /** Save keys typed by the user (write-only: values never come back). Resolves { ok, problems, status }. */
  envSave: (updates) => ipcRenderer.invoke("momo:env-save", updates && typeof updates === "object" ? updates : {}),
  /** Delete everything Momo stored on this PC (settings storage, speech model, AI counter). */
  wipeData: () => ipcRenderer.invoke("momo:wipe-data"),
});
