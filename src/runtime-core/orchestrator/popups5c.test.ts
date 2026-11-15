import { describe, expect, it } from "vitest";
import type { UiNode } from "../shared/ports";
import { buildTools } from "./tools";
import { call, finish, popupWorld, runPopup, stepsOf, tw, un, type Popup } from "./popupWorld";

/**
 * Phase 5c: reading dialogs, answering them safely, and file dialogs. Secure-desktop, credential and password prompts are refused; backing out
 * needs no approval and everything else asks; nothing is clicked on a stale picture; the path of a file is never kept anywhere.
 */
const btn = (name: string, i: number, over: Partial<UiNode> = {}): UiNode => un("Button", name, { rect: { l: 200 + i * 100, t: 400, w: 80, h: 28 }, ...over });
const hitBtn = (ui: UiNode[], x: number, y: number) => ui.find((n) => n.type === "Button" && n.rect && x >= n.rect.l && x <= n.rect.l + n.rect.w && y >= n.rect.t && y <= n.rect.t + n.rect.h);
const chainOf = (ui: () => UiNode[]) => (x: number, y: number) => { const b = hitBtn(ui(), x, y); return b ? [{ rid: b.rid ?? "", type: "Button", name: b.name, password: false }] : null; };
const DLG = 301;
const CANARY_PATH = "C:\\Users\\bob\\Private\\TaxReturn-2025.xlsx";

function messageBox() {
  let ui: UiNode[] = [btn("Yes", 0), btn("No", 1), un("Text", "Replace the file?")];
  let open = true;
  const w = popupWorld({
    popups: () => (open ? [{ win: tw(DLG, "dialog", { fg: true }), ui }] : []),
    chainAt: chainOf(() => ui), windowAt: (x, y) => (hitBtn(ui, x, y) ? DLG : 20),
    onClick: (x, y) => { if (hitBtn(ui, x, y)) open = false; },
  });
  return { w, setUi: (u: UiNode[]) => { ui = u; }, isOpen: () => open };
}
const go = async (w: ReturnType<typeof popupWorld>, tool: string, args: Record<string, unknown>) => {
  const r = runPopup(w, [call(tool, args), finish()]);
  await r.session.handleTranscript("s", "x");
  return { ...r, step: stepsOf(r.results)[0] };
};

describe("read_dialog", () => {
  it("a confirmation box: what it says, its buttons, and which of them ask the user first", async () => {
    const { w } = messageBox();
    const { step } = await go(w, "read_dialog", {});
    expect(step.outcome).toBe("ok");
    expect(step.text).toContain("“Replace the file?”");
    expect(step.text).toMatch(/Yes \(asks you first\)/);
    expect(step.text).toMatch(/No(?! \(asks)/);
    expect(w.log.clicks).toEqual([]);
  });
  it("a file dialog is recognised, and the file name FIELD'S VALUE is never read out", async () => {
    const ui = [un("ComboBox", "File name:", { value: CANARY_PATH }), btn("Open", 0), btn("Cancel", 1)];
    const w = popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui }] });
    const { step, session } = await go(w, "read_dialog", {});
    expect(step.text).toMatch(/file dialog/);
    expect(step.text).toMatch(/“File name” field \(its value is never read\)/);
    expect(JSON.stringify([step, session.orchestrator.journal()])).not.toContain("TaxReturn");
  });
  it("secure and credential prompts are never read: not their text, not their buttons", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(401, "secure", { proc: "consent" }), ui: [btn("Yes", 0), un("Text", "SECRET-ADMIN-TEXT")] }, { win: tw(402, "dialog"), ui: [un("Edit", "Password", { password: true }), un("Text", "SECRET-CRED-TEXT"), btn("OK", 0)] }] });
    const { step } = await go(w, "read_dialog", {});
    expect(step.outcome).toBe("failed");
    expect(step.failure).toMatchObject({ kind: "blocked_by_policy", acted: "no" });
    expect(step.text).not.toMatch(/SECRET/);
  });
  it("no dialog open: not found", async () => {
    const { step } = await go(popupWorld({ popups: () => [] }), "read_dialog", {});
    expect(step.failure).toMatchObject({ kind: "target_not_found", acted: "no" });
  });
});

describe("answer_dialog: approval", () => {
  it("backing out is free; everything else is consequential", () => {
    const t = buildTools().find((x) => x.name === "answer_dialog")!;
    for (const b of ["Cancel", "No", "Close", "Not now"]) expect(t.risk({ button: b }), b).toBe("reversible");
    for (const b of ["OK", "Yes", "Open", "Save", "Replace", "Delete", "Allow", "Continue", "Don't Save", "Whatever"]) expect(t.risk({ button: b }), b).toBe("consequential");
  });
  it("Cancel is answered without asking: one click, on the exact button, with the dialog and its owner as the allowed windows; the dialog closing is the evidence", async () => {
    const { w } = messageBox();
    const { step } = await go(w, "answer_dialog", { button: "No" });
    expect(w.log.clicks.length).toBe(1);
    expect(hitBtn([btn("Yes", 0), btn("No", 1)], w.log.clicks[0].x, w.log.clicks[0].y)?.name).toBe("No");
    expect((w.log.clicks[0].opts.expectRoot as number[]).includes(DLG) && (w.log.clicks[0].opts.expectRoot as number[]).includes(20)).toBe(true);
    expect(step).toMatchObject({ outcome: "ok", acted: "yes" });
    expect(step.text).toMatch(/the dialog closed/);
  });
  it("Yes is NOT clicked until the user approves, and exactly once after", async () => {
    const { w, isOpen } = messageBox();
    const r = runPopup(w, [call("answer_dialog", { button: "Yes" }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks).toEqual([]);
    expect(isOpen()).toBe(true);
    const ask = r.events.filter((e) => e.type === "task.confirmation_required").pop() as { taskId: string };
    expect(ask).toBeTruthy();
    await r.session.respondConfirmation(ask.taskId, true);
    expect(w.log.clicks.length).toBe(1);
    expect(isOpen()).toBe(false);
  });
  it("...and a refusal of the approval clicks nothing", async () => {
    const { w, isOpen } = messageBox();
    const r = runPopup(w, [call("answer_dialog", { button: "Yes" }), finish()]);
    await r.session.handleTranscript("s", "x");
    const ask = r.events.filter((e) => e.type === "task.confirmation_required").pop() as { taskId: string };
    await r.session.respondConfirmation(ask.taskId, false);
    expect(w.log.clicks).toEqual([]);
    expect(isOpen()).toBe(true);
  });
});

describe("answer_dialog: what is refused", () => {
  it("a secure-desktop prompt: refused, nothing sent, never read", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(401, "secure", { proc: "consent" }), ui: [btn("Yes", 0)] }] });
    const { step } = await go(w, "answer_dialog", { button: "Cancel" });
    expect(w.log.clicks).toEqual([]);
    expect(step.failure).toMatchObject({ kind: "blocked_by_policy", acted: "no" });
    expect(w.log.uiReads).toBe(0);
  });
  it("a credential prompt (password field): refused", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(402, "dialog"), ui: [un("Edit", "Password", { password: true }), btn("Cancel", 0)] }] });
    const { step } = await go(w, "answer_dialog", { button: "Cancel" });
    expect(w.log.clicks).toEqual([]);
    expect(step.failure).toMatchObject({ kind: "blocked_by_policy" });
  });
  it("a dialog that BECOMES a credential prompt between the first read and the click: no click", async () => {
    let reads = 0;
    const base: UiNode[] = [btn("Cancel", 0), btn("OK", 1)];
    const w = popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui: base }], chainAt: chainOf(() => base), windowAt: () => DLG });
    const orig = w.deps.screen.readUi;
    w.deps.screen.readUi = async (h) => { const r = await orig(h); reads++; if (reads >= 2 && r.ok) r.items.push(un("Edit", "PIN", { password: true })); return r; };
    const { step } = await go(w, "answer_dialog", { button: "Cancel" });
    expect(w.log.clicks).toEqual([]);
    expect(step.failure).toMatchObject({ kind: "blocked_by_policy", acted: "no" });
  });
  it("a button that is not there, a twin, a disabled one: never guessed", async () => {
    for (const [ui, button, kind] of [
      [[btn("Yes", 0), btn("No", 1)], "Back", "target_not_found"],
      [[btn("Cancel", 0), btn("Cancel", 1)], "Cancel", "ambiguous"],
      [[btn("Cancel", 0, { enabled: false }), btn("OK", 1)], "Cancel", "target_disabled"],
    ] as const) {
      const w = popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui: [...ui] }], chainAt: chainOf(() => [...ui]), windowAt: () => DLG });
      const { step } = await go(w, "answer_dialog", { button });
      expect(w.log.clicks, `${button}/${kind}`).toEqual([]);
      expect(step.failure, `${button}/${kind}`).toMatchObject({ kind, acted: "no" });
    }
  });
  it("two dialogs with the button: the user is asked which; nothing is clicked", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(501, "dialog"), ui: [btn("Cancel", 0)] }, { win: tw(502, "dialog"), ui: [btn("Cancel", 0)] }] });
    const r = runPopup(w, [call("answer_dialog", { button: "Cancel" }), finish()]);
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks).toEqual([]);
    expect(r.events.some((e) => e.type === "task.clarification_required")).toBe(true);
  });
  it("an unknown popup, a toast or a menu is never answered as a dialog", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(601, "other"), ui: [btn("Cancel", 0)] }, { win: tw(602, "window"), ui: [btn("Cancel", 0)] }, { win: tw(603, "popup"), ui: [btn("Cancel", 1)] }] });
    const { step } = await go(w, "answer_dialog", { button: "Cancel" });
    expect(w.log.clicks).toEqual([]);
    expect(step.failure).toMatchObject({ kind: "target_not_found", acted: "no" });
  });
  it("Show Only: the button is invoked by id, never by position", async () => {
    let open = true;
    const ui = [btn("Cancel", 0), btn("OK", 1)];
    const w = popupWorld({ pointer: false, popups: () => (open ? [{ win: tw(DLG, "dialog"), ui }] : []), invoke: () => { open = false; return { ok: true }; } });
    const { step } = await go(w, "answer_dialog", { button: "Cancel" });
    expect(w.log.act).toEqual(["invoke:Button:Cancel"]);
    expect(w.log.clicks).toEqual([]);
    expect(step.outcome).toBe("ok");
  });
});

describe("zero wrong clicks when the dialog changes under it (100 injected-change trials)", () => {
  it("renamed, reordered, vanished, replaced by a secure prompt, buttons swapped, and changes between the last read and the click", async () => {
    let wrong = 0, right = 0, refused = 0;
    const kinds = ["none", "reorder", "rename", "vanish", "secure", "swap", "race-reorder", "race-rename", "race-vanish", "race-secure"] as const;
    for (let trial = 0; trial < 100; trial++) {
      const kind = kinds[trial % kinds.length];
      let ui: UiNode[] = [btn("OK", 0), btn("Cancel", 1)];
      let open = true, secure = false;
      const mutate = () => {
        if (kind.endsWith("reorder")) ui = [btn("Cancel", 0), btn("OK", 1)];
        else if (kind.endsWith("rename")) ui = [btn("OK", 0), btn("Delete all", 1)];
        else if (kind.endsWith("vanish")) open = false;
        else if (kind.endsWith("secure")) secure = true;
        else if (kind === "swap") ui = [btn("Cancel", 0, { rid: "Button:OK" }), btn("OK", 1, { rid: "Button:Cancel" })];
      };
      const w = popupWorld({
        popups: () => (!open ? [] : secure ? [{ win: tw(DLG, "secure", { proc: "consent" }), ui }] : [{ win: tw(DLG, "dialog"), ui }]),
        chainAt: (x, y) => (open ? chainOf(() => ui)(x, y) : null), windowAt: (x, y) => (open && hitBtn(ui, x, y) ? DLG : 20),
        onClick: (x, y) => { const b = hitBtn(ui, x, y); if (secure || !open || !b || b.name !== "Cancel") wrong++; else right++; open = false; },
      });
      if (!kind.startsWith("race")) mutate();
      let reads = 0;
      const orig = w.deps.screen.readUi;
      w.deps.screen.readUi = async (h) => { const r = await orig(h); reads++; if (kind.startsWith("race") && reads === 2) mutate(); return r; };
      const r = runPopup(w, [call("answer_dialog", { button: "Cancel" }), finish()]);
      await r.session.handleTranscript("s", "x");
      if (w.log.clicks.length === 0) refused++;
    }
    expect(wrong).toBe(0);
    expect(right).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(right + refused).toBe(100);
  });
});

describe("choose_file", () => {
  const fileDialog = (opts: { fieldRid?: string } = {}) => {
    const ui: UiNode[] = [un("Edit", "File name:", { rid: opts.fieldRid ?? "Edit:name", value: "" }), btn("Open", 0), btn("Cancel", 1)];
    return popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui }], setText: (_rid, text) => ({ ok: true, readBack: text }), chainAt: () => [{ rid: opts.fieldRid ?? "Edit:name", type: "Edit", name: "File name:", password: false }] });
  };
  it("clicks INTO the File name field, selects, types the name and reads it back; it does NOT press Open", async () => {
    const w = fileDialog();
    const { step, session } = await go(w, "choose_file", { path: CANARY_PATH });
    expect(w.log.clicks.length).toBe(1);                 // one click: into the field (never on Open)
    expect(w.log.clicks[0].x).toBeGreaterThan(119); expect(w.log.clicks[0].x).toBeLessThan(201); // inside the Edit's box
    expect(w.log.presses).toEqual(["ctrl+a"]);           // select what is there; no Enter
    expect(w.log.texts).toEqual([CANARY_PATH]);
    expect(w.log.act).toEqual([]);
    expect(step).toMatchObject({ outcome: "ok" });
    // the path appears nowhere that Momo keeps or says: not in what the planner is told, not in the journal
    expect(step.text).not.toContain("TaxReturn");
    expect(JSON.stringify(session.orchestrator.journal())).not.toContain("TaxReturn");
    expect(JSON.stringify(session.orchestrator.journal())).not.toContain("bob");
  });
  it("a value that did not go in is NOT claimed", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui: [un("Edit", "File name:", { rid: "Edit:name" }), btn("Open", 0), btn("Cancel", 1)] }], chainAt: () => [{ rid: "Edit:name", type: "Edit", name: "File name:", password: false }], fieldValue: () => ({ ok: true, value: "something else" }) });
    const { step } = await go(w, "choose_file", { path: "a.txt" });
    expect(step.outcome).toBe("unverified");
  });
  it("Show Only (no real pointer): the field is set through UI Automation instead", async () => {
    const w = popupWorld({ pointer: false, popups: () => [{ win: tw(DLG, "dialog"), ui: [un("Edit", "File name:", { rid: "Edit:name" }), btn("Open", 0), btn("Cancel", 1)] }], setText: (_r, t) => ({ ok: true, readBack: t }) });
    const { step } = await go(w, "choose_file", { path: "a.txt" });
    expect(w.log.act).toEqual(["settext:Edit:name"]);
    expect(step.outcome).toBe("ok");
  });
  it("the pointer is not over the File name field any more: nothing is typed", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui: [un("Edit", "File name:", { rid: "Edit:name" }), btn("Open", 0), btn("Cancel", 1)] }], chainAt: () => [{ rid: "Other", type: "Button", name: "Open", password: false }] });
    const { step } = await go(w, "choose_file", { path: "a.txt" });
    expect(w.log.texts).toEqual([]);
    expect(w.log.clicks).toEqual([]);
    expect(step.failure?.acted).toBe("no");
  });
  it("invalid names are refused before anything is touched", async () => {
    for (const path of ["a|b.txt", "what?.txt", "x\u0001y", "<script>"]) {
      const w = fileDialog();
      const { step } = await go(w, "choose_file", { path });
      expect(w.log.act, path).toEqual([]);
      expect(step.failure, path).toMatchObject({ kind: "invalid_request", acted: "no" });
    }
  });
  it("a normal Windows path (drive colon, backslashes) is accepted", async () => {
    const w = fileDialog();
    await go(w, "choose_file", { path: "D:\\Projects\\notes.txt" });
    expect(w.log.texts).toEqual(["D:\\Projects\\notes.txt"]);
  });
  it("only a FILE dialog: a message box, a secure prompt, or nothing at all is refused", async () => {
    const mb = popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui: [btn("Yes", 0), btn("No", 1), un("Text", "Sure?")] }] });
    expect((await go(mb, "choose_file", { path: "a.txt" })).step.failure).toMatchObject({ kind: "target_not_found", acted: "no" });
    expect(mb.log.act).toEqual([]);
    const sec = popupWorld({ popups: () => [{ win: tw(DLG, "secure", { proc: "consent" }) }] });
    expect((await go(sec, "choose_file", { path: "a.txt" })).step.failure).toMatchObject({ kind: "blocked_by_policy", acted: "no" });
    const none = popupWorld({ popups: () => [] });
    expect((await go(none, "choose_file", { path: "a.txt" })).step.failure).toMatchObject({ kind: "target_not_found" });
  });
  it("the field changes between the reads: nothing is typed on the stale picture (Phase 4 then looks again ONCE, and types only into what it re-reads)", async () => {
    let reads = 0;
    const w = popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui: [un("Edit", "File name:", { rid: "Edit:a" }), btn("Open", 0), btn("Cancel", 1)] }], chainAt: () => [{ rid: "Edit:b", type: "Edit", name: "File name:", password: false }] });
    const orig = w.deps.screen.readUi;
    w.deps.screen.readUi = async (h) => { const r = await orig(h); reads++; if (reads >= 2 && r.ok) r.items = r.items.map((n) => (n.type === "Edit" ? { ...n, rid: "Edit:b" } : n)); return r; };
    const { step, session } = await go(w, "choose_file", { path: "a.txt" });
    const j = session.orchestrator.journal();
    expect(j[0]).toMatchObject({ attempt: 1, acted: "no", failure: "target_moved" }); // the first try typed nothing
    expect(j.length).toBe(2);                                                        // one bounded retry, on a fresh read
    expect(w.log.texts).toEqual(["a.txt"]);                                           // exactly one entry, into the field as it is NOW
    expect(step.outcome).toBe("ok");
  });
  it("is reversible (typing a name into a field), because committing it is the separate, approved, step", () => {
    expect(buildTools().find((t) => t.name === "choose_file")!.risk({ path: "a.txt" })).toBe("reversible");
  });
});

describe("recovery integration (phase 4)", () => {
  it("a click that was sent is never retried: the same answer is not clicked twice", async () => {
    const ui = [btn("Cancel", 0)];
    const w = popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui }], chainAt: chainOf(() => ui), windowAt: () => DLG }); // the dialog never closes
    const { step } = await go(w, "answer_dialog", { button: "Cancel" });
    expect(w.log.clicks.length).toBe(1);
    expect(step.outcome).toBe("unverified");
  });
  it("the confirm hook (read-only) takes the dialog closing as evidence", async () => {
    const t = buildTools().find((x) => x.name === "answer_dialog")!;
    expect(await t.confirm!({ button: "No" }, { hwnd: DLG, pid: 20 }, { popups: async () => [] } as never)).toEqual({ verified: true, evidence: [{ kind: "popup_closed", ok: true }] });
    expect((await t.confirm!({ button: "No" }, { hwnd: DLG, pid: 20 }, { popups: async () => [tw(DLG, "dialog")] } as never)).verified).toBeNull();
  });
  it("the journal records the dialog steps without any button name or text", async () => {
    const { w } = messageBox();
    const { session } = await go(w, "answer_dialog", { button: "No" });
    expect(JSON.stringify(session.orchestrator.journal())).not.toMatch(/Replace|Yes/);
  });
});

describe("cancellation", () => {
  it("cancelled while the dialog is being answered: nothing more happens and the pointer is told to stop", async () => {
    const ui = [btn("Cancel", 0)];
    let session: { orchestrator: { cancel(): void } } | null = null;
    const w = popupWorld({ popups: () => [{ win: tw(DLG, "dialog"), ui }], chainAt: chainOf(() => ui), windowAt: () => DLG, onClick: () => { session!.orchestrator.cancel(); } });
    const r = runPopup(w, [call("answer_dialog", { button: "Cancel" }), finish()]);
    session = r.session;
    await r.session.handleTranscript("s", "x");
    expect(w.log.clicks.length).toBe(1);
    expect(w.log.aborted).toContain("cancel");
    expect(r.events.some((e) => e.type === "task.completed")).toBe(false);
  });
});

void (undefined as unknown as Popup);
