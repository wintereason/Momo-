import type { HairColor, Theme } from "./config";

export interface Palette {
  accent: string; glow: string; hair: string; hairHi: string; eye: string; eyeDeep: string;
  line: string; jacket: string; jacketShade: string; tee: string; trim: string; skin: string; skinShade: string;
}
const SKIN = { skin: "#ffe6d8", skinShade: "#f2c6b6" };
export const PALETTES: Record<Theme, Palette> = {
  classic: { accent: "#8b6cff", glow: "#5ad8ff", hair: "#1d1535", line: "#1d1535", hairHi: "#6a4fd1", eye: "#8a7bff", eyeDeep: "#2e1f78", jacket: "#f1ecff", jacketShade: "#cdc3f0", tee: "#15111f", trim: "#5ad8ff", ...SKIN },
  cyber: { accent: "#19d9f0", glow: "#19e3ff", hair: "#0d1b2b", line: "#0d1b2b", hairHi: "#1fa6c9", eye: "#27e0ee", eyeDeep: "#0a4a63", jacket: "#e2f7fb", jacketShade: "#b6dde6", tee: "#0a1620", trim: "#19e3ff", ...SKIN },
  pastel: { accent: "#ff93bd", glow: "#ffc2dc", hair: "#5e4260", line: "#5e4260", hairHi: "#c690b8", eye: "#ff8fb8", eyeDeep: "#7a3f86", jacket: "#fff2f6", jacketShade: "#f3d3df", tee: "#4a3a5e", trim: "#a98bff", ...SKIN },
  neon: { accent: "#ff3df2", glow: "#ff3df2", hair: "#190a2c", line: "#190a2c", hairHi: "#b323ff", eye: "#ff55dc", eyeDeep: "#5a0aa6", jacket: "#3a1d5e", jacketShade: "#26123f", tee: "#0d0617", trim: "#ff3df2", ...SKIN },
};

/** hair colour presets (the theme supplies the default) */
export const HAIR_PRESETS: Record<Exclude<HairColor, "theme">, { hair: string; hairHi: string }> = {
  midnight: { hair: "#1d1535", hairHi: "#6a4fd1" },
  silver: { hair: "#d9dbe8", hairHi: "#ffffff" },
  rose: { hair: "#e0678f", hairHi: "#ffb4cf" },
  chestnut: { hair: "#5a3a2a", hairHi: "#a8745a" },
};

export function paletteFor(theme: Theme, hairColor: HairColor): Palette {
  const p = PALETTES[theme];
  if (hairColor === "theme") return p;
  const h = HAIR_PRESETS[hairColor];
  // light hair still needs dark eyelines and brows
  return { ...p, ...h, line: hairColor === "silver" ? "#5a5878" : hairColor === "rose" ? "#8a2d52" : h.hair };
}
