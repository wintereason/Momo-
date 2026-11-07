# Asset Guide

## Reference images (do not ship, do not edit)
- `reference/character_sheet_expressions.png` — selection panel, per-character expressions (each has Happy, Thinking, Sorry, Sleepy plus two extras), and Gojo's state demos (Listening, Thinking, Task Completed, Task Failed, Sleeping).
- `reference/group_bench_scene.png` — all five characters together; style reference for the cherry-blossom theme.

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
