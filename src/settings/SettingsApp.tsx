import { useEffect, useState } from "react";
import { desktop } from "../desktop";
import { loadPrefs, savePrefs, PREFS_KEY, type Prefs } from "../state/settings";
import { Connections } from "../components/Connections";
import { HomePage } from "./pages/HomePage";
import { DictationPage } from "./pages/DictationPage";
import { VoicePage } from "./pages/VoicePage";
import { ShortcutPage } from "./pages/ShortcutPage";
import { AskPage } from "./pages/AskPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { GeneralPage } from "./pages/GeneralPage";
import { CharacterPage } from "./pages/CharacterPage";
import { LearnPage } from "./pages/LearnPage";
import "../styles/settings.css";

export interface PageProps {
  prefs: Prefs;
  set(patch: Partial<Prefs>): void;
}

const PAGES = [
  { id: "home", label: "Home", icon: "⌂", group: "" },
  { id: "voice", label: "Language & voice", icon: "🎙", group: "Dictation" },
  { id: "dictation", label: "Writing style", icon: "✎", group: "Dictation" },
  { id: "shortcut", label: "Shortcut", icon: "⌨", group: "Dictation" },
  { id: "ai", label: "AI & keys", icon: "✦", group: "Smart features" },
  { id: "ask", label: "Ask Momo", icon: "💬", group: "Smart features" },
  { id: "learn", label: "Learn a language", icon: "🎓", group: "Smart features" },
  { id: "character", label: "Character", icon: "☺", group: "App" },
  { id: "general", label: "General", icon: "⚙", group: "App" },
  { id: "privacy", label: "Privacy & data", icon: "🔒", group: "App" },
] as const;
type PageId = (typeof PAGES)[number]["id"];

/** Momo's app window: every setting in one place. The dictation bar itself lives at the bottom of the screen. */
export default function SettingsApp() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(window.localStorage));
  const [page, setPage] = useState<PageId>("home");

  const set = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));
  useEffect(() => { savePrefs(window.localStorage, prefs); }, [prefs]);
  // the desktop character can change its own size (a click on it): follow changes made in the other window
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === PREFS_KEY) setPrefs(loadPrefs(window.localStorage)); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  useEffect(() => { desktop?.setPolicy({ confirmReversible: false, confirmScreenRead: false }); }, []); // routine things never ask; decisions always do

  return (
    <div className="app">
      <nav className="side" aria-label="Settings sections">
        <div className="brand"><span className="logo" aria-hidden="true">m</span> Momo</div>
        {PAGES.map((p, i) => (
          <div key={p.id} className="nav-item">
          {p.group && p.group !== PAGES[i - 1]?.group && <div className="nav-group">{p.group}</div>}
          <button className={p.id === page ? "nav on" : "nav"} onClick={() => setPage(p.id)} aria-current={p.id === page ? "page" : undefined}>
            <span className="nav-icon" aria-hidden="true">{p.icon}</span> {p.label}
          </button>
          </div>
        ))}
        <div className="grow" />
        {desktop && <button className="nav quiet" onClick={() => desktop!.quit()}>Quit Momo</button>}
      </nav>
      <main className="content">
        {!desktop && (
          <p className="notice" role="note">
            <strong>Browser preview.</strong> The dictation bar, the global shortcut and typing into other apps only work in the Momo desktop app (<code>npm run desktop</code>).
          </p>
        )}
        {page === "home" && <HomePage prefs={prefs} set={set} go={(p) => setPage(p)} />}
        {page === "learn" && <LearnPage prefs={prefs} set={set} />}
        {page === "character" && <CharacterPage prefs={prefs} set={set} />}
        {page === "general" && <GeneralPage prefs={prefs} set={set} />}
        {page === "dictation" && <DictationPage prefs={prefs} set={set} />}
        {page === "voice" && <VoicePage prefs={prefs} set={set} />}
        {page === "shortcut" && <ShortcutPage prefs={prefs} set={set} />}
        {page === "ai" && (<><header className="page-head"><h1>AI &amp; keys</h1><p className="lead">Momo uses a free AI service to fix grammar and improve your wording. A free Groq key also unlocks the most accurate cloud speech. Paste a key below to add or replace it; it is saved only on this PC.</p></header><Connections /></>)}
        {page === "ask" && <AskPage />}
        {page === "privacy" && <PrivacyPage prefs={prefs} set={set} />}
      </main>
    </div>
  );
}
