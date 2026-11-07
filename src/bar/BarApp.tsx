import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { desktop, type ShortcutRole } from "../desktop";
import { loadPrefs, PREFS_KEY, type Prefs } from "../state/settings";
import { barReducer, holdMs, initialBar, needsClicks, type BarEvent, type BarMode, type DictateResult } from "../state/dictationState";
import { activationStep, type ActivationInput } from "../state/activation";
import { parseRuntimeEvent } from "../types/runtime-events";
import { LiveVoice } from "../voice/liveVoice";
import { MicSession, browserMicDeps } from "../voice/micSession";
import { createWhisperAdapter, whisper } from "../voice/whisperClient";
import { Speaker } from "../voice/tts";
import { forSpeech, speechFor } from "../state/speech";
import { Waveform } from "./Waveform";
import "../styles/bar.css";

let spokenLanguage = "en";
const whisperAdapter = createWhisperAdapter(undefined, () => spokenLanguage);
const LEVELS_KEPT = 40;

/**
 * The pill bar. Two shortcuts: DICTATE (speak, and Momo writes grammar-corrected text into the app you are in) and ASK
 * MOMO (speak a goal, and Momo plans, acts and checks it). While it works, the bar shows each step; when a decision or a
 * question comes up it shows a card with buttons, and you can also answer by voice with the Ask Momo shortcut.
 */
export default function BarApp() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(window.localStorage));
  const [bar, dispatch] = useReducer(barReducer, initialBar);
  const [levels, setLevels] = useState<number[]>([]);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const barRef = useRef(bar);
  barRef.current = bar;
  const modeRef = useRef<BarMode>("dictate");
  const speakerRef = useRef<Speaker | null>(null);
  if (!speakerRef.current) speakerRef.current = new Speaker();
  const goalSeq = useRef(0);
  spokenLanguage = prefs.speechLanguage;

  // Settings is another window of the same app: it saves into the same storage, and we hear about it here.
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === PREFS_KEY || e.key === null) setPrefs(loadPrefs(window.localStorage)); };
    window.addEventListener("storage", on);
    document.documentElement.classList.add("bar-route");
    return () => window.removeEventListener("storage", on);
  }, []);

  const send = useCallback((e: BarEvent) => dispatch(e), []);

  // a speech model that is already on this PC counts as agreed to
  const cachedRef = useRef(false);
  useEffect(() => {
    void whisper.isCached().then((c) => {
      cachedRef.current = c;
      if (c) void whisper.load().catch(() => {}); // get the speech engine ready now, so the first sentence is not slow
    });
  }, [prefs.localModelConsent]);

  // what the agent does arrives as events (validated again here)
  useEffect(() => {
    if (!desktop) return;
    return desktop.onRuntimeEvent((raw) => {
      const e = parseRuntimeEvent(raw);
      if (!e) return;
      dispatch({ type: "agent", event: e });
      // Momo says what it is opening, confirms what it verified, and explains what failed
      const p = prefsRef.current.voiceOutput;
      const say = p.enabled ? speechFor(e) : null;
      if (say) {
        const s = forSpeech(say);
        speakerRef.current?.speak(s.text, { voiceURI: p.voiceURI, rate: p.rate, lang: prefsRef.current.speechLanguage }, !s.queue);
      }
    });
  }, []);

  // routine things (opening, switching, reading a window on this PC) never ask: only decisions do, and those are not a setting
  useEffect(() => { desktop?.setPolicy({ confirmReversible: false, confirmScreenRead: false }); }, []);

  async function finishDictation(text: string) {
    const p = prefsRef.current;
    send({ type: "recognised", polishing: p.dictation.style !== "off" });
    try {
      const result = (await desktop!.dictate(text, p.dictation.style, p.dictation.mode, p.dictation.restoreClipboard)) as DictateResult;
      send({ type: "result", result, mode: p.dictation.mode });
    } catch {
      send({ type: "problem", message: "I couldn't write that. Please try again." });
    }
  }

  /** What was said is a goal (or the answer to Momo's question): hand it to the agent. Its events drive the bar from here. */
  function giveGoal(text: string) {
    send({ type: "goal" });
    desktop?.submitTranscript(`v${++goalSeq.current}`, text);
  }

  // One voice pipeline for the life of the window.
  const liveRef = useRef<LiveVoice | null>(null);
  if (!liveRef.current) {
    const deps = browserMicDeps();
    if (deps) {
      const mic = new MicSession(
        deps,
        (l) => setLevels((old) => [...old.slice(-(LEVELS_KEPT - 1)), l]),
        () => liveRef.current?.deviceLost(),
      );
      liveRef.current = new LiveVoice(
        (raw) => {
          const e = raw as { type?: string; message?: string };
          if (e.type === "voice.started") {
            speakerRef.current?.stop();
            setLevels([]); send({ type: "listening", mode: modeRef.current });
            if (modeRef.current === "dictate") desktop?.dictationBegin();
            void whisper.load().catch(() => {}); // loads while the user speaks (instant when it is already loaded)
          } else if (e.type === "voice.stopped") send({ type: "heard" });
          else if (e.type === "runtime.error") send({ type: "problem", message: e.message ?? "Something went wrong with the microphone." });
        },
        mic,
        () => whisperAdapter,
        (_sid, text) => { if (modeRef.current === "agent") giveGoal(text); else void finishDictation(text); },
        () => prefsRef.current.microphoneId,
        250, // keep listening a moment after release so the last word is not clipped
      );
    }
  }

  const activate = useCallback((role: ShortcutRole, input: ActivationInput) => {
    const p = prefsRef.current;
    const live = liveRef.current;
    const phase = barRef.current.phase;
    if (!live) { if (input.kind === "press" && !input.repeat) send({ type: "problem", message: "No microphone is available." }); return; }
    if (input.kind === "press" && !input.repeat && !p.localModelConsent && !cachedRef.current) {
      send({ type: "problem", message: "Set up speech first.", detail: "Opening Momo settings…" });
      desktop?.openSettings();
      return;
    }
    // a press while the agent is working or waiting must not start a new recording over it; a press while it waits for an
    // answer is the user answering by voice
    if (input.kind === "press" && !input.repeat && modeRef.current === "agent" && (phase === "thinking")) return;
    if (input.kind === "press" && !input.repeat && phase !== "listening") modeRef.current = role;
    // hold mode released while the permission prompt or device is still starting: finish as soon as capture begins
    if (input.kind === "release" && p.activationMode === "hold" && live.busy && phase !== "listening") { void live.stop(); return; }
    const { action } = activationStep(p.activationMode, { recording: phase === "listening", busy: phase === "transcribing" || phase === "polishing" || phase === "thinking" }, input);
    if (action === "start") void live.start();
    else if (action === "stop") void live.stop();
    else if (action === "cancel") { live.cancel(); send({ type: "reset" }); }
  }, [send]);

  // The global shortcuts (hold or toggle), registered by the desktop shell.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    for (const role of ["dictate", "agent"] as const) {
      const chord = role === "dictate" ? prefs.shortcut : prefs.agentShortcut;
      void desktop.setShortcut(role, chord, prefs.activationMode).then((r) => {
        if (!cancelled && !r.ok) send({ type: "problem", message: r.reason ?? "A shortcut isn't available.", detail: "Pick another in Momo settings." });
      });
    }
    const off = desktop.onShortcut((m) => activate(m.role, { kind: m.kind }));
    return () => { cancelled = true; off(); };
  }, [prefs.shortcut, prefs.agentShortcut, prefs.activationMode, activate, send]);

  // A finished or failed bar fades back to the quiet pill. Questions and decisions wait for an answer.
  useEffect(() => {
    if (bar.phase !== "done" && bar.phase !== "problem") return;
    const h = setTimeout(() => dispatch({ type: "reset" }), holdMs(bar));
    return () => clearTimeout(h);
  }, [bar]);

  // The bar ignores the mouse, except while it has a button to press.
  const clicks = needsClicks(bar);
  useEffect(() => { desktop?.barInteractive(clicks); }, [clicks]);

  useEffect(() => () => liveRef.current?.cancel(), []);

  const cancelTask = () => { desktop?.cancelTask(); liveRef.current?.cancel(); dispatch({ type: "reset" }); };
  const answer = (taskId: string, yes: boolean) => { desktop?.respondConfirmation(taskId, yes); if (!yes) dispatch({ type: "reset" }); };
  // clicking an option is the same as saying its number: Momo opens it at once
  const pick = (index: number) => { speakerRef.current?.stop(); giveGoal(String(index + 1)); };

  if (!desktop) return null;
  const card = bar.card;
  return (
    <div className="bar-stage">
      {card && (
        <div className={`card ${card.kind}`} role={card.kind === "confirm" || card.kind === "ask" ? "alertdialog" : "status"} aria-live="polite">
          {card.kind === "ask" && card.options && card.options.length > 0 ? (
            <>
              <p>Which one should I use?</p>
              <ol className="options">
                {card.options.map((o, i) => (
                  <li key={i}>
                    <button onClick={() => pick(i)}>
                      <strong>{i + 1}. {o.label}</strong>
                      {o.detail && <small>{o.detail}</small>}
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p>{card.text}</p>
          )}
          {card.kind === "confirm" && card.taskId && (
            <div className="buttons">
              <button className="yes" onClick={() => answer(card.taskId!, true)}>Yes</button>
              <button onClick={() => answer(card.taskId!, false)}>No</button>
            </div>
          )}
          {card.kind === "ask" && (
            <div className="buttons">
              <span className="hint">Click one, or hold <kbd>{prefs.agentShortcut}</kbd> and say which</span>
              <button onClick={cancelTask}>Cancel</button>
            </div>
          )}
          {(card.kind === "result" || card.kind === "answer") && <div className="buttons"><button onClick={() => dispatch({ type: "reset" })}>Close</button></div>}
        </div>
      )}
      <div className={`pill ${bar.phase} ${bar.mode}`} role="status" aria-live="polite">
        {bar.phase === "idle" && <span className="idle-dots" aria-label="Momo is ready"><i /><i /><i /></span>}
        {bar.phase === "listening" && (<><span className="rec" aria-hidden="true" /><Waveform levels={levels} /></>)}
        {(bar.phase === "transcribing" || bar.phase === "polishing" || bar.phase === "thinking") && (
          <>
            <span className="shimmer">{bar.message}</span>
            {bar.phase === "thinking" && <button className="stop" onClick={cancelTask} aria-label="Cancel">✕</button>}
          </>
        )}
        {bar.phase === "confirming" && (<><span className="icon ask" aria-hidden="true">?</span><span className="text">{bar.message}</span></>)}
        {bar.phase === "asking" && (<><span className="icon ask" aria-hidden="true">?</span><span className="text">{bar.message}</span></>)}
        {bar.phase === "done" && (<><span className="icon ok" aria-hidden="true">✓</span><span className="text">{bar.message}</span></>)}
        {bar.phase === "problem" && (<><span className="icon warn" aria-hidden="true">!</span><span className="text">{bar.message}</span></>)}
      </div>
      {!card && (bar.phase === "done" || bar.phase === "problem") && bar.detail && <div className="detail">{bar.detail}</div>}
    </div>
  );
}
