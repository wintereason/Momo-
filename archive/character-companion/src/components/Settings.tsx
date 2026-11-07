import { useState } from "react";
import { VoiceInput } from "./VoiceInput";
import { SpokenReplies } from "./SpokenReplies";
import { DeleteData } from "./DeleteData";
import { Connections } from "./Connections";
import type { Prefs } from "../state/settings";
import { chordFromEvent, validateShortcut } from "../state/shortcut";
import type { ActivationMode } from "../types/runtime-events";

interface Props {
  prefs: Prefs;
  onChange(p: Prefs): void;
  onPickCompanion(): void;
  onClose(): void;
  speechAvailable: boolean;
  /** result of registering the global shortcut (desktop app only) */
  inDesktop: boolean;
  /** shown when the 3D scene was switched off automatically */
  sceneNote: string | null;
  modelInfo: { using: boolean; placeholder: boolean } | null;
  shortcutStatus: { ok: boolean; reason?: string; note?: string } | null;
}

export function Settings({ prefs, onChange, onPickCompanion, onClose, speechAvailable, inDesktop, sceneNote, modelInfo, shortcutStatus }: Props) {
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const set = (patch: Partial<Prefs>) => onChange({ ...prefs, ...patch });
  const setWidget = (patch: Partial<Prefs["widget"]>) => set({ widget: { ...prefs.widget, ...patch } });
  const setPrivacy = (patch: Partial<Prefs["privacy"]>) => set({ privacy: { ...prefs.privacy, ...patch } });

  return (
    <div className="settings" role="dialog" aria-label="Settings">
      <header>
        <h2>Settings</h2>
        <button onClick={onClose} aria-label="Close settings">✕</button>
      </header>

      <fieldset>
        <legend>Voice activation</legend>
        <p className="hint">Exactly one mode is active at a time.</p>
        {([["hold", "Hold shortcut — hold to record, release to stop"], ["toggle", "Tap to toggle — press to start, press again to stop"]] as [ActivationMode, string][]).map(([m, text]) => (
          <label key={m} className="radio">
            <input type="radio" name="mode" checked={prefs.activationMode === m} onChange={() => set({ activationMode: m })} />
            {text}
          </label>
        ))}
        <label className="field">
          Shortcut
          <input
            data-shortcut-recorder
            readOnly
            value={recording ? "Press a combination…" : prefs.shortcut}
            onFocus={() => { setRecording(true); setShortcutError(null); }}
            onBlur={() => setRecording(false)}
            onKeyDown={(e) => {
              e.preventDefault();
              if (e.key === "Escape") { (e.target as HTMLInputElement).blur(); return; }
              const chord = chordFromEvent(e);
              // wait until a valid combination is formed (ignore a lone modifier press)
              const v = validateShortcut(chord);
              if (v.ok) { set({ shortcut: chord }); setShortcutError(null); (e.target as HTMLInputElement).blur(); }
              else if (!/^(Ctrl|Alt|Shift|Win)(\+(Ctrl|Alt|Shift|Win))*$/.test(chord)) setShortcutError(v.reason);
            }}
          />
        </label>
        {shortcutError && <p className="error" role="alert">{shortcutError}</p>}
        {shortcutStatus && !shortcutStatus.ok && <p className="error" role="alert">{shortcutStatus.reason}</p>}
        {shortcutStatus?.ok && shortcutStatus.note && <p className="hint">{shortcutStatus.note}</p>}
        <p className="hint">{shortcutStatus ? (shortcutStatus.ok ? "✓ Active system-wide — works in any app." : "Not active until the conflict is fixed.") : "Works while this page is focused. The desktop app makes it system-wide."}</p>
        <VoiceInput prefs={prefs} set={set} browserSpeechAvailable={speechAvailable} inDesktop={inDesktop} />
        <label className="check-row">
          <input type="checkbox" checked={prefs.showRecordingIndicator} onChange={(e) => set({ showRecordingIndicator: e.target.checked })} />
          Show recording indicator
        </label>
        <label className="field">
          Rest after (minutes of inactivity)
          <input type="number" min={1} max={240} value={prefs.inactivityMinutes}
            onChange={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 240) set({ inactivityMinutes: n }); }} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Spoken replies</legend>
        <SpokenReplies prefs={prefs} set={set} />
      </fieldset>

      <fieldset>
        <legend>Permissions</legend>
        <label className="check-row">
          <input
            type="checkbox"
            checked={prefs.permissions.confirmReversible}
            onChange={(e) => set({ permissions: { ...prefs.permissions, confirmReversible: e.target.checked } })}
          />
          Ask before I open apps, websites or folders, switch, minimize, click or type (recommended)
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={prefs.permissions.confirmScreenRead}
            onChange={(e) => set({ permissions: { ...prefs.permissions, confirmScreenRead: e.target.checked } })}
          />
          Ask before I look at your screen or browser tabs (recommended)
        </label>
        <p className="hint">Closing a window, and clicking anything like Send, Delete, Save, Pay, OK or Submit, will <strong>always</strong> ask first, whatever this says. I never type into password boxes. When I look at a window I read its text with Windows' own accessibility and text-recognition tools on this PC. Screenshots stay in memory and are never saved or sent anywhere, and I never read password boxes.</p>
      </fieldset>

      <fieldset>
        <legend>Privacy</legend>
        <label className="check-row">
          <input type="checkbox" checked={prefs.privacy.saveTranscriptHistory} onChange={(e) => setPrivacy({ saveTranscriptHistory: e.target.checked })} />
          Keep transcript history (off by default; not implemented yet — nothing is stored)
        </label>
        <label className="check-row">
          <input type="checkbox" checked={prefs.privacy.saveRawAudio} onChange={(e) => setPrivacy({ saveRawAudio: e.target.checked })} />
          Save raw audio (off by default; not implemented yet — nothing is stored)
        </label>
        <button disabled>Clear saved history (none stored)</button>
        <DeleteData />
        <p className="hint">Deleting local data does not control a third-party AI provider's own retention policy.</p>
      </fieldset>

      <fieldset>
        <legend>Appearance</legend>
        <button onClick={onPickCompanion}>Change companion…</button>
        <label className="field">Scene quality
          <select value={prefs.visuals.quality} onChange={(e) => set({ visuals: { ...prefs.visuals, quality: e.target.value as Prefs["visuals"]["quality"] } })}>
            <option value="auto">Automatic (recommended)</option>
            <option value="standard">Full 3D scene (table, petals, effects)</option>
            <option value="low">Light (flat, uses the least power)</option>
          </select>
        </label>
        <label className="field">Character
          <select value={prefs.visuals.characterView} onChange={(e) => set({ visuals: { ...prefs.visuals, characterView: e.target.value as Prefs["visuals"]["characterView"] } })}>
            <option value="2d">2D art (recommended)</option>
            <option value="3d">3D model, if there is one</option>
          </select>
        </label>
        {sceneNote && <p className="notice" role="status">{sceneNote}</p>}
        {prefs.visuals.characterView === "3d" && modelInfo && !modelInfo.using && <p className="hint">No 3D model for this character yet, so the 2D art is shown. Put a model at assets/models/&lt;id&gt;.glb.</p>}
        {prefs.visuals.characterView === "3d" && modelInfo?.using && modelInfo.placeholder && <p className="hint">This is a rough placeholder model, not the final character.</p>}
        <p className="hint">The full scene uses your graphics chip a little. It draws fewer frames when nothing is happening and pauses when Momo is hidden or asleep.</p>
        <label className="field">Widget size ({prefs.widget.size.toFixed(1)}×)
          <input type="range" min={0.6} max={1.6} step={0.1} value={prefs.widget.size} onChange={(e) => setWidget({ size: Number(e.target.value) })} />
        </label>
        <label className="field">Opacity ({Math.round(prefs.widget.opacity * 100)}%)
          <input type="range" min={0.3} max={1} step={0.05} value={prefs.widget.opacity} onChange={(e) => setWidget({ opacity: Number(e.target.value) })} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={prefs.widget.compact} onChange={(e) => setWidget({ compact: e.target.checked })} />
          Compact mode
        </label>
        <label className="check-row">
          <input type="checkbox" checked={prefs.widget.reduceMotion} onChange={(e) => setWidget({ reduceMotion: e.target.checked })} />
          Reduce motion
        </label>
      </fieldset>

      <fieldset>
        <legend>Connections (API keys)</legend>
        <Connections />
      </fieldset>
    </div>
  );
}
