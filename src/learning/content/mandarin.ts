import type { Lesson, Symbol, VocabItem } from "./types";

const S = (id: string, char: string, roman: string, guide: string, ex?: [string, string, string]): Symbol => ({ id: `zh-${id}`, char, roman, guide, example: ex ? { text: ex[0], roman: ex[1], meaning: ex[2] } : undefined });
const V = (id: string, text: string, roman: string, meaning: string, guide: string, ex: [string, string, string], context: string, accept?: string[]): VocabItem => ({ id: `zh-${id}`, text, roman, meaning, guide, example: { text: ex[0], roman: ex[1], meaning: ex[2] }, context, accept: [roman, ...(accept ?? [])] });

/** Pinyin written without tone marks is accepted when typing (nihao for nǐ hǎo); tones are taught and tested separately. */
export const MANDARIN_LESSONS: Lesson[] = [
  {
    id: "zh-w1", lang: "zh", level: "beginner", kind: "writing", title: "Pinyin and the four tones",
    objective: "Tell the four Mandarin tones and the neutral tone apart, by ear and by tone mark.",
    symbols: [
      S("t1", "妈", "mā", "tone 1: high and level; mā means “mother”", ["妈妈", "māma", "mum"]),
      S("t2", "麻", "má", "tone 2: rising, like a question “what?”; má means “hemp”"),
      S("t3", "马", "mǎ", "tone 3: dips down then up; mǎ means “horse”", ["马", "mǎ", "horse"]),
      S("t4", "骂", "mà", "tone 4: sharp and falling, like a firm “no!”; mà means “to scold”"),
      S("t0", "吗", "ma", "neutral tone: short and light, no tone mark; ma turns a statement into a question"),
    ],
  },
  {
    id: "zh-w2", lang: "zh", level: "beginner", kind: "writing", title: "The characters for 1 to 10",
    objective: "Recognise and read the Chinese characters for the numbers one to ten, with their Pinyin and tones.",
    symbols: [
      S("1", "一", "yī", "one: tone 1; written with one horizontal stroke"),
      S("2", "二", "èr", "two: tone 4; two horizontal strokes"),
      S("3", "三", "sān", "three: tone 1; three horizontal strokes"),
      S("4", "四", "sì", "four: tone 4"),
      S("5", "五", "wǔ", "five: tone 3"),
      S("6", "六", "liù", "six: tone 4"),
      S("7", "七", "qī", "seven: tone 1"),
      S("8", "八", "bā", "eight: tone 1"),
      S("9", "九", "jiǔ", "nine: tone 3"),
      S("10", "十", "shí", "ten: tone 2; a cross"),
    ],
  },
  {
    id: "zh-v1", lang: "zh", level: "beginner", kind: "vocab", category: "Greetings and introductions", title: "Greetings and introductions",
    objective: "Greet, say goodbye, thank, apologise, ask politely and answer yes or no in Mandarin.",
    vocab: [
      V("nihao", "你好", "nǐ hǎo", "hello", "nee how (both syllables are tone 3; the first becomes tone 2 in speech)", ["你好，我叫安娜。", "Nǐ hǎo, wǒ jiào Ānnà.", "Hello, my name is Anna."], "The standard greeting", ["nihao", "ni hao"]),
      V("zaoshang", "早上好", "zǎoshang hǎo", "good morning", "dzow-shahng how", ["早上好，老师。", "Zǎoshang hǎo, lǎoshī.", "Good morning, teacher."], "Greeting in the morning", ["zaoshanghao", "zaoshang hao"]),
      V("zaijian", "再见", "zàijiàn", "goodbye", "dzye-jyen", ["明天见，再见！", "Míngtiān jiàn, zàijiàn!", "See you tomorrow, goodbye!"], "Saying goodbye", ["zaijian"]),
      V("xiexie", "谢谢", "xièxie", "thank you", "shyeh-shyeh", ["谢谢你的帮助。", "Xièxie nǐ de bāngzhù.", "Thank you for your help."], "Thanking someone", ["xiexie"]),
      V("qing", "请", "qǐng", "please", "ching", ["请坐。", "Qǐng zuò.", "Please sit down."], "Asking or inviting politely", ["qing"]),
      V("duibuqi", "对不起", "duìbuqǐ", "sorry", "dway-boo-chee", ["对不起，我迟到了。", "Duìbuqǐ, wǒ chídào le.", "Sorry, I’m late."], "Apologising", ["duibuqi"]),
      V("shide", "是的", "shì de", "yes", "shuh duh", ["是的，我是学生。", "Shì de, wǒ shì xuésheng.", "Yes, I am a student."], "Answering", ["shide", "shi de"]),
      V("bushi", "不是", "bú shì", "no; it is not", "boo shuh", ["不是，这是水。", "Bú shì, zhè shì shuǐ.", "No, this is water."], "Answering", ["bushi", "bu shi"]),
    ],
  },
  {
    id: "zh-v2", lang: "zh", level: "beginner", kind: "vocab", category: "Numbers and dates", title: "Numbers 1 to 10",
    objective: "Say and use the numbers one to ten in short sentences.",
    vocab: [
      V("n1", "一", "yī", "one", "ee", ["现在是一月。", "Xiànzài shì yīyuè.", "It’s January now."], "Counting; 一月 = January", ["yi"]),
      V("n2", "二", "èr", "two", "ar", ["二月很冷。", "Èryuè hěn lěng.", "February is cold."], "Counting; 二月 = February", ["er"]),
      V("n3", "三", "sān", "three", "sahn", ["现在三点钟。", "Xiànzài sān diǎn zhōng.", "It is three o’clock now."], "Counting and telling the time", ["san"]),
      V("n4", "四", "sì", "four", "suh", ["我有四本书。", "Wǒ yǒu sì běn shū.", "I have four books."], "Counting", ["si"]),
      V("n5", "五", "wǔ", "five", "woo", ["五点见。", "Wǔ diǎn jiàn.", "See you at five."], "Counting and the time", ["wu"]),
      V("n6", "六", "liù", "six", "lyoh", ["这里有六个人。", "Zhèlǐ yǒu liù ge rén.", "There are six people here."], "Counting", ["liu"]),
      V("n7", "七", "qī", "seven", "chee", ["我七点起床。", "Wǒ qī diǎn qǐchuáng.", "I get up at seven."], "Counting and the time", ["qi"]),
      V("n8", "八", "bā", "eight", "bah", ["这个八块钱。", "Zhège bā kuài qián.", "This costs eight yuan."], "Counting and prices", ["ba"]),
      V("n9", "九", "jiǔ", "nine", "jyoh", ["九点上课。", "Jiǔ diǎn shàngkè.", "Class starts at nine."], "Counting and the time", ["jiu"]),
      V("n10", "十", "shí", "ten", "shuh", ["我买了十个苹果。", "Wǒ mǎi le shí ge píngguǒ.", "I bought ten apples."], "Counting", ["shi"]),
    ],
  },
];
