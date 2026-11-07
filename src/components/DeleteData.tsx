import { useState } from "react";
import { desktop } from "../desktop";
import { wipeAllData, type WipeResult } from "../state/wipe";

/** "Delete everything Momo stored on this PC": two steps, so it can't be done by accident. */
export function DeleteData() {
  const [step, setStep] = useState<"idle" | "confirm" | "working" | "done">("idle");
  const [result, setResult] = useState<WipeResult | null>(null);

  const run = async () => {
    setStep("working");
    const shell = desktop;
    const r = await wipeAllData({
      kv: window.localStorage,
      caches: typeof caches !== "undefined" ? { keys: () => caches.keys(), delete: (n) => caches.delete(n) } : undefined,
      desktopWipe: shell ? () => shell.wipeData() : undefined,
    });
    setResult(r);
    setStep("done");
    if (r.ok) setTimeout(() => window.location.reload(), 1800); // back to a first launch
  };

  if (step === "idle") {
    return <button onClick={() => setStep("confirm")}>Delete everything Momo stored…</button>;
  }
  if (step === "confirm") {
    return (
      <div className="notice" role="alertdialog" aria-label="Delete everything Momo stored">
        <p><strong>This removes everything Momo has stored on this PC:</strong> your settings, the AI request counter and the downloaded speech model (about 75 MB; you can download it again).</p>
        <p>Momo never saves audio, transcripts or screenshots, so there is nothing else to delete. Anything already sent to a cloud speech service is outside Momo's control.</p>
        <div className="row">
          <button className="primary" onClick={run}>Yes, delete everything</button>
          <button onClick={() => setStep("idle")}>Keep it</button>
        </div>
      </div>
    );
  }
  if (step === "working") return <p className="hint" role="status">Deleting…</p>;
  return (
    <div role="status">
      {result?.removed.length ? <p className="hint">✓ Removed {result.removed.join(", ")}.</p> : null}
      {result && !result.ok && <p className="error" role="alert">Couldn't remove {result.failed.join(", ")}. You can delete the Momo folder under %APPDATA% by hand.</p>}
      {result?.ok && <p className="hint">Restarting Momo…</p>}
    </div>
  );
}
