import { useEffect, useId, useMemo, useRef, useState } from "react";
import "../styles/avatar.css"; // shared by the desktop bar and the Settings preview
import { AVATARS, avatarSprite, isSpriteArt, type AvatarCell, type SpriteArt, type AvatarView as View } from "./avatars";
import { DRAW, DRAW_CELLS, POSES, RIGS, type FaceDraw, type Region } from "./avatarRig";
import { DrawLayer, driveDraw } from "./drawFace";
import { blinkFactor, lidClosure, motionAmount, nextBlinkDelay } from "./animation";
import type { CharacterPrefs } from "./config";
import { ease } from "./face";
import type { ExpressionId } from "./face";
import { PERSONAS } from "./personality";
import type { MouthSync } from "./speechMouth";

/**
 * An avatar sheet character, brought to life without redrawing it (see avatarRig.ts):
 *  - faces cross-fade into each other instead of switching;
 *  - blinks: where the avatar has a drawn face (see DRAW), eyelids are drawn inside the lenses in the artwork's own skin tones and close
 *    over about 300 ms like the reference animation; otherwise the artist's closed-eye face is laid over the eyes;
 *  - speech: a small mouth is drawn in place and follows the real speech timing (MouthSync), resting on a soft smile line;
 *  - the whole figure breathes, tilts, bounces, droops or trembles according to the expression;
 *  - a small symbol tells apart states that share one drawn face.
 * It only draws what it is given; it knows nothing about tasks.
 */
/**
 * A surprise does not last. Measured on video 5: wide eyes and a small round mouth for about 1.4 s, the mouth relaxing into a smile
 * over the next ~1.3 s while he is already talking, the wide-eyed face with its sweat drops stays until about 6.8 s in the clip, then the normal face returns.
 */
/**
 * Keeps a tilted, breathing figure inside the box it is drawn in (the window crops anything outside). The figure turns about the middle of
 * its feet, so one bottom corner dips below the box: lift it by that much, and shrink it, uniformly, just enough for its tilted, breathing
 * height to fit. `k` is 1 for a level figure. The deliberate "pop" of an expression (its own scale and bounce) is applied on top of this and
 * may still rise a little above the box; that is the animation, not a fit error.
 */
export function fitFigure(w: number, h: number, W: number, H: number, rot: number, breath: number, popScale: number): { k: number; lift: number } {
  if (!(w > 0 && h > 0 && W > 0 && H > 0)) return { k: 1, lift: 0 };
  const th = (Math.abs(rot) * Math.PI) / 180;
  const needW = w * Math.cos(th) + h * breath * Math.sin(th);
  const needH = h * breath * Math.cos(th) + w * Math.sin(th); // the tilted figure's whole bounding height: its top corner rises and its bottom corner dips
  const k = Math.min(1, W / needW, H / needH);
  return { k, lift: (w * popScale * k * Math.sin(th)) / 2 };
}
export const SURPRISE_HOLD_S = 1.4, SURPRISE_RELAX_S = 1.3, SURPRISE_SETTLE_MS = 6800;
/** 1 = fully surprised .. 0 = relaxed, t seconds after the surprise began */
export function surpriseLevel(t: number): number {
  if (t <= SURPRISE_HOLD_S) return 1;
  const k = Math.min(1, (t - SURPRISE_HOLD_S) / SURPRISE_RELAX_S);
  return 1 - k * k * (3 - 2 * k);
}
const mask = (r: Region, core = 55) => (Array.isArray(r.cx) ? r.cx : [r.cx]).map((cx) => `radial-gradient(ellipse ${r.rx * 100}% ${r.ry * 100}% at ${cx * 100}% ${r.cy * 100}%, #000 ${core}%, transparent 100%)`).join(", ");
const GLYPH_COLOR = { accent: "#ffd1e1", warn: "#ffb83d", bad: "#ff5c7a", soft: "#bfe3ff" } as const;

export function AvatarView({ character, expression, view, mouth, className }: {
  character: CharacterPrefs;
  expression: ExpressionId;
  view: View;
  mouth?: MouthSync | null;
  className?: string;
}) {
  const art = isSpriteArt(character.art) ? character.art : null;
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const reg = (k: string) => (el: HTMLElement | null) => { refs.current[k] = el; };
  const svgs = useRef<Record<string, SVGElement | null>>({});
  // The figure's box must be EXACTLY the picture's box, so everything placed as a fraction of the picture lands on the right spot.
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = refs.current.rig;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setRoom({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const fit = room && nat && room.w > 0 && room.h > 0 ? (() => { const s = Math.min(room.w / nat.w, room.h / nat.h, 1); return { w: nat.w * s, h: nat.h * s }; })() : null;
  const sreg = (k: string) => (el: SVGElement | null) => { svgs.current[k] = el; };
  // the surprise settles back to normal on its own after a few seconds (see SURPRISE_*)
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (expression !== "surprised") return;
    const t = window.setTimeout(() => setSettled(true), SURPRISE_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [expression]);
  const shownEx: ExpressionId = expression === "surprised" && settled ? "calm" : expression;
  const live = useRef({ expression: shownEx, mouth, character, view });
  live.current = { expression: shownEx, mouth, character, view };

  const src = art ? avatarSprite(art, shownEx, view) : undefined;
  const [prev, setPrev] = useState<string | undefined>(undefined);
  /** while one pose fades into another, the drawn eyes and mouth of the pose that is leaving stay on it (so its own mouth never shows through) */
  const [prevDraw, setPrevDraw] = useState(-1);
  const lastDraw = useRef(-1);
  const shown = useRef<string | undefined>(src);
  useEffect(() => {
    if (shown.current === src) return;
    setPrev(shown.current);
    setPrevDraw(lastDraw.current);
    shown.current = src;
    const t = window.setTimeout(() => { setPrev(undefined); setPrevDraw(-1); }, 300);
    return () => window.clearTimeout(t);
  }, [src]);

  const rig = art ? RIGS[art] : null;
  const cellOf = (e: ExpressionId): AvatarCell | null => (art ? AVATARS[art].faces[e] : null);
  // the drawn eyes and mouth: the resting face first, then any other pose that has its own measured eyes and mouth
  const draws = useMemo<FaceDraw[]>(() => (art ? [DRAW[art]?.[view], ...Object.values(DRAW_CELLS[art] ?? {}).map((v) => v?.[view])].filter((d): d is FaceDraw => !!d) : []), [art, view]);
  const draw: FaceDraw | null = draws[0] ?? null;
  const activeDraw = draws.findIndex((d) => d.restCell === cellOf(shownEx)); // -1: this pose has its own eyes and mouth
  useEffect(() => { lastDraw.current = activeDraw; }); // after the pose effect above, so that one still sees the leaving pose
  const blinkSrc = art && rig && !draw ? sheetCell(art, view, rig.blink) : undefined; // the artist's closed-eye face (avatars without a drawn face)

  useEffect(() => {
    if (!art) return;
    const osReduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const start = performance.now();
    const st = { roll: 0, dy: 0, scale: 1, shake: 0, bounce: 0, held: 0, glyph: "", glyphA: 0, nextBlink: start + 1800, blinkAt: -1, sAt: -1, last: start, mo: 0, mr: 0, mw: 1 };
    let timer = 0, raf = 0, running = true;
    const set = (k: string, f: (el: HTMLElement) => void) => { const el = refs.current[k]; if (el) f(el); };
    const dr0 = DRAW[art]?.[view] ?? null;

    const frame = (now: number) => {
      raf = 0;
      if (!running) return;
      const { expression: ex, mouth: m, character: ch } = live.current;
      const motion = motionAmount(ch.animation, osReduced);
      const persona = PERSONAS[ch.personality];
      const pose = POSES[ex];
      const dt = Math.min(0.5, (now - st.last) / 1000); st.last = now; // a throttled (background) window still settles instead of crawling
      const t = (now - start) / 1000;
      const k = motion.ease ? 7 : 1000;
      const sway = motion.sway * persona.motion;

      st.roll = ease(st.roll, pose.roll, dt, k); st.dy = ease(st.dy, pose.dy, dt, k); st.scale = ease(st.scale, pose.scale, dt, k);
      st.shake = ease(st.shake, pose.shake, dt, k); st.bounce = ease(st.bounce, pose.bounce, dt, k); st.held = ease(st.held, pose.eyesHeld, dt, 5);

      const level = m?.speaking ? true : null; // speaking: a small nod and lean (no mouth is drawn over the artwork)
      const speakingNod = level ? 1.6 * motion.sway : 0;
      const breath = 1 + Math.sin(t * (ex === "sleepy" ? 0.9 : 1.5)) * pose.breath * sway;
      const bob = Math.abs(Math.sin(t * 3.1)) * st.bounce * sway;
      const jitter = Math.sin(t * 38) * st.shake * sway;
      const lean = Math.sin(t * 0.7) * 0.9 * sway + (level ? Math.sin(t * 2.4) * 1.1 * motion.sway : 0);
      set("fig", (el) => {
        const rot = st.roll + lean;
        // A tilted or enlarged figure must still fit the box it is drawn in (the window crops anything outside): shrink it, uniformly, only as far as needed
        const { k, lift } = fitFigure(el.offsetWidth, el.offsetHeight, refs.current.rig?.clientWidth ?? 0, refs.current.rig?.clientHeight ?? 0, rot, breath, st.scale);
        el.style.transform = `translate(${jitter.toFixed(2)}px, ${(st.dy - bob + speakingNod - lift).toFixed(2)}px) rotate(${rot.toFixed(2)}deg) scale(${(st.scale * k).toFixed(3)}, ${(st.scale * k * breath).toFixed(3)})`;
      });

      // blink: the closed-eye face over the eyes, quick, at random intervals (held shut while sleepy)
      let blink = 0, lid = 0;
      const span = dr0 ? 300 : 160; // the drawn eyelids take as long as in the reference animation
      if (motion.blink) {
        if (st.blinkAt < 0 && now >= st.nextBlink) st.blinkAt = now;
        if (st.blinkAt >= 0) {
          const el = now - st.blinkAt;
          blink = 1 - blinkFactor(el, 160);
          lid = lidClosure(el, span);
          if (el > span) { st.blinkAt = -1; st.nextBlink = now + (Math.random() < 0.15 ? 140 : nextBlinkDelay(Math.random(), persona.blinkEvery)); }
        }
      }
      const cell = cellOf(ex);
      const eyesAlready = !!(cell && rig && rig.eyesShut.includes(cell));
      const flutter = 0;
      const eyesA = eyesAlready ? 0 : Math.max(blink, st.held - flutter);
      set("blink", (el) => { el.style.opacity = eyesA.toFixed(3); });

      // drawn face (the reference technique): eyelids inside the lenses and a mouth that follows the real speech, for whichever pose is shown
      const cellNow = cellOf(ex);
      const di = draws.findIndex((d) => d.restCell === cellNow);
      if (ex === "surprised") { if (st.sAt < 0) st.sAt = now; } else st.sAt = -1;
      if (di >= 0) {
        const dr = draws[di];
        const closed = dr.noEyes ? 0 : Math.max(lid, st.held);
        const lv = m?.level(now) ?? null;
        if (!lv) { st.mo = 0; st.mr = 0; st.mw = 1; } // silence: back to the resting mouth in the same frame
        else {
          const want = Math.min(1, lv.open * 1.25);
          st.mo = ease(st.mo, want, dt, want > st.mo ? 50 : 38); st.mr = ease(st.mr, lv.round, dt, 40); st.mw = ease(st.mw, lv.wide, dt, 40);
        }
        const surprise = ex === "surprised" && st.sAt >= 0 ? surpriseLevel((now - st.sAt) / 1000) : 0;
        driveDraw((k, attr, v) => svgs.current[di + ":" + k]?.setAttribute(attr, String(v)), dr, { closed, open: st.mo, round: st.mr, wide: st.mw, speaking: !!lv, surprise });
      }

      // the symbol: fades out, swaps, fades in
      const wantG = (art && AVATARS[art].glyphs?.[ex]) ?? pose.glyph;
      if (st.glyph !== wantG) { st.glyphA = ease(st.glyphA, 0, dt, 14); if (st.glyphA < 0.05) { st.glyph = wantG; set("glyph", (el) => { el.textContent = wantG; el.style.color = GLYPH_COLOR[pose.tone]; }); } }
      else st.glyphA = ease(st.glyphA, wantG ? 1 : 0, dt, 12);
      set("glyph", (el) => { el.style.opacity = st.glyphA.toFixed(3); el.style.transform = `translateY(${(Math.sin(t * 3) * 2 * sway).toFixed(2)}px)`; });

      timer = window.setTimeout(() => { raf = requestAnimationFrame(frame); }, 28);
    };
    raf = requestAnimationFrame(frame);
    return () => { running = false; window.clearTimeout(timer); if (raf) cancelAnimationFrame(raf); };
  }, [art, view]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!art || !src || !rig) return null;
  // held shut (sleepy) the eyelid must hide the whole open eye, so its area is a little larger and its core fully opaque
  const layer = (key: string, url: string | undefined, region: Region, extra?: string, held = false) => url && (
    <img key={key} ref={reg(key)} src={url} className={`avatar-layer ${extra ?? ""}`} style={{ opacity: 0, WebkitMaskImage: held ? mask({ ...region, rx: region.rx * 1.3, ry: region.ry * 1.35 }, 78) : mask(region), maskImage: held ? mask({ ...region, rx: region.rx * 1.3, ry: region.ry * 1.35 }, 78) : mask(region) }} alt="" aria-hidden="true" draggable={false} />
  );
  return (
    <div ref={reg("rig")} className={`avatar-rig${className ? " " + className : ""}`} data-view={view} aria-hidden="true">
      <div ref={reg("fig")} className="avatar-fig" style={fit ? { width: fit.w, height: fit.h } : undefined}>
        <img key={src} src={src} className="avatar-base" style={fit ? { width: "100%", height: "100%", maxWidth: "none", maxHeight: "none" } : undefined} alt="" draggable={false} data-expression={expression} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        {prev && <img src={prev} className="avatar-layer avatar-prev" alt="" draggable={false} />}
        {draws.map((d, i) => <DrawLayer key={i} draw={d} uid={uid + i} sreg={(k) => sreg(i + ":" + k)} active={i === activeDraw || i === prevDraw} />)}
        {view === "compact" || view === "expanded" ? (
          <>
            {layer("blink", blinkSrc, rig.areas[view].eyes, undefined, expression === "sleepy")}
          </>
        ) : null}
      </div>
      <span ref={reg("glyph")} className="avatar-glyph" />
    </div>
  );
}

/** the sprite of a specific drawn face (not an expression) */
function sheetCell(art: SpriteArt, view: View, cell: AvatarCell): string | undefined {
  const e = (Object.keys(AVATARS[art].faces) as ExpressionId[]).find((x) => AVATARS[art].faces[x] === cell);
  return e ? avatarSprite(art, e, view) : undefined;
}
