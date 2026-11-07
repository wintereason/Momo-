import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Picker } from "./components/Picker";
import { Settings } from "./components/Settings";
import { Widget } from "./components/Widget";
import { DebugPanel } from "./components/DebugPanel";
import { MockRuntime, type Scenario } from "./runtime/mockRuntime";
import { actionsToReach } from "./runtime/debugStates";
import { CAN_START_VOICE, companionReducer, initialCompanionState } from "./state/companionState";
import { activationStep, type ActivationInput } from "./state/activation";
import { chordKey, chordMods, normalizeKey } from "./state/shortcut";
import { loadPrefs, savePrefs, type Prefs } from "./state/settings";
import { parseRuntimeEvent, type CompanionUiState } from "./types/runtime-events";
import { desktop, type ShortcutStatus } from "./desktop";
import { LiveVoice } from "./voice/liveVoice";
import { MIC_MESSAGES, MicSession, browserMicDeps } from "./voice/micSession";
import { webSpeechAdapter } from "./voice/stt";
import { Speaker } from "./voice/tts";
import { chooseQuality } from "./scene/perf";
import { webglAvailable } from "./scene/webgl";
import { createWhisperAdapter } from "./voice/whisperClient";

let spokenLanguage = "en"; // kept in sync with the saved preference below
const whisperAdapter = createWhisperAdapter(undefined, () => spokenLanguage);

const BUSY: ReadonlySet<CompanionUiState> = new Set(["transcribing", "thinking", "working"]);
const AUTO_DISMISS: ReadonlySet<CompanionUiState> = new Set(["success", "partial_success", "sorry", "error"]);

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(window.localStorage));
  const [state, dispatch] = useReducer(companionReducer, initialCompanionState);
  const [view, setView] = useState<"widget" | "picker">("widget");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // the mock-runtime controls are a browser-preview aid; hidden by default in the desktop app
  const [debugOpen, setDebugOpen] = useState(!desktop);
  const [scenario, setScenario] = useState<Scenario>("storage");
  const [activity, setActivity] = useState(0);
  const [level, setLevel] = useState(0);
  // if the 3D scene is too slow (or the GPU context is lost) Momo drops to the light view for the rest of the session
  const [sceneDowngraded, setSceneDowngraded] = useState<null | "slow" | "context-lost">(null);
  const [modelInfo, setModelInfo] = useState<{ using: boolean; placeholder: boolean } | null>(null);
  const [webgl] = useState(() => webglAvailable());
  const [shortcutStatus, setShortcutStatus] = useState<ShortcutStatus | null>(null);

  const rtRef = useRef<MockRuntime | null>(null);
  if (!rtRef.current) rtRef.current = new MockRuntime();
  const rt = rtRef.current;

  const stateRef = useRef(state);
  stateRef.current = state;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Live voice (real microphone + speech adapter). Null when the browser has no microphone API.
  const liveRef = useRef<LiveVoice | null>(null);
  if (!liveRef.current) {
    const deps = browserMicDeps();
    if (deps) {
      const mic = new MicSession(deps, setLevel, () => liveRef.current?.deviceLost());
      liveRef.current = new LiveVoice(
        (e) => rt.emit(e), mic,
        () => (desktop || prefsRef.current.speechEngine === "local" ? whisperAdapter : webSpeechAdapter),
        (sid, text) => (desktop ? desktop.submitTranscript(sid, text) : rt.runTranscript(sid, text)),
        () => prefsRef.current.microphoneId,
      );
    }
  }

  // Desktop shell: small widget window normally; larger window while settings/picker/debug are open.
  const needsPanel = view === "picker" || prefs.companionId === null || settingsOpen || debugOpen;
  useEffect(() => {
    desktop?.setMode(needsPanel ? "panel" : "widget", prefs.widget.size);
  }, [needsPanel, prefs.widget.size]);

  // Transparent areas of the window let clicks through; Momo's own UI does not.
  useEffect(() => {
    const d = desktop;
    if (!d) return;
    document.documentElement.classList.add("desktop");
    let ignoring = true;
    const onMove = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      const interactive = !!el?.closest?.(".widget, .settings, .debug, .picker, .debug-open");
      if (interactive === ignoring) { ignoring = !interactive; d.ignoreMouse(ignoring); }
    };
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, []);

  spokenLanguage = prefs.speechLanguage;

  // Persist only the allowed preferences.
  useEffect(() => savePrefs(window.localStorage, prefs), [prefs]);

  // Runtime -> UI; explicit cleanup on exit (session state is discarded).
  useEffect(() => {
    const off = rt.subscribe(dispatch);
    const exit = () => { liveRef.current?.cancel(); rt.dispose(); dispatch({ type: "local.reset" }); };
    window.addEventListener("beforeunload", exit);
    return () => { off(); window.removeEventListener("beforeunload", exit); };
  }, [rt]);

  useEffect(() => rt.setScenario(scenario), [rt, scenario]);

  // Single activation entry point for BOTH keyboard and mic button.
  const activate = useCallback((input: ActivationInput) => {
    const s = stateRef.current;
    if (s.ui === "sleeping") {
      // The first activation only wakes Momo.
      if (input.kind === "press" && !input.repeat) dispatch({ type: "local.wake" });
      return;
    }
    if (s.ui === "disabled") return;
    const p = prefsRef.current;
    const local = !!desktop || p.speechEngine === "local";
    const useLive = p.voiceInput === "live" && (local ? p.localModelConsent : p.speechDisclosureAccepted);
    const live = useLive ? liveRef.current : null;
    if (useLive && !live) {
      if (input.kind === "press" && !input.repeat) rt.emit({ type: "runtime.error", code: "mic_unavailable", message: MIC_MESSAGES.mic_unavailable });
      return;
    }
    // Hold mode released while the permission prompt/device is still starting: finish it as soon as capture begins.
    if (live && input.kind === "release" && p.activationMode === "hold" && live.busy && s.ui !== "listening") {
      void live.stop();
      return;
    }
    const { action } = activationStep(
      prefsRef.current.activationMode,
      { recording: s.ui === "listening", busy: BUSY.has(s.ui) },
      input,
    );
    if (action === "start") { if (live) void live.start(); else rt.startVoice(); }
    else if (action === "stop") { if (live) void live.stop(); else rt.stopVoice(); }
    else if (action === "cancel") { live?.cancel(); rt.cancelVoice(); desktop?.cancelTask(); }
  }, [rt]);

  // In-page stand-in for the global shortcut (real global shortcut + key-up hook is Phase B).
  useEffect(() => {
    const matches = (e: KeyboardEvent) => {
      const p = prefsRef.current.shortcut;
      const k = chordKey(p);
      const mods = chordMods(p);
      const has = (m: string) => mods.includes(m);
      return (
        e.ctrlKey === has("Ctrl") && e.altKey === has("Alt") && e.shiftKey === has("Shift") && e.metaKey === has("Win") &&
        (k === null ? true : normalizeKey(e.key) === k)
      );
    };
    const inRecorder = (e: KeyboardEvent) => (e.target as HTMLElement | null)?.hasAttribute?.("data-shortcut-recorder");
    const down = (e: KeyboardEvent) => {
      setActivity((n) => n + 1);
      if (inRecorder(e)) return;
      if (e.key === "Escape") return activate({ kind: "cancel" });
      if (desktop) return; // the desktop shell delivers the shortcut globally
      if (matches(e)) { e.preventDefault(); activate({ kind: "press", repeat: e.repeat }); }
    };
    const up = (e: KeyboardEvent) => {
      if (desktop || inRecorder(e)) return;
      const p = prefsRef.current.shortcut;
      const key = normalizeKey(e.key);
      if (key === chordKey(p) || chordMods(p).includes(key)) activate({ kind: "release" });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [activate]);

  // Desktop: results from the real runtime (Phase C). Every event is validated at this boundary.
  useEffect(() => {
    if (!desktop) return;
    return desktop.onRuntimeEvent((raw) => {
      const e = parseRuntimeEvent(raw);
      if (e) dispatch(e);
    });
  }, []);

  // A typed request takes exactly the same path as a spoken one (after transcription).
  const typedSeq = useRef(0);
  const submitText = useCallback((text: string) => {
    const t = text.trim().slice(0, 2000);
    if (!t || !CAN_START_VOICE.has(stateRef.current.ui)) return;
    const sid = `typed${++typedSeq.current}`;
    dispatch({ type: "voice.started", sessionId: sid });
    dispatch({ type: "voice.stopped", sessionId: sid });
    dispatch({ type: "transcript.ready", sessionId: sid, text: t });
    if (desktop) desktop.submitTranscript(sid, t);
    else rt.runTranscript(sid, t);
  }, [rt]);

  // Desktop: keep the runtime's permission policy in step with Settings.
  useEffect(() => {
    desktop?.setPolicy(prefs.permissions);
  }, [prefs.permissions]);

  // Desktop: register the global shortcut for the current mode and listen for it.
  useEffect(() => {
    const d = desktop;
    if (!d) return;
    let cancelled = false;
    void d.setShortcut(prefs.shortcut, prefs.activationMode).then((r) => { if (!cancelled) setShortcutStatus(r); });
    const off = d.onShortcut((m) => activate({ kind: m.kind }));
    return () => { cancelled = true; off(); };
  }, [prefs.shortcut, prefs.activationMode, activate]);

  // 30-minute (configurable) inactivity -> sleeping. Any interaction resets the timer.
  useEffect(() => {
    const bump = () => setActivity((n) => n + 1);
    window.addEventListener("pointerdown", bump);
    return () => window.removeEventListener("pointerdown", bump);
  }, []);
  useEffect(() => {
    if (state.ui !== "idle") return;
    const h = setTimeout(() => dispatch({ type: "local.sleep" }), prefs.inactivityMinutes * 60_000);
    return () => clearTimeout(h);
  }, [state.ui, activity, prefs.inactivityMinutes]);

  // Spoken replies: read the outcome aloud once per result. Stops the moment the user starts talking.
  const speakerRef = useRef<Speaker | null>(null);
  if (!speakerRef.current) speakerRef.current = new Speaker();
  useEffect(() => {
    const speaker = speakerRef.current!;
    const { voiceOutput: vo, speechLanguage } = prefsRef.current;
    if (!vo.enabled || state.ui === "listening" || state.ui === "transcribing" || state.ui === "sleeping") {
      speaker.stop();
      return;
    }
    const s = stateRef.current;
    const text =
      s.answer ? s.answer.text
      : s.ui === "success" || s.ui === "sorry" || s.ui === "error" ? (s.result?.summary ?? s.message)
      : s.ui === "asking" ? s.clarification?.question
      : s.ui === "blocked" ? s.confirmation?.summary
      : s.ui === "partial_success" || s.ui === "disabled" ? s.message
      : undefined;
    if (text) speaker.speak(text, { voiceURI: vo.voiceURI, rate: vo.rate, lang: speechLanguage });
  }, [state.ui, state.taskId, state.result, state.clarification, state.confirmation, state.message, state.answer]);
  useEffect(() => { if (!prefs.voiceOutput.enabled) speakerRef.current?.stop(); }, [prefs.voiceOutput.enabled]);
  useEffect(() => () => speakerRef.current?.stop(), []);

  // Results fade back to idle after a while.
  useEffect(() => {
    if (!AUTO_DISMISS.has(state.ui)) return;
    const h = setTimeout(() => dispatch({ type: "local.dismiss" }), 10_000);
    return () => clearTimeout(h);
  }, [state.ui, state.taskId]);

  // An AI answer stays a little longer (it is longer to read), then fades.
  useEffect(() => {
    if (!state.answer) return;
    const h = setTimeout(() => dispatch({ type: "local.dismiss" }), 45_000);
    return () => clearTimeout(h);
  }, [state.answer]);

  const updatePrefs = (p: Prefs) => setPrefs(p);
  // y is the distance from the viewport bottom (the widget is bottom-anchored)
  const move = (x: number, y: number) => setPrefs((p) => ({ ...p, widget: { ...p.widget, x, y } }));

  const force = (s: CompanionUiState) => {
    rt.cancelVoice(); // stop any scripted scenario still playing
    actionsToReach(s).forEach((a) => dispatch(a));
  };

  if (prefs.companionId === null || view === "picker") {
    return (
      <div className="stage">
        <Picker
          current={prefs.companionId}
          onUse={(id) => { setPrefs({ ...prefs, companionId: id }); setView("widget"); }}
          onCancel={prefs.companionId ? () => setView("widget") : undefined}
        />
      </div>
    );
  }

  return (
    <div className="stage">
      {!desktop && (
        <p className="stage-note" role="note">
          <strong>Browser preview — demo only.</strong> Replies here are scripted examples, not answers from your PC
          (the numbers are made up). For real answers use the Momo desktop window: run <code>npm run desktop</code>
          or click the Momo icon in the system tray.
        </p>
      )}
      <Widget
        prefs={prefs}
        state={state}
        level={prefs.voiceInput === "live" ? level : undefined}
        quality={sceneDowngraded ? "low" : chooseQuality({ setting: prefs.visuals.quality, reduceMotion: prefs.widget.reduceMotion, webgl, deviceMemoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory })}
        characterView={prefs.visuals.characterView}
        onSceneSlow={setSceneDowngraded}
        onModelInfo={setModelInfo}
        onMove={move}
        onToggleCompact={() => setPrefs({ ...prefs, widget: { ...prefs.widget, compact: !prefs.widget.compact } })}
        onSettings={() => setSettingsOpen(true)}
        micDown={() => activate({ kind: "press" })}
        micUp={() => activate({ kind: "release" })}
        onCancel={() => activate({ kind: "cancel" })}
        onConfirm={(ok) => {
          const id = state.confirmation?.taskId;
          if (desktop && id) desktop.respondConfirmation(id, ok); // the real runtime owns the pending action
          else if (rt.awaitingKind === "confirmation") rt.respondConfirmation(ok);
          else dispatch({ type: "local.dismiss" });
        }}
        onAnswer={(t) => {
          if (desktop) submitText(t); // the real runtime owns the pending question
          else if (rt.awaitingKind === "clarification") rt.respondClarification(t);
          else dispatch({ type: "local.dismiss" });
        }}
        onSubmitText={submitText}
        onDismiss={() => dispatch({ type: "local.dismiss" })}
        onWake={() => dispatch({ type: "local.wake" })}
      />
      {settingsOpen && (
        <Settings
          prefs={prefs}
          onChange={updatePrefs}
          speechAvailable={webSpeechAdapter.available()}
          inDesktop={!!desktop}
          sceneNote={sceneDowngraded ? (sceneDowngraded === "slow" ? "The 3D scene was running slowly, so I switched to the light view for now." : "The graphics card reset, so I switched to the light view for now.") : null}
          modelInfo={modelInfo}
          shortcutStatus={desktop ? shortcutStatus : null}
          onPickCompanion={() => { setSettingsOpen(false); setView("picker"); }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {debugOpen ? (
        <DebugPanel current={state.ui} scenario={scenario} onScenario={setScenario} onForce={force} onClose={() => setDebugOpen(false)} />
      ) : (
        <button className="debug-open" onClick={() => setDebugOpen(true)}>Mock controls</button>
      )}
    </div>
  );
}
