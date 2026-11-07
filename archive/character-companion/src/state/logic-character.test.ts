import { describe, expect, it, vi, afterEach } from "vitest";
import { activationStep, type ActivationState } from "./activation";
import { companionReducer, initialCompanionState, type CompanionState } from "./companionState";
import { chordFromEvent, validateShortcut } from "./shortcut";
import { defaultPrefs, loadPrefs, savePrefs, PREFS_KEY, type KV } from "./settings";
import { parseRuntimeEvent, UI_STATES } from "../types/runtime-events";
import { resolveExpression, manifest } from "../companion/expression";
import { MockRuntime, SCENARIOS } from "../runtime/mockRuntime";
import type { RuntimeEvent } from "../types/runtime-events";

const idle: ActivationState = { recording: false, busy: false };

describe("expression fallback (manifest)", () => {
  const all = new Set(["happy"]);
  it("every state resolves to something when 'happy' exists", () => {
    for (const s of UI_STATES) expect(resolveExpression(s, all)).toBe("happy");
  });
  it("uses first available in the list", () => {
    expect(resolveExpression("asking", new Set(["surprised", "happy"]))).toBe("surprised");
    expect(resolveExpression("sleeping", new Set(["sleepy", "happy"]))).toBe("sleepy");
  });
  it("returns null with no sprites", () => {
    expect(resolveExpression("idle", new Set())).toBeNull();
  });
  it("manifest covers all 13 states and 5 characters", () => {
    expect(Object.keys(manifest.stateToExpression).sort()).toEqual([...UI_STATES].sort());
    expect(manifest.characters).toHaveLength(5);
  });
});

describe("mock runtime", () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers();
    const rt = new MockRuntime();
    const events: RuntimeEvent[] = [];
    rt.subscribe((e) => events.push(e));
    return { rt, events };
  }

  it("every scenario ends in the expected UI state", () => {
    const expected: Record<string, string> = {
      storage: "success", partial: "partial_success", ambiguous: "asking", confirm_send: "blocked",
      fail: "sorry", fatal: "error", unrelated: "idle", mic_denied: "disabled",
    };
    for (const { id } of SCENARIOS) {
      const { rt, events } = setup();
      rt.setScenario(id);
      rt.startVoice();
      rt.stopVoice();
      vi.advanceTimersByTime(10_000);
      const final = events.reduce(companionReducer, initialCompanionState);
      expect(final.ui, id).toBe(expected[id]);
      rt.dispose();
    }
  });

  it("confirmation approve -> success, cancel -> idle; clarification -> success", () => {
    for (const [approve, ui] of [[true, "success"], [false, "idle"]] as const) {
      const { rt, events } = setup();
      rt.setScenario("confirm_send");
      rt.startVoice(); rt.stopVoice();
      vi.advanceTimersByTime(5000);
      rt.respondConfirmation(approve);
      vi.advanceTimersByTime(5000);
      expect(events.reduce(companionReducer, initialCompanionState).ui).toBe(ui);
    }
    const { rt, events } = setup();
    rt.setScenario("ambiguous");
    rt.startVoice(); rt.stopVoice();
    vi.advanceTimersByTime(5000);
    rt.respondClarification("the first one");
    vi.advanceTimersByTime(5000);
    expect(events.reduce(companionReducer, initialCompanionState).ui).toBe("success");
  });

  it("drops invalid events at the boundary", () => {
    const { rt, events } = setup();
    rt.emit({ type: "task.completed", taskId: "t", summary: "s", verified: false });
    rt.emit({ garbage: true });
    expect(events).toHaveLength(0);
    expect(rt.droppedEvents).toBe(2);
  });

  it("session cleanup: dispose cancels pending work and stops delivery", () => {
    const { rt, events } = setup();
    rt.startVoice(); rt.stopVoice();
    const before = events.length;
    rt.dispose();
    vi.advanceTimersByTime(10_000);
    expect(events.length).toBe(before);
    rt.emit({ type: "voice.started", sessionId: "x" });
    expect(events.length).toBe(before);
  });
});
