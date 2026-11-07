import { describe, expect, it } from "vitest";
import { DesktopAgent, sanitizeTitle } from "./desktopAgent";
import { WorldModel } from "../verifier";
import type { RawWindow, WindowsPort, WindowsSnapshot } from "../shared/ports";

const W = (hwnd: number, pid: number, process: string, title: string): RawWindow => ({ hwnd, pid, process, title });
const agent = (snap: WindowsSnapshot | (() => Promise<WindowsSnapshot>), selfPids: number[] = []) => {
  const world = new WorldModel();
  const win: WindowsPort = { query: typeof snap === "function" ? snap : async () => snap };
  return { a: new DesktopAgent(world, win, () => selfPids), world };
};

describe("sanitizeTitle", () => {
  it("removes control, zero-width and direction-override characters and caps the length", () => {
    expect(sanitizeTitle("a\u0000b​c‮d⁦e﻿f")).toBe("a b c d e f");
    expect(sanitizeTitle("x".repeat(500))).toHaveLength(200);
    expect(sanitizeTitle(null)).toBe("");
  });
});

describe("DesktopAgent", () => {
  it("marks exactly the foreground window when Windows tells us which one it is", async () => {
    const { a } = agent({ activePid: 10, activeHwnd: 102, windows: [W(101, 10, "chrome", "A"), W(102, 10, "chrome", "B"), W(201, 20, "Code", "C")] });
    const s = await a.snapshot();
    expect(s.windows.filter((w) => w.active).map((w) => w.hwnd)).toEqual([102]);
    expect(s.active?.title).toBe("B");
  });
  it("falls back to 'a window of the foreground program' and says it is less certain", async () => {
    const { a, world } = agent({ activePid: 10, activeHwnd: 999, windows: [W(101, 10, "chrome", "A"), W(102, 10, "chrome", "B")] });
    const s = await a.snapshot();
    expect(s.windows.every((w) => w.active)).toBe(true);
    expect(world.get("window:101")!.confidence).toBeLessThan(0.7);
  });
  it("no foreground window known means no active window", async () => {
    const { a } = agent({ activePid: null, windows: [W(1, 10, "x", "A")] });
    expect((await a.snapshot()).active).toBeNull();
  });
  it("ignores malformed records and tells Momo's own windows apart", async () => {
    const { a } = agent({ activePid: 1, windows: [W(Number.NaN, 5, "x", "bad"), W(1, 1, "electron", "Momo"), W(2, 2, "Code", "Code")] }, [1]);
    const s = await a.snapshot();
    expect(s.windows.map((w) => w.hwnd)).toEqual([1, 2]);
    expect(s.windows[0].isMomo).toBe(true);
  });
  it("a failing query leaves an error for the caller and invents nothing", async () => {
    const { a, world } = agent(async () => { throw new Error("boom"); });
    await expect(a.snapshot()).rejects.toThrow("boom");
    expect(world.get("desktop:main")).toBeUndefined();
  });
});
