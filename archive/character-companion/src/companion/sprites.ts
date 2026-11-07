/**
 * Sprites are discovered at build time from assets/characters/<id>/<expression>.png.
 * With no art yet this map is empty and the UI shows placeholders.
 */
const files = import.meta.glob("../../assets/characters/*/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const byChar = new Map<string, Map<string, string>>();
for (const [path, url] of Object.entries(files)) {
  const m = path.match(/characters\/([^/]+)\/([^/]+)\.png$/);
  if (!m) continue;
  if (!byChar.has(m[1])) byChar.set(m[1], new Map());
  byChar.get(m[1])!.set(m[2], url);
}

export function availableExpressions(characterId: string): Set<string> {
  const m = byChar.get(characterId);
  if (!m) return new Set();
  const s = new Set(m.keys());
  s.delete("portrait");
  return s;
}
export const spriteUrl = (characterId: string, expression: string): string | undefined =>
  byChar.get(characterId)?.get(expression);
export const portraitUrl = (characterId: string): string | undefined =>
  byChar.get(characterId)?.get("portrait");
