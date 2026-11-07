import { useEffect, useRef } from "react";
import { SceneEngine, SCENE_H, SCENE_W, type EngineOptions } from "../scene/engine";
import type { CompanionUiState } from "../types/runtime-events";

interface Props {
  characterId: string;
  state: CompanionUiState;
  reduceMotion: boolean;
  view: "2d" | "3d";
  onSlow(reason: "slow" | "context-lost"): void;
  onModel?: EngineOptions["onModel"];
}

declare global {
  interface Window { __momoScene?: SceneEngine }
}

/** The 3D scene (table, props, petals, character, effects). Everything heavy lives in SceneEngine. */
export default function Scene3D({ characterId, state, reduceMotion, view, onSlow, onModel }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<SceneEngine | null>(null);
  const cb = useRef({ onSlow, onModel });
  cb.current = { onSlow, onModel };

  // create once; dispose on unmount (GPU memory is released, no timers left running)
  useEffect(() => {
    const e = new SceneEngine(host.current!, {
      onSlow: (r) => cb.current.onSlow(r),
      onModel: (i) => cb.current.onModel?.(i),
    });
    engine.current = e;
    if (import.meta.env.DEV) window.__momoScene = e; // lets the live check read frame statistics
    const onVis = () => e.kick();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      e.dispose();
      engine.current = null;
      if (import.meta.env.DEV && window.__momoScene === e) delete window.__momoScene;
    };
  }, []);

  useEffect(() => { engine.current?.setCharacter(characterId, view); }, [characterId, view]);
  useEffect(() => { engine.current?.setState(state); }, [state, characterId, view]);
  useEffect(() => { engine.current?.setReduceMotion(reduceMotion); }, [reduceMotion]);

  return (
    <div
      ref={host}
      className="scene3d"
      style={{ width: SCENE_W, height: SCENE_H }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        engine.current?.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
      }}
      role="img"
      aria-label={`${characterId} is ${state.replace("_", " ")}`}
    />
  );
}
