# 3D character models

Momo shows a 3D model for a character when `assets/models/<id>.glb` exists (id = `gojo`, `nezuko`, `megumi`,
`klee`, `mochi`) and **Settings → Appearance → Character → "3D model"** is selected. Otherwise it shows the 2D art.
`<id>.placeholder.glb` files are crude generated stand-ins (see `scripts/make-placeholder-models.mjs`); a real
`<id>.glb` always wins over them.

## What a model must look like
| Thing | Requirement |
|---|---|
| Format | glTF binary (`.glb`), one file per character |
| Orientation | +Y up, facing +Z (towards the camera) |
| Size | any units: Momo scales every model to the same height and sits its feet on the table, so models stay consistent |
| Pose | seated, feet at the lowest point of the model |
| Budget | under about 5,000 triangles and 2 MB (it runs on integrated graphics) |
| Materials | standard PBR (base colour, roughness); no custom shaders |

## Animation clips (one per Momo state; missing ones fall back, finally to a built-in motion)
`idle` (required), `listening`, `transcribing`, `thinking`, `asking`, `working`, `success`, `partial_success`, `sorry`,
`blocked`, `error`, `sleeping`, `disabled`. Short aliases are also understood (`celebrate`, `happy`, `sad`, `sleep`, ...):
see `src/scene/modelMap.ts`. `success`, `error` and `partial_success` play once; the others loop.

## Face morph targets (blend shapes), optional
Named like the sprite expressions: `happy`, `excited`, `thinking`, `sorry`, `sleepy`, `angry`, `sad`, `focused`,
`annoyed`, `surprised`, `confused`. The matching one is blended in for each state.
