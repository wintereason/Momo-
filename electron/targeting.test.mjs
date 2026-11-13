import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { createTargeting } = createRequire(import.meta.url)("./targeting.cjs");

const field = (name, over = {}) => ({ rid: "1." + name, name, type: "Edit", editable: true, password: false, rect: { l: 0, t: 0, w: 100, h: 20 }, ...over });
const win = { l: 0, t: 0, w: 800, h: 600 };

function make({ scan, focusedSeq = [], focusOk = true, before = "Hello", after = "Hello world", fg = [{ hwnd: 7 }] } = {}) {
  const log = [];
  let fgi = 0, fi = 0;
  const uia = {
    scanTargets: async (h) => { log.push("scan:" + h); return scan; },
    focusedField: async () => { log.push("focused?"); return focusedSeq[Math.min(fi++, focusedSeq.length - 1)] ?? null; },
    focusField: async (h, rid) => { log.push("focus:" + rid); return focusOk ? { ok: true, before, collapsedSelection: false } : { ok: false, reason: "focus_failed" }; },
    readBack: async () => { log.push("readback"); return after; },
    planTarget: (s) => (s && s.plan) || { kind: "click" },
    verifyInsertion: (b, a, t) => (a === null ? "unreadable" : a === b + t ? "confirmed" : "failed"),
    describeField: () => "near the top",
  };
  const inserter = {
    insert: async (text, o) => {
      log.push("insert:" + text);
      const g = await o.beforePaste();
      if (g.ok === false) return { ok: false, reason: "target_lost", copied: true, detail: g.reason };
      log.push("paste");
      return { ok: true, verification: await o.afterPaste() };
    },
  };
  let n = 0;
  const t = createTargeting({ uia, foreground: () => fg[Math.min(fgi++, fg.length - 1)], inserter, sleep: async () => {}, now: () => (n += 10) });
  return { t, log };
}

describe("dictation targeting", () => {
  it("one suitable field: focuses it, pastes, and verifies", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "ready", hwnd: 7, field: field("Search") } }, before: "Hello", after: "Hello world" });
    m.t.begin();
    const r = await m.t.deliver(" world");
    expect(r).toMatchObject({ kind: "inserted", verification: "confirmed", field: "Search" });
    // focus is proven BEFORE the paste, and the read-back comes after it
    expect(m.log.indexOf("focus:1.Search")).toBeLessThan(m.log.indexOf("paste"));
    expect(m.log.indexOf("paste")).toBeLessThan(m.log.indexOf("readback"));
  });
  it("never pastes when the field cannot be focused", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "ready", hwnd: 7, field: field("a") } }, focusOk: false });
    m.t.begin();
    expect(await m.t.deliver("x")).toMatchObject({ kind: "blocked", reason: "target_lost", copied: true });
    expect(m.log).not.toContain("paste");
  });
  it("reports a paste that did not arrive as failed, not as success", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "ready", hwnd: 7, field: field("a") } }, before: "Hello", after: "Hello" });
    m.t.begin();
    expect(await m.t.deliver(" world")).toMatchObject({ kind: "inserted", verification: "failed" });
  });
  it("a password field blocks without touching anything", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "password" } } });
    m.t.begin();
    expect(await m.t.deliver("x")).toMatchObject({ kind: "blocked", reason: "password" });
    expect(m.log.some((l) => l.startsWith("insert") || l === "paste")).toBe(false);
  });
  it("several fields: asks, writes nothing, then writes into the chosen one only", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "choose", hwnd: 7, fields: [field("To"), field("Subject"), field("Body")] } }, before: "", after: "Hi" });
    m.t.begin();
    const q = await m.t.deliver("Hi");
    expect(q.kind).toBe("choose");
    expect(q.options.map((o) => o.label)).toEqual(["To", "Subject", "Body"]);
    expect(m.log.some((l) => l.startsWith("insert"))).toBe(false);
    expect(await m.t.pick(1)).toMatchObject({ kind: "inserted", verification: "confirmed", field: "Subject" });
    expect(m.log).toContain("focus:1.Subject");
    expect(await m.t.pick(1)).toMatchObject({ kind: "blocked", reason: "expired" }); // the text is gone after use
  });
  it("an invalid choice writes nothing", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "choose", hwnd: 7, fields: [field("a"), field("b")] } } });
    m.t.begin();
    await m.t.deliver("Hi");
    expect(await m.t.pick(9)).toMatchObject({ kind: "blocked", reason: "expired" });
    expect(m.log.some((l) => l.startsWith("insert"))).toBe(false);
  });
  it("no field: asks for a click, then writes into the field the user clicked", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "click" } }, focusedSeq: [null, { hwnd: 7, field: field("Notes") }], before: "", after: "Hi" });
    m.t.begin();
    expect(await m.t.deliver("Hi")).toEqual({ kind: "click" });
    expect(await m.t.waitForClick()).toMatchObject({ kind: "inserted", field: "Notes" });
  });
  it("while waiting for a click, a clicked password box is refused", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "click" } }, focusedSeq: [{ hwnd: 7, field: field("pw", { password: true, editable: false }) }] });
    m.t.begin();
    await m.t.deliver("Hi");
    expect(await m.t.waitForClick()).toMatchObject({ kind: "blocked", reason: "password" });
    expect(m.log).not.toContain("paste");
  });
  it("gives up waiting for a click and hands the text back to be copied", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "click" } }, focusedSeq: [null] });
    m.t.begin();
    await m.t.deliver("Hi");
    expect(await m.t.waitForClick()).toMatchObject({ kind: "blocked", reason: "no_field", text: "Hi" });
  });
  it("cancel drops the held text", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "choose", hwnd: 7, fields: [field("a"), field("b")] } } });
    m.t.begin();
    await m.t.deliver("secret words");
    m.t.cancel();
    expect(m.t.hasPending()).toBe(false);
    expect(await m.t.pick(0)).toMatchObject({ kind: "blocked", reason: "expired" });
  });
  it("re-detects when the user switched windows while speaking", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "ready", hwnd: 9, field: field("a") } }, fg: [{ hwnd: 7 }, { hwnd: 9 }] });
    m.t.begin();
    await m.t.deliver("x");
    expect(m.log.filter((l) => l.startsWith("scan:"))).toEqual(["scan:7", "scan:9"]);
  });
  it("an unreadable field is pasted into but never called confirmed", async () => {
    const m = make({ scan: { ok: true, win, plan: { kind: "ready", hwnd: 7, field: field("a") } }, before: null });
    m.t.begin();
    expect(await m.t.deliver("x")).toMatchObject({ kind: "inserted", verification: "unreadable" });
  });
});
