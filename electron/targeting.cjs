// Where does dictated text go? Detect -> Identify -> Focus -> Dictate -> Verify. Never type into an unidentified field.
//  Detect/Identify: UI Automation scan of the window in front (done while the user is still speaking).
//  One suitable field (or one that already has the focus): focus it and write.  Several: ask which.  None: ask for a click.
//  Dictate: paste at the cursor, only after the focus on that very field is proven.  Verify: read the field back.
// Pure orchestration: UI Automation, the keyboard and the clock are passed in, so it is tested without a PC.
// The dictated text is held in memory only while a question is open (60 s at most) and is dropped on any answer.

const PENDING_MS = 60_000;
const CLICK_WAIT_MS = 30_000;

/**
 * @param {{
 *   uia: { scanTargets(h: number): Promise<any>, focusedField(): Promise<any>, focusField(h: number, rid: string): Promise<any>,
 *          readBack(h: number, rid: string, beforeLen: number): Promise<string|null>, planTarget(scan: any): any,
 *          verifyInsertion(b: string|null, a: string|null, t: string): string, describeField(f: any, win: any): string },
 *   foreground: () => { hwnd: number } | null,
 *   inserter: { insert(text: string, opts: any): Promise<any> },
 *   sleep?: (ms: number) => Promise<void>, now?: () => number,
 * }} deps
 */
function createTargeting(deps) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  let detection = null; // { hwnd, promise }
  let pending = null; //   { text, fields?, hwnd?, at, opts }
  let cancelled = false;

  const detect = (hwnd) => ({
    hwnd,
    promise: deps.uia.scanTargets(hwnd).then((scan) => ({ scan, plan: deps.uia.planTarget(scan) })).catch(() => ({ scan: null, plan: { kind: "click" } })),
  });

  return {
    /** The user started speaking: look at the window in front now, so the answer is ready when they finish. */
    begin() {
      const fg = deps.foreground();
      detection = fg && fg.hwnd ? detect(fg.hwnd) : null;
    },

    /** Dictated text is ready. Returns what happened, or a question for the user. */
    async deliver(text, opts = {}) {
      cancelled = false;
      pending = null;
      const fg = deps.foreground();
      // the user moved to another window while speaking: what was found earlier no longer applies
      if (!detection || !fg || detection.hwnd !== fg.hwnd) detection = fg && fg.hwnd ? detect(fg.hwnd) : null;
      const found = detection ? await detection.promise : { scan: null, plan: { kind: "click" } };
      detection = null;
      const plan = found.plan;
      if (plan.kind === "password") return { kind: "blocked", reason: "password", copied: false };
      if (plan.kind === "ready") return insertInto(text, plan.hwnd, plan.field, opts);
      if (plan.kind === "choose") {
        const fields = plan.fields.slice(0, 8);
        pending = { text, hwnd: plan.hwnd, fields, at: now(), opts };
        return {
          kind: "choose",
          options: fields.map((f, i) => ({ id: i, label: f.name.trim() || "Text field", detail: deps.uia.describeField(f, found.scan.win) })),
        };
      }
      pending = { text, at: now(), opts };
      return { kind: "click" };
    },

    /** The user chose one of the listed fields. */
    async pick(id) {
      const p = pending;
      pending = null;
      if (!p || !p.fields || now() - p.at > PENDING_MS) return { kind: "blocked", reason: "expired", copied: false };
      const f = Number.isInteger(id) ? p.fields[id] : undefined;
      if (!f) return { kind: "blocked", reason: "expired", copied: false };
      return insertInto(p.text, p.hwnd, f, p.opts);
    },

    /** After "click inside a field": wait until the user has put the cursor in one, then write there. */
    async waitForClick() {
      const p = pending;
      if (!p || p.fields) return { kind: "blocked", reason: "expired", copied: false };
      cancelled = false;
      while (!cancelled && now() - p.at < CLICK_WAIT_MS) {
        const f = await deps.uia.focusedField();
        if (cancelled) break;
        if (f && f.field) {
          if (f.field.password) { pending = null; return { kind: "blocked", reason: "password", copied: false }; }
          if (f.field.editable) { pending = null; return insertInto(p.text, f.hwnd, f.field, p.opts); }
        }
        await sleep(600);
      }
      const hadText = !!pending;
      pending = null;
      return cancelled ? { kind: "cancelled" } : hadText ? { kind: "blocked", reason: "no_field", copied: true, text: p.text } : { kind: "cancelled" };
    },

    /** The user dismissed the question. The text is dropped. */
    cancel() { cancelled = true; pending = null; detection = null; },
    /** For the caller: is a question open (so the text is still held)? */
    hasPending() { return !!pending; },
  };

  async function insertInto(text, hwnd, field, opts) {
    let before = null;
    let collapsed = false;
    const r = await deps.inserter.insert(text, {
      restoreClipboard: opts.restoreClipboard === true,
      async beforePaste() {
        const f = await deps.uia.focusField(hwnd, field.rid);
        if (!f.ok) return { ok: false, reason: f.reason };
        before = f.before;
        collapsed = !!f.collapsedSelection;
        return { ok: true };
      },
      async afterPaste() {
        if (before === null) return "unreadable";
        const after = await deps.uia.readBack(hwnd, field.rid, before.length);
        return deps.uia.verifyInsertion(before, after, text);
      },
    });
    const label = field.name && field.name.trim() ? field.name.trim() : undefined;
    if (!r.ok) {
      if (r.reason === "target_lost") return { kind: "blocked", reason: r.detail === "password" ? "password" : "target_lost", copied: r.copied, detail: r.detail };
      return { kind: "blocked", reason: r.reason, copied: r.copied };
    }
    return { kind: "inserted", verification: r.verification || "unreadable", field: label, collapsedSelection: collapsed };
  }
}

module.exports = { createTargeting, PENDING_MS, CLICK_WAIT_MS };
