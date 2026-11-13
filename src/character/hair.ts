import type { Hairstyle } from "./config";

/** Hair as SVG path data in the head's own space (head centred on x=150, crown at y=62, chin at y=222). */
export interface HairShape {
  /** behind the head (and neck) */
  back: string;
  /** the fringe over the forehead */
  front: string;
  /** lighter strands on the fringe */
  shine: string;
  /** a loose tuft that sways on its own (the "ahoge"), or empty */
  tuft: string;
  /** y the headphone band should sit at */
}

/** A fringe: the top contour, then scalloped bangs (tips listed right to left as [x, y, how high the scallop rises]) and side locks. */
function fringe(lock: number, tips: [number, number, number][]): string {
  let d = `M72 150 C66 96 98 56 150 56 C202 56 234 96 228 150 L226 ${lock} C222 ${lock - 26} 216 140 ${tips[0][0]} ${tips[0][1]}`;
  for (let i = 1; i < tips.length; i++) d += ` Q${(tips[i - 1][0] + tips[i][0]) / 2} ${tips[i][2]} ${tips[i][0]} ${tips[i][1]}`;
  const last = tips[tips.length - 1];
  return d + ` C${last[0] - 10} ${last[1] + 14} 80 ${lock - 26} 74 ${lock} L72 150Z`;
}

export const HAIR: Record<Hairstyle, HairShape> = {
  messy: {
    back: "M72 150 C60 90 96 44 150 44 C204 44 240 90 228 150 C226 120 214 96 196 84 L104 84 C86 96 74 120 72 150Z",
    front: fringe(178, [[208, 113, 0], [190, 125, 93], [170, 109, 89], [150, 123, 87], [130, 107, 87], [110, 123, 91], [92, 111, 93]]),
    shine: "M110 78 C124 66 146 62 160 66 M168 74 C184 76 198 84 204 94",
    tuft: "M146 62 C142 40 160 28 172 34 C160 38 156 48 156 62Z",
  },
  short: {
    back: "M76 150 C66 94 100 50 150 50 C200 50 234 94 224 150 C222 118 208 92 150 90 C92 92 78 118 76 150Z",
    front: fringe(152, [[206, 101, 0], [182, 111, 85], [160, 99, 81], [138, 109, 81], [116, 97, 81], [94, 109, 85]]),
    shine: "M112 76 C128 66 150 64 166 68",
    tuft: "",
  },
  long: {
    back: "M70 150 C58 90 96 44 150 44 C204 44 242 90 230 150 L236 262 C220 280 196 270 190 250 L110 250 C104 270 80 280 64 262Z",
    front: fringe(214, [[210, 119, 0], [186, 117, 89], [164, 101, 83], [144, 89, 77], [126, 105, 79], [104, 119, 87], [88, 113, 89]]),
    shine: "M108 80 C124 66 148 62 168 68",
    tuft: "",
  },
  bob: {
    back: "M68 150 C58 90 96 44 150 44 C204 44 242 90 232 150 L236 214 C226 232 206 230 198 218 L102 218 C94 230 74 232 64 214Z",
    front: fringe(196, [[208, 109, 0], [184, 117, 89], [160, 107, 85], [136, 109, 83], [112, 115, 87], [90, 109, 89]]),
    shine: "M110 80 C126 66 150 62 170 68",
    tuft: "",
  },
  ponytail: {
    back: "M74 150 C62 92 98 46 150 46 C202 46 238 92 226 150 C224 120 210 94 150 92 C94 94 76 120 74 150Z M214 96 C262 92 272 170 244 232 C250 176 236 140 208 122Z",
    front: fringe(160, [[206, 107, 0], [184, 117, 87], [162, 103, 83], [140, 115, 83], [118, 101, 81], [94, 111, 87]]),
    shine: "M112 76 C128 66 150 62 168 68",
    tuft: "",
  },
};
