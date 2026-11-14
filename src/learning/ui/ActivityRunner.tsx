import { useEffect, useMemo, useState } from "react";
import { itemsOf } from "../activities";
import { LANGUAGES, type Lesson } from "../content";
import { advance, answerQuestion, abandonAttempt } from "../progress";
import type { ActiveAttempt, AnswerRecord, Attempt, LearningState, Question } from "../state";
import type { Prefs } from "../../state/settings";
import { useSpeechInput } from "./speechInput";
import type { useTeacher } from "./teacher";

type Teacher = ReturnType<typeof useTeacher>;
/** feedback belongs to the question that was just answered (which may be the last one of its activity, so there is no "next" question) */
interface Feedback { q: Question; mode: AnswerRecord["mode"]; correct: boolean; answer: string; given: string; estimate?: AnswerRecord["estimate"]; part?: AnswerRecord["part"] }

/**
 * Runs one lesson attempt. Activities appear one after another; a question counts only when it has been ANSWERED and evaluated,
 * and the next activity unlocks only when the current one is complete. Nothing here marks anything done by being opened.
 */
export function ActivityRunner({ lesson, state, update, teacher, prefs, onExit }: {
  lesson: Lesson; state: LearningState; update: (fn: (s: LearningState) => LearningState) => LearningState | null;
  teacher: Teacher; prefs: Prefs; onExit(): void;
}) {
  const lang = state.settings.lang;
  const info = LANGUAGES[lang];
  const active: ActiveAttempt | undefined = state.lessons[lesson.id]?.active;
  const [fb, setFb] = useState<Feedback | null>(null);
  const [result, setResult] = useState<{ attempt: Attempt; passed: boolean } | null>(null);
  const [typed, setTyped] = useState("");
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [pickLeft, setPickLeft] = useState<string | null>(null);
  const speech = useSpeechInput(lang, prefs);
  const [micNote, setMicNote] = useState<string | null>(null);

  const act = active?.activities[active.index];
  const nextQ: Question | undefined = act?.questions.find((q) => !active!.answers[q.id]);
  const done = !!act && !nextQ;
  useEffect(() => { setTyped(""); setPairs({}); setPickLeft(null); setMicNote(null); }, [nextQ?.id]);
  // audio never starts by itself: the learner presses Play

  if (result) return <ResultView lesson={lesson} result={result} onExit={onExit} state={state} />;
  if (!active || !act) return <p className="hint">No open attempt. <button onClick={onExit}>Back</button></p>;

  const submit = (given: string, mode: AnswerRecord["mode"]) => {
    if (!nextQ) return;
    let outcome: Feedback | null = null;
    update((s) => {
      const r = answerQuestion(s, lesson.id, nextQ.id, given, mode, Date.now());
      if (!r.ok) return s;
      const rec = r.state.lessons[lesson.id].active!.answers[nextQ.id];
      outcome = { q: nextQ, mode, correct: r.evaluation.correct, answer: nextQ.answer, given, estimate: r.evaluation.estimate, part: r.evaluation.part ?? rec.part };
      return r.state;
    });
    if (outcome) {
      const o: Feedback = outcome;
      setFb(o);
      teacher.react(o.correct ? "happy" : "apologetic");
    }
  };
  const next = () => setFb(null);
  const nextActivity = () => {
    setFb(null);
    let fin: { attempt: Attempt; passed: boolean } | undefined;
    update((s) => { const r = advance(s, lesson.id, Date.now()); if (!r.ok) return s; fin = r.finished; return r.state; });
    if (fin) { setResult(fin); teacher.react(fin.passed ? "excited" : "apologetic", 4000); }
  };
  const isLast = active.index === active.activities.length - 1;

  const play = (text: string) => { if (!teacher.say(text, lang)) setMicNote(`No ${info.name} voice is installed on this PC, so I can't play audio. Add one in Windows Settings → Time & language → Speech.`); };

  const speak = async () => {
    if (speech.phase === "listening") {
      const heard = await speech.finish();
      if (!heard) { setMicNote(speech.error ?? "I didn't hear anything I could turn into text. Try again closer to the microphone, or type it instead."); teacher.react("confused"); return; }
      submit(heard, "spoken");
    } else { setMicNote(null); teacher.react("listening", 15000); await speech.begin(); }
  };

  const q = nextQ;
  return (
    <section className="panel runner" aria-live="polite">
      <header className="runner-head">
        <div><strong>{lesson.title}</strong>{active.kind === "revision" && <span className="badge warn">Revision</span>}</div>
        <span className="hint">Activity {active.index + 1} of {active.activities.length}: {act.title}</span>
        <button onClick={() => { if (window.confirm("Start this attempt over? Answers so far will not count.")) { update((s) => abandonAttempt(s, lesson.id)); onExit(); } }}>Start over</button>
      </header>
      <progress className="bar-progress" max={act.questions.length} value={act.questions.filter((x) => active.answers[x.id]).length} aria-label="Activity progress" />
      <p className="hint">{act.instructions}</p>

      {q && !fb && (
        <div className="question">
          {q.kind === "match" ? (
            <div>
              <h2 className="qprompt">{q.prompt}</h2>
              <MatchBoard q={q} pairs={pairs} setPairs={setPairs} pickLeft={pickLeft} setPickLeft={setPickLeft} />
              <button className="primary" disabled={Object.keys(pairs).length < (q.pairs?.length ?? 0)} onClick={() => submit(JSON.stringify(pairs), "chosen")}>Check my matches</button>
            </div>
          ) : (
            <>
              <h2 className={`qprompt script-${lang}`}>{q.prompt}</h2>
              {q.sub && <p className="hint">{q.sub}</p>}
              {(q.kind === "audio-id" || q.kind === "repeat" || q.kind === "speak") && q.say && <button onClick={() => play(q.say!)}>▶ Play audio</button>}
              {(q.kind === "choice" || q.kind === "audio-id") && (
                <div className="options" role="group" aria-label="Answers">
                  {q.options!.map((o) => <button key={o} className={`opt script-${lang}`} onClick={() => submit(o, "chosen")}>{o}</button>)}
                </div>
              )}
              {(q.kind === "translate" || q.kind === "fill-blank") && (
                <form onSubmit={(e) => { e.preventDefault(); if (typed.trim()) submit(typed, "typed"); }} className="row">
                  <input autoFocus lang={lang} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your answer" aria-label="Your answer" />
                  <button className="primary" type="submit" disabled={!typed.trim()}>Check</button>
                </form>
              )}
              {(q.kind === "repeat" || q.kind === "speak") && (
                <div className="speak">
                  {!speech.available || speech.ready === false ? (
                    <p className="notice">{!speech.available ? "No microphone is available." : "Speech recognition isn't set up yet (Settings → Language & voice)."} You can type what you would say instead; it is recorded as typed, not spoken.</p>
                  ) : (
                    <div className="row">
                      <button className={speech.phase === "listening" ? "primary rec" : "primary"} disabled={speech.phase === "starting" || speech.phase === "transcribing"} onClick={() => void speak()}>
                        {speech.phase === "listening" ? "■ Stop and check" : speech.phase === "transcribing" ? "Turning your speech into text…" : speech.error || micNote ? "🎙 Try again" : "🎙 Start speaking"}
                      </button>
                      {(speech.phase === "listening" || speech.phase === "starting" || speech.phase === "transcribing") && <button onClick={() => { speech.cancel(); teacher.react("calm", 1500); setMicNote("Cancelled: nothing was checked."); }}>Cancel</button>}
                    </div>
                  )}
                  <form onSubmit={(e) => { e.preventDefault(); if (typed.trim()) submit(typed, "typed-instead-of-speaking"); }} className="row">
                    <input lang={lang} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="…or type it" aria-label="Type instead of speaking" />
                    <button type="submit" disabled={!typed.trim()}>Use typed answer</button>
                  </form>
                </div>
              )}
              {(micNote || speech.error) && <p className="error">{micNote ?? speech.error}</p>}
            </>
          )}
        </div>
      )}

      {fb && (
        <div className={`feedback ${fb.estimate ? "est" : fb.correct ? "good" : "bad"}`}>
          {fb.mode === "spoken" && <p className="tag spoken">🎙 Recognized speech: what you said, as the recognizer heard it</p>}
          {fb.mode === "typed-instead-of-speaking" && <p className="tag typed">⌨ Typed instead of speaking: this is NOT speaking practice and no pronunciation estimate is made</p>}
          {fb.estimate ? (
            <>
              <strong>{fb.estimate.verdict === "match" ? "I understood you." : fb.estimate.verdict === "close" ? "Close." : "I didn't recognise that."}</strong>
              <p>The recognizer heard: <span className={`script-${lang}`}>“{fb.given}”</span> (target: <span className={`script-${lang}`}>{fb.q.answer}</span>)</p>
              <p className="hint">Automated estimate, not verified: {fb.estimate.note}</p>
            </>
          ) : fb.q.kind === "match" ? (
            <p><strong>{fb.correct ? "All matched!" : `${fb.part?.right ?? 0} of ${fb.part?.total ?? 0} matches were right.`}</strong> <span className="hint">Correct: {fb.q.answer}</span></p>
          ) : (
            <p><strong>{fb.correct ? "Correct!" : "Not quite."}</strong> {!fb.correct && <>The answer is <span className={`script-${lang}`}><b>{fb.q.answer}</b></span>.</>}</p>
          )}
          <button className="primary" onClick={next}>Continue</button>
        </div>
      )}

      {done && !fb && (
        <div className="feedback good">
          <p><strong>Activity complete.</strong> {isLast ? "That was the last one." : "The next activity is unlocked."}</p>
          <button className="primary" onClick={nextActivity}>{isLast ? "Finish and see my result" : "Next activity"}</button>
        </div>
      )}
    </section>
  );
}

function MatchBoard({ q, pairs, setPairs, pickLeft, setPickLeft }: { q: Question; pairs: Record<string, string>; setPairs(p: Record<string, string>): void; pickLeft: string | null; setPickLeft(id: string | null): void }) {
  const rights = useMemo(() => [...(q.pairs ?? [])].map((p) => p.right).sort((a, b) => (a < b ? -1 : 1)), [q.pairs]);
  const used = new Set(Object.values(pairs));
  return (
    <div className="board">
      <div className="col">
        {q.pairs!.map((p) => (
          <button key={p.id} className={pickLeft === p.id ? "opt on" : pairs[p.id] ? "opt done" : "opt"} onClick={() => setPickLeft(pickLeft === p.id ? null : p.id)}>
            <span>{p.left}</span>{pairs[p.id] && <small> → {pairs[p.id]}</small>}
          </button>
        ))}
      </div>
      <div className="col">
        {rights.map((r) => (
          <button key={r} className={used.has(r) ? "opt done" : "opt"} disabled={!pickLeft && !used.has(r)} onClick={() => {
            if (used.has(r)) { const k = Object.keys(pairs).find((x) => pairs[x] === r)!; const n = { ...pairs }; delete n[k]; setPairs(n); return; }
            if (pickLeft) { setPairs({ ...pairs, [pickLeft]: r }); setPickLeft(null); }
          }}>{r}</button>
        ))}
      </div>
      <p className="hint">Pick a word on the left, then its match on the right. Click a matched answer to undo it.</p>
    </div>
  );
}

function ResultView({ lesson, result, onExit, state }: { lesson: Lesson; result: { attempt: Attempt; passed: boolean }; onExit(): void; state: LearningState }) {
  const { attempt, passed } = result;
  const items = itemsOf(lesson);
  const lang = state.settings.lang;
  const missed = attempt.missed.map((id) => items.find((i) => i.id === id)).filter(Boolean) as ReturnType<typeof itemsOf>;
  const pct = Math.round((attempt.score ?? 0) * 100);
  const need = Math.round(state.settings.passScore * 100);
  const revision = attempt.kind === "revision";
  return (
    <section className="panel result">
      <h2>{passed ? (revision ? "Revision passed" : "Lesson passed") : revision ? "Revision not passed yet" : "Not passed this time"}</h2>
      <p><strong>{pct}%</strong> of the checkable questions were right ({attempt.correct} of {attempt.total}); the pass mark is {need}%.</p>
      {passed && !revision && <p>The next lesson is now unlocked.</p>}
      {passed && revision && <p>You can retake the lesson now.</p>}
      {!passed && !revision && <p>Before you retake it, revise the items you missed. It is required.</p>}
      {!passed && revision && <p>Try the revision again; it is built from what you still missed.</p>}
      {missed.length > 0 && (
        <div>
          <h3>Items to review</h3>
          <ul className="plain">{missed.map((m) => <li key={m.id}><span className={`script-${lang}`}><b>{m.text}</b></span> {m.roman && <em>{m.roman}</em>}: {m.meaning}</li>)}</ul>
        </div>
      )}
      {attempt.speaking && (attempt.speaking.spoken + attempt.speaking.typed > 0) && (
        <p className="hint">Speaking activities: {attempt.speaking.spoken} answered by speaking (recognized speech), {attempt.speaking.typed} typed instead. Speaking is an unverified estimate and does not change this score.</p>
      )}
      <button className="primary" onClick={onExit}>Back to the course</button>
    </section>
  );
}
