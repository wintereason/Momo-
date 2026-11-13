# Momo as a dictation app (Wispr-Flow style)

## What the user sees
- **The bar**: a small pill at the bottom centre of the screen. It never takes focus and never catches clicks.
  Idle = three quiet dots. Listening = a live waveform. Then "Writing it down…", "Polishing…", and a short
  "Inserted" / "Copied" / problem message with one quiet detail line.
- **The Settings app** (opens when Momo starts; tray icon reopens it): Home, Dictation, Voice & microphone,
  Shortcut, AI & keys, Ask Momo (typed commands), Privacy & data.
- One calm look and no voice replies: Momo only writes text.

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
