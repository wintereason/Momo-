import type { Lesson, Symbol, VocabItem } from "./types";

const S = (id: string, char: string, roman: string, guide: string, ex?: [string, string, string]): Symbol => ({ id: `ko-${id}`, char, roman, guide, example: ex ? { text: ex[0], roman: ex[1], meaning: ex[2] } : undefined });
const V = (id: string, text: string, roman: string, meaning: string, guide: string, ex: [string, string, string], context: string, accept?: string[]): VocabItem => ({ id: `ko-${id}`, text, roman, meaning, guide, example: { text: ex[0], roman: ex[1], meaning: ex[2] }, context, accept: [roman, ...(accept ?? [])] });

export const KOREAN_LESSONS: Lesson[] = [
  {
    id: "ko-w1", lang: "ko", level: "beginner", kind: "writing", title: "Hangul vowels",
    objective: "Recognise the ten basic Hangul vowels and say each one.",
    symbols: [
      S("a", "ㅏ", "a", "“ah”, as in “father”", ["아이", "ai", "child"]),
      S("ya", "ㅑ", "ya", "“yah”"),
      S("eo", "ㅓ", "eo", "like the “u” in “cup”, with a rounder mouth"),
      S("yeo", "ㅕ", "yeo", "“yuh”"),
      S("o", "ㅗ", "o", "“oh”, as in “go”"),
      S("yo", "ㅛ", "yo", "“yoh”"),
      S("u", "ㅜ", "u", "“oo”, as in “moon”"),
      S("yu", "ㅠ", "yu", "“yoo”"),
      S("eu", "ㅡ", "eu", "“uh”, as in “put”, with the lips spread flat"),
      S("i", "ㅣ", "i", "“ee”, as in “see”"),
    ],
  },
  {
    id: "ko-w2", lang: "ko", level: "beginner", kind: "writing", title: "Hangul consonants, part 1",
    objective: "Recognise the consonants ㄱ ㄴ ㄷ ㄹ ㅁ ㅂ ㅅ and their sounds.",
    symbols: [
      S("g", "ㄱ", "g / k", "“g” at the start of a word, closer to “k” in the middle; name: giyeok"),
      S("n", "ㄴ", "n", "“n”; name: nieun"),
      S("d", "ㄷ", "d / t", "“d” at the start of a word, closer to “t” in the middle; name: digeut"),
      S("r", "ㄹ", "r / l", "a quick “r” between vowels, “l” at the end of a syllable; name: rieul"),
      S("m", "ㅁ", "m", "“m”; name: mieum"),
      S("b", "ㅂ", "b / p", "“b” at the start of a word, closer to “p” in the middle; name: bieup"),
      S("s", "ㅅ", "s", "“s”, but “sh” before ㅣ; name: siot"),
    ],
  },
  {
    id: "ko-w3", lang: "ko", level: "beginner", kind: "writing", title: "Hangul consonants, part 2",
    objective: "Recognise the consonants ㅇ ㅈ ㅊ ㅋ ㅌ ㅍ ㅎ and their sounds.",
    symbols: [
      S("ng", "ㅇ", "silent / ng", "silent at the start of a syllable (it holds the place of a consonant); “ng” as in “sing” at the end; name: ieung"),
      S("j", "ㅈ", "j", "“j”, as in “jam”; name: jieut"),
      S("ch", "ㅊ", "ch", "“ch” with a strong puff of breath; name: chieut"),
      S("k", "ㅋ", "k", "“k” with a strong puff of breath; name: kieuk"),
      S("t", "ㅌ", "t", "“t” with a strong puff of breath; name: tieut"),
      S("p", "ㅍ", "p", "“p” with a strong puff of breath; name: pieup"),
      S("h", "ㅎ", "h", "“h”, as in “hat”; name: hieut"),
    ],
  },
  {
    id: "ko-w4", lang: "ko", level: "beginner", kind: "writing", title: "Hangul syllable blocks",
    objective: "Read simple syllable blocks made of a consonant and a vowel, and blocks with a final consonant.",
    symbols: [
      S("ga", "가", "ga", "ㄱ + ㅏ: the consonant goes on the left, the vowel on the right", ["가수", "gasu", "singer"]),
      S("na", "나", "na", "ㄴ + ㅏ", ["나라", "nara", "country"]),
      S("da", "다", "da", "ㄷ + ㅏ"),
      S("ma", "마", "ma", "ㅁ + ㅏ"),
      S("ba", "바", "ba", "ㅂ + ㅏ", ["바다", "bada", "sea"]),
      S("sa", "사", "sa", "ㅅ + ㅏ"),
      S("blk-a", "아", "a", "ㅇ (silent) + ㅏ: the silent ㅇ fills the consonant place"),
      S("go", "고", "go", "ㄱ + ㅗ: with ㅗ, ㅜ, ㅡ the vowel goes underneath", ["고기", "gogi", "meat"]),
      S("han", "한", "han", "ㅎ + ㅏ + ㄴ: a final consonant (batchim) goes at the bottom", ["한국", "hanguk", "Korea"]),
      S("geul", "글", "geul", "ㄱ + ㅡ + ㄹ", ["한글", "hangeul", "the Korean alphabet"]),
    ],
  },
  {
    id: "ko-v1", lang: "ko", level: "beginner", kind: "vocab", category: "Greetings and introductions", title: "Greetings and introductions",
    objective: "Greet, say goodbye, thank, apologise, ask politely and answer yes or no in Korean.",
    vocab: [
      V("annyeong", "안녕하세요", "annyeonghaseyo", "hello", "ahn-nyuhng-ha-seh-yo", ["안녕하세요, 만나서 반갑습니다.", "Annyeonghaseyo, mannaseo bangapseumnida.", "Hello, nice to meet you."], "A polite greeting at any time of day"),
      V("annyeonghi", "안녕히 가세요", "annyeonghi gaseyo", "goodbye (said to someone who is leaving)", "ahn-nyuhng-hee ga-seh-yo", ["안녕히 가세요, 내일 봐요.", "Annyeonghi gaseyo, naeil bwayo.", "Goodbye, see you tomorrow."], "Said by the person who stays; the person leaving says 안녕히 계세요"),
      V("gamsa", "감사합니다", "gamsahamnida", "thank you", "gam-sa-ham-ni-da", ["도와주셔서 감사합니다.", "Dowajusyeoseo gamsahamnida.", "Thank you for helping me."], "Thanking someone politely"),
      V("ne", "네", "ne", "yes", "neh", ["네, 알겠습니다.", "Ne, algetseumnida.", "Yes, I understand."], "Answering"),
      V("aniyo", "아니요", "aniyo", "no", "ah-nee-yo", ["아니요, 괜찮아요.", "Aniyo, gwaenchanayo.", "No, it’s okay."], "Answering"),
      V("mian", "미안합니다", "mianhamnida", "I’m sorry", "mee-an-ham-ni-da", ["늦어서 미안합니다.", "Neujeoseo mianhamnida.", "I’m sorry I’m late."], "Apologising"),
      V("juseyo", "주세요", "juseyo", "please give me", "joo-seh-yo", ["물 좀 주세요.", "Mul jom juseyo.", "Please give me some water."], "Asking for something politely; said after the thing you want"),
      V("achim", "좋은 아침", "joeun achim", "good morning", "jo-eun ah-chim", ["좋은 아침입니다.", "Joeun achimimnida.", "Good morning."], "Greeting in the morning"),
    ],
  },
  {
    id: "ko-v2", lang: "ko", level: "beginner", kind: "vocab", category: "Numbers and dates", title: "Numbers 1 to 10 (native Korean)",
    objective: "Say and recognise the native Korean numbers one to ten, used for counting things and telling the hour.",
    vocab: [
      V("hana", "하나", "hana", "one", "ha-na", ["사과 하나 주세요.", "Sagwa hana juseyo.", "One apple, please."], "Counting things"),
      V("dul", "둘", "dul", "two", "dool", ["커피 둘 주세요.", "Keopi dul juseyo.", "Two coffees, please."], "Counting things"),
      V("set", "셋", "set", "three", "set", ["친구가 셋 있어요.", "Chinguga set isseoyo.", "I have three friends."], "Counting things"),
      V("net", "넷", "net", "four", "net", ["학생이 넷 있어요.", "Haksaengi net isseoyo.", "There are four students."], "Counting things"),
      V("daseot", "다섯", "daseot", "five", "da-suht", ["지금 다섯 시예요.", "Jigeum daseot siyeyo.", "It is five o’clock now."], "Counting and the hour"),
      V("yeoseot", "여섯", "yeoseot", "six", "yuh-suht", ["여섯 시에 일어나요.", "Yeoseot sie ireonayo.", "I wake up at six."], "Counting and the hour"),
      V("ilgop", "일곱", "ilgop", "seven", "il-gop", ["일곱 시에 만나요.", "Ilgop sie mannayo.", "Let’s meet at seven."], "Counting and the hour"),
      V("yeodeol", "여덟", "yeodeol", "eight", "yuh-duhl", ["여덟 시에 시작해요.", "Yeodeol sie sijakaeyo.", "It starts at eight."], "Counting and the hour"),
      V("ahop", "아홉", "ahop", "nine", "a-hop", ["아홉 시에 자요.", "Ahop sie jayo.", "I go to sleep at nine."], "Counting and the hour"),
      V("yeol", "열", "yeol", "ten", "yuhl", ["열 시예요.", "Yeol siyeyo.", "It’s ten o’clock."], "Counting and the hour"),
    ],
  },
];
