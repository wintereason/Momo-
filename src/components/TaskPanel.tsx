import { useState } from "react";
import type { CompanionState } from "../state/companionState";
import type { CompanionUiState } from "../types/runtime-events";

export const STATE_TEXT: Record<CompanionUiState, string> = {
  idle: "Ready",
  listening: "Listening…",
  transcribing: "Turning speech into text…",
  thinking: "Let me check that.",
  asking: "I have a question",
  working: "Working on it…",
  success: "Done — I verified it.",
  partial_success: "I finished part of it; one step remains.",
  sorry: "Sorry, I couldn't complete that.",
  blocked: "I need your confirmation before continuing.",
  error: "Something went wrong. You can retry.",
  sleeping: "Resting — use your shortcut or button to wake me.",
  disabled: "Microphone access is disabled.",
};

interface Props {
  state: CompanionState;
  onConfirm(approved: boolean): void;
  onAnswer(text: string): void;
  onDismiss(): void;
  onWake(): void;
}

export function TaskPanel({ state, onConfirm, onAnswer, onDismiss, onWake }: Props) {
  const [answer, setAnswer] = useState("");
  const { ui } = state;

  return (
    <section className="task-panel" aria-live="polite" aria-label="Task status">
      {!state.answer && <div className={`status status-${ui}`}>{STATE_TEXT[ui]}</div>}

      {state.transcript && (
        <p className="transcript"><span className="label">You said</span> “{state.transcript}”</p>
      )}
      {state.message && ui !== "success" && <p className="message">{state.message}</p>}

      {state.answer && (
        <div className="card answer">
          <span className="label">{state.answer.source}</span>
          <p>{state.answer.text}</p>
          <small className="hint">An AI wrote this. It can be wrong: check anything important.</small>
          <button onClick={onDismiss}>OK</button>
        </div>
      )}

      {ui === "asking" && state.clarification && (
        <div className="card clarification">
          <p>{state.clarification.options?.length ? "Which one should I use?" : state.clarification.question}</p>
          {state.clarification.options && state.clarification.options.length > 0 && (
            <ol className="options">
              {state.clarification.options.map((o, i) => (
                <li key={i}>
                  <button onClick={() => onAnswer(String(i + 1))}>
                    <strong>{o.label}</strong>
                    {o.detail && <small>{o.detail}</small>}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <form onSubmit={(e) => { e.preventDefault(); if (answer.trim()) { onAnswer(answer.trim()); setAnswer(""); } }}>
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Type or speak your answer" aria-label="Your answer" />
            <button type="submit" disabled={!answer.trim()}>Answer</button>
          </form>
        </div>
      )}

      {ui === "blocked" && state.confirmation && (
        <div className="card confirmation" role="alertdialog" aria-label="Confirmation required">
          <p>{state.confirmation.summary}</p>
          <div className="row">
            <button className="primary" onClick={() => onConfirm(true)}>Confirm</button>
            <button onClick={() => onConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {state.result && (ui === "success" || ui === "sorry" || ui === "error") && (
        <div className={`card result result-${state.result.kind}`}>
          <p>{state.result.summary}</p>
          {state.result.kind === "success" && state.result.verified && <span className="verified">✓ Verified</span>}
          <button onClick={onDismiss}>OK</button>
        </div>
      )}

      {(ui === "partial_success") && <button onClick={onDismiss}>OK</button>}
      {(ui === "sleeping" || ui === "disabled") && (
        <button onClick={onWake}>{ui === "sleeping" ? "Wake up" : "Retry microphone"}</button>
      )}
    </section>
  );
}
