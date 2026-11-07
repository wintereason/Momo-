import * as THREE from "three";
import { manifest, resolveExpression } from "../companion/expression";
import { availableExpressions, spriteUrl } from "../companion/sprites";
import type { CompanionUiState } from "../types/runtime-events";
import { effectMotion, effectsFor, type EffectKind } from "./effects";
import { ONE_SHOT, resolveClip, resolveMorph } from "./modelMap";
import { disposeModel, parseGlb, type LoadedModel } from "./modelLoader";
import { modelFor } from "./modelUrls";
import { AdaptiveQuality, FrameBudget, targetFps } from "./perf";
import { createPetals, stepPetals, type Bounds, type Petal } from "./petals";
import { poseFor } from "./pose";
import { effectTexture, petalTexture, placeholderCharacterTexture, skyTexture, softCircleTexture, woodTexture } from "./textures";

export const SCENE_W = 340;
export const SCENE_H = 270;
const MODEL_HEIGHT = 1.25; // a 3D model is shown this tall (the 2D card is 1.5)
const PETAL_COUNT = 30;
const BOUNDS: Bounds = { xMin: -1.8, xMax: 1.8, yMin: -0.1, yMax: 2.1, zMin: -0.9, zMax: 1.1 };

export interface EngineOptions {
  /** called once if rendering is too slow or the GPU context was lost: switch to the light 2D view */
  onSlow(reason: "slow" | "context-lost"): void;
  onModel?(info: { using: boolean; placeholder: boolean }): void;
}

export interface EngineStats { frames: number; avgWorkMs: number; avgIntervalMs: number; usingModel: boolean; tier: string }

/** The 3D scene. Plain class (no React) so lifecycle and memory are explicit. */
export class SceneEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private pivot = new THREE.Group(); // feet of the character
  private card: THREE.Mesh; // 2D art billboard
  private cardMat: THREE.MeshBasicMaterial;
  private modelGroup: THREE.Group | null = null;
  private model: LoadedModel | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private petals: Petal[];
  private petalMesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private effects = new Map<EffectKind, THREE.Sprite>();
  private effectTex = new Map<EffectKind, THREE.CanvasTexture>();
  private spriteTex = new Map<string, THREE.Texture>();
  private placeholderTex: THREE.Texture | null = null;
  private bokeh: { s: THREE.Sprite; baseX: number; depth: number }[] = [];
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private disposables: { dispose(): void }[] = [];

  private characterId = "";
  private view: "2d" | "3d" = "2d";
  private state: CompanionUiState = "idle";
  private reduceMotion = false;
  private stateStart = 0;
  private clock = 0;
  private lastDraw = 0;
  private lastPointerMove = -1e9;
  private pointer = { x: 0, y: 0 };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private disposed = false;
  private budget = new FrameBudget();
  private adaptive = new AdaptiveQuality();
  private stat = { frames: 0, work: 0, interval: 0 };
  private loadToken = 0;

  constructor(container: HTMLElement, private opts: EngineOptions) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); // sharp enough, cheap on integrated GPUs
    this.renderer.setSize(SCENE_W, SCENE_H);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const el = this.renderer.domElement;
    el.style.display = "block";
    el.style.width = `${SCENE_W}px`;
    el.style.height = `${SCENE_H}px`;
    el.setAttribute("aria-hidden", "true");
    el.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.opts.onSlow("context-lost"); });
    container.appendChild(el);

    this.camera = new THREE.PerspectiveCamera(26, SCENE_W / SCENE_H, 0.1, 40);
    this.camera.position.set(0, 1.0, 5.4);
    this.camera.lookAt(0, 0.62, 0);

    // light: warm sun from the upper left over a pink sky, like the reference
    this.hemi = new THREE.HemisphereLight(0xfff0f6, 0xd9a888, 1.9);
    this.sun = new THREE.DirectionalLight(0xffe4c8, 2.3);
    this.sun.position.set(-2.5, 3.5, 3);
    this.scene.add(this.hemi, this.sun);

    this.buildBackdrop();
    this.buildTable();
    this.buildProps();

    // character: a billboard for the 2D art; a 3D model is swapped in when available
    this.cardMat = new THREE.MeshBasicMaterial({ transparent: true, color: 0xfff7f2, alphaTest: 0.01 });
    this.card = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), this.cardMat);
    this.card.position.y = 0.67; // the lower edge sinks into the tabletop so the character sits ON the table
    this.pivot.position.set(0, 0, 0.08);
    this.pivot.add(this.card);
    this.scene.add(this.pivot);
    this.disposables.push(this.card.geometry, this.cardMat);

    // petals in front of and behind the character
    this.petals = createPetals(PETAL_COUNT, BOUNDS, 7);
    const pt = petalTexture();
    const pm = new THREE.MeshBasicMaterial({ map: pt, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const pg = new THREE.PlaneGeometry(1, 1);
    this.petalMesh = new THREE.InstancedMesh(pg, pm, PETAL_COUNT);
    this.petalMesh.renderOrder = 10;
    this.petalMesh.frustumCulled = false;
    this.scene.add(this.petalMesh);
    this.disposables.push(pt, pm, pg);

    this.stateStart = 0;
    this.kick();
  }

  // ------------------------------------------------------------------ building the set

  private track<T extends { dispose(): void }>(o: T): T { this.disposables.push(o); return o; }

  private buildBackdrop() {
    const skyT = this.track(skyTexture());
    const sky = new THREE.Mesh(this.track(new THREE.PlaneGeometry(8, 5.4)), this.track(new THREE.MeshBasicMaterial({ map: skyT, transparent: true, depthWrite: false })));
    sky.position.set(0, 1.0, -2.6);
    this.scene.add(sky);
    const colors = ["rgba(255,196,226,0.55)", "rgba(255,224,190,0.5)", "rgba(226,200,255,0.5)", "rgba(255,170,205,0.45)"];
    for (let i = 0; i < 8; i++) {
      const t = this.track(softCircleTexture(colors[i % colors.length]));
      const s = new THREE.Sprite(this.track(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false })));
      const depth = 0.4 + (i % 4) * 0.2;
      const x = -1.9 + ((i * 0.61) % 3.8);
      s.position.set(x, 0.5 + ((i * 0.37) % 1.4), -2 + depth * -0.4);
      s.scale.setScalar(0.35 + (i % 3) * 0.22);
      this.bokeh.push({ s, baseX: x, depth });
      this.scene.add(s);
    }
  }

  private buildTable() {
    const wood = this.track(woodTexture());
    const top = new THREE.Mesh(this.track(new THREE.BoxGeometry(2.9, 0.14, 1.35)), this.track(new THREE.MeshStandardMaterial({ map: wood, roughness: 0.5, metalness: 0 })));
    top.position.set(0, -0.07, 0);
    this.scene.add(top);
    const legMat = this.track(new THREE.MeshStandardMaterial({ color: 0x8a5230, roughness: 0.7 }));
    const legGeo = this.track(new THREE.BoxGeometry(0.14, 0.9, 0.14));
    for (const [x, z] of [[-1.3, 0.55], [1.3, 0.55], [-1.3, -0.55], [1.3, -0.55]]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(x, -0.6, z);
      this.scene.add(leg);
    }
    // soft contact shadow under the character
    const sh = this.track(softCircleTexture("rgba(70,25,50,0.5)"));
    const shadow = new THREE.Mesh(this.track(new THREE.PlaneGeometry(1.25, 0.55)), this.track(new THREE.MeshBasicMaterial({ map: sh, transparent: true, depthWrite: false })));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, 0.004, 0.08);
    this.scene.add(shadow);
  }

  private buildProps() {
    const std = (color: number, rough = 0.85, glow = 0) => this.track(new THREE.MeshStandardMaterial({ color, roughness: rough, emissive: color, emissiveIntensity: glow }));
    // bonsai blossom tree (back right)
    const pot = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.13, 0.1, 0.15, 18)), std(0xc4704a));
    pot.position.set(1.1, 0.075, -0.3);
    const trunk = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.018, 0.034, 0.36, 8)), std(0x6b4630));
    trunk.position.set(1.1, 0.33, -0.3);
    trunk.rotation.z = 0.15;
    this.scene.add(pot, trunk);
    const blossom = [0xffb8d2, 0xffc9dc, 0xff9fc3, 0xffd6e6, 0xffb0cd];
    const spots: [number, number, number, number][] = [[1.1, 0.58, -0.3, 0.17], [0.98, 0.5, -0.27, 0.12], [1.22, 0.52, -0.33, 0.13], [1.12, 0.7, -0.28, 0.1], [1.04, 0.64, -0.36, 0.1]];
    spots.forEach(([x, y, z, r], i) => {
      const b = new THREE.Mesh(this.track(new THREE.IcosahedronGeometry(r, 1)), std(blossom[i % blossom.length], 0.95, 0.42));
      b.position.set(x, y, z);
      this.scene.add(b);
    });
    // mug (front left)
    const mug = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.1, 0.09, 0.15, 22)), std(0xfff1ee, 0.35));
    mug.position.set(-1.1, 0.075, 0.3);
    const handle = new THREE.Mesh(this.track(new THREE.TorusGeometry(0.05, 0.014, 8, 16)), std(0xfff1ee, 0.35));
    handle.position.set(-1.0, 0.08, 0.3);
    this.scene.add(mug, handle);
    // books (back left)
    const books: [number, number, number, number][] = [[0xb86aa0, 0.34, 0.06, 0.05], [0x6a8fd1, 0.3, 0.05, -0.04], [0xe6b552, 0.28, 0.05, 0.02]];
    let y = 0;
    for (const [color, w, h, rot] of books) {
      const bk = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, h, 0.22)), std(color, 0.8));
      bk.position.set(-1.1, y + h / 2, -0.35);
      bk.rotation.y = rot;
      this.scene.add(bk);
      y += h;
    }
  }

  // ------------------------------------------------------------------ public controls

  setReduceMotion(v: boolean): void { this.reduceMotion = v; this.kick(); }

  setPointer(nx: number, ny: number): void {
    this.pointer.x = Math.max(-1, Math.min(1, nx));
    this.pointer.y = Math.max(-1, Math.min(1, ny));
    this.lastPointerMove = performance.now();
    this.kick();
  }

  setState(state: CompanionUiState): void {
    if (state === this.state && this.stateStart > 0) return;
    this.state = state;
    this.stateStart = this.clock;
    this.applyExpression();
    this.applyEffects();
    this.applyClip();
    this.kick();
  }

  /** Choose the character and how it is shown. A missing/invalid 3D model falls back to the 2D art. */
  setCharacter(id: string, view: "2d" | "3d"): void {
    if (id === this.characterId && view === this.view) return;
    this.characterId = id;
    this.view = view;
    this.spriteTex.forEach((t) => t.dispose());
    this.spriteTex.clear();
    this.placeholderTex?.dispose();
    this.placeholderTex = null;
    this.removeModel();
    this.applyExpression();
    const ref = view === "3d" ? modelFor(id) : null;
    const token = ++this.loadToken;
    if (!ref) {
      this.card.visible = true;
      this.opts.onModel?.({ using: false, placeholder: false });
      this.kick();
      return;
    }
    void this.loadModel(ref.url, ref.placeholder, token);
  }

  /** Wake the render loop (after a state change, pointer move, visibility change...). */
  kick(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    this.budget.reset();
    this.adaptive.reset(); // a stutter right after waking is not the machine's fault
    this.timer = null;
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  stats(): EngineStats {
    const n = Math.max(1, this.stat.frames);
    return { frames: this.stat.frames, avgWorkMs: this.stat.work / n, avgIntervalMs: this.stat.interval / n, usingModel: !!this.model, tier: "standard" };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    this.removeModel();
    this.spriteTex.forEach((t) => t.dispose());
    this.effectTex.forEach((t) => t.dispose());
    this.placeholderTex?.dispose();
    this.petalMesh.dispose();
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------------ character visuals

  private expressionTexture(): THREE.Texture {
    const available = availableExpressions(this.characterId);
    const expr = resolveExpression(this.state, available);
    const url = expr ? spriteUrl(this.characterId, expr) : undefined;
    if (url) {
      let t = this.spriteTex.get(url);
      if (!t) {
        t = new THREE.TextureLoader().load(url, () => this.kick());
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        this.spriteTex.set(url, t);
      }
      return t;
    }
    // no art yet: a coloured stand-in with the state's face
    this.placeholderTex?.dispose();
    const label = manifest.characters.find((c) => c.id === this.characterId)?.label ?? this.characterId;
    this.placeholderTex = placeholderCharacterTexture(this.characterId, this.state, label);
    return this.placeholderTex;
  }

  private applyExpression(): void {
    if (!this.characterId) return;
    this.cardMat.map = this.expressionTexture();
    this.cardMat.needsUpdate = true;
  }

  private applyEffects(): void {
    const wanted = effectsFor(this.state);
    for (const [kind, sprite] of this.effects) {
      if (!wanted.some((w) => w.kind === kind)) { this.scene.remove(sprite); sprite.material.dispose(); this.effects.delete(kind); }
    }
    for (const w of wanted) {
      if (this.effects.has(w.kind)) continue;
      let t = this.effectTex.get(w.kind);
      if (!t) { t = effectTexture(w.kind); this.effectTex.set(w.kind, t); }
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
      s.renderOrder = 20;
      this.effects.set(w.kind, s);
      this.scene.add(s);
    }
  }

  // ------------------------------------------------------------------ 3D model

  private async loadModel(url: string, placeholder: boolean, token: number): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("fetch");
      const model = await parseGlb(await res.arrayBuffer());
      if (this.disposed || token !== this.loadToken) { disposeModel(model); return; }
      this.model = model;
      const inner = model.root;
      inner.scale.setScalar(model.scale);
      inner.position.y = model.offsetY;
      this.modelGroup = new THREE.Group();
      this.modelGroup.scale.setScalar(MODEL_HEIGHT);
      this.modelGroup.add(inner);
      this.pivot.add(this.modelGroup);
      this.card.visible = false;
      this.mixer = new THREE.AnimationMixer(inner);
      this.mixer.addEventListener("finished", () => this.playLoop("idle"));
      this.actions.clear();
      for (const c of model.clips) this.actions.set(c.name, this.mixer.clipAction(c));
      this.applyClip();
      this.opts.onModel?.({ using: true, placeholder });
    } catch {
      if (token !== this.loadToken) return;
      this.card.visible = true; // keep the 2D art: a broken model never breaks the character
      this.opts.onModel?.({ using: false, placeholder });
    }
    this.kick();
  }

  private removeModel(): void {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions.clear();
    this.current = null;
    if (this.modelGroup) this.pivot.remove(this.modelGroup);
    if (this.model) disposeModel(this.model);
    this.modelGroup = null;
    this.model = null;
  }

  private playLoop(state: CompanionUiState): void {
    if (!this.model) return;
    const name = resolveClip(state, this.model.clipNames);
    const next = name ? this.actions.get(name) ?? null : null;
    if (!next || next === this.current) return;
    next.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.25).play();
    this.current?.fadeOut(0.25);
    this.current = next;
  }

  private applyClip(): void {
    if (!this.model || !this.mixer) return;
    const name = resolveClip(this.state, this.model.clipNames);
    const next = name ? this.actions.get(name) ?? null : null;
    if (!next) { this.current?.fadeOut(0.25); this.current = null; return; }
    if (ONE_SHOT.has(this.state)) next.reset().setLoop(THREE.LoopOnce, 1).setEffectiveWeight(1);
    else next.reset().setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = true;
    next.fadeIn(0.25).play();
    if (this.current && this.current !== next) this.current.fadeOut(0.25);
    this.current = next;
  }

  // ------------------------------------------------------------------ the loop

  private frame(now: number): void {
    if (this.disposed) return;
    const hidden = typeof document !== "undefined" && document.hidden;
    const pointerNear = now - this.lastPointerMove < 1500;
    const fps = targetFps({ state: this.state, hidden, reduceMotion: this.reduceMotion, pointerNear });
    if (fps <= 0) return; // hidden: draw nothing; a kick (visibility change) wakes the loop again

    if (this.budget.due(now, fps)) {
      const t0 = performance.now();
      const dt = this.lastDraw ? Math.min((now - this.lastDraw) / 1000, 0.25) : 0.016;
      const interval = this.lastDraw ? now - this.lastDraw : 1000 / fps;
      this.lastDraw = now;
      this.clock += dt;
      this.update(dt, pointerNear);
      this.renderer.render(this.scene, this.camera);
      const work = performance.now() - t0;
      this.stat.frames++;
      this.stat.work += work;
      this.stat.interval += interval;
      // slow if the frame itself was expensive or the loop ran far behind its schedule
      if (fps >= 15 && this.adaptive.push(Math.max(work, interval - (1000 / fps - 16.7))) === "downgrade") {
        this.opts.onSlow("slow");
        return;
      }
    }
    this.timer = setTimeout(() => { this.raf = requestAnimationFrame((n) => this.frame(n)); }, Math.max(0, 1000 / fps - 12));
  }

  private update(dt: number, pointerNear: boolean): void {
    const since = this.clock - this.stateStart;
    const reduce = this.reduceMotion;

    // pose of the character (drives the 2D card, or a model that has no clip for this state)
    const pose = poseFor(this.state, this.clock, since, reduce);
    const usingClip = !!(this.model && this.current);
    this.pivot.position.set(usingClip ? 0 : pose.x, usingClip ? 0 : pose.y, 0.08);
    this.pivot.rotation.z = usingClip ? 0 : pose.rotZ;
    this.pivot.scale.set(usingClip ? 1 : pose.scale, usingClip ? 1 : pose.scale * pose.squash, 1);

    this.cardMat.color.setHex(this.state === "sleeping" ? 0xd9d0e6 : 0xfff7f2);
    this.sun.intensity += ((this.state === "sleeping" ? 1.4 : 2.3) - this.sun.intensity) * 0.1;

    if (this.mixer) this.mixer.update(dt);
    if (this.model) this.updateMorphs();

    // floating effect icons
    for (const spec of effectsFor(this.state)) {
      const s = this.effects.get(spec.kind);
      if (!s) continue;
      const m = effectMotion(spec.kind, this.clock, since, reduce);
      s.position.set(spec.anchor.x * 1.35 + m.x, 0.35 + spec.anchor.y * 1.1 + m.y + pose.y, 0.5);
      s.scale.setScalar(spec.size * 1.6 * m.scale);
      s.material.opacity = m.alpha;
      s.material.rotation = m.rotZ;
    }

    // petals
    stepPetals(this.petals, dt, this.clock, BOUNDS, reduce);
    for (let i = 0; i < this.petals.length; i++) {
      const p = this.petals[i];
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.rotation.set(Math.sin(p.rot * 0.7) * 0.9, 0, p.rot);
      this.dummy.scale.setScalar(p.size * (reduce ? 0.9 : 1));
      this.dummy.updateMatrix();
      this.petalMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.petalMesh.instanceMatrix.needsUpdate = true;

    // gentle parallax toward the pointer
    const k = pointerNear && !reduce ? 1 : 0.4;
    const tx = this.pointer.x * 0.14 * k, ty = this.pointer.y * 0.05 * k;
    this.camera.position.x += (tx - this.camera.position.x) * 0.08;
    this.camera.position.y += (1.0 + ty - this.camera.position.y) * 0.08;
    this.camera.lookAt(0, 0.62, 0);
    for (const b of this.bokeh) b.s.position.x = b.baseX + this.camera.position.x * -b.depth * 0.9 + Math.sin(this.clock * 0.2 + b.baseX) * 0.05 * (reduce ? 0.2 : 1);
  }

  private updateMorphs(): void {
    if (!this.model) return;
    const want = resolveMorph(this.state, this.model.morphNames);
    for (const mesh of this.model.morphMeshes) {
      const dict = mesh.morphTargetDictionary!;
      const inf = mesh.morphTargetInfluences!;
      for (const [name, i] of Object.entries(dict)) {
        const target = name === want ? 0.85 : 0;
        inf[i] += (target - inf[i]) * 0.15;
      }
    }
  }
}
