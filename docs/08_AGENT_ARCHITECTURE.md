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
