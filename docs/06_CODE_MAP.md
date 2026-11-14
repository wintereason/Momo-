# Code map: Momo's runtime follows the 9 agent roles

`src/runtime-core/` has one folder per role from `docs/Momo_Desktop_AI_Agent_Concept.md`.
Each role has a matching helper in `.claude/agents/`. Roles are logical: they run in one process and share
the temporary world model.

| Folder | Role | Helper agent |
|---|---|---|
| `orchestrator/` (+ `ai/`) | Decides, asks, runs the AI brain, owns the session | `momo-orchestrator` |
| `desktop/` | Windows, focus | `momo-desktop` |
| `vision/` | Screenshots + OCR | `momo-vision` |
| `uipanel/` | UI Automation controls | `momo-ui-panel` |
| `filesystem/` | Drives, folders (read-only) | `momo-filesystem` |
| `apps/` | Installed apps, launching, URLs | `momo-apps` |
| `browser/` | Tabs and pages | `momo-browser` |
| `action/` | Clicks, typing, safety policy | `momo-action` |
| `verifier/` | Verification + temporary world model | `momo-verifier` |
| `languageTeacher/` | Plays the other role of a language interview (one validated line per call); holds the learner-progress summary the orchestrator reads | `momo-language-teacher` |
| `shared/` | ports, redaction, node ports, screen-text helpers | (orchestrator approves changes) |

Flow: the orchestrator reads the request, asks specialists to observe (writing to the world model), has the
action agent act only after the policy allows it, then the verifier checks before anything is called a success.

## Boundaries (enforced by `src/audit/agents.test.ts`)
- Each role's public face is its `index.ts`. Other roles import `../<role>`, never `../<role>/<file>`.
- Specialists never import the orchestrator. Allowed dependencies: desktop, filesystem, uipanel and vision may use the verifier (world model);
  the verifier may use desktop and filesystem (to judge their results); apps, browser and action use only `shared/`.
- `shared/` imports no role.
- Each role has a helper in `.claude/agents/` that names its folder.
