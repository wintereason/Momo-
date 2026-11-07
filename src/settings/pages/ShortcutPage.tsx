import { useEffect, useState } from "react";
import type { PageProps } from "../SettingsApp";
import { desktop, type ShortcutRole, type ShortcutStatus } from "../../desktop";
import { chordFromEvent, shortcutsConflict, validateShortcut } from "../../state/shortcut";
import type { ActivationMode } from "../../types/runtime-events";

function Recorder({ label, hint, role, value, other, onSet }: { label: string; hint: string; role: ShortcutRole; value: string; other: string; onSet(chord: string): void }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ShortcutStatus | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    // the bar registers a shortcut a moment after a change; ask again shortly after
    const t = setTimeout(() => { void desktop!.shortcutStatus(role).then((s) => { if (alive) setStatus(s); }); }, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [value, role]);

  return (
    <div className="subsection">
      <label className="field">{label}
        <input
          data-shortcut-recorder
          readOnly
          value={recording ? "Press a combination…" : value}
          onFocus={() => { setRecording(true); setError(null); }}
          onBlur={() => setRecording(false)}
          onKeyDown={(e) => {
            e.preventDefault();
            if (e.key === "Escape") { (e.target as HTMLInputElement).blur(); return; }
            const chord = chordFromEvent(e);
            const v = validateShortcut(chord);
            if (v.ok) {
              if (shortcutsConflict(chord, other)) { setError("That overlaps the other shortcut (one is part of the other). Pick a different combination."); return; }
              onSet(chord); setError(null); (e.target as HTMLInputElement).blur();
            } else if (!/^(Ctrl|Alt|Shift|Win)(\+(Ctrl|Alt|Shift|Win))*$/.test(chord)) setError(v.reason);
          }}
        />
      </label>
      <p className="hint">{hint}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {status && !status.ok && <p className="error" role="alert">{status.reason}</p>}
      {status?.ok && status.note && <p className="hint">{status.note}</p>}
      <p className="hint">{status ? (status.ok ? "✓ Active in every app." : "Not active until the problem above is fixed.") : desktop ? "Checking…" : "Active only in the desktop app."}</p>
    </div>
  );
}

export function ShortcutPage({ prefs, set }: PageProps) {
  return (
    <>
      <h1>Shortcuts</h1>
      <p className="lead">Two shortcuts, so Momo never has to guess whether you want text written or a job done.</p>

      <fieldset>
        <legend>How do you start talking?</legend>
        {([["hold", "Hold the shortcut: speak while you hold it, let go to finish."], ["toggle", "Tap the shortcut: press once to start, press again to finish."]] as [ActivationMode, string][]).map(([m, text]) => (
          <label key={m} className="radio"><input type="radio" name="mode" checked={prefs.activationMode === m} onChange={() => set({ activationMode: m })} /> {text}</label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Your shortcuts</legend>
        <Recorder label="Dictate" role="dictate" value={prefs.shortcut} other={prefs.agentShortcut} onSet={(c) => set({ shortcut: c })}
          hint="Speak, and Momo types clean, well-worded text into the app you are in." />
        <Recorder label="Ask Momo" role="agent" value={prefs.agentShortcut} other={prefs.shortcut} onSet={(c) => set({ agentShortcut: c })}
          hint="Say what you want done. Momo plans the steps, asks you before any decision, and checks the result. You also answer its questions with this shortcut." />
      </fieldset>
    </>
  );
}
