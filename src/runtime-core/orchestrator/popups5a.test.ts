import { describe, expect, it } from "vitest";
import { HELPER_SCRIPT } from "../shared/uiaHelper";
import { call, finish, me, popupWorld, runPopup, stepsOf, tw, un } from "./popupWorld";

/** Phase 5a: finding menus, dialogs, dropdowns and popups the normal window list cannot see, and telling the planner what is open. Read-only. */
const go = async (w: ReturnType<typeof popupWorld>, args: Record<string, unknown> = {}) => {
  const r = runPopup(w, [call("look_popups", args), finish()]);
  await r.session.handleTranscript("s", "look");
  return { ...r, step: stepsOf(r.results)[0] };
};

describe("look_popups", () => {
  it("nothing open: says so", async () => {
    const { step } = await go(popupWorld({ popups: () => [] }));
    expect(step.outcome).toBe("ok");
    expect(step.text).toMatch(/No menu, dialog or other pop-up is open/);
  });
  it("finds a context menu, a drop-down list, a dialog and a toast, and says what each offers", async () => {
    const w = popupWorld({
      popups: () => [
        { win: tw(101, "menu", { fg: true }), menu: [me("Open"), me("More", { expandable: true }), me("Sub", { depth: 1, parent: 1 })] },
        { win: tw(102, "dropdown", { cls: "ComboLBox", owner: 0, rootOwner: 0 }), ui: [un("ListItem", "alpha"), un("ListItem", "beta")] },
        { win: tw(103, "dialog"), ui: [un("Button", "Yes"), un("Button", "No"), un("Text", "Replace the file?")] },
        { win: tw(104, "window"), ui: [un("Text", "Saved"), un("Button", "Dismiss")] },
      ],
    });
    const { step } = await go(w);
    expect(step.outcome).toBe("ok");
    expect(step.text).toMatch(/4 pop-ups open/);
    expect(step.text).toMatch(/menu with 2 items: Open, More/);
    expect(step.text).toMatch(/\(in front\)/);
    expect(step.text).toMatch(/drop-down list with 2 choices: alpha, beta/);
    expect(step.text).toMatch(/dialog with buttons “Yes”, “No” and 1 line of text/);
  });
  it("it never acts: no click, key, focus change or invoke", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(101, "menu"), menu: [me("Delete")] }] });
    await go(w);
    expect(w.log.act).toEqual([]);
    expect(w.log.clicks).toEqual([]);
    expect(w.log.presses).toEqual([]);
  });
  it("a secure-desktop or credential prompt is reported, never read", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(201, "secure", { proc: "consent", cls: "Credential Dialog Xaml Host" }), ui: [un("Button", "Yes"), un("Text", "Do you want to allow this app to make changes?")] }, { win: tw(202, "dialog"), ui: [un("Edit", "Password", { password: true }), un("Button", "OK")] }] });
    const { step } = await go(w);
    expect(step.text).toMatch(/secure prompt \(consent\): I never read or answer these/);
    expect(step.text).toMatch(/credential prompt: I never read or answer these/);
    expect(step.text).not.toMatch(/make changes|Password/);
    expect(w.log.uiReads).toBe(1); // the secure one was not even read; only the dialog that had to be classified
  });
  it("an unknown popup is listed and never used; a menu that cannot be read is reported as such", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(301, "other") }, { win: tw(302, "popup") }] });
    const { step } = await go(w);
    expect(step.text).toMatch(/unknown popup: listed only, never used/);
    expect(step.text).toMatch(/cannot read \(it may be drawn by the application itself\)/);
  });
  it("only the popups of the named window are listed", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(401, "menu", { rootOwner: 20, owner: 20 }), menu: [me("A")] }, { win: tw(402, "menu", { rootOwner: 77, owner: 77 }), menu: [me("B")] }] });
    const { step } = await go(w, { window: "Documents" });
    expect(step.text).toMatch(/1 pop-up open/);
    expect(step.text).toMatch(/: A/);
  });
  it("without the helper it says so plainly (and nothing was sent)", async () => {
    const w = popupWorld({ popups: () => [] });
    (w.deps.screen as { transients?: unknown }).transients = async () => ({ ok: false, reason: "helper unavailable" });
    const { step } = await go(w);
    expect(step.outcome).toBe("failed");
    expect(step.failure).toMatchObject({ acted: "no" });
  });
  it("is a sensitive read: item names and dialog text are screen content", async () => {
    const { buildTools } = await import("./tools");
    const t = buildTools().find((x) => x.name === "look_popups")!;
    expect(t.sensitive).toBe(true);
    expect(t.risk({})).toBe("sensitive_read");
  });
  it("the journal keeps no menu item, button or text from what it saw", async () => {
    const w = popupWorld({ popups: () => [{ win: tw(101, "menu"), menu: [me("TopSecretItem")] }, { win: tw(103, "dialog"), ui: [un("Button", "TopSecretButton")] }] });
    const r = await go(w);
    expect(JSON.stringify(r.session.orchestrator.journal())).not.toMatch(/TopSecret/);
  });
});

describe("the helper commands for pop-ups (source checks; the real script is compiled in uiaHelper.test)", () => {
  const slice = (from: string, to: string) => HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf(from), HELPER_SCRIPT.indexOf(to));
  it("transients lists facts only: it never appends a window title or any text", () => {
    const t = slice("public static string Transients", "public static string Menu");
    expect(t).toContain("GetWindowText(h, t, 8)"); // only to know whether there IS a title (8 chars), never kept
    expect(t).not.toMatch(/Q\(sb, t\.ToString\(\)\)|\.Append\(t\)|GetWindowText\(h, [a-z]+, (?:128|256|512)/);
    expect(t).not.toMatch(/WebClient|System\.Net|File\.|AutomationElement/);
  });
  it("transients knows the secure-desktop processes", () => {
    for (const p of ["consent", "credentialuibroker", "logonui"]) expect(HELPER_SCRIPT).toContain(p);
  });
  it("the commands exist and only read", () => {
    for (const c of ["'transients'", "'menu'"]) expect(HELPER_SCRIPT).toContain(c);
    const t = slice("public static string Transients", "public static string Windows");
    expect(t).not.toMatch(/PostMessage|SendMessage|SendInput|SetForeground|ShowWindow|InvokePattern|\.Invoke\(|SetValue|\.Expand\(|\.Collapse\(/);
  });
  it("the at command now also says which top-level window the point is in", () => {
    expect(HELPER_SCRIPT).toContain('\\"w\\"');
  });
});
