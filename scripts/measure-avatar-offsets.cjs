// Measures how far each drawn face sits from the first one (so the blink and mouth overlays line up), from the hair, which never changes.
// node scripts/measure-avatar-offsets.cjs   -> prints the numbers kept in src/character/avatarRig.ts
const sharp = require("sharp");
const cells = ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"];
async function gray(f) {
  const { data, info } = await sharp(f).flatten({ background: "#808080" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const a = await sharp(f).ensureAlpha().extractChannel(3).raw().toBuffer();
  return { data, a, w: info.width, h: info.height };
}
(async () => {
  const out = {};
  for (const art of ["dark"]) for (const view of ["head", "full"]) {
    const ims = []; for (const c of cells) ims.push(await gray(`assets/avatars/${art}/${view}/${c}.png`));
    const ref = ims[0], res = {};
    for (let i = 0; i < cells.length; i++) {
      const im = ims[i]; let best = [0, 0], bs = Infinity;
      const y1 = Math.round(Math.min(ref.h, im.h) * (view === "head" ? 0.42 : 0.2));
      for (let dy = -24; dy <= 24; dy += 1) for (let dx = -24; dx <= 24; dx += 1) {
        let s = 0, n = 0;
        for (let y = 10; y < y1; y += 2) for (let x = 20; x < Math.min(ref.w, im.w) - 20; x += 2) {
          const xr = x + dx, yr = y + dy; if (xr < 0 || yr < 0 || xr >= ref.w || yr >= ref.h) continue;
          if (ref.a[yr * ref.w + xr] < 200 || im.a[y * im.w + x] < 200) continue;
          const d = ref.data[yr * ref.w + xr] - im.data[y * im.w + x]; s += d * d; n++;
        }
        if (n > 200 && s / n < bs) { bs = s / n; best = [dx, dy]; }
      }
      res[cells[i]] = { dx: best[0] / im.w, dy: best[1] / im.h, w: im.w, h: im.h };
    }
    out[art + "/" + view] = res;
  }
  console.log(JSON.stringify(out, (k, v) => (typeof v === "number" ? Math.round(v * 10000) / 10000 : v), 1));
})();
