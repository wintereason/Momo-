import { useCallback, useEffect, useRef, useState } from "react";
import { MIC_MESSAGES, MicSession, browserMicDeps } from "../../voice/micSession";
import { LiveVoice } from "../../voice/liveVoice";
import { createWhisperAdapter, whisper } from "../../voice/whisperClient";
import type { Prefs } from "../../state/settings";
import { LANGUAGES, type LangId } from "../content";
import { cleanHeard } from "../text";

export type MicPhase = "idle" | "starting" | "listening" | "transcribing";

/**
 * Speaking practice through Momo's existing microphone and speech recognition: one capture at a time, audio kept only in
 * memory and never saved, transcribed in the learner's target language. Resolves with the text the recognizer heard, or an
 * honest reason it could not listen.
 */
export function useSpeechInput(lang: LangId, prefs: Prefs) {
  const [phase, setPhase] = useState<MicPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const live = useRef<LiveVoice | null>(null);
  const pending = useRef<{ resolve(t: string | null): void } | null>(null);
  const cfg = useRef({ lang, prefs });
  cfg.current = { lang, prefs };

  if (!live.current) {
    const deps = browserMicDeps();
    if (deps) {
      const mic = new MicSession(deps, () => {}, () => live.current?.deviceLost());
      const adapter = createWhisperAdapter(undefined, () => LANGUAGES[cfg.current.lang].stt, () => cfg.current.prefs.speechEngine);
      live.current = new LiveVoice(
        (raw) => {
          const e = raw as { type?: string; message?: string };
          if (e.type === "voice.started") setPhase("listening");
          else if (e.type === "voice.stopped") setPhase("transcribing");
          else if (e.type === "runtime.error") { setError(e.message ?? MIC_MESSAGES.mic_failed); setPhase("idle"); pending.current?.resolve(null); pending.current = null; }
        },
        mic, () => adapter,
        // hallucinated silence ("...") and runaway loops are not something the learner said: they become "nothing heard"
        (_sid, text) => { setPhase("idle"); pending.current?.resolve(cleanHeard(text)); pending.current = null; },
        () => cfg.current.prefs.microphoneId, 250,
      );
    }
  }
  useEffect(() => () => { live.current?.cancel(); }, []);

  const available = !!live.current;
  /** is the speech engine ready (a model on this PC, or cloud speech chosen)? */
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => { void whisper.isCached().then((c) => setReady(prefs.speechEngine === "cloud" || c || prefs.localModelConsent)).catch(() => setReady(false)); }, [prefs.speechEngine, prefs.localModelConsent]);

  const begin = useCallback(async (): Promise<void> => {
    setError(null);
    if (!live.current) { setError(MIC_MESSAGES.mic_unavailable); return; }
    setPhase("starting");
    void whisper.load().catch(() => {});
    await live.current.start();
  }, []);
  /** stop listening and wait for what was heard (null if nothing could be transcribed) */
  const finish = useCallback((): Promise<string | null> => new Promise((resolve) => {
    pending.current = { resolve };
    void live.current?.stop();
  }), []);
  const cancel = useCallback(() => { live.current?.cancel(); setPhase("idle"); pending.current?.resolve(null); pending.current = null; }, []);

  return { phase, error, available, ready, begin, finish, cancel };
}
