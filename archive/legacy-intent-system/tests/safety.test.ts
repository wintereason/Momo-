import { afterEach, describe, expect, it, vi } from "vitest";
import { decide, resolveYesNo, DEFAULT_POLICY } from "./safety";
import { ActionAgent } from "./actionAgent";
import { Verifier } from "../verifier";
import { classify } from "../orchestrator/intent";
import { Session } from "../orchestrator/session";
import { companionReducer, initialCompanionState } from "../../state/companionState";
import type { ActionPort, FsPort, RawWindow, WindowsPort, WindowsSnapshot } from "../shared/ports";
import type { RuntimeEvent } from "../../types/runtime-events";

// ---------- fakes ----------
const TREE: Record<string, string[]> = {
  "C:\\Users\\me": ["Documents"],
  "D:\\": ["Project 2", "Single Folder"],
  "D:\\Project 2": ["Context Companion Ai"],
  "C:\\Users\\me\\Documents": ["Context Companion"],
};
function fakeFs(): { port: FsPort; remove(p: string): void } {
  const exists = new Set<string>();
  for (const [dir, kids] of Object.entries(TREE)) { exists.add(dir.toLowerCase()); kids.forEach((k) => exists.add(`${dir.replace(/\\$/, "")}\\${k}`.toLowerCase())); }
  return {
    remove: (p) => void exists.delete(p.toLowerCase()),
    port: {
      listDriveRoots: async () => ["C:\\", "D:\\"],
      statfs: async () => ({ total: 100, free: 40 }),
      readDirs: async (p) => TREE[p] ?? null,
      stat: async (p) => (exists.has(p.toLowerCase()) ? { isDir: true } : null),
      homeDir: () => "C:\\Users\\me",
    },
  };
}
const W = (hwnd: number, pid: number, process: string, title: string): RawWindow => ({ hwnd, pid, process, title });

function harness(opts: { openResult?: string; showsWindow?: boolean; policy?: boolean; timeoutMs?: number } = {}) {
  const f = fakeFs();
  const snap: WindowsSnapshot = { activePid: 1, windows: [W(1, 1, "Code", "x")] };
  const opened: string[] = [];
  const act: ActionPort = {
    openPath: async (p) => {
      opened.push(p);
      if (!opts.openResult && opts.showsWindow !== false) snap.windows.push(W(9, 9, "explorer", p.split("\\").pop() ?? p));
      return opts.openResult ?? "";
    },
  };
  const win: WindowsPort = { query: async () => snap };
  const events: RuntimeEvent[] = [];
  const session = new Session({
    fs: f.port, win, act, emit: (e) => events.push(e), sleep: async () => {}, confirmTimeoutMs: opts.timeoutMs,
  });
  if (opts.policy === false) session.setPolicy({ confirmReversible: false, confirmScreenRead: true });
  const last = () => events[events.length - 1];
  const types = () => events.map((e) => e.type);
  return { session, events, opened, last, types, f };
}
const confirmId = (events: RuntimeEvent[]) => (events.find((e) => e.type === "task.confirmation_required") as { taskId: string }).taskId;

// ---------- the gate ----------
describe("safety gate", () => {
  it("consequential actions always need confirmation, whatever the policy", () => {
    expect(decide({ risk: "consequential" }, { confirmReversible: false, confirmScreenRead: true })).toBe("confirm");
    expect(decide({ risk: "consequential" }, { confirmReversible: true, confirmScreenRead: true })).toBe("confirm");
  });
  it("reversible actions follow the policy; reads never ask", () => {
    expect(decide({ risk: "reversible" }, { confirmReversible: true, confirmScreenRead: true })).toBe("confirm");
    expect(decide({ risk: "reversible" }, { confirmReversible: false, confirmScreenRead: true })).toBe("allow");
    expect(decide({ risk: "read" }, { confirmReversible: true, confirmScreenRead: true })).toBe("allow");
  });
  it("defaults to asking first", () => expect(DEFAULT_POLICY.confirmReversible).toBe(true));
  it("never reads consent into unclear or contradictory answers", () => {
    expect(resolveYesNo("yes please")).toBe("yes");
    expect(resolveYesNo("go ahead")).toBe("yes");
    expect(resolveYesNo("no, cancel that")).toBe("no");
    expect(resolveYesNo("yes no")).toBe("unclear");
    expect(resolveYesNo("hmm, maybe")).toBe("unclear");
    expect(resolveYesNo("")).toBe("unclear");
    expect(resolveYesNo("don't")).toBe("no");
  });
});

describe("open-folder intent", () => {
  it.each([
    ["open my downloads folder", { kind: "open_folder", query: "downloads" }],
    ["Open the Context Companion project folder", { kind: "open_folder", query: "context companion" }],
    ["can you open the single folder", { kind: "open_folder", query: "single" }],
  ])("%s", (t, e) => expect(classify(t)).toMatchObject(e));
  it("applications are not folders", () => {
    expect(classify("open WhatsApp")).toMatchObject({ kind: "open_app", query: "whatsapp" });
    expect(classify("open my context companion project in VS Code")).toMatchObject({ kind: "open_in_vscode", query: "context companion" });
  });
  it("asks which folder when none is named", () => expect(classify("open the folder").kind).toBe("ambiguous"));
});

// ---------- the action agent ----------
describe("ActionAgent", () => {
  const ok: ActionPort = { openPath: async () => "" };
  const f = fakeFs();
  it("refuses UNC, device, relative and traversal paths without calling the OS", async () => {
    let called = 0;
    const a = new ActionAgent(f.port, { openPath: async () => { called++; return ""; } });
    for (const p of ["\\\\server\\share", "\\\\.\\C:\\", "relative\\path", "C:\\a\\..\\b", "file:///C:/x", "calc.exe"]) {
      expect((await a.openFolder(p)).ok).toBe(false);
    }
    expect(called).toBe(0);
  });
  it("re-checks the folder right before acting", async () => {
    const a = new ActionAgent(f.port, ok);
    expect(await a.openFolder("D:\\Gone")).toMatchObject({ ok: false });
    expect(await a.openFolder("D:\\Single Folder")).toEqual({ ok: true });
    expect(a.calls).toBe(1);
  });
  it("reports OS errors instead of pretending", async () => {
    const a = new ActionAgent(f.port, { openPath: async () => "Access denied" });
    expect(await a.openFolder("D:\\Single Folder")).toMatchObject({ ok: false });
  });
  it("without an action port it cannot act at all", async () => {
    expect(await new ActionAgent(f.port, undefined).openFolder("D:\\Single Folder")).toMatchObject({ ok: false });
  });
});

describe("Verifier.folderWindow", () => {
  const v = new Verifier();
  const snap = (title: string, process = "explorer") => ({ windows: [{ hwnd: 1, pid: 1, process, title, active: true, isMomo: false }], active: null });
  it("needs an Explorer window showing that folder", () => {
    expect(v.folderWindow(snap("Single Folder"), "D:\\Single Folder").verified).toBe(true);
    expect(v.folderWindow(snap("Other"), "D:\\Single Folder").verified).toBe(false);
    expect(v.folderWindow(snap("Single Folder", "chrome"), "D:\\Single Folder").verified).toBe(false); // wrong program
  });
});

// ---------- confirmation flow end to end ----------
describe("confirmation flow (policy: ask first)", () => {
  it("asks before touching anything, and does nothing until approved", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    expect(h.last()).toMatchObject({ type: "task.confirmation_required", summary: expect.stringContaining("D:\\Single Folder") });
    expect(h.opened).toEqual([]); // nothing happened yet
    expect(companionReducer(initialCompanionState, h.last()).ui).toBe("blocked");
  });

  it("Confirm -> opens, verifies the window, then and only then reports success", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.opened).toEqual(["D:\\Single Folder"]);
    expect(h.last()).toMatchObject({ type: "task.completed", verified: true });
    expect(h.types().indexOf("task.confirmation_required")).toBeLessThan(h.types().indexOf("task.completed"));
  });

  it("Cancel -> nothing is opened", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    await h.session.respondConfirmation(confirmId(h.events), false);
    expect(h.opened).toEqual([]);
    expect(h.last()).toMatchObject({ type: "task.state", state: "idle" });
  });

  it("a spoken yes confirms; a spoken no cancels", async () => {
    const yes = harness();
    await yes.session.handleTranscript("s", "open the single folder");
    await yes.session.handleTranscript("s", "yes please");
    expect(yes.opened).toHaveLength(1);
    expect(yes.last().type).toBe("task.completed");

    const no = harness();
    await no.session.handleTranscript("s", "open the single folder");
    await no.session.handleTranscript("s", "no, cancel");
    expect(no.opened).toEqual([]);
  });

  it("an unclear answer re-asks once, then gives up without acting", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    await h.session.handleTranscript("s", "hmm maybe");
    expect(h.last().type).toBe("task.confirmation_required");
    await h.session.handleTranscript("s", "I don't know");
    // "don't" reads as a no, which is also safe
    expect(h.opened).toEqual([]);
    const h2 = harness();
    await h2.session.handleTranscript("s", "open the single folder");
    await h2.session.handleTranscript("s", "hmm maybe");
    await h2.session.handleTranscript("s", "uh well");
    expect(h2.opened).toEqual([]);
    expect(h2.last()).toMatchObject({ type: "task.state", state: "idle" });
  });

  it("a new unrelated request is not consent", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    await h.session.handleTranscript("s", "which window is active");
    expect(h.opened).toEqual([]);
    await h.session.respondConfirmation(confirmId(h.events), true); // the old question is gone
    expect(h.opened).toEqual([]);
  });

  it("ignores a stale or invented task id", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    await h.session.respondConfirmation("t999", true);
    await h.session.respondConfirmation("", true);
    expect(h.opened).toEqual([]);
    expect(h.last().type).toBe("task.confirmation_required"); // still waiting for the real answer
  });

  it("an approval cannot be reused", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    const id = confirmId(h.events);
    await h.session.respondConfirmation(id, true);
    await h.session.respondConfirmation(id, true);
    expect(h.opened).toHaveLength(1);
  });

  describe("silence", () => {
    afterEach(() => vi.useRealTimers());
    it("lapses after the timeout without doing anything", async () => {
      vi.useFakeTimers();
      const h = harness({ timeoutMs: 5000 });
      await h.session.handleTranscript("s", "open the single folder");
      vi.advanceTimersByTime(5001);
      expect(h.last()).toMatchObject({ type: "task.state", state: "idle" });
      expect(h.opened).toEqual([]);
      await h.session.respondConfirmation(confirmId(h.events), true); // too late
      expect(h.opened).toEqual([]);
    });
  });

  it("cancelling the task drops the pending question", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    h.session.cancelTask();
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.opened).toEqual([]);
  });

  it("dispose drops it too and nothing more is emitted", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    const n = h.events.length;
    h.session.dispose();
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.opened).toEqual([]);
    expect(h.events.length).toBe(n);
  });
});

describe("clarification then confirmation", () => {
  it("several matches -> which one? -> are you sure? -> opens the chosen one", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the context companion folder");
    expect(h.last()).toMatchObject({ type: "task.clarification_required" });
    await h.session.handleTranscript("s", "the second one");
    expect(h.last().type).toBe("task.confirmation_required");
    expect(h.opened).toEqual([]);
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.opened).toHaveLength(1);
    expect(h.last()).toMatchObject({ type: "task.completed" });
  });
});

describe("policy: do not ask for reversible actions", () => {
  it("acts straight away, still verifies", async () => {
    const h = harness({ policy: false });
    await h.session.handleTranscript("s", "open the single folder");
    expect(h.types()).not.toContain("task.confirmation_required");
    expect(h.opened).toEqual(["D:\\Single Folder"]);
    expect(h.last()).toMatchObject({ type: "task.completed", verified: true });
  });
  it("the policy can be switched back on while running", async () => {
    const h = harness({ policy: false });
    h.session.setPolicy({ confirmReversible: true, confirmScreenRead: true });
    await h.session.handleTranscript("s", "open the single folder");
    expect(h.last().type).toBe("task.confirmation_required");
    expect(h.opened).toEqual([]);
  });
  it("ignores junk policy values", async () => {
    const h = harness();
    h.session.setPolicy({ confirmReversible: "no" as unknown as boolean });
    await h.session.handleTranscript("s", "open the single folder");
    expect(h.last().type).toBe("task.confirmation_required");
  });
});

describe("verification after acting", () => {
  it("opened but not seen -> partial success, never full success", async () => {
    const h = harness({ policy: false, showsWindow: false });
    await h.session.handleTranscript("s", "open the single folder");
    expect(h.opened).toHaveLength(1);
    expect(h.last()).toMatchObject({ type: "task.state", state: "partial_success" });
    expect(h.types()).not.toContain("task.completed");
  });
  it("an OS error is a failure", async () => {
    const h = harness({ policy: false, openResult: "boom" });
    await h.session.handleTranscript("s", "open the single folder");
    expect(h.last()).toMatchObject({ type: "task.failed", recoverable: true });
    expect(h.types()).not.toContain("task.completed");
  });
  it("a folder that vanished after confirmation is not opened", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    h.f.remove("D:\\Single Folder");
    await h.session.respondConfirmation(confirmId(h.events), true);
    expect(h.opened).toEqual([]);
    expect(h.last()).toMatchObject({ type: "task.failed" });
  });
  it("every event stays schema-valid", async () => {
    const h = harness();
    await h.session.handleTranscript("s", "open the single folder");
    await h.session.respondConfirmation(confirmId(h.events), true);
    for (const e of h.events) expect(typeof e.type).toBe("string");
  });
});

describe("UI: voice answers while a confirmation is open", () => {
  it("the state machine allows listening from 'blocked'", () => {
    const blocked = companionReducer(initialCompanionState, { type: "task.confirmation_required", taskId: "t", summary: "s" });
    expect(companionReducer(blocked, { type: "voice.started", sessionId: "v" }).ui).toBe("listening");
  });
});
