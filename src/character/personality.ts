import type { Personality } from "./config";
import type { ExpressionId } from "./face";

/**
 * Personality = how Momo SOUNDS and carries itself. It rewrites only Momo's own fixed phrases (greetings, "Done",
 * "I couldn't do that"...) and the small lead-in it speaks before a result. It never changes what an AI answer says,
 * what Momo knows, which tools it may use, or whether it asks before a consequential action.
 */
export type PhraseKey =
  | "ready" | "listenDictate" | "listenAgent" | "transcribing" | "polishing" | "working" | "confirm" | "ask" | "done" | "failed" | "partial";

type Table = Record<PhraseKey, string>;
const PHRASES: Record<Personality, Table> = {
  friendly: { ready: "Hi! I'm here.", listenDictate: "I'm listening…", listenAgent: "What can I do for you?", transcribing: "Writing it down…", polishing: "Polishing…", working: "On it!", confirm: "Is this okay?", ask: "Quick question", done: "All done!", failed: "Sorry, I couldn't do that", partial: "Almost, but not sure" },
  professional: { ready: "Ready.", listenDictate: "Listening…", listenAgent: "Please state the task.", transcribing: "Transcribing…", polishing: "Refining the text…", working: "Working on it…", confirm: "Please confirm", ask: "I need to clarify", done: "Completed", failed: "Unable to complete that", partial: "Not fully confirmed" },
  playful: { ready: "Ooh, hi there!", listenDictate: "Ears on! Go ahead…", listenAgent: "Hit me with it!", transcribing: "Scribbling it down…", polishing: "Making it shine…", working: "Let me cook…", confirm: "You sure about this?", ask: "Hmm, which one?", done: "Ta-da! Done!", failed: "Oops, that didn't work", partial: "Mostly there, I think" },
  strict: { ready: "Ready.", listenDictate: "Speak.", listenAgent: "State the task.", transcribing: "Transcribing.", polishing: "Editing.", working: "Working.", confirm: "Confirm.", ask: "Clarify.", done: "Done.", failed: "Failed", partial: "Unverified" },
  calm: { ready: "I'm here, no rush.", listenDictate: "Take your time…", listenAgent: "Tell me when you're ready…", transcribing: "Writing it down…", polishing: "Smoothing it out…", working: "Taking care of it…", confirm: "Shall I go ahead?", ask: "One small question", done: "That's done", failed: "I couldn't manage that", partial: "Not entirely sure" },
};

/** The bar's stock messages (from dictationState) and the phrase each one stands for. Anything else is left exactly as is. */
const STOCK: Record<string, PhraseKey> = {
  "Listening…": "listenDictate",
  "Tell me what to do…": "listenAgent",
  "Writing it down…": "transcribing",
  "Polishing…": "polishing",
  "Almost there…": "polishing",
  "Working it out…": "working",
  "Please confirm": "confirm",
  "I have a question": "ask",
  "Done": "done",
  "I couldn't do that": "failed",
  "Not fully confirmed": "partial",
};

export const phrase = (key: PhraseKey, p: Personality): string => PHRASES[p][key];

/** Re-word one of the bar's stock messages. Messages that carry facts (a file name, an error) are never touched. */
export function styleMessage(message: string, p: Personality): string {
  const key = STOCK[message];
  return key ? PHRASES[p][key] : message;
}

/** A short lead-in said before a spoken result (never before an AI answer, a question or a decision). */
export function leadIn(kind: "completed" | "failed", p: Personality): string {
  if (kind === "completed") return { friendly: "Done! ", professional: "", playful: "Ta-da! ", strict: "", calm: "All set. " }[p];
  return { friendly: "Sorry, ", professional: "", playful: "Oops, ", strict: "", calm: "I'm sorry, " }[p];
}

export interface Persona {
  /** what Momo looks like while waiting */
  idle: ExpressionId;
  /** the face for a verified success, and for a failure it is sorry about */
  celebrate: ExpressionId;
  failure: ExpressionId;
  /** blink pace and how lively the idle motion is (multipliers) */
  blinkEvery: number;
  motion: number;
  /** a small playful wink now and then while idle */
  winks: boolean;
}
export const PERSONAS: Record<Personality, Persona> = {
  friendly: { idle: "friendly", celebrate: "happy", failure: "apologetic", blinkEvery: 1, motion: 1, winks: false },
  professional: { idle: "calm", celebrate: "friendly", failure: "apologetic", blinkEvery: 1.2, motion: 0.7, winks: false },
  playful: { idle: "idle", celebrate: "excited", failure: "sad", blinkEvery: 0.8, motion: 1.3, winks: true },
  strict: { idle: "serious", celebrate: "calm", failure: "serious", blinkEvery: 1.5, motion: 0.5, winks: false },
  calm: { idle: "calm", celebrate: "friendly", failure: "apologetic", blinkEvery: 1.3, motion: 0.55, winks: false },
};
