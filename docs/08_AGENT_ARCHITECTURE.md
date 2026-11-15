# Momo's architecture: a goal-driven agent (follows `docs/Momo_Desktop_AI_Agent_Concept.md`)

Momo has ONE way of getting things done. There are no per-task handlers and no phrase router.

```
user (voice goal on the Ask Momo shortcut, or typed in Settings → Ask Momo)
        │
        ▼
 ┌──────────────────────── Orchestrator (orchestrator/agent.ts) ─────────────────────────┐
 │  owns the goal, the step log, uncertainty, permissions and the final answer           │
 │                                                                                       │
 │   Planner (the AI, ai/service.ts `plan`)  ──one next move──►  tool call               │
 │        ▲                                                       │                      │
 │        │ observation (fenced as untrusted data)                ▼                      │
 │   step log  ◄── Verification ◄── Specialist role runs the tool ◄── Permission gate   │
 │                                                    (ask the user if it is a decision) │
 └───────────────────────────────────────────────────────────────────────────────────────┘
        │                       shared temporary World Model (verifier/worldModel.ts)
        ▼
 final answer: "completed" only for verified results; otherwise partial / failed / an AI answer
```

## The loop (one goal)
1. **Plan.** The AI sees the goal and what has happened so far and replies with exactly ONE move: a tool call, a
   question for the user, `done`, or `fail` (strict JSON schema; anything else is discarded).
2. **Validate.** Momo (not the AI) checks the tool exists and its arguments fit the tool's strict schema.
3. **Gate.** The tool's risk (`read`, `sensitive_read`, `reversible`, `consequential`) goes through `decide()`. Decisions
   (closing a window, clicking Send/Delete/Save/Pay…, an account guessed from a picture, sending screen contents to an
   online AI) always ask; small things ask only if the user's settings say so.
4. **Act.** The specialist role runs it (File System, Desktop, Visual Perception, UI & Panel, Application, Browser, Action).
5. **Verify.** Every tool checks its own result with the Verifier (a new window appeared, Windows says the window closed,
   the field reads back, the browser shows the site…). A result that cannot be confirmed is `unverified`.
6. **Observe / recover.** The result goes back to the planner. It can retry differently, ask, or give up. Guards: the same
   call twice with nothing changed in between is refused; 4 failures or 10 moves end the goal honestly.
7. **Finish.** `task.completed` (verified) only if every step that ran was verified. Otherwise `partial_success`.
   A goal that needed no tool is an `task.answer` (labelled as an AI answer).

## Specialist roles → tools (`orchestrator/tools.ts`)
| Role | Tools |
|---|---|
| File System | `drive_info`, `find_paths` (files and folders, with full paths) |
| Desktop + UI & Panel | `list_windows`, `look_screen`, `understand_screen` (what every control is FOR), `inspect_component` (look closer at one: OCR, then a visual AI if the user allows) (every window with its state, front to back, plus what the front window shows: address/title, controls, listed items) |
| UI & Panel + Visual Perception | `read_window` (UI Automation text, OCR fallback; password boxes never read) |
| Action | `open_path` (a file or folder), `focus_window`, `minimize_window`, `close_window`, `click_control` (`open:true` double-clicks an item), `type_text`, `select_field`, `press_enter` |
| Application | `open_app` (with browser `account` + `url`), `open_url` |
| Browser | `browser_accounts`, `list_tabs`, `switch_tab` |
| Verification | built into every tool (and `Verifier`), plus the final check in the orchestrator |

There is no tool to send, delete, buy, install or download: Momo cannot do those things.

## Voice fields: "select the search bar" → dictate → "search"
Three presses, no phrase router (the planner chooses the tools):
1. **Ask Momo shortcut**: "select the search bar" → `select_field` finds the field by its UI Automation name ("the search bar" also matches a field just called "Search"), asks if several match, refuses password fields, and returns success only after Windows reports THAT field has the keyboard focus.
2. **Dictate shortcut**: the field already has the cursor, so the dictation pipeline writes into it (Detect → Identify → Focus → Dictate → Verify).
3. **Ask Momo shortcut**: "search" / "okay" / "go" → `press_enter` presses Enter only in the text field that has the cursor, and only if it is still the identified one. In a search or address box it just runs; in any other field (it could send a message) it asks first. It is verified by the box or page title changing; if nothing visibly changed it says so instead of claiming success.
Dictated words themselves are still never obeyed as commands.

## The shadow cursor
While a task runs, a transparent click-through window (`electron/shadowCursor.cjs`, `src/cursor/`) shows a ghost pointer that starts at your real mouse position and glides to each control Momo acts on (`cursor.move` events from the tools, in UI Automation's physical pixels, converted per display). It exists only during a task and fades out ~1.6 s after it. The ghost itself is only drawn (it never clicks); with **Human-like control** on (see below) the REAL pointer travels with it and does the click. Settings → General → Shadow cursor turns the ghost off.

## Opening files and folders: clear target = execute, several = ask
`open_path` is one tool the planner calls with the user's own words. Momo searches (files and folders, user profile first):
* **one clear match** (a unique exact name beats longer partial matches) → opens it **immediately**, with no confirmation;
* **several matches** → the orchestrator shows **all of them with names and full paths** (as text, as buttons on the bar,
  and read aloud) and the user picks by **click or by voice** ("the second one", "the one in Documents"); the chosen one opens at once;
* **every opening is verified**: a folder by its Explorer window, a file by a window that shows its name. Not seen = "not confirmed";
* the only confirmation is for a **decision**: opening a *program* (.exe, .bat, .ps1, .msi, .lnk…) runs it, so that asks.
Spoken replies (the PC's own voices, off-switch in Settings → Voice): announces what it is opening, confirms what it verified,
explains what failed, and reads out the options when it asks which one.

## "Ask, never guess"
A tool that finds several matches returns `ambiguous`; the **orchestrator** asks the user (windows, controls, tabs, apps,
browser accounts) and re-runs the same call with the chosen one. The AI never sees the account emails the user is asked
to choose between.

## Privacy rules
* The AI receives only the goal's words and Momo's fenced observations. Tools marked `sensitive` (window titles and text,
  tab titles, account emails) are **withheld from an online AI** unless the user set `MOMO_AI_ALLOW_SCREEN_CONTEXT=true`;
  then the user gets the result directly, exactly as read. With a local AI (Ollama) they are shared, and with an online
  AI that was allowed, each such read is a confirmed decision.
* Everything from the PC is untrusted data inside `<observation>` tags; the planner is told never to obey it.
* Free AI services only; a daily request cap (each planner turn is one request); no key ever in a URL.

## The World Model
`verifier/worldModel.ts`: an in-memory graph of windows, controls, drives, folders and screens with the source, time and
confidence of every observation. Agents write to it as they observe; an action invalidates what it may have changed; it is
never written to disk and `Session.dispose()` empties it on exit (tested).

## The bar (`src/bar/`)
A passive pill at the bottom of the screen. **Dictate shortcut**: speak → local Whisper → AI polishes → pasted into the app
in front. **Ask Momo shortcut**: speak a goal → the agent runs; the bar shows each step; decisions and questions appear as a
card with Yes/No (or answer by holding the Ask Momo shortcut and speaking). The bar only accepts clicks while it shows a card.
Typed goals work too: Settings → Ask Momo.

## Removed in this rebuild
`orchestrator/intent.ts` (the phrase router with 20 hardcoded intents), the old `orchestrator.ts` (about 1,200 lines of
per-task handlers: open app, open url, list tabs, accounts, windows, controls, folders, drive space…), the
`interpret`/`explain` AI calls and their action schema, and the tests that drove them (kept in `archive/legacy-intent-system/`
for reference; they are not compiled or run).

### Choosing between look-alike boxes, and acting it out
* `select_field` only considers boxes that are **shown** (not hidden, not scrolled out of the window, not a sliver). If several match (two "Search" boxes), Momo asks which one and describes each by **where it is and which panel it sits in** ("top centre · in “Toolbar”", "left side · in “Sidebar”"). The exact box that is picked is remembered (runtime id + on-screen box), so the answer selects it directly instead of searching by name again.
* **Opening things is acted out, then done.** With the shadow cursor on, `open_app`, `open_url` and `open_path` first walk the ghost through what a person would do, one step at a time, using the real positions read from the taskbar with UI Automation: click the app's taskbar icon, or click Start → type the name → press Enter; for a website, the browser's taskbar icon, then the address bar (type the site, Enter). Then Momo does the real, verified action directly (a launch call), and the ghost glides to the window that appeared. The ghost only draws those Start-menu/address-bar steps (an app with a taskbar button is different: see Human-like control). With the shadow cursor off none of these steps run.


## Human-like control: observe → decide → act → observe again
Settings → General → **Human-like control** (default on) lets Momo use the REAL mouse and keyboard the way a person does. It is a narrow, guarded tool (`electron/humanInput.cjs`, the `PointerPort`), not a remote control:
* **Observe.** `look_screen` lists every top-level window with its state (in front / open / maximized / minimized, front to back, from `EnumWindows`, `IsIconic`, `IsZoomed`) and what the front window shows right now (title/address, controls, listed items such as drives and folders, read with UI Automation). The planner is told to call it before choosing a click and after every change, so each move comes from the latest screen, never from a fixed script.
* **Already running = reuse.** `open_app` first looks at the windows: if the app is running, its window is brought forward (a minimized one is restored) instead of starting another copy; a second copy only with `newWindow:true`. With one window it clicks the app's **taskbar button** with the real pointer; otherwise (several windows, taskbar covered, or the click did nothing) Windows is asked to bring the front-most window forward. Every result is checked with Windows (in front, not minimized).
* **Acting.** `click_control` (also `open:true` = double-click), `select_field` and `type_text` bring the window forward, read it again if it moved, glide the real pointer to the identified control (the ghost glides with it), click, and verify with fresh UI Automation (focus really moved / the field reads back / the window changed). `type_text` clicks the field, selects its text and types it key by key; if the read-back is wrong it sets the text through UI Automation instead.
* **Guards (all in `humanInput.cjs` and `tools.ts`).** Never on an unidentified control, password field or minimized/hidden window; the window under the pointer when it arrives must be the identified one (or, for the taskbar, a `Shell_TrayWnd` window, so a full-screen app covering the taskbar is refused, not clicked); consequential labels still ask first; if the click is refused ("covered") UI Automation does it instead; **if the user moves the mouse or presses Esc the task stops at once** and nothing else is done.
* Coordinates are physical pixels (UI Automation's); the pointer asks Windows for per-monitor DPI awareness itself.
* Turning it off puts Momo back to acting only through UI Automation, with the ghost only drawing.
* Verification limits: a click is "confirmed" when the window's controls changed afterwards. That does not prove it did what was intended, which is why the planner observes again before deciding the next step. Online AIs only see `look_screen` results when `MOMO_AI_ALLOW_SCREEN_CONTEXT=true` (window titles are private); a local AI always does.
* Live checks: `scripts/live-desktop-control.cjs` runs the loop on the real desktop (reuse of a minimized app, then File Explorer: running window reused → observe → real double-click → observe).


## Understanding controls: what they are FOR, not only what they are called
`uipanel/understand.ts` (pure, tested) works out, for each control, **what it is for, what it searches, what using it will do, how sure Momo is and where the evidence came from**. `understand_screen` shows it for a whole window; every interaction tool uses it before acting.
* **Evidence, strongest first:** (1) the application's own UI Automation metadata: patterns (Toggle, Expand/Collapse, Value, Grid/Table item), AutomationId, class, help text, the label the app tied to a field, expanded/selected state; (2) the label (only well-established UI words, and only when the verb LEADS the label, so "View site information" is not a "change the view" button); (3) the surroundings: the caption next to a field, the named panel it sits in, the program and the window title (a search box inside File Explorer that says "Search Project 2" searches inside that folder; a browser's omnibox is both address and web search; a box inside a "Sidebar" section searches that section); (4) a picture of it: OCR of its box on this PC, then, only if allowed, a visual AI. Every line says which of these it rests on.
* **Never guess.** If nothing explains a control (an icon-only button, a search box whose target is not stated) it is "purpose UNKNOWN" / "NOT SURE", not a made-up meaning. Momo then reads its picture locally (OCR: nothing leaves the PC). Text from a picture alone, or an answer from a visual AI, is capped below "sure": acting on it still asks the user first.
* **Before interacting:** `click_control` identifies the target and what it does. A control picked by position (`ref`, how unlabeled controls are addressed) or with unknown purpose is looked at more closely, and if still unclear the user is asked ("Momo isn't sure what it does: ..."). `select_field` lists every search box on screen when you say "the search bar" and describes each by what it searches. `press_enter` runs at once only in a box understood to be a search/address box.
* **After interacting:** the effect it was understood to have is checked, not just "something changed": a switch must have flipped, a menu button must report expanded (or new entries must appear). A breadcrumb/split button counts as its main action, not a menu.
* **Visual AI (optional, off by default):** `inspect_component({visual:true})` can show ONE small cropped picture of ONE control (no window title, no other text) to a vision model (Gemini, Groq's llama-4-scout, or a local Ollama "llava"; `MOMO_AI_MODEL_VISION` overrides). An online provider qualifies only with `MOMO_AI_ALLOW_SCREEN_CONTEXT=true`, and even then the user is asked before each picture leaves the PC. Its reply is parsed against a strict shape and treated as data. Verified on fakes only: no picture has been sent to a real provider.
* **World Model:** each understood control is kept as a `control` entity (purpose, scope, effect, basis, confidence; source uia/ocr/vision), replaced whenever the window is read again.


## Application management: reuse, ask when unclear
`open_app` first looks at the real windows (`EnumWindows`: visible or minimized, titled, not hidden UWP shells; each with state and z-order, plus every running program name) and decides:
* **not running** (no window, no process of that name) -> launch, verified by a new window; **explicit `newWindow:true`** -> launch another copy.
* **one window** -> bring that one forward (restoring it if minimized; a maximized window stays maximized). With one window and the taskbar readable it clicks the app's taskbar button with the real pointer; otherwise (or if that does nothing) Windows is asked. Checked with Windows (in front, not minimized).
* **several windows** -> if one is already in front, that is the one in use (it says the others exist). If none is in front it does NOT guess: it **asks which**, listing each window with its state ("minimized", "open behind other windows"). The user can answer, or the request can carry a `window` hint (part of the title) that picks one without asking; a hint matching several windows still asks.
* **running in the background with no window** (a tray app) -> recognised from the program list; the app is asked to come up (a launch call, which single-instance apps answer by showing their running copy) and the answer says it was already running. Not verified on a real tray app (see test notes).

## The shadow cursor now mirrors the real pointer
Events: `cursor.aim` (the exact element's box, with what it is for, BEFORE anything moves), the pointer's own positions (`track`, streamed by `humanInput.cjs` straight to the overlay, not through the runtime events), `cursor.result` (verifying / verified / unconfirmed / failed) and a user `stop`.
* **Context-aware:** the label comes from the understanding of the control ("Clicking “Sort”: opens a menu or a list of options"), the highlight kind from its role (button, search, input, menu, list).
* **Synchronised:** in human-like control the ghost sits at each REAL pointer position (many updates per second, no easing of its own, arrow tip on the pointer's hotspot): hover when it arrives, the ring at the moment the button really goes down, each typed letter in its bubble when it is really typed. Without human-like control it glides on its own, as before.
* **Honest results:** the orchestrator sends the verdict right after the tool's own verification: verified = green check with the evidence ("it reports being expanded now"); done but not confirmed = amber "Not confirmed"; failed = red with the reason. A task that finished with an unconfirmed step is never shown as "Done" (partial success shows "Finished, but not everything was confirmed"). "Checking…" is shown while the screen is re-read.
* **The user always wins:** while a task is armed, a watchdog notices the physical mouse moving away from where Momo left it, or Esc, during the glide, while typing and BETWEEN steps; then the whole task is cancelled (not just the click), the ghost shows "Stopped: you moved the mouse / pressed Esc", nothing later (not even the task's own ending) overrides that, and the bar is told. It is disarmed while Momo waits for your answer, so clicking Confirm is not a takeover.
* **Changing windows:** the window's box is captured before the controls are read; the pointer refuses to press if the window has moved (and re-reads and re-aims once). A covered target is refused; DPI/multi-monitor: positions are physical pixels converted per display; the overlay raises itself above always-on-top windows on each aim, press and result.
* Evidence: `scripts/live-apps.cjs` (real Calculator, Explorer, Notepad windows), `scripts/live-cursor-sync.cjs` (real overlay + real pointer + real input, with takeover latency), `scripts/live-understand-act.cjs` (real tools on a real Explorer window).

## Real mouse and keyboard, and how Momo checks the screen (interaction upgrade)

One cycle for every action on the desktop: **observe → understand → plan → validate → move → act → observe again → verify.** Nothing here is a separate automation system: the tools below are ordinary orchestrator tools (`src/runtime-core/orchestrator/tools.ts`) that use the same UI Agent (UI Automation first, local OCR as the fallback), Action Agent, World Model and shadow cursor, and the same `PointerPort` (`electron/humanInput.cjs`).

- **Look before acting.** Tools that act on a control first glance at the visible windows and settle on the target window (`lookAround`, a `cursor.window` "look" event), then read that window fresh. Simple actions do not scan; the glance is only a show for the shadow cursor and costs nothing when it is off.
- **Tools (Human-like control on):** `scroll_window`, `right_click`, `drag_drop` (always asks first), `press_keys` (shortcuts; Win+L, Win+R, Win+X, Ctrl+Alt+Del, Ctrl+Shift+Esc and Alt+Tab are refused; closing / deleting / pasting / saving / sending shortcuts ask first), `select_text` (all / word), `arrange_window` (snap left/right, maximize, restore, via Win+arrow keys), `click_text` (the OCR fallback: reads the words on the window with their screen boxes and clicks the exact words, only after `click_control` found no such control). Existing tools (`click_control` incl. double-click, `type_text`, `select_field`, `press_enter`, window tools) are unchanged.
- **No stale coordinates.** Controls and OCR words are read fresh for every action; the click is refused if the window moved or something else is on top of the spot (`expectRoot` / `expectWindow`), then read again once. `isFront` now also asks Windows which window is really on top, not only which program owns the foreground.
- **Verification.** Each tool reads the screen again and says "verified" only when the second look shows it (a menu appeared, a new window opened, the item left the list, the window's rectangle changed, the field read back). Otherwise it reports "could not confirm". A new window appearing after an action (dialog, menu) is part of the evidence and is mentioned.
- **Safety.** Show Only and Human-like control stay separate modes (the new tools need the real pointer and say so when it is off). Esc or moving the real mouse stops everything at once, a held mouse button is always released, and Momo's own Esc keystroke is ignored by the watchdog for half a second. No key or click goes to a password field (`UiReadResult.passwordFocused`).
- **Limits (honest):** Windows does not report which text is selected, so `select_text` can confirm only that the field has the cursor. Window snapping uses the keyboard, not dragging the title bar or edges. OCR needs a Windows language pack and cannot read text a program draws outside its window capture.

### Observation helper (interaction upgrade, phase 1)

`src/runtime-core/shared/uiaHelper.ts` keeps ONE long-lived Windows PowerShell 5.1 host running (compiled C# inside, nothing to install) and answers UI Automation reads and window lists over stdin/stdout. It is only an accelerator: if it is off (`MOMO_UIA_HELPER=0`), still starting, crashes, hangs (20 s) or cannot start (a 60 s cool-off), the same answer comes from the old one-shot script, and the helper restarts later. Measured on a real PC (steady state): window list ~900 ms → ~6 ms; Settings read ~2.2 s → ~0.25 s; Explorer ~2.0 s → ~0.3-0.45 s; Orca ~2.8 s → ~0.4 s; Chrome ~4.8 s → ~1.0 s.

- Launched as `-File` from a content-hashed copy in the per-user temp folder (`%TEMP%\momo-helper\uia-<hash>.ps1`): a base64 "Invoke-Expression" launcher was refused by Windows Defender (spawn EPERM), and the script exceeds the 32 KB command-line limit. The file is rewritten if its content is not exactly ours. It contains no network or file-writing code (tested).
- Same walker as before (`ControlViewWalker`), with each element's properties fetched in one batched call. Same fields, same caps. It returns a **superset** of the old reader on some windows (Explorer's real navigation tree instead of a "Navigation Pane" stub; caption buttons on Settings/Firefox). Elements with no control type (Explorer's toolbars) get an empty type, never dropped.
- Never keeps its parent alive (handles are unref'd) and exits when its stdin closes or after 5 idle minutes. Started in the background when the runtime is created (`uiaHost.warm()`); its first start compiles for about a second.

## Change detection instead of fixed pauses (phase 2)

Before, every verified action ended with a fixed sleep (400-1000 ms) and then one look. Now it ends with a **timed condition wait**: look
at once, and look again when Windows reports a change, until the effect shows or a time limit passes.

**Event source.** The Phase 1 helper also runs a `MomoEvents` thread: three out-of-context `SetWinEventHook`s (foreground, menu/dialog/scroll/
minimize/move, window create/destroy/show/hide, focus, selection, state/name/value changes) feeding a message loop. It pushes `@@!E {n, e:[[kind, rootHwnd]...]}`
lines, coalesced every 40 ms. Only a kind and a window handle: never titles, text, pixels or UI trees; windows that are parts of other windows,
the mouse cursor and the caret are dropped. Nothing is written anywhere; Node keeps the last 64 batches in memory.

**Lifecycle.** Events are off until something waits (`acquire()` sends `events on`) and are switched off 10 s after the last wait ends (`events off`).
A helper restart, crash, timeout or idle stop sets events to "not healthy" and nothing pretends they are still on.

**Health = heartbeat.** About once a second the timer posts a message to the hook thread's message loop; only if the loop answers is `@@!H`
sent. Without a recent heartbeat (3.5 s) `healthy()` is false and waits poll. A batch that overflowed is reported as a `many` change, not silence.

**`waitFor(check, {timeoutMs, pollMs, fallbackMs, source, relevant})`** (`shared/changeWatch.ts`). The caller's `check` (a real read of the screen) always decides;
an event only says "look now". Healthy: wake on a relevant event (+40 ms settle), or on the fallback timer (250-600 ms) in case an event was lost; a change
that lands while a look is running is looked at again at once. Unhealthy or no source or a source that throws: plain polling. Always: a hard timeout,
reported as `timedOut`, never as success; cancel is honoured; the hook is released in `finally`. Time spent counts requested waits, so fake sleeps in tests cannot spin.

**Use in the tools.** `until()` wraps it. Replaced fixed pauses: open file/folder/app/page, focus/minimize/close, bring-to-front (also waits for the window to stop moving
before coordinates are used), taskbar launch, typing read-back, snap/arrange, and the "did the screen change" look after click, scroll, right-click, drag, keys and OCR click
(`untilChanged`: a change counts once it has held still, judged by a quiet event stream when events are healthy, else by a second identical look). Not replaced: the
shadow cursor's lead time (a show for the user, not a post-action delay).

**Window state through the helper.** `InputPort.windowState` was a one-shot PowerShell (~0.9 s per look), which made every polled look slow. The helper now answers `state <hwnd>` in ~1 ms
(the one-shot script remains the fallback).

**Fixed on the way.** `arrange_window restore` pressed Win+Down on a window that was not maximized, which MINIMIZES it, and reported success because the rectangle changed. It now checks the real
state, reports it as not done and brings the window back. Scroll is judged on nearly every visible control (not the first 40, which in a browser are the toolbar).
