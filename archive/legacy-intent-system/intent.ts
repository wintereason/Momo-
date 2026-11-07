/**
 * Deterministic intent router (no AI call). Classifies an utterance as a task for Momo,
 * unrelated speech, or ambiguous, and picks the smallest capability that can answer it.
 * English patterns only for now.
 */
export type Intent =
  | { kind: "drive_space"; drive?: string } // no drive = all drives
  | { kind: "active_window" }
  | { kind: "list_windows" }
  | { kind: "find_folder"; query: string }
  | { kind: "open_folder"; query: string }
  | { kind: "open_app"; query: string } //        start an installed application
  | { kind: "open_in_vscode"; query: string } //   open a folder in Visual Studio Code (an app adapter)
  | { kind: "open_url"; url: string } //           open a web address in the default browser
  | { kind: "list_tabs"; browser?: string } //     list browser windows and their tabs
  | { kind: "current_page"; browser?: string } //  what site/page the browser is showing
  | { kind: "switch_tab"; query: string; browser?: string }
  | { kind: "focus_window"; query: string } //  bring a window to the front
  | { kind: "minimize_window"; query?: string } // no query = the window the user was just in
  | { kind: "close_window"; query?: string }
  | { kind: "click_control"; label: string } //  click a named button/link/tab in the window the user was just in
  | { kind: "set_text"; text: string; field: string } // type text into a named field there
  | { kind: "list_accounts"; browser?: string; mailWord?: boolean } // the accounts (emails) signed in to a browser's profiles
  | { kind: "open_browser"; browser: "chrome" | "msedge" | "brave"; hint?: string; site?: { url: string; host: string } } // a browser, with an account described by the user, and/or a website
  | { kind: "explain_screen" } //                  read the window the user was just in and EXPLAIN it (needs the AI)
  | { kind: "read_screen"; focus?: "error" } // read the text of the window the user was just in
  | { kind: "list_controls" } //               list that window's buttons and controls
  | { kind: "unsupported"; verb: string } // a real task, but not read-only / not built yet
  | { kind: "ambiguous"; question: string }
  | { kind: "unrelated" };

export const HELP_QUESTION =
  "I'm not sure what you'd like. Right now I can check drive space, tell you which window is active, list open windows, find or open a folder, or read what's in the window you were just using. Which one?";

const FILLER = new Set([
  "find", "locate", "where", "is", "s", "my", "the", "a", "an", "folder", "folders", "directory", "directories",
  "project", "called", "named", "for", "look", "search", "me", "please", "can", "you", "tell", "show", "on",
  "this", "pc", "computer", "laptop", "in", "of", "to", "i", "do", "have", "momo", "hey", "hi", "it", "that",
  "open", "launch", "go", "take", "up", "at", "explorer", "file",
]);

function stripWake(raw: string): string {
  return raw.trim().replace(/^(hey|hi|ok|okay)?[\s,]*momo[\s,.:!-]*/i, "");
}

/** The drive letter the user meant, if any. Spoken "a"/"i" are only accepted as "A:"/"I:" to avoid the words. */
export function extractDrive(text: string): string | undefined {
  const colon = text.match(/\b([A-Za-z]):/);
  if (colon) return colon[1].toUpperCase();
  const after = text.match(/\b(?:drive|disk|disc|volume)\s+(?:letter\s+)?([A-Za-z])\b/i);
  if (after && !/^[aAiI]$/.test(after[1])) return after[1].toUpperCase();
  const before = text.match(/\b([A-Za-z])\s+(?:drive|disk|disc|volume)\b/);
  if (before && !/^[aAiI]$/.test(before[1])) return before[1].toUpperCase();
  return undefined;
}

import { cleanAppQuery, normalizeUrl, siteUrl } from "../apps";
import { browserFromWords } from "../browser";

const FOLDER_WORDS = new Set([
  "the", "my", "a", "an", "folder", "folders", "directory", "project", "please", "this", "that", "open", "launch", "start",
  "it", "up", "files", "file", "for", "me", "named", "called",
]);
const POLITE = "(?:please |can you |could you |would you )?";
const WINDOW_WORDS = new Set(["window", "windows", "app", "application", "program", "the", "my", "this", "that", "please", "up", "forward", "front", "to", "a", "an"]);
const stripWords = (s: string, drop: Set<string>) => s.split(" ").filter((w) => w && !drop.has(w)).join(" ").trim();
const trimQuotes = (s: string) => s.trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
const KEY_NAMES = /^(enter|return|escape|esc|tab|space|spacebar|backspace|delete key|ctrl|control|alt|shift|windows key|win|key|keys|f\d{1,2}|arrow|page up|page down)\b/;

/** Commands that DO something to a window or control. Null when the sentence isn't one. */
export function classifyAction(original: string, t: string): Intent | null {
  // ---- click <label>
  const click = t.match(new RegExp("^" + POLITE + "(?:click|press|tap|hit|push|select)\\b(?: on)?\\s*(.*)$"));
  if (click) {
    const rest = click[1].trim();
    if (!rest || /^(it|that|this|here)$/.test(rest)) return { kind: "ambiguous", question: "What should I click? Tell me the name on the button, like “click Save”." };
    if (KEY_NAMES.test(rest)) return { kind: "unsupported", verb: "press keys" }; // raw keystrokes can't be targeted or verified
    const label = rest.replace(/^(the|a|an|on)\s+/, "").replace(/\s+(button|link|tab|option|checkbox|check box|icon|menu item|menu|radio button)$/, "").trim();
    return label ? { kind: "click_control", label } : { kind: "ambiguous", question: "What should I click?" };
  }

  // ---- type <text> in <field>   (the typed text keeps the user's own capitalisation)
  const type = original.match(new RegExp("^" + POLITE + "(?:type|enter|write|fill in|fill|put)\\b\\s+(.+)$", "i"));
  if (type) {
    const body = type[1].trim();
    const seps = [...body.matchAll(/\s+(?:in|into|on|inside)\s+(?:the\s+|my\s+)?/gi)];
    const last = seps[seps.length - 1];
    if (!last || last.index === undefined) return { kind: "ambiguous", question: "Where should I type that? Say, for example, “type hello in the search box”." };
    const text = trimQuotes(body.slice(0, last.index)).slice(0, 500);
    const field = body.slice(last.index + last[0].length).toLowerCase().replace(/[?!.,]+$/, "")
      .replace(/\s+(box|field|bar|input|area|textbox|text box|editor)$/, "").trim();
    if (!text) return { kind: "ambiguous", question: "What should I type?" };
    if (!field) return { kind: "ambiguous", question: "Which field should I type it in?" };
    return { kind: "set_text", text, field };
  }

  // ---- "how many emails/accounts do I have in Chrome?" -> list the browser's profiles (read-only, from the browser's own settings)
  if (/^(?:please |can you |could you |hey )?(?:tell|show|list|name|what|which|how many|give)\b/.test(t) && /\b(?:e-?mails?|accounts?|profiles?)\b/.test(t)
      && !/\b(?:send|write|compose|delete|read|check|unread|inbox|messages?)\b/.test(t)) {
    const b = browserFromWords(t);
    if (b && !/^(chrome|msedge|brave)$/.test(b)) return { kind: "unsupported", verb: "listing accounts in that browser" };
    return { kind: "list_accounts", browser: b, mailWord: /\be-?mails?\b/.test(t) && !b };
  }

  // ---- a browser with an account and/or a site, in one sentence:
  //      "open chrome and go to the panda icon email and open youtube", "open youtube in chrome with my work account"
  const ACCOUNT_WORDS = /\b(icon|avatar|profile|account|email|emails|face|picture|photo)\b/;
  const STEP = /\b(?:(?:and|then)\s+)+(?:also\s+)?(?:open|go to|goto|visit|launch|use|select|pick|choose|switch to)\s+/;
  const browserKey = (w: string): "chrome" | "msedge" | "brave" => (w === "edge" ? "msedge" : (w as "chrome" | "brave"));
  const asBrowser = t.match(new RegExp("^" + POLITE + "(?:open|launch|start)\\s+(?:google\\s+|microsoft\\s+)?(chrome|edge|brave)\\b(.*)$"));
  if (asBrowser && asBrowser[2].trim()) {
    let hint: string | undefined;
    let site: { url: string; host: string } | undefined;
    let understood = true;
    for (const part of asBrowser[2].split(STEP)) {
      const seg = part.trim();
      if (!seg) continue;
      if (ACCOUNT_WORDS.test(seg)) hint = hint ? hint + " " + seg : seg;
      else { const s = siteUrl(seg); if (s) site = s; else understood = false; }
    }
    if (understood && (hint || site)) return { kind: "open_browser", browser: browserKey(asBrowser[1]), hint, site };
  }
  const siteInBrowser = t.match(new RegExp("^" + POLITE + "(?:open|go to|visit|launch)\\s+(.+?)\\s+(?:in|on|with|using)\\s+(?:google\\s+|microsoft\\s+)?(chrome|edge|brave)\\b(.*)$"));
  if (siteInBrowser) {
    const site = siteUrl(siteInBrowser[1]);
    const tail = siteInBrowser[3].trim();
    if (site && (!tail || ACCOUNT_WORDS.test(tail))) return { kind: "open_browser", browser: browserKey(siteInBrowser[2]), hint: tail || undefined, site };
  }

  // ---- a bare "open" / "launch": say what to open
  if (new RegExp("^" + POLITE + "(?:open|launch|start)\\s*$").test(t)) return { kind: "ambiguous", question: "What should I open? Tell me an app, a folder or a website." };

  // ---- browser tabs: "switch to the gmail tab"
  const tab = t.match(new RegExp("^" + POLITE + "(?:switch to|go to|open|show|select|activate|bring up)\\b(.*)\\btab\\b(.*)$"));
  if (tab) {
    const browser = browserFromWords(t);
    const drop = new Set([...WINDOW_WORDS, "tab", "in", "on", "chrome", "google", "edge", "microsoft", "firefox", "brave", "opera", "vivaldi", "browser"]);
    const query = stripWords(`${tab[1]} ${tab[2]}`, drop);
    return query ? { kind: "switch_tab", query, browser } : { kind: "ambiguous", question: "Which tab should I switch to?" };
  }

  // ---- open <something>: a folder in VS Code, a website, or an installed app (folders are handled further down)
  const opener = t.match(new RegExp("^" + POLITE + "(?:open|launch|start|visit|browse to|navigate to)\\b\\s+(.+)$"));
  const goTo = t.match(new RegExp("^" + POLITE + "go to\\b\\s+(.+)$"));
  const rest = (opener?.[1] ?? goTo?.[1] ?? "").trim();
  if (rest) {
    const inCode = rest.match(/^(.*?)\s+(?:in|with|using)\s+(?:vs ?code|visual studio code|vscode|code)\b.*$/);
    if (inCode && opener) {
      const query = stripWords(inCode[1], FOLDER_WORDS);
      return query ? { kind: "open_in_vscode", query } : { kind: "ambiguous", question: "Which folder should I open in Visual Studio Code?" };
    }
    const asUrl = normalizeUrl(original.trim().replace(/^(?:please |can you |could you |would you )?(?:open|launch|start|visit|browse to|navigate to|go to)\s+/i, ""));
    if (asUrl && !/\b(folder|folders|directory|directories)\b/.test(rest)) return { kind: "open_url", url: asUrl.url };
    if (opener && !/\b(folder|folders|directory|directories|project)\b/.test(rest)) {
      if (/\s(?:and|then|after that)\s/.test(rest)) return { kind: "unsupported", verb: "more than one step" };
      if (/\s(?:in|with|using)\s/.test(rest) && !/\s(?:in|with|using)$/.test(rest)) return { kind: "unsupported", verb: "open in another app" };
      const app = cleanAppQuery(rest);
      if (app && !/^(it|this|that|window|windows|something|anything)$/.test(app)) return { kind: "open_app", query: app };
      return { kind: "ambiguous", question: "Which app should I open?" };
    }
  }

  // ---- window commands
  const focus = t.match(new RegExp("^" + POLITE + "(?:switch to|go to|bring up|bring|focus on|focus|activate)\\b\\s*(.*)$"));
  if (focus && !/\b(folder|folders|directory|directories|project)\b/.test(t)) {
    const query = stripWords(focus[1], WINDOW_WORDS);
    return query ? { kind: "focus_window", query } : { kind: "ambiguous", question: "Which window should I switch to?" };
  }
  const min = t.match(new RegExp("^" + POLITE + "minimi[sz]e\\b\\s*(.*)$"));
  if (min) {
    const query = stripWords(min[1], WINDOW_WORDS);
    return query ? { kind: "minimize_window", query } : { kind: "minimize_window" };
  }
  const close = t.match(new RegExp("^" + POLITE + "(?:close|quit|exit)\\b\\s*(.*)$"));
  if (close) {
    const rest = close[1];
    const query = stripWords(rest, WINDOW_WORDS);
    if (!rest.trim()) return { kind: "ambiguous", question: "What should I close?" };
    return query && !/^(it|everything|all)$/.test(query) ? { kind: "close_window", query } : { kind: "close_window" };
  }
  return null;
}

export function classify(raw: string): Intent {
  const original = stripWake(raw);
  const t = original.toLowerCase().replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  // "Momo?" on its own is someone talking to Momo without saying what they want
  if (!t) return /\bmomo\b/i.test(raw) ? { kind: "ambiguous", question: HELP_QUESTION } : { kind: "unrelated" };

  // --- read-only capabilities Momo has now
  const storageWord = /\b(storage|space|capacity|free|used|full|size|gb|gigabytes?|how much)\b/.test(t);
  const driveWord = /\b(drive|drives|disk|disks|disc|volume)\b|\b[a-z]:/i.test(original);
  // Phase C only knows about disk storage, so these phrases are unambiguous even without the word "drive"
  const plainStorage = /\b(storage|disk space|free space|space left|space is (left|free)|how much space)\b/.test(t);
  if ((storageWord && driveWord) || plainStorage || /\b(list|which|what)\b.*\bdrives\b/.test(t)) {
    return { kind: "drive_space", drive: extractDrive(original) };
  }

  // --- acting on windows and controls. Anchored at the START of the sentence so questions can't be mistaken for commands.
  const act = classifyAction(original, t);
  if (act) return act;

  // --- browser: which tabs, which page (browsing data is private, so these go through the safety gate)
  if (/\btabs\b/.test(t) && /\b(what|which|list|show|how many|name|are there|do i have|have i got)\b/.test(t)) {
    return { kind: "list_tabs", browser: browserFromWords(t) };
  }
  if (/\b(what|which)\s+(page|website|site|webpage|url)\b/.test(t) || /\bwhat('?s| is)\s+this\s+(page|website|site|webpage)\b/.test(t)) {
    return { kind: "current_page", browser: browserFromWords(t) };
  }

  // --- looking at the window the user was just in (reads private content, so it goes through the safety gate)
  const mentionsScreen = /\b(screen|window|page|this|here)\b/.test(t);
  // "explain this error", "what does this message mean", "why is it failing", "help me fix this"
  if (/\b(explain|help me (with|fix|understand)|what('?s| is) wrong with)\b/.test(t) && (mentionsScreen || /\b(error|message|warning|failing|failure|exception)\b/.test(t))) return { kind: "explain_screen" };
  if (/\bwhat does (this|that|the) (error|message|warning|text|screen|window)\b.*\bmean\b/.test(t)) return { kind: "explain_screen" };
  if (/\bwhy (is|am i|did|does)\b.*\b(error|failing|failed|not working|crash\w*|broken)\b/.test(t) && mentionsScreen) return { kind: "explain_screen" };
  if (/\b(buttons|controls|clickable)\b/.test(t) && /\b(what|which|list|show|name|are)\b/.test(t)) {
    return { kind: "list_controls" };
  }
  if (/\bwhat can i (click|press|do here)\b/.test(t)) return { kind: "list_controls" };
  const readVerb = /\b(read|scan|look at|what do you see|what can you see)\b/.test(t);
  const whatsOn = /\bwhat('?s| is| does| do)\b.*\b(on|in|say|says|show|shows|written)\b.*\b(screen|window|page)\b/.test(t) ||
                  /\bwhat\b.*\b(window|screen|page)\b.*\b(say|says|show|shows)\b/.test(t);
  const errorAsk = /\b(error|exception|warning|message)\b/.test(t) && /\bwhat('?s| is| does)\b/.test(t) && mentionsScreen;
  if ((readVerb && (mentionsScreen || /\b(error|message|text)\b/.test(t))) || whatsOn || errorAsk) {
    return /\b(error|exception|warning|failed|failure)\b/.test(t) ? { kind: "read_screen", focus: "error" } : { kind: "read_screen" };
  }

  // "which window is active" and "what's the active window" (either word order)
  const activeWord = /\b(active|current|focused|foreground|in front|on top)\b/.test(t);
  const windowWord = /\b(window|app|application|program)\b/.test(t);
  if ((activeWord && windowWord) ||
      /\bwhat\b.*\b(window|app|application|program)\b.*\b(am i|i am)\b/.test(t)) {
    return { kind: "active_window" };
  }

  if (/\b(open|running)\b.*\b(windows|apps|applications|programs)\b/.test(t) ||
      /\b(list|show|what|which)\b.*\b(windows|apps|applications|programs)\b/.test(t) ||
      /\bwhat('?s| is) open\b/.test(t)) {
    return { kind: "list_windows" };
  }

  if (/\b(find|locate|where|look for|search for)\b/.test(t) && /\b(folder|folders|directory|directories|project)\b/.test(t)) {
    const query = t.split(" ").filter((w) => !FILLER.has(w)).join(" ").trim();
    if (!query) return { kind: "ambiguous", question: "Which folder are you looking for?" };
    return { kind: "find_folder", query };
  }

  // opening a folder in File Explorer (the first thing Momo can DO, so it goes through the safety gate)
  if (/^(?:please |can you |could you )?(open|launch|go to|take me to)\b/.test(t) && /\b(folder|folders|directory|directories|project)\b/.test(t)) {
    // "open X in VS Code" means an application, which Momo can't drive yet
    if (/\b(in|with|using)\s+(vs ?code|visual studio( code)?|code|notepad|chrome|firefox|edge|terminal|cmd|powershell)\b/.test(t)) {
      return { kind: "unsupported", verb: "open in another app" };
    }
    const query = t.split(" ").filter((w) => !FILLER.has(w)).join(" ").trim();
    if (!query) return { kind: "ambiguous", question: "Which folder should I open?" };
    return { kind: "open_folder", query };
  }
  // --- tasks Momo understands but cannot do yet: say so honestly instead of guessing
  const verb = t.match(/^(?:please |can you |could you )?(open|launch|start|close|delete|remove|send|type|click|install|download|run|play|write|create|rename|move|copy|call|message)\b/);
  if (verb) return { kind: "unsupported", verb: verb[1] };

  // --- looks addressed to Momo but unclear
  if (/\bmomo\b/i.test(raw) || /^(what|how|where|which|tell me|show me|can you|could you|please)\b/.test(t)) {
    return { kind: "ambiguous", question: HELP_QUESTION };
  }

  return { kind: "unrelated" };
}

// ---- answering a pending "which one?" question

export type Choice = { kind: "pick"; index: number } | { kind: "cancel" } | { kind: "unclear" };

const ORDINALS: [RegExp, number][] = [
  [/\b(first|1st|number one|1)\b/, 0], [/\b(second|2nd|two|2)\b/, 1], [/\b(third|3rd|three|3)\b/, 2],
  [/\b(fourth|4th|four|4)\b/, 3], [/\b(fifth|5th|five|5)\b/, 4],
];

/** Resolve a spoken/typed answer against the offered paths. Never guesses between several matches. */
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
