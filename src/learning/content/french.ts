import type { Lesson, Symbol, VocabItem } from "./types";

const L = (id: string, char: string, roman: string, guide: string, ex?: [string, string]): Symbol => ({ id: `fr-${id}`, char, roman, guide, example: ex ? { text: ex[0], meaning: ex[1] } : undefined });
const V = (id: string, text: string, roman: string | undefined, meaning: string, guide: string, ex: [string, string], context: string, accept?: string[]): VocabItem => ({ id: `fr-${id}`, text, roman, meaning, guide, example: { text: ex[0], meaning: ex[1] }, context, accept });

export const FRENCH_LESSONS: Lesson[] = [
  {
    id: "fr-w1", lang: "fr", level: "beginner", kind: "writing", title: "The French alphabet, A to M",
    objective: "Recognise the letters A to M and say each letter's French name.",
    symbols: [
      L("a", "a", "a", "“ah”, as in “father”"), L("b", "b", "bé", "“bay”"), L("c", "c", "cé", "“say”"), L("d", "d", "dé", "“day”"),
      L("e", "e", "e", "“uh”, as in the first sound of “about”"), L("f", "f", "effe", "“eff”"), L("g", "g", "gé", "“zhay” (zh as in “measure”)"),
      L("h", "h", "hache", "“ash”; the letter h is silent inside words"), L("i", "i", "i", "“ee”, as in “see”"), L("j", "j", "ji", "“zhee” (zh as in “measure”)"),
      L("k", "k", "ka", "“kah”"), L("l", "l", "elle", "“ell”"), L("m", "m", "emme", "“emm”"),
    ],
  },
  {
    id: "fr-w2", lang: "fr", level: "beginner", kind: "writing", title: "The French alphabet, N to Z",
    objective: "Recognise the letters N to Z and say each letter's French name.",
    symbols: [
      L("n", "n", "enne", "“enn”"), L("o", "o", "o", "“oh”"), L("p", "p", "pé", "“pay”"), L("q", "q", "cu", "“kew”, with rounded lips"),
      L("r", "r", "erre", "“air”, with the r made at the back of the throat"), L("s", "s", "esse", "“ess”"), L("t", "t", "té", "“tay”"),
      L("u", "u", "u", "“ü”: say “ee” with your lips rounded as for “oo”"), L("v", "v", "vé", "“vay”"), L("w", "w", "double vé", "“doo-bluh-vay”"),
      L("x", "x", "iks", "“eeks”"), L("y", "y", "i grec", "“ee-grek”"), L("z", "z", "zède", "“zed”"),
    ],
  },
  {
    id: "fr-w3", lang: "fr", level: "beginner", kind: "writing", title: "French accents and special letters",
    objective: "Recognise accented letters and know how each one changes the sound.",
    symbols: [
      L("e1", "é", "e accent aigu", "“ay”, as in “say” without the glide", ["l’été", "summer"]),
      L("e2", "è", "e accent grave", "“eh”, as in “bed”", ["la mère", "the mother"]),
      L("e3", "ê", "e accent circonflexe", "“eh”, as in “bed”", ["la fête", "the party"]),
      L("a1", "à", "a accent grave", "“ah”; the accent separates it from “a” (has)", ["à demain", "see you tomorrow"]),
      L("c1", "ç", "c cédille", "“s”, as in “sun” (the cedilla makes c soft before a, o, u)", ["ça va", "it’s going well"]),
      L("o1", "ô", "o accent circonflexe", "“oh”", ["l’hôtel", "the hotel"]),
      L("i1", "ï", "i tréma", "“ee”; the dots show it is pronounced separately from the letter before it", ["naïf", "naive"]),
    ],
  },
  {
    id: "fr-v1", lang: "fr", level: "beginner", kind: "vocab", category: "Greetings and introductions", title: "Greetings and introductions",
    objective: "Greet someone, say goodbye, thank them, apologise and answer yes or no in French.",
    vocab: [
      V("bonjour", "bonjour", undefined, "hello; good day", "bohn-ZHOOR", ["Bonjour, madame.", "Hello, ma’am."], "Used all day until the evening"),
      V("bonsoir", "bonsoir", undefined, "good evening", "bohn-SWAHR", ["Bonsoir, comment allez-vous ?", "Good evening, how are you?"], "Used from the evening on, to greet someone"),
      V("au-revoir", "au revoir", undefined, "goodbye", "oh ruh-VWAHR", ["Au revoir et à demain.", "Goodbye and see you tomorrow."], "Saying goodbye", ["aurevoir"]),
      V("merci", "merci", undefined, "thank you", "mehr-SEE", ["Merci beaucoup.", "Thank you very much."], "Thanking someone"),
      V("sil-vous-plait", "s’il vous plaît", undefined, "please", "seel voo PLEH", ["Un café, s’il vous plaît.", "A coffee, please."], "Asking politely (formal or to several people)", ["s'il vous plait", "sil vous plait"]),
      V("pardon", "pardon", undefined, "sorry; excuse me", "par-DOHN", ["Pardon, je suis en retard.", "Sorry, I am late."], "Apologising or getting someone’s attention"),
      V("oui", "oui", undefined, "yes", "WEE", ["Oui, c’est ça.", "Yes, that’s right."], "Answering"),
      V("non", "non", undefined, "no", "NOHN", ["Non, merci.", "No, thank you."], "Answering"),
    ],
  },
  {
    id: "fr-v2", lang: "fr", level: "beginner", kind: "vocab", category: "Numbers and dates", title: "Numbers 1 to 10",
    objective: "Say, recognise and write the numbers one to ten in French.",
    vocab: [
      V("un", "un", undefined, "one", "UHN", ["J’ai un frère.", "I have one brother."], "Counting; “un” is also the masculine word for “a”"),
      V("deux", "deux", undefined, "two", "DUH", ["Deux cafés, s’il vous plaît.", "Two coffees, please."], "Counting"),
      V("trois", "trois", undefined, "three", "TRWAH", ["Il y a trois chats.", "There are three cats."], "Counting"),
      V("quatre", "quatre", undefined, "four", "KATR", ["Il est quatre heures.", "It is four o’clock."], "Counting and telling the time"),
      V("cinq", "cinq", undefined, "five", "SANK", ["J’ai cinq euros.", "I have five euros."], "Counting and money"),
      V("six", "six", undefined, "six", "SEES", ["Il y a six pommes.", "There are six apples."], "Counting"),
      V("sept", "sept", undefined, "seven", "SET", ["Il y a sept jours dans une semaine.", "There are seven days in a week."], "Counting; the p is silent"),
      V("huit", "huit", undefined, "eight", "WEET", ["Elle a huit ans.", "She is eight years old."], "Counting and ages"),
      V("neuf", "neuf", undefined, "nine", "NUHF", ["Il y a neuf élèves.", "There are nine pupils."], "Counting"),
      V("dix", "dix", undefined, "ten", "DEES", ["J’attends depuis dix minutes.", "I have been waiting for ten minutes."], "Counting and time"),
    ],
  },
];
