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
      for (const e of EXPRESSIONS) expect(AVATARS[art].faces[e], `${art}/${e}`).toMatch(/^r[12]c[1-3]$/);
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

  it("each sheet contributes exactly the twelve sprites (six faces x two crops)", () => {
    for (const art of AVATAR_ARTS) {
      expect(avatarFiles(art), art).toHaveLength(12);
      expect(avatarFiles(art).filter((k) => k.startsWith("head/"))).toHaveLength(6);
      expect(avatarFiles(art).filter((k) => k.startsWith("full/"))).toHaveLength(6);
    }
  });

  it("the setting offers the drawn character and both sheets, and defaults to the supplied avatar", () => {
    expect([...ART_CHOICES]).toEqual(["drawn", "pink", "dark"]);
    expect(defaultCharacter.art).toBe("pink");
    expect(isSpriteArt("drawn")).toBe(false);
    expect(isSpriteArt("pink")).toBe(true);
    expect(CharacterPrefsSchema.parse({}).art).toBe("pink");
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
