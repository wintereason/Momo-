import { useEffect, useMemo, useState } from "react";
import { AvatarStage } from "../../character/AvatarStage";
import { SpeechCloud } from "../../character/SpeechCloud";
import { itemsOf } from "../../learning/activities";
import { LANGUAGES, LEVELS, NATIVE_LANGUAGES, courseFor, levelsAvailable, type LangId, type Lesson, type Level } from "../../learning/content";
import { desktop } from "../../desktop";
import { addGoal, defaultTarget, goalProgress, recommendNext, removeGoal, summaryText, vocabLearned } from "../../learning/goals";
import { ensureCourse, isLevelUnlocked, levelStatus, selectCourse, startAttempt } from "../../learning/progress";
import type { Goal, LessonProgress } from "../../learning/state";
import { ActivityRunner } from "../../learning/ui/ActivityRunner";
import { useLearning } from "../../learning/ui/useLearning";
import { useTeacher } from "../../learning/ui/teacher";
import { InterviewPanel } from "../../learning/ui/InterviewPanel";
import type { PageProps } from "../SettingsApp";
import "../../styles/learn.css";

const STATUS: Record<LessonProgress["status"], string> = { locked: "Locked", available: "Ready", in_progress: "In progress", revision_required: "Revision needed", passed: "Passed" };
const GOAL_KINDS: { kind: Goal["kind"]; label: (lang: string) => string }[] = [
  { kind: "vocab_count", label: () => "Learn vocabulary words" },
  { kind: "writing_system", label: () => "Master the writing system" },
  { kind: "lessons_count", label: () => "Complete lessons" },
  { kind: "level_pass", label: () => "Pass the beginner level" },
  { kind: "interview_complete", label: () => "Complete a conversation interview" },
  { kind: "pronunciation_practice", label: () => "Practise speaking" },
];

/** Momo as a language teacher: courses, lessons that must be passed, goals, and the final interview. */
export function LearnPage({ prefs }: PageProps) {
  const { store, state, update } = useLearning();
  const teacher = useTeacher(prefs.character);
  const [tab, setTab] = useState<"course" | "goals" | "interview">("course");
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // keep the orchestrator's read-only learning tool current (memory only, a short text with no name in it)
  useEffect(() => { if (state) desktop?.setLanguageSummary(summaryText(state)); }, [state]);
  const [name, setName] = useState("");
  const [newLang, setNewLang] = useState<LangId>("fr");

  if (!state) {
    return (
      <>
        <header className="page-head"><h1>Learn a language</h1><p className="lead">Momo teaches you step by step: the writing system, vocabulary, practice you must pass, and finally a spoken interview. Your progress is saved on this PC, per learner.</p></header>
        <section className="panel">
          <h2 className="tight">Start learning</h2>
          <label className="field">Your name (for your own profile)
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ana" maxLength={40} />
          </label>
          <label className="field">I want to learn
            <select value={newLang} onChange={(e) => setNewLang(e.target.value as LangId)}>
              {(Object.keys(LANGUAGES) as LangId[]).map((l) => <option key={l} value={l}>{LANGUAGES[l].name} — {LANGUAGES[l].nativeName}</option>)}
            </select>
          </label>
          <label className="field">My language (explanations are written in)
            <select disabled value="en"><option value="en">{NATIVE_LANGUAGES[0].name}</option></select>
          </label>
          <p className="hint">Writing system: {LANGUAGES[newLang].script}. Only English explanations are written so far.</p>
          <div className="row"><button className="primary" onClick={() => { store.createProfile(name || "Learner", newLang); update((s) => s); }}>Create my profile and begin</button></div>
        </section>
      </>
    );
  }

  const { lang, level } = state.settings;
  const info = LANGUAGES[lang];
  const course = courseFor(lang, level);
  const lessonObj = course.lessons.find((l) => l.id === lessonId) ?? null;
  const next = recommendNext(state);
  const st = levelStatus(state, lang, level);

  const begin = (l: Lesson) => {
    setMsg(null);
    let err: string | null = null;
    update((s) => { const r = startAttempt(s, l.id, Date.now(), Math.floor(Math.random() * 1e9)); if (!r.ok) { err = r.reason; return s; } return r.state; });
    if (err) { setMsg(err); return; }
    setLessonId(l.id); setRunning(true);
  };

  return (
    <>
      <header className="page-head learn-head">
        <div className="learn-title">
          <h1>Learn {info.name}</h1>
          <p className="lead">{info.nativeName} · writing system: {info.script} · {level} level</p>
          <SpeechCloud cloud={teacher.cloud} className="learn-cloud" />
        </div>
        <AvatarStage character={prefs.character} expression={teacher.expression} mouth={teacher.mouth} cloud={null} className="teacher-stage" />
      </header>

      <nav className="tabs" aria-label="Learning sections">
        {(["course", "goals", "interview"] as const).map((t) => <button key={t} className={tab === t ? "chip on" : "chip"} onClick={() => { setTab(t); setRunning(false); setLessonId(null); }}>{t === "course" ? "Course" : t === "goals" ? "Goals" : "Final interview"}</button>)}
        <span className="grow" />
        <select aria-label="Learner profile" value={store.activeId() ?? ""} onChange={(e) => { store.switchProfile(e.target.value); update((s) => s); setLessonId(null); setRunning(false); }}>
          {store.profiles().map((p) => <option key={p.id} value={p.id}>{p.name} ({LANGUAGES[p.lang as LangId]?.name})</option>)}
        </select>
        <button onClick={() => { const n = window.prompt("Name of the new learner:"); if (n) { store.createProfile(n, lang); update((s) => s); setLessonId(null); } }}>+ Learner</button>
      </nav>

      {tab === "course" && !running && (
        <>
          <section className="panel">
            <div className="row between">
              <div><strong>Next step</strong><p className="hint">{next.text}</p></div>
              {(next.kind === "resume" || next.kind === "lesson" || next.kind === "revision") && (
                <button className="primary" onClick={() => { const l = course.lessons.find((x) => x.id === next.lessonId); if (l) begin(l); }}>{next.kind === "resume" ? "Resume" : next.kind === "revision" ? "Start revision" : "Start"}</button>
              )}
              {next.kind === "interview" && <button className="primary" onClick={() => setTab("interview")}>Go to the interview</button>}
            </div>
          </section>

          <section className="panel">
            <fieldset className="chips"><legend>Language</legend>
              <div>{(Object.keys(LANGUAGES) as LangId[]).map((l) => (
                <button key={l} className={l === lang ? "chip on" : "chip"} onClick={() => update((s) => { const levelsOk = levelsAvailable(l); return ensureCourse({ ...s, settings: { ...s.settings, lang: l, level: levelsOk.includes(s.settings.level) ? s.settings.level : "beginner" } }, Date.now()); })}>{LANGUAGES[l].name}</button>
              ))}</div>
            </fieldset>
            <fieldset className="chips"><legend>Level</legend>
              <div>{LEVELS.map((lv) => {
                const u = isLevelUnlocked(state, lang, lv);
                const written = levelsAvailable(lang).includes(lv);
                return <button key={lv} className={lv === level ? "chip on" : "chip"} disabled={!written || !u.unlocked} title={!written ? "Not written yet" : u.unlocked ? "" : u.reason}
                  onClick={() => { const r = selectCourse(state, lang, lv as Level, Date.now()); if (r.ok) update(() => r.state); else setMsg(r.reason); }}>{lv}{!written ? " (coming)" : !u.unlocked ? " 🔒" : ""}</button>;
              })}</div>
            </fieldset>
            <p className="hint">{info.typingNote} Level progress: {st.lessonsPassed} of {st.lessonsTotal} lessons passed{st.interviewRequired ? `, final interview ${st.interviewDone ? "completed" : "not yet taken"}` : ""}. Vocabulary learned: {vocabLearned(state)}.</p>
            {!teacher.hasVoice(lang) && teacher.voicesLoaded && <p className="notice">No {info.name} voice is installed on this PC, so audio can't play yet. Add one in Windows Settings → Time &amp; language → Speech.</p>}
            {msg && <p className="error">{msg}</p>}
          </section>

          <section className="panel">
            <h2 className="tight">Lessons</h2>
            <ol className="lessons">
              {course.lessons.map((l) => {
                const p = state.lessons[l.id];
                const s = p?.status ?? "locked";
                return (
                  <li key={l.id} className={`lesson ${s}`}>
                    <div>
                      <strong>{l.title}</strong> <span className={`badge ${s === "passed" ? "ok" : s === "revision_required" ? "warn" : ""}`}>{STATUS[s]}</span>
                      <p className="hint">{l.objective}</p>
                      {p && p.attempts.length > 0 && <p className="hint">Best score {Math.round(p.bestScore * 100)}% · {p.attempts.length} attempt{p.attempts.length === 1 ? "" : "s"}</p>}
                    </div>
                    <div className="row">
                      <button onClick={() => { setLessonId(l.id); setRunning(false); }}>{lessonId === l.id ? "Viewing" : "Study"}</button>
                      <button className="primary" disabled={s === "locked"} onClick={() => begin(l)}>{p?.active ? "Resume" : s === "passed" ? "Practise again" : s === "revision_required" ? "Revise" : "Practise"}</button>
                    </div>
                  </li>
                );
              })}
            </ol>
            {course.lessons.length === 0 && <p className="hint">This level has no lessons yet.</p>}
          </section>

          {lessonObj && <LessonStudy lesson={lessonObj} teacher={teacher} lang={lang} />}

          <section className="panel">
            <h2 className="tight">Course settings</h2>
            <label className="field">Pass mark: {Math.round(state.settings.passScore * 100)}%
              <input type="range" min="50" max="100" step="5" value={Math.round(state.settings.passScore * 100)} onChange={(e) => update((s) => ({ ...s, settings: { ...s.settings, passScore: Number(e.target.value) / 100 } }))} />
            </label>
            <label className="check-row"><input type="checkbox" checked={state.settings.requireRevision} onChange={(e) => update((s) => ({ ...s, settings: { ...s.settings, requireRevision: e.target.checked } }))} /> <span>After a failed lesson, require a passed revision before retaking it</span></label>
            <label className="check-row"><input type="checkbox" checked={state.settings.interviewRequired} onChange={(e) => update((s) => ({ ...s, settings: { ...s.settings, interviewRequired: e.target.checked } }))} /> <span>Require the final interview before the next level opens</span></label>
            <label className="field">Mastery: a word counts as learned after being right in {state.settings.masteryNeeded} of the last {Math.max(state.settings.masteryWindow, state.settings.masteryNeeded)} finished attempts (and in the latest one)
              <input type="range" min="2" max="6" value={state.settings.masteryNeeded} onChange={(e) => update((s) => ({ ...s, settings: { ...s.settings, masteryNeeded: Number(e.target.value) } }))} />
            </label>
            <label className="field">Attempts looked at for mastery: {Math.max(state.settings.masteryWindow, state.settings.masteryNeeded)}
              <input type="range" min="3" max="10" value={Math.max(state.settings.masteryWindow, state.settings.masteryNeeded)} onChange={(e) => update((s) => ({ ...s, settings: { ...s.settings, masteryWindow: Number(e.target.value) } }))} />
            </label>
            <label className="field">Things to say in the interview for it to count as completed: {state.settings.interviewMinTurns}
              <input type="range" min="2" max="20" value={state.settings.interviewMinTurns} onChange={(e) => update((s) => ({ ...s, settings: { ...s.settings, interviewMinTurns: Number(e.target.value) } }))} />
            </label>
          </section>
        </>
      )}

      {tab === "course" && running && lessonObj && (
        <ActivityRunner lesson={lessonObj} state={state} update={update} teacher={teacher} prefs={prefs} onExit={() => { setRunning(false); teacher.stop(); }} />
      )}

      {tab === "goals" && <GoalsPanel state={state} update={update} lang={lang} />}
      {tab === "interview" && <InterviewPanel state={state} update={update} teacher={teacher} prefs={prefs} />}
    </>
  );
}

function LessonStudy({ lesson, teacher, lang }: { lesson: Lesson; teacher: ReturnType<typeof useTeacher>; lang: LangId }) {
  const items = useMemo(() => itemsOf(lesson), [lesson]);
  const info = LANGUAGES[lang];
  const [noVoice, setNoVoice] = useState(false);
  return (
    <section className="panel">
      <h2 className="tight">{lesson.title}</h2>
      <p className="hint"><strong>Goal:</strong> {lesson.objective}</p>
      {noVoice && <p className="notice">No {info.name} voice is installed on this PC, so I can't play this. Add one in Windows Settings → Time &amp; language → Speech, then try again.</p>}
      <div className="study">
        {items.map((i) => (
          <div key={i.id} className="item">
            <button className="play" aria-label={`Play ${i.text}`} onClick={() => setNoVoice(!teacher.say(i.say, lang))}>▶</button>
            <div>
              <div className={`big script-${lang}`}>{i.text}</div>
              <div className="sub">{i.roman && <em>{info.romanLabel}: {i.roman}</em>}{lesson.kind === "vocab" && <> · {i.meaning}</>}</div>
              <div className="hint">{lesson.kind === "writing" ? i.guide : `Say it: ${i.guide}`}</div>
              {i.example && <div className="ex"><span className={`script-${lang}`}>{i.example.text}</span>{i.example.roman && <em> {i.example.roman}</em>} — {i.example.meaning}</div>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GoalsPanel({ state, update, lang }: { state: NonNullable<ReturnType<typeof useLearning>["state"]>; update: ReturnType<typeof useLearning>["update"]; lang: LangId }) {
  const [kind, setKind] = useState<Goal["kind"]>("vocab_count");
  const [target, setTarget] = useState<number>(defaultTarget("vocab_count", lang));
  useEffect(() => setTarget(defaultTarget(kind, lang)), [kind, lang]);
  const fixed = kind === "level_pass" || kind === "interview_complete" || kind === "writing_system";
  return (
    <>
      <section className="panel">
        <h2 className="tight">My goals</h2>
        {state.goals.length === 0 && <p className="hint">No goals yet. Set a measurable one below.</p>}
        <ul className="goals">
          {state.goals.map((g) => {
            const p = goalProgress(g, state);
            return (
              <li key={g.id}>
                <div className="row between"><strong>{g.label}</strong><button onClick={() => update((s) => removeGoal(s, g.id))}>Remove</button></div>
                <progress max={p.target} value={p.current} aria-label={g.label} />
                <span className="hint">{p.current} of {p.target}{p.done ? " — reached" : ""}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="panel">
        <h2 className="tight">Add a goal</h2>
        <label className="field">Goal
          <select value={kind} onChange={(e) => setKind(e.target.value as Goal["kind"])}>{GOAL_KINDS.map((g) => <option key={g.kind} value={g.kind}>{g.label(lang)}</option>)}</select>
        </label>
        {!fixed && <label className="field">How many
          <input type="number" min={1} max={500} value={target} onChange={(e) => setTarget(Math.max(1, Number(e.target.value) || 1))} />
        </label>}
        <p className="hint">Targets count real progress: words answered correctly in several lessons, lessons passed, interviews completed.</p>
        <div className="row"><button className="primary" onClick={() => {
          const g = GOAL_KINDS.find((x) => x.kind === kind)!;
          update((s) => addGoal(s, { kind, lang, level: kind === "level_pass" ? "beginner" : undefined, target: fixed ? defaultTarget(kind, lang) : target, label: `${g.label(lang)}${fixed ? "" : `: ${target}`} (${LANGUAGES[lang].name})` }, Date.now()));
        }}>Add goal</button></div>
      </section>
    </>
  );
}

