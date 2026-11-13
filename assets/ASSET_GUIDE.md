# Asset Guide

## Reference images (do not ship, do not edit)
- `reference/character_sheet_expressions.png` — selection panel, per-character expressions (each has Happy, Thinking, Sorry, Sleepy plus two extras), and Gojo's state demos (Listening, Thinking, Task Completed, Task Failed, Sleeping).
- `reference/group_bench_scene.png` — all five characters together; style reference for the cherry-blossom theme.

## Avatar sheets (supplied art, shipped)
- `reference/avatar_sheet_pink.png` — pink/blue-haired girl with glasses and a gradient dress, 3 columns × 2 rows.
- `reference/avatar_sheet_dark.png` — dark-haired boy with glasses and a black hoodie, 3 columns × 2 rows.

Both are 1024×1024 renders of a chibi 3D “AVATAR 3D” figurine on a pale studio set with a rounded display base.
`node scripts/cut-avatar-sheets.mjs` turns them into transparent sprites:

- `avatars/<art>/head/<cell>.png` — head and shoulders, used by the compact bar.
- `avatars/<art>/full/<cell>.png` — the whole figure, head to shoes, used by the expanded bar and the Settings preview.
- `<cell>` is `r1c1` … `r2c3` (row, column). The expression → cell mapping lives in `src/character/avatars.ts`.
- The cutter flood-fills the blue-grey studio set, removes the wide flat base and its “AVATAR 3D” print, drops
  sparkles, and keeps the figure’s legs/shoes and pale tights. It also writes `avatars/_check-<art>.png` checkerboard
  contact sheets so the result can be checked at a glance.
- Re-run the cutter whenever the source sheets change; do not hand-edit the generated PNGs.

## Sprites to produce (transparent PNG, same canvas size, same seated anchor point per character)
Path pattern: `characters/<id>/<expression>.png`
Expressions: `happy, excited, thinking, sorry, sleepy` plus each character's extra (see manifest), plus ideally `listening, working, asking, blocked`.
Also `characters/<id>/portrait.png` for the picker card.
Recommended: 1024x1024 source, exported at 512x512 and 256x256.
Until real cut-outs exist, the app should show a placeholder (colored shape + label) so nothing blocks.

## Scene
`scene/table.png` (individual wooden table), `scene/blossom_backdrop.png` (optional, not required to fill desktop).

## 3D (later)
`models/<id>.glb`, one per character, consistent scale and seated pose, with animations or blend shapes for idle, listening, thinking, happy, sorry, confused, sleeping.
