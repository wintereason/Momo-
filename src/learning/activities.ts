import type { Lesson, LangId } from "./content";
import { LANGUAGES } from "./content";
import type { Activity, Question } from "./state";
import { estimateSpeech, matchesAny, normalizeAnswer } from "./text";

/** a deterministic random source, so a lesson attempt is reproducible (and testable) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(xs: readonly T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** the learnable things of a lesson, whatever its kind */
interface Item {
  id: string; text: string; roman?: string; meaning: string; guide: string; say: string;
  accept: string[]; example?: { text: string; roman?: string; meaning: string };
}
export function itemsOf(lesson: Lesson): Item[] {
  if (lesson.kind === "writing") {
    return (lesson.symbols ?? []).map((s) => ({
      id: s.id, text: s.char, roman: s.roman, meaning: s.roman, guide: s.guide, say: s.char,
      // the sound or name may be written "g / k": any of the parts, or the whole, is accepted
      accept: [s.char, s.roman, ...s.roman.split("/").map((p) => p.trim()).filter(Boolean)], example: s.example,
    }));
  }
  return (lesson.vocab ?? []).map((v) => ({
    id: v.id, text: v.text, roman: v.roman, meaning: v.meaning, guide: v.guide, say: v.text,
    accept: [v.text, ...(v.roman ? [v.roman] : []), ...(v.accept ?? [])], example: v.example,
  }));
}

const optionsFor = (r: () => number, pool: string[], correct: string, n: number): string[] => {
  const others = shuffle([...new Set(pool.filter((p) => normalizeAnswer(p) !== normalizeAnswer(correct)))], r).slice(0, Math.max(1, n - 1));
  return shuffle([correct, ...others], r);
};

/** the label a learner sees for an item as a "word": the script, with its romanization when it has one */
const shown = (i: Item) => i.text;
const sub = (i: Item, hide: boolean) => (hide ? undefined : i.roman);

export interface BuildOptions {
  /** 1 easy .. 3 hard: more wrong options, fewer hints, more typing */
  difficulty: 1 | 2 | 3;
  seed: number;
  /** revise only these items (padded with others when fewer than three) */
  focus?: string[];
  /** include the listen-and-repeat and speaking activities */
  speaking?: boolean;
}

export function buildActivities(lesson: Lesson, o: BuildOptions): Activity[] {
  const r = rng(o.seed);
  const all = itemsOf(lesson);
  let items = all;
  if (o.focus && o.focus.length) {
    const f = all.filter((i) => o.focus!.includes(i.id));
    const pad = shuffle(all.filter((i) => !o.focus!.includes(i.id)), r).slice(0, Math.max(0, 3 - f.length));
    items = [...f, ...pad];
  }
  items = shuffle(items, r);
  const nOpt = 2 + o.difficulty; // 3, 4 or 5 choices
  const hide = o.difficulty === 3; // the hardest level hides the romanization help
  const uid = `${lesson.id}:${o.seed}`;
  const acts: Activity[] = [];
  const q = (kind: Question["kind"], item: Item, idx: number, extra: Partial<Question>): Question => ({
    id: `${uid}:${kind}:${idx}`, kind, itemId: item.id, prompt: "", answer: "", accept: [], ...extra,
  });
  const pool = (f: (i: Item) => string) => all.map(f);
  const writing = lesson.kind === "writing";

  // 1. match symbols/words with their sounds/meanings (one board of up to six pairs)
  const boardItems = items.slice(0, 6);
  if (boardItems.length >= 2) {
    acts.push({
      id: `${uid}:match`, kind: "match", title: writing ? "Match each symbol with its sound" : "Match each word with its meaning",
      instructions: writing ? "Connect every symbol with how it is read." : "Connect every word with what it means.", speaking: false,
      questions: [q("match", boardItems[0], 0, {
        prompt: writing ? "Match the symbols with their sounds" : "Match the words with their meanings", answer: boardItems.map((i) => `${shown(i)} = ${i.meaning}`).join("; "),
        pairs: boardItems.map((i) => ({ id: i.id, left: shown(i), right: i.meaning })), accept: [],
      })],
    });
  }

  // 2. recognise: see the symbol/word, choose what it is
  acts.push({
    id: `${uid}:choice`, kind: "choice", title: writing ? "Recognise the symbol" : "Choose the meaning", instructions: "Pick the correct answer.", speaking: false,
    questions: items.map((i, n) => q("choice", i, n, {
      prompt: shown(i), sub: sub(i, hide && !writing), answer: i.meaning, accept: [i.meaning],
      options: optionsFor(r, pool((x) => x.meaning), i.meaning, nOpt),
    })),
  });

  // 3. identify from audio: hear it, choose what it is
  acts.push({
    id: `${uid}:audio`, kind: "audio-id", title: "Identify what you hear", instructions: "Press play, listen, then pick the answer.", speaking: false,
    questions: items.map((i, n) => q("audio-id", i, n, {
      prompt: writing ? "Which symbol do you hear?" : "What does it mean?", say: i.say,
      answer: writing ? shown(i) : i.meaning, accept: [writing ? shown(i) : i.meaning],
      options: optionsFor(r, writing ? pool(shown) : pool((x) => x.meaning), writing ? shown(i) : i.meaning, nOpt),
    })),
  });

  // 4. translate: from the meaning (or the sound) to the target text, typed
  acts.push({
    id: `${uid}:translate`, kind: "translate", title: writing ? "Write the sound of each symbol" : "Translate into the language", speaking: false,
    instructions: writing ? "Type how each symbol is read." : `Type the word in the language you are learning. ${LANGUAGES[lesson.lang].typingNote}`,
    questions: items.map((i, n) => q("translate", i, n, {
      prompt: writing ? shown(i) : i.meaning, sub: writing ? undefined : undefined, answer: writing ? i.roman ?? i.meaning : i.text,
      accept: i.accept,
    })),
  });

  // 5. fill the missing word (vocabulary with an example sentence that contains the word exactly once)
  if (!writing) {
    const fills = items.map((i, n) => ({ i, n, at: blankAt(i) })).filter((x) => x.at !== null);
    if (fills.length >= 2) {
      acts.push({
        id: `${uid}:fill`, kind: "fill-blank", title: "Fill in the missing word", instructions: "Type the word that completes the sentence.", speaking: false,
        questions: fills.map(({ i, n, at }) => q("fill-blank", i, n, {
          prompt: i.example!.text.slice(0, at!) + "____" + i.example!.text.slice(at! + i.text.length),
          sub: i.example!.meaning, answer: i.text, accept: i.accept,
        })),
      });
    }
  }

  // 6 and 7. listen and repeat, then speak (estimated, never verified)
  if (o.speaking !== false) {
    acts.push({
      id: `${uid}:repeat`, kind: "repeat", title: "Listen and repeat", speaking: true,
      instructions: "Listen, then say it out loud. Momo tells you what the speech recognizer heard: an estimate, not a verdict on your accent.",
      questions: items.slice(0, 6).map((i, n) => q("repeat", i, n, { prompt: shown(i), sub: i.roman, say: i.say, target: i.text, answer: i.text, accept: i.accept })),
    });
    if (!writing) {
      const withEx = items.filter((i) => i.example).slice(0, 3);
      if (withEx.length) {
        acts.push({
          id: `${uid}:speak`, kind: "speak", title: "Say a whole sentence", speaking: true,
          instructions: "Read the sentence aloud after listening to it.",
          questions: withEx.map((i, n) => q("speak", i, n, { prompt: i.example!.text, sub: i.example!.roman ?? i.example!.meaning, say: i.example!.text, target: i.example!.text, answer: i.example!.text, accept: [i.example!.text, ...(i.example!.roman ? [i.example!.roman] : [])] })),
        });
      }
    }
  }
  return acts.filter((a) => a.questions.length > 0);
}

/** where the item's word sits in its example sentence, only if it appears exactly once and as a whole word */
function blankAt(i: Item): number | null {
  const s = i.example?.text;
  if (!s || !i.text) return null;
  const hay = s.toLowerCase(), needle = i.text.toLowerCase(); // a sentence may start with a capital
  const at = hay.indexOf(needle);
  if (at < 0 || hay.indexOf(needle, at + 1) >= 0) return null;
  const latin = /^[\p{Script=Latin}'’\s-]+$/u.test(i.text);
  if (latin) {
    const before = s[at - 1], after = s[at + i.text.length];
    if ((before && /\p{L}/u.test(before)) || (after && /\p{L}/u.test(after))) return null;
  }
  return at;
}

export interface Evaluation {
  correct: boolean;
  /** match questions: how many pairs were right */
  part?: { right: number; total: number };
  /** the ids of the pairs that were wrong */
  wrongPairs?: string[];
  estimate?: ReturnType<typeof estimateSpeech>;
}

/**
 * Judge one answer. Choice and typed answers are judged exactly; a spoken answer gets an estimate only and is marked "close" or
 * "match" if the recognizer heard something near the target, but is never called verified.
 */
export function evaluate(qn: Question, given: string, lang: LangId, mode: "typed" | "chosen" | "spoken" | "typed-instead-of-speaking"): Evaluation {
  switch (qn.kind) {
    case "match": {
      let map: Record<string, string> = {};
      try { map = JSON.parse(given) as Record<string, string>; } catch { /* treated as empty */ }
      const pairs = qn.pairs ?? [];
      const wrong = pairs.filter((p) => normalizeAnswer(map[p.id] ?? "") !== normalizeAnswer(p.right)).map((p) => p.id);
      return { correct: wrong.length === 0, part: { right: pairs.length - wrong.length, total: pairs.length }, wrongPairs: wrong };
    }
    case "choice": case "audio-id":
      return { correct: normalizeAnswer(given) === normalizeAnswer(qn.answer) };
    case "translate": case "fill-blank":
      return { correct: matchesAny(given, qn.accept) };
    case "repeat": case "speak": {
      if (mode === "typed-instead-of-speaking") return { correct: matchesAny(given, qn.accept) };
      const est = estimateSpeech([qn.target ?? qn.answer, ...qn.accept], given, LANGUAGES[lang].tonal);
      return { correct: est.verdict !== "different", estimate: est };
    }
  }
}

/** speaking activities are evaluated and must be completed, but they never decide the pass score (only checkable answers do) */
export const isCheckable = (k: Question["kind"]) => k !== "repeat" && k !== "speak";
