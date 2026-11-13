import { useEffect, useState } from "react";
import { desktop, type EnvStatus, type ShortcutStatus } from "../../desktop";
import { whisper, type ModelState } from "../../voice/whisperClient";
import { LANGUAGES, languageLabel } from "../../state/languages";
import type { PageProps } from "../SettingsApp";

type Go = (p: "dictation" | "voice" | "shortcut" | "ai" | "general") => void;

const keys = (chord: string) => chord.split("+").map((k) => <kbd key={k}>{k}</kbd>);

export function HomePage({ prefs, set, go }: PageProps & { go: Go }) {
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [sc, setSc] = useState<ShortcutStatus | null>(null);
  const [model, setModel] = useState<ModelState>(whisper.state);
  const [cached, setCached] = useState<boolean | null>(null);

  useEffect(() => { void desktop?.envStatus().then(setEnv).catch(() => setEnv(null)); }, []);
  useEffect(() => {
    let alive = true;
    const poll = () => { void desktop?.shortcutStatus("dictate").then((s) => { if (alive) setSc(s); }); };
    poll();
    const t = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [prefs.shortcut, prefs.activationMode]);
  useEffect(() => whisper.subscribe(() => setModel(whisper.state)), []);
  useEffect(() => { void whisper.isCached().then(setCached); }, [model]);

  const cloud = prefs.speechEngine === "cloud";
  const cloudReady = cloud && !!env?.ai.keys.groq;
  const speechReady = cloudReady || model === "ready" || cached === true;
  const shortcutOk = !!sc?.ok;
  const ready = speechReady && shortcutOk;
  const hold = prefs.activationMode === "hold";

  const steps = [
    { ok: speechReady, title: "Speech", text: speechReady ? (cloudReady ? "Cloud speech (most accurate)" : "Speech model on this PC") : "Download the speech model once", to: "voice" as const },
    { ok: shortcutOk, title: "Shortcut", text: sc ? (sc.ok ? "Works in every app" : sc.reason ?? "Not active") : "Checking…", to: "shortcut" as const },
    { ok: !!env?.ai.ready, title: "AI wording", text: env?.ai.ready ? `On (${env.ai.provider})` : "Optional: better grammar and wording", to: "ai" as const, optional: true },
  ];

  return (
    <>
      <section className={ready ? "hero ready" : "hero"}>
        <div className="hero-status">
          <span className="dot" aria-hidden="true" />
          <strong>{ready ? "Momo is ready" : "Almost ready"}</strong>
          <span className="muted">{ready ? "Waiting quietly in your tray" : "Finish the steps below"}</span>
        </div>
        <h1>Say it. Momo types it.</h1>
        <p className="hero-how">
          Click into any text box, {hold ? "hold" : "press"} <span className="caps">{keys(prefs.shortcut)}</span>, speak{hold ? " and let go" : ", then press again"}.
        </p>
        <label className="hero-lang">
          <span>I speak</span>
          <select value={prefs.speechLanguage} onChange={(e) => set({ speechLanguage: e.target.value })} aria-label="Spoken language">
            <option value="auto">Detect automatically</option>
            <optgroup label="Indian languages">
              {LANGUAGES.filter((l) => l.group === "India").map((l) => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}
            </optgroup>
            <optgroup label="Other languages">
              {LANGUAGES.filter((l) => l.group === "World").map((l) => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}
            </optgroup>
          </select>
        </label>
      </section>

      <h2 className="section">Setup</h2>
      <div className="steps">
        {steps.map((s) => (
          <button key={s.title} className={s.ok ? "step ok" : s.optional ? "step opt" : "step todo"} onClick={() => go(s.to)}>
            <span className="tick" aria-hidden="true">{s.ok ? "✓" : s.optional ? "+" : "!"}</span>
            <span className="step-text"><strong>{s.title}</strong><small>{s.text}</small></span>
          </button>
        ))}
      </div>

      <h2 className="section">Try it here</h2>
      <textarea className="try" rows={4} placeholder="Click here, then hold the shortcut and speak…" aria-label="Try dictation here" />
      <p className="hint">The bar at the bottom of the screen shows what Momo is doing. <button className="link" onClick={() => go("general")}>Start with Windows and other options</button></p>
    </>
  );
}
