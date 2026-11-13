// Cuts the two 3x2 avatar expression sheets (assets/reference/avatar_sheet_*.png) into transparent sprites.
// The sheets are 3D "figurine" renders on a pale blue-grey studio set, so the set is removed by flood-filling
// from the border through pixels that are low-chroma and blue-ish (skin is peach, the pink dress is red-ish,
// dark hair and clothes are far too dark to match). Each cell becomes:
//   full/<cell>.png  the whole figure, head to feet (no display base)  -> expanded view
//   head/<cell>.png  head and shoulders                                -> compact view
// Run: node scripts/cut-avatar-sheets.mjs
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHEETS = [
  { id: "pink", file: "assets/reference/avatar_sheet_pink.png" },
  { id: "dark", file: "assets/reference/avatar_sheet_dark.png" },
];
const COLS = 3, ROWS = 2;
const HEAD_FRACTION = 0.58; // where the shoulders are, measured down the figure
const SIDE_PAD = 0.08, TOP_PAD = 0.05;

const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
const luma = (r, g, b) => (Math.max(r, g, b) + Math.min(r, g, b)) / 510;

/** Flood fill the studio set away from the edges. Returns an alpha buffer. */
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
function figureAlpha(alpha, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const queue = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!alpha[start] || label[start] >= 0) continue;
    const id = comps.length;
    let area = 0, minx = w, miny = h, maxx = -1, maxy = -1;
    label[start] = id;
    queue[0] = start;
    let qh = 0, qt = 1;
    while (qh < qt) {
      const i = queue[qh++]; area++;
      const x = i % w, y = (i / w) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && alpha[j] && label[j] < 0) { label[j] = id; queue[qt++] = j; }
      }
    }
    comps.push({ id, area, minx, miny, maxx, maxy });
  }

  const specks = comps.filter((c) => c.area < 300);          // sparkles, stray highlights
  const solid = comps.filter((c) => c.area >= 300);
  const bottom = solid.reduce((m, c) => Math.max(m, c.maxy), -1);
  const base = solid.find((c) =>
    c.maxx - c.minx + 1 >= w * 0.45 &&                    // a wide disc/plinth
    c.maxy - c.miny + 1 <= h * 0.18 &&                    // but a short band
    (c.maxy - c.miny + 1) / (c.maxx - c.minx + 1) <= 0.4 && // wider than it is tall
    c.maxy >= bottom - h * 0.02                           // sitting at the bottom of the cell
  );

  for (const c of specks) for (let i = 0; i < w * h; i++) if (label[i] === c.id) alpha[i] = 0;
  if (base) for (let i = 0; i < w * h; i++) if (label[i] === base.id) alpha[i] = 0;
  // The contact shadow sits on the base just under the shoes. The top edge of the base is the ground line, so
  // everything below it (base, print, shadow) goes. The shoes rest above that line and stay whole.
  if (base) for (let y = base.miny; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = 0;

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

for (const sheet of SHEETS) {
  const src = path.join(root, sheet.file);
  const { data: rgb, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = cutBackground(rgb, info.width, info.height);
  const outRoot = path.join(root, "assets/avatars", sheet.id);
  fs.mkdirSync(path.join(outRoot, "full"), { recursive: true });
  fs.mkdirSync(path.join(outRoot, "head"), { recursive: true });

  const cw = Math.floor(info.width / COLS), ch = Math.floor(info.height / ROWS);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const key = `r${row + 1}c${col + 1}`;
      const ox = col * cw, oy = row * ch;
      // cell-local buffers
      const cell = Buffer.alloc(cw * ch * 3), cellA = Buffer.alloc(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const s = (oy + y) * info.width + ox + x, d = y * cw + x;
          cell[d * 3] = rgb[s * 3]; cell[d * 3 + 1] = rgb[s * 3 + 1]; cell[d * 3 + 2] = rgb[s * 3 + 2];
          cellA[d] = alpha[s];
        }
      }
      const { alpha: spriteA, box } = figureAlpha(cellA, cw, ch);
      const headBox = { ...box, height: Math.max(1, Math.round(box.height * HEAD_FRACTION)) };
      await sprite(cell, spriteA, cw, box, path.join(outRoot, "full", `${key}.png`), SIDE_PAD);
      await sprite(cell, spriteA, cw, headBox, path.join(outRoot, "head", `${key}.png`), TOP_PAD);
      console.log(sheet.id, key, `${box.width}x${box.height}`, "@", box.x, box.y);
    }
  }
}

// contact sheets for a quick visual check
for (const sheet of SHEETS) {
  const tiles = [];
  for (const view of ["full", "head"]) {
    for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
      const p = path.join(root, "assets/avatars", sheet.id, view, `r${row + 1}c${col + 1}.png`);
      tiles.push({ input: await sharp(p).resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer(), left: col * 256, top: ((view === "full" ? 0 : 2) + row) * 256 });
    }
  }
  // checkerboard
  const checker = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024">${Array.from({ length: 48 }, (_, y) => Array.from({ length: 36 }, (_, x) => `<rect x="${x * 21.33}" y="${y * 21.33}" width="21.33" height="21.33" fill="${(x + y) % 2 ? "#2a2636" : "#1a1724"}"/>`).join("")).join("")}</svg>`);
  await sharp(checker).composite(tiles).png().toFile(path.join(root, "assets/avatars", `_check-${sheet.id}.png`));
}
