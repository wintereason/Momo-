import { describe, expect, it } from "vitest";
import { planTarget, verifyInsertion, type FieldInfo, type TargetScan } from "./dictationTarget";

const f = (name: string, over: Partial<FieldInfo> = {}): FieldInfo => ({ rid: name, name, type: "Edit", editable: true, password: false, rect: { l: 0, t: 0, w: 100, h: 20 }, ...over });
const scan = (over: Partial<TargetScan> = {}): TargetScan => ({ ok: true, hwnd: 7, win: { l: 0, t: 0, w: 800, h: 600 }, focused: null, candidates: [], truncated: false, ...over });

describe("planTarget: detect -> identify", () => {
  it("uses the field that already has the focus, even when others exist", () => {
    const a = f("a");
    expect(planTarget(scan({ focused: a, candidates: [a, f("b")] }))).toMatchObject({ kind: "ready", via: "focused", field: a });
  });
  it("one suitable field and nothing focused: use it", () => {
    expect(planTarget(scan({ candidates: [f("only")] }))).toMatchObject({ kind: "ready", via: "only-field" });
  });
  it("several fields and none focused: ask which", () => {
    expect(planTarget(scan({ candidates: [f("a"), f("b")] })).kind).toBe("choose");
  });
  it("no field: ask the user to click inside one", () => {
    expect(planTarget(scan())).toEqual({ kind: "click" });
  });
  it("a scan that failed is never guessed at", () => {
    expect(planTarget(null)).toEqual({ kind: "click" });
    expect(planTarget(scan({ ok: false }))).toEqual({ kind: "click" });
  });
  it("a focused password box blocks everything", () => {
    expect(planTarget(scan({ focused: f("pw", { password: true, editable: false }), candidates: [f("a")] }))).toEqual({ kind: "password" });
  });
  it("ignores read-only and password candidates", () => {
    expect(planTarget(scan({ candidates: [f("ro", { editable: false }), f("pw", { password: true }), f("ok")] }))).toMatchObject({ kind: "ready", field: { name: "ok" } });
  });
  it("a focused element that is not editable (a web page itself) does not count", () => {
    expect(planTarget(scan({ focused: f("page", { type: "Document", editable: false }) }))).toEqual({ kind: "click" });
  });
});

describe("verifyInsertion: verify", () => {
  it("confirms text added at the end, the start and the middle, with the old content intact", () => {
    expect(verifyInsertion("Hello", "Hello world", " world")).toBe("confirmed");
    expect(verifyInsertion("world", "Hello world", "Hello ")).toBe("confirmed");
    expect(verifyInsertion("ab", "aXYb", "XY")).toBe("confirmed");
    expect(verifyInsertion("", "Hi.", "Hi.")).toBe("confirmed");
  });
  it("handles repeated characters around the insertion point", () => {
    expect(verifyInsertion("aaa", "aaaaaa", "aaa")).toBe("confirmed");
    expect(verifyInsertion("abab", "ababab", "ab")).toBe("confirmed");
  });
  it("treats CRLF and LF alike", () => {
    expect(verifyInsertion("a\r\nb", "a\nXb", "X")).toBe("confirmed");
  });
  it("fails when nothing changed", () => {
    expect(verifyInsertion("Hello", "Hello", "world")).toBe("failed");
  });
  it("flags existing content that was replaced instead of kept", () => {
    expect(verifyInsertion("Hello world", "Dictated", "Dictated")).toBe("overwritten");
  });
  it("says unconfirmed when the text is there but other text changed too", () => {
    expect(verifyInsertion("teh cat", "the cat sat", " sat")).toBe("unconfirmed");
  });
  it("says unreadable when the field's text cannot be read", () => {
    expect(verifyInsertion(null, "x", "x")).toBe("unreadable");
    expect(verifyInsertion("x", null, "x")).toBe("unreadable");
  });
});
