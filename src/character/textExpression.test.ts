import { describe, expect, it } from "vitest";
import { PERSONALITIES } from "./config";
import { EXPRESSIONS } from "./face";
import { PROTECTED, expressionAt, expressionForSentence, faceWhileSpeaking, sentenceSpans, settleForPersona } from "./textExpression";

describe("the face follows the words Momo says", () => {
  it("reads the meaning of a sentence", () => {
    expect(expressionForSentence("Sorry, I couldn't do that.")).toBe("apologetic");
    expect(expressionForSentence("I couldn't open that folder.")).toBe("apologetic");
    expect(expressionForSentence("Careful: unsaved work will be lost.")).toBe("warning");
    expect(expressionForSentence("Hello! How can I help?")).toBe("happy");
    expect(expressionForSentence("Great, it's all done!")).toBe("excited");
    expect(expressionForSentence("Opened Notepad.")).toBe("happy");
    expect(expressionForSentence("Wow, that is unexpected.")).toBe("surprised");
    expect(expressionForSentence("Unfortunately there are no results.")).toBe("sad");
    expect(expressionForSentence("I am not sure about this one.")).toBe("worried");
    expect(expressionForSentence("Let me check that for you.")).toBe("thinking");
    expect(expressionForSentence("Which one do you want?")).toBe("listening");
    expect(expressionForSentence("The Z drive was not found on this computer.")).toBe("sad");
    expect(expressionForSentence("I did not find any good results.")).toBeNull(); // "good" is not good news here
    expect(expressionForSentence("The drive has 194 gigabytes free.")).toBeNull(); // neutral facts stay neutral
    expect(expressionForSentence("   ")).toBeNull();
  });
  it("only ever returns a face that exists", () => {
    for (const s of ["sorry", "warning", "great!", "wow", "tired", "angry", "let me see", "ok?"]) {
      const e = expressionForSentence(s);
      if (e) expect(EXPRESSIONS).toContain(e);
    }
  });
  it("changes face sentence by sentence, following the position being spoken", () => {
    const text = "Hello there! I couldn't find that file. Which one did you mean?";
    const spans = sentenceSpans(text);
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.expr)).toEqual(["happy", "apologetic", "listening"]);
    expect(expressionAt(spans, 0)).toBe("happy");
    expect(expressionAt(spans, text.indexOf("couldn't"))).toBe("apologetic");
    expect(expressionAt(spans, text.indexOf("Which"))).toBe("listening");
    expect(expressionAt(spans, 9999)).toBe("listening"); // past the end: the last sentence
    expect(expressionAt([], 3)).toBeNull();
  });
  it("personality tones the face down but never changes its meaning", () => {
    expect(settleForPersona("excited", "playful")).toBe("excited");
    expect(settleForPersona("excited", "strict")).toBe("calm");
    expect(settleForPersona("happy", "professional")).toBe("friendly");
    expect(settleForPersona("apologetic", "strict")).toBe("apologetic");
    for (const p of PERSONALITIES) for (const e of EXPRESSIONS) expect(EXPRESSIONS).toContain(settleForPersona(e, p));
  });
  it("what Momo is DOING wins for problems and decisions; the words decide the rest", () => {
    for (const e of PROTECTED) expect(faceWhileSpeaking(e, "happy", "friendly")).toBe(e);
    expect(faceWhileSpeaking("speaking", "apologetic", "friendly")).toBe("apologetic");
    expect(faceWhileSpeaking("speaking", null, "friendly")).toBe("speaking");
    expect(faceWhileSpeaking("happy", "sad", "friendly")).toBe("sad");
  });
});
