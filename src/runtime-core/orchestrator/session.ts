import type { RuntimeEvent } from "../../types/runtime-events";
import { ActionAgent } from "../action";
import { DesktopAgent } from "../desktop";
import { FileSystemAgent } from "../filesystem";
import { Orchestrator } from "./agent";
import type { ActionPort, AppsPort, ForegroundPort, FsPort, InputPort, LaunchPort, ScreenPort, WindowsPort } from "../shared/ports";
import { AppAgent } from "../apps";
import type { AiService } from "./ai/service";
import { UiPanelAgent } from "../uipanel";
import { VisualAgent } from "../vision";
import { DEFAULT_POLICY, type Policy } from "../action";
import { localClean, type DictationOutcome, type DictationStyle } from "./dictation";
import { Verifier } from "../verifier";
import { WorldModel } from "../verifier";

export interface SessionDeps {
  fs: FsPort;
  win: WindowsPort;
  /** what Momo may do to the PC; absent = read-only */
  act?: ActionPort;
  /** looking at a window (UI Automation + OCR); absent = Momo can't look at the screen */
  screen?: ScreenPort;
  /** acting on windows and controls; absent = Momo can't touch windows or controls */
  input?: InputPort;
  /** the installed-app list and starting programs; absent = Momo can't open apps */
  apps?: AppsPort;
  launch?: LaunchPort;
  foreground?: ForegroundPort;
  /** the optional AI brain (a free provider) */
  ai?: AiService;
  emit(e: RuntimeEvent): void;
  selfPids?: () => number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  confirmTimeoutMs?: number;
  taskTimeoutMs?: number;
  verifyAttempts?: number;
  maxSteps?: number;
}

/**
 * One Momo session: temporary world model + task state. It exists only in memory and
 * dispose() discards all of it (called on exit; tested).
 */
export class Session {
  readonly world: WorldModel;
  readonly fsAgent: FileSystemAgent;
  readonly desktopAgent: DesktopAgent;
  readonly actionAgent: ActionAgent;
  readonly uiAgent: UiPanelAgent;
  readonly visualAgent: VisualAgent;
  readonly appAgent: AppAgent;
  readonly orchestrator: Orchestrator;
  private ai?: AiService;
  private policy: Policy = { ...DEFAULT_POLICY };
  private disposed = false;

  constructor(deps: SessionDeps) {
    const now = deps.now ?? Date.now;
    this.ai = deps.ai;
    this.world = new WorldModel(now);
    this.fsAgent = new FileSystemAgent(this.world, deps.fs, now);
    this.desktopAgent = new DesktopAgent(this.world, deps.win, deps.selfPids);
    this.actionAgent = new ActionAgent(deps.fs, deps.act, deps.input);
    // without a screen port, looking at windows fails with an honest message instead of guessing
    const screen: ScreenPort = deps.screen ?? {
      readUi: async () => ({ ok: false, reason: "looking at windows isn't available in this build" }),
      ocr: async () => ({ ok: false, reason: "looking at windows isn't available in this build" }),
    };
    this.appAgent = new AppAgent(deps.apps, deps.launch, deps.fs, now);
    this.uiAgent = new UiPanelAgent(this.world, screen);
    this.visualAgent = new VisualAgent(this.world, screen);
    this.orchestrator = new Orchestrator({
      world: this.world, fsAgent: this.fsAgent, desktopAgent: this.desktopAgent, actionAgent: this.actionAgent,
      uiAgent: this.uiAgent, visualAgent: this.visualAgent, appAgent: this.appAgent, foreground: deps.foreground, ai: deps.ai,
      verifier: new Verifier(), fs: deps.fs, policy: () => this.policy,
      sleep: deps.sleep, confirmTimeoutMs: deps.confirmTimeoutMs, taskTimeoutMs: deps.taskTimeoutMs, verifyAttempts: deps.verifyAttempts, maxSteps: deps.maxSteps,
      emit: (e) => { if (!this.disposed) deps.emit(e); },
    });
  }

  handleTranscript(sessionId: string, text: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.orchestrator.handleTranscript(sessionId, text);
  }

  /**
   * Dictation: turn what was said into clean written text. The AI (if on) fixes grammar and improves the wording;
   * without it, or if it fails, a light local clean-up is used and the user is told. The text is only returned to be
   * written somewhere: it is never treated as a command.
   */
  async dictate(raw: string, style: DictationStyle): Promise<DictationOutcome> {
    if (this.disposed) return { ok: false, reason: "Momo is closing." };
    const text = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 3000);
    if (!text) return { ok: false, reason: "I didn't catch any words." };
    if (style === "off") return { ok: true, text, polished: false };
    const ai = this.ai;
    if (!ai || !ai.ready()) {
      return { ok: true, text: localClean(text), polished: false, note: "AI is off, so I only fixed the basics. Turn it on in Settings → AI for full grammar and wording help." };
    }
    const r = await ai.polish(text, style);
    if (this.disposed) return { ok: false, reason: "Momo is closing." };
    if (r.ok) return { ok: true, text: r.text, polished: true, source: r.source };
    return { ok: true, text: localClean(text), polished: false, note: `${r.message} I only fixed the basics.` };
  }

  /** The user pressed Confirm or Cancel on a confirmation card. */
  respondConfirmation(taskId: string, approved: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.orchestrator.respondConfirmation(taskId, approved);
  }

  /** Update the permission policy (from Settings). Only known keys are accepted. */
  setPolicy(p: Partial<Policy>): void {
    if (typeof p.confirmReversible === "boolean") this.policy = { ...this.policy, confirmReversible: p.confirmReversible };
    if (typeof p.confirmScreenRead === "boolean") this.policy = { ...this.policy, confirmScreenRead: p.confirmScreenRead };
  }

  cancelTask(): void {
    this.orchestrator.cancel();
  }

  /** The environment changed (focus, windows, files): earlier observations must not be reused as current. */
  notify(change: Parameters<WorldModel["notify"]>[0]): void {
    this.world.notify(change);
  }

  /** Discard everything this session knew. */
  dispose(): void {
    this.orchestrator.cancel();
    this.world.dispose();
    this.disposed = true;
  }
}
