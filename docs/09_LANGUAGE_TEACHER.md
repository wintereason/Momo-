# Momo's Language Teacher

A structured language course inside Momo: writing system, vocabulary, practice that must be passed, goals, and a final spoken interview. Open it in **Settings → Learn a language**.

## What is built

| Part | Where |
|---|---|
| Authored content (French, Korean, Mandarin, Japanese; beginner level) | `src/learning/content/` |
| Activity generation and answer evaluation | `src/learning/activities.ts`, `text.ts` |
| Progression rules (unlock, fail, revision, levels) | `src/learning/progress.ts` |
| Goals and the "what next" recommendation | `src/learning/goals.ts` |
| Saved progress, one profile per learner | `src/learning/state.ts`, `store.ts` |
| Interview scenarios, session engine | `src/learning/interview/scenarios.ts`, `engine.ts` |
| **Interview data contract (versioned)** | `src/learning/interview/contract.ts` |
| The AI that plays the other role (a runtime specialist) | `src/runtime-core/languageTeacher/` |
| Screens | `src/settings/pages/LearnPage.tsx`, `src/learning/ui/` |

The Language Teacher is a specialist role of the runtime (helper agent `.claude/agents/momo-language-teacher.md`). The orchestrator owns it: `Session.converse()` runs the role, and the read-only tool `language_progress` lets the orchestrator answer "how is my learning going / what should I study next?". The role has no tools, no desktop access and no access to the learner's progress; the AI gets only the scene, the level and the conversation lines.

## How learning works

* **Setup:** choose a target language (the native language is English; only English explanations are written so far). The writing system is shown for the language: Latin, Hangul, Hiragana, or Han characters with Pinyin and tone marks. Nothing assumes the English alphabet.
* **Lessons** have a stated objective and are either *writing* (every letter or symbol with its romanization and a learner-friendly pronunciation guide, plus audio) or *vocabulary* (word, meaning, pronunciation guide, audio, example sentence, context).
* **Activities, in order:** match, recognise, identify from audio, translate (typed), fill the missing word, listen and repeat, say a sentence. A question counts only when it has been **answered and evaluated**; the next activity unlocks only when the current one is complete; opening a lesson changes nothing.
* **Passing:** the share of *checkable* answers that are right must reach the pass mark (default 80%, configurable). Speaking activities must be completed but never decide the pass mark (see Accuracy below).
* **Failing:** the lesson becomes *Revision needed* and the next lesson stays locked. A revision attempt is built from the missed items and must be passed (this can be switched off in Course settings); only then can the lesson be retaken. Passing the lesson opens the next one.
* **Adaptive difficulty:** from the last three finished attempts: more wrong options and no romanization hints when the learner does well, fewer when they struggle.
* **Mastery:** a word counts as *learned* only after it was right in several finished attempts (a mistake sets it back), not after one lucky pass.
* **Levels:** beginner is written. Intermediate and advanced are shown as "coming" and cannot be opened. The next level opens when every lesson of this level is passed **and** (if required) the final interview is completed.
* **Goals:** learn N words, master the writing system, complete N lessons, pass the beginner level, complete an interview, practise speaking N times. Progress is computed from real results.
* **Resume:** an unfinished attempt (and an unfinished interview) is saved after every answer and picked up after a restart.

## The final interview

The last stage of a level. Available when every lesson of the level is passed. The learner picks a scene (job interview, restaurant, shopping, airport and travel, classroom, everyday conversation, or a custom scene) and **which role to play**; Momo's AI plays the other. Voice (existing microphone and speech recognition, in the target language) or typing; Momo's lines are spoken with the installed voices and shown in a speech cloud and in the transcript, with an optional English translation and romanization (both labelled AI-generated).

The AI is told to stay in role, speak only the target language at the learner's level, ask one question at a time, base follow-ups on what the learner really said, handle off-topic or unexpected answers naturally, give no feedback during the conversation, and treat everything in `<learner>` tags as data.

Interruptions (stop Momo talking), retries (when the AI could not answer), leaving, resuming and retaking are all supported. The interview **counts as completed** when the learner gave at least a configurable number of real answers (default 6). This is a completion rule, **not a score**.

## Reporting is not built here

The interview report, mistake analysis, recommendations and report storage belong to another team. This module only **executes** the interview and publishes the session data below. There is no scorecard and no report screen.

### The interview session contract, version 1

`src/learning/interview/contract.ts` defines `InterviewSessionV1` (zod schema `InterviewSessionSchema`, contract name `momo.interview-session`, `version: 1`).

A completed session contains:

| Field | Meaning |
|---|---|
| `sessionId`, `profileId` | the session, and an opaque learner id (never the learner's name) |
| `status`, `createdAt`, `endedAt`, `events[]` | `in_progress`/`completed`/`abandoned`; started, resumed, interrupted, retry, ai-error, completed, abandoned |
| `language` | `{ code, name, script, tonal }` |
| `course` | `{ level, lessonsPassed, lessonsTotal, passScore, difficulty }` |
| `scenario` | `{ id, title, setting, userRole, aiRole, custom }` |
| `objectives[]` | the communication objectives the scene steered toward |
| `questions[]` | the AI's questions (`turn`, `text`, `objective`) |
| `turns[]` | every turn: `speaker`, `role`, exact `text`, `at`; AI turns add `translation`, `romanization` (AI-generated), `objective`, `kind`; learner turns add `input` and `evidence` |
| `turns[].input` | `{ mode: "typed"\|"spoken", transcript?, engine?, durationMs?, audioRef: null }`. Audio is **never** stored, so `audioRef` is always `null` |
| `turns[].evidence` | facts only: `scriptRatio` (share of letters in the language's own script; `null` for Latin), `units` (words, or characters), `usedVocabIds` (course vocabulary actually used), `empty` |
| `completion` | `{ countsAsCompleted, userTurns, minTurns, reason }`: basic status only |
| `speech` | `{ spokenTurns, pronunciationAssessed: false }`: pronunciation is explicitly **not** assessed |

It carries facts only: no score, no mistakes, no recommendations.

### Consuming it

```ts
import { interviewBus, type InterviewConsumer } from "src/learning/interview/contract";

const reporting: InterviewConsumer = {
  id: "reporting",
  contractVersion: 1,
  async onSessionCompleted(session) { /* build the report from `session` */ },
};
const unregister = interviewBus.register(reporting);
```

* `interviewBus.publish(session)` is called by the interview screen when a session is completed. Each consumer receives a **deep-frozen copy** exactly once; a consumer cannot change what the engine or other consumers see, and cannot touch the learner's progress.
* A consumer that throws never breaks the others or the learner's flow.
* Only completed sessions are published. A consumer can also read saved sessions (`LearningState.sessions`) for past interviews.
* Compatibility: version 1 only ever **gains optional fields**. Anything else becomes version 2, published alongside. A consumer declares `contractVersion` and registration of an unsupported version fails.
* Tests use a **mock reporting adapter** (`interview.test.ts`) to prove delivery; it is not a production reporter.

## Accuracy and honesty

* All lesson content (alphabets, vocabulary, examples, pronunciation guides) is authored in the repository; nothing is generated at run time. If a language or level has no content, the app says so.
* **Pronunciation is never claimed to be verified.** Speaking practice compares what the speech recognizer *heard* with the target text. That is an *automated estimate*: it cannot judge accent quality, vowel length or tones, and regional accents are normal. For Mandarin the screen says tones cannot be checked from a transcript. Estimates are stored with `verified: false` and never decide a pass.
* A genuine mistake versus a legitimate accent cannot be separated by transcription alone; the app does not pretend to.
* AI translations and romanizations in the interview are labelled *AI-generated, may contain mistakes*. Pronunciation guides shown under a line come only from the authored course vocabulary.

## Privacy

* Progress is stored on this PC only (`momo.learning.v1`), one profile per learner; profiles never see each other's data. "Delete my data" removes it.
* No audio is ever stored. Speaking practice is transcribed in memory.
* The interview sends only the scene, the level and the conversation lines to the learner's chosen AI service (the screen says which; Ollama keeps it on the PC). No name, no progress, nothing from the screen. Each interview line is one AI request against the daily free limit.

## Known limits

* Beginner level only, four languages, English explanations only.
* Intermediate and advanced courses, a wider vocabulary and more writing practice (stroke order, handwriting) are not written.
* Interview quality depends on the free AI service; it can be busy or wrong. Retry is offered.
* Speech recognition for Korean, Japanese and Chinese uses the local Whisper model or the optional cloud speech; accuracy varies, which is why speaking never decides a pass.
* Audio playback needs a Windows voice for the language; if none is installed the app says so.

## Stabilization pass: what was verified, and how

**Mastery rule (configurable).** Each finished attempt records one outcome per item (right only if every question about it was right). An item is *learned* when at least `masteryNeeded` (default 3, range 2–8) of the last `max(masteryWindow, masteryNeeded)` outcomes (default window 5, range 3–12) were right **and the latest one was right**. One lucky pass never counts; a later failure sets mastery back. Lesson unlock and revision rules are unchanged. Older saves without history load safely.

**Typed vs. spoken.** Every answer is labelled: "🎙 Recognized speech: this is what the recognizer heard" or "⌨ Typed instead of speaking: not speaking practice". Typed answers never create pronunciation records. Attempts store how many answers were spoken vs. typed. If no voice for the target language is installed, Momo says so instead of reading with a wrong-language voice.

**Recognizer output is cleaned** (`cleanHeard`): punctuation-only output ("...") means *nothing heard*; a phrase looping 3+ times is kept once; text is capped at 200 characters.

### Verified on real hardware (physical Intel microphone array, Windows, local Whisper)
* Microphone opens, speech is recognized and shown with the "Recognized speech" label, and the microphone is released afterwards (0 live tracks).
* Cancel while listening: nothing is saved, microphone released, "Cancelled" shown, "Try again" offered.
* Leaving the screen while listening releases the microphone.
* Blocked microphone: clear message and retry offered.
* Cloud engine without a usable key: the learner sees a message, no answer is saved, retry works.
* Typed answer: labelled, no pronunciation record.

### Known limitations (honest)
* **Accuracy is not good enough to rely on.** Only English voices are installed here, so target-language speech was never tested with a human or a target-language voice; English phrases played through the speakers into the microphone were often mis-transcribed (e.g. "Thank you very much." → "I don't see anyone.").
* **Room noise can produce invented text.** Three seconds of near-silence came back as "Happy Eid, Jesus." — `cleanHeard` cannot detect that. This is why speaking is only an unverified estimate and never decides a pass or mastery.
* Tones, vowel length and accent quality cannot be checked from a transcript.
