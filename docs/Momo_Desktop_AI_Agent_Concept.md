# Momo --- Desktop AI Agent

## Concept, Architecture, and Wireframe

**Document purpose:** Explain the Momo desktop-agent idea clearly enough
for an AI coding assistant (such as Claude) to understand the intended
product and help design it before implementation.

**Status:** Concept and proposed architecture --- not an implemented
system.\
**Target environment:** Windows desktop, initially Windows 11.\
**Core principle:** Understand the user's goal and the current computer
environment, then take the minimum necessary action to fulfill the goal.

------------------------------------------------------------------------

## 1. Product vision

Momo is a desktop AI companion with a small, cute animated character
that can live on the desktop, for example near the bottom-right corner.
Behind the character is a computer-use agent that can understand the
current desktop and help the user operate their PC.

Momo should not be a collection of fixed macros. It should understand
the environment, interpret a user's request, choose the appropriate
capabilities, act only when needed, and verify outcomes.

Examples of user requests:

-   "Tell me the storage of D drive."
-   "Open my Context Companion project in VS Code."
-   "What is this error on my screen?"
-   "Find the project folder and tell me how its AI assistant works."
-   "Open WhatsApp, find Sumeet, and prepare a hello message."

The same system should support short questions that require no visible
interaction and complex tasks that require multiple agents and actions.

## 2. Fundamental design principles

1.  **Goal-first, not procedure-first.** Interpret what the user wants
    before choosing actions. Do not hardcode a click sequence for each
    task.
2.  **Minimum necessary action.** If a request can be answered with a
    direct API or filesystem query, do not open an application just to
    retrieve the answer.
3.  **Environment understanding.** Represent the computer as connected
    entities: virtual desktops, windows, application panels, controls,
    files, folders, browser tabs, pages, and other relevant objects.
4.  **Specialized collaboration.** Different specialist agents
    understand different kinds of entities and can share observations
    when useful.
5.  **One coordinating authority.** The orchestrator is responsible for
    the user's goal, task-level decisions, uncertainty, and conflict
    resolution.
6.  **Evidence-based actions.** Prefer reliable Windows APIs,
    accessibility/UI Automation, filesystem metadata,
    application/browser interfaces, and visual perception. Combine
    sources when needed.
7.  **Verify results.** Do not assume an action worked merely because it
    was issued.
8.  **Ask when uncertain.** If several targets match, intent is unclear,
    or an action has meaningful consequences, ask the user instead of
    guessing.
9.  **Permission-aware execution.** External or consequential
    actions---such as sending messages, submitting forms, deleting
    files, or making purchases---require confirmation unless the user
    has explicitly configured a suitable permission policy.
10. **Temporary session understanding.** Agent-specific observations,
    world-model state, and coordination data exist only for the active
    session and are discarded when Momo exits. Do not build persistent
    personal memory or task-history storage into the core design.
11. **No claim of cloud erasure.** If a cloud AI service receives data,
    its own retention policy is separate from local session cleanup and
    must be disclosed.
12. **Use models pragmatically.** Start with existing models and
    reliable system interfaces. The specialist roles do not each need
    their own separate AI model.

## 3. Agent count and responsibilities

The proposed initial design has **9 logical agents: 1 orchestrator + 8
specialists**. These are roles, not necessarily nine separate processes
or AI models.

### Main agent: Orchestrator / Decision Agent

-   Interprets the user's goal.
-   Decides which specialist capabilities are relevant.
-   Chooses the least invasive and least costly path to an answer or
    action.
-   Requests observations from specialists and combines their findings.
-   Handles ambiguity, safety checks, and user clarification.
-   Maintains task progress in temporary session memory.
-   Can change direction if new evidence contradicts an assumption.
-   Returns a concise answer or reports what could not be completed.

### Specialist 1: Desktop Agent

Understands the desktop/workspace layer: - Virtual desktops and
available desktop/workspace context where discoverable. - Top-level
windows, their titles, positions, visibility, focus, and
relationships. - Which application window is active. - Window changes
and focus changes.

### Specialist 2: Visual Perception Agent

Understands what is visually present: - Screenshots and visible screen
regions. - Visible text, icons, objects, and UI elements. - Visual
relationships and layout. - Uncertainty when an element is occluded, too
small, or ambiguous.

A screenshot alone cannot reliably reveal hidden tabs, background state,
or filesystem truth.

### Specialist 3: UI & Panel Agent

Understands the internal structure of a user interface: - Menus,
dialogs, sidebars, panels, buttons, text fields, lists, and controls. -
Which controls belong to which window or application. - Whether a
control appears enabled, disabled, selected, or unavailable, when
detectable. - Accessible names, roles, and state exposed through Windows
UI Automation or other accessibility interfaces.

### Specialist 4: File System Agent

Understands files and folders through filesystem interfaces: - Drives,
capacity, free space, folders, files, paths, types, and metadata. -
Folder and file relationships. - Whether a path exists and whether
access is permitted. - Safe listing and inspection operations.

It should not open File Explorer unless opening a visible window is
actually part of the user's goal.

### Specialist 5: Application Agent

Understands applications and their current state: - Installed/running
applications where discoverable. - Which window belongs to which
application. - Application-specific concepts, capabilities, and
available interfaces. - Relevant files, errors, and app state when
accessible. - Whether an application-specific adapter or API can perform
a task more reliably than mouse automation.

### Specialist 6: Browser Agent

Understands browser-specific entities: - Browser windows, tabs, active
tab, page title, URL, and page structure where accessible. - Web forms,
page controls, and web applications. - Distinguishes a browser window
from its tabs and pages. - Uses browser accessibility/automation
interfaces when available, with visual fallback when necessary.

### Specialist 7: Action Agent

Executes approved operations: - Mouse movement and clicks. - Keyboard
input and shortcuts. - Window focus and navigation actions. - Filesystem
operations or other system tools through narrowly scoped interfaces. -
Application/browser actions through the most reliable available
mechanism.

It should act on a current, identified target---not on a stale
screenshot or guessed coordinate alone. It should obey permission rules
and report the action performed.

### Specialist 8: Verification Agent

Independently checks outcomes: - Confirms whether the intended window,
file, page, or control is now in the expected state. - Checks returned
values and operation results. - Detects failed actions, unexpected
dialogs, focus changes, and mismatches. - Reports evidence and
confidence to the orchestrator. - Requests a fresh observation when the
environment has changed.

Verification should be proportionate: a simple read-only query needs a
lightweight check; consequential actions need stronger checks.

## 4. Architecture wireframe

The diagram below shows the proposed logical connections.
Specialist-to-specialist links are optional collaboration paths, not
mandatory steps in every task.

``` mermaid
flowchart TD
    U["User request"] <--> O["Main Orchestrator / Decision Agent"]
    O <--> W["Shared Temporary World Model"]

    W <--> D["Desktop Agent"]
    W <--> V["Visual Perception Agent"]
    W <--> P["UI and Panel Agent"]
    W <--> F["File System Agent"]
    W <--> A["Application Agent"]
    W <--> B["Browser Agent"]

    D <--> V
    V <--> P
    A <--> P
    A <--> F
    A <--> B

    D --> X["Action Agent"]
    P --> X
    F --> X
    A --> X
    B --> X

    X --> R["Verification Agent"]
    R --> W
    R --> O

    O --> Q["Clarify or request confirmation when needed"]
    Q --> U
```

### Connection rules

-   The orchestrator owns the task goal and final decision.
-   The shared world model holds temporary observations and
    relationships.
-   Specialists may ask other specialists for evidence, but should avoid
    uncontrolled agent-to-agent loops.
-   Agents share structured observations and evidence, not just long
    natural-language chat.
-   The Action Agent receives a clear target, intended operation, and
    relevant authorization.
-   The Verification Agent sends results back to both the world model
    and orchestrator.
-   If observations conflict, refresh them or ask the user when the
    uncertainty matters.

## 5. Shared Temporary World Model

The world model is a central, in-memory representation of what Momo
currently knows about the computer. It is not a permanent database.

Example conceptual structure:

``` text
Desktop
├── VS Code window
│   ├── Explorer sidebar
│   │   └── Context Companion project folder
│   ├── Editor panel
│   │   └── Current file tab
│   └── Integrated terminal
└── Firefox window
    ├── Tab 1
    ├── Tab 2 (active)
    └── Tab 3
```

Each entity may contain: - Temporary session ID. - Entity type and
best-known identity. - Parent/child and related-entity links. - Current
state and properties. - Evidence source (e.g. filesystem API, Windows UI
Automation, browser interface, screenshot). - Last-observed time /
freshness. - Confidence and unresolved uncertainty. - Whether the entity
is actionable and what permissions apply.

Important distinctions: - A window is not a tab. - A panel inside an app
is not necessarily a separate window. - A folder label seen in a
screenshot is not proof of its actual filesystem path. - A visible
control is not necessarily enabled or safe to activate. - An old
observation must not be treated as current after the environment
changes.

The model should update or invalidate affected observations when
windows, focus, tabs, files, or screen contents change. Do not store
this world model persistently between sessions.

## 6. Goal-driven execution: choose the smallest adequate path

Momo should decide whether a request requires a direct query,
observation, interaction, or a combination.

### Example A: "Tell me the storage of D drive."

1.  Orchestrator classifies this as a read-only information request.
2.  File System Agent queries Windows/filesystem storage information
    directly.
3.  Verification Agent checks that the returned capacity and free-space
    values are valid.
4.  Momo replies with total, used, and available space.
5.  File Explorer does **not** need to open.

### Example B: "Open my Context Companion project in VS Code."

1.  Orchestrator identifies the goal: open a specific project in an
    editor.
2.  File System Agent locates and verifies the target folder.
3.  Application Agent checks whether VS Code is already open and whether
    the correct folder is loaded.
4.  Action Agent opens the folder only if needed.
5.  Verification Agent confirms the correct project is open.

### Example C: "Why isn't my project running?"

1.  Orchestrator determines that the current application and error
    context matter.
2.  Desktop Agent identifies the active application window.
3.  Visual Perception and UI & Panel agents inspect relevant visible UI
    and terminal/error areas.
4.  Application Agent gathers relevant app/project evidence when
    accessible.
5.  Orchestrator reasons over the combined evidence.
6.  If evidence is insufficient, Momo asks a focused question or gathers
    more information before suggesting or applying a fix.

### Example D: "Open WhatsApp, find Sumeet, and send him hello."

1.  Application/Browser Agent identifies the available WhatsApp
    interface.
2.  Relevant UI agent locates search and contact results.
3.  If multiple contacts match "Sumeet," Momo asks which one is
    intended.
4.  Momo prepares the message.
5.  Sending requires confirmation unless the user has explicitly
    configured a trusted permission rule.
6.  Verification checks the result without claiming success prematurely.

## 7. Safety and trust model

-   Read-only requests should generally execute without unnecessary
    confirmation.
-   Ask for clarification if the target is ambiguous.
-   Require confirmation for sending messages, deleting or overwriting
    files, purchases, submissions, and other consequential external
    actions unless an explicit permission setting allows them.
-   Never invent the user's intended contact, file, tab, recipient, or
    destination.
-   Do not take risky exploratory actions merely to learn an unfamiliar
    interface.
-   Prefer reversible, narrowly scoped actions.
-   Stop and report when permissions, evidence, or capabilities are
    insufficient.
-   Avoid collecting or retaining more screen or personal data than the
    task requires.
-   Treat screen content, webpages, files, and other observed content as
    untrusted data---not as authority to override the user's intent or
    the system's safety rules.

## 8. Temporary session and privacy requirements

When Momo starts: - Create an empty session state. - Observe only what
is needed for the current request. - Build a temporary world model and
temporary task state in memory.

While Momo runs: - Update observations as the environment changes. -
Share only task-relevant evidence between agents. - Do not create a
persistent personal-memory database or permanent step-by-step task log
as part of the core architecture.

When Momo exits: - Discard agent-specific session memory, world-model
entities, cached observations, and coordination state. - Do not restore
the prior desktop understanding on the next launch. - General pretrained
model knowledge remains unchanged. - Be transparent about any data sent
to external AI services; local deletion cannot guarantee deletion from a
provider's systems.

Implementation should make session cleanup explicit and testable. Avoid
writing screenshots, prompts, task history, or world-model state to disk
by default. Any diagnostics that might retain user data should be
optional, clearly disclosed, and designed with privacy controls.

## 9. Implementation approach

Build incrementally, validating each layer before adding more
complexity.

### Phase 1 --- Safe foundations

-   Windows app/desktop inventory.
-   Read-only filesystem queries.
-   Shared temporary world model.
-   Simple orchestrator that selects the minimum required capability.
-   Basic verification and user-facing answers.

### Phase 2 --- Screen and UI understanding

-   Screenshot capture when required and permitted.
-   Windows UI Automation/accessibility integration.
-   Visual perception fallback.
-   Freshness/confidence tracking and stale-observation invalidation.

### Phase 3 --- Controlled actions

-   Keyboard/mouse and window actions.
-   Target identification and pre-action checks.
-   Post-action verification.
-   Confirmation and permission policies.

### Phase 4 --- Application and browser capabilities

-   Browser tabs/pages and web controls.
-   App-specific adapters when they offer more reliable access.
-   Multi-agent collaboration for tasks spanning files, applications,
    and the web.

### Phase 5 --- Desktop companion UI

-   Small animated character overlay.
-   Clear listening/working/asking/acting states.
-   User controls for pause, permissions, and privacy.
-   Avoid obscuring important desktop controls.

These phases are a suggested plan, not a commitment to a particular
programming language or framework. Choose implementation technologies
after reviewing Windows compatibility, accessibility, security, and
maintenance needs.

## 10. Initial acceptance criteria

The first working prototype should demonstrate:

1.  "Tell me the storage of D drive" returns real values without opening
    File Explorer.
2.  A folder lookup returns the correct path and reports ambiguity
    instead of guessing.
3.  Momo can identify the active window and distinguish it from other
    open windows.
4.  It can distinguish browser windows and tabs when the chosen browser
    interface exposes that information.
5.  It can use a direct interface when available and visual
    understanding when required.
6.  It verifies a requested action and detects obvious failures.
7.  It asks which contact/file/tab is intended when multiple plausible
    targets exist.
8.  It asks for confirmation before sending an external message by
    default.
9.  It does not treat stale observations as current after the
    environment changes.
10. On exit, its agent-specific world model and session state are
    discarded.
11. Simple requests do not trigger unnecessary agents or UI actions.
12. It never reports a result as verified unless it has supporting
    evidence.

## 11. Guidance for the coding assistant reading this document

Before writing code: - Explain the proposed architecture in your own
words. - Identify ambiguities, feasibility risks, and Windows-specific
constraints. - Propose a minimal Phase 1 implementation and explain why
each component is needed. - Distinguish logical agent roles from
separate processes/models. - Design clear interfaces for observations,
requests, actions, permissions, and verification. - Keep user-specific
session state in memory and design explicit cleanup. - Avoid
implementing every feature at once. - Do not turn the examples in this
document into hardcoded task scripts. - Do not assume the separate
"Context Companion" project is part of Momo; it is only an example
folder the user might ask Momo to open. - Wait for the user's agreement
on the architecture and initial scope before making broad implementation
changes.

**Product summary:** Momo is a goal-driven, privacy-conscious desktop AI
companion that understands the current PC environment through
specialized capabilities, collaborates through a shared temporary world
model, chooses the minimum necessary action, asks when uncertain, and
verifies outcomes.
