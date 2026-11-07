import { useEffect, useState } from "react";
import { MIC_MESSAGES, listMicrophones, testMicrophone } from "../voice/micSession";
import { webSpeechAdapter } from "../voice/stt";
import { createWhisperAdapter, whisper, type ModelState } from "../voice/whisperClient";
import type { DownloadProgress } from "../voice/progress";
import type { Prefs } from "../state/settings";

const localAdapter = createWhisperAdapter();

const LANGUAGES: [string, string][] = [
  ["en", "English"], ["hi", "Hindi"], ["mr", "Marathi"], ["gu", "Gujarati"], ["bn", "Bengali"],
  ["ta", "Tamil"], ["te", "Telugu"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
];

interface Props {
  prefs: Prefs;
  set(patch: Partial<Prefs>): void;
  browserSpeechAvailable: boolean;
  /** the browser speech service does not work inside the desktop app */
  inDesktop: boolean;
}

export function VoiceInput({ prefs, set, browserSpeechAvailable, inDesktop }: Props) {
  const live = prefs.voiceInput === "live";
  const engine = inDesktop ? "local" : prefs.speechEngine;
  const consent = engine === "local" ? prefs.localModelConsent : prefs.speechDisclosureAccepted;

  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [model, setModel] = useState<ModelState>(whisper.state);
  const [cached, setCached] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  // Momo works fully offline once the speech model is on the PC; only the one-time download needs a connection
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  useEffect(() => whisper.subscribe(() => setModel(whisper.state)), []);
  useEffect(() => { void whisper.isCached().then(setCached); }, [model]);
  useEffect(() => {
    if (live && consent) void listMicrophones().then(setMics).catch(() => setMics([]));
  }, [live, consent]);

  const runTest = async () => {
    setTesting(true);
    setTestResult("Listening for 2 seconds — say something…");
    const r = await testMicrophone(prefs.microphoneId);
    setTesting(false);
    setTestResult(r.ok ? (r.heardSound ? "✓ Microphone works — I heard sound." : "Microphone opened, but I heard no sound.") : MIC_MESSAGES[r.code]);
    void listMicrophones().then(setMics).catch(() => {});
  };

  const download = async () => {
    set({ localModelConsent: true });
    setProgress({ percent: 0, loadedMB: 0, totalMB: 0 });
    try { await whisper.load(setProgress); } catch { /* shown via whisper.lastError */ }
    setProgress(null);
  };

  return (
    <div className="subsection">
      <strong>Voice input</strong>
      <label className="radio">
        <input type="radio" name="vin" checked={!live} onChange={() => set({ voiceInput: "mock" })} />
        Demo voice (scripted, nothing is recorded)
      </label>
      <label className="radio">
        <input type="radio" name="vin" checked={live} onChange={() => set({ voiceInput: "live" })} />
        Live microphone
      </label>

      {live && (
        <>
          <strong>Speech recognition</strong>
          <label className="radio">
            <input type="radio" name="eng" checked={engine === "local"} onChange={() => set({ speechEngine: "local" })} />
            Local Whisper — private, works offline (recommended)
          </label>
          {!inDesktop && (
            <label className="radio">
              <input type="radio" name="eng" checked={engine === "browser"} disabled={!browserSpeechAvailable} onChange={() => set({ speechEngine: "browser" })} />
              Browser speech service — sends audio to the cloud{browserSpeechAvailable ? "" : " (not available here)"}
            </label>
          )}

          {engine === "local" ? (
            <>
              <p className="notice" role="note"><strong>How it works:</strong> {localAdapter.disclosure} Pick the language you speak below: it cannot be detected automatically. Momo never saves your audio. The model uses some memory while loaded and is released after 5 idle minutes.</p>
              {model === "ready" || (cached && prefs.localModelConsent) ? (
                <p className="hint" role="status">✓ Speech model {model === "ready" ? "loaded" : "downloaded"} on this PC.</p>
              ) : (
                <div className="row">
                  <button onClick={download} disabled={model === "loading" || !online} className="primary">
                    {model === "loading" ? "Downloading…" : "Download speech model (~75 MB)"}
                  </button>
                </div>
              )}
              {!online && !(model === "ready" || (cached && prefs.localModelConsent)) && (
                <p className="hint" role="status">You're offline. Connect to the internet once to download the speech model; after that Momo works without any connection.</p>
              )}
              {progress && (
                <div role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} className="bar">
                  <i style={{ width: `${progress.percent}%` }} />
                  <span>{progress.percent}%{progress.totalMB ? ` · ${progress.loadedMB} / ${progress.totalMB} MB` : ""}</span>
                </div>
              )}
              {model === "error" && <p className="error" role="alert">Couldn't load the speech model: {whisper.lastError || "unknown error"}. Check your connection and try again.</p>}
            </>
          ) : (
            <>
              <p className="notice" role="note"><strong>Before you use it:</strong> {webSpeechAdapter.disclosure} Audio is never saved by Momo.</p>
              <label className="check-row">
                <input type="checkbox" checked={prefs.speechDisclosureAccepted} onChange={(e) => set({ speechDisclosureAccepted: e.target.checked })} />
                I understand and want to use the browser speech service
              </label>
            </>
          )}

          {engine === "local" && (
            <label className="field">Spoken language
              <select value={prefs.speechLanguage} onChange={(e) => set({ speechLanguage: e.target.value })}>
                {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
          )}

          {consent && (
            <>
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
            </>
          )}
        </>
      )}
    </div>
  );
}
