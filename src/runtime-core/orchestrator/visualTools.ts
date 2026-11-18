import { z } from "zod";
import { aimAt, bringToFront, glideMs, HUMAN_OFF, humanPointer, retryCovered, stoppedWhy, titlesNow, type ToolCtx, type ToolDef, type ToolOutcome, type Win } from "./tools";
import { classifyControlRisk } from "../action";
import type { TargetCheck } from "../shared/ports";
import { failBefore, ok, ownerWindow } from "./popupTools";
import { cleanScreenText } from "../shared/screenText";
import { labelKey, type CaptureFrame, type LookOutcome, type VisualCandidate } from "../vision";

/**
 * Looking at windows whose controls Windows cannot see (Phase 6b). Read-only: nothing here clicks, types, moves the pointer or touches the window.
 *
 *  - look_visual (6b)  what a window LOOKS like: labelled button-like shapes, unlabelled shapes, large areas and loose text, each with a
 *                      confidence score and an honest reason when it may not be used as a target.
 *
 * Privacy: sensitive (kept from an online AI unless the user allowed it), confirmed like every other screen read, never aimed at Momo's own
 * windows or at a window with a password box. The recognised text is in the answer for this step only; the journal gets fixed facts.
 */

const short = (s: string, n = 60): string => { const c = cleanScreenText(s); return c.length > n ? c.slice(0, n - 1) + "…" : c; };
const mk = (d: Omit<ToolDef, "risk"> & { risk: "read" | "sensitive_read" }): ToolDef => ({ ...d, risk: () => d.risk } as ToolDef);
const KIND_WORD: Record<VisualCandidate["kind"], string> = { button_like: "button-like shape with a label", shape: "unlabelled shape", region: "large area", text: "loose text" };
const MAX_LINES = 20;

const describeOne = (c: VisualCandidate, n: number): string => {
  const where = `at ${c.rect.l},${c.rect.t} size ${c.rect.w}×${c.rect.h}`;
  const label = c.text ? ` “${short(c.text, 40)}”` : "";
  const verdict = c.usable ? "could be offered as a target" : `NOT a target: ${c.issues[0] ?? "not confident enough"}`;
  return `${n}) ${KIND_WORD[c.kind]}${label} · score ${c.confidence.toFixed(2)} · ${verdict} · ${where}`;
};

export function buildVisualTools(): ToolDef[] {
  return [
    clickVisualTool(),
    mk({
      name: "look_visual", signature: "look_visual({window?, find?})",
      description: "Look at the PICTURE of a window whose controls Windows cannot list (a canvas, a game-like or custom-drawn app, a GPU-rendered page): shapes that look like labelled buttons, shapes without a label, large areas and loose text, each with a score. Use it only after read_window / click_control show that the window does not expose what you need. It only LOOKS: it never clicks. What it finds are things that LOOK like controls, not proven controls: a word alone is not a button, and a shape without a label is never guessed at. `find` narrows the list to a label (a word that appears on two candidates is reported as ambiguous). Without `window`, the window the user was just in.",
      schema: z.object({ window: z.string().trim().min(1).max(120).optional(), find: z.string().trim().min(1).max(80).optional(), _hwnd: z.number().int().optional() }).strict() as never,
      sensitive: true, risk: "sensitive_read",
      describe: (a) => `Take a look at the picture of ${a.window ? `the “${short(String(a.window), 40)}” window` : "the window you were just in"}?`,
      working: () => "Looking at the window…",
      async run(a, ctx: ToolCtx): Promise<ToolOutcome> {
        const look = ctx.d.visualLook;
        if (!look) return failBefore("Looking at window pictures isn't available in this build.", "unavailable");
        const own = await ownerWindow(ctx, a.window as string | undefined, a._hwnd as number | undefined);
        if ("out" in own) return own.out;
        const hwnd = own.hwnd || ctx.d.foreground?.lastExternal()?.hwnd || 0;
        if (!hwnd) return failBefore("I can't tell which window is meant. Ask the user to click it, or name it.", "target_not_found");
        const snap = await ctx.d.desktopAgent.snapshot();
        if (!ctx.live()) return failBefore("cancelled", "unavailable");
        const win = snap.windows.find((w) => w.hwnd === hwnd);
        if (!win) return failBefore("That window is gone.", "target_gone");
        if (win.isMomo) return failBefore("That is one of my own windows, so I will not take a picture of it.", "blocked_by_policy");
        // a screenshot would show whatever a password box shows
        const ui = await ctx.d.uiAgent.read(hwnd);
        if (!ctx.live()) return failBefore("cancelled", "unavailable");
        if (ui.ok && ui.hadPasswordField) return failBefore("This window has a password box, so I will not take a picture of it.", "blocked_by_policy");

        const r = await look.look(hwnd, ctx.live);
        if (!ctx.live()) return failBefore("cancelled", "unavailable");
        if (!r.ok) return failBefore(r.reason, r.state === "gone" ? "target_gone" : "unavailable");

        const want = a.find ? labelKey(String(a.find)) : "";
        const all = r.candidates;
        const shown = want ? all.filter((c) => c.text && labelKey(c.text).includes(want)) : all;
        const usable = all.filter((c) => c.usable).length;
        const edge = r.frame.clipped ? " Part of this window is outside the screen, so anything drawn there may be missing from the picture, and nothing there can be used." : "";
        const head = `Looked at “${short(win.title, 50)}” (${all.length} thing${all.length === 1 ? "" : "s"} found, ${usable} that could be offered as a target; read in ${r.stages.totalMs} ms). These are what the picture LOOKS like, not proven controls.${edge}`;
        if (all.length === 0) return ok(`${head} Nothing recognisable: the window may be mostly plain, or its text too small to read. That does NOT mean it is empty.`, true);
        if (want && shown.length === 0) return ok(`${head} No candidate has the label “${short(String(a.find), 40)}”. That does not prove it is not there; the picture may not show it clearly.`, true);
        const lines = shown.slice(0, MAX_LINES).map((c, i) => describeOne(c, i + 1));
        const more = shown.length > MAX_LINES ? ` (+${shown.length - MAX_LINES} more)` : "";
        return ok(`${head}\n${lines.join("\n")}${more}`, true);
      },
    }),
  ];
}

// =====================================================================================================================================
// click_visual (Phase 6c): the ONLY thing in Momo that clicks a place found by looking at a picture.
//
// What a click here has to get through, in order, and every refusal before the last step sends nothing:
//   1. The user's own words must contain the label (Momo never clicks something it came up with, and never guesses what an icon does).
//   2. Windows' own description of the window (UI Automation) is asked first: if it can name the control, a picture is not used at all.
//   3. A fresh look: exactly ONE button-like shape carries exactly that label (same letters, nothing similar or partial), it is usable
//      (confident, cleanly read, read the same way by independent readings) and entirely on the screen. Any twin, usable or not, is a refusal.
//   4. The real pointer glides there under every Phase 3 guard (window family under it, window exactly where it was seen, takeover, Esc,
//      cancel), and at the very last moment BEFORE the press the window is captured and detected AGAIN: still exactly one, still usable, still
//      within 3 px of where it was seen, and the pointer is inside it. Only then is the button pressed.
//   5. Whether it worked is a separate question: only the effect the caller named (a label that must appear or disappear, a new window)
//      counts, checked from Windows' tree and from a fresh picture. A picture that merely CHANGED proves nothing; with no expectation, or an
//      expectation that does not hold, the click is reported unverified. It is never repeated once input may have been sent.
// =====================================================================================================================================

/** the user's words contain the label as whole words (case, punctuation and spacing aside): the click is something they asked for */
export function instructionNames(instruction: string, label: string): boolean {
  const n = (x: string): string => " " + x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
  const l = n(label);
  return l.trim() !== "" && n(instruction).includes(l);
}

/** how far (physical pixels) the button may have moved between the first look and the last look before the press */
export const CLICK_TOLERANCE_PX = 3;
const INTERACTIVE = new Set(["Button", "MenuItem", "Hyperlink", "TabItem", "CheckBox", "RadioButton", "SplitButton", "ListItem"]);

export interface ClickExpect { appears?: string; disappears?: string; windowTitle?: string }

type Refusal = { reason: string; kind: "target_not_found" | "target_gone" | "target_moved" | "ambiguous" | "unavailable" | "invalid_request" | "blocked_by_policy" | "wrong_window" | "cancelled" };
const refusal = (reason: string, kind: Refusal["kind"]): Refusal => ({ reason, kind });
const txt = (x: string): string => short(x, 40);

/** every label the picture shows (buttons, loose text, areas), as comparable keys: held for the duration of one step only */
const visibleKeys = (cands: VisualCandidate[]): Set<string> => new Set(cands.filter((c) => c.text && c.kind !== "shape").map((c) => labelKey(c.text!)).filter((k) => k !== ""));

/** One button-like shape with exactly this label, usable and on the screen, from one look: or the reason there is none. */
function pickOne(r: LookOutcome, want: string, label: string): { ok: true; c: VisualCandidate; frame: CaptureFrame; keys: Set<string> } | ({ ok: false } & Refusal) {
  if (!r.ok) return { ok: false, ...refusal(r.reason, r.state === "gone" ? "target_gone" : "unavailable") };
  if (r.frame.clipped) return { ok: false, ...refusal("Part of that window is outside the screen, so I cannot be sure nothing is hidden there. I clicked nothing.", "unavailable") };
  const same = r.candidates.filter((c) => c.kind === "button_like" && !!c.text && labelKey(c.text) === want);
  if (same.length === 0) return { ok: false, ...refusal("I could not see a button labelled “" + txt(label) + "” in that window. I clicked nothing.", "target_not_found") };
  if (same.length > 1) return { ok: false, ...refusal("More than one button looks like “" + txt(label) + "”, so I would not know which one you mean. I clicked nothing.", "ambiguous") };
  const c = same[0];
  if (!c.usable) return { ok: false, ...refusal("I can see something that looks like “" + txt(label) + "”, but I cannot trust it (" + (c.issues[0] ?? "not confident enough").replace(/\.$/, "").toLowerCase() + "). I clicked nothing.", "target_not_found") };
  return { ok: true, c, frame: r.frame, keys: visibleKeys(r.candidates) };
}

const centreOf = (r: { l: number; t: number; w: number; h: number }) => ({ x: Math.round(r.l + r.w / 2), y: Math.round(r.t + r.h / 2) });

function clickVisualTool(): ToolDef {
  return {
    name: "click_visual", signature: "click_visual({label, window?, expect?: {appears?, disappears?, windowTitle?}})",
    description: "LAST RESORT: click a button that is only a drawn picture (a canvas, a GPU-rendered or custom-drawn interface) and that Windows does not list, found by looking at the window. Use it only when click_control cannot find the control and the user NAMED the button in their own words: label must be those exact words (never a guess, never an icon's meaning, never something similar). It refuses unless exactly one button in the picture carries exactly that label and it was read reliably, and it looks again immediately before pressing. IMPORTANT: say what should happen in the expect argument when the user told you (a label that must appear or disappear, or the title of a window that must open): only that effect counts as success. Without it the click is reported as unconfirmed. Needs Human-like control.",
    sensitive: false,
    risk: (a) => classifyControlRisk(String(a.label ?? "")),
    schema: z.object({
      label: z.string().trim().min(1).max(60),
      window: z.string().trim().min(1).max(120).optional(),
      _hwnd: z.number().int().optional(),
      expect: z.object({ appears: z.string().trim().min(1).max(60).optional(), disappears: z.string().trim().min(1).max(60).optional(), windowTitle: z.string().trim().min(1).max(80).optional() }).strict().optional(),
    }).strict() as never,
    describe: (a) => "Click the button labelled “" + short(String(a.label), 50) + "” in " + (a.window ? "the “" + short(String(a.window), 40) + "” window" : "the window you were in") + ", found by looking at it?" + (classifyControlRisk(String(a.label)) === "consequential" ? " This might not be undoable." : ""),
    working: (a) => "Looking for the button “" + short(String(a.label), 40) + "”…",

    async run(a, ctx: ToolCtx): Promise<ToolOutcome> {
      const label = String(a.label);
      const want = labelKey(label);
      const ex = (a.expect ?? {}) as ClickExpect;
      const hasExpect = !!(ex.appears || ex.disappears || ex.windowTitle);
      const stop = (r: Refusal): ToolOutcome => (r.kind === "cancelled" ? ({ ok: false, reason: "cancelled" } as ToolOutcome) : failBefore(r.reason, r.kind));

      // ---- 0) only what the user named, on a pointer that is allowed to exist
      const p = humanPointer(ctx);
      if (!p) return failBefore(HUMAN_OFF, "unavailable");
      const look = ctx.d.visualLook;
      if (!look) return failBefore("Looking at window pictures isn't available in this build.", "unavailable");
      const said = ctx.instruction?.();
      if (typeof said !== "string" || !instructionNames(said, label)) return failBefore("That is not a label you asked me to click, so I will not click it.", "invalid_request");
      if (want.length < 2) return failBefore("A label that short cannot be told apart reliably, so I will not click by it.", "invalid_request");

      // ---- 1) the window
      const own = await ownerWindow(ctx, a.window as string | undefined, a._hwnd as number | undefined);
      if ("out" in own) return own.out;
      const hwnd = own.hwnd || ctx.d.foreground?.lastExternal()?.hwnd || 0;
      if (!hwnd) return failBefore("I can't tell which window is meant. Ask the user to click it, or name it.", "target_not_found");
      const snap = await ctx.d.desktopAgent.snapshot();
      if (!ctx.live()) return stop(refusal("cancelled", "cancelled"));
      const entry = snap.windows.find((w) => w.hwnd === hwnd);
      if (!entry) return failBefore("That window is gone.", "target_gone");
      if (entry.isMomo) return failBefore("That is one of my own windows, so I will not click in it.", "blocked_by_policy");
      const win: Win = { hwnd: entry.hwnd, pid: entry.pid, title: entry.title, process: entry.process };

      // ---- 2) Windows' own description first: if it can name the control, a picture is not used at all
      const ui = await ctx.d.uiAgent.read(hwnd);
      if (!ctx.live()) return stop(refusal("cancelled", "cancelled"));
      if (ui.ok) {
        if (ui.hadPasswordField || ui.passwordFocused) return failBefore("This window has a password box, so I will not take a picture of it or click in it.", "blocked_by_policy");
        const named = ui.items.filter((n) => INTERACTIVE.has(n.type) && !!n.name && labelKey(n.name) === want && !n.offscreen);
        if (named.length === 1) return failBefore("Windows can identify a control with that name itself, so I will not click a picture of it. Use click_control for this one.", "invalid_request");
        if (named.length > 1) return failBefore("Windows lists more than one control with that name, so I will not guess from a picture.", "ambiguous");
      }

      // ---- 3) a fresh look: exactly one, usable, on the screen
      const fr = await bringToFront(ctx, win);
      if (!ctx.live()) return stop(refusal("cancelled", "cancelled"));
      if (!fr.front) return failBefore("I could not bring “" + short(win.title) + "” to the front, so I clicked nothing.", "wrong_window");
      const r1 = await look.look(hwnd, ctx.live);
      if (!ctx.live()) return stop(refusal("cancelled", "cancelled"));
      const first = pickOne(r1, want, label);
      if (!first.ok) return stop(first);
      // the effect has to be something the click could have CAUSED
      const uiNames = ui.ok ? new Set(ui.items.filter((n) => !!n.name).map((n) => labelKey(n.name))) : new Set<string>();
      const shownNow = (k: string): boolean => first.keys.has(k) || uiNames.has(k);
      if (ex.appears && shownNow(labelKey(ex.appears))) return failBefore("“" + txt(ex.appears) + "” is already on the screen, so I could not tell whether the click made it appear. I clicked nothing.", "invalid_request");
      if (ex.disappears && !shownNow(labelKey(ex.disappears))) return failBefore("“" + txt(ex.disappears) + "” is not on the screen now, so I could not tell whether the click made it go. I clicked nothing.", "invalid_request");

      // ---- 4) the real pointer, guarded; the last look happens AFTER the glide and BEFORE the press
      const cand = first.c;
      await aimAt(ctx, cand.rect, cand.text ?? label, "Clicking the button “" + short(label, 36) + "” (found by looking at the window)", "button");
      if (!ctx.live()) return stop(refusal("cancelled", "cancelled"));
      const titles0 = await titlesNow(ctx);
      let why: Refusal | null = null;
      let pre: { keys: Set<string> } | null = null;
      const near = (x: number, y: number): boolean => Math.abs(x - y) <= CLICK_TOLERANCE_PX;
      const check: TargetCheck = async (pt) => {
        why = null; pre = null;
        const r2 = await look.look(hwnd, ctx.live);
        if (!ctx.live()) { why = refusal("cancelled", "cancelled"); return { ok: false, reason: "cancelled" }; }
        const second = pickOne(r2, want, label);
        if (!second.ok) { why = second; return { ok: false, reason: "changed" }; }
        const f1 = first.frame, f2 = second.frame, c2 = second.c;
        if (f2.hwnd !== f1.hwnd || !near(f2.l, f1.l) || !near(f2.t, f1.t) || !near(f2.pw, f1.pw) || !near(f2.ph, f1.ph)) { why = refusal("The window moved or changed size after I looked at it, so I clicked nothing.", "target_moved"); return { ok: false, reason: "changed" }; }
        if (!near(c2.rect.l, cand.rect.l) || !near(c2.rect.t, cand.rect.t) || !near(c2.rect.w, cand.rect.w) || !near(c2.rect.h, cand.rect.h)) { why = refusal("The button “" + txt(label) + "” is not where I saw it a moment ago, so I clicked nothing.", "target_moved"); return { ok: false, reason: "changed" }; }
        if (pt.x < c2.rect.l || pt.x > c2.rect.l + c2.rect.w || pt.y < c2.rect.t || pt.y > c2.rect.t + c2.rect.h) { why = refusal("The pointer is not on the button any more, so I clicked nothing.", "target_moved"); return { ok: false, reason: "changed" }; }
        if (ex.appears && second.keys.has(labelKey(ex.appears))) { why = refusal("“" + txt(ex.appears) + "” appeared on the screen before I clicked, so I could not tell whether the click made it appear. I clicked nothing.", "invalid_request"); return { ok: false, reason: "changed" }; }
        if (ex.disappears && !second.keys.has(labelKey(ex.disappears)) && !uiNames.has(labelKey(ex.disappears))) { why = refusal("“" + txt(ex.disappears) + "” is gone from the screen before I clicked, so I could not tell whether the click removed it. I clicked nothing.", "invalid_request"); return { ok: false, reason: "changed" }; }
        pre = { keys: second.keys };
        return { ok: true };
      };
      const at = centreOf(cand.rect);
      const frame1 = first.frame;
      const res = await retryCovered(ctx, win, () => p.click(at.x, at.y, { ms: glideMs(ctx), expectRoot: win.hwnd, expectWindow: { hwnd: win.hwnd, rect: { l: frame1.l, t: frame1.t, w: frame1.pw, h: frame1.ph } }, verifyTarget: check }));
      if (!ctx.live()) return { ok: false, reason: "cancelled" };
      if (!res.ok) {
        const refused = why as Refusal | null;
        if (res.reason === "changed" && refused) return stop(refused);
        switch (res.reason) {
          case "user_moved": case "stopped": return { ok: false, reason: stoppedWhy(res.reason) };
          case "cancelled": return { ok: false, reason: "cancelled" };
          case "password": return failBefore("That is a password field, and I never touch those. Nothing was clicked.", "blocked_by_policy");
          case "gone": return failBefore("“" + short(win.title) + "” closed, so I stopped. Nothing was clicked.", "target_gone");
          case "moved": case "changed": return failBefore("The window or the button moved after I looked, so I clicked nothing.", "target_moved");
          case "covered": return failBefore("Another window is covering that spot, so I clicked nothing.", "wrong_window");
          case "offscreen": case "cursor_refused": return failBefore("The pointer cannot get to that spot, so I clicked nothing.", "unavailable");
          default: return { ok: false, reason: "I could not click it (" + String(res.reason) + ")." }; // not known to be before the press: the pointer says how far it got
        }
      }
      const preState = pre as { keys: Set<string> } | null;

      // ---- 5) the click was sent. Did it do what was asked? Only the named effect counts.
      const target = { hwnd: win.hwnd, pid: win.pid };
      ctx.d.emit({ type: "cursor.result", state: "verifying", text: "Checking…" });
      if (!hasExpect) return ok("Clicked the button “" + txt(label) + "” (found by looking at the window), but I was not told what should happen, so I cannot confirm that it worked.", false, { acted: "yes", target });
      const eff = await waitForEffect(ctx, look, win, ex, titles0);
      if (!ctx.live()) return { ok: false, reason: "cancelled" };
      void preState;
      return eff.holds
        ? ok("Clicked the button “" + txt(label) + "” and confirmed it worked: " + eff.said + ".", true, { acted: "yes", target, shown: eff.said })
        : ok("Clicked the button “" + txt(label) + "”, but " + eff.missing + ", so I cannot confirm that it worked.", false, { acted: "yes", target });
    },

    async confirm(a, target, view) {
      // verify-only recovery: look, never press. Windows' tree can show an expected label; a picture cannot be taken from here, so absence is "cannot tell"
      const ex = (a.expect ?? {}) as ClickExpect;
      if (!target || !ex.appears) return { verified: null, evidence: [] };
      const ui = await view.readWindow(target.hwnd);
      if (!ui.ok) return { verified: null, evidence: [{ kind: "observation_failed", ok: null }] };
      const want = labelKey(ex.appears);
      const present = ui.items.some((n) => !!n.name && labelKey(n.name) === want);
      return present ? { verified: true, evidence: [{ kind: "tool_verified", ok: true }] } : { verified: null, evidence: [{ kind: "tool_unverified", ok: null }] };
    },
  };
}

/** Wait (a few seconds at most) for the named effect, from Windows' tree AND a fresh picture. A look that cannot be trusted is "cannot tell", never "gone". */
async function waitForEffect(ctx: ToolCtx, look: NonNullable<ToolCtx["d"]["visualLook"]>, win: Win, ex: ClickExpect, titlesBefore: Map<number, string>): Promise<{ holds: boolean; said: string; missing: string }> {
  const sleep = ctx.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const deadline = Date.now() + 3000;
  const norm = (x: string): string => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  let missing = "the expected effect did not show";
  for (let round = 0; round < 6 && ctx.live(); round++) {
    if (round > 0) await sleep(250);
    const said: string[] = [];
    const lacking: string[] = [];
    if (ex.windowTitle) {
      const now = await titlesNow(ctx);
      const w = norm(ex.windowTitle);
      const hit = w !== "" && [...now].some(([h, t]) => !titlesBefore.has(h) && norm(t).includes(w));
      if (hit) said.push("a window titled “" + txt(ex.windowTitle) + "” opened"); else lacking.push("no window titled “" + txt(ex.windowTitle) + "” opened");
    }
    if (ex.appears || ex.disappears) {
      const uia = await ctx.d.uiAgent.read(win.hwnd);
      const uiaKeys = uia.ok ? new Set(uia.items.filter((n) => !!n.name).map((n) => labelKey(n.name))) : null;
      const lr = await look.look(win.hwnd, ctx.live);
      const visKeys = lr.ok && !lr.frame.clipped ? visibleKeys(lr.candidates) : null; // a picture that could not be trusted says nothing
      if (ex.appears) {
        const k = labelKey(ex.appears);
        if ((uiaKeys?.has(k) ?? false) || (visKeys?.has(k) ?? false)) said.push("“" + txt(ex.appears) + "” is now shown"); else lacking.push("“" + txt(ex.appears) + "” did not appear");
      }
      if (ex.disappears) {
        const k = labelKey(ex.disappears);
        const absent = visKeys !== null && !visKeys.has(k) && !(uiaKeys?.has(k) ?? false);
        if (absent) said.push("“" + txt(ex.disappears) + "” is gone"); else lacking.push(visKeys === null ? "I could not look at the window again to see whether “" + txt(ex.disappears) + "” went" : "“" + txt(ex.disappears) + "” is still there");
      }
    }
    if (lacking.length === 0) return { holds: true, said: said.join(" and "), missing: "" };
    missing = lacking.join(" and ");
    if (Date.now() > deadline) break;
  }
  return { holds: false, said: "", missing };
}
