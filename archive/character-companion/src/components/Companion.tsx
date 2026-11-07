import { useMemo } from "react";
import { PLACEHOLDER_FACE, colorFor, manifest, resolveExpression } from "../companion/expression";
import { availableExpressions, spriteUrl } from "../companion/sprites";
import type { CompanionUiState } from "../types/runtime-events";

interface Props {
  characterId: string;
  state: CompanionUiState;
  reduceMotion: boolean;
}

/** CharacterRenderer + ExpressionController: picks a sprite via the manifest fallbacks, else a placeholder. */
export function Companion({ characterId, state, reduceMotion }: Props) {
  const available = useMemo(() => availableExpressions(characterId), [characterId]);
  const expression = resolveExpression(state, available);
  const url = expression ? spriteUrl(characterId, expression) : undefined;
  const label = manifest.characters.find((c) => c.id === characterId)?.label ?? characterId;

  return (
    <div
      className={`companion state-${state}${reduceMotion ? " reduce-motion" : ""}`}
      data-state={state}
      data-expression={expression ?? "placeholder"}
      role="img"
      aria-label={`${label} is ${state.replace("_", " ")}`}
    >
      {url ? (
        <img src={url} alt="" draggable={false} className="sprite" />
      ) : (
        <div className="placeholder" style={{ background: colorFor(characterId) }}>
          <span className="placeholder-face">{PLACEHOLDER_FACE[state]}</span>
          <span className="placeholder-name">{label}</span>
          <span className="placeholder-expr">{expression ?? "no sprite"}</span>
        </div>
      )}
      <StateBadge state={state} />
    </div>
  );
}

const BADGE: Partial<Record<CompanionUiState, string>> = {
  listening: "🎤",
  transcribing: "〰",
  thinking: "💭",
  asking: "❓",
  working: "⚙",
  success: "✔",
  partial_success: "½",
  sorry: "💧",
  blocked: "✋",
  error: "⚠",
  sleeping: "z z Z",
  disabled: "🚫",
};
function StateBadge({ state }: { state: CompanionUiState }) {
  const b = BADGE[state];
  return b ? <span className="badge" aria-hidden="true">{b}</span> : null;
}
