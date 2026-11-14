import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AVATAR_ARTS, AVATARS, avatarFiles, avatarSprite, isSpriteArt, type SpriteArt } from "./avatars";
import { AVATAR_ARTS as ART_CHOICES, CharacterPrefsSchema, defaultCharacter } from "./config";
import { EXPRESSIONS } from "./face";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("avatar sheets", () => {
  it("every semantic expression has a drawn face, for every avatar", () => {
    for (const art of AVATAR_ARTS) {
      for (const e of EXPRESSIONS) expect(AVATARS[art].faces[e], `${art}/${e}`).toMatch(/^(r[12]c[1-3]|s1|g1|h1)$/);
    }
  });

  it("only real faces are referenced, and the files are on disk for both views", () => {
    for (const art of AVATAR_ARTS) {
      for (const view of ["head", "full"] as const) {
        for (const e of EXPRESSIONS) {
          const cell = AVATARS[art].faces[e];
          const file = path.join(root, "assets/avatars", art, view, `${cell}.png`);
          expect(fs.existsSync(file), file).toBe(true);
          expect(fs.statSync(file).size, file).toBeGreaterThan(1000);
          expect(avatarSprite(art, e, view === "head" ? "compact" : "expanded"), `${art}/${e}/${view}`).toBeTruthy();
        }
      }
    }
  });

  it("each sheet contributes the twelve sprites (six faces x two crops), plus two for each extra video-cut pose", () => {
    for (const art of AVATAR_ARTS) {
      const extra = art === "dark" ? 2 : 1; // dark: surprised and eyes-closed smile, both with glasses; bob: the wave
      expect(avatarFiles(art), art).toHaveLength(12 + 2 * extra);
      expect(avatarFiles(art).filter((k) => k.startsWith("head/"))).toHaveLength(6 + extra);
      expect(avatarFiles(art).filter((k) => k.startsWith("full/"))).toHaveLength(6 + extra);
    }
  });

  it("the setting offers the drawn character, both sheets and the video-cut avatar, and defaults to the supplied avatar", () => {
    expect([...ART_CHOICES]).toEqual(["drawn", "dark", "bob"]);
    expect(defaultCharacter.art).toBe("dark");
    expect(isSpriteArt("drawn")).toBe(false);
    expect(isSpriteArt("dark")).toBe(true);
    expect(CharacterPrefsSchema.parse({}).art).toBe("dark");
    expect(CharacterPrefsSchema.parse({ art: "pink" }).art).toBe("dark"); // saved before the pink avatar was removed
  });

  it("the head crop is used above the pill and the full figure in Settings", () => {
    for (const art of AVATAR_ARTS) {
      const compact = avatarSprite(art as SpriteArt, "idle", "compact")!;
      const expanded = avatarSprite(art as SpriteArt, "idle", "expanded")!;
      expect(compact).toContain("/head/");
      expect(expanded).toContain("/full/");
    }
  });
});

import { POSES, RIGS } from "./avatarRig";
import { DEFAULT_VOICES } from "./config";
import { expressionFor } from "./expression";
import { initialBar } from "../state/dictationState";

const REQUIRED = ["idle", "happy", "excited", "listening", "thinking", "speaking", "confused", "surprised", "sad", "angry", "worried", "apologetic", "error", "sleepy"] as const;

describe("the animated avatars", () => {
  it("all fourteen required states exist for the avatars", () => {
    for (const e of REQUIRED) expect(EXPRESSIONS).toContain(e);
  });
  it("no two required states look the same: each differs by its drawn face, its pose or its symbol", () => {
    for (const art of AVATAR_ARTS) {
      const sig = (e: (typeof REQUIRED)[number]) => { const p = POSES[e]; return JSON.stringify([AVATARS[art].faces[e], p.glyph, p.roll, p.dy, p.scale, p.shake, p.bounce, p.eyesHeld]); };
      const seen = new Map<string, string>();
      for (const e of REQUIRED) { const s = sig(e); expect(seen.get(s), `${art}: ${e} looks like ${seen.get(s)}`).toBeUndefined(); seen.set(s, e); }
    }
  });
  it("blinking and lip-sync use the artist's own faces, which really exist", () => {
    for (const art of AVATAR_ARTS) {
      const rig = RIGS[art];
      for (const c of [rig.blink, rig.mouthWide, rig.mouthRound]) expect(fs.existsSync(path.join(root, "assets/avatars", art, "head", `${c}.png`)), `${art}/${c}`).toBe(true);
    }
  });
  it("each avatar has its own voice, independent of the look", () => {
    expect(DEFAULT_VOICES.bob).not.toEqual(DEFAULT_VOICES.dark);
    expect(defaultCharacter.voices).toEqual(DEFAULT_VOICES);
    const c = CharacterPrefsSchema.parse({ art: "dark", voices: { bob: { voiceURI: "X", rate: 1.2, pitch: 1.3 } } });
    expect(c.voices.bob.voiceURI).toBe("X");
    expect(c.voices.dark).toEqual(DEFAULT_VOICES.dark); // choosing another avatar's voice does not touch this one
  });
  it("Momo gets sleepy only when idle for a while", () => {
    expect(expressionFor(initialBar, false, "friendly", true)).toBe("sleepy");
    expect(expressionFor(initialBar, true, "friendly", true)).toBe("speaking");
  });
});

import { DRAW } from "./avatarRig";
import { BLINK_MS, lidClosure } from "./animation";

describe("the drawn face (eyelids and mouth) follows the reference animation", () => {
  it("a blink lasts about 300 ms: eases shut, holds, eases open, and is never closed outside it", () => {
    expect(BLINK_MS).toBe(300);
    expect(lidClosure(-5)).toBe(0);
    expect(lidClosure(0)).toBe(0);
    expect(lidClosure(50)).toBeGreaterThan(0);
    expect(lidClosure(50)).toBeLessThan(1);
    expect(lidClosure(150)).toBe(1);
    expect(lidClosure(250)).toBeGreaterThan(0);
    expect(lidClosure(250)).toBeLessThan(1);
    expect(lidClosure(300)).toBe(0);
    for (let t = 0; t < 300; t += 7) expect(Math.abs(lidClosure(t + 7) - lidClosure(t))).toBeLessThan(0.3); // smooth, no snapping
  });
  it("the dark avatar's lenses and mouth lie inside its resting-face pictures, with skin tones for each lens", () => {
    for (const view of ["compact", "expanded"] as const) {
      const d = DRAW.dark![view];
      expect(d.restCell).toBe("r1c1");
      for (const e of d.eyes) {
        expect(e.cx - e.rx).toBeGreaterThan(0); expect(e.cx + e.rx).toBeLessThan(d.w);
        expect(e.cy - e.ry).toBeGreaterThan(0); expect(e.cy + e.ry).toBeLessThan(d.h);
        expect(e.top).toMatch(/^rgb\(/); expect(e.bottom).toMatch(/^rgb\(/);
      }
      expect(d.mouth.cx).toBeGreaterThan(d.eyes[0].cx); expect(d.mouth.cx).toBeLessThan(d.eyes[1].cx + 10);
      expect(d.mouth.cy).toBeGreaterThan(d.eyes[0].cy + d.eyes[0].ry);
      expect(d.mouth.cy).toBeLessThan(d.h);
    }
  });
});


import sharp from "sharp";
describe("the video-cut avatar (bob) is rigged like the others", () => {
  it("has a rig, a drawn-face calibration for both views, and a voice of its own", () => {
    expect(RIGS.bob).toBeTruthy();
    expect(DRAW.bob?.compact.restCell).toBe("r1c1");
    expect(DRAW.bob?.expanded.restCell).toBe("r1c1");
    expect(defaultCharacter.voices.bob).toBeTruthy();
    expect(CharacterPrefsSchema.parse({ art: "bob" }).art).toBe("bob");
    // saved preferences from before this avatar existed (no voice entry for it) still load, and nothing else changes
    expect(CharacterPrefsSchema.parse({ art: "dark", voices: { drawn: {}, dark: {} } }).voices.bob).toEqual(defaultCharacter.voices.bob);
    expect(defaultCharacter.art).toBe("dark");
  });
  it("every drawn-face coordinate lies inside the sprite it was measured on", async () => {
    for (const art of ["bob", "dark"] as const) {
      for (const view of ["compact", "expanded"] as const) {
        const d = DRAW[art]![view];
        const file = path.join(root, "assets/avatars", art, view === "compact" ? "head" : "full", `${d.restCell}.png`);
        const meta = await sharp(file).metadata();
        expect([meta.width, meta.height], `${art}/${view} size`).toEqual([d.w, d.h]);
        for (const e of d.eyes) { expect(e.cx - e.rx).toBeGreaterThan(0); expect(e.cx + e.rx).toBeLessThan(d.w); expect(e.cy - e.ry).toBeGreaterThan(0); expect(e.cy + e.ry).toBeLessThan(d.h); }
        expect(d.mouth.cx + d.mouth.w).toBeLessThan(d.w); expect(d.mouth.cy).toBeLessThan(d.h);
      }
    }
  });
});

import { DRAW_CELLS } from "./avatarRig";
import { driveDraw } from "./drawFace";
import { SURPRISE_HOLD_S, SURPRISE_RELAX_S, SURPRISE_SETTLE_MS, surpriseLevel } from "./AvatarView";
describe("the surprised sequence (measured on video 5) and the drawn mouth", () => {
  it("holds, relaxes smoothly, and is over before the face settles back to normal", () => {
    expect(surpriseLevel(0)).toBe(1);
    expect(surpriseLevel(SURPRISE_HOLD_S)).toBe(1);
    expect(surpriseLevel(SURPRISE_HOLD_S + SURPRISE_RELAX_S)).toBe(0);
    const mid = surpriseLevel(SURPRISE_HOLD_S + SURPRISE_RELAX_S / 2);
    expect(mid).toBeGreaterThan(0.3); expect(mid).toBeLessThan(0.7);
    let prev = 1; for (let t = SURPRISE_HOLD_S; t < SURPRISE_HOLD_S + SURPRISE_RELAX_S; t += 0.05) { const v = surpriseLevel(t); expect(v).toBeLessThanOrEqual(prev + 1e-9); prev = v; }
    expect(SURPRISE_SETTLE_MS / 1000).toBeGreaterThan(SURPRISE_HOLD_S + SURPRISE_RELAX_S);
  });
  it("the boy's surprised pose is the video one (with glasses) and carries its own sweat drops", () => {
    expect(AVATARS.dark.faces.surprised).toBe("s1");
    expect(AVATARS.dark.glyphs?.surprised).toBe("");
    for (const v of ["compact", "expanded"] as const) expect(DRAW_CELLS.dark!.s1![v].native).toBeTruthy();
  });
  it("his own round mouth is left alone while surprised and silent, and covered once he speaks or relaxes", () => {
    const rec = () => { const m: Record<string, Record<string, string>> = {}; return { m, sv: (k: string, a: string, v: string | number) => { (m[k] ??= {})[a] = String(v); } }; };
    const d = DRAW_CELLS.dark!.s1!.compact;
    const a = rec(); driveDraw(a.sv, d, { closed: 0, open: 0, round: 0, wide: 1, speaking: false, surprise: 1 });
    expect(a.m.mpatch.opacity).toBe("0.000"); expect(a.m.mline.opacity).toBe("0");
    const b = rec(); driveDraw(b.sv, d, { closed: 0, open: 0, round: 0, wide: 1, speaking: false, surprise: 0 });
    expect(b.m.mpatch.opacity).toBe("1.000"); expect(b.m.mline.opacity).toBe("1");
    const c = rec(); driveDraw(c.sv, d, { closed: 0, open: 0.5, round: 0, wide: 1, speaking: true, surprise: 1 });
    expect(c.m.mpatch.opacity).toBe("1.000"); expect(c.m.mopen.opacity).toBe("1");
  });
  it("the girl's smile-shaped mouth: a smile line at rest, an opening with teeth when parted, never NaN", () => {
    const rec = () => { const m: Record<string, Record<string, string>> = {}; return { m, sv: (k: string, a: string, v: string | number) => { (m[k] ??= {})[a] = String(v); } }; };
    const d = DRAW.bob!.compact;
    const rest = rec(); driveDraw(rest.sv, d, { closed: 0, open: 0, round: 0, wide: 1, speaking: false, surprise: 0 });
    expect(rest.m.mline.opacity).toBe("1"); expect(rest.m.mopen.opacity).toBe("0");
    for (const open of [0.1, 0.4, 1]) {
      const x = rec(); driveDraw(x.sv, d, { closed: 0, open, round: 0.3, wide: 0.6, speaking: true, surprise: 0 });
      expect(x.m.mopen.d, String(open)).not.toMatch(/NaN/); expect(x.m.mteeth.d).not.toMatch(/NaN/);
      expect(x.m.mopen.opacity).toBe("1"); expect(x.m.mline.opacity).toBe("0");
    }
    const wide = rec(); driveDraw(wide.sv, d, { closed: 0, open: 1, round: 0, wide: 1, speaking: true, surprise: 0 });
    expect(wide.m.mtongue.opacity).not.toBe("0.00");
  });
  it("every drawn pose lies inside its sprite", async () => {
    for (const [art, cells] of Object.entries(DRAW_CELLS)) {
      for (const [cell, views] of Object.entries(cells!)) {
        for (const view of ["compact", "expanded"] as const) {
          const d = views![view];
          const meta = await sharp(path.join(root, "assets/avatars", art, view === "compact" ? "head" : "full", cell + ".png")).metadata();
          expect([meta.width, meta.height], art + "/" + cell + "/" + view).toEqual([d.w, d.h]);
          for (const e of d.eyes) { expect(e.cx - e.rx).toBeGreaterThan(0); expect(e.cx + e.rx).toBeLessThan(d.w); }
          expect(d.mouth.cy).toBeLessThan(d.h);
        }
      }
    }
  });
});

import { fitFigure } from "./AvatarView";
describe("a tilted figure stays inside its box", () => {
  it("is untouched when level, and shrunk and lifted just enough when tilted", () => {
    expect(fitFigure(240, 340, 300, 340, 0, 1, 1)).toEqual({ k: 1, lift: 0 });
    const t = fitFigure(240, 340, 300, 340, 5, 1, 1);
    expect(t.k).toBeLessThan(1); expect(t.k).toBeGreaterThan(0.9);
    // after the fit, the tilted bounding height equals the box height
    const th = (5 * Math.PI) / 180;
    expect(340 * t.k * Math.cos(th) + 240 * t.k * Math.sin(th)).toBeCloseTo(340, 5);
    expect(t.lift).toBeCloseTo((240 * t.k * Math.sin(th)) / 2, 5);
    expect(fitFigure(0, 340, 300, 340, 5, 1, 1)).toEqual({ k: 1, lift: 0 }); // not measured yet
  });
});

import { VOICE_HINTS } from "./config";
describe("each avatar has a voice of its own by default", () => {
  it("the hints differ for every avatar", () => {
    expect(Object.keys(VOICE_HINTS).sort()).toEqual([...ART_CHOICES].sort());
    expect(VOICE_HINTS.dark.prefer).toContain("David");
    expect(VOICE_HINTS.bob.prefer).toContain("Zira");
    expect(VOICE_HINTS.dark.slot).not.toBe(VOICE_HINTS.bob.slot);
  });
});

import { CLOUD_VOICE_IDS } from "./config";
describe("online voice ids", () => {
  it("one id per sprite avatar, all different, in the shape the service uses", () => {
    expect(Object.keys(CLOUD_VOICE_IDS).sort()).toEqual(["bob", "dark"]);
    expect(new Set(Object.values(CLOUD_VOICE_IDS)).size).toBe(2);
    for (const id of Object.values(CLOUD_VOICE_IDS)) expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
  });
});
