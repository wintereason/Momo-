// Finds the mouth (and the two lens centres) in every drawn face of both avatars, so overlays can be registered to the exact spot.
// node scripts/measure-avatar-mouths.cjs  -> prints positions as fractions of each picture
const sharp = require("sharp");
const cells = ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"];
// where to look (fractions): a window around the expected mouth, per art/view
const WIN = {
  "pink/head": [0.36, 0.72, 0.62, 0.95], "pink/full": [0.38, 0.47, 0.62, 0.58],
  "dark/head": [0.34, 0.78, 0.62, 0.99], "dark/full": [0.33, 0.50, 0.60, 0.585],
};
(async () => {
  const out = {};
  for (const art of ["dark"]) for (const view of ["head", "full"]) {
    out[`${art}/${view}`] = {};
    for (const c of cells) {
      const { data, info } = await sharp(`assets/avatars/${art}/${view}/${c}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const [x0, y0, x1, y1] = WIN[`${art}/${view}`].map((v, i) => Math.round(v * (i % 2 ? info.height : info.width)));
      let sx = 0, sy = 0, n = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * info.width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 200) continue;
        // mouth: red-dominant and dark/saturated compared with skin (interior, lips, tongue) or a dark line
        const red = r - g > 55 && r - b > 25 && r < 235;
        const darkLine = art === "dark" && r + g + b < 260 && Math.abs(r - b) < 40 && y > y0 + 2;
        if (red || darkLine) { sx += x; sy += y; n++; minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      }
      out[`${art}/${view}`][c] = n > 12 ? { cx: +(sx / n / info.width).toFixed(4), cy: +(sy / n / info.height).toFixed(4), w: +((maxx - minx) / info.width).toFixed(3), h: +((maxy - miny) / info.height).toFixed(3), px: n } : null;
    }
  }
  console.log(JSON.stringify(out, null, 1));
})();
