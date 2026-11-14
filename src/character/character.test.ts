import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { barReducer, initialBar, type BarState } from "../state/dictationState";
import { defaultPrefs, loadPrefs, savePrefs, PREFS_KEY, type KV } from "../state/settings";
import { CharacterPrefsSchema, defaultCharacter, PERSONALITIES } from "./config";
import { expressionFor } from "./expression";
import { BUILDS, EXPRESSIONS, EXPRESSION_DEFS, browPath, ease, easeFace, eyePaths, faceDistance, mouthPath } from "./face";
import { PERSONAS, leadIn, phrase, styleMessage } from "./personality";
import { visemeAt } from "./speechMouth";
import { blinkFactor, motionAmount, nextBlinkDelay } from "./animation";

const agent = (s: BarState, event: Parameters<typeof barReducer>[1] extends infer E ? (E extends { type: "agent"; event: infer V } ? V : never) : never) => barReducer(s, { type: "agent", event });

describe("which face Momo wears follows what Momo is really doing", () => {
  const f = (s: BarState, speaking = false, p: (typeof PERSONALITIES)[number] = "friendly") => expressionFor(s, speaking, p);
  it("idle, listening, thinking", () => {
    expect(f(initialBar)).toBe(PERSONAS.friendly.idle);
    expect(f(barReducer(initialBar, { type: "listening", mode: "dictate" }))).toBe("listening");
    expect(f(barReducer(initialBar, { type: "heard" }))).toBe("thinking");
    expect(f(barReducer(initialBar, { type: "goal" }))).toBe("thinking"); // "Working it out…" is planning
  });
  it("carrying out a step looks focused; a decision looks careful; a question looks puzzled", () => {
    expect(f(agent(initialBar, { type: "task.state", taskId: "t", state: "working", message: "Opening Chrome…" }))).toBe("serious");
    expect(f(agent(initialBar, { type: "task.confirmation_required", taskId: "t", summary: "Close Notepad?" }))).toBe("worried");
    expect(f(agent(initialBar, { type: "task.clarification_required", taskId: "t", question: "Which one?" }))).toBe("confused");
  });
  it("a verified success is happy; an AI answer is NOT celebrated", () => {
    expect(f(agent(initialBar, { type: "task.completed", taskId: "t", summary: "Opened.", verified: true }))).toBe("happy");
    expect(f(agent(initialBar, { type: "task.completed", taskId: "t", summary: "Opened.", verified: true }), false, "playful")).toBe("excited");
    expect(f(agent(initialBar, { type: "task.answer", taskId: "t", text: "Paris.", source: "AI" }))).toBe("friendly");
  });
  it("failures: sorry when recoverable, alarmed when not, careful for warnings", () => {
    expect(f(agent(initialBar, { type: "task.failed", taskId: "t", summary: "x", recoverable: true }))).toBe("apologetic");
    expect(f(agent(initialBar, { type: "task.failed", taskId: "t", summary: "x", recoverable: false }))).toBe("error");
    expect(f(agent(initialBar, { type: "runtime.error", code: "x", message: "boom" }))).toBe("error");
    expect(f(agent(initialBar, { type: "task.state", taskId: "t", state: "partial_success", message: "m" }))).toBe("warning");
    expect(f(barReducer(initialBar, { type: "result", mode: "type", result: { ok: true, blocked: "password" } }))).toBe("warning");
    expect(f(barReducer(initialBar, { type: "result", mode: "type", result: { ok: false, reason: "nope" } }))).toBe("error");
  });
  it("dictation: inserted is happy, pasted-but-unconfirmed is not a celebration", () => {
    expect(f(barReducer(initialBar, { type: "result", mode: "type", result: { ok: true, inserted: true, verified: "confirmed" } }))).toBe("happy");
    expect(f(barReducer(initialBar, { type: "result", mode: "type", result: { ok: true, inserted: true, verified: "unreadable" } }))).toBe("calm");
  });
  it("speaking shows the talking face when there is nothing more specific", () => {
    expect(f(initialBar, true)).toBe("speaking");
  });
  it("the character reads state only: every bar phase maps to a known expression", () => {
    for (const p of PERSONALITIES) for (const phase of ["idle", "listening", "transcribing", "polishing", "thinking", "confirming", "asking", "done", "problem"] as const) {
      expect(EXPRESSIONS).toContain(expressionFor({ ...initialBar, phase, message: "" }, false, p));
    }
  });
});

describe("the face model", () => {
  it("every expression is defined and the required states are all there", () => {
    for (const e of ["idle", "listening", "speaking", "thinking", "happy", "excited", "friendly", "confused", "surprised", "serious", "sad", "apologetic", "warning", "error"]) {
      expect(EXPRESSION_DEFS[e as keyof typeof EXPRESSION_DEFS]).toBeDefined();
    }
  });
  it("expressions are genuinely different faces", () => {
    for (const a of EXPRESSIONS) for (const b of EXPRESSIONS) if (a < b) expect(faceDistance(EXPRESSION_DEFS[a].face, EXPRESSION_DEFS[b].face), `${a} vs ${b}`).toBeGreaterThan(0.05);
  });
  it("transitions ease smoothly and reach the target", () => {
    let cur = EXPRESSION_DEFS.idle.face;
    const target = EXPRESSION_DEFS.sad.face;
    const first = easeFace(cur, target, 1 / 30);
    expect(faceDistance(first, target)).toBeLessThan(faceDistance(cur, target));
    expect(faceDistance(first, target)).toBeGreaterThan(0); // not a jump
    for (let i = 0; i < 90; i++) cur = easeFace(cur, target, 1 / 30);
    expect(faceDistance(cur, target)).toBeLessThan(0.01);
    expect(ease(0, 1, 0)).toBe(0);
  });
  it("paths are well-formed and respond to the parameters", () => {
    expect(eyePaths({ cx: 100, cy: 100, w: 36, h: 40 }, 1, 0).opening).not.toBe(eyePaths({ cx: 100, cy: 100, w: 36, h: 40 }, 0.1, 0).opening);
    expect(mouthPath(0.5, 0, 0, 1).filled).toBe(false);
    expect(mouthPath(0.5, 0.8, 0, 1).filled).toBe(true);
    expect(browPath(116, 1, 0, 0)).not.toBe(browPath(116, 1, 1, 0.5));
    expect(/NaN|undefined/.test(mouthPath(-1, 1, 1, 0.5).path + eyePaths({ cx: 1, cy: 1, w: 1, h: 1 }, 1.2, 1).opening)).toBe(false);
  });
  it("gender presentation changes proportions only, and neutral is the default", () => {
    expect(defaultCharacter.presentation).toBe("neutral");
    expect(Object.keys(BUILDS).sort()).toEqual(["androgynous", "feminine", "masculine", "neutral"]);
    expect(BUILDS.masculine.jaw).toBeGreaterThan(BUILDS.feminine.jaw);
  });
});

describe("speech and mouth", () => {
  it("picks the mouth shape from the vowel being said", () => {
    expect(visemeAt("hello", 1)).toBe("e");
    expect(visemeAt("so", 1)).toBe("o");
    expect(visemeAt("a, b", 1)).toBe("m"); // a pause
  });
});

describe("natural motion", () => {
  it("blinks are irregular, quick and return to open", () => {
    expect(nextBlinkDelay(0)).toBeGreaterThan(2000);
    expect(nextBlinkDelay(1)).toBeLessThan(7000);
    expect(blinkFactor(0)).toBe(1);
    expect(blinkFactor(75)).toBeLessThan(0.05);
    expect(blinkFactor(200)).toBe(1);
  });
  it("animation setting and the OS 'reduce motion' preference are respected", () => {
    expect(motionAmount("full", false)).toEqual({ sway: 1, blink: true, ease: true });
    expect(motionAmount("full", true).sway).toBe(0);
    expect(motionAmount("reduced", false).sway).toBe(0);
    expect(motionAmount("off", false)).toEqual({ sway: 0, blink: false, ease: false });
  });
});

describe("personality changes style, not substance", () => {
  it("each personality words the stock messages differently", () => {
    const set = new Set(PERSONALITIES.map((p) => styleMessage("Done", p)));
    expect(set.size).toBeGreaterThan(3);
    expect(phrase("failed", "strict")).not.toBe(phrase("failed", "friendly"));
  });
  it("messages that carry facts are never rewritten", () => {
    for (const p of PERSONALITIES) {
      expect(styleMessage("Inserted into \"To\"", p)).toBe("Inserted into \"To\"");
      expect(styleMessage("Checking disk space…", p)).toBe("Checking disk space…");
    }
  });
  it("the lead-in is the only thing added to a spoken result", () => {
    expect(leadIn("completed", "professional")).toBe("");
    expect(leadIn("failed", "friendly")).toMatch(/sorry/i);
  });
  it("the character code never touches the runtime, and the runtime never touches the character", () => {
    const root = path.resolve(__dirname, "..");
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const imports = (f: string) => [...fs.readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const f of walk(path.join(root, "character")).filter((x) => /\.tsx?$/.test(x) && !x.endsWith(".test.ts"))) {
      for (const i of imports(f)) expect(i, f).not.toMatch(/runtime-core|electron|desktop/);
    }
    for (const f of walk(path.join(root, "runtime-core")).filter((x) => /\.tsx?$/.test(x))) {
      for (const i of imports(f)) expect(i, f).not.toMatch(/character/);
    }
  });
});

describe("saved appearance", () => {
  const mem = (): KV & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };
  it("defaults: neutral, friendly, classic, shown, compact", () => {
    expect(defaultPrefs.character).toMatchObject({ presentation: "neutral", personality: "friendly", theme: "classic", enabled: true, view: "compact", animation: "full" });
  });
  it("round-trips, and settings saved before the character existed still load with the defaults", () => {
    const m = mem();
    savePrefs(m, { ...defaultPrefs, character: { ...defaultCharacter, theme: "neon", hairstyle: "ponytail", personality: "calm", presentation: "androgynous" } });
    expect(loadPrefs(m).character).toMatchObject({ theme: "neon", hairstyle: "ponytail", personality: "calm", presentation: "androgynous" });
    const old = { ...defaultPrefs } as Partial<typeof defaultPrefs>;
    delete old.character;
    m.setItem(PREFS_KEY, JSON.stringify(old));
    expect(loadPrefs(m).character).toEqual(defaultCharacter);
  });
  it("rejects unknown values (falls back safely) and reset restores the defaults", () => {
    expect(CharacterPrefsSchema.safeParse({ theme: "gold" }).success).toBe(false);
    const m = mem();
    m.setItem(PREFS_KEY, JSON.stringify({ ...defaultPrefs, character: { ...defaultCharacter, theme: "gold" } }));
    expect(loadPrefs(m)).toEqual(defaultPrefs);
    savePrefs(m, { ...defaultPrefs, character: defaultCharacter });
    expect(loadPrefs(m).character).toEqual(defaultCharacter);
  });
  it("appearance carries no task data and no permissions", () => {
    expect(Object.keys(defaultCharacter).sort()).toEqual(["animation", "art", "enabled", "hairColor", "hairstyle", "headphones", "onlineVoice", "outfit", "personality", "presentation", "theme", "view", "voices"]);
  });
});
