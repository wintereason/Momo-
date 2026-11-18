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
While a task runs, a transparent click-through window (`electron/shadowCursor.cjs`, `src/cursor/`) shows a ghost pointer that starts at your real mouse position and glides to each control Momo acts on (`cursor.move` events from the tools, in UI Automation's physical pixels, converted per display). It exists only during a task and fades out ~1.6 s after it. The ghost itself is only drawn (it never clicks); with **Human-like control** on (see below) the REAL pointer travels with it and does the click. The ghost never acts out steps Momo does not really take: there are no scripted taskbar, Start-menu or address-bar walkthroughs, only real targets are shown. Settings → General → Shadow cursor turns the ghost off.

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

### Choosing between look-alike boxes, and opening things
* `select_field` only considers boxes that are **shown** (not hidden, not scrolled out of the window, not a sliver). If several match (two "Search" boxes), Momo asks which one and describes each by **where it is and which panel it sits in** ("top centre · in “Toolbar”", "left side · in “Sidebar”"). The exact box that is picked is remembered (runtime id + on-screen box), so the answer selects it directly instead of searching by name again.
* **Opening things starts from where the screen already is; there is no scripted demo.** `open_app`, `open_url` and `open_path` do not walk the ghost through taskbar clicks, the Start menu or the address bar: Momo never takes those steps, so it does not draw them (the old scripted walkthrough was removed). Momo first checks what is already open and reuses it (see “Already running = reuse” below and “Application management”), then makes the real, verified call: a launch call or, with Human-like control on and for an app, the real pointer on its taskbar button. The planner is told the same (prompt rule 7g): start from the first step still needed (a site that is already showing goes straight to its search box), and do not ask which browser, window or account when one is already in use. An explicitly requested new window (`newWindow:true`) is still supported. The ghost only aims at real targets: the control or the window Momo is about to act in.


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
* **several windows** -> the one in use is picked without asking: the window in front, else the one the user was in before turning to Momo (Momo's own bar may hold the focus), else the front-most window that is not minimized (it says the others exist). Momo asks **which** only when none of those can be picked (for example every window is minimized) or when a `window` hint does not settle it: it lists each window with its state ("minimized", "open behind other windows"), the user can answer, and a hint (part of the title) that matches several windows still asks.
* **a browser that is already open, no account named** -> Momo does not ask which account to start. With a website (`url`) the running browser takes the address as a new tab of its window (which window and account it lands in is the browser's choice, normally the one last used). An account the user names (`account`) is still honoured, and a browser that is not running, with several accounts and none named, still asks which. `newWindow:true` asks the browser for a separate window (`--new-window`) instead of a tab.
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

- **Look before acting.** Tools that act on a control first aim at the window they are about to act in (`lookAround`, a `cursor.window` "look" event), then read that window fresh. Momo does not glance at other windows or act out steps first: that was a scripted show and was removed. Simple actions do not scan; the aim is only for the shadow cursor and costs nothing when it is off.
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

## Input safety (phase 3)

Momo holds real buttons and keys while it acts (a click holds the left button for 45 ms; a drag holds it for the whole drag; Ctrl+A holds Ctrl). The rule of this phase: **an operation may fail, be cancelled or be killed, but it must never leave anything held down, and it must never act on something that is no longer what it meant.** Everything here is in `electron/humanInput.cjs`; the companion is `electron/deadman.cjs`.

- **The ledger.** A button or key is written into a ledger (`heldButtons`, `heldKeys`) *before* it is sent, so even a native call that throws after taking effect is known and released. Every operation runs inside `guarded()`: whatever happens, it ends with `releaseAll()`, which releases only what Momo itself pressed, in reverse order (modifiers last), and is idempotent. A press that Windows refused is removed again; a press that may have gone through stays recorded.
- **Never touch the user's hand.** If the user already holds that button or key, Momo does not press it at all (`user_holding` → the task stops). `releaseAll()` never releases a button or key that is not in the ledger, so a button the user is holding stays down.
- **The user wins, always.** The watch loop (~40 ms) and every glide step check Esc, the physical pointer compared with where Windows actually put it (28 px), a held mouse button and a held modifier. `main.cjs` also feeds the existing global input hook into `userSignal(kind)`: Esc, a wheel turn, a click or any keypress stops the task. Only the *kind* is passed (never which key), and Momo's own input is ignored for 400 ms, so a click it just made, or its own Esc during a drag cancel, cannot stop itself. Keys used by the voice shortcut are filtered by the hook before this point. Stopping runs the stop hooks first (a drag is cancelled, not dropped), then `releaseAll()`, then `onInterrupt` — which tells the bar and `cancelTask()`; `stopped` is sticky until the next `arm()`.
- **Abort.** `abort("cancel" | "quit")` is the app's own stop (Cancel, quitting, an uncaught error): same release path, but nobody took the mouse, so the shadow cursor does not claim a takeover. `"quit"` also makes the pointer dead for good.
- **Watchdog.** Anything held longer than 1.5 s without a heartbeat, or 10 s in total, or whose release failed, is released and reported (`onRelease`). A stuck button is the worst outcome, so it is treated as one.
- **Drag is cancelled, not dropped.** On any stop (Esc, the user's hand, abort, the source/drop window closing, something covering the drop point) a drag cancels the drop *before* letting go of the button. The default strategy `"esc"` sends Windows' own cancel keystroke, so the item is not dropped wherever the pointer happens to be; `"origin"` glides back to the start instead, and `"esc+origin"` does both. When the *user* is the cause, the pointer is never moved (it is theirs now) — only Esc is sent. The drag also samples the source window and the drop point during the move.
- **Last look before the press.** `beforePress()` re-checks, on the exact point that will be clicked: the window under the pointer, the window class, that the target window has not moved (>3 px) or closed, that the user has not touched anything, and the caller's own `verifyTarget` check. A check that throws is *not* a pass. After the async check the synchronous checks run again. Tools pass `at`-based checks (`uiaHelper`'s `at x y`, ~12 ms) and fall back to a slow re-read if it cannot answer; a password field returns "never touch".
- **Monitors.** A point on no monitor (off the edge or in a gap between displays) is refused as `offscreen` before the glide; a pointer that another program has confined is `cursor_refused`; a glide where Windows keeps putting the pointer somewhere else, or moves it in a way the user did not, is told apart (a small landing difference from scaling is accepted as "where it is").
- **Typing and scrolling guards.** Typing stops (`focus_changed`) the moment another window has the keyboard, and (`gone`) if the target window closes — nothing more is typed either way. Scrolling refuses (`covered`) when a window has opened over the page, so Momo never scrolls something it did not mean to.
- **Interruption diagnostics.** Every stop records its cause, distance and the last few pointer positions in memory (`lastInterrupt`), so a false "you moved the mouse" can be explained afterwards. Nothing is written to disk. (One real data point: Windows reported 226 s since the last input during a test, which is what pointed away from the user being the cause.)
- **Dead-man companion.** `electron/deadman.cjs` is a tiny second process started with the real pointer. It knows only what is *currently* held — button names and virtual-key codes, never text, names or positions — mirrored over Electron's private IPC on every press and release. If the main process is killed outright (crash, Task Manager, forced sleep), its `exit` handlers never run; the IPC channel then closes and the companion releases exactly that list and exits. While the app runs it does nothing. It cannot start? The app works as before; this is a last line of defence, not a dependency. The companion is `unref`'d, so it never keeps the app alive.
- **Right-click reads only the menu.** A context menu is its own small top-level window under the pointer, so after the click `popupWindow()` samples `windowAt` near the click point, waits up to ~700 ms for that window, and reads *only it*; if none appears (an app that draws its menu inside its own window) it falls back to the old whole-window `untilChanged`. The window it belongs to is still read once, before the click.
- **Honest limits.** Escape-based drag cancel is the default because that is how Windows cancels a drag; it is now confirmed on a real Explorer file drag (the file was not moved). A real context-menu read still costs ~0.8 s on a WPF popup (~2.3 s for the whole right-click path including the menu appearing), better than the old ~2 s per re-read but not milliseconds; the helper's `uia` read of a large app (Chrome, Orca) is what made the old path slow. Monitor edges, gaps and mixed-DPI behaviour are proven with simulated layouts — this PC has one display at 200%. The global hook's own privacy rule is unchanged: Momo learns *that* you typed, not what.
- **Evidence.** Unit tests: `electron/humanInputSafety.test.mjs` (a fault matrix: 9 operations × 11 native calls × failure before/after the effect × 30 call positions, plus user-held inputs, cancel, drag, last look, monitors, typing; 237 tests), `electron/deadman.test.mjs` (release exactly what was held, failure isolation, a real companion process exiting cleanly), and the 25 original pointer tests. Real Windows: `node scripts/live-safety.cjs` (7/7 — 12 real clicks with an empty ledger after each, typing landing with nothing held, a real context menu found and read on its own, typing refused when unfocused, Esc mid-drag on a real file leaving the file in place, and Windows itself reporting no stuck button or key). Real takeover and ghost tracking remain in `scripts/live-cursor-sync.cjs`.

## Input safety and coordinate reliability (phase 3)

**Ledger.** `humanInput.cjs` records every mouse button and key Momo presses the moment it goes down. `releaseAll()` (idempotent) lets go of exactly that and
nothing else; every operation ends with it, an exception becomes a failed result, and a watchdog frees anything held after a stalled operation (1.5 s without a heartbeat,
10 s absolute) or whose release failed. A button or modifier the USER holds is never pressed over or released: it stops the task instead.

**Abort.** `pointer.abort("cancel" | "quit")` (Cancel button, quitting) stops operations in flight and releases at once; `main.cjs` also releases on `before-quit`, `uncaughtException` and process exit.

**Interrupted drag.** Tested on real Explorer: Esc cancels the drag; returning to the origin and releasing there DROPPED the file into a folder the user had moved the pointer over. So Esc is always sent first
(`esc+origin` only adds a return for app-initiated stops), the drag is also cancelled if either window closes or the drop point is covered, and a last drop check runs before the button is released.

**Last look before a press.** window under the pointer, target window moved/closed, user input, and a target check on the exact point (`at x y` in the helper: the control under the point and its parents, ~12 ms,
password fields refused; slow re-read as fallback; a check that cannot run is not a pass). New failure reasons: gone, changed, password, offscreen, cursor_refused, focus_changed, cancelled.

**Monitors.** Points on no monitor (off the edge, in a gap) are refused as `offscreen`, a pointer confined by another program as `cursor_refused`; where Windows lands the pointer is where it IS (scaling rounding), so it is not mistaken for the user. The helper declares per-monitor DPI awareness.

**Takeover.** Esc, key, wheel and click arrive as events from the existing global hook (only the KIND is passed on; Momo's own input is ignored for 400 ms; the voice shortcut's keys do not count; nothing stored); position drift and held buttons are polled. Typing stops when another window takes the focus. Every interruption records its cause, distance and recent positions in memory (`lastInterrupt()`).

**Verified on real Windows.** 72 real runs (click, right-click, Esc, scroll, Ctrl+A, drag, each with no fault, a mouse shove, Cancel, and an Esc from the user) left no button or key down and no file lost; the same 24-run soak passed with the PACKAGED Electron runtime (`release-test`, run as node). Not verified: multi-monitor and mixed DPI (one 200% display here; simulated in tests), the packaged app's main process and global hook.

## Recovery foundation (phase 4a)

Only vocabulary and facts; **nothing is retried yet** and the planner is shown exactly what it was before.

- `orchestrator/recovery/taxonomy.ts`: `FailureKind` (target_not_found, target_moved, target_gone, target_disabled, covered, wrong_window, popup_interrupted, app_unresponsive, timeout, uia_failed, input_failed, partial, unverified, ambiguous, needs_confirmation, blocked_by_policy, unavailable, invalid_request, user_interrupted, cancelled, unknown), `classifyFailure` (the input layer's own reason is exact and wins; sentences from tools are matched in order; facts from re-observation, once gathered, beat words), `Acted` and `deriveActed`.
- **`acted: no | maybe | yes`** = did any input REACH the app. The real pointer counts button presses, keys, wheel notches and typed characters (not pointer movement): "maybe" is set before the call (an error thrown after the input went through must not read as "nothing happened") and put back if Windows refused it outright; `resetActed()` / `actedSince()` are cumulative per step. Without that fact the derivation is conservative: a read never acted; a refusal decided up front is "no"; any other failure of a step that changes things is "maybe". A tool's own answer can never lower what the input layer saw.
- Every recorded step now carries `failure: {kind, acted}` and `acted` (a successful action: "yes"; an unverified one is named `unverified`); a thrown tool is "maybe".
- **Hung windows:** the helper's `state` command also reports `hung` (Windows' own `IsHungAppWindow`), exposed as `WindowState.hung` (absent when it is not known: the one-shot fallback cannot tell). Real test: a throwaway window with a blocked UI thread was reported hung ~4.3 s after input was posted to it, matching Win32 directly; ordinary windows were not. Limit: Windows only calls a window hung while input is waiting for it, so a frozen window nobody has sent anything to is not flagged.

## Action journal and verify-only recovery (phase 4b)

**Journal** (`orchestrator/recovery/journal.ts`): per task, memory only, at most 50 entries (the oldest drop first). Each entry: tool, a salted fingerprint of the arguments (random salt per task, so it means nothing outside it and a typed value cannot be guessed back from it), the argument NAMES (never values), phase trail (started, ran/failed, observing, verified / not_effective / unconfirmed, cancelled, declined), `acted`, the failure kind with a FIXED phrase for it (never the tool's own sentence, which can carry a title, label or path) and evidence as a fixed vocabulary of yes/no/count facts. Nothing is written, logged or sent. `Orchestrator.journal()` returns copies.

**Verify-only recovery** (`recovery/verifyOnly.ts`, called from `Agent.attempt`): when an action step MAY have run (failed with `acted` maybe/yes, not a user/cancel/policy refusal) or ran but could not be confirmed, Momo LOOKS: Windows' state of the window it acted on (exists, hung), then the tool's own optional `confirm` (window tools: Windows' state again; type_text: does the field hold exactly what was typed, only yes/no kept). The look is given a view that can only read (state, window list, read a window), so it cannot repeat or perform anything; a hung window is not asked about its content; every look checks cancellation and the user's takeover first and stops there, discarding any answer. Only a check that says true WITH positive evidence turns the step into a success (unverified -> ok; failed -> ok with the original failure kept in the text); a check that finds the effect really absent is recorded as such; everything else stays unverified. What was seen (hung, gone) can also name the failure better.

**Guard.** A failed step that may have run is added to the same "do not repeat" set as unverified ones, unless a real look found the effect absent; the existing guards (identical call with nothing changed, unverified action) are unchanged. Nothing in 4b retries anything; planner text is unchanged apart from a recovered step now reading as done.

## Bounded retries, frozen apps, dialogs, takeover (phases 4c and 4d)

**One decision point** (`recovery/policy.ts`, called from `Agent.attempt`; each try is `Agent.executeOnce`). A failed step may be tried again only when ALL hold: nothing was sent to the app (`acted === "no"`, the maximum over everything seen so far), the step is a read or reversible (never consequential), the failure is one a fresh look can fix (`target_moved`, `wrong_window`, `uia_failed`, `timeout`, `input_failed`; a window in the way is handled inside the tools where the window can be raised), the journal does not say the same call may already have run, no window is frozen or blocked by a dialog, the user has not taken over and the task is live, and the budgets allow it: **one retry per call, two per task, shared by every tool**. A retry that itself sends anything is final. The retry is never a blind repeat: positions (`_box`) are dropped and the tool resolves its target again from a fresh read; the result is verified like any other (4b). Tools state `acted: no` for refusals made before anything was sent (`failBeforeActing`, used when a window cannot be read), which is what makes those retryable; any other failure without facts stays "maybe" and is never retried. A retried step is announced ("Looking again and trying once more…") and does not use a planner step. The journal records both tries (`attempt` 1 and 2) and the decision as evidence.

**Frozen applications.** The look (4b) also reads Windows' hung flag (`IsHungAppWindow`) for the step's target, or for the window the user is working in when the step names none. While a window is hung nothing is sent to it (input is queued by Windows and fires later): Momo waits, read-only and bounded (3 s), for it to answer. If it answers it is LOOKED AT again (the input already sent may have landed) and only evidence confirms it; if it stays frozen the step stays unverified/failed as `app_unresponsive` with a plain note for the planner and no retry. A frozen window is never asked about its content.

**Dialogs.** The helper's `state` also reports `modal` (an enabled dialog of its own is open: `GW_ENABLEDPOPUP`), and the number of windows that appeared while an action step ran is counted (names are never kept). Either one makes an unexplained failure `popup_interrupted`: no retry, nothing is clicked in the dialog, and the step text tells the planner a dialog may be waiting for an answer.

**Takeover and cancellation.** Every look, wait and retry decision checks the task is live and the pointer has not been taken over, and discards anything it learned after that. `Orchestrator.cancel()` now also tells the real mouse and keyboard to abort (idempotent with the app's own call): anything held is let go of and a drag is cancelled.

**Regression guard.** The C# inside the helper script is only compiled by Windows PowerShell, and a typo silently turns the helper off (everything falls back to the slow script); a test now starts the real helper and checks `ping`, `windows` and `state` (including `hung` and `modal`).

## Menus, popups and transient windows (phase 5)

**Why they need their own handling.** Context menus, submenus, drop-downs, dialogs and toasts are top-level windows that are *owned*, *untitled* or *tool windows*, and the normal window list skips exactly those. A real probe showed the owner window's UI Automation tree includes them, but the pointer's "which window is under me" answer is the popup, not its owner.

**5a: discovery.** Helper `transients [owner]` lists visible owned/untitled/tool windows (class, process, owner chain, size, top/fg flags, a kind from class and style: menu, dialog, dropdown, popup, window, secure, other); never titles or text; zero-size hosts, shadows, tooltips and non-topmost unknown windows are dropped. `UiPanelAgent.transients()` feeds a bounded in-memory `TransientRegistry` (32 windows, 30 s, handles/classes/kinds only). `look_popups` is read-only and sensitive. The Phase 3 pointer accepts a *family* of windows for `expectRoot`/`expectForeground` (popup + owner + sibling popups). `at` also returns the window the point is in.

**Coordinates (found by real testing).** UI Automation reports a DPI-UNAWARE app's controls in its own unscaled pixels (half of the real ones at 200%), but a system dialog of the same process in real pixels. The helper decides per window from the controls themselves (which interpretation lies inside the window's real rectangle) and reports real screen pixels; aware windows are unchanged.

**5b: menus.** Helper `menu <hwnd>` returns items with hierarchy, enabled/checked/expandable/shortcut/focus. Pure resolution in `uipanel/popupAgent.ts` (labels compared like a person reads them; duplicates or no match are never guessed). `read_menu`, `choose_menu_item({path})` (mouse path or Show Only UIA invoke by runtime id), `close_popup` (Esc, only while a menu is really open, never a dialog). Every level is read again just before it is used; the exact item is checked under the pointer (`at`, or a re-read when a toolkit answers "the menu" for any point); anything unexpected means no click. A WinUI menu shown through several windows with identical items is one menu.

**5c: dialogs.** `read_dialog`, `answer_dialog({button})`, `choose_file({path})`. Secure-desktop, credential and password prompts are only counted, never read or answered (rechecked right before acting). Backing out (Cancel/No/Close/Not now) needs no approval; every other button, including unknown ones, is consequential and asks. A dialog button is read again and checked at the exact point; a covered dialog is raised once (nothing has been sent). `choose_file` clicks into the "File name" edit box (the helper's `fieldvalue` reads back only to compare), selects, types, verifies, and never presses Open/Save; the path is not echoed, journaled or logged.

**5d: keyboard.** `choose_menu_item({via:"keys"})`: Down/Up (the shorter way, wrapping), Right for a submenu, Enter only when the focus is read to be on the exact item; after EVERY key the menu is re-read and the focus must be exactly where the key should have put it (a surprise, two focused items, no visible focus, a vanished menu: stop, close with Esc unless the user took over, never Enter). Needs the menu's window family to have the keyboard (checked by the pointer). Menus whose focus cannot be read, and menus drawn by the application, are refused.

**Phase 4 integration.** All refusals before anything is sent say `acted: no`; a click or key that was sent is never retried; `confirm()` hooks (read-only) take the closed popup as evidence; the journal holds no item, button, path or text; the recovery view can list popups; a dialog or popup interrupting an action is `popup_interrupted` as before.

## Phase 6a: persistent window capture and readiness (GPU-rendered apps)

Apps whose interface is drawn by the GPU, a canvas or the app itself expose little or nothing to UI Automation. Phase 6 adds a way to LOOK at such a window. 6a is only the foundation: getting a real, settled picture of one window, safely. It does not read, detect or click anything (6b and 6c do, on top of this).

- **Where the pixels live.** `PrintWindow(PW_RENDERFULLCONTENT)` writes into one bitmap held in the long-lived helper's own memory (`shared/captureHelper.ts`, C# compiled lazily on the first capture request, so tasks that never look at pixels pay nothing). The helper's replies are numbers and a verdict only: size, place, timing, share of non-black pixels, distinct colours, how many tiles changed since the last frame. No pixel ever reaches the orchestrator, a log, the journal or the disk (audit tests check the sources).
- **Readiness.** A frame is evidence of content only when it is not black (under 0.5% non-black), not blank (fewer than 4 distinct colours) and the frame before it agrees with it (at most 2% of a 24×24 tile signature changed). Two successive agreeing frames make a window `ready`. Blank, black, changing, half-painted (PrintWindow failed, or the window moved during the capture) and unavailable are reported as exactly that: `vision/capture.ts` has no state meaning "nothing is there".
- **Refused before any pixel is requested.** Minimized, hidden or on another virtual desktop (DWM cloaked), capture-excluded (`GetWindowDisplayAffinity`), hung, gone, smaller than 40 px, larger than 4096×4096 (64 MB). Reasons are fixed sentences with no window title, number or content.
- **Coordinates.** The window's rectangle (`l`, `t`, `pw`, `ph`) is in physical screen pixels (the helper is per-monitor DPI aware); a frame also carries the window's DPI and the monitor's DPI. **Correction found in 6b:** for a DPI-UNAWARE window (an old program Windows scales up) `PrintWindow` returns the window's LOGICAL picture in the top-left corner of the bitmap, so a picture point (x, y) is at (l + x*scale, t + y*scale) on the screen, not (l + x, t + y). The helper now detects this (`GetWindowDpiAwarenessContext` against the monitor's DPI), captures at the logical size and reports `scale`; every later step maps through it. A moved or resized window restarts the readiness count.
- **Freshness.** `isFresh` (cheap) and `confirmFresh` (asks the helper: same session and frame, young enough, window still in the same place, still capturable) are what a later click will have to pass; default maximum age 1.5 s.
- **Lifetime.** One session, one window. The capture is released when the task ends, is cancelled, waits for an answer, the Session is disposed, another window is looked at, after 20 s idle (checked by the helper itself every 5 s) or when the helper exits. `release()` asks the helper only when a capture was started, so ordinary tasks never wake it.
- **Not in 6a.** OCR, button detection, `look_visual`, `click_visual`, Windows Graphics Capture.

## Phase 6b: seeing what a window looks like (read-only `look_visual`)

Built on 6a's settled frame. Nothing here clicks, types or moves anything.

- **Detection, inside the helper, on the frame already in memory.** Button-like rectangles are found by a flood fill (tolerance 8 per channel, half resolution) that keeps regions which fill at least 70% of their box, are not the background (touching two edges) and stand out from a ring just outside them. Words come from Windows OCR on the in-memory bitmap (no PNG, no file). Each plausible rectangle is also read ON ITS OWN, enlarged to suit its size and at two different enlargements. The pixel copy exists only for that operation and is dropped before the reply; the reply holds rectangles and recognised words only.
- **Candidates** (`vision/detect.ts`, pure functions): `button_like` (a rectangle with a label), `shape` (a rectangle without a readable label: never offered, never guessed at), `region` (large or multi-line), `text` (words in no rectangle: a word alone does not show a control). Each has kind, rectangle (physical pixels), optional text, a score, the frame number, the capture time, an `evidence` field and fixed-sentence `issues`. The score is a heuristic from the evidence (how the rectangle stands out, how clean the text is, how many readings agree), not a probability: Windows OCR gives no per-word confidence, so none is claimed.
- **A label is what the readings agree on, and it must be clean** (see the validation pass below for the final rules: unanimous crop readings, a lone reading is never usable, stray symbols are refused even when readings agree). Two candidates with the same label are BOTH refused as ambiguous.
- **Usable** means: `button_like`, scored at least 0.6, cleanly read, unambiguous. Nothing else is ever a target.
- **Freshness.** Candidates exist only while their look is fresh (1.5 s); they are wiped on expiry, on any release of the capture (task end, cancel, idle, another window) and by a timer. `confirmCandidate` additionally asks the helper whether the same frame is still current and the window is still capturable in the same place and size.
- **`look_visual({window?, find?})`** is a sensitive read: confirmed like every screen read, withheld from an online AI that may not see the screen, never aimed at Momo's own windows or at a window with a password box. The answer says plainly that these are things that LOOK like controls; a window with nothing recognisable is "not necessarily empty"; a missing label does not prove the control is absent. The journal and diagnostics never hold a label, window name or pixel.
- **Measured (this laptop, 200% display, controlled throwaway windows):** see the Phase 6b report; the numbers are from synthetic seeded layouts and a dedicated Chrome canvas/WebGL page, not from real-world applications.
- **Not in 6b:** `click_visual`, any decision about what an icon means, Windows Graphics Capture.

### Phase 6b validation and correction pass

**What changed after review.** The first 6b numbers came from layouts I had tuned against, with one generator. The detector was corrected, then frozen (content hashes recorded), and measured once on layouts it had never seen, from a second, independently written generator as well.

- **Shape finder.** A region grows from neighbouring pixels that are close in colour (tolerance 6 per channel, never more than 64 from its first pixel), so a gradient-filled button is one region instead of a band; small pictures are examined at full resolution (a 2 px border cannot fall between samples); a region counts as rectangular when it fills 70% of its box, or 40% with all four edges covered (a button that is mostly text); contrast against the surroundings is measured at two distances (an outlined button has its border right outside).
- **Label readings.** Each plausible rectangle is read on its own at two scales chosen from its size (small text is enlarged, large text is reduced: the recogniser reads a middling size best), plus a grey, contrast-stretched reading for every small button and whenever the first two disagree. The whole-frame OCR words only ever support a label; they cannot veto one.
- **A label is usable only when** at least two readings agree exactly (letters only: case and spacing do not matter), no reading of the rectangle itself disagrees (one dissent vetoes: a reading that dropped a letter is a disagreement), the label reads cleanly (no symbols among the letters such as backslash, pipe, braces, underscore; no punctuation inside a word), it is not a look-alike of a drawing read as letters (a ring as "O", a bar as "I", "oo", "0"), it has at least two letters, and no other candidate has the same label. A label read once is never usable. A reading that fails these leaves the rectangle as a labelled but refused candidate or, for look-alikes and one-letter readings, as a shape without a label.
- **Off-screen content.** A window only paints what is on the screen, so a part that was outside the desktop when the app painted can be missing from the picture PrintWindow returns. The helper reports the desktop bounds; a frame is `clipped` when the window sticks out by more than 24 px (the invisible resize border of a normal window is ignored); candidates not wholly on the screen are never usable, and `look_visual` says part of the window may be missing.
- **Helper script clean-up.** Every change to the helper writes a new content-hashed `uia-<hash>.ps1` into `%TEMP%\momo-helper`. Once per process, files named exactly `uia-<16 hex>.ps1` are removed unless they are the one in use, among the newest four, or younger than 24 hours; failures are ignored; nothing is ever written.

**Method.** Dev seeds were the only ones studied or tuned against. The held-out seeds were run once, after the freeze, and not looked at before. Generator 1: filled and flat buttons on light, dark and mid pages, Segoe UI. Generator 2 (written independently): other fonts (Arial, Tahoma, Verdana, Calibri, Consolas, Georgia), a different word list, header bar / sidebar / form structure, and flat, gradient, pill, outlined and tinted-chip buttons, icon-only controls, a status line and a card. Each was drawn as a DPI-unaware window (logical picture, scale 2) and as a genuinely DPI-aware 200% window. Windows were centred fully on the screen (a first harness placed some partly off-screen, which produced false misses and led to the off-screen finding above).

**Definitions.** Detection recall: labelled buttons found as a button-like candidate. End-to-end label accuracy: found with the correct label, over all labelled buttons. Usable precision: usable candidates that are a real button with the right label, over all usable candidates. Usable recall: non-duplicate buttons offered as usable with the right label, over all of them. Two buttons that carry the same label count as correctly handled only when both are refused.

**Held-out results (720 labelled buttons, 90 layouts, this laptop at 200%):**
- DPI-unaware windows (360 buttons): detection recall 100%, end-to-end label accuracy 97.5%, usable precision 99.4% (328 true, 2 false), usable recall 95.9% (14 missed).
- DPI-aware 200% windows (360 buttons): 100%, 99.2%, precision 99.7% (332 true, 1 false), recall 97.1% (10 missed).
- All: 100%, 98.3% (708/720), precision 99.5% (660 true, 3 false), recall 96.5% (24 missed), duplicate labels refused 34/36, icon-only controls shown as unlabelled shapes 155/155 (none ever called a labelled button).
- Of the 3 false positives, 2 carry the CORRECT label on a button whose same-label twin was not read, so the detector could not know it was ambiguous; 1 is a real misread offered as usable ("Delete i tern" for "Delete item"). Refused misreads are the main cost: they are what the recall figure pays for.
- Latency of a whole look (settle two frames, detect, read every rectangle): median 0.58-0.89 s, 95th percentile up to about 1.9 s; the first look after the helper starts takes about 1.8 s (it loads the recogniser).

**Real applications (controlled states; ground truth is the application's own UI Automation tree for its top toolbar, or the page content I wrote):**
- Chrome and Firefox showing my test page (3 canvas buttons with no accessibility node, 1 WebGL button, 3 HTML buttons): Chrome 6 of 7 offered as usable and 1 refused (read as "Shave", readings disagreed); Firefox 7 of 7 usable. No spurious usable candidates in Chrome.
- Browser toolbars, Windows 11 Explorer's command bar and Windows Terminal's tab strip: of the 13 + 24 + 27 + 10 controls those applications themselves report, essentially none were found as labelled buttons (Explorer 0 of 27: 3 text only, 6 shapes without a label, 17 not found, 1 wrong label; Chrome 0 of 13; Firefox 1 usable of 24; Terminal 1 usable of 10). Modern toolbars are flat and borderless, so there is no rectangle to find, and most of their buttons are icon-only. These are exactly the interfaces where UI Automation works and should be used.
- Conclusion: drawn, canvas and GPU buttons with a filled shape and a text label work well. Flat or icon-only controls are not detected, and that is the honest limit.

**Not covered.** Only this one 200% display; 100% and 150% scaling and multi-monitor; non-English text (the recogniser here is English only); real applications beyond those named; flat buttons with no outline; disabled or hover states. The generated layouts come from two generators written by the same author.

## Phase 6c: `click_visual`, the only click that comes from a picture

A fallback for buttons that exist only as drawn pixels (canvas, GPU-rendered, owner-drawn). Nothing here decides anything on its own: it can only press what the user NAMED, after every check below, and it is a separate tool the planner is told to use last.

**Before anything moves (each refusal sends nothing, `acted: no`):**
1. The label must appear in the user's own words (whole words, case and punctuation aside; `ToolCtx.instruction()` is the task's goal text). A label of fewer than two letters is refused. An icon is never a target: there is no label to match.
2. Windows' own description (UI Automation) is asked first: one exact match means a picture is not used (the answer says to use `click_control`); two means ambiguous. A password box in the window refuses everything. Momo's own windows are refused.
3. A fresh look (the 6b detection): exactly ONE button-like shape carries exactly that label (same letters; nothing similar or partial), it is usable (confident, cleanly read, two or more readings agree and none of the rectangle's own readings disagree) and it is wholly on the screen. A twin refuses, even an unusable one. A window that sticks out past the screen refuses (something hidden there could change the answer). Loose text that equals the label is not a button.
4. The effect the caller names (`expect`: a label that must appear, a label that must disappear, a window title that must open) must be something the click could cause: an expected label that is already on the screen, or one that must disappear but is not there, refuses before the click.

**The press (Phase 3 pointer, unchanged):** the pointer glides under every existing guard (window family under it, the window EXACTLY where it was seen, takeover by hand, Esc, cancel, held-input ledger). After the glide and BEFORE any input is sent, the pointer's last-look hook runs a new capture and detection: still exactly one, still usable, the same window rectangle and the button's rectangle within 3 physical pixels of where they were first seen, the pointer inside it, and the expectation still makes sense. Any difference refuses with nothing sent. The pointer then re-checks takeover and cancel once more before pressing.

**After the press:** the click was sent, so it is never repeated (Phase 4: the orchestrator reads what the pointer actually delivered). Only the NAMED effect counts, read from Windows' tree and from a fresh picture (a picture that cannot be trusted says "cannot tell", never "gone"). A screen that merely changed proves nothing; with no `expect`, or an expectation that does not hold, the result is reported UNVERIFIED. Verify-only recovery can confirm an expected label from Windows' tree and otherwise says "cannot tell".

**Safety and privacy.** Risk comes from `classifyControlRisk`: labels like Delete, Apply, Reset, Save, OK, Share, Send always ask first, before anything is captured. The tool's answers contain only the label the user named plus fixed sentences: no other recognised text, no picture, no window content. The journal and diagnostics hold no label. The tool's source has no disk, network or logging access (audited by tests), and its one `click` call carries the three guards (audited by tests). Recognised text is wiped with the task, like every look.

**Tests.** 59 tests with a fake desktop whose pointer enforces the same rules as the real one and whose "app" can react to the pointer arriving: correct selection and exactness, garbled and one-reading labels, duplicates (including an unreadable twin), UI Automation first, clipped, minimized, covered, password and Momo windows, the button moving by 2 / 6 px, vanishing, relabelled, a decoy twin, a look-alike, a swap of places, window moved or resized, cancellation before and after the press, takeover, an error after the press (no repeat), consequential labels, effect verification in all its forms, privacy and the journal.

**Real Windows (controlled apps only, this laptop at 200%).** A purpose-built owner-drawn app logged every click it really received and wrote its own state; 138 trials against it, plus 19 against a canvas page in Chrome (DPI-aware, GPU-composited; the page reported clicks in its title).
- Expected clicks (58 in the app): 56 right single clicks; 2 refused as unreliable readings (false negatives, safe); 0 wrong clicks; 0 extra clicks. Click position within 3 physical pixels in 62 of 62 (median 1.4 px, 95th percentile 2.8 px).
- Verification: 44 clicks claimed verified (38 with a named appearing label, 6 with a named disappearing label); in every one the app's own state confirmed the effect; 0 claimed verified wrongly. 6 clicks with a named effect that did not happen were reported unverified, and 6 clicks with no expectation were reported unverified although the screen did change.
- Refusals with 0 clicks received by the app: duplicates 8, absent 6, only look-alikes 6, Windows control exists 4, label not in the instruction 3, window past the screen edge 3, button moves away 5, vanishes 5, relabelled 5, decoy twin appears 5, unreadable label 8, cancelled at the button 5, user takes the mouse on arrival 4 and during the last look 4, consequential label declined 2.
- Window moved by the app as the pointer arrives (5): 4 times the stale attempt was refused with nothing sent, the one permitted retry looked again, found the label in its new place, passed every check and pressed once (right button, verified); 1 refused.
- Chrome canvas: 8 of 8 expected clicks right and verified; 2 of 2 without an expectation unverified; 9 of 9 refusals with 0 clicks.
- Stuck inputs after any trial: 0. Clicks on a wrong label across all trials: 0.
- Latency of a successful click (whole tool): median 3.8 s, 95th percentile 6.9 s: about 2.1 s until the pointer arrives (Windows' tree, bringing the window forward, the first look, the glide), about 0.47 s for the last look before the press, then the effect check. A refusal takes a median 2.1 s.

**Not covered.** Real applications beyond my own controlled app and page; 100% and 150% scaling and multi-monitor; text other than English; icon-only buttons (refused by design); a click whose effect the user did not describe (reported unverified, never confirmed).

## Phase 6d: Windows Graphics Capture (WGC): investigated, NOT adopted

**Decision.** PrintWindow stays the only capture method. WGC was tested against it on the same windows at the same moment and gave no advantage that matters to Momo; where the two differ, WGC is worse for Momo's purpose (acting only on fresh, verified pictures). No WGC code was added. The one genuine PrintWindow-path defect the investigation found (an unbounded wait on a busy window) is fixed in PrintWindow itself.

**Method.** WGC was driven through Chromium's own window capturer (Electron 33 / Chromium 130 in a throwaway host process, outside the project); PrintWindow through Momo's real helper capture and an equivalent stand-alone probe. Both returned only statistics and a 24 x 24 tile signature of mean colours, so the two pictures could be compared with each other and with the content known to be on the window (never by eye alone). The windows were my own: GDI windows (DPI-unaware and DPI-aware), one painted while partly off the screen, a layered window, a transparent frameless Electron window with WebGL, Chrome with WebGL and with decoded video, Firefox, Windows Terminal, Calculator, Paint, Notepad, a window covered by another, solid white, solid black and not-yet-painted windows.

**Content.** In every capturable scenario PrintWindow returned complete, correct content that agreed with WGC (mean difference per tile 0.7 to 2.2 grey levels; 0 for blank and black windows; Calculator 5.9; Paint differs in translucent backdrop areas and the Terminal border only). Neither API can capture a minimized window (WGC offers no source for one). Momo's readiness check classified the blank, black and not-yet-painted windows correctly. No case was found in which PrintWindow failed to capture a visible window and WGC succeeded.

**Where WGC is worse.** After a minimize or while the target is stalled, a WGC stream stays "live" and keeps handing back the last composed frame, looking valid (100% non-black); nothing says it is old, and a static window and a frozen one are indistinguishable. After the window closes the track ends and the frame goes black (detectable). Measured cost: about 1.2 GB of private memory across the host's four processes while a stream is open (185 MB idle), not returned until the host exits; PrintWindow in the helper costs about 7 MB (70 to 77 MB, back to 69 MB after release). Opening a stream took a median 139 ms (95th percentile 172 ms); frames from an open stream 50 ms median; PrintWindow frames 73 to 88 ms median, 0 non-ready frames in 100.

**The defect that was found (and fixed).** PrintWindow waits for the TARGET to answer. A busy application (UI thread blocked, but not yet "not responding", which Windows only flags after 5 s) held the single-threaded helper for as long as it stayed busy: a 4 s stall blocked every capture for 3.7 s; a 12 s stall that began after the "hung" check made the request wait 9.2 s and then killed and restarted the helper (everything it held was lost). WGC would have answered instantly, but with a stale picture. The fix: PrintWindow now runs on a worker thread with its OWN scratch bitmap and a 1.5 s bound. If the window has not answered, the wait is abandoned and the capture reports "busy" (a fixed sentence, an honest refusal; the caller tries again). The worker discards its result and frees only its own bitmap whenever it finally returns; at most three abandoned workers exist and never two for one window; nothing is copied into the session bitmap after a timeout. Measured after the fix: the 12 s stall returns "busy" after 1.5 s with 0 helper restarts, the helper keeps answering, and capture resumes (337 ms) once the app answers. Cost: about 15 ms more per frame (scratch bitmap copy); memory unchanged.

**Not tested.** Windows on another virtual desktop; protected (DRM) video; exclusive full-screen DirectX; multi-monitor and mixed DPI; any application beyond those listed. WGC's capture border indicator and GPU use were not measured.

## Phase 6e: final validation of the GPU-rendered application support (6a to 6d)

This section describes the architecture as it stands, what was measured on a real Windows PC, and what was NOT tested. "Real" means a real window, the real helper, the real pointer and the real Session on this machine; "simulated" means a fake transport in a unit test. Nothing here claims support for applications that were not tried.

### Architecture and lifecycle (final)

- **Capture** (`vision/capture.ts`, `shared/captureHelper.ts`): PrintWindow(PW_RENDERFULLCONTENT) into a bitmap that lives only inside the long-lived helper process. A session is started for ONE window, a frame is accepted only after two agreeing frames (24 x 24 tile signature, at most 2% of tiles changed), and blank, black, minimized, hidden, excluded, hung, busy, gone, too small, too big and partly off-screen windows are refused with fixed sentences. DPI-unaware windows are handled through the reported scale. Pixels never leave the helper: only counts, rectangles and recognised words come back.
- **Detection** (`vision/detect.ts`, `look.ts`): shapes, Windows OCR on the in-memory bitmap, per-rectangle crop readings, label voting. Candidates are held only while their frame is fresh (1.5 s) and are wiped on release.
- **look_visual** (read-only) and **click_visual** (`orchestrator/visualTools.ts`): described in the 6b and 6c sections. click_visual acts only on a label named in the user's current instruction, only when UI Automation does not list the control, only on one exact, unique, usable, on-screen candidate, after a fresh last look immediately before the press, through the Phase 3 pointer, and reports success only when the named effect is verified. It never retries once input may have been sent.
- **Release** on task end, cancel, takeover, session dispose, a different window, a hard refusal (including busy) and after 20 s idle. Observed from outside the helper (capinfo): explicit release 6 to 14 ms; idle release 20.4 s; a closed window reports "gone" and leaves no session.
- **Why PrintWindow only; why WGC was rejected**: see the 6d section. WGC showed no content advantage in any scenario tried and, for a stalled or minimized window, returns an old frame that looks valid, which Momo's freshness rule cannot accept. It also costs about 1.2 GB across four processes while a stream is open.
- **Busy bound (6d, re-validated in 6e)**: PrintWindow runs on a worker thread with its own scratch bitmap and a 1.5 s bound. If the window has not answered, the capture reports "busy" and releases the session. At most three abandoned workers exist, never two for one window; an abandoned worker frees only its own bitmap and event when it finally returns. Nothing is copied into the session bitmap after a timeout, and the next capture needs two new agreeing frames.

### Defect found and fixed in 6e

The per-frame worker thread added in 6d left about two kernel handles per frame in the helper until the garbage collector happened to run (measured: +1,156 to +1,300 handles over 600 frames; GDI objects and memory were flat). The worker's event is now closed explicitly (by the capture when the window answered, by the abandoned worker otherwise) and releasing a session collects the per-frame thread handles. After the fix: 0 growth over 1,500 frames (-9) and a net drop after 40 start/observe/release cycles. This would not have been visible in the earlier 100-frame runs.

### Measurements (this PC, one run set; not a benchmark of other hardware)

| Measure | Result |
|---|---|
| Session start + first usable frame (1640 x 1280) | 0.9 to 1.0 s |
| Capture, median / p95 / max (100 frames) | 73 to 88 / 83 to 114 / 131 to 155 ms; 0 non-ready |
| look_visual, controlled 1640 x 1280 window | median 106 to 121, p95 121 to 141 ms |
| look_visual in applications (median) | Calculator 78, Notepad 161, Terminal 150, Chrome 185 to 198, Electron WebGL 180, Paint 298 ms |
| look_visual, Firefox 2810 x 1826 | first look 4 to 10 s; median 0.8 to 1.2 s; one run refused as stale while the page settled |
| click_visual, whole task (real, 40 clicks) | median 2.85 s, p95 3.08 s (the human-like pointer glide dominates); last look before the press median 305, p95 359 ms; click accuracy median 1.4 px, max 2.8 px |
| UIA-first overhead before a visual fallback | UIA read median 655, p95 800 ms against visual look median 121, p95 141 ms on the same controlled window |
| Helper memory | 70 (idle) to 77 (capturing) to 69 MB (after release); about 88 MB while OCR is loaded |
| Helper CPU | idle with a session held: 0.00 s per 1.5 s; continuous captures 29% of one core; continuous full looks 74% of one core (only while a look runs) |
| Cleanup after a task | 6 to 14 ms |
| Handles / threads | no growth over 1,500 frames and 150 sessions (after the fix) |

### Busy-window validation (real)

Stalls of 3 s and 8 s on a throwaway window (its UI thread blocked, not yet "not responding"): the first capture returned busy after 1.52 s (bound 1.5 s), later requests were refused in about 4 ms (no worker piled on), no frame was accepted during either stall, the helper kept the same process, no helper restart, threads and handles returned to baseline, and capture resumed in 186 to 200 ms. A 12 s stall (previously 9.2 s and a helper kill) returns busy after 1.5 s.

### Compatibility (real; controlled content only; small test set)

| Application | UIA items (buttons) | Capture | Visual look | Notes |
|---|---|---|---|---|
| Our GDI windows, DPI-unaware and DPI-aware, off-screen-painted, layered, covered | 1 | yes | shapes found; labels read when text present | the click_visual test application |
| Chrome with a canvas/WebGL page | 18 (13) | yes | 11 candidates, 9 labelled; "SAVE", "CANCEL", "Open file", "GPU BUTTON" read | UIA does not list the drawn buttons |
| Chrome with decoded video | 21 (13) | yes | 13 candidates | |
| Firefox (controlled page) | 63 to 94 (26 to 38) | yes | 17 candidates, 15 labelled, 9 buttons read | slow on a 5 MP window |
| Windows Terminal | 21 (11) | yes | 10 candidates, 9 labelled | |
| Calculator | 56 (39) | yes | 7 candidates, 5 labelled | UIA lists the keys: the visual path is not used |
| Paint | 123 (58) | yes | 41 candidates, 18 labelled | UIA lists the controls |
| Notepad | 91 (16) | yes | 21 text candidates | UIA lists the controls |
| Electron transparent WebGL window | 18 (0) | yes | regions only | first look 2.2 s |
| Solid white / solid black / not yet painted | 1 | refused: blank / black / blank | n/a | correct |
| Minimized / closed | n/a | refused: minimized / gone | n/a | correct |

click_visual (real, our own GDI test application only): 138 trials. Delivered clicks 68; on the wrong button 0; verified wrongly 0; false negatives 2 of 40 positive trials (safe refusals: two readings of a label disagreed on a DPI-unaware window). In every refusal category (duplicate, absent, similar, unreadable, UIA-listed, not named by the user, clipped, declined confirmation, changed or vanished button) no click was delivered. When the window moved after the first look the first attempt refused without clicking, then the Phase 4 retry ("Looking again and trying once more", allowed only because no input had been delivered) re-looked and clicked the correct button. Cancel and takeover: 42 trials; 0 clicks when the interrupt came before the press (cancel or mouse grab up to 220 ms after the pointer arrived), 0 held inputs left; clicks occurred only when the interrupt came after the press had already happened.

Applications NOT used with click_visual: Chrome, Firefox, Terminal, Calculator, Paint and Notepad were only looked at (capture, detection, UIA coverage). Click accuracy was not measured on third-party applications.

### Privacy audit (source and runtime)

Verified: pixels stay in the helper's memory (no file, network, clipboard or process API in the capture source; no console or file output in the Phase 6 TypeScript; a runtime scan of Momo's data folders, the helper's temp folder, the project's source, docs and shots, and Pictures, Desktop and Documents, 16,179 files, found no file created or changed by a run of real looks and clicks except an unrelated one, no image files, and no file containing the on-screen labels); the helper scripts in the temp folder are code only (hash-named, at most four kept); look_visual output is marked sensitive and withheld from an online AI unless the user allowed it; click_visual reports only strings the user named; the journal keeps fixed phrases; the capture is reachable only through the two tools; a real window with a real password box and a window declared as Momo's own were both refused with no capture left active; busy carries a fixed sentence.
Partially verified: the "no screen content to an external AI" claim rests on the sensitive marking and the code audit; it was not tested against a live cloud model. Known limitation: a separate, older per-control picture feature in the UI panel (not part of Phase 6) can send a control picture to a vision model when the user permits it.

### Not tested / limitations

Another virtual desktop; protected (DRM) video; exclusive full-screen DirectX; multi-monitor and mixed DPI; display scaling: only this PC's setting (about 200%: its 2880 x 1800 screen shows a DPI-unaware window at scale 2) was available, so 100% and 150% were not tested; any application beyond those listed; very large windows (the Firefox 5 MP window is slow, not wrong); languages other than the installed OCR language; text smaller than the recogniser can read; icon-only controls (never guessed by design); a cloud model end to end. No trained icon recognition and no autonomous icon clicking exist.

## `arrange_window restore`: restored to the recorded normal place, verified against it (found by the Phase 8a acceptance suite, A07)

**The defect.** `restore` pressed Win+Down and reported success whenever the rectangle changed. On a half-snapped window Win+Down moves it to a QUARTER of the screen (A07 on a 2880x1800 screen: 920x1120 at 1028,340 -> snapped right 1414x1811 -> "restored" 1414x911 at 1477,900), and the tool still said "restored to its normal size": a false verified claim. Windows itself kept the truth all along: `WINDOWPLACEMENT.rcNormalPosition` never changed.

**The fix.** The helper (per-monitor DPI aware, so everything is in physical pixels like the pointer) has two commands: `wplace` (read-only: the show state, `rcNormalPosition` still raw, the window's current outer rectangle from GetWindowRect, and the primary work area's origin) and `wrestore` (SetWindowPlacement with SW_SHOWNORMAL and the recorded rectangle passed back exactly as Windows gave it, WPF_ASYNCWINDOWPLACEMENT so a stuck window cannot block the helper; a window with no usable normal rectangle is refused, nothing is invented). The tool no longer presses a key for a restore.

**Coordinates.** `rcNormalPosition` is in WORKSPACE coordinates: relative to the top-left of the primary monitor's work area (the screen without the taskbar). `placementFromRaw` adds the work-area origin: screen = workspace + origin (width and height need no conversion). With the taskbar docked on the left (work area from x = 96), a recorded 932 is screen x = 1028, which is exactly where the window started; a real window in its normal state also satisfies workspace + origin = its own rectangle. Both rectangles are OUTER rectangles (invisible resize borders included) and are read in the same units, so they compare directly.

**Verification.** After the request the tool waits until the window holds still and says "restored" ONLY when Windows reports the normal show state and the current rectangle is within 6 px (left, top, width, height) of the recorded normal rectangle. Otherwise it says it cannot say the window was restored and where it is. Refusals before the request (placement unreadable, no usable normal size) say nothing was changed and are marked "nothing sent" (a retry is safe); a request that gets no answer in time is "maybe" and is never repeated blindly. A build whose port cannot read placements falls back to the key path, which never calls a changed rectangle "restored". Snap left/right and maximize are unchanged.

**Tested.** Unit tests (quarter-snap that stays a quarter, genuine restoration, already normal, tolerance edges, maximized and minimized afterwards, unreadable placement, unusable normal rectangle, refused and timed-out requests, older build, other actions unchanged; the workspace conversion with the real numbers) and the real helper's read-only answers. NOT yet tested on a real desktop: the write path (SetWindowPlacement) has only been exercised with a window that does not exist; that, other monitors (the workspace origin is taken from the primary monitor's work area, which is Windows' convention but was only confirmed on a single monitor), a taskbar on other edges, Windows 10, windows that refuse to resize, and snap-group behaviour are untested. If the origin convention were wrong the verification would fail and the tool would say it could not confirm: it cannot produce a false "restored".
