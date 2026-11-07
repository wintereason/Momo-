import { describe, expect, it } from "vitest";
import { VisualAgent } from "./visualAgent";
import { WorldModel } from "../verifier";
import type { OcrResult, ScreenPort } from "../shared/ports";

const agent = (ocr: OcrResult) => {
  const world = new WorldModel();
  const screen: ScreenPort = { readUi: async () => ({ ok: false, reason: "n/a" }), ocr: async () => ocr };
  return { a: new VisualAgent(world, screen), world };
};

describe("VisualAgent", () => {
  it("passes a failure straight through and records nothing", async () => {
    const { a, world } = agent({ ok: false, reason: "no access" });
    expect(await a.read(5)).toEqual({ ok: false, reason: "no access" });
    expect(world.get("screen:5")).toBeUndefined();
  });
  it("cleans and redacts what the OCR engine returned, and keeps a low confidence", async () => {
    const { a, world } = agent({ ok: true, lines: ["  Error:​ boom  ", "x", "key AIzaSyA1234567890abcdefghijklmnopqrstuv"] });
    const r = await a.read(5);
    expect(r.ok && r.lines).toEqual(["Error: boom", expect.stringContaining("key")]);
    expect(JSON.stringify(r)).not.toContain("AIzaSyA1234567890");
    expect(world.get("screen:5")?.confidence).toBeLessThan(0.9);
  });
  it("a blank capture is 'nothing readable', not a successful read of nothing", async () => {
    const { a } = agent({ ok: true, lines: ["", " ", "x"] });
    expect(await a.read(5)).toMatchObject({ ok: false });
  });
  it("caps the number of lines", async () => {
    const { a } = agent({ ok: true, lines: Array.from({ length: 200 }, (_, i) => `line number ${i}`) });
    const r = await a.read(5);
    expect(r.ok && r.lines.length).toBe(80);
  });
});
