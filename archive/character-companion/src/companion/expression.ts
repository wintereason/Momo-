import manifestJson from "../../assets/characters.manifest.json";
import type { CompanionUiState } from "../types/runtime-events";

export interface CharacterDef {
  id: string;
  label: string;
  tagline: string;
  sheetExpressions: string[];
  extraDemoViews?: string[];
}
export interface Manifest {
  characters: CharacterDef[];
  stateToExpression: Record<CompanionUiState, string[]>;
}

export const manifest = manifestJson as unknown as Manifest;

/**
 * Fallback rule (manifest): first expression in the state's list that exists for the
 * character; else "happy"; else null (caller shows the placeholder).
 */
export function resolveExpression(
  state: CompanionUiState,
  available: ReadonlySet<string>,
  map: Manifest["stateToExpression"] = manifest.stateToExpression,
): string | null {
  for (const e of map[state] ?? []) if (available.has(e)) return e;
  return available.has("happy") ? "happy" : null;
}

/** Placeholder face glyphs so every state is visually distinct without art. */
export const PLACEHOLDER_FACE: Record<CompanionUiState, string> = {
  idle: "(◕‿◕)",
  listening: "(◕o◕)",
  transcribing: "(•_•)",
  thinking: "(¬_¬)?",
  asking: "(・・?)",
  working: "(`･ω･´)",
  success: "(ﾉ◕ヮ◕)ﾉ",
  partial_success: "(◔‿◔)",
  sorry: "(╥﹏╥)",
  blocked: "(⊙_⊙)",
  error: "(×_×)",
  sleeping: "(－_－) zzZ",
  disabled: "(・_・)",
};

export const CHARACTER_COLORS: Record<string, string> = {
  gojo: "#b9a7ff",
  nezuko: "#ffa3b8",
  megumi: "#8a9bbd",
  klee: "#f2c27a",
  mochi: "#ff9ccf",
};
export const colorFor = (id: string) => CHARACTER_COLORS[id] ?? "#c9b8d9";
