import { Suspense, lazy, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Prefs } from "../state/settings";
import type { CompanionState } from "../state/companionState";
import { Companion } from "./Companion";
// three.js is large: it is only downloaded when the full 3D scene is actually used
const Scene3D = lazy(() => import("./Scene3D"));
import type { Quality } from "../scene/perf";
import { TaskPanel, STATE_TEXT } from "./TaskPanel";
import { manifest } from "../companion/expression";
import { desktop } from "../desktop";

interface Props {
  prefs: Prefs;
  state: CompanionState;
  /** live microphone level 0..1 (only with live voice) */
  level?: number;
  onMove(x: number, bottom: number): void;
  onToggleCompact(): void;
  onSettings(): void;
  micDown(): void;
  micUp(): void;
  onCancel(): void;
  onConfirm(approved: boolean): void;
  onAnswer(text: string): void;
  onDismiss(): void;
  /** type a request instead of speaking it */
  onSubmitText(text: string): void;
  onWake(): void;
  /** "standard" draws the 3D scene; "low" keeps the light 2D view */
  quality: Quality;
  characterView: "2d" | "3d";
  onSceneSlow(reason: "slow" | "context-lost"): void;
  onModelInfo?(info: { using: boolean; placeholder: boolean }): void;
}

const W = 340;
const MARGIN = 24;
const MIN_VISIBLE = 80;

/**
 * Anchored by its BOTTOM-left corner: `prefs.widget.x` = left offset, `prefs.widget.y` = distance
 * from the viewport bottom. The character, table and controls therefore never move when the
 * task panel above them appears, grows or disappears.
 */
export function Widget(p: Props) {
  const { prefs, state } = p;
  const drag = useRef<{ dx: number; dBottom: number; sx: number; sy: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const recording = state.ui === "listening";
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const scale = prefs.widget.size;
  const compact = prefs.widget.compact;

  const left = (desktop ? null : prefs.widget.x) ?? Math.max(8, window.innerWidth - W * scale - MARGIN);
  const bottom = (desktop ? null : prefs.widget.y) ?? MARGIN;

  // The panel only appears when Momo has something to say; idle shows just the character.
  const showPanel = !compact && (state.ui !== "idle" || !!state.answer);
  const showBubble = compact && (state.ui !== "idle" || !!state.answer);

  const down = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest("button,input,select,a")) return;
    const r = ref.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dBottom: r.bottom - e.clientY, sx: e.screenX, sy: e.screenY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent) => {
    if (!drag.current) return;
    if (desktop) { // move the whole OS window
      desktop.dragBy(e.screenX - drag.current.sx, e.screenY - drag.current.sy);
      drag.current.sx = e.screenX; drag.current.sy = e.screenY;
      return;
    }
    const x = e.clientX - drag.current.dx;
    const b = window.innerHeight - (e.clientY + drag.current.dBottom);
    p.onMove(
      Math.min(Math.max(0, x), Math.max(0, window.innerWidth - MIN_VISIBLE)),
      Math.min(Math.max(0, b), Math.max(0, window.innerHeight - MIN_VISIBLE)),
    );
  };
  const up = () => { if (drag.current && desktop) desktop.dragEnd(); drag.current = null; };

  const micLabel = prefs.activationMode === "hold" ? "Hold to talk" : recording ? "Stop" : "Tap to talk";

  return (
    <div
      ref={ref}
      className={`widget${compact ? " is-compact" : ""}`}
      style={{ left, bottom, width: W, opacity: prefs.widget.opacity, transform: `scale(${scale})`, transformOrigin: "bottom left" }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
    >
      <div className="toolbar">
        <span className="grip" title="Drag to move" aria-hidden="true">⠿</span>
        <button onClick={p.onToggleCompact} aria-label={compact ? "Expand panel" : "Compact mode"} title={compact ? "Expand" : "Compact"}>
          {compact ? "▢" : "▁"}
        </button>
        <button onClick={() => setTyping((v) => !v)} aria-label="Type a request" title="Type a request" aria-pressed={typing}>⌨</button>
        <button onClick={p.onSettings} aria-label="Settings" title="Settings">⚙</button>
        {desktop && <button onClick={() => desktop?.hide()} aria-label="Hide to tray" title="Hide to tray (use the tray icon to bring me back)">✕</button>}
      </div>

      {showPanel && (
        <TaskPanel state={state} onConfirm={p.onConfirm} onAnswer={p.onAnswer} onDismiss={p.onDismiss} onWake={p.onWake} />
      )}
      {showBubble && <div className="bubble" aria-live="polite">{state.answer ? state.answer.text.slice(0, 160) : (state.message ?? STATE_TEXT[state.ui])}</div>}

      {p.quality === "standard" ? (
        <div className="scene scene-3d">
          <Suspense fallback={<div className="scene3d-loading" style={{ width: 340, height: 270 }} aria-hidden="true" />}>
          <Scene3D
            characterId={prefs.companionId ?? "mochi"}
            state={state.ui}
            reduceMotion={prefs.widget.reduceMotion}
            view={p.characterView}
            onSlow={p.onSceneSlow}
            onModel={p.onModelInfo}
          />
          </Suspense>
        </div>
      ) : (
        <div className="scene">
          <Companion characterId={prefs.companionId ?? "mochi"} state={state.ui} reduceMotion={prefs.widget.reduceMotion} />
          <div className="table" aria-hidden="true" />
        </div>
      )}

      <div className="nametag">
        <strong>✦ {manifest.characters.find((c) => c.id === prefs.companionId)?.label ?? ""}</strong>
        <small>Your AI Companion</small>
      </div>

      {typing && (
        <form className="typed" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { p.onSubmitText(draft); setDraft(""); } }}>
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. storage of D drive" aria-label="Type a request" maxLength={500} />
          <button type="submit" disabled={!draft.trim()}>Ask</button>
        </form>
      )}

      <div className="controls">
        {recording && prefs.showRecordingIndicator && (
          <span className="rec" role="status"><span className="dot" /> Recording</span>
        )}
        <button
          className={`mic${recording ? " on" : ""}`}
          disabled={state.ui === "disabled"}
          onPointerDown={prefs.activationMode === "hold" ? p.micDown : undefined}
          onPointerUp={prefs.activationMode === "hold" ? p.micUp : undefined}
          onPointerLeave={prefs.activationMode === "hold" && recording ? p.micUp : undefined}
          onClick={prefs.activationMode === "toggle" ? p.micDown : undefined}
          aria-pressed={recording}
        >
          🎤 {micLabel}
        </button>
        {recording && p.level !== undefined && (
          <span className="meter" role="img" aria-label="Microphone level"><i style={{ width: `${Math.min(100, Math.round(p.level * 160))}%` }} /></span>
        )}
        {recording && <button onClick={p.onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
