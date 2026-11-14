import { useCallback, useEffect, useRef, useState } from "react";
import "../styles/avatar.css";
import type { SpeechEvent } from "../voice/tts";
import type { ExpressionId } from "./face";
import { expressionAt, sentenceSpans, type Span } from "./textExpression";

/**
 * The cloud that shows what Momo is saying, word by word as the speech engine really reaches each word, and the face that fits
 * the sentence being said. Fed only by the speech engine's own events (the same ones that drive everything else), so it starts
 * with the voice and stops with the voice. It never sees the task.
 */
export interface Cloud { text: string; hi: [number, number] | null }

const HOLD_MS = 2200; // the cloud stays a moment after the last word so it can be read

export function useSpokenCloud() {
  const [cloud, setCloud] = useState<Cloud | null>(null);
  const [words, setWords] = useState<ExpressionId | null>(null);
  const spans = useRef<Span[]>([]);
  const hide = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hide.current), []);

  const handle = useCallback((e: SpeechEvent) => {
    switch (e.type) {
      case "start":
        window.clearTimeout(hide.current);
        spans.current = sentenceSpans(e.text);
        setCloud({ text: e.text, hi: null });
        setWords(expressionAt(spans.current, 0));
        break;
      case "boundary": {
        setCloud((c) => {
          if (!c) return c;
          const len = e.length ?? (c.text.slice(e.index).match(/^\S+/)?.[0].length ?? 1);
          return { ...c, hi: [e.index, len] };
        });
        setWords(expressionAt(spans.current, e.index));
        break;
      }
      case "end":
        setWords(null); // the face goes back to what Momo is doing the moment the voice stops
        window.clearTimeout(hide.current);
        hide.current = window.setTimeout(() => setCloud(null), HOLD_MS);
        break;
      default: break; // pause / resume / interrupt: the words stay as they are until the next start or end
    }
  }, []);
  return { cloud, words, handle };
}

export function SpeechCloud({ cloud, className }: { cloud: Cloud | null; className?: string }) {
  if (!cloud) return null;
  const [s, l] = cloud.hi ?? [0, 0];
  const before = cloud.hi ? cloud.text.slice(0, s) : "";
  const now = cloud.hi ? cloud.text.slice(s, s + l) : "";
  const after = cloud.hi ? cloud.text.slice(s + l) : cloud.text;
  return (
    <div className={`cloud${className ? " " + className : ""}`} role="status" aria-live="polite">
      <span className="cloud-text">{before}<mark>{now}</mark>{after}</span>
    </div>
  );
}
