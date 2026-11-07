import { Box3, Vector3, type AnimationClip, type Mesh, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fitScale, seatedOffset } from "./modelMap";

export interface LoadedModel {
  root: Object3D;
  clips: AnimationClip[];
  clipNames: string[];
  /** union of the face morph target names found on the model's meshes */
  morphNames: string[];
  morphMeshes: Mesh[];
  /** uniform scale that makes the model 1 unit tall */
  scale: number;
  /** vertical offset (after scaling) that puts its lowest point at y = 0 */
  offsetY: number;
  /** the model's own height before scaling */
  height: number;
}

/** Parse a .glb already in memory (no network, no disk). Rejects with a plain message on bad data. */
export function parseGlb(data: ArrayBuffer): Promise<LoadedModel> {
  return new Promise((resolve, reject) => {
    const bad = () => reject(new Error("That model file could not be read."));
    try {
      new GLTFLoader().parse(
      data,
      "",
      (gltf) => {
        const root = gltf.scene;
        const box = new Box3().setFromObject(root);
        const size = box.getSize(new Vector3());
        const morphMeshes: Mesh[] = [];
        const morphNames = new Set<string>();
        root.traverse((o) => {
          const m = o as Mesh;
          if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) {
            morphMeshes.push(m);
            for (const n of Object.keys(m.morphTargetDictionary)) morphNames.add(n);
          }
        });
        const scale = fitScale(size.y, 1);
        resolve({
          root, clips: gltf.animations, clipNames: gltf.animations.map((c) => c.name),
          morphNames: [...morphNames], morphMeshes, scale, offsetY: seatedOffset(box.min.y, scale), height: size.y,
        });
      },
      bad,
      );
    } catch {
      bad(); // the loader throws synchronously on data that isn't a glTF at all
    }
  });
}

/** Release GPU and CPU memory held by a model. */
export function disposeModel(m: LoadedModel): void {
  m.root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) mat?.dispose();
  });
}
