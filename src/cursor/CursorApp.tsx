import { useEffect, useRef, useState } from "react";
import { desktop, type CursorMessage } from "../desktop";
import "../styles/cursor.css";

const VERB: Record<string, string> = { look: "Here", select: "Selecting", click: "Clicking", type: "Typing in", submit: "Pressing Enter in" };
/** how long a glide takes (matches the CSS transition) and how long the ghost stays to "do" the action (UI Automation actions only) */
const GLIDE_MS = 800;
const DWELL_MS: Record<string, number> = { look: 450, select: 650, click: 700, type: 900, submit: 800 };

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const frames = (n: number) => new Promise<void>((r) => { const step = (i: number) => (i <= 0 ? r() : requestAnimationFrame(() => step(i - 1))); step(n); });

type Verdict = "wait" | "ok" | "unconfirmed" | "failed";
interface Box { x: number; y: number; w: number; h: number }
interface View {
  shown: boolean; fading: boolean;
  /** the ghost pointer */
  x: number; y: number;
  /** true while it is driven by the REAL pointer's positions (no glide of its own: it can never lag or drift) */
  follow: boolean;
  /** the first paint at a new place has no glide (so the next move glides FROM there) */
  snap: boolean;
  label: string;
  /** the exact element Momo is working on, centred, with its size */
  target: Box | null;
  tone: string;
  /** letters typed so far, as they are REALLY typed */
  typed: string;
  /** which action is being performed right now, and a counter that restarts its animation */
  cue: { action: string; n: number } | null;
  /** the outcome of the step, only ever set after Momo checked it */
  verdict: Verdict | null;
  /** the user took over */
  stopped: "mouse" | "esc" | null;
  /** how the whole task ended */
  final: "ok" | "unconfirmed" | "failed" | null;
}
const hidden: View = { shown: false, fading: false, x: 0, y: 0, follow: false, snap: false, label: "", target: null, tone: "other", typed: "", cue: null, verdict: null, stopped: null, final: null };
const GLYPH: Record<Verdict, string> = { wait: "", ok: "✓", unconfirmed: "?", failed: "✕" };

/**
 * Momo's shadow cursor: a soft ghost pointer that shows what Momo does, step by step:
 *   aim      the exact element is highlighted (with what it is for) BEFORE anything moves,
 *   move     the ghost either glides on its own (UI Automation) or is placed at the REAL pointer's actual position, many times a second,
 *   hover / click / type   what happens at the target, at the moment it really happens (the ring appears when the button goes down,
 *            each letter appears when it is typed),
 *   result   "checking…", then only after Momo has verified: confirmed (green), not confirmed (amber) or failed (red),
 *   stop     you moved the mouse or pressed Esc: it stops at once.
 * It exists only while a task runs, never receives clicks, and never clicks anything itself.
 */
export default function CursorApp() {
  const [v, setV] = useState<View>(hidden);
  const queue = useRef<CursorMessage[]>([]);
  const running = useRef(false);
  const cueN = useRef(0);
  const epoch = useRef(0); // bumps on "hide" so a stale step never draws after it

  useEffect(() => {
    document.documentElement.classList.add("cursor-route");
    if (!desktop) return;

    /** messages that must show the instant they arrive (they mirror something that is happening right now) */
    const immediate = (m: CursorMessage): boolean => {
      if (m.kind === "aim") {
        setV((s) => ({ ...s, shown: true, fading: false, follow: false, target: { x: m.x, y: m.y, w: m.w, h: m.h }, tone: m.tone ?? "other", label: m.say || (m.label ? `${m.label}` : "Here"), typed: "", cue: { action: "aim", n: ++cueN.current }, verdict: null, stopped: null, final: null }));
        return true;
      }
      if (m.kind === "track") {
        setV((s) => {
          if (s.stopped) return s;
          if (m.phase === "move" && m.x !== undefined && m.y !== undefined) return { ...s, follow: true, x: m.x, y: m.y, snap: false, cue: s.cue?.action === "aim" ? s.cue : null };
          if (m.phase === "hover") return { ...s, cue: { action: "hover", n: ++cueN.current } };
          if (m.phase === "press") return { ...s, cue: { action: "click", n: ++cueN.current } };
          if (m.phase === "key") return m.ch === "↵" ? { ...s, cue: { action: "submit", n: ++cueN.current } } : { ...s, typed: s.typed + (m.ch ?? ""), cue: { action: "type", n: s.cue?.action === "type" ? s.cue.n : ++cueN.current } };
          return s;
        });
        return true;
      }
      if (m.kind === "result") {
        setV((s) => (s.stopped ? s : { ...s, verdict: m.state === "verifying" ? "wait" : m.state === "verified" ? "ok" : m.state, label: m.text || (m.state === "verifying" ? "Checking…" : m.state === "verified" ? "Confirmed" : m.state === "unconfirmed" ? "Not confirmed" : "That didn't work"), cue: null }));
        return true;
      }
      if (m.kind === "stop") {
        setV((s) => ({ ...s, stopped: m.reason, verdict: null, cue: null, label: m.reason === "esc" ? "Stopped: you pressed Esc" : "Stopped: you moved the mouse" }));
        return true;
      }
      return false;
    };

    const apply = async (m: CursorMessage, my: number) => {
      const stale = () => my !== epoch.current;
      if (m.kind === "show") {
        // render at the start position first (no glide), so the first move visibly starts from here
        setV({ ...hidden, shown: true, x: m.x, y: m.y, label: "Momo is working", snap: true });
        await frames(3);
        if (stale()) return;
        setV((s) => ({ ...s, snap: false }));
        await wait(350);
      } else if (m.kind === "say") {
        setV((s) => (s.shown && !s.verdict && !s.stopped ? { ...s, label: m.text } : s));
      } else if (m.kind === "move") {
        const verb = VERB[m.action] ?? "Working on";
        setV((s) => ({ ...s, shown: true, fading: false, follow: false, x: m.x, y: m.y, target: { x: m.x, y: m.y, w: m.w, h: m.h }, tone: "other", typed: m.text ?? "", cue: null, verdict: null, stopped: null, final: null, label: m.say ? m.say : m.label ? `${verb} “${m.label}”` : verb }));
        await wait(GLIDE_MS); // the glide
        if (stale()) return;
        setV((s) => (s.stopped ? s : { ...s, cue: { action: m.action, n: ++cueN.current } })); // the action itself
        await wait(m.action === "type" && m.text ? 1300 : (DWELL_MS[m.action] ?? 600));
      } else if (m.kind === "done") {
        setV((s) => (s.stopped ? s : { ...s, fading: true, cue: null, final: m.result ?? (m.ok ? "ok" : "failed"), label: (m.result ?? (m.ok ? "ok" : "failed")) === "ok" ? "Done" : (m.result ?? "failed") === "unconfirmed" ? "Finished, but not everything was confirmed" : "Stopped" }));
      }
    };

    const pump = async () => {
      if (running.current) return;
      running.current = true;
      const my = epoch.current;
      while (queue.current.length && my === epoch.current) await apply(queue.current.shift()!, my);
      running.current = false;
      if (my !== epoch.current && queue.current.length) void pump();
    };

    return desktop.onCursor((m) => {
      if (m.kind === "hide") { epoch.current++; queue.current = []; running.current = false; setV(hidden); return; }
      if (immediate(m)) return;
      queue.current.push(m);
      void pump();
    });
  }, []);

  if (!v.shown) return null;
  const t = v.target;
  const state = v.stopped ? "failed" : v.verdict ?? (v.cue?.action === "click" || v.cue?.action === "submit" ? "hit" : v.cue?.action === "hover" ? "hover" : v.cue?.action === "aim" ? "aim" : v.cue ? "hit" : "idle");
  const tagTone = v.stopped || v.final === "failed" || v.verdict === "failed" ? "bad" : v.final === "unconfirmed" || v.verdict === "unconfirmed" ? "warn" : v.final === "ok" || v.verdict === "ok" ? "good" : "";
  return (
    <div className={v.fading ? "shadow fade" : "shadow"} aria-hidden="true">
      {t && t.w > 0 && (
        <>
          <i className={`target ${v.tone} ${state}`} style={{ left: t.x - t.w / 2, top: t.y - t.h / 2, width: t.w, height: t.h }} />
          {(v.verdict || v.stopped) && (
            <span className={`badge ${v.stopped ? "failed" : v.verdict}`} style={{ left: t.x + t.w / 2 - 10, top: t.y - t.h / 2 - 12 }}>
              {v.verdict === "wait" ? <><i /><i /><i /></> : v.stopped ? "■" : GLYPH[v.verdict!]}
            </span>
          )}
        </>
      )}
      <div className={`${v.snap ? "ghost snap" : v.follow ? "ghost follow" : "ghost"}`} style={{ transform: `translate(${v.x}px, ${v.y}px)` }}>
        <div className={v.follow ? "" : "drift"}>
          {v.cue && (v.cue.action === "click" || v.cue.action === "select") && <span key={v.cue.n} className="ring on" />}
          {v.cue?.action === "hover" && <span key={v.cue.n} className="halo" />}
          <svg className={v.cue && (v.cue.action === "click" || v.cue.action === "select" || v.cue.action === "submit") ? "arrow press" : "arrow"} width="28" height="28" viewBox="0 0 24 24" key={v.cue ? `p${v.cue.n}` : "idle"}>
            <path d="M4 2.5v17l4.6-4.2 3 6.4 2.7-1.3-3-6.2 6.3-.4z" fill="rgba(255,122,168,.9)" stroke="rgba(255,255,255,.96)" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          {v.cue?.action === "type" && !v.typed && <span key={v.cue.n} className="typing"><i /><i /><i /></span>}
          {v.cue?.action === "type" && v.typed && (v.follow
            ? <span className="typed live">{v.typed}<b /></span>
            : <span key={v.cue.n} className="typed" style={{ ["--n" as string]: v.typed.length }}>{v.typed}</span>)}
          {v.cue?.action === "submit" && <span key={v.cue.n} className="keycap">↵ Enter</span>}
          <span className={`tag ${tagTone}`}>{v.label}</span>
        </div>
      </div>
    </div>
  );
}
