// Restores the top of the girl's head (and the hair chunks on her right) in every sprite, using REAL pixels of her from another video.
// In the clip her sprites were cut from, the camera is so close that the top of her head is out of the picture (a flat cut). In the other clip
// (video 2, assets/reference/video/bob_head_room.jpg) she stands further back and her whole head is in view, round crown included.
// That frame is laid over the sprite, registered by her glasses (rotation, scale and shift from the two lens centres), and only the missing
// hair is taken from it: the crown above the cut, and gaps inside the hair outline on the upper part of the head.
// Run once, on freshly cut sprites:  node scripts/cut-video-avatar.mjs && node scripts/cut-video-register.mjs && node scripts/inpaint-bob-mouths.mjs && node scripts/restore-bob-head.mjs
// The sprites grow a transparent margin on top (BOB_PAD in src/character/avatarRig.ts must match PAD below).
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CELLS = ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3", "g1"];
const PAD = { head: 40, full: 30 };
// the two lens centres: in the room frame (measured on it) and in each view of the resting sprite (the same numbers as DRAW.bob in avatarRig.ts)
const FRAME = { L: [860, 460], R: [1030, 435] };
const SPRITE = { head: { L: [167, 208], R: [308, 216] }, full: { L: [127, 144], R: [225, 156] } };

const donor = await sharp(path.join(root, "assets/reference/video/bob_head_room.jpg")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const FW = donor.info.width, FH = donor.info.height;
const sample = (x, y) => { // bilinear, [r,g,b] or null outside
  if (x < 0 || y < 0 || x >= FW - 1 || y >= FH - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, o = (yy, xx) => (yy * FW + xx) * 3, D = donor.data;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) out[c] = (D[o(y0, x0) + c] * (1 - fx) + D[o(y0, x0 + 1) + c] * fx) * (1 - fy) + (D[o(y0 + 1, x0) + c] * (1 - fx) + D[o(y0 + 1, x0 + 1) + c] * fx) * fy;
  return out;
};

function restore(d, w, h, view) {
  const P = PAD[view], S = SPRITE[view];
  const fAng = Math.atan2(FRAME.R[1] - FRAME.L[1], FRAME.R[0] - FRAME.L[0]), sAng = Math.atan2(S.R[1] - S.L[1], S.R[0] - S.L[0]);
  const fd = Math.hypot(FRAME.R[0] - FRAME.L[0], FRAME.R[1] - FRAME.L[1]), sd = Math.hypot(S.R[0] - S.L[0], S.R[1] - S.L[1]);
  const k0 = sd / fd, th0 = sAng - fAng;
  const Lx0 = S.L[0], Ly0 = S.L[1] + P;
  let top = -1, bottom = -1;
  for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 200) n++; if (n > 4) { if (top < 0) top = y; bottom = y; } }
  if (top < 0) return { crown: 0, gaps: 0 };
  // each pose has its own head (tilt, lean): the lens-based registration is refined per pose by matching the donor's hair outline to the cut-out's over the
  // upper head (agreement of "hair here" / "room here"), over small shifts, turns and scales
  const yEye = S.L[1] + P;
  const roi = [];
  { let xl = w, xr = 0; for (let y = top; y < yEye - 15; y += 3) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 200) { if (x < xl) xl = x; if (x > xr) xr = x; }
    for (let y = top + 6; y < yEye - 15; y += 3) for (let x = Math.max(0, xl - 25); x <= Math.min(w - 1, xr + 25); x += 3) roi.push([x, y]); }
  const params = (dx, dy, dr, ds) => { const k = k0 * ds, th = th0 + dr; return { k, c: Math.cos(-th), s: Math.sin(-th), Lx: Lx0 + dx, Ly: Ly0 + dy }; };
  const at = (pr, x, y) => { const rx = (x - pr.Lx) / pr.k, ry = (y - pr.Ly) / pr.k; return sample(FRAME.L[0] + pr.c * rx - pr.s * ry, FRAME.L[1] + pr.s * rx + pr.c * ry); };
  const score = (dx, dy, dr, ds) => {
    const pr = params(dx, dy, dr, ds); let sc = 0;
    for (const [x, y] of roi) { const p = at(pr, x, y); if (!p) continue; const lm = (p[0] + p[1] + p[2]) / 3, op = d[(y * w + x) * 4 + 3] > 200; if (op && lm < 135) sc++; else if (!op && lm > 152) sc++; else if ((op && lm > 152) || (!op && lm < 135)) sc--; }
    return sc;
  };
  let best = { sc: -1e9, dx: 0, dy: 0, dr: 0, ds: 1 };
  // coarse over a wide range, then fine around the best
  for (const ds of [0.94, 0.97, 1, 1.03, 1.06]) for (const dr of [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15]) for (let dy = -24; dy <= 24; dy += 4) for (let dx = -30; dx <= 30; dx += 4) { const sc = score(dx, dy, dr, ds); if (sc > best.sc) best = { sc, dx, dy, dr, ds }; }
  const c0 = best;
  for (const ds of [c0.ds - 0.015, c0.ds, c0.ds + 0.015]) for (const dr of [c0.dr - 0.025, c0.dr, c0.dr + 0.025]) for (let dy = c0.dy - 3; dy <= c0.dy + 3; dy++) for (let dx = c0.dx - 3; dx <= c0.dx + 3; dx++) { const sc = score(dx, dy, dr, ds); if (sc > best.sc) best = { sc, dx, dy, dr, ds }; }
  const pr = params(best.dx, best.dy, best.dr, best.ds);
  // the warped donor: for each sprite pixel, the room-frame pixel that lands on it
  const dc = new Float32Array(w * h * 3), dn = new Uint8Array(w * h); // colour, and 1 where the donor is hair
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = at(pr, x, y); if (!p) continue;
    const i = y * w + x; dc[i * 3] = p[0]; dc[i * 3 + 1] = p[1]; dc[i * 3 + 2] = p[2];
    const lm = (p[0] + p[1] + p[2]) / 3;
    dn[i] = lm < 135 ? 1 : lm > 152 ? 2 : 0; // 1 = hair (even its lit highlights are darker than the pale room), 2 = the room
  }
  // the hair's span on the cut line, a little wider, bounds the crown
  let l0 = w, r0 = -1; for (let x = 0; x < w; x++) if (d[((top + 2) * w + x) * 4 + 3] > 200) { if (x < l0) l0 = x; r0 = x; }
  let crown = 0, gaps = 0;
  // the donor's hair is lit a little differently from the cut-out's: match the crown's colour to the cut-out's hair just below the cut line
  const ratio = [1, 1, 1];
  {
    const sp = [0, 0, 0], dd = [0, 0, 0]; let n = 0;
    for (let y = top + 3; y < top + 12; y++) for (let x = l0; x <= r0; x++) { const i = y * w + x; if (d[i * 4 + 3] > 200 && dn[i] === 1) { for (let q = 0; q < 3; q++) { sp[q] += d[i * 4 + q]; dd[q] += dc[i * 3 + q]; } n++; } }
    if (n > 30) for (let q = 0; q < 3; q++) ratio[q] = Math.min(1.5, Math.max(0.6, sp[q] / Math.max(1, dd[q])));
  }
  // 1. the crown: above the cut line, wherever the donor is hair within the hair's own width (grown a little as the head widens downward)
  for (let y = 0; y < top + 3; y++) for (let x = Math.max(0, l0 - 18); x <= Math.min(w - 1, r0 + 18); x++) {
    const i = y * w + x; if (dn[i] !== 1 || d[i * 4 + 3] > 200) continue;
    d[i * 4] = Math.min(255, Math.round(dc[i * 3] * ratio[0])); d[i * 4 + 1] = Math.min(255, Math.round(dc[i * 3 + 1] * ratio[1])); d[i * 4 + 2] = Math.min(255, Math.round(dc[i * 3 + 2] * ratio[2])); d[i * 4 + 3] = 255; crown++;
  }
  // 1b. the top band of the cut-out (the camera's cut edge and its dark crease): the donor decides what is hair there, so the flat corners go and the
  // rounded crown it shows replaces them
  const reach = view === "head" ? 70 : 48; // reach: how deep the donor may cut away the flat corners (never into the face)
  // wherever the donor shows the pale room (not her), the cut-out must not have hair: the flat corners go. Deeper than the colour band, because the cut line is wider than the real, rounded head
  for (let y = top; y < top + reach; y++) for (let x = Math.max(0, l0 - 40); x <= Math.min(w - 1, r0 + 40); x++) { const i = y * w + x; if (dn[i] === 2 && d[i * 4 + 3] > 0) d[i * 4 + 3] = 0; }
  // 2. holes and notches in the hair outline on the upper part of the head (closing of the opaque area, filled with the donor's hair)
  const rr = view === "head" ? 24 : 16, limit = top + Math.round((bottom - top) * (view === "head" ? 0.62 : 0.36));
  const mask = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) mask[i] = d[i * 4 + 3] > 128 ? 1 : 0;
  const t1 = new Uint8Array(w * h), t2 = new Uint8Array(w * h), t3 = new Uint8Array(w * h), cl = new Uint8Array(w * h);
  for (let y = 0; y < limit; y++) for (let x = 0; x < w; x++) { let v = 0; for (let q = -rr; q <= rr && !v; q++) { const xx = x + q; if (xx >= 0 && xx < w && mask[y * w + xx]) v = 1; } t1[y * w + x] = v; }
  for (let y = 0; y < limit; y++) for (let x = 0; x < w; x++) { let v = 0; for (let q = -rr; q <= rr && !v; q++) { const yy = y + q; if (yy >= 0 && yy < limit && t1[yy * w + x]) v = 1; } t2[y * w + x] = v; }
  for (let y = 0; y < limit; y++) for (let x = 0; x < w; x++) { let v = 1; for (let q = -rr; q <= rr && v; q++) { const xx = x + q; if (xx < 0 || xx >= w || !t2[y * w + xx]) v = 0; } t3[y * w + x] = v; }
  for (let y = 0; y < limit; y++) for (let x = 0; x < w; x++) { let v = 1; for (let q = -rr; q <= rr && v; q++) { const yy = y + q; if (yy < 0 || yy >= limit || !t3[yy * w + x]) v = 0; } cl[y * w + x] = v; }
  for (let y = top; y < limit; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (mask[i] || !cl[i] || dn[i] !== 1) continue;
    d[i * 4] = Math.min(255, Math.round(dc[i * 3] * ratio[0])); d[i * 4 + 1] = Math.min(255, Math.round(dc[i * 3 + 1] * ratio[1])); d[i * 4 + 2] = Math.min(255, Math.round(dc[i * 3 + 2] * ratio[2])); d[i * 4 + 3] = 255; gaps++;
  }
  // 3. what is left of the ragged outline (small notches the donor does not cover): a small closing that copies the neighbouring DARK hair
  {
    const r2 = view === "head" ? 7 : 5, m = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0;
    const e1 = new Uint8Array(w * h), e2 = new Uint8Array(w * h), e3 = new Uint8Array(w * h), c3 = new Uint8Array(w * h);
    for (let y = top; y < limit; y++) for (let x = 0; x < w; x++) { let v = 0; for (let q = -r2; q <= r2 && !v; q++) { const xx = x + q; if (xx >= 0 && xx < w && m[y * w + xx]) v = 1; } e1[y * w + x] = v; }
    for (let y = top; y < limit; y++) for (let x = 0; x < w; x++) { let v = 0; for (let q = -r2; q <= r2 && !v; q++) { const yy = y + q; if (yy >= 0 && yy < h && e1[yy * w + x]) v = 1; } e2[y * w + x] = v; }
    for (let y = top; y < limit; y++) for (let x = 0; x < w; x++) { let v = 1; for (let q = -r2; q <= r2 && v; q++) { const xx = x + q; if (xx < 0 || xx >= w || !e2[y * w + xx]) v = 0; } e3[y * w + x] = v; }
    for (let y = top; y < limit; y++) for (let x = 0; x < w; x++) { let v = 1; for (let q = -r2; q <= r2 && v; q++) { const yy = y + q; if (yy < 0 || yy >= h || !e3[yy * w + x]) v = 0; } c3[y * w + x] = v; }
    for (let y = top; y < limit; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (m[i] || !c3[i]) continue;
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let dy = -r2; dy <= r2; dy++) for (let dx = -r2; dx <= r2; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const j = yy * w + xx; if (m[j]) { sr += d[j * 4]; sg += d[j * 4 + 1]; sb += d[j * 4 + 2]; n++; } }
      if (!n || (sr + sg + sb) / (3 * n) > 135) continue;
      d[i * 4] = Math.round(sr / n); d[i * 4 + 1] = Math.round(sg / n); d[i * 4 + 2] = Math.round(sb / n); d[i * 4 + 3] = 255; gaps++;
    }
  }
  return { crown, gaps, fit: best };
}

/** light smoothing of the outline (1px erode, blur, sharpen), edge colours copied from just inside: the pale studio fringe goes */
function smooth(d, w, h) {
  const m = new Float32Array(w * h), e = new Float32Array(w * h), t = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = d[i * 4 + 3] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = m[y * w + x]; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; v = Math.min(v, xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : m[yy * w + xx]); } e[y * w + x] = v; }
  const K = [1, 4, 6, 4, 1];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let q = -2; q <= 2; q++) s += e[y * w + Math.min(w - 1, Math.max(0, x + q))] * K[q + 2]; t[y * w + x] = s / 16; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let q = -2; q <= 2; q++) s += t[Math.min(h - 1, Math.max(0, y + q)) * w + x] * K[q + 2]; b[y * w + x] = s / 16; }
  const sm = (v) => { const z = Math.min(1, Math.max(0, (v - 0.3) / 0.4)); return z * z * (3 - 2 * z); };
  const old = Buffer.from(d);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = sm(b[i]); d[i * 4 + 3] = Math.round(255 * a);
    if (a > 0 && old[i * 4 + 3] < 250) {
      let found = false;
      for (let r = 1; r <= 3 && !found; r++) for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r && !found; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const j = (yy * w + xx) * 4; if (old[j + 3] >= 250) { d[i * 4] = old[j]; d[i * 4 + 1] = old[j + 1]; d[i * 4 + 2] = old[j + 2]; found = true; } }
    }
  }
}

for (const view of ["head", "full"]) {
  for (const cell of CELLS) {
    const file = path.join(root, "assets/avatars/bob", view, cell + ".png");
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const P = PAD[view], w = info.width, h = info.height + P;
    const d = Buffer.alloc(w * h * 4); data.copy(d, P * w * 4);
    const r = restore(d, w, h, view);
    smooth(d, w, h);
    await sharp(d, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toFile(file);
    console.log(view, cell, w + "x" + h, "crown px", r.crown, "gap px", r.gaps, "fit", r.fit ? JSON.stringify({ dx: r.fit.dx, dy: r.fit.dy, rot: +(r.fit.dr * 57.3).toFixed(1), scale: r.fit.ds }) : "-");
  }
}
