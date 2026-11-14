// Cuts the "bob" avatar (black bob, glasses, cream dress) out of six frames of the supplied reference video
// (assets/reference/video/bob_<cell>.jpg, 1920x1080 stills of one 3D character on the same pale studio set). Same cut as the
// sheets: the set is flood-filled away, the display base dropped, then a full figure and a head-and-shoulders crop are written.
// Every cell's figure is scaled to the same height, so the faces cross-fade without the figure jumping.
// Run: node scripts/cut-video-avatar.mjs
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CELLS = ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"];
const HEAD_FRACTION = 0.6; // where the shoulders are, measured down the figure
const SIDE_PAD = 0.08, TOP_PAD = 0.05;

const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
const luma = (r, g, b) => (Math.max(r, g, b) + Math.min(r, g, b)) / 510;

/** Flood fill the studio set away from the edges. Returns an alpha buffer. */
/** keep bg regions only where they are wider than 2r+1 px: thin gaps are glossy hair highlights, not set */
function openBackground(alpha, w, h, r) {
  const bg = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) bg[i] = alpha[i] ? 0 : 1;
  const pass = (src, dst, horizontal, op) => { // op: 0 = erode (min), 1 = dilate (max)
    const n = horizontal ? w : h, m = horizontal ? h : w;
    for (let a = 0; a < m; a++) for (let b = 0; b < n; b++) {
      let v = op === 0 ? 1 : 0;
      for (let k = -r; k <= r; k++) { const bb = b + k; const x = horizontal ? bb : a, y = horizontal ? a : bb; const val = bb < 0 || bb >= n ? (op === 0 ? 1 : 0) : src[y * w + x]; if (op === 0 ? !val : val) { v = op === 0 ? 0 : 1; break; } }
      dst[(horizontal ? a * w + b : b * w + a)] = v;
    }
  };
  const t1 = new Uint8Array(w * h), t2 = new Uint8Array(w * h);
  pass(bg, t1, true, 0); pass(t1, t2, false, 0); pass(t2, t1, true, 1); pass(t1, t2, false, 1);
  for (let i = 0; i < w * h; i++) alpha[i] = t2[i] ? 0 : 255;
  return alpha;
}
function cutBackground(data, w, h) {
  const alpha = Buffer.alloc(w * h, 255);
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qh = 0, qt = 0;
  const isBg = (i) => {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const l = luma(r, g, b), c = chroma(r, g, b);
    // Pale studio walls and the soft grey/white blocks: light, blue-ish, almost no colour. The blue cast matters:
    // the figures' white tights and highlights are neutral (b ~= r), so they are not mistaken for the set.
    return l >= 0.40 && c <= 58 && b - r >= 10;
  };
  const push = (i) => { if (!seen[i] && isBg(i)) { seen[i] = 1; queue[qt++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++];
    alpha[i] = 0;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return alpha;
}

/**
 * The sheet draws the figure as a few opaque islands: the body, sometimes the legs/shoes as separate pieces, plus
 * the round display base and its "AVATAR 3D" print, a few sparkles and light props. Label the islands and keep the
 * figure: drop the specks, and drop the base, which is the one wide, flat, bottom-most island (the legs are narrow
 * and tall, so they survive). Returns the cleaned alpha and the figure box.
 */
function figureAlpha(alpha, w, h, rgb) {
  // The set here is a video frame, so the cube, the round plinth and the sparkles are separate islands of the cut-out:
  // the figure is the biggest one. Smaller islands are kept only if they are dark (the shoes, when the legs are cut off by the
  // flood fill) and sit right under it; everything else (the cube, the plinth print, sparkles) goes.
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const queue = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!alpha[start] || label[start] >= 0) continue;
    const id = comps.length;
    let area = 0, minx = w, miny = h, maxx = -1, maxy = -1;
    label[start] = id; queue[0] = start;
    let qh = 0, qt = 1;
    while (qh < qt) {
      const i = queue[qh++]; area++;
      const x = i % w, y = (i / w) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && alpha[j] && label[j] < 0) { label[j] = id; queue[qt++] = j; }
    }
    comps.push({ id, area, minx, miny, maxx, maxy });
  }
  const main = comps.reduce((m, c) => (c.area > m.area ? c : m), comps[0]);
  const keep = new Set([main.id]);
  for (const c of comps) {
    if (c.id === main.id || c.area < 300) continue;
    const overlap = Math.min(c.maxx, main.maxx) - Math.max(c.minx, main.minx);
    if (overlap > (c.maxx - c.minx) * 0.8 && c.miny > main.miny + (main.maxy - main.miny) * 0.7 && c.maxy <= main.maxy + (main.maxy - main.miny) * 0.12) {
      let r = 0, n = 0; // a shoe cut off from the legs is dark brown; the plinth's lit rim and print are not
      for (let y = c.miny; y <= c.maxy; y++) for (let x = c.minx; x <= c.maxx; x++) { const i = y * w + x; if (label[i] === c.id) { r += rgb[i * 3]; n++; } }
      if (n && r / n < 125) keep.add(c.id);
    }
  }
  for (let i = 0; i < w * h; i++) if (alpha[i] && !keep.has(label[i])) alpha[i] = 0;
  // the plinth's lit rim and its print stay attached under the shoes: cut at the lowest shoe-coloured (dark brown) row
  const dark = (i) => { const r = rgb[i * 3], g = rgb[i * 3 + 1], bl = rgb[i * 3 + 2]; return r < 120 && g < 95 && bl < 92 && r - bl >= 6; };
  const rowHits = (y) => { let n = 0; for (let x = 0; x < w; x++) { const i = y * w + x; if (alpha[i] && dark(i)) n++; } return n; };
  let sole = -1;
  for (let y = Math.floor(h * 0.6); y < h; y++) if (rowHits(y) >= 6) sole = y;
  let shoeTop = sole;
  while (shoeTop > 0 && sole - shoeTop < 90 && rowHits(shoeTop - 1) >= 2) shoeTop--;
  let sx0 = w, sx1 = -1;
  for (let y = shoeTop; y <= sole; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (alpha[i] && dark(i)) { if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; } }
  if (sole > 0) {
    for (let y = sole + 3; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = 0;
    // from the shoes' top down: nothing outside the shoes' own width (the plinth's rim), and no bits of the set showing between the legs
    for (let y = Math.max(0, shoeTop - 6); y <= sole + 3; y++) for (let x = 0; x < w; x++) if (x < sx0 - 10 || x > sx1 + 10) alpha[y * w + x] = 0;
    for (let y = Math.max(0, shoeTop - Math.round((sole - shoeTop) * 2.2)); y <= sole + 3; y++) for (let x = sx0 - 10; x <= sx1 + 10; x++) {
      const i = y * w + x; if (!alpha[i]) continue;
      const r = rgb[i * 3], g = rgb[i * 3 + 1], bl = rgb[i * 3 + 2], mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      if ((mx + mn) / 510 >= 0.4 && mx - mn <= 58 && bl - r >= 10) alpha[i] = 0;
    }
  }
  return { alpha, box: figureBox(alpha, w, h) };
}

/** Bounding box of the opaque figure inside a cell, ignoring stray specks (<0.4% of a row/column). */
function figureBox(alpha, w, h) {
  const colHit = new Uint32Array(w), rowHit = new Uint32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x]) { colHit[x]++; rowHit[y]++; }
  const keep = (hits, n) => {
    let first = -1, last = -1;
    for (let i = 0; i < hits.length; i++) if (hits[i] > n * 0.004) { if (first < 0) first = i; last = i; }
    return [Math.max(0, first), Math.min(hits.length - 1, last)];
  };
  const [x0, x1] = keep(colHit, h);
  const [y0, y1] = keep(rowHit, w);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Crop a region plus a little air, then fit it onto a transparent 512 square. */
async function sprite(rgb, alpha, w, box, out, pad) {
  const left = Math.max(0, box.x - Math.round(box.width * pad));
  const top = Math.max(0, box.y - Math.round(box.height * pad));
  const width = Math.min(w - left, Math.round(box.width * (1 + 2 * pad)));
  const height = Math.min(alpha.length / w - top, Math.round(box.height * (1 + 2 * pad)));
  const crop = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (top + y) * w + (left + x), dst = (y * width + x) * 4;
      crop[dst] = rgb[src * 3]; crop[dst + 1] = rgb[src * 3 + 1]; crop[dst + 2] = rgb[src * 3 + 2];
      crop[dst + 3] = alpha[src];
    }
  }
  await sharp(crop, { raw: { width, height, channels: 4 } })
    .resize(492, 492, { fit: "inside", kernel: "lanczos3" })
    .extend({ top: 10, bottom: 10, left: 10, right: 10, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
}


/** a reference still -> { rgba, w, h } with the studio set removed and only the figure kept */
export async function cutFigure(file) {
  const { data: rgb, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = openBackground(cutBackground(rgb, info.width, info.height), info.width, info.height, 4);
  const { alpha: a2 } = figureAlpha(alpha, info.width, info.height, rgb);
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = a2[i]; }
  return { rgba, w: info.width, h: info.height };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
async function main() {
const outRoot = path.join(root, "assets/avatars/bob");
fs.mkdirSync(path.join(outRoot, "full"), { recursive: true });
fs.mkdirSync(path.join(outRoot, "head"), { recursive: true });
for (const key of CELLS) {
  const { data: rgb, info } = await sharp(path.join(root, "assets/reference/video", "bob_" + key + ".jpg")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = openBackground(cutBackground(rgb, info.width, info.height), info.width, info.height, 4);
  const { alpha: spriteA, box } = figureAlpha(alpha, info.width, info.height, rgb);
  const headBox = { ...box, height: Math.max(1, Math.round(box.height * HEAD_FRACTION)) };
  await sprite(rgb, spriteA, info.width, box, path.join(outRoot, "full", key + ".png"), SIDE_PAD);
  await sprite(rgb, spriteA, info.width, headBox, path.join(outRoot, "head", key + ".png"), TOP_PAD);
  console.log("bob", key, box.width + "x" + box.height, "@", box.x, box.y);
}
const tiles = [];
for (const view of ["full", "head"]) for (let i = 0; i < 6; i++) tiles.push({ input: await sharp(path.join(outRoot, view, CELLS[i] + ".png")).resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer(), left: (i % 3) * 256, top: ((view === "full" ? 0 : 2) + Math.floor(i / 3)) * 256 });
const checker = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024">' + Array.from({ length: 48 }, (_, y) => Array.from({ length: 36 }, (_, x) => '<rect x="' + x * 21.33 + '" y="' + y * 21.33 + '" width="21.33" height="21.33" fill="' + ((x + y) % 2 ? "#2a2636" : "#1a1724") + '"/>').join("")).join("") + "</svg>");
await sharp(checker).composite(tiles).png().toFile(path.join(root, "assets/avatars/_check-bob.png"));
}
