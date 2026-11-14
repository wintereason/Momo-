import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { desktop, type ShortcutRole } from "../desktop";
import { loadPrefs, savePrefs, PREFS_KEY, type Prefs } from "../state/settings";
import { Momo } from "../character/Momo";
import { AvatarView } from "../character/AvatarView";
import { isSpriteArt } from "../character/avatars";
import { MouthSync } from "../character/speechMouth";
import { expressionFor } from "../character/expression";
import { leadIn, styleMessage } from "../character/personality";
import { SpeechCloud, useSpokenCloud } from "../character/SpeechCloud";
import { VOICE_HINTS, onlineVoiceIdFor } from "../character/config";
import { attachOnlineVoice } from "../voice/onlineVoice";
import { faceWhileSpeaking } from "../character/textExpression";
import { barReducer, holdMs, initialBar, type BarEvent, type BarMode, type DictateResult } from "../state/dictationState";
import { activationStep, type ActivationInput } from "../state/activation";
import { parseRuntimeEvent } from "../types/runtime-events";
import { LiveVoice } from "../voice/liveVoice";
import { MicSession, browserMicDeps } from "../voice/micSession";
import { createWhisperAdapter, whisper } from "../voice/whisperClient";
import { wrongScript, languageName } from "../state/languages";
import { Speaker } from "../voice/tts";
import { forSpeech, speechFor } from "../state/speech";
import { Waveform } from "./Waveform";
import "../styles/bar.css";

// Momo's mouth follows whatever the Speaker is really saying (character code only draws; it never sees the task)
const mouth = new MouthSync();
let spokenLanguage = "en";
let speechEngine: "local" | "cloud" = "local";
const whisperAdapter = createWhisperAdapter(undefined, () => spokenLanguage, () => speechEngine);
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
  const spoken = useSpokenCloud();
  if (!speakerRef.current) { speakerRef.current = new Speaker(); attachOnlineVoice(speakerRef.current); speakerRef.current.listen((e) => { mouth.handle(e); spoken.handle(e); }); }
  const speaking = useSyncExternalStore(mouth.subscribe.bind(mouth), () => mouth.speaking);
  const goalSeq = useRef(0);
  spokenLanguage = prefs.speechLanguage;
  speechEngine = prefs.speechEngine;

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
        // the personality adds a short lead-in to results; it never changes what an answer says
        const pers = prefsRef.current.character.personality;
        if (e.type === "task.completed") say.text = leadIn("completed", pers) + say.text;
        else if (e.type === "task.failed") say.text = leadIn("failed", pers) + say.text;
        const s = forSpeech(say);
        // each avatar has its own voice (falling back to the general one when it has none chosen)
        const vp = prefsRef.current.character.voices[prefsRef.current.character.art];
        speakerRef.current?.speak(s.text, { voiceURI: vp.voiceURI ?? p.voiceURI, rate: vp.rate * p.rate, pitch: vp.pitch, lang: prefsRef.current.speechLanguage, ...VOICE_HINTS[prefsRef.current.character.art], onlineVoiceId: onlineVoiceIdFor(prefsRef.current.character) }, !s.queue);
      }
    });
  }, []);

  // the shadow cursor (shown only while a task runs) can be switched off in Settings
  useEffect(() => { desktop?.setShadowCursor(prefs.shadowCursor); }, [prefs.shadowCursor]);
  useEffect(() => { desktop?.setHumanInput(prefs.humanInput); }, [prefs.humanInput]);

  // routine things (opening, switching, reading a window on this PC) never ask: only decisions do, and those are not a setting
  useEffect(() => { desktop?.setPolicy({ confirmReversible: false, confirmScreenRead: false }); }, []);

  async function finishDictation(text: string) {
    const p = prefsRef.current;
    // The classic local-model slip: Hindi heard in Urdu letters. With the AI on, the polish step rewrites it in the right
    // script; without it, typing the wrong script would be useless, so say how to fix it.
    if (wrongScript(p.speechLanguage, text)) {
      const env = await desktop?.envStatus().catch(() => null);
      if (!env?.ai.ready || p.dictation.style === "off") {
        send({ type: "problem", message: `That came out in the wrong script for ${languageName(p.speechLanguage)}.`, detail: "Turn on Cloud speech in Voice settings for exact results." });
        return;
      }
    }
    send({ type: "recognised", polishing: p.dictation.style !== "off" });
    try {
      const result = (await desktop!.dictate(text, p.dictation.style, p.dictation.mode, p.dictation.restoreClipboard)) as DictateResult;
      send({ type: "result", result, mode: p.dictation.mode });
      if (result.needs === "click") await waitForClick();
    } catch {
      send({ type: "problem", message: "I couldn't write that. Please try again." });
    }
  }

  /** No text box was found: Momo waits until the user clicks into one, then writes there. */
  async function waitForClick() {
    const result = (await desktop!.dictationWaitClick()) as DictateResult;
    // answered or cancelled meanwhile? then there is nothing to show
    if (barRef.current.card?.kind !== "field") return;
    send({ type: "result", result, mode: "type" });
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
    if (input.kind === "press" && !input.repeat && p.speechEngine !== "cloud" && !p.localModelConsent && !cachedRef.current) {
      send({ type: "problem", message: "Set up speech first.", detail: "Opening Momo settings…", tone: "warning" });
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
        if (!cancelled && !r.ok) send({ type: "problem", message: r.reason ?? "A shortcut isn't available.", detail: "Pick another in Momo settings.", tone: "warning" });
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

  // The bar is click-through. It tells the desktop shell where its buttons and cards are (marked data-hit); the shell watches
  // the real pointer and lets the mouse through everywhere else, so the character and the empty space never block other windows.
  const lastRects = useRef("");
  useEffect(() => {
    const send = () => {
      const rects = [...document.querySelectorAll("[data-hit]")].slice(0, 12).map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((r) => r.w > 0 && r.h > 0);
      const key = JSON.stringify(rects);
      if (key !== lastRects.current) { lastRects.current = key; desktop?.setBarHitRects(rects); }
    };
    send();
    const h = window.setInterval(send, 150);
    return () => { window.clearInterval(h); desktop?.setBarHitRects([]); };
  }, []);

  // the window follows the character's size
  const ch = prefs.character;
  useEffect(() => { desktop?.setBarLayout(ch.enabled ? ch.view : "compact"); }, [ch.enabled, ch.view]);
  const toggleView = () => {
    const cur = prefsRef.current;
    const next = { ...cur, character: { ...cur.character, view: cur.character.view === "compact" ? ("expanded" as const) : ("compact" as const) } };
    savePrefs(window.localStorage, next);
    setPrefs(next);
  };
  const shown = { ...bar, message: styleMessage(bar.message, ch.personality) };
  // after a few quiet minutes Momo gets sleepy; anything happening wakes it
  const [asleep, setAsleep] = useState(false);
  useEffect(() => {
    setAsleep(false);
    if (bar.phase !== "idle" || speaking) return;
    const h = window.setTimeout(() => setAsleep(true), 3 * 60_000);
    return () => window.clearTimeout(h);
  }, [bar, speaking]);
  // what Momo is doing decides problems and decisions; while it speaks, the sentence being said decides the rest
  const expression = faceWhileSpeaking(expressionFor(bar, speaking, ch.personality, asleep), speaking ? spoken.words : null, ch.personality);

  useEffect(() => () => liveRef.current?.cancel(), []);

  const cancelTask = () => { desktop?.cancelTask(); liveRef.current?.cancel(); dispatch({ type: "reset" }); };
  const answer = (taskId: string, yes: boolean) => { desktop?.respondConfirmation(taskId, yes); if (!yes) dispatch({ type: "reset" }); };
  // clicking an option is the same as saying its number: Momo opens it at once
  // choosing a text box to write in (the text is held by the desktop shell, in memory, until you choose or cancel)
  const pickField = async (index: number) => {
    send({ type: "recognised", polishing: false });
    try { send({ type: "result", result: (await desktop!.dictationPick(index)) as DictateResult, mode: "type" }); }
    catch { send({ type: "problem", message: "I couldn't write that. Please try again." }); }
  };
  const cancelField = () => { desktop?.dictationCancel(); dispatch({ type: "reset" }); };
  const pick = (index: number) => { speakerRef.current?.stop(); giveGoal(String(index + 1)); };

  if (!desktop) return null;
  const card = bar.card;
  return (
    <div className={`bar-stage view-${ch.enabled ? ch.view : "none"} theme-${ch.theme}`}>
      {card && (
        <div data-hit className={`card ${card.kind}`} role={card.kind === "confirm" || card.kind === "ask" ? "alertdialog" : "status"} aria-live="polite">
          {card.kind === "field" && card.options && card.options.length > 0 ? (
            <>
              <p>{card.text}</p>
              <ol className="options">
                {card.options.map((o, i) => (
                  <li key={i}>
                    <button onClick={() => void pickField(i)}>
                      <strong>{i + 1}. {o.label}</strong>
                      {o.detail && <small>{o.detail}</small>}
                    </button>
                  </li>
                ))}
              </ol>
              <div className="buttons"><button onClick={cancelField}>Cancel</button></div>
            </>
          ) : card.kind === "field" ? (
            <>
              <p>{card.text}</p>
              <div className="buttons"><button onClick={cancelField}>Cancel</button></div>
            </>
          ) : card.kind === "ask" && card.options && card.options.length > 0 ? (
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
      {ch.enabled && (
        <div className={`dock ${ch.view}${isSpriteArt(ch.art) ? " has-art" : ""}`}>
          {isSpriteArt(ch.art)
            ? <AvatarView character={ch} expression={expression} view={ch.view} mouth={mouth} className="dock-art" />
            : <Momo appearance={ch} expression={expression} mouth={mouth} view={ch.view} className="dock-svg" />}
          <SpeechCloud cloud={spoken.cloud} />
          <button data-hit className="dock-toggle" onClick={toggleView} aria-label={ch.view === "compact" ? "Expand Momo" : "Shrink Momo"} title={ch.view === "compact" ? "Expand" : "Shrink"}>{ch.view === "compact" ? "⤢" : "⤡"}</button>
        </div>
      )}
      <div className={`pill ${bar.phase} ${bar.mode}`} role="status" aria-live="polite" data-expression={expression}>
        {bar.phase === "idle" && <span className="idle-dots" aria-label="Momo is ready"><i /><i /><i /></span>}
        {bar.phase === "listening" && (<><span className="rec" aria-hidden="true" /><Waveform levels={levels} /></>)}
        {(bar.phase === "transcribing" || bar.phase === "polishing" || bar.phase === "thinking") && (
          <>
            <span className="shimmer">{shown.message}</span>
            {bar.phase === "thinking" && <button data-hit className="stop" onClick={cancelTask} aria-label="Cancel">✕</button>}
          </>
        )}
        {bar.phase === "confirming" && (<><span className="icon ask" aria-hidden="true">?</span><span className="text">{shown.message}</span></>)}
        {bar.phase === "asking" && (<><span className="icon ask" aria-hidden="true">?</span><span className="text">{shown.message}</span></>)}
        {bar.phase === "done" && (<><span className="icon ok" aria-hidden="true">✓</span><span className="text">{shown.message}</span></>)}
        {bar.phase === "problem" && (<><span className="icon warn" aria-hidden="true">!</span><span className="text">{shown.message}</span></>)}
      </div>
      {!card && (bar.phase === "done" || bar.phase === "problem") && bar.detail && <div className="detail">{bar.detail}</div>}
    </div>
  );
}
