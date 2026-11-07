import { useEffect, useState } from "react";
import { desktop, type EnvStatus, type ShortcutStatus } from "../../desktop";
import { whisper, type ModelState } from "../../voice/whisperClient";
import type { Prefs } from "../../state/settings";

type Go = (p: "dictation" | "voice" | "shortcut" | "ai") => void;

const STYLE_TEXT = { off: "exactly as heard", light: "mistakes fixed", polish: "grammar fixed and wording improved" } as const;

export function HomePage({ prefs, go }: { prefs: Prefs; go: Go }) {
  const [env, setEnv] = useState<EnvStatus | null>(null);
  const [sc, setSc] = useState<ShortcutStatus | null>(null);
  const [sa, setSa] = useState<ShortcutStatus | null>(null);
  const [model, setModel] = useState<ModelState>(whisper.state);
  const [cached, setCached] = useState<boolean | null>(null);

  useEffect(() => { void desktop?.envStatus().then(setEnv).catch(() => setEnv(null)); }, []);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      void desktop?.shortcutStatus("dictate").then((s) => { if (alive) setSc(s); });
      void desktop?.shortcutStatus("agent").then((s) => { if (alive) setSa(s); });
    };
    poll();
    const t = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [prefs.shortcut, prefs.agentShortcut, prefs.activationMode]);
  useEffect(() => whisper.subscribe(() => setModel(whisper.state)), []);
  useEffect(() => { void whisper.isCached().then(setCached); }, [model]);

  const speechReady = model === "ready" || cached === true; // a model already on this PC needs no new download
  const aiReady = !!env?.ai.ready;
  const hold = prefs.activationMode === "hold";

  return (
    <>
      <h1>Talk to Momo</h1>
      <p className="lead">
        <strong>Dictate:</strong> {hold ? "hold" : "press"} <kbd>{prefs.shortcut}</kbd>, speak{hold ? ", let go" : ", press it again"}: Momo fixes the grammar, improves the wording and types it into the app you are in.<br />
        <strong>Ask Momo:</strong> {hold ? "hold" : "press"} <kbd>{prefs.agentShortcut}</kbd> and say what you want done, like "open Chrome with my work account and go to YouTube". Momo works out the steps, asks before any decision, and checks the result.
      </p>

      <div className="cards">
        <button className={speechReady ? "card ok" : "card todo"} onClick={() => go("voice")}>
          <span className="tick" aria-hidden="true">{speechReady ? "✓" : "1"}</span>
          <strong>Speech on this PC</strong>
          <span>{speechReady ? "Ready. Your voice never leaves this PC." : "Download the speech model once (about 75 MB)."}</span>
        </button>
        <button className={sc?.ok && sa?.ok ? "card ok" : "card todo"} onClick={() => go("shortcut")}>
          <span className="tick" aria-hidden="true">{sc?.ok && sa?.ok ? "✓" : "2"}</span>
          <strong>Shortcuts</strong>
          <span>{sc && sa ? (sc.ok && sa.ok ? "Both work in every app." : (!sc.ok ? sc.reason : sa.reason) ?? "Not active.") : "Checking…"}</span>
        </button>
        <button className={aiReady ? "card ok" : "card todo"} onClick={() => go("ai")}>
          <span className="tick" aria-hidden="true">{aiReady ? "✓" : "3"}</span>
          <strong>The AI (Ask Momo and wording)</strong>
          <span>{aiReady ? `On (${env!.ai.provider}). ${env!.ai.requestsToday} of ${env!.ai.limitPerDay} free requests used today.` : "Off. Ask Momo needs it, and dictation only gets basic fixes without it. Turn it on in AI & keys."}</span>
        </button>
        <button className="card" onClick={() => go("dictation")}>
          <span className="tick" aria-hidden="true">✎</span>
          <strong>Your text</strong>
          <span>{STYLE_TEXT[prefs.dictation.style]}, {prefs.dictation.mode === "type" ? "typed into the app in front" : "copied to the clipboard"}.</span>
        </button>
      </div>

      <h2>Try it here</h2>
      <p className="hint">Click inside the box, then use the shortcut. The bar at the bottom of the screen shows what Momo is doing.</p>
      <textarea className="try" rows={5} placeholder="Click here, hold the shortcut and say something, for example: “um i go to market yesterday and buyed some vegetable”" aria-label="Try dictation here" />
    </>
  );
}
