import { useState } from "react";
import { PLACEHOLDER_FACE, colorFor, manifest } from "../companion/expression";
import { portraitUrl } from "../companion/sprites";
import { Companion } from "./Companion";

interface Props {
  current: string | null;
  onUse(id: string): void;
  onCancel?(): void;
}

export function Picker({ current, onUse, onCancel }: Props) {
  const [sel, setSel] = useState<string>(current ?? manifest.characters[0].id);
  const chosen = manifest.characters.find((c) => c.id === sel)!;

  return (
    <div className="picker" role="dialog" aria-label="Select your companion">
      <h1>✦ Select Your Companion</h1>
      <p className="sub">Choose one of your Momo friends!</p>
      <div className="cards" role="radiogroup" aria-label="Companions">
        {manifest.characters.map((c) => {
          const active = c.id === sel;
          const url = portraitUrl(c.id);
          return (
            <button
              key={c.id}
              role="radio"
              aria-checked={active}
              className={`card-btn${active ? " selected" : ""}`}
              onClick={() => setSel(c.id)}
            >
              {active && <span className="check" aria-hidden="true">✓</span>}
              {url ? <img src={url} alt="" /> : (
                <span className="portrait-ph" style={{ background: colorFor(c.id) }}>{PLACEHOLDER_FACE.idle}</span>
              )}
              <strong>{c.label}</strong>
              <small>{c.tagline}</small>
            </button>
          );
        })}
      </div>
      <div className="preview">
        <Companion characterId={sel} state="idle" reduceMotion={false} />
        <div>
          <h2>{chosen.label}</h2>
          <p>{chosen.tagline}</p>
          <div className="row">
            <button className="primary" onClick={() => onUse(sel)}>Use this companion</button>
            {onCancel && <button onClick={onCancel}>Cancel</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
