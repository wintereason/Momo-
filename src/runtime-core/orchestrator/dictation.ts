/**
 * Dictation: turning what was said into clean written text.
 *  - The AI step (ai/service.ts `polish`) fixes grammar, punctuation and wording.
 *  - This file holds what works WITHOUT the AI (a light local clean-up) and the check that the AI's reply is
 *    still the user's sentence and not something else. The text is only ever inserted; it is never run as a command.
 */

export type DictationStyle = "off" | "light" | "polish";

export interface DictationResult {
  ok: true;
  /** what to write */
  text: string;
  /** did the AI improve it? false = only the local clean-up (or nothing) was applied */
  polished: boolean;
  /** who improved it, e.g. "Gemini" */
  source?: string;
  /** a short, honest note for the user when the AI could not be used */
  note?: string;
}

export type DictationOutcome = DictationResult | { ok: false; reason: string };

const FILLERS = /\b(?:um+|uh+|erm+|er|ah+|hmm+|you know|i mean)\b[,]?\s*/gi;

/** A cheap, safe clean-up used when the AI is off or unavailable. It never changes the meaning. */
export function localClean(input: string): string {
  let t = input.replace(/\s+/g, " ").trim();
  if (!t) return "";
  t = t.replace(FILLERS, "");
  // "the the" -> "the": a stumbled repeat of a SHORT word (longer repeats like "very very" or "had had" can be intended)
  t = t.replace(/\b(\p{L}{1,3})(\s+\1\b)+/giu, "$1");
  t = t.replace(/\s+([,.!?;:])/g, "$1").replace(/\bi\b/g, "I").replace(/\bi'(m|ll|d|ve)\b/g, "I'$1");
  t = t.replace(/\s{2,}/g, " ").trim();
  // capitalise the first letter and sentence starts (Latin letters only: other scripts have no capitals)
  t = t.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
  // a full stop only after Latin text: Hindi and other scripts have their own sentence marks
  if (/[A-Za-z0-9]$/.test(t)) t += ".";
  return t;
}

/**
 * Is the AI's output still plausibly the same sentence? Rejects empty output, a reply that is far longer than what was
 * said (it started explaining or answering), or one that is wrapped in commentary.
 */
export function acceptPolish(raw: string, polished: string): string | null {
  let t = polished.trim();
  if (!t) return null;
  // models sometimes wrap the answer in quotes or a code fence
  t = t.replace(/^```[a-z]*\n?|\n?```$/gi, "").trim();
  if (t.length >= 2 && /^["“'].*["”']$/s.test(t) && !/^["“'].*["”'].*["“']/s.test(t)) t = t.slice(1, -1).trim();
  if (!t) return null;
  if (t.length > raw.length * 2.5 + 40) return null;
  if (/^(sure|here(?:'s| is)|certainly|of course|i (?:can|cannot|can't))\b/i.test(t) && !/^(sure|here|certainly|of course|i )/i.test(raw.trim())) return null;
  return t.slice(0, 4000);
}
