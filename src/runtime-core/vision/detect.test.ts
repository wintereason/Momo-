import { describe, expect, it } from "vitest";
import { ISSUE, MAX_CANDIDATES, buildCandidates, groupPhrases, labelKey, misreadLike, parseRaw, symbolLike, textSanity, type RawDetect } from "./detect";
import type { CaptureFrame } from "./capture";

const frame: CaptureFrame = { session: 3, frame: 7, hwnd: 42, w: 1640, h: 1280, l: 600, t: 240, pw: 1640, ph: 1280, scale: 1, visible: { l: 0, t: 0, w: 2880, h: 1800 }, clipped: false, dpi: 192, monitorDpi: 192, ms: 30, at: 5000 };
const raw = (over: Partial<RawDetect> = {}): RawDetect => ({ w: 1640, h: 1280, words: [], shapes: [], crops: [], msCopy: 5, msShapes: 20, msCrops: 150, msOcr: 140, ...over });
/** a button 260x100 with a centred label, as the Chrome test page draws them */
const button = (l: number, t: number, label: string, o: { w?: number; h?: number; fill?: number; contrast?: number } = {}) => {
  const w = o.w ?? 260, h = o.h ?? 100;
  const parts = label.split(" ");
  const widths = parts.map((x) => x.length * 22);
  const total = widths.reduce((n, x) => n + x, 0) + 12 * (parts.length - 1);
  let x = l + (w - total) / 2;
  const words: RawDetect["words"] = parts.map((word, i) => { const e: RawDetect["words"][number] = [word, Math.round(x), t + h / 2 - 14, widths[i], 28]; x += widths[i] + 12; return e; });
  return { shape: [l, t, w, h, o.fill ?? 90, o.contrast ?? 200] as RawDetect["shapes"][number], words, label };
};
const make = (...bs: Array<ReturnType<typeof button>>) => raw({ shapes: bs.map((b) => b.shape), words: bs.flatMap((b) => b.words), crops: bs.map((b, i) => ({ i, texts: [b.label, b.label] })) });

describe("candidates from one detection", () => {
  it("a labelled rectangle is a button-like candidate with a high score, in physical screen pixels", () => {
    const b = button(80, 140, "SAVE");
    const c = buildCandidates(raw({ shapes: [b.shape], words: b.words, crops: [{ i: 0, texts: ["SAVE", "SAVE"] }] }), frame);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "button_like", text: "SAVE", evidence: "shape+text", usable: true, frame: 7, session: 3, hwnd: 42, capturedAt: 5000, rect: { l: 680, t: 380, w: 260, h: 100 } });
    expect(c[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(c[0].issues).toEqual([]);
    expect(c[0].id).toBe("v7.1");
  });

  it("a rectangle with no readable label is a SHAPE: never usable, and nothing is guessed about what it does", () => {
    const c = buildCandidates(raw({ shapes: [[370, 60, 60, 50, 100, 137]] }), frame);
    expect(c[0]).toMatchObject({ kind: "shape", usable: false, evidence: "shape", issues: [ISSUE.noLabel] });
    expect(c[0].text).toBeUndefined();
    expect(c[0].confidence).toBeLessThanOrEqual(0.7);
  });

  it("words that are in no rectangle are loose TEXT: listed, never a target (a word is not a button)", () => {
    const c = buildCandidates(raw({ words: [["Save", 100, 100, 70, 28]] }), frame);
    expect(c[0]).toMatchObject({ kind: "text", text: "Save", usable: false, evidence: "text", issues: [ISSUE.textOnly] });
  });

  it("a big panel with a paragraph is a REGION, not a button", () => {
    const words: RawDetect["words"] = [];
    for (let i = 0; i < 6; i++) for (const [j, w] of ["Some", "long", "paragraph", "text"].entries()) words.push([w, 120 + j * 120, 520 + i * 40, 100, 28]);
    const c = buildCandidates(raw({ shapes: [[100, 500, 900, 300, 95, 60]], words }), frame);
    expect(c.find((x) => x.kind === "region")).toMatchObject({ usable: false, issues: [ISSUE.region] });
    expect(c.some((x) => x.kind === "button_like")).toBe(false);
  });

  it("two candidates with the same label are BOTH refused as ambiguous, each naming the other", () => {
    const c = buildCandidates(make(button(80, 140, "OK"), button(400, 140, "Ok"), button(720, 140, "Cancel")), frame);
    const oks = c.filter((x) => labelKey(x.text ?? "") === "ok");
    expect(oks).toHaveLength(2);
    for (const o of oks) {
      expect(o.usable).toBe(false);
      expect(o.issues).toContain(ISSUE.ambiguous);
      expect(o.ambiguousWith).toEqual(oks.filter((x) => x.id !== o.id).map((x) => x.id));
    }
    expect(c.find((x) => x.text === "Cancel")?.usable).toBe(true);
  });

  it("a one-letter reading is dropped (too short to be sure what it says, and what a picture looks like when read as a letter): the rectangle is a shape", () => {
    const c = buildCandidates(make(button(80, 140, "X", { w: 120 })), frame);
    expect(c[0].kind).toBe("shape");
    expect(c[0].usable).toBe(false);
    expect(c[0].issues).toContain(ISSUE.noLabel);
  });

  it("a faint rectangle whose 'text' is only symbols has no label at all: a shape, never usable", () => {
    const b = button(80, 140, "?!", { fill: 71, contrast: 15 });
    const c = buildCandidates(make(b), frame);
    expect(c[0].kind).toBe("shape");
    expect(c[0].usable).toBe(false);
    expect(c[0].issues).toContain(ISSUE.noLabel);
  });
  it("a faint rectangle with a clean single reading scores much lower than a strong one, and never reaches the full score", () => {
    const faint = buildCandidates(raw({ shapes: [[80, 140, 260, 100, 71, 15]], crops: [{ i: 0, texts: ["Apply", ""] }] }), frame)[0];
    const strong = buildCandidates(raw({ shapes: [[80, 140, 260, 100, 95, 220]], crops: [{ i: 0, texts: ["Apply", "Apply"] }] }), frame)[0];
    expect(faint.confidence).toBeLessThan(strong.confidence - 0.2);
    expect(faint.usable).toBe(false); // a single reading
  });

  it("the score rises with how clearly the rectangle stands out and fills its box", () => {
    const hi = buildCandidates(make(button(80, 140, "Apply", { fill: 95, contrast: 220 })), frame)[0].confidence;
    const mid = buildCandidates(make(button(80, 140, "Apply", { fill: 80, contrast: 60 })), frame)[0].confidence;
    const lo = buildCandidates(make(button(80, 140, "Apply", { fill: 72, contrast: 16 })), frame)[0].confidence;
    expect(hi).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(lo);
  });

  it("a label belongs to the SMALLEST rectangle that holds it (a button inside a panel)", () => {
    const b = button(300, 300, "Apply");
    const c = buildCandidates(raw({ shapes: [[100, 200, 900, 500, 96, 40], b.shape], words: b.words }), frame);
    expect(c.find((x) => x.text === "Apply")?.rect).toMatchObject({ w: 260, h: 100 });
    expect(c.find((x) => x.kind === "shape")?.rect.w).toBe(900); // the panel stays a label-less shape
  });

  it("two overlapping detections of one rectangle become one candidate", () => {
    const b = button(80, 140, "Open file");
    const c = buildCandidates(raw({ shapes: [b.shape, [84, 142, 254, 96, 88, 120]], words: b.words }), frame);
    expect(c.filter((x) => x.kind === "button_like")).toHaveLength(1);
  });

  it("a multi-word label is read as one phrase; labels far apart stay separate", () => {
    const p = groupPhrases([["Open", 100, 100, 80, 28], ["file", 190, 100, 60, 28], ["SAVE", 700, 100, 90, 28]]);
    expect(p.map((x) => x.text)).toEqual(["Open file", "SAVE"]);
  });

  it("everything is clamped to the window: a box that runs off the frame cannot point outside it", () => {
    const c = buildCandidates(raw({ shapes: [[1600, 1240, 200, 100, 90, 100]] }), frame);
    expect(c[0].rect.l + c[0].rect.w).toBeLessThanOrEqual(frame.l + frame.w);
    expect(c[0].rect.t + c[0].rect.h).toBeLessThanOrEqual(frame.t + frame.h);
  });

  it("at most MAX_CANDIDATES come back, the usable and most confident first", () => {
    const shapes: RawDetect["shapes"] = [];
    for (let i = 0; i < 80; i++) shapes.push([20 + (i % 10) * 150, 20 + Math.floor(i / 10) * 130, 100, 60, 90, 100]);
    const c = buildCandidates(raw({ shapes }), frame);
    expect(c.length).toBe(MAX_CANDIDATES);
  });

  it("is deterministic: the same detection always gives the same candidates", () => {
    const r = make(button(80, 140, "SAVE"), button(400, 140, "CANCEL"));
    expect(buildCandidates(r, frame)).toEqual(buildCandidates(r, frame));
  });

  it("a fixed set of sentences: no candidate issue contains any recognised text", () => {
    const c = buildCandidates(make(button(80, 140, "SecretWord"), button(400, 140, "SecretWord")), frame);
    for (const x of c) for (const i of x.issues) expect(i).not.toMatch(/SecretWord/);
  });
});

describe("a label is what at least TWO readings say identically (two enlargements of the rectangle, and the whole frame)", () => {
  /** crop readings (two enlargements) and the words the whole-frame pass found inside the rectangle */
  const one = (crops: string[], frameText: string | null) => {
    const b = button(80, 140, "X"); // geometry only
    const words = frameText === null ? [] : button(80, 140, frameText).words;
    return buildCandidates(raw({ shapes: [b.shape], words, crops: crops.length ? [{ i: 0, texts: crops }] : [] }), frame)[0];
  };

  it("three identical readings: the label stands, full score", () => {
    const c = one(["Save", "Save"], "Save");
    expect(c).toMatchObject({ kind: "button_like", text: "Save", usable: true });
    expect(c.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it("two enlargements agree and the whole frame misread: the two win (the vote)", () => {
    const c = one(["Sign in", "Sign in"], "Ign I");
    expect(c).toMatchObject({ text: "Sign in", usable: true });
  });
  it("the rectangle's own readings must not disagree: one that dropped letters VETOES the label even when the whole frame agrees with the other", () => {
    const c = one(["Sto", "Stop"], "Stop");
    expect(c.usable).toBe(false);
    expect(c.issues).toContain(ISSUE.disagree);
  });
  it("a third reading that disagrees with two that agree vetoes them (they can agree on the same wrong text)", () => {
    const c = one(["Pa IJS e", "Pa IJS e", "Pause"], null);
    expect(c.usable).toBe(false);
    expect(c.issues).toContain(ISSUE.disagree);
  });
  it("a third reading that is empty does not veto (it simply could not read it)", () => {
    expect(one(["Pause", "Pause", ""], null).usable).toBe(true);
  });
  it("the whole-frame reading only ever supports: when it disagrees with unanimous readings of the rectangle itself, the label stands", () => {
    expect(one(["Pause", "Pause", "Pause"], "Pa use")).toMatchObject({ text: "Pause", usable: true });
  });
  it("when two agree only after dropping letters ('Sto' and 'Stop' alone) that is NOT agreement: not usable", () => {
    const c = one(["Sto", "Stop"], null);
    expect(c.usable).toBe(false);
    expect(c.issues).toContain(ISSUE.disagree);
  });
  it("readings that all differ: not usable, with the reason (a wrong label is worse than no label)", () => {
    const c = one(["Delete", "Delet item"], "Save");
    expect(c.usable).toBe(false);
    expect(c.issues).toContain(ISSUE.disagree);
  });
  it("a substituted letter is never agreement ('Safe' vs 'Save')", () => {
    expect(one(["Safe", "Save"], null).usable).toBe(false);
  });
  it("the label shown is the most complete form of the agreeing readings", () => {
    expect(one(["Open file", "open file"], null).text).toBe("Open file");
  });
  it("only ONE reading exists: never usable, however clean it reads (a single reading cannot be checked against anything)", () => {
    const c = one(["Export", ""], null);
    expect(c).toMatchObject({ kind: "button_like", text: "Export", usable: false });
    expect(c.issues).toContain(ISSUE.weakReading);
    expect(c.confidence).toBeLessThanOrEqual(0.85);
    const f = one([], "Export");
    expect(f.usable).toBe(false);
    expect(f.issues).toContain(ISSUE.weakReading);
  });
  it("two readings that AGREE on a garbled label are still refused (both can agree on the same misread)", () => {
    for (const garbled of ["p\\ay", "He\\p", "Toggle_", "Revie.v", "Sav|e"]) {
      const c = one([garbled, garbled], garbled);
      expect(c.usable, garbled).toBe(false);
      expect(c.issues, garbled).toContain(ISSUE.garbled);
    }
  });
  it("a clean label with ordinary punctuation is not mistaken for a garble", () => {
    for (const ok of ["Save as...", "Open file", "Sign-in", "Add new", "OK", "Don't save", "Yes & close"]) expect(misreadLike(ok), ok).toBe(false);
  });
  it("a picture read as letters (a ring as 'O', a bar as 'I', 'oo', '0') is never a label: the rectangle stays a shape", () => {
    for (const glyph of ["O", "o", "0", "OO", "Il", "l", "|", "( )"]) {
      const c = one([glyph, glyph], null);
      expect(c.kind, glyph).toBe("shape");
      expect(c.usable).toBe(false);
    }
    expect(symbolLike("OO")).toBe(true);
    expect(symbolLike("Oil")).toBe(true);
    expect(symbolLike("Open")).toBe(false);
  });
  it("garbage readings are ignored: the rectangle is a shape with no label", () => {
    expect(one(["# ~ |", "|"], null).kind).toBe("shape");
  });
});

describe("a window that sticks out past the screen: what is outside may be missing from the picture", () => {
  it("a candidate that is not entirely on the screen is never usable, with the reason", () => {
    const edgy: CaptureFrame = { ...frame, l: 2000, t: 600, clipped: true }; // the window's right part is beyond x = 2880
    const b = button(700, 140, "SAVE", { w: 260 }); // its right edge at 2000 + 960 = 2960 > 2880
    const c = buildCandidates(raw({ shapes: [b.shape], words: b.words, crops: [{ i: 0, texts: ["SAVE", "SAVE"] }] }), edgy);
    expect(c[0].kind).toBe("button_like");
    expect(c[0].usable).toBe(false);
    expect(c[0].issues).toContain(ISSUE.offscreen);
  });
  it("a candidate wholly on the screen is unaffected even when the window as a whole sticks out", () => {
    const edgy: CaptureFrame = { ...frame, l: 2000, t: 600, clipped: true };
    const b = button(80, 140, "SAVE");
    const c = buildCandidates(raw({ shapes: [b.shape], words: b.words, crops: [{ i: 0, texts: ["SAVE", "SAVE"] }] }), edgy);
    expect(c[0].usable).toBe(true);
  });
});

describe("a DPI-virtualized window: the picture is the logical size, the screen position is scaled", () => {
  const virt: CaptureFrame = { ...frame, w: 820, h: 640, pw: 1640, ph: 1280, scale: 2, dpi: 96, monitorDpi: 192 };
  it("a rectangle at picture (80, 140) size 130x50 is at l + 160, t + 280 on the screen, size 260x100", () => {
    const c = buildCandidates(raw({ w: 820, h: 640, shapes: [[80, 140, 130, 50, 92, 236]], words: [["Save", 110, 155, 60, 18]], crops: [{ i: 0, texts: ["Save", "Save"] }] }), virt);
    expect(c[0].rect).toEqual({ l: 600 + 160, t: 240 + 280, w: 260, h: 100 });
    expect(c[0].kind).toBe("button_like");
  });
  it("button size limits are judged in the picture's own pixels (a 130x50 button is a normal button at 96 DPI)", () => {
    const c = buildCandidates(raw({ w: 820, h: 640, shapes: [[80, 140, 130, 50, 92, 236]], crops: [{ i: 0, texts: ["Save", "Save"] }] }), virt);
    expect(c[0].kind).toBe("button_like");
  });
  it("it stays inside the window on the screen", () => {
    const c = buildCandidates(raw({ w: 820, h: 640, shapes: [[780, 600, 130, 100, 92, 100]] }), virt);
    expect(c[0].rect.l + c[0].rect.w).toBeLessThanOrEqual(virt.l + virt.pw);
    expect(c[0].rect.t + c[0].rect.h).toBeLessThanOrEqual(virt.t + virt.ph);
  });
  it("an ordinary frame (scale 1) maps one to one", () => {
    const c = buildCandidates(raw({ shapes: [[100, 100, 260, 100, 92, 100]], crops: [{ i: 0, texts: ["Save", "Save"] }] }), frame);
    expect(c[0].rect).toEqual({ l: 700, t: 340, w: 260, h: 100 });
  });
});

describe("text rules", () => {
  it("sanity: real words are fine, noise is not", () => {
    expect(textSanity("Save", 28)).toBe(1);
    expect(textSanity("###", 28)).toBe(0);
    expect(textSanity("a", 28)).toBeLessThanOrEqual(0.4);
    expect(textSanity("Save", 5)).toBeLessThan(1);
    expect(textSanity("�x", 20)).toBe(0);
  });
  it("labels compare without case, spacing or punctuation", () => {
    expect(labelKey("Open  File…")).toBe(labelKey("open file"));
    expect(labelKey("OK")).not.toBe(labelKey("Cancel"));
  });
});

describe("the helper's answer is checked to the last field", () => {
  const good = { ok: true, w: 1640, h: 1280, words: [["Save", 10, 10, 50, 20]], shapes: [[1, 2, 3, 4, 90, 100]], crops: [[0, "Save", "Save"]], msCopy: 4, msShapes: 25, msCrops: 90, msOcr: 130 };
  const dims = { w: 1640, h: 1280 };
  it("accepts a well-formed answer", () => expect(parseRaw(good, dims)).toMatchObject({ w: 1640, words: [["Save", 10, 10, 50, 20]], msOcr: 130 }));
  it("refuses anything odd, whole: a wrong size, wrong shapes, too many items, a missing field", () => {
    for (const bad of [null, {}, { ...good, ok: false }, { ...good, w: 10 }, { ...good, words: [["x", 1, 2, 3]] }, { ...good, shapes: [[1, 2, 3, 4, 5]] }, { ...good, words: Array(401).fill(["a", 1, 2, 3, 4]) }, { ...good, shapes: [[1, 2, 3, 4, 90, NaN]] }, { ...good, words: [[5, 1, 2, 3, 4]] }, { ...good, crops: [[3, "x", "x"]] }, { ...good, crops: [[0, 5]] }, { ...good, crops: "x" }, { ...good, crops: [[0, "a", "b", "c", "d"]] }]) {
      expect(parseRaw(bad, dims), JSON.stringify(bad).slice(0, 60)).toBeNull();
    }
  });
  it("cleans and bounds recognised text", () => {
    const r = parseRaw({ ...good, words: [["A\u0000B" + "x".repeat(200), 1, 2, 3, 4]] }, dims)!;
    expect(r.words[0][0].length).toBeLessThanOrEqual(80);
    expect(r.words[0][0]).not.toMatch(/\u0000/);
  });
});
