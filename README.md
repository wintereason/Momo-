# Momo — Voice-to-text for Windows

**Current design:** hold a shortcut, speak, let go: Momo writes grammar-corrected, better-worded text into whatever app you are in, with a small Wispr-Flow-style bar at the bottom of the screen and one Settings app for everything. See `docs/07_DICTATION_APP.md`. Run it with `npm run desktop`; AI keys (free services only) go in `.env`.

> The text below describes the original idea (a chibi character companion). That interface is archived in `archive/character-companion/`.

Momo is a small animated chibi companion that sits on the Windows desktop (bottom-right, at its own table in a cherry-blossom theme). The user speaks (hold-to-talk or tap-to-toggle shortcut), and Momo understands the PC environment and does the **smallest necessary action** to fulfil the request, asks when unsure, asks permission for risky actions, and **verifies** results before showing success.

Five selectable companions share one engine: Gojo, Nezuko, Megumi, Klee, Mochi (names are configurable labels only).

## Folder map
```
momo-project/
├── README.md                      <- you are here (human overview)
├── AGENTS.md                      <- instructions for AI coding tools (READ FIRST)
├── CLAUDE.md                      <- pointer to AGENTS.md for Claude Code
├── docs/
│   ├── 01_CONCEPT_AND_ARCHITECTURE.md        <- the "brain": 9 agents, world model, safety, privacy
│   ├── 02_FRONTEND_UI_AND_BACKEND_WIRING.md  <- the "body": UI, voice, states, event contract
│   ├── 03_BUILD_ORDER.md                     <- single merged build plan (resolves phase conflict)
│   └── 04_OPEN_DECISIONS.md                  <- choices the AI must propose + user must approve
├── assets/
│   ├── reference/                 <- original images (visual reference only, NOT 3D models)
│   │   ├── character_sheet_expressions.png
│   │   ├── group_bench_scene.png
│   │   ├── avatar_sheet_pink.png  <- supplied 3x2 expression sheet (pink-haired girl)
│   │   └── avatar_sheet_dark.png  <- supplied 3x2 expression sheet (dark-haired boy)
│   ├── avatars/<art>/{head,full}/ <- cut-out sprites from those two sheets (checked in, built by a script)
│   ├── characters/<id>/           <- cut-out expression PNGs go here (see ASSET_GUIDE.md)
│   ├── scene/                     <- table, blossom backdrop
│   ├── models/                    <- future .glb files
│   ├── characters.manifest.json   <- characters, expressions, state->expression mapping
│   └── ASSET_GUIDE.md             <- naming rules and cut-out instructions
└── src/                           <- empty; code goes here after stack is approved
```

## Running it
```
npm install
npm run desktop    # the real app: transparent always-on-top widget (Electron), real runtime
npm run dev        # browser preview at http://localhost:5173 (demo only: scripted replies)
npm test           # the full test suite, including the privacy/security audit
npm run build      # typecheck + production build
```
The desktop shell is Electron (chosen over Tauri because it needs no Rust/C++ toolchain on this laptop).

## What Momo can do (Phases A to I)
Voice or typed requests, answered by deterministic handlers (no AI model yet):
drive space, window list, find/open folders, read a window (UI Automation, OCR fallback), list controls,
click/type/switch/minimize/close with verification, open apps and websites, open a folder in VS Code,
browser windows / tabs / pages, spoken replies, local Whisper speech recognition.
Every action asks first (risky ones always), and success is only reported after it was observed.

## Look and feel (Phase H)
Momo draws a real 3D scene (WebGL / Three.js): a lit wooden table with a bonsai blossom tree, mug and books, falling
cherry petals, and the character with state effects (mic waves, thought dots, stars and check, sweat drop, Zzz...).
- The character is the 2D art as a lit billboard, or a **3D model** if `assets/models/<id>.glb` exists (spec in
  `assets/models/README.md`); 13 animation clips map to the 13 states.
- Built for an integrated-graphics laptop: about 2 ms of CPU per frame, 30 fps when busy, about 10 fps idle, nothing
  when hidden or asleep, and an automatic fall-back to a light 2D view if frames get slow (Settings → Appearance).
- The 3D code is a separate lazily-loaded chunk, so the light mode never loads it.
- Check it for real: `electron scripts/check-scene-live.cjs <id> <2d|3d> [prod]` (screenshots + frame cost), then
  `node scripts/scene-contact-sheet.cjs <id> <view>`.

### Avatar art
The character on the bar can be the hand-drawn Momo or one of the two supplied 3D-style avatar sheets (pink-haired
girl, dark-haired boy). Settings → Character → **Avatar art** switches between `drawn`, `pink` and `dark`; `pink` is
the default.

- Each sheet is 3 columns × 2 rows = six drawn faces. Momo maps every semantic expression (listening, thinking,
  happy, sad, …) to the closest drawn face, so it never shows a face the artist did not draw. The compact bar uses a
  head-and-shoulders crop, the expanded bar and the Settings preview use the whole figure.
- The sprites are real cut-outs, not re-drawn code: `node scripts/cut-avatar-sheets.mjs` removes the studio set, the
  display base, its “AVATAR 3D” print and the sparkles, keeps the legs and shoes, and writes transparent PNGs to
  `assets/avatars/<art>/{head,full}/<cell>.png` plus `_check-<art>.png` contact sheets for a visual check.
- Choosing `drawn` brings back the original SVG character and its hairstyle/outfit options.

## Privacy and safety guarantees (each one is enforced by a test)
- Nothing is saved except settings, the window position, and the downloaded speech model. No audio, transcripts,
  screenshots or task history. (`src/audit/privacy.test.ts`)
- The only outgoing network connection is the one-time speech-model download from huggingface.co; everything else is
  cancelled by an allowlist in the desktop shell. (`electron/netpolicy.cjs`, verified live with `scripts/check-net-live.cjs`)
- Password boxes are never read or typed into, including old-style (WinForms/Win32) ones; card numbers, API keys and
  tokens seen on screen are redacted. (`src/runtime-core/redact.ts`)
- Programs are only started from the Windows app list, a verified folder, or a plain http(s) address, never through a shell.
- The temporary world model is wiped on exit and cannot be refilled afterwards; a hung task is abandoned after 90 s.
- Settings → Privacy → "Delete everything Momo stored" removes all of it.

## Real-machine checks (run these after changes to the Windows-facing code)
```
node scripts/check-agent-live.cjs    # the planner on real goals (read-only; actions stop at their confirmation card)
node scripts/check-agent-act.cjs     # opens, minimizes and closes Calculator, checking each result
node scripts/check-dictation-live.cjs # grammar and wording clean-up
node scripts/check-stt.cjs           # speech recognition speed and accuracy
npx electron scripts/smoke-insert.cjs # typing into another app
```

## How to use this folder
Give the whole folder to an AI coding tool and tell it:
> "Read AGENTS.md first, then everything it lists. Do not write code yet. Report your understanding, the open decisions with your recommendation, and your Phase A plan. Wait for my approval."

## API keys (`.env`) - free services only
A copy of `.env.example` is already at `.env` (git-ignored). **Nothing is required.** The AI brain, when built, will use ONE
free provider: Google Gemini (free tier, recommended), Groq (free tier), OpenRouter (":free" models) or local Ollama.
No paid service is supported. By default the AI would only ever see the words you said, never screen text
(`MOMO_AI_ALLOW_SCREEN_CONTEXT=false`), because free cloud tiers may log prompts.
The file is read only by the desktop shell; Settings -> Connections shows a tick or dash per key, never a value.
The AI keys are detected but **not used yet** (the AI feature isn't built).

## Install and use (Windows)
Build the installer once with `npm run dist` → `release/Momo Setup 0.1.0.exe`. Run it (no admin needed); Momo appears in the Start menu and on the desktop.
1. First run: Settings opens. Allow the microphone and accept the one-time speech-model download (~250 MB).
2. Click into any text box (browser, Notepad, VS Code, chat app), then hold the dictation shortcut (see Settings → Shortcut), speak, release.
3. Momo finds the text box, writes at your cursor and checks the text arrived. If it can't tell which box, it asks you.
4. Pick your language (Hindi etc. are written in their own script). For the best accuracy add a free `GROQ_API_KEY` and choose *Cloud speech*. Momo starts with Windows and waits in the tray (turn off in General).
4. Optional AI polish: put a free key in `%APPDATA%\Momo\.env` (see `.env.example`), then Settings → AI & keys → Re-read .env.
Not code-signed yet: Windows SmartScreen may show "unknown publisher" (More info → Run anyway).
