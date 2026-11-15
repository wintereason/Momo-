import { afterEach, describe, expect, it, vi } from "vitest";
import { HELPER_SCRIPT } from "../shared/uiaHelper";
import { uiaHost } from "../shared/nodePorts";
import { nodeInput } from "./inputPorts";
import { classifyFailure } from "../orchestrator/recovery/taxonomy";

/** Hung-window detection: the helper reports it, the port passes it on only when it was actually reported, and it drives classification. */
afterEach(() => vi.restoreAllMocks());

describe("hung window state", () => {
  it("the helper asks Windows (IsHungAppWindow) and reports it with the other window facts, read-only", () => {
    expect(HELPER_SCRIPT).toContain("IsHungAppWindow");
    const state = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf("public static string State"), HELPER_SCRIPT.indexOf("SetProcessDpiAwarenessContext"));
    expect(state).toContain('\\"hung\\"');
    expect(state).not.toMatch(/PostMessage|SendMessage|TerminateProcess|ShowWindow|SetForeground/); // it only looks
  });

  it("windowState carries hung:true / hung:false exactly as reported", async () => {
    const spy = vi.spyOn(uiaHost, "request");
    spy.mockResolvedValueOnce({ ok: true, exists: true, minimized: false, pid: 7, fgPid: 7, hung: true });
    expect(await nodeInput.windowState(123)).toMatchObject({ exists: true, pid: 7, hung: true });
    spy.mockResolvedValueOnce({ ok: true, exists: true, minimized: false, pid: 7, fgPid: 7, hung: false });
    expect(await nodeInput.windowState(123)).toMatchObject({ hung: false });
  });

  it("when nothing was reported (an older helper, the one-shot fallback) hung is ABSENT, never a made-up false", async () => {
    vi.spyOn(uiaHost, "request").mockResolvedValueOnce({ ok: true, exists: true, minimized: false, pid: 7, fgPid: 7 });
    const s = await nodeInput.windowState(123);
    expect("hung" in s).toBe(false);
  });

  it("modal is passed on exactly as reported, and absent when nothing was reported", async () => {
    const spy = vi.spyOn(uiaHost, "request");
    spy.mockResolvedValueOnce({ ok: true, exists: true, minimized: false, pid: 7, fgPid: 7, hung: false, modal: true });
    expect(await nodeInput.windowState(123)).toMatchObject({ modal: true });
    spy.mockResolvedValueOnce({ ok: true, exists: true, minimized: false, pid: 7, fgPid: 7, hung: false });
    expect("modal" in (await nodeInput.windowState(123))).toBe(false);
  });

  it("the helper reports a blocking dialog from Windows (enabled popup), read-only", () => {
    const state = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf("public static string State"), HELPER_SCRIPT.indexOf("SetProcessDpiAwarenessContext"));
    expect(state).toContain('\\"modal\\"');
    expect(state).toContain("GetWindow(h, 6)"); // GW_ENABLEDPOPUP
  });

  it("a window that does not exist is not reported hung", async () => {
    vi.spyOn(uiaHost, "request").mockResolvedValueOnce({ ok: true, exists: false, minimized: false, pid: 0, fgPid: 4, hung: false });
    expect(await nodeInput.windowState(123)).toMatchObject({ exists: false, hung: false });
  });

  it("an invalid handle never reaches the helper", async () => {
    const spy = vi.spyOn(uiaHost, "request");
    expect(await nodeInput.windowState(-5)).toEqual({ exists: false, minimized: false, pid: 0, foregroundPid: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a hung state turns a timeout into app_unresponsive (the evidence the recovery layer will gather)", async () => {
    vi.spyOn(uiaHost, "request").mockResolvedValueOnce({ ok: true, exists: true, minimized: false, pid: 7, fgPid: 7, hung: true });
    const s = await nodeInput.windowState(123);
    expect(classifyFailure({ reason: "Windows didn't answer in time", evidence: { windowExists: s.exists, windowHung: s.hung } })).toBe("app_unresponsive");
    expect(classifyFailure({ reason: "Windows didn't answer in time", evidence: { windowExists: s.exists, windowHung: false } })).toBe("timeout");
  });
});
