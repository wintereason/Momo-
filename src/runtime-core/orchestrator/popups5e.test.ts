import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildTools } from "./tools";
import { call, finish, me, popupWorld, runPopup, stepsOf, tw, un } from "./popupWorld";
import { buildPlanInput } from "./ai/prompts";

/** Phase 5e: what holds across all of phase 5 — privacy, no cost on ordinary steps, the tools are registered and described to the planner. */
const SRC = (f: string) => fs.readFileSync(path.resolve(__dirname, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the popup tools are part of the toolbox", () => {
  const names = ["look_popups", "read_menu", "choose_menu_item", "close_popup", "read_dialog", "answer_dialog", "choose_file"];
  it("all seven are registered with a description, and the planner is told how to use them", () => {
    const tools = buildTools();
    for (const n of names) { const t = tools.find((x) => x.name === n); expect(t, n).toBeTruthy(); expect(t!.description.length, n).toBeGreaterThan(40); }
    const prompt = buildPlanInput("goal", []);
    void prompt;
    const src = fs.readFileSync(path.resolve(__dirname, "ai/prompts.ts"), "utf8");
    expect(src).toMatch(/7f\. Menus, drop-downs and dialogs/);
    expect(src).toMatch(/Secure prompts \(administrator approval, sign-in, passwords\) are never read or answered/);
  });
  it("reads are sensitive (item names and dialog text are screen content), actions are not marked as reads", () => {
    const t = (n: string) => buildTools().find((x) => x.name === n)!;
    for (const n of ["look_popups", "read_menu", "read_dialog"]) { expect(t(n).sensitive, n).toBe(true); expect(t(n).risk({}), n).toBe("sensitive_read"); }
    for (const n of ["choose_menu_item", "answer_dialog", "choose_file", "close_popup"]) expect(["reversible", "consequential"], n).toContain(t(n).risk({ path: ["Open"], button: "Cancel" }));
  });
});

describe("privacy of the popup code", () => {
  it("never writes a file, opens the network, logs, or runs a process", () => {
    for (const f of ["popupTools.ts", "../uipanel/popupAgent.ts", "../uipanel/transientRegistry.ts"]) {
      expect(SRC(f), f).not.toMatch(/node:fs|node:child_process|node:net|node:http|\bfetch\(|console\.|localStorage|writeFile|XMLHttpRequest/);
    }
  });
  it("a whole menu + dialog + file task leaves no item, button, text or path in the journal or the planner's recorded failures", async () => {
    let open = true;
    const items = [me("TopSecretMenuItem", { rect: { l: 110, t: 110, w: 180, h: 24 } })];
    const w = popupWorld({
      popups: () => (open ? [{ win: tw(101, "menu"), menu: items }, { win: tw(201, "dialog"), ui: [un("Text", "TopSecretDialogText"), un("Button", "TopSecretButton", { rect: { l: 500, t: 400, w: 80, h: 28 } }), un("Edit", "File name:", { rid: "E", value: "C:\\TopSecretPath\\x.txt" })] }] : []),
      chainAt: () => [{ rid: "r:TopSecretMenuItem", type: "MenuItem", name: "TopSecretMenuItem", password: false }], onClick: () => { open = false; },
    });
    const r = runPopup(w, [call("read_menu"), call("read_dialog"), call("choose_menu_item", { path: ["TopSecretMenuItem"] }), finish()]);
    await r.session.handleTranscript("s", "x");
    const j = JSON.stringify(r.session.orchestrator.journal());
    expect(j).not.toMatch(/TopSecret/);
    expect(stepsOf(r.results).length).toBeGreaterThan(0);
  });
  it("the registry stores handles, classes and kinds only: not one title or text field exists on what it keeps", () => {
    const src = SRC("../uipanel/transientRegistry.ts");
    expect(src).not.toMatch(/\btitle\b|\btext\b|\bname:/);
  });
});

describe("no cost on ordinary steps", () => {
  it("an ordinary (non-popup) step costs well under 5 ms of orchestration with the popup tools registered, and never touches pop-ups", async () => {
    const w = popupWorld({ popups: () => [] });
    const TASKS = 60;
    // The best of several rounds: a loaded machine (the whole suite runs in parallel, some tests compile PowerShell code) only ever makes a round
    // SLOWER, so the fastest round is the cost of the orchestration itself. The limit is unchanged.
    let perStep = Infinity;
    for (let round = 0; round < 5; round++) {
      const t0 = performance.now();
      for (let i = 0; i < TASKS; i++) {
        const r = runPopup(w, [call("list_windows"), finish()]);
        await r.session.handleTranscript("s" + round + "-" + i, "x");
      }
      perStep = Math.min(perStep, (performance.now() - t0) / (TASKS * 2)); // a planner turn + a tool step per task
    }
    expect(perStep).toBeLessThan(5);
    expect(w.log.looks).toBe(0);      // no pop-up listing
    expect(w.log.menuReads).toBe(0);  // no menu reads
  });
});
