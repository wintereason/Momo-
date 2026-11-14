import type { FaceDraw } from "./avatarRig";

/**
 * The drawn part of an avatar's face (the reference animation's technique): eyelids that close inside the lenses and a mouth drawn in
 * place, both in the artwork's own skin tones. `DrawLayer` is the SVG; `driveDraw` moves it every frame. A character with a
 * `mouthStyle` gets a smile-shaped opening with a row of teeth and a tongue (measured on its speaking frames); the others keep the
 * small oval mouth of the original rig.
 */
export function DrawLayer({ draw, uid, sreg, active }: { draw: FaceDraw; uid: string; sreg: (k: string) => (el: SVGElement | null) => void; active: boolean }) {
  const st = draw.mouthStyle;
  return (
    <svg className="avatar-draw" data-cell={draw.restCell} viewBox={`0 0 ${draw.w} ${draw.h}`} preserveAspectRatio="none" aria-hidden="true" style={{ opacity: active ? 1 : 0 }}>
      <defs>
        <radialGradient id={`${uid}pt`}><stop offset="0" stopColor={draw.skinBottom} stopOpacity="1" /><stop offset={draw.patch?.solid ?? 0.6} stopColor={draw.skinBottom} stopOpacity=".97" /><stop offset="1" stopColor={draw.skinBottom} stopOpacity="0" /></radialGradient>
        <radialGradient id={`${uid}fd`}><stop offset="0" stopColor="#fff" /><stop offset=".74" stopColor="#fff" /><stop offset="1" stopColor="#000" /></radialGradient>
        {st && <linearGradient id={`${uid}in`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={st.shadow} /><stop offset="1" stopColor={st.inner} /></linearGradient>}
        {draw.clip && <clipPath id={`${uid}cl`}><polygon points={draw.clip.map((p) => p.join(",")).join(" ")} /></clipPath>}
        {st && <clipPath id={`${uid}mc`}><path ref={sreg("mclip")} d="M0 0" /></clipPath>}
        {draw.eyes.map((e, i) => (
          <g key={i}>
            <linearGradient id={`${uid}lg${i}`} gradientUnits="userSpaceOnUse" x1="0" y1={e.cy - e.ry} x2="0" y2={e.cy + e.ry}><stop offset="0" stopColor={e.top} /><stop offset="1" stopColor={e.bottom} /></linearGradient>
            <mask id={`${uid}m${i}`} maskUnits="userSpaceOnUse" x={e.cx - e.rx - 6} y={e.cy - e.ry - 6} width={e.rx * 2 + 12} height={e.ry * 2 + 12}><ellipse cx={e.cx} cy={e.cy} rx={e.rx + 3} ry={e.ry + 3} fill={`url(#${uid}fd)`} /></mask>
          </g>
        ))}
      </defs>
      {draw.eyes.map((e, i) => (
        <g key={i} mask={`url(#${uid}m${i})`}>
          <path ref={sreg("lid" + i)} d="M0 0" fill={`url(#${uid}lg${i})`} />
          <path data-part="lash" ref={sreg("lash" + i)} d="M0 0" fill="none" stroke="#2b2125" strokeWidth={Math.max(1.4, e.ry * 0.14)} strokeLinecap="round" opacity="0" />
        </g>
      ))}
      {/* skin over the pose's own mouth (a smile, or a small round "o"), so the drawn mouth is the only one */}
      <g clipPath={draw.clip ? `url(#${uid}cl)` : undefined}>
      <ellipse data-part="mpatch" ref={sreg("mpatch")} cx={draw.mouth.cx} cy={draw.mouth.cy} rx={draw.patch?.rx ?? draw.mouth.w * 0.85} ry={draw.patch?.ry ?? draw.mouth.w * 0.36} fill={`url(#${uid}pt)`} />
      {st?.lipLight ? <path data-part="mlight" ref={sreg("mlight")} d="M0 0" fill="none" stroke="#fff" strokeLinecap="round" opacity="0" /> : null}
      <path data-part="mline" ref={sreg("mline")} d="M0 0" fill="none" stroke={st ? st.lip : "#6e464a"} strokeOpacity={1} strokeWidth={Math.max(1.1, draw.mouth.w * (st?.restW ?? 1) * (st ? st.lineW ?? 0.028 : 0.09))} strokeLinecap="round" />
      <path data-part="mopen" ref={sreg("mopen")} d="M0 0" fill={st ? `url(#${uid}in)` : "#3b2025"} opacity="0" />
      <g clipPath={st ? `url(#${uid}mc)` : undefined}>
        <path ref={sreg("mteeth")} d="M0 0" fill={st ? st.teethColor : "#f0e6e2"} opacity="0" />
        <ellipse ref={sreg("mtongue")} cx={draw.mouth.cx} cy={draw.mouth.cy} rx="0" ry="0" fill={st ? st.tongue : "#c4707a"} opacity="0" />
      </g>
      {st && <path data-part="mrim" ref={sreg("mrim")} d="M0 0" fill="none" stroke={st.lip} strokeWidth={Math.max(0.8, draw.mouth.w * 0.022)} strokeLinejoin="round" opacity="0" />}
      </g>
    </svg>
  );
}

export interface DriveInput {
  /** 0 open .. 1 shut, for the eyelids */
  closed: number;
  /** the mouth, smoothed by the caller: how open (0..1), how round (0..1), how wide (0..1); speaking = real speech is playing */
  open: number; round: number; wide: number; speaking: boolean;
  /** 1 = fully surprised .. 0 (only meaningful for a pose with its own "o" mouth) */
  surprise: number;
}

export function driveDraw(sv: (name: string, attr: string, v: string | number) => void, dr: FaceDraw, x: DriveInput): void {
  if (!dr.noEyes) {
    dr.eyes.forEach((e, i) => {
      const top = e.cy - e.ry - 6, edge = e.cy - e.ry - 3 + x.closed * (e.ry * 2 + 4), sag = e.ry * 0.3 * Math.min(1, x.closed * 3);
      sv("lid" + i, "d", `M${e.cx - e.rx - 5} ${top} L${e.cx + e.rx + 5} ${top} L${e.cx + e.rx + 5} ${edge} Q${e.cx} ${edge + 2 * sag} ${e.cx - e.rx - 5} ${edge}Z`);
      sv("lash" + i, "d", `M${e.cx - e.rx - 2} ${edge} Q${e.cx} ${edge + 2 * sag} ${e.cx + e.rx + 2} ${edge}`);
      sv("lash" + i, "opacity", Math.min(1, x.closed * 3).toFixed(2));
    });
  }
  const { cx, cy, w } = dr.mouth;
  const isOpen = x.open > 0.06;
  // a pose with its own round mouth: while the surprise lasts and nobody is speaking, that mouth is left alone (no skin patch, no drawn mouth)
  const ownMouth = dr.native && !x.speaking ? Math.min(1, Math.max(0, (x.surprise - 0.2) / 0.55)) : 0;
  sv("mpatch", "opacity", dr.noPatch ? 0 : (1 - ownMouth).toFixed(3));
  const st = dr.mouthStyle;
  if (!st) {
    const hw = (w / 2) * (0.7 + 0.35 * x.wide + 0.25 * x.open) * (1 - 0.3 * x.round), h = w * 0.62 * x.open;
    sv("mline", "d", `M${cx - hw} ${cy} Q${cx} ${cy + w * 0.16} ${cx + hw} ${cy}`);
    sv("mline", "opacity", isOpen || ownMouth > 0.5 ? 0 : 1 - ownMouth);
    sv("mopen", "d", `M${cx - hw} ${cy} Q${cx} ${cy - h * 0.25} ${cx + hw} ${cy} Q${cx} ${cy + h * 1.2} ${cx - hw} ${cy}Z`);
    sv("mopen", "opacity", isOpen ? 1 : 0);
    sv("mteeth", "d", `M${cx - hw * 0.72} ${cy + 0.4} Q${cx} ${cy - h * 0.2 + 0.4} ${cx + hw * 0.72} ${cy + 0.4} L${cx + hw * 0.6} ${cy + h * 0.3} Q${cx} ${cy + h * 0.24} ${cx - hw * 0.6} ${cy + h * 0.3}Z`);
    sv("mteeth", "opacity", Math.min(1, Math.max(0, (x.open - 0.2) * 3)).toFixed(2));
    sv("mtongue", "cy", cy + h * 0.66); sv("mtongue", "rx", hw * 0.5); sv("mtongue", "ry", Math.max(0.01, h * 0.2));
    sv("mtongue", "opacity", Math.min(1, Math.max(0, (x.open - 0.45) * 4)).toFixed(2));
    return;
  }
  // smile-shaped opening. Resting: a smile line with the corners lifted. Parted: the upper teeth show along the top lip.
  // Wider: the corners rise, the lower lip drops and the tongue shows. Rounder: narrower and taller.
  const o = x.open;
  const rw = w * (st.restW ?? 1);
  const grow = (st.restW ?? 1) + (1 - (st.restW ?? 1)) * Math.min(1, o * 1.8); // the smile line is narrow; the open mouth grows to the full width
  const hw = (w / 2) * grow * (0.94 + 0.1 * x.wide + 0.08 * o) * (1 - 0.2 * x.round);
  const corner = cy - w * st.lift * o - w * 0.02;
  const sag = w * st.sag, h = w * st.tall * o;
  const topMid = corner + sag, botMid = topMid + h;
  const hw0 = (rw / 2) * (0.94 + 0.1 * x.wide);
  sv("mline", "d", `M${cx - hw0} ${corner} Q${cx} ${corner + rw * 0.2} ${cx + hw0} ${corner}`);
  sv("mline", "opacity", isOpen || ownMouth > 0.5 ? 0 : 1 - ownMouth);
  if (st.lipLight) { // a pale lower lip under the closed smile
    const y0 = corner + rw * 0.012;
    sv("mlight", "d", `M${cx - hw0 * 0.8} ${y0} Q${cx} ${corner + rw * 0.3} ${cx + hw0 * 0.8} ${y0}`);
    sv("mlight", "stroke-width", Math.max(1, rw * 0.035));
    sv("mlight", "opacity", isOpen ? 0 : st.lipLight);
  }
  const mouth = `M${cx - hw} ${corner} Q${cx} ${corner + 2 * sag} ${cx + hw} ${corner} Q${cx} ${2 * botMid - corner} ${cx - hw} ${corner}Z`;
  sv("mopen", "d", mouth);
  sv("mclip", "d", mouth);
  sv("mopen", "opacity", isOpen ? 1 : 0);
  // teeth: a band under the top lip, as tall as `teeth` of the opening (a little more when barely open, so a thin gap still shows teeth)
  const t = Math.max(h * st.teeth, Math.min(h * 0.9, w * 0.045));
  sv("mteeth", "d", `M${cx - hw} ${corner} Q${cx} ${corner + 2 * sag} ${cx + hw} ${corner} L${cx + hw} ${corner + t} Q${cx} ${corner + 2 * sag + t} ${cx - hw} ${corner + t}Z`);
  sv("mteeth", "opacity", isOpen ? 1 : 0);
  sv("mtongue", "cx", cx); sv("mtongue", "cy", botMid - h * 0.2); sv("mtongue", "rx", hw * 0.52); sv("mtongue", "ry", Math.max(0.01, h * 0.24));
  sv("mtongue", "opacity", Math.min(1, Math.max(0, (o - 0.3) * 3.5)).toFixed(2));
  sv("mrim", "d", mouth);
  sv("mrim", "opacity", isOpen ? 0.55 : 0);
}
