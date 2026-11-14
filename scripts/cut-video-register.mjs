// Cuts extra poses out of reference-video frames and REGISTERS each one onto an existing avatar's resting sprite, so switching to it
// never makes the face or body jump: the figure is scaled and moved so its two eye centres land exactly on the resting sprite's.
// Below where the video frame ends (legs and shoes are out of shot) the resting sprite's own legs are kept: they are the same
// character in the same clip, so nothing is invented. Run after cut-avatar-sheets.mjs / cut-video-avatar.mjs: node scripts/cut-video-register.mjs
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cutFigure } from "./cut-video-avatar.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** eye centres of each avatar's resting sprite (the same numbers as DRAW in src/character/avatarRig.ts) */
const REST = {
  dark: { head: { w: 512, h: 441, eyes: [[169, 322], [310, 320]] }, full: { w: 354, h: 512, eyes: [[116, 231], [208, 231]] } },
  bob: { head: { w: 512, h: 459, eyes: [[167, 208], [308, 216]] }, full: { w: 380, h: 512, eyes: [[127, 144], [225, 156]] } },
};
/** frame: reference still; eyes: the two eye centres in that 1920x1080 still; legs: keep the resting sprite's legs below the frame's end */
/** the glasses area of each view of the girl's resting sprite (x0,y0,x1,y1): poses are refined until their glasses frames lie on hers */
const GLASSES = { bob: { head: [95, 170, 350, 320], full: [90, 105, 260, 185] }, dark: { head: [80, 280, 400, 370], full: [70, 205, 250, 262] } };
const isDark = (d, w, h, x, y) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return false; const i = (y * w + x) * 4; return d[i + 3] > 200 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 95; };
/** best (scale about the glasses centre, dx, dy) laying the pose's dark glasses/hair pixels onto the resting sprite's */
function refine(restData, poseData, w, h, box) {
  const [x0, y0, x1, y1] = box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let best = { cost: Infinity, s: 1, dx: 0, dy: 0 };
  for (let s = 0.9; s <= 1.101; s += 0.02) for (let dy = -26; dy <= 26; dy += 2) for (let dx = -26; dx <= 26; dx += 2) {
    let cost = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      // the pose pixel that lands on resting pixel (x,y): inverse of  p' = c + s*(p - c) + d
      const px = cx + (x - dx - cx) / s, py = cy + (y - dy - cy) / s;
      if (isDark(restData, w, h, x, y) !== isDark(poseData, w, h, px, py)) cost++;
    }
    if (cost < best.cost) best = { cost, s, dx, dy };
  }
  return { ...best, cx, cy };
}
export const CELLS = [
  { art: "dark", cell: "s1", file: "dark_s1.jpg", eyes: [[845, 462], [1066, 462]], legs: true },
  // the boy's eyes-closed smile, WITH his glasses (the sheet's are drawn without them), from the end of video 4
  { art: "dark", cell: "h1", file: "dark_h1.jpg", hair: true, legs: true, seamRow: 395 },
  // the girl's poses are registered by her hair (width at the cheeks and top of the head), because her eyes are different in every pose
  { art: "bob", cell: "r1c2", file: "bob_r1c2.jpg", hair: true },
  { art: "bob", cell: "r1c3", file: "bob_r1c3.jpg", hair: true },
  { art: "bob", cell: "r2c1", file: "bob_r2c1.jpg", hair: true },
  { art: "bob", cell: "r2c2", file: "bob_r2c2.jpg", hair: true },
  { art: "bob", cell: "r2c3", file: "bob_r2c3.jpg", hair: true },
  { art: "bob", cell: "g1", file: "bob_g1.jpg", hair: true, legs: true },
];
/** widest row of the head (the bob hair at cheek level) in the top 35% of what is visible, and the top of the head */
function hairBox(alpha, w, h) {
  let top = h, bottom = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha(x, y) > 40) { if (y < top) top = y; bottom = y; }
  let best = { width: 0, cx: 0 };
  for (let y = top; y < top + (bottom - top) * 0.35; y++) {
    let x0 = w, x1 = -1;
    for (let x = 0; x < w; x++) if (alpha(x, y) > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    if (x1 - x0 > best.width) best = { width: x1 - x0, cx: (x0 + x1) / 2 };
  }
  return { top, ...best };
}

/** width of the head (hair and ears) in a band around the eye line: the one measure that is the same for a sheet render and a video still */
function headWidth(alpha, w, h, eyeY) {
  let top = h; for (let y = 0; y < h && top === h; y++) for (let x = 0; x < w; x++) if (alpha(x, y) > 40) { top = y; break; }
  const y0 = Math.round(top + 0.3 * (eyeY - top)), y1 = Math.round(eyeY + 0.1 * (eyeY - top));
  let x0 = w, x1 = -1;
  for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) if (alpha(x, y) > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  return x1 - x0;
}
async function placeOn(rgba, w, h, s, from, to, cw, ch) {
  const rw = Math.round(w * s), rh = Math.round(h * s);
  const scaled = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).resize(rw, rh, { kernel: "lanczos3" }).raw().toBuffer();
  const ox = Math.round(to[0] - from[0] * s), oy = Math.round(to[1] - from[1] * s);
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < rh; y++) { const ty = y + oy; if (ty < 0 || ty >= ch) continue; for (let x = 0; x < rw; x++) { const tx = x + ox; if (tx < 0 || tx >= cw) continue; const si = (y * rw + x) * 4, di = (ty * cw + tx) * 4; out[di] = scaled[si]; out[di + 1] = scaled[si + 1]; out[di + 2] = scaled[si + 2]; out[di + 3] = scaled[si + 3]; } }
  return out;
}

for (const c of CELLS) {
  const fig = await cutFigure(path.join(root, "assets/reference/video", c.file));
  let tf = null; // the girl's poses: the frame -> full-sprite transform found for the full view, reused (with the fixed full -> head mapping) for the head view
  for (const view of c.hair ? ["full", "head"] : ["head", "full"]) {
    const R = REST[c.art][view];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (c.hair && view === "full") {
      const restA = await sharp(path.join(root, "assets/avatars", c.art, view, "r1c1.png")).ensureAlpha().raw().toBuffer();
      const rb = hairBox((x, y) => restA[(y * R.w + x) * 4 + 3], R.w, R.h), fb = hairBox((x, y) => fig.rgba[(y * fig.w + x) * 4 + 3], fig.w, fig.h);
      const s0 = rb.width / fb.width, from = [fb.cx, fb.top], to0 = [rb.cx, rb.top];
      const first = await placeOn(fig.rgba, fig.w, fig.h, s0, from, to0, R.w, R.h);
      const r = refine(restA, first, R.w, R.h, GLASSES[c.art].full);
      // p' = C + rs*(p - C) + d, applied after the first placement
      const to1 = [r.cx + r.s * (to0[0] - r.cx) + r.dx, r.cy + r.s * (to0[1] - r.cy) + r.dy];
      tf = { scale: s0 * r.s, from, to: to1 };
      console.log("  glasses refine", c.cell, "scale", r.s.toFixed(2), "dx", r.dx, "dy", r.dy, "mismatch", r.cost);
    } else if (c.hair) {
      // the fixed mapping from the resting FULL sprite to the resting HEAD sprite (from their eye centres): scale 1.43, offset (-14.6, -2.5)
      tf = { scale: tf.scale * 1.43, from: tf.from, to: [tf.to[0] * 1.43 - 14.6, tf.to[1] * 1.43 - 2.5] };
    }
    const rest0 = await sharp(path.join(root, "assets/avatars", c.art, view, "r1c1.png")).ensureAlpha().raw().toBuffer();
    const eyeMid = (e) => (e[0][1] + e[1][1]) / 2;
    const restW = c.hair ? 1 : headWidth((x, y) => rest0[(y * R.w + x) * 4 + 3], R.w, R.h, eyeMid(R.eyes));
    const figW = c.hair ? 1 : headWidth((x, y) => fig.rgba[(y * fig.w + x) * 4 + 3], fig.w, fig.h, eyeMid(c.eyes));
    const s = c.hair ? 1 : restW / figW;
    // put the middle of the eye line on the resting sprite's (the eyes themselves are calibrated separately, per cell)
    const mid = c.eyes ? [(c.eyes[0][0] + c.eyes[1][0]) / 2, eyeMid(c.eyes)] : null, rmid = [(R.eyes[0][0] + R.eyes[1][0]) / 2, eyeMid(R.eyes)];
    let out = c.hair ? await placeOn(fig.rgba, fig.w, fig.h, tf.scale, tf.from, tf.to, R.w, R.h) : await placeOn(fig.rgba, fig.w, fig.h, s, mid, rmid, R.w, R.h);
    if (view === "full" && c.legs) {
      // The frame ends above the feet. Find the dress hem in both images (the last row that is still wide), drop everything under
      // the new figure's hem, and put the resting sprite's legs there: shifted so its hem meets this hem (same character, same clip).
      const rest = await sharp(path.join(root, "assets/avatars", c.art, "full", "r1c1.png")).ensureAlpha().raw().toBuffer();
      const hem = (buf, minW) => {
        const wd = new Array(R.h).fill(0), cxs = new Array(R.h).fill(0);
        for (let y = 0; y < R.h; y++) { let x0 = R.w, x1 = -1; for (let x = 0; x < R.w; x++) if (buf[(y * R.w + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; } wd[y] = x1 >= 0 ? x1 - x0 : 0; cxs[y] = (x0 + x1) / 2; }
        const mx = Math.max(...wd.slice(Math.floor(R.h * 0.45)));
        let row = 0; for (let y = Math.floor(R.h * 0.45); y < R.h; y++) if (wd[y] >= (minW ?? (c.hemFrac ?? 0.55) * mx)) row = y;
        return { row, cx: cxs[row - 4], width: wd[row] };
      };
      if (c.seamRow) {
        // the boy: his legs are the resting sprite's from the hoodie hem down (his silhouette narrows there, so there is no dress hem to find)
        for (let y = c.seamRow; y < R.h; y++) for (let x = 0; x < R.w; x++) { const i = (y * R.w + x) * 4; out[i] = rest[i]; out[i + 1] = rest[i + 1]; out[i + 2] = rest[i + 2]; out[i + 3] = rest[i + 3]; }
        console.log("  legs from row", c.seamRow);
      } else {
      const hr = hem(rest), hn = hem(out, hr.width * 0.8); // the new figure's hem: the last row about as wide as the resting hem (arms held out do not count)
      const dx = Math.round(hn.cx - hr.cx), dy = hn.row - hr.row;
      for (let y = hn.row + 2; y < R.h; y++) for (let x = 0; x < R.w; x++) out[(y * R.w + x) * 4 + 3] = 0;
      for (let y = hr.row + 2; y < R.h; y++) {
        const ty = y + dy; if (ty < 0 || ty >= R.h) continue;
        for (let x = 0; x < R.w; x++) { const tx = x + dx; if (tx < 0 || tx >= R.w) continue; const si = (y * R.w + x) * 4, di = (ty * R.w + tx) * 4; if (rest[si + 3] === 0) continue; out[di] = rest[si]; out[di + 1] = rest[si + 1]; out[di + 2] = rest[si + 2]; out[di + 3] = rest[si + 3]; }
      }
      console.log("  legs: hem row", hn.row, "(resting", hr.row + ")", "shift", dx, dy);
      }
    }
    const dir = path.join(root, "assets/avatars", c.art, view);
    await sharp(out, { raw: { width: R.w, height: R.h, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(dir, c.cell + ".png"));
    console.log("registered", c.art, c.cell, view, "scale", s.toFixed(3));
  }
}
