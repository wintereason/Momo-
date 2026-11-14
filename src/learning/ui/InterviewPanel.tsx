import { useEffect, useRef, useState } from "react";
import { desktop, type EnvStatus } from "../../desktop";
import type { Prefs } from "../../state/settings";
import { allLessons, LANGUAGES } from "../content";
import { interviewAvailable, levelStatus } from "../progress";
import type { LearningState } from "../state";
import { type InterviewSessionV1, interviewBus } from "../interview/contract";
import { abandonSession, addAiTurn, addEvent, addUserTurn, completeSession, historyFor, openSession, saveSession, startInterview } from "../interview/engine";
import { SCENARIOS, scenarioById, type Scenario } from "../interview/scenarios";
import { normalizeAnswer } from "../text";
import { useSpeechInput } from "./speechInput";
import type { useTeacher } from "./teacher";

type Teacher = ReturnType<typeof useTeacher>;
type Update = (fn: (s: LearningState) => LearningState) => LearningState | null;

/** vocabulary from the course (verified content) that appears in a line: its pronunciation guide, never AI-made */
function guidesIn(text: string, lang: string): { text: string; roman?: string; guide: string; meaning: string }[] {
  const n = normalizeAnswer(text);
  return allLessons().filter((l) => l.lang === lang && l.kind === "vocab").flatMap((l) => l.vocab ?? []).filter((v) => normalizeAnswer(v.text).length > 1 && n.includes(normalizeAnswer(v.text))).slice(0, 6);
}

/**
 * The final stage of a level: a spoken or typed conversation in the target language, with Momo's AI playing the other role. This
 * panel RUNS the interview and saves its data in the versioned contract; it does not score or report it (see
 * docs/09_LANGUAGE_TEACHER.md for how a reporting module receives completed sessions).
 */
export function InterviewPanel({ state, update, teacher, prefs }: { state: LearningState; update: Update; teacher: Teacher; prefs: Prefs }) {
  const { lang, level } = state.settings;
  const info = LANGUAGES[lang];
  const avail = interviewAvailable(state, lang, level);
  const st = levelStatus(state, lang, level);
  const [env, setEnv] = useState<EnvStatus | null>(null);
  useEffect(() => { void desktop?.envStatus().then(setEnv).catch(() => setEnv(null)); }, []);
  const open = openSession(state);
  const [sid, setSid] = useState<string | null>(null);
  const session = sid ? state.sessions[sid] ?? null : null;
  const [scenarioId, setScenarioId] = useState<string>("restaurant");
  const [roleId, setRoleId] = useState<string>("");
  const [custom, setCustom] = useState({ setting: "", userRole: "", aiRole: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [showEn, setShowEn] = useState(true);
  const [published, setPublished] = useState<string | null>(null);
  const speech = useSpeechInput(lang, prefs);
  const scenario: Scenario | undefined = scenarioById(scenarioId);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "nearest" }); }, [session?.turns.length]);
  useEffect(() => { if (scenario && !scenario.roles.some((r) => r.id === roleId)) setRoleId(scenario.roles[0].id); }, [scenarioId]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastAskRef = useRef<InterviewSessionV1 | null>(null);

  /** ask the AI for the next line of the conversation (the opening line when nobody has spoken yet) */
  const askAi = async (x: InterviewSessionV1) => {
    setBusy(true); setErr(null); lastAskRef.current = x;
    if (!desktop) { setErr("The interview needs the Momo desktop app (npm run desktop)."); setBusy(false); return; }
    teacher.react("thinking", 20000);
    const res = await desktop.languageConverse({
      language: x.language.code, level: x.course.level,
      scenario: { title: x.scenario.title, setting: x.scenario.setting, userRole: x.scenario.userRole, aiRole: x.scenario.aiRole, objectives: x.objectives },
      history: historyFor(x), userTurns: x.completion.userTurns, minTurns: x.completion.minTurns,
    });
    setBusy(false);
    if (!res.ok) {
      update((s) => saveSession(s, addEvent(s.sessions[x.sessionId] ?? x, "ai-error", Date.now(), res.message.slice(0, 120))));
      setErr(res.message);
      teacher.react("apologetic", 3500);
      return;
    }
    let next: InterviewSessionV1 = x;
    update((s) => { next = addAiTurn(s.sessions[x.sessionId] ?? x, res.reply, Date.now()); return saveSession(s, next); });
    if (!teacher.say(res.reply.reply, lang, { rate: level === "beginner" ? 0.8 : 0.95 })) setVoiceNote(`No ${info.name} voice is installed on this PC, so Momo's lines are shown but not spoken.`);
    else setVoiceNote(null);
  };

  const begin = async (resume?: InterviewSessionV1) => {
    setErr(null); setPublished(null);
    if (resume) {
      const x = addEvent(resume, "resumed", Date.now());
      update((s) => saveSession(s, x));
      setSid(resume.sessionId);
      if (x.turns.length === 0 || x.turns[x.turns.length - 1].speaker === "user") await askAi(x);
      return;
    }
    const id = `i${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    let started: InterviewSessionV1 | null = null, reason: string | null = null;
    update((s) => { const r = startInterview(s, { scenarioId, userRoleId: roleId, custom }, Date.now(), null, id); if (!r.ok) { reason = r.reason; return s; } started = r.session; return r.state; });
    if (reason || !started) { setErr(reason ?? "Could not start."); return; }
    setSid(id);
    await askAi(started);
  };

  const send = async (given: string, mode: "typed" | "spoken") => {
    if (!session || busy) return;
    let x: InterviewSessionV1 | null = null, reason: string | null = null;
    update((s) => { const r = addUserTurn(s.sessions[session.sessionId], given, { mode, transcript: mode === "spoken" ? given : undefined, engine: prefs.speechEngine }, Date.now()); if (!r.ok) { reason = r.reason; return s; } x = r.session; return saveSession(s, r.session); });
    if (reason || !x) { setErr(reason ?? "Nothing to send."); return; }
    setText("");
    await askAi(x);
  };

  const talk = async () => {
    if (speech.phase === "listening") {
      const heard = await speech.finish();
      if (!heard) { setErr(speech.error ?? "I didn't hear anything I could turn into text. Try again, or type your answer."); teacher.react("confused", 2500); return; }
      await send(heard, "spoken");
    } else { teacher.stop(); setErr(null); teacher.react("listening", 20000); await speech.begin(); }
  };

  const interrupt = () => {
    teacher.stop();
    if (session) update((s) => saveSession(s, addEvent(s.sessions[session.sessionId], "interrupted", Date.now())));
  };

  const finish = async () => {
    if (!session) return;
    let done: InterviewSessionV1 | null = null;
    update((s) => { const r = completeSession(s, session.sessionId, Date.now()); if (!r.ok) return s; done = r.session; return r.state; });
    teacher.stop();
    if (done) {
      const r = await interviewBus.publish(done); // the contract: any registered consumer (e.g. a reporting module) receives it
      setPublished(r.delivered.length ? `Delivered to: ${r.delivered.join(", ")}.` : "Saved. No reporting module is connected yet.");
      teacher.react((done as InterviewSessionV1).completion.countsAsCompleted ? "happy" : "calm", 3500);
    }
  };
  const leave = () => { if (session && session.status === "in_progress") update((s) => abandonSession(s, session.sessionId, Date.now())); teacher.stop(); setSid(null); };

  // ----- not available yet
  if (!avail.ok && !session) {
    return (
      <section className="panel">
        <h2 className="tight">Final interview</h2>
        <p>{avail.reason}</p>
        <p className="hint">The interview is the last stage of each level: after the lessons, you hold a real conversation in {info.name}.</p>
      </section>
    );
  }
  if (!env?.ai.ready && !session) {
    return (
      <section className="panel">
        <h2 className="tight">Final interview</h2>
        <p>The interview needs the AI to play the other role. Add a free key in Settings → AI &amp; keys, then come back.</p>
      </section>
    );
  }

  // ----- the conversation
  if (session) {
    const over = session.status !== "in_progress";
    const enough = session.completion.userTurns >= session.completion.minTurns;
    const last = session.turns[session.turns.length - 1];
    const aiEnded = over ? false : !!lastAskRef.current && last?.speaker === "ai" && last.kind === "closing";
    return (
      <>
        <section className="panel interview">
          <div className="row between">
            <div><strong>{session.scenario.title}</strong> <span className="hint">You: {session.scenario.userRole} · Momo: {session.scenario.aiRole}</span></div>
            <label className="check-row"><input type="checkbox" checked={showEn} onChange={(e) => setShowEn(e.target.checked)} /> <span>Show English translations</span></label>
          </div>
          <p className="hint">{session.scenario.setting} {env?.ai.provider && (env.ai.provider !== "ollama" ? `Your conversation text is sent to ${env.ai.provider} to produce Momo's lines.` : "The conversation stays on this PC.")}</p>
          <div className="chat" role="log" aria-live="polite">
            {session.turns.map((t) => (
              <div key={t.index} className={`bubble ${t.speaker}`}>
                <div className="who">{t.speaker === "user" ? "You" : t.role}</div>
                <div className={`line script-${lang}`}>{t.text}</div>
                {t.speaker === "ai" && (
                  <>
                    {showEn && t.translation && <div className="tr">{t.translation} <small>(AI translation, may contain mistakes)</small></div>}
                    {t.romanization && <div className="tr"><em>{t.romanization}</em> <small>(AI-generated, unverified)</small></div>}
                    {guidesIn(t.text, lang).length > 0 && (
                      <div className="guides">{guidesIn(t.text, lang).map((g) => <span key={g.text} className="guide"><b className={`script-${lang}`}>{g.text}</b> {g.roman && <em>{g.roman}</em>} — {g.guide}</span>)}</div>
                    )}
                    <button className="mini" onClick={() => setVoiceNote(teacher.say(t.text, lang, { rate: 0.8 }) ? null : `No ${info.name} voice is installed on this PC, so I can't play this line.`)}>▶ Play</button>
                  </>
                )}
                {t.speaker === "user" && (t.input?.mode === "spoken" ? <small className="tag spoken">🎙 recognized speech: this is what the recognizer heard</small> : <small className="tag typed">⌨ typed</small>)}
              </div>
            ))}
            {busy && <div className="bubble ai"><div className="who">{session.scenario.aiRole}</div><div className="line">…</div></div>}
            <div ref={endRef} />
          </div>
          {voiceNote && <p className="notice">{voiceNote}</p>}
          {err && <p className="error">{err} {lastAskRef.current && !busy && <button onClick={() => void askAi(session)}>Try again</button>}</p>}
          {!over && (
            <div className="compose">
              <form onSubmit={(e) => { e.preventDefault(); void send(text, "typed"); }} className="row">
                <input lang={lang} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Answer in ${info.name}`} aria-label="Your answer" disabled={busy} />
                <button className="primary" type="submit" disabled={busy || !text.trim()}>Send</button>
              </form>
              <div className="row">
                {speech.available && speech.ready !== false
                  ? <><button className={speech.phase === "listening" ? "primary rec" : ""} disabled={busy || speech.phase === "starting" || speech.phase === "transcribing"} onClick={() => void talk()}>{speech.phase === "listening" ? "■ Stop and send" : speech.phase === "transcribing" ? "Turning your speech into text…" : speech.error ? "🎙 Try again" : "🎙 Speak your answer"}</button>
                    {(speech.phase === "listening" || speech.phase === "starting" || speech.phase === "transcribing") && <button onClick={() => { speech.cancel(); teacher.react("calm", 1500); setErr("Cancelled: nothing was sent."); }}>Cancel</button>}</>
                  : <span className="hint">Speaking needs a microphone and speech set up (Settings → Language &amp; voice); you can type instead.</span>}
                <button onClick={interrupt} disabled={!teacher.speaking}>Stop Momo talking</button>
                <span className="grow" />
                <span className="hint">{session.completion.userTurns} of {session.completion.minTurns} answers</span>
                <button className={enough || aiEnded ? "primary" : ""} onClick={() => void finish()} title={enough ? "" : `Needs ${session.completion.minTurns} answers to count as completed`}>Finish interview</button>
                <button onClick={leave}>Leave (not completed)</button>
              </div>
            </div>
          )}
          {over && (
            <div className="feedback good">
              <p><strong>{session.status === "completed" ? (session.completion.countsAsCompleted ? "Interview completed." : "Interview ended early.") : "Interview left."}</strong> {session.completion.reason}</p>
              <p className="hint">{published ?? "Saved to your learning history."} Detailed feedback comes from the reporting module, not from this screen.</p>
              <div className="row"><button className="primary" onClick={() => setSid(null)}>Back</button></div>
            </div>
          )}
        </section>
      </>
    );
  }

  // ----- choose a scenario and a role
  const mine = scenario?.roles.find((r) => r.id === roleId);
  return (
    <>
      <section className="panel">
        <h2 className="tight">Final interview · {level}</h2>
        <p className="hint">A real conversation in {info.name}, in a scene you choose. Momo's AI plays the other role, asks follow-up questions that depend on what you say, and adapts to your {level} level. {st.interviewDone ? "You have completed this stage; you can practise again any time." : "Completing it counts toward opening the next level."}</p>
        {open && (
          <div className="notice">
            <strong>Unfinished interview:</strong> {open.scenario.title} ({open.completion.userTurns} answers so far).
            <div className="row"><button className="primary" onClick={() => void begin(open)}>Resume it</button><button onClick={() => update((s) => abandonSession(s, open.sessionId, Date.now()))}>Discard it</button></div>
          </div>
        )}
        <div className="scenes" role="radiogroup" aria-label="Scenario">
          {SCENARIOS.map((s) => <button key={s.id} role="radio" aria-checked={scenarioId === s.id} className={scenarioId === s.id ? "scene on" : "scene"} onClick={() => setScenarioId(s.id)}><strong>{s.title}</strong><small>{s.blurb}</small></button>)}
          <button role="radio" aria-checked={scenarioId === "custom"} className={scenarioId === "custom" ? "scene on" : "scene"} onClick={() => setScenarioId("custom")}><strong>Custom roleplay</strong><small>Describe your own scene and both roles.</small></button>
        </div>
        {scenarioId === "custom" ? (
          <div>
            <label className="field">The scene<input value={custom.setting} maxLength={240} onChange={(e) => setCustom({ ...custom, setting: e.target.value })} placeholder="e.g. a visit to the doctor because of a cold" /></label>
            <label className="field">Your role<input value={custom.userRole} maxLength={40} onChange={(e) => setCustom({ ...custom, userRole: e.target.value })} placeholder="e.g. patient" /></label>
            <label className="field">Momo plays<input value={custom.aiRole} maxLength={40} onChange={(e) => setCustom({ ...custom, aiRole: e.target.value })} placeholder="e.g. doctor" /></label>
          </div>
        ) : scenario && (
          <fieldset className="chips"><legend>I will play</legend>
            <div role="radiogroup" aria-label="Your role">{scenario.roles.map((r) => <button key={r.id} role="radio" aria-checked={roleId === r.id} className={roleId === r.id ? "chip on" : "chip"} onClick={() => setRoleId(r.id)}>{r.label}</button>)}</div>
            {mine && <p className="hint">Momo will play: {scenario.roles.find((r) => r.id !== roleId)?.label}.</p>}
          </fieldset>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row"><button className="primary" onClick={() => void begin()}>Start the interview</button></div>
        <p className="hint">Your lines and Momo's lines are the only text sent to the AI service ({env?.ai.provider ?? "AI"}); no recording is ever saved.</p>
      </section>
      {state.interviews.filter((i) => i.lang === lang).length > 0 && (
        <section className="panel">
          <h2 className="tight">Past interviews</h2>
          <ul className="plain">{[...state.interviews].filter((i) => i.lang === lang).sort((a, b) => b.startedAt - a.startedAt).map((i) => (
            <li key={i.sessionId}>{new Date(i.startedAt).toLocaleString()} · {scenarioById(i.scenarioId)?.title ?? "Custom roleplay"} ({i.userRole}) · {i.status === "completed" ? (i.countsAsCompleted ? "completed" : "ended early") : i.status === "abandoned" ? "left" : "in progress"} · {i.userTurns} answers</li>
          ))}</ul>
        </section>
      )}
    </>
  );
}
