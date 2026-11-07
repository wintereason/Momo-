// Draws Momo's app/tray icon (a pink rounded square with a small waveform) into assets/icon.png.
//   node scripts/make-icon.mjs
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bars = [10, 22, 34, 22, 14, 28, 18];
const w = 7, gap = 5, total = bars.length * w + (bars.length - 1) * gap;
const x0 = (128 - total) / 2;
const rects = bars.map((h, i) => `<rect x="${x0 + i * (w + gap)}" y="${64 - h}" width="${w}" height="${h * 2}" rx="3.5" fill="#fff"/>`).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8fb3"/><stop offset="1" stop-color="#e8588c"/></linearGradient></defs>
  <rect width="128" height="128" rx="30" fill="url(#g)"/>${rects}
</svg>`;
await sharp(Buffer.from(svg)).png().toFile(path.join(root, "assets", "icon.png"));
console.log("wrote assets/icon.png");
