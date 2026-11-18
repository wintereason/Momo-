import { parseRuntimeEvent } from "../../types/runtime-events";
import { decide, resolveYesNo, type Risk } from "../action";
import { resolveChoice } from "./choice";
import { TOOL_CATALOG, buildTools, type AgentDeps, type ToolDef, type ToolOutcome } from "./tools";
import type { PlanStep } from "./ai/prompts";
import { describeFailure, isTerminal, maxActed, type Acted, type Evidence, type Failure } from "./recovery/taxonomy";
import { decideRetry, refreshArgs } from "./recovery/policy";
import { waitResponsive } from "./recovery/hung";
import { ActionJournal, type JournalEntry } from "./recovery/journal";
import { verifyOnly, type ReadOnlyView, type StepTarget } from "./recovery/verifyOnly";

export type { AgentDeps };
export type OrchestratorDeps = AgentDeps;

const WITHHELD = "[Private result: not shown to the AI. It will be shown to the user exactly as read. If that completes the goal, finish with done.]";

/** What one try of a step left behind (see Orchestrator.executeOnce). */
interface Attempt {
  /** the task was cancelled or the user took over: nothing more is done */
  stop?: boolean;
  out: ToolOutcome;
  threw: boolean;
  delivered?: Acted;
  failure?: Failure;
  verdict?: "verified" | "absent" | "unconfirmed";
  facts: Evidence;
  seq: number;
  base: Risk;
  isAction: boolean;
}

/** Say what the look found when it explains the missing result: a frozen window, or a dialog waiting for an answer. Facts only; nothing is clicked. */
function annotate(out: ToolOutcome, f: Evidence): ToolOutcome {
  const notes: string[] = [];
  if (f.windowHung === true) notes.push("The window is not responding right now, so I sent it nothing more.");
  if (f.windowBlockedByDialog === true || f.newWindowAppeared === true) notes.push("A dialog or new window appeared and may be waiting for an answer; I did not click anything in it. Look at the screen.");
  if (notes.length === 0) return out;
  const add = " " + notes.join(" ");
  if (out.ok) return { ...out, brief: out.brief + add, report: out.report + add };
  if ("reason" in out) return { ...out, reason: out.reason + add };
  return out;
}

/** One tool call, ready to run. `confirmed` means the user already approved exactly this call. */
interface Call { tool: ToolDef; args: Record<string, unknown>; confirmed: boolean; lock?: string }

/** One goal being pursued. Lives only in memory, for this goal. */
interface Task {
  id: string;
  goal: string;
  steps: PlanStep[];
  moves: number;
  /** tool results that are private and were kept from the AI: shown to the user at the end (only those still current) */
  reports: { text: string; epoch: number }[];
  /** actions that ran but could not be confirmed: never repeated blindly */
  unverifiedActions: Set<string>;
  /** how many tool calls succeeded, and how many of those could not be confirmed */
  ran: number;
  unverified: number;
  failures: number;
  /** counts every action that changed something, so an identical read AFTER a change is not mistaken for a repeat */
  epoch: number;
  seen: Map<string, number>;
  repeats: number;
  /** what was done in this task and how far each step got (bounded, in memory, no content): see recovery/journal.ts */
  journal: ActionJournal;
  /** automatic retries used in this task (shared by every tool), and per call */
  retries: number;
  retried: Map<string, number>;
}

type Pending =
  | { kind: "ask"; task: Task; question: string }
  | { kind: "confirm"; task: Task; call: Call; asked: number; timer: ReturnType<typeof setTimeout> }
  | { kind: "pick"; task: Task; call: Call; labels: string[]; details?: string[]; patches: Record<string, unknown>[]; asked: number };

/**
 * The orchestrator: the single coordinating authority. It owns the user's GOAL and runs one loop:
 *   plan (the AI picks the next tool) -> permission gate (ask when it is a decision) -> act (a specialist role)
 *   -> verify (the result is checked) -> observe (what happened goes back to the planner) -> recover or finish.
 * It never takes the AI's word for anything: the AI only names tools, and every call is validated, gated and verified here.
 * There are no per-task handlers: what Momo can do is exactly what its tools can do, and the planner combines them.
 */
/** Tools whose result is a window that has just appeared or come forward. */
const OPENING_TOOLS = new Set(["open_path", "open_app", "open_url", "switch_tab"]);

export class Orchestrator {
  private seq = 0;
  private generation = 0;
  private pending: Pending | null = null;
  private busy = false;
  private lastTaskId: string | null = null;
  private abandoned = new Set<string>();
  /** the journal of the most recent task (memory only; replaced by the next task's) */
  private lastJournal: ActionJournal | null = null;
  /** a copy of the most recent task's action journal: what ran, how far it got, what looking afterwards found. Holds no content. */
  journal(): JournalEntry[] { return this.lastJournal ? this.lastJournal.entries() : []; }
  private tools = buildTools();
  private catalogue = TOOL_CATALOG(this.tools);

  constructor(private d: AgentDeps) {}

  private emit(e: unknown): void {
    const ev = parseRuntimeEvent(e); // validate at the boundary
    if (!ev) return;
    if ("taskId" in ev) {
      if (this.abandoned.has(ev.taskId)) return; // a cancelled task can never speak again
      this.lastTaskId = ev.taskId;
    }
    this.d.emit(ev);
  }

  /** Safety net: if something awaited never answers, stop waiting, tell the user, and free Momo for the next goal. */
  private watchdog(gen: number): { finish(): void } {
    const ms = this.d.taskTimeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      if (this.generation !== gen || !this.busy) return;
      this.emit({ type: "task.failed", taskId: this.lastTaskId ?? `t${this.seq}`, summary: "That took too long, so I stopped. You can try again.", recoverable: true });
      this.cancel();
    }, ms);
    return { finish: () => clearTimeout(timer) };
  }

  private clearPending(): void {
    if (this.pending?.kind === "confirm") clearTimeout(this.pending.timer);
    this.pending = null;
  }

  // ---------------------------------------------------------------- entry points

  /** What the user said or typed: a new goal, or the answer to a question Momo is waiting on. */
  async handleTranscript(_sessionId: string, text: string): Promise<void> {
    if (this.busy) return; // one goal at a time
    this.busy = true;
    const gen = this.generation;
    const live = () => gen === this.generation;
    const wd = this.watchdog(gen);
    let taskId = `t${this.seq}`;
    try {
      if (this.pending) {
        taskId = this.pending.task.id;
        if (await this.answerPending(text, live)) return;
      }
      taskId = `t${++this.seq}`;
      const task: Task = { id: taskId, goal: text.slice(0, 2000), steps: [], moves: 0, reports: [], unverifiedActions: new Set(), ran: 0, unverified: 0, failures: 0, epoch: 0, seen: new Map(), repeats: 0, journal: new ActionJournal(), retries: 0, retried: new Map() };
      this.lastJournal = task.journal;
      await this.pursue(task, live);
    } catch {
      if (live()) this.emit({ type: "task.failed", taskId, summary: "Something went wrong while doing that. You can retry.", recoverable: true });
    } finally {
      wd.finish();
      this.releaseCapture();
      if (live()) this.busy = false; // a goal that timed out was already released: never release a newer goal's lock
    }
  }

  /** The user pressed Confirm/Cancel on the card. Ignored unless it matches the question that is actually open. */
  async respondConfirmation(taskId: string, approved: boolean): Promise<void> {
    const p = this.pending;
    if (this.busy || !p || p.kind !== "confirm" || p.task.id !== taskId) return; // stale or forged id
    this.busy = true;
    const gen = this.generation;
    const live = () => gen === this.generation;
    const wd = this.watchdog(gen);
    try {
      await this.resolveConfirmation(p, approved, live);
    } catch {
      if (live()) this.emit({ type: "task.failed", taskId, summary: "Something went wrong while doing that. You can retry.", recoverable: true });
    } finally {
      wd.finish();
      this.releaseCapture();
      if (live()) this.busy = false;
    }
  }

  /** Free any window capture (a no-op, and no helper call, when none was started). Never throws: ending a task must not depend on it. */
  private releaseCapture(): void {
    try { void this.d.visualCapture?.release().catch(() => undefined); } catch { /* nothing to free */ }
  }

  /** Drop the current goal: pending questions are forgotten and late results are discarded. */
  cancel(): void {
    // whatever the real mouse and keyboard are doing stops now, and anything they hold is let go of (a drag is cancelled, not dropped)
    try { this.d.pointer?.()?.abort?.("cancel"); } catch { /* the pointer may not exist (Show Only) */ }
    this.releaseCapture();
    if (this.lastTaskId) this.abandoned.add(this.lastTaskId);
    if (this.pending) this.abandoned.add(this.pending.task.id);
    if (this.abandoned.size > 200) this.abandoned = new Set([...this.abandoned].slice(-100));
    this.generation++;
    this.clearPending();
    this.busy = false;
  }

  // ---------------------------------------------------------------- the loop

  private async pursue(task: Task, live: () => boolean): Promise<void> {
    const ai = this.d.ai;
    const maxSteps = this.d.maxSteps ?? 16;
    while (live()) {
      if (task.moves >= maxSteps) {
        this.emit({ type: "task.failed", taskId: task.id, recoverable: true, summary: `I couldn't finish that in ${maxSteps} steps, so I stopped instead of going round in circles. Try a smaller request.` });
        return;
      }
      if (!ai) { this.emit({ type: "task.failed", taskId: task.id, recoverable: true, summary: "I need the AI to work out how to do that, and it isn't available in this build." }); return; }
      this.emit({ type: "task.state", taskId: task.id, state: "working", message: task.moves === 0 ? `Working out how… (${ai.label()})` : "Deciding the next step…" });
      const r = await ai.plan(task.goal, task.steps, this.catalogue);
      if (!live()) return;
      if (!r.ok) { this.emit({ type: "task.failed", taskId: task.id, recoverable: true, summary: r.message }); return; }
      task.moves++;
      const dec = r.decision;

      if (dec.type === "done") return this.finish(task, dec.answer, r.source);
      if (dec.type === "fail") { this.emit({ type: "task.failed", taskId: task.id, recoverable: true, summary: dec.reason }); return; }
      if (dec.type === "ask") {
        this.clearPending();
        this.pending = { kind: "ask", task, question: dec.question };
        this.emit({ type: "task.clarification_required", taskId: task.id, question: dec.question });
        return;
      }

      // a tool call: Momo validates it itself, whatever the planner said
      const tool = this.tools.find((t) => t.name === dec.tool);
      if (!tool) { this.note(task, dec.tool, dec.args, "failed", `There is no tool called "${dec.tool}". Use only the listed tools.`); if (this.tooMany(task)) return; continue; }
      const parsed = tool.schema.safeParse(dec.args);
      if (!parsed.success) {
        this.note(task, tool.name, dec.args, "failed", `Invalid arguments: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".") || "args"} ${i.message}`).join("; ")}.`);
        if (this.tooMany(task)) return;
        continue;
      }
      const call: Call = { tool, args: parsed.data, confirmed: false };
      const key = `${tool.name}:${JSON.stringify(parsed.data)}:${task.epoch}`;
      if (task.seen.has(key)) {
        // the same call again with nothing changed in between: it cannot give a different answer
        this.note(task, tool.name, parsed.data, "failed", "You already made this exact call and nothing has changed since. Do not repeat it: use its result, try something different, or finish.");
        if (++task.repeats >= 2) { this.emit({ type: "task.failed", taskId: task.id, recoverable: true, summary: `I kept repeating myself without getting anywhere, so I stopped.${this.lastProblem(task)}` }); return; }
        continue;
      }
      const actionKey = `${tool.name}:${JSON.stringify(parsed.data)}`;
      if (task.unverifiedActions.has(actionKey)) {
        this.note(task, tool.name, parsed.data, "failed", "You already did this and it could not be verified. Do not do it again: look at what really happened first (for example list_windows or read_window), then decide.");
        if (++task.repeats >= 2) { this.emit({ type: "task.failed", taskId: task.id, recoverable: true, summary: "I asked for that, but I couldn't confirm it worked, and I didn't want to keep trying blindly, so I stopped." }); return; }
        continue;
      }
      task.seen.set(key, 1);
      const next = await this.attempt(task, call, live);
      if (next !== "continue") return;
    }
  }

  /** Record a step for the planner to see. */
  private note(task: Task, tool: string, args: unknown, outcome: "ok" | "unverified" | "failed" | "declined", text: string, meta: { failure?: Failure; acted?: Acted } = {}): void {
    task.steps.push({ kind: "tool", tool, args, outcome, text, ...(meta.failure ? { failure: meta.failure } : {}), ...(meta.acted ? { acted: meta.acted } : {}) });
    if (outcome === "failed") task.failures++;
  }

  /** The most recent thing that went wrong in this goal, for an honest final message. */
  private lastProblem(task: Task): string {
    const last = [...task.steps].reverse().find((s) => s.kind === "tool" && s.outcome === "failed" && !/already|do not repeat|Do not/i.test(s.text));
    return last && last.kind === "tool" ? ` Last problem: ${last.text.slice(0, 200)}` : "";
  }

  /** Too many failures in one goal: say honestly that Momo could not do it. */
  private tooMany(task: Task): boolean {
    if (task.failures < 4) return false;
    this.emit({ type: "task.failed", taskId: task.id, recoverable: true, summary: `I tried a few ways and couldn't get it done.${this.lastProblem(task)}` });
    return true;
  }

  /** The decision the call amounts to. Sending the contents of a window to an ONLINE AI is a decision too. */
  private riskOf(call: Call): Risk {
    const base = call.tool.risk(call.args);
    const ai = this.d.ai;
    return call.tool.sensitive && ai && ai.isCloud() && ai.canSeeScreen() ? "consequential" : base;
  }

  /** Gate, act, verify, observe. "continue" = ask the planner for the next move; anything else = the loop is suspended or over. */
  private async attempt(task: Task, call: Call, live: () => boolean): Promise<"continue" | "suspended" | "stop"> {
    // did this step point at something on screen? Then the shadow cursor is told how it ENDED (below), and only then
    let pointed = false;
    const d = { ...this.d, emit: (e: Parameters<AgentDeps["emit"]>[0]) => { if (e.type === "cursor.aim" || e.type === "cursor.move" || e.type === "cursor.window") pointed = true; this.d.emit(e); } };
    const ctx = { d, live, confirmed: call.confirmed, lock: call.lock, instruction: () => task.goal };
    if (!call.confirmed && decide({ risk: this.riskOf(call) }, this.d.policy()) === "confirm") {
      this.askConfirmation(task, call, await call.tool.describe(call.args, ctx));
      return "suspended";
    }
    // a step that DOES something is announced aloud ("Opening D:\Projects…"); looking things up is not
    const doing = call.tool.risk(call.args);
    this.emit({ type: "task.state", taskId: task.id, state: "working", message: call.tool.working(call.args), speak: doing === "reversible" || doing === "consequential" });
    // did any input REACH the app during this step? The real mouse and keyboard know exactly (each try starts counting from zero)
    let pointer: ReturnType<NonNullable<AgentDeps["pointer"]>> | undefined;
    try { pointer = this.d.pointer?.(); } catch { pointer = undefined; }
    const originalArgs = call.args;
    const intent = task.journal.fingerprint(call.tool.name, originalArgs);
    let tries = 1;
    let r = await this.executeOnce(task, call, ctx, pointer, live, tries);
    if (r.stop) return "stop";
    let delivered: Acted | undefined = r.delivered;

    // BOUNDED RETRY (phase 4c). Decided in ONE place (recovery/policy.ts): only when nothing was sent, only for a read or a reversible step,
    // only for a failure a fresh look can fix, never after a cancel or a takeover, one retry per call and two per task. The target is found
    // again (positions dropped), the result is verified like any other, and a retry that sends anything is final.
    while (!r.out.ok && r.failure && !("needsConfirmation" in r.out) && !("ambiguous" in r.out)) {
      let interrupted = false;
      try { interrupted = !!pointer?.interrupted?.(); } catch { interrupted = false; }
      const dec = decideRetry({
        kind: r.failure.kind, acted: maxActed(r.failure.acted, delivered), risk: r.base, verdict: r.verdict,
        intentRetries: task.retried.get(intent) ?? 0, taskRetries: task.retries, mayHaveRun: task.journal.mayHaveRun(call.tool.name, call.args, r.seq),
        live: live(), interrupted, windowHung: r.facts.windowHung === true, windowBlocked: r.facts.windowBlockedByDialog === true || r.facts.newWindowAppeared === true,
      });
      task.journal.update(r.seq, { evidence: [{ kind: dec.retry ? "retry_decided" : "retry_declined", ok: dec.retry }] });
      if (!dec.retry) break;
      const parsed = call.tool.schema.safeParse(refreshArgs(call.args, dec.refresh));
      if (!parsed.success) break;
      task.retries++;
      task.retried.set(intent, (task.retried.get(intent) ?? 0) + 1);
      task.journal.update(r.seq, { phase: "retrying" });
      this.emit({ type: "task.state", taskId: task.id, state: "working", message: "Looking again and trying once more…" });
      call = { ...call, args: parsed.data };
      tries++;
      r = await this.executeOnce(task, call, { ...ctx }, pointer, live, tries);
      if (r.stop) return "stop";
      delivered = maxActed(delivered, r.delivered);
    }
    const { out, failure, verdict, base, isAction } = r;
    if (!live()) return "stop";
    // the verdict on the shadow cursor is tied to the verification result: verified = confirmed; ok but not verified = NOT confirmed; else failed
    if (pointed) {
      if (out.ok) this.emit({ type: "cursor.result", state: out.verified ? "verified" : "unconfirmed", text: (out.verified ? (out.shown ?? "Confirmed") : "Not confirmed").slice(0, 100) });
      else if (!("needsConfirmation" in out) && !("ambiguous" in out) && out.reason !== "cancelled") this.emit({ type: "cursor.result", state: "failed", text: out.reason.slice(0, 90) });
    }
    const keyOf = (a: Record<string, unknown>) => `${call.tool.name}:${JSON.stringify(a)}`;
    const blockRepeat = () => { task.unverifiedActions.add(keyOf(originalArgs)); task.unverifiedActions.add(keyOf(call.args)); };

    if (out.ok) {
      // after opening something, the shadow cursor glides to the window that appeared
      if (out.verified && OPENING_TOOLS.has(call.tool.name)) {
        const fg = this.d.foreground?.lastExternal();
        if (fg) this.emit({ type: "cursor.window", hwnd: fg.hwnd, action: "open", label: fg.title.slice(0, 60) });
      }
      if (isAction) { task.epoch++; this.d.world.notify("focus_changed"); } // what was observed before may no longer be true
      task.ran++;
      // an action that succeeded delivered its input; a read delivered nothing
      const acted: Acted = isAction ? maxActed(out.acted ?? "yes", delivered) : "no";
      const unverifiedFailure: Failure | undefined = out.verified ? undefined : { kind: "unverified", acted };
      if (!out.verified) { task.unverified++; if (isAction && verdict !== "absent") blockRepeat(); }
      const withheld = call.tool.sensitive && !(this.d.ai?.canSeeScreen() ?? false);
      if (withheld) task.reports.push({ text: out.report, epoch: task.epoch });
      this.note(task, call.tool.name, call.args, out.verified ? "ok" : "unverified", withheld ? WITHHELD : out.brief, { acted, failure: unverifiedFailure });
      return "continue";
    }
    if ("needsConfirmation" in out) {
      this.askConfirmation(task, { ...call, confirmed: true, lock: out.needsConfirmation.lock }, out.needsConfirmation.summary);
      return "suspended";
    }
    if ("ambiguous" in out) {
      const { labels, patches, noun, details } = out.ambiguous;
      this.clearPending();
      this.pending = { kind: "pick", task, call, labels, details, patches, asked: 1 };
      this.emit({ type: "task.clarification_required", taskId: task.id, question: this.pickQuestion(noun, labels, details), options: this.pickOptions(labels, details) });
      return "suspended";
    }
    if (out.reason === "cancelled") return "stop";
    const failureOut: Failure = failure ?? describeFailure({ reason: out.reason, risk: base, delivered });
    const actedFinal: Failure = { kind: failureOut.kind, acted: maxActed(failureOut.acted, delivered) };
    // it may have happened and nothing shows it did not: the same exact action is not repeated blindly (the planner is told to look first)
    if (isAction && actedFinal.acted !== "no" && verdict !== "absent" && !isTerminal(actedFinal.kind)) blockRepeat();
    this.note(task, call.tool.name, call.args, "failed", out.reason, { failure: actedFinal, acted: actedFinal.acted });
    return this.tooMany(task) ? "stop" : "continue";
  }

  /**
   * One TRY of a step: run it, name what went wrong, and (when it may have run or could not be confirmed) LOOK, read-only. Returns what is known.
   * Used once for every step and, at most once more, for a bounded retry (see `attempt`).
   */
  private async executeOnce(task: Task, call: Call, ctx: { d: AgentDeps; live: () => boolean; confirmed: boolean; lock?: string }, pointer: ReturnType<NonNullable<AgentDeps["pointer"]>> | undefined, live: () => boolean, attemptNo: number): Promise<Attempt> {
    const base = call.tool.risk(call.args);
    const isAction = base === "reversible" || base === "consequential"; // changed something on the PC
    const facts: Evidence = {};
    // the windows that exist now: anything else that shows up while the step runs is a dialog, a popup or a new app (only their number is kept)
    let baseline: Set<number> | undefined;
    if (isAction) { try { baseline = new Set((await this.d.desktopAgent.snapshot()).windows.map((w) => w.hwnd)); } catch { baseline = undefined; } }
    try { pointer?.resetActed?.(); } catch { /* the pointer may be gone */ }
    const seq = task.journal.begin(call.tool.name, call.args, { attempt: attemptNo });
    let out: ToolOutcome;
    let threw = false;
    try { out = await call.tool.run(call.args, ctx); } catch { threw = true; out = { ok: false, reason: "That step hit an unexpected problem." }; }
    let delivered: Acted | undefined;
    try { delivered = pointer?.actedSince?.(); } catch { delivered = undefined; }
    const stoppedNow = (): Attempt => { task.journal.update(seq, { phase: "cancelled", acted: delivered ?? "no" }); return { stop: true, out, threw, delivered, facts, seq, base, isAction }; };
    if (!live()) return stoppedNow();

    // name a failure, and say whether anything got through (a tool that threw is unknown: "maybe" for anything that changes things)
    const isFailure = !out.ok && !("needsConfirmation" in out) && !("ambiguous" in out) && out.reason !== "cancelled";
    let failure: Failure | undefined;
    if (isFailure && !out.ok && "reason" in out) {
      const f = describeFailure({ reason: out.reason, risk: base, delivered, explicitKind: out.failure?.kind, explicitActed: out.failure?.acted });
      failure = threw && isAction ? { kind: f.kind, acted: maxActed(f.acted, "maybe") } : f;
    }
    if (out.ok) task.journal.update(seq, { phase: "ran", acted: isAction ? maxActed(out.acted ?? "yes", delivered) : "no", ...(out.verified ? { evidence: [{ kind: "tool_verified" as const, ok: true }] } : { evidence: [{ kind: "tool_unverified" as const, ok: null }] }) });
    else if (failure) task.journal.update(seq, { phase: "failed", acted: failure.acted, failure: failure.kind });

    // VERIFY-ONLY RECOVERY (4b) with the frozen-window and dialog handling (4d). An action that MAY have run, or ran and could not be confirmed, is
    // not repeated and not trusted: it is LOOKED AT. The look is read-only (the view below can only read), stops the moment the task is
    // cancelled or the user takes over, and only real evidence can turn it into a success.
    const needsLook = isAction && ((out.ok && !out.verified) || (!!failure && failure.acted !== "no" && !isTerminal(failure.kind)));
    // a failed READ or a step that sent nothing is also worth a quick look at the window when the failure could be a frozen or blocked app
    const worthChecking = !needsLook && !!failure && !isTerminal(failure.kind) && (failure.kind === "timeout" || failure.kind === "uia_failed" || failure.kind === "input_failed");
    let verdict: "verified" | "absent" | "unconfirmed" | undefined;
    if (needsLook || worthChecking) {
      task.journal.update(seq, { phase: "observing" });
      const view: ReadOnlyView = {
        live: () => live(),
        interrupted: () => { try { return !!pointer?.interrupted?.(); } catch { return false; } },
        sleep: this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
        windowState: (h) => this.d.actionAgent.state(h),
        windows: () => this.d.desktopAgent.snapshot(),
        readWindow: (h) => this.d.uiAgent.read(h),
        popups: async () => { const r = await this.d.uiAgent.transients(); return r.ok ? r.windows : null; },
        verifier: this.d.verifier,
      };
      // the window the user is working in is the one to watch when the step names none
      let watch: StepTarget | undefined;
      try { const fg = this.d.foreground?.lastExternal(); if (fg && Number.isSafeInteger(fg.hwnd) && fg.hwnd > 0) watch = { hwnd: fg.hwnd, pid: fg.pid }; } catch { watch = undefined; }
      const confirm = needsLook ? call.tool.confirm : undefined;
      const lookInput = { target: out.ok ? out.target : undefined, watch, baseline, confirm: confirm ? (t: StepTarget | undefined, v: ReadOnlyView) => confirm.call(call.tool, call.args, t, v) : undefined, view };
      let looked = await verifyOnly(lookInput);
      task.journal.update(seq, { evidence: looked.evidence });
      if (looked.cancelled || !live()) return stoppedNow();
      // A frozen window is sent NOTHING (input to it is queued and would fire later). Wait, read-only and bounded, for it to answer, then look again:
      // the input that was already sent may have landed in the meantime.
      const hwndToWatch = (out.ok ? out.target?.hwnd : undefined) ?? watch?.hwnd;
      if (looked.facts.windowHung === true && hwndToWatch) {
        task.journal.update(seq, { phase: "waiting" });
        const res = await waitResponsive(view, hwndToWatch);
        if (res === "cancelled" || !live()) return stoppedNow();
        task.journal.update(seq, { evidence: [res === "responsive" ? { kind: "responsive_again", ok: true } : res === "still_hung" ? { kind: "still_hung", ok: true } : { kind: "window_exists", ok: false }] });
        if (res === "responsive") {
          task.journal.update(seq, { phase: "observing" });
          looked = await verifyOnly(lookInput);
          task.journal.update(seq, { evidence: looked.evidence });
          if (looked.cancelled || !live()) return stoppedNow();
          looked.facts.windowHung = false;
        } else if (res === "gone") looked.facts.windowExists = false;
      }
      Object.assign(facts, looked.facts);
      verdict = looked.verdict;
      task.journal.update(seq, { phase: verdict === "verified" ? "verified" : verdict === "absent" ? "not_effective" : "unconfirmed" });
      if (failure) {
        // what was actually seen (the window is hung / gone / blocked by a dialog) can name the failure better than the sentence did
        failure = describeFailure({ reason: !out.ok && "reason" in out ? out.reason : undefined, risk: base, delivered, explicitActed: failure.acted, evidence: looked.facts, explicitKind: failure.kind === "unknown" || failure.kind === "timeout" || failure.kind === "uia_failed" || failure.kind === "input_failed" ? undefined : failure.kind });
        task.journal.update(seq, { failure: failure.kind });
      }
      if (verdict === "verified") {
        // real evidence that the effect is there: now (and only now) it counts as done
        if (out.ok) out = { ...out, verified: true, shown: "Confirmed afterwards" };
        else {
          const said = "reason" in out ? out.reason : "";
          out = { ok: true, brief: `${said} Looking afterwards shows it did happen.`, report: `${said} Looking afterwards shows it did happen.`, verified: true, shown: "Confirmed afterwards", acted: "yes" };
        }
        failure = undefined;
      } else {
        out = annotate(out, facts);
      }
    }
    return { out, threw, delivered, failure, verdict, facts, seq, base, isAction };
  }

  /** "I found 3 matches: 1) Folder: Projects — D:\Projects …  Which one?": names AND full paths, so nothing is a guess. */
  private pickQuestion(noun: string, labels: string[], details?: string[]): string {
    return `I found ${labels.length} ${noun}: ${labels.map((l, i) => `${i + 1}) ${l}${details?.[i] ? ` — ${details[i]}` : ""}`).join("  ")}. Which one?`;
  }
  private pickOptions(labels: string[], details?: string[]): { label: string; detail?: string }[] {
    return labels.slice(0, 9).map((label, i) => ({ label: label.slice(0, 200), ...(details?.[i] ? { detail: details[i].slice(0, 400) } : {}) }));
  }

  /** The planner says it is done. Success is claimed only for what was actually verified. */
  private finish(task: Task, answer: string, source: string): void {
    // private results the AI never saw are shown as they were read. Only the ones read AFTER the last change count: an
    // earlier look (before something was opened or closed) was just an observation, not the answer.
    const current = task.reports.filter((r) => r.epoch === task.epoch);
    if (current.length > 0) {
      const text = `${answer}  ${current.map((r) => r.text).join("  ")}`.slice(0, 3900);
      if (task.unverified === 0) this.emit({ type: "task.completed", taskId: task.id, summary: text, verified: true });
      else this.emit({ type: "task.state", taskId: task.id, state: "partial_success", message: `${text} (I couldn't confirm every step.)`.slice(0, 3900) });
      return;
    }
    if (task.ran === 0) { this.emit({ type: "task.answer", taskId: task.id, text: answer, source: `${source} · AI answer` }); return; }
    if (task.unverified === 0) { this.emit({ type: "task.completed", taskId: task.id, summary: answer, verified: true }); return; }
    this.emit({ type: "task.state", taskId: task.id, state: "partial_success", message: `${answer} (I couldn't confirm every step, so I can't call it done.)`.slice(0, 3900) });
  }

  // ---------------------------------------------------------------- asking the user

  private askConfirmation(task: Task, call: Call, summary: string, asked = 1): void {
    this.clearPending();
    const timer = setTimeout(() => {
      if (this.pending?.kind === "confirm" && this.pending.task.id === task.id) {
        this.pending = null;
        this.emit({ type: "task.state", taskId: task.id, state: "idle", message: "I didn't hear back, so I didn't do anything." });
      }
    }, this.d.confirmTimeoutMs ?? 60_000);
    this.pending = { kind: "confirm", task, call: { ...call, confirmed: true }, asked, timer };
    this.emit({ type: "task.confirmation_required", taskId: task.id, summary });
  }

  private async resolveConfirmation(p: Extract<Pending, { kind: "confirm" }>, approved: boolean, live: () => boolean): Promise<void> {
    this.clearPending();
    if (!approved) {
      p.task.steps.push({ kind: "tool", tool: p.call.tool.name, args: p.call.args, outcome: "declined", text: "The user said no." });
      p.task.journal.update(p.task.journal.begin(p.call.tool.name, p.call.args), { phase: "declined" }); // nothing was sent
      this.emit({ type: "task.state", taskId: p.task.id, state: "idle", message: "Okay, I won't do that." });
      return;
    }
    const next = await this.attempt(p.task, p.call, live);
    if (next === "continue") await this.pursue(p.task, live);
  }

  /** @returns true if the utterance was consumed as an answer to our own question */
  private async answerPending(text: string, live: () => boolean): Promise<boolean> {
    const p = this.pending!;
    if (p.kind === "ask") {
      this.clearPending();
      p.task.steps.push({ kind: "ask", question: p.question, answer: text.slice(0, 500) });
      await this.pursue(p.task, live);
      return true;
    }
    if (p.kind === "confirm") {
      const yn = resolveYesNo(text);
      if (yn !== "unclear") { await this.resolveConfirmation(p, yn === "yes", live); return true; }
      if (p.asked >= 2) { this.clearPending(); this.emit({ type: "task.state", taskId: p.task.id, state: "idle", message: "I'm not sure what you meant, so I didn't do anything." }); return true; }
      this.askConfirmation(p.task, p.call, `Please say yes or no. (${p.call.tool.name})`, p.asked + 1);
      return true;
    }
    // pick
    // the user may name an option by its name OR by where it is ("the one in Documents"): match against both
    const choice = resolveChoice(text, p.labels.map((l, i) => (p.details?.[i] ? `${l} ${p.details[i]}` : l)));
    if (choice.kind === "cancel") {
      this.clearPending();
      this.emit({ type: "task.state", taskId: p.task.id, state: "idle" });
      return true;
    }
    if (choice.kind === "pick") {
      this.clearPending();
      const args = { ...p.call.args, ...p.patches[choice.index] };
      const parsed = p.call.tool.schema.safeParse(args);
      if (!parsed.success) { this.emit({ type: "task.failed", taskId: p.task.id, summary: "I lost track of what you picked. Please ask again.", recoverable: true }); return true; }
      const next = await this.attempt(p.task, { ...p.call, args: parsed.data }, live);
      if (next === "continue") await this.pursue(p.task, live);
      return true;
    }
    if (p.asked >= 2) {
      this.clearPending();
      this.emit({ type: "task.failed", taskId: p.task.id, summary: "I still couldn't tell which one you meant, so I stopped. Ask again whenever you like.", recoverable: true });
      return true;
    }
    p.asked++;
    this.emit({ type: "task.clarification_required", taskId: p.task.id, question: `Sorry, which one? Say “first”, “second”… or “cancel”. ${p.labels.map((l, i) => `${i + 1}) ${l}${p.details?.[i] ? ` — ${p.details[i]}` : ""}`).join("  ")}`, options: this.pickOptions(p.labels, p.details) });
    return true;
  }
}
