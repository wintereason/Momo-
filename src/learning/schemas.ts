import { z } from "zod";
/** the two small enums everything in learning shares (kept apart so the state and the interview contract do not import each other) */
export const LangIdSchema = z.enum(["fr", "ko", "zh", "ja"]);
export const LevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
