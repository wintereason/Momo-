import { useEffect, useState } from "react";
import type { Prefs } from "../state/settings";
import { Speaker, type VoiceLike } from "../voice/tts";

const speaker = new Speaker();

interface Props {
  prefs: Prefs;
  set(patch: Partial<Prefs>): void;
}

/** Settings for Momo's spoken replies (uses voices already installed on this PC). */
export function SpokenReplies({ prefs, set }: Props) {
  const vo = prefs.voiceOutput;
  const [voices, setVoices] = useState<VoiceLike[]>(() => speaker.voices());

  // Chromium fills the voice list asynchronously
  useEffect(() => {
    if (!speaker.available) return;
    const refresh = () => setVoices(speaker.voices());
    refresh();
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);

  const setVo = (patch: Partial<Prefs["voiceOutput"]>) => set({ voiceOutput: { ...vo, ...patch } });
  const test = () => speaker.speak("Hi! This is how I sound. D drive has 198 gigabytes free.", { voiceURI: vo.voiceURI, rate: vo.rate, lang: prefs.speechLanguage });

  if (!speaker.available) {
    return <p className="hint">Spoken replies aren't available here: this app has no speech synthesis.</p>;
  }

  return (
    <>
      <label className="check-row">
        <input type="checkbox" checked={vo.enabled} onChange={(e) => { setVo({ enabled: e.target.checked }); if (!e.target.checked) speaker.stop(); }} />
        Read Momo's replies out loud
      </label>
      {vo.enabled && (
        <>
          <label className="field">Voice
            <select value={vo.voiceURI ?? ""} onChange={(e) => setVo({ voiceURI: e.target.value || null })}>
              <option value="">Automatic (best for your language)</option>
              {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
            </select>
          </label>
          <label className="field">Speed ({vo.rate.toFixed(1)}×)
            <input type="range" min={0.6} max={1.6} step={0.1} value={vo.rate} onChange={(e) => setVo({ rate: Number(e.target.value) })} />
          </label>
          <div className="row"><button onClick={test}>Test voice</button></div>
          {voices.length === 0 && <p className="hint">No voices found yet. Windows voices are listed under Settings → Time &amp; language → Speech.</p>}
          <p className="hint">Replies are spoken on this PC with Windows voices. Nothing is sent anywhere. It stops as soon as you start talking.</p>
        </>
      )}
    </>
  );
}
