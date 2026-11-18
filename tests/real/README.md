# Real-Windows acceptance suite (Phase 8a)

Repeatable tests that drive Momo's **real** runtime (Session, UI Automation helper, window capture, real pointer) against **controlled test applications that the suite creates itself**. Every verdict compares what Momo claims with what the test application itself recorded it received. A scripted planner stands in for the AI, so **no AI is contacted and no screen content leaves the PC**.

> **Status:** the runner, the reporting, the cleanup and the self-checks were validated without touching the desktop (`npm run test:real -- --selftest`). The real-desktop tests (groups A, B, C, D01 and D02) have **not been run yet**. Until they have passed, the suite is not validated.

## Run it

```
npm run test:real                       # everything automated (estimated about 17 minutes; see "Time")
npm run test:real -- --quick            # a representative subset (estimated about 4.6 minutes)
npm run test:real -- --list             # every test: kind, whether it uses your real mouse/keyboard, estimated time. Starts nothing
npm run test:real -- --dry-run          # preflight only: environment, runtime freshness, what would run. Starts nothing
npm run test:real -- --selftest         # the runner's own checks (simulated: no windows, no input)
npm run test:real -- --group A,B        # only these groups
npm run test:real -- --only C13,C14     # only these tests
npm run test:real -- --repeat 3         # run each selected test 3 times, to study flakiness (failures are never retried away)
npm run test:real -- --allow-skip C13   # accept this test being skipped
npm run test:real -- --no-results       # do not write the results file
```

**Hands off the mouse and keyboard while it runs.** The suite moves your real mouse and sends real keystrokes, only to its own test windows. It shows a 5 second countdown first (`--no-countdown` skips it). Ctrl+C stops it safely and cleans up.

Requirements: Windows 10/11, Node (the project's), Windows PowerShell 5.1, Google Chrome for the Chrome tests. It rebuilds `electron/runtime.cjs` (a git-ignored build artifact) when that is older than the source; `--no-build` refuses to instead.

### Exit codes
| code | meaning |
|---|---|
| 0 | every required test passed (and at least one test passed) |
| 1 | a test failed, or something was left behind after cleanup |
| 2 | usage or preflight problem (nothing was run) |
| 3 | **incomplete**: a required test was skipped (Chrome missing, another application's pop-up open, ...) or nothing passed |

A skipped test is **never** reported as passed. It is listed with its reason and makes the run incomplete unless you named it in `--allow-skip`. `MANUAL` rows are tests only you can run; they are listed as not run and never counted as passed. A test that records no assertions fails.

## Groups

| group | what | uses real input |
|---|---|---|
| **S** | the runner's own logic: judging rules, report/exit-code rules, cleanup ledger, shutdown on Ctrl+C/crash, fixture syntax, manual-script guards. Simulated | no |
| **A** | basic desktop interaction on a controlled WPF window: UIA read, click, type, scroll, keys, foreground change, window move, disabled/ambiguous refusals, cancellation, takeover, held-input release | yes |
| **B** | context menus and submenus, message boxes (No / Yes with approval), a file dialog in a temp folder, a frozen window that stays frozen / recovers, cancel while waiting, retry only when no input was sent | yes (B05, B06, B08, B09 are tool-level) |
| **C** | window capture (ready, blank, black, unpainted, never-settling, busy, minimized, closed), detection accuracy, `look_visual` read-only, `click_visual` positives and refusals, effect verification, helper resources, idle release, and **Chrome 2D canvas (C13) and WebGL (C14)** | most |
| **D** | password-box refusal (D01), Momo's-own-window exclusion (D02); **D03 UAC, D04 session lock, D05 sleep/resume are MANUAL** | D01, D02 |

`--quick` runs: S01-S15, A02, A10, A11, B07, C01, C02, C04, C08, C09, C13, C14, D01.

## Manual tests (you run them; the suite never does)

They interrupt your session, so each needs an explicit flag **and** a typed confirmation, and only reads (window list, UI Automation read, pop-up scan, a capture of the suite's own test window, the helper's heartbeat). They send **no input at all**, never approve a prompt and never enter credentials.

| test | command | what happens |
|---|---|---|
| D03 UAC | `node tests/real/manual/uac.cjs --i-understand` | a harmless elevation request shows a real UAC prompt. **You click No.** |
| D04 lock | `node tests/real/manual/lock.cjs --i-agree-to-lock` | **locks your Windows session** after a 10 s countdown; sign in, press Enter |
| D05 sleep | `node tests/real/manual/sleep.cjs --i-agree-to-sleep` | **puts the PC to sleep** after a 10 s countdown; wake it yourself |

Each prints a PASS/FAIL verdict (no hang, the helper restarted at most once, Momo's reads came back afterwards) and saves a counts-and-timings-only result under `tests/real/results/`. UAC is a discovery test: what Momo does on the secure desktop was not known before.

## What a test may touch (isolation)

* Only windows, processes and files the suite creates. Each carries this run's unique id (`momo-real-r<time>-<pid>`) in its window title and command line; all files live under `%TEMP%\momo-real\<run id>\`.
* **Every test, and every repetition of it, has its own artifact directory** (`%TEMP%\momo-real\<run id>\<test id>[_r<n>]\`): a fixture's click log, state file, marker or browser profile can never be shared with another test or another repetition (`ledger.beginCase` / `endCase`; the scope always ends, even when a test throws). Self-checks S10 and S11 guard this; `--repeat 3 --only S11` shows it.
* Fixtures close themselves after 15 minutes even if the runner is killed outright.
* Cleanup finds things **only** by that id, on normal completion, Ctrl+C, termination, an uncaught error, and at the start of the next run (a crashed run's directory is swept only if its owner process is gone and the name matches). After every test, and at the end, the suite asserts: 0 leftover processes, the run directory removed, no key or mouse button held. Any of those failing fails the run.
* Chrome runs in a **throwaway profile** under the run directory, never yours. Before and after, the suite checks that every Chrome process and window that existed before is still there.
* Dialog and menu tools act on "the one that is open"; the suite refuses (SKIP) to run them if any open pop-up belongs to another application.
* The file-dialog test uses a folder it created; no personal folder is shown or read.
* The helper that is measured for leaks is the one that is a child of the runner, never another running Momo's.

## Privacy

Capture stays in memory (as in Phase 6). No screenshot, OCR text or window title of anything other than the suite's own fixtures is saved or reported. The results file (`tests/real/results/<run id>.json`, git-ignored) holds counts, timings, test names and pass/fail only. `tests/` is not part of the packaged app.

## Diagnostics in the results file

Every row of `tests/real/results/<run id>.json` can carry `diagnostics`, recorded whether the test passes or fails: one record per tool call (tool, outcome, whether Momo asked and the answer, the pointer's phases and last wheel point, the outcome text of acting tools), plus what a test adds itself (the fixture window's rectangle in its own units and in physical pixels at each stage, the wheel point against the list rectangle, one record per C08 trial, the C07 timings).

Privacy: only the suite's own fixtures are involved, and even so nothing arbitrary is kept. The text of tools that **read** windows (dialogs, menus, window lists, `look_visual`, ...) is never stored, only its length; in the text of acting tools every quoted name is redacted unless it is this run's id, one of our fixtures' control names or a value the test passed (never a path); strings are clipped; the run id is shortened to `<run>`. No screenshot, OCR text, credential or personal data can pass through. Self-check S12 guards this.

## What the corrected measurements mean

* **C07** (look latency): an untimed warm-up look first, then at least 20 timed looks; the p95 is computed from those only and compared with the Phase 6e baseline (WARN when more than 1.5x slower, never a failure). The raw timings are in the diagnostics.
* **C08** (positive clicks): the 90% hard threshold and 95% target are unchanged. When the target is missed the report now says what the sample size allows: with 15 trials the target tolerates 0 misses, so one miss (14/15 = 93.3%) cannot reach it; 20 trials are needed to tolerate one. One diagnostic record per trial (label, expected target, awareness, result, outcome, clicks, fixed refusal sentence, duration).
* **A04** (scroll): the test uses `-Layout scroll`, a tall list, so the point `scroll_window` aims at (60% down the window) is comfortably inside it (self-check S14 proves the geometry headlessly). The diagnostics record the wheel point and the list rectangle with margins.
* **A07** (restore): diagnostics only. At each stage it records the fixture's own rectangle (DIPs), Momo's physical-pixel rectangle, the `WINDOWPLACEMENT` (show state and the *normal* rectangle Windows keeps for a snapped window, with the units it was read in) and the tool's actual answer. No assertion changed and no production behaviour is claimed fixed.

## Pass criteria and baselines (`baselines.json`)

Safety thresholds are absolute: **0 wrong clicks; 0 clicks in refusal cases; every unsuccessful positive is a safe refusal; every success claim backed by the application's own record (a visual change alone is never proof; for Chrome the page's own press counter is);** positive click success **>= 90% (hard), >= 95% (target)**; 0 blank/black frames accepted; capture p95 < 150 ms at 1640x1280; busy refusal within 1.5 s + 0.3 s; idle release 20 s +/- 2 s; helper handle growth <= 20; detection end-to-end accuracy >= 95%; menu: 0 wrong items, >= 90%.

Latency is compared with the Phase 6e measurements (a **WARN** when more than 1.5x slower, never a failure) and only when this machine matches the reference (one 2880x1800 display at 200%); otherwise it is reported as "not comparable".

## Time

The estimates (`--list`) come from the structure of each test, **not from a measured run**: a full run is estimated at about 17 minutes (more than the 10 minutes first hoped for) and `--quick` at about 4.6 minutes. Use `--group` / `--only` to split it: A+B about 7 min, C without Chrome about 7 min (`--only C01,C02,...`), the two Chrome tests (`--only C13,C14`) about 2.3 min, S+D under 1.5 min.

## Known limits

* Not validated on other machines, other display scaling (100%, 150%) or several monitors. The Phase 6e baselines are one machine.
* The harness is a scripted planner: it tests the tools and the safety machinery, not the AI's choices.
* Controlled fixtures stand in for real applications; third-party applications (Notepad, Calculator, Paint, Firefox, Terminal) are covered by the Phase 6e measurements, not by this suite.
* UAC, lock and sleep are user-run only.
* Console Ctrl+C delivery is not driven by a self-check (the shutdown code is, through a stand-in process object).

## Adding a test

Create or edit a file in `cases/` that exports an array of `{ id, group, title, mode, expect, est, interactive, quick, needs, run(ctx) }`. Record checks with `ctx.check(name, ok, detail)`; ground truth comes from the fixture's own record. Fixtures are in `apps/` (PowerShell 5.1 files must stay pure ASCII). Keep the self-checks (`S05`, `S07`) green.

Files: `run.cjs` (runner) - `lib/` (ledger, report, judge, harness, fixtures kit, shutdown, environment) - `apps/` (fixtures) - `cases/` (tests) - `manual/` (user-run scripts) - `baselines.json` - `results/` (git-ignored).
