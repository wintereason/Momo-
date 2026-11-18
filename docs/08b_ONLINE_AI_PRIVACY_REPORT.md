# Phase 8b: Online AI privacy: leakage report

Tests: `src/audit/onlinePrivacy.test.ts` (81 tests) and the harness `src/audit/onlinePrivacyKit.ts`.
Method: the real `Session` + `createAiService` + `LlmClient` run against a made-up in-memory PC and a recording fake `fetch`. The global `fetch` is stubbed to throw (asserted never called), keys are fake, no real file, window, screen or network is touched. Private-looking values are CANARY markers. Reports list canary classes only, never request bodies.

Policy applied (user decision): file paths, window titles, tab titles and screen-derived text are sensitive and must not reach a cloud planner without explicit screen-context permission. The tests were written first and failed on every leak; production fixes followed (see Status).

Status: **F1-F11 fixed**. Before the fix 11 tests failed (the table below). After the fix all 81 tests pass; with the redaction switched off again, 14 of them fail (checked once, then restored).

Fix: `agent.ts` shows an online planner that may not see the screen (`isCloud() && !canSeeScreen()`) only the tool name and outcome of every step that ran on this PC; its arguments and result text are replaced (`redactSteps` in `ai/prompts.ts`). The real steps and the arguments the tools run with are unchanged. `drive_info` and `language_progress` are shown as before. With screen context ON nothing is redacted and the existing confirmation gates apply; the online screen-read confirmation now says the information leaves this PC (F11).

Findings as first recorded:

## Findings (flag OFF, cloud planner, what the planner request contained)

| Finding | Tool / case | Canary classes that reached the request | Test |
|---|---|---|---|
| F1 (High) | `find_paths` | file name, folder name (full path) | B2 |
| F2 (High) | `open_path` | file name, folder name | B2 |
| F3 (High) | `open_path` after the user picks one of several files | file name, folder name (the picked path becomes a step argument) | B3 |
| F4 (Med) | `click_control` | control name | B2 |
| F5 (Med) | `right_click` | window title, control name | B2 |
| F6 (Med) | `select_text` | window title, control name | B2 |
| F7 (Med) | `press_keys` | window title | B2 |
| F8 (Med) | `arrange_window` | window title | B2 |
| F9 (Med) | `focus_window` | window title | B2 |
| F10 (Med) | `minimize_window` | window title | B2 |
| F11 (Med, transparency) | confirmation for an online screen read does not say the result goes online ("Look at the screen ... and read what is on it?") | n/a | C3 |

Cause (from source, not changed): these tools are `sensitive: false`, so their result text is not withheld, and step arguments are never withheld.

## Passing (privacy holds)

- Flag OFF: all 10 sensitive tools (`look_screen`, `understand_screen`, `inspect_component`, `list_windows`, `read_window`, `browser_accounts`, `list_tabs`, `look_popups`, `read_menu`, `read_dialog`) put no canary in any request; the planner sees the placeholder.
- Flag OFF: `type_text`, `select_field`, `press_enter`, `scroll_window`, `click_text`, `open_app`, `open_url`, `switch_tab`, `drag_drop`, `choose_menu_item`, `close_popup`, `answer_dialog`, `drive_info`, `language_progress` leaked no canary in this PC model (a tool that echoes a different value is not covered by what is modelled).
- Flag ON: a sensitive read always asks, a decline sends nothing, result text is fenced and at most 1,200 chars.
- `look_visual`, `click_visual`: no OCR/screen canary in any request with the flag off, and none before the user answers with the flag on.
- Pictures: no vision request without the flag (cloud); a decline sends nothing and takes no picture; approved = exactly one image request with no canary in its text; password field refused before capture; hostile reply not obeyed; local Ollama stays on `localhost:11434`.
- Errors: a provider error body that echoes a canary and the key reaches no event; Ollama never falls back to a cloud host.
- Drift guards: every registered tool is covered by the test lists; the `sensitive` flags in source match the classification in the test.

## Not covered (by decision or limits)

- Dictation polish, Language Teacher, cloud STT, online voice: deferred to a separate task.
- Real providers, real keys, real screens: never used.
- Tool results that depend on content a fake PC cannot model (real Explorer lists, real browsers).
- Confirmation-after-approval flow for `look_visual` text with the flag on (only "nothing sent before the answer" is asserted).

## Review follow-up (D1-D4, D6)

- D1: every non-sensitive tool test now asserts the outcome the planner is shown (a silently failing tool can no longer pass), the real local effect, and no canary.
- D2: the fake PC records the real path, app, URL, focused window, keys and text a tool used; tests compare them with the real arguments (including the picked file, F3).
- D3 (known behaviour, not a defect to fix here): with screen context OFF an online planner sees only outcomes. A repeated read is stopped by "You already made this exact call" and the task ends cleanly (M3); a repeated action is allowed again because an action changes the world. The planner can no longer chain a path from `find_paths` into `open_path { path }`; `open_path { query }` still works (M2). Goals that depend on a previous result need screen context ON.
- D4: the redacted text now depends on the outcome. Only a verified step suggests finishing; failed and unverified steps say so (M5, M7).
- D6: the end-of-run network guard is asserted in `afterAll` and in test Z; the old error-swallowing in the visual helper is gone (the helper tolerates an empty scripted log instead).
- Accepted policy D5 is kept and tested: with screen context ON, non-sensitive results are sent without a per-call prompt and are not redacted.
- The seven tools that needed a richer PC (`select_field`, `press_enter`, `scroll_window`, `right_click`, `select_text`, `click_text`, `drag_drop`) now run successfully in a rich fake PC whose screen reacts to what is done to it. Each test checks the outcome, the exact local effect (pointer coordinates and button, wheel notches, keys, the field that got Enter, the drag start and end) and that no canary is in any request. `select_text` is `done but NOT verified` by design (Windows does not report what is selected). The failure paths of the same seven tools stay covered in the plain PC (B2f).
- Mutation checks (each reverted afterwards): no redaction -> 28 tests fail; text redacted but args kept -> 25 fail; failed step worded as success -> 2 fail; confirmation wording removed -> 6 fail.
