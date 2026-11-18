import { describe, expect, it } from "vitest";
import { call, finish } from "./popupWorld";
import { clickWorld, type Btn, type WorldOpts } from "./clickVisualWorld";
import { instructionNames } from "./visualTools";

/**
 * Phase 6c: click_visual. A click here is the riskiest thing Momo does with a picture, so most of these tests are about NOT clicking:
 * every refusal must leave the log of real clicks empty, and the one click that is allowed must land on the right button, once.
 */
const B = (label: string, l: number, t: number, extra: Partial<Btn> = {}): Btn => ({ label, l, t, w: 120, h: 44, ...extra });
const BASE = [B("Preview", 40, 60), B("Filter", 200, 60), B("Inspect", 360, 60)];
const centre = (b: Btn, win = { l: 200, t: 100 }) => ({ x: Math.round(win.l + b.l + b.w / 2), y: Math.round(win.t + b.t + b.h / 2) });

const go = async (o: WorldOpts, goal: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const w = clickWorld(o);
  const r = await w.run(goal, [call("click_visual", { _hwnd: 20, ...args }), finish()], extra);
  return { w, r, step: r.steps[0] };
};
const noClick = (w: ReturnType<typeof clickWorld>) => expect(w.log.clicks).toEqual([]);

describe("the user's own words name the target", () => {
  it("instructionNames: whole words, case and punctuation aside, never a part of a word", () => {
    expect(instructionNames("please click the Preview button", "Preview")).toBe(true);
    expect(instructionNames("click apply!", "APPLY")).toBe(true);
    expect(instructionNames("press Open file now", "Open file")).toBe(true);
    expect(instructionNames("click the Previewing tool", "Preview")).toBe(false); // part of a word
    expect(instructionNames("open the file", "Open file")).toBe(false);        // not contiguous
    expect(instructionNames("do something useful", "Preview")).toBe(false);
    expect(instructionNames("anything", "  ")).toBe(false);
  });

  it("a label the user did not say is never clicked (and nothing is even captured)", async () => {
    const { w, step } = await go({ buttons: BASE }, "tidy up the settings", { label: "Preview" });
    expect(step.outcome).toBe("failed");
    expect(step.text).toMatch(/not a label you asked me to click/);
    noClick(w);
    expect(w.log.grabs).toBe(0);
  });

  it("a label too short to tell apart is refused", async () => {
    const { w, step } = await go({ buttons: [B("Go", 40, 60)] }, "click G", { label: "G" });
    expect(step.text).toMatch(/that short/);
    noClick(w);
  });
});

describe("correct target selection", () => {
  it("clicks exactly the button with that label, at its centre, once", async () => {
    const { w, step } = await go({ buttons: BASE }, "click Filter", { label: "Filter" });
    expect(w.log.clicks).toEqual([{ ...centre(BASE[1]), hit: "Filter" }]);
    expect(step.outcome).toBe("unverified"); // no expectation was given: a click alone is never 'confirmed'
  });

  it("the same letters in another case or spacing are the same label; a similar label is not", async () => {
    const a = await go({ buttons: [B("OPEN FILE", 40, 60), B("Open", 200, 60)] }, "click open file", { label: "open file" });
    expect(a.w.log.clicks.map((c) => c.hit)).toEqual(["OPEN FILE"]);
    const b = await go({ buttons: [B("Sort by", 40, 60), B("Sorted", 200, 60), B("Sor", 360, 60)] }, "click Sort", { label: "Sort" });
    noClick(b.w);
    expect(b.step.text).toMatch(/could not see a button labelled/);
  });

  it("never a partial match: the label 'Open' does not match 'Open file'", async () => {
    const { w } = await go({ buttons: [B("Open file", 40, 60)] }, "click Open", { label: "Open" });
    noClick(w);
  });

  it("loose text that equals the label is not a button: nothing is clicked", async () => {
    const { w, step } = await go({ buttons: BASE, texts: [{ text: "Archive", l: 40, t: 300 }] }, "click Archive", { label: "Archive" });
    noClick(w);
    expect(step.text).toMatch(/could not see a button/);
  });

  it("an icon-only shape is never a target: there is no label to match", async () => {
    const w = clickWorld({ buttons: [{ ...B("x", 40, 60), readings: ["", "", ""] }] });
    const r = await w.run("click Preview", [call("click_visual", { _hwnd: 20, label: "Preview" }), finish()]);
    expect(w.log.clicks).toEqual([]);
    expect(r.steps[0].outcome).toBe("failed");
  });
});

describe("garbled and untrustworthy labels", () => {
  it("a label whose readings disagree is refused, and nothing is clicked", async () => {
    const { w, step } = await go({ buttons: [B("Preview", 40, 60, { readings: ["Preview", "Appiy", "Preview"] })] }, "click Preview", { label: "Preview" });
    noClick(w);
    expect(step.text).toMatch(/cannot trust it/);
  });

  it("a label read only once is refused", async () => {
    const { w } = await go({ buttons: [B("Preview", 40, 60, { readings: ["Preview", "", ""], noFrameWords: true })] }, "click Preview", { label: "Preview" });
    noClick(w);
  });

  it("a label with symbols among the letters is refused even when every reading agrees", async () => {
    const { w } = await go({ buttons: [B("p\\ay", 40, 60)] }, "click Play", { label: "Play" });
    noClick(w);
  });

  it("a garbled reading never matches a different, real label", async () => {
    // the picture shows 'Inspeet' where the button says Inspect: it is not the label that was asked for, so it is never clicked
    const { w } = await go({ buttons: [B("Inspeet", 40, 60)] }, "click Inspect", { label: "Inspect" });
    noClick(w);
  });
});

describe("duplicate labels, and Windows' own list first", () => {
  it("two buttons with the label: refused, nothing clicked", async () => {
    const { w, step } = await go({ buttons: [B("Filter", 40, 60), B("Filter", 200, 60), B("Preview", 360, 60)] }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(step.text).toMatch(/More than one button looks like/);
  });

  it("a twin that is too garbled to use still counts: the label is ambiguous", async () => {
    const { w } = await go({ buttons: [B("Filter", 40, 60), B("Filter", 200, 60, { readings: ["Filter", "Filtre", "Filter"] })] }, "click Filter", { label: "Filter" });
    noClick(w);
  });

  it("when Windows' own tree names the control, a picture is not used at all", async () => {
    const { w, step } = await go({ buttons: BASE, uia: ["Filter"] }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(step.text).toMatch(/Use click_control/);
    expect(w.log.detects).toBe(0); // not even looked at
  });

  it("when Windows lists the name twice it is ambiguous, not a reason to guess from a picture", async () => {
    const { w, step } = await go({ buttons: BASE, uia: ["Filter", "Filter"] }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(step.text).toMatch(/more than one control/);
    expect(w.log.detects).toBe(0);
  });

  it("a Windows control with another name does not stop the picture from being used", async () => {
    const { w } = await go({ buttons: BASE, uia: ["Minimize", "Close"] }, "click Filter", { label: "Filter" });
    expect(w.log.clicks.map((c) => c.hit)).toEqual(["Filter"]);
  });
});

describe("a window that cannot be trusted", () => {
  it("a window that sticks out past the screen is refused (something hidden there could change the answer)", async () => {
    const { w, step } = await go({ buttons: BASE, clipped: true }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(step.text).toMatch(/outside the screen/);
  });

  it("a window that is busy and does not answer in time is refused: nothing is clicked, and the reason says to try again", async () => {
    const w = clickWorld({ buttons: BASE });
    w.state.refuse = "busy";
    const r = await w.run("click Filter", [call("click_visual", { _hwnd: 20, label: "Filter" }), finish()]);
    expect(w.log.clicks).toEqual([]);
    expect(r.steps[0].text).toMatch(/busy and did not answer in time/);
  });

  it("a minimized window is refused", async () => {
    const w = clickWorld({ buttons: BASE });
    w.state.refuse = "minimized";
    const r = await w.run("click Filter", [call("click_visual", { _hwnd: 20, label: "Filter" }), finish()]);
    expect(w.log.clicks).toEqual([]);
    expect(r.steps[0].text).toMatch(/minimized/);
  });

  it("a window with a password box is never looked at or clicked", async () => {
    const w = clickWorld({ buttons: BASE });
    w.state.password = true;
    const r = await w.run("click Filter", [call("click_visual", { _hwnd: 20, label: "Filter" }), finish()]);
    expect(w.log.clicks).toEqual([]);
    expect(w.log.grabs).toBe(0);
    expect(r.steps[0].text).toMatch(/password/);
  });

  it("Momo's own window is refused", async () => {
    const w = clickWorld({ buttons: BASE });
    const r = await w.run("click Filter", [call("click_visual", { _hwnd: 999, label: "Filter" }), finish()]);
    expect(w.log.clicks).toEqual([]);
    expect(r.steps[0].text).toMatch(/my own windows/);
  });

  it("with Human-like control off, nothing is done", async () => {
    const { w, step } = await go({ buttons: BASE, noPointer: true }, "click Filter", { label: "Filter" });
    expect(step.text).toMatch(/Human-like control/);
    expect(w.log.grabs).toBe(0);
  });

  it("another window covering the spot: the pointer refuses, nothing is clicked", async () => {
    const w = clickWorld({ buttons: BASE });
    w.state.coverBy = 777;
    const r = await w.run("click Filter", [call("click_visual", { _hwnd: 20, label: "Filter" }), finish()]);
    expect(w.log.clicks).toEqual([]);
    expect(r.steps[0].text).toMatch(/covering/);
  });
});

describe("the last look before the press: things that change between observation and click", () => {
  it("the button moves away when the pointer arrives: refused, nothing clicked", async () => {
    const { w, step } = await go({ buttons: BASE, onArrive: (s) => { s.buttons[1].l += 60; } }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(step.text).toMatch(/not where I saw it|moved/);
  });

  it("a small shift within tolerance (2 px) is still the same button and is clicked", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.buttons[1].l += 2; } }, "click Filter", { label: "Filter" });
    expect(w.log.clicks.map((c) => c.hit)).toEqual(["Filter"]);
  });

  it("a shift of 6 px is not the same place: refused", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.buttons[1].l += 6; } }, "click Filter", { label: "Filter" });
    noClick(w);
  });

  it("the button disappears: refused", async () => {
    const { w, step } = await go({ buttons: BASE, onArrive: (s) => { s.buttons.splice(1, 1); } }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(step.text).toMatch(/could not see a button labelled/);
  });

  it("the button is relabelled to something else: refused", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.buttons[1].label = "Delete"; } }, "click Filter", { label: "Filter" });
    noClick(w);
  });

  it("the button is relabelled to a garble of itself: refused", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.buttons[1].readings = ["Filter", "Fiiter", "Filter"]; } }, "click Filter", { label: "Filter" });
    noClick(w);
  });

  it("the window is moved: refused (the pointer sees the window is not where it was seen)", async () => {
    const { w, step } = await go({ buttons: BASE, onArrive: (s) => { s.win.l += 40; } }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(step.text).toMatch(/moved|not where/);
  });

  it("the window is resized: refused", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.win.w += 30; } }, "click Filter", { label: "Filter" });
    noClick(w);
  });

  it("the window is minimized before the press: refused", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.refuse = "minimized"; } }, "click Filter", { label: "Filter" });
    noClick(w);
  });
});

describe("injected false targets", () => {
  it("a decoy button with the same label appears under the pointer: refused", async () => {
    const { w, step } = await go({ buttons: BASE, onArrive: (s) => { s.buttons.push(B("Filter", 600, 300)); } }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(step.text).toMatch(/More than one button looks like/);
  });

  it("the real button is replaced by a look-alike ('Filter' -> 'Filtre'): refused", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.buttons[1].label = "Filtre"; } }, "click Filter", { label: "Filter" });
    noClick(w);
  });

  it("two buttons swap places while the pointer travels: the stale spot is refused, and only after a FRESH look is the button that really carries the label pressed (once, at its new place)", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.buttons[1].label = "Inspect"; s.buttons[2].label = "Filter"; } }, "click Filter", { label: "Filter" });
    // the first attempt aimed at the old spot, where 'Inspect' now is: refused before anything was sent. The one permitted retry (nothing had been
    // sent) looked again, found exactly one 'Filter' (now at the third place) and pressed that. Inspect was never pressed.
    expect(w.log.clicks).toEqual([{ ...centre(BASE[2]), hit: "Filter" }]);
    expect(w.log.checks).toBe(2);
  });

  it("when the swap keeps happening on every attempt the label is never pressed: the stale target is always refused", async () => {
    let n = 0;
    const { w } = await go({ buttons: BASE, onArrive: (s) => { n++; const a = s.buttons[1], b = s.buttons[2]; [a.l, b.l] = [b.l, a.l]; } }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe("the effect: only the named effect counts", () => {
  const withEffect = (apply: (s: import("./clickVisualWorld").WorldState) => void, hit = "Preview") => ({ buttons: BASE, onPress: (s: import("./clickVisualWorld").WorldState, h: string | null) => { if (h === hit) apply(s); } }) as WorldOpts;

  it("the named label appears: verified", async () => {
    const { w, step } = await go(withEffect((s) => s.texts.push({ text: "Previewing", l: 40, t: 300 })), "click Preview", { label: "Preview", expect: { appears: "Previewing" } });
    expect(w.log.clicks.map((c) => c.hit)).toEqual(["Preview"]);
    expect(step.outcome).toBe("ok");
    expect(step.text).toMatch(/confirmed it worked/);
  });

  it("with no expectation the click is reported unverified, even though the picture changed", async () => {
    const { w, step } = await go(withEffect((s) => s.texts.push({ text: "Previewing", l: 40, t: 300 })), "click Preview", { label: "Preview" });
    expect(w.log.clicks).toHaveLength(1);
    expect(step.text).toMatch(/not told what should happen, so I cannot confirm/);
  });

  it("a change that is NOT the named effect does not verify (something else appeared)", async () => {
    const { w, step } = await go(withEffect((s) => s.texts.push({ text: "Something else", l: 40, t: 300 })), "click Preview", { label: "Preview", expect: { appears: "Previewing" } });
    expect(w.log.clicks).toHaveLength(1);
    expect(step.text).toMatch(/did not appear.*cannot confirm/);
  });

  it("nothing happens: unverified, and the click is NOT repeated", async () => {
    const { w, step } = await go({ buttons: BASE }, "click Preview", { label: "Preview", expect: { appears: "Previewing" } });
    expect(w.log.clicks).toHaveLength(1);
    expect(step.text).toMatch(/cannot confirm/);
  });

  it("the named label disappears: verified", async () => {
    const o = withEffect((s) => { s.buttons = s.buttons.filter((b) => b.label !== "Inspect"); });
    const { w, step } = await go(o, "click Preview", { label: "Preview", expect: { disappears: "Inspect" } });
    expect(w.log.clicks).toHaveLength(1);
    expect(step.text).toMatch(/confirmed it worked.*gone/);
  });

  it("a label that was not there to begin with cannot 'disappear': refused BEFORE clicking", async () => {
    const { w, step } = await go({ buttons: BASE }, "click Preview", { label: "Preview", expect: { disappears: "Banner" } });
    noClick(w);
    expect(step.text).toMatch(/not on the screen now/);
  });

  it("an expected label that is already on the screen cannot prove anything: refused BEFORE clicking", async () => {
    const { w, step } = await go({ buttons: BASE, texts: [{ text: "Previewing", l: 40, t: 300 }] }, "click Preview", { label: "Preview", expect: { appears: "Previewing" } });
    noClick(w);
    expect(step.text).toMatch(/already on the screen/);
  });

  it("an expected label that appears BEFORE the press (during the glide) cannot prove anything: refused", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.texts.push({ text: "Previewing", l: 40, t: 300 }); } }, "click Preview", { label: "Preview", expect: { appears: "Previewing" } });
    noClick(w);
  });

  it("a window with the named title opens: verified", async () => {
    const w = clickWorld({ buttons: BASE, onPress: (s, h) => { if (h === "Preview") s.extraWindows.push({ hwnd: 55, title: "Settings dialog" }); } });
    const r = await w.run("click Preview", [call("click_visual", { _hwnd: 20, label: "Preview", expect: { windowTitle: "settings" } }), finish()]);
    expect(r.steps[0].text).toMatch(/window titled/);
    expect(r.steps[0].outcome).toBe("ok");
  });

  it("a window with another title opens: unverified", async () => {
    const w = clickWorld({ buttons: BASE, onPress: (s, h) => { if (h === "Preview") s.extraWindows.push({ hwnd: 55, title: "Unrelated" }); } });
    const r = await w.run("click Preview", [call("click_visual", { _hwnd: 20, label: "Preview", expect: { windowTitle: "settings" } }), finish()]);
    expect(r.steps[0].text).toMatch(/cannot confirm/);
  });

  it("a look that cannot be trusted afterwards is 'cannot tell', never 'it went away'", async () => {
    const o = withEffect((s) => { s.refuse = "hidden"; }); // after the click the window cannot be captured at all
    const { step } = await go(o, "click Preview", { label: "Preview", expect: { disappears: "Inspect" } });
    expect(step.text).toMatch(/cannot confirm/);
  });
});

describe("cancellation, takeover, and what was sent", () => {
  it("the user takes the mouse during the last look: nothing is clicked", async () => {
    const { w, step } = await go({ buttons: BASE, takeoverDuringCheck: true }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(step.text).toMatch(/moved the mouse/);
  });

  it("cancel during the last look: nothing is clicked", async () => {
    const { w } = await go({ buttons: BASE, cancelDuringCheck: (cancel) => cancel() }, "click Filter", { label: "Filter" });
    noClick(w);
  });

  it("the whole task is cancelled while the pointer is travelling / at the last look: nothing is clicked", async () => {
    const w: ReturnType<typeof clickWorld> = clickWorld({ buttons: BASE, onArrive: () => w.cancelTask() });
    const r = await w.run("click Filter", [call("click_visual", { _hwnd: 20, label: "Filter" }), finish()]);
    expect(w.log.clicks).toEqual([]);
    expect(r.session.visualCapture.active()).toBe(false);
  });

  it("the task is cancelled right AFTER the press: no second click, no waiting for the effect, nothing held", async () => {
    const w: ReturnType<typeof clickWorld> = clickWorld({ buttons: BASE, onPress: () => w.cancelTask() });
    const r = await w.run("click Filter", [call("click_visual", { _hwnd: 20, label: "Filter", expect: { appears: "Previewing" } }), finish()]);
    expect(w.log.clicks).toHaveLength(1);
    expect(w.pointer.heldCount?.()).toBe(0);
    expect(r.steps.every((s) => s.outcome !== "ok")).toBe(true);
  });

  it("an error AFTER the press: the click is never repeated (input may have been sent)", async () => {
    const { w, step } = await go({ buttons: BASE, failAfterPress: true }, "click Filter", { label: "Filter" });
    expect(w.log.clicks).toHaveLength(1);
    expect(step.outcome).toBe("failed");
  });

  it("a refusal before anything was sent is retried at most once by the central policy, and never turns into a click", async () => {
    const { w } = await go({ buttons: BASE, onArrive: (s) => { s.buttons[1].l += 60; } }, "click Filter", { label: "Filter" });
    noClick(w);
    expect(w.log.checks).toBeLessThanOrEqual(2);
  });

  it("no input is held after any outcome, and the recognised text is gone with the task", async () => {
    const w = clickWorld({ buttons: BASE });
    const r = await w.run("click Filter", [call("click_visual", { _hwnd: 20, label: "Filter" }), finish()]);
    expect(w.pointer.heldCount?.()).toBe(0);
    expect(r.session.visualLook.stats().holding).toBe(false);
    expect(r.session.visualCapture.active()).toBe(false);
  });
});

describe("consequential labels, privacy and the journal", () => {
  it("a label like Delete is asked about FIRST: nothing is captured or clicked before the user says yes", async () => {
    const w = clickWorld({ buttons: [B("Delete", 40, 60), B("Keep", 200, 60)] });
    const r = await w.run("click Delete", [call("click_visual", { _hwnd: 20, label: "Delete" }), finish()], {});
    // runPopup sets the policy not to ask for reversible steps; consequential ones are asked about regardless
    expect(r.events.some((e) => e.type === "task.confirmation_required")).toBe(true);
    expect(w.log.clicks).toEqual([]);
    expect(w.log.grabs).toBe(0);
  });

  it("the journal holds no label, and the answer shows no text except the one the user named", async () => {
    const w = clickWorld({ buttons: [B("Preview", 40, 60), B("Secretword", 200, 60)], texts: [{ text: "Personalnote", l: 40, t: 300 }] });
    const r = await w.run("click Preview", [call("click_visual", { _hwnd: 20, label: "Preview", expect: { appears: "Previewing" } }), finish()]);
    const dump = JSON.stringify(r.session.orchestrator.journal());
    expect(dump).not.toMatch(/Preview|Secretword|Personalnote|Previewing/);
    const text = r.steps[0].text;
    expect(text).not.toMatch(/Secretword|Personalnote/);
  });

  it("a refusal does not leak the other labels on the screen either", async () => {
    const w = clickWorld({ buttons: [B("Secretword", 40, 60), B("Othersecret", 200, 60)] });
    const r = await w.run("click Preview", [call("click_visual", { _hwnd: 20, label: "Preview" }), finish()]);
    expect(r.steps[0].text).not.toMatch(/Secretword|Othersecret/);
  });
});

describe("click_visual's own code", () => {
  it("never touches the disk or the network, logs nothing, and has no way to keep a picture or recognised text", async () => {
    const fsx = await import("node:fs");
    const path = await import("node:path");
    const src = fsx.readFileSync(path.join(__dirname, "visualTools.ts"), "utf8");
    expect(src).not.toMatch(/from "node:|require\(|fetch\(|XMLHttpRequest|WebSocket|writeFile|appendFile|createWriteStream|localStorage/);
    expect(src).not.toMatch(/console\.(log|info|warn|error)/);
    expect(src).not.toMatch(/Buffer|Uint8Array|toDataURL|base64/);
  });

  it("the only way it presses anything is the guarded pointer click, with the last-look hook and the window-exactly-here guard", async () => {
    const fsx = await import("node:fs");
    const path = await import("node:path");
    const src = fsx.readFileSync(path.join(__dirname, "visualTools.ts"), "utf8");
    const clicks = src.match(/\bp\.click\(/g) ?? [];
    expect(clicks.length).toBe(1);
    const line = src.split("\n").find((l) => /\bp\.click\(/.test(l)) ?? "";
    for (const guard of ["expectRoot", "expectWindow", "verifyTarget"]) expect(line, guard).toContain(guard);
    expect(src).not.toMatch(/\.press\(|\.type\(|\.drag\?*\(|\.scroll\?*\(|clickControl|invokeControl|setControlText/);
  });
});
