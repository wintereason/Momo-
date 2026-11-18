"use strict";
// The cleanup ledger. The suite creates windows, processes and files; ALL of them are found again by this run's unique id
// (in window titles, on command lines and in the run directory name) and by nothing else, so the cleanup can never touch
// anything that belongs to the user.
const fs = require("fs");
const path = require("path");
const { pidsByCommandLine, killTree, isAlive } = require("./ps.cjs");

const RUN_DIR_RX = /^momo-real-r\d+-\d+$/;

class Ledger {
  /** @param {{ runId: string, runDir: string, tmpRoot: string }} o */
  constructor(o) {
    if (!RUN_DIR_RX.test(o.runId)) throw new Error("bad run id");
    this.runId = o.runId; this.runDir = o.runDir; this.tmpRoot = o.tmpRoot;
    this.scopeDir = null; this.scopeLabel = null;   // the open test case's artifact directory (beginCase / endCase)
    this.pids = [];            // process ids this run started itself, in order
    this.removed = { processes: 0, dirs: 0 };
  }

  init() {
    fs.mkdirSync(this.runDir, { recursive: true });
    fs.writeFileSync(path.join(this.runDir, "owner.pid"), String(process.pid));
  }

  /**
   * A label (a test id, with its repetition: "B07#2") as ONE safe directory name: no separators, no drive letters, no leading dots, no reserved device names.
   * Different labels stay different ("B07" and "B07#2" -> "B07" and "B07_r2").
   */
  static safeLabel(label) {
    let s = String(label == null ? "" : label).replace(/#/g, "_r").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 48);
    if (!s || /^\.*$/.test(s)) s = "case";
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = "c_" + s;
    return s;
  }

  /**
   * Start a test case's artifact scope: from now on file() resolves under its OWN directory, so a fixture's log, state, marker or browser profile can never be
   * shared with another test or with another repetition of the same test. A scope that is still open is ended first. A directory left over from an earlier use of
   * the same label is never reused: it is removed, or the new scope gets a fresh name.
   */
  beginCase(label) {
    if (this.scopeDir) this.endCase();
    const safe = Ledger.safeLabel(label);
    let dir = path.join(this.runDir, safe);
    for (let n = 2; fs.existsSync(dir); n++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a locked file: take another name */ }
      if (!fs.existsSync(dir)) break;
      dir = path.join(this.runDir, safe + "-" + n);
    }
    fs.mkdirSync(dir, { recursive: true });
    this.scopeDir = dir; this.scopeLabel = safe;
    return dir;
  }

  /** End the current scope (safe to call when none is open). Its files are removed unless remove is false; the whole run directory goes at the end anyway. */
  endCase({ remove = true } = {}) {
    const dir = this.scopeDir;
    this.scopeDir = null; this.scopeLabel = null;
    if (dir && remove) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* removed with the run directory */ } }
    return dir;
  }

  /** Run fn inside a case scope; the scope ends however fn ends (returns, throws or rejects). */
  async runInCase(label, fn) {
    this.beginCase(label);
    try { return await fn(); } finally { try { this.endCase(); } catch { /* removed with the run directory */ } }
  }

  /** a file or folder path inside the current case's directory (or the run directory when no case is open), never anywhere else */
  file(...parts) {
    const base = path.resolve(this.scopeDir || this.runDir);
    const p = path.resolve(base, ...parts);
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error("path escapes the " + (this.scopeDir ? "case" : "run") + " directory");
    return p;
  }

  track(pid) { if (pid && !this.pids.includes(pid)) this.pids.push(pid); return pid; }
  mark() { return this.pids.length; }

  /** kill what was started since `mark` (a finished test case's own fixtures) */
  releaseSince(mark) {
    const mine = this.pids.splice(mark);
    let n = 0;
    for (const pid of mine) if (killTree(pid)) n++;
    this.removed.processes += n;
    return n;
  }

  /** every process that carries this run's id on its command line, plus the ones started directly */
  sweepProcesses() {
    let n = 0;
    for (const pid of this.pids.splice(0)) if (killTree(pid)) n++;
    // children that outlived their parent (a browser's helpers, a PowerShell's host) are found by the id on their command line
    for (let round = 0; round < 3; round++) {
      const found = pidsByCommandLine(this.runId);
      if (!found.length) break;
      for (const p of found) if (killTree(p.pid)) n++;
    }
    this.removed.processes += n;
    return n;
  }

  removeDir() {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(this.runDir, { recursive: true, force: true }); } catch { /* files may still be released: retry */ }
      if (!fs.existsSync(this.runDir)) { this.removed.dirs++; return true; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    return !fs.existsSync(this.runDir);
  }

  /** the full cleanup. Safe to call more than once. */
  sweep() { const processes = this.sweepProcesses(); const dir = this.removeDir(); return { processes, dirRemoved: dir }; }

  /** what is still there that belongs to this run (must be nothing after sweep) */
  leftovers() {
    let procs = [];
    try { procs = pidsByCommandLine(this.runId); } catch { /* unknown: reported by the caller as unverifiable */ }
    return { processes: procs.length, dir: fs.existsSync(this.runDir) };
  }

  /**
   * Runs that crashed before they could clean up: their directory is still under the tmp root and their owner process is gone.
   * Only directories with OUR naming pattern and a dead owner are touched.
   */
  static sweepStale(tmpRoot, alive = isAlive) {
    const out = { runs: 0, processes: 0 };
    let names = [];
    try { names = fs.readdirSync(tmpRoot); } catch { return out; }
    for (const name of names) {
      if (!RUN_DIR_RX.test(name)) continue;
      const dir = path.join(tmpRoot, name);
      let owner = 0;
      try { owner = Number(fs.readFileSync(path.join(dir, "owner.pid"), "utf8")); } catch { /* no owner file: treat as abandoned */ }
      if (owner && alive(owner)) continue;
      const found = pidsByCommandLine(name);
      for (const p of found) if (killTree(p.pid)) out.processes++;
      try { fs.rmSync(dir, { recursive: true, force: true }); out.runs++; } catch { /* retried by the next run */ }
    }
    return out;
  }
}

module.exports = { Ledger, RUN_DIR_RX };
