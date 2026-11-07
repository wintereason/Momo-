// Generates PLACEHOLDER 3D characters (assets/models/<id>.placeholder.glb) so the .glb pipeline can be built and
// tested before real models exist. They are deliberately crude: a round head, body and hair cap in each
// character's colours, with real animation clips (one per Momo state) and real face morph targets.
// Replace them by dropping a real assets/models/<id>.glb next to them: the real model is used when present.
import { Document, NodeIO } from "@gltf-transform/core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "assets", "models");
fs.mkdirSync(outDir, { recursive: true });

// colours: skin, hair, outfit
const LOOKS = {
  gojo:   { skin: "#ffd9c7", hair: "#e9e4f5", outfit: "#26232e" },
  nezuko: { skin: "#ffdcc9", hair: "#4a2c27", outfit: "#e9a3b8" },
  megumi: { skin: "#f6d3bf", hair: "#1b1b24", outfit: "#2a2a36" },
  klee:   { skin: "#ffe0cf", hair: "#e8c58a", outfit: "#f2e7c9" },
  mochi:  { skin: "#ffe0d2", hair: "#f58fc1", outfit: "#f9c9e2" },
};
const rgb = (hex) => [1, 3, 5].map((i) => Math.pow(parseInt(hex.slice(i, i + 2), 16) / 255, 2.2)).concat(1);

function uvSphere(rx, ry, rz, lat = 14, lon = 22, cutTop = false) {
  const pos = [], nrm = [], idx = [];
  const latMax = cutTop ? Math.PI * 0.5 : Math.PI; // a hair cap is the top half only
  for (let i = 0; i <= lat; i++) {
    const th = (i / lat) * latMax;
    for (let j = 0; j <= lon; j++) {
      const ph = (j / lon) * Math.PI * 2;
      const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
      pos.push(x * rx, y * ry, z * rz);
      const n = [x / rx, y / ry, z / rz], l = Math.hypot(...n) || 1;
      nrm.push(n[0] / l, n[1] / l, n[2] / l);
    }
  }
  for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
    const a = i * (lon + 1) + j, b = a + lon + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
}

const quatZ = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
const quatX = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];

function build(id) {
  const look = LOOKS[id];
  const doc = new Document();
  const buf = doc.createBuffer();
  const mat = (name, hex, rough = 0.7) => doc.createMaterial(name).setBaseColorFactor(rgb(hex)).setRoughnessFactor(rough).setMetallicFactor(0);
  const skin = mat("Skin", look.skin, 0.6), hair = mat("Hair", look.hair, 0.5), outfit = mat("Outfit", look.outfit, 0.8), dark = mat("Eye", "#1c1c28", 0.3), blush = mat("Blush", "#ff9bb0", 0.9);

  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buf);
  const prim = (g, m) => doc.createPrimitive()
    .setAttribute("POSITION", accessor("VEC3", g.pos)).setAttribute("NORMAL", accessor("VEC3", g.nrm))
    .setIndices(accessor("SCALAR", g.idx)).setMaterial(m);
  const meshNode = (name, g, m, t) => doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim(g, m))).setTranslation(t);

  // ----- character (about 1.0 tall, feet at y = 0, big head like the chibi references)
  const root = doc.createNode("Character");
  const body = meshNode("Body", uvSphere(0.2, 0.24, 0.17), outfit, [0, 0.26, 0]);
  const headNode = doc.createNode("Head").setTranslation([0, 0.72, 0]);

  // head with face morph targets (the same names the sprite manifest uses)
  const headGeo = uvSphere(0.3, 0.27, 0.28);
  const headPrim = prim(headGeo, skin);
  const delta = (fn) => {
    const d = new Float32Array(headGeo.pos.length);
    for (let i = 0; i < headGeo.pos.length; i += 3) {
      const r = fn(headGeo.pos[i], headGeo.pos[i + 1], headGeo.pos[i + 2]);
      d[i] = r[0]; d[i + 1] = r[1]; d[i + 2] = r[2];
    }
    return accessor("VEC3", d);
  };
  const targets = {
    happy:     (x, y, z) => [x * 0.06, y * 0.02, 0],
    excited:   (x, y, z) => [x * 0.10, y * 0.05, 0],
    thinking:  (x, y, z) => [0, y * 0.0, z * 0.04],
    sorry:     (x, y, z) => [x * 0.0, -Math.abs(y) * 0.10, 0],
    sleepy:    (x, y, z) => [0, -Math.abs(y) * 0.14, 0],
    surprised: (x, y, z) => [0, y * 0.10, z * 0.04],
    confused:  (x, y, z) => [Math.sign(x) * 0.0 + x * 0.02, y * 0.03, 0],
    angry:     (x, y, z) => [0, -Math.abs(y) * 0.05, 0],
  };
  const names = Object.keys(targets);
  for (const n of names) headPrim.addTarget(doc.createPrimitiveTarget(n).setAttribute("POSITION", delta(targets[n])));
  const headMesh = doc.createMesh("HeadMesh").addPrimitive(headPrim).setWeights(names.map(() => 0));
  headMesh.setExtras({ targetNames: names }); // three.js reads these as the morph target dictionary
  headNode.setMesh(headMesh);

  const hairNode = meshNode("Hair", uvSphere(0.33, 0.3, 0.31, 12, 22, true), hair, [0, 0.02, -0.01]);
  const eyeL = meshNode("EyeL", uvSphere(0.034, 0.04, 0.02, 8, 10), dark, [-0.1, -0.01, 0.265]);
  const eyeR = meshNode("EyeR", uvSphere(0.034, 0.04, 0.02, 8, 10), dark, [0.1, -0.01, 0.265]);
  const cheekL = meshNode("CheekL", uvSphere(0.05, 0.03, 0.015, 8, 10), blush, [-0.17, -0.08, 0.235]);
  const cheekR = meshNode("CheekR", uvSphere(0.05, 0.03, 0.015, 8, 10), blush, [0.17, -0.08, 0.235]);
  headNode.addChild(hairNode).addChild(eyeL).addChild(eyeR).addChild(cheekL).addChild(cheekR);
  root.addChild(body).addChild(headNode);
  doc.createScene("Scene").addChild(root);

  // ----- animation clips: one per Momo state (names match src/scene/modelMap.ts)
  const clip = (name, dur, channels) => {
    const a = doc.createAnimation(name);
    for (const [node, path, times, values] of channels) {
      const s = doc.createAnimationSampler().setInput(accessor("SCALAR", new Float32Array(times)))
        .setOutput(accessor(path === "rotation" ? "VEC4" : "VEC3", new Float32Array(values.flat()))).setInterpolation("LINEAR");
      a.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(s));
    }
    return a;
  };
  const T = [0, 0.5, 1, 1.5, 2]; // loop of 2 s
  const breathe = (amp) => [[1, 1, 1], [1 + amp * 0.5, 1 + amp, 1 + amp * 0.5], [1, 1, 1], [1 + amp * 0.5, 1 + amp, 1 + amp * 0.5], [1, 1, 1]];
  const rotZ = (...a) => a.map(quatZ), rotX = (...a) => a.map(quatX);
  const head0 = [0, 0.72, 0];
  clip("idle", 2, [[root, "scale", T, breathe(0.02)]]);
  clip("listening", 2, [[headNode, "rotation", T, rotZ(0, -0.08, 0, -0.08, 0)], [root, "scale", T, breathe(0.03)]]);
  clip("transcribing", 2, [[headNode, "rotation", T, rotZ(0, 0.04, 0, -0.04, 0)]]);
  clip("thinking", 2, [[headNode, "rotation", T, rotZ(-0.1, 0, 0.1, 0, -0.1)]]);
  clip("asking", 2, [[headNode, "rotation", T, rotZ(0.18, 0.2, 0.18, 0.2, 0.18)]]);
  clip("working", 1, [[headNode, "rotation", [0, 0.25, 0.5, 0.75, 1], rotX(0.06, 0.1, 0.06, 0.1, 0.06)]]);
  clip("success", 1.5, [[root, "translation", [0, 0.25, 0.5, 0.75, 1, 1.5], [[0, 0, 0], [0, 0.16, 0], [0, 0, 0], [0, 0.1, 0], [0, 0, 0], [0, 0, 0]]]]);
  clip("partial_success", 2, [[headNode, "rotation", T, rotZ(0.04, 0.06, 0.04, 0.06, 0.04)]]);
  clip("sorry", 2, [[headNode, "rotation", T, rotX(0.25, 0.28, 0.25, 0.28, 0.25)], [headNode, "translation", T, [head0, [0, 0.7, 0], head0, [0, 0.7, 0], head0]]]);
  clip("blocked", 2, [[headNode, "rotation", [0, 2], rotZ(0, 0)]]);
  clip("error", 1, [[root, "translation", [0, 0.1, 0.2, 0.3, 1], [[0, 0, 0], [0.02, 0, 0], [-0.02, 0, 0], [0.02, 0, 0], [0, 0, 0]]]]);
  clip("sleeping", 3, [[headNode, "rotation", [0, 1.5, 3], rotX(0.45, 0.5, 0.45)], [root, "scale", [0, 1.5, 3], [[1, 0.97, 1], [1, 1, 1], [1, 0.97, 1]]]]);
  clip("disabled", 2, [[root, "scale", [0, 2], [[1, 1, 1], [1, 1, 1]]]]);
  return doc;
}

const io = new NodeIO();
for (const id of Object.keys(LOOKS)) {
  const file = path.join(outDir, `${id}.placeholder.glb`);
  const bytes = await io.writeBinary(build(id));
  fs.writeFileSync(file, bytes);
  console.log(`${id}.placeholder.glb  ${(bytes.length / 1024).toFixed(0)} KB`);
}
