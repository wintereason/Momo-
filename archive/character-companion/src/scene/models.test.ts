import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Box3 } from "three";
import { UI_STATES } from "../types/runtime-events";
import { parseGlb } from "./modelLoader";
import { coverage, resolveClip, resolveMorph } from "./modelMap";

const dir = path.resolve(__dirname, "../../assets/models");
const IDS = ["gojo", "nezuko", "megumi", "klee", "mochi"];
const load = (id: string) => {
  const b = fs.readFileSync(path.join(dir, `${id}.placeholder.glb`));
  return parseGlb(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};

describe("the .glb pipeline, using the placeholder characters", () => {
  it.each(IDS)("%s: loads with its animation clips and face morph targets", async (id) => {
    const m = await load(id);
    expect(m.clipNames.length).toBeGreaterThanOrEqual(13);
    expect(m.morphNames).toEqual(expect.arrayContaining(["happy", "sorry", "sleepy", "thinking", "surprised"]));
    expect(m.morphMeshes.length).toBeGreaterThan(0);
    // every morph mesh has one influence per target, all neutral
    for (const mesh of m.morphMeshes) {
      expect(mesh.morphTargetInfluences!.length).toBe(Object.keys(mesh.morphTargetDictionary!).length);
      expect(mesh.morphTargetInfluences!.every((v) => v === 0)).toBe(true);
    }
  });

  it.each(IDS)("%s: every one of the 13 states resolves to a real clip", async (id) => {
    const m = await load(id);
    for (const s of UI_STATES) expect(resolveClip(s, m.clipNames), `${id}/${s}`).not.toBeNull();
    const cov = coverage({ clips: m.clipNames, morphs: m.morphNames });
    expect(Object.values(cov).every((v) => v === "clip")).toBe(true);
    // the state-specific clips are used where they exist (not just idle)
    expect(resolveClip("success", m.clipNames)).toBe("success");
    expect(resolveClip("sorry", m.clipNames)).toBe("sorry");
    expect(resolveClip("sleeping", m.clipNames)).toBe("sleeping");
  });

  it.each(IDS)("%s: face morphs follow the same expression names as the 2D sprites", async (id) => {
    const m = await load(id);
    expect(resolveMorph("sorry", m.morphNames)).toBe("sorry");
    expect(resolveMorph("sleeping", m.morphNames)).toBe("sleepy");
    expect(resolveMorph("success", m.morphNames)).toBe("excited");
    expect(resolveMorph("asking", m.morphNames)).toBe("confused");
    expect(resolveMorph("error", m.morphNames)).toBe("angry");
  });

  it("every character is normalised to the same size and seated on the same level", async () => {
    for (const id of IDS) {
      const m = await load(id);
      expect(m.height).toBeGreaterThan(0.5);
      expect(m.height * m.scale).toBeCloseTo(1, 5); // 1 unit tall, whatever the source units
      // apply exactly what the scene applies, then measure: feet on the table (y = 0), 1 unit tall
      m.root.scale.setScalar(m.scale);
      m.root.position.y = m.offsetY;
      m.root.updateMatrixWorld(true);
      const box = new Box3().setFromObject(m.root);
      expect(box.min.y).toBeCloseTo(0, 4);
      expect(box.max.y - box.min.y).toBeCloseTo(1, 4);
    }
  });

  it("is light enough for an integrated GPU", async () => {
    for (const id of IDS) {
      const size = fs.statSync(path.join(dir, `${id}.placeholder.glb`)).size;
      expect(size).toBeLessThan(2 * 1024 * 1024);
      const m = await load(id);
      let tris = 0;
      m.root.traverse((o) => {
        const mesh = o as import("three").Mesh;
        if (mesh.isMesh) tris += (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;
      });
      expect(tris).toBeLessThan(5000);
    }
  });

  it("rejects garbage with a plain message instead of crashing", async () => {
    await expect(parseGlb(new Uint8Array([1, 2, 3, 4]).buffer)).rejects.toThrow(/could not be read/);
  });
});
