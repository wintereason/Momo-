import type { Personality } from "./config";
import type { ExpressionId } from "./face";

/**
 * The face that fits what Momo is SAYING. The text being spoken is split into sentences; each sentence is read for its meaning
 * (apology, good news, a warning, a question, ...) and the avatar wears the matching face while that sentence is being said.
 * Plain keyword rules, deterministic and local: nothing is sent anywhere, and nothing here can change what Momo does.
 */
interface Rule { expr: ExpressionId; re: RegExp }
const RULES: Rule[] = [
  { expr: "apologetic", re: /\b(sorry|apolog\w*|my mistake|couldn'?t|could not|can'?t|cannot|unable|failed|didn'?t work|not able|access denied|no access)\b/i },
  { expr: "sad", re: /\b(not found|wasn'?t found|weren'?t found|couldn'?t find|can'?t find|does not exist|doesn'?t exist|isn'?t available|not available|no such)\b/i },
  { expr: "warning", re: /\b(warning|careful|caution|unsaved|permanently|cannot be undone|can'?t be undone|will be lost|could be lost|danger\w*)\b/i },
  { expr: "worried", re: /\b(worried|not sure|unsure|might be wrong|may be wrong|unconfirmed|couldn'?t confirm|not confirmed|not fully)\b/i },
  { expr: "sad", re: /\b(sad|sadly|unfortunately|no results|nothing found|nothing to show|goodbye|miss you)\b/i },
  { expr: "surprised", re: /\b(wow|whoa|surpris\w*|unexpected\w*|incredible|no way|oh no)\b/i },
  { expr: "excited", re: /\b(awesome|amazing|fantastic|congrat\w*|hooray|yay|woohoo|excellent|brilliant|perfect|love it)\b/i },
  { expr: "happy", re: /\b(hello|hi|hey|welcome|thanks|thank you|glad|happy|great|good|nice|done|complete\w*|success\w*|opened|found|ready|all set|enjoy|of course|my pleasure|here you go)\b/i },
  { expr: "thinking", re: /\b(let me|checking|looking|searching|working on|one moment|just a moment|hmm|reading|figuring)\b/i },
  { expr: "serious", re: /\b(must|required|important|note that|make sure|never)\b/i },
  { expr: "sleepy", re: /\b(good night|sleepy|tired|zzz)\b/i },
  { expr: "angry", re: /\b(angry|furious|annoyed)\b/i },
];
/** good-news words do not count in a sentence that says "no", "not" or "n't" */
const NEGATED = /\b(not|no|never|none|nothing)\b|n't\b/i;
const QUESTION = /\?\s*$|\b(which one|would you like|do you want|shall i|should i|can you tell me)\b/i;

/** The expression for one sentence, or null when it is neutral. */
export function expressionForSentence(sentence: string): ExpressionId | null {
  const s = sentence.trim();
  if (!s) return null;
  for (const r of RULES) {
    if (!r.re.test(s)) continue;
    if (r.expr === "happy" && NEGATED.test(s)) continue;
    // an exclamation makes good news bigger ("Great, it's done!")
    if (r.expr === "happy" && /!\s*$/.test(s) && /\b(great|done|success\w*|perfect|complete\w*)\b/i.test(s)) return "excited";
    return r.expr;
  }
  if (QUESTION.test(s)) return "listening"; // a question: attentive, waiting for the answer
  return null;
}

export interface Span { start: number; end: number; expr: ExpressionId | null }

/** The sentences of `text` with their positions and faces. */
export function sentenceSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/[^.!?…]+[.!?…]*\s*/g)) {
    if (!m[0].trim()) continue;
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, expr: expressionForSentence(m[0]) });
  }
  return out;
}

/** The face for the character at `index` of the spoken text (the sentence being said). */
export function expressionAt(spans: Span[], index: number): ExpressionId | null {
  for (const s of spans) if (index >= s.start && index < s.end) return s.expr;
  return spans.length ? spans[spans.length - 1].expr : null;
}

/** The personality tones the faces down or up (a strict Momo does not squeal), but never changes the meaning. */
export function settleForPersona(e: ExpressionId, p: Personality): ExpressionId {
  if (e === "excited") return p === "playful" ? "excited" : p === "strict" ? "calm" : p === "friendly" ? "happy" : "friendly";
  if (e === "happy") return p === "strict" ? "calm" : p === "professional" || p === "calm" ? "friendly" : "happy";
  return e;
}

/** Faces that come from what Momo is DOING (a problem, a decision, a question, listening...) are never overridden by the words. */
export const PROTECTED: ReadonlySet<ExpressionId> = new Set<ExpressionId>(["error", "warning", "worried", "confused", "listening", "thinking", "sleepy"]);

/** The final face: what Momo is doing wins for problems and decisions; otherwise the words decide while Momo speaks. */
export function faceWhileSpeaking(fromActivity: ExpressionId, fromWords: ExpressionId | null, personality: Personality): ExpressionId {
  if (!fromWords || PROTECTED.has(fromActivity)) return fromActivity;
  return settleForPersona(fromWords, personality);
}
