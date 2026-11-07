import { parseRuntimeEvent, type RuntimeEvent } from "../../types/runtime-events";
import type { ActionAgent } from "../action";
import type { DesktopAgent } from "../desktop";
import type { DriveInfo, FileSystemAgent, FolderMatch } from "../filesystem";
import { classify, resolveChoice, type Intent } from "./intent";
import type { ForegroundPort, FsPort } from "../shared/ports";
import { classifyControlRisk, decide, resolveYesNo, type ActionPlan, type Policy } from "../action";
import {
  MAX_LINES, SPARSE_TEXT_CHARS, cleanScreenText, collectControls, collectText, errorLines, matchControls, signature, totalChars, visibleNames,
} from "../shared/screenText";
import type { UiPanelAgent } from "../uipanel";
import type { VisualAgent } from "../vision";
import type { AppEntry, BrowserProfile, UiNode } from "../shared/ports";
import type { AiService } from "./ai/service";
import type { AppAgent } from "../apps";
import { browserKeyFor, hintWords, matchProfileHint, normalizeUrl, profileLabels, siteUrl } from "../apps";
import { BROWSER_PROCESSES, browserName, extractPage, hostOf, isPrivateWindow, matchTabs } from "../browser";
import type { DesktopSnapshot, WindowInfo } from "../desktop";
import type { Verifier } from "../verifier";
import type { WorldModel } from "../verifier";

export interface OrchestratorDeps {
  world: WorldModel;
  fsAgent: FileSystemAgent;
  desktopAgent: DesktopAgent;
  actionAgent: ActionAgent;
  uiAgent: UiPanelAgent;
  visualAgent: VisualAgent;
  appAgent: AppAgent;
  /** the optional AI brain (a free provider); absent = only Momo's built-in phrases */
  ai?: AiService;
  /** which window the user was in before turning to Momo (absent in tests / non-Windows) */
  foreground?: ForegroundPort;
  verifier: Verifier;
  fs: FsPort;
  /** current permission policy (changes while Momo runs) */
  policy(): Policy;
  /** delivers events to the UI; every event is validated here before it leaves */
  emit(e: RuntimeEvent): void;
  sleep?(ms: number): Promise<void>;
  /** how long a confirmation stays open before it lapses (default 60 s) */
  confirmTimeoutMs?: number;
  /** how long one task may run before Momo gives up on it (default 90 s) */
  taskTimeoutMs?: number;
  /** how many times to look for the result of an action before giving up on verifying it */
  verifyAttempts?: number;
}

const GB = 1024 ** 3;
const TB = 1024 ** 4;
export function formatBytes(n: number): string {
  if (n >= TB) return `${(n / TB).toFixed(2)} TB`;
  return `${(n / GB).toFixed(1)} GB`;
}
const driveLine = (d: DriveInfo) => `${d.letter}: ${formatBytes(d.total)} total, ${formatBytes(d.free)} free (${formatBytes(d.used)} used)`;

type Then = "report" | "open" | "vscode";
type Pending =
  | { kind: "choice"; taskId: string; query: string; options: FolderMatch[]; asked: number; then: Then }
  | { kind: "confirm"; taskId: string; plan: ActionPlan; asked: number; timer: ReturnType<typeof setTimeout> }
  // several windows/controls match what the user said: ask which, never guess
  | { kind: "pick"; taskId: string; labels: string[]; asked: number; resume: (index: number, live: () => boolean) => Promise<void> };

/** Something that can be acted on: a window the user named, or the one they were just in. */
interface WinTarget { hwnd: number; pid: number; title: string; process?: string }
interface BrowserWin extends WinTarget { process: string }

/**
 * The single coordinating authority. Routes a transcript to the smallest sufficient capability,
 * asks when unsure, asks permission before acting (through the safety gate), verifies the result,
 * and only then reports success. No AI model is involved yet: every supported request is handled
 * by a deterministic handler.
 */
export class Orchestrator {
  private seq = 0;
  private generation = 0;
  private pending: Pending | null = null;
  private busy = false;
  /** what the user said in the current request (given to the AI as context when explaining something) */
  private requestText = "";
  /** the task the UI is currently showing, and tasks that were cancelled or timed out */
  private lastTaskId: string | null = null;
  private abandoned = new Set<string>();

  constructor(private d: OrchestratorDeps) {}

  private emit(e: unknown): void {
    const ev = parseRuntimeEvent(e); // validate at the boundary
    if (!ev) return;
    if ("taskId" in ev) {
      // a task that was cancelled or timed out can never speak again, even if something it awaited finally returns
      if (this.abandoned.has(ev.taskId)) return;
      this.lastTaskId = ev.taskId;
    }
    this.d.emit(ev);
  }

  /**
   * Safety net: if Windows (or anything awaited) never answers, stop waiting after a while, tell the user,
   * and free Momo for the next request. `finish()` must be called when the work ends normally.
   */
  private watchdog(gen: number): { finish(): void } {
    const ms = this.d.taskTimeoutMs ?? 90_000;
    const timer = setTimeout(() => {
      if (this.generation !== gen || !this.busy) return;
      this.emit({ type: "task.failed", taskId: this.lastTaskId ?? `t${this.seq}`, summary: "That took too long, so I stopped. You can try again.", recoverable: true });
      this.cancel(); // discards anything the hung call produces later
    }, ms);
    return { finish: () => clearTimeout(timer) };
  }

  private clearPending(): void {
    if (this.pending?.kind === "confirm") clearTimeout(this.pending.timer);
    this.pending = null;
  }

  /**
   * The permission policy in force. An action the AI proposed goes through exactly the same gate as one the user asked
   * for directly: it asks only where the gate asks (consequential actions, or what the user's settings say).
   */
  private pol(): Policy {
    return this.d.policy();
  }

  /** Only requests Momo's own router could not place are sent to the AI: known phrases never cost a request. */
  private wantsAi(intent: Intent): boolean {
    return intent.kind === "unrelated" || intent.kind === "ambiguous" || intent.kind === "unsupported";
  }

  async handleTranscript(sessionId: string, text: string): Promise<void> {
    if (this.busy) return; // one task at a time
    this.busy = true;
    const gen = this.generation;
    const live = () => gen === this.generation; // false after cancel()/dispose()
    const wd = this.watchdog(gen);
    let taskId = `t${this.seq}`; // plan ids also bump seq, so remember this task's own id for failure reports
    try {
      // an answer to our own question takes priority over a fresh request
      if (this.pending && (await this.answerPending(text, live))) return;
      taskId = `t${++this.seq}`;
      let intent = classify(text);
      this.requestText = text;

      const ai = this.d.ai;
      if (ai && ai.ready() && this.wantsAi(intent)) {
        this.emit({ type: "task.state", taskId, state: "working", message: `Asking ${ai.label()}…` });
        const r = await ai.interpret(text);
        if (!live()) return;
        if (r.ok) {
          const dec = r.decision;
          if (dec.type === "answer") { this.emit({ type: "task.answer", taskId, text: dec.text, source: `${r.source} · AI answer` }); return; }
          if (dec.type === "clarify") { this.emit({ type: "task.clarification_required", taskId, question: dec.question }); return; }
          if (dec.type === "none") { this.emit({ type: "task.state", taskId, state: "idle" }); return; }
          intent = dec.intent; // one of Momo's own steps: it now goes through the same gate as any other request
        } else if (intent.kind === "unrelated") {
          // Momo couldn't place it and the AI couldn't help: say why instead of silently ignoring a deliberate request
          this.emit({ type: "task.failed", taskId, summary: r.message, recoverable: true });
          return;
        }
        // ambiguous / unsupported: the built-in answer below still applies
      }
      await this.run(taskId, intent, live);
    } catch {
      if (live()) this.emit({ type: "task.failed", taskId, summary: "Something went wrong while doing that. You can retry.", recoverable: true });
    } finally {
      wd.finish();
      // a task that timed out was already released: never release a newer task's lock
      if (live()) this.busy = false;
    }
    void sessionId;
  }

  /** The user pressed Confirm/Cancel on the card. Ignored unless it matches the question that is actually open. */
  async respondConfirmation(taskId: string, approved: boolean): Promise<void> {
    const p = this.pending;
    if (this.busy || !p || p.kind !== "confirm" || p.taskId !== taskId) return; // stale or forged id
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

  /** Drop the current task: pending questions are forgotten and late results are discarded. */
  cancel(): void {
    this.d.ai?.reset(); // the AI's short conversation memory goes with the task
    if (this.lastTaskId) this.abandoned.add(this.lastTaskId);
    if (this.pending) this.abandoned.add(this.pending.taskId);
    if (this.abandoned.size > 200) this.abandoned = new Set([...this.abandoned].slice(-100)); // stay small
    this.generation++;
    this.clearPending();
    this.busy = false;
  }

  // ---------------------------------------------------------------- routing

  private async run(taskId: string, intent: Intent, live: () => boolean): Promise<void> {
    const working = (message: string) => this.emit({ type: "task.state", taskId, state: "working", message });
    const done = (summary: string) => live() && this.emit({ type: "task.completed", taskId, summary, verified: true });
    const failed = (summary: string, recoverable = true) => live() && this.emit({ type: "task.failed", taskId, summary, recoverable });

    switch (intent.kind) {
      case "unrelated":
        // not for Momo: take no action and make no claims
        this.emit({ type: "task.state", taskId, state: "idle" });
        return;

      case "ambiguous":
        this.emit({ type: "task.clarification_required", taskId, question: intent.question });
        return;

      case "unsupported":
        failed(intent.verb === "more than one step"
          ? "I can only do one thing at a time right now. Ask me for the first step, and then the next."
          : `I understood "${intent.verb}", but I can't do that yet. I can open apps, websites and folders, read and click things in a window, and work with browser tabs.`);
        return;

      case "open_app":
        return this.openApp(taskId, intent.query, live);

      case "open_in_vscode":
        return this.locate(taskId, intent.query, "vscode", live);

      case "open_url":
        return this.openUrl(taskId, intent.url, live);

      case "list_tabs":
        return this.tabsFlow(taskId, "list", intent.browser, live);

      case "current_page":
        return this.tabsFlow(taskId, "page", intent.browser, live);

      case "switch_tab":
        return this.switchTab(taskId, intent.query, intent.browser, live);

      case "drive_space": {
        working("Reading drive information…");
        if (intent.drive) {
          const r = await this.d.fsAgent.drive(intent.drive);
          if (!live()) return;
          if (r.kind === "not_found") {
            failed(`I couldn't find a ${r.letter}: drive. The drives I can see are ${r.available.map((l) => l + ":").join(", ") || "none"}.`);
            return;
          }
          if (!this.d.verifier.drive(r.info).verified) { failed("I read the drive but the numbers didn't check out, so I won't report them."); return; }
          done(`${driveLine(r.info)}.`);
          return;
        }
        const drives = await this.d.fsAgent.allDrives();
        if (!live()) return;
        const good = drives.filter((x) => this.d.verifier.drive(x).verified);
        if (good.length === 0) { failed("I couldn't read any drive information."); return; }
        done(good.map(driveLine).join(" · "));
        return;
      }

      case "active_window": {
        working("Checking your windows…");
        const snap = await this.d.desktopAgent.snapshot();
        if (!live()) return;
        if (!this.d.verifier.desktop(snap).verified) { failed("I couldn't get a reliable picture of your windows."); return; }
        if (!snap.active) { failed("I couldn't tell which window is in front."); return; }
        done(snap.active.isMomo
          ? "Momo itself is in front right now. Click the app you mean, then ask again."
          : `The active window is "${snap.active.title}" (${snap.active.process}).`);
        return;
      }

      case "list_windows": {
        working("Checking your windows…");
        const snap = await this.d.desktopAgent.snapshot();
        if (!live()) return;
        if (!this.d.verifier.desktop(snap).verified) { failed("I couldn't get a reliable picture of your windows."); return; }
        const others = snap.windows.filter((w) => !w.isMomo);
        if (others.length === 0) { done("I don't see any other open windows."); return; }
        const short = (s: string) => (s.length > 45 ? s.slice(0, 44) + "…" : s);
        const shown = others.slice(0, 8).map((w) => `${short(w.title)} (${w.process})`);
        done(`${others.length} open window${others.length === 1 ? "" : "s"}: ${shown.join("; ")}${others.length > 8 ? `; and ${others.length - 8} more` : ""}.`);
        return;
      }

      case "find_folder":
        return this.locate(taskId, intent.query, "report", live);

      case "open_folder":
        return this.locate(taskId, intent.query, "open", live);

      case "focus_window":
        return this.windowAction(taskId, "focus_window", intent.query, live);
      case "minimize_window":
        return this.windowAction(taskId, "minimize_window", intent.query, live);
      case "close_window":
        return this.windowAction(taskId, "close_window", intent.query, live);
      case "click_control":
        return this.controlAction(taskId, "click", intent.label, undefined, live);
      case "set_text":
        return this.controlAction(taskId, "type", intent.field, intent.text, live);

      case "list_accounts":
        return this.listAccounts(taskId, intent.browser, intent.mailWord === true);
      case "open_browser":
        return this.openBrowser(taskId, intent.browser, intent.hint, intent.site, live);
      case "explain_screen":
        return this.explain(taskId, live);

      case "read_screen":
        return this.lookAt(taskId, "read", intent.focus, live);

      case "list_controls":
        return this.lookAt(taskId, "controls", undefined, live);
    }
  }

  // ---------------------------------------------------------------- applications, websites, VS Code

  private async openApp(taskId: string, query: string, live: () => boolean): Promise<void> {
    this.emit({ type: "task.state", taskId, state: "working", message: "Looking for the app…" });
    const r = await this.d.appAgent.search(query);
    if (!live()) return;
    if (!r.ok) { this.emit({ type: "task.failed", taskId, summary: r.reason, recoverable: true }); return; }
    if (r.matches.length === 0) {
      // not an installed app: maybe a well-known website ("open youtube")
      const site = siteUrl(query);
      if (site) return this.openUrl(taskId, site.url, live);
      this.emit({ type: "task.failed", taskId, recoverable: true, summary: `I couldn't find an app called “${query}”. If you meant a folder, say “open the ${query} folder”.` });
      return;
    }
    if (r.matches.length > 1) {
      const opts = r.matches.slice(0, 4);
      this.setPick(taskId, opts.map((a) => a.name), (i, lv) => this.proposeApp(taskId, opts[i], lv));
      return;
    }
    return this.proposeApp(taskId, r.matches[0], live);
  }

  /**
   * "Open Chrome with the panda icon account and go to YouTube": one browser, an account the user DESCRIBED, and a site.
   * The description is matched against each account's name and email, then against the picture it uses. A match made from
   * the picture is a guess, so it is always confirmed with the account's email. Nothing is opened until the account is clear.
   */
  private async openBrowser(taskId: string, browser: "chrome" | "msedge" | "brave", hint: string | undefined, site: { url: string; host: string } | undefined, live: () => boolean): Promise<void> {
    const appName = browser === "msedge" ? "microsoft edge" : browser === "brave" ? "brave" : "google chrome";
    const found = await this.d.appAgent.search(appName);
    if (!live()) return;
    const app = found.ok ? found.matches.find((a) => browserKeyFor(a.name) === browser) : undefined;
    if (!app) { this.emit({ type: "task.failed", taskId, recoverable: true, summary: `I couldn't find ${browser === "msedge" ? "Microsoft Edge" : browser === "brave" ? "Brave" : "Google Chrome"} installed on this PC.` }); return; }
    const profiles = await this.d.appAgent.profilesOfBrowser(browser);
    if (!live()) return;
    if (profiles.length <= 1 || !hint) return this.proposeApp(taskId, app, live, undefined, site); // proposeApp asks which account when there are several
    const m = matchProfileHint(profiles, hint);
    const labelOf = (p: BrowserProfile) => profileLabels([p])[0];
    if (m.matches.length === 1) {
      const p = m.matches[0];
      return this.proposeApp(taskId, app, live, { dir: p.dir, name: labelOf(p) }, site, m.by === "text");
    }
    // several accounts fit, or none did: ask, and say why
    const pool = m.matches.length > 1 ? m.matches : profiles;
    const opts = pool.slice(0, 9);
    const labels = profileLabels(opts);
    const words = hintWords(hint).join(" ");
    if (m.matches.length === 0) this.emit({ type: "task.state", taskId, state: "working", message: `I can't tell which account has “${this.short(words || hint, 30)}”.` });
    this.setPick(taskId, labels, (i, lv) => this.proposeApp(taskId, app, lv, { dir: opts[i].dir, name: labels[i] }, site), `${this.short(app.name, 30)} accounts`);
  }

  /** "How many emails do I have in Chrome?": every account (profile) the browser has, with its email. */
  private async listAccounts(taskId: string, browser: string | undefined, mailWord: boolean): Promise<void> {
    const key = browser === "msedge" || browser === "brave" ? browser : "chrome";
    const name = key === "msedge" ? "Edge" : key === "brave" ? "Brave" : "Chrome";
    const profiles = await this.d.appAgent.profilesOfBrowser(key);
    if (profiles.length === 0) {
      this.emit({ type: "task.failed", taskId, recoverable: true, summary: `I couldn't find any ${name} accounts on this PC. Is ${name} installed and signed in?` });
      return;
    }
    if (!this.d.verifier.profiles(profiles).verified) { this.emit({ type: "task.failed", taskId, recoverable: true, summary: "What I read didn't check out, so I won't report it." }); return; }
    const labels = profileLabels(profiles);
    const shown = labels.slice(0, 20).map((l, i) => `${i + 1}) ${this.short(l, 90)}`).join("  ");
    const more = labels.length > 20 ? `, and ${labels.length - 20} more` : "";
    const note = mailWord ? " These are the accounts signed in to Chrome; I can't see your inbox." : "";
    this.emit({ type: "task.completed", taskId, verified: true, summary: `You have ${labels.length} ${name} account${labels.length === 1 ? "" : "s"}: ${shown}${more}.${note}` });
  }

  /**
   * Open an app. A browser with several accounts (profiles) is ambiguous, so Momo asks which one first. `site` is a web
   * address to open in that browser right away; `sure: false` means the account was GUESSED from a description (such as
   * its picture), so the user must confirm it, with the account's email shown.
   */
  private async proposeApp(taskId: string, app: AppEntry, live: () => boolean, profile?: { dir: string; name: string }, site?: { url: string; host: string }, sure = true): Promise<void> {
    if (!live()) return;
    if (!profile) {
      const profiles = await this.d.appAgent.profilesFor(app);
      if (!live()) return;
      if (profiles.length > 1) {
        const opts = profiles.slice(0, 9);
        const labels = profileLabels(opts);
        this.setPick(taskId, labels, (i, lv) => this.proposeApp(taskId, app, lv, { dir: opts[i].dir, name: labels[i] }, site), `${this.short(app.name, 30)} accounts`);
        return;
      }
    }
    const where = site ? ` and go to ${this.short(site.host, 40)}` : "";
    const plan: ActionPlan = {
      id: `a${++this.seq}`, kind: "open_app",
      // a guess made from a description is always confirmed, whatever the settings say
      risk: sure ? "reversible" : "consequential",
      summary: profile ? `Open ${this.short(app.name, 40)} with ${sure ? "the" : "what looks like the"} “${this.short(profile.name, 60)}” account${where}?` : `Open ${this.short(app.name, 50)}${where}?`,
      target: { appId: app.id, appName: app.name, ...(profile ? { profile } : {}), ...(site ? { url: site.url, host: site.host } : {}) },
    };
    if (decide(plan, this.pol()) === "allow") return this.execute(taskId, plan, live);
    this.askConfirmation(taskId, plan, 1);
  }

  private sleeper(): (ms: number) => Promise<void> {
    return this.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  }

  /** Start the app, then look for its window. Success is only reported when a window was actually seen. */
  private async executeApp(taskId: string, plan: ActionPlan, live: () => boolean): Promise<void> {
    const name = plan.target.appName ?? "the app";
    const id = plan.target.appId;
    if (!id) { this.emit({ type: "task.failed", taskId, summary: "I lost track of which app you meant.", recoverable: true }); return; }
    this.emit({ type: "task.state", taskId, state: "working", message: `Starting ${this.short(name, 40)}…` });
    const beforeSnap = await this.d.desktopAgent.snapshot();
    if (!live()) return;
    const before = new Set(beforeSnap.windows.map((w) => w.hwnd));
    const profile = plan.target.profile;
    const site = plan.target.url && plan.target.host ? { url: plan.target.url, host: plan.target.host } : undefined;
    const r = profile || site ? await this.d.appAgent.openProfile({ name, id }, profile?.dir ?? null, site?.url) : await this.d.appAgent.launchApp({ name, id });
    if (!live()) return;
    if (!r.ok) { this.emit({ type: "task.failed", taskId, summary: r.reason, recoverable: true }); return; }
    if (site) {
      // success means the browser is really showing the site, not just that a window appeared
      const shown = await this.confirmPage(site.host, live);
      if (shown === undefined) return;
      if (shown) this.emit({ type: "task.completed", taskId, verified: true, summary: `Opened ${site.host} in ${shown}${profile ? ` with the “${this.short(profile.name, 60)}” account` : ""}. The browser is showing it.` });
      else this.emit({ type: "task.state", taskId, state: "partial_success", message: `I opened ${this.short(name, 40)} for ${site.host}, but I couldn't confirm the page is showing.` });
      return;
    }
    const sleep = this.sleeper();
    for (let i = 0; i < (this.d.verifyAttempts ?? 4) * 2; i++) {
      await sleep(700);
      if (!live()) return;
      const snap = await this.d.desktopAgent.snapshot();
      if (!live()) return;
      if (this.d.verifier.appWindow(snap, before, name).verified) {
        this.emit({ type: "task.completed", taskId, summary: `Opened ${this.short(name, 50)}. I can see its window.`, verified: true });
        return;
      }
    }
    this.emit({ type: "task.state", taskId, state: "partial_success", message: `I asked Windows to start ${this.short(name, 40)}, but I couldn't see its window appear. It may still be starting.` });
  }

  private async executeVscode(taskId: string, plan: ActionPlan, live: () => boolean): Promise<void> {
    const folder = plan.target.path;
    if (!folder) { this.emit({ type: "task.failed", taskId, summary: "I lost track of which folder you meant.", recoverable: true }); return; }
    this.emit({ type: "task.state", taskId, state: "working", message: "Opening it in Visual Studio Code…" });
    const r = await this.d.appAgent.openFolderInVsCode(folder);
    if (!live()) return;
    if (!r.ok) { this.emit({ type: "task.failed", taskId, summary: r.reason, recoverable: true }); return; }
    const sleep = this.sleeper();
    for (let i = 0; i < (this.d.verifyAttempts ?? 4) * 2; i++) {
      await sleep(700);
      if (!live()) return;
      const snap = await this.d.desktopAgent.snapshot();
      if (!live()) return;
      if (this.d.verifier.vscodeFolder(snap, folder).verified) {
        this.emit({ type: "task.completed", taskId, summary: `Opened ${folder} in Visual Studio Code. I can see the window.`, verified: true });
        return;
      }
    }
    this.emit({ type: "task.state", taskId, state: "partial_success", message: "I asked Visual Studio Code to open it, but I couldn't see its window show that folder yet." });
  }

  private async openUrl(taskId: string, rawUrl: string, live: () => boolean): Promise<void> {
    const n = normalizeUrl(rawUrl);
    if (!n) { this.emit({ type: "task.failed", taskId, summary: "That doesn't look like a normal web address, so I won't open it.", recoverable: true }); return; }
    const shown = n.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const plan: ActionPlan = {
      id: `a${++this.seq}`, kind: "open_url", risk: "reversible",
      summary: `Open ${this.short(shown, 70)} in your browser?`, target: { url: n.url, host: n.host },
    };
    if (decide(plan, this.pol()) === "allow") return this.execute(taskId, plan, live);
    this.askConfirmation(taskId, plan, 1);
  }

  private async executeUrl(taskId: string, plan: ActionPlan, live: () => boolean): Promise<void> {
    const { url, host } = plan.target;
    if (!url || !host) { this.emit({ type: "task.failed", taskId, summary: "I lost track of the address.", recoverable: true }); return; }
    this.emit({ type: "task.state", taskId, state: "working", message: "Opening it…" });
    const r = await this.d.appAgent.openUrl(url);
    if (!live()) return;
    if (!r.ok) { this.emit({ type: "task.failed", taskId, summary: r.reason, recoverable: true }); return; }
    const shown = await this.confirmPage(host, live);
    if (shown === undefined) return;
    if (shown) this.emit({ type: "task.completed", taskId, summary: `Opened ${host} in ${shown}. The browser is showing it.`, verified: true });
    else this.emit({ type: "task.state", taskId, state: "partial_success", message: `I asked your browser to open ${host}, but I couldn't confirm the page is showing.` });
  }

  /**
   * Wait until a browser (never a private window, never Momo) is really showing a site. Returns the browser's name when it
   * is, null when it could not be confirmed, and undefined when the task was cancelled meanwhile.
   */
  private async confirmPage(host: string, live: () => boolean): Promise<string | null | undefined> {
    const sleep = this.sleeper();
    for (let i = 0; i < (this.d.verifyAttempts ?? 4) * 2; i++) {
      await sleep(800);
      if (!live()) return undefined;
      const snap = await this.d.desktopAgent.snapshot();
      if (!live()) return undefined;
      const w = snap.active && !snap.active.isMomo && BROWSER_PROCESSES.test(snap.active.process) && !isPrivateWindow(snap.active.title) ? snap.active : null;
      if (!w) continue;
      const ui = await this.d.uiAgent.read(w.hwnd);
      if (!live()) return undefined;
      if (!ui.ok) continue;
      const page = extractPage(ui.items);
      const selected = page.tabs.find((t) => t.selected);
      if (this.d.verifier.urlShown({ address: page.address, selectedTitle: selected?.name }, host).verified) return browserName(w.process);
    }
    return null;
  }

  // ---------------------------------------------------------------- browser: windows, tabs and pages

  private browserWindows(snap: DesktopSnapshot, browser?: string): { all: BrowserWin[]; usable: BrowserWin[] } {
    const all = snap.windows
      .filter((w) => !w.isMomo && BROWSER_PROCESSES.test(w.process) && (!browser || w.process.toLowerCase() === browser))
      .map((w) => ({ hwnd: w.hwnd, pid: w.pid, title: w.title, process: w.process }));
    // private windows are never listed or read
    return { all, usable: all.filter((w) => !isPrivateWindow(w.title)) };
  }

  private async tabsFlow(taskId: string, mode: "list" | "page", browser: string | undefined, live: () => boolean): Promise<void> {
    const failed = (summary: string) => live() && this.emit({ type: "task.failed", taskId, summary, recoverable: true });
    this.emit({ type: "task.state", taskId, state: "working", message: "Finding your browser…" });
    const snap = await this.d.desktopAgent.snapshot();
    if (!live()) return;
    const { all, usable } = this.browserWindows(snap, browser);
    const label = browser ? browserName(browser) : "browser";
    if (usable.length === 0) {
      failed(all.length > 0 ? `The ${label} windows I can see are private ones, which I don't read.` : `I don't see an open ${label} window.`);
      return;
    }
    let wins = usable;
    if (mode === "page") {
      // "what page am I on": the browser window the user was just in
      const t = this.pickTarget(snap);
      const mine = t ? usable.filter((w) => w.pid === t.pid) : [];
      wins = mine.length > 0 ? mine.slice(0, 1) : usable.length === 1 ? usable : [];
      if (wins.length === 0) { failed("I can't tell which browser window you mean. Click it, then ask again."); return; }
    }
    wins = wins.slice(0, 4);
    const plan: ActionPlan = {
      id: `a${++this.seq}`, kind: "read_tabs", risk: "sensitive_read",
      summary: mode === "page"
        ? `Look at which page your ${browserName(wins[0].process)} window is showing?`
        : `Look at the tabs in your ${wins.length} ${label} window${wins.length === 1 ? "" : "s"} (page titles and sites)?`,
      target: { windows: wins }, params: { tabs: mode },
    };
    if (decide(plan, this.pol()) === "allow") return this.perceiveTabs(taskId, plan, live, false);
    this.askConfirmation(taskId, plan, 1);
  }

  /** Read the approved browser windows: which windows, which tabs, which page. */
  private async perceiveTabs(taskId: string, plan: ActionPlan, live: () => boolean, recheck: boolean): Promise<void> {
    const failed = (summary: string) => live() && this.emit({ type: "task.failed", taskId, summary, recoverable: true });
    const wins = plan.target.windows ?? [];
    this.emit({ type: "task.state", taskId, state: "working", message: "Reading your tabs…" });
    if (recheck) {
      const snap = await this.d.desktopAgent.snapshot();
      if (!live()) return;
      const stillThere = wins.filter((w) => snap.windows.some((x) => x.pid === w.pid && x.hwnd === w.hwnd && !isPrivateWindow(x.title)));
      if (stillThere.length === 0) { failed("Those browser windows aren't open any more."); return; }
      wins.splice(0, wins.length, ...stillThere);
    }
    const parts: string[] = [];
    let totalTabs = 0;
    let pageLine = "";
    for (const w of wins) {
      const ui = await this.d.uiAgent.read(w.hwnd);
      if (!live()) return;
      const name = browserName(w.process);
      if (!ui.ok) { parts.push(`${name}: I couldn't read it`); continue; }
      const page = extractPage(ui.items);
      if (page.tabs.length === 0) { parts.push(`${name} doesn't show its tabs to Windows, so I can't list them`); continue; }
      totalTabs += page.tabs.length;
      const cur = page.tabs.find((t) => t.selected);
      if (plan.params?.tabs === "page") {
        const host = hostOf(page.address);
        pageLine = `You're on “${this.short(cur?.name ?? w.title, 70)}”${host ? ` (${host})` : ""} in ${name}.`;
        break;
      }
      const shown = page.tabs.slice(0, 8).map((t) => `“${this.short(t.name, 35)}”${t.selected ? " (current)" : ""}`);
      parts.push(`${name}: ${page.tabs.length} tab${page.tabs.length === 1 ? "" : "s"}: ${shown.join(", ")}${page.tabs.length > 8 ? ", and more" : ""}`);
    }
    if (plan.params?.tabs === "page") {
      if (!pageLine) { failed("I couldn't tell which page that is: the browser doesn't show it to Windows."); return; }
      if (live()) this.emit({ type: "task.completed", taskId, summary: pageLine, verified: true });
      return;
    }
    if (totalTabs === 0) { failed(`I couldn't read any tabs. ${parts.join("; ")}.`); return; }
    if (live()) this.emit({ type: "task.completed", taskId, summary: `${wins.length} browser window${wins.length === 1 ? "" : "s"}. ${parts.join(". ")}.`, verified: true });
  }

  private async switchTab(taskId: string, query: string, browser: string | undefined, live: () => boolean): Promise<void> {
    const failed = (summary: string) => live() && this.emit({ type: "task.failed", taskId, summary, recoverable: true });
    this.emit({ type: "task.state", taskId, state: "working", message: `Looking for a “${query}” tab…` });
    const snap = await this.d.desktopAgent.snapshot();
    if (!live()) return;
    const { all, usable } = this.browserWindows(snap, browser);
    if (usable.length === 0) { failed(all.length > 0 ? "The browser windows I can see are private ones, which I don't read." : "I don't see an open browser window."); return; }
    const found: { win: BrowserWin; tab: ReturnType<typeof extractPage>["tabs"][number] }[] = [];
    for (const w of usable.slice(0, 4)) {
      const ui = await this.d.uiAgent.read(w.hwnd);
      if (!live()) return;
      if (!ui.ok) continue;
      for (const tab of matchTabs(extractPage(ui.items).tabs, query)) if (tab.rid) found.push({ win: w, tab });
    }
    if (found.length === 0) { failed(`I can't find a tab called “${query}”.`); return; }
    if (found.length > 1) {
      const opts = found.slice(0, 4);
      this.setPick(taskId, opts.map((f) => `${this.short(f.tab.name, 40)} (${browserName(f.win.process)})`), (i, lv) => this.proposeTab(taskId, opts[i].win, opts[i].tab, lv));
      return;
    }
    return this.proposeTab(taskId, found[0].win, found[0].tab, live);
  }

  private async proposeTab(taskId: string, win: BrowserWin, tab: { name: string; rid?: string; enabled: boolean; selected?: boolean }, live: () => boolean): Promise<void> {
    if (!live()) return;
    if (!tab.enabled) { this.emit({ type: "task.failed", taskId, summary: "That tab can't be selected right now.", recoverable: true }); return; }
    if (tab.selected) {
      // observed just now: nothing to click
      this.emit({ type: "task.completed", taskId, summary: `The “${this.short(tab.name, 50)}” tab in ${browserName(win.process)} is already the one showing.`, verified: true });
      return;
    }
    const plan: ActionPlan = {
      id: `a${++this.seq}`, kind: "click_control", risk: "reversible",
      summary: `Switch to the “${this.short(tab.name, 50)}” tab in ${browserName(win.process)}?`,
      target: { hwnd: win.hwnd, pid: win.pid, title: win.title, rid: tab.rid, name: tab.name, controlType: "TabItem" },
    };
    if (decide(plan, this.pol()) === "allow") return this.execute(taskId, plan, live);
    this.askConfirmation(taskId, plan, 1);
  }

  // ---------------------------------------------------------------- acting on windows

  private matchWindows(snap: DesktopSnapshot, query: string): WinTarget[] {
    const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const q = n(query);
    const tokens = q.split(" ").filter(Boolean);
    const cands = snap.windows.filter((w) => !w.isMomo);
    const exact = cands.filter((w) => n(w.process) === q || n(w.title) === q);
    const hits = exact.length > 0 ? exact : cands.filter((w) => { const hay = n(`${w.title} ${w.process}`); return tokens.length > 0 && tokens.every((t) => hay.includes(t)); });
    return hits.map((w) => ({ hwnd: w.hwnd, pid: w.pid, title: w.title, process: w.process }));
  }

  private short(s: string, n = 60): string {
    const c = cleanScreenText(s);
    return c.length > n ? c.slice(0, n - 1) + "…" : c;
  }

  private async windowAction(taskId: string, kind: "focus_window" | "minimize_window" | "close_window", query: string | undefined, live: () => boolean): Promise<void> {
    this.emit({ type: "task.state", taskId, state: "working", message: "Finding the window…" });
    const snap = await this.d.desktopAgent.snapshot();
    if (!live()) return;
    let cands: WinTarget[];
    if (query) {
      cands = this.matchWindows(snap, query);
    } else {
      const t = this.pickTarget(snap);
      cands = t ? [t] : [];
    }
    if (cands.length === 0) {
      this.emit({ type: "task.failed", taskId, recoverable: true, summary: query ? `I couldn't find a window matching “${query}”.` : "I can't tell which window you mean. Click it, then ask again." });
      return;
    }
    if (cands.length > 1) {
      const opts = cands.slice(0, 4);
      this.setPick(taskId, opts.map((w) => `${this.short(w.title, 40)} (${w.process ?? "app"})`), (i, lv) => this.proposeWindow(taskId, kind, opts[i], lv));
      return;
    }
    return this.proposeWindow(taskId, kind, cands[0], live);
  }

  private async proposeWindow(taskId: string, kind: "focus_window" | "minimize_window" | "close_window", w: WinTarget, live: () => boolean): Promise<void> {
    const title = this.short(w.title);
    const plan: ActionPlan = {
      id: `a${++this.seq}`, kind,
      // closing can lose unsaved work, so it can never be done without asking
      risk: kind === "close_window" ? "consequential" : "reversible",
      summary: kind === "focus_window" ? `Switch to “${title}”?`
        : kind === "minimize_window" ? `Minimize “${title}”?`
        : `Close “${title}”? Anything unsaved in it could be lost.`,
      target: { hwnd: w.hwnd, pid: w.pid, title: w.title },
    };
    if (decide(plan, this.pol()) === "allow") return this.execute(taskId, plan, live);
    this.askConfirmation(taskId, plan, 1);
  }

  private async executeWindow(taskId: string, plan: ActionPlan, live: () => boolean): Promise<void> {
    const t = { hwnd: plan.target.hwnd!, pid: plan.target.pid! };
    const title = this.short(plan.target.title ?? "that window");
    const failed = (summary: string) => live() && this.emit({ type: "task.failed", taskId, summary, recoverable: true });
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    this.emit({ type: "task.state", taskId, state: "working", message: plan.kind === "close_window" ? "Closing it…" : plan.kind === "minimize_window" ? "Minimizing it…" : "Switching…" });

    const r = plan.kind === "focus_window" ? await this.d.actionAgent.focusWindow(t)
      : plan.kind === "minimize_window" ? await this.d.actionAgent.minimizeWindow(t)
      : await this.d.actionAgent.closeWindow(t);
    if (!live()) return;
    if (!r.ok) { failed(r.reason); return; }

    // verify by asking Windows what is true now
    const attempts = plan.kind === "close_window" ? 4 : 2;
    for (let i = 0; i < attempts; i++) {
      await sleep(plan.kind === "close_window" ? 700 : 400);
      if (!live()) return;
      const s = await this.d.actionAgent.state(t.hwnd);
      if (!live()) return;
      const v = plan.kind === "focus_window" ? this.d.verifier.windowFocused(s, t.pid)
        : plan.kind === "minimize_window" ? this.d.verifier.windowMinimized(s)
        : this.d.verifier.windowClosed(s);
      if (v.verified) {
        const verb = plan.kind === "focus_window" ? "Switched to" : plan.kind === "minimize_window" ? "Minimized" : "Closed";
        this.emit({ type: "task.completed", taskId, summary: `${verb} “${title}”. I checked with Windows.`, verified: true });
        return;
      }
    }
    // asked, but the result could not be observed: never claim success
    this.emit({
      type: "task.state", taskId, state: "partial_success",
      message: plan.kind === "focus_window" ? "I asked Windows to bring it to the front, but it didn't come forward. Windows sometimes blocks that."
        : plan.kind === "minimize_window" ? "I asked for it to be minimized, but it still isn't."
        : "I asked it to close, but it's still open. It may be asking whether to save.",
    });
  }

  // ---------------------------------------------------------------- acting on controls

  private typeWord(t: string): string {
    return ({ Button: "button", SplitButton: "button", CheckBox: "checkbox", RadioButton: "option", TabItem: "tab", Hyperlink: "link", MenuItem: "menu item", ListItem: "item", Edit: "field", ComboBox: "field" } as Record<string, string>)[t] ?? "control";
  }

  private async controlAction(taskId: string, kind: "click" | "type", label: string, text: string | undefined, live: () => boolean): Promise<void> {
    const failed = (summary: string) => live() && this.emit({ type: "task.failed", taskId, summary, recoverable: true });
    this.emit({ type: "task.state", taskId, state: "working", message: "Checking which window you mean…" });
    const snap = await this.d.desktopAgent.snapshot();
    if (!live()) return;
    const target = this.pickTarget(snap);
    if (!target) { failed("I can't tell which window you mean. Click it, then ask again."); return; }
    // typing into a password field is never done, whatever it is called
    if (kind === "type" && /\b(password|passcode|passphrase|pin|cvv|otp|secret)\b/i.test(label)) { failed("I never type into password fields."); return; }

    this.emit({ type: "task.state", taskId, state: "working", message: `Looking for “${label}”…` });
    const ui = await this.d.uiAgent.read(target.hwnd);
    if (!live()) return;
    const title = this.short(target.title);
    if (!ui.ok) { failed(`I couldn't look inside “${title}” (${ui.reason}).`); return; }

    const matches = matchControls(ui.items, label, kind);
    if (matches.length === 0) {
      const names = visibleNames(ui.items, kind);
      failed(`I can't see a “${label}” ${kind === "click" ? "button" : "field"} in “${title}”.${names.length ? ` I can see: ${names.join(", ")}.` : ""}`);
      return;
    }
    if (matches.length > 1) {
      const opts = matches.slice(0, 4);
      this.setPick(taskId, opts.map((n) => `${this.short(n.name, 40)} (${this.typeWord(n.type)})`), (i, lv) => this.proposeControl(taskId, kind, text, target, opts[i], lv));
      return;
    }
    return this.proposeControl(taskId, kind, text, target, matches[0], live);
  }

  private async proposeControl(taskId: string, kind: "click" | "type", text: string | undefined, target: WinTarget, node: UiNode, live: () => boolean): Promise<void> {
    if (!live()) return;
    const name = this.short(node.name, 50);
    const title = this.short(target.title);
    if (!node.enabled) { this.emit({ type: "task.failed", taskId, recoverable: true, summary: `“${name}” is disabled right now, so I can't use it.` }); return; }
    if (kind === "type" && node.readOnly) { this.emit({ type: "task.failed", taskId, recoverable: true, summary: `“${name}” is read-only.` }); return; }
    const risk = kind === "click" ? classifyControlRisk(node.name) : "reversible";
    // the card shows EXACTLY what will be typed (it is at most 500 characters): never a shortened preview of a longer text
    const shown = text;
    const plan: ActionPlan = {
      id: `a${++this.seq}`, kind: kind === "click" ? "click_control" : "set_text", risk,
      summary: kind === "click"
        ? `Click the “${name}” ${this.typeWord(node.type)} in “${title}”?${risk === "consequential" ? " This might not be undoable." : ""}`
        : `Type “${shown}” into the “${name}” field in “${title}”?`,
      target: { hwnd: target.hwnd, pid: target.pid, title: target.title, rid: node.rid, name: node.name, controlType: node.type },
      params: kind === "type" ? { text } : undefined,
    };
    if (decide(plan, this.pol()) === "allow") return this.execute(taskId, plan, live);
    this.askConfirmation(taskId, plan, 1);
  }

  /** Re-find exactly the approved control, act on it, then check the effect. */
  private async executeControl(taskId: string, plan: ActionPlan, live: () => boolean): Promise<void> {
    const failed = (summary: string) => live() && this.emit({ type: "task.failed", taskId, summary, recoverable: true });
    const { hwnd, pid, rid, name } = plan.target;
    const title = this.short(plan.target.title ?? "that window");
    const shortName = this.short(name ?? "that control", 50);
    if (hwnd === undefined || pid === undefined || !rid || !name) { failed("I lost track of exactly which control you meant."); return; }
    this.emit({ type: "task.state", taskId, state: "working", message: plan.kind === "set_text" ? "Typing…" : "Clicking…" });

    // pre-action check: this exact control must still exist, with the same name, and be usable
    const before = await this.d.uiAgent.read(hwnd);
    if (!live()) return;
    if (!before.ok) { failed(`I couldn't look inside “${title}” any more (${before.reason}).`); return; }
    const node = before.items.find((n) => n.rid === rid);
    if (!node || node.name !== name) { failed(`“${shortName}” has changed or gone, so I didn't touch it.`); return; }
    if (!node.enabled) { failed(`“${shortName}” is disabled right now, so I didn't touch it.`); return; }
    const sig0 = signature(before.items);
    const t = { hwnd, pid, rid, name };
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));

    if (plan.kind === "set_text") {
      const text = plan.params?.text ?? "";
      const r = await this.d.actionAgent.typeText(t, text);
      if (!live()) return;
      if (!r.ok) { failed(r.reason); return; }
      if (this.d.verifier.typed(r.readBack, text).verified) {
        this.emit({ type: "task.completed", taskId, summary: `Typed it into “${shortName}” in “${title}”. I read the field back and it matches.`, verified: true });
      } else {
        this.emit({ type: "task.state", taskId, state: "partial_success", message: `I entered it, but “${shortName}” now shows something different (${this.short(r.readBack, 40)}).` });
      }
      return;
    }

    const r = await this.d.actionAgent.clickControl(t);
    if (!live()) return;
    if (!r.ok) { failed(r.reason); return; }
    await sleep(700);
    if (!live()) return;
    const after = await this.d.uiAgent.read(hwnd);
    if (!live()) return;
    let gone = false;
    if (!after.ok) gone = !(await this.d.actionAgent.state(hwnd)).exists;
    const verdict = this.d.verifier.clickEffect(sig0, after.ok ? signature(after.items) : null, gone);
    if (verdict.verified) {
      if (plan.target.controlType === "TabItem") {
        // a tab was selected inside its window: also bring that browser window to the front (best effort)
        await this.d.actionAgent.focusWindow({ hwnd, pid });
        if (!live()) return;
        this.emit({ type: "task.completed", taskId, summary: `Switched to the “${shortName}” tab. I checked: the tab selection changed.`, verified: true });
        return;
      }
      this.emit({ type: "task.completed", taskId, summary: `Clicked “${shortName}” in “${title}”. I checked: ${gone ? "the window closed" : "the window changed"} afterwards.`, verified: true });
    } else {
      // never claim an effect that wasn't observed
      this.emit({ type: "task.state", taskId, state: "partial_success", message: `I clicked “${shortName}”, but I couldn't see anything change, so I can't confirm it worked.` });
    }
  }

  // ---------------------------------------------------------------- "which one?" for windows and controls

  /** Ask "which one?" whenever more than one thing could be meant (apps, windows, tabs, controls, folders, browser profiles...). */
  private setPick(taskId: string, labels: string[], resume: (index: number, live: () => boolean) => Promise<void>, noun = "matches"): void {
    this.clearPending();
    this.pending = { kind: "pick", taskId, labels, asked: 1, resume };
    this.emit({ type: "task.clarification_required", taskId, question: `I found ${labels.length} ${noun}: ${labels.map((l, i) => `${i + 1}) ${l}`).join("  ")}. Which one?` });
  }

  private async answerPick(p: Extract<Pending, { kind: "pick" }>, text: string, live: () => boolean): Promise<boolean> {
    const choice = resolveChoice(text, p.labels);
    if (choice.kind === "cancel") {
      this.clearPending();
      this.emit({ type: "task.state", taskId: p.taskId, state: "idle" });
      return true;
    }
    if (choice.kind === "pick") {
      this.clearPending();
      await p.resume(choice.index, live);
      return true;
    }
    const k = classify(text).kind;
    if (k !== "unrelated" && k !== "ambiguous") { this.clearPending(); return false; }
    if (p.asked >= 2) {
      this.clearPending();
      this.emit({ type: "task.failed", taskId: p.taskId, summary: "I still couldn't tell which one you meant, so I stopped. Ask again whenever you like.", recoverable: true });
      return true;
    }
    p.asked++;
    this.emit({ type: "task.clarification_required", taskId: p.taskId, question: `Sorry, which one? Say “first”, “second”… or “cancel”. ${p.labels.map((l, i) => `${i + 1}) ${l}`).join("  ")}` });
    return true;
  }

  // ---------------------------------------------------------------- looking at a window

  /** The window the user was in before turning to Momo (never Momo's own window). */
  private pickTarget(snap: DesktopSnapshot): { hwnd: number; pid: number; title: string } | null {
    const fg = this.d.foreground?.lastExternal() ?? null;
    if (fg) {
      const w = snap.windows.find((x) => x.pid === fg.pid && !x.isMomo);
      if (w) return { hwnd: fg.hwnd, pid: fg.pid, title: fg.title || w.title };
    }
    const a: WindowInfo | null = snap.active;
    return a && !a.isMomo ? { hwnd: a.hwnd, pid: a.pid, title: a.title } : null;
  }

  /**
   * "Explain this": read the window as usual, then ask the AI to explain what was read. Because that sends the text
   * of the screen to the AI, it only happens when the AI may see the screen (always for Ollama on this PC; for an
   * online provider only if the user switched MOMO_AI_ALLOW_SCREEN_CONTEXT on), and only after the user confirms.
   */
  private async explain(taskId: string, live: () => boolean): Promise<void> {
    const ai = this.d.ai;
    if (!ai || !ai.ready()) {
      // no AI: the best Momo can do is find and show the error text
      this.emit({ type: "task.state", taskId, state: "working", message: "The AI is off, so I'll just read the error text." });
      return this.lookAt(taskId, "read", "error", live);
    }
    if (!ai.canSeeScreen()) {
      this.emit({
        type: "task.failed", taskId, recoverable: true,
        summary: `I can read that window, but explaining it means sending its text to ${ai.label()}, an online service, and that is switched off to protect your privacy (MOMO_AI_ALLOW_SCREEN_CONTEXT=false in .env). Say "read the error" to just read it, or set the provider to Ollama to keep it all on this PC.`,
      });
      return;
    }
    return this.lookAt(taskId, "read", undefined, live, true);
  }

  private async lookAt(taskId: string, mode: "read" | "controls", focus: "error" | undefined, live: () => boolean, explain = false): Promise<void> {
    this.emit({ type: "task.state", taskId, state: "working", message: "Checking which window you mean…" });
    const snap = await this.d.desktopAgent.snapshot();
    if (!live()) return;
    const target = this.pickTarget(snap);
    if (!target) {
      this.emit({ type: "task.failed", taskId, recoverable: true, summary: "I can't tell which window you mean. Click the window you want me to look at, then ask again." });
      return;
    }
    const title = target.title.length > 60 ? target.title.slice(0, 59) + "…" : target.title;
    const plan: ActionPlan = {
      id: `a${++this.seq}`, kind: "read_screen",
      // sending what is on a window to an online AI service is a decision (data leaves this PC): it always asks
      risk: explain && this.d.ai?.isCloud() ? "consequential" : "sensitive_read",
      summary: mode === "controls"
        ? `Look at the “${title}” window and list its buttons and controls?`
        : explain && this.d.ai
          ? `Look at the “${title}” window and ${this.d.ai.isCloud() ? `send its text to ${this.d.ai.label()} (an online service)` : `explain its text with ${this.d.ai.label()}`} to explain it?`
          : `Look at the “${title}” window and read what's on it?`,
      target, params: { mode, focus, explain },
    };
    if (decide(plan, this.pol()) === "allow") return this.perceive(taskId, plan, live, false);
    this.askConfirmation(taskId, plan, 1);
  }

  /** Read the approved window. Re-checks it still exists, then verifies what was read before reporting it. */
  private async perceive(taskId: string, plan: ActionPlan, live: () => boolean, recheck: boolean): Promise<void> {
    const failed = (summary: string) => live() && this.emit({ type: "task.failed", taskId, summary, recoverable: true });
    const done = (summary: string) => live() && this.emit({ type: "task.completed", taskId, summary, verified: true });
    const { hwnd, pid } = plan.target;
    const title = plan.target.title ?? "that window";
    if (hwnd === undefined || pid === undefined) { failed("I lost track of which window you meant."); return; }
    this.emit({ type: "task.state", taskId, state: "working", message: "Reading the window…" });

    if (recheck) {
      // the user may have taken a while to answer: make sure it is still the window they approved
      const snap = await this.d.desktopAgent.snapshot();
      if (!live()) return;
      if (!snap.windows.some((w) => w.pid === pid && !w.isMomo)) { failed(`“${title}” isn't open any more.`); return; }
    }

    const ui = await this.d.uiAgent.read(hwnd);
    if (!live()) return;
    const mode = plan.params?.mode ?? "read";

    if (mode === "controls") {
      if (!ui.ok) { failed(`I couldn't read the controls of “${title}” (${ui.reason}).`); return; }
      const controls = collectControls(ui.items);
      if (controls.length === 0) {
        failed(`“${title}” doesn't tell Windows about its buttons and controls, so I can't list them. I can still read its text: ask me to read the window.`);
        return;
      }
      if (!this.d.verifier.screenText(controls.map((c) => c.name), "uia").verified) { failed("What I read didn't check out, so I won't report it."); return; }
      const shown = controls.slice(0, 12).map((c) => (c.enabled ? c.name : `${c.name} (disabled)`));
      done(`In “${title}” I can see ${controls.length} control${controls.length === 1 ? "" : "s"}: ${shown.join(", ")}${controls.length > 12 ? ", and more" : ""}.`);
      return;
    }

    const explain = plan.params?.explain === true;
    let lines = ui.ok ? collectText(ui.items, explain ? 30 : MAX_LINES) : [];
    let source: "uia" | "ocr" = "uia";
    // a screenshot would show whatever a password box shows, so never fall back to one for a window that has such a box
    const hasPassword = ui.ok && ui.hadPasswordField === true;
    if (totalChars(lines) < SPARSE_TEXT_CHARS && !hasPassword) {
      // the app doesn't expose its text: fall back to reading a screenshot with the local OCR engine
      const o = await this.d.visualAgent.read(hwnd);
      if (!live()) return;
      if (o.ok && o.lines.length > 0) {
        lines = o.lines.slice(0, explain ? 40 : MAX_LINES * 2);
        source = "ocr";
      } else if (lines.length === 0) {
        failed(`I couldn't read “${title}”: ${o.ok ? "I found no text on it" : o.reason}.`);
        return;
      }
    }
    if (!this.d.verifier.screenText(lines, source).verified) { failed("What I read didn't check out, so I won't report it."); return; }

    const note = source === "ocr" ? " (read from a screenshot, so it may contain mistakes)" : "";

    if (explain && this.d.ai) {
      // The text below was already redacted (passwords, keys, card numbers) and the user confirmed sending it.
      this.emit({ type: "task.state", taskId, state: "working", message: `Asking ${this.d.ai.label()} to explain…` });
      const r = await this.d.ai.explain({ title, lines, request: this.requestText });
      if (!live()) return;
      if (r.ok) {
        this.emit({ type: "task.answer", taskId, text: r.text, source: `${r.source} · explains “${title.length > 40 ? title.slice(0, 39) + "…" : title}”${source === "ocr" ? " (read from a screenshot)" : ""}` });
      } else {
        // the reading itself succeeded and was verified: report that, and say why there is no explanation
        done(`In “${title}” I can read: ${lines.slice(0, 6).join(" · ").slice(0, 500)}. I couldn't get an explanation: ${r.message}`);
      }
      return;
    }
    if (plan.params?.focus === "error") {
      const hits = errorLines(lines);
      if (hits.length === 0) { done(`I read “${title}” but didn't see an error message${note}.`); return; }
      lines = hits;
    }
    let text = lines.slice(0, 8).join(" · ");
    if (text.length > 600) text = text.slice(0, 599) + "…";
    done(`In “${title}” I can read: ${text}${lines.length > 8 ? " …" : ""}${note}.`);
  }

  // ---------------------------------------------------------------- folders

  private async locate(taskId: string, query: string, then: Then, live: () => boolean): Promise<void> {
    this.emit({ type: "task.state", taskId, state: "working", message: `Looking for “${query}”…` });
    const found = await this.d.fsAgent.findFolders(query);
    if (!live()) return;
    // re-check on disk before reporting or acting on anything
    const { verdict, confirmed } = await this.d.verifier.folders(found.matches, this.d.fs);
    if (!verdict.verified) {
      this.emit({ type: "task.failed", taskId, recoverable: true, summary: `I couldn't find a folder matching “${query}”${found.truncated ? " in the part of the disk I searched before stopping" : ""}.` });
      return;
    }
    await this.present(taskId, query, confirmed, found.truncated, then, live);
  }

  private async present(taskId: string, query: string, options: FolderMatch[], truncated: boolean, then: Then, live: () => boolean): Promise<void> {
    if (!live()) return;
    if (options.length === 1 && !truncated) return this.chosen(taskId, options[0], then, live);
    // several plausible targets (or an incomplete search): ask, never guess
    const shown = options.slice(0, 4);
    this.clearPending();
    this.pending = { kind: "choice", taskId, query, options: shown, asked: 1, then };
    const more = options.length > shown.length ? ` (${options.length - shown.length} more not shown)` : "";
    const question = options.length === 1
      ? `I found one match so far, but my search stopped early: ${shown[0].path}. Is that it?`
      : `I found ${options.length} folders matching “${query}”${more}: ${shown.map((o, i) => `${i + 1}) ${o.path}`).join("  ")}. Which one?`;
    this.emit({ type: "task.clarification_required", taskId, question });
  }

  /** The target is now exact: report it, or propose acting on it. */
  private async chosen(taskId: string, folder: FolderMatch, then: Then, live: () => boolean): Promise<void> {
    if (then === "report") {
      this.emit({ type: "task.completed", taskId, summary: `Found it: ${folder.path} (checked on disk).`, verified: true });
      return;
    }
    if (then === "vscode") {
      // multi-agent task: the file system agent found and verified the folder, the application agent opens it
      const vs: ActionPlan = {
        id: `a${++this.seq}`, kind: "open_in_vscode", risk: "reversible",
        summary: `Open “${folder.path}” in Visual Studio Code?`, target: { path: folder.path },
      };
      if (decide(vs, this.pol()) === "allow") return this.execute(taskId, vs, live);
      this.askConfirmation(taskId, vs, 1);
      return;
    }
    const plan: ActionPlan = {
      id: `a${++this.seq}`, kind: "open_folder", risk: "reversible",
      summary: `Open “${folder.path}” in File Explorer?`, target: { path: folder.path },
    };
    if (decide(plan, this.pol()) === "allow") return this.execute(taskId, plan, live);
    this.askConfirmation(taskId, plan, 1);
  }

  // ---------------------------------------------------------------- permission + action

  private askConfirmation(taskId: string, plan: ActionPlan, asked: number): void {
    this.clearPending();
    const ms = this.d.confirmTimeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      // no answer: do nothing, and say so
      if (this.pending?.kind === "confirm" && this.pending.taskId === taskId) {
        this.pending = null;
        this.emit({ type: "task.state", taskId, state: "idle", message: "I didn't hear back, so I didn't do anything." });
      }
    }, ms);
    this.pending = { kind: "confirm", taskId, plan, asked, timer };
    this.emit({ type: "task.confirmation_required", taskId, summary: plan.summary });
  }

  private async resolveConfirmation(p: Extract<Pending, { kind: "confirm" }>, approved: boolean, live: () => boolean): Promise<void> {
    this.clearPending();
    if (!approved) {
      this.emit({ type: "task.state", taskId: p.taskId, state: "idle", message: "Okay, I won't do that." });
      return;
    }
    await this.execute(p.taskId, p.plan, live, true);
  }

  /** Carry out an approved plan. */
  private async execute(taskId: string, plan: ActionPlan, live: () => boolean, confirmed = false): Promise<void> {
    switch (plan.kind) {
      case "read_screen": return this.perceive(taskId, plan, live, confirmed);
      case "read_tabs": return this.perceiveTabs(taskId, plan, live, confirmed);
      case "open_app": return this.executeApp(taskId, plan, live);
      case "open_in_vscode": return this.executeVscode(taskId, plan, live);
      case "open_url": return this.executeUrl(taskId, plan, live);
      case "open_folder": return this.executeOpen(taskId, plan, live);
      case "focus_window":
      case "minimize_window":
      case "close_window": return this.executeWindow(taskId, plan, live);
      case "click_control":
      case "set_text": return this.executeControl(taskId, plan, live);
    }
  }

  /** Act, then verify. Success is only reported when the result was actually observed. */
  private async executeOpen(taskId: string, plan: ActionPlan, live: () => boolean): Promise<void> {
    this.emit({ type: "task.state", taskId, state: "working", message: "Opening it…" });
    if (plan.target.path === undefined) { this.emit({ type: "task.failed", taskId, summary: "I lost track of which folder you meant.", recoverable: true }); return; }
    const r = await this.d.actionAgent.openFolder(plan.target.path);
    if (!live()) return;
    if (!r.ok) {
      this.emit({ type: "task.failed", taskId, summary: r.reason, recoverable: true });
      return;
    }
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    for (let i = 0; i < (this.d.verifyAttempts ?? 4); i++) {
      await sleep(600);
      if (!live()) return;
      const snap = await this.d.desktopAgent.snapshot();
      if (!live()) return;
      if (this.d.verifier.folderWindow(snap, plan.target.path).verified) {
        this.emit({ type: "task.completed", taskId, summary: `Opened ${plan.target.path} in File Explorer — I can see the window.`, verified: true });
        return;
      }
    }
    // asked Windows, but the result could not be observed: never claim full success
    this.emit({ type: "task.state", taskId, state: "partial_success", message: "I asked Windows to open it, but I couldn't confirm the window appeared." });
  }

  // ---------------------------------------------------------------- answers to our questions

  /** @returns true if the utterance was consumed as an answer */
  private async answerPending(text: string, live: () => boolean): Promise<boolean> {
    const p = this.pending!;
    if (p.kind === "confirm") return this.answerConfirm(p, text, live);
    if (p.kind === "pick") return this.answerPick(p, text, live);
    return this.answerChoice(p, text, live);
  }

  private async answerConfirm(p: Extract<Pending, { kind: "confirm" }>, text: string, live: () => boolean): Promise<boolean> {
    const yn = resolveYesNo(text);
    if (yn !== "unclear") {
      await this.resolveConfirmation(p, yn === "yes", live);
      return true;
    }
    // an unrelated new request drops the old question (and does NOT count as consent)
    const k = classify(text).kind;
    if (k !== "unrelated" && k !== "ambiguous") {
      this.clearPending();
      return false;
    }
    if (p.asked >= 2) {
      this.clearPending();
      this.emit({ type: "task.state", taskId: p.taskId, state: "idle", message: "I didn't get a clear yes, so I didn't do it." });
      return true;
    }
    this.askConfirmation(p.taskId, p.plan, p.asked + 1); // ask again with the same exact summary
    return true;
  }

  private async answerChoice(p: Extract<Pending, { kind: "choice" }>, text: string, live: () => boolean): Promise<boolean> {
    const choice = resolveChoice(text, p.options.map((o) => o.path));
    if (choice.kind === "cancel") {
      this.clearPending();
      this.emit({ type: "task.state", taskId: p.taskId, state: "idle" });
      return true;
    }
    if (choice.kind === "pick") {
      this.clearPending();
      const picked = p.options[choice.index];
      const { verdict } = await this.d.verifier.folders([picked], this.d.fs);
      if (!live()) return true;
      if (!verdict.verified) {
        this.emit({ type: "task.failed", taskId: p.taskId, summary: "That folder doesn't seem to exist any more.", recoverable: true });
        return true;
      }
      await this.chosen(p.taskId, picked, p.then, live);
      return true;
    }
    // unclear: if it sounds like a brand-new request, drop the old question and handle it normally
    const k = classify(text).kind;
    if (k !== "unrelated" && k !== "ambiguous") {
      this.clearPending();
      return false;
    }
    if (p.asked >= 2) {
      this.clearPending();
      this.emit({ type: "task.failed", taskId: p.taskId, summary: "I still couldn't tell which folder you meant, so I stopped. Ask again whenever you like.", recoverable: true });
      return true;
    }
    p.asked++;
    this.emit({ type: "task.clarification_required", taskId: p.taskId, question: `Sorry, which one? Say “first”, “second”… or “cancel”. ${p.options.map((o, i) => `${i + 1}) ${o.path}`).join("  ")}` });
    return true;
  }
}
