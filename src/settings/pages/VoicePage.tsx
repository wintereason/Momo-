import { useEffect, useState } from "react";
import type { PageProps } from "../SettingsApp";
import { MIC_MESSAGES, listMicrophones, testMicrophone } from "../../voice/micSession";
import { createWhisperAdapter, whisper, type ModelState } from "../../voice/whisperClient";
import type { DownloadProgress } from "../../voice/progress";
import { Speaker, type VoiceLike } from "../../voice/tts";

const localAdapter = createWhisperAdapter();

const LANGUAGES: [string, string][] = [
  ["en", "English"], ["hi", "Hindi"], ["mr", "Marathi"], ["gu", "Gujarati"], ["bn", "Bengali"],
  ["ta", "Tamil"], ["te", "Telugu"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
];

export function VoicePage({ prefs, set }: PageProps) {
  const [speaker] = useState(() => new Speaker());
  const [voices, setVoices] = useState<VoiceLike[]>(() => speaker.voices());
  useEffect(() => {
    // the list of voices arrives a moment after the page opens
    const t = setInterval(() => setVoices(speaker.voices()), 600);
    const stop = setTimeout(() => clearInterval(t), 4000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [speaker]);
  const vo = prefs.voiceOutput;
  const setVo = (patch: Partial<typeof vo>) => set({ voiceOutput: { ...vo, ...patch } });
  const [model, setModel] = useState<ModelState>(whisper.state);
  const [cached, setCached] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  useEffect(() => whisper.subscribe(() => setModel(whisper.state)), []);
  useEffect(() => { void whisper.isCached().then(setCached); }, [model]);
  useEffect(() => { if (prefs.localModelConsent || cached) void listMicrophones().then(setMics).catch(() => setMics([])); }, [prefs.localModelConsent, cached]);

  const ready = model === "ready" || cached === true;

  const download = async () => {
    set({ localModelConsent: true });
    setProgress({ percent: 0, loadedMB: 0, totalMB: 0 });
    try { await whisper.load(setProgress); } catch { /* shown through whisper.lastError */ }
    setProgress(null);
  };
  const runTest = async () => {
    setTesting(true);
    setTestResult("Listening for 2 seconds. Say something…");
    const r = await testMicrophone(prefs.microphoneId);
    setTesting(false);
    setTestResult(r.ok ? (r.heardSound ? "✓ The microphone works. I heard sound." : "The microphone opened, but I heard no sound.") : MIC_MESSAGES[r.code]);
    void listMicrophones().then(setMics).catch(() => {});
  };

  return (
    <>
      <h1>Voice &amp; microphone</h1>
      <p className="lead">Your voice is turned into text by Whisper, which runs on this PC. Audio is never saved and never sent anywhere.</p>

      <fieldset>
        <legend>Speech model</legend>
        <p className="notice" role="note"><strong>How it works:</strong> {localAdapter.disclosure} The model uses some memory while loaded and is released after 5 idle minutes.</p>
        {ready ? (
          <p className="hint" role="status">✓ The speech model is on this PC. Momo works without an internet connection for speech.</p>
        ) : (
          <div className="row"><button className="primary" onClick={download} disabled={model === "loading" || !online}>{model === "loading" ? "Downloading…" : "Download speech model (about 75 MB)"}</button></div>
        )}
        {!ready && !online && <p className="hint" role="status">You're offline. Connect once to download the model; after that no connection is needed.</p>}
        {progress && (
          <div role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} className="bar">
            <i style={{ width: `${progress.percent}%` }} />
            <span>{progress.percent}%{progress.totalMB ? ` · ${progress.loadedMB} / ${progress.totalMB} MB` : ""}</span>
          </div>
        )}
        {model === "error" && <p className="error" role="alert">Couldn't load the speech model: {whisper.lastError || "unknown error"}. Check your connection and try again.</p>}
      </fieldset>

      <fieldset>
        <legend>Language you speak</legend>
        <label className="field">Spoken language
          <select value={prefs.speechLanguage} onChange={(e) => set({ speechLanguage: e.target.value })}>
            {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
        <p className="hint">Whisper can't tell the language by itself, so pick the one you speak most. The written result keeps the same language.</p>
      </fieldset>

      <fieldset>
        <legend>Microphone</legend>
        {mics.length > 1 && (
          <label className="field">Microphone
            <select value={prefs.microphoneId ?? ""} onChange={(e) => set({ microphoneId: e.target.value || null })}>
              <option value="">System default</option>
              {mics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        )}
        <div className="row"><button onClick={runTest} disabled={testing || !ready}>Test microphone</button></div>
        {!ready && <p className="hint">Download the speech model first; then you can test the microphone.</p>}
        {testResult && <p className="hint" role="status">{testResult}</p>}
      </fieldset>

      <fieldset>
        <legend>Momo's voice</legend>
        <label className="check-row">
          <input type="checkbox" checked={vo.enabled} onChange={(e) => setVo({ enabled: e.target.checked })} />
          Speak: say what Momo is opening, confirm when it is done and checked, explain when something failed, and read out the options when it has to ask which one
        </label>
        {vo.enabled && (
          <>
            {speaker.available ? (
              <>
                <label className="field">Voice
                  <select value={vo.voiceURI ?? ""} onChange={(e) => setVo({ voiceURI: e.target.value || null })}>
                    <option value="">Automatic (best match for your language)</option>
                    {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
                  </select>
                </label>
                <label className="field">Speed ({vo.rate.toFixed(1)}×)
                  <input type="range" min={0.6} max={1.6} step={0.1} value={vo.rate} onChange={(e) => setVo({ rate: Number(e.target.value) })} />
                </label>
                <div className="row"><button onClick={() => speaker.speak("Opening your Documents folder. Done: I can see its window.", { voiceURI: vo.voiceURI, rate: vo.rate, lang: prefs.speechLanguage })}>Test voice</button></div>
              </>
            ) : <p className="hint">This PC has no speech voices available to Momo.</p>}
            <p className="hint">It uses the voices already installed on this PC. Nothing is sent over the network.</p>
          </>
        )}
      </fieldset>
    </>
  );
}
