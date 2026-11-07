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
| Desktop | `list_windows` |
| UI & Panel + Visual Perception | `read_window` (UI Automation text, OCR fallback; password boxes never read) |
| Action | `open_path` (a file or folder), `focus_window`, `minimize_window`, `close_window`, `click_control`, `type_text` |
| Application | `open_app` (with browser `account` + `url`), `open_url` |
| Browser | `browser_accounts`, `list_tabs`, `switch_tab` |
| Verification | built into every tool (and `Verifier`), plus the final check in the orchestrator |

There is no tool to send, delete, buy, submit, install or download: Momo cannot do those things.

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
