/**
 * Permission and safety gate. Decides, for a concrete planned action, whether Momo may just do it
 * or must ask first. Pure and deterministic: the model/agents never decide this for themselves.
 */
export type Risk =
  | "read" //             reads information only (drive space, window list)
  | "sensitive_read" //   reads what is on the user's screen: changes nothing, but is private
  | "reversible" //       changes what is on screen, easily undone (open a folder, focus a window)
  | "consequential"; //   external or hard to undo: send, delete, overwrite, purchase, submit

export type ActionKind =
  | "open_folder" | "read_screen"
  | "open_app" | "open_in_vscode" | "open_url" | "read_tabs"
  | "focus_window" | "minimize_window" | "close_window"
  | "click_control" | "set_text";

export interface ActionPlan {
  id: string;
  kind: ActionKind;
  risk: Risk;
  /** exactly what will happen, shown to the user before they confirm */
  summary: string;
  /**
   * An identified, concrete target: a folder path, a window, or one control inside a window
   * (`rid` is the control's UI Automation runtime id, `name` the label the user was shown).
   */
  target: {
    path?: string; hwnd?: number; title?: string; pid?: number; rid?: string; name?: string; controlType?: string;
    /** an installed app (Start-menu id and display name) */
    appId?: string; appName?: string;
    /** one profile of a browser (Chrome, Edge, Brave) chosen by the user */
    profile?: { dir: string; name: string };
    /** a web address (already validated) and its host */
    url?: string; host?: string;
    /** browser windows to read for read_tabs */
    windows?: { hwnd: number; pid: number; process: string; title: string }[];
  };
  /** how a read_screen result should be presented, what to type for set_text, or what to show for read_tabs */
  params?: { mode?: "read" | "controls"; focus?: "error"; text?: string; tabs?: "list" | "page"; explain?: boolean };
}

export interface Policy {
  /** ask before reversible actions too (default: yes while Momo is new) */
  confirmReversible: boolean;
  /** ask before looking at the screen (default: yes: screen contents are private) */
  confirmScreenRead: boolean;
}
// Opening things is routine, so it does not ask. Only decisions (consequential actions) always ask.
export const DEFAULT_POLICY: Policy = { confirmReversible: false, confirmScreenRead: false };

/** Files that RUN code when opened. Opening one is not "just opening a file": it is a decision. */
const PROGRAM_EXTENSIONS = new Set([
  "exe", "com", "bat", "cmd", "msi", "msp", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "scr", "pif", "reg", "jar", "hta", "msc", "cpl", "lnk", "appx", "msix", "dll", "sys", "gadget",
]);
export function isProgramFile(filePath: string): boolean {
  const name = filePath.slice(Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/")) + 1);
  const dot = name.lastIndexOf(".");
  return dot >= 0 && PROGRAM_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export type Decision = "allow" | "confirm";

export function decide(plan: Pick<ActionPlan, "risk">, policy: Policy): Decision {
  if (plan.risk === "consequential") return "confirm"; // never skippable
  if (plan.risk === "reversible") return policy.confirmReversible ? "confirm" : "allow";
  if (plan.risk === "sensitive_read") return policy.confirmScreenRead ? "confirm" : "allow";
  return "allow";
}

/**
 * Labels whose buttons send, delete, overwrite, buy, submit or otherwise can't be taken back.
 * Clicking one ALWAYS needs confirmation, whatever the policy says. Deliberately broad: a wrong
 * "ask" costs one tap, a wrong "don't ask" can cost data or money.
 */
const CONSEQUENTIAL_LABEL = new RegExp(
  "\\b(" + [
    "delete", "remove", "erase", "clear", "empty", "wipe", "discard", "destroy", "uninstall", "format", "reset", "restore",
    "send", "reply", "forward", "post", "publish", "share", "upload", "submit", "transfer", "pay", "buy", "purchase",
    "checkout", "check out", "order", "book", "subscribe", "donate", "withdraw", "deposit",
    "save", "overwrite", "replace", "apply", "confirm", "yes", "ok", "okay", "accept", "agree", "allow", "grant", "authori[sz]e",
    "exit", "quit", "finish", "done", "continue", "rename", "disable", "turn off", "terminate", "kill", "stop", "move",
    "sign out", "log out", "logout", "sign off", "install", "update", "download", "run", "execute", "empty trash", "permanently", "unsubscribe",
  ].join("|") + ")\\b",
  "i",
);

export function classifyControlRisk(label: string): Risk {
  return CONSEQUENTIAL_LABEL.test(label) ? "consequential" : "reversible";
}

export type YesNo = "yes" | "no" | "unclear";

/** Understand a spoken or typed answer to "Do you want me to...?". */
export function resolveYesNo(answer: string): YesNo {
  const t = answer.toLowerCase().replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  const yes = /\b(yes|yeah|yep|yup|sure|ok|okay|confirm|go ahead|do it|proceed|please do)\b/.test(t);
  const no = /\b(no|nope|cancel|stop|don'?t|do not|never ?mind|abort)\b/.test(t);
  if (yes === no) return "unclear"; // neither, or both: never assume consent
  return yes ? "yes" : "no";
}
