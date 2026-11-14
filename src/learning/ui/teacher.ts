import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ExpressionId } from "../../character/face";
import { MouthSync } from "../../character/speechMouth";
import { useSpokenCloud } from "../../character/SpeechCloud";
import { LANGUAGES, type LangId } from "../content";
import { Speaker } from "../../voice/tts";
import { PERSONAS } from "../../character/personality";
import { VOICE_HINTS, onlineVoiceIdFor, type CharacterPrefs } from "../../character/config";
import { attachOnlineVoice } from "../../voice/onlineVoice";

/**
 * Momo as a teacher on screen: it speaks the target language through the voices installed on this PC (the same speech code the
 * rest of Momo uses), its mouth and captions follow the real playback, and its face reacts to what the learner just did.
 */
export function useTeacher(character: CharacterPrefs) {
  const mouth = useMemo(() => new MouthSync(), []);
  const speaker = useRef<Speaker | null>(null);
  if (!speaker.current) { speaker.current = new Speaker(); attachOnlineVoice(speaker.current); }
  const spoken = useSpokenCloud();
  const speaking = useSyncExternalStore(mouth.subscribe.bind(mouth), () => mouth.speaking);
  const [reaction, setReaction] = useState<ExpressionId | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [voices, setVoices] = useState(0);

  useEffect(() => {
    const sp = speaker.current!;
    sp.listen((e) => { mouth.handle(e); spoken.handle(e); });
    const load = () => setVoices(sp.voices().length);
    load();
    window.speechSynthesis?.addEventListener?.("voiceschanged", load);
    return () => { sp.stop(); sp.listen(null); window.speechSynthesis?.removeEventListener?.("voiceschanged", load); window.clearTimeout(timer.current); };
  }, [mouth]); // eslint-disable-line react-hooks/exhaustive-deps

  /** is there an installed voice for this language? (the app says so honestly when there is not) */
  const hasVoice = useCallback((lang: LangId): boolean => {
    const prefix = LANGUAGES[lang].tts.slice(0, 2).toLowerCase();
    return (speaker.current?.voices() ?? []).some((v) => v.lang.toLowerCase().startsWith(prefix));
  }, [voices]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Say something in a language, slowly enough to learn from. If no voice for that language is installed it does NOT speak (a voice for
   * another language would read it as nonsense): it returns false and the caller says so.
   */
  const say = useCallback((text: string, lang: LangId, opts?: { rate?: number; queue?: boolean }): boolean => {
    if (!hasVoice(lang)) return false;
    const voice = character.voices[character.art];
    return speaker.current!.speak(text, { voiceURI: null, rate: opts?.rate ?? 0.85, pitch: voice.pitch, lang: LANGUAGES[lang].tts, maxChars: 400, ...VOICE_HINTS[character.art] }, !opts?.queue);
  }, [character, hasVoice]);
  /** say something in the learner's own language (English): uses the avatar's own voice */
  const sayNative = useCallback((text: string) => {
    const voice = character.voices[character.art];
    return speaker.current!.speak(text, { voiceURI: voice.voiceURI, rate: voice.rate, pitch: voice.pitch, lang: "en", maxChars: 400, ...VOICE_HINTS[character.art], onlineVoiceId: onlineVoiceIdFor(character) }, true);
  }, [character]);
  const stop = useCallback(() => speaker.current?.stop(), []);

  /** show a reaction for a moment ("happy" after a right answer) */
  const react = useCallback((e: ExpressionId, ms = 2600) => {
    setReaction(e);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setReaction(null), ms);
  }, []);

  const expression: ExpressionId = speaking ? "speaking" : reaction ?? PERSONAS[character.personality].idle;
  return { mouth, cloud: spoken.cloud, expression, speaking, say, sayNative, stop, react, hasVoice, voicesLoaded: voices > 0 };
}
