import { describe, expect, it } from "vitest";
import type { CaptureTransport } from "../shared/ports";
import { call, finish, popupWorld, runPopup, stepsOf, un } from "./popupWorld";

/** Phase 6b: look_visual. Read-only, honest about what a picture can and cannot show. The helper is faked; the real one is measured separately. */
const grab = (n: number) => ({ ok: true, state: "ready", ready: true, session: 1, frame: n, w: 1640, h: 1280, l: 600, t: 240, pw: 1640, ph: 1280, scale: 1, dpi: 192, mdpi: 192, ms: 30 });
const notReady = { ok: true, state: "not_ready", ready: false, session: 1, frame: 1 };
const LAYOUT = {
  ok: true, session: 1, frame: 2, w: 1640, h: 1280, msCopy: 5, msShapes: 20, msCrops: 80, msOcr: 130,
  crops: [[0, "Apply", "Apply"], [1, "Reset", "Reset"], [3, "Sunny", "Sunny"], [4, "Sunny", "Sunny"]],
  shapes: [[80, 140, 260, 100, 92, 236], [400, 140, 260, 100, 92, 236], [720, 140, 120, 100, 100, 137], [80, 400, 260, 100, 92, 236], [400, 400, 260, 100, 92, 236]],
  words: [["Apply", 150, 170, 120, 30], ["Reset", 470, 170, 110, 30], ["Sunny", 150, 430, 120, 30], ["Sunny", 470, 430, 120, 30], ["Hello", 100, 700, 80, 30]],
};

function world(o: { grabs?: unknown[]; detect?: unknown; windows?: Array<{ hwnd: number; pid: number; process: string; title: string; z?: number }>; password?: boolean; transport?: CaptureTransport } = {}) {
  const calls: string[] = [];
  let g = 0;
  const transport: CaptureTransport = o.transport ?? {
    async send(cmd, args) {
      calls.push(args === undefined ? cmd : `${cmd} ${([] as number[]).concat(args).join(" ")}`);
      if (cmd === "capstart") return { ok: true, session: 1, bytes: 1 };
      if (cmd === "capgrab") { const a = o.grabs ?? [notReady, grab(2)]; return a[Math.min(g++, a.length - 1)]; }
      if (cmd === "capdetect") return o.detect ?? LAYOUT;
      return { ok: true, was: true };
    },
  };
  const w = popupWorld({ popups: () => [] });
  if (o.password) (w.deps.screen as { readUi: unknown }).readUi = async () => ({ ok: true, items: [un("Edit", "Password", { password: true })], truncated: false, hadPasswordField: true });
  if (o.windows) (w.deps as unknown as { win: unknown }).win = { query: async () => ({ activePid: 20, activeHwnd: 20, windows: [{ hwnd: 999, pid: 999, process: "electron", title: "Momo", z: 5 }, ...o.windows!] }) };
  return { w, transport, calls };
}
const run = async (x: ReturnType<typeof world>, args: Record<string, unknown> = {}) => {
  const r = runPopup(x.w, [call("look_visual", { _hwnd: 20, ...args }), finish()], { capture: x.transport });
  await r.session.handleTranscript("s", "look at the picture");
  return { ...r, step: stepsOf(r.results)[0] };
};

describe("look_visual", () => {
  it("lists what the picture looks like: labelled button-like shapes, a shape with no label, loose text, each with a score and a verdict", async () => {
    const x = world();
    const { step } = await run(x);
    expect(step.outcome).toBe("ok");
    expect(step.text).toMatch(/LOOKS like, not proven controls/);
    expect(step.text).toMatch(/button-like shape with a label “Apply” · score 0\.\d\d · could be offered as a target/);
    expect(step.text).toMatch(/unlabelled shape · score [\d.]+ · NOT a target: No readable label/);
    expect(step.text).toMatch(/loose text “Hello” · score [\d.]+ · NOT a target: Text alone does not show/);
  });

  it("two buttons with the same label are reported as ambiguous, not as targets", async () => {
    const { step } = await run(world());
    const sunny = step.text.split("\n").filter((l) => /Sunny/.test(l) && /button-like/.test(l));
    expect(sunny).toHaveLength(2);
    for (const l of sunny) expect(l).toMatch(/NOT a target: Another candidate has the same label/);
  });

  it("`find` narrows to a label; a label that is not found says it does NOT prove it is absent", async () => {
    const hit = await run(world(), { find: "reset" });
    expect(hit.step.text).toMatch(/“Reset”/);
    expect(hit.step.text).not.toMatch(/“Apply”/);
    const miss = await run(world(), { find: "delete" });
    expect(miss.step.text).toMatch(/No candidate has the label/);
    expect(miss.step.text).toMatch(/does not prove it is not there/);
  });

  it("a window with nothing recognisable says that does NOT mean it is empty", async () => {
    const { step } = await run(world({ detect: { ...LAYOUT, shapes: [], words: [], crops: [] } }));
    expect(step.text).toMatch(/does NOT mean it is empty/);
  });

  it("a blank, minimized or capture-excluded window is refused with the reason, never described as empty", async () => {
    for (const [state, rx] of [["blank", /looks blank/], ["minimized", /minimized/], ["excluded", /does not allow its picture/], ["busy", /busy and did not answer in time/]] as const) {
      const { step } = await run(world({ grabs: [{ ok: false, state }] }));
      expect(step.outcome).toBe("failed");
      expect(step.text).toMatch(rx);
    }
  });

  it("a window that sticks out past the screen says so: what is outside may be missing from the picture", async () => {
    const x = world({ grabs: [{ ...grab(1), ready: false, state: "not_ready" }, { ...grab(2), t: 1000, vl: 0, vt: 0, vw: 2880, vh: 1800 }] });
    const { step } = await run(x);
    expect(step.text).toMatch(/Part of this window is outside the screen/);
    expect(step.text).toMatch(/may be missing from the picture/);
  });

  it("it never looks at Momo's own windows or at a window with a password box", async () => {
    const own = world();
    const r1 = runPopup(own.w, [call("look_visual", { _hwnd: 999 }), finish()], { capture: own.transport });
    await r1.session.handleTranscript("s", "look");
    expect(stepsOf(r1.results)[0].text).toMatch(/one of my own windows/);
    expect(own.calls).toEqual([]); // nothing was captured
    const pw = world({ password: true });
    const { step } = await run(pw);
    expect(step.text).toMatch(/password box/);
    expect(pw.calls).toEqual([]);
  });

  it("with no capture available it says so", async () => {
    const r = runPopup(popupWorld({ popups: () => [] }), [call("look_visual", { _hwnd: 20 }), finish()]);
    await r.session.handleTranscript("s", "look");
    expect(stepsOf(r.results)[0].text).toMatch(/not available right now/);
  });

  it("it is read-only: no click, key, focus change or typing, and the capture is freed when the task ends", async () => {
    const x = world();
    const { session } = await run(x);
    expect(x.w.log.clicks).toEqual([]);
    expect(x.w.log.presses).toEqual([]);
    expect(x.w.log.act).toEqual([]);
    expect(x.w.log.texts).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(session.visualCapture.active()).toBe(false);
    expect(session.visualLook.stats().holding).toBe(false); // the recognised text is gone with it
    expect(x.calls).toContain("capstop");
  });

  it("the label never reaches the action journal or any diagnostic", async () => {
    const x = world();
    const { session } = await run(x);
    const dump = JSON.stringify(session.orchestrator.journal());
    expect(dump).not.toMatch(/Apply|Reset|Sunny|Hello/);
    expect(JSON.stringify(session.visualLook.stats())).not.toMatch(/Apply|Reset|Sunny|Hello/);
  });

  it("it is a screen read: asked about when the user's policy says so, and kept from an online AI that may not see the screen", async () => {
    const x = world();
    const r = runPopup(x.w, [call("look_visual", { _hwnd: 20 }), finish()], { capture: x.transport });
    r.session.setPolicy({ confirmReversible: false, confirmScreenRead: true });
    await r.session.handleTranscript("s", "look");
    const asked = r.events.find((e) => e.type === "task.confirmation_required");
    expect(asked).toBeTruthy();
    expect(x.calls).toEqual([]); // nothing was captured before the user said yes
  });
});
