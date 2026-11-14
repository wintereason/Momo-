// For each of the girl's poses, finds the small shift (dx, dy, in sprite pixels) that best lays her resting face (glasses frames) onto the pose's own
// glasses, so the resting face can be shown over a gesture pose while she speaks without doubled frames. Prints a table for src/character/avatarRig.ts.
import sharp from "sharp";
const CELLS = ["r1c2", "r1c3", "r2c1", "r2c2", "r2c3", "g1"];
const BOX = { head: [95, 170, 350, 320], full: [60, 100, 270, 180] }; // the glasses area of each view (x0,y0,x1,y1) in sprite pixels
const dark = (d, i) => d[i + 3] > 200 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 95;
for (const view of ["head", "full"]) {
  const rest = await sharp(`assets/avatars/bob/${view}/r1c1.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [x0, y0, x1, y1] = BOX[view], W = rest.info.width;
  for (const cell of CELLS) {
    const pose = await sharp(`assets/avatars/bob/${view}/${cell}.png`).ensureAlpha().raw().toBuffer();
    let best = { s: Infinity, dx: 0, dy: 0 };
    for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) {
      let s = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const a = dark(rest.data, (y * W + x) * 4), b = dark(pose, ((y + dy) * W + (x + dx)) * 4); if (a !== b) s++; }
      if (s < best.s) best = { s, dx, dy };
    }
    console.log(view.padEnd(5), cell, "dx", best.dx, "dy", best.dy, "mismatch px", best.s);
  }
}
