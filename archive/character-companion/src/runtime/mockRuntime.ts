import { parseRuntimeEvent, type RuntimeEvent } from "../types/runtime-events";

export type Scenario =
  | "storage" // read-only success
  | "partial"
  | "ambiguous" // clarification, then success
  | "confirm_send" // confirmation, then success (or cancel)
  | "fail" // sorry
  | "fatal" // error
  | "unrelated" // back to idle
  | "mic_denied"; // disabled

export const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: "storage", label: "Success (read-only: D drive)" },
  { id: "partial", label: "Partial success" },
  { id: "ambiguous", label: "Ambiguous contact → clarification" },
  { id: "confirm_send", label: "Send message → confirmation" },
  { id: "fail", label: "Cannot complete (sorry)" },
  { id: "fatal", label: "Runtime error" },
  { id: "unrelated", label: "Unrelated speech → idle" },
  { id: "mic_denied", label: "Microphone denied (disabled)" },
];

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}
const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type Step = [delayMs: number, event: RuntimeEvent];
type Listener = (e: RuntimeEvent) => void;

/**
 * Mock of the trusted local runtime. Phase D replaces it with the real one over the
 * same event contract. Every emitted event is validated at the boundary.
 */
export class MockRuntime {
  private listeners = new Set<Listener>();
  private timers = new Set<unknown>();
  private seq = 0;
  private session = "";
  private task = "";
  private pendingScenario: Scenario = "storage";
  private awaiting: "confirmation" | "clarification" | null = null;
  private disposed = false;
  /** Invalid events dropped at the boundary (kept for tests/diagnostics). */
  droppedEvents = 0;

  /** What the scripted task is waiting for, if anything. */
  get awaitingKind(): "confirmation" | "clarification" | null {
    return this.awaiting;
  }

  constructor(private sched: Scheduler = realScheduler, private speed = 1) {}

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Boundary: validate, then deliver. */
  emit(raw: unknown): void {
    if (this.disposed) return;
    const e = parseRuntimeEvent(raw);
    if (!e) {
      this.droppedEvents++;
      return;
    }
    this.listeners.forEach((l) => l(e));
  }

  private play(steps: Step[]): void {
    let t = 0;
    for (const [d, ev] of steps) {
      t += d * this.speed;
      const h = this.sched.set(() => {
        this.timers.delete(h);
        this.emit(ev);
      }, t);
      this.timers.add(h);
    }
  }
  private clearTimers(): void {
    this.timers.forEach((h) => this.sched.clear(h));
    this.timers.clear();
  }

  /** Which scripted result the next spoken request will produce. */
  setScenario(s: Scenario): void {
    this.pendingScenario = s;
  }

  startVoice(): void {
    this.clearTimers();
    // A spoken answer to a pending clarification keeps the task open.
    if (this.awaiting !== "clarification") this.awaiting = null;
    this.session = `s${++this.seq}`;
    this.emit({ type: "voice.started", sessionId: this.session });
  }

  /** Stop recording; the scripted transcript and task then play out. */
  stopVoice(): void {
    const sid = this.session;
    this.emit({ type: "voice.stopped", sessionId: sid });
    if (this.awaiting === "clarification") {
      this.awaiting = null;
      const taskId = this.task;
      this.play([
        [400, { type: "transcript.ready", sessionId: sid, text: "The first one" }],
        [500, { type: "task.state", taskId, state: "working", message: "Preparing the message…" }],
        [900, { type: "task.completed", taskId, summary: "Draft prepared for the chosen contact (verified).", verified: true }],
      ]);
      return;
    }
    this.runScenario(this.pendingScenario, sid);
  }

  cancelVoice(): void {
    this.clearTimers();
    this.awaiting = null;
    this.emit({ type: "task.state", taskId: this.task || "none", state: "idle" });
  }

  respondConfirmation(approved: boolean): void {
    if (this.awaiting !== "confirmation") return;
    this.awaiting = null;
    const taskId = this.task;
    if (!approved) {
      this.emit({ type: "task.state", taskId, state: "idle" });
      return;
    }
    this.play([
      [0, { type: "task.state", taskId, state: "working", message: "Sending…" }],
      [900, { type: "task.completed", taskId, summary: "Message sent and shown in the chat (verified).", verified: true }],
    ]);
  }

  respondClarification(_answer: string): void {
    if (this.awaiting !== "clarification") return;
    this.awaiting = null;
    const taskId = this.task;
    this.play([
      [0, { type: "task.state", taskId, state: "working", message: "Preparing the message…" }],
      [900, { type: "task.completed", taskId, summary: "Draft prepared for the chosen contact (verified).", verified: true }],
    ]);
  }

  /** Live voice: the transcript is real, the task result is still the scripted scenario. */
  runTranscript(sid: string, text: string): void {
    if (this.awaiting === "clarification") { this.respondClarification(text); return; }
    this.runScenario(this.pendingScenario, sid, text);
  }

  private runScenario(s: Scenario, sid: string, spoken?: string): void {
    this.clearTimers();
    const taskId = `t${this.seq}`;
    this.task = taskId;
    // With live voice the transcript.ready event was already emitted, so skip the scripted one.
    const transcript = (text: string): Step => [spoken ? 0 : 400, spoken
      ? { type: "task.state", taskId, state: "thinking", message: "Let me check that." }
      : { type: "transcript.ready", sessionId: sid, text }];
    const state = (state: "thinking" | "working", message: string, d = 500): Step =>
      [d, { type: "task.state", taskId, state, message }];

    switch (s) {
      case "storage":
        return this.play([
          transcript("Tell me the storage of D drive"),
          state("working", "Reading drive information…"),
          [700, { type: "task.completed", taskId, summary: "D: has 512 GB total, 188 GB free (verified).", verified: true }],
        ]);
      case "partial":
        return this.play([
          transcript("Open my project and run the tests"),
          state("working", "Opening project…"),
          [800, { type: "task.state", taskId, state: "partial_success", message: "Opened the project; I couldn't start the tests." }],
        ]);
      case "ambiguous":
        this.awaiting = "clarification";
        return this.play([
          transcript("Open WhatsApp and say hello to Sumeet"),
          state("thinking", "Let me check that."),
          [700, { type: "task.clarification_required", taskId, question: "I found two contacts named Sumeet. Which one do you mean?" }],
        ]);
      case "confirm_send":
        this.awaiting = "confirmation";
        return this.play([
          transcript("Send hello to Sumeet"),
          state("thinking", "Let me check that."),
          [700, { type: "task.confirmation_required", taskId, summary: 'Send "Hello" to Sumeet Shah on WhatsApp?' }],
        ]);
      case "fail":
        return this.play([
          transcript("Open the budget file"),
          state("working", "Looking for the file…"),
          [800, { type: "task.failed", taskId, summary: "I couldn't find a file called budget.", recoverable: true }],
        ]);
      case "fatal":
        return this.play([
          transcript("Take a screenshot of my window"),
          state("working", "Working on it…"),
          [800, { type: "task.failed", taskId, summary: "Something went wrong. You can retry.", recoverable: false }],
        ]);
      case "unrelated":
        return this.play([
          transcript("…and then he said we should go to lunch"),
          state("thinking", "Let me check that."),
          [600, { type: "task.state", taskId, state: "idle" }],
        ]);
      case "mic_denied":
        return this.play([[300, { type: "runtime.error", code: "mic_denied", message: "Microphone access is disabled." }]]);
    }
  }

  /** Explicit, testable session cleanup (called on exit). */
  dispose(): void {
    this.clearTimers();
    this.listeners.clear();
    this.awaiting = null;
    this.session = "";
    this.task = "";
    this.disposed = true;
  }
}
