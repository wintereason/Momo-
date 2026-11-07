import type { PageProps } from "../SettingsApp";
import type { Prefs } from "../../state/settings";

const STYLES: { id: Prefs["dictation"]["style"]; title: string; before: string; after: string }[] = [
  { id: "polish", title: "Polish (recommended)", before: "i go market yesterday and buyed some vegetable", after: "I went to the market yesterday and bought some vegetables." },
  { id: "light", title: "Fix mistakes only", before: "i go market yesterday and buyed some vegetable", after: "I went to market yesterday and bought some vegetables." },
  { id: "off", title: "Exactly as I said it", before: "um i go market yesterday", after: "um i go market yesterday" },
];

export function DictationPage({ prefs, set }: PageProps) {
  const d = prefs.dictation;
  const setD = (patch: Partial<Prefs["dictation"]>) => set({ dictation: { ...d, ...patch } });
  return (
    <>
      <h1>Dictation</h1>
      <p className="lead">What Momo does with your words after it hears them.</p>

      <fieldset>
        <legend>How should it clean up what I say?</legend>
        {STYLES.map((s) => (
          <label key={s.id} className={d.style === s.id ? "choice on" : "choice"}>
            <input type="radio" name="style" checked={d.style === s.id} onChange={() => setD({ style: s.id })} />
            <span>
              <strong>{s.title}</strong>
              <em>“{s.before}”</em>
              <em className="arrow">→ “{s.after}”</em>
            </span>
          </label>
        ))}
        <p className="hint">Polish and “fix mistakes” need the AI (AI &amp; keys). Without it Momo still removes “um”, repeated words and fixes capital letters. Hindi, Hinglish and other languages keep their own language and script.</p>
      </fieldset>

      <fieldset>
        <legend>Where should the text go?</legend>
        <label className="radio"><input type="radio" name="mode" checked={d.mode === "type"} onChange={() => setD({ mode: "type" })} /> Type it into the app I'm using (recommended)</label>
        <label className="radio"><input type="radio" name="mode" checked={d.mode === "copy"} onChange={() => setD({ mode: "copy" })} /> Only copy it. I'll paste it myself with Ctrl+V.</label>
        <label className="check-row">
          <input type="checkbox" checked={d.restoreClipboard} disabled={d.mode === "copy"} onChange={(e) => setD({ restoreClipboard: e.target.checked })} />
          Put my previous clipboard text back after typing
        </label>
        <p className="hint">Momo types by pasting, so for a moment your clipboard holds the dictated text. By default it stays there, so you can paste it again if an app ignored it. Momo skips password boxes it can recognise, but it can't always see one inside a web page, so don't dictate secrets.</p>
      </fieldset>

      <p className="notice" role="note">
        <strong>Privacy:</strong> when the AI is on, the <em>words you dictated</em> (text only, never audio) are sent to your chosen free AI service to be corrected. Choose Ollama in <code>.env</code> to keep it all on this PC.
      </p>
    </>
  );
}
