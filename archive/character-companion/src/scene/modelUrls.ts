/**
 * 3D models are discovered at build time from assets/models/. A real model (<id>.glb) always wins over the
 * generated placeholder (<id>.placeholder.glb). With neither, the character stays a 2D sprite.
 */
const files = import.meta.glob("../../assets/models/*.glb", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

export interface ModelRef { url: string; placeholder: boolean }

const byId = new Map<string, ModelRef>();
for (const [p, url] of Object.entries(files)) {
  const m = p.match(/models\/([^/]+?)(\.placeholder)?\.glb$/);
  if (!m) continue;
  const placeholder = !!m[2];
  const existing = byId.get(m[1]);
  if (!existing || (existing.placeholder && !placeholder)) byId.set(m[1], { url, placeholder });
}

export const modelFor = (characterId: string): ModelRef | null => byId.get(characterId) ?? null;
