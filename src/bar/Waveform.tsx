/** A row of bars that follows the microphone level, like the bar in Wispr Flow. Decorative: the state is also in words. */
export const BARS = 26;

/** Turn the rolling list of levels (0..1) into bar heights between 3 and 26 px, with a calmer edge. */
export function barHeights(levels: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < BARS; i++) {
    const v = levels[levels.length - BARS + i] ?? 0;
    const edge = 0.45 + 0.55 * Math.sin((Math.PI * (i + 0.5)) / BARS); // taller in the middle
    const h = 3 + Math.min(1, Math.sqrt(Math.max(0, v)) * 1.7) * 23 * edge;
    out.push(Math.round(h));
  }
  return out;
}

export function Waveform({ levels }: { levels: number[] }) {
  return (
    <div className="wave" aria-hidden="true">
      {barHeights(levels).map((h, i) => <i key={i} style={{ height: h }} />)}
    </div>
  );
}
