import { describe, expect, it } from "vitest";
import { UI_STATES } from "../types/runtime-events";
import { REST_POSE, poseFor } from "./pose";
import { SUCCESS_KINDS, effectMotion, effectsFor } from "./effects";
import { createPetals, rng, stepPetals, type Bounds } from "./petals";
import { AdaptiveQuality, FrameBudget, chooseQuality, targetFps } from "./perf";
import { ONE_SHOT, STATE_TO_CLIPS, coverage, fitScale, resolveClip, resolveMorph, seatedOffset } from "./modelMap";
import { manifest } from "../companion/expression";

describe("character motion", () => {
  it("every state has a finite, bounded pose at any time", () => {
    for (const s of UI_STATES) {
      for (const t of [0, 0.4, 1.7, 33.3, 1234.5]) {
        for (const since of [0, 0.3, 2, 50]) {
          const p = poseFor(s, t, since);
          for (const v of Object.values(p)) expect(Number.isFinite(v), `${s} ${t}`).toBe(true);
          expect(Math.abs(p.x)).toBeLessThan(0.1);
          expect(p.y).toBeGreaterThan(-0.15);
          expect(p.y).toBeLessThan(0.25);
          expect(p.scale).toBeGreaterThan(0.9);
          expect(p.scale).toBeLessThan(1.1);
          expect(p.squash).toBeGreaterThan(0.9);
          expect(p.squash).toBeLessThan(1.1);
          expect(Math.abs(p.rotZ)).toBeLessThan(0.3);
        }
      }
    }
  });

  it("success hops at first and then settles; sleeping rests lower than idle", () => {
    const hop = Math.max(...Array.from({ length: 40 }, (_, i) => poseFor("success", 0, i * 0.03).y));
    expect(hop).toBeGreaterThan(0.05);
    expect(poseFor("success", 10, 5).y).toBeLessThan(0.02);
    expect(poseFor("sleeping", 0, 0).y).toBeLessThan(poseFor("idle", 0, 0).y);
  });

  it("reduce-motion keeps the motion tiny for every state", () => {
    for (const s of UI_STATES) {
      const p = poseFor(s, 1.3, 0.2, true);
      expect(Math.abs(p.x)).toBeLessThan(0.01);
      expect(Math.abs(p.scale - 1)).toBeLessThan(0.01);
      expect(Math.abs(p.rotZ)).toBeLessThan(0.05);
    }
  });

  it("is deterministic", () => {
    expect(poseFor("thinking", 2.2, 1)).toEqual(poseFor("thinking", 2.2, 1));
    expect(REST_POSE).toEqual({ x: 0, y: 0, scale: 1, squash: 1, rotZ: 0 });
  });
});

describe("floating effect icons", () => {
  it("every state is covered, and idle shows nothing", () => {
    for (const s of UI_STATES) expect(Array.isArray(effectsFor(s))).toBe(true);
    expect(effectsFor("idle")).toEqual([]);
  });

  it("success icons exist ONLY for the success state (an icon never implies a result that isn't verified)", () => {
    for (const s of UI_STATES) {
      const kinds = effectsFor(s).map((e) => e.kind);
      for (const k of SUCCESS_KINDS) expect(kinds.includes(k), `${s} shows ${k}`).toBe(s === "success");
    }
    // partial success must look different from success
    expect(effectsFor("partial_success").map((e) => e.kind)).toEqual(["half"]);
  });

  it("matches the reference: mic while listening, dots thinking, sweat when sorry, zzz asleep", () => {
    expect(effectsFor("listening")[0].kind).toBe("mic");
    expect(effectsFor("thinking")[0].kind).toBe("dots");
    expect(effectsFor("sorry")[0].kind).toBe("sweat");
    expect(effectsFor("sleeping")[0].kind).toBe("zzz");
    expect(effectsFor("asking")[0].kind).toBe("question");
  });

  it("motion stays visible and finite", () => {
    for (const s of UI_STATES) for (const e of effectsFor(s)) {
      for (const t of [0, 0.5, 9, 200]) {
        const m = effectMotion(e.kind, t, t);
        for (const v of Object.values(m)) expect(Number.isFinite(v)).toBe(true);
        expect(m.alpha).toBeGreaterThanOrEqual(0);
        expect(m.alpha).toBeLessThanOrEqual(1);
      }
    }
    expect(effectMotion("mic", 0, 0).alpha).toBe(0); // pops in
    expect(effectMotion("mic", 1, 1).alpha).toBe(1);
  });
});

describe("petals", () => {
  const b: Bounds = { xMin: -1.6, xMax: 1.6, yMin: -1, yMax: 1.4, zMin: -0.8, zMax: 0.8 };

  it("is reproducible from a seed and has the requested count", () => {
    expect(createPetals(40, b, 3)).toEqual(createPetals(40, b, 3));
    expect(createPetals(40, b, 3)).not.toEqual(createPetals(40, b, 4));
    expect(createPetals(25, b)).toHaveLength(25);
    expect(rng(1)()).toBe(rng(1)());
  });

  it("starts inside the bounds and never leaves them, however long it runs", () => {
    const p = createPetals(60, b, 11);
    let t = 0;
    for (let i = 0; i < 6000; i++) { t += 0.033; stepPetals(p, 0.033, t, b); }
    for (const q of p) {
      expect(q.x).toBeGreaterThanOrEqual(b.xMin);
      expect(q.x).toBeLessThanOrEqual(b.xMax);
      expect(q.y).toBeGreaterThanOrEqual(b.yMin - 1e-9);
      expect(q.y).toBeLessThanOrEqual(b.yMax);
      for (const v of [q.x, q.y, q.z, q.rot]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("petals fall, and a huge time step (hidden page) cannot make them jump", () => {
    const p = createPetals(10, b, 5);
    const y0 = p.map((q) => q.y);
    stepPetals(p, 0.5, 1, b);
    expect(p.every((q, i) => q.y <= y0[i] || q.y === b.yMax)).toBe(true);
    const q = createPetals(10, b, 5);
    stepPetals(q, 60, 1, b); // one minute in a single step is clamped to 0.1 s
    for (let i = 0; i < 10; i++) expect(Math.abs(q[i].y - y0[i]) < 0.05 || q[i].y === b.yMax).toBe(true);
  });

  it("reduce-motion slows them right down", () => {
    const a = createPetals(10, b, 9), c = createPetals(10, b, 9);
    stepPetals(a, 0.05, 1, b);
    stepPetals(c, 0.05, 1, b, true);
    const fallA = a.reduce((s, q, i) => s + (createPetals(10, b, 9)[i].y - q.y), 0);
    const fallC = c.reduce((s, q, i) => s + (createPetals(10, b, 9)[i].y - q.y), 0);
    expect(fallC).toBeLessThan(fallA);
  });
});

describe("performance policy for a laptop", () => {
  it("auto picks the lightweight view when the machine or the user asks for less", () => {
    expect(chooseQuality({ setting: "auto", reduceMotion: false, webgl: true, deviceMemoryGB: 8 })).toBe("standard");
    expect(chooseQuality({ setting: "auto", reduceMotion: true, webgl: true })).toBe("low");
    expect(chooseQuality({ setting: "auto", reduceMotion: false, webgl: true, deviceMemoryGB: 2 })).toBe("low");
    expect(chooseQuality({ setting: "auto", reduceMotion: false, webgl: false })).toBe("low");
  });
  it("an explicit choice is respected, except that no WebGL always means low", () => {
    expect(chooseQuality({ setting: "standard", reduceMotion: true, webgl: true })).toBe("standard");
    expect(chooseQuality({ setting: "low", reduceMotion: false, webgl: true })).toBe("low");
    expect(chooseQuality({ setting: "standard", reduceMotion: false, webgl: false })).toBe("low");
  });
  it("draws nothing when hidden and very little when asleep or idle", () => {
    const o = { reduceMotion: false, pointerNear: false };
    expect(targetFps({ ...o, state: "idle", hidden: true })).toBe(0);
    expect(targetFps({ ...o, state: "sleeping", hidden: true })).toBe(0);
    expect(targetFps({ ...o, state: "sleeping", hidden: false })).toBeLessThanOrEqual(8);
    expect(targetFps({ ...o, state: "idle", hidden: false })).toBeLessThanOrEqual(15);
    expect(targetFps({ ...o, state: "working", hidden: false })).toBe(30);
    expect(targetFps({ ...o, state: "working", hidden: false, reduceMotion: true })).toBeLessThanOrEqual(12);
    for (const s of UI_STATES) expect(targetFps({ ...o, state: s, hidden: false })).toBeLessThanOrEqual(30);
  });
  it("the frame budget never draws faster than the target", () => {
    const f = new FrameBudget();
    let drawn = 0;
    for (let ms = 0; ms < 1000; ms += 4) if (f.due(ms, 15)) drawn++; // ticks every 4 ms, target 15 fps
    expect(drawn).toBeGreaterThanOrEqual(14);
    expect(drawn).toBeLessThanOrEqual(16);
    expect(new FrameBudget().due(0, 0)).toBe(false);
  });
  it("steps down to the lightweight view when most frames are slow, but not for a brief stutter", () => {
    const a = new AdaptiveQuality();
    for (let i = 0; i < 400; i++) expect(a.push(16)).toBe("ok");
    const stutter = new AdaptiveQuality();
    let r = "ok";
    for (let i = 0; i < 100; i++) r = stutter.push(i % 10 === 0 ? 120 : 16);
    expect(r).toBe("ok");
    const slow = new AdaptiveQuality();
    const results = Array.from({ length: 200 }, () => slow.push(80));
    expect(results.filter((x) => x === "downgrade")).toHaveLength(1); // exactly once
    const resumed = new AdaptiveQuality();
    for (let i = 0; i < 50; i++) resumed.push(90);
    resumed.reset();
    expect(resumed.push(90)).toBe("ok");
  });
});

describe("mapping states onto a .glb model", () => {
  it("every state has a preferred clip list that ends in idle (or is idle)", () => {
    for (const s of UI_STATES) {
      const list = STATE_TO_CLIPS[s];
      expect(list.length).toBeGreaterThan(0);
      expect(list[list.length - 1]).toBe("idle");
    }
  });
  it("picks the first clip the model has, ignoring case and punctuation", () => {
    expect(resolveClip("success", ["Idle", "Celebrate", "Sorry"])).toBe("Celebrate");
    expect(resolveClip("asking", ["idle", "Confused"])).toBe("Confused");
    expect(resolveClip("sleeping", ["Idle", "sleep_loop"])).toBe("Idle"); // "sleep_loop" is not "sleep": falls back
    expect(resolveClip("listening", ["IDLE"])).toBe("IDLE");
    expect(resolveClip("thinking", ["walk", "run"])).toBeNull(); // nothing suitable: procedural pose instead
    expect(resolveClip("idle", [])).toBeNull();
  });
  it("morph targets follow the same expression names as the sprite manifest", () => {
    for (const s of UI_STATES) {
      expect(manifestMorphs(s)).toEqual(manifest.stateToExpression[s]);
    }
    expect(resolveMorph("sorry", ["Happy", "Sorry"])).toBe("Sorry");
    expect(resolveMorph("error", ["angry", "happy"])).toBe("angry");
    expect(resolveMorph("sorry", ["happy"])).toBeNull();
  });
  it("coverage: every state always resolves to something", () => {
    const none = coverage({ clips: [], morphs: [] });
    const full = coverage({ clips: ["idle", "success", "sorry"], morphs: ["happy"] });
    for (const s of UI_STATES) {
      expect(["clip", "morph", "procedural"]).toContain(none[s]);
      expect(none[s]).toBe("procedural");
    }
    expect(full.success).toBe("clip");
    expect(full.idle).toBe("clip");
    expect(full.thinking).toBe("clip"); // falls back to the idle clip
  });
  it("flourishes play once; loops keep going", () => {
    expect(ONE_SHOT.has("success")).toBe(true);
    expect(ONE_SHOT.has("idle")).toBe(false);
  });
  it("models are fitted to a common size and seated on the table whatever their authoring units", () => {
    expect(fitScale(2, 1)).toBe(0.5);
    expect(fitScale(0.01, 1)).toBe(100); // a model exported in centimetres-ish units
    expect(fitScale(0, 1)).toBe(1);
    expect(fitScale(NaN, 1)).toBe(1);
    expect(seatedOffset(-0.5, 2)).toBe(1);
  });
});

import { STATE_TO_MORPHS } from "./modelMap";
const manifestMorphs = (s: (typeof UI_STATES)[number]) => STATE_TO_MORPHS[s];
