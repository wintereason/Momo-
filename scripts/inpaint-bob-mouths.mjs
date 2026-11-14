// Removes the girl's own mouth from every pose sprite, so Momo can draw one mouth (closed or speaking) without a skin patch over it.
// The mouth area is filled smoothly from the skin around it (diffusion fill). Glasses frames and hair next to the mouth are left alone:
// dark pixels that belong to a big dark shape (the frames, the hair) are fixed, only small dark bits (a mouth's inside, its corner ticks) are filled.
// Run last: node scripts/cut-video-avatar.mjs && node scripts/cut-video-register.mjs && node scripts/inpaint-bob-mouths.mjs
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// the drawn mouth's centre in the resting sprite, per view, and each pose's own mouth: dy from the resting centre, half-size of the area to clear
const REST = { head: { cx: 228, cy: 268, k: 1 }, full: { cx: 170, cy: 194, k: 0.7 } };
const POSES = { r1c1: { dy: 0, rx: 60, ry: 20 }, r1c2: { dy: 12, rx: 62, ry: 26 }, r1c3: { dy: 0, rx: 60, ry: 22 }, r2c1: { dy: 3, rx: 60, ry: 22 }, r2c2: { dy: -6, rx: 60, ry: 22 }, r2c3: { dy: 0, rx: 60, ry: 22 }, g1: { dy: -5, rx: 60, ry: 22 } };
const lum = (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 3;

for (const view of ["head", "full"]) {
  for (const [cell, P] of Object.entries(POSES)) {
    const file = path.join(root, "assets/avatars/bob", view, cell + ".png");
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height, R = REST[view];
    const cx = R.cx, cy = R.cy + P.dy * R.k, rx = P.rx * R.k, ry = P.ry * R.k;
    // big dark shapes (glasses, hair): 8-connected components of dark pixels larger than 600 px at the compact size
    const dark = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) dark[i] = data[i * 4 + 3] > 200 && lum(data, i * 4) < 105 ? 1 : 0;
    const comp = new Int32Array(w * h).fill(-1), sizes = []; const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (!dark[s] || comp[s] >= 0) continue; const id = sizes.length; let n = 0; stack.push(s); comp[s] = id;
      while (stack.length) { const i = stack.pop(); n++; const x = i % w, y = (i / w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const j = yy * w + xx; if (dark[j] && comp[j] < 0) { comp[j] = id; stack.push(j); } } }
      sizes.push(n);
    }
    // a dark shape is "big" (glasses frame, hair) if it reaches well outside the mouth area; a mouth's own dark inside does not
    const reaches = new Uint8Array(sizes.length);
    for (let i = 0; i < w * h; i++) { if (comp[i] < 0) continue; const x = i % w, y = (i / w) | 0; if (((x - cx) / (rx * 1.4)) ** 2 + ((y - cy) / (ry * 1.4)) ** 2 > 1) reaches[comp[i]] = 1; }
    const big = (i) => comp[i] >= 0 && reaches[comp[i]] === 1;
    const fill = new Uint8Array(w * h); const idx = [];
    for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(h, Math.ceil(cy + ry)); y++) for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(w, Math.ceil(cx + rx)); x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
      const i = y * w + x; if (data[i * 4 + 3] < 200 || big(i)) continue;
      fill[i] = 1; idx.push(i);
    }
    // diffusion fill: start from the mean of the surrounding skin, then relax every filled pixel toward the average of its neighbours
    const ch = [0, 1, 2]; const vals = ch.map(() => new Float32Array(w * h));
    for (let i = 0; i < w * h; i++) for (const c of ch) vals[c][i] = data[i * 4 + c];
    let sum = [0, 0, 0], n = 0;
    for (const i of idx) { const x = i % w, y = (i / w) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const j = (y + dy) * w + (x + dx); if (!fill[j] && data[j * 4 + 3] > 200 && !big(j)) { for (const c of ch) sum[c] += data[j * 4 + c]; n++; } } }
    for (const i of idx) for (const c of ch) vals[c][i] = sum[c] / Math.max(1, n);
    for (let it = 0; it < 1800; it++) for (const i of idx) { const x = i % w, y = (i / w) | 0; for (const c of ch) vals[c][i] = (vals[c][i - 1] + vals[c][i + 1] + vals[c][i - w] + vals[c][i + w]) / 4; }
    for (const i of idx) for (const c of ch) data[i * 4 + c] = Math.round(vals[c][i]);
    await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toFile(file);
    console.log(view, cell, "cleared", idx.length, "px");
  }
}
