import { useEffect, useState } from "react";
import { desktop } from "../../desktop";
import type { PageProps } from "../SettingsApp";

export function GeneralPage({ prefs, set }: PageProps) {
  const [auto, setAuto] = useState<boolean | null>(null);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => { void desktop?.getAutostart().then(setAuto).catch(() => setAuto(false)); }, []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  return (
    <>
      <header className="page-head"><h1>General</h1><p className="lead">How Momo lives on your PC.</p></header>

      <section className="panel">
        <label className="switch-row">
          <span><strong>Start Momo when Windows starts</strong><small>It waits quietly in the tray, so dictation works as soon as you sign in. Closing this window does not stop it.</small></span>
          <span className="switch">
            <input type="checkbox" role="switch" checked={auto === true} disabled={auto === null || !desktop} onChange={(e) => { setAuto(e.target.checked); void desktop?.setAutostart(e.target.checked).then(setAuto); }} />
            <i aria-hidden="true" />
          </span>
        </label>
        {!desktop && <p className="hint">Only available in the installed Momo app.</p>}
      </section>

      <section className="panel">
        <label className="switch-row">
          <span><strong>Shadow cursor</strong><small>While Momo works on a task, a soft ghost pointer glides to the box or button it is using, so you can follow along. It appears only during a task and never clicks by itself (the real pointer, if you allow Human-like control below, does that).</small></span>
          <span className="switch">
            <input type="checkbox" role="switch" checked={prefs.shadowCursor} onChange={(e) => set({ shadowCursor: e.target.checked })} />
            <i aria-hidden="true" />
          </span>
        </label>
      </section>

      <section className="panel">
        <label className="switch-row">
          <span><strong>Human-like control</strong><small>Momo uses your real mouse and keyboard the way a person does: it moves the pointer to a button, clicks, opens a folder, types. The shadow cursor moves with it. It never clicks something it has not identified first, and it stops at once if you move the mouse or press Esc.</small></span>
          <span className="switch">
            <input type="checkbox" role="switch" checked={prefs.humanInput} onChange={(e) => set({ humanInput: e.target.checked })} />
            <i aria-hidden="true" />
          </span>
        </label>
      </section>

      <section className="panel">
        <div className="switch-row static">
          <span><strong>Internet</strong><small>{online ? "Connected. Cloud speech and AI wording can work." : "Offline. Speech on this PC still works; cloud speech and AI wording wait for a connection."}</small></span>
          <span className={online ? "badge ok" : "badge warn"}>{online ? "Online" : "Offline"}</span>
        </div>
      </section>

      <section className="panel">
        <strong>To stop Momo completely</strong>
        <p className="hint">Right-click the Momo icon in the system tray (bottom right, maybe under the ^ arrow) and choose Quit. While it is quit, the shortcut does nothing.</p>
        {desktop && <div className="row"><button onClick={() => desktop!.quit()}>Quit Momo now</button></div>}
      </section>
    </>
  );
}
