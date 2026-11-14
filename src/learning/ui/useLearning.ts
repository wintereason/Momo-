import { useCallback, useEffect, useMemo, useState } from "react";
import { updateGoals } from "../goals";
import type { LearningState } from "../state";
import { LEARNING_KEY, LearningStore } from "../store";

/** The learner's saved progress as React state. Every change is validated and saved at once, and other windows are followed. */
export function useLearning() {
  const store = useMemo(() => new LearningStore(window.localStorage), []);
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === LEARNING_KEY || e.key === null) { store.reload(); refresh(); } };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, [store, refresh]);
  const update = useCallback((fn: (s: LearningState) => LearningState): LearningState | null => {
    const next = store.update((s) => updateGoals(fn(s), Date.now()));
    refresh();
    return next;
  }, [store, refresh]);
  return { store, state: store.state(), update, refresh };
}
