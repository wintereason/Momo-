import type { Lesson, Symbol, VocabItem } from "./types";

const H = (c: string, r: string, g: string): Symbol => ({ id: `ja-${r}`, char: c, roman: r, guide: g });
const V = (id: string, text: string, roman: string, meaning: string, guide: string, ex: [string, string, string], context: string, accept?: string[]): VocabItem => ({ id: `ja-${id}`, text, roman, meaning, guide, example: { text: ex[0], roman: ex[1], meaning: ex[2] }, context, accept: [roman, ...(accept ?? [])] });

const row = (id: string, title: string, objective: string, symbols: Symbol[]): Lesson => ({ id: `ja-${id}`, lang: "ja", level: "beginner", kind: "writing", title, objective, symbols });

export const JAPANESE_LESSONS: Lesson[] = [
  row("w1", "Hiragana: vowels and the K row", "Read and say あ い う え お and か き く け こ.", [
    H("あ", "a", "“ah”, as in “father”"), H("い", "i", "“ee”, as in “see”"), H("う", "u", "“oo”, with the lips relaxed (not rounded)"), H("え", "e", "“eh”, as in “bed”"), H("お", "o", "“oh”"),
    H("か", "ka", "“kah”"), H("き", "ki", "“kee”"), H("く", "ku", "“koo”"), H("け", "ke", "“keh”"), H("こ", "ko", "“koh”"),
  ]),
  row("w2", "Hiragana: the S and T rows", "Read and say さ し す せ そ and た ち つ て と.", [
    H("さ", "sa", "“sah”"), H("し", "shi", "“shee”"), H("す", "su", "“soo”"), H("せ", "se", "“seh”"), H("そ", "so", "“soh”"),
    H("た", "ta", "“tah”"), H("ち", "chi", "“chee”"), H("つ", "tsu", "“tsoo”, as the “ts” in “cats”"), H("て", "te", "“teh”"), H("と", "to", "“toh”"),
  ]),
  row("w3", "Hiragana: the N and H rows", "Read and say な に ぬ ね の and は ひ ふ へ ほ.", [
    H("な", "na", "“nah”"), H("に", "ni", "“nee”"), H("ぬ", "nu", "“noo”"), H("ね", "ne", "“neh”"), H("の", "no", "“noh”"),
    H("は", "ha", "“hah” (as the particle は it is read “wa”)"), H("ひ", "hi", "“hee”"), H("ふ", "fu", "“foo”, with the lips barely touching"), H("へ", "he", "“heh” (as a particle it is read “e”)"), H("ほ", "ho", "“hoh”"),
  ]),
  row("w4", "Hiragana: the M and Y rows", "Read and say ま み む め も and や ゆ よ.", [
    H("ま", "ma", "“mah”"), H("み", "mi", "“mee”"), H("む", "mu", "“moo”"), H("め", "me", "“meh”"), H("も", "mo", "“moh”"),
    H("や", "ya", "“yah”"), H("ゆ", "yu", "“yoo”"), H("よ", "yo", "“yoh”"),
  ]),
  row("w5", "Hiragana: the R row, わ, を and ん", "Read and say ら り る れ ろ, わ, を and ん, completing the 46 basic hiragana.", [
    H("ら", "ra", "a light tap of the tongue, between “r”, “l” and “d”: “rah”"), H("り", "ri", "“ree”"), H("る", "ru", "“roo”"), H("れ", "re", "“reh”"), H("ろ", "ro", "“roh”"),
    H("わ", "wa", "“wah”"), H("を", "wo", "pronounced “o”; used only as the object particle"), H("ん", "n", "a nasal “n” that makes a syllable of its own"),
  ]),
  {
    id: "ja-v1", lang: "ja", level: "beginner", kind: "vocab", category: "Greetings and introductions", title: "Greetings and introductions",
    objective: "Greet, say goodbye, thank, apologise, ask politely and answer yes or no in Japanese.",
    vocab: [
      V("konnichiwa", "こんにちは", "konnichiwa", "hello; good afternoon", "kohn-nee-chee-wah", ["こんにちは、田中です。", "Konnichiwa, Tanaka desu.", "Hello, I am Tanaka."], "Greeting during the day"),
      V("ohayo", "おはよう", "ohayō", "good morning", "oh-hah-yoh", ["おはようございます。", "Ohayō gozaimasu.", "Good morning (polite)."], "Greeting in the morning; add ございます to be polite", ["ohayo", "ohayou"]),
      V("sayonara", "さようなら", "sayōnara", "goodbye", "sah-yoh-nah-rah", ["さようなら、また明日。", "Sayōnara, mata ashita.", "Goodbye, see you tomorrow."], "A fairly formal goodbye", ["sayonara", "sayounara"]),
      V("arigato", "ありがとう", "arigatō", "thank you", "ah-ree-gah-toh", ["どうもありがとう。", "Dōmo arigatō.", "Thank you very much."], "Thanking someone", ["arigato", "arigatou"]),
      V("onegai", "お願いします", "onegaishimasu", "please", "oh-neh-gah-ee-shee-mahs", ["水をお願いします。", "Mizu o onegaishimasu.", "Water, please."], "Asking for something politely", ["onegai shimasu", "おねがいします"]),
      V("sumimasen", "すみません", "sumimasen", "excuse me; I’m sorry", "soo-mee-mah-sen", ["すみません、遅れました。", "Sumimasen, okuremashita.", "Sorry, I’m late."], "Apologising or getting attention"),
      V("hai", "はい", "hai", "yes", "hah-ee", ["はい、そうです。", "Hai, sō desu.", "Yes, that’s right."], "Answering"),
      V("iie", "いいえ", "iie", "no", "ee-eh", ["いいえ、違います。", "Iie, chigaimasu.", "No, that’s not right."], "Answering"),
    ],
  },
  {
    id: "ja-v2", lang: "ja", level: "beginner", kind: "vocab", category: "Numbers and dates", title: "Numbers 1 to 10",
    objective: "Say and recognise the numbers one to ten in Japanese, written in hiragana.",
    vocab: [
      V("n1", "いち", "ichi", "one", "ee-chee", ["一時です。", "Ichiji desu.", "It’s one o’clock."], "Counting and the hour"),
      V("n2", "に", "ni", "two", "nee", ["二時です。", "Niji desu.", "It’s two o’clock."], "Counting and the hour"),
      V("n3", "さん", "san", "three", "sahn", ["三時です。", "Sanji desu.", "It’s three o’clock."], "Counting and the hour"),
      V("n4", "よん", "yon", "four", "yohn", ["四百円です。", "Yonhyaku-en desu.", "It’s 400 yen."], "Four is also said し (shi), but よん is usual when counting", ["shi", "し"]),
      V("n5", "ご", "go", "five", "goh", ["五時です。", "Goji desu.", "It’s five o’clock."], "Counting and the hour"),
      V("n6", "ろく", "roku", "six", "roh-koo", ["六時です。", "Rokuji desu.", "It’s six o’clock."], "Counting and the hour"),
      V("n7", "なな", "nana", "seven", "nah-nah", ["七百円です。", "Nanahyaku-en desu.", "It’s 700 yen."], "Seven is also said しち (shichi)", ["shichi", "しち"]),
      V("n8", "はち", "hachi", "eight", "hah-chee", ["八時です。", "Hachiji desu.", "It’s eight o’clock."], "Counting and the hour"),
      V("n9", "きゅう", "kyū", "nine", "kyoo", ["九百円です。", "Kyūhyaku-en desu.", "It’s 900 yen."], "Nine is also said く (ku) in some words", ["kyu", "kyuu", "ku", "く"]),
      V("n10", "じゅう", "jū", "ten", "joo", ["十時です。", "Jūji desu.", "It’s ten o’clock."], "Counting and the hour", ["ju", "juu"]),
    ],
  },
];
