// Dev tool: stitches the per-state screenshots written by check-scene-live.cjs into one contact sheet.
//   node scripts/scene-contact-sheet.cjs <characterId> <2d|3d>

const sharp = require("sharp");
const id = process.argv[2] || "mochi", view = process.argv[3] || "2d";
const states = ["idle","listening","thinking","asking","working","success","sorry","sleeping"];
(async () => {
  const W = 340, H = 270;
  const tiles = await Promise.all(states.map(async (s, i) => ({ input: await sharp("D:/dev-cache/scene-check/" + id + "-" + view + "-" + s + ".png").resize(W, H).toBuffer(), left: (i % 4) * W, top: Math.floor(i / 4) * H })));
  await sharp({ create: { width: W * 4, height: H * 2, channels: 4, background: "#3b2a4a" } }).composite(tiles).png().toFile("D:/dev-cache/scene-check/sheet-" + id + "-" + view + ".png");
  console.log("sheet ok");
})();
