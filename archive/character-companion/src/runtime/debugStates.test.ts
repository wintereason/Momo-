import { describe, expect, it } from "vitest";
import { actionsToReach } from "./debugStates";
import { companionReducer, initialCompanionState } from "../state/companionState";
import { UI_STATES } from "../types/runtime-events";

describe("phase A exit criterion: all 13 UI states reachable", () => {
  for (const st of UI_STATES) {
    it(`reaches ${st}`, () => {
      expect(actionsToReach(st).reduce(companionReducer, initialCompanionState).ui).toBe(st);
    });
  }
  it("covers exactly 13 states", () => expect(UI_STATES).toHaveLength(13));
});
