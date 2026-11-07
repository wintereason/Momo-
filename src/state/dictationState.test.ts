import { describe, expect, it } from "vitest";
import { barReducer, holdMs, initialBar, needsClicks, type BarState } from "./dictationState";
import type { RuntimeEvent } from "../types/runtime-events";

const agent = (s: BarState, event: RuntimeEvent) => barReducer(s, { type: "agent", event });

describe("dictation on the bar", () => {
  it("walks through listening, writing it down, polishing and done", () => {
    let s: BarState = initialBar;
    s = barReducer(s, { type: "listening", mode: "dictate" }); expect(s).toMatchObject({ phase: "listening", message: "Listening…" });
    s = barReducer(s, { type: "heard" }); expect(s.phase).toBe("transcribing");
    s = barReducer(s, { type: "recognised", polishing: true }); expect(s).toMatchObject({ phase: "polishing", message: "Polishing…" });
    s = barReducer(s, { type: "result", mode: "type", result: { ok: true, inserted: true, polished: true, source: "Gemini" } });
    expect(s).toEqual({ phase: "done", mode: "dictate", message: "Inserted", detail: "Polished by Gemini" });
    expect(barReducer(s, { type: "reset" })).toEqual(initialBar);
  });
  it("tells the truth when the AI could not be used", () => {
    const s = barReducer(initialBar, { type: "result", mode: "type", result: { ok: true, inserted: true, polished: false, note: "AI is off, so I only fixed the basics." } });
    expect(s).toMatchObject({ phase: "done", message: "Inserted", detail: "AI is off, so I only fixed the basics." });
  });
  it("copy mode, and a paste that could not happen, say 'Copied' and never 'Inserted'", () => {
    expect(barReducer(initialBar, { type: "result", mode: "copy", result: { ok: true, copied: true, inserted: false } }).message).toMatch(/^Copied/);
    const held = barReducer(initialBar, { type: "result", mode: "type", result: { ok: true, copied: true, inserted: false, blocked: "keys_held" } });
    expect(held).toMatchObject({ phase: "problem", message: expect.stringMatching(/^Copied/) });
  });
  it("a password box is refused and explained, and failures show their reason", () => {
    expect(barReducer(initialBar, { type: "result", mode: "type", result: { ok: true, blocked: "password", inserted: false } })).toMatchObject({ phase: "problem", message: expect.stringMatching(/password/) });
    expect(barReducer(initialBar, { type: "result", mode: "type", result: { ok: false, reason: "I didn't catch any words." } })).toMatchObject({ phase: "problem", message: "I didn't catch any words." });
  });
});

describe("a goal for the agent on the bar", () => {
  it("the agent shortcut says it is waiting for a goal, then shows each step as it works", () => {
    let s = barReducer(initialBar, { type: "listening", mode: "agent" });
    expect(s).toMatchObject({ phase: "listening", mode: "agent", message: "Tell me what to do…" });
    s = barReducer(s, { type: "goal" });
    expect(s).toMatchObject({ phase: "thinking", mode: "agent" });
    s = agent(s, { type: "task.state", taskId: "t1", state: "working", message: "Checking disk space…" });
    expect(s).toMatchObject({ phase: "thinking", message: "Checking disk space…" });
  });
  it("a decision waits for the user, and keeps its card until it is answered", () => {
    const s = agent(initialBar, { type: "task.confirmation_required", taskId: "t7", summary: "Close “Notepad”? Anything unsaved in it could be lost." });
    expect(s).toMatchObject({ phase: "confirming", card: { kind: "confirm", taskId: "t7", text: "Close “Notepad”? Anything unsaved in it could be lost." } });
    expect(needsClicks(s)).toBe(true);
  });
  it("several matches are kept as options with their full paths, for a click", () => {
    const s = agent(initialBar, { type: "task.clarification_required", taskId: "t3", question: "I found 2 matches", options: [{ label: "File: Resume.pdf", detail: "C:\a\Resume.pdf" }, { label: "File: Resume.pdf", detail: "C:\b\Resume.pdf" }] });
    expect(s.card?.options).toHaveLength(2);
    expect(s.card?.options?.[1].detail).toBe("C:\b\Resume.pdf");
  });
  it("a question is shown in full, so the user can answer it by voice or by button", () => {
    const s = agent(initialBar, { type: "task.clarification_required", taskId: "t2", question: "I found 3 accounts: 1) a  2) b  3) c. Which one?" });
    expect(s).toMatchObject({ phase: "asking", card: { kind: "ask", text: expect.stringContaining("Which one?") } });
  });
  it("only a verified completion is shown as Done; a failure says it could not", () => {
    expect(agent(initialBar, { type: "task.completed", taskId: "t1", summary: "Opened youtube.com in Chrome.", verified: true })).toMatchObject({ phase: "done", message: "Done", card: { kind: "result", text: "Opened youtube.com in Chrome." } });
    expect(agent(initialBar, { type: "task.failed", taskId: "t1", summary: "I cannot delete files.", recoverable: true })).toMatchObject({ phase: "problem", message: "I couldn't do that", card: { text: "I cannot delete files." } });
    expect(agent(initialBar, { type: "task.state", taskId: "t1", state: "partial_success", message: "Opened it, but I couldn't confirm every step." })).toMatchObject({ phase: "problem", message: "Not fully confirmed" });
  });
  it("an AI answer is labelled as one, never as a verified result", () => {
    expect(agent(initialBar, { type: "task.answer", taskId: "t1", text: "Paris.", source: "Gemini · AI answer" })).toMatchObject({ phase: "done", message: "Answer · Gemini · AI answer", card: { kind: "answer", text: "Paris." } });
  });
  it("voice events are not the agent's business", () => {
    const s = barReducer(initialBar, { type: "listening", mode: "agent" });
    expect(agent(s, { type: "voice.started", sessionId: "v1" } as RuntimeEvent)).toBe(s);
  });
});

describe("how long the bar stays", () => {
  it("problems stay longer than a plain success, and a card stays long enough to read", () => {
    expect(holdMs({ phase: "problem", mode: "dictate", message: "x" })).toBeGreaterThan(holdMs({ phase: "done", mode: "dictate", message: "Inserted" }));
    const long = holdMs({ phase: "done", mode: "agent", message: "Done", card: { kind: "result", text: "x".repeat(300) } });
    const short = holdMs({ phase: "done", mode: "agent", message: "Done", card: { kind: "result", text: "ok" } });
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(15_000);
  });
  it("only a bar with something to press accepts clicks", () => {
    expect(needsClicks(initialBar)).toBe(false);
    expect(needsClicks({ phase: "listening", mode: "dictate", message: "" })).toBe(false);
    expect(needsClicks({ phase: "thinking", mode: "agent", message: "" })).toBe(true);
  });
});
