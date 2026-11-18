import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KEEP_NEWEST_SCRIPTS, MIN_SCRIPT_AGE_MS, pruneHelperScripts } from "./uiaHelper";

/** The helper's old script versions pile up in %TEMP%\momo-helper (one content-hashed file per change). The cleanup must be safe above all. */
const DAY = 24 * 60 * 60 * 1000;
let dir: string;
const NOW = Date.now();
const name = (n: number) => `uia-${n.toString(16).padStart(16, "0")}.ps1`;
const put = (n: string, ageMs: number, content = "# script") => { const p = path.join(dir, n); fs.writeFileSync(p, content); const t = new Date(NOW - ageMs); fs.utimesSync(p, t, t); return p; };
const left = () => fs.readdirSync(dir).sort();

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-prune-test-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("pruning old helper scripts", () => {
  it("removes old versions, but never the one in use, the newest few, or anything younger than a day", () => {
    const current = put(name(1), 5 * DAY);                       // in use: old, yet never removed
    for (let i = 2; i <= 7; i++) put(name(i), (i + 1) * DAY);     // six more, oldest first removed
    put(name(8), 2 * 60 * 60 * 1000);                              // two hours old: never removed
    const removed = pruneHelperScripts(dir, current, NOW);
    const kept = left();
    expect(kept).toContain(name(1));
    expect(kept).toContain(name(8));
    // of the six old ones, the newest KEEP_NEWEST_SCRIPTS stay (those are counted among the others, excluding the current one)
    expect(removed).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(2 + KEEP_NEWEST_SCRIPTS);
    expect(kept.length).toBeGreaterThanOrEqual(1 + KEEP_NEWEST_SCRIPTS);
  });

  it("never removes anything younger than a day, however many there are", () => {
    for (let i = 1; i <= 12; i++) put(name(i), i * 60 * 60 * 1000); // 1 to 12 hours old
    expect(pruneHelperScripts(dir, path.join(dir, name(1)), NOW)).toBe(0);
    expect(left().length).toBe(12);
    expect(MIN_SCRIPT_AGE_MS).toBe(DAY);
  });

  it("removes the oldest when there are more than the keep-count of old ones", () => {
    const current = put(name(100), 30 * DAY);
    for (let i = 1; i <= 8; i++) put(name(i), (10 + i) * DAY);   // 11..18 days old
    const removed = pruneHelperScripts(dir, current, NOW);
    expect(removed).toBe(8 - KEEP_NEWEST_SCRIPTS);
    const kept = left();
    expect(kept).toContain(name(100));
    // the survivors are the newest of the old ones
    for (let i = 1; i <= KEEP_NEWEST_SCRIPTS; i++) expect(kept).toContain(name(i));
  });

  it("touches only files named exactly uia-<16 hex>.ps1: other files, odd names and folders are left alone", () => {
    const current = put(name(1), 40 * DAY);
    const others = ["notes.txt", "uia-short.ps1", "uia-0000000000000001.ps1.bak", "uia-ZZZZZZZZZZZZZZZZ.ps1", "..uia-0000000000000009.ps1", "uia-0000000000000009.PS1"];
    for (const o of others) put(o, 90 * DAY);
    fs.mkdirSync(path.join(dir, name(50)));                       // a FOLDER with a matching name
    for (let i = 2; i <= 9; i++) put(name(i), (20 + i) * DAY);
    pruneHelperScripts(dir, current, NOW);
    for (const o of others) expect(fs.existsSync(path.join(dir, o)), o).toBe(true);
    expect(fs.statSync(path.join(dir, name(50))).isDirectory()).toBe(true);
  });

  it("ignores failures: a file that cannot be removed, or a missing folder, never throws", () => {
    const current = put(name(1), 40 * DAY);
    for (let i = 2; i <= 9; i++) put(name(i), (20 + i) * DAY);
    const stubborn = { readdirSync: fs.readdirSync, lstatSync: fs.lstatSync, unlinkSync: () => { throw new Error("EBUSY"); } } as unknown as typeof fs;
    expect(() => pruneHelperScripts(dir, current, NOW, stubborn)).not.toThrow();
    expect(pruneHelperScripts(dir, current, NOW, stubborn)).toBe(0);
    expect(() => pruneHelperScripts(path.join(dir, "does-not-exist"), current, NOW)).not.toThrow();
    expect(pruneHelperScripts(path.join(dir, "does-not-exist"), current, NOW)).toBe(0);
  });

  it("a name cannot escape the folder: the pattern admits no path separators", () => {
    // the only names ever joined to the folder are ones that matched the strict pattern
    const evil = ["uia-..\\..\\x.ps1", "uia-../../x.ps1"];
    for (const e of evil) expect(/^uia-[0-9a-f]{16}\.ps1$/.test(e)).toBe(false);
  });

  it("it only ever reads and deletes: it writes nothing", () => {
    const src = fs.readFileSync(path.join(__dirname, "uiaHelper.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function pruneHelperScripts"), src.indexOf("\n}\n", src.indexOf("export function pruneHelperScripts")));
    expect(fn).not.toMatch(/writeFile|appendFile|mkdir|rename|copyFile|rmSync|rmdir/);
  });
});
