/**
 * Language-aware text helpers. Nothing here assumes the English alphabet: accents are folded only on Latin letters (so French
 * "café" matches "cafe" and Pinyin "nǐ hǎo" matches "ni hao"), while Hangul, kana and Chinese characters are compared as they are.
 */
const LATIN_ACCENTED = /[À-ɏ]/;

export function foldLatin(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) out += LATIN_ACCENTED.test(ch) ? ch.normalize("NFD").replace(/[̀-ͯ]/g, "") : ch;
  return out;
}

/** lower case, full-width -> normal, accents folded on Latin letters, punctuation and spaces removed */
export function normalizeAnswer(s: string): string {
  const k = s.normalize("NFKC").toLowerCase().replace(/[’‘`´]/g, "'");
  return foldLatin(k).replace(/[^\p{L}\p{N}\p{M}]/gu, "");
}

export function matchesAny(given: string, accept: readonly string[]): boolean {
  const g = normalizeAnswer(given);
  return g.length > 0 && accept.some((a) => normalizeAnswer(a) === g);
}

/** edit distance */
function lev(a: string[], b: string[]): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** 0..1 similarity of two strings after normalisation (by character, so it works for every script) */
export function similarity(a: string, b: string): number {
  const x = [...normalizeAnswer(a)], y = [...normalizeAnswer(b)];
  if (!x.length || !y.length) return 0;
  return 1 - lev(x, y) / Math.max(x.length, y.length);
}

export interface SpeechEstimate { score: number; verdict: "match" | "close" | "different"; verified: false; note: string }

/**
 * How close what the speech engine HEARD is to what the learner was asked to say. This is an AUTOMATED ESTIMATE only: a transcript
 * cannot show tone quality, vowel length, or whether a difference is a mistake or an ordinary regional accent, so a "match" means
 * "the recognizer understood the words", not "the pronunciation is verified correct".
 */
export function estimateSpeech(candidates: readonly string[], heard: string, tonal: boolean): SpeechEstimate {
  const score = Math.max(0, ...candidates.map((c) => similarity(c, heard)));
  const verdict = score >= 0.85 ? "match" : score >= 0.6 ? "close" : "different";
  const base = "Estimated from what the speech recognizer heard; it cannot judge accent quality, and regional accents are normal.";
  return { score: Math.round(score * 100) / 100, verdict, verified: false, note: tonal ? `${base} Tones cannot be checked from a transcript.` : base };
}

/**
 * What the recognizer "heard", made safe to use as a spoken answer. Speech models hallucinate on silence and noise: they return
 * "..." or a short filler, or loop one phrase over and over. None of that is something the learner said, so:
 *  - punctuation-only text ("...", "-") is nothing at all (empty string: the learner is told nothing was heard);
 *  - a phrase repeated three or more times in a row is kept once;
 *  - the result is capped, so a runaway loop can never fill the screen or the saved history.
 */
export const MAX_HEARD_CHARS = 200;
export function cleanHeard(raw: string): string {
  let t = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^[-–—\s]+/, "");
  if (!/[\p{L}\p{N}]/u.test(t)) return "";
  // collapse loops: the same run of 1..8 words repeated 3+ times in a row is kept once
  let words = t.split(" ");
  for (let n = 1; n <= 8; n++) {
    for (let i = 0; i + 3 * n <= words.length; i++) {
      const a = words.slice(i, i + n).join(" ").toLowerCase();
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && words.slice(i + reps * n, i + (reps + 1) * n).join(" ").toLowerCase() === a) reps++;
      if (reps >= 3) { words = [...words.slice(0, i + n), ...words.slice(i + reps * n)]; }
    }
  }
  t = words.join(" ");
  if (t.length > MAX_HEARD_CHARS) t = t.slice(0, MAX_HEARD_CHARS).replace(/\s+\S*$/, "") + "…";
  return t;
}
