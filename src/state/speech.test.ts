import { describe, expect, it } from "vitest";
import { forSpeech, speechFor, spokenOption } from "./speech";
import type { RuntimeEvent } from "../types/runtime-events";

describe("what Momo says aloud", () => {
  it("announces a step that does something, but stays silent while thinking or looking things up", () => {
    expect(speechFor({ type: "task.state", taskId: "t1", state: "working", message: "Opening Notes…", speak: true })).toEqual({ text: "Opening Notes…", queue: false });
    expect(speechFor({ type: "task.state", taskId: "t1", state: "working", message: "Looking for “notes”…", speak: false })).toBeNull();
    expect(speechFor({ type: "task.state", taskId: "t1", state: "working", message: "Deciding the next step…" })).toBeNull();
  });
  it("confirms what was verified and explains what failed", () => {
    expect(speechFor({ type: "task.completed", taskId: "t1", summary: "Opened the file C:\\Users\\me\\Notes.txt; its window is showing.", verified: true })?.text).toContain("Opened the file");
    expect(speechFor({ type: "task.failed", taskId: "t1", summary: "Nothing named like \"tax\" was found on this PC.", recoverable: true })?.text).toBe("I couldn't do that. Nothing named like \"tax\" was found on this PC.");
    expect(speechFor({ type: "task.state", taskId: "t1", state: "partial_success", message: "Asked Windows to open it, but no window appeared." })?.text).toContain("no window appeared");
  });
  it("reads the options out when it has to ask which one, with where each one is", () => {
    const e: RuntimeEvent = {
      type: "task.clarification_required", taskId: "t1", question: "I found 2 matches …",
      options: [{ label: "File: Resume.pdf", detail: "C:\\Users\\me\\Documents\\Resume.pdf" }, { label: "File: Resume.pdf", detail: "C:\\Users\\me\\Downloads\\Resume.pdf" }],
    };
    expect(speechFor(e)?.text).toBe("I found 2 matches. 1: Resume.pdf, in Documents. 2: Resume.pdf, in Downloads. Which one?");
    expect(spokenOption("Folder: Projects", "D:\\Projects", 0)).toBe("1: Projects, in D drive");
  });
  it("a question without options is read as it is; decisions are read too", () => {
    expect(speechFor({ type: "task.clarification_required", taskId: "t1", question: "Which folder do you mean?" })?.text).toBe("Which folder do you mean?");
    expect(speechFor({ type: "task.confirmation_required", taskId: "t1", summary: "Close “Notepad”?" })).toEqual({ text: "Close “Notepad”?", queue: false });
  });
  it("events that are not worth saying stay silent", () => {
    expect(speechFor({ type: "voice.started", sessionId: "v1" })).toBeNull();
    expect(speechFor({ type: "runtime.error", code: "x", message: "m" })).toBeNull();
  });
  it("paths are made pleasant for the ear and long text is shortened", () => {
    expect(forSpeech({ text: "Opened C:\\Users\\me\\Notes.txt", queue: true }).text).toBe("Opened C drive, Users, me, Notes.txt");
    expect(forSpeech({ text: "word ".repeat(200), queue: true }).text.length).toBeLessThanOrEqual(330);
  });
});
