import { parseRuntimeEvent } from "../../types/runtime-events";
import { decide, resolveYesNo, type Risk } from "../action";
import { resolveChoice } from "./choice";
import { TOOL_CATALOG, buildTools, type AgentDeps, type ToolDef, type ToolOutcome } from "./tools";
import type { PlanStep } from "./ai/prompts";

export type { AgentDeps };
export type OrchestratorDeps = AgentDeps;

const WITHHELD = "[Private result: not shown to the AI. It will be shown to the user exactly as read. If that completes the goal, finish with done.]";

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
      const task: Task = { id: taskId, goal: text.slice(0, 2000), steps: [], moves: 0, reports: [], unverifiedActions: new Set(), ran: 0, unverified: 0, failures: 0, epoch: 0, seen: new Map(), repeats: 0 };
      await this.pursue(task, live);
    } catch {
      if (live()) this.emit({ type: "task.failed", taskId, summary: "Something went wrong while doing that. You can retry.", recoverable: true });
    } finally {
      wd.finish();
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
      if (live()) this.busy = false;
    }
  }

  /** Drop the current goal: pending questions are forgotten and late results are discarded. */
  cancel(): void {
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
  private note(task: Task, tool: string, args: unknown, outcome: "ok" | "unverified" | "failed" | "declined", text: string): void {
    task.steps.push({ kind: "tool", tool, args, outcome, text });
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
    const ctx = { d, live, confirmed: call.confirmed, lock: call.lock };
    if (!call.confirmed && decide({ risk: this.riskOf(call) }, this.d.policy()) === "confirm") {
      this.askConfirmation(task, call, await call.tool.describe(call.args, ctx));
      return "suspended";
    }
    // a step that DOES something is announced aloud ("Opening D:\Projects…"); looking things up is not
    const doing = call.tool.risk(call.args);
    this.emit({ type: "task.state", taskId: task.id, state: "working", message: call.tool.working(call.args), speak: doing === "reversible" || doing === "consequential" });
    let out: ToolOutcome;
    try { out = await call.tool.run(call.args, ctx); } catch { out = { ok: false, reason: "That step hit an unexpected problem." }; }
    if (!live()) return "stop";
    // the verdict on the shadow cursor is tied to the verification result: verified = confirmed; ok but not verified = NOT confirmed; else failed
    if (pointed) {
      if (out.ok) this.emit({ type: "cursor.result", state: out.verified ? "verified" : "unconfirmed", text: (out.verified ? (out.shown ?? "Confirmed") : "Not confirmed").slice(0, 100) });
      else if (!("needsConfirmation" in out) && !("ambiguous" in out) && out.reason !== "cancelled") this.emit({ type: "cursor.result", state: "failed", text: out.reason.slice(0, 90) });
    }
    const base = call.tool.risk(call.args);
    const isAction = base === "reversible" || base === "consequential"; // changed something on the PC

    if (out.ok) {
      // after opening something, the shadow cursor glides to the window that appeared
      if (out.verified && OPENING_TOOLS.has(call.tool.name)) {
        const fg = this.d.foreground?.lastExternal();
        if (fg) this.emit({ type: "cursor.window", hwnd: fg.hwnd, action: "open", label: fg.title.slice(0, 60) });
      }
      if (isAction) { task.epoch++; this.d.world.notify("focus_changed"); } // what was observed before may no longer be true
      task.ran++;
      if (!out.verified) { task.unverified++; if (isAction) task.unverifiedActions.add(`${call.tool.name}:${JSON.stringify(call.args)}`); }
      const withheld = call.tool.sensitive && !(this.d.ai?.canSeeScreen() ?? false);
      if (withheld) task.reports.push({ text: out.report, epoch: task.epoch });
      this.note(task, call.tool.name, call.args, out.verified ? "ok" : "unverified", withheld ? WITHHELD : out.brief);
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
    this.note(task, call.tool.name, call.args, "failed", out.reason);
    return this.tooMany(task) ? "stop" : "continue";
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
