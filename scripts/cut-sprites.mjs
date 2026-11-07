// Cuts provisional sprites out of assets/reference/character_sheet_expressions.png.
// Low resolution (~120px): meant as stand-ins until real 512px art is generated
// from assets/05_CHARACTER_PROMPTS.md. Output: assets/characters/<id>/<expression>.png + portrait.png
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sheet = path.join(root, "assets/reference/character_sheet_expressions.png");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "assets/characters.manifest.json"), "utf8"));

// Card left edges in the lower panel, and the grid of 2 columns x 3 rows inside each card.
const CARD_L = { gojo: 28, nezuko: 272, megumi: 514, klee: 756, mochi: 997 };
const COLS = [[4, 116], [120, 228]]; // x offsets from card left
const ROWS = [[512, 628], [654, 766], [796, 906]]; // y ranges (above the text labels)
// Portrait boxes in the top "Select your companion" panel.
const PORTRAIT = {
  gojo: [64, 142, 124, 172], nezuko: [206, 150, 106, 164], megumi: [330, 146, 104, 166],
  klee: [450, 142, 102, 170], mochi: [566, 142, 96, 172],
};

// The sheet's tiles are soft lavender glass cells, so instead of colour-keying (which eats pale
// hair/skin) each crop gets a feathered rounded mask. Real transparent art replaces these later.
async function crop(x, y, w, h, outFile, scale = 4) {
  const W = w * scale, H = h * scale, inset = 3 * scale, r = Math.min(W, H) * 0.3, f = 3 * scale;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><filter id="b"><feGaussianBlur stdDeviation="${f}"/></filter></defs>` +
    `<rect x="${inset + f}" y="${inset + f}" width="${W - 2 * (inset + f)}" height="${H - 2 * (inset + f)}" rx="${r}" fill="#fff" filter="url(#b)"/></svg>`);
  const base = await sharp(sheet)
    .extract({ left: x, top: y, width: w, height: h })
    .resize(W, H, { kernel: "lanczos3" })
    .ensureAlpha().png().toBuffer();
  const masked = await sharp(base).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  await sharp(masked)
    .resize(512, 512, { fit: "contain", position: "south", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(outFile);
}

for (const c of manifest.characters) {
  const dir = path.join(root, "assets/characters", c.id);
  fs.mkdirSync(dir, { recursive: true });
  const L = CARD_L[c.id];
  for (let i = 0; i < 6; i++) {
    const [cx0, cx1] = COLS[i % 2];
    const [y0, y1] = ROWS[Math.floor(i / 2)];
    await crop(L + cx0, y0, cx1 - cx0, y1 - y0, path.join(dir, `${c.sheetExpressions[i]}.png`));
  }
  const [px, py, pw, ph] = PORTRAIT[c.id];
  await crop(px, py, pw, ph, path.join(dir, "portrait.png"));
  console.log("cut", c.id);
}
