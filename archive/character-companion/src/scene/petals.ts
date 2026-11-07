/** Falling cherry petals. Pure, deterministic physics (seeded), so it is testable and never allocates per frame. */
export interface Bounds { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number }

export interface Petal {
  x: number; y: number; z: number;
  rot: number; spin: number;
  phase: number; sway: number;
  fall: number; size: number;
}

/** mulberry32: tiny seeded RNG */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createPetals(count: number, b: Bounds, seed = 7): Petal[] {
  const r = rng(seed);
  return Array.from({ length: count }, () => ({
    x: b.xMin + r() * (b.xMax - b.xMin),
    y: b.yMin + r() * (b.yMax - b.yMin),
    z: b.zMin + r() * (b.zMax - b.zMin),
    rot: r() * Math.PI * 2,
    spin: (r() - 0.5) * 2.2,
    phase: r() * Math.PI * 2,
    sway: 0.12 + r() * 0.22,
    fall: 0.10 + r() * 0.16,
    size: 0.05 + r() * 0.05,
  }));
}

/** Advance every petal by dt seconds. Petals that fall out of the bottom re-enter at the top. */
export function stepPetals(petals: Petal[], dt: number, t: number, b: Bounds, reduceMotion = false): void {
  const k = reduceMotion ? 0.25 : 1;
  const step = Math.min(dt, 0.1) * k; // a long pause (tab hidden) must not make petals jump
  for (const p of petals) {
    p.y -= p.fall * step;
    p.x += Math.sin(t * 0.9 + p.phase) * p.sway * step;
    p.rot += p.spin * step;
    if (p.y < b.yMin) {
      p.y = b.yMax;
      p.x = b.xMin + ((p.phase * 977) % 1) * (b.xMax - b.xMin);
    }
    if (p.x < b.xMin) p.x = b.xMax;
    else if (p.x > b.xMax) p.x = b.xMin;
  }
}
