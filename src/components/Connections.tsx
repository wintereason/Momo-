import { useEffect, useState } from "react";
import { desktop, type EnvStatus } from "../desktop";

const Row = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <li className={ok ? "conn on" : "conn"}>
    <span aria-hidden="true">{ok ? "✓" : "—"}</span> {children} <span className="sr-only">{ok ? "found" : "not set"}</span>
  </li>
);

/**
 * Shows which keys from the .env file Momo can see. It receives booleans only: a key's value never reaches
 * this page, so it cannot be displayed, logged or leaked from here. Only FREE services are offered.
 */
export function Connections() {
  const [status, setStatus] = useState<EnvStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const reread = async () => {
    setBusy(true);
    try { setStatus((await desktop?.envStatus()) ?? null); } catch { setStatus(null); }
    setBusy(false);
  };
  useEffect(() => { void reread(); }, []);

  if (!desktop) {
    return <p className="hint">Keys in the <code>.env</code> file are read by the desktop app. This browser preview can't see them.</p>;
  }
  if (!status) return <p className="hint" role="status">Checking your .env file…</p>;

  const s = status;
  const cloud = s.ai.provider !== "ollama";
  return (
    <div className="connections">
      <p className="hint">
        {s.fileFound ? <>Reading <code>{s.files.join(", ")}</code>. Keys stay inside Momo's desktop shell and are never shown here.</> : <>No <code>.env</code> file found. Copy <code>.env.example</code> to <code>.env</code> in the Momo folder and fill in what you want.</>}
      </p>
      {s.problems.length > 0 && (
        <ul className="problems" role="alert">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}

      <strong>AI brain</strong> <small>(all free · {s.ai.enabled ? "switched on" : "switched off"} · provider: {s.ai.provider})</small>
      <ul>
        <Row ok={s.ai.keys.gemini}>Google Gemini key <small>(recommended, free tier)</small></Row>
        <Row ok={s.ai.keys.groq}>Groq key <small>(free tier)</small></Row>
        <Row ok={s.ai.keys.openrouter}>OpenRouter key <small>(":free" models)</small></Row>
        <Row ok={s.ai.keys.ollama}>Ollama address <small>(runs on this PC)</small></Row>
      </ul>
      {cloud && (
        <p className="notice" role="note">
          <strong>Privacy:</strong> free cloud tiers may log what you send. Momo sends only the words you say
          {s.ai.screenContext ? ", and screen text when you ask about it (you turned this on in .env)." : ", never what is on your screen (MOMO_AI_ALLOW_SCREEN_CONTEXT=false)."}
          {" "}Ollama keeps everything on this PC.
        </p>
      )}
      {s.ai.ready ? (
        <p className="hint" role="status">
          ✓ The AI is <strong>active</strong>. It is asked only when Momo's own phrases don't understand you. Requests today:{" "}
          <strong>{s.ai.requestsToday} / {s.ai.limitPerDay}</strong> (this keeps you inside the free tier).
        </p>
      ) : (
        <p className="hint" role="status">
          The AI is {s.ai.enabled ? "switched on but not ready (see above)" : <>switched <strong>off</strong>: set <code>MOMO_AI_ENABLED=true</code> in .env, then click Re-read</>}.
          Until then Momo understands only its built-in phrases.
        </p>
      )}

      <strong>Optional</strong>
      <ul>
        <Row ok={s.speech.hfToken}>Hugging Face token <small>(free; only if the speech-model download is rate-limited)</small></Row>
      </ul>

      <div className="row"><button onClick={reread} disabled={busy}>{busy ? "Reading…" : "Re-read .env"}</button></div>
    </div>
  );
}
