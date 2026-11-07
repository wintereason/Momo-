import { describe, expect, it } from "vitest";
import { activationStep, type ActivationState } from "./activation";
import { companionReducer, initialCompanionState, type CompanionState } from "./companionState";
import { chordFromEvent, validateShortcut } from "./shortcut";
import { defaultPrefs, loadPrefs, savePrefs, PREFS_KEY, type KV } from "./settings";
import { parseRuntimeEvent } from "../types/runtime-events";

const idle: ActivationState = { recording: false, busy: false };

describe("activation logic (single mode)", () => {
  it("hold: press starts once, key-repeat ignored, release stops once", () => {
    let s = idle;
    let r = activationStep("hold", s, { kind: "press" });
    expect(r.action).toBe("start");
    s = r.next;
    expect(activationStep("hold", s, { kind: "press", repeat: true }).action).toBeNull();
    expect(activationStep("hold", s, { kind: "press" }).action).toBeNull();
    r = activationStep("hold", s, { kind: "release" });
    expect(r.action).toBe("stop");
    expect(activationStep("hold", r.next, { kind: "release" }).action).toBeNull();
  });

  it("toggle: first press starts, release ignored, second press stops", () => {
    let r = activationStep("toggle", idle, { kind: "press" });
    expect(r.action).toBe("start");
    expect(activationStep("toggle", r.next, { kind: "release" }).action).toBeNull();
    r = activationStep("toggle", r.next, { kind: "press" });
    expect(r.action).toBe("stop");
  });

  it("refuses overlapping sessions while busy, in both modes", () => {
    const busy = { recording: false, busy: true };
    expect(activationStep("hold", busy, { kind: "press" }).action).toBeNull();
    expect(activationStep("toggle", busy, { kind: "press" }).action).toBeNull();
  });

  it("cancel stops an active recording only", () => {
    expect(activationStep("hold", { recording: true, busy: false }, { kind: "cancel" }).action).toBe("cancel");
    expect(activationStep("hold", idle, { kind: "cancel" }).action).toBeNull();
  });
});

describe("companion state transitions", () => {
  const run = (events: Parameters<typeof companionReducer>[1][], from: CompanionState = initialCompanionState) =>
    events.reduce(companionReducer, from);

  it("happy path ends in success only via verified task.completed", () => {
    let s = run([
      { type: "voice.started", sessionId: "a" },
      { type: "voice.stopped", sessionId: "a" },
      { type: "transcript.ready", sessionId: "a", text: "hi" },
    ]);
    expect(s.ui).toBe("thinking");
    s = run([{ type: "task.state", taskId: "t", state: "working" }], s);
    expect(s.ui).toBe("working");
    s = run([{ type: "task.completed", taskId: "t", summary: "ok", verified: true }], s);
    expect(s.ui).toBe("success");
    expect(s.result?.verified).toBe(true);
  });

  it("task.state cannot force success or sleeping", () => {
    const w = run([{ type: "task.state", taskId: "t", state: "working" }]);
    expect(run([{ type: "task.state", taskId: "t", state: "success" }], w).ui).toBe("working");
    expect(run([{ type: "task.state", taskId: "t", state: "sleeping" }], w).ui).toBe("working");
  });

  it("only one voice session at a time", () => {
    const l = run([{ type: "voice.started", sessionId: "a" }]);
    expect(run([{ type: "voice.started", sessionId: "b" }], l).sessionId).toBe("a");
    const w = run([{ type: "task.state", taskId: "t", state: "working" }]);
    expect(run([{ type: "voice.started", sessionId: "b" }], w).ui).toBe("working");
  });

  it("ignores stale/mismatched session events", () => {
    const l = run([{ type: "voice.started", sessionId: "a" }]);
    expect(run([{ type: "voice.stopped", sessionId: "zzz" }], l).ui).toBe("listening");
  });

  it("confirmation -> blocked, failure kinds map to sorry/error", () => {
    expect(run([{ type: "task.confirmation_required", taskId: "t", summary: "s" }]).ui).toBe("blocked");
    expect(run([{ type: "task.failed", taskId: "t", summary: "s", recoverable: true }]).ui).toBe("sorry");
    expect(run([{ type: "task.failed", taskId: "t", summary: "s", recoverable: false }]).ui).toBe("error");
  });

  it("sleeping only exits via wake; runtime events are ignored", () => {
    const sl = run([{ type: "local.sleep" }]);
    expect(sl.ui).toBe("sleeping");
    expect(run([{ type: "voice.started", sessionId: "a" }], sl).ui).toBe("sleeping");
    expect(run([{ type: "local.wake" }], sl).ui).toBe("idle");
  });

  it("only idle falls asleep", () => {
    const l = run([{ type: "voice.started", sessionId: "a" }]);
    expect(run([{ type: "local.sleep" }], l).ui).toBe("listening");
  });

  it("mic denied -> disabled; wake retries", () => {
    const d = run([{ type: "runtime.error", code: "mic_denied", message: "m" }]);
    expect(d.ui).toBe("disabled");
    expect(run([{ type: "local.wake" }], d).ui).toBe("idle");
  });
});

describe("event validation at the boundary", () => {
  it("accepts valid and rejects invalid events", () => {
    expect(parseRuntimeEvent({ type: "voice.started", sessionId: "x" })).not.toBeNull();
    expect(parseRuntimeEvent({ type: "task.completed", taskId: "t", summary: "s", verified: false })).toBeNull();
    expect(parseRuntimeEvent({ type: "task.state", taskId: "t", state: "dancing" })).toBeNull();
    expect(parseRuntimeEvent({ type: "nope" })).toBeNull();
    expect(parseRuntimeEvent("rm -rf /")).toBeNull();
    expect(parseRuntimeEvent(null)).toBeNull();
  });
});

describe("shortcut validation", () => {
  it("builds and validates chords", () => {
    expect(chordFromEvent({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, key: " " })).toBe("Ctrl+Alt+Space");
    expect(validateShortcut("Ctrl+Alt+Space").ok).toBe(true);
    expect(validateShortcut("Ctrl+Alt").ok).toBe(true);
    expect(validateShortcut("Space").ok).toBe(false);
    expect(validateShortcut("Alt+Tab").ok).toBe(false);
    expect(validateShortcut("Ctrl+C").ok).toBe(false);
    expect(validateShortcut("").ok).toBe(false);
  });
});

describe("preferences persistence", () => {
  const mem = (): KV & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };
  it("old saved settings from the character version still load, and gain the new defaults", () => {
    const store = new Map<string, string>([[PREFS_KEY, JSON.stringify({ version: 1, companionId: "mochi", activationMode: "hold", shortcut: "Ctrl+Alt+Space", showRecordingIndicator: true, voiceInput: "mock", inactivityMinutes: 30, widget: {}, privacy: { saveTranscriptHistory: false, saveRawAudio: false } })]]);
    const kv: KV = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) };
    expect(loadPrefs(kv).dictation.style).toBe("polish");
    expect(loadPrefs(kv).shortcut).toBe("Ctrl+Alt+Space");
  });
  it("Momo asks only for real decisions by default, and old 'ask about everything' settings are reset once", () => {
    expect(defaultPrefs.permissions).toEqual({ confirmReversible: false, confirmScreenRead: false, rev: 2 });
    const old = { ...defaultPrefs, permissions: { confirmReversible: true, confirmScreenRead: true } }; // saved by the earlier version
    const store = new Map<string, string>([[PREFS_KEY, JSON.stringify(old)]]);
    const kv: KV = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) };
    expect(loadPrefs(kv).permissions).toEqual({ confirmReversible: false, confirmScreenRead: false, rev: 2 });
    // a choice made under the new rule is kept
    savePrefs(kv, { ...loadPrefs(kv), permissions: { confirmReversible: true, confirmScreenRead: false, rev: 2 } });
    expect(loadPrefs(kv).permissions.confirmReversible).toBe(true);
  });
  it("defaults are privacy-safe", () => {
    expect(defaultPrefs.privacy).toEqual({ saveTranscriptHistory: false, saveRawAudio: false });
    expect(defaultPrefs.dictation).toEqual({ style: "polish", mode: "type", restoreClipboard: false });
  });
  it("round-trips and recovers from corrupt data", () => {
    const m = mem();
    savePrefs(m, { ...defaultPrefs, activationMode: "toggle", dictation: { ...defaultPrefs.dictation, style: "light" } });
    expect(loadPrefs(m)).toMatchObject({ activationMode: "toggle", dictation: { style: "light" } });
    m.setItem(PREFS_KEY, "{bad json");
    expect(loadPrefs(m)).toEqual(defaultPrefs);
    m.setItem(PREFS_KEY, JSON.stringify({ ...defaultPrefs, activationMode: "both" }));
    expect(loadPrefs(m)).toEqual(defaultPrefs);
  });
  it("persists no transcript or task data", () => {
    const m = mem();
    savePrefs(m, defaultPrefs);
    expect([...m.data.keys()]).toEqual([PREFS_KEY]);
    expect(Object.keys(JSON.parse(m.data.get(PREFS_KEY)!)).sort()).toEqual(
      ["activationMode", "agentShortcut", "dictation", "localModelConsent", "microphoneId", "permissions", "privacy", "shortcut", "speechLanguage", "version", "voiceOutput"],
    );
  });
});

describe("two shortcuts", () => {
  it("overlapping shortcuts are detected, separate ones are fine", async () => {
    const { shortcutsConflict } = await import("./shortcut");
    expect(shortcutsConflict("Ctrl+Alt", "Ctrl+Alt+M")).toBe(true);
    expect(shortcutsConflict("Ctrl+Alt+Space", "Ctrl+Alt+Space")).toBe(true);
    expect(shortcutsConflict("Ctrl+Alt+Space", "Ctrl+Shift+Space")).toBe(false);
    expect(shortcutsConflict("Ctrl+Alt+Space", "Ctrl+Alt+M")).toBe(false);
  });
});
