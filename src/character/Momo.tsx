import { useEffect, useId, useRef } from "react";
import type { CharacterPrefs } from "./config";
import {
  BUILDS, EXPRESSION_DEFS, EYES, NO_BLINK, browPath, ease, easeFace, eyePaths, facePath, faceDistance, mouthPath,
  type ExpressionId, type FaceParams, type Glyph,
} from "./face";
import { HAIR } from "./hair";
import { PERSONAS } from "./personality";
import { paletteFor } from "./themes";
import { blinkFactor, motionAmount, nextBlinkDelay } from "./animation";
import type { MouthSync } from "./speechMouth";

/**
 * Momo, drawn live. The face is not a set of pictures: eyes, brows and mouth are paths rebuilt every frame from numbers
 * that ease toward the current expression, so blinking, looking around, speaking and changing mood all blend smoothly.
 * This component only DRAWS. It is given an expression and (optionally) a MouthSync; it knows nothing of the agent.
 */
export interface MomoProps {
  appearance: CharacterPrefs;
  expression: ExpressionId;
  /** the live mouth: when it is speaking, the mouth follows it */
  mouth?: MouthSync | null;
  /** compact = head and shoulders crop; expanded = upper body */
  view?: "compact" | "expanded";
  className?: string;
}

const VIEWBOX = { compact: "28 22 244 244", expanded: "0 0 300 340" } as const;
const GLYPH_TONE = { accent: "", warn: "#ffb83d", bad: "#ff5c7a" } as const;

interface Anim {
  face: FaceParams;
  mouth: { open: number; round: number; wide: number };
  nextBlink: number; blinkAt: number; doubleBlink: boolean;
  glyph: Glyph; glyphAlpha: number; glyphWant: Glyph;
  winkUntil: number; nextWink: number;
  last: number; paint: number;
}

export function Momo({ appearance, expression, mouth, view = "compact", className }: MomoProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const pal = paletteFor(appearance.theme, appearance.hairColor);
  const build = BUILDS[appearance.presentation];
  const hair = HAIR[appearance.hairstyle];
  const refs = useRef<Record<string, SVGElement | null>>({});
  const reg = (k: string) => (el: SVGElement | null) => { refs.current[k] = el; };

  // the loop reads these without restarting
  const live = useRef({ expression, mouth, appearance, build });
  live.current = { expression, mouth, appearance, build };
  const wake = useRef<() => void>(() => {});
  useEffect(() => { wake.current(); }, [expression, appearance]);

  useEffect(() => {
    const osReduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const start = performance.now();
    const target0 = EXPRESSION_DEFS[live.current.expression];
    const a: Anim = {
      face: { ...target0.face }, mouth: { open: target0.face.open, round: target0.face.round, wide: target0.face.wide },
      nextBlink: start + 1500, blinkAt: -1, doubleBlink: false,
      glyph: target0.glyph, glyphAlpha: target0.glyph === "none" ? 0 : 1, glyphWant: target0.glyph,
      winkUntil: 0, nextWink: start + 20000 + Math.random() * 15000, last: start, paint: 0,
    };
    let raf = 0;
    let running = true;
    const g0 = refs.current.glyph;
    if (g0) { g0.textContent = target0.glyph === "none" ? "" : target0.glyph; if (target0.glyphTone !== "accent") g0.setAttribute("fill", GLYPH_TONE[target0.glyphTone]); }

    const set = (k: string, attr: string, v: string | number) => { refs.current[k]?.setAttribute(attr, String(v)); };

    const frame = (now: number) => {
      raf = 0;
      if (!running) return;
      const { appearance: ap, build: bd, mouth: mouthSync } = live.current;
      const motion = motionAmount(ap.animation, osReduced);
      const persona = PERSONAS[ap.personality];
      const dt = Math.min(0.1, (now - a.last) / 1000);
      a.last = now;
      const t = (now - start) / 1000;

      // a playful Momo sometimes winks while idle
      let want: ExpressionId = live.current.expression;
      if (persona.winks && motion.sway > 0 && want === persona.idle) {
        if (now > a.nextWink) { a.winkUntil = now + 900; a.nextWink = now + 18000 + Math.random() * 17000; }
        if (now < a.winkUntil) want = "wink";
      }
      const def = EXPRESSION_DEFS[want];
      const speakingLevel = mouthSync?.level(now) ?? null;

      a.face = motion.ease ? easeFace(a.face, def.face, dt, 9) : { ...def.face };
      const m = speakingLevel ?? { open: def.face.open, round: def.face.round, wide: def.face.wide };
      const k = speakingLevel ? 24 : 9;
      a.mouth = motion.ease
        ? { open: ease(a.mouth.open, m.open, dt, k), round: ease(a.mouth.round, m.round, dt, k), wide: ease(a.mouth.wide, m.wide * (speakingLevel ? def.face.wide : 1), dt, k) }
        : { ...m };
      const f = a.face;

      // blinking
      let blink = 1;
      if (motion.blink && !NO_BLINK.has(want)) {
        if (a.blinkAt < 0 && now >= a.nextBlink) { a.blinkAt = now; a.doubleBlink = Math.random() < 0.15; }
        if (a.blinkAt >= 0) {
          const el = now - a.blinkAt;
          blink = blinkFactor(el);
          if (el > 150) {
            a.blinkAt = -1;
            a.nextBlink = a.doubleBlink ? now + 120 : now + nextBlinkDelay(Math.random(), persona.blinkEvery);
            a.doubleBlink = false;
          }
        }
      }

      // gentle life: breathing, a slight sway, the eyes drifting
      const sway = motion.sway * persona.motion * f.energy;
      const speakingNow = speakingLevel !== null;
      const roll = f.headRoll + Math.sin(t * 0.7) * 1.1 * sway + (speakingNow ? Math.sin(t * 5.3) * 0.9 * motion.sway : 0);
      const dy = f.headDY + Math.sin(t * 1.3) * 1.4 * sway + (speakingNow ? Math.abs(Math.sin(t * 2.7)) * -1.2 * motion.sway : 0);
      const gx = f.gazeX + Math.sin(t * 0.37) * 0.14 * sway;
      const gy = f.gazeY + Math.sin(t * 0.53) * 0.09 * sway;

      set("head", "transform", `translate(0 ${dy.toFixed(2)}) rotate(${roll.toFixed(2)} 150 226)`);
      set("hairBack", "transform", `translate(${(-roll * 0.6).toFixed(2)} ${(-dy * 0.3).toFixed(2)})`);
      set("tuft", "transform", `rotate(${(Math.sin(t * 1.9) * 5 * motion.sway + roll * 0.8).toFixed(2)} 150 64)`);
      set("body", "transform", `translate(0 ${(Math.sin(t * 1.3 - 0.4) * 1.2 * sway).toFixed(2)})`);

      // eyes
      for (const side of ["L", "R"] as const) {
        const g = EYES[side];
        const open = (side === "L" ? f.openL : f.openR) * blink;
        const arc = side === "L" ? f.arcL : f.arcR;
        const p = eyePaths(g, open, arc, bd.eye);
        set("eyeClip" + side, "d", p.opening);
        set("sclera" + side, "d", p.opening);
        set("lid" + side, "d", p.lid);
        const outer = side === "L" ? -1 : 1;
        const ox = g.cx + outer * (g.w * bd.eye) / 2, oy = g.cy + g.h * bd.eye * 0.12 - arc * 2;
        set("lash" + side, "d", `M${ox} ${oy} Q${ox + outer * 6} ${oy - 1} ${ox + outer * 10} ${oy - 7}`);
        set("iris" + side, "transform", `translate(${(gx * 5).toFixed(2)} ${(gy * 4).toFixed(2)})`);
        set("pupil" + side, "rx", (7 * f.pupil).toFixed(2));
        set("pupil" + side, "ry", (10.5 * f.pupil).toFixed(2));
        set("hiA" + side, "r", (4.1 + f.sparkle * 1.8).toFixed(2));
        set("hiB" + side, "r", (2 + f.sparkle * 1.2).toFixed(2));
      }
      set("browL", "d", browPath(EYES.L.cx, 1, f.browL, f.tilt));
      set("browR", "d", browPath(EYES.R.cx, -1, f.browR, f.tilt));

      // mouth
      const ms = mouthPath(f.smile, a.mouth.open, a.mouth.round, a.mouth.wide);
      set("mouth", "d", ms.path);
      set("mouthClipPath", "d", ms.path);
      set("mouth", "fill", ms.filled ? "#4a1830" : "none");
      set("tongue", "opacity", ms.filled ? Math.min(1, ms.opening / 8) : 0);
      set("tongue", "cy", 197 + ms.opening * 0.95);

      // blush, sweat, tear
      set("blush", "opacity", Math.min(1, f.blush) * 0.55);
      set("sweat", "opacity", Math.min(1, f.sweat));
      set("sweat", "transform", `translate(0 ${(Math.sin(t * 1.5) * 1.5 * motion.sway).toFixed(2)})`);
      set("tear", "opacity", Math.min(1, f.tear));

      // the symbol that floats beside the head ("?", "!"...): fades out, swaps, fades in
      if (a.glyphWant !== def.glyph) a.glyphWant = def.glyph;
      const wantAlpha = a.glyph === a.glyphWant ? (a.glyph === "none" ? 0 : 1) : 0;
      a.glyphAlpha = motion.ease ? ease(a.glyphAlpha, wantAlpha, dt, 12) : wantAlpha;
      if (a.glyph !== a.glyphWant && a.glyphAlpha < 0.05) {
        a.glyph = a.glyphWant;
        const el = refs.current.glyph;
        if (el) { el.textContent = a.glyph === "none" ? "" : a.glyph; el.setAttribute("fill", GLYPH_TONE[def.glyphTone] || pal.accent); }
      }
      const bob = Math.sin(t * 3) * 2 * motion.sway;
      set("glyph", "opacity", a.glyphAlpha.toFixed(3));
      set("glyph", "transform", `translate(0 ${bob.toFixed(2)})`);

      // keep drawing while anything moves; when everything is settled and motion is off, sleep until something changes
      const settled = faceDistance(a.face, def.face) < 0.004 && a.glyph === a.glyphWant && Math.abs(a.glyphAlpha - (a.glyph === "none" ? 0 : 1)) < 0.01;
      if (motion.sway > 0 || motion.blink || !settled || speakingNow) {
        const interval = settled && !speakingNow && motion.sway === 0 ? 50 : 33; // about 30 frames a second
        raf = window.setTimeout(() => { raf = requestAnimationFrame(frame); }, Math.max(0, interval - (performance.now() - now))) as unknown as number;
      } else raf = 0;
    };
    const kick = () => { if (!raf && running) raf = requestAnimationFrame(frame); };
    wake.current = kick;
    kick();
    return () => { running = false; wake.current = () => {}; if (raf) { cancelAnimationFrame(raf); clearTimeout(raf); } };
  }, [pal.accent]);

  const id = (s: string) => `${uid}-${s}`;
  const s = build.shoulders;
  const outfit = appearance.outfit;
  const jacketFill = outfit === "techwear" ? "#241d38" : outfit === "casual" ? pal.accent : outfit === "formal" ? "#2b2544" : pal.jacket;
  const jacketShade = outfit === "techwear" ? "#17122a" : outfit === "casual" ? pal.glow : outfit === "formal" ? "#1b1730" : pal.jacketShade;
  const teeFill = outfit === "formal" ? pal.jacket : outfit === "casual" ? pal.jacket : pal.tee;
  const bodyPath = `M${150 - 120 * s} 340 L${150 - 114 * s} 282 C${150 - 108 * s} 254 ${150 - 70 * s} 240 ${150 - 34} 232 L${150 + 34} 232 C${150 + 70 * s} 240 ${150 + 108 * s} 254 ${150 + 114 * s} 282 L${150 + 120 * s} 340Z`;
  const eyeScale = build.eye;

  return (
    <svg className={className} viewBox={VIEWBOX[view]} xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Momo">
      <defs>
        <radialGradient id={id("halo")} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor={pal.accent} stopOpacity=".38" /><stop offset="1" stopColor={pal.accent} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id("iris")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={pal.eyeDeep} /><stop offset=".55" stopColor={pal.eye} /><stop offset="1" stopColor={pal.glow} />
        </linearGradient>
        <linearGradient id={id("skin")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={pal.skin} /><stop offset="1" stopColor={pal.skin} />
        </linearGradient>
        <filter id={id("glow")} x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <clipPath id={id("clL")}><path ref={reg("eyeClipL")} /></clipPath>
        <clipPath id={id("clR")}><path ref={reg("eyeClipR")} /></clipPath>
        <clipPath id={id("mc")}><path ref={reg("mouthClipPath")} /></clipPath>
      </defs>

      {view === "expanded" && <circle cx="150" cy="170" r="150" fill={`url(#${id("halo")})`} />}

      {/* body */}
      <g ref={reg("body")}>
        <path d={bodyPath} fill={jacketFill} />
        {outfit === "hoodie" && <path d={`M${150 - 62} 230 Q150 276 ${150 + 62} 230 L${150 + 76} 252 Q150 300 ${150 - 76} 252Z`} fill={jacketShade} />}
        <path d={`M${150 - 34} 232 Q150 268 ${150 + 34} 232 L${150 + 46} 340 L${150 - 46} 340Z`} fill={teeFill} />
        {(outfit === "hoodie" || outfit === "techwear") && (
          <text x="150" y="308" textAnchor="middle" fontFamily="Segoe UI, Arial, sans-serif" fontWeight="800" fontSize="34" fill={pal.glow} filter={`url(#${id("glow")})`}>M</text>
        )}
        {outfit === "formal" && <path d="M150 238 L140 262 L150 340 L160 262Z" fill={pal.accent} />}
        {outfit === "casual" && <path d={`M${150 - 34} 232 Q150 262 ${150 + 34} 232`} fill="none" stroke={pal.jacket} strokeWidth="8" strokeLinecap="round" />}
        {outfit === "techwear" && <>
          <path d={`M${150 - 80 * s} 270 L${150 - 60 * s} 340 M${150 + 80 * s} 270 L${150 + 60 * s} 340`} stroke={pal.trim} strokeWidth="3" fill="none" opacity=".9" />
          <path d={`M${150 - 34} 232 L${150 - 46} 340 M${150 + 34} 232 L${150 + 46} 340`} stroke={pal.trim} strokeWidth="2.5" fill="none" />
        </>}
        {outfit === "hoodie" && <path d={`M${150 - 34} 232 L${150 - 46} 340 M${150 + 34} 232 L${150 + 46} 340`} stroke={jacketShade} strokeWidth="3" fill="none" />}
        {outfit === "formal" && <path d={`M${150 - 34} 232 L${150 - 28} 340 M${150 + 34} 232 L${150 + 28} 340`} stroke={jacketShade} strokeWidth="3" fill="none" />}
        {/* neck */}
        <path d="M132 206 L132 240 Q150 258 168 240 L168 206Z" fill={pal.skin} />
        <path d="M132 214 Q150 232 168 214 L168 230 Q150 246 132 230Z" fill={pal.skinShade} opacity=".55" />
      </g>

      {/* head */}
      <g ref={reg("head")}>
        <g ref={reg("hairBack")}>
          <path d={hair.back} fill={pal.hair} />
        </g>
        {!appearance.headphones && <><ellipse cx="79" cy="162" rx="7" ry="11" fill={pal.skin} /><ellipse cx="221" cy="162" rx="7" ry="11" fill={pal.skin} /></>}
        <path d={facePath(build.jaw)} fill={`url(#${id("skin")})`} />
        <ellipse cx="150" cy="100" rx="64" ry="22" fill={pal.skinShade} opacity=".35" />
        <path d="M147 179 Q150 182 153 179" stroke={pal.skinShade} strokeWidth="2.2" fill="none" strokeLinecap="round" />
        <g ref={reg("blush")} opacity=".1" fill="#ff7fa0"><ellipse cx="102" cy="184" rx="14" ry="7" /><ellipse cx="198" cy="184" rx="14" ry="7" /></g>

        {/* eyes */}
        {(["L", "R"] as const).map((side) => {
          const g = EYES[side];
          return (
            <g key={side}>
              <path ref={reg("sclera" + side)} fill="#fbf8ff" />
              <g clipPath={`url(#${id("cl" + side)})`}>
                <g ref={reg("iris" + side)}>
                  <ellipse cx={g.cx} cy={g.cy + 2} rx={15.5 * eyeScale} ry={20 * eyeScale} fill={`url(#${id("iris")})`} />
                  <ellipse ref={reg("pupil" + side)} cx={g.cx} cy={g.cy + 1} rx="7" ry="10.5" fill="#150d2e" />
                  <circle ref={reg("hiA" + side)} cx={g.cx - 5} cy={g.cy - 7} r="4.1" fill="#fff" />
                  <circle ref={reg("hiB" + side)} cx={g.cx + 6} cy={g.cy + 7} r="2" fill="#fff" opacity=".9" />
                </g>
              </g>
              <path ref={reg("lid" + side)} fill="none" stroke={pal.line} strokeWidth={4.2 + build.lash * 0.6} strokeLinecap="round" strokeLinejoin="round" />
              <path ref={reg("lash" + side)} fill="none" stroke={pal.line} strokeWidth="2.6" strokeLinecap="round" opacity={build.lash} />
            </g>
          );
        })}

        {/* mouth */}
        <path ref={reg("mouth")} stroke="#8a3a4f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <g clipPath={`url(#${id("mc")})`}><ellipse ref={reg("tongue")} cx="150" cy="200" rx="7.5" ry="4.5" fill="#ff8aa6" opacity="0" /></g>

        {/* tear and sweat */}
        <path ref={reg("tear")} d="M92 178 q-4 8 0 12 q4 -4 0 -12z" fill="#9fdcff" opacity="0" />
        <path ref={reg("sweat")} d="M226 104 q-7 12 0 17 q7 -5 0 -17z" fill="#9fdcff" stroke="#fff" strokeOpacity=".7" strokeWidth="1" opacity="0" />

        {/* fringe, tuft, headphones */}
        <path d={hair.front} fill={pal.hair} />
        <path d={hair.shine} stroke={pal.hairHi} strokeWidth="4" strokeLinecap="round" fill="none" opacity=".75" />
        <path ref={reg("browL")} fill="none" stroke={pal.line} strokeWidth={build.browW} strokeLinecap="round" />
        <path ref={reg("browR")} fill="none" stroke={pal.line} strokeWidth={build.browW} strokeLinecap="round" />
        {hair.tuft && <g ref={reg("tuft")}><path d={hair.tuft} fill={pal.hair} /></g>}
        {appearance.headphones && (
          <g>
            <path d="M78 150 C74 60 226 60 222 150" fill="none" stroke="#2a2543" strokeWidth="9" strokeLinecap="round" />
            <path d="M78 150 C74 60 226 60 222 150" fill="none" stroke={pal.glow} strokeWidth="1.6" opacity=".7" />
            {[76, 224].map((x) => (
              <g key={x}>
                <ellipse cx={x} cy="162" rx="14" ry="23" fill="#2a2543" />
                <ellipse cx={x} cy="162" rx="8" ry="15" fill="none" stroke={pal.glow} strokeWidth="3" filter={`url(#${id("glow")})`} />
              </g>
            ))}
          </g>
        )}
        <text ref={reg("glyph")} x="238" y="84" fontFamily="Segoe UI, Arial, sans-serif" fontWeight="800" fontSize="34" fill={pal.accent} opacity="0" textAnchor="middle" filter={`url(#${id("glow")})`} />
      </g>
    </svg>
  );
}
