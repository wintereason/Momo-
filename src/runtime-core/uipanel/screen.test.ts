import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, decide } from "../action";
import { cleanScreenText, collectControls, collectText, errorLines, usable } from "../shared/screenText";
import type {      UiNode } from "../shared/ports";

// ---------- fakes ----------
const N = (type: string, name: string, extra: Partial<UiNode> = {}): UiNode => ({ type, name, enabled: true, offscreen: false, ...extra });




// ---------- helpers ----------
describe("screen text helpers", () => {
  it("drops passwords and hidden elements before anything else", () => {
    const items = [N("Edit", "Password", { password: true, value: "hunter2" }), N("Text", "hidden", { offscreen: true }), N("Text", "visible")];
    expect(usable(items).map((i) => i.name)).toEqual(["visible"]);
    expect(collectText(items)).toEqual(["visible"]);
    expect(JSON.stringify(collectText(items))).not.toContain("hunter2");
  });
  it("includes what is typed in edit boxes, but never from a password box", () => {
    expect(collectText([N("Edit", "To", { value: "alice@example.com" })])).toEqual(["alice@example.com"]);
    expect(collectText([N("Edit", "Pass", { value: "secret", password: true })])).toEqual([]);
  });
  it("neutralises control and bidi characters and caps line length", () => {
    expect(cleanScreenText("a\u0000b\u202ec\u200bd\n e")).toBe("a b c d e");
    expect(cleanScreenText("y".repeat(500))).toHaveLength(160);
  });
  it("de-duplicates and caps lines", () => {
    const items = Array.from({ length: 30 }, (_, i) => N("Text", `line ${i % 20}`));
    expect(collectText(items)).toHaveLength(14);
    expect(new Set(collectText(items)).size).toBe(14);
  });
  it("lists controls with their enabled state, skipping duplicates", () => {
    const c = collectControls([N("Button", "Save"), N("Button", "save"), N("Button", "Undo", { enabled: false }), N("Text", "not a control")]);
    expect(c).toEqual([{ type: "Button", name: "Save", enabled: true }, { type: "Button", name: "Undo", enabled: false }]);
  });
  it("finds error lines", () => {
    expect(errorLines(["All good", "Error: disk full", "Permission denied (0x80070005)", "Warning: low memory"])).toEqual([
      "Error: disk full", "Permission denied (0x80070005)", "Warning: low memory",
    ]);
  });
});

describe("safety gate: screen reads are private", () => {
  it("reading a window on this PC does not ask by default, and the setting can make it ask", () => {
    expect(DEFAULT_POLICY.confirmScreenRead).toBe(false);
    expect(decide({ risk: "sensitive_read" }, DEFAULT_POLICY)).toBe("allow");
    expect(decide({ risk: "sensitive_read" }, { ...DEFAULT_POLICY, confirmScreenRead: true })).toBe("confirm");
    expect(decide({ risk: "consequential" }, { confirmReversible: false, confirmScreenRead: false })).toBe("confirm");
  });
});
