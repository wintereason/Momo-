import { useEffect, useMemo, useRef, useState } from "react";
import { Momo } from "../../character/Momo";
import { AvatarView } from "../../character/AvatarView";
import { isSpriteArt } from "../../character/avatars";
import { MouthSync } from "../../character/speechMouth";
import { EXPRESSIONS, type ExpressionId } from "../../character/face";
import { PERSONAS, phrase } from "../../character/personality";
import {
  ANIMATION_LEVELS, AVATAR_ARTS, HAIRSTYLES, HAIR_COLORS, LABELS, OUTFITS, PERSONALITIES, PERSONALITY_BLURB, PRESENTATIONS, THEMES, VIEWS,
  defaultCharacter, type CharacterPrefs,
} from "../../character/config";
import { Speaker } from "../../voice/tts";
import type { PageProps } from "../SettingsApp";

type Group = keyof typeof LABELS;

function Chips<K extends Group>({ legend, group, options, value, onPick }: { legend: string; group: K; options: readonly string[]; value: string; onPick(v: string): void }) {
  const labels = LABELS[group] as Record<string, string>;
  return (
    <fieldset className="chips">
      <legend>{legend}</legend>
      <div role="radiogroup" aria-label={legend}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? "chip on" : "chip"} onClick={() => onPick(o)}>{labels[o]}</button>
        ))}
      </div>
    </fieldset>
  );
}

/** Customise Momo and watch the same character that appears on the desktop. Nothing here changes what Momo can do. */
export function CharacterPage({ prefs, set }: PageProps) {
  const c = prefs.character;
  const patch = (p: Partial<CharacterPrefs>) => set({ character: { ...c, ...p } });
  const [forced, setForced] = useState<ExpressionId | null>(null);
  const mouth = useMemo(() => new MouthSync(), []);
  const speaker = useRef<Speaker | null>(null);
  if (!speaker.current) speaker.current = new Speaker();
  useEffect(() => { speaker.current?.listen(mouth.handle); return () => { speaker.current?.stop(); speaker.current?.listen(null); }; }, [mouth]);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => mouth.subscribe(() => setSpeaking(mouth.speaking)), [mouth]);

  const shown: ExpressionId = forced ?? (speaking ? "speaking" : PERSONAS[c.personality].idle);
  const hello = `${phrase("ready", c.personality)} ${phrase("listenAgent", c.personality)}`;
  const say = () => speaker.current?.speak(hello, { voiceURI: prefs.voiceOutput.voiceURI, rate: prefs.voiceOutput.rate, lang: prefs.speechLanguage }, true);
  const changed = JSON.stringify(c) !== JSON.stringify(defaultCharacter);

  return (
    <>
      <header className="page-head"><h1>Character</h1><p className="lead">Make Momo yours. Appearance and personality only change how Momo looks and sounds: its skills, its safety checks and what it asks permission for stay exactly the same.</p></header>

      <section className="panel char-preview">
        <div className="stage" data-theme={c.theme}>
          {isSpriteArt(c.art)
            ? <AvatarView character={c} expression={shown} view="expanded" className="preview-art" />
            : <Momo appearance={c} expression={shown} mouth={mouth} view="expanded" className="preview-svg" />}
        </div>
        <div className="preview-side">
          <p className="bubble">“{hello}”</p>
          <div className="row">
            <button className="primary" onClick={say}>Say hello</button>
            <button onClick={() => setForced(null)} disabled={forced === null}>Back to automatic</button>
          </div>
          <p className="hint">Preview a face. On the desktop Momo picks the face from what it is really doing: listening, working, finished or stuck.</p>
          <div className="expr-grid" role="group" aria-label="Preview expression">
            {EXPRESSIONS.map((e) => (
              <button key={e} type="button" className={forced === e ? "chip sm on" : "chip sm"} onClick={() => setForced(e)}>{e}</button>
            ))}
          </div>
        </div>
      </section>

      <section className="panel">
        <label className="switch-row">
          <span><strong>Show Momo on the desktop</strong><small>Turn off to keep only the small status bar.</small></span>
          <span className="switch"><input type="checkbox" role="switch" checked={c.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /><i aria-hidden="true" /></span>
        </label>
        <Chips legend="Size on the desktop" group="view" options={VIEWS} value={c.view} onPick={(v) => patch({ view: v as CharacterPrefs["view"] })} />
      </section>

      <section className="panel">
        <h2 className="tight">Appearance</h2>
        <Chips legend="Avatar art" group="art" options={AVATAR_ARTS} value={c.art} onPick={(v) => patch({ art: v as CharacterPrefs["art"] })} />
        {isSpriteArt(c.art) ? (
          <p className="hint">The avatar sheets are the two figures you supplied. Each has six drawn faces, so Momo shows the closest face for what it is doing. Choose “Drawn” to go back to the hand-drawn character and its hairstyle and outfit options.</p>
        ) : (
          <>
            <Chips legend="Gender presentation" group="presentation" options={PRESENTATIONS} value={c.presentation} onPick={(v) => patch({ presentation: v as CharacterPrefs["presentation"] })} />
            <Chips legend="Hairstyle" group="hairstyle" options={HAIRSTYLES} value={c.hairstyle} onPick={(v) => patch({ hairstyle: v as CharacterPrefs["hairstyle"] })} />
            <Chips legend="Hair colour" group="hairColor" options={HAIR_COLORS} value={c.hairColor} onPick={(v) => patch({ hairColor: v as CharacterPrefs["hairColor"] })} />
            <Chips legend="Outfit" group="outfit" options={OUTFITS} value={c.outfit} onPick={(v) => patch({ outfit: v as CharacterPrefs["outfit"] })} />
            <label className="switch-row">
              <span><strong>Headphones</strong></span>
              <span className="switch"><input type="checkbox" role="switch" checked={c.headphones} onChange={(e) => patch({ headphones: e.target.checked })} /><i aria-hidden="true" /></span>
            </label>
          </>
        )}
        <Chips legend="Theme" group="theme" options={THEMES} value={c.theme} onPick={(v) => patch({ theme: v as CharacterPrefs["theme"] })} />
      </section>

      <section className="panel">
        <h2 className="tight">Personality</h2>
        <Chips legend="How Momo talks to you" group="personality" options={PERSONALITIES} value={c.personality} onPick={(v) => patch({ personality: v as CharacterPrefs["personality"] })} />
        <p className="hint">{PERSONALITY_BLURB[c.personality]} It changes Momo's wording and manner only, never its intelligence or what it is allowed to do.</p>
        <ul className="plain sample">
          <li>“{phrase("listenAgent", c.personality)}”</li>
          <li>“{phrase("done", c.personality)}”</li>
          <li>“{phrase("failed", c.personality)}”</li>
        </ul>
      </section>

      <section className="panel">
        <h2 className="tight">Animation</h2>
        <Chips legend="Movement" group="animation" options={ANIMATION_LEVELS} value={c.animation} onPick={(v) => patch({ animation: v as CharacterPrefs["animation"] })} />
        <p className="hint">Full: blinking, breathing and small head movements. Reduced: blinking and expression changes only. Off: still poses. Windows' “reduce animations” setting is respected.</p>
      </section>

      <section className="panel">
        <div className="row"><button onClick={() => { setForced(null); set({ character: defaultCharacter }); }} disabled={!changed}>Reset character to defaults</button></div>
        <p className="hint">Your choices are saved on this PC only, with your other settings, and removed by “Delete my data”.</p>
      </section>
    </>
  );
}
