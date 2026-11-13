import { useEffect, useState } from "react";
import { desktop, type EnvStatus } from "../desktop";

type Provider = "gemini" | "groq" | "openrouter" | "ollama";

/** The keys you can paste here. Write-only: a saved key is never shown again, only "saved". */
const FIELDS: { key: string; flag: keyof EnvStatus["ai"]["keys"]; label: string; note: string; where: string; placeholder: string; secret: boolean }[] = [
  { key: "GEMINI_API_KEY", flag: "gemini", label: "Google Gemini key", note: "Recommended. Free tier, no card.", where: "aistudio.google.com/apikey", placeholder: "AIza…", secret: true },
  { key: "GROQ_API_KEY", flag: "groq", label: "Groq key", note: "Free tier. Also turns on the most accurate Cloud speech.", where: "console.groq.com/keys", placeholder: "gsk_…", secret: true },
  { key: "OPENROUTER_API_KEY", flag: "openrouter", label: "OpenRouter key", note: "Use only models ending in :free.", where: "openrouter.ai/keys", placeholder: "sk-or-…", secret: true },
  { key: "OLLAMA_HOST", flag: "ollama", label: "Ollama address", note: "Runs on this PC; nothing leaves it.", where: "ollama.com", placeholder: "http://localhost:11434", secret: false },
];

/**
 * Add or replace the keys Momo uses. The page only SENDS what you type (to Momo's desktop shell, which checks it and saves
 * it in Momo's own settings file on this PC) and gets back yes/no: a key never comes back to this page.
 */
export function Connections() {
  const [status, setStatus] = useState<EnvStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reread = async () => {
    setBusy(true);
    try { setStatus((await desktop?.envStatus()) ?? null); } catch { setStatus(null); }
    setBusy(false);
  };
  useEffect(() => { void reread(); }, []);

  const save = async (updates: Record<string, string>, done: string) => {
    if (!desktop) return;
    setBusy(true); setMsg(null);
    try {
      const r = await desktop.envSave(updates);
      if (r.status) setStatus(r.status);
      if (r.ok) { setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !(k in updates)))); setMsg({ ok: true, text: done }); }
      else setMsg({ ok: false, text: r.problems.join(" ") || "That couldn't be saved." });
    } catch { setMsg({ ok: false, text: "That couldn't be saved." }); }
    setBusy(false);
  };

  if (!desktop) return <p className="hint">Keys are saved by the desktop app. This browser preview can't do that.</p>;
  if (!status) return <p className="hint" role="status">Checking your settings…</p>;

  const s = status;
  const provider = s.ai.provider as Provider;
  return (
    <div className="connections">
      <section className="panel">
        <label className="switch-row">
          <span><strong>Use AI to fix grammar and improve wording</strong><small>{s.ai.ready ? `Active (${provider}). ${s.ai.requestsToday} of ${s.ai.limitPerDay} free requests used today.` : s.ai.enabled ? "Switched on, but not ready: add a key below." : "Switched off. Without it Momo only does basic clean-up."}</small></span>
          <span className="switch">
            <input type="checkbox" role="switch" checked={s.ai.enabled} disabled={busy} onChange={(e) => void save({ MOMO_AI_ENABLED: e.target.checked ? "true" : "false" }, e.target.checked ? "AI switched on." : "AI switched off.")} />
            <i aria-hidden="true" />
          </span>
        </label>
        <label className="field">Which service to use
          <select value={provider} disabled={busy} onChange={(e) => void save({ MOMO_AI_PROVIDER: e.target.value }, "Service changed.")}>
            <option value="gemini">Google Gemini</option>
            <option value="groq">Groq</option>
            <option value="openrouter">OpenRouter</option>
            <option value="ollama">Ollama (on this PC)</option>
          </select>
        </label>
        {s.ai.provider !== "ollama" && (
          <p className="hint">Free cloud services may log what you send. Momo sends only the words you say{s.ai.screenContext ? ", and screen text when you ask about it" : ", never what is on your screen"}.</p>
        )}
      </section>

      <section className="panel">
        <h2>Keys</h2>
        <p className="hint">Paste a key and press Save. It is checked, then stored only on this PC in Momo's settings file, and never shown here again. Paste a new one any time to replace it.</p>
        {FIELDS.map((f) => {
          const have = s.ai.keys[f.flag];
          const value = draft[f.key] ?? "";
          return (
            <div className="key-row" key={f.key}>
              <div className="key-head">
                <strong>{f.label}</strong>
                <span className={have ? "badge ok" : "badge"}>{have ? "✓ Saved" : "Not set"}</span>
              </div>
              <small className="muted">{f.note} Get one at <code>{f.where}</code></small>
              <div className="key-input">
                <input
                  type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false}
                  placeholder={have ? "Paste a new value to replace it" : f.placeholder}
                  value={value} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} aria-label={f.label}
                />
                <button className="primary" disabled={busy || !value.trim()} onClick={() => void save({ [f.key]: value }, `${f.label} saved.`)}>Save</button>
                {have && <button disabled={busy} onClick={() => void save({ [f.key]: "" }, `${f.label} removed.`)}>Remove</button>}
              </div>
            </div>
          );
        })}
        {msg && <p className={msg.ok ? "hint ok-text" : "error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
        {s.problems.length > 0 && <ul className="problems" role="alert">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      </section>

      <section className="panel">
        <h2>Optional</h2>
        <div className="key-row">
          <div className="key-head"><strong>Hugging Face token</strong><span className={s.speech.hfToken ? "badge ok" : "badge"}>{s.speech.hfToken ? "✓ Saved" : "Not set"}</span></div>
          <small className="muted">Free. Only needed if the speech-model download is rate-limited. Get one at <code>huggingface.co/settings/tokens</code></small>
          <div className="key-input">
            <input type="password" autoComplete="off" spellCheck={false} placeholder={s.speech.hfToken ? "Paste a new value to replace it" : "hf_…"} value={draft.HF_TOKEN ?? ""} onChange={(e) => setDraft({ ...draft, HF_TOKEN: e.target.value })} aria-label="Hugging Face token" />
            <button className="primary" disabled={busy || !(draft.HF_TOKEN ?? "").trim()} onClick={() => void save({ HF_TOKEN: draft.HF_TOKEN }, "Hugging Face token saved.")}>Save</button>
            {s.speech.hfToken && <button disabled={busy} onClick={() => void save({ HF_TOKEN: "" }, "Token removed.")}>Remove</button>}
          </div>
        </div>
      </section>

      <p className="hint">Saved in <code>{s.files.length ? s.files.join(", ") : "Momo/.env"}</code> on this PC. <button className="link" onClick={reread} disabled={busy}>Re-read the file</button> if you edited it by hand.</p>
    </div>
  );
}
