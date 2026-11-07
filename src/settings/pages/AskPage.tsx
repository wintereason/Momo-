import { useEffect, useReducer, useRef, useState } from "react";
import { desktop } from "../../desktop";
import { CAN_START_VOICE, companionReducer, initialCompanionState } from "../../state/companionState";
import { parseRuntimeEvent } from "../../types/runtime-events";
import { TaskPanel } from "../../components/TaskPanel";

/** Typed commands: "how much space is on D", "open Calculator". Momo asks before it does anything on your PC. */
export function AskPage() {
  const [state, dispatch] = useReducer(companionReducer, initialCompanionState);
  const [draft, setDraft] = useState("");
  const seq = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!desktop) return;
    const off = desktop.onRuntimeEvent((raw) => { const e = parseRuntimeEvent(raw); if (e) dispatch(e); });
    return () => { off(); dispatch({ type: "local.reset" }); };
  }, []);

  const submit = (text: string) => {
    const t = text.trim().slice(0, 2000);
    if (!t || !CAN_START_VOICE.has(stateRef.current.ui)) return;
    const sid = `typed${++seq.current}`;
    dispatch({ type: "voice.started", sessionId: sid });
    dispatch({ type: "voice.stopped", sessionId: sid });
    dispatch({ type: "transcript.ready", sessionId: sid, text: t });
    desktop?.submitTranscript(sid, t);
  };

  return (
    <>
      <h1>Ask Momo</h1>
      <p className="lead">Type a question or a small job. Momo reads the answer from your PC, and asks before it opens or clicks anything.</p>
      {!desktop && <p className="hint">These commands need the desktop app.</p>}
      <form className="ask" onSubmit={(e) => { e.preventDefault(); submit(draft); setDraft(""); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. how much space is left on D, or open Calculator" aria-label="Ask Momo" maxLength={500} disabled={!desktop} />
        <button className="primary" type="submit" disabled={!desktop || !draft.trim()}>Ask</button>
      </form>
      <div className="taskarea">
        <TaskPanel
          state={state}
          onConfirm={(ok) => { const id = state.confirmation?.taskId; if (id) desktop?.respondConfirmation(id, ok); else dispatch({ type: "local.dismiss" }); }}
          onAnswer={(t) => submit(t)}
          onDismiss={() => { desktop?.cancelTask(); dispatch({ type: "local.dismiss" }); }}
          onWake={() => dispatch({ type: "local.wake" })}
        />
      </div>
    </>
  );
}
