import { SCENARIOS, type Scenario } from "../runtime/mockRuntime";
import { UI_STATES, type CompanionUiState } from "../types/runtime-events";

interface Props {
  current: CompanionUiState;
  scenario: Scenario;
  onScenario(s: Scenario): void;
  onForce(s: CompanionUiState): void;
  onClose(): void;
}

export function DebugPanel({ current, scenario, onScenario, onForce, onClose }: Props) {
  return (
    <aside className="debug" aria-label="Mock runtime controls">
      <header>
        <h3>Mock runtime</h3>
        <button onClick={onClose} aria-label="Close debug panel">✕</button>
      </header>
      <label className="field">
        Next spoken request plays:
        <select value={scenario} onChange={(e) => onScenario(e.target.value as Scenario)}>
          {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <p className="hint">Then use the shortcut or the mic button.</p>
      <h4>Jump straight to a state</h4>
      <div className="state-grid">
        {UI_STATES.map((s) => (
          <button key={s} className={s === current ? "primary" : ""} onClick={() => onForce(s)}>{s}</button>
        ))}
      </div>
    </aside>
  );
}
