# Merged Build Order (overrides the phase numbers in docs 01 and 02)

Docs 01 and 02 each had their own "Phase 1". This file is the single plan.

## Phase A — UI shell with MOCK runtime (no AI, no real actions)
- Pick and scaffold the desktop shell (see open decisions).
- Companion picker with 5 cards, selection persisted locally.
- Always-on-top draggable widget near bottom-right, with table scene + 2D sprite character, compact mode and larger panel, position remembered.
- Task/transcript panel, confirmation card, clarification card, result card.
- Settings: voice mode (hold/toggle radio), shortcut recorder, privacy toggles (defaults off), appearance (companion, size, opacity, reduce motion).
- `ExpressionController` mapped to all semantic states (doc 02 section 4) using the manifest fallbacks.
- Typed `RuntimeEvent` contract + a mock runtime that can replay every state, so all expressions and transitions can be tested by hand.
- Exit criteria: all 13 UI states reachable via mock events; settings persist; widget usable with placeholder art.

## Phase B — Voice activation and transcription
- Single `ActivationMode`; global shortcut; mic button; recording indicator; cancel.
- Mic permission denied, device unplugged, empty audio, transcription failure all handled.
- Speech-to-text adapter (provider chosen in decisions); transcript preview.
- 30-minute inactivity -> sleeping; wake by shortcut/button.

## Phase C — Runtime foundations (read-only, deterministic)
- Session-only temporary world model with source, freshness, confidence, invalidation.
- Filesystem agent: drives/capacity/free space, folder lookup with ambiguity reporting.
- Desktop agent: windows, active window, focus.
- Minimal orchestrator + intent router (task / unrelated / ambiguous) choosing the minimum capability.
- Verification (lightweight for read-only). Explicit, tested session cleanup on exit.
- Exit criteria: "storage of D drive" returns real values without opening Explorer and without an unnecessary LLM call.

## Phase D — Connect UI and runtime
- Replace the mock runtime with the real one over the same event contract.
- Permission/safety gate, clarification and confirmation flows end to end.

## Phase E — Screen and UI understanding
- Screenshot on demand, Windows UI Automation, visual fallback, stale-observation handling.

## Phase F — Controlled actions
- Mouse/keyboard/window actions on identified current targets, pre-action checks, post-action verification, permission policies.

## Phase G — Applications and browser
- Browser windows vs tabs vs pages, app adapters, multi-agent tasks.

## Phase H — 3D polish (optional)
- Import `.glb` models, connect animations to semantic states, blossom environment, performance tuning for the target laptop.

## Phase I — Privacy and resilience
- Verify storage defaults and deletion, API limits, offline mode, restart, shortcut conflicts, stale results.
