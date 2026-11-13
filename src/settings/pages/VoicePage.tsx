import { useEffect, useState } from "react";
import type { PageProps } from "../SettingsApp";
import { MIC_MESSAGES, listMicrophones, testMicrophone } from "../../voice/micSession";
import { createWhisperAdapter, whisper, type ModelState } from "../../voice/whisperClient";
import type { DownloadProgress } from "../../voice/progress";
import { LANGUAGES, languageLabel } from "../../state/languages";
import { desktop } from "../../desktop";
import { Speaker, type VoiceLike } from "../../voice/tts";

const localAdapter = createWhisperAdapter();


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
  const cloud = prefs.speechEngine === "cloud";
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
  useEffect(() => { if (prefs.localModelConsent || cached || cloud) void listMicrophones().then(setMics).catch(() => setMics([])); }, [prefs.localModelConsent, cached, cloud]);

  const ready = model === "ready" || cached === true;
  const [groqKey, setGroqKey] = useState(false);
  useEffect(() => { void desktop?.envStatus().then((e) => setGroqKey(!!e?.ai.keys.groq)).catch(() => {}); }, []);

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
      <header className="page-head"><h1>Language &amp; voice</h1><p className="lead">Choose what you speak and how accurately Momo should listen.</p></header>

      <section className="panel">
        <h2>Language you speak</h2>
        <label className="field">Spoken language
          <select value={prefs.speechLanguage} onChange={(e) => set({ speechLanguage: e.target.value })}>
            <option value="auto">Detect automatically</option>
            <optgroup label="Indian languages">{LANGUAGES.filter((l) => l.group === "India").map((l) => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}</optgroup>
            <optgroup label="Other languages">{LANGUAGES.filter((l) => l.group === "World").map((l) => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}</optgroup>
          </select>
        </label>
        <p className="hint">Your words are written in the language's own script (Hindi in देवनागरी, Tamil in தமிழ், and so on). Picking the language is more accurate than automatic detection.</p>
      </section>

      <section className="panel">
        <h2>How should Momo listen?</h2>
        <label className={cloud ? "choice on" : "choice"}>
          <input type="radio" name="engine" checked={cloud} onChange={() => set({ speechEngine: "cloud" })} />
          <span><strong>Cloud speech <span className="badge ok">Most accurate</span></strong>
            <em>Whisper large-v3 on Groq's servers. Best for Hindi and every other language; needs internet and a free Groq key. Your audio is sent to Groq for each sentence and is not stored by Momo.</em></span>
        </label>
        <label className={!cloud ? "choice on" : "choice"}>
          <input type="radio" name="engine" checked={!cloud} onChange={() => set({ speechEngine: "local" })} />
          <span><strong>On this PC <span className="badge">Private</span></strong>
            <em>Works offline. Your audio never leaves this PC. Less accurate for non-English languages.</em></span>
        </label>
        {cloud && !groqKey && <p className="notice" role="note">Cloud speech needs a free <strong>Groq key</strong> (console.groq.com): add it in <em>AI &amp; keys</em>. Until then Momo uses the speech model on this PC.</p>}
        {cloud && groqKey && <p className="hint" role="status">✓ Groq key found. If the internet is down, Momo falls back to the model on this PC{ready ? "" : " (download it below)"}.</p>}
      </section>

      <section className="panel">
        <h2>Speech model on this PC</h2>
        <p className="hint">{localAdapter.disclosure} It uses some memory while loaded and is released after 5 idle minutes.</p>
        {ready ? (
          <p className="hint" role="status">✓ The speech model is on this PC.</p>
        ) : (
          <div className="row"><button className="primary" onClick={download} disabled={model === "loading" || !online}>{model === "loading" ? "Downloading…" : "Download speech model (about 250 MB)"}</button></div>
        )}
        {!ready && !online && <p className="hint" role="status">You're offline. Connect once to download the model.</p>}
        {progress && (
          <div role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} className="bar">
            <i style={{ width: `${progress.percent}%` }} />
            <span>{progress.percent}%{progress.totalMB ? ` · ${progress.loadedMB} / ${progress.totalMB} MB` : ""}</span>
          </div>
        )}
        {model === "error" && <p className="error" role="alert">Couldn't load the speech model: {whisper.lastError || "unknown error"}. Check your connection and try again.</p>}
      </section>

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
        <div className="row"><button onClick={runTest} disabled={testing}>Test microphone</button></div>
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
