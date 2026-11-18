/**
 * Phase 8b: Online AI privacy. What would an ONLINE planner / vision model actually receive?
 *
 * Real Session + real AI service + real LlmClient, against a recording fake `fetch`. No network (the global fetch throws, and the run ends by asserting
 * it was never called), fake keys, a made-up in-memory PC, CANARY markers instead of private data. A failing test here is a finding, not a flake.
 * See docs/08b_ONLINE_AI_PRIVACY_REPORT.md for the matrix.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CANARY, CLOUD_OFF, CLOUD_ON, FAKE_KEY, FILE_PATH, LOCAL_ONLY, leaked, makeProvider, makeService, makeWorld, run, tool, done, userText, type ProviderOpts, type World } from "./onlinePrivacyKit";
import { REDACTED_ARGS, REDACTED_NOTE, redactedText, redactSteps, type PlanStep } from "../runtime-core/orchestrator/ai/prompts";
import { buildTools } from "../runtime-core/orchestrator/tools";
import { buildPopupTools } from "../runtime-core/orchestrator/popupTools";
import { buildVisualTools } from "../runtime-core/orchestrator/visualTools";
import { clickWorld } from "../runtime-core/orchestrator/clickVisualWorld";

const realFetch = globalThis.fetch;
let stray = 0;
beforeAll(() => { globalThis.fetch = (async () => { stray++; throw new Error("real network is forbidden in Phase 8b tests"); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; expect(stray, "something called the real fetch").toBe(0); });

type Outcome = "OK (verified)" | "done but NOT verified" | "FAILED" | "the user declined" | "none";
/** the outcome label the planner was shown for one tool's step in a request (a label only, never the text) */
const outcomeOf = (requestText: string, name: string): Outcome => (new RegExp(`${name} .*? -> (OK \\(verified\\)|done but NOT verified|FAILED|the user declined):`).exec(requestText)?.[1] as Outcome | undefined) ?? "none";
const kind = (o: Outcome) => (o === "OK (verified)" ? "ok" : o === "done but NOT verified" ? "unverified" : o === "the user declined" ? "declined" : "failed") as "ok" | "unverified" | "failed" | "declined";
const bodies = (reqs: Array<{ body: string }>) => reqs.map((q) => q.body).join("\n");

/** run one planner tool call (the planner's args never contain a canary), auto-answering confirmations, and return what the planner was shown next */
async function oneTool(values: Record<string, string>, name: string, args: Record<string, unknown>, o: { world?: Parameters<typeof makeWorld>[0]; approve?: boolean } = {}) {
  const world = makeWorld(o.world);
  const prov = makeProvider({ script: (n) => (n === 0 ? tool(name, args) : done("ok")) });
  const t = run(world, makeService(values, prov.fetchFn));
  await t.say("do the thing");
  for (let i = 0; i < 4 && t.last()?.type === "task.confirmation_required"; i++) await t.approve(o.approve !== false);
  const planner = prov.planner();
  const next = planner[1] ? userText(planner[1].body) : "";
  return { world, prov, t, next, all: bodies(prov.requests) };
}

// ------------------------------------------------------------------------------------------------ A: the harness itself
describe("A. harness self-checks", () => {
  it("A1 the detector flags a request that does contain a canary (mutation check)", () => {
    expect(leaked(`x ${CANARY.tabTitle} y ${CANARY.fileName}`)).toEqual(["tabTitle", "fileName"]);
    expect(leaked("nothing private here")).toEqual([]);
  });
  it("A2 the global fetch is blocked and nothing reached it so far", () => { expect(stray).toBe(0); });
  it("A3 the fake key only ever travels in a header", async () => {
    const r = await oneTool(CLOUD_OFF, "drive_info", { drive: "D" });
    expect(r.prov.requests.length).toBeGreaterThan(0);
    for (const q of r.prov.requests) { expect(q.body).not.toContain(FAKE_KEY); expect(q.url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//); }
    expect(JSON.stringify(r.prov.requests.map((q) => q.headers))).toContain(FAKE_KEY);
  });
  it("A4 canaries are unique and are not part of any tool description or system prompt", () => {
    const vals = Object.values(CANARY);
    expect(new Set(vals).size).toBe(vals.length);
    const docs = JSON.stringify([...buildTools(), ...buildPopupTools(), ...buildVisualTools()].map((t) => [t.name, t.signature, t.description]));
    for (const v of vals) expect(docs).not.toContain(v);
  });
});

// ------------------------------------------------------------------------------------------------ B: screen-context flag OFF, cloud planner
const SENSITIVE: Array<[string, Record<string, unknown>]> = [
  ["look_screen", { window: "notepad" }], ["understand_screen", { window: "notepad" }], ["inspect_component", { ref: "150,115", window: "notepad" }],
  ["list_windows", {}], ["read_window", { window: "notepad", mode: "controls" }], ["browser_accounts", {}], ["list_tabs", { browser: "chrome" }],
  ["look_popups", {}], ["read_menu", {}], ["read_dialog", {}],
];
describe("B1. flag OFF: tools marked sensitive never put what they read into a cloud request", () => {
  for (const [name, args] of SENSITIVE) {
    it(`${name}`, async () => {
      const r = await oneTool(CLOUD_OFF, name, args);
      expect(outcomeOf(r.next, name), "the planner was never shown the step").not.toBe("none");
      expect(leaked(r.all)).toEqual([]);
    });
  }
  it("the placeholder is what the planner sees instead", async () => {
    const r = await oneTool(CLOUD_OFF, "list_windows", {});
    expect(r.next).toContain(REDACTED_NOTE);
  });
});

/**
 * Every tool that is NOT marked sensitive, run against the canary PC (F1, F2, F4-F10). For each: the outcome the planner is shown must be the
 * expected one (a tool that silently failed would otherwise pass for the wrong reason), the tool's REAL local effect must have happened with the
 * real arguments (exact coordinates, keys, text, paths), and no canary may be in any request. Seven tools need the RICH fake PC (a pointer with wheel and
 * drag, a field that takes the cursor, readable words, a screen that reacts to what is done to it); B2f runs the same seven in the plain PC, where they fail. */
interface Row { name: string; args: Record<string, unknown>; world?: Parameters<typeof makeWorld>[0]; outcome: Outcome; effect: (w: World) => void; open?: boolean }
const CLICKS = (w: World) => w.popupLog.clicks.map((c) => [c.x, c.y, (c.opts as { button?: string }).button ?? "left"]);
const none = (w: World) => { expect(w.popupLog.clicks.length + w.popupLog.presses.length + w.popupLog.texts.length + w.log.openPaths.length + w.log.apps.length).toBe(0); };
const NON_SENSITIVE: Row[] = [
  { name: "drive_info", args: { drive: "D" }, outcome: "OK (verified)", effect: none, open: true },
  { name: "language_progress", args: {}, outcome: "OK (verified)", effect: none, open: true },
  { name: "find_paths", args: { query: "resume", kind: "file" }, outcome: "OK (verified)", effect: none },
  { name: "open_path", args: { query: "resume", kind: "file" }, world: { oneFile: true }, outcome: "OK (verified)", effect: (w) => expect(w.log.openPaths).toEqual([FILE_PATH(`${CANARY.fileName}.docx`)]) },
  { name: "click_control", args: { label: "Send", window: "notepad" }, outcome: "done but NOT verified", effect: (w) => expect(w.popupLog.clicks.length).toBe(1) },
  { name: "type_text", args: { label: "Body", text: "hello", window: "notepad" }, outcome: "OK (verified)", effect: (w) => { expect(w.popupLog.texts).toEqual(["hello"]); expect(w.popupLog.act).toContain("settext:e1"); } },
  { name: "press_keys", args: { keys: "ctrl+a", window: "notepad" }, outcome: "done but NOT verified", effect: (w) => expect(w.popupLog.presses).toEqual(["ctrl+a"]) },
  { name: "arrange_window", args: { to: "left", window: "notepad" }, outcome: "done but NOT verified", effect: (w) => expect(w.popupLog.presses).toEqual(["win+left"]) },
  { name: "open_app", args: { app: "Calculator" }, outcome: "done but NOT verified", effect: (w) => expect(w.log.apps).toEqual(["Calculator"]) },
  { name: "open_url", args: { url: "https://example.test/" }, outcome: "done but NOT verified", effect: (w) => { expect(w.log.urls.length).toBe(1); expect(w.log.urls[0]).toContain("example.test"); } },
  { name: "switch_tab", args: { query: "second", browser: "chrome" }, outcome: "done but NOT verified", effect: (w) => expect(w.popupLog.act).toContain("invoke:tab2") },
  { name: "focus_window", args: { window: "notepad" }, outcome: "OK (verified)", effect: (w) => expect(w.log.focused).toContain(w.NOTE) },
  { name: "minimize_window", args: { window: "notepad" }, outcome: "done but NOT verified", effect: (w) => expect(w.popupLog.act).toContain("minimize") },
  { name: "choose_menu_item", args: { path: ["Copy"] }, outcome: "done but NOT verified", effect: (w) => expect(w.popupLog.clicks.length).toBe(1) },
  { name: "close_popup", args: {}, outcome: "done but NOT verified", effect: (w) => expect(w.popupLog.presses).toEqual(["esc", "esc"]) },
  { name: "answer_dialog", args: { button: "OK" }, outcome: "done but NOT verified", effect: (w) => expect(w.popupLog.clicks.length).toBe(1) },
  // the seven tools that need a richer PC (a real pointer, a wheel, a drag, a field that takes the cursor, readable words, a screen that reacts)
  { name: "select_field", args: { label: "Body", window: "notepad" }, world: { rich: true }, outcome: "OK (verified)", effect: (w) => { expect(CLICKS(w)).toEqual([[400, 300, "left"]]); expect(w.log.rich.hits).toEqual(["e1"]); } },
  { name: "press_enter", args: { window: "notepad" }, world: { rich: true, bodyFocused: true }, outcome: "OK (verified)", effect: (w) => { expect(w.log.rich.submits).toEqual([{ rid: "e1", name: "Body" }]); expect(CLICKS(w)).toEqual([]); } },
  { name: "scroll_window", args: { direction: "down", window: "notepad" }, world: { rich: true }, outcome: "OK (verified)", effect: (w) => expect(w.log.rich.scrolls).toEqual([{ x: 500, y: 480, notches: 3 }]) },
  { name: "right_click", args: { label: "Send", window: "notepad" }, world: { rich: true }, outcome: "OK (verified)", effect: (w) => { expect(CLICKS(w)).toEqual([[150, 115, "right"]]); expect(w.log.rich.hits).toEqual(["b1"]); } },
  // select_text never claims "verified": Windows does not report what is selected. It must still have clicked the item and pressed Ctrl+A.
  { name: "select_text", args: { label: "notes", scope: "all", window: "notepad" }, world: { rich: true }, outcome: "done but NOT verified", effect: (w) => { expect(CLICKS(w)).toEqual([[250, 535, "left"]]); expect(w.popupLog.presses).toEqual(["ctrl+a"]); expect(w.log.rich.hits).toEqual(["f1"]); } },
  { name: "click_text", args: { text: "Send", window: "notepad" }, world: { rich: true }, outcome: "OK (verified)", effect: (w) => { expect(CLICKS(w)).toEqual([[930, 110, "left"]]); expect(w.log.rich.hits).toEqual(["none"]); } },
  { name: "drag_drop", args: { from: "notes", to: "archive", window: "notepad" }, world: { rich: true }, outcome: "OK (verified)", effect: (w) => expect(w.log.rich.drags).toEqual([{ from: { x: 250, y: 535 }, to: { x: 250, y: 575 } }]) },
];
describe("B2. flag OFF: tools NOT marked sensitive: outcome, real local effect, and no canary in any request", () => {
  for (const row of NON_SENSITIVE) {
    it(`${row.name}`, async () => {
      const r = await oneTool(CLOUD_OFF, row.name, row.args, { world: row.world });
      expect(outcomeOf(r.next, row.name), "the step did not end as expected").toBe(row.outcome);
      row.effect(r.world); // the tool really ran, locally, with its real arguments
      expect(leaked(r.all)).toEqual([]);
      if (row.open) expect(r.next).not.toContain(REDACTED_ARGS);
      else { expect(r.next).toContain(REDACTED_ARGS); expect(r.next).toContain(redactedText(kind(row.outcome))); }
    });
  }
});

/** the same seven tools in the PLAIN fake PC (no pointer wheel/drag, no field with the cursor, no readable words): they fail, the reason names windows and controls, and that reason must be redacted */
describe("B2f. flag OFF: failure reasons that name windows and controls are redacted", () => {
  const SEVEN: Array<[string, Record<string, unknown>]> = [
    ["select_field", { label: "Body", window: "notepad" }], ["press_enter", { window: "notepad" }], ["scroll_window", { direction: "down", window: "notepad" }], ["right_click", { label: "Body", window: "notepad" }],
    ["select_text", { label: "Body", scope: "all", window: "notepad" }], ["click_text", { text: "Send", window: "notepad" }], ["drag_drop", { from: "Send", to: "Body", window: "notepad" }],
  ];
  for (const [name, args] of SEVEN) {
    it(`${name}`, async () => {
      const r = await oneTool(CLOUD_OFF, name, args);
      expect(outcomeOf(r.next, name)).toBe("FAILED");
      expect(r.next).toContain(redactedText("failed"));
      expect(r.next).toContain(REDACTED_ARGS);
      expect(leaked(r.all)).toEqual([]);
    });
  }
});

describe("B3. flag OFF: choosing between look-alike files (F3)", () => {
  it("the picked file is opened locally with its real path, and none of it travels to the cloud planner", async () => {
    const world = makeWorld();
    const prov = makeProvider({ script: (n) => (n === 0 ? tool("open_path", { query: "resume", kind: "file" }) : done("ok")) });
    const t = run(world, makeService(CLOUD_OFF, prov.fetchFn));
    await t.say("open my resume");
    expect(t.last()?.type, "an ambiguous pick was expected").toBe("task.clarification_required");
    await t.say("first");
    expect(world.log.openPaths, "the real picked path must be what was opened").toEqual([FILE_PATH(`${CANARY.fileName}-old.docx`)]);
    expect(prov.planner().length, "the planner was never asked again after the pick").toBeGreaterThan(1);
    const after = userText(prov.planner()[1].body);
    expect(after).toContain(REDACTED_ARGS);
    expect(leaked(bodies(prov.requests))).toEqual([]);
  });
});

describe("B4/B5. flag OFF: first request and fencing", () => {
  it("B4 the first planner request holds only the goal", async () => {
    const r = await oneTool(CLOUD_OFF, "drive_info", { drive: "D" });
    const first = userText(r.prov.planner()[0].body);
    expect(first).toContain("Nothing has been done yet.");
    expect(leaked(first)).toEqual([]);
  });
  it("B5 a tool result stays inside the observation fence", async () => {
    const r = await oneTool(CLOUD_ON, "list_windows", {}, { approve: true });
    expect(/<observation>([\s\S]*?)<\/observation>/.exec(r.next)).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ multi-step behaviour (D3) and the redaction layer itself
describe("M. multi-step planning stays safe and works with a redacted history", () => {
  it("M1 several steps: every step is redacted in every later request, and every one really ran locally", async () => {
    const world = makeWorld();
    const prov = makeProvider({ script: (n) => (n === 0 ? tool("focus_window", { window: "notepad" }) : n === 1 ? tool("press_keys", { keys: "ctrl+a", window: "notepad" }) : done("ok")) });
    const t = run(world, makeService(CLOUD_OFF, prov.fetchFn));
    await t.say("select everything in notepad");
    expect(world.log.focused).toContain(world.NOTE);
    expect(world.popupLog.presses).toEqual(["ctrl+a"]);
    const third = userText(prov.planner()[2].body);
    expect(outcomeOf(third, "focus_window")).toBe("OK (verified)");
    expect(outcomeOf(third, "press_keys")).toBe("done but NOT verified");
    expect(third.split(REDACTED_ARGS).length - 1).toBe(2);
    expect(leaked(bodies(prov.requests))).toEqual([]);
    expect(prov.planner().length, "the planner reached its final answer").toBe(3);
    expect(t.events.some((e) => e.type === "task.failed")).toBe(false);
  });
  it("M2 find then open: the chain still works with redacted history, and the real path is only used locally", async () => {
    const world = makeWorld({ oneFile: true });
    const prov = makeProvider({ script: (n) => (n === 0 ? tool("find_paths", { query: "resume", kind: "file" }) : n === 1 ? tool("open_path", { query: "resume", kind: "file" }) : done("ok")) });
    const t = run(world, makeService(CLOUD_OFF, prov.fetchFn));
    await t.say("open my resume");
    expect(world.log.openPaths).toEqual([FILE_PATH(`${CANARY.fileName}.docx`)]);
    expect(leaked(bodies(prov.requests))).toEqual([]);
    expect(prov.planner().length, "the planner reached its final answer").toBe(3);
    expect(t.events.some((e) => e.type === "task.failed")).toBe(false);
  });
  it("M3 a planner that repeats a READ it can no longer see the result of is stopped from repeating it, and the task still ends cleanly", async () => {
    const world = makeWorld({ oneFile: true });
    const prov = makeProvider({ script: (n) => (n <= 1 ? tool("find_paths", { query: "resume", kind: "file" }) : done("ok")) });
    const t = run(world, makeService(CLOUD_OFF, prov.fetchFn));
    await t.say("find my resume");
    expect(prov.planner().length).toBe(3);
    expect(userText(prov.planner()[2].body)).toContain("already made this exact call");
    expect(t.events.some((e) => e.type === "task.failed")).toBe(false);
    expect(leaked(bodies(prov.requests))).toEqual([]);
  });
  it("M4 a declined step ends the task: nothing more is sent, and nothing reached the app", async () => {
    const r = await oneTool(CLOUD_OFF, "click_control", { label: "Send", window: "notepad" }, { approve: false });
    expect(r.t.asked().length).toBeGreaterThan(0);
    expect(r.prov.planner().length, "after a decline nothing further goes to the planner").toBe(1);
    expect(r.world.popupLog.clicks.length).toBe(0);
    expect(leaked(r.all)).toEqual([]);
  });
  it("M5 a step that FAILED with a window or control name in its reason is redacted and cannot read as a success", async () => {
    const r = await oneTool(CLOUD_OFF, "right_click", { label: "Body", window: "notepad" });
    expect(outcomeOf(r.next, "right_click")).toBe("FAILED");
    expect(r.next).toContain(redactedText("failed"));
    expect(r.next).not.toMatch(/finish with done/);
    expect(leaked(r.all)).toEqual([]);
  });
  it("M6 redactSteps: any ran step is redacted whatever its args and text hold (also steps whose args were refreshed on a retry); the input is not changed", () => {
    const steps: PlanStep[] = [
      { kind: "tool", tool: "click_control", args: { label: CANARY.controlName, path: FILE_PATH("x") }, outcome: "failed", text: `no ${CANARY.windowTitle}`, ran: true },
      { kind: "tool", tool: "open_path", args: { path: FILE_PATH("y") }, outcome: "ok", text: `Opened ${FILE_PATH("y")}`, ran: true },
      { kind: "tool", tool: "type_text", args: { text: CANARY.fieldText }, outcome: "unverified", text: CANARY.uiaText, ran: true },
      { kind: "tool", tool: "click_control", args: { label: CANARY.controlName }, outcome: "declined", text: "The user said no.", ran: true },
      { kind: "tool", tool: "drive_info", args: { drive: "D" }, outcome: "ok", text: "D: 300.0 GB total", ran: true },
      { kind: "tool", tool: "nope", args: { x: "planner words" }, outcome: "failed", text: 'There is no tool called "nope".' },
      { kind: "ask", question: "Which one?", answer: "the first" },
    ];
    const before = JSON.stringify(steps);
    const out = redactSteps(steps, new Set(["drive_info"]));
    expect(JSON.stringify(steps), "the real steps must not change").toBe(before);
    expect(leaked(JSON.stringify(out))).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("C:\\Users");
    expect(out[3]).toMatchObject({ outcome: "declined", text: "The user said no.", args: REDACTED_ARGS });
    expect(out[4]).toEqual(steps[4]); // open tool
    expect(out[5]).toEqual(steps[5]); // not run: the planner's own words
    expect(out[6]).toEqual(steps[6]);
    expect([out[0], out[1], out[2]].map((s) => (s.kind === "tool" ? s.text : ""))).toEqual([redactedText("failed"), redactedText("ok"), redactedText("unverified")]);
  });
  it("M7 redacted text matches the outcome: only a verified step may suggest finishing", () => {
    expect(redactedText("ok")).toMatch(/finish with done/);
    expect(redactedText("failed")).not.toMatch(/finish with done|succeeded/);
    expect(redactedText("unverified")).not.toMatch(/finish with done|succeeded/);
    expect(redactedText("failed")).toMatch(/FAILED/);
    expect(redactedText("unverified")).toMatch(/NOT verified/);
  });
  it("M8 screen context switched OFF in the middle of a task: the step that ran while it was ON is redacted from then on", async () => {
    const values: Record<string, string> = { ...CLOUD_ON };
    const world = makeWorld();
    const inp = world.deps.input as { focusWindow: (h: number) => Promise<unknown> };
    const orig = inp.focusWindow;
    inp.focusWindow = async (h) => { const r = await orig(h); values.MOMO_AI_ALLOW_SCREEN_CONTEXT = "false"; return r; };
    const prov = makeProvider({ script: (n) => (n === 0 ? tool("focus_window", { window: "notepad" }) : done("ok")) });
    const t = run(world, makeService(values, prov.fetchFn));
    await t.say("focus notepad");
    expect(world.log.focused).toContain(world.NOTE);
    expect(userText(prov.planner()[1].body)).toContain(REDACTED_ARGS);
    expect(leaked(bodies(prov.requests))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ C: flag ON, cloud planner
describe("C. flag ON: screen text goes online only after the user agrees", () => {
  it("C1 a sensitive tool asks even when the policy says not to, and a decline sends no canary", async () => {
    const r = await oneTool(CLOUD_ON, "look_screen", { window: "notepad" }, { approve: false });
    expect(r.t.asked().length).toBeGreaterThan(0);
    expect(leaked(r.all)).toEqual([]);
  });
  it("C2 after approval the planner gets the text, fenced and clipped", async () => {
    const r = await oneTool(CLOUD_ON, "look_screen", { window: "notepad" }, { approve: true });
    expect(outcomeOf(r.next, "look_screen")).not.toBe("none");
    const obs = /<observation>([\s\S]*?)<\/observation>/.exec(r.next)?.[1] ?? "";
    expect(obs.length).toBeLessThanOrEqual(1200);
    expect(r.next).not.toContain(REDACTED_NOTE);
  });
  it("C3/F11 the confirmation says plainly that screen information leaves this PC", async () => {
    const r = await oneTool(CLOUD_ON, "look_screen", { window: "notepad" }, { approve: false });
    expect(r.t.asked()[0]?.summary ?? "").toMatch(/leaves this PC/i);
    expect(r.t.asked()[0]?.summary ?? "").toMatch(/online AI/i);
  });
  for (const [name, args] of [["inspect_component", { ref: "150,115", window: "notepad" }], ["list_windows", {}], ["read_window", { window: "notepad", mode: "controls" }], ["understand_screen", { window: "notepad" }]] as Array<[string, Record<string, unknown>]>) {
    it(`F11 the ${name} confirmation says it leaves this PC, and a decline sends nothing private`, async () => {
      const r = await oneTool(CLOUD_ON, name, args, { approve: false });
      expect(r.t.asked()[0]?.summary ?? "").toMatch(/leaves this PC/i);
      expect(leaked(r.all)).toEqual([]);
    });
  }
  it("D5 policy kept: with screen context ON a non-sensitive result goes on without a per-call prompt and is not redacted", async () => {
    const r = await oneTool(CLOUD_ON, "focus_window", { window: "notepad" });
    expect(r.t.asked().length).toBe(0);
    expect(r.next).not.toContain(REDACTED_NOTE);
    expect(r.next).not.toContain(REDACTED_ARGS);
  });
  it("a LOCAL planner (Ollama) is neither redacted nor told its reads leave the PC, and stays on the local host", async () => {
    const r = await oneTool(LOCAL_ONLY, "look_screen", { window: "notepad" });
    expect(r.t.asked().length).toBe(0);
    expect(r.next).not.toContain(REDACTED_NOTE);
    expect(JSON.stringify(r.t.events)).not.toMatch(/leaves this PC/i);
    for (const q of r.prov.requests) expect(q.url).toMatch(/^http:\/\/localhost:11434\//);
  });
});

// ------------------------------------------------------------------------------------------------ C4/C5: look_visual / click_visual
async function runTask(w: ReturnType<typeof clickWorld>, goal: string, ai: unknown, emit?: (e: unknown) => void) {
  await w.run(goal, [done()], { ai, ...(emit ? { emit } : {}) });
}
function visualRun(values: Record<string, string>, script: ProviderOpts["script"], pw = false) {
  const w = clickWorld({ buttons: [{ label: "Save", l: 100, t: 100, w: 80, h: 30 }], texts: [{ text: CANARY.ocrText, l: 300, t: 300 }], uia: ["Save"] });
  w.state.password = pw;
  const prov = makeProvider({ script });
  return { w, prov, svc: makeService(values, prov.fetchFn) };
}
describe("C4/C5. look_visual and click_visual", () => {
  it("C4a flag OFF: OCR words from look_visual never reach a cloud planner", async () => {
    const v = visualRun(CLOUD_OFF, (n) => (n === 0 ? tool("look_visual", { find: "Save" }) : done("ok")));
    await runTask(v.w, "look", v.svc);
    expect(v.prov.planner().length).toBeGreaterThan(1);
    expect(leaked(bodies(v.prov.requests))).toEqual([]);
  });
  it("C4b flag ON: until the user answers, the OCR words stay on the PC (only the first planner request has been sent)", async () => {
    const v = visualRun(CLOUD_ON, (n) => (n === 0 ? tool("look_visual", { find: "Save" }) : done("ok")));
    await runTask(v.w, "look", v.svc);
    expect(v.prov.planner().length).toBe(1);
    expect(leaked(bodies(v.prov.requests))).toEqual([]);
  });
  it("C4c flag ON: look_visual asks, says it leaves this PC, a decline sends nothing, an approval sends the words and nothing is redacted", async () => {
    const declined = visualRun(CLOUD_ON, (n) => (n === 0 ? tool("look_visual", { _hwnd: 20 }) : done("ok")));
    const ev1: Array<{ type: string; taskId?: string; summary?: string }> = [];
    await runTask(declined.w, "look", declined.svc, (e) => ev1.push(e as never));
    const ask1 = ev1.find((e) => e.type === "task.confirmation_required");
    expect(ask1?.summary).toMatch(/leaves this PC/i);
    await declined.w.respond(ask1!.taskId!, false);
    expect(leaked(bodies(declined.prov.requests))).toEqual([]);

    const v = visualRun(CLOUD_ON, (n) => (n === 0 ? tool("look_visual", { _hwnd: 20 }) : done("ok")));
    const events: Array<{ type: string; taskId?: string; summary?: string }> = [];
    await runTask(v.w, "look", v.svc, (e) => events.push(e as never));
    const ask = events.find((e) => e.type === "task.confirmation_required");
    expect(ask?.summary).toMatch(/leaves this PC/i);
    expect(v.prov.planner().length).toBe(1);
    await v.w.respond(ask!.taskId!, true);
    expect(v.prov.planner().length).toBeGreaterThan(1);
    const after = userText(v.prov.planner()[1].body);
    expect(outcomeOf(after, "look_visual")).not.toBe("none");
    expect(after).not.toContain(REDACTED_NOTE);
    expect(after).toContain("Looked at"); // approved: what the picture showed really was sent (clipped, fenced)
    expect(after.length).toBeLessThan(1600);
  });
  it("C5 click_visual: other text on the screen never enters a request", async () => {
    const v = visualRun(CLOUD_OFF, (n) => (n === 0 ? tool("click_visual", { label: "Save" }) : done("ok")));
    await runTask(v.w, "click save", v.svc);
    expect(leaked(bodies(v.prov.requests))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ D: pictures
const ICON = { ref: "1850,20", window: "notepad", visual: true };
describe("D. describe-image", () => {
  it("D1 flag OFF + cloud: no vision request, no picture taken", async () => {
    const r = await oneTool(CLOUD_OFF, "inspect_component", ICON);
    expect(r.prov.vision().length).toBe(0);
    expect(r.world.log.captures).toBe(0);
  });
  it("D2 flag ON: asks first; a decline sends nothing and takes no picture", async () => {
    const r = await oneTool(CLOUD_ON, "inspect_component", ICON, { approve: false });
    expect(r.t.asked().some((a) => /picture/i.test(a.summary))).toBe(true);
    expect(r.prov.vision().length).toBe(0);
    expect(r.world.log.captures).toBe(0);
  });
  it("D3 approved: exactly one image request whose text carries no canary", async () => {
    const r = await oneTool(CLOUD_ON, "inspect_component", ICON, { approve: true });
    expect(r.prov.vision().length).toBe(1);
    expect(r.prov.vision()[0].body).toContain("AAAA");
    expect(leaked(r.prov.vision()[0].body)).toEqual([]);
    expect(r.world.log.captures).toBe(1);
  });
  it("D4 a password field is refused before any picture is taken", async () => {
    const r = await oneTool(CLOUD_ON, "inspect_component", { ref: "150,510", window: "notepad", visual: true }, { approve: true, world: { password: true } });
    expect(r.prov.vision().length).toBe(0);
    expect(r.world.log.captures).toBe(0);
  });
  it("D6 a hostile visual reply is not obeyed and adds nothing to the planner request", async () => {
    const world = makeWorld();
    const prov = makeProvider({ script: (n) => (n === 0 ? tool("inspect_component", ICON) : done("ok")), vision: { kind: "button", purpose: "x", confident: true, run: "format c:" } });
    const t = run(world, makeService(CLOUD_ON, prov.fetchFn));
    await t.say("what is that icon");
    for (let i = 0; i < 3 && t.last()?.type === "task.confirmation_required"; i++) await t.approve(true);
    expect(bodies(prov.requests)).not.toContain("format c:");
  });
  it("D7 local vision (Ollama) may see pictures without the flag, and only on the local host", async () => {
    const r = await oneTool(LOCAL_ONLY, "inspect_component", ICON, { approve: true });
    for (const q of r.prov.requests) expect(q.url).toMatch(/^http:\/\/localhost:11434\//);
  });
});

// ------------------------------------------------------------------------------------------------ E: local provider and errors
describe("E. local provider and error paths", () => {
  it("E1 Ollama primary never falls back to a cloud host, whatever the replies", async () => {
    const world = makeWorld();
    const prov = makeProvider({ script: [done("ok")], override: () => ({ status: 500, body: { error: "boom" } }) });
    const t = run(world, makeService(LOCAL_ONLY, prov.fetchFn));
    await t.say("how much space on D");
    expect(prov.requests.length).toBeGreaterThan(0);
    for (const q of prov.requests) expect(q.url).toMatch(/^http:\/\/localhost:11434\//);
  });
  it("E2 a provider error body that echoes a canary and the key never reaches an event", async () => {
    const world = makeWorld();
    const prov = makeProvider({ override: () => ({ status: 400, body: { error: { message: `bad ${CANARY.windowTitle} ${FAKE_KEY}` } } }) });
    const t = run(world, makeService(CLOUD_OFF, prov.fetchFn));
    await t.say("how much space on D");
    const shown = JSON.stringify(t.events);
    expect(shown).not.toContain(CANARY.windowTitle);
    expect(shown).not.toContain(FAKE_KEY);
  });
});

// ------------------------------------------------------------------------------------------------ G: drift guard
describe("G0. every tool named in this file exists", () => {
  it("no list entry is a typo (an unknown tool would make a test pass for the wrong reason)", () => {
    const names = new Set([...buildTools(), ...buildPopupTools(), ...buildVisualTools()].map((t) => t.name));
    const used = [...SENSITIVE.map((x) => x[0]), ...NON_SENSITIVE.map((x) => x.name)];
    expect(used.filter((n) => !names.has(n))).toEqual([]);
  });
});

describe("G. every registered tool has an explicit privacy classification", () => {
  const SENS = new Set(["look_screen", "understand_screen", "inspect_component", "list_windows", "read_window", "browser_accounts", "list_tabs", "look_visual", "look_popups", "read_menu", "read_dialog"]);
  const tested = new Set([...SENSITIVE.map((x) => x[0]), ...NON_SENSITIVE.map((x) => x.name), "look_visual", "click_visual", "close_window", "choose_file", "look_popups"]);
  it("every tool is covered by this file (a new tool must be added to a list above)", () => {
    const all = [...buildTools(), ...buildPopupTools(), ...buildVisualTools()];
    const missing = all.filter((t) => !tested.has(t.name)).map((t) => t.name);
    expect(missing).toEqual([]);
  });
  it("the sensitive flags in the source match the classification here", () => {
    const all = [...buildTools(), ...buildPopupTools(), ...buildVisualTools()];
    const flagged = [...new Set(all.filter((t) => t.sensitive).map((t) => t.name))].sort();
    expect(flagged).toEqual([...SENS].filter((n) => all.some((t) => t.name === n)).sort());
  });
});

// ------------------------------------------------------------------------------------------------ Z: last
describe("Z. the real network was never touched during the whole run", () => {
  it("no call reached the real fetch", () => { expect(stray).toBe(0); });
});
