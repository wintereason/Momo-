/** Understanding the user's answer to a "which one?" question. Never guesses between several matches. */

export type Choice = { kind: "pick"; index: number } | { kind: "cancel" } | { kind: "unclear" };

const ORDINALS: [RegExp, number][] = [
  [/\b(first|1st|number one|1)\b/, 0], [/\b(second|2nd|two|2)\b/, 1], [/\b(third|3rd|three|3)\b/, 2],
  [/\b(fourth|4th|four|4)\b/, 3], [/\b(fifth|5th|five|5)\b/, 4], [/\b(sixth|6th|six|6)\b/, 5],
  [/\b(seventh|7th|seven|7)\b/, 6], [/\b(eighth|8th|eight|8)\b/, 7], [/\b(ninth|9th|nine|9)\b/, 8],
];

export function resolveChoice(answer: string, options: string[]): Choice {
  const t = answer.toLowerCase().replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(cancel|never ?mind|forget it|stop|none|no)\b/.test(t)) return { kind: "cancel" };
  // "Is that it?" with a single candidate
  if (options.length === 1 && /\b(yes|yeah|yep|correct|right|sure|that one|that's it)\b/.test(t)) return { kind: "pick", index: 0 };
  const hits = ORDINALS.filter(([re, i]) => re.test(t) && i < options.length).map(([, i]) => i);
  if (hits.length === 1) return { kind: "pick", index: hits[0] };
  const words = t.split(" ").filter((w) => w.length > 2 && !["the", "one", "folder", "that", "this", "please"].includes(w));
  if (words.length > 0) {
    const byText = options.map((o, i) => ({ i, o: o.toLowerCase() })).filter(({ o }) => words.every((w) => o.includes(w)));
    if (byText.length === 1) return { kind: "pick", index: byText[0].i };
  }
  return { kind: "unclear" };
}
