import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ActionJournal, JOURNAL_MAX_ENTRIES, type EvidenceItem } from "./journal";
import { KIND_PHRASE, FAILURE_KINDS } from "./taxonomy";

const CANARIES = ["CANARY-typed-secret-9917", "My Private Folder", "C:\\Users\\bob\\Secret\\taxes.xlsx", "bob@example.com", "https://bank.example.org/login?id=4412", "Quarterly Report - Notepad"];

describe("the journal is bounded", () => {
  it("keeps at most 50 entries per task and drops the OLDEST first", () => {
    const j = new ActionJournal();
    for (let i = 1; i <= 120; i++) j.begin("click_control", { label: `item ${i}` });
    const e = j.entries();
    expect(JOURNAL_MAX_ENTRIES).toBe(50);
    expect(e.length).toBe(50);
    expect(j.size).toBe(50);
    expect(j.dropped).toBe(70);
    expect(e[0].seq).toBe(71);
    expect(e[49].seq).toBe(120);
  });
  it("a smaller limit can be asked for, a larger one cannot", () => {
    const small = new ActionJournal({ max: 5 });
    for (let i = 0; i < 9; i++) small.begin("t", {});
    expect(small.size).toBe(5);
    const big = new ActionJournal({ max: 5000 });
    for (let i = 0; i < 80; i++) big.begin("t", {});
    expect(big.size).toBe(50);
  });
  it("updating an entry that was already dropped does nothing (and does not throw)", () => {
    const j = new ActionJournal({ max: 2 });
    const first = j.begin("a", {});
    j.begin("b", {}); j.begin("c", {});
    expect(() => j.update(first, { phase: "verified", acted: "yes" })).not.toThrow();
    expect(j.entries().map((x) => x.tool)).toEqual(["b", "c"]);
  });
  it("the trail and the evidence per entry are capped too", () => {
    const j = new ActionJournal();
    const s = j.begin("t", {});
    for (const p of ["ran", "acted", "observing", "unconfirmed", "observing", "verified", "ran", "acted", "observing", "verified"] as const) j.update(s, { phase: p });
    for (let i = 0; i < 40; i++) j.update(s, { evidence: [{ kind: "windows_listed", ok: null, n: i }] });
    const e = j.entries()[0];
    expect(e.trail.length).toBeLessThanOrEqual(8);
    expect(e.evidence.length).toBeLessThanOrEqual(8);
  });
  it("clear() empties it", () => {
    const j = new ActionJournal(); j.begin("t", {}); j.clear();
    expect(j.size).toBe(0);
  });
});

describe("the journal holds no content", () => {
  it("typed text, labels, paths, addresses and window titles never appear anywhere in it", () => {
    const j = new ActionJournal();
    const s = j.begin("type_text", { label: CANARIES[1], text: CANARIES[0], window: CANARIES[5], path: CANARIES[2], url: CANARIES[4], _hwnd: 99 });
    j.update(s, { phase: "failed", acted: "maybe", failure: "input_failed" });
    const dump = JSON.stringify(j.entries());
    for (const c of CANARIES) expect(dump, c).not.toContain(c);
    for (const part of ["secret", "bob", "taxes", "bank", "Quarterly", "Private Folder"]) expect(dump.toLowerCase(), part).not.toContain(part.toLowerCase());
  });
  it("records only the NAMES of the arguments, and never the private (underscore) ones", () => {
    const j = new ActionJournal();
    j.begin("click_control", { label: "x", open: true, _hwnd: 5, _rid: "1.2.3" });
    expect(j.entries()[0].argKeys).toEqual(["label", "open"]);
  });
  it("equal calls give equal fingerprints, different calls differ", () => {
    const j = new ActionJournal();
    const a = j.fingerprint("click_control", { label: "Save", open: true });
    expect(j.fingerprint("click_control", { open: true, label: "Save" })).toBe(a); // key order does not matter
    expect(j.fingerprint("click_control", { label: "Save", open: false })).not.toBe(a);
    expect(j.fingerprint("click_control", { label: "Sav", open: true })).not.toBe(a);
    expect(j.fingerprint("type_text", { label: "Save", open: true })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
  it("a fingerprint means nothing outside its task: another task (another salt) gives another value for the same call", () => {
    const a = new ActionJournal().fingerprint("type_text", { text: "hello" });
    const b = new ActionJournal().fingerprint("type_text", { text: "hello" });
    expect(a).not.toBe(b);
    // and the typed value cannot be recovered by hashing guesses without that task's salt
    const guess = new ActionJournal({ salt: "guess" }).fingerprint("type_text", { text: "hello" });
    expect(guess).not.toBe(a);
  });
  it("the 'reason' is a fixed phrase for the failure kind: there is no way to put the tool's own sentence in", () => {
    const j = new ActionJournal();
    const s = j.begin("t", {});
    // @ts-expect-error free-text reasons are not accepted at all
    j.update(s, { failure: "covered", reason: `Window ${CANARIES[5]} at ${CANARIES[2]}` });
    const e = j.entries()[0];
    expect(e.reason).toBe(KIND_PHRASE.covered);
    expect(JSON.stringify(e)).not.toContain("Quarterly");
    expect(FAILURE_KINDS.every((k) => typeof KIND_PHRASE[k] === "string" && KIND_PHRASE[k].length > 5)).toBe(true);
  });
  it("evidence is re-cleaned on the way in: only yes / no / unknown and a bounded count", () => {
    const j = new ActionJournal();
    const s = j.begin("t", {});
    j.update(s, { evidence: [{ kind: "windows_listed", ok: "SECRET" as unknown as boolean, n: 123456 }, { kind: "field_matches", ok: true, n: Number.NaN }, { kind: "window_exists", ok: false }] as EvidenceItem[] });
    const ev = j.entries()[0].evidence;
    expect(ev[0]).toEqual({ kind: "windows_listed", ok: null, n: 9999 });
    expect(ev[1]).toEqual({ kind: "field_matches", ok: true });
    expect(ev[2]).toEqual({ kind: "window_exists", ok: false });
    expect(JSON.stringify(ev)).not.toContain("SECRET");
  });
  it("entries() hands out copies: changing them cannot change the journal", () => {
    const j = new ActionJournal();
    j.begin("t", { a: 1 });
    const e = j.entries();
    e[0].tool = "hacked"; e[0].evidence.push({ kind: "no_probe", ok: null }); e[0].argKeys.push("zzz");
    expect(j.entries()[0].tool).toBe("t");
    expect(j.entries()[0].evidence).toEqual([]);
    expect(j.entries()[0].argKeys).toEqual(["a"]);
  });
  it("acted never goes back down, and mayHaveRun reads it", () => {
    const j = new ActionJournal();
    const s = j.begin("click_control", { label: "Go" });
    j.update(s, { acted: "yes" });
    j.update(s, { acted: "no" });
    expect(j.entries()[0].acted).toBe("yes");
    expect(j.mayHaveRun("click_control", { label: "Go" })).toBe(true);
    expect(j.mayHaveRun("click_control", { label: "Other" })).toBe(false);
    const t = j.begin("look_screen", {});
    void t;
    expect(j.mayHaveRun("look_screen", {})).toBe(false); // nothing was sent
    const u = j.begin("close_window", {});
    j.update(u, { acted: "maybe", phase: "not_effective" });
    expect(j.mayHaveRun("close_window", {})).toBe(false); // a real look found the effect absent
  });
  it("the module is memory-only: no file, network, console or process access", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "journal.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/node:fs|node:child_process|node:net|node:http|\bfetch\(|console\.|process\.|localStorage|writeFile/);
  });
});
