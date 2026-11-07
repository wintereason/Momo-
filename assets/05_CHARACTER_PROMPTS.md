# Character Image Prompts (match the reference images)

Use with any image generator (ChatGPT/DALL-E, Midjourney, Gemini/Imagen, Leonardo, Flux, SDXL).
Always upload `assets/reference/character_sheet_expressions.png` and `group_bench_scene.png` as image references when the tool allows it, and say "keep the exact same character design as the reference".
Characters are described by visual traits (not names) because many generators refuse named characters. Gojo, Nezuko and Megumi are existing anime characters: personal use only; replace before any public release.

---
## 1. MASTER STYLE BLOCK (paste at the start of every prompt)

```
Ultra-cute chibi character, glossy 3D render in the style of a premium vinyl collectible figure / Pixar-quality animation. Oversized head (about 2:1 head-to-body ratio), tiny soft body, short rounded limbs, smooth soft-clay skin with subtle subsurface scattering, big shiny detailed eyes (unless covered), rosy blush on cheeks, finely sculpted hair strands with glossy highlights, fabric with realistic soft folds and stitching detail. Seated pose, cross-legged or knees together, facing the camera at a slight 3/4 angle. Warm cherry-blossom palette: pink, peach, lavender, soft gold. Soft cinematic key light from upper left, warm rim light, gentle ambient occlusion, shallow depth of field, 8K, sharp focus, high detail, octane render look.
```

## 2. NEGATIVE PROMPT (for tools that support it)

```
flat 2D, sketch, lineart, blurry, low resolution, extra fingers, deformed hands, distorted face, asymmetrical eyes, realistic human proportions, adult proportions, creepy, scary, dark horror lighting, text, watermark, logo, cropped, cut off, duplicate character, multiple characters, inconsistent outfit, wrong hair color, plastic harsh glare
```

## 3. CHARACTER DESCRIPTOR BLOCKS (paste after the master block)

**GOJO (id: gojo) — Cool & Chill**
```
Chibi boy with big fluffy spiky white hair swept upward, a black blindfold band covering both eyes, small happy smile with a tiny open mouth, rosy cheeks, black high-collar uniform jacket and black trousers with black shoes. He hugs a round fluffy white plush creature wearing small round black sunglasses.
```

**NEZUKO (id: nezuko) — Kind & Caring**
```
Chibi girl with very long wavy dark-brown hair that fades into orange-red tips, a small pink bow on the right side of her head, a green bamboo tube held in her mouth tied with a ribbon behind her head, gentle closed happy eyes with long lashes, pink kimono with a light geometric hexagon pattern and an orange obi, a dark brown haori jacket over it, white tabi socks and wooden sandals, hands resting neatly on her lap.
```

**MEGUMI (id: megumi) — Calm & Smart**
```
Chibi boy with spiky black hair gathered into a small top bun, calm half-lidded dark eyes with a slight confident smirk, small ear stud, black buttoned school uniform jacket with gold buttons and black trousers, black shoes. He holds a tiny white dog plush wearing small round black sunglasses.
```

**KLEE (id: klee) — Cheerful & Energetic**
```
Chibi girl with long wavy light-golden-blonde hair with a small ahoge, two red ribbons tying side tufts, a heart-shaped pink hair clip, big sparkling blue eyes, open cheerful smile, cream knitted cardigan over a white sailor top with a light-blue collar and teal bow, lavender pleated skirt, white socks, black Mary Jane shoes. Hands held up near her chest.
```

**MOCHI (id: mochi) — Cute & Friendly**
```
Chibi girl with fluffy pink bob hair fading to cyan-blue tips, round black-framed glasses, large sparkling blue eyes, happy open smile, black choker, oversized pink-to-white gradient sweatshirt with a small black bow print, white ankle socks, black-and-white sneakers.
```

## 4. SETTING BLOCKS

**Desk widget scene (default Momo scene)**
```
Sitting at her/his own small polished wooden table in a cherry-blossom garden, falling pink petals, a small potted bonsai blossom tree and a mug on the table, warm sunset bokeh background with a blurred pagoda, dreamy lavender-pink atmosphere.
```

**Transparent sprite (for app use)**
```
Isolated on a plain pure white background, no shadow, no props except the character's own items, centered, full seated body visible, same camera angle and same scale as the other expressions. (Then remove the background to get a transparent PNG.)
```

## 5. EXPRESSION MODIFIERS (append one; keep everything else identical)

Create the SAME character each time; change ONLY the face/pose line below.

| Momo state | Append this |
|---|---|
| idle / happy | `Expression: gentle happy smile, relaxed pose, soft blink.` |
| listening | `Expression: attentive and eager, head tilted slightly, one hand near ear, a glowing blue microphone-wave bubble beside the head.` |
| transcribing | `Expression: focused, small sound-wave icon floating beside the head.` |
| thinking | `Expression: pondering, one hand on chin, eyes looking up, small question-mark and thought bubble.` |
| asking | `Expression: curious head tilt, wide eyes, small floating question mark.` |
| working | `Expression: determined and focused, small sparkle/gear icon, slightly leaning forward.` |
| success / excited | `Expression: very happy, arms raised in celebration, sparkling stars and a green check mark, bright joyful eyes.` |
| partial success | `Expression: relieved warm smile, one thumb up.` |
| sorry | `Expression: apologetic, lowered head, teary soft eyes, small sweat drop, hands pressed together.` |
| blocked | `Expression: serious and cautious, one palm raised in a "wait" gesture, small shield or exclamation icon.` |
| error | `Expression: concerned/worried, small warning symbol (use angry/annoyed/sad per character: Gojo angry, Megumi annoyed, Nezuko sad).` |
| sleeping | `Expression: eyes closed, head resting on the plush/hands, gentle breathing, floating "Zzz".` |

## 6. READY-TO-USE FULL EXAMPLE (Gojo, success)

```
Ultra-cute chibi character, glossy 3D render in the style of a premium vinyl collectible figure / Pixar-quality animation, oversized head (2:1 ratio), soft-clay skin with subtle subsurface scattering, rosy cheeks, finely sculpted glossy hair, realistic soft fabric folds, seated pose facing camera at a slight 3/4 angle, warm cherry-blossom palette, soft cinematic key light with warm rim light, shallow depth of field, 8K, octane render look. Chibi boy with big fluffy spiky white hair, a black blindfold band covering both eyes, small happy smile, black high-collar uniform and trousers, hugging a fluffy white plush wearing tiny round black sunglasses. Expression: very happy, arms raised in celebration, sparkling stars and a green check mark. Sitting at a small polished wooden table in a cherry-blossom garden, falling petals, warm sunset bokeh. Keep the exact same character design as the reference image.
```

## 7. IMAGE-TO-3D PREP PROMPT (to feed Meshy / Tripo / Hunyuan3D)

Generate a clean, neutral source image first:
```
[Master style block] [Character descriptor] Neutral calm smile, symmetrical seated pose, hands resting on lap, full body visible head to shoes, plain light-grey background, flat even studio lighting with NO dramatic shadows, no petals, no props on the table, orthographic-like front view. Also produce matching side view and back view of the exact same character (turnaround sheet), same scale.
```
Then: run image-to-3D, import `.glb` into Blender, add a skeleton (or use Mixamo-style auto-rig), and build face blend shapes for the 13 states. Expect to hand-fix the face, hair and the plush/prop. Keep the table and blossom scene as separate assets.

## 8. CONSISTENCY WORKFLOW (important)

1. Generate each character's **happy** image first and lock it as the master.
2. For every other expression, upload that master and say: "Same character, same outfit, same camera, same lighting. Change only the expression to: ...".
3. Use the same seed / "character reference" feature if the tool has one.
4. Generate all 13 states per character on a plain white background, then remove the background to a transparent PNG.
5. Save as `assets/characters/<id>/<state>.png` (e.g. `gojo/success.png`) and keep names matching `assets/characters.manifest.json`.
6. Check that all five characters have the same size, framing and seated anchor point so the widget doesn't jump when expressions change.
