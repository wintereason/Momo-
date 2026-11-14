# Momo as a dictation app (Wispr-Flow style)

## What the user sees
- **The bar**: a small pill at the bottom centre of the screen. It never takes focus and never catches clicks.
  Idle = three quiet dots. Listening = a live waveform. Then "Writing it down…", "Polishing…", and a short
  "Inserted" / "Copied" / problem message with one quiet detail line.
- **The Settings app** (opens when Momo starts; tray icon reopens it): Home, Dictation, Voice & microphone,
  Shortcut, AI & keys, Ask Momo (typed commands), Privacy & data.
- **Momo, the character** (`src/character/`): gender-neutral by default, shown above the pill, compact (round face) or expanded (bust); hover it for the resize button. The face comes ONLY from the bar state (listening, thinking, working, asking, confirming, done, problem + severity) and whether Momo is speaking; the mouth follows the real speech (`Speaker` start / word position / end). Customise in Settings > Character (presentation, hair, outfit, theme, personality, animation, preview, reset); saved with the other preferences and removed by "Delete my data". Personality rewords only Momo's stock phrases and the spoken lead-in, never AI answers, skills or permissions. The window stays click-through; only buttons and cards (`data-hit`) take the mouse while hovered. `scripts/screenshot-character.cjs` renders every expression.

## The flow
1. Shortcut pressed (hold or toggle, never both) → the bar starts the microphone; at the same moment the shell looks at the window in front with UI Automation (`electron/targeting.cjs`, `src/runtime-core/action/dictationTarget.ts`) to find the editable fields and which one has the focus.
2. Shortcut released (the bar keeps listening for a quarter of a second so the last word is not clipped) → Whisper turns the audio into text on this PC. It runs **natively in the shell** (`electron/stt.cjs` + `stt.worker.cjs`, a worker thread using ONNX Runtime for Node), about 5× faster than the in-page WebAssembly version (a 5.5 s sentence: ~1–3 s instead of ~10 s on the dev laptop). The model is loaded when the bar starts and while you speak, and released after 5 idle minutes. Whisper's invented text in silence ("(soft music)", "Thank you.") is dropped. Audio is never saved or sent.
3. `momo:dictate` (bar → shell) → `Session.dictate()` in the runtime:
   - style `off`: the text as heard; `light`: mistakes only; `polish`: grammar + wording (the AI step, `ai.polish`);
   - AI off or failed → a local clean-up (`localClean`: filler words, short repeats, capitals, a full stop after
     Latin text) and a plain note. The AI's reply is checked (`acceptPolish`); a reply that explains, answers or is far
     longer than the input is discarded.
4. The shell writes the text with the rule **Detect → Identify → Focus → Dictate → Verify** (never into an unidentified field):
   - a field that already has the focus is used; exactly one editable field in the window is focused automatically;
   - several fields → the bar lists them (by their own label) and waits for your click; none → the bar asks you to click inside one and waits (30 s);
   - the chosen field is found by its UI Automation runtime id (no coordinates), focused, and the focus is proven before anything is pasted;
   - the text goes in at the cursor (clipboard + Ctrl+V, sent only after the focus is proven); a selection is collapsed first so it is kept, not replaced;
   - the field is read back and compared with what it held before: "Inserted" is shown only when the new text arrived and the old text is intact. If the app does not let Momo read the field it says "Pasted (not confirmed)"; if the text did not arrive it says "Copied. Press Ctrl+V";
   - password boxes it can recognise are skipped. While a question is open, the dictated text is held in memory for at most 60 s and dropped on any answer.

## Rules this keeps
- The dictated words are **data**: they are rewritten, never obeyed and never run as commands (`task.*` events are not
  emitted by dictation; tested).
- Only the dictated words are sent to the AI (no screen text, no history, no keys in URLs). Cloud providers may log
  them: the Settings pages say so; Ollama keeps it on this PC.
- Free services only (Gemini, Groq, OpenRouter, Ollama). Daily request cap applies to dictation too.
- Nothing dictated is stored. The clipboard is written only with dictated text (audited).

## Cloud speech (optional, off by default)
In Language & voice the user can pick *Cloud speech*: each sentence's audio is sent over HTTPS to Groq (Whisper large-v3, `electron/cloudStt.cjs`, pinned to api.groq.com, key from `.env` only, never in the page) for much better accuracy in Hindi and other languages. If it fails (offline, limit) Momo falls back to the model on this PC. Momo stores nothing either way.

## Starting with Windows
The installed app switches on *start with Windows* the first time it runs (a one-byte marker file records that it was offered); it then starts hidden in the tray (`--hidden`). It can be turned off in General.

## Speech model
Downloaded once (about 250 MB) from the model hub into Momo's data folder (`speech-model/`), only through the same host allowlist the pages use; "Delete my data" removes it. Nothing else leaves the PC.

## Known limits (honest)
- Browsers and Electron apps build their accessibility tree only when asked: Momo asks and looks again once, but a page that exposes no text boxes ends in "click inside a text box". Fields in apps that do not expose their text (some editors) are written to but reported as "not confirmed".
- A password box **inside a web page** is not reported by Chromium to Windows UI Automation, so it can't be detected;
  the UI tells the user not to dictate secrets.
- Typing into an app running as administrator is blocked by Windows.
- Each dictation uses one free AI request; Groq is fastest (~0.3–1.2 s), Gemini ~1–2.5 s.

## Where things are
`src/bar/`, `src/settings/`, `src/state/dictationState.ts`, `src/runtime-core/orchestrator/dictation.ts` and
`ai/prompts.ts` (DICTATION_SYSTEM), `electron/insert.cjs`, `electron/main.cjs` (two windows),
`scripts/check-dictation-live.cjs` (live AI check), `scripts/smoke-insert.cjs` (live typing check), `scripts/smoke-targeting.cjs` (live find/focus/write/verify check on Momo's own test windows), `scripts/check-stt.cjs` (speech speed and accuracy on a known sentence).

## Avatars (the two official designs)
`assets/avatars/dark` is the official 3D chibi design from the supplied sheet, shown unaltered (a second sheet, pink, was removed; see below for the video-cut girl). `src/character/AvatarView.tsx` animates them without redrawing: faces cross-fade; blinks lay the artist's closed-eye face over the lenses at random intervals; speech lays the artist's open-mouth face over the mouth, following the real voice; the figure breathes, tilts, bounces, droops or trembles per expression (`avatarRig.ts`); small symbols (? ! … ♪ 💢 💧 Zz) tell apart states that share one drawn face. Eye and mouth areas are measured fractions of each picture (`scripts/measure-avatar-offsets.cjs` checks that the faces line up). Honest limit: each sheet has only six drawn faces, so some states share a face and differ by pose and symbol. Each avatar has its own voice/speed/pitch (Windows voices, offline), independent of which avatar is shown. Sleepy appears after 3 quiet minutes.

### Speaking (replaces the old sprite mouth overlay)
The sprite avatars are flat pictures with six drawn faces, so their mouths cannot be animated honestly; pasting a mouth from another face
onto them showed up as a stray patch. Instead, while Momo speaks a white cloud beside the avatar shows the words being said, with the
current word highlighted from the speech engine's own word events (`src/character/SpeechCloud.tsx`), and the avatar wears the face that fits
the sentence being said (`textExpression.ts`: apology, good news, warning, question, "not found" ... with negation handled).
What Momo is DOING still wins for problems, decisions and questions. The drawn (SVG) character keeps a real moving mouth driven by the same events
(`speechMouth.ts`: 175 ms audio lag measured against the system output, per-word timing learned from the voice, closed in pauses and at once on
stop / pause / interrupt / error). `Speaker` (`src/voice/tts.ts`) reports start, word, pause, resume, interrupt and end, splits long text into
sentence-sized pieces, and has a watchdog for engines that never send "end".

### The GIF-style drawn face (dark avatar)
Following the supplied reference animation, the dark avatar's resting face gets eyelids and a small mouth DRAWN in place (`DRAW` in `avatarRig.ts`,
rendered by `AvatarView.tsx`), in the artwork's own measured skin tones: eyelids close inside the lenses over about 300 ms (ease shut, hold, ease open,
random intervals, sometimes a double blink); the mouth rests on a soft smile line, opens into a small dark mouth with a teeth highlight and tongue
following the real speech timing (`speechMouth.ts`), and returns to the smile the moment speech stops. The drawn face shows only over the resting
face; other expressions use their own drawn faces. The figure's box is sized to exactly the picture so everything placed as a fraction of it lands
precisely. (The pink avatar, which once had no `DRAW` entry, has since been removed from the project.)

## The video-reference avatar ("Black bob")

Five reference videos (`avatar/avatar/*.mp4`, 1080p, 10 s each, AI-rendered 3D) show two characters. The boy (black hoodie, rectangular glasses) is **exactly** Momo's existing `dark` avatar, same art as `assets/reference/avatar_sheet_dark.png`, so it was not duplicated. The girl (black bob, round glasses, cream puff-sleeve dress) existed nowhere in the project, so she was added as a separate option, **Black bob** (`art: "bob"`). Pink, Dark and Drawn are untouched and the default avatar is still Pink.

* **Source of her art:** six full-resolution stills of the video (`assets/reference/video/bob_<cell>.jpg`, from the studio-set clip `Avatar_speaking_text_0b5eaf1f`), cut out with `node scripts/cut-video-avatar.mjs` into `assets/avatars/bob/{full,head}/<cell>.png`. The cut removes the set, the plinth and its print, and keeps the shoes; it is the same technique as the sheets. Cells: `r1c1` resting closed smile, `r1c2` eyes-closed laugh with a hand out, `r1c3` wink, `r2c1` wide-eyed open-mouth talk, `r2c2` hands to the chest, `r2c3` relaxed smile with a hand on the hip.
* **Animation:** the same rig as the dark avatar: eyelids and a mouth DRAWN in place on the resting face (`DRAW.bob`, measured on her sprites, checked by a test), random blinks including quick double blinks, the mouth following the real speech timing and returning to the resting smile the instant speech ends or is interrupted, cross-faded expression cells, breathing/tilt/bounce poses.
* **Her own voice slot** (`voices.bob`); older saved preferences without it still load.

### What differs from the videos (honest)
* The videos are generated clips with a moving camera, pose changes and speech clouds rendered into the picture. Momo's avatars are live 2D cut-outs that animate in place; they do not reproduce the camera moves, the sparkles, or the continuous 3D motion of the clips.
* Her expressions are limited to the poses that exist in the clip: she has no sad, serious, thinking, angry or surprised face of her own (those states reuse a drawn pose plus Momo's symbols and body motion).
* **Hand gestures are only those inside the six cut poses** (hands to the chest, a hand out, a hand on the hip) and appear with the matching expression (friendly, happy/excited, calm). A waving pose exists in the clip only in frames where her feet are out of shot, and the boy's fists-at-chest and wave frames all have a speech cloud drawn over his hair or are cropped, so neither could be cut out cleanly. **The boy therefore has no hand gestures** (his sheet has the hands in his pockets), and the compact view never shows hands.
* The boy's blinking, eyes-closed smile, surprised face (wide eyes, round mouth) and mouth shapes come from the existing sheet and the DRAW rig, as before.

### Second pass (checked against the videos frame by frame)
* **The old "surprised" face of the Dark avatar had no glasses** (that sheet cell is drawn without them), unlike video 5. It was replaced by a pose cut from video 5 itself (`assets/reference/video/dark_s1.jpg` -> `dark/{head,full}/s1.png`, made by `scripts/cut-video-register.mjs`): wide eyes, worried brows, a small round mouth and sweat drops, with his glasses. The sheet art is untouched.
* **The sequence** (`SURPRISE_*` in `AvatarView.tsx`, timings read off video 5): wide eyes and the round mouth for ~1.4 s, the mouth relaxing into a smile over the next ~1.3 s (or following the speech if he is talking, as in the video), the whole face settling back to the normal one after ~3.2 s. His own round mouth is left alone until the surprise passes or he speaks; blinks are drawn over the glasses.
* **Black bob:** her poses are registered onto her resting sprite by her hair (same head size and position, no jumps), the flat-topped hair of the old `r2c1` is gone, and the legs that are out of shot in the waving frame are taken from her resting sprite (same character, same clip) and joined at the dress hem (`g1` = waving, used for the `friendly` greeting). Her mouth is now a smile-shaped opening with a teeth band and a tongue, measured on her speaking frames; it follows the real speech and returns to a soft smile line at the end.
* **Still not reproduced:** hand gestures for the boy (every frame where his hands are raised has a speech cloud over his hair, or is a close-up with the top of his head cut off, so there is nothing clean to cut out); drawn lip-sync on the girl's other poses (her resting face has it, the other poses keep their own mouths); the clips' camera moves, sparkles and clouds.

### Third pass (quality assurance against the videos)
* **Frames were sampled, not watched as video.** Frames of every clip were extracted with a hidden Electron window (no ffmpeg here) and compared at 0.1–0.2 s steps for videos 1 (2–7 s), 3 (0–9 s), 4 (3–10 s) and 5 (0.9–6.7 s), and every second for video 2. The audio-less clips were never played back at speed next to the app.
* **Dark hair now has glasses on every face I could cut cleanly.** The sheet's laughing and surprised cells are drawn without glasses; video 4's end frame (eyes-closed smile with blush, glasses on) is registered onto the resting sprite as \`h1\` and used for happy, excited and wink. Winking with one eye is not available (the only frame has sparkles stuck to the hair), so wink shows the closed-eye smile. The surprised face holds until ~6.8 s (video 5 keeps the sweat drops and wide eyes that long), then the normal face returns.
* **Black bob:** every pose is registered onto her resting sprite by her glasses (\`scripts/cut-video-register.mjs\` searches scale and shift until the dark glasses frames coincide), the head view uses the same transform, and her measured eyes and mouth are drawn over every pose, so blinking and lip-sync work on the gesture poses too (eyes are left alone on the laughing, winking and head-tilted poses, whose own eyes would clash). The thin dark strand on the right hair edge was a glossy hair highlight that the studio-set removal had eaten; a morphological opening now keeps thin bands. What remains is a real gap between two locks of hair.
* **Checked in the running app** (\`data-part\` markers on the drawn layers let a script read them): after speech, interrupted speech, expression changes during speech, compact/expanded switches during speech and rapid avatar switches, exactly one drawn layer is active, the mouth is back at rest, no cross-fade image is left behind and no path contains NaN. 126 size/avatar/view/expression combinations were measured at 760, 1000 and 1500 px: no sideways scroll; the only deviation is the girl's compact "wink" pose, whose rotated figure overshoots its box by more than 1 px at the two larger sizes (the amount was not measured).
* **Known differences:** the boy's laugh/surprised cell (\`h1\`) has no drawn lip-sync (the sheet art and the video frame keep their own mouth); the drawn mouths are simpler than the clips' 3D lips and the boy's open mouth is smaller than in video 5; the boy's normal face is the sheet's heavy-lidded one, while in the clips his normal face has round open eyes.

### Fourth pass
* **Tilt fit:** a tilted, breathing figure is lifted and shrunk (uniformly) just enough to stay inside its box (`fitFigure` in `AvatarView.tsx`). Measured at rest in the running preview (Dark hair and Black bob, compact and expanded, 7 expressions): idle, calm, friendly, wink and confused overshoot the box by 0–1 px. The deliberate "pop" of happy (~9 px), excited (~20 px) and surprised (~22 px) still rises above the box: that is their scale and bounce, not a fit error.
* **Pink hair was removed** at the owner's request; the default avatar is now Dark hair, and a saved choice of Pink loads as Dark hair.
* **Mouths:** the boy's open mouth uses proportions measured on video 5 (about 0.75 of the eye distance wide); the girl's uses video 3 (about 0.48 of the eye distance wide, at most a quarter of that tall). The boy's eyes-closed smile now lip-syncs with the glasses frame protected by a clip polygon.

### A voice of its own for each avatar
With no voice chosen in Settings, each avatar now speaks with a different installed Windows voice (`VOICE_HINTS` in `config.ts`, `pickVoice` in `voice/tts.ts`): Dark hair prefers a male voice (David, Mark, ...), Black bob a female one (Zira, Hazel, Aria, ...), and if none of those names is installed each takes its own slot among the installed voices. A voice chosen on the Character page always wins. Verified on this PC (installed: David, Mark, Zira, Ravi, Heera): Dark hair speaks as David (pitch 0.82, speed 0.95), Black bob as Zira (pitch 1.1). Voices are the PC's own; nothing is downloaded or sent anywhere.

### The girl's mouth (fix)
Her poses used to keep their own photographed mouth under a flat skin patch with the drawn mouth on top, which left double mouths and visible patches. Now `scripts/inpaint-bob-mouths.mjs` (run after `cut-video-avatar.mjs` and `cut-video-register.mjs`) erases the mouth from every pose sprite, filling the area smoothly from the surrounding skin and leaving the glasses frames and hair alone, and Momo draws the only mouth: a soft smile line with a pale lower-lip highlight when closed, and a smile-shaped opening with teeth and tongue when speaking, placed where that pose's own mouth was. Checked at 3x zoom in all seven poses, closed and speaking (friendly/wave and happy/laughing included). Limitation: her resting smile is now drawn, so it no longer shows the exact teeth gleam of the video frame.


### Online avatar voices (ElevenLabs, optional)
Dark hair (male) speaks with online voice `DODLEQrClDo8wCz460ld` and Black bob (female) with `4e32WqNVWRquDa1OcRYZ` (`CLOUD_VOICE_IDS` in `config.ts`), **only while an ElevenLabs key is saved** (Settings -> AI & keys -> Online avatar voices, or `ELEVENLABS_API_KEY` in `.env`) and the avatar's "Use online voice" switch is on (default on). With no key nothing is sent anywhere and the Windows voices speak, exactly as before.
* **Privacy:** what Momo SAYS (replies, the preview phrase, the teacher's English) is sent to ElevenLabs; what you dictate never is. The key stays in the desktop shell (`electron/main.cjs`, IPC `momo:tts-online`); the page only sends text and a voice id and gets mp3 bytes back, which are decoded and played in memory with Web Audio (no file and no URL; the shell's request code is `electron/onlineVoice.cjs`, pinned to api.elevenlabs.io and covered by the privacy audit). A daily character cap (`MOMO_VOICE_MAX_CHARS_PER_DAY`, default 3000) protects the free tier; only that day's count is stored (`voice-usage.json`, removed by "Delete everything").
* **Fallback:** no key, offline, 401, quota, a voice id the account cannot use, a timeout or an audio error all fall back to the Windows voice for that sentence (the Character page shows the reason after "Test this voice"). A Windows voice chosen by hand always wins.
* **Mouth:** the service returns no word timings, so `Speaker` spreads the words over the audio's real duration by their position in the text and feeds the same `MouthSync`; stop/replace/pause/resume work as for the Windows voices.
* **Free-only rule:** this is the one deliberate exception to "only free services" (the AI brain is still free-only; a test pins that). ElevenLabs has a free tier but needs an account and a key.
* **Tested:** the engine, fallback, word timing, pause/stop and the request code by unit tests with fakes; in the running app with no key (both avatars fell back to David and Zira and said why) and with a deliberately invalid key (the real request was rejected with a 401, shown as "The online voice key was rejected", and the Windows voice took over). **A successful ElevenLabs reply has NOT been heard here (no valid key), so the online voices themselves, their word timing against real audio and the daily budget counter after a success are untested.**
