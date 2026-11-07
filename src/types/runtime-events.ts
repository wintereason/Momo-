import { z } from "zod";

export const UI_STATES = [
  "idle", "listening", "transcribing", "thinking", "asking", "working",
  "success", "partial_success", "sorry", "blocked", "error", "sleeping", "disabled",
] as const;
export type CompanionUiState = (typeof UI_STATES)[number];

export const ACTIVATION_MODES = ["hold", "toggle"] as const;
export type ActivationMode = (typeof ACTIVATION_MODES)[number];

const id = z.string().min(1).max(128);
const text = z.string().max(4000);

/** Typed event contract between the local runtime and the UI (doc 02, section 10). */
export const RuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("voice.started"), sessionId: id }),
  z.object({ type: z.literal("voice.stopped"), sessionId: id }),
  z.object({ type: z.literal("transcript.ready"), sessionId: id, text }),
  z.object({
    type: z.literal("task.state"), taskId: id,
    state: z.enum(UI_STATES), message: text.optional(),
    /** a short line worth reading aloud ("Opening D:\Projects"): set only for steps that do something */
    speak: z.boolean().optional(),
  }),
  z.object({ type: z.literal("task.confirmation_required"), taskId: id, summary: text }),
  z.object({
    type: z.literal("task.clarification_required"), taskId: id, question: text,
    /** several things match: each with its name and (when it has one) its full path, so the user can pick by click or by voice */
    options: z.array(z.object({ label: z.string().max(200), detail: z.string().max(400).optional() })).max(9).optional(),
  }),
  z.object({
    type: z.literal("task.completed"), taskId: id, summary: text, verified: z.literal(true),
  }),
  z.object({
    type: z.literal("task.failed"), taskId: id, summary: text, recoverable: z.boolean(),
  }),
  // An answer written by an AI model. It is NOT a verified result and never looks like a success:
  // the UI shows it as an answer that "may be wrong", and the character stays neutral.
  z.object({ type: z.literal("task.answer"), taskId: id, text: z.string().min(1).max(4000), source: z.string().max(80) }),
  z.object({ type: z.literal("runtime.error"), code: z.string().min(1).max(64), message: text }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

/** Validate untrusted data at the runtime boundary. Never throws. */
export function parseRuntimeEvent(raw: unknown): RuntimeEvent | null {
  const r = RuntimeEventSchema.safeParse(raw);
  return r.success ? r.data : null;
}
